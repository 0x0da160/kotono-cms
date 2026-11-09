/**
 * 作業場所の画面の操作（38・39）と、暗号化した復旧ドラフト（39.1）。
 * OPFS は MemFs、IndexedDB は fake-indexeddb で代替する。
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DraftController } from "../../src/lib/app/drafts.svelte";
import { LOGIN_ID, LoginController } from "../../src/lib/app/login.svelte";
import { MemoryLoginStore } from "../../src/lib/login/store";
import { PlacesController, type Deliver } from "../../src/lib/app/places.svelte";
import { Workspace } from "../../src/lib/app/workspace.svelte";
import { encodeUtf8, sha256Hex } from "../../src/lib/core/bytes";
import { aesEncrypt, b64u } from "../../src/lib/crypto/keys";
import type { PasskeyApi } from "../../src/lib/crypto/passkey";
import { Vault } from "../../src/lib/crypto/vault";
import { SealedDraftStore } from "../../src/lib/drafts/sealed";
import { DRAFT_FORMAT_VERSION, IdbDraftStore, type DraftRecord } from "../../src/lib/drafts/store";
import { inlineMdService } from "../../src/lib/parse/md-inline";
import { MemDir, MemFs } from "./support/memory-fs";

const te = new TextEncoder();

function paths(d: MemDir): string[] {
  return [...d.children.values()].flatMap((c) => (c instanceof MemDir ? [c.path, ...paths(c)] : [c.path]));
}

async function rec(ws: string, text: string, over: Partial<DraftRecord> = {}): Promise<DraftRecord> {
  return {
    ws,
    key: "a:k7m2x9q",
    seq: 1,
    articleId: "k7m2x9q",
    isNew: false,
    revision: 1,
    sessionNonce: "n",
    baseHash: "base",
    savedAt: Date.now(),
    appVersion: "t",
    formatVersion: DRAFT_FORMAT_VERSION,
    size: encodeUtf8(text).length,
    checksum: await sha256Hex(encodeUtf8(text)),
    text,
    ...over,
  };
}

/**
 * パスキーの代わり。登録したパスキーごとに秘密を持ち、PRF の出力は秘密と塩から決まる。
 * `pick` で、認証のときに利用者が選ぶパスキー（登録順の番号）を決める。null なら取り消し（NotAllowedError 相当）。
 */
function fakePasskey(rpId = "kotono.example") {
  const secrets: Uint8Array[] = [];
  const state = { pick: 0 as number | null, asked: 0, lastAllowed: 0 };
  const prf = async (secret: Uint8Array, salt: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...secret, ...salt])));
  const api: PasskeyApi = {
    rpId,
    async register(_label, prfSalt) {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      secrets.push(secret);
      return { credentialId: new Uint8Array([secrets.length]), prf: await prf(secret, prfSalt) };
    },
    async authenticate(allowed) {
      state.asked++;
      state.lastAllowed = allowed.length;
      if (state.pick === null) throw new Error("取り消されました。回復コードで開けます。");
      const n = state.pick + 1;
      const a = allowed.find((x) => x.credentialId[0] === n);
      const secret = secrets[state.pick];
      if (!a || !secret) throw new Error("該当するパスキーがありません。回復コードで開けます。");
      return { credentialId: new Uint8Array([n]), prf: await prf(secret, a.prfSalt) };
    },
  };
  return { api, state };
}

