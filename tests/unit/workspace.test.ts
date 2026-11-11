/**
 * 編集セッションと保存の流れ（8.2・10.1・11.2・13.2.1・14・37.1 T12・T25）。
 */
import { describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import { Workspace } from "../../src/lib/app/workspace.svelte";
import { encodeUtf8 } from "../../src/lib/core/bytes";
import { parseDateTime } from "../../src/lib/core/datetime";
import { MemFs } from "./support/memory-fs";

const ID = "k7m2x9q";
const article = (body = "本文\n", extra = "") =>
  `---\r\nid: "${ID}"\r\ntitle: "T" # コメント\r\nslug: "s"\r\nstatus: "draft"\r\ncreatedAt: "2026-11-03T22:08:00+09:00"\r\nupdatedAt: "2026-11-03T22:08:00+09:00"\r\npublishedAt: null\r\ntags: []\r\ncover: null\r\n${extra}---\r\n${body.replace(/\n/g, "\r\n")}`;

async function open(content = article()) {
  const fs = new MemFs();
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encodeUtf8(content)]);
  const file = fs.write(`content/articles/${ID}/index.md`, bom);
  const ws = new Workspace({});
  await ws.openRoot(fs.root);
  await ws.openArticle(ID);
  const s = ws.session;
  if (!s) throw new Error("no session");
  return { fs, file, ws, s };
}

describe("開いて保存するだけでは書き込まない（26.2 D01）", () => {
  it("CRLF・BOM の文書でも未変更なら書き込まず、updatedAt も変えない", async () => {
    const { ws, s, file } = await open();
    expect(s.dirty).toBe(false);
    await ws.save();
    expect(file.writes).toHaveLength(0);
    expect(s.notice?.kind).toBe("info");
  });
});

