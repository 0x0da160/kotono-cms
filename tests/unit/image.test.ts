/**
 * 画像の内容形式・寸法・アニメーション構造の検査（17.1・17.3・34.3）。
 * 試験用の画像はヘッダー部分だけを組み立てたもの（デコード可能な完全な画像ではない）。
 */
import { describe, expect, it } from "vitest";
import { escapeAlt, imageMarkdown, inspectImage, sniffFormat } from "../../src/lib/core/image";
import { avif, gif, jpeg, png, webpAnimated, webpLossless } from "./support/images";

describe("形式の判定（17.1）", () => {
  it.each([
    ["png", png(2, 3)],
    ["gif", gif(2, 3, 1)],
    ["jpeg", jpeg(2, 3)],
    ["webp", webpLossless(2, 3)],
    ["avif", avif(2, 3)],
  ])("%s を先頭バイトで判定し、寸法を読む", (fmt, bytes) => {
    expect(sniffFormat(bytes)).toBe(fmt);
    const r = inspectImage(bytes);
    expect(r).toMatchObject({ ok: true, info: { format: fmt, width: 2, height: 3 } });
  });

  it("SVG は取り込み・プレビューの対象外", () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(inspectImage(svg)).toMatchObject({ ok: false, code: "svg" });
  });

  it("未知の形式は拒否する", () => {
    expect(inspectImage(new Uint8Array([1, 2, 3, 4]))).toMatchObject({ ok: false, code: "unknown-format" });
  });

  it("拡張子と内容の不一致は拒否する（偽装）", () => {
    expect(inspectImage(png(1, 1), { fileName: "photo.jpg" })).toMatchObject({ ok: false, code: "extension-mismatch" });
    expect(inspectImage(png(1, 1), { fileName: "photo" })).toMatchObject({ ok: false, code: "extension-mismatch" });
    expect(inspectImage(png(1, 1), { fileName: "PHOTO.PNG" }).ok).toBe(true);
    expect(inspectImage(jpeg(1, 1), { fileName: "a.jpeg", declaredType: "image/jpeg" }).ok).toBe(true);
  });

  it("申告 MIME と内容の不一致は拒否する", () => {
    expect(inspectImage(png(1, 1), { declaredType: "image/gif" })).toMatchObject({ ok: false, code: "mime-mismatch" });
  });
});

describe("画素数・アニメーションの上限（34.3）", () => {
  it("画素数はデコード前にヘッダーから検査する", () => {
    expect(inspectImage(png(8000, 5001))).toMatchObject({ ok: false, code: "pixels" });
    expect(inspectImage(png(8000, 5000)).ok).toBe(true);
    // 設定値の方が小さければ設定値を使う
    expect(inspectImage(png(100, 100), { maxPixels: 9_999 })).toMatchObject({ ok: false, code: "pixels" });
    // 設定値が固定上限より大きくても緩和しない
    expect(inspectImage(png(8000, 5001), { maxPixels: 100_000_000 })).toMatchObject({ ok: false, code: "pixels" });
  });

  it("GIF のフレーム数・累積画素を全展開せずに数える", () => {
    expect(inspectImage(gif(10, 10, 3))).toMatchObject({ ok: true, info: { frames: 3, animated: true } });
    expect(inspectImage(gif(10, 10, 201))).toMatchObject({ ok: false, code: "frames" });
    expect(inspectImage(gif(5000, 5000, 5))).toMatchObject({ ok: false, code: "frames" });
  });

  it("APNG は acTL のフレーム数で判定する", () => {
    expect(inspectImage(png(10, 10, 4))).toMatchObject({ ok: true, info: { animated: true, frames: 4 } });
    expect(inspectImage(png(10, 10, 1000))).toMatchObject({ ok: false, code: "frames" });
  });

  it("アニメーション WebP は ANMF を数える", () => {
    expect(inspectImage(webpAnimated(10, 10, 2))).toMatchObject({ ok: true, info: { animated: true, frames: 2 } });
    expect(inspectImage(webpAnimated(10, 10, 201))).toMatchObject({ ok: false, code: "frames" });
  });

  it("アニメーション AVIF は構造を検査できないため拒否する", () => {
    expect(inspectImage(avif(10, 10, "avis"))).toMatchObject({ ok: false, code: "animation-unverifiable" });
  });

  it("途中で切れたファイルは不正として拒否する", () => {
    const g = gif(10, 10, 2);
    expect(inspectImage(g.slice(0, g.length - 5))).toMatchObject({ ok: false, code: "malformed" });
    const p = png(10, 10);
    expect(inspectImage(p.slice(0, 30))).toMatchObject({ ok: false });
  });
});

describe("本文への挿入（17.1）", () => {
  it("alt を Markdown の画像記法に合わせてエスケープする", () => {
    expect(escapeAlt("a]b[c\\d\ne")).toBe("a\\]b\\[c\\\\d e");
    expect(imageMarkdown("", "abc.png")).toBe("![](./media/abc.png)");
  });
});
