/**
 * ローカル Git 機能とネイティブ Git の相互運用（仕様 20〜22・26.4・TG02 の一部）。
 * 実フォルダを Node の fs で包んで使う。ブラウザの File System Access API での実測（TG01・TG02）の代替ではない。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, withUser, getConfig } from "../../src/lib/git/config";
import { checkGitPath } from "../../src/lib/git/gitfs";
import { parseIndex, serializeIndex } from "../../src/lib/git/index-file";
import { applyDelta } from "../../src/lib/git/objects";
import { validRefName } from "../../src/lib/git/refs";
import { GitRepo, type RepoInfo } from "../../src/lib/git/repo";
import { NodeDirHandle, nodeFaults } from "./support/node-fs";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Native",
  GIT_AUTHOR_EMAIL: "native@example.com",
  GIT_COMMITTER_NAME: "Native",
  GIT_COMMITTER_EMAIL: "native@example.com",
};

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" });
const write = (p: string, t: string | Uint8Array) => {
  mkdirSync(join(dir, p, ".."), { recursive: true });
  writeFileSync(join(dir, p), t);
};
const article = (id: string, title: string) =>
  `---\nid: "${id}"\ntitle: "${title}"\nslug: "${id}"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n本文\n`;

async function open() {
  const root = new NodeDirHandle(dir);
  const repo = new GitRepo(root);
  const info = await repo.inspect();
  const articles = await root.getDirectoryHandle("content").then((c) => c.getDirectoryHandle("articles"));
  return { root, repo, info: info as RepoInfo, articles };
}

const who = { name: "山田 太郎", email: "taro@example.com" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kotono-git-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Local User");
  git("config", "user.email", "local@example.com");
  write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "一"));
  write("content/articles/bbbbbbb/index.md", article("bbbbbbb", "二"));
  write("content/articles/bbbbbbb/media/x.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  write("README.md", "readme\n");
  git("add", "-A");
  git("commit", "-q", "-m", "初期");
});

afterEach(() => {
  nodeFaults.beforeClose = undefined;
  nodeFaults.chromeBlocklist = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("対応構成の判定（20.2）", () => {
  it("通常のリポジトリは書き込み可。ブランチ・作者を読む", async () => {
    const { info } = await open();
    expect(info.kind).toBe("repo");
    expect(info.blockers).toEqual([]);
    expect(info.branch).toBe("main");
    expect(info.identity).toEqual({ name: "Local User", email: "local@example.com" });
    expect(info.headOid).toBe(git("rev-parse", "HEAD").trim());
  });

  it("Git 未使用フォルダは none、.git がファイルなら非対応", async () => {
    rmSync(join(dir, ".git"), { recursive: true });
    expect((await new GitRepo(new NodeDirHandle(dir)).inspect()).kind).toBe("none");
    writeFileSync(join(dir, ".git"), "gitdir: ../elsewhere\n");
    expect((await new GitRepo(new NodeDirHandle(dir)).inspect()).kind).toBe("unsupported");
  });

  it.each([
    ["マージ途中", () => write(".git/MERGE_HEAD", git("rev-parse", "HEAD")), "in-progress"],
    ["index.lock", () => write(".git/index.lock", ""), "lock"],
    ["フック", () => write(".git/hooks/pre-commit", "#!/bin/sh\n"), "hooks"],
    ["署名必須", () => git("config", "commit.gpgsign", "true"), "sign"],
    ["include", () => git("config", "include.path", "../other"), "include"],
    ["LFS", () => write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n"), "attributes"],
    ["alternates", () => write(".git/objects/info/alternates", "/elsewhere\n"), "alternates"],
    ["submodule", () => write(".gitmodules", "[submodule]\n"), "submodule"],
    ["detached HEAD", () => git("checkout", "-q", "--detach"), "detached"],
    ["sparse", () => git("config", "core.sparseCheckout", "true"), "sparse"],
    ["sha256", () => git("config", "extensions.objectformat", "sha256"), "extension"],
  ])("%s は Git 書き込みを止める", async (_n, setup, code) => {
    setup();
    const { info } = await open();
    expect(info.blockers.map((b) => b.code)).toContain(code);
  });

  it("未解決の競合を検出する", async () => {
    git("checkout", "-q", "-b", "other");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "他"));
    git("commit", "-qam", "other");
    git("checkout", "-q", "main");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "本"));
    git("commit", "-qam", "main");
    try {
      git("merge", "-q", "other");
    } catch {
      // 競合で失敗する
    }
    const { repo, info, articles } = await open();
    expect(info.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["in-progress", "conflict"]));
    const { statuses } = await repo.articleStatuses(info, articles, null);
    expect(statuses.get("aaaaaaa")?.state).toBe("conflict");
  });
});

describe("状態（22）", () => {
  it("変更・未追跡・削除・無視を区別する", async () => {
    write(".gitignore", "*.tmp\n");
    git("add", ".gitignore");
    git("commit", "-qm", "ignore");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "変更"));
    write("content/articles/ccccccc/index.md", article("ccccccc", "新"));
    write("content/articles/bbbbbbb/work.tmp", "x");
    rmSync(join(dir, "content/articles/bbbbbbb/media/x.png"));
    const { repo, info, articles } = await open();
    const { statuses, staged } = await repo.articleStatuses(info, articles, null);
    expect(staged).toEqual([]);
    expect(statuses.get("aaaaaaa")?.state).toBe("changed");
    expect(statuses.get("ccccccc")?.state).toBe("untracked");
    const b = statuses.get("bbbbbbb");
    expect(b?.state).toBe("changed");
    expect(b?.files.find((f) => f.path.endsWith("work.tmp"))?.ignored).toBe(true);
    expect(git("status", "--porcelain")).toContain("aaaaaaa");
  });

  it("ネイティブ Git でステージした変更を「既存ステージ」として検出する", async () => {
    write("README.md", "changed\n");
    git("add", "README.md");
    const { repo, info, articles } = await open();
    const { staged } = await repo.articleStatuses(info, articles, null);
    expect(staged).toEqual(["README.md"]);
  });
});

describe("記事単位のコミット（21）", () => {
  it("変更・追加・削除をコミットし、ネイティブ Git が整合と認める", async () => {
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "変更後"));
    write("content/articles/aaaaaaa/media/new.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9]));
    write("README.md", "記事外の変更\n");
    const { repo, info, articles } = await open();
    const r = await repo.plan(info, articles, "aaaaaaa");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.targets.map((t) => [t.path, t.change])).toEqual([
      ["content/articles/aaaaaaa/index.md", "modified"],
      ["content/articles/aaaaaaa/media/new.png", "added"],
    ]);
    const out = await repo.commit(r.plan, "記事を更新: 変更後", who, info.textConversion);
    expect(out.kind).toBe("committed");
    git("fsck", "--strict", "--no-dangling");
    expect(git("log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe(
      "山田 太郎 <taro@example.com>|山田 太郎 <taro@example.com>|記事を更新: 変更後\n",
    );
    // 記事外の変更は含めない（21.1）
    expect(git("status", "--porcelain")).toBe(" M README.md\n");
    expect(git("show", "--name-status", "--format=", "HEAD")).toBe(
      "M\tcontent/articles/aaaaaaa/index.md\nA\tcontent/articles/aaaaaaa/media/new.png\n",
    );
    // reflog も追記されている
    expect(git("reflog", "-1", "--format=%gs")).toBe("commit: 記事を更新: 変更後\n");
  });

  it("新規記事の追加と記事の削除", async () => {
    write("content/articles/ccccccc/index.md", article("ccccccc", "新"));
    let { repo, info, articles } = await open();
    let r = await repo.plan(info, articles, "ccccccc");
    expect(r.ok && r.plan.targets.map((t) => t.change)).toEqual(["added"]);
    if (!r.ok) return;
    expect((await repo.commit(r.plan, "記事を追加: 新", who, false)).kind).toBe("committed");
    rmSync(join(dir, "content/articles/bbbbbbb"), { recursive: true });
    ({ repo, info, articles } = await open());
    r = await repo.plan(info, articles, "bbbbbbb");
    expect(r.ok && r.plan.targets.map((t) => t.change)).toEqual(["deleted", "deleted"]);
    if (!r.ok) return;
    expect((await repo.commit(r.plan, "記事を削除: 二", who, false)).kind).toBe("committed");
    git("fsck", "--strict", "--no-dangling");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("ls-files")).toBe("README.md\ncontent/articles/aaaaaaa/index.md\ncontent/articles/ccccccc/index.md\n");
  });

  it("変更なし・既存ステージ・無視対象は空コミットや強制追加をしない", async () => {
    let { repo, info, articles } = await open();
    expect(await repo.plan(info, articles, "aaaaaaa")).toMatchObject({ ok: false, nothing: true });
    write("README.md", "staged\n");
    git("add", "README.md");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "x"));
    ({ repo, info, articles } = await open());
    const r = await repo.plan(info, articles, "aaaaaaa");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("ステージ");
    git("reset", "-q");
    write(".gitignore", "*.log\n");
    git("add", ".gitignore");
    git("commit", "-qm", "ig");
    write("content/articles/aaaaaaa/debug.log", "x");
    ({ repo, info, articles } = await open());
    const r2 = await repo.plan(info, articles, "aaaaaaa");
    expect(r2.ok && r2.plan.ignored).toEqual(["content/articles/aaaaaaa/debug.log"]);
    expect(r2.ok && r2.plan.targets.map((t) => t.path)).toEqual(["content/articles/aaaaaaa/index.md"]);
  });

  it("確認後に対象・HEAD が変わったら何も書かずに止める（21.3）", async () => {
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "1"));
    const { repo, info, articles } = await open();
    const r = await repo.plan(info, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "2"));
    expect((await repo.commit(r.plan, "m", who, false)).kind).toBe("stopped");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "1"));
    write("README.md", "外部コミット\n");
    git("commit", "-qam", "external");
    expect((await repo.commit(r.plan, "m", who, false)).kind).toBe("stopped");
    expect(git("log", "--format=%s")).toBe("external\n初期\n");
  });

  it("ステージ後にブランチ更新が失敗したら「ステージ済み」とし、同一セッションで再試行できる（21.4）", async () => {
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "再試行"));
    const { repo, info, articles } = await open();
    const r = await repo.plan(info, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    nodeFaults.beforeClose = (p) => {
      if (p.endsWith("refs/heads/main")) throw Object.assign(new Error("x"), { name: "NoModificationAllowedError" });
    };
    const out = await repo.commit(r.plan, "記事を更新", who, false);
    expect(out.kind).toBe("staged");
    // ネイティブ Git からは「ステージ済み・未コミット」に見える
    expect(git("status", "--porcelain")).toBe("M  content/articles/aaaaaaa/index.md\n");
    nodeFaults.beforeClose = undefined;
    if (out.kind !== "staged") return;
    const again = await repo.commit(r.plan, "記事を更新", who, false, { stagedChecksum: out.stagedChecksum });
    expect(again).toMatchObject({ kind: "committed" });
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%s")).toBe("記事を更新\n初期\n");
  });

  it("index の書き込みが失敗しても index・ブランチは変わらない", async () => {
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "x"));
    const { repo, info, articles } = await open();
    const r = await repo.plan(info, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    const before = readFileSync(join(dir, ".git/index"));
    nodeFaults.beforeClose = (p) => {
      if (p.endsWith(".git/index")) throw Object.assign(new Error("x"), { name: "QuotaExceededError" });
    };
    expect((await repo.commit(r.plan, "m", who, false)).kind).toBe("stopped");
    expect(readFileSync(join(dir, ".git/index")).equals(before)).toBe(true);
    expect(git("log", "--format=%s")).toBe("初期\n");
  });

  it("改行変換が設定され CR を含むテキストは止める", async () => {
    git("config", "core.autocrlf", "true");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "crlf").replace(/\n/g, "\r\n"));
    const { repo, info, articles } = await open();
    expect(info.textConversion).toBe(true);
    const r = await repo.plan(info, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    const out = await repo.commit(r.plan, "m", who, info.textConversion);
    expect(out).toMatchObject({ kind: "stopped" });
  });

  it("実行属性付きで記録された記事はコミットしない", async () => {
    git("update-index", "--chmod=+x", "content/articles/aaaaaaa/index.md");
    git("commit", "-qm", "exec");
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "x"));
    const { repo, info, articles } = await open();
    const r = await repo.plan(info, articles, "aaaaaaa");
    expect(!r.ok && r.message).toContain("実行属性");
  });
});

describe("pack・履歴（22・34.4）", () => {
  it("gc 後の pack（delta を含む）から読み、記事別の履歴がネイティブ Git と一致する", async () => {
    for (let i = 0; i < 8; i++) {
      write("content/articles/aaaaaaa/index.md", article("aaaaaaa", `版${i}`) + "長い本文\n".repeat(50));
      git("commit", "-qam", `a${i}`);
      if (i % 3 === 0) {
        write("README.md", `r${i}\n`);
        git("commit", "-qam", `r${i}`);
      }
    }
    git("gc", "-q", "--aggressive");
    expect(existsSync(join(dir, ".git/packed-refs"))).toBe(true);
    const { repo, info, articles } = await open();
    expect(info.blockers).toEqual([]);
    const cur = await repo.startHistory(info.headOid, "content/articles/aaaaaaa");
    if (!cur) throw new Error("no head");
    const page = await repo.history(cur);
    expect(page.items.map((i) => i.oid).join("\n") + "\n").toBe(
      git("log", "--format=%H", "--", "content/articles/aaaaaaa"),
    );
    const all = await repo.history((await repo.startHistory(info.headOid, null)) as NonNullable<typeof cur>);
    expect(all.items.map((i) => i.oid).join("\n") + "\n").toBe(git("log", "--format=%H"));
    const { statuses } = await repo.articleStatuses(info, articles, null);
    expect([...statuses.values()].every((s) => s.state === "clean")).toBe(true);
    // pack 化後もコミットできる
    write("content/articles/aaaaaaa/index.md", article("aaaaaaa", "pack後"));
    const info2 = (await repo.inspect()) as RepoInfo;
    const r = await repo.plan(info2, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    expect((await repo.commit(r.plan, "after gc", who, false)).kind).toBe("committed");
    git("fsck", "--strict", "--no-dangling");
  }, 30_000);

  it("50件ずつ表示し、続きのカーソルを返す", async () => {
    for (let i = 0; i < 55; i++) git("commit", "-q", "--allow-empty", "-m", `e${i}`);
    const { repo, info } = await open();
    const cur = await repo.startHistory(info.headOid, null);
    if (!cur) throw new Error("no head");
    const p1 = await repo.history(cur);
    expect(p1.items).toHaveLength(50);
    expect(p1.cursor).not.toBeNull();
    const p2 = await repo.history(p1.cursor as NonNullable<typeof p1.cursor>);
    expect(p2.items).toHaveLength(6);
    expect(p2.cursor).toBeNull();
  }, 30_000);

  it("shallow で親が見つからない場合は終端不確かとして示す", async () => {
    for (let i = 0; i < 3; i++) git("commit", "-q", "--allow-empty", "-m", `s${i}`);
    const src = dir;
    dir = mkdtempSync(join(tmpdir(), "kotono-shallow-"));
    execFileSync("git", ["clone", "-q", "--depth", "2", `file://${src}`, dir], { env: ENV });
    const repo = new GitRepo(new NodeDirHandle(dir));
    const info = (await repo.inspect()) as RepoInfo;
    expect(info.notes.join()).toContain("shallow");
    const page = await repo.history((await repo.startHistory(info.headOid, null)) as never);
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(true);
    rmSync(src, { recursive: true, force: true });
  });
});

describe("git init と作者設定（20.1・21.2）", () => {
  it("CMS で初期化したリポジトリにコミットでき、ネイティブ Git が読める", async () => {
    rmSync(join(dir, ".git"), { recursive: true });
    const root = new NodeDirHandle(dir);
    const repo = new GitRepo(root);
    expect(await repo.init()).toEqual({ ok: true, configSkipped: false });
    expect(await repo.init()).toMatchObject({ ok: false });
    const info = (await repo.inspect()) as RepoInfo;
    expect(info.blockers).toEqual([]);
    expect(info.headOid).toBeNull();
    const articles = await (await root.getDirectoryHandle("content")).getDirectoryHandle("articles");
    const r = await repo.plan(info, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    expect((await repo.commit(r.plan, "最初の記事", who, false)).kind).toBe("committed");
    git("fsck", "--strict", "--no-dangling");
    expect(git("log", "--format=%s")).toBe("最初の記事\n");
    expect(git("status", "--porcelain")).toBe("?? README.md\n?? content/articles/bbbbbbb/\n");
  });

  it("ブラウザが .git/config の作成を禁止しても初期化でき、コミットとネイティブ Git が動く", async () => {
    rmSync(join(dir, ".git"), { recursive: true });
    nodeFaults.chromeBlocklist = true;
    const root = new NodeDirHandle(dir);
    const repo = new GitRepo(root);
    expect(await repo.init()).toEqual({ ok: true, configSkipped: true });
    expect(existsSync(join(dir, ".git/config"))).toBe(false);
    const info = (await repo.inspect()) as RepoInfo;
    expect(info.blockers).toEqual([]);
    expect(info.identity).toBeNull();
    const articles = await (await root.getDirectoryHandle("content")).getDirectoryHandle("articles");
    const r = await repo.plan(info, articles, "aaaaaaa");
    if (!r.ok) throw new Error(r.message);
    expect((await repo.commit(r.plan, "最初の記事", who, false)).kind).toBe("committed");
    // 作者の保存は禁止を説明して止める（コミットには影響しない）
    await expect(repo.saveIdentity(who)).rejects.toThrow(/\.git\/config.*git config user\.name/);
    git("fsck", "--strict", "--no-dangling");
    expect(git("log", "--format=%s")).toBe("最初の記事\n");
    expect(git("status", "--porcelain")).toBe("?? README.md\n?? content/articles/bbbbbbb/\n");
    // 外部の Git で init をやり直すと設定ファイルが作られ、履歴はそのまま
    git("init", "-q");
    expect(existsSync(join(dir, ".git/config"))).toBe(true);
    expect(git("log", "--format=%s")).toBe("最初の記事\n");
  });

  it("初期化が途中で失敗したら、作りかけの .git を片付ける", async () => {
    rmSync(join(dir, ".git"), { recursive: true });
    nodeFaults.beforeClose = (p) => {
      if (p.endsWith("description")) throw new Error("disk full");
    };
    const repo = new GitRepo(new NodeDirHandle(dir));
    const r = await repo.init();
    expect(r).toMatchObject({ ok: false, left: [] });
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(await repo.inspect()).toEqual({ kind: "none" });
  });

  it("片付けで中身のあるフォルダは消さず、残りを報告する", async () => {
    rmSync(join(dir, ".git"), { recursive: true });
    nodeFaults.beforeClose = (p) => {
      if (p.endsWith("description")) {
        // 外部の処理が途中で .git にファイルを置いた
        writeFileSync(join(dir, ".git/info/exclude"), "x\n");
        throw new Error("disk full");
      }
    };
    const r = await new GitRepo(new NodeDirHandle(dir)).init();
    expect(r).toMatchObject({ ok: false, left: [".git", ".git/info"] });
    expect(readFileSync(join(dir, ".git/info/exclude"), "utf8")).toBe("x\n");
  });

  it("user.name・user.email を保存し、他の設定は変えない", async () => {
    git("config", "--unset", "user.name");
    git("config", "core.ignorecase", "true");
    const repo = new GitRepo(new NodeDirHandle(dir));
    expect(((await repo.inspect()) as RepoInfo).identity).toBeNull();
    await repo.saveIdentity({ name: "佐藤 花子", email: "hanako@example.com" });
    expect(git("config", "user.name")).toBe("佐藤 花子\n");
    expect(git("config", "user.email")).toBe("hanako@example.com\n");
    expect(git("config", "core.ignorecase")).toBe("true\n");
    await expect(repo.saveIdentity({ name: "a<b", email: "x" })).rejects.toThrow();
  });
});

describe("部品", () => {
  it("index を読み書きしてネイティブ Git の index と同じ内容になる", async () => {
    const bytes = new Uint8Array(readFileSync(join(dir, ".git/index")));
    const idx = await parseIndex(bytes);
    expect(idx.entries.map((e) => e.path)).toEqual([
      "README.md",
      "content/articles/aaaaaaa/index.md",
      "content/articles/bbbbbbb/index.md",
      "content/articles/bbbbbbb/media/x.png",
    ]);
    const again = await parseIndex(await serializeIndex(idx.entries));
    expect(again.entries).toEqual(idx.entries);
  });

  it("delta の範囲外コピーを拒否する", () => {
    expect(() => applyDelta(new Uint8Array(4), new Uint8Array([4, 8, 0x91, 0, 8]), 100)).toThrow();
  });

  it("ref 名・Git パスの検証", () => {
    expect(validRefName("refs/heads/main")).toBe(true);
    for (const bad of ["refs/heads/a..b", "refs/heads/.x", "refs/heads/x.lock", "refs/heads/a b", "refs/heads/a@{1}"])
      expect(validRefName(bad)).toBe(false);
    expect(checkGitPath("content/articles/x/index.md")).toBeNull();
    for (const bad of ["../x", "a//b", "/abs", "a\\b", "c:x", "a./b"]) expect(checkGitPath(bad)).not.toBeNull();
  });

  it("config の user だけを書き換える", () => {
    const c = parseConfig('[core]\n\tbare = false\n[user]\n\tname = "Old Name"\n# comment\n');
    const t = withUser(c, "New", "n@example.com");
    expect(t).toContain("# comment");
    const p = parseConfig(t);
    expect(getConfig(p, "user.name")).toBe("New");
    expect(getConfig(p, "user.email")).toBe("n@example.com");
    expect(getConfig(p, "core.bare")).toBe("false");
  });
});