function setup(opts: { now?: () => Date; passkey?: PasskeyApi; fs?: MemFs; store?: MemoryLoginStore } = {}) {
  const idb = new IDBFactory();
  const base = new IdbDraftStore(idb);
  const sealed = new SealedDraftStore(base);
  const drafts = new DraftController(sealed, "t");
  const ws = new Workspace(undefined, { drafts, md: inlineMdService, processor: null });
  const fs = opts.fs ?? new MemFs("opfs");
  const delivered: { bytes: Uint8Array; name: string }[] = [];
  const deliver: Deliver = async (bytes, name) => {
    delivered.push({ bytes, name });
    return "downloaded";
  };
  const vault = new Vault(opts.passkey ?? null, 100_000);
  const store = opts.store ?? new MemoryLoginStore();
  const login = new LoginController(vault, store, sealed);
  let autoLocked = 0;
  const places = new PlacesController(ws, {}, deliver, {
    vault,
    sealed,
    ...(opts.now ? { now: opts.now } : {}),
    hooks: {
      login: () => (login.unlocked && login.record ? { id: LOGIN_ID, slots: login.record.keyring.slots } : null),
      removed: (id) => login.forgetPlace(id),
      autoLocked: () => {
        autoLocked++;
        login.lock();
      },
      active: () => login.unlocked,
    },
  });
  return { idb, base, sealed, drafts, ws, fs, places, delivered, vault, store, login, autoLocked: () => autoLocked };
}

/** パスキーでログインを登録して、作業場所の保存領域を開いた状態にする。ログインの回復コードを返す */
async function loggedIn(opts: Parameters<typeof setup>[0] = {}) {
  const pk = opts.passkey ? null : fakePasskey();
  const t = setup({ ...opts, passkey: opts.passkey ?? (pk as ReturnType<typeof fakePasskey>).api });
  await t.login.init();
  if (!(await t.login.register())) throw new Error(t.login.error ?? "register");
  const code = t.login.recoveryCode ?? "";
  t.login.confirmRecovery();
  await t.places.init(t.fs.root);
  return { ...t, code, pk };
}

describe("暗号化した復旧ドラフト（39.1）", () => {
  it("下の保存領域には記事ID・本文・チェックサムを平文で置かない", async () => {
    const { base, sealed, vault } = setup();
    const k = await vault.prepareNew();
    vault.adopt("a".repeat(16), k.key);
    const ws = `e:${"a".repeat(16)}`;
    sealed.register(ws, vault.draftSealer("a".repeat(16)));
    await sealed.setEnabled(true);
    const r = await rec(ws, "秘密の本文");
    expect(await sealed.put(r)).toEqual({ kind: "stored" });
    const raw = JSON.stringify(await base.list());
    expect(raw).not.toContain("秘密");
    expect(raw).not.toContain("k7m2x9q");
    expect(raw).not.toContain(r.checksum);
    expect(await sealed.verify(ws, r.key, 1, r.checksum)).toBe(true);
    const back = await sealed.list();
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ key: r.key, articleId: "k7m2x9q", text: "秘密の本文", baseHash: "base" });
    // ロック中は一覧に出さず、書き込みも拒む
    sealed.unregister(ws);
    expect(await sealed.list()).toEqual([]);
    await expect(sealed.put(r)).rejects.toThrow("ロック");
    expect(await base.list()).toHaveLength(1);
  });

  it("別の作業場所の記録の差し替えを正常として扱わない", async () => {
    const { base, sealed, vault } = setup();
    const a = "a".repeat(16);
    const b = "b".repeat(16);
    vault.adopt(a, (await vault.prepareNew()).key);
    vault.adopt(b, (await vault.prepareNew()).key);
    sealed.register(`e:${a}`, vault.draftSealer(a));
    sealed.register(`e:${b}`, vault.draftSealer(b));
    await sealed.setEnabled(true);
    await sealed.put(await rec(`e:${a}`, "A"));
    const [stored] = await base.list();
    if (!stored) throw new Error("no record");
    await base.put({ ...stored, ws: `e:${b}`, seq: 2 });
    const listed = await sealed.list();
    expect(listed.map((r) => r.ws)).toEqual([`e:${a}`]);
  });

  it("実フォルダのドラフトもログイン鍵で暗号化し、ログインしていない間は読み書きしない（ADR-0011）", async () => {
    const { base, sealed, vault } = setup();
    await sealed.setEnabled(true);
    // 以前の版の平文のドラフト
    await base.put(await rec("folder-1", "以前の本文"));
    expect(await sealed.list()).toHaveLength(0);
    await expect(sealed.put(await rec("folder-1", "x", { seq: 2 }))).rejects.toThrow("ログイン");
    vault.adopt("login", (await vault.prepareNew()).key);
    expect(await sealed.setDefault(vault.draftSealer("login"))).toBe(1);
    const raw = JSON.stringify(await base.list());
    expect(raw).not.toContain("以前の本文");
    expect(raw).not.toContain("k7m2x9q");
    const back = await sealed.list();
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ ws: "folder-1", key: "a:k7m2x9q", text: "以前の本文" });
    await sealed.put(await rec("folder-1", "新しい本文", { seq: 3 }));
    expect(JSON.stringify(await base.list())).not.toContain("新しい本文");
    expect((await sealed.list()).map((r) => r.text)).toContain("新しい本文");
    await sealed.setDefault(null);
    expect(await sealed.list()).toHaveLength(0);
  });

  it("復旧ドラフトは既定で有効（未設定は有効、無効にしたら無効のまま）", async () => {
    const { drafts, sealed } = setup();
    await drafts.init();
    expect(drafts.mode).toBe("enabled");
    await drafts.disable(false);
    const again = new DraftController(sealed, "t");
    await again.init();
    expect(again.mode).toBe("disabled");
  });
});

