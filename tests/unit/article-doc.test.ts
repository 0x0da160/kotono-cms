import { describe, expect, it } from "vitest";
import {
  analyzeText,
  classifyChange,
  editField,
  newArticleText,
  replaceBody,
  textFromBytes,
  verifyCandidateBytes,
} from "../../src/lib/core/article-doc";
import { encodeUtf8 } from "../../src/lib/core/bytes";
import { DocHistory } from "../../src/lib/core/history";
import { lineDiff } from "../../src/lib/core/diff";
import { sortItems, matches, DEFAULT_QUERY } from "../../src/lib/core/list";
import { validateStandard, isSafeMediaRef } from "../../src/lib/core/schema";
import { parseFrontmatter } from "../../src/lib/core/yaml-doc";

const ID = "k7m2x9q";
const doc = (fm: string, body = "本文\n") =>
  `---\nid: "${ID}"\ntitle: "T"\nslug: "s"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n${fm}---\n${body}`;

function change(a: string, b: string) {
  return classifyChange(analyzeText(a, ID), analyzeText(b, ID));
}

describe("変更判定（8.2・26.2 D01・D04）", () => {
  it("同一なら未変更", () => {
    expect(change(doc(""), doc(""))).toMatchObject({ textChanged: false, contentChanged: false });
  });
  it("本文の変更は updatedAt を更新する（空白・末尾改行を含む）", () => {
    expect(change(doc(""), doc("", "本文\n\n")).contentChanged).toBe(true);
    expect(change(doc(""), doc("", "本文 \n")).contentChanged).toBe(true);
  });
  it("標準値・未知値の変更は updatedAt を更新する", () => {
    expect(change(doc(""), doc("").replace('title: "T"', 'title: "U"')).contentChanged).toBe(true);
    expect(change(doc("x: 1\n"), doc("x: 2\n")).contentChanged).toBe(true);
    expect(change(doc("x: {a: 1}\n"), doc("x: {a: 1, b: 2}\n")).contentChanged).toBe(true);
  });
  it("コメント・引用符・キー順・フロー表記だけの変更は保存するが updatedAt は更新しない", () => {
    const c = change(doc("x: {a: 1, b: 2}\n"), doc("# comment\nx: {b: 2, a: 1}\n").replace('title: "T"', "title: 'T'"));
    expect(c).toMatchObject({ textChanged: true, contentChanged: false });
  });
  it("日時のオフセット表記だけの変更は updatedAt を更新しない", () => {
    const b = doc("").replace("publishedAt: null", 'publishedAt: "2026-11-03T22:08:00+09:00"');
    const c = change(b, b.replace('publishedAt: "2026-11-03T22:08:00+09:00"', 'publishedAt: "2026-11-03T13:08:00Z"'));
    expect(c).toMatchObject({ textChanged: true, contentChanged: false });
  });
  it("updatedAt・createdAt の時刻の変更を検出する", () => {
    const u = change(
      doc(""),
      doc("").replace('updatedAt: "2026-11-03T22:08:00+09:00"', 'updatedAt: "2027-01-01T00:00:00Z"'),
    );
    expect(u).toMatchObject({ updatedAtEdited: true, contentChanged: false });
    const sameInstant = change(
      doc(""),
      doc("").replace('updatedAt: "2026-11-03T22:08:00+09:00"', 'updatedAt: "2026-11-03T13:08:00Z"'),
    );
    expect(sameInstant.updatedAtEdited).toBe(false);
    const cr = change(
      doc(""),
      doc("").replace('createdAt: "2026-11-03T22:08:00+09:00"', 'createdAt: "2020-01-01T00:00:00Z"'),
    );
    expect(cr.createdAtEdited).toBe(true);
  });
});

