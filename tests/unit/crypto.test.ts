import { describe, expect, it } from "vitest";
import { MemFs, type MemDir, type MemFile } from "./support/memory-fs";
import {
  aesEncrypt,
  b64u,
  deriveDataKeys,
  newRecoveryCode,
  normalizeRecoveryCode,
  base32,
  fromBase32,
} from "../../src/lib/crypto/keys";
import { encryptedRoot, CONTENT_OVERHEAD, type EncContext } from "../../src/lib/crypto/encfs";
import { Vault } from "../../src/lib/crypto/vault";
import { accountName, asciiLabel, browserPasskey, prfInputs } from "../../src/lib/crypto/passkey";
import { writeNewFile, enumerateTree, readAllBytes } from "../../src/lib/fs/tree";
import { checkBackupTarget } from "../../src/lib/fs/backup";
import { WorkspaceStore } from "../../src/lib/workspaces/store";
import { exportZip, planZip } from "../../src/lib/workspaces/zip";
import type { FileHandleLike } from "../../src/lib/fs/types";

const enc = (s: string) => new TextEncoder().encode(s);
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("値がありません");
  return v;
}
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function ctx(scope = "w", onUnreadable?: (w: string) => void): Promise<EncContext> {
  const keys = await deriveDataKeys(new Uint8Array(32).fill(7));
  return { keys, scope, workspaceId: "w".repeat(16), ...(onUnreadable ? { onUnreadable } : {}) };
}

describe("鍵の表現", () => {
  it("base32 の往復", () => {
    const b = crypto.getRandomValues(new Uint8Array(44));
    expect(fromBase32(base32(b))).toEqual(b);
  });
  it("回復コードは区切り・大文字小文字を問わない", () => {
    const c = newRecoveryCode();
    expect(c).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    expect(normalizeRecoveryCode(c.toLowerCase().replaceAll("-", " "))).toBe(normalizeRecoveryCode(c));
    expect(normalizeRecoveryCode("short")).toBeNull();
  });
});

