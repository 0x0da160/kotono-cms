/**
 * GitHub との push・pull・簡易マージ（仕様 3.2 第40章、ADR-0006 第8章）。
 *
 * 通信は REST API（Git Data）だけで行う。手元の Git は自前の Git 層（GitRepo）で読み書きする。
 *
 * push：リモートの先頭が手元の履歴にあることを確かめ、足りない object を作り、
 *       作られたコミット ID が手元と一致したときだけ ref を force なしで進める。読み直して照合する。
 * pull：取得した object の ID を計算し直してから書く。作業ツリーは、変わるファイルが手元で
 *       変更されていないことを確かめてから書き換える。確定点はブランチの ref の更新。
 * 分岐：パスごとの三方向比較と記事の行単位マージ。残った競合は呼び出し側で選ばせてから
 *       マージコミットを作る。途中の状態は `.git/kotono-merge.json` に置く（ネイティブ Git の MERGE_HEAD は書かない）。
 */
import { decodeUtf8Strict, encodeUtf8 } from "../core/bytes";
import type { DirHandleLike } from "../fs/types";
import { checkGitPath } from "../git/gitfs";
import { emptyIndex, entryFor, parseIndex, serializeIndex, type IndexEntry } from "../git/index-file";
import {
  MODE_EXEC,
  MODE_FILE,
  MODE_TREE,
  serializeCommit,
  serializeTree,
  type Signature,
  type TreeItem,
} from "../git/model";
import { GitError, hashObject, objectBytes, sha1 } from "../git/objects";
import { type GitRepo } from "../git/repo";
import { GitHubError, type ApiCommit, type ApiTreeEntry, type GitHubApi } from "./github-api";
import { ARTICLE_FILE, classify, mergeText, type Side } from "./merge";

/** 1 回の同期で辿るコミット・作る object の上限（第34.4節の Git 予算の入口） */
export const SYNC_MAX_COMMITS = 2_000;
export const SYNC_MAX_OBJECTS = 20_000;
export const MERGE_STATE_PATH = ".git/kotono-merge.json";

export type SyncState =
  | { kind: "up-to-date" }
  | { kind: "ahead"; count: number }
  | { kind: "behind" }
  | { kind: "diverged" }
  | { kind: "remote-empty" }
  | { kind: "local-empty" };

export interface WorkChange {
  readonly path: string;
  readonly change: "added" | "modified" | "deleted";
}

export type PullOutcome =
  | { kind: "up-to-date" }
  | { kind: "ahead" }
  | { kind: "fast-forward"; head: string; changes: WorkChange[] }
  | { kind: "merge-needed"; plan: MergePlan }
  | { kind: "stopped"; message: string };

export type PushOutcome =
  | { kind: "pushed"; head: string; commits: number }
  | { kind: "up-to-date" }
  | { kind: "diverged" }
  | { kind: "stopped"; message: string }
  | { kind: "unknown"; message: string };

export interface ConflictItem {
  readonly path: string;
  readonly reason: string;
  readonly base: Side | null;
  readonly local: Side | null;
  readonly remote: Side | null;
}

export interface MergePlan {
  readonly localHead: string;
  readonly remoteHead: string;
  readonly base: string;
  /** 自動で決まったパス（パス → 採る item、null は削除） */
  readonly resolved: ReadonlyMap<string, TreeItem | null>;
  /** 自動マージで新しく作った内容（パス → blob の内容） */
  readonly mergedBlobs: ReadonlyMap<string, Uint8Array>;
  readonly conflicts: readonly ConflictItem[];
}

export type Choice = "local" | "remote";

class Budget {
  n = 0;
  constructor(
    readonly max: number,
    readonly what: string,
  ) {}
  step(): void {
    if (++this.n > this.max) throw new GitError(`${this.what}が上限（${this.max}）を超えました。`, "budget");
  }
}

// ---------------------------------------------------------------------------
// 日時・コミットの復元

