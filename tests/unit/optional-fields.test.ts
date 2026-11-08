/**
 * 任意の標準項目（description・aliases・revisedAt・corrections・authors）と、
 * cover の caption・credit（docs/knowledge/research/cms-comparison.md の P1）。
 */
import { describe, expect, it } from "vitest";
import { analyzeText, editField, newArticleText } from "../../src/lib/core/article-doc";
import { checkAliasUniqueness, checkSlugUniqueness } from "../../src/lib/core/slug";
import { matches, DEFAULT_QUERY } from "../../src/lib/core/list";

const ID = "k7m2x9q";
const AT = "2026-11-03T22:08:00+09:00";

function doc(extra: string, body = "本文\n"): string {
  return [
    "---",
    `id: "${ID}"`,
    'title: "見出し"',
    'slug: "new-slug"',
    'status: "published"',
    `createdAt: "${AT}"`,
    `updatedAt: "${AT}"`,
    `publishedAt: "${AT}"`,
    "tags: []",
    "cover: null",
    ...(extra ? [extra] : []),
    "---",
    body,
  ].join("\n");
}

function problems(text: string): string[] {
  return analyzeText(text, ID).problems.map((p) => p.message);
}

function values(text: string) {
  return analyzeText(text, ID).schema?.values ?? {};
}

function edit(text: string, ...args: Parameters<typeof editField> extends [string, ...infer R] ? R : never): string {
  const r = editField(text, ...args);
  if (!r.ok) throw new Error(r.message);
  return r.text;
}

describe("任意の標準項目の検証", () => {
  it("ない記事は今までどおり正常", () => {
    expect(problems(doc(""))).toEqual([]);
    expect(problems(newArticleText(ID, AT))).toEqual([]);
  });

  it("正しい値を読み取る", () => {
    const t = doc(
      [
        'description: "要約"',
        "aliases:",
        '  - "old-slug"',
        `revisedAt: "${AT}"`,
        "corrections:",
        `  - at: "${AT}"`,
        '    note: "数字を訂正しました"',
        'authors: ["yamada-taro", "suzuki"]',
      ].join("\n"),
    );
    expect(problems(t)).toEqual([]);
    const v = values(t);
    expect(v.description).toBe("要約");
    expect(v.aliases).toEqual(["old-slug"]);
    expect(v.revisedAt).toBe(AT);
    expect(v.corrections).toEqual([{ at: AT, note: "数字を訂正しました" }]);
    expect(v.authors).toEqual(["yamada-taro", "suzuki"]);
  });

  it("型・形式の誤りを示す", () => {
    expect(problems(doc("description: 3"))).toEqual(["description は文字列にしてください。"]);
    expect(problems(doc('aliases: ["Old Slug"]'))[0]).toMatch(/旧 slug の形式が不正/);
    expect(problems(doc('aliases: ["a", "a"]'))[0]).toMatch(/重複した旧 slug/);
    expect(problems(doc('aliases: ["new-slug"]'))[0]).toMatch(/現在の slug/);
    expect(problems(doc("revisedAt: null"))).toEqual([]);
    expect(problems(doc('revisedAt: "2026-11-03"'))[0]).toMatch(/revisedAt の日時形式/);
    expect(problems(doc('corrections: ["x"]'))[0]).toMatch(/at・note/);
    expect(problems(doc(`corrections: [{ at: "${AT}", note: " " }]`))[0]).toMatch(/内容が空/);
    expect(problems(doc('authors: ["山田"]'))[0]).toMatch(/著者 ID の形式/);
  });

  it("cover の caption・credit は任意の文字列", () => {
    const ok = doc("").replace(
      "cover: null",
      'cover: { src: "./media/a.jpg", alt: "", caption: "説明", credit: "撮影" }',
    );
    expect(problems(ok)).toEqual([]);
    expect(values(ok).cover).toEqual({ src: "./media/a.jpg", alt: "", caption: "説明", credit: "撮影" });
    const bad = doc("").replace("cover: null", 'cover: { src: "./media/a.jpg", alt: "", credit: 1 }');
    expect(problems(bad)).toEqual(["cover.credit は文字列にしてください。"]);
  });
});

