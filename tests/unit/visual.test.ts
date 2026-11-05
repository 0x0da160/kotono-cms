/**
 * 見たまま編集の DOM → Markdown（ADR-0005）。実 DOM での往復は E2E（tests/e2e/visual.spec.ts）で確かめる。
 */
import { describe, expect, it } from "vitest";
import {
  escapeLineStart,
  escapeText,
  serializeRoot,
  type PristineBlock,
  type VNode,
} from "../../src/lib/visual/serialize";

const t = (value: string): VNode => ({ nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] });
function el(name: string, attrs: Record<string, string> = {}, ...children: (VNode | string)[]): VNode {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    nodeValue: null,
    childNodes: children.map((c) => (typeof c === "string" ? t(c) : c)),
    getAttribute: (n) => attrs[n] ?? null,
  };
}
const none = { pristine: () => null };
const md = (root: VNode, opts: { pristine(el: VNode): PristineBlock | null } = none) =>
  serializeRoot(root, opts).markdown;

describe("文字のエスケープ", () => {
  it("強調・コード・リンクの記号をエスケープし、語中の _ はそのままにする", () => {
    expect(escapeText("a*b `c` [d] <e> ~f~ \\")).toBe("a\\*b \\`c\\` \\[d\\] \\<e> \\~f\\~ \\\\");
    expect(escapeText("snake_case と 日本語_の_間")).toBe("snake_case と 日本語_の_間");
    expect(escapeText("_強調_")).toBe("\\_強調\\_");
    expect(escapeText("&amp; と & だけ")).toBe("\\&amp; と & だけ");
  });

  it("行頭の見出し・引用・リスト・区切り線をエスケープする", () => {
    expect(escapeLineStart("# 見出しではない")).toBe("\\# 見出しではない");
    expect(escapeLineStart("> 引用ではない")).toBe("\\> 引用ではない");
    expect(escapeLineStart("- 項目ではない")).toBe("\\- 項目ではない");
    expect(escapeLineStart("1. 番号ではない")).toBe("1\\. 番号ではない");
    expect(escapeLineStart("---")).toBe("\\---");
    expect(escapeLineStart("#タグ")).toBe("#タグ");
    expect(escapeLineStart("2026年")).toBe("2026年");
  });
});

describe("DOM から Markdown", () => {
  it("段落・見出し・強調・リンク・画像・コード", () => {
    const root = el(
      "div",
      {},
      el("h2", {}, "見出し"),
      el(
        "p",
        {},
        "本文と",
        el("b", {}, "太字 "),
        "と",
        el("em", {}, "斜体"),
        "と",
        el("a", { "data-href": "https://example.com/a b" }, "リンク"),
        "と",
        el("code", {}, "a`b"),
      ),
      el("p", {}, el("span", { "data-img": "", "data-src": "./media/abcdefghjk.png", "data-alt": "写真 [1]" })),
      el("pre", { "data-lang": "ts" }, "const a = 1;\n```\n"),
      el("hr"),
    );
    expect(md(root)).toBe(
      [
        "## 見出し",
        "",
        "本文と**太字** と*斜体*と[リンク](<https://example.com/a b>)と``a`b``",
        "",
        "![写真 \\[1\\]](./media/abcdefghjk.png)",
        "",
        "````ts\nconst a = 1;\n```\n````",
        "",
        "---",
        "",
      ].join("\n"),
    );
  });

  it("リスト（入れ子・番号・チェック）と引用", () => {
    const root = el(
      "div",
      {},
      el(
        "ul",
        { "data-marker": "*" },
        el("li", {}, "一", el("ul", {}, el("li", {}, "入れ子"))),
        el("li", { "data-checked": "true" }, el("span", { "data-ui": "check" }, "☑"), "済"),
      ),
      el("ol", { start: "3" }, el("li", {}, "三"), el("li", {}, "四")),
      el("blockquote", {}, "引用の", el("br"), "続き"),
    );
    expect(md(root)).toBe("* 一\n  - 入れ子\n* [x] 済\n\n3. 三\n4. 四\n\n> 引用の\\\n> 続き\n");
  });

  it("編集していないブロックは元の記述と区切りをそのまま使う", () => {
    const a = el("p", {}, "A");
    const b = el("p", {}, "B");
    const c = el("p", {}, "C（編集後）");
    const info = new Map<VNode, PristineBlock>([
      [a, { src: "*A*", prev: null, gap: "\n", tail: null }],
      [b, { src: "B\n===", prev: a, gap: "\n\n\n", tail: null }],
      [c, { src: "C", prev: b, gap: "\n\n", tail: "\n\n" }],
    ]);
    const root = el("div", {}, a, b, c);
    // c だけ編集した
    expect(md(root, { pristine: (n) => (n === c ? null : (info.get(n) ?? null)) })).toBe(
      "\n*A*\n\n\nB\n===\n\nC（編集後）\n",
    );
    // すべて未編集なら元どおり
    expect(md(root, { pristine: (n) => info.get(n) ?? null })).toBe("\n*A*\n\n\nB\n===\n\nC\n\n");
  });

  it("対応しない記法は data-md の記述をそのまま出す。空の段落と末尾の <br> は出さない", () => {
    const root = el(
      "div",
      {},
      el("div", { "data-md": "| a |\n| - |", "data-md-block": "table" }, "| a |"),
      el("p", {}, el("br")),
      el("p", {}, "前", el("span", { "data-md": "<kbd>x</kbd>" }, "<kbd>x</kbd>"), "後", el("br")),
    );
    expect(md(root)).toBe("| a |\n| - |\n\n前<kbd>x</kbd>後\n");
  });

  it("ブラウザが直下に置いた文字は段落にする", () => {
    expect(md(el("div", {}, "直下の文字"))).toBe("直下の文字\n");
    expect(md(el("div", {}))).toBe("");
  });
});
