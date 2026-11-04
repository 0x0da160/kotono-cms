/**
 * Git 機能の画面状態（仕様 20〜22・23.2）。
 *
 * - 状態は明示操作・フォルダを開いたとき・CMS の操作後に取り直す。自動監視はしない（23.2）。
 * - コミットは記事単位。未保存の編集があればコミットしない（21.1）。
 * - 初回の Git 書き込み前に、CMS が署名・フックを実行せず外部の条件適合を保証しないことを説明する（20.2）。
 */
import { checkIdentity, checkMessage } from "../git/model";
import {
  errText,
  GitRepo,
  stagedChange,
  unstagedChange,
  type ArticleStatus,
  type CommitPlan,
  type GitInfo,
  type HistoryCursor,
  type HistoryItem,
  type Identity,
  type RepoInfo,
} from "../git/repo";
import type { Notice } from "./session.svelte";
import type { GitHooks, Workspace } from "./workspace.svelte";

export interface CommitRequest {
  readonly plan: CommitPlan;
  readonly title: string;
  readonly branch: string;
  message: string;
  name: string;
  email: string;
  /** リポジトリの設定に保存する（別の明示操作として確認する：21.2） */
  saveIdentity: boolean;
  readonly identityFromConfig: boolean;
  readonly resolve: (ok: boolean) => void;
}

type Pending =
  | { kind: "staged"; plan: CommitPlan; stagedChecksum: string; message: string; who: Identity }
  | { kind: "unknown"; plan: CommitPlan; commitOid: string };

