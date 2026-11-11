/**
 * ブラウザ内復旧ドラフト（33・37.1 T13）。IndexedDB は fake-indexeddb で代替している
 * （実ブラウザ・再起動後の永続状態は TG10 で実機確認が必要）。
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DraftController } from "../../src/lib/app/drafts.svelte";
import { EditorSession } from "../../src/lib/app/session.svelte";
import { Workspace } from "../../src/lib/app/workspace.svelte";
import { encodeUtf8, sha256Hex } from "../../src/lib/core/bytes";
import { DRAFT_FORMAT_VERSION, IdbDraftStore, type DraftRecord } from "../../src/lib/drafts/store";
import { inlineMdService } from "../../src/lib/parse/md-inline";
import { MemFs } from "./support/memory-fs";

const ID = "k7m2x9q";
/** 代入による型の絞り込みを避けて現在のセッションを読む */
const sess = (ws: Workspace): EditorSession | null => ws.session;
const article = (body = "本文\n") =>
  `---\nid: "${ID}"\ntitle: "T"\nslug: "s"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n${body}`;

async function rec(over: Partial<DraftRecord> = {}): Promise<DraftRecord> {
  const text = over.text ?? "x";
  return {
    ws: "w",
    key: "a:k",
    seq: 1,
    articleId: "k",
    isNew: false,
    revision: 1,
    sessionNonce: "n",
    baseHash: null,
    savedAt: Date.now(),
    appVersion: "t",
    formatVersion: DRAFT_FORMAT_VERSION,
    size: encodeUtf8(text).length,
    checksum: await sha256Hex(encodeUtf8(text)),
    text,
    ...over,
  };
}

async function enabledStore() {
  const store = new IdbDraftStore(new IDBFactory());
  await store.setEnabled(true);
  return store;
}

