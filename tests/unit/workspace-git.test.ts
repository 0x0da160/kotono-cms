/**
 * 暗号化した作業場所の上で自前の Git 層が動き、書き出した zip をネイティブ Git が整合と認めること
 * （仕様 3.2 第38・39章、TG02 の作業場所版の一部。OPFS 実機の代替ではない）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { MemFs } from "./support/memory-fs";
import { Vault } from "../../src/lib/crypto/vault";
import { GitRepo, type RepoInfo } from "../../src/lib/git/repo";
import { writeNewFile } from "../../src/lib/fs/tree";
import { WorkspaceStore } from "../../src/lib/workspaces/store";
import { exportZip } from "../../src/lib/workspaces/zip";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const article = (id: string) =>
  `---\nid: "${id}"\ntitle: "題名"\nslug: "${id}"\nstatus: "draft"\ncreatedAt: "2026-11-06T10:00:00+09:00"\nupdatedAt: "2026-11-06T10:00:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n本文\n`;

describe("暗号化した作業場所での Git（38・39）", () => {
  it("初期化・コミットし、書き出しをネイティブ Git で検証する", async () => {
    const v = new Vault(null, 100_000);
    const fs = new MemFs("opfs");
    const store = await WorkspaceStore.open(fs.root);
    const place = await v.newKey();
    const login = await v.newLogin();
    v.adopt("login", login.key);
    const meta = await store.create({ name: "site", keyring: (id) => v.placeKeyring("login", id, place) });
    v.adopt(meta.id, place);
    const root = await v.wrapOpened(await store.root(meta.id), meta.id);

    const repo = new GitRepo(root);
    const init = await repo.init("main");
    expect(init.ok).toBe(true);
    // OPFS には Chromium の .git/config の書き込み禁止がない（ADR-0004 緊張点 11 は当てはまらない）
    if (init.ok) expect(init.configSkipped).toBe(false);

    const c = await root.getDirectoryHandle("content", { create: true });
    const a = await c.getDirectoryHandle("articles", { create: true });
    const art = await a.getDirectoryHandle("k7m2x9q", { create: true });
    expect((await writeNewFile(art, "index.md", new TextEncoder().encode(article("k7m2x9q")))).ok).toBe(true);

    const info = (await repo.inspect()) as RepoInfo;
    expect(info.kind).toBe("repo");
    const p = await repo.plan(info, a, "k7m2x9q");
    if (!p.ok) throw new Error(p.message);
    const out = await repo.commit(p.plan, "記事を追加", { name: "T", email: "t@example.com" }, false);
    expect(out.kind).toBe("committed");

    const ex = await exportZip(root);
    if (!ex.ok) throw new Error(ex.message);
    dir = mkdtempSync(join(tmpdir(), "kotono-ws-"));
    for (const [name, bytes] of Object.entries(unzipSync(ex.bytes))) {
      const target = join(dir, name);
      if (name.endsWith("/")) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" });
    git("fsck", "--strict");
    expect(git("log", "--format=%s")).toBe("記事を追加\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "HEAD:content/articles/k7m2x9q/index.md")).toContain("本文");
  });
});
