/**
 * ローカル Git 機能（仕様 20〜22・31）。
 *
 * 外部プロセス・フック・フィルターを実行しない純粋な読み書きで、次だけを行う。
 * - 対応構成の判定（20.2・20.2.1）。判定できなければ Git 書き込みを止める。
 * - 記事フォルダ単位の状態算出（HEAD・index・作業ファイル）。
 * - 記事単位のステージとコミット（21）。開始前のステージがあれば止め、解除しない。
 * - 明示的な git init（20.1）。
 * - 予算付きの履歴取得（22・34.4）。
 *
 * 書き込む Git メタデータ：loose object、.git/index、ブランチ ref、既存の reflog、
 * （明示操作時のみ）.git/config の user.name・user.email。HEAD・packed-refs は書き換えない。
 */
import {
  GIT_HISTORY_MAX_COMMITS,
  GIT_HISTORY_MAX_MS,
  GIT_HISTORY_MAX_TREES,
  GIT_HISTORY_PAGE,
  GIT_OBJECT_MAX_BYTES,
  PROVISIONAL_GIT_CONFIG_MAX_BYTES,
  PROVISIONAL_GIT_INDEX_MAX_BYTES,
  PROVISIONAL_GIT_RULES_MAX_BYTES,
  PROVISIONAL_GIT_STATUS_MAX_MS,
  PROVISIONAL_GIT_STATUS_MAX_TREE_ENTRIES,
} from "../core/budgets";
import { enumerateTree } from "../fs/tree";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "../fs/types";
import { configBool, getConfig, parseConfig, withUser, type GitConfig } from "./config";
import { checkGitPath, GitFs, GitFsError } from "./gitfs";
import { IgnoreRules } from "./ignore-rules";
import {
  emptyIndex,
  entryFor,
  modeString,
  parseIndex,
  requiredExtensions,
  serializeIndex,
  indexDigest,
  type GitIndex,
  type IndexEntry,
} from "./index-file";
import {
  checkIdentity,
  cleanMessage,
  MODE_EXEC,
  MODE_FILE,
  MODE_GITLINK,
  MODE_LINK,
  MODE_TREE,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
  type Commit,
  type Signature,
  type TreeItem,
} from "./model";
import { GitError, hashObject, InflateBudget, ObjectStore } from "./objects";
import { Refs, type Head } from "./refs";

export const ARTICLES_GIT_PATH = "content/articles";
const dec = new TextDecoder();