describe("保存領域の順序保証（33.3.1）", () => {
  it("同意前・無効化後は本文を永続保存しない", async () => {
    const store = new IdbDraftStore(new IDBFactory());
    expect(await store.getEnabled()).toBeNull();
    expect(await store.put(await rec())).toEqual({ kind: "skipped", reason: "disabled" });
    await store.setEnabled(true);
    expect((await store.put(await rec())).kind).toBe("stored");
    await store.setEnabled(false);
    expect(await store.put(await rec({ seq: 2 }))).toEqual({ kind: "skipped", reason: "disabled" });
    expect((await store.list()).map((d) => d.seq)).toEqual([1]);
  });

  it("古い要求の遅延完了で新しい世代を巻き戻さない", async () => {
    const store = await enabledStore();
    await store.put(await rec({ seq: 5, text: "new" }));
    expect(await store.put(await rec({ seq: 3, text: "old" }))).toEqual({ kind: "skipped", reason: "older" });
    expect((await store.list()).map((d) => d.text)).toEqual(["new"]);
  });

  it("明示破棄の後に完了した古い要求を復活させない", async () => {
    const store = await enabledStore();
    await store.put(await rec({ seq: 1 }));
    await store.discard("w", "a:k", 10);
    expect(await store.list()).toEqual([]);
    expect(await store.put(await rec({ seq: 9 }))).toEqual({ kind: "skipped", reason: "stale" });
    expect((await store.put(await rec({ seq: 11 }))).kind).toBe("stored");
  });

  it("保存成功前の要求は保存済み世代として復活させず、保存後の編集世代は保持する", async () => {
    const store = await enabledStore();
    await store.put(await rec({ seq: 1, revision: 3 }));
    await store.put(await rec({ seq: 2, revision: 5 }));
    await store.markSaved("w", "a:k", "n", 4);
    expect((await store.list()).map((d) => d.revision)).toEqual([5]);
    expect(await store.put(await rec({ seq: 3, revision: 4 }))).toEqual({ kind: "skipped", reason: "saved" });
    expect((await store.put(await rec({ seq: 4, revision: 6 }))).kind).toBe("stored");
  });

  it("1記事につき最大2世代を残す", async () => {
    const store = await enabledStore();
    for (let i = 1; i <= 4; i++) await store.put(await rec({ seq: i, text: `v${i}` }));
    expect((await store.list()).map((d) => d.text)).toEqual(["v3", "v4"]);
  });

  it("1ワークスペース20記事を超える新しい記事は退避せず、既存の最新ドラフトを追い出さない", async () => {
    const store = await enabledStore();
    for (let i = 0; i < 20; i++) await store.put(await rec({ key: `a:${i}`, seq: i + 1 }));
    const out = await store.put(await rec({ key: "a:new", seq: 100 }));
    expect(out.kind).toBe("quota");
    expect(await store.list()).toHaveLength(20);
    // 別のワークスペースは別に数える
    expect((await store.put(await rec({ ws: "other", key: "a:new", seq: 101 }))).kind).toBe("stored");
  });

  it("全体 50 MiB を超えると退避を止める", async () => {
    const store = await enabledStore();
    const big = "a".repeat(5 * 1024 * 1024);
    for (let i = 0; i < 9; i++) await store.put(await rec({ key: `a:${i}`, seq: i + 1, text: big, ws: `w${i}` }));
    const out = await store.put(await rec({ key: "a:x", seq: 50, text: big, ws: "wx" }));
    expect(out.kind).toBe("stored");
    const over = await store.put(await rec({ key: "a:y", seq: 51, text: big, ws: "wy" }));
    expect(over.kind).toBe("quota");
  }, 20_000);

  it("保持期間を過ぎた記事のドラフトを整理する", async () => {
    const store = await enabledStore();
    const old = Date.now() - 8 * 24 * 3600 * 1000;
    await store.put(await rec({ key: "a:old", seq: 1, savedAt: old }));
    await store.put(await rec({ key: "a:new", seq: 2 }));
    expect(await store.expire(Date.now())).toBe(1);
    expect((await store.list()).map((d) => d.key)).toEqual(["a:new"]);
  });

  it("形式の不正な記録は一覧に出さない（34.5）", async () => {
    const store = await enabledStore();
    await store.put({ ...(await rec()), checksum: "x".repeat(10_000) });
    expect(await store.list()).toEqual([]);
  });

  it("ワークスペースはハンドルの同一性で照合し、名前では認定しない（33.2）", async () => {
    const store = await enabledStore();
    const a = { name: "repo" };
    const b = { name: "repo" };
    const same = async (x: unknown, y: unknown) =>
      (x as { name: string }).name === (y as { name: string }).name && x === y;
    const first = await store.identify(a, same);
    expect(first.matched).toBe(false);
    // 同じ名前の別フォルダは別のワークスペース
    expect((await store.identify(b, async () => false)).id).not.toBe(first.id);
  });
});