describe("フォームでの編集", () => {
  it("ない項目は末尾に足し、他の項目と本文を変えない", () => {
    const base = doc("x-unknown: 1 # コメント");
    let t = edit(base, "description", "要約");
    expect(t).toBe(base.replace("x-unknown: 1 # コメント\n", 'x-unknown: 1 # コメント\ndescription: "要約"\n'));
    t = edit(t, "description", "要約2");
    expect(values(t).description).toBe("要約2");
    t = edit(t, "aliases", ["old-slug"]);
    expect(t).toContain('aliases:\n  - "old-slug"\n');
    t = edit(t, "aliases", ["old-slug", "older"]);
    expect(values(t).aliases).toEqual(["old-slug", "older"]);
    t = edit(t, "revisedAt", AT);
    expect(values(t).revisedAt).toBe(AT);
    expect(t.endsWith("---\n本文\n")).toBe(true);
    expect(problems(t)).toEqual([]);
  });

  it("訂正・追記を足す・直す・消す", () => {
    let t = edit(doc(""), "corrections", [{ at: AT, note: "一" }]);
    expect(t).toContain(`corrections:\n  - at: "${AT}"\n    note: "一"\n`);
    t = edit(t, "corrections", [
      { at: AT, note: "一" },
      { at: AT, note: "二" },
    ]);
    expect(values(t).corrections?.map((c) => c.note)).toEqual(["一", "二"]);
    t = edit(t, "corrections", []);
    expect(values(t).corrections).toEqual([]);
    t = edit(t, "corrections", [{ at: AT, note: "三" }]);
    expect(values(t).corrections).toEqual([{ at: AT, note: "三" }]);
    expect(problems(t)).toEqual([]);
  });

  it("cover に caption・credit を足し、未知の子項目を保つ（ブロック形式）", () => {
    const base = doc("").replace("cover: null", 'cover:\n  src: "./media/a.jpg"\n  alt: ""\n  focus: "30% 70%"');
    let t = edit(base, "cover", { src: "./media/a.jpg", alt: "", caption: "説明" });
    expect(t).toContain('cover:\n  src: "./media/a.jpg"\n  alt: ""\n  focus: "30% 70%"\n  caption: "説明"\n');
    t = edit(t, "cover", { src: "./media/a.jpg", alt: "", credit: "撮影：山田" });
    expect(values(t).cover).toEqual({ src: "./media/a.jpg", alt: "", caption: "説明", credit: "撮影：山田" });
    // 空文字では、ない項目を足さない
    const same = edit(base, "cover", { src: "./media/a.jpg", alt: "x", caption: "" });
    expect(same).not.toContain("caption");
  });

  it("cover に caption を足す（フロー形式）", () => {
    const base = doc("").replace("cover: null", 'cover: { src: "./media/a.jpg", alt: "" }');
    const t = edit(base, "cover", { src: "./media/a.jpg", alt: "", caption: "説明" });
    expect(t).toContain('cover: { src: "./media/a.jpg", alt: "", caption: "説明" }');
  });
});

describe("旧 slug を含む重複検査", () => {
  const entries = [
    { id: "aaaaaaa", slug: "first", aliases: ["first-old"] },
    { id: "bbbbbbb", slug: "second" },
  ];
  it("他の記事の旧 slug と同じ slug は重複", () => {
    expect(checkSlugUniqueness("first-old", "ccccccc", entries)).toEqual({ kind: "duplicate", ids: ["aaaaaaa"] });
    expect(checkSlugUniqueness("third", "ccccccc", entries)).toEqual({ kind: "unique" });
  });
  it("旧 slug が他の記事の slug・旧 slug と重なれば重複", () => {
    expect(checkAliasUniqueness(["second", "x"], "ccccccc", entries)).toEqual({
      kind: "duplicate",
      ids: ["bbbbbbb"],
      aliases: ["second"],
    });
    expect(checkAliasUniqueness(["first-old"], "aaaaaaa", entries)).toEqual({ kind: "unique" });
  });
});

describe("一覧のキーワード検索", () => {
  it("説明文にも一致する", () => {
    const item = { id: ID, values: { title: "t", description: "地方選挙の速報" } };
    expect(matches(item, { ...DEFAULT_QUERY, keyword: "選挙" })).toBe(true);
  });
});