export function isoDate(s: Signature): string {
  const d = new Date((s.time + s.tzMinutes * 60) * 1000).toISOString().slice(0, 19);
  const a = Math.abs(s.tzMinutes);
  return `${d}${s.tzMinutes < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

function parseIso(s: string): { time: number; tz: number | null } | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(t)) return null;
  const tz = m[2] === "Z" ? null : (Number(m[4]) * 60 + Number(m[5])) * (m[3] === "-" ? -1 : 1);
  return { time: Math.floor(t / 1000) - (tz ?? 0) * 60, tz };
}

/** 試す時差の順（日付の時差・手元の時差・UTC・日本時間の後に、15 分刻みのすべて） */
function tzCandidates(first: number | null, local: number): number[] {
  const all = [first, 0, local, 540];
  for (let m = -720; m <= 840; m += 15) all.push(m);
  return [...new Set(all.filter((x): x is number => x !== null))];
}

/**
 * API の応答からコミットの元の内容を組み立てる。ID が一致するものが見つからなければ null。
 * REST API は日時を UTC に直して返すことがあるため、時差を試して ID で確かめる。
 */
export async function rebuildCommit(c: ApiCommit, localTz = 0): Promise<Uint8Array | null> {
  const msgs = c.message.endsWith("\n") ? [c.message] : [`${c.message}\n`, c.message];
  if (c.signature) {
    // 署名の末尾：通常の Git は最後の改行を含めずに書くが、GitHub の画面で作ったコミット（web-flow の署名）は
    // 末尾に空の継続行（" "）が 1 行残る。API はどちらも同じ形で返すため、両方を試して ID で確かめる
    const raw = c.signature.signature.replace(/\n$/, "");
    const sigs = [raw, `${raw}\n`].map((s) => `gpgsig ${s.split("\n").join("\n ")}\n`);
    const p = c.signature.payload;
    const blank = p.indexOf("\n\n");
    if (blank > 0) {
      const head = p.slice(0, blank + 1);
      const rest = p.slice(blank + 1);
      const lines = head.split(/(?<=\n)/);
      const ci = lines.findIndex((l) => l.startsWith("committer "));
      const variants: string[] = [];
      for (const sig of sigs) {
        variants.push(head + sig + rest);
        if (ci >= 0) variants.push(lines.slice(0, ci + 1).join("") + sig + lines.slice(ci + 1).join("") + rest);
      }
      for (const v of variants) {
        const bytes = encodeUtf8(v);
        if ((await hashObject("commit", bytes)) === c.sha) return bytes;
      }
    }
    return null;
  }
  const a = parseIso(c.author.date);
  const m = parseIso(c.committer.date);
  if (!a || !m) return null;
  const at = tzCandidates(a.tz, localTz);
  const mt = tzCandidates(m.tz, localTz);
  const build = (atz: number, mtz: number, message: string) =>
    serializeCommit({
      tree: c.tree,
      parents: c.parents,
      author: { name: c.author.name, email: c.author.email, time: a.time, tzMinutes: atz },
      committer: { name: c.committer.name, email: c.committer.email, time: m.time, tzMinutes: mtz },
      message,
    });
  for (const message of msgs) {
    // 作者とコミッターの時差は同じことが多いので先に試す
    for (const z of at) {
      const b = build(z, z, message);
      if ((await sha1(objectBytes("commit", b))) === c.sha) return b;
    }
    for (const za of at.slice(0, 8))
      for (const zm of mt) {
        const b = build(za, zm, message);
        if ((await sha1(objectBytes("commit", b))) === c.sha) return b;
      }
  }
  return null;
}

function treeFromApi(entries: readonly ApiTreeEntry[]): TreeItem[] {
  return entries.map((e) => ({ mode: e.mode === "040000" ? MODE_TREE : e.mode, name: e.path, oid: e.sha }));
}

// ---------------------------------------------------------------------------

export class GitHubSync {
  constructor(
    readonly repo: GitRepo,
    readonly api: GitHubApi,
    private readonly localTz: number = -new Date().getTimezoneOffset(),
  ) {}

  /** 手元の HEAD（ブランチ）を読む。ブランチ以外・未初期化は止める */
  async localHead(): Promise<{ ref: string; branch: string; oid: string | null }> {
    this.repo.reset();
    const h = await this.repo.refs.head();
    if (h.kind !== "branch") throw new GitError("HEAD がブランチを指していないため同期できません。");
    return { ref: h.ref, branch: h.branch, oid: h.oid };
  }

  /** a が b の祖先（または同じ）か。手元の object だけで判定する */
  async isAncestor(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const budget = new Budget(SYNC_MAX_COMMITS * 5, "履歴の探索");
    const seen = new Set<string>([b]);
    const queue = [b];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (!(await this.repo.store.has(cur))) continue;
      budget.step();
      for (const p of (await this.repo.readCommit(cur)).parents) {
        if (p === a) return true;
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return false;
  }

  /** 共通の祖先（両方の先頭から幅優先で、最初に共通になったもの） */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const budget = new Budget(SYNC_MAX_COMMITS * 5, "共通の祖先の探索");
    const anc = new Set<string>();
    const qa = [a];
    while (qa.length > 0) {
      const cur = qa.shift() as string;
      if (anc.has(cur)) continue;
      anc.add(cur);
      budget.step();
      if (await this.repo.store.has(cur)) qa.push(...(await this.repo.readCommit(cur)).parents);
    }
    const seen = new Set<string>();
    const qb = [b];
    while (qb.length > 0) {
      const cur = qb.shift() as string;
      if (anc.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      budget.step();
      if (await this.repo.store.has(cur)) qb.push(...(await this.repo.readCommit(cur)).parents);
    }
    return null;
  }

  async state(): Promise<SyncState> {
    const local = (await this.localHead()).oid;
    const remote = await this.api.head();
    if (remote === null) return { kind: "remote-empty" };
    if (local === null) return { kind: "local-empty" };
    if (local === remote) return { kind: "up-to-date" };
    if (await this.repo.store.has(remote)) {
      if (await this.isAncestor(remote, local))
        return { kind: "ahead", count: (await this.newCommits(local, remote)).length };
      if (await this.isAncestor(local, remote)) return { kind: "behind" };
      return { kind: "diverged" };
    }
    // リモートの先頭が手元にない：手元が祖先なら behind、そうでなければ分岐（取得するまで分からない）
    return { kind: "behind" };
  }

  // -------------------------------------------------------------------------
  // 取得

  /** リモートの先頭までの、手元にないコミット・tree・blob を取得し、ID を確かめてから書く */
  async fetch(remoteHead: string): Promise<number> {
    const budget = new Budget(SYNC_MAX_OBJECTS, "取得する object の数");
    const commits: { sha: string; bytes: Uint8Array; tree: string }[] = [];
    const seen = new Set<string>();
    const queue = [remoteHead];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha) || (await this.repo.store.has(sha))) continue;
      seen.add(sha);
      if (commits.length >= SYNC_MAX_COMMITS)
        throw new GitError(`取得するコミットが上限（${SYNC_MAX_COMMITS}）を超えました。`, "budget");
      const c = await this.api.commit(sha);
      const bytes = await rebuildCommit(c, this.localTz);
      if (!bytes)
        throw new GitError(
          `GitHub のコミット ${sha.slice(0, 7)} の内容を、ID と一致する形に復元できません（署名・特殊なヘッダーなど）。外部の Git で取得してください。`,
          "unsupported",
        );
      commits.push({ sha, bytes, tree: c.tree });
      queue.push(...c.parents);
    }
    // 古い順に書く（コミットがあればその tree と祖先も揃っている状態を保つ）
    for (const c of commits.reverse()) {
      await this.fetchTree(c.tree, budget);
      if ((await this.repo.store.write("commit", c.bytes)) !== c.sha)
        throw new GitError(`コミット ${c.sha.slice(0, 7)} の ID が一致しません。`);
    }
    return commits.length;
  }

  private async fetchTree(sha: string, budget: Budget): Promise<void> {
    if (await this.repo.store.has(sha)) return;
    budget.step();
    const items = treeFromApi(await this.api.tree(sha));
    const data = serializeTree(items);
    if ((await hashObject("tree", data)) !== sha) throw new GitError(`tree ${sha.slice(0, 7)} の ID が一致しません。`);
    for (const it of items) {
      if (it.mode === MODE_TREE) await this.fetchTree(it.oid, budget);
      else if (it.mode === "160000")
        continue; // サブモジュールの参照は取得しない
      else if (!(await this.repo.store.has(it.oid))) {
        budget.step();
        const bytes = await this.api.blob(it.oid);
        if ((await this.repo.store.write("blob", bytes)) !== it.oid)
          throw new GitError(`${it.name} の内容が ID と一致しません。`);
      }
    }
    // 子を書き終えてから tree を書く
    await this.repo.store.write("tree", data);
  }

  // -------------------------------------------------------------------------
  // push

  /** 手元の先頭からリモートの先頭までのコミット（古い順）。リモートにあるものは含めない */
  private async newCommits(local: string, remote: string | null): Promise<string[]> {
    const budget = new Budget(SYNC_MAX_COMMITS, "送るコミットの数");
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [local];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (cur === remote || seen.has(cur)) continue;
      seen.add(cur);
      if (remote !== null && (await this.isAncestor(cur, remote))) continue;
      budget.step();
      out.push(cur);
      queue.push(...(await this.repo.readCommit(cur)).parents);
    }
    return out.reverse();
  }

  async push(): Promise<PushOutcome> {
    const local = await this.localHead();
    if (!local.oid) return { kind: "stopped", message: "まだコミットがありません。" };
    if (local.branch !== this.api.target.branch)
      return {
        kind: "stopped",
        message: `手元のブランチ（${local.branch}）と同期先のブランチ（${this.api.target.branch}）が違います。`,
      };
    let remote: string | null;
    try {
      remote = await this.api.head();
    } catch (e) {
      return { kind: "stopped", message: errText(e) };
    }
    if (remote === local.oid) return { kind: "up-to-date" };
    if (remote === null)
      return {
        kind: "stopped",
        message:
          "GitHub のリポジトリ（またはブランチ）が空です。REST API では空のリポジトリへ送れません。README を作ってから取得（pull）し直すか、外部の Git で最初の push をしてください。",
      };
    if (!(await this.repo.store.has(remote)) || !(await this.isAncestor(remote, local.oid)))
      return { kind: "diverged" };
    const commits = await this.newCommits(local.oid, remote);
    const uploaded = new Set<string>();
    const objBudget = new Budget(SYNC_MAX_OBJECTS, "送る object の数");
    try {
      for (const oid of commits) {
        const c = await this.repo.readCommit(oid);
        if (c.signed)
          return {
            kind: "stopped",
            message: `コミット ${oid.slice(0, 7)} は署名つきのため、REST API では同じ ID で送れません。外部の Git で push してください。`,
          };
        if (c.encoding)
          return { kind: "stopped", message: `コミット ${oid.slice(0, 7)} は文字コードの指定つきのため送れません。` };
        if (!c.author || !c.committer)
          return { kind: "stopped", message: `コミット ${oid.slice(0, 7)} の作者情報を読めません。` };
        const parentTrees = await Promise.all(c.parents.map(async (p) => (await this.repo.readCommit(p)).tree));
        await this.uploadTree(c.tree, parentTrees, uploaded, objBudget);
        const made = await this.api.createCommit({
          message: c.message,
          tree: c.tree,
          parents: c.parents,
          author: { name: c.author.name, email: c.author.email, date: isoDate(c.author) },
          committer: { name: c.committer.name, email: c.committer.email, date: isoDate(c.committer) },
        });
        if (made !== oid)
          return {
            kind: "stopped",
            message: `GitHub で作ったコミットの ID が手元（${oid.slice(0, 7)}）と一致しないため、ブランチを更新せずに止めました（GitHub 側の内容は変わっていません）。`,
          };
      }
    } catch (e) {
      return { kind: "stopped", message: `送信を中断しました（GitHub のブランチは変えていません）：${errText(e)}` };
    }
    // 確定点：ref を force なしで進める
    try {
      await this.api.updateRef(local.oid, false);
    } catch (e) {
      if (e instanceof GitHubError && e.code === "conflict") return { kind: "diverged" };
      // 結果を読み直して判断する
      const now = await this.api.head().catch(() => undefined);
      if (now === local.oid) return { kind: "pushed", head: local.oid, commits: commits.length };
      if (now === remote) return { kind: "stopped", message: `ブランチを更新できませんでした：${errText(e)}` };
      return { kind: "unknown", message: `ブランチの更新結果を確かめられません：${errText(e)}` };
    }
    const now = await this.api.head().catch(() => undefined);
    if (now !== local.oid)
      return { kind: "unknown", message: "GitHub のブランチを読み直した結果が手元と一致しません。" };
    return { kind: "pushed", head: local.oid, commits: commits.length };
  }

  private async uploadTree(sha: string, parents: (string | null)[], done: Set<string>, budget: Budget): Promise<void> {
    if (done.has(sha) || parents.includes(sha)) return;
    const items = await this.repo.readTree(sha);
    const parentItems = await Promise.all(parents.map((p) => (p ? this.repo.readTree(p).catch(() => []) : [])));
    for (const it of items) {
      const inParent = parentItems.map((list) => list.find((x) => x.name === it.name) ?? null);
      if (inParent.some((x) => x?.oid === it.oid) || done.has(it.oid)) continue;
      if (it.mode === MODE_TREE) {
        await this.uploadTree(
          it.oid,
          inParent.map((x) => (x && x.mode === MODE_TREE ? x.oid : null)),
          done,
          budget,
        );
      } else if (it.mode === "160000") {
        throw new GitError("サブモジュールを含む変更は送れません。");
      } else {
        budget.step();
        const o = await this.repo.store.read(it.oid);
        if ((await this.api.createBlob(o.data)) !== it.oid) throw new GitError(`${it.name} の送信結果が一致しません。`);
        done.add(it.oid);
      }
    }
    budget.step();
    const made = await this.api.createTree(
      items.map((it) => ({
        path: it.name,
        mode: it.mode === MODE_TREE ? "040000" : it.mode,
        type: it.mode === MODE_TREE ? "tree" : it.mode === "160000" ? "commit" : "blob",
        sha: it.oid,
      })),
    );
    if (made !== sha) throw new GitError("送った tree の ID が手元と一致しません。");
    done.add(sha);
  }

  // -------------------------------------------------------------------------
  // pull

  /**
   * 取得して、早送りできれば作業ツリーを書き換える。分岐していればマージの計画を返す。
   * 呼び出し側は、未保存の記事がないことと、変わる記事の一覧の確認（confirm）を済ませること。
   */
  async pull(confirm: (changes: WorkChange[]) => Promise<boolean>): Promise<PullOutcome> {
    const local = await this.localHead();
    if (local.branch !== this.api.target.branch)
      return {
        kind: "stopped",
        message: `手元のブランチ（${local.branch}）と同期先のブランチ（${this.api.target.branch}）が違います。`,
      };
    let remote: string | null;
    try {
      remote = await this.api.head();
      if (remote === null) return { kind: "up-to-date" };
      if (remote === local.oid) return { kind: "up-to-date" };
      await this.fetch(remote);
    } catch (e) {
      return { kind: "stopped", message: `取得できませんでした（手元は変えていません）：${errText(e)}` };
    }
    if (local.oid && (await this.isAncestor(remote, local.oid))) return { kind: "ahead" };
    if (local.oid === null || (await this.isAncestor(local.oid, remote))) {
      const oldTree = local.oid ? (await this.repo.readCommit(local.oid)).tree : null;
      const newTree = (await this.repo.readCommit(remote)).tree;
      const plan = await this.planCheckout(oldTree, newTree, new Map());
      if (typeof plan === "string") return { kind: "stopped", message: plan };
      if (plan.changes.length > 0 && !(await confirm(plan.changes)))
        return { kind: "stopped", message: "取り消しました。" };
      const r = await this.applyCheckout(
        plan,
        local.ref,
        local.oid,
        remote,
        `pull: fast-forward to ${remote.slice(0, 7)}`,
      );
      if (r) return { kind: "stopped", message: r };
      return { kind: "fast-forward", head: remote, changes: plan.changes };
    }
    try {
      return { kind: "merge-needed", plan: await this.planMerge(local.oid, remote) };
    } catch (e) {
      return { kind: "stopped", message: errText(e) };
    }
  }

  // -------------------------------------------------------------------------
  // 作業ツリーの書き換え

  private async flatten(tree: string | null): Promise<Map<string, TreeItem>> {
    const out = new Map<string, TreeItem>();
    if (!tree) return out;
    const budget = new Budget(SYNC_MAX_OBJECTS * 5, "ファイルの数");
    const walk = async (oid: string, prefix: string) => {
      for (const it of await this.repo.readTree(oid)) {
        budget.step();
        const p = prefix === "" ? it.name : `${prefix}/${it.name}`;
        if (it.mode === MODE_TREE) await walk(it.oid, p);
        else out.set(p, it);
      }
    };
    await walk(tree, "");
    return out;
  }

  /**
   * 書き換えの計画。変わるファイルが作業ツリー・index で手元の版（または書き換え後の版）のままかを確かめる。
   * overrides：マージで作った内容（パス → blob の内容。null は削除）
   */
  async planCheckout(
    oldTree: string | null,
    newTree: string,
    overrides: ReadonlyMap<string, Uint8Array>,
  ): Promise<CheckoutPlan | string> {
    const before = await this.flatten(oldTree);
    const after = await this.flatten(newTree);
    const changes: WorkChange[] = [];
    const writes: { path: string; item: TreeItem }[] = [];
    const removes: string[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const p of [...paths].sort()) {
      const a = before.get(p) ?? null;
      const b = after.get(p) ?? null;
      if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
      const bad = checkGitPath(p);
      if (bad || p === ".git" || p.startsWith(".git/")) return `${p} は書き換えられないパスです（${bad ?? ".git"}）。`;
      for (const it of [a, b])
        if (it && it.mode !== MODE_FILE && it.mode !== MODE_EXEC)
          return `${p} はシンボリックリンク・サブモジュールのため、CMS では書き換えません。外部の Git で取得してください。`;
      if (b) writes.push({ path: p, item: b });
      else removes.push(p);
      changes.push({ path: p, change: a === null ? "added" : b === null ? "deleted" : "modified" });
    }
    // 作業ツリーと index が手元の版（または書き換え後の版：中断後の再実行）であることを確かめる
    const index = await this.readIndex();
    const byPath = new Map(index.entries.filter((e) => e.stage === 0).map((e) => [e.path, e]));
    if (index.entries.some((e) => e.stage !== 0))
      return "index に未解決の競合があります。外部の Git で解決してください。";
    const dirty: string[] = [];
    for (const c of changes) {
      const a = before.get(c.path)?.oid ?? null;
      const b = after.get(c.path)?.oid ?? null;
      const work = await this.workOid(c.path);
      if (work !== a && work !== b) dirty.push(c.path);
      const idx = byPath.get(c.path)?.oid ?? null;
      if (idx !== a && idx !== b) dirty.push(`${c.path}（ステージ済み）`);
    }
    if (dirty.length > 0)
      return `手元で変更したままのファイルがあるため、書き換えずに止めました。コミットするか元に戻してから再試行してください：${dirty.slice(0, 10).join("、")}${dirty.length > 10 ? ` ほか ${dirty.length - 10} 件` : ""}`;
    void overrides;
    return { changes, writes, removes, newTree };
  }

  private async readIndex() {
    const b = await this.repo.fs.readOrNull(".git/index", 64 * 1024 * 1024, "index");
    return b ? parseIndex(b) : emptyIndex();
  }

  private async workOid(path: string): Promise<string | null> {
    const h = await fileAt(this.repo.root, path);
    if (!h) return null;
    const f = await h.getFile();
    return hashObject("blob", new Uint8Array(await f.arrayBuffer()));
  }

  /** 書き換える。戻り値は止めた理由（null なら完了） */
  async applyCheckout(
    plan: CheckoutPlan,
    ref: string,
    oldHead: string | null,
    newHead: string,
    reflogMsg: string,
  ): Promise<string | null> {
    try {
      for (const w of plan.writes) {
        const o = await this.repo.store.read(w.item.oid);
        await writeWork(this.repo.root, w.path, o.data);
      }
      for (const p of plan.removes) await removeWork(this.repo.root, p);
    } catch (e) {
      return `作業ツリーの書き換えが途中で止まりました（ブランチは変えていません。再試行すると続きから揃えます）：${errText(e)}`;
    }
    // index
    try {
      const index = await this.readIndex();
      const changed = new Set(plan.changes.map((c) => c.path));
      const next: IndexEntry[] = index.entries.filter((e) => !changed.has(e.path));
      for (const w of plan.writes) {
        const h = await fileAt(this.repo.root, w.path);
        const f = h ? await h.getFile() : null;
        const e = entryFor(w.path, w.item.oid, f?.size ?? 0, f?.lastModified ?? 0);
        next.push(w.item.mode === MODE_EXEC ? { ...e, mode: 0o100755 } : e);
      }
      await this.repo.fs.replace(".git/index", await serializeIndex(next), { create: true });
    } catch (e) {
      return `index を更新できませんでした（ブランチは変えていません。再試行してください）：${errText(e)}`;
    }
    // 確定点：ブランチ
    try {
      await this.repo.refs.update(ref, newHead, oldHead);
    } catch (e) {
      return `ブランチを更新できませんでした：${errText(e)}`;
    }
    this.repo.refs.reset();
    if ((await this.repo.refs.resolve(ref)) !== newHead) return "ブランチを読み直した結果が一致しません。";
    const who: Signature = {
      name: "Kotono CMS",
      email: "kotono-cms@localhost",
      time: Math.floor(Date.now() / 1000),
      tzMinutes: this.localTz,
    };
    await this.repo.refs.appendReflog(ref, oldHead, newHead, who, reflogMsg).catch(() => false);
    return null;
  }

  // -------------------------------------------------------------------------
  // 分岐時の簡易マージ

  async planMerge(localHead: string, remoteHead: string): Promise<MergePlan> {
    const base = await this.mergeBase(localHead, remoteHead);
    if (!base) throw new GitError("共通の祖先が見つかりません（関係のない履歴）。外部の Git で合わせてください。");
    const [bt, lt, rt] = await Promise.all(
      [base, localHead, remoteHead].map(async (c) => this.flatten((await this.repo.readCommit(c)).tree)),
    );
    const B = bt as Map<string, TreeItem>;
    const L = lt as Map<string, TreeItem>;
    const R = rt as Map<string, TreeItem>;
    const resolved = new Map<string, TreeItem | null>();
    const mergedBlobs = new Map<string, Uint8Array>();
    const conflicts: ConflictItem[] = [];
    const side = (it: TreeItem | undefined): Side | null => (it ? { oid: it.oid, mode: it.mode } : null);
    for (const p of [...new Set([...B.keys(), ...L.keys(), ...R.keys()])].sort()) {
      const b = side(B.get(p));
      const l = side(L.get(p));
      const r = side(R.get(p));
      const c = classify(b, l, r);
      if (c !== "text") {
        if (c.kind === "take") resolved.set(p, c.item ? { ...c.item, name: p } : null);
        else if (c.kind === "conflict") conflicts.push({ path: p, reason: c.reason, base: b, local: l, remote: r });
        continue;
      }
      if (!ARTICLE_FILE.test(p) || !b || !l || !r) {
        conflicts.push({
          path: p,
          reason: b ? "両側で別の内容に変更" : "両側で別の内容を追加",
          base: b,
          local: l,
          remote: r,
        });
        continue;
      }
      const [tb, tl, tr] = await Promise.all(
        [b, l, r].map(async (s) => decodeUtf8Strict((await this.repo.store.read(s.oid)).data)),
      );
      const merged =
        tb?.ok && tl?.ok && tr?.ok && !tb.bom && !tl.bom && !tr.bom ? mergeText(tb.text, tl.text, tr.text) : null;
      if (merged === null) {
        conflicts.push({ path: p, reason: "両側で同じ箇所を変更", base: b, local: l, remote: r });
        continue;
      }
      const bytes = encodeUtf8(merged);
      mergedBlobs.set(p, bytes);
      resolved.set(p, { mode: l.mode, name: p, oid: await hashObject("blob", bytes) });
    }
    return { localHead, remoteHead, base, resolved, mergedBlobs, conflicts };
  }

  /**
   * 競合をすべて選んだ後に、マージコミットを作って作業ツリーを書き換える。
   * 戻り値は止めた理由（null なら完了。続けて push する）
   */
  async completeMerge(
    plan: MergePlan,
    choices: ReadonlyMap<string, Choice>,
    who: { name: string; email: string },
    confirm: (changes: WorkChange[]) => Promise<boolean>,
  ): Promise<{ ok: true; head: string; changes: WorkChange[] } | { ok: false; message: string }> {
    const local = await this.localHead();
    if (local.oid !== plan.localHead) return { ok: false, message: "手元のブランチが計画時から変わっています。" };
    const final = new Map(plan.resolved);
    for (const c of plan.conflicts) {
      const ch = choices.get(c.path);
      if (!ch) return { ok: false, message: `${c.path} の扱いが決まっていません。` };
      const s = ch === "local" ? c.local : c.remote;
      final.set(c.path, s ? { ...s, name: c.path } : null);
    }
    // マージで作った内容を object として書く
    for (const [p, bytes] of plan.mergedBlobs) {
      const want = final.get(p);
      if (want && (await hashObject("blob", bytes)) === want.oid) await this.repo.store.write("blob", bytes);
    }
    const tree = await this.writeTree(final);
    const t = Math.floor(Date.now() / 1000);
    const sig: Signature = { name: who.name, email: who.email, time: t, tzMinutes: this.localTz };
    const commit = await this.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parents: [plan.localHead, plan.remoteHead],
        author: sig,
        committer: sig,
        message: `Merge GitHub ${this.api.target.owner}/${this.api.target.repo} ${this.api.target.branch}\n`,
      }),
    );
    const oldTree = (await this.repo.readCommit(plan.localHead)).tree;
    const co = await this.planCheckout(oldTree, tree, plan.mergedBlobs);
    if (typeof co === "string") return { ok: false, message: co };
    if (co.changes.length > 0 && !(await confirm(co.changes))) return { ok: false, message: "取り消しました。" };
    const r = await this.applyCheckout(co, local.ref, plan.localHead, commit, `merge: ${plan.remoteHead.slice(0, 7)}`);
    if (r) return { ok: false, message: r };
    await this.repo.fs.remove(MERGE_STATE_PATH).catch(() => undefined);
    return { ok: true, head: commit, changes: co.changes };
  }

  private async writeTree(files: ReadonlyMap<string, TreeItem | null>): Promise<string> {
    interface Node {
      files: TreeItem[];
      dirs: Map<string, Node>;
    }
    const root: Node = { files: [], dirs: new Map() };
    for (const [p, it] of files) {
      if (!it) continue;
      const parts = p.split("/");
      let n = root;
      for (const d of parts.slice(0, -1)) {
        let next = n.dirs.get(d);
        if (!next) {
          next = { files: [], dirs: new Map() };
          n.dirs.set(d, next);
        }
        n = next;
      }
      n.files.push({ mode: it.mode, name: parts.at(-1) as string, oid: it.oid });
    }
    const build = async (n: Node): Promise<string> => {
      const items = [...n.files];
      for (const [name, sub] of n.dirs) items.push({ mode: MODE_TREE, name, oid: await build(sub) });
      return this.repo.store.write("tree", serializeTree(items));
    };
    return build(root);
  }

  /** 選んだ途中の内容を残す（再開用） */
  async saveMergeState(plan: MergePlan, choices: ReadonlyMap<string, Choice>): Promise<void> {
    const s = JSON.stringify({
      v: 1,
      localHead: plan.localHead,
      remoteHead: plan.remoteHead,
      choices: Object.fromEntries(choices),
    });
    await this.repo.fs.replace(MERGE_STATE_PATH, encodeUtf8(s), { create: true });
  }

  async loadMergeState(): Promise<{ localHead: string; remoteHead: string; choices: Map<string, Choice> } | null> {
    const b = await this.repo.fs.readOrNull(MERGE_STATE_PATH, 1024 * 1024, "マージの途中状態").catch(() => null);
    if (!b) return null;
    try {
      const v = JSON.parse(new TextDecoder().decode(b)) as {
        v?: unknown;
        localHead?: unknown;
        remoteHead?: unknown;
        choices?: Record<string, unknown>;
      };
      if (v.v !== 1 || typeof v.localHead !== "string" || typeof v.remoteHead !== "string") return null;
      const choices = new Map<string, Choice>();
      for (const [k, c] of Object.entries(v.choices ?? {})) if (c === "local" || c === "remote") choices.set(k, c);
      return { localHead: v.localHead, remoteHead: v.remoteHead, choices };
    } catch {
      return null;
    }
  }

  async abortMerge(): Promise<void> {
    await this.repo.fs.remove(MERGE_STATE_PATH).catch(() => undefined);
  }
}

export interface CheckoutPlan {
  readonly changes: WorkChange[];
  readonly writes: { path: string; item: TreeItem }[];
  readonly removes: string[];
  readonly newTree: string;
}

// ---------------------------------------------------------------------------
// 作業ツリーの読み書き（.git の外。pull・マージの書き換えだけが使う：40.4）

async function fileAt(root: DirHandleLike, path: string) {
  const parts = path.split("/");
  let d = root;
  try {
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    return await d.getFileHandle(parts.at(-1) as string);
  } catch {
    return null;
  }
}

async function writeWork(root: DirHandleLike, path: string, bytes: Uint8Array): Promise<void> {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const h = await d.getFileHandle(parts.at(-1) as string, { create: true });
  const w = await h.createWritable({ keepExistingData: false });
  try {
    await w.write(bytes);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
  const back = new Uint8Array(await (await h.getFile()).arrayBuffer());
  if (back.length !== bytes.length || back.some((x, i) => x !== bytes[i]))
    throw new Error(`${path} を読み直した内容が一致しません。`);
}

async function removeWork(root: DirHandleLike, path: string): Promise<void> {
  const parts = path.split("/");
  const dirs: DirHandleLike[] = [root];
  try {
    for (const p of parts.slice(0, -1)) dirs.push(await (dirs.at(-1) as DirHandleLike).getDirectoryHandle(p));
  } catch {
    return; // 既にない
  }
  const parent = dirs.at(-1) as DirHandleLike;
  if (!parent.removeEntry) throw new Error("この環境では削除できません。");
  try {
    await parent.removeEntry(parts.at(-1) as string);
  } catch (e) {
    if ((e as Error).name !== "NotFoundError") throw e;
  }
  // 空になったフォルダを親へ向かって消す（中身があれば消えない）
  for (let i = parts.length - 2; i >= 0; i--) {
    const d = dirs[i] as DirHandleLike;
    try {
      await d.removeEntry?.(parts[i] as string);
    } catch {
      break;
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
