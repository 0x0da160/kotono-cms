/**
 * GitHub の REST API（Git Data）の最小限の呼び出し（仕様 3.2 第40章、ADR-0006 第8章）。
 *
 * - 通信先は api.github.com に固定する（40.2）。トークンは Authorization ヘッダーだけに使い、表示・記録しない。
 * - 応答は未信頼入力として形を確かめる。
 */
export const GITHUB_API = "https://api.github.com";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteTarget {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "auth" | "not-found" | "empty" | "conflict" | "rate" | "network" | "invalid" | "other",
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface ApiCommit {
  readonly sha: string;
  readonly tree: string;
  readonly parents: string[];
  readonly author: { name: string; email: string; date: string };
  readonly committer: { name: string; email: string; date: string };
  readonly message: string;
  /** 署名つきのとき、署名を除いたコミットの本体と署名 */
  readonly signature: { payload: string; signature: string } | null;
}

export interface ApiTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
}

const OID = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function validTarget(t: RemoteTarget): string | null {
  if (!NAME.test(t.owner) || !NAME.test(t.repo)) return "所有者・リポジトリ名に使えない文字があります。";
  if (t.repo === "." || t.repo === "..") return "リポジトリ名が不正です。";
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(t.branch) || t.branch.includes("..") || t.branch.startsWith("/"))
    return "ブランチ名が不正です。";
  return null;
}