describe("保存時の旧 slug の記録と著者の一覧（ワークスペース）", async () => {
  const { Workspace } = await import("../../src/lib/app/workspace.svelte");
  const { MemFs } = await import("./support/memory-fs");
  const { readAuthors } = await import("../../src/lib/fs/repo");

  async function openPublished(extra = "") {
    const fs = new MemFs();
    const file = fs.write(`content/articles/${ID}/index.md`, doc(extra).replace('slug: "new-slug"', 'slug: "first"'));
    const ws = new Workspace({});
    await ws.openRoot(fs.root);
    await ws.openArticle(ID);
    const s = ws.session;
    if (!s) throw new Error("no session");
    return { fs, file, ws, s };
  }

  async function waitDialog(ws: InstanceType<typeof Workspace>) {
    for (let i = 0; i < 20 && !ws.dialog; i++) await Promise.resolve();
    if (!ws.dialog) throw new Error("no dialog");
    return ws.dialog;
  }

  it("公開対象の slug を変えると、旧 slug を aliases に残して保存できる", async () => {
    const { ws, s, file } = await openPublished();
    expect(s.setField("slug", "second").ok).toBe(true);
    const p = ws.save();
    const d = await waitDialog(ws);
    expect(d.buttons.map((b) => b.value)).toEqual(["keep", "ok", "cancel"]);
    d.resolve("keep");
    await p;
    expect(s.notice?.kind).toBe("ok");
    expect(file.text()).toContain('aliases:\n  - "first"\n');
    expect(s.dirty).toBe(false);
  });

  it("「残さずに保存」では aliases を足さない", async () => {
    const { ws, s, file } = await openPublished();
    s.setField("slug", "second");
    const p = ws.save();
    (await waitDialog(ws)).resolve("ok");
    await p;
    expect(s.notice?.kind).toBe("ok");
    expect(file.text()).not.toContain("aliases");
  });

  it("元の slug に戻すと、その slug を aliases から外す", async () => {
    const { ws, s, file } = await openPublished('aliases: ["zero"]');
    s.setField("slug", "zero");
    const p = ws.save();
    (await waitDialog(ws)).resolve("keep");
    await p;
    expect(s.notice?.kind).toBe("ok");
    expect(analyzeText(file.text(), ID).schema?.values.aliases).toEqual(["first"]);
  });

  it("他の記事の slug と重なる旧 slug では保存しない", async () => {
    const { ws, s, fs, file } = await openPublished();
    fs.write(
      "content/articles/p4c8n6w/index.md",
      doc("").replace(ID, "p4c8n6w").replace('slug: "new-slug"', 'slug: "taken"'),
    );
    s.setField("aliases", ["taken"]);
    await ws.save();
    expect(s.notice?.kind).toBe("error");
    expect(s.notice?.text).toMatch(/旧 slug（taken）/);
    expect(file.writes).toHaveLength(0);
  });

  it("content/authors/ の name を読む", async () => {
    const fs = new MemFs();
    fs.write("content/authors/yamada-taro/index.md", '---\nname: "山田 太郎"\n---\n紹介\n');
    fs.write("content/authors/no-name/index.md", "---\nbio: x\n---\n");
    fs.write("content/authors/Bad_ID/index.md", '---\nname: "x"\n---\n');
    const r = await readAuthors(fs.root);
    expect(r.kind).toBe("ok");
    expect(r.authors).toEqual([
      { id: "Bad_ID", name: null, problem: "フォルダ名が著者 ID の形式ではありません。" },
      { id: "no-name", name: null, problem: "name（表示名）がありません。" },
      { id: "yamada-taro", name: "山田 太郎" },
    ]);
    expect((await readAuthors(new MemFs().root)).kind).toBe("missing");
  });
});

describe("複製", () => {
  it("旧 slug・読者向けの更新日時・訂正を空にし、説明文・著者は残す", async () => {
    const { duplicateText } = await import("../../src/lib/core/article-doc");
    const src = doc(
      [
        'description: "要約"',
        'aliases: ["old"]',
        `revisedAt: "${AT}"`,
        `corrections: [{ at: "${AT}", note: "x" }]`,
        'authors: ["a"]',
      ].join("\n"),
    );
    const r = duplicateText(src, "p4c8n6w", AT);
    if (!r.ok) throw new Error(r.message);
    const v = analyzeText(r.text, "p4c8n6w").schema?.values ?? {};
    expect(v.aliases).toEqual([]);
    expect(v.revisedAt).toBeNull();
    expect(v.corrections).toEqual([]);
    expect(v.description).toBe("要約");
    expect(v.authors).toEqual(["a"]);
    // ない項目は足さない
    const plain = duplicateText(doc(""), "p4c8n6w", AT);
    expect(plain.ok && plain.text.includes("aliases")).toBe(false);
  });
});
