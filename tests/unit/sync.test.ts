/**
 * GitHub との同期（仕様 3.2 第40章）。GitHub の REST API を、ネイティブ Git のリポジトリを裏に持つ
 * 偽の応答で代替する。日時は GitHub と同じく UTC で返し、時差の復元も確かめる。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemFs, type MemFile } from "./support/memory-fs";
import { GitRepo, type RepoInfo } from "../../src/lib/git/repo";
import { GitHubApi, parseRepoInput, type ApiCommit, type FetchLike } from "../../src/lib/sync/github-api";
import { GitHubSync, isoDate, rebuildCommit } from "../../src/lib/sync/sync";
import { encodeUtf8 } from "../../src/lib/core/bytes";
import { hashObject } from "../../src/lib/git/objects";
import { mergeText } from "../../src/lib/sync/merge";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kotono-sync-"));
  dirs.push(d);
  return d;
}

const article = (id: string, body: string, updated = "2026-11-06T10:00:00+09:00") =>
  `---\nid: "${id}"\ntitle: "題名"\nslug: "${id}"\nstatus: "draft"\ncreatedAt: "2026-11-06T10:00:00+09:00"\nupdatedAt: "${updated}"\npublishedAt: null\ntags: []\ncover: null\n---\n${body}`;

class NativeRemote {
  readonly dir = tmp();
  constructor() {
    this.git("init", "-q", "-b", "main");
  }
  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, env: ENV, encoding: "utf8" });
  }
  gitIn(input: string | Buffer, env: Record<string, string>, ...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, env: { ...ENV, ...env }, input, encoding: "utf8" }).trim();
  }
  commitFiles(files: Record<string, string>, msg: string, date = "2026-11-06T10:00:00+09:00"): string {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, p)), { recursive: true });
      writeFileSync(join(this.dir, p), c);
    }
    this.git("add", "-A");
    execFileSync("git", ["commit", "-q", "-m", msg], {
      cwd: this.dir,
      env: {
        ...ENV,
        GIT_AUTHOR_NAME: "R",
        GIT_AUTHOR_EMAIL: "r@example.com",
        GIT_COMMITTER_NAME: "R",
        GIT_COMMITTER_EMAIL: "r@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    return this.git("rev-parse", "HEAD").trim();
  }

  /** api.github.com の Git Data の一部を、このリポジトリで答える */
  fetcher: FetchLike = async (url, init) => {
    const u = new URL(url);
    expect(u.origin).toBe("https://api.github.com");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer t0ken");
    const path = u.pathname.replace(/^\/repos\/o\/r/, "");
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const json = (status: number, v: unknown) =>
      new Response(JSON.stringify(v), { status, headers: { "x-ratelimit-remaining": "4999" } });
    try {
      if (method === "GET" && path === "") return json(200, { full_name: "o/r" });
      let m = /^\/git\/ref\/heads\/(.+)$/.exec(path);
      if (method === "GET" && m) {
        try {
          return json(200, {
            object: { sha: this.git("rev-parse", "--verify", `refs/heads/${m[1]}`).trim(), type: "commit" },
          });
        } catch {
          return json(404, { message: "Not Found" });
        }
      }
      m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path);
      if (method === "GET" && m) {
        const sha = m[1] as string;
        const raw = this.git("cat-file", "commit", sha);
        const [head, ...rest] = raw.split("\n\n");
        const lines = (head as string).split("\n");
        const sig = (k: string) => {
          const l = lines.find((x) => x.startsWith(`${k} `)) as string;
          const mm = /^\S+ (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(l) as RegExpExecArray;
          return { name: mm[1], email: mm[2], date: new Date(Number(mm[3]) * 1000).toISOString().replace(".000", "") };
        };
        return json(200, {
          sha,
          tree: { sha: lines[0]?.slice(5) },
          parents: lines.filter((l) => l.startsWith("parent ")).map((l) => ({ sha: l.slice(7) })),
          author: sig("author"),
          committer: sig("committer"),
          // GitHub は末尾の改行を落として返す
          message: rest.join("\n\n").replace(/\n$/, ""),
          verification: { verified: false, reason: "unsigned", signature: null, payload: null },
        });
      }
      m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path);
      if (method === "GET" && m) {
        const tree = this.git("ls-tree", m[1] as string)
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [meta, p] = l.split("\t");
            const [mode, type, sha] = (meta as string).split(" ");
            return { path: p, mode, type, sha };
          });
        return json(200, { sha: m[1], tree, truncated: false });
      }
      m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
      if (method === "GET" && m) {
        const b = execFileSync("git", ["cat-file", "blob", m[1] as string], { cwd: this.dir, env: ENV });
        return json(200, { sha: m[1], content: b.toString("base64"), encoding: "base64" });
      }
      if (method === "POST" && path === "/git/blobs") {
        const sha = this.gitIn(Buffer.from(String(body?.["content"]), "base64"), {}, "hash-object", "-w", "--stdin");
        return json(201, { sha });
      }
      if (method === "POST" && path === "/git/trees") {
        const entries = body?.["tree"] as { path: string; mode: string; type: string; sha: string }[];
        const sha = this.gitIn(entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}\n`).join(""), {}, "mktree");
        return json(201, { sha });
      }
      if (method === "POST" && path === "/git/commits") {
        const a = body?.["author"] as { name: string; email: string; date: string };
        const c = body?.["committer"] as { name: string; email: string; date: string };
        const parents = (body?.["parents"] as string[]).flatMap((p) => ["-p", p]);
        const sha = this.gitIn(
          String(body?.["message"]),
          {
            GIT_AUTHOR_NAME: a.name,
            GIT_AUTHOR_EMAIL: a.email,
            GIT_AUTHOR_DATE: a.date,
            GIT_COMMITTER_NAME: c.name,
            GIT_COMMITTER_EMAIL: c.email,
            GIT_COMMITTER_DATE: c.date,
          },
          "commit-tree",
          String(body?.["tree"]),
          ...parents,
        );
        return json(201, { sha });
      }
      m = /^\/git\/refs\/heads\/(.+)$/.exec(path);
      if (method === "PATCH" && m) {
        const cur = this.git("rev-parse", `refs/heads/${m[1]}`).trim();
        const next = String(body?.["sha"]);
        expect(body?.["force"]).toBe(false);
        try {
          this.git("merge-base", "--is-ancestor", cur, next);
        } catch {
          return json(422, { message: "Update is not a fast forward" });
        }
        this.git("update-ref", `refs/heads/${m[1]}`, next, cur);
        if (this.git("symbolic-ref", "HEAD").trim() === `refs/heads/${m[1]}`) this.git("reset", "-q", "--hard");
        return json(200, { object: { sha: next } });
      }
      return json(404, { message: `unhandled ${method} ${path}` });
    } catch (e) {
      return json(500, { message: String(e) });
    }
  };
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const read = (fs: MemFs, p: string) => dec((fs.get(p) as MemFile).data);

async function localCommit(repo: GitRepo, fs: MemFs, id: string, text: string, msg: string): Promise<string> {
  fs.write(`content/articles/${id}/index.md`, text);
  const info = (await repo.inspect()) as RepoInfo;
  const a = await fs.root.getDirectoryHandle("content").then((d) => d.getDirectoryHandle("articles"));
  const p = await repo.plan(info, a, id);
  if (!p.ok) throw new Error(p.message);
  const out = await repo.commit(p.plan, msg, { name: "L", email: "l@example.com" }, false);
  if (out.kind !== "committed") throw new Error(JSON.stringify(out));
  return out.oid;
}

async function setup() {
  const remote = new NativeRemote();
  remote.commitFiles(
    { "content/articles/aaaaaaa/index.md": article("aaaaaaa", "一行目\n二行目\n三行目\n"), "README.md": "r\n" },
    "最初",
  );
  const fs = new MemFs("local");
  const repo = new GitRepo(fs.root);
  const init = await repo.init("main");
  if (!init.ok) throw new Error("init");
  const api = new GitHubApi({ owner: "o", repo: "r", branch: "main" }, "t0ken", remote.fetcher);
  const sync = new GitHubSync(repo, api, 540);
  return { remote, fs, repo, api, sync };
}

describe("GitHub との同期（40）", () => {
  it("入力の解釈と日時の形式", () => {
    expect(parseRepoInput("https://github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseRepoInput("o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseRepoInput("o/r/x")).toBeNull();
    expect(isoDate({ name: "", email: "", time: 1793955600, tzMinutes: 540 })).toBe("2026-11-06T18:00:00+09:00");
    expect(isoDate({ name: "", email: "", time: 0, tzMinutes: -150 })).toBe("1969-12-31T21:30:00-02:30");
  });

  it("空の作業場所へ取得し（初回の pull）、コミットを送る", async () => {
    const { remote, fs, repo, sync } = await setup();
    const asked: string[][] = [];
    const r = await sync.pull(async (c) => {
      asked.push(c.map((x) => x.path));
      return true;
    });
    expect(r.kind).toBe("fast-forward");
    expect(asked[0]).toEqual(["README.md", "content/articles/aaaaaaa/index.md"]);
    expect(read(fs, "content/articles/aaaaaaa/index.md")).toContain("二行目");
    expect(await repo.refs.resolve("refs/heads/main")).toBe(remote.git("rev-parse", "HEAD").trim());

    const oid = await localCommit(repo, fs, "bbbbbbb", article("bbbbbbb", "新しい記事\n"), "記事を追加");
    expect(await sync.state()).toEqual({ kind: "ahead", count: 1 });
    const p = await sync.push();
    expect(p).toEqual({ kind: "pushed", head: oid, commits: 1 });
    expect(remote.git("rev-parse", "HEAD").trim()).toBe(oid);
    remote.git("fsck", "--strict");
    expect(remote.git("show", "HEAD:content/articles/bbbbbbb/index.md")).toContain("新しい記事");
    expect(await sync.state()).toEqual({ kind: "up-to-date" });
  });

  it("手元で変更したままのファイルがあれば書き換えない", async () => {
    const { remote, fs, sync } = await setup();
    await sync.pull(async () => true);
    remote.commitFiles({ "content/articles/aaaaaaa/index.md": article("aaaaaaa", "リモート\n") }, "変更");
    fs.write("content/articles/aaaaaaa/index.md", "手元の未コミット\n");
    const r = await sync.pull(async () => true);
    expect(r.kind).toBe("stopped");
    if (r.kind === "stopped") expect(r.message).toContain("aaaaaaa");
    expect(read(fs, "content/articles/aaaaaaa/index.md")).toBe("手元の未コミット\n");
  });

  it("分岐したら記事を行単位で合わせ、マージコミットを送る（ネイティブ Git と同じ tree）", async () => {
    const { remote, fs, repo, sync } = await setup();
    await sync.pull(async () => true);
    const base = remote.git("rev-parse", "HEAD").trim();
    // リモート：3 行目と別の記事、手元：1 行目
    const theirs = remote.commitFiles(
      {
        "content/articles/aaaaaaa/index.md": article("aaaaaaa", "一行目\n二行目\n三行目（リモート）\n"),
        "content/articles/ccccccc/index.md": article("ccccccc", "別の記事\n"),
      },
      "リモートの変更",
      "2026-11-06T12:00:00-05:00",
    );
    const ours = await localCommit(
      repo,
      fs,
      "aaaaaaa",
      article("aaaaaaa", "一行目（手元）\n二行目\n三行目\n"),
      "手元の変更",
    );
    expect(await sync.push()).toEqual({ kind: "diverged" });
    const r = await sync.pull(async () => true);
    expect(r.kind).toBe("merge-needed");
    if (r.kind !== "merge-needed") return;
    expect(r.plan.base).toBe(base);
    expect(r.plan.conflicts).toEqual([]);
    const done = await sync.completeMerge(r.plan, new Map(), { name: "L", email: "l@example.com" }, async () => true);
    if (!done.ok) throw new Error(done.message);
    expect(read(fs, "content/articles/aaaaaaa/index.md")).toContain("一行目（手元）\n二行目\n三行目（リモート）");
    expect(read(fs, "content/articles/ccccccc/index.md")).toContain("別の記事");
    const p = await sync.push();
    expect(p.kind).toBe("pushed");
    remote.git("fsck", "--strict");
    // ネイティブ Git のマージ結果と tree が一致する
    const nativeTree = remote.git("merge-tree", "--write-tree", ours, theirs).split("\n")[0];
    expect(remote.git("rev-parse", `${done.head}^{tree}`).trim()).toBe(nativeTree);
  });

  it("同じ行の両側の変更は競合として選ばせる", async () => {
    const { remote, fs, repo, sync } = await setup();
    await sync.pull(async () => true);
    remote.commitFiles(
      { "content/articles/aaaaaaa/index.md": article("aaaaaaa", "一行目（リモート）\n二行目\n三行目\n") },
      "r",
    );
    await localCommit(repo, fs, "aaaaaaa", article("aaaaaaa", "一行目（手元）\n二行目\n三行目\n"), "l");
    const r = await sync.pull(async () => true);
    if (r.kind !== "merge-needed") throw new Error(r.kind);
    expect(r.plan.conflicts.map((c) => c.path)).toEqual(["content/articles/aaaaaaa/index.md"]);
    const missing = await sync.completeMerge(
      r.plan,
      new Map(),
      { name: "L", email: "l@example.com" },
      async () => true,
    );
    expect(missing.ok).toBe(false);
    await sync.saveMergeState(r.plan, new Map([["content/articles/aaaaaaa/index.md", "remote"]]));
    const st = await sync.loadMergeState();
    expect(st?.choices.get("content/articles/aaaaaaa/index.md")).toBe("remote");
    const done = await sync.completeMerge(
      r.plan,
      st?.choices ?? new Map(),
      { name: "L", email: "l@example.com" },
      async () => true,
    );
    if (!done.ok) throw new Error(done.message);
    expect(read(fs, "content/articles/aaaaaaa/index.md")).toContain("一行目（リモート）");
    expect(await sync.loadMergeState()).toBeNull();
    expect((await sync.push()).kind).toBe("pushed");
  });
});

describe("署名つきコミットの復元（40）", () => {
  it("GitHub の画面で作ったマージコミット（web-flow の署名、末尾に空の継続行）を ID どおりに復元する", async () => {
    const c = JSON.parse(
      readFileSync(join(__dirname, "../fixtures/github/web-flow-merge-commit.json"), "utf8"),
    ) as ApiCommit;
    const bytes = await rebuildCommit(c, 540);
    expect(bytes).not.toBeNull();
    expect(await hashObject("commit", bytes as Uint8Array)).toBe(c.sha);
  });

  it("通常の Git で署名したコミット（末尾の空行なし）も復元する", async () => {
    const sig = "-----BEGIN PGP SIGNATURE-----\n\nAAAA\n=BBBB\n-----END PGP SIGNATURE-----\n";
    const head =
      "tree 1c097bcc8a3f975ee4051dee5d23a29ae66153d9\n" +
      "author A <a@example.com> 1793959150 +0900\n" +
      "committer A <a@example.com> 1793959150 +0900\n";
    const body = "\nmsg\n";
    const raw = `${head}gpgsig ${sig.replace(/\n$/, "").split("\n").join("\n ")}\n${body}`;
    const sha = await hashObject("commit", encodeUtf8(raw));
    const c: ApiCommit = {
      sha,
      tree: "1c097bcc8a3f975ee4051dee5d23a29ae66153d9",
      parents: [],
      author: { name: "A", email: "a@example.com", date: "2026-11-06T09:59:10Z" },
      committer: { name: "A", email: "a@example.com", date: "2026-11-06T09:59:10Z" },
      message: "msg\n",
      signature: { signature: sig, payload: head + body },
    };
    const bytes = await rebuildCommit(c, 540);
    expect(bytes).not.toBeNull();
    expect(await hashObject("commit", bytes as Uint8Array)).toBe(sha);
  });
});

describe("行単位の三方向マージ（40.5）", () => {
  const b = article("aaaaaaa", "a\nb\nc\nd\ne\n", "2026-11-01T00:00:00Z");
  it("重ならない変更は両方当てる。updatedAt は新しい方", () => {
    const l = article("aaaaaaa", "A\nb\nc\nd\ne\n", "2026-11-02T00:00:00Z");
    const r = article("aaaaaaa", "a\nb\nc\nd\nE\n", "2026-11-03T00:00:00Z");
    expect(mergeText(b, l, r)).toBe(article("aaaaaaa", "A\nb\nc\nd\nE\n", "2026-11-03T00:00:00Z"));
  });
  it("重なる・接する変更は競合", () => {
    expect(mergeText(b, b.replace("b\n", "B\n"), b.replace("b\n", "X\n"))).toBeNull();
    expect(mergeText(b, b.replace("b\n", "B\n"), b.replace("c\n", "C\n"))).toBeNull();
  });
  it("id の食い違いは競合", () => {
    expect(mergeText(b, b.replace('id: "aaaaaaa"', 'id: "bbbbbbb"'), b.replace("e\n", "E\n"))).toBeNull();
  });
});
