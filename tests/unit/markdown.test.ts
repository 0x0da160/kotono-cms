/**
 * Markdown の描画安全性・参照抽出・資源上限（15・16・18.1・34.2）。
 */
import { describe, expect, it } from "vitest";
import { classifyUrl, collectImages, renderHtml } from "../../src/lib/core/markdown";
import { extractMediaRefs, parseMarkdown } from "../../src/lib/core/markdown-parse";

function html(md: string, images: Parameters<typeof renderHtml>[1] = []) {
  const p = parseMarkdown(md);
  if (!p.ok) throw new Error(p.message);
  return renderHtml(p.tree, images);
}

describe("描画（15・16.1）", () => {
  it("GFM の表・取り消し線・チェックリストに対応する", () => {
    const r = html("| a | b |\n|:-|-:|\n| 1 | 2 |\n\n~~消す~~\n\n- [x] 済\n- [ ] 未\n");
    expect(r.html).toContain("<table>");
    expect(r.html).toContain('<th class="a-left">a</th>');
    expect(r.html).toContain("<del>消す</del>");
    expect(r.html).toContain("☑");
    expect(r.html).toContain("☐");
    expect(r.html).not.toContain("<input");
  });

  it("生 HTML は描画せず文字として表示する", () => {
    const r = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n段落 <b onclick="x">b</b>\n');
    expect(r.html).not.toMatch(/<script|<img|<b /);
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("onerror=&quot;alert(1)&quot;");
  });

  it("リンクは遷移しない表示にし、行先は一覧へ出す（16.1.1）", () => {
    const r = html("[外](https://example.com/?a=1&b=2) [危](javascript:alert(1)) [内](#top) [相](../x)\n");
    expect(r.html).not.toContain("<a");
    expect(r.html).not.toContain("href");
    expect(r.links.map((l) => l.target.kind)).toEqual(["external", "rejected", "fragment", "relative"]);
    expect(r.html).toContain('data-link="1"');
  });

  it("コードは実行せずエスケープする", () => {
    const r = html("```html\n<script>x</script>\n```\n\n`<b>`\n");
    expect(r.html).toContain('<pre data-lang="html"><code>&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).toContain("<code>&lt;b&gt;</code>");
  });

  it("単一改行は改行にせず、行末2スペース・バックスラッシュで改行する", () => {
    expect(html("a\nb\n").html).toBe("<p>a\nb</p>");
    expect(html("a  \nb\n").html).toContain("<br>");
    expect(html("a\\\nb\n").html).toContain("<br>");
  });

  it("脚注は対象外として文字のまま残す", () => {
    const r = html("本文[^1]\n\n[^1]: 注\n");
    expect(r.html).toContain("本文[^1]");
    expect(r.html).toContain("[^1]: 注");
    expect(r.links).toHaveLength(0);
  });

  it("画像は親が用意した資源だけを使い、それ以外はプレースホルダーにする", () => {
    const md = "![a](./media/x.png) ![b](https://example.com/x.png) ![c](./media/y.png)\n";
    const p = parseMarkdown(md);
    if (!p.ok) throw new Error();
    const imgs = collectImages(p.tree);
    expect(imgs.map((i) => i.target.kind)).toEqual(["media", "external", "media"]);
    const r = renderHtml(p.tree, [
      { kind: "data", url: "data:image/png;base64,AAAA", width: 1, height: 1 },
      { kind: "placeholder", reason: "外部画像は読み込みません" },
      null,
    ]);
    expect(r.html).toContain('<img src="data:image/png;base64,AAAA" alt="a" width="1" height="1">');
    expect(r.html).toContain("外部画像は読み込みません");
    expect(r.html).toContain("未読込");
    expect(r.html.match(/<img/g)).toHaveLength(1);
  });

  it("alt の引用符は属性から抜け出せない", () => {
    const r = html('![x" onerror="y](./media/a.png)\n', [
      { kind: "data", url: "data:image/png;base64,A", width: 1, height: 1 },
    ]);
    expect(r.html).toContain('alt="x&quot; onerror=&quot;y"');
  });
});

describe("URL の分類（16.2・16.3）", () => {
  it.each([
    ["./media/a.png", "media"],
    ["https://example.com", "external"],
    ["mailto:a@example.com", "external"],
    ["JavaScript:alert(1)", "rejected"],
    ["java\tscript:alert(1)", "rejected"],
    ["data:text/html,x", "rejected"],
    ["file:///etc/passwd", "rejected"],
    ["vbscript:x", "rejected"],
    ["//evil.example", "rejected"],
    ["./media/../index.md", "rejected"],
    ["media/a.png", "rejected"],
    ["./media/a%2epng", "rejected"],
    ["#x", "fragment"],
    ["../other", "relative"],
  ])("%s → %s", (url, kind) => expect(classifyUrl(url).kind).toBe(kind));
});

describe("メディア参照の抽出（18.1）", () => {
  it("インライン・参照形式の画像、media へのリンク、cover を集める", () => {
    const r = extractMediaRefs(
      "![a](./media/a.png)\n\n![b][ref]\n\n[dl](./media/c.pdf)\n\n[ref]: ./media/b.webp\n",
      "./media/cover.jpg",
    );
    expect(r.status).toBe("ok");
    expect([...r.names].sort()).toEqual(["a.png", "b.webp", "c.pdf", "cover.jpg"]);
  });

  it("コードブロック・インラインコード中の例示は参照とみなさない", () => {
    const r = extractMediaRefs("```\n![x](./media/x.png)\n```\n\n`./media/y.png`\n", null);
    expect(r).toEqual({ status: "ok", names: new Set() });
  });

  it("生 HTML・未対応構文・曖昧なパスに media があれば参照状況不明", () => {
    expect(extractMediaRefs('<img src="./media/a.png">\n', null).status).toBe("unknown");
    expect(extractMediaRefs("注[^1]\n\n[^1]: ![x](media/a.png)\n", null).status).toBe("unknown");
    expect(extractMediaRefs("![x](media/a.png)\n", null).status).toBe("unknown");
    expect(extractMediaRefs("![x](./media/a%2Epng)\n", null).status).toBe("unknown");
    expect(extractMediaRefs("", "media/a.png").status).toBe("unknown");
  });

  it("解析の上限を超えたら参照状況不明（未使用と断定しない）", () => {
    const many = "![x](./a.png)".repeat(10_001);
    expect(extractMediaRefs(many, null).status).toBe("unknown");
  });
});

describe("資源上限（34.2）", () => {
  it("入れ子の上限を超えると停止する", () => {
    const p = parseMarkdown(`${">".repeat(120)} x\n`);
    expect(p).toMatchObject({ ok: false, reason: "budget" });
  });

  it("リンク・画像の合計が上限を超えると停止する", () => {
    const p = parseMarkdown("[a](b) ".repeat(10_001));
    expect(p).toMatchObject({ ok: false, reason: "budget" });
  });

  it("ノード数の上限を超えると停止する", () => {
    // 実際の上限（200,000）に届く入力は解析に時間がかかるため、上限値を小さくして検査の働きを確かめる
    const p = parseMarkdown("a\n\n".repeat(600), undefined, { nodes: 1000, depth: 100, linksImages: 10 });
    expect(p).toMatchObject({ ok: false, reason: "budget" });
  });

  it("時間上限を超えた結果を現行として返さない", () => {
    let t = 0;
    const p = parseMarkdown("a\n", () => (t += 3000));
    expect(p).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("プレビュー DOM の要素数が上限を超えたら全文を出さない", () => {
    const r = html("- a\n".repeat(21_000));
    expect(r.overBudget).toBe(true);
    expect(r.html).toBe("");
  });
});