describe("作業場所の操作（38・39.3、ADR-0012）", () => {
  it("作業場所は常にログインの鍵で暗号化し、作業場所ごとの回復コード・パスキーは作らない", async () => {
    const { places, ws, fs } = await loggedIn();
    const m = await places.create("ブログ");
    if (!m) throw new Error(places.error ?? "create");
    expect(m.keyring?.slots.map((s) => s.kind)).toEqual(["login"]);
    await places.open(m);
    expect(ws.rootName).toBe("ブログ");
    // 作成時に記事の置き場所を用意する
    expect(ws.articles).not.toBeNull();
    expect(ws.missingArticles).toBe(false);
    // OPFS 上の名前は暗号化されている
    const names = paths(fs.root).join("\n");
    expect(names).not.toContain("content");
    expect(names).not.toContain("articles");
  });

  it("ログインしていなければ作業場所を作れない（黙らずに知らせる）", async () => {
    const { places, fs } = setup({ passkey: fakePasskey().api });
    await places.init(fs.root);
    expect(places.needsLogin).toBe(true);
    expect(await places.create("ブログ")).toBeNull();
    expect(places.error).toContain("ログイン");
  });

  it("保存領域（OPFS）を開けないときは理由を示し、作るを押すと黙らずに知らせる。もう一度試せる", async () => {
    const t = setup({ passkey: fakePasskey().api });
    await t.login.init();
    await t.login.register();
    t.login.confirmRecovery();
    let fail = true;
    await t.places.start(async () =>
      fail ? { ok: false, reason: "UnknownError：一時的な失敗" } : { ok: true, root: t.fs.root },
    );
    expect(t.places.ready).toBe(true);
    expect(t.places.store).toBeNull();
    expect(t.places.storageError).toBe("UnknownError：一時的な失敗");
    expect(await t.places.create("ブログ")).toBeNull();
    expect(t.places.error).toContain("保存領域を開けていない");
    expect(t.places.busy).toBe(false);
    fail = false;
    await t.places.retry();
    expect(t.places.storageError).toBeNull();
    expect(await t.places.create("ブログ")).not.toBeNull();
  });

  it("暗号化する作業場所でも、表示名は鍵なしで読める平文で保存する", async () => {
    const { fs, places } = await loggedIn();
    const m = await places.create("ブログ");
    if (!m) throw new Error(places.error ?? "create");
    expect(m.name).toBe("ブログ");
    expect(m.keyring).not.toHaveProperty("name");
    // 鍵を持たない別の画面（Vault なし）で一覧を読む
    const other = new PlacesController(
      new Workspace(undefined, { md: inlineMdService, processor: null }),
      {},
      async () => "cancelled",
    );
    await other.init(fs.root);
    expect(other.views()[0]).toMatchObject({ label: "ブログ", locked: true });
  });

  it("以前の版の作業場所（作業場所の回復コード）は、一度解錠するとログインの枠を足し、次からログインだけで開ける。表示名も平文へ移す", async () => {
    const pk = fakePasskey();
    const a = await loggedIn({ passkey: pk.api });
    const store = a.places.store;
    if (!store) throw new Error("store");
    // 以前の版の形式：作業場所の回復コードの枠。name は空、keyring.name に表示名の暗号文
    const k = await a.vault.prepareNew();
    const encName = await aesEncrypt(k.key.keys.meta, te.encode("旧ブログ"), te.encode("kotono-cms/meta/name"));
    const created = await store.create({
      name: "旧ブログ",
      keyring: k.record,
      fill: async (dir, id) => {
        const t = await a.vault.wrapDir(dir, id, k.key);
        await (
          await t.getDirectoryHandle("content", { create: true })
        ).getDirectoryHandle("articles", { create: true });
      },
    });
    await store.update(created.id, { name: "", keyring: { ...k.record, name: b64u(encName) } });
    await a.places.refresh();
    const legacy = a.places.entries[0];
    if (legacy?.state !== "ok") throw new Error("entry");
    expect(await a.places.unlockWithLogin()).toEqual([]);
    expect(a.places.views()[0]).toMatchObject({ locked: true, label: "ロック中の作業場所" });

    expect(await a.places.unlock(legacy.meta, { kind: "recovery", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" })).toBe(false);
    expect(await a.places.unlock(legacy.meta, { kind: "recovery", code: k.recoveryCode })).toBe(true);
    expect(a.places.views()[0]).toMatchObject({ locked: false, label: "旧ブログ" });
    const migrated = await store.get(created.id);
    if (migrated.state !== "ok") throw new Error("migrated");
    expect(migrated.meta.name).toBe("旧ブログ");
    expect(migrated.meta.keyring).not.toHaveProperty("name");
    expect(migrated.meta.keyring?.slots.map((s) => s.kind)).toEqual(["recovery", "login"]);

    // 起動し直す：ログインだけで開ける（作業場所の回復コードは要らない）
    const b = setup({ passkey: pk.api, fs: a.fs, store: a.store });
    await b.login.init();
    await b.places.init(a.fs.root);
    expect(await b.login.login({ kind: "passkey" })).toBe(true);
    expect(await b.places.unlockWithLogin()).toEqual([created.id]);
    await b.places.open(migrated.meta);
    expect(b.ws.rootName).toBe("旧ブログ");
    expect(b.ws.articles).not.toBeNull();
  });

  it("以前の版（ADR-0011）でログインの記録に覚えた鍵は、作業場所の meta へ移す", async () => {
    const a = await loggedIn();
    const store = a.places.store;
    if (!store) throw new Error("store");
    const k = await a.vault.prepareNew();
    const created = await store.create({ name: "日記", keyring: k.record });
    a.vault.adopt(created.id, k.key);
    const wrapped = await a.vault.wrapPlace(LOGIN_ID, created.id);
    const rec = a.store.rec;
    if (!rec) throw new Error("rec");
    a.store.rec = { ...rec, places: { [created.id]: wrapped } };
    a.vault.lock(created.id);
    await a.login.init();
    await a.places.refresh();
    const legacy = await a.login.unlockPlaces();
    expect(legacy).toEqual([created.id]);
    expect(await a.places.unlockWithLogin(legacy)).toEqual([created.id]);
    const m = await store.get(created.id);
    expect(m.state === "ok" && m.meta.keyring?.slots.map((s) => s.kind)).toEqual(["recovery", "login"]);
  });

  it("無操作の時間・非表示の時間でロックする（ログインもロックする）", async () => {
    let t = Date.parse("2026-11-06T00:00:00Z");
    const { places, ws, login, autoLocked } = await loggedIn({ now: () => new Date(t) });
    const m = await places.create("x");
    if (!m) throw new Error("create");
    await places.open(m);
    places.activity();
    t += 14 * 60_000;
    await places.tick();
    expect(places.anyUnlocked).toBe(true);
    t += 60_000;
    await places.tick();
    expect(places.anyUnlocked).toBe(false);
    expect(ws.root).toBeNull();
    expect(autoLocked()).toBe(1);
    expect(login.phase).toBe("login");
  });

  it("非表示が短ければロックしない（共有シート等）", async () => {
    let t = Date.parse("2026-11-06T00:00:00Z");
    const { places } = await loggedIn({ now: () => new Date(t) });
    const m = await places.create("x");
    if (!m) throw new Error("create");
    await places.visibility(true);
    t += 60_000;
    await places.visibility(false);
    expect(places.anyUnlocked).toBe(true);
    await places.visibility(true);
    t += 5 * 60_000;
    await places.visibility(false);
    expect(places.anyUnlocked).toBe(false);
  });

  it("暗号化して書き出し、別の端末でログインの回復コードで取り込める。同じ端末ではそのまま取り込める（38.3・39.4）", async () => {
    const a = await loggedIn();
    const m = await a.places.create("ブログ");
    if (!m) throw new Error("create");
    await a.places.open(m);
    const created = await a.ws.root?.getDirectoryHandle("content").then((d) => d.getDirectoryHandle("articles"));
    const f = await (
      await created?.getDirectoryHandle("k7m2x9q", { create: true })
    )?.getFileHandle("index.md", {
      create: true,
    });
    const w = await f?.createWritable();
    await w?.write(te.encode("本文"));
    await w?.close();
    await a.places.export(m, false);
    const out = a.delivered[0];
    expect(out?.name).toMatch(/^ブログ-\d{8}\.kotono$/);
    if (!out) return;
    expect(new TextDecoder().decode(out.bytes)).not.toContain("本文");
    const file = { name: "ブログ-20261106.kotono", arrayBuffer: async () => out.bytes.slice().buffer };

    // 同じ端末（同じログイン）：回復コードを求めずに取り込める
    await a.places.prepareImport(file);
    expect(a.places.pendingSealed).toBeNull();
    expect(a.places.pendingImport).not.toBeNull();
    a.places.cancelImport();

    // 別の端末（別のログイン）：書き出した端末のログインの回復コードで開く
    const b = await loggedIn();
    await b.places.prepareImport(file);
    expect(b.places.pendingSealed).not.toBeNull();
    expect(await b.places.unsealImport({ kind: "recovery", code: b.code })).toBe(false);
    expect(await b.places.unsealImport({ kind: "recovery", code: a.code })).toBe(true);
    expect(b.places.pendingImport?.plan.files.map((x) => x.path)).toContain("content/articles/k7m2x9q/index.md");
    const nm = await b.places.confirmImport("取り込み");
    if (!nm) throw new Error(b.places.error ?? "import");
    // 取り込んだ作業場所は、取り込んだ端末のログインの鍵で包む
    expect(nm.keyring?.slots.map((s) => s.kind)).toEqual(["login"]);
    await b.places.open(nm);
    expect(b.ws.scan?.entries.map((e) => e.dirName)).toEqual(["k7m2x9q"]);
  });

  it("保存で「端末の外にない変更」を記録する", async () => {
    const { places, ws } = await loggedIn();
    const m = await places.create("x");
    if (!m) throw new Error("create");
    await places.open(m);
    ws.noteDiskChange();
    await new Promise((r) => setTimeout(r, 10));
    expect(places.current?.lastChangeAt).not.toBeNull();
  });
});

describe("起動時のログイン（ADR-0011・ADR-0012）", () => {
  it("パスキーで登録すると、作業場所はログインだけで開ける（作業場所ごとの解錠は要らない）", async () => {
    const pk = fakePasskey();
    const a = setup({ passkey: pk.api });
    await a.login.init();
    expect(a.login.phase).toBe("register");
    expect(await a.login.register()).toBe(true);
    expect(a.login.phase).toBe("recovery");
    expect(a.login.record?.keyring.slots.map((s) => s.kind)).toEqual(["recovery", "passkey"]);
    a.login.confirmRecovery();
    expect(a.login.phase).toBe("ready");
    await a.places.init(a.fs.root);
    const m = await a.places.create("ブログ");
    if (!m) throw new Error(a.places.error ?? "create");
    // ログインの記録には作業場所の鍵を置かない（作業場所の meta のログインの枠に置く）
    expect(a.store.rec?.places).toEqual({});

    // 起動し直す：ログインの記録と保存領域は同じ。鍵はメモリにしかない
    const b = setup({ passkey: pk.api, fs: a.fs, store: a.store });
    await b.login.init();
    expect(b.login.phase).toBe("login");
    await b.places.init(a.fs.root);
    expect(b.places.views()[0]?.locked).toBe(true);
    expect(await b.login.login({ kind: "passkey" })).toBe(true);
    await b.places.unlockWithLogin();
    expect(b.places.views()[0]?.locked).toBe(false);
    await b.places.open(m);
    expect(b.ws.rootName).toBe("ブログ");
    expect(pk.state.asked).toBe(1);
  });

  it("パスキーを使えない開き方（file://）では登録もログインもできない", async () => {
    const a = setup();
    await a.login.init();
    expect(a.login.phase).toBe("nopasskey");
    expect(await a.login.register()).toBe(false);
  });

  it("パスフレーズではログインできない。以前の版のパスフレーズの枠は、回復コードでログインしたときに外し、パスキーの登録を求める", async () => {
    // 以前の版の記録：回復コードとパスフレーズの枠
    const old = setup();
    const fresh = await old.vault.prepareNew();
    old.vault.adopt(LOGIN_ID, fresh.key);
    const keyring = await old.vault.withPassphrase(LOGIN_ID, fresh.record, "correct horse battery");
    const store = new MemoryLoginStore();
    store.rec = { v: 1, keyring, places: {}, createdAt: "2026-11-09T00:00:00Z" };

    const pk = fakePasskey();
    const a = setup({ passkey: pk.api, store });
    await a.login.init();
    expect(a.login.phase).toBe("login");
    expect(a.login.hasPasskey).toBe(false);
    expect(await a.login.login({ kind: "passphrase", passphrase: "correct horse battery" })).toBe(false);
    expect(await a.login.login({ kind: "recovery", code: fresh.recoveryCode })).toBe(true);
    expect(store.rec?.keyring.slots.map((s) => s.kind)).toEqual(["recovery"]);
    expect(a.login.phase).toBe("passkey");
    expect(await a.login.addPasskey()).toBe(true);
    expect(a.login.phase).toBe("ready");
  });

  it("パスキーの取り消し・失敗では自動で繰り返さず、回復コードでログインできる", async () => {
    const pk = fakePasskey();
    const a = setup({ passkey: pk.api });
    await a.login.init();
    await a.login.register();
    const code = a.login.recoveryCode ?? "";
    a.login.confirmRecovery();
    a.login.lock();
    pk.state.pick = null;
    expect(await a.login.login({ kind: "passkey" })).toBe(false);
    expect(a.login.failed).toBe(true);
    expect(a.login.error).toContain("回復コード");
    expect(pk.state.asked).toBe(1);
    expect(await a.login.login({ kind: "recovery", code: code.toLowerCase() })).toBe(true);
    expect(pk.state.asked).toBe(1);
  });

  it("ログインを作り直すと、ログインの枠だけの作業場所は開けない", async () => {
    const a = await loggedIn();
    const m = await a.places.create("x");
    if (!m) throw new Error("create");
    await a.places.lockAll();
    await a.login.reset();
    await a.login.register();
    a.login.confirmRecovery();
    expect(await a.places.unlockWithLogin()).toEqual([]);
    expect(a.places.views()[0]?.locked).toBe(true);
  });
});