describe("ディスクのバイト列（9.1・13.2.2）", () => {
  it("BOM・CRLF を報告し、編集用の正本は LF・BOM なし", () => {
    const r = textFromBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...encodeUtf8("---\r\na: 1\r\n---\r\nb\r\n")]));
    expect(r).toEqual({ ok: true, text: "---\na: 1\n---\nb\n", bom: true, crlf: true });
  });
  it("不正な UTF-8・単独 CR・5 MiB 超は編集しない", () => {
    expect(textFromBytes(new Uint8Array([0x2d, 0xff])).ok).toBe(false);
    expect(textFromBytes(encodeUtf8("---\na: 1\r---\n")).ok).toBe(false);
    expect(textFromBytes(new Uint8Array(5 * 1024 * 1024 + 1)).ok).toBe(false);
  });
  it("最終候補を同じ検証規則で再読込できなければ保存しない", () => {
    expect(verifyCandidateBytes(encodeUtf8(doc("")), ID).ok).toBe(true);
    expect(verifyCandidateBytes(encodeUtf8(doc("").replace('status: "draft"', 'status: "x"')), ID).ok).toBe(false);
    // 日本語・絵文字で5 MiBを超える最終候補（T27）
    const big = doc("", "あ😀".repeat((5 * 1024 * 1024) / 7 + 1));
    const r = verifyCandidateBytes(encodeUtf8(big), ID);
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.code).toBe("size");
  });
});

describe("記事の検証（6・24）", () => {
  it("新規テンプレートは標準項目の掲載順で、そのまま正常な記事", () => {
    const t = newArticleText(ID, "2026-11-03T22:08:00+09:00");
    expect(analyzeText(t, ID).problems).toEqual([]);
    expect(
      t
        .split("\n")
        .slice(1, 10)
        .map((l) => l.split(":")[0]),
    ).toEqual(["id", "title", "slug", "status", "createdAt", "updatedAt", "publishedAt", "tags", "cover"]);
  });
  it("ID 不一致・不足・型不正・公開条件を検出し、勝手に補わない", () => {
    const codes = (t: string) => analyzeText(t, ID).problems.map((p) => p.code);
    expect(codes(doc("").replace(`id: "${ID}"`, 'id: "p4c8n6w"'))).toContain("id-mismatch");
    expect(codes(doc("").replace('title: "T"\n', ""))).toContain("missing");
    expect(codes(doc("").replace("tags: []", "tags: [1]"))).toContain("type");
    expect(codes(doc("").replace("tags: []", 'tags: ["a", "a"]'))).toContain("tag-duplicate");
    expect(codes(doc("").replace("tags: []", 'tags: [" "]'))).toContain("tag-empty");
    const pub = doc("").replace('status: "draft"', 'status: "published"').replace('title: "T"', 'title: "  "');
    expect(codes(pub)).toEqual(expect.arrayContaining(["title-required", "published-at-required"]));
    expect(codes(doc("").replace('id: "k7m2x9q"', 'id: "BAD"'))).toContain("id-format");
    expect(analyzeText(doc("").replace('id: "k7m2x9q"', 'id: "BAD"'), ID).readOnlyReason).not.toBeNull();
  });
  it("非対応 YAML は読み取り専用、構文エラーは原文で修正可能", () => {
    expect(analyzeText(doc("x: &a 1\ny: *a\n"), ID).readOnlyReason).not.toBeNull();
    const syn = analyzeText(doc("x: [\n"), ID);
    expect(syn.readOnlyReason).toBeNull();
    expect(syn.problems.length).toBeGreaterThan(0);
  });
  it("cover は当該記事の media 内だけ（16.2）", () => {
    expect(isSafeMediaRef("./media/a.jpg")).toBe(true);
    for (const bad of [
      "media/a.jpg",
      "./media/../index.md",
      "./media/a/b.jpg",
      "./media/%2e%2e",
      "https://x/a.jpg",
      "/abs.jpg",
      "./media/",
      "./media/a.jpg?x",
      "./media/..",
      "file:///etc/passwd",
    ]) {
      expect(isSafeMediaRef(bad), bad).toBe(false);
    }
    const p = parseFrontmatter('id: "k7m2x9q"\ncover: { src: "https://example.com/a.jpg", alt: "" }\n');
    if (!p.ok) throw new Error();
    expect(validateStandard(p.root, ID).errors.map((e) => e.code)).toContain("cover-src");
  });
});

describe("フォーム編集（9.3・14）", () => {
  it("存在しない項目は追加しない（勝手に補わない）", () => {
    const t = doc("").replace("cover: null\n", "");
    expect(editField(t, "cover", null)).toMatchObject({ ok: false });
  });
  it("構文エラー中はフォームで編集できない", () => {
    expect(editField(doc("x: [\n"), "title", "a").ok).toBe(false);
  });
  it("本文の置換は frontmatter を変えない", () => {
    const t = doc("# c\n");
    const r = replaceBody(t, "new\n");
    expect(r).toEqual({ ok: true, text: t.replace("本文\n", "new\n") });
  });
});

