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

function setup(opts: { now?: () => Date } = {}) {
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
  const vault = new Vault(null, 100_000);
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
