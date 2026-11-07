import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToOklab, oklabToHex } from "../../src/lib/design/oklab";
import { CONTRAST_RULES, HUES, SCALES, SEMANTIC, semanticHex } from "../../src/lib/design/palette";
import { renderTokensCss } from "../../src/lib/design/tokens";

const ROOT = join(import.meta.dirname, "../..");
const TOKENS_CSS = join(ROOT, "src/styles/tokens.css");

describe("Oklab の変換", () => {
  it("白と黒の明度は 1 と 0", () => {
    expect(hexToOklab("#ffffff").L).toBeCloseTo(1, 4);
    expect(hexToOklab("#000000").L).toBeCloseTo(0, 4);
  });

  it("Ottosson の参照値（sRGB の赤）と一致する", () => {
    const red = hexToOklab("#ff0000");
    expect(red.L).toBeCloseTo(0.628, 3);
    expect(red.a).toBeCloseTo(0.2249, 3);
    expect(red.b).toBeCloseTo(0.1258, 3);
  });

  it("16 進 → Oklab → 16 進で値が戻る", () => {
    for (const hex of ["#0b57d0", "#1a7f37", "#b42318", "#f3f3f1", "#141413", "#8ab4f8"]) {
      expect(oklabToHex(hexToOklab(hex))).toBe(hex);
    }
  });

  it("WCAG のコントラスト比（白と黒は 21:1）", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

describe("パレット", () => {
  it.each(HUES.map((h) => [h.name, h] as const))("%s の段は明度で等間隔", (_name, hue) => {
    const scale = SCALES.get(hue.name) ?? [];
    expect(scale.length).toBeGreaterThan(5);
    for (let i = 1; i < scale.length; i++) {
      expect((scale[i - 1]?.L ?? 0) - (scale[i]?.L ?? 0)).toBeCloseTo(hue.step, 6);
    }
    // 8 ビットに丸めた後の実際の色でも、明度は名目の値から 0.005 以内（色域の外に出ていない）
    for (const s of scale) expect(Math.abs(hexToOklab(s.hex).L - s.L)).toBeLessThan(0.005);
  });

  it("有彩色の段は無彩色の段と同じ明度に並ぶ", () => {
    const neutral = new Set((SCALES.get("neutral") ?? []).map((s) => s.L));
    for (const hue of HUES) for (const s of SCALES.get(hue.name) ?? []) expect(neutral.has(s.L)).toBe(true);
  });

  it("意味の色はすべてパレットの段を指す", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const s of SEMANTIC) expect(semanticHex(s.name, theme)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  const cases = (["light", "dark"] as const).flatMap((theme) =>
    CONTRAST_RULES.flatMap((r) => r.on.map((bg) => [theme, r.fg, bg, r.min] as const)),
  );
  it.each(cases)("%s：%s は %s に対して %s:1 以上（WCAG 2.1 AA）", (theme, fg, bg, min) => {
    expect(contrastRatio(semanticHex(fg, theme), semanticHex(bg, theme))).toBeGreaterThanOrEqual(min);
  });
});

describe("tokens.css", () => {
  it("正本（tokens.ts・palette.ts）から生成したものと一致する（違うときは pnpm tokens）", () => {
    const expected = renderTokensCss();
    if (process.env.UPDATE_TOKENS === "1") writeFileSync(TOKENS_CSS, expected);
    expect(readFileSync(TOKENS_CSS, "utf8")).toBe(expected);
  });

  it("部品のスタイルに色を直接書かず、旧い短い変数名も使わない", () => {
    const files = [
      join(ROOT, "src/app.css"),
      join(ROOT, "src/App.svelte"),
      ...readdirSync(join(ROOT, "src/components"))
        .filter((f) => f.endsWith(".svelte"))
        .map((f) => join(ROOT, "src/components", f)),
    ];
    const offenders = files.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const styles = f.endsWith(".css")
        ? [src]
        : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
      return styles.flatMap((css) =>
        [
          ...css.matchAll(
            /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|var\(--(?:bg|surface|text|muted|border|field-border|ok|ng|focus|on-accent)\)/g,
          ),
        ].map((m) => `${f}: ${m[0]}`),
      );
    });
    expect(offenders).toEqual([]);
  });
});
