/**
 * GitHub との同期の画面の状態と操作（仕様 3.2 第40章）。
 *
 * - 同期は明示操作でだけ行う（40.1）。
 * - トークン：ブラウザ内の作業場所では作業場所の鍵で暗号化して保存できる。実フォルダでは
 *   保存せず、このタブを閉じるまでメモリにだけ置く（40.2：デスクトップの保存方法は技術ゲートで確定するまでの暫定）。
 * - pull・マージの作業ツリーの書き換えは、未保存の編集がないことと、変わるファイルの一覧の確認の後に行う。
 */
import { getConfig } from "../git/config";
import { GitRepo } from "../git/repo";
import { GitHubApi, parseRepoInput, validTarget, type FetchLike, type RemoteTarget } from "../sync/github-api";
import { GitHubSync, type Choice, type MergePlan, type SyncState, type WorkChange } from "../sync/sync";
import type { GitController } from "./git.svelte";
import type { PlacesController } from "./places.svelte";
import type { Workspace } from "./workspace.svelte";

export interface SyncNotice {
  readonly kind: "ok" | "warn" | "error";
  readonly text: string;
}

export class SyncController {
  target = $state<RemoteTarget | null>(null);
  /** トークンがメモリにあるか（値は画面に出さない） */
  hasToken = $state(false);
  /** トークンを暗号化して保存しているか */
  tokenSaved = $state(false);
  status = $state<SyncState | null>(null);
  busy = $state(false);
  notice = $state<SyncNotice | null>(null);
  merge = $state<{ plan: MergePlan; choices: Record<string, Choice> } | null>(null);
  rateRemaining = $state<number | null>(null);
  #token: string | null = null;

  constructor(
    private readonly ws: Workspace,
    private readonly git: GitController,
    private readonly places: PlacesController | null,
    private readonly fetcher?: FetchLike,
  ) {}

  /** トークンを保存できる（ブラウザ内の作業場所を開いているとき。作業場所は暗号化している） */
  get canSaveToken(): boolean {
    return this.places?.current != null;
  }

  reset(): void {
    this.target = null;
    this.#token = null;
    this.hasToken = false;
    this.tokenSaved = false;
    this.status = null;
    this.notice = null;
    this.merge = null;
  }

  /** フォルダ・作業場所を開いたとき：保存した同期先と、.git/config の origin（GitHub）から同期先を得る */
  async load(): Promise<void> {
    this.reset();
    const m = this.places?.current;
    if (m?.remote) {
      this.target = { owner: m.remote.owner, repo: m.remote.repo, branch: m.remote.branch };
      if (m.remote.token && this.places?.vault.isUnlocked(m.id)) {
        try {
          const t = await this.places.vault.openToken(m.id, m.remote.token);
          if (t) {
            this.#token = t;
            this.hasToken = true;
            this.tokenSaved = true;
          }
        } catch {
          this.notice = { kind: "warn", text: "保存したトークンを読めません。入力し直してください。" };
        }
      }
      return;
    }
    const cfg = this.git.repo?.config;
    const url = cfg ? getConfig(cfg, "remote.origin.url") : null;
    const parsed = url ? parseRepoInput(url) : null;
    if (parsed) this.target = { ...parsed, branch: this.git.repo?.branch ?? "main" };
  }