export interface HistoryState {
  readonly scope: "repo" | "article";
  readonly articleId: string | null;
  items: HistoryItem[];
  cursor: HistoryCursor | null;
  partial: string | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

export const UNOBSERVABLE_NOTE =
  "CMS は Git の署名・フック・フィルターを実行しません。OS のグローバル Git 設定、サーバー側の規約、組織のルールは確認できないため、適合しているとは表示しません。";

export class GitController {
  info = $state<GitInfo | null>(null);
  statuses = $state<Record<string, ArticleStatus> | null>(null);
  staged = $state<string[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  loadedAt = $state<number | null>(null);
  /** 状態の取得後に CMS の操作で内容が変わった記事（再読み込みまで表示を「要再確認」にする） */
  stale = $state<string[]>([]);
  acknowledged = $state(false);
  /** 今回のセッションだけで使う作者（21.2：一時入力） */
  sessionIdentity = $state<Identity | null>(null);
  commitDialog = $state<CommitRequest | null>(null);
  pending = $state<Pending | null>(null);
  history = $state<HistoryState | null>(null);
  notice = $state<Notice | null>(null);
  busy = $state(false);
  #repo: GitRepo | null = null;
  #historyAbort: AbortController | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly ws: Workspace) {}

  get repo(): RepoInfo | null {
    return this.info?.kind === "repo" ? this.info : null;
  }

  get writable(): boolean {
    return this.repo !== null && this.repo.blockers.length === 0;
  }

  /** フォルダを開いたとき（同意・一時作者・保留はフォルダごと） */
  reset(): void {
    this.info = null;
    this.statuses = null;
    this.staged = [];
    this.error = null;
    this.loadedAt = null;
    this.stale = [];
    this.acknowledged = false;
    this.sessionIdentity = null;
    this.pending = null;
    this.history = null;
    this.notice = null;
    this.#historyAbort?.abort();
    this.#repo = this.ws.root ? new GitRepo(this.ws.root) : null;
  }

  async refresh(): Promise<void> {
    if (!this.#repo && this.ws.root) this.#repo = new GitRepo(this.ws.root);
    const repo = this.#repo;
    if (!repo || this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      const info = await repo.inspect();
      this.info = info;
      if (info.kind === "repo") {
        const r = await repo.articleStatuses(info, this.ws.articles, null);
        this.statuses = Object.fromEntries(r.statuses);
        this.staged = r.staged;
      } else {
        this.statuses = null;
        this.staged = [];
      }
      this.stale = [];
      this.loadedAt = Date.now();
    } catch (e) {
      this.error = `Git の状態を取得できません：${errText(e)}`;
      this.statuses = null;
    } finally {
      this.loading = false;
    }
  }

  async refreshArticle(id: string): Promise<void> {
    const repo = this.#repo;
    const info = this.repo;
    if (!repo || !info || this.loading) return;
    try {
      const fresh = await repo.inspect();
      if (fresh.kind !== "repo") {
        this.info = fresh;
        return;
      }
      const r = await repo.articleStatuses(fresh, this.ws.articles, [id]);
      this.info = fresh;
      const st = r.statuses.get(id);
      const next = Object.fromEntries(Object.entries(this.statuses ?? {}).filter(([k]) => k !== id));
      if (st && !(st.state === "clean" && st.files.length === 0)) next[id] = st;
      this.statuses = next;
      this.staged = r.staged;
      this.stale = this.stale.filter((x) => x !== id);
    } catch (e) {
      this.error = `Git の状態を取得できません：${errText(e)}`;
    }
  }

  statusOf(id: string): ArticleStatus | null {
    return this.statuses?.[id] ?? null;
  }

  /** 一覧の補助表示（23） */
  label(id: string): string | null {
    if (!this.repo) return null;
    if (this.stale.includes(id)) return "Git 状態は要再確認";
    const st = this.statusOf(id);
    if (!st) return null;
    switch (st.state) {
      case "conflict":
        return "Git 競合";
      case "untracked":
        return "未追跡";
      case "changed":
        return "未コミット";
      case "deleted":
        return "削除未コミット";
      case "unknown":
        return "Git 状態不明";
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace との連携

  readonly hooks: GitHooks = {
    readOnlyReason: (id) =>
      this.statusOf(id)?.state === "conflict"
        ? "Git の未解決の競合があるため、この記事は編集・保存できません。外部の Git で競合を解決してください。"
        : null,
    describe: async (id, relPaths) => this.#describe(id, relPaths),
    changed: (id) => {
      if (!this.repo) return;
      if (!this.stale.includes(id)) this.stale = [...this.stale, id];
      if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
      this.#refreshTimer = setTimeout(() => {
        this.#refreshTimer = null;
        for (const x of this.stale) void this.refreshArticle(x);
      }, 300);
    },
  };

  async #describe(id: string, relPaths?: readonly string[]): Promise<string[]> {
    if (!this.#repo) return [];
    if (this.info?.kind === "none") return ["Git 状態：Git 未使用のフォルダです。Git から復元することはできません。"];
    if (!this.repo) return ["Git 状態：未確認（対応外の Git 構成です）。Git だけで復元できるとは限りません。"];
    await this.refreshArticle(id);
    const st = this.statusOf(id);
    const prefix = `content/articles/${id}/`;
    const files = (st?.files ?? []).filter((f) => !relPaths || relPaths.includes(f.path.slice(prefix.length)));
    if (!st || st.state === "unknown") return ["Git 状態：確認できませんでした。Git だけで復元できるとは限りません。"];
    const out: string[] = [];
    for (const f of files) {
      if (!f.work) continue;
      const rel = f.path.slice(prefix.length);
      let s: string;
      if (f.ignored) s = "Git の無視対象（Git からは復元できません）";
      else if (!f.head && !f.index) s = "未追跡（Git からは復元できません）";
      else if (stagedChange(f) || unstagedChange(f) || (f.head && f.work.oid !== f.head.oid))
        s = "Git 管理・未コミットの変更あり（最新の内容は Git から復元できません）";
      else s = "Git 管理・コミット済み";
      out.push(`Git 状態：${rel} … ${s}`);
    }
    if (out.length === 0) out.push("Git 状態：対象のファイルは Git に記録されていません。");
    return out;
  }

  // ---------------------------------------------------------------------------
  // git init（20.1）

  async init(): Promise<void> {
    const repo = this.#repo;
    if (!repo || this.busy || this.info?.kind !== "none") return;
    const v = await this.ws.ask({
      title: "Git リポジトリを初期化します",
      message: `選んだフォルダ「${this.ws.rootName}」に .git フォルダを作り、ブランチ main を用意します。記事ファイルは変更しません。`,
      details: [
        "既存の .git がないことを確認してから作成します。",
        "OS のグローバル Git 設定は参照しません。作者はコミット時に入力します。",
        UNOBSERVABLE_NOTE,
      ],
      buttons: [
        { label: "初期化する", value: "init", variant: "primary" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v !== "init") return;
    this.busy = true;
    try {
      const r = await repo.init();
      if (r.ok)
        this.notice = {
          kind: "ok",
          text: "Git リポジトリを初期化しました（ブランチ main）。",
          details: r.configSkipped
            ? [
                "ブラウザの制限により .git/config は作っていません。Git は設定ファイルがなくても既定の設定で動きます。",
                "設定ファイルが必要なら、外部の Git でこのフォルダに git init をもう一度実行してください（既存の内容は消えません）。",
              ]
            : [],
        };
      else
        this.notice = {
          kind: "error",
          text: r.message,
          details:
            r.left.length > 0
              ? ["作りかけのものを片付けようとしましたが、次は消せませんでした：", ...r.left]
              : ["作りかけのものは片付けました。フォルダは初期化前の状態です。"],
        };
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }

  // ---------------------------------------------------------------------------
  // コミット（21）

  async #acknowledge(): Promise<boolean> {
    if (this.acknowledged) return true;
    const v = await this.ws.ask({
      title: "Git への書き込みについて",
      message: "CMS は記事フォルダ単位でステージとコミットだけを行います。次の点を確認してください。",
      details: [
        UNOBSERVABLE_NOTE,
        "リポジトリ内で観測できる署名必須・フック・未対応の変換を検出した場合は、書き込みを止めます。",
        "外部の Git クライアントと同時に操作しないでください（ロックを検出したら止めます）。",
        "push・pull・ブランチ操作は行いません。",
      ],
      buttons: [
        { label: "理解して続ける", value: "ok", variant: "primary" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    this.acknowledged = v === "ok";
    return this.acknowledged;
  }

  async commitArticle(id: string): Promise<void> {
    const repo = this.#repo;
    if (!repo || this.busy || this.ws.busy) return;
    const s = this.ws.session;
    if (s && s.id === id && (s.dirty || s.isNew)) {
      this.notice = {
        kind: "error",
        text: "未保存の編集があります。先に保存するか破棄してから、コミットしてください。",
      };
      return;
    }
    if (this.pending) {
      this.notice = { kind: "error", text: "前回のコミットが完了していません。先に再試行または照合をしてください。" };
      return;
    }
    if (!(await this.#acknowledge())) return;
    this.busy = true;
    try {
      const info = await repo.inspect();
      this.info = info;
      if (info.kind !== "repo") {
        this.notice = { kind: "error", text: info.kind === "none" ? "Git が初期化されていません。" : info.message };
        return;
      }
      if (info.blockers.length > 0) {
        this.notice = {
          kind: "error",
          text: "このリポジトリには CMS から書き込めません。",
          details: info.blockers.map((b) => b.message),
        };
        return;
      }
      const r = await repo.plan(info, this.ws.articles, id);
      if (!r.ok) {
        this.notice = { kind: r.nothing ? "info" : "error", text: r.message };
        return;
      }
      const entry = this.ws.scan?.entries.find((e) => e.dirName === id);
      const titleVal = entry?.values?.title;
      const title = typeof titleVal === "string" && titleVal !== "" ? titleVal : `無題（${id}）`;
      const changes = r.plan.targets.map((t) => t.change);
      const verb = changes.every((c) => c === "deleted")
        ? "記事を削除"
        : changes.every((c) => c === "added")
          ? "記事を追加"
          : "記事を更新";
      const who = info.identity ?? this.sessionIdentity;
      const ok = await new Promise<boolean>((resolve) => {
        this.commitDialog = {
          plan: r.plan,
          title,
          branch: r.plan.branch,
          message: `${verb}: ${title}`,
          name: who?.name ?? "",
          email: who?.email ?? "",
          saveIdentity: false,
          identityFromConfig: info.identity !== null,
          resolve: (v) => {
            resolve(v);
          },
        };
      });
      const req = this.commitDialog;
      this.commitDialog = null;
      if (!ok || !req) return;
      const msgErr = checkMessage(req.message);
      const idErr = checkIdentity(req.name, req.email);
      if (msgErr || idErr) {
        this.notice = { kind: "error", text: msgErr ?? idErr ?? "" };
        return;
      }
      const identity = { name: req.name.trim(), email: req.email.trim() };
      if (req.saveIdentity) await this.#saveIdentity(repo, identity);
      else if (!info.identity) this.sessionIdentity = identity;
      const out = await repo.commit(r.plan, req.message, identity, info.textConversion);
      this.#handle(out, r.plan, req.message, identity);
    } catch (e) {
      this.notice = { kind: "error", text: `コミットできませんでした：${errText(e)}` };
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }

  async #saveIdentity(repo: GitRepo, id: Identity): Promise<void> {
    const v = await this.ws.ask({
      title: "作者をリポジトリ設定に保存します",
      message: "このリポジトリの .git/config に次の値を書き込みます。他の設定は変更しません。",
      details: [`user.name = ${id.name}`, `user.email = ${id.email}`],
      buttons: [
        { label: "保存する", value: "save", variant: "primary" },
        { label: "保存しない（今回だけ使う）", value: "skip" },
      ],
      initial: "skip",
    });
    if (v !== "save") {
      this.sessionIdentity = id;
      return;
    }
    try {
      await repo.saveIdentity(id);
      this.ws.announce("作者をリポジトリ設定に保存しました。");
    } catch (e) {
      this.sessionIdentity = id;
      // 設定保存の失敗をコミットの成否と混同しない（21.2）
      this.ws.announce(`作者の設定は保存できませんでした（コミットは続けます）：${errText(e)}`);
    }
  }

  #handle(out: Awaited<ReturnType<GitRepo["commit"]>>, plan: CommitPlan, message: string, who: Identity): void {
    switch (out.kind) {
      case "committed":
        this.pending = null;
        this.notice = {
          kind: "ok",
          text: `コミットしました（${out.oid.slice(0, 7)}、ブランチ ${plan.branch}）。`,
          details: out.reflog ? [] : ["reflog は更新していません（ファイルがない、または上限を超えています）。"],
        };
        this.ws.announce(this.notice.text);
        if (this.history) void this.loadHistory(this.history.scope, this.history.articleId);
        break;
      case "stopped":
        this.notice = { kind: "error", text: out.message, details: ["何も書き込んでいません。"] };
        break;
      case "staged":
        this.pending = { kind: "staged", plan, stagedChecksum: out.stagedChecksum, message, who };
        this.notice = {
          kind: "error",
          text: `ステージ済みですが、コミットは完了していません：${out.message}`,
          details: [
            "ファイルとステージは残しています。自動でステージを解除しません。",
            "このセッションの間は、状態が今回の予定と一致する場合に限り再試行できます。",
          ],
        };
        break;
      case "unknown":
        this.pending = { kind: "unknown", plan, commitOid: out.commitOid };
        this.notice = {
          kind: "error",
          text: `結果不明：${out.message}`,
          details: [`作成したコミット：${out.commitOid}`, "同じ操作を繰り返さず、「結果を照合」で確認してください。"],
        };
        break;
    }
  }

  /** 保留中のコミットの再試行・照合（21.4） */
  async resolvePending(): Promise<void> {
    const repo = this.#repo;
    const p = this.pending;
    if (!repo || !p || this.busy) return;
    this.busy = true;
    try {
      if (p.kind === "unknown") {
        const v = await repo.verifyCommit(p.plan, p.commitOid);
        if (v === "committed")
          this.#handle({ kind: "committed", oid: p.commitOid, reflog: false }, p.plan, "", { name: "", email: "" });
        else if (v === "not-committed") {
          this.pending = null;
          this.notice = {
            kind: "error",
            text: "コミットはブランチに反映されていません。状態を再確認してから、もう一度コミットしてください。",
          };
        } else
          this.notice = {
            kind: "error",
            text: "結果を判定できません。外部の Git で git log と git status を確認してください。",
          };
      } else {
        const info = await repo.inspect();
        const out = await repo.commit(p.plan, p.message, p.who, info.kind === "repo" && info.textConversion, {
          stagedChecksum: p.stagedChecksum,
        });
        if (out.kind === "stopped") {
          this.pending = null;
          this.notice = {
            kind: "error",
            text: `状態が今回の予定と一致しないため再試行しません：${out.message}`,
            details: ["ステージは残っている可能性があります。外部の Git で確認してください。"],
          };
        } else this.#handle(out, p.plan, p.message, p.who);
      }
    } catch (e) {
      this.notice = { kind: "error", text: errText(e) };
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }

  // ---------------------------------------------------------------------------
  // 履歴（22）

  async loadHistory(scope: "repo" | "article", articleId: string | null = null): Promise<void> {
    const repo = this.#repo;
    const info = this.repo;
    if (!repo || !info) return;
    this.#historyAbort?.abort();
    const ac = new AbortController();
    this.#historyAbort = ac;
    const h: HistoryState = {
      scope,
      articleId: scope === "article" ? articleId : null,
      items: [],
      cursor: null,
      partial: null,
      truncated: false,
      loading: true,
      error: null,
    };
    this.history = h;
    try {
      const fresh = await repo.inspect();
      const head = fresh.kind === "repo" ? fresh.headOid : null;
      const path = scope === "article" && articleId ? `content/articles/${articleId}` : null;
      const cur = await repo.startHistory(head, path);
      if (!cur) {
        this.history = { ...h, loading: false };
        return;
      }
      await this.#page(repo, cur, ac);
    } catch (e) {
      if (this.#historyAbort === ac && this.history)
        this.history = { ...this.history, loading: false, error: errText(e) };
    }
  }

  async moreHistory(): Promise<void> {
    const repo = this.#repo;
    const h = this.history;
    if (!repo || !h?.cursor || h.loading) return;
    const ac = new AbortController();
    this.#historyAbort = ac;
    this.history = { ...h, loading: true, partial: null };
    try {
      await this.#page(repo, h.cursor, ac);
    } catch (e) {
      if (this.history) this.history = { ...this.history, loading: false, error: errText(e) };
    }
  }

  cancelHistory(): void {
    this.#historyAbort?.abort();
  }

  async #page(repo: GitRepo, cur: HistoryCursor, ac: AbortController): Promise<void> {
    const page = await repo.history(cur, ac.signal);
    if (this.#historyAbort !== ac || !this.history) return;
    this.history = {
      ...this.history,
      items: [...this.history.items, ...page.items],
      cursor: page.cursor,
      partial: page.partial,
      truncated: this.history.truncated || page.truncated,
      loading: false,
    };
  }
}

export function commitDate(c: HistoryItem): string {
  const s = c.commit.author ?? c.commit.committer;
  if (!s) return "日時不明";
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 表示用の一時値
  const d = new Date(s.time * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
