import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToOklab, oklabToHex } from "../../src/lib/design/oklab";
import {
  BRAND,
  CONTRAST_RULES,
  EFFECTS,
  FAMILIES,
  LEVELS,
  PALETTE,
  SEMANTIC,
  semanticHex,
  swatch,
} from "../../src/lib/design/palette";
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

describe("パレット（デザインシステム 0.4.0）", () => {
  it("ブランド6色は OKLCH の入力値から承認済みの HEX を再現する", () => {
    for (const [k, b] of Object.entries(BRAND)) expect(swatch(`brand-${k}`).hex).toBe(b.hex);
  });

  it("8 系列 × 11 段 ＋ 追加 4 段 ＋ ブランド 6 ＋ 白・黒 の 100 項目", () => {
    expect(PALETTE).toHaveLength(FAMILIES.length * LEVELS.length + 4 + 6 + 2);
    expect(new Set(PALETTE.map((s) => s.name)).size).toBe(PALETTE.length);
  });

  it("段の明度は名目の値どおり（8 ビットに丸めた後で 0.005 以内）で、彩度は目標を超えない", () => {
    for (const s of PALETTE) {
      expect(Math.abs(hexToOklab(s.hex).L - s.L)).toBeLessThan(0.005);
      expect(s.C).toBeLessThanOrEqual(s.requestedC + 1e-9);
    }
  });

  it("デザインシステムの生成器と同じ値になる（代表の段）", () => {
    // design-system 0.4.0 の palette.csv の値
    expect(swatch("neutral-100").hex).toBe("#f0eeeb");
    expect(swatch("neutral-975").hex).toBe("#151412");
    expect(swatch("petrol-800").hex).toBe("#005b88");
    expect(swatch("warning-800").hex).toBe("#734c00");
    expect(swatch("danger-950").hex).toBe("#470005");
  });

  it("意味の色はすべてパレットを指し、ライトとダークで同じ名前を持つ", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const s of SEMANTIC) expect(semanticHex(s.name, theme)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(SEMANTIC.map((s) => s.name)).size).toBe(SEMANTIC.length);
    for (const e of EFFECTS) for (const t of ["light", "dark"] as const) expect(swatch(e[t].color)).toBeTruthy();
  });

  it("面の段（page・surface・raised・hover・pressed）はどのテーマでも互いに異なる", () => {
    for (const theme of ["light", "dark"] as const) {
      const hexes = ["bg-page", "bg-surface", "bg-raised", "bg-hover", "bg-pressed"].map((n) => semanticHex(n, theme));
      expect(new Set(hexes).size).toBe(5);
    }
  });

  it("検査対象は 178 組（ライト・ダークで 356 組）で、重複がない", () => {
    const pairs = CONTRAST_RULES.flatMap((r) => r.on.map((bg) => `${r.fg}|${bg}`));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toHaveLength(178);
  });

  const cases = (["light", "dark"] as const).flatMap((theme) =>
    CONTRAST_RULES.flatMap((r) => r.on.map((bg) => [theme, r.fg, bg, r.min] as const)),
  );
  it.each(cases)("%s：%s は %s に対して %s:1 以上", (theme, fg, bg, min) => {
    expect(contrastRatio(semanticHex(fg, theme), semanticHex(bg, theme))).toBeGreaterThanOrEqual(min);
  });
});

describe("tokens.css", () => {
  it("正本（tokens.ts・palette.ts）から生成したものと一致する（違うときは pnpm tokens）", () => {
    const expected = renderTokensCss();
    if (process.env.UPDATE_TOKENS === "1") writeFileSync(TOKENS_CSS, expected);
    expect(readFileSync(TOKENS_CSS, "utf8")).toBe(expected);
  });

  it("部品のスタイルに色を直接書かず、パレットや旧い変数名も使わない", () => {
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
            /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|var\(--palette-|var\(--color-(?:bg|surface|text|muted|border|field-border|ok|ng|focus)\)|var\(--(?:bg|surface|text|muted|border|field-border|ok|ng|focus|on-accent)\)/g,
          ),
        ].map((m) => `${f}: ${m[0]}`),
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe("ブラウザの枠の色（ADR-0015）", () => {
  // CSS の変数を読めない場所（index.html・manifest）には値を直接書くので、正本とずれないよう確かめる
  it("index.html の theme-color は、上部バーの面の色（bg-surface）と同じ", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    for (const theme of ["light", "dark"] as const) {
      const m = new RegExp(
        `name="theme-color" content="(#[0-9a-f]{6})" media="\\(prefers-color-scheme: ${theme}\\)"`,
      ).exec(html);
      expect(m?.[1]).toBe(semanticHex("bg-surface", theme));
    }
  });

  it("manifest の色は、ライトの面の色（bg-surface）と地の色（bg-page）と同じ", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "public/manifest.webmanifest"), "utf8")) as {
      theme_color: string;
      background_color: string;
    };
    expect(manifest.theme_color).toBe(semanticHex("bg-surface", "light"));
    expect(manifest.background_color).toBe(semanticHex("bg-page", "light"));
  });

  it("画面の端まで使い（viewport-fit=cover）、拡大は止めない", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    const viewport = /name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
  });
});