describe("編集との連携（33.3・33.4）", () => {
  async function setup() {
    const fs = new MemFs();
    fs.write(`content/articles/${ID}/index.md`, article());
    const store = await enabledStore();
    const dc = new DraftController(store, "t", { idleMs: 5, maxMs: 50 });
    await dc.init();
    const ws = new Workspace({}, { drafts: dc, md: inlineMdService });
    await ws.openRoot(fs.root);
    await ws.openArticle(ID);
    const s = ws.session as EditorSession;
    return { fs, store, dc, ws, s };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("入力が止まったら退避し、読み直して一致したリビジョンだけを退避済みにする", async () => {
    const { s, dc } = await setup();
    s.setBody("編集\n");
    expect(s.draft.kind).toBe("pending");
    await wait(40);
    expect(s.draft).toMatchObject({ kind: "saved", revision: s.revision });
    expect(dc.records).toHaveLength(1);
    expect(dc.records[0]?.text).toBe(s.text);
    expect(dc.records[0]?.baseHash).toBe(s.base?.hash);
  });

  it("IME 変換中は退避を待つ", async () => {
    const { s, dc } = await setup();
    s.composing = true;
    s.setBody("へんかん\n");
    await wait(40);
    expect(dc.records).toHaveLength(0);
    s.composing = false;
    await wait(600);
    expect(dc.records).toHaveLength(1);
  });

  it("リポジトリ保存に成功したら保存したリビジョンまでのドラフトを消す", async () => {
    const { s, dc, ws } = await setup();
    s.setBody("保存する\n");
    await dc.flush(s);
    expect(dc.records).toHaveLength(1);
    await ws.save();
    expect(s.notice?.kind).toBe("ok");
    expect(dc.records).toHaveLength(0);
  });

  it("破棄すると以後その世代を復活させない", async () => {
    const { s, dc, ws, fs } = await setup();
    s.setBody("捨てる\n");
    await dc.flush(s);
    fs.write("content/articles/p4c8n6w/index.md", article().replace(ID, "p4c8n6w").replace('slug: "s"', 'slug: "t"'));
    ws.ask = async () => "discard";
    await ws.openArticle("p4c8n6w");
    expect(dc.records).toHaveLength(0);
  });

  it("無効化は未完了の退避を待ってから確定し、以後は保存しない", async () => {
    const { s, dc } = await setup();
    s.setBody("a\n");
    const p = dc.flush(s);
    await dc.disable(false);
    await p;
    s.setBody("b\n");
    await dc.flush(s);
    expect(dc.records.every((r) => r.text.includes("a\n"))).toBe(true);
    expect(dc.mode).toBe("disabled");
  });

  it("ロックで復号した一覧を捨て、ロックの前に始めた読み直しの結果も戻さない。保存領域の記録は残す", async () => {
    const { s, dc } = await setup();
    s.setBody("a\n");
    await dc.flush(s);
    expect(dc.records.map((r) => r.text.includes("a\n"))).toEqual([true]);
    // 読み直しの途中でロックする
    const reading = dc.reload();
    dc.forget();
    expect(dc.records).toEqual([]);
    await reading;
    expect(dc.records).toEqual([]);
    // ロックを解除して読み直すと、また候補に出る
    await dc.reload();
    expect(dc.records.map((r) => r.text.includes("a\n"))).toEqual([true]);
  });

  it("復旧候補を編集として開く。基準版と一致すればそのまま、違えば外部変更として扱う", async () => {
    const { s, dc, ws, fs } = await setup();
    s.setBody("復旧したい\n");
    await dc.flush(s);
    const rec0 = dc.records[0] as DraftRecord;
    ws.session = null;
    await ws.openDraft(rec0);
    expect(sess(ws)?.text).toContain("復旧したい");
    expect(sess(ws)?.dirty).toBe(true);
    expect(sess(ws)?.recoveryMismatch).toBe(false);
    // ディスクが変わっていた場合
    await dc.flush(sess(ws) as EditorSession);
    const rec1 = dc.records[0] as DraftRecord;
    fs.write(`content/articles/${ID}/index.md`, article("外部で変更\n"));
    ws.session = null;
    await ws.openDraft(rec1);
    expect(sess(ws)?.recoveryMismatch).toBe(true);
    expect(sess(ws)?.conflict?.diskText).toContain("外部で変更");
    // 保存前に置き換えの確認を求める
    const asked: string[] = [];
    ws.ask = async (r) => {
      asked.push(r.title);
      return "cancel";
    };
    await ws.save();
    expect(asked).toEqual(["復旧ドラフトを保存します"]);
    expect(fs.readText(`content/articles/${ID}/index.md`)).toContain("外部で変更");
  });

  it("チェックサムが一致しないドラフトは開かない（33.4）", async () => {
    const { s, dc, ws } = await setup();
    s.setBody("x\n");
    await dc.flush(s);
    const bad = { ...(dc.records[0] as DraftRecord), text: "改ざん" };
    ws.session = null;
    await ws.openDraft(bad);
    expect(ws.session).toBeNull();
    expect(ws.folderError).toContain("破損");
  });

  it("未保存の新規記事も退避・復旧でき、createdAt を取り直さない（T25）", async () => {
    const { dc, ws } = await setup();
    await ws.createNew();
    const n = sess(ws) as EditorSession;
    const createdAt = n.newCreatedAt;
    n.setField("title", "新規");
    await dc.flush(n);
    const r = dc.records.find((d) => d.isNew) as DraftRecord;
    expect(r.key).toMatch(/^n:/);
    ws.session = null;
    await ws.openDraft(r);
    expect(sess(ws)?.isNew).toBe(true);
    expect(sess(ws)?.newCreatedAt).toBe(createdAt);
  });

  it("利用できない環境は「利用不可」とし、無効化と区別する（33.1）", async () => {
    const dc = new DraftController(null, "t");
    await dc.init();
    expect(dc.mode).toBe("unavailable");
  });
});