  /** 同期先とトークンを設定する */
  async configure(repoInput: string, branch: string, token: string, save: boolean): Promise<boolean> {
    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
      this.notice = { kind: "error", text: "リポジトリは「所有者/名前」または GitHub の URL で入力してください。" };
      return false;
    }
    const target = { ...parsed, branch: branch.trim() || "main" };
    const bad = validTarget(target);
    if (bad) {
      this.notice = { kind: "error", text: bad };
      return false;
    }
    const t = token.trim();
    if (t !== "" && !/^[A-Za-z0-9_]{20,255}$/.test(t)) {
      this.notice = {
        kind: "error",
        text: "トークンの形式が違います（github_pat_ で始まる文字列を貼り付けてください）。",
      };
      return false;
    }
    this.target = target;
    if (t !== "") {
      this.#token = t;
      this.hasToken = true;
    }
    const m = this.places?.current;
    if (m && this.places?.store) {
      let sealed: string | null = m.remote?.token ?? null;
      if (t !== "") sealed = save && this.canSaveToken ? await this.places.vault.sealToken(m.id, t) : null;
      const updated = await this.places.store.update(m.id, { remote: { ...target, token: sealed } });
      this.places.current = updated;
      this.tokenSaved = sealed !== null;
    }
    this.notice = { kind: "ok", text: "同期先を設定しました。" };
    return true;
  }

  async forgetToken(): Promise<void> {
    this.#token = null;
    this.hasToken = false;
    const m = this.places?.current;
    if (m?.remote && this.places?.store) {
      this.places.current = await this.places.store.update(m.id, { remote: { ...m.remote, token: null } });
    }
    this.tokenSaved = false;
    this.notice = { kind: "ok", text: "トークンを消しました。" };
  }

  private engine(): GitHubSync | null {
    const root = this.ws.root;
    if (!root || !this.target || !this.#token) {
      this.notice = { kind: "error", text: "同期先とトークンを設定してください。" };
      return null;
    }
    const api = new GitHubApi(this.target, this.#token, this.fetcher);
    return new GitHubSync(new GitRepo(root), api);
  }

  private async run<T>(f: (s: GitHubSync) => Promise<T>): Promise<T | null> {
    if (this.busy || this.ws.busy) return null;
    const s = this.engine();
    if (!s) return null;
    this.busy = true;
    this.notice = null;
    try {
      return await f(s);
    } catch (e) {
      this.notice = { kind: "error", text: e instanceof Error ? e.message : String(e) };
      return null;
    } finally {
      this.rateRemaining = s.api.remaining;
      this.busy = false;
    }
  }

  async check(): Promise<void> {
    await this.run(async (s) => {
      this.status = await s.state();
    });
  }

  async push(): Promise<void> {
    await this.run(async (s) => {
      const r = await s.push();
      switch (r.kind) {
        case "pushed":
          this.notice = { kind: "ok", text: `GitHub へ送りました（コミット ${r.commits} 件）。` };
          await this.synced();
          break;
        case "up-to-date":
          this.notice = { kind: "ok", text: "GitHub と同じです。送るものはありません。" };
          await this.synced();
          break;
        case "diverged":
          this.notice = {
            kind: "warn",
            text: "GitHub に手元にないコミットがあります。先に「取得」して合わせてから送ってください。",
          };
          break;
        default:
          this.notice = { kind: r.kind === "unknown" ? "warn" : "error", text: r.message };
      }
      this.status = await s.state().catch(() => null);
    });
  }

  private async beforeRewrite(): Promise<boolean> {
    const s = this.ws.session;
    if (s?.dirty) {
      this.notice = { kind: "error", text: "未保存の編集があります。保存するか破棄してから取得してください。" };
      return false;
    }
    const changed = Object.values(this.git.statuses ?? {}).filter((x) => x.state !== "clean").length;
    if (changed > 0) {
      this.notice = {
        kind: "error",
        text: `未コミットの記事が ${changed} 件あります。コミットしてから取得してください。`,
      };
      return false;
    }
    return true;
  }

  private confirmChanges = async (changes: WorkChange[]): Promise<boolean> => {
    const label = { added: "追加", modified: "変更", deleted: "削除" } as const;
    const v = await this.ws.ask({
      title: "GitHub の内容で書き換えます",
      message: `次の ${changes.length} 件のファイルを書き換えます。手元で変更していないことは確認済みです。`,
      details: changes.slice(0, 50).map((c) => `${label[c.change]}：${c.path}`),
      buttons: [
        { label: "書き換える", value: "ok", variant: "primary" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "ok",
    });
    return v === "ok";
  };

  async pull(): Promise<void> {
    if (!(await this.beforeRewrite())) return;
    await this.run(async (s) => {
      const r = await s.pull(this.confirmChanges);
      switch (r.kind) {
        case "up-to-date":
          this.notice = { kind: "ok", text: "GitHub と同じです。" };
          await this.synced();
          break;
        case "ahead":
          this.notice = { kind: "ok", text: "取得するものはありません（手元の方が新しいので、送ってください）。" };
          break;
        case "fast-forward":
          this.notice = { kind: "ok", text: `GitHub の内容を取得しました（${r.changes.length} ファイル）。` };
          await this.afterRewrite();
          await this.synced();
          break;
        case "merge-needed": {
          const saved = await s.loadMergeState();
          const choices: Record<string, Choice> = {};
          if (saved && saved.localHead === r.plan.localHead && saved.remoteHead === r.plan.remoteHead)
            for (const [k, v] of saved.choices) choices[k] = v;
          this.merge = { plan: r.plan, choices };
          const lead =
            r.plan.base === null
              ? "手元と GitHub の履歴は別々に始まっています（共通の祖先がありません）。両方のファイルを 1 つに合わせます。"
              : "手元と GitHub の両方に変更があります。";
          this.notice =
            r.plan.conflicts.length === 0
              ? {
                  kind: r.plan.base === null ? "warn" : "ok",
                  text: `${lead}自動で合わせられます。内容を確かめて「合わせて送る」を押してください。`,
                }
              : {
                  kind: "warn",
                  text: `${lead}${r.plan.conflicts.length} 件のファイルは、どちらを採るか選んでください。`,
                };
          break;
        }
        case "stopped":
          this.notice = { kind: "error", text: r.message };
      }
      this.status = await s.state().catch(() => null);
    });
  }

  async choose(path: string, c: Choice): Promise<void> {
    if (!this.merge) return;
    this.merge.choices = { ...this.merge.choices, [path]: c };
    const s = this.engine();
    await s?.saveMergeState(this.merge.plan, choiceMap(this.merge.choices)).catch(() => undefined);
  }

  async abortMerge(): Promise<void> {
    const s = this.engine();
    await s?.abortMerge();
    this.merge = null;
    this.notice = { kind: "ok", text: "合わせるのを中止しました（手元は変えていません）。" };
  }

  /** 競合をすべて選んだら、マージコミットを作って送る */
  async completeMerge(): Promise<void> {
    const m = this.merge;
    if (!m) return;
    if (!(await this.beforeRewrite())) return;
    const info = this.git.repo;
    const who = info?.identity ?? this.git.sessionIdentity;
    if (!who) {
      this.notice = {
        kind: "error",
        text: "マージコミットの作者が決まっていません。先に記事を 1 件コミットして作者を設定してください。",
      };
      return;
    }
    await this.run(async (s) => {
      const r = await s.completeMerge(m.plan, choiceMap(m.choices), who, this.confirmChanges);
      if (!r.ok) {
        this.notice = { kind: "error", text: r.message };
        return;
      }
      this.merge = null;
      await this.afterRewrite();
      const p = await s.push();
      if (p.kind === "pushed") {
        this.notice = { kind: "ok", text: "合わせて GitHub へ送りました。" };
        await this.synced();
      } else if (p.kind === "diverged")
        this.notice = {
          kind: "warn",
          text: "合わせている間に GitHub に新しいコミットが入りました。もう一度「取得」してください。",
        };
      else
        this.notice = {
          kind: "error",
          text: `合わせましたが、送れませんでした：${"message" in p ? p.message : p.kind}`,
        };
      this.status = await s.state().catch(() => null);
    });
  }

  /** 作業ツリーを書き換えた後：編集中の記事を閉じ、一覧と Git の状態を読み直す */
  private async afterRewrite(): Promise<void> {
    this.ws.session = null;
    await this.ws.refreshList();
    await this.git.refresh();
  }

  private async synced(): Promise<void> {
    const m = this.places?.current;
    if (m) await this.places?.markSynced(m.id);
  }

  /** マージの競合の 3 版（表示用の文字列。読めなければ null） */
  async versions(path: string): Promise<{ base: string | null; local: string | null; remote: string | null } | null> {
    const c = this.merge?.plan.conflicts.find((x) => x.path === path);
    const root = this.ws.root;
    if (!c || !root) return null;
    const repo = new GitRepo(root);
    const td = new TextDecoder("utf-8", { fatal: true });
    const read = async (s: { oid: string } | null) => {
      if (!s) return null;
      try {
        return td.decode((await repo.store.read(s.oid)).data);
      } catch {
        return null;
      }
    };
    return { base: await read(c.base), local: await read(c.local), remote: await read(c.remote) };
  }
}

function choiceMap(c: Record<string, Choice>): ReadonlyMap<string, Choice> {
  return new Map(Object.entries(c));
}