export interface Blocker {
  readonly code: string;
  readonly message: string;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export type GitInfo =
  | { kind: "none" }
  | { kind: "unsupported"; message: string }
  | {
      kind: "repo";
      head: Head;
      branch: string | null;
      headOid: string | null;
      /** Git 書き込みを止める理由（空なら書き込み可） */
      blockers: Blocker[];
      /** 書き込みは止めないが表示する注意 */
      notes: string[];
      identity: Identity | null;
      /** 作業ファイルの改行変換が設定されている（CRLF を含む対象は止める） */
      textConversion: boolean;
      index: GitIndex | null;
      indexMtime: number;
      config: GitConfig | null;
    };

export type RepoInfo = Extract<GitInfo, { kind: "repo" }>;

function blocker(code: string, message: string): Blocker {
  return { code, message };
}

const IN_PROGRESS: [string, string][] = [
  ["MERGE_HEAD", "マージ"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase・am"],
  ["sequencer", "連続操作（sequencer）"],
];

const LOCKS = ["index.lock", "HEAD.lock", "config.lock", "packed-refs.lock", "shallow.lock"];

const ATTR_FATAL = /(^|\s)!?(filter|working-tree-encoding|ident)(=|\s|$)/m;
const ATTR_TEXT = /(^|\s)!?(text|eol|crlf)(=|\s|$)/m;

function stripComments(s: string): string {
  return s
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

export function now(): Signature["time"] {
  return Math.floor(Date.now() / 1000);
}

export function localTz(): number {
  return -new Date().getTimezoneOffset();
}

/** 1要求の時間・件数の予算 */
class StepBudget {
  readonly t0 = Date.now();
  n = 0;
  constructor(
    readonly maxN: number,
    readonly maxMs: number,
    readonly what: string,
    readonly signal?: AbortSignal,
  ) {}
  step(k = 1) {
    this.n += k;
    if (this.signal?.aborted) throw new GitError("中止しました。", "cancelled");
    if (this.n > this.maxN) throw new GitError(`${this.what}の件数が上限を超えました。`, "budget");
    if (Date.now() - this.t0 > this.maxMs) throw new GitError(`${this.what}が時間上限を超えました。`, "budget");
  }
}

export interface FileState {
  readonly path: string;
  readonly head: { oid: string; mode: string } | null;
  readonly index: { oid: string; mode: string; entry: IndexEntry } | null;
  readonly conflict: boolean;
  readonly work: { size: number; mtimeMs: number; oid: string | null } | null;
  readonly ignored: boolean;
}

export type ChangeKind = "added" | "modified" | "deleted";

export function stagedChange(f: FileState): ChangeKind | null {
  if (f.conflict) return null;
  if (!f.head && f.index) return "added";
  if (f.head && !f.index) return "deleted";
  if (f.head && f.index && (f.head.oid !== f.index.oid || f.head.mode !== f.index.mode)) return "modified";
  return null;
}

export function unstagedChange(f: FileState): ChangeKind | "untracked" | null {
  if (f.conflict) return null;
  if (!f.index) return f.work && !f.ignored ? "untracked" : null;
  if (!f.work) return "deleted";
  if (f.work.oid !== null && f.work.oid !== f.index.oid) return "modified";
  return null;
}

/** HEAD から見た作業ファイルの変化（コミット対象の算出に使う。index は HEAD と同じ前提） */
export function workChange(f: FileState): ChangeKind | null {
  const work = f.work && !(f.ignored && !f.index && !f.head) ? f.work : null;
  if (!f.head && work) return "added";
  if (f.head && !work) return "deleted";
  if (f.head && work && (work.oid !== f.head.oid || f.head.mode !== MODE_FILE)) return "modified";
  return null;
}

export type ArticleGitState = "clean" | "changed" | "untracked" | "deleted" | "conflict" | "unknown";

export interface ArticleStatus {
  readonly id: string;
  readonly state: ArticleGitState;
  readonly files: FileState[];
  /** この記事を CMS でコミットできない理由（属性・リンク等） */
  readonly unsupported: string | null;
}

export interface CommitTarget {
  readonly path: string;
  readonly change: ChangeKind;
  readonly oid: string | null;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface CommitPlan {
  readonly articleId: string;
  readonly branch: string;
  readonly ref: string;
  readonly headOid: string | null;
  readonly indexChecksum: string;
  readonly targets: CommitTarget[];
  readonly ignored: string[];
}

export type PlanResult = { ok: true; plan: CommitPlan } | { ok: false; message: string; nothing?: boolean };

export type CommitOutcome =
  | { kind: "committed"; oid: string; reflog: boolean }
  /** 実行前の再確認で止めた（何も書いていない） */
  | { kind: "stopped"; message: string }
  /** index は今回の内容に更新済みで、コミットが未完了 */
  | { kind: "staged"; message: string; stagedChecksum: string }
  /** ref の更新結果を確かめられない */
  | { kind: "unknown"; message: string; commitOid: string };

export interface HistoryItem {
  readonly oid: string;
  readonly commit: Commit;
}

export interface HistoryCursor {
  readonly queue: { oid: string; commit: Commit }[];
  readonly seen: Set<string>;
  readonly path: string | null;
}

export interface HistoryPage {
  readonly items: HistoryItem[];
  readonly cursor: HistoryCursor | null;
  /** 予算に達して未調査が残る */
  readonly partial: string | null;
  /** 親が見つからなかった（shallow 等）ため履歴の終端が不確か */
  readonly truncated: boolean;
}

export class GitRepo {
  readonly fs: GitFs;
  readonly store: ObjectStore;
  readonly refs: Refs;

  constructor(readonly root: DirHandleLike) {
    this.fs = new GitFs(root);
    this.store = new ObjectStore(this.fs);
    this.refs = new Refs(this.fs);
  }

  reset() {
    this.store.reset();
    this.refs.reset();
  }

  // ---------------------------------------------------------------------------
  // 対応構成の判定（20.2）

  async inspect(): Promise<GitInfo> {
    this.reset();
    const kind = await this.fs.kind(".git").catch(() => "error" as const);
    if (kind === "missing") return { kind: "none" };
    if (kind === "error") return { kind: "unsupported", message: ".git を確認できません。" };
    if (kind === "file")
      return {
        kind: "unsupported",
        message: ".git がファイルです（worktree・submodule 等の別構成）。Git 機能は使えません。記事の編集はできます。",
      };
    const blockers: Blocker[] = [];
    const notes: string[] = [];
    let config: GitConfig | null = null;
    try {
      const b = await this.fs.readOrNull(".git/config", PROVISIONAL_GIT_CONFIG_MAX_BYTES, ".git/config");
      config = parseConfig(b ? dec.decode(b) : "");
      if (!b) blockers.push(blocker("config-missing", ".git/config がありません。"));
    } catch (e) {
      blockers.push(blocker("config", e instanceof Error ? e.message : String(e)));
    }
    let textConversion = false;
    if (config) {
      const ver = getConfig(config, "core.repositoryformatversion");
      const v = ver === undefined || ver === null ? 0 : Number(ver);
      if (v !== 0 && v !== 1) blockers.push(blocker("format", `リポジトリ形式の版（${String(ver)}）は未対応です。`));
      for (const e of config.entries) {
        if (e.section === "extensions") {
          if (e.key === "objectformat" && (e.value ?? "").toLowerCase() === "sha1") continue;
          blockers.push(blocker("extension", `未対応のリポジトリ拡張（extensions.${e.key}）があります。`));
        }
        if (e.section === "include" || e.section === "includeif")
          blockers.push(blocker("include", ".git/config に include／includeIf があります。外部の設定は追跡しません。"));
      }
      if (configBool(getConfig(config, "core.bare"))) blockers.push(blocker("bare", "bare リポジトリです。"));
      if (getConfig(config, "core.worktree") !== undefined)
        blockers.push(blocker("worktree", "core.worktree が設定されています。"));
      if (configBool(getConfig(config, "core.sparsecheckout")))
        blockers.push(blocker("sparse", "sparse checkout が有効です。"));
      if (configBool(getConfig(config, "commit.gpgsign")))
        blockers.push(blocker("sign", "コミット署名が必須（commit.gpgsign）ですが、CMS は署名できません。"));
      if (getConfig(config, "core.hookspath") !== undefined)
        blockers.push(blocker("hooks", "core.hooksPath が設定されています。CMS はフックを実行しません。"));
      const crlf = (getConfig(config, "core.autocrlf") ?? "false").toString().toLowerCase();
      if (crlf === "true" || crlf === "input") textConversion = true;
      if (getConfig(config, "core.fsmonitor") !== undefined)
        notes.push("core.fsmonitor は使いません（作業ファイルは直接確認します）。");
    }
    const exists = async (p: string) => (await this.fs.kind(p).catch(() => "file" as const)) !== "missing";
    if (await exists(".git/objects/info/alternates"))
      blockers.push(blocker("alternates", "objects/info/alternates（外部の object 置き場）があります。"));
    if (await exists(".git/commondir")) blockers.push(blocker("commondir", "commondir があります（worktree 構成）。"));
    if (await exists(".git/info/sparse-checkout"))
      blockers.push(blocker("sparse", "sparse checkout の設定（info/sparse-checkout）があります。"));
    const wt = await this.fs.list(".git/worktrees", 1000).catch(() => null);
    if (wt && wt.length > 0) blockers.push(blocker("worktree", "追加の worktree があります。"));
    if (await exists(".gitmodules")) blockers.push(blocker("submodule", ".gitmodules があります（submodule 構成）。"));
    if (await exists(".git/shallow")) notes.push("shallow リポジトリです。古い履歴は表示できません。");
    for (const [f, label] of IN_PROGRESS)
      if (await exists(`.git/${f}`)) blockers.push(blocker("in-progress", `${label}の途中です（.git/${f}）。`));
    for (const f of LOCKS)
      if (await exists(`.git/${f}`))
        blockers.push(blocker("lock", `.git/${f} があります。外部の Git が処理中か、中断の残骸の可能性があります。`));
    const hooks = (await this.fs.list(".git/hooks", 1000).catch(() => null)) ?? [];
    const active = hooks.filter((h) => h.kind === "file" && !h.name.endsWith(".sample")).map((h) => h.name);
    if (active.length > 0)
      blockers.push(blocker("hooks", `Git フック（${active.join("・")}）があります。CMS はフックを実行しません。`));
    for (const p of [
      ".git/info/attributes",
      ".gitattributes",
      "content/.gitattributes",
      "content/articles/.gitattributes",
    ]) {
      const b = await this.fs.readOrNull(p, PROVISIONAL_GIT_RULES_MAX_BYTES, "属性").catch(() => null);
      if (!b) continue;
      const t = stripComments(dec.decode(b));
      if (ATTR_FATAL.test(t))
        blockers.push(
          blocker("attributes", `${p} に未対応の変換（filter・LFS・working-tree-encoding・ident）があります。`),
        );
      if (ATTR_TEXT.test(t)) textConversion = true;
    }
    let head: Head;
    try {
      head = await this.refs.head();
    } catch (e) {
      head = { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
    }
    if (head.kind === "detached")
      blockers.push(blocker("detached", "detached HEAD です。ブランチ上でのみ書き込めます。"));
    if (head.kind === "invalid") blockers.push(blocker("head", head.message));
    let index: GitIndex | null = null;
    let indexMtime = 0;
    try {
      const r = await this.#readIndex();
      index = r.index;
      indexMtime = r.mtime;
      const req = requiredExtensions(index);
      if (req.length > 0)
        blockers.push(blocker("index-ext", `index に未対応の必須拡張（${req.join("・")}）があります。`));
      const flags = index.entries.filter((e) => e.skipWorktree || e.intentToAdd || e.assumeValid);
      if (flags.length > 0)
        blockers.push(
          blocker(
            "index-flags",
            `index に未対応のフラグ（skip-worktree・intent-to-add・assume-unchanged）があります（${flags[0]?.path}）。`,
          ),
        );
      const conflicts = index.entries.filter((e) => e.stage > 0);
      if (conflicts.length > 0)
        blockers.push(
          blocker("conflict", `未解決の競合があります（${conflicts[0]?.path} ほか）。外部の Git で解決してください。`),
        );
      if (index.entries.some((e) => modeString(e.mode) === MODE_GITLINK))
        blockers.push(blocker("submodule", "index に submodule（gitlink）があります。"));
    } catch (e) {
      blockers.push(blocker("index", `index を確認できません：${e instanceof Error ? e.message : String(e)}`));
    }
    const name = config ? getConfig(config, "user.name") : undefined;
    const email = config ? getConfig(config, "user.email") : undefined;
    const identity =
      typeof name === "string" && typeof email === "string" && checkIdentity(name, email) === null
        ? { name, email }
        : null;
    return {
      kind: "repo",
      head,
      branch: head.kind === "branch" ? head.branch : null,
      headOid: head.kind === "branch" ? head.oid : head.kind === "detached" ? head.oid : null,
      blockers,
      notes,
      identity,
      textConversion,
      index,
      indexMtime,
      config,
    };
  }

  async #readIndex(): Promise<{ index: GitIndex; mtime: number }> {
    const st = await this.fs.stat(".git/index");
    if (!st) return { index: emptyIndex(), mtime: 0 };
    const b = await this.fs.readOrNull(".git/index", PROVISIONAL_GIT_INDEX_MAX_BYTES, "index");
    if (!b) return { index: emptyIndex(), mtime: 0 };
    return { index: await parseIndex(b), mtime: st.mtimeMs };
  }

  // ---------------------------------------------------------------------------
  // tree

  async readTree(oid: string, budget?: InflateBudget): Promise<TreeItem[]> {
    const o = await this.store.read(oid, budget);
    if (o.type !== "tree") throw new GitError(`${oid} は tree ではありません。`);
    return parseTree(o.data);
  }

  async readCommit(oid: string, budget?: InflateBudget): Promise<Commit> {
    const o = await this.store.read(oid, budget);
    if (o.type !== "commit") throw new GitError(`${oid} は commit ではありません。`);
    return parseCommit(o.data);
  }

  /** tree 内のパスの object（なければ null） */
  async treeEntryAt(
    treeOid: string,
    path: string,
    count?: () => void,
    cache?: Map<string, TreeItem[]>,
  ): Promise<TreeItem | null> {
    let cur: TreeItem = { mode: MODE_TREE, name: "", oid: treeOid };
    for (const part of path.split("/")) {
      if (cur.mode !== MODE_TREE) return null;
      let items = cache?.get(cur.oid);
      if (!items) {
        count?.();
        items = await this.readTree(cur.oid);
        cache?.set(cur.oid, items);
      }
      const next = items.find((i) => i.name === part);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  async flatten(treeOid: string, prefix: string, budget: StepBudget, out = new Map<string, TreeItem>()) {
    const items = await this.readTree(treeOid);
    budget.step(items.length);
    for (const it of items) {
      const p = prefix === "" ? it.name : `${prefix}/${it.name}`;
      if (it.mode === MODE_TREE) await this.flatten(it.oid, p, budget, out);
      else out.set(p, it);
    }
    return out;
  }

  /** index（stage 0）から tree を組み立てる。write が false なら ID の計算だけ */
  async treeFromIndex(entries: readonly IndexEntry[], write: boolean): Promise<string> {
    const build = async (list: { rest: string; e: IndexEntry }[]): Promise<string> => {
      const files: TreeItem[] = [];
      const dirs = new Map<string, { rest: string; e: IndexEntry }[]>();
      for (const it of list) {
        const slash = it.rest.indexOf("/");
        if (slash < 0) files.push({ mode: modeString(it.e.mode), name: it.rest, oid: it.e.oid });
        else {
          const d = it.rest.slice(0, slash);
          const arr = dirs.get(d) ?? [];
          arr.push({ rest: it.rest.slice(slash + 1), e: it.e });
          dirs.set(d, arr);
        }
      }
      for (const [name, sub] of dirs) files.push({ mode: MODE_TREE, name, oid: await build(sub) });
      const data = serializeTree(files);
      return write ? this.store.write("tree", data) : hashObject("tree", data);
    };
    if (entries.some((e) => e.stage !== 0)) throw new GitError("未解決の競合がある index から tree は作れません。");
    return build(entries.map((e) => ({ rest: e.path, e })));
  }

  async headTree(headOid: string | null): Promise<string | null> {
    if (!headOid) return null;
    return (await this.readCommit(headOid)).tree;
  }

  // ---------------------------------------------------------------------------
  // 状態（22）

  /**
   * 記事フォルダ群の状態を算出する。stat（サイズ・更新時刻）が index と一致するファイルは
   * 内容を読まない（Git と同じ近似。同一秒内の更新は内容で確かめる）。
   */
  async articleStatuses(
    info: RepoInfo,
    articles: DirHandleLike | null,
    ids: readonly string[] | null,
    signal?: AbortSignal,
  ): Promise<{ statuses: Map<string, ArticleStatus>; staged: string[] }> {
    const budget = new StepBudget(
      PROVISIONAL_GIT_STATUS_MAX_TREE_ENTRIES,
      PROVISIONAL_GIT_STATUS_MAX_MS,
      "状態の算出",
      signal,
    );
    const headTree = await this.headTree(info.headOid);
    const headFiles = new Map<string, TreeItem>();
    if (headTree) {
      const at = await this.treeEntryAt(headTree, ARTICLES_GIT_PATH);
      if (at && at.mode === MODE_TREE) await this.flatten(at.oid, ARTICLES_GIT_PATH, budget, headFiles);
    }
    const index = info.index ?? emptyIndex();
    const indexFiles = new Map<string, IndexEntry>();
    const conflicts = new Set<string>();
    for (const e of index.entries) {
      if (!e.path.startsWith(`${ARTICLES_GIT_PATH}/`)) continue;
      if (e.stage > 0) conflicts.add(e.path);
      else indexFiles.set(e.path, e);
    }
    // index と HEAD の差（リポジトリ全体）：tree ID の比較で判定し、違う部分だけ辿る
    const staged = await this.stagedPaths(info, headTree);
    const idOf = (p: string) => p.slice(ARTICLES_GIT_PATH.length + 1).split("/")[0] as string;
    const all = new Set<string>(ids ?? []);
    if (ids === null && articles) for await (const c of articles.values()) if (c.kind === "directory") all.add(c.name);
    if (ids === null) for (const p of [...headFiles.keys(), ...indexFiles.keys(), ...conflicts]) all.add(idOf(p));
    const rules = new IgnoreRules(this.fs);
    const statuses = new Map<string, ArticleStatus>();
    for (const id of [...all].sort()) {
      budget.step();
      statuses.set(id, await this.#articleStatus(id, articles, headFiles, indexFiles, conflicts, info, rules));
    }
    return { statuses, staged };
  }

  /** index と HEAD で違うパス（リポジトリ全体、開始前の既存ステージの検出：21.1） */
  async stagedPaths(info: RepoInfo, headTree: string | null): Promise<string[]> {
    const index = info.index ?? emptyIndex();
    const stage0 = index.entries.filter((e) => e.stage === 0);
    if (index.entries.some((e) => e.stage > 0))
      return [...new Set(index.entries.filter((e) => e.stage > 0).map((e) => e.path))];
    if (!headTree) return stage0.map((e) => e.path);
    const idxTree = await this.treeFromIndex(stage0, false);
    if (idxTree === headTree) return [];
    // 違いのあるパスを特定する（表示用、件数上限付き）
    const budget = new StepBudget(
      PROVISIONAL_GIT_STATUS_MAX_TREE_ENTRIES,
      PROVISIONAL_GIT_STATUS_MAX_MS,
      "ステージの確認",
    );
    const head = await this.flatten(headTree, "", budget);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const e of stage0) {
      seen.add(e.path);
      const h = head.get(e.path);
      if (!h || h.oid !== e.oid || h.mode !== modeString(e.mode)) out.push(e.path);
    }
    for (const p of head.keys()) if (!seen.has(p)) out.push(p);
    return out.length > 0 ? out.sort() : ["（tree の構造の違い）"];
  }

  async #articleStatus(
    id: string,
    articles: DirHandleLike | null,
    headFiles: Map<string, TreeItem>,
    indexFiles: Map<string, IndexEntry>,
    conflicts: Set<string>,
    info: RepoInfo,
    rules: IgnoreRules,
  ): Promise<ArticleStatus> {
    const prefix = `${ARTICLES_GIT_PATH}/${id}`;
    const inArticle = (p: string) => p === prefix || p.startsWith(`${prefix}/`);
    const work = new Map<string, { size: number; mtimeMs: number; handle: FileHandleLike }>();
    let unsupported: string | null = null;
    let dirIgnored = false;
    if (articles) {
      let dir: DirHandleLike | null = null;
      try {
        dir = await articles.getDirectoryHandle(id);
      } catch (e) {
        const k = classifyFsError(e);
        if (k !== "not-found" && k !== "type-mismatch")
          return { id, state: "unknown", files: [], unsupported: `記事フォルダを確認できません：${fsErrorMessage(k)}` };
      }
      if (dir) {
        dirIgnored = await rules.ignored(prefix, true);
        const tree = await enumerateTree(dir);
        if (!tree.ok) return { id, state: "unknown", files: [], unsupported: tree.message };
        for (const e of tree.entries) {
          if (e.kind !== "file") continue;
          const path = `${prefix}/${e.path}`;
          const bad = checkGitPath(path);
          if (bad) unsupported ??= bad;
          let mtime = 0;
          try {
            mtime = (await (e.handle as FileHandleLike).getFile()).lastModified;
          } catch {
            // 読めないファイルは内容の確認で失敗として扱う
          }
          work.set(path, { size: e.size, mtimeMs: mtime, handle: e.handle as FileHandleLike });
          if (e.path.endsWith(".gitattributes")) unsupported ??= `${path} があります（記事内の属性指定は未対応です）。`;
        }
      }
    }
    const paths = new Set<string>([
      ...[...headFiles.keys()].filter(inArticle),
      ...[...indexFiles.keys()].filter(inArticle),
      ...[...conflicts].filter(inArticle),
      ...work.keys(),
    ]);
    const files: FileState[] = [];
    for (const path of [...paths].sort()) {
      const h = headFiles.get(path) ?? null;
      const ie = indexFiles.get(path) ?? null;
      const w = work.get(path) ?? null;
      for (const m of [h?.mode, ie ? modeString(ie.mode) : undefined]) {
        if (m === MODE_LINK) unsupported ??= `${path} はシンボリックリンクとして記録されています。`;
        else if (m === MODE_EXEC)
          unsupported ??= `${path} は実行属性付きで記録されています（CMS は属性を保持できません）。`;
        else if (m === MODE_GITLINK) unsupported ??= `${path} は submodule です。`;
      }
      const ignored = !ie && !h && w !== null && (dirIgnored || (await rules.ignored(path)));
      let workState: FileState["work"] = null;
      if (w) {
        let oid: string | null = null;
        const ref = ie?.oid ?? h?.oid ?? null;
        if (ref !== null) {
          const statSame =
            ie !== null &&
            ie.size === w.size % 2 ** 32 &&
            Math.floor(ie.mtimeS * 1000 + ie.mtimeNs / 1e6) === w.mtimeMs &&
            // 同一秒内の更新（racy）は内容で確かめる
            ie.mtimeS * 1000 < info.indexMtime - 1000;
          oid = statSame ? ie.oid : await this.#hashWork(w.handle, path);
        }
        workState = { size: w.size, mtimeMs: w.mtimeMs, oid };
      }
      files.push({
        path,
        head: h ? { oid: h.oid, mode: h.mode } : null,
        index: ie ? { oid: ie.oid, mode: modeString(ie.mode), entry: ie } : null,
        conflict: conflicts.has(path),
        work: workState,
        ignored,
      });
    }
    let state: ArticleGitState = "clean";
    if (files.some((f) => f.conflict)) state = "conflict";
    else if (files.length > 0 && files.every((f) => !f.head && !f.index) && files.some((f) => f.work && !f.ignored))
      state = "untracked";
    else if (files.some((f) => f.head) && files.every((f) => !f.work)) state = "deleted";
    else if (files.some((f) => stagedChange(f) || unstagedChange(f) || workChange(f))) state = "changed";
    return { id, state, files, unsupported };
  }

  async #hashWork(handle: FileHandleLike, path: string): Promise<string> {
    let bytes: Uint8Array;
    try {
      const f = await handle.getFile();
      if (f.size > GIT_OBJECT_MAX_BYTES)
        throw new GitError(`${path} が Git object の上限（64 MiB）を超えています。`, "budget");
      bytes = new Uint8Array(await f.arrayBuffer());
    } catch (e) {
      if (e instanceof GitError) throw e;
      throw new GitError(`${path} を読めません：${fsErrorMessage(classifyFsError(e))}`, "io");
    }
    return hashObject("blob", bytes);
  }

  // ---------------------------------------------------------------------------
  // コミット（21）

  /** コミット対象を算出する。何も書かない */
  async plan(info: RepoInfo, articles: DirHandleLike | null, articleId: string): Promise<PlanResult> {
    if (info.blockers.length > 0) return { ok: false, message: info.blockers.map((b) => b.message).join("\n") };
    if (info.head.kind !== "branch") return { ok: false, message: "ブランチ上でのみコミットできます。" };
    const headTree = await this.headTree(info.headOid);
    const staged = await this.stagedPaths(info, headTree);
    if (staged.length > 0)
      return {
        ok: false,
        message: `開始前からステージされた変更があります（${staged.slice(0, 5).join("、")}${staged.length > 5 ? " ほか" : ""}）。CMS は既存のステージを解除しません。外部の Git で確認してください。`,
      };
    const { statuses } = await this.articleStatuses(info, articles, [articleId]);
    const st = statuses.get(articleId);
    if (!st || st.state === "unknown") return { ok: false, message: st?.unsupported ?? "記事の状態を確認できません。" };
    if (st.state === "conflict") return { ok: false, message: "未解決の競合があります。" };
    if (st.unsupported) return { ok: false, message: st.unsupported };
    const targets: CommitTarget[] = [];
    const ignored: string[] = [];
    for (const f of st.files) {
      if (f.ignored && !f.head) {
        ignored.push(f.path);
        continue;
      }
      const ch = workChange(f);
      if (!ch) continue;
      if (ch !== "deleted" && f.work?.oid === null) {
        // 未追跡の新規ファイルはここで内容 ID を求める
        const handle = await this.fs.file(f.path);
        const oid = await this.#hashWork(handle, f.path);
        targets.push({ path: f.path, change: ch, oid, size: f.work.size, mtimeMs: f.work.mtimeMs });
      } else
        targets.push({
          path: f.path,
          change: ch,
          oid: f.work?.oid ?? null,
          size: f.work?.size ?? 0,
          mtimeMs: f.work?.mtimeMs ?? 0,
        });
    }
    if (targets.length === 0) return { ok: false, message: "コミットする変更はありません。", nothing: true };
    return {
      ok: true,
      plan: {
        articleId,
        branch: info.branch as string,
        ref: info.head.ref,
        headOid: info.headOid,
        indexChecksum: await indexDigest(info.index ?? emptyIndex()),
        targets,
        ignored,
      },
    };
  }

  /**
   * 確認済みの計画でコミットする（21.3・21.4）。
   * 実行直前に HEAD・index・対象ファイルを再確認し、違えば何も書かずに止める。
   */
  async commit(
    plan: CommitPlan,
    message: string,
    who: Identity,
    textConversion: boolean,
    resume: { stagedChecksum: string } | null = null,
  ): Promise<CommitOutcome> {
    const msg = cleanMessage(message);
    this.reset();
    // --- 再確認（書き込み前）
    const head = await this.refs.head();
    if (head.kind !== "branch" || head.ref !== plan.ref || head.oid !== plan.headOid)
      return { kind: "stopped", message: "ブランチまたは HEAD が確認時から変わっています。状態を再確認してください。" };
    for (const f of ["index.lock", "HEAD.lock", `${plan.ref}.lock`])
      if ((await this.fs.kind(`.git/${f}`)) !== "missing")
        return { kind: "stopped", message: `.git/${f} があります。外部の Git が処理中の可能性があるため止めました。` };
    let index: GitIndex;
    try {
      index = (await this.#readIndex()).index;
    } catch (e) {
      return { kind: "stopped", message: `index を読めません：${e instanceof Error ? e.message : String(e)}` };
    }
    const expectIndex = resume ? resume.stagedChecksum : plan.indexChecksum;
    if ((await indexDigest(index)) !== expectIndex)
      return { kind: "stopped", message: "index が確認時から変わっています。状態を再確認してください。" };
    const blobs = new Map<string, Uint8Array>();
    for (const t of plan.targets) {
      if (t.change === "deleted") {
        if ((await this.fs.kind(t.path)) !== "missing")
          return { kind: "stopped", message: `${t.path} が確認時から変わっています（削除予定のファイルがあります）。` };
        continue;
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await this.fs.readOrNull(t.path, GIT_OBJECT_MAX_BYTES, "対象ファイル");
      } catch (e) {
        return { kind: "stopped", message: e instanceof Error ? e.message : String(e) };
      }
      if (!bytes || (await hashObject("blob", bytes)) !== t.oid)
        return { kind: "stopped", message: `${t.path} が確認時から変わっています。状態を再確認してください。` };
      if (/^version https:\/\/git-lfs\.github\.com\/spec\//.test(dec.decode(bytes.subarray(0, 64))))
        return { kind: "stopped", message: `${t.path} は Git LFS のポインターです。CMS は扱いません。` };
      if (textConversion && !bytes.subarray(0, 8000).includes(0) && bytes.includes(0x0d))
        return {
          kind: "stopped",
          message: `${t.path} に CR を含む改行があります。改行変換（autocrlf・text 属性）が設定されているため、外部の Git でコミットしてください。`,
        };
      blobs.set(t.path, bytes);
    }
    // --- object（参照されなければ残っても無害。自動掃除しない：31.2）
    let next: IndexEntry[];
    let stagedChecksum: string;
    if (resume) {
      next = index.entries;
      stagedChecksum = resume.stagedChecksum;
    } else {
      try {
        for (const [, b] of blobs) await this.store.write("blob", b);
      } catch (e) {
        return {
          kind: "stopped",
          message: `object を書けませんでした（index・ブランチは変えていません）：${errText(e)}`,
        };
      }
      const targetPaths = new Set(plan.targets.map((t) => t.path));
      next = index.entries.filter((e) => !targetPaths.has(e.path));
      for (const t of plan.targets)
        if (t.change !== "deleted") next.push(entryFor(t.path, t.oid as string, t.size, t.mtimeMs));
      // --- index（ここから「ステージ済み」）
      let bytes: Uint8Array;
      try {
        bytes = await serializeIndex(next);
      } catch (e) {
        return { kind: "stopped", message: errText(e) };
      }
      try {
        await this.fs.replace(".git/index", bytes, { create: true });
      } catch (e) {
        const now = await this.#readIndex().catch(() => null);
        if (now && (await indexDigest(now.index)) === (await indexDigest(index)))
          return { kind: "stopped", message: `index を更新できませんでした（変更していません）：${errText(e)}` };
        return {
          kind: "staged",
          message: `index の更新結果を確かめられません：${errText(e)}。外部の Git で git status を確認してください。`,
          stagedChecksum: await indexDigest(await parseIndex(bytes)),
        };
      }
      stagedChecksum = await indexDigest(await parseIndex(bytes));
    }
    // --- tree・commit
    let commitOid: string;
    let commitTime: Signature;
    try {
      const tree = await this.treeFromIndex(
        next.filter((e) => e.stage === 0),
        true,
      );
      const headTree = await this.headTree(plan.headOid);
      if (tree === headTree) return { kind: "staged", message: "コミット対象の差分がありません。", stagedChecksum };
      commitTime = { name: who.name.trim(), email: who.email.trim(), time: now(), tzMinutes: localTz() };
      commitOid = await this.store.write(
        "commit",
        serializeCommit({
          tree,
          parents: plan.headOid ? [plan.headOid] : [],
          author: commitTime,
          committer: commitTime,
          message: msg,
        }),
      );
    } catch (e) {
      return { kind: "staged", message: `コミットを作れませんでした：${errText(e)}`, stagedChecksum };
    }
    // --- ref（確定点）
    try {
      await this.refs.update(plan.ref, commitOid, plan.headOid);
    } catch (e) {
      this.refs.reset();
      const cur = await this.refs.resolve(plan.ref).catch(() => undefined);
      if (cur === commitOid) return this.#confirm(plan, commitOid, commitTime, msg);
      if (cur === plan.headOid)
        return { kind: "staged", message: `ブランチを更新できませんでした：${errText(e)}`, stagedChecksum };
      return { kind: "unknown", message: `ブランチの更新結果を確かめられません：${errText(e)}`, commitOid };
    }
    return this.#confirm(plan, commitOid, commitTime, msg);
  }

  async #confirm(plan: CommitPlan, oid: string, who: Signature, msg: string): Promise<CommitOutcome> {
    this.refs.reset();
    const cur = await this.refs.resolve(plan.ref).catch(() => undefined);
    if (cur !== oid)
      return { kind: "unknown", message: "ブランチを読み直した結果がコミットと一致しません。", commitOid: oid };
    const c = await this.readCommit(oid).catch(() => null);
    if (!c || (c.parents[0] ?? null) !== plan.headOid)
      return { kind: "unknown", message: "作成したコミットを読み直せません。", commitOid: oid };
    const reflog = await this.refs.appendReflog(plan.ref, plan.headOid, oid, who, `commit: ${msg}`).catch(() => false);
    return { kind: "committed", oid, reflog };
  }

  /** 既知のコミット ID が実際にブランチへ反映されたかを照合する（21.4：UI 更新だけ失敗した場合） */
  async verifyCommit(plan: CommitPlan, oid: string): Promise<"committed" | "not-committed" | "unknown"> {
    this.refs.reset();
    try {
      const cur = await this.refs.resolve(plan.ref);
      if (cur === oid) return "committed";
      if (cur === plan.headOid) return "not-committed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** 作者設定をリポジトリローカルの .git/config へ保存する（21.2：別の明示操作） */
  async saveIdentity(id: Identity): Promise<void> {
    const bad = checkIdentity(id.name, id.email);
    if (bad) throw new GitError(bad);
    if ((await this.fs.kind(".git/config.lock")) !== "missing")
      throw new GitError(".git/config.lock があるため保存しません。", "io");
    const b = await this.fs.readOrNull(".git/config", PROVISIONAL_GIT_CONFIG_MAX_BYTES, ".git/config");
    const cfg = parseConfig(b ? dec.decode(b) : "");
    const text = withUser(cfg, id.name.trim(), id.email.trim());
    // 書き換え後も解釈でき、他の項目が変わっていないことを確かめる
    const after = parseConfig(text);
    const others = (c: GitConfig) =>
      c.entries
        .filter((e) => !(e.section === "user" && e.subsection === null && (e.key === "name" || e.key === "email")))
        .map((e) => `${e.section}\u0000${e.subsection}\u0000${e.key}\u0000${e.value}`)
        .join("\n");
    if (others(after) !== others(cfg)) throw new GitError("設定の書き換えで他の項目が変わるため保存しません。");
    await this.fs.replace(".git/config", new TextEncoder().encode(text));
  }

  // ---------------------------------------------------------------------------
  // git init（20.1）

  async init(branch = "main"): Promise<{ ok: true } | { ok: false; message: string; created: string[] }> {
    if ((await this.fs.kind(".git")) !== "missing")
      return { ok: false, message: ".git が既にあります。初期化しません。", created: [] };
    const created: string[] = [];
    const enc = new TextEncoder();
    const steps: [string, Uint8Array | null][] = [
      [".git/objects/info", null],
      [".git/objects/pack", null],
      [".git/refs/heads", null],
      [".git/refs/tags", null],
      [".git/info", null],
      [".git/logs/refs/heads", null],
      [
        ".git/config",
        enc.encode(
          "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n",
        ),
      ],
      [".git/description", enc.encode("Unnamed repository; edit this file 'description' to name the repository.\n")],
      [".git/logs/HEAD", new Uint8Array()],
      [`.git/logs/refs/heads/${branch}`, new Uint8Array()],
      // HEAD を最後に置く：HEAD があって初めて Git はリポジトリとみなす
      [".git/HEAD", enc.encode(`ref: refs/heads/${branch}\n`)],
    ];
    try {
      for (const [p, b] of steps) {
        if (b === null) await this.fs.mkdirs(p);
        else await this.fs.createNew(p, b);
        created.push(p);
      }
    } catch (e) {
      return { ok: false, message: `初期化が途中で止まりました：${errText(e)}`, created };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // 履歴（22）

  async startHistory(headOid: string | null, path: string | null): Promise<HistoryCursor | null> {
    if (!headOid) return null;
    const commit = await this.readCommit(headOid);
    return { queue: [{ oid: headOid, commit }], seen: new Set([headOid]), path };
  }

  async history(cursor: HistoryCursor, signal?: AbortSignal): Promise<HistoryPage> {
    const t0 = Date.now();
    let commits = 0;
    let trees = 0;
    const items: HistoryItem[] = [];
    const queue = [...cursor.queue];
    const seen = new Set(cursor.seen);
    const cache = new Map<string, TreeItem[]>();
    let truncated = false;
    let partial: string | null = null;
    const countTree = () => {
      trees++;
    };
    const time = (c: Commit) => c.committer?.time ?? c.author?.time ?? 0;
    while (queue.length > 0 && items.length < GIT_HISTORY_PAGE) {
      if (signal?.aborted) {
        partial = "中止しました。";
        break;
      }
      if (
        commits >= GIT_HISTORY_MAX_COMMITS ||
        trees >= GIT_HISTORY_MAX_TREES ||
        Date.now() - t0 > GIT_HISTORY_MAX_MS
      ) {
        partial = "1回の調査量の上限に達しました。";
        break;
      }
      // 日時の新しい順（同時刻は ID 順で安定させる）
      queue.sort((a, b) => time(b.commit) - time(a.commit) || (a.oid < b.oid ? -1 : 1));
      const cur = queue.shift() as { oid: string; commit: Commit };
      const parents: { oid: string; commit: Commit }[] = [];
      for (const p of cur.commit.parents) {
        try {
          parents.push({ oid: p, commit: await this.readCommit(p) });
          commits++;
        } catch (e) {
          if (e instanceof GitError && e.code === "missing") truncated = true;
          else throw e;
        }
      }
      let include = true;
      if (cursor.path) {
        const mine = await this.treeEntryAt(cur.commit.tree, cursor.path, countTree, cache);
        if (parents.length === 0) include = mine !== null;
        else {
          const same: boolean[] = [];
          for (const p of parents) {
            const theirs = await this.treeEntryAt(p.commit.tree, cursor.path, countTree, cache);
            same.push((mine?.oid ?? null) === (theirs?.oid ?? null));
          }
          include = !same.some(Boolean);
        }
      }
      if (include) items.push({ oid: cur.oid, commit: cur.commit });
      for (const p of parents)
        if (!seen.has(p.oid)) {
          seen.add(p.oid);
          queue.push(p);
        }
    }
    return {
      items,
      cursor: queue.length > 0 ? { queue, seen, path: cursor.path } : null,
      partial: queue.length > 0 ? partial : null,
      truncated,
    };
  }
}

export function errText(e: unknown): string {
  if (e instanceof GitError || e instanceof GitFsError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