describe("暗号化する DirHandleLike（39.4）", () => {
  it("名前と内容を暗号化し、上の層には平文を見せる", async () => {
    const fs = new MemFs("ws");
    const root = encryptedRoot(fs.root, await ctx());
    const a = await root.getDirectoryHandle("content", { create: true });
    const b = await a.getDirectoryHandle("articles", { create: true });
    const c = await b.getDirectoryHandle("k7m2x9q", { create: true });
    const r = await writeNewFile(c, "index.md", enc("---\ntitle: 秘密の題名\n---\n本文"));
    expect(r.ok).toBe(true);
    // 内側：名前に平文がない。内容に平文がない
    const innerNames = [...fs.root.children.keys()];
    expect(innerNames).toHaveLength(1);
    expect(innerNames[0]).not.toContain("content");
    const walk = (d: MemDir): MemFile[] =>
      [...d.children.values()].flatMap((x) => ("children" in x ? walk(x as MemDir) : [x as MemFile]));
    const files = walk(fs.root);
    expect(files).toHaveLength(1);
    expect(dec(must(files[0]).data)).not.toContain("秘密");
    expect(must(files[0]).data.length).toBe(enc("---\ntitle: 秘密の題名\n---\n本文").length + CONTENT_OVERHEAD);
    // 平文の側：列挙・大きさ・内容
    const t = await enumerateTree(root);
    expect(t.ok && t.entries.map((e) => e.path)).toEqual([
      "content",
      "content/articles",
      "content/articles/k7m2x9q",
      "content/articles/k7m2x9q/index.md",
    ]);
    const h = await c.getFileHandle("index.md");
    expect((await h.getFile()).size).toBe(enc("---\ntitle: 秘密の題名\n---\n本文").length);
    const back = await readAllBytes(h, 1 << 20);
    expect(back.ok && dec(back.bytes)).toContain("秘密の題名");
  });

  it("同じ名前は同じ暗号名、別の親では別の暗号名", async () => {
    const fs = new MemFs("ws");
    const root = encryptedRoot(fs.root, await ctx());
    const x = await root.getDirectoryHandle("x", { create: true });
    const y = await root.getDirectoryHandle("y", { create: true });
    await x.getFileHandle("a", { create: true });
    await y.getFileHandle("a", { create: true });
    await root.getDirectoryHandle("x", { create: true });
    expect(fs.root.children.size).toBe(2);
    const nx = [...(fs.root.children.get(must([...fs.root.children.keys()][0])) as MemDir).children.keys()][0];
    const ny = [...(fs.root.children.get(must([...fs.root.children.keys()][1])) as MemDir).children.keys()][0];
    expect(nx).not.toBe(ny);
  });

  it("改ざん・差し替えは読めない（39.3）", async () => {
    const fs = new MemFs("ws");
    const seen: string[] = [];
    const root = encryptedRoot(fs.root, await ctx("w", (w) => seen.push(w)));
    await writeNewFile(root, "a.md", enc("A"));
    await writeNewFile(root, "b.md", enc("B"));
    const inner: Record<string, MemFile> = {};
    for await (const c of root.values()) inner[c.name] = (c as unknown as { inner: MemFile }).inner;
    const fa = must(inner["a.md"]);
    const fb = must(inner["b.md"]);
    // 別パスの暗号文への差し替え
    const orig = fa.data;
    fa.data = fb.data;
    expect((await readAllBytes(await root.getFileHandle("a.md"), 100)).ok).toBe(false);
    // 1 バイトの改ざん
    fa.data = orig.slice();
    fa.data[fa.data.length - 1] = must(fa.data[fa.data.length - 1]) ^ 1;
    expect((await readAllBytes(await root.getFileHandle("a.md"), 100)).ok).toBe(false);
    expect(seen).toContain("a.md");
    fa.data = orig;
    expect((await readAllBytes(await root.getFileHandle("a.md"), 100)).ok).toBe(true);
    // CMS が作っていない名前は列挙に出さない
    fs.write("plain.txt", "x");
    const names: string[] = [];
    for await (const c of root.values()) names.push(c.name);
    expect(names.sort()).toEqual(["a.md", "b.md"]);
    expect(seen.some((s) => s.includes("読めない名前"))).toBe(true);
  });

  it("長い名前は置き換え名と別ファイルで扱う", async () => {
    const fs = new MemFs("ws");
    const root = encryptedRoot(fs.root, await ctx());
    const long = "あ".repeat(60) + ".md";
    const r = await writeNewFile(root, long, enc("x"));
    expect(r.ok).toBe(true);
    expect([...fs.root.children.keys()].every((n) => n.length <= 200)).toBe(true);
    expect([...fs.root.children.keys()].some((n) => n.endsWith(".n"))).toBe(true);
    const names: string[] = [];
    for await (const c of root.values()) names.push(c.name);
    expect(names).toEqual([long]);
    await root.removeEntry(long);
    expect(fs.root.children.size).toBe(0);
  });

  it("keepExistingData で既存の内容に続けて書ける", async () => {
    const fs = new MemFs("ws");
    const root = encryptedRoot(fs.root, await ctx());
    await writeNewFile(root, "log", enc("a"));
    const h = (await root.getFileHandle("log")) as FileHandleLike;
    const w = await h.createWritable({ keepExistingData: true });
    await w.write(enc("b"));
    await w.close();
    const r = await readAllBytes(h, 10);
    expect(r.ok && dec(r.bytes)).toBe("ab");
  });

  it("退避先と作業場所の重なりを判定できる（19.1 手順2）", async () => {
    const fs = new MemFs("opfs");
    const c = await ctx();
    const ws = encryptedRoot(await fs.root.getDirectoryHandle("ws", { create: true }), c);
    const bk = encryptedRoot(await fs.root.getDirectoryHandle("bk", { create: true }), { ...c, scope: "b" });
    expect(await checkBackupTarget(bk, ws)).toEqual({ ok: true });
    const inside = await ws.getDirectoryHandle("x", { create: true });
    const r = await checkBackupTarget(inside, ws);
    expect(r.ok).toBe(false);
  });
});