describe("共通の Undo/Redo 履歴（14）", () => {
  it("連続入力はまとめ、モード切替（seal）で区切る", () => {
    const h = new DocHistory("a", 1000);
    h.push("ab", "body", 0);
    h.push("abc", "body", 100);
    h.seal();
    h.push("abcd", "body", 200);
    expect(h.undo()).toBe("abc");
    expect(h.undo()).toBe("a");
    expect(h.redo()).toBe("abc");
  });
  it("フォーム変更→原文変更→Undo で最後の原文変更だけを戻す", () => {
    const h = new DocHistory("v0");
    h.push("v1-form", "field:title", 0);
    h.push("v2-source", "source", 10);
    expect(h.undo()).toBe("v1-form");
  });
  it("予算超過で古い履歴を切り捨てて通知し、現在文書は保持する", () => {
    const h = new DocHistory("0", 0, 3);
    for (let i = 1; i <= 5; i++) h.push(String(i), null, i);
    expect(h.truncated).toBe(true);
    expect(h.current).toBe("5");
    expect(h.undo()).toBe("4");
  });
  it("管理値の反映は履歴全体に適用し、Undo の対象にしない", () => {
    const h = new DocHistory("u=1 a");
    h.push("u=1 ab", null, 0);
    h.mapAll((t) => t.replace("u=1", "u=2"));
    expect(h.current).toBe("u=2 ab");
    expect(h.undo()).toBe("u=2 a");
    expect(h.canUndo).toBe(false);
  });
});

describe("行差分（12.2・34.2）", () => {
  it("追加・削除・共通行を返す", () => {
    const r = lineDiff("a\nb\nc", "a\nx\nc\nd");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.lines.map((l) => `${l.op}${l.text}`)).toEqual([" a", "-b", "+x", " c", "+d"]);
  });
  it("予算超過は差分なしとせず理由を返す", () => {
    const big = "x\n".repeat(20_001);
    expect(lineDiff(big, "")).toMatchObject({ ok: false });
    let t = 0;
    const slow = () => (t += 1000);
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(lineDiff(a, b, slow)).toMatchObject({ ok: false });
  });
});

describe("一覧（23・26.6 P03）", () => {
  const items = [
    { id: "ccccccc", values: { title: "い", updatedAt: "2026-01-02T00:00:00Z", status: "draft", tags: ["A"] } },
    { id: "aaaaaaa", values: { title: "あ", updatedAt: "bad", status: "published", tags: ["a", "B"] } },
    { id: "bbbbbbb", values: { title: "う", status: "draft", tags: [] } },
    {
      id: "ddddddd",
      values: { title: "あ", updatedAt: "2026-01-02T09:00:00+09:00", status: "draft", slug: "Hello-x" },
    },
  ];
  it("不正・未設定日時は昇順・降順とも末尾、同値は ID 昇順", () => {
    expect(sortItems(items, "updatedAt", "desc").map((i) => i.id)).toEqual([
      "ccccccc",
      "ddddddd",
      "aaaaaaa",
      "bbbbbbb",
    ]);
    expect(sortItems(items, "updatedAt", "asc").map((i) => i.id)).toEqual(["ccccccc", "ddddddd", "aaaaaaa", "bbbbbbb"]);
    expect(sortItems(items, "title", "asc").map((i) => i.id)).toEqual(["aaaaaaa", "ddddddd", "ccccccc", "bbbbbbb"]);
  });
  it("キーワードは大小を区別しない部分一致、タグは完全一致の AND", () => {
    expect(items.filter((i) => matches(i, { ...DEFAULT_QUERY, keyword: "HELLO" })).map((i) => i.id)).toEqual([
      "ddddddd",
    ]);
    expect(items.filter((i) => matches(i, { ...DEFAULT_QUERY, tags: ["a"] })).map((i) => i.id)).toEqual(["aaaaaaa"]);
    expect(items.filter((i) => matches(i, { ...DEFAULT_QUERY, tags: ["a", "B"] })).map((i) => i.id)).toEqual([
      "aaaaaaa",
    ]);
    expect(items.filter((i) => matches(i, { ...DEFAULT_QUERY, status: "published" })).map((i) => i.id)).toEqual([
      "aaaaaaa",
    ]);
  });
});
