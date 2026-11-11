import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { MemFs, type MemDir, type MemFile } from "./support/memory-fs";
import {
  openOpfs,
  WorkspaceStore,
  isWorkspaceId,
  newWorkspaceId,
  parseMeta,
  unsyncedSince,
  type WorkspaceMeta,
} from "../../src/lib/workspaces/store";
import { exportZip, extractZip, planEntries, planZip } from "../../src/lib/workspaces/zip";
import { detectCapabilities, supportedMode } from "../../src/lib/capabilities";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** ロック解除の鍵で包んだ枠だけを持つ鍵の情報（作業場所はすべて暗号化する：ADR-0012） */
const loginKeyring = async () => ({ v: 1 as const, slots: [{ kind: "login" as const, wrapped: "QUJD" }] });

function seq(): (n: number) => Uint8Array {
  let i = 0;
  return (n) => new Uint8Array(n).map(() => i++ % 251);
}

async function store(fs = new MemFs("opfs")) {
  return { fs, s: await WorkspaceStore.open(fs.root, { now: () => "2026-11-06T00:00:00Z", random: seq() }) };
}

describe("作業場所（38.1）", () => {
  it("ID は 16 文字の英小文字と数字", () => {
    const id = newWorkspaceId();
    expect(isWorkspaceId(id)).toBe(true);
    expect(isWorkspaceId("../x")).toBe(false);
  });

  it("作成・一覧・開く。meta を最後に書く", async () => {
    const { fs, s } = await store();
    const m = await s.create({ name: "  ブログ  ", keyring: loginKeyring });
    expect(m.name).toBe("ブログ");
    expect(fs.get(`kotono/meta/${m.id}.json`)).toBeDefined();
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: "ok", meta: { id: m.id, name: "ブログ" } });
    const root = await s.root(m.id);
    expect(root.name).toBe(m.id);
  });

  it("fill が失敗したら meta を書かず、不完全として表示する（38.2）", async () => {
    const { s } = await store();
    await expect(
      s.create({
        name: "x",
        keyring: loginKeyring,
        fill: async (dir) => {
          await dir.getFileHandle("a.txt", { create: true });
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("incomplete");
  });

  it("名前の検査", async () => {
    const { s } = await store();
    await expect(s.create({ name: "   ", keyring: loginKeyring })).rejects.toThrow("名前を入力");
    await expect(s.create({ name: "a\u0001", keyring: loginKeyring })).rejects.toThrow("制御文字");
  });

  it("壊れた meta は不完全とし、内容を使わない", async () => {
    const { fs, s } = await store();
    const m = await s.create({ name: "x", keyring: loginKeyring });
    fs.write(`kotono/meta/${m.id}.json`, "{");
    expect((await s.list())[0]).toMatchObject({ state: "incomplete" });
    expect(parseMeta(enc(JSON.stringify({ ...m, id: "other" })), m.id)).toContain("ID が一致しません");
    expect(parseMeta(enc(JSON.stringify({ ...m, v: 2 })), m.id)).toContain("未知の版");
  });

  it("鍵の情報に、ロック解除の鍵で包んだ枠がない作業場所は不完全とし、使わない（ADR-0012）", async () => {
    const { fs, s } = await store();
    const m = await s.create({ name: "x", keyring: loginKeyring });
    const recoveryOnly = {
      ...m,
      keyring: { v: 1, slots: [{ kind: "recovery", salt: "QUJD", iterations: 600_000, wrapped: "QUJD" }] },
    };
    expect(parseMeta(enc(JSON.stringify(recoveryOnly)), m.id)).toContain("ロック解除の鍵で包んだ枠がありません");
    expect(parseMeta(enc(JSON.stringify({ ...m, keyring: null })), m.id)).toContain("鍵の情報が不正です");
    fs.write(`kotono/meta/${m.id}.json`, JSON.stringify(recoveryOnly));
    expect((await s.list())[0]).toMatchObject({ state: "incomplete" });
  });

  it("削除は中身を 1 件ずつ消し、退避は残す（19.1 手順8）", async () => {
    const { fs, s } = await store();
    const m = await s.create({ name: "x", keyring: loginKeyring });
    fs.write(`kotono/workspaces/${m.id}/content/articles/abcdefg/index.md`, "a");
    const b = await s.backupRoot(m.id);
    await b.getFileHandle("keep.txt", { create: true });
    expect(await s.remove(m.id)).toEqual({ ok: true });
    expect(await s.list()).toEqual([]);
    expect(fs.get(`kotono/backups/${m.id}/keep.txt`)).toBeDefined();
  });

  it("削除の部分失敗を区別する", async () => {
    const { fs, s } = await store();
    const m = await s.create({ name: "x", keyring: loginKeyring });
    fs.write(`kotono/workspaces/${m.id}/a.txt`, "a");
    fs.write(`kotono/workspaces/${m.id}/b.txt`, "b");
    fs.faults.beforeRemove = (p) => {
      if (p.endsWith("b.txt")) throw Object.assign(new Error("x"), { name: "NoModificationAllowedError" });
    };
    const r = await s.remove(m.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.remaining).toEqual(["b.txt"]);
  });

  it("端末の外にない変更の判定（38.4）", () => {
    const base: WorkspaceMeta = {
      v: 1,
      id: "a".repeat(16),
      name: "x",
      createdAt: "2026-11-01T00:00:00Z",
      lastExportAt: null,
      lastSyncAt: null,
      lastChangeAt: null,
      keyring: { v: 1, slots: [{ kind: "login", wrapped: "QUJD" }] },
      remote: null,
    };
    expect(unsyncedSince(base)).toBeNull();
    expect(unsyncedSince({ ...base, lastChangeAt: "2026-11-02T00:00:00Z" })).toBe("2026-11-01T00:00:00Z");
    expect(
      unsyncedSince({ ...base, lastChangeAt: "2026-11-02T00:00:00Z", lastSyncAt: "2026-11-03T00:00:00Z" }),
    ).toBeNull();
    expect(unsyncedSince({ ...base, lastChangeAt: "2026-11-04T00:00:00Z", lastExportAt: "2026-11-03T00:00:00Z" })).toBe(
      "2026-11-03T00:00:00Z",
    );
  });
});

describe("保存先の系統（2.1）", () => {
  class FakeHandle {
    createWritable(): void {}
  }
  const common = {
    isSecureContext: true,
    FileSystemFileHandle: FakeHandle,
    Worker: function Worker() {},
    Blob: function Blob() {},
    URL,
    crypto: globalThis.crypto,
    indexedDB: {},
    TextDecoder,
  };
  it("フォルダ選択がなく OPFS があれば作業場所（iOS）", () => {
    const r = detectCapabilities({ ...common, navigator: { storage: { getDirectory: () => undefined } } });
    expect(supportedMode(r)).toBe("workspace");
  });
  it("両方あれば実フォルダを優先し、指定すれば作業場所", () => {
    const r = detectCapabilities({
      ...common,
      showDirectoryPicker: () => undefined,
      navigator: { storage: { getDirectory: () => undefined } },
    });
    expect(supportedMode(r)).toBe("folder");
    expect(supportedMode(r, "workspace")).toBe("workspace");
  });
  it("どちらもなければ非対応", () => {
    expect(supportedMode(detectCapabilities(common))).toBeNull();
  });
});

function zipOf(files: Record<string, string>): Uint8Array {
  const z: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  return zipSync(z);
}

describe("zip の取り込み（38.2）", () => {
  it("1 つのフォルダにまとまった zip はそのフォルダを外す", () => {
    const p = planZip(zipOf({ "site/content/articles/abcdefg/index.md": "a", "site/.git/HEAD": "ref" }));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.strippedRoot).toBe("site");
      expect(p.files.map((f) => f.path).sort()).toEqual([".git/HEAD", "content/articles/abcdefg/index.md"]);
      expect(p.hasGit).toBe(true);
    }
  });

  it("OS の付属物は読み飛ばす", () => {
    const p = planZip(zipOf({ "a.md": "a", "__MACOSX/._a.md": "x", "sub/.DS_Store": "x" }));
    expect(p.ok && p.skipped.length).toBe(2);
  });

  it.each([
    ["../evil", "不正なパス区間"],
    ["/abs", "絶対パス"],
    ["a\\b", "区切り文字"],
    ["c:x", "OS 依存"],
    ["a/./b", "不正なパス区間"],
  ])("危険なパス %s を拒否する", (name, msg) => {
    const p = planEntries([{ name, size: 1, originalSize: 1 }]);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.message).toContain(msg);
  });

  it("大文字小文字・正規化の衝突と重複を拒否する", () => {
    const a = planEntries([
      { name: "A.md", size: 1, originalSize: 1 },
      { name: "a.md", size: 1, originalSize: 1 },
    ]);
    expect(a.ok).toBe(false);
    const b = planEntries([
      { name: "が.md", size: 1, originalSize: 1 },
      { name: "が.md", size: 1, originalSize: 1 },
    ]);
    expect(b.ok).toBe(false);
  });

  it("上限と圧縮率を検査する", () => {
    expect(planEntries([{ name: "a", size: 1, originalSize: 65 * 1024 * 1024 }]).ok).toBe(false);
    expect(planEntries([{ name: "a", size: 10, originalSize: 1024 * 1024 }]).ok).toBe(false);
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, size: 1, originalSize: 1 }));
    expect(planEntries(many, { ...limits(), maxTotalBytes: 3 }).ok).toBe(false);
  });

  it("ファイルとフォルダが同じパスなら拒否する", () => {
    const p = planEntries([
      { name: "a", size: 1, originalSize: 1 },
      { name: "a/b", size: 1, originalSize: 1 },
    ]);
    expect(p.ok).toBe(false);
  });

  it("壊れた zip を拒否する", () => {
    expect(planZip(enc("not a zip")).ok).toBe(false);
  });

  it("展開して読み戻せる。書き出し→取り込みで同じ内容になる（38.3）", async () => {
    const src = new MemFs("src");
    src.write("content/articles/abcdefg/index.md", "---\nid: abcdefg\n---\n本文\n");
    src.write("content/articles/abcdefg/media/q7m2k9w4ac.png", new Uint8Array([137, 80, 78, 71]));
    src.write(".git/HEAD", "ref: refs/heads/main\n");
    src.mkdir(".git/refs/heads/");
    const ex = await exportZip(src.root);
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    const plan = planZip(ex.bytes);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const dst = new MemFs("dst");
    const r = await extractZip(ex.bytes, dst.root, plan);
    expect(r).toMatchObject({ ok: true, files: 3 });
    expect(dec((dst.get("content/articles/abcdefg/index.md") as MemFile).data)).toContain("本文");
    expect(dst.get(".git/refs/heads/") as MemDir).toBeDefined();
  });

  it("既存のファイルを上書きしない", async () => {
    const z = zipOf({ "a.md": "new" });
    const plan = planZip(z);
    if (!plan.ok) throw new Error(plan.message);
    const dst = new MemFs("dst");
    dst.write("a.md", "old");
    const r = await extractZip(z, dst.root, plan);
    expect(r.ok).toBe(false);
    expect(dec((dst.get("a.md") as MemFile).data)).toBe("old");
  });
});

function limits() {
  return {
    maxZipBytes: 1 << 30,
    maxEntries: 100,
    maxFileBytes: 1 << 26,
    maxTotalBytes: 1 << 30,
    maxRatio: 200,
    maxDepth: 32,
  };
}

describe("OPFS を開く（38.1）", () => {
  const noWait = async () => undefined;

  it("一時的に失敗しても、間を置いて試し直す", async () => {
    const fs = new MemFs();
    let n = 0;
    const host = {
      navigator: {
        storage: {
          getDirectory: async () => {
            if (++n < 3) throw Object.assign(new Error("transient"), { name: "UnknownError" });
            return fs.root;
          },
        },
      },
    };
    const r = await openOpfs(host, { delay: noWait });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("開けなければ、例外の名前と内容を理由として返す", async () => {
    const host = {
      navigator: {
        storage: {
          getDirectory: async () => {
            throw Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
          },
        },
      },
    };
    expect(await openOpfs(host, { delay: noWait })).toEqual({
      ok: false,
      reason: "SecurityError：The operation is insecure.",
    });
    expect(await openOpfs({ navigator: {} })).toEqual({
      ok: false,
      reason: "このブラウザは OPFS に対応していません。",
    });
  });
});