describe("Vault（39.2・39.4）", () => {
  const ITER = 100_000;

  it("回復コード・パスフレーズで解錠する", async () => {
    const v = new Vault(null, ITER);
    const k = await v.prepareNew();
    const id = "a".repeat(16);
    v.adopt(id, k.key);
    const rec = await v.withPassphrase(id, k.record, "correct horse battery");
    v.lockAll();
    expect(v.isUnlocked(id)).toBe(false);
    expect(await v.unlock(id, rec, { kind: "recovery", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" })).toBeNull();
    expect(await v.unlock(id, rec, { kind: "recovery", code: k.recoveryCode.toLowerCase() })).toEqual({
      legacyName: null,
    });
    v.lock(id);
    expect(await v.unlock(id, rec, { kind: "passphrase", passphrase: "wrong passphrase!" })).toBeNull();
    expect(await v.unlock(id, rec, { kind: "passphrase", passphrase: "correct horse battery" })).toEqual({
      legacyName: null,
    });
    await expect(v.withPassphrase(id, rec, "short")).rejects.toThrow("10 文字以上");
  });

  it("新しい鍵の情報に表示名を置かない", async () => {
    const v = new Vault(null, ITER);
    const k = await v.prepareNew();
    expect(k.record).not.toHaveProperty("name");
    expect(v.keyringFor(k.record.slots)).not.toHaveProperty("name");
  });

  it("以前の版の暗号化した表示名は、解錠したときに復号して返す", async () => {
    const v = new Vault(null, ITER);
    const k = await v.prepareNew();
    const id = "f".repeat(16);
    const encName = await aesEncrypt(k.key.keys.meta, enc("旧ブログ"), enc("kotono-cms/meta/name"));
    const legacy = { ...k.record, name: b64u(encName) };
    expect(await v.unlock(id, legacy, { kind: "recovery", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" })).toBeNull();
    expect(await v.unlock(id, legacy, { kind: "recovery", code: k.recoveryCode })).toEqual({ legacyName: "旧ブログ" });
    // 暗号文が壊れていれば正常として扱わない
    v.lock(id);
    const broken = { ...k.record, name: b64u(encName.map((b, i) => (i === encName.length - 1 ? b ^ 1 : b))) };
    expect(await v.unlock(id, broken, { kind: "recovery", code: k.recoveryCode })).toBeNull();
    expect(v.isUnlocked(id)).toBe(false);
  });

  it("パスキーの PRF で包んだ枠で解錠する", async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = new Uint8Array([1, 2, 3]);
    const api = {
      register: async () => ({ credentialId, prf }),
      authenticate: async () => ({ credentialId, prf }),
    };
    const v = new Vault(api, ITER);
    const k = await v.prepareNew();
    const id = "b".repeat(16);
    v.adopt(id, k.key);
    const rec = await v.withPasskey(id, k.record, "x");
    v.lock(id);
    expect(await v.unlock(id, rec, { kind: "passkey" })).toEqual({ legacyName: null });
  });

  it("登録した配信元を記録し、別の配信元ではパスキーを求めずに理由を示す", async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = new Uint8Array([1, 2, 3]);
    let asked = 0;
    const api = (rpId: string) => ({
      rpId,
      register: async () => ({ credentialId, prf }),
      authenticate: async () => {
        asked++;
        return { credentialId, prf };
      },
    });
    const v = new Vault(api("a.example"), ITER);
    const k = await v.prepareNew();
    const id = "d".repeat(16);
    v.adopt(id, k.key);
    const rec = await v.withPasskey(id, k.record, "x");
    expect(rec.slots.find((s) => s.kind === "passkey")).toMatchObject({ rpId: "a.example" });
    v.lock(id);
    const other = new Vault(api("b.example"), ITER);
    await expect(other.unlock(id, rec, { kind: "passkey" })).rejects.toThrow("「a.example」で登録した");
    expect(asked).toBe(0);
    expect(await v.unlock(id, rec, { kind: "passkey" })).toEqual({ legacyName: null });
  });

  it("パスキーの NotAllowedError を、次にできることが分かる言葉に置き換える", async () => {
    const notAllowed = () => Promise.reject(new DOMException("The request is not allowed", "NotAllowedError"));
    const pk = browserPasskey({
      navigator: { credentials: { get: notAllowed, create: notAllowed } as unknown as CredentialsContainer },
      location: { hostname: "a.example" },
      PublicKeyCredential: function () {},
    });
    if (!pk) throw new Error("パスキーを使えるはず");
    expect(pk.rpId).toBe("a.example");
    await expect(pk.authenticate([{ credentialId: new Uint8Array([1]), prfSalt: new Uint8Array(32) }])).rejects.toThrow(
      "回復コードで開けます",
    );
    await expect(pk.register("x", new Uint8Array(32))).rejects.toThrow("パスキーを登録できませんでした");
  });

  it("PRF の入力は塩が共通なら eval、違えば evalByCredential で渡す", () => {
    const a = { credentialId: new Uint8Array([1]), prfSalt: new Uint8Array(32).fill(1) };
    const b = { credentialId: new Uint8Array([2]), prfSalt: new Uint8Array(32).fill(2) };
    expect(prfInputs([a])).toEqual({ eval: { first: a.prfSalt } });
    // 塩が共通なら複数件でも eval
    expect(prfInputs([a, { ...b, prfSalt: a.prfSalt }])).toEqual({ eval: { first: a.prfSalt } });
    expect(prfInputs([a, b])).toEqual({ evalByCredential: { AQ: { first: a.prfSalt }, Ag: { first: b.prfSalt } } });
  });

  it("2 件目のパスキーは 1 件目と同じ塩で包み、外すと回復コードの枠だけ残る", async () => {
    const salts: Uint8Array[] = [];
    let n = 0;
    const api = {
      register: async (_label: string, prfSalt: Uint8Array) => {
        salts.push(prfSalt);
        return { credentialId: new Uint8Array([++n]), prf: crypto.getRandomValues(new Uint8Array(32)) };
      },
      authenticate: async () => {
        throw new Error("使わない");
      },
    };
    const v = new Vault(api, ITER);
    const k = await v.prepareNew();
    const id = "e".repeat(16);
    v.adopt(id, k.key);
    const r1 = await v.withPasskey(id, k.record, "x");
    const r2 = await v.withPasskey(id, r1, "x");
    expect(salts[1]).toEqual(salts[0]);
    const pks = r2.slots.filter((s) => s.kind === "passkey");
    expect(pks).toHaveLength(2);
    expect(pks[0]?.kind === "passkey" && pks[1]?.kind === "passkey" && pks[0].wrapped !== pks[1].wrapped).toBe(true);
    expect(v.withoutPasskeys(r2).slots.map((s) => s.kind)).toEqual(["recovery"]);
  });

  it("パスキーの名前は英字だけにする（日本語の名前は 1Password が認証を拒否する）", () => {
    expect(accountName("0123456789abcdef")).toBe("kotono-01234567");
    expect(asciiLabel("Kotono 確認用")).toBe("Kotono");
    expect(asciiLabel("ブログ")).toBe("kotono");
    expect(asciiLabel("kotono-01234567")).toBe("kotono-01234567");
  });

  it("トークンを暗号化して保存できる（40.2）", async () => {
    const v = new Vault(null, ITER);
    const k = await v.prepareNew();
    const id = "c".repeat(16);
    v.adopt(id, k.key);
    const s = await v.sealToken(id, "github_pat_secret");
    expect(s).not.toContain("secret");
    expect(await v.openToken(id, s)).toBe("github_pat_secret");
  });

  it("暗号化した作業場所を書き出し、別の端末で回復コードで取り込める（38.3）", async () => {
    const v = new Vault(null, ITER);
    const fs = new MemFs("opfs");
    const store = await WorkspaceStore.open(fs.root);
    const k = await v.prepareNew();
    const meta = await store.create({
      name: "サイト",
      keyring: k.record,
      fill: async (dir, id) => {
        const root = await v.wrapDir(dir, id, k.key);
        const a = await root.getDirectoryHandle("content", { create: true });
        await writeNewFile(a, "x.md", enc("中身"));
      },
    });
    v.adopt(meta.id, k.key);
    const root = await v.wrapOpened(await store.root(meta.id), meta.id);
    const ex = await exportZip(root);
    if (!ex.ok) throw new Error(ex.message);
    const sealed = await v.sealExport(meta.id, ex.bytes, k.record.slots);
    expect(Vault.isSealedExport(sealed)).toBe(true);
    // 別の端末
    const other = new Vault(null, ITER);
    expect(
      await other.openSealedExport(sealed, { kind: "recovery", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" }),
    ).toBeNull();
    const opened = await other.openSealedExport(sealed, { kind: "recovery", code: k.recoveryCode });
    expect(opened).not.toBeNull();
    const plan = planZip(must(opened).zip);
    expect(plan.ok && plan.files.map((f) => f.path)).toEqual(["content/x.md"]);
  });

  it("ログインの枠で作業場所を開き、書き出し（版 2）はログインの回復コードで開ける。別の作業場所の枠への差し替えは開けない（ADR-0012）", async () => {
    const v = new Vault(null, ITER);
    const login = await v.prepareNew();
    v.adopt("login", login.key);
    const place = await v.newKey();
    const a = "a".repeat(16);
    const b = "b".repeat(16);
    const slot = await v.loginSlot("login", a, place);
    expect(slot.kind).toBe("login");
    expect(await v.unlockWithLogin("login", a, { v: 1, slots: [slot] })).toBe(true);
    expect(await v.unlockWithLogin("login", b, { v: 1, slots: [slot] })).toBe(false);

    const sealed = await v.sealExport(a, enc("zip"), [slot], { id: "login", slots: login.record.slots });
    const h = Vault.readExportHeader(sealed);
    expect(h?.header.v).toBe(2);
    // 直接の枠にはログインの枠を入れない（ほかの端末では意味がない）
    expect(h?.header.slots).toEqual([]);
    expect(await v.openSealedExport(sealed, { kind: "login", loginId: "login" })).not.toBeNull();
    const other = new Vault(null, ITER);
    expect(
      await other.openSealedExport(sealed, { kind: "recovery", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" }),
    ).toBeNull();
    const opened = await other.openSealedExport(sealed, { kind: "recovery", code: login.recoveryCode });
    expect(opened && dec(opened.zip)).toBe("zip");
  });
});