describe("保存（13.2・8.2）", () => {
  it("本文を変えて保存すると LF・BOM なしで書き、updatedAt を更新して未保存を解除する", async () => {
    const { ws, s, file } = await open();
    s.setBody("新しい本文\n");
    expect(s.dirty).toBe(true);
    await ws.save();
    expect(s.notice?.kind).toBe("ok");
    expect(file.writes).toHaveLength(1);
    const saved = file.text();
    expect(saved.includes("\r")).toBe(false);
    expect(file.data[0]).toBe(0x2d);
    expect(saved).toContain('title: "T" # コメント');
    expect(saved).not.toContain('updatedAt: "2026-11-03T22:08:00+09:00"');
    expect(s.dirty).toBe(false);
    expect(s.status).toBe("saved");
    const upd = s.analysis.schema?.values.updatedAt ?? "";
    expect(parseDateTime(upd)).not.toBeNull();
  });

  it("コメントだけの変更は保存するが updatedAt を更新しない（8.2）", async () => {
    const { ws, s, file } = await open();
    s.setText(s.text.replace("# コメント", "# 別のコメント"), "source");
    await ws.save();
    expect(file.writes).toHaveLength(1);
    expect(file.text()).toContain('updatedAt: "2026-11-03T22:08:00+09:00"');
  });

  it("updatedAt だけの原文編集は拒否する（8.2）", async () => {
    const { ws, s, file } = await open();
    s.setText(s.text.replace('updatedAt: "2026-11-03T22:08:00+09:00"', 'updatedAt: "2030-01-01T00:00:00Z"'), "source");
    await ws.save();
    expect(file.writes).toHaveLength(0);
    expect(s.notice?.text).toContain("updatedAt");
  });

  it("検証エラー中は保存しない", async () => {
    const { ws, s, file } = await open();
    s.setText(s.text.replace('status: "draft"', 'status: "x"'), "source");
    await ws.save();
    expect(file.writes).toHaveLength(0);
    expect(s.notice?.kind).toBe("error");
  });

  it("T12：保存中の後続編集は保持し、管理値だけを反映する。Undo は管理値を戻さない", async () => {
    const { ws, s, fs } = await open();
    s.setBody("v1\n");
    // 書き込み中に後続の編集を入れる
    fs.faults.beforeWrite = () => {
      s.setBody("v2（保存中の編集）\n");
    };
    await ws.save();
    flushSync();
    const savedText = fs.readText(`content/articles/${ID}/index.md`) ?? "";
    expect(savedText).toContain("v1");
    expect(s.text).toContain("v2（保存中の編集）");
    expect(s.dirty).toBe(true);
    // 現在文書の updatedAt は保存済みの値になっている
    const savedUpd = /updatedAt: "([^"]+)"/.exec(savedText)?.[1];
    expect(s.analysis.schema?.values.updatedAt).toBe(savedUpd);
    // 後続編集を元へ戻すと、管理値反映後の基準と一致して未保存が解除される
    s.undo();
    expect(s.text).toContain("v1");
    expect(s.dirty).toBe(false);
    expect(s.analysis.schema?.values.updatedAt).toBe(savedUpd);
  });

  it("外部変更を検出したら保存を止め、3版を識別する（12）", async () => {
    const { ws, s, file } = await open();
    s.setBody("mine\n");
    file.data = encodeUtf8(article("theirs\n"));
    await ws.save();
    expect(s.conflict).not.toBeNull();
    expect(s.conflict?.diskText).toContain("theirs");
    expect(s.conflict?.editingText).toContain("mine");
    expect(s.conflict?.baseHash).not.toBe(s.conflict?.diskHash);
    expect(file.text()).toContain("theirs");
    expect(s.dirty).toBe(true);
  });

  it("書き込み失敗後は未保存・候補を保持し、再試行で照合する（13.3）", async () => {
    const { ws, s, fs, file } = await open();
    s.setBody("retry\n");
    fs.faults.beforeClose = () => {
      throw Object.assign(new Error("x"), { name: "QuotaExceededError" });
    };
    await ws.save();
    expect(s.notice?.text).toContain("保存に失敗しました");
    expect(s.dirty).toBe(true);
    expect(s.pendingCandidate).not.toBeNull();
    fs.faults = {};
    await ws.save();
    expect(s.notice?.kind).toBe("ok");
    expect(file.text()).toContain("retry");
    expect(s.dirty).toBe(false);
  });

  it("slug を変えると全体を再走査し、重複なら保存を止める（7.1）", async () => {
    const { ws, s, fs, file } = await open();
    fs.write(
      "content/articles/p4c8n6w/index.md",
      article().replace(ID, "p4c8n6w").replace('slug: "s"', 'slug: "taken"'),
    );
    // 一覧キャッシュには載っていない（古い一覧）
    expect(s.setField("slug", "taken").ok).toBe(true);
    await ws.save();
    expect(file.writes).toHaveLength(0);
    expect(s.notice?.text).toContain("重複");
  });

  it("他記事の slug を確認できなければ「重複検査不能」として止める（7.1・26.6 P05）", async () => {
    const { ws, s, fs, file } = await open();
    fs.write("content/articles/p4c8n6w/index.md", "---\nslug: [\n---\n");
    s.setField("slug", "fresh");
    await ws.save();
    expect(file.writes).toHaveLength(0);
    expect(s.notice?.text).toContain("重複検査不能");
  });

  it("公開対象へ初めて変えると publishedAt を入れ、title・slug の条件を満たせば保存できる（7.2）", async () => {
    const { ws, s, file } = await open();
    expect(s.setStatus("published", null).ok).toBe(true);
    expect(s.analysis.schema?.values.publishedAt).not.toBeNull();
    await ws.save();
    expect(file.text()).toContain('status: "published"');
  });
});