/** 「owner/repo」や GitHub の URL から所有者とリポジトリを取り出す */
export function parseRepoInput(s: string): { owner: string; repo: string } | null {
  const t = s
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(t);
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

/** トークンの作成ページで、既定にする有効期限（日） */
export const PAT_EXPIRES_DAYS = 90;

/**
 * fine-grained personal access token の作成ページの URL。名前・説明・所有者・有効期限・Contents の読み書きを
 * 入力した状態で開く（GitHub の作成ページの URL パラメーター）。リポジトリの選択は GitHub 側で利用者が行う。
 * 利用者が押したときに開くだけで、CMS は github.com と通信しない。
 */
export function patCreationUrl(target: { owner: string; repo: string } | null): string {
  const q = new URLSearchParams({
    name: target ? `Kotono CMS ${target.repo}`.slice(0, 40) : "Kotono CMS",
    description: target
      ? `Kotono CMS から ${target.owner}/${target.repo} へ同期するためのトークン`
      : "Kotono CMS から同期するためのトークン",
    ...(target ? { target_name: target.owner } : {}),
    expires_in: String(PAT_EXPIRES_DAYS),
    contents: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${q.toString()}`;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class GitHubApi {
  /** 残りの回数（応答の X-RateLimit-Remaining） */
  remaining: number | null = null;
  calls = 0;

  constructor(
    readonly target: RemoteTarget,
    private readonly token: string,
    private readonly fetcher: FetchLike = (u, i) => fetch(u, i),
  ) {
    const bad = validTarget(target);
    if (bad) throw new GitHubError(bad, 0, "invalid");
  }

  private url(path: string): string {
    return `${GITHUB_API}/repos/${this.target.owner}/${this.target.repo}${path}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    this.calls++;
    try {
      res = await this.fetcher(this.url(path), {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new GitHubError("GitHub に接続できません（オフライン・通信の遮断）。", 0, "network");
    }
    const rem = Number(res.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(rem) && res.headers.has("x-ratelimit-remaining")) this.remaining = rem;
    let json: unknown = null;
    const text = await res.text().catch(() => "");
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return json;
    const msg =
      typeof (json as { message?: unknown })?.message === "string" ? (json as { message: string }).message : "";
    if (res.status === 401)
      throw new GitHubError(
        "トークンが無効か、期限が切れています。「設定」の「トークンの作り方」で作り直して貼り付けてください。",
        401,
        "auth",
      );
    if (res.status === 403 && this.remaining === 0)
      throw new GitHubError("GitHub の回数制限に達しました。しばらく待ってから再試行してください。", 403, "rate");
    if (res.status === 403)
      throw new GitHubError("トークンにこの操作の権限がありません（Contents の読み書きが必要です）。", 403, "auth");
    if (res.status === 404)
      throw new GitHubError("リポジトリ・ブランチが見つからないか、トークンで読めません。", 404, "not-found");
    if (res.status === 409 && /empty/i.test(msg)) throw new GitHubError("リポジトリが空です。", 409, "empty");
    if (res.status === 409 || res.status === 422)
      throw new GitHubError(
        `GitHub が更新を受け付けませんでした（${res.status}${msg ? `：${msg}` : ""}）。`,
        res.status,
        "conflict",
      );
    throw new GitHubError(`GitHub の応答が異常です（${res.status}）。`, res.status, "other");
  }

  /** ブランチの先頭。ブランチ・リポジトリが空なら null */
  async head(): Promise<string | null> {
    try {
      const r = (await this.call("GET", `/git/ref/heads/${encodeRef(this.target.branch)}`)) as {
        object?: { sha?: unknown; type?: unknown };
      };
      const sha = r?.object?.sha;
      if (typeof sha !== "string" || !OID.test(sha) || r.object?.type !== "commit")
        throw new GitHubError("ブランチの応答が不正です。", 200, "invalid");
      return sha;
    } catch (e) {
      if (e instanceof GitHubError && (e.code === "empty" || e.code === "not-found")) {
        // リポジトリ自体が読めないのか、ブランチがないだけかを区別する
        if (e.code === "not-found") await this.call("GET", "");
        return null;
      }
      throw e;
    }
  }

  async commit(sha: string): Promise<ApiCommit> {
    const r = (await this.call("GET", `/git/commits/${sha}`)) as Record<string, unknown>;
    return parseApiCommit(r, sha);
  }

  async tree(sha: string): Promise<ApiTreeEntry[]> {
    const r = (await this.call("GET", `/git/trees/${sha}`)) as { sha?: unknown; tree?: unknown; truncated?: unknown };
    if (r?.sha !== sha || !Array.isArray(r.tree) || r.truncated === true)
      throw new GitHubError("tree の応答が不正です（大きすぎる tree は扱いません）。", 200, "invalid");
    return r.tree.map((e: unknown) => {
      const o = e as Record<string, unknown>;
      if (
        typeof o["path"] !== "string" ||
        typeof o["mode"] !== "string" ||
        typeof o["sha"] !== "string" ||
        !OID.test(o["sha"]) ||
        !(o["type"] === "blob" || o["type"] === "tree" || o["type"] === "commit")
      )
        throw new GitHubError("tree の項目が不正です。", 200, "invalid");
      return { path: o["path"], mode: o["mode"], type: o["type"], sha: o["sha"] } as ApiTreeEntry;
    });
  }

  async blob(sha: string): Promise<Uint8Array> {
    const r = (await this.call("GET", `/git/blobs/${sha}`)) as { sha?: unknown; content?: unknown; encoding?: unknown };
    if (r?.sha !== sha || typeof r.content !== "string" || r.encoding !== "base64")
      throw new GitHubError("blob の応答が不正です。", 200, "invalid");
    try {
      return fromB64(r.content);
    } catch {
      throw new GitHubError("blob の内容を読めません。", 200, "invalid");
    }
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    const r = (await this.call("POST", "/git/blobs", { content: b64(bytes), encoding: "base64" })) as { sha?: unknown };
    return oidOf(r?.sha);
  }

  async createTree(entries: readonly ApiTreeEntry[]): Promise<string> {
    const r = (await this.call("POST", "/git/trees", {
      tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
    })) as { sha?: unknown };
    return oidOf(r?.sha);
  }

  async createCommit(c: {
    message: string;
    tree: string;
    parents: readonly string[];
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  }): Promise<string> {
    const r = (await this.call("POST", "/git/commits", c)) as { sha?: unknown };
    return oidOf(r?.sha);
  }

  /** ref を進める（force なし）。ブランチがまだなければ作る */
  async updateRef(sha: string, create: boolean): Promise<void> {
    if (create) await this.call("POST", "/git/refs", { ref: `refs/heads/${this.target.branch}`, sha });
    else await this.call("PATCH", `/git/refs/heads/${encodeRef(this.target.branch)}`, { sha, force: false });
  }
}

function encodeRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function oidOf(v: unknown): string {
  if (typeof v !== "string" || !OID.test(v))
    throw new GitHubError("作成した object の ID が不正です。", 200, "invalid");
  return v;
}

function person(v: unknown): { name: string; email: string; date: string } {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o["name"] !== "string" || typeof o["email"] !== "string" || typeof o["date"] !== "string")
    throw new GitHubError("コミットの作者情報が不正です。", 200, "invalid");
  return { name: o["name"], email: o["email"], date: o["date"] };
}

export function parseApiCommit(r: Record<string, unknown>, sha: string): ApiCommit {
  if (r?.["sha"] !== sha) throw new GitHubError("コミットの応答が不正です。", 200, "invalid");
  const tree = (r["tree"] as { sha?: unknown } | undefined)?.sha;
  const parents = r["parents"];
  if (typeof tree !== "string" || !OID.test(tree) || !Array.isArray(parents) || typeof r["message"] !== "string")
    throw new GitHubError("コミットの応答が不正です。", 200, "invalid");
  const ps = parents.map((p) => oidOf((p as { sha?: unknown })?.sha));
  const v = r["verification"] as { payload?: unknown; signature?: unknown } | undefined;
  const signature =
    typeof v?.payload === "string" && typeof v.signature === "string"
      ? { payload: v.payload, signature: v.signature }
      : null;
  return {
    sha,
    tree,
    parents: ps,
    author: person(r["author"]),
    committer: person(r["committer"]),
    message: r["message"],
    signature,
  };
}
