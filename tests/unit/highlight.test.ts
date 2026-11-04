/** コードハイライト（仕様 15）：対象8言語だけ、クラス名を検証し、文字列はエスケープする */
import { describe, expect, it } from "vitest";
import type { Code, Root } from "mdast";
import { attachHighlights, highlight, languageOf } from "../../src/lib/core/highlight";
import { validTokens } from "../../src/lib/core/highlight-tokens";
import { renderHtml } from "../../src/lib/core/markdown";
import { parseMarkdown } from "../../src/lib/core/markdown-parse";

function render(md: string): string {
  const p = parseMarkdown(md);
  if (!p.ok) throw new Error(p.message);
  attachHighlights(p.tree);
  return renderHtml(p.tree, []).html;
}

describe("コードハイライト", () => {
  it.each(["html", "css", "js", "javascript", "ts", "typescript", "json", "yaml", "yml", "bash", "sh", "python", "py"])(
    "%s は対象言語",
    (l) => expect(languageOf(l)).not.toBeNull(),
  );

  it("非対応の言語はプレーン表示", () => {
    expect(languageOf("rust")).toBeNull();
    expect(render("```rust\nfn main() {}\n```\n")).toContain('<code class="hljs">fn main() {}</code>');
  });

  it("TypeScript をハイライトし、連結すると元のコードに戻る", () => {
    const code = "const x: number = 1; // c\n";
    const t = highlight(code, "ts");
    expect(t?.some(([c]) => c.includes("hljs-keyword"))).toBe(true);
    expect(t?.map((x) => x[1]).join("")).toBe(code);
    expect(render("```ts\n" + code + "```\n")).toContain('<span class="hljs-keyword">const</span>');
  });

  it("コード内の HTML は文字として表示する", () => {
    const html = render("```html\n<script>alert(1)</script>\n```\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });

  it("解析層から届いた不正なクラス名・改変された文字列は使わない", () => {
    expect(validTokens([['x" onclick="a', "a"]], "a")).toBeNull();
    expect(validTokens([["hljs-keyword", "b"]], "a")).toBeNull();
    expect(validTokens([["hljs-keyword", "a"]], "a")).not.toBeNull();
    const tree: Root = {
      type: "root",
      children: [{ type: "code", lang: "js", value: "a", data: { hl: [['"><img src=x>', "a"]] } } as Code],
    };
    const out = renderHtml(tree, []).html;
    expect(out).not.toContain("<img");
    expect(out).toContain('<code class="hljs">a</code>');
  });
});