describe("新規作成（10.1・37.1 T25）", () => {
  it("作成開始時に ID と createdAt を決め、初回保存までフォルダを作らない", async () => {
    const fs = new MemFs();
    fs.mkdir("content/articles");
    const ws = new Workspace({});
    await ws.openRoot(fs.root);
    await ws.createNew();
    const s = ws.session;
    if (!s) throw new Error();
    expect(s.isNew).toBe(true);
    expect(s.id).toMatch(/^[0-9a-hjkmnp-tv-z]{7}$/);
    const createdAt = s.newCreatedAt;
    expect(fs.get(`content/articles/${s.id}`)).toBeUndefined();

    // 失敗→再試行でも createdAt を取り直さない
    fs.faults.beforeClose = () => {
      throw Object.assign(new Error("x"), { name: "QuotaExceededError" });
    };
    s.setField("title", "はじめての記事");
    await ws.save();
    expect(s.notice?.text).toContain("不完全");
    fs.faults = {};
    await ws.save();
    expect(s.notice?.kind).toBe("ok");
    expect(s.isNew).toBe(false);
    const saved = fs.readText(`content/articles/${s.id}/index.md`) ?? "";
    expect(saved).toContain(`createdAt: "${createdAt}"`);
    expect(saved).toContain('title: "はじめての記事"');
    expect(ws.scan?.entries.some((e) => e.dirName === s.id)).toBe(true);
  });

  it("初回保存直前に同名エントリーが現れたら ID を再生成して表示を更新する", async () => {
    const fs = new MemFs();
    fs.mkdir("content/articles");
    const ws = new Workspace({});
    await ws.openRoot(fs.root);
    await ws.createNew();
    const s = ws.session;
    if (!s) throw new Error();
    const first = s.id;
    fs.mkdir(`content/articles/${first}`);
    await ws.save();
    expect(s.id).not.toBe(first);
    expect(s.analysis.schema?.values.id).toBe(s.id);
    expect(fs.readText(`content/articles/${s.id}/index.md`)).toContain(`id: "${s.id}"`);
    expect((fs.get(`content/articles/${first}`) as { children: Map<string, unknown> }).children.size).toBe(0);
  });

  it("設定が不正なら新規作成を停止する（4.2）", async () => {
    const fs = new MemFs();
    fs.mkdir("content/articles");
    fs.write("cms.config.json", "{");
    const ws = new Workspace({});
    await ws.openRoot(fs.root);
    await ws.createNew();
    expect(ws.session).toBeNull();
    expect(ws.folderError).toContain("設定");
  });
});

describe("未保存確認（13.1）", () => {
  it("別記事への移動では保存・破棄・キャンセルを選ばせ、キャンセルなら移動しない", async () => {
    const { ws, s, fs } = await open();
    fs.write("content/articles/p4c8n6w/index.md", article().replace(ID, "p4c8n6w").replace('slug: "s"', 'slug: "t"'));
    s.setBody("unsaved\n");
    const p = ws.openArticle("p4c8n6w");
    await Promise.resolve();
    expect(ws.dialog?.title).toBe("未保存の編集");
    expect(ws.dialog?.initial).toBe("cancel");
    ws.dialog?.resolve("cancel");
    await p;
    expect(ws.session).toBe(s);
    const p2 = ws.openArticle("p4c8n6w");
    await Promise.resolve();
    ws.dialog?.resolve("discard");
    await p2;
    expect(ws.session?.id).toBe("p4c8n6w");
  });

  it("答えを待っている確認は、選ばずに閉じられる（Esc・ロック）。答えは「キャンセル」、なければ最後のボタン", async () => {
    const ws = new Workspace({});
    const ask = (values: string[]) =>
      ws.ask({ title: "t", message: "m", buttons: values.map((value) => ({ label: value, value })), initial: "" });
    const p = ask(["delete", "cancel", "other"]);
    expect(ws.dialog).not.toBeNull();
    ws.dismissDialog();
    expect(ws.dialog).toBeNull();
    expect(await p).toBe("cancel");
    const q = ask(["save", "skip"]);
    ws.dismissDialog();
    expect(await q).toBe("skip");
    // 待っている確認がなければ、何もしない
    ws.dismissDialog();
    expect(ws.dialog).toBeNull();
  });
});
