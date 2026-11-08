/**
 * 作業場所の画面の操作（38・39）と、暗号化した復旧ドラフト（39.1）。
 * OPFS は MemFs、IndexedDB は fake-indexeddb で代替する。
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DraftController } from "../../src/lib/app/drafts.svelte";
import { PlacesController, type Deliver } from "../../src/lib/app/places.svelte";
import { Workspace } from "../../src/lib/app/workspace.svelte";
import { encodeUtf8, sha256Hex } from "../../src/lib/core/bytes";
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

function setup(opts: { now?: () => Date; passkey?: PasskeyApi } = {}) {
  const idb = new IDBFactory();
  const base = new IdbDraftStore(idb);
  const sealed = new SealedDraftStore(base);
  const drafts = new DraftController(sealed, "t");
  const ws = new Workspace(undefined, { drafts, md: inlineMdService, processor: null });
  const fs = new MemFs("opfs");
  const delivered: { bytes: Uint8Array; name: string }[] = [];
  const deliver: Deliver = async (bytes, name) => {
    delivered.push({ bytes, name });
    return "downloaded";
  };
  const vault = new Vault(opts.passkey ?? null, 100_000);
  const places = new PlacesController(ws, {}, deliver, { vault, sealed, ...(opts.now ? { now: opts.now } : {}) });
  return { idb, base, sealed, drafts, ws, fs, places, delivered, vault };
}

describe("暗号化した復旧ドラフト（39.1）", () => {
  it("下の保存領域には記事ID・本文・チェックサムを平文で置かない", async () => {
    const { base, sealed, vault } = setup();
    const k = await vault.prepareNew("x");
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
    vault.adopt(a, (await vault.prepareNew("a")).key);
    vault.adopt(b, (await vault.prepareNew("b")).key);
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
});

describe("作業場所の操作（38・39.3）", () => {
  it("作る・開く・ロックで閉じる・解錠して開く", async () => {
    const { fs, places, ws } = setup();
    await places.init(fs.root);
    const m = await places.create("ブログ", true);
    if (!m) throw new Error(places.error ?? "create");
    expect(places.recoveryToShow?.code).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    const code = places.recoveryToShow?.code ?? "";
    places.recoveryToShow = null;
    await places.open(m);
    expect(ws.rootName).toBe("ブログ");
    // 作成時に記事の置き場所を用意する
    expect(ws.articles).not.toBeNull();
    expect(ws.missingArticles).toBe(false);
    // OPFS 上の名前は暗号化されている
    const names = paths(fs.root).join("\n");
    expect(names).not.toContain("content");
    expect(names).not.toContain("articles");

    await places.lock(m.id);
    expect(ws.root).toBeNull();
    expect(places.views()[0]).toMatchObject({ locked: true, label: "ロック中の作業場所" });
    expect(await places.unlock(m, { kind: "recovery", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" })).toBe(false);
    expect(await places.unlock(m, { kind: "recovery", code: code.toLowerCase() })).toBe(true);
    expect(places.views()[0]).toMatchObject({ locked: false, label: "ブログ" });
  });

  it("無操作の時間・非表示の時間でロックする", async () => {
    let t = Date.parse("2026-11-06T00:00:00Z");
    const { fs, places, ws } = setup({ now: () => new Date(t) });
    await places.init(fs.root);
    const m = await places.create("x", true);
    if (!m) throw new Error("create");
    places.recoveryToShow = null;
    await places.open(m);
    places.activity();
    t += 14 * 60_000;
    await places.tick();
    expect(places.anyUnlocked).toBe(true);
    t += 60_000;
    await places.tick();
    expect(places.anyUnlocked).toBe(false);
    expect(ws.root).toBeNull();

    expect(await places.unlock(m, { kind: "recovery", code: "x" })).toBe(false);
  });

  it("非表示が短ければロックしない（共有シート等）", async () => {
    let t = Date.parse("2026-11-06T00:00:00Z");
    const { fs, places } = setup({ now: () => new Date(t) });
    await places.init(fs.root);
    const m = await places.create("x", true);
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

  it("暗号化して書き出し、別の端末で回復コードで取り込める（38.3・39.4）", async () => {
    const a = setup();
    await a.places.init(a.fs.root);
    const m = await a.places.create("ブログ", true);
    if (!m) throw new Error("create");
    const code = a.places.recoveryToShow?.code ?? "";
    a.places.recoveryToShow = null;
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

    const b = setup();
    await b.places.init(b.fs.root);
    await b.places.prepareImport({ name: "ブログ-20261106.kotono", arrayBuffer: async () => out.bytes.slice().buffer });
    expect(b.places.pendingSealed).not.toBeNull();
    expect(await b.places.unsealImport({ kind: "recovery", code })).toBe(true);
    expect(b.places.pendingImport?.plan.files.map((x) => x.path)).toContain("content/articles/k7m2x9q/index.md");
    const nm = await b.places.confirmImport("取り込み", true);
    if (!nm) throw new Error(b.places.error ?? "import");
    await b.places.open(nm);
    expect(b.ws.scan?.entries.map((e) => e.dirName)).toEqual(["k7m2x9q"]);
    // 同じ鍵を引き継ぐので、同じ回復コードで解錠できる
    await b.places.lock(nm.id);
    const fresh = b.places.entries.find((e) => e.state === "ok" && e.meta.id === nm.id);
    if (fresh?.state !== "ok") throw new Error("entry");
    expect(await b.places.unlock(fresh.meta, { kind: "recovery", code })).toBe(true);
  });

  it("保存で「端末の外にない変更」を記録する", async () => {
    const { fs, places, ws } = setup();
    await places.init(fs.root);
    const m = await places.create("x", false);
    if (!m) throw new Error("create");
    await places.open(m);
    ws.noteDiskChange();
    await new Promise((r) => setTimeout(r, 10));
    expect(places.current?.lastChangeAt).not.toBeNull();
  });
});

describe("起動時のログイン（39.3）", () => {
  /** 暗号化した作業場所を 2 つ作り、それぞれにパスキーを 1 件ずつ登録して、すべてロックした状態から起動し直す */
  async function twoPlaces() {
    const pk = fakePasskey();
    const a = setup({ passkey: pk.api });
    await a.places.init(a.fs.root);
    const codes: string[] = [];
    for (const name of ["ブログ", "日記"]) {
      const m = await a.places.create(name, true);
      if (!m) throw new Error(a.places.error ?? "create");
      codes.push(a.places.recoveryToShow?.code ?? "");
      a.places.recoveryToShow = null;
      expect(await a.places.addUnlock(m, { kind: "passkey" })).toBe(true);
    }
    // 同じ保存領域・同じパスキーで起動し直す（鍵はメモリにしかないので、すべてロック中になる）
    const b = setup({ passkey: pk.api });
    expect(b.places.loginRequired).toBe(false);
    await b.places.init(a.fs.root);
    return { pk, places: b.places, ws: b.ws, codes };
  }

  it("暗号化した作業場所があれば、一覧より先にログインを求め、選んだパスキーの作業場所を開く", async () => {
    const { pk, places, ws } = await twoPlaces();
    expect(places.loginRequired).toBe(true);
    expect(places.passkeyPlaces).toBe(2);
    pk.state.pick = 1;
    const m = await places.loginWithPasskey();
    // 1 回の認証で、両方の作業場所のパスキーを候補にする
    expect(pk.state.asked).toBe(1);
    expect(pk.state.lastAllowed).toBe(2);
    expect(m && places.names[m.id]).toBe("日記");
    expect(places.loginRequired).toBe(false);
    if (!m) return;
    await places.open(m);
    expect(ws.rootName).toBe("日記");
    // ほかの作業場所はロックしたまま
    expect(places.views().filter((v) => v.locked)).toHaveLength(1);
  });

  it("パスキーが取り消し・失敗なら自動で繰り返さず、回復コードで開く道を示す", async () => {
    const { pk, places, codes } = await twoPlaces();
    pk.state.pick = null;
    expect(await places.loginWithPasskey()).toBeNull();
    expect(pk.state.asked).toBe(1);
    expect(places.loginFailed).toBe(true);
    expect(places.error).toContain("回復コード");
    expect(places.loginRequired).toBe(true);
    // 回復コードで開く一覧へ進む
    places.useFallback();
    expect(places.loginRequired).toBe(false);
    expect(places.error).toBeNull();
    const e = places.entries.find((x) => x.state === "ok" && x.meta.keyring);
    if (e?.state !== "ok") throw new Error("entry");
    // どちらの作業場所かは一覧の順による。どちらかの回復コードで開ける
    let ok = false;
    for (const c of codes) ok ||= await places.unlock(e.meta, { kind: "recovery", code: c });
    expect(ok).toBe(true);
    // 失敗のあとも、パスキーの要求は 1 回のまま
    expect(pk.state.asked).toBe(1);
    // パスキーは登録済みなので、登録は勧めない
    expect(places.suggestPasskey).toBeNull();
  });

  it("すべてロックすると（自動ロックを含む）、またログインの画面に戻る", async () => {
    const { pk, places } = await twoPlaces();
    pk.state.pick = 0;
    const m = await places.loginWithPasskey();
    if (!m) throw new Error(places.error ?? "login");
    await places.open(m);
    await places.lock(m.id);
    expect(places.loginRequired).toBe(true);
    // 回復コードの一覧に進んでからロックしても、ログインの画面に戻る
    places.useFallback();
    pk.state.pick = 0;
    const m2 = await places.loginWithPasskey();
    if (!m2) throw new Error("login");
    await places.lockAll();
    expect(places.fallback).toBe(false);
    expect(places.loginRequired).toBe(true);
  });

  it("パスキーのない作業場所は回復コードで開き、パスキーの登録を勧める", async () => {
    const pk = fakePasskey();
    const a = setup({ passkey: pk.api });
    await a.places.init(a.fs.root);
    const m = await a.places.create("ブログ", true);
    if (!m) throw new Error("create");
    const code = a.places.recoveryToShow?.code ?? "";
    a.places.recoveryToShow = null;
    await a.places.lock(m.id);
    expect(a.places.loginRequired).toBe(true);
    // パスキーでのログインはできないので、要求もしない
    expect(a.places.passkeyPlaces).toBe(0);
    a.places.useFallback();
    const fresh = a.places.entries.find((e) => e.state === "ok" && e.meta.id === m.id);
    if (fresh?.state !== "ok") throw new Error("entry");
    expect(await a.places.unlock(fresh.meta, { kind: "recovery", code })).toBe(true);
    expect(a.places.suggestPasskey).toBe(m.id);
    expect(await a.places.addUnlock(fresh.meta, { kind: "passkey" })).toBe(true);
    expect(a.places.suggestPasskey).toBeNull();
    expect(a.places.passkeyPlaces).toBe(1);
    expect(pk.state.asked).toBe(0);
  });

  it("暗号化した作業場所がなければ、ログインを求めない", async () => {
    const { fs, places } = setup({ passkey: fakePasskey().api });
    await places.init(fs.root);
    expect(places.loginRequired).toBe(false);
    await places.create("平文", false);
    expect(places.loginRequired).toBe(false);
  });

  it("別の配信元で登録したパスキーしかなければ、要求せずに回復コードを案内する", async () => {
    const { places } = await twoPlaces();
    const other = new Vault(fakePasskey("other.example").api, 100_000);
    const metas = places.entries.flatMap((e) => (e.state === "ok" && e.meta.keyring ? [e.meta] : []));
    await expect(
      other.loginWithPasskey(metas.map((m) => ({ id: m.id, record: m.keyring ?? { v: 1, slots: [], name: "" } }))),
    ).rejects.toThrow("回復コードで開き");
  });
});
