/**
 * Kotono CMS のカラーパレット（正本）。
 *
 * - 色はすべて Oklab の明度 L・彩度 C・色相 h で定義し、sRGB の 16 進に変換して `src/styles/tokens.css` に書き出す。
 * - 段の名前は明度そのもの（`neutral-48` は L = 0.48）。段の間隔は明度で等間隔にする：
 *   無彩色は 0.04 ごと、有彩色は 0.08 ごと（有彩色の段は無彩色の段の 1 つおきに一致する）。
 * - 色域を超える段は、明度と色相を保ったまま彩度だけを下げる（oklab.ts の gamutMapChroma）。
 * - 画面で使うのは意味のトークン（`--color-*`）だけ。段の値を部品の CSS から直接参照しない。
 *
 * 決定の経緯は docs/knowledge/decisions/0007-design-system-oklab.md、使い方は docs/knowledge/product/design-system.md。
 * 値を変えたら `pnpm tokens` で tokens.css を書き直す（単体試験が一致とコントラストを確かめる）。
 */
import { gamutMapChroma, oklabToHex } from "./oklab";

export interface Hue {
  /** 段の名前の接頭辞（`--neutral-48` など） */
  name: string;
  /** 色相（度） */
  h: number;
  /** 目標の彩度。色域に収まらない段では下がる */
  C: number;
  /** 明度の段の間隔 */
  step: number;
}

/** 段の明度の範囲。0.16 より暗い段と 1.00 は無彩色にだけある。 */
const L_MIN = 0.16;

export const HUES: readonly Hue[] = [
  // 黄みにわずかに寄せた無彩色（これまでの #f3f3f1・#1d1d1b の色相 107° を引き継ぐ）
  { name: "neutral", h: 107, C: 0.005, step: 0.04 },
  // 主な操作・フォーカス・選択（これまでの #0b57d0 の色相）
  { name: "accent", h: 261, C: 0.2, step: 0.08 },
  // 成功・公開対象
  { name: "success", h: 148, C: 0.15, step: 0.08 },
  // エラー・未保存・削除・警告
  { name: "danger", h: 28, C: 0.19, step: 0.08 },
];

export interface Swatch {
  token: string;
  L: number;
  C: number;
  h: number;
  hex: string;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function buildScale(hue: Hue): Swatch[] {
  const out: Swatch[] = [];
  const top = hue.name === "neutral" ? 1 : 0.96;
  for (let L = top; L >= L_MIN - 1e-9; L = round2(L - hue.step)) {
    // 無彩色の白（L = 1）は純白にする
    const C = L >= 1 ? 0 : hue.C;
    const lab = gamutMapChroma(L, C, hue.h);
    out.push({
      token: `${hue.name}-${Math.round(L * 100)}`,
      L,
      C: Math.hypot(lab.a, lab.b),
      h: hue.h,
      hex: oklabToHex(lab),
    });
  }
  return out;
}

export const SCALES: ReadonlyMap<string, Swatch[]> = new Map(HUES.map((h) => [h.name, buildScale(h)]));

export function swatch(token: string): Swatch {
  for (const scale of SCALES.values()) {
    const s = scale.find((x) => x.token === token);
    if (s) return s;
  }
  throw new Error(`unknown palette step: ${token}`);
}

/** 意味のトークン。左がライト、右がダーク（段の名前で指定する）。 */
export interface SemanticColor {
  name: string;
  light: string;
  dark: string;
  /** 役割（tokens.css の注記と文書に出す） */
  role: string;
}

export const SEMANTIC: readonly SemanticColor[] = [
  { name: "bg", light: "neutral-96", dark: "neutral-20", role: "画面の背景" },
  { name: "surface", light: "neutral-100", dark: "neutral-24", role: "面（パネル・入力欄・ボタン・選択中の行）" },
  { name: "text", light: "neutral-24", dark: "neutral-92", role: "本文の文字" },
  { name: "muted", light: "neutral-48", dark: "neutral-72", role: "補助の文字" },
  { name: "border", light: "neutral-88", dark: "neutral-36", role: "領域の区切り・ボタンの枠（装飾）" },
  { name: "field-border", light: "neutral-60", dark: "neutral-56", role: "入力欄の枠（部品の境界、3:1 以上）" },
  { name: "accent", light: "accent-48", dark: "accent-72", role: "主な操作の面・選択・リンク" },
  { name: "on-accent", light: "neutral-100", dark: "accent-16", role: "accent の面に載せる文字" },
  { name: "focus", light: "accent-48", dark: "accent-72", role: "フォーカスの輪" },
  { name: "ok", light: "success-48", dark: "success-72", role: "成功・保存済み・公開対象" },
  { name: "ng", light: "danger-48", dark: "danger-72", role: "エラー・未保存・削除・警告" },
];

/**
 * ブランドの色（固定の 16 進）。ロゴの記号・CMS の文字に使う。
 * 値は design-system 0.4.0 の Petrol Blue と、そのダーク用の petrol-300 をそのまま写す。
 * パレットの段（Oklab で生成）には乗せない：ブランドの値を段の格子に丸めないため。
 */
export const BRAND: { light: string; dark: string; role: string } = {
  light: "#0573aa",
  dark: "#85cdff",
  role: "ロゴの記号・CMS・ブランドの強調（Petrol Blue）",
};

/**
 * コントラストの検査対象（WCAG 2.1 AA）。
 * 文字は 4.5:1（1.4.3）、部品の境界とフォーカスの輪は 3:1（1.4.11・2.4.7）。
 * `on` に並べた背景のすべてに対して満たすこと。
 */
export interface ContrastRule {
  fg: string;
  on: readonly string[];
  min: number;
  why: string;
}

export const CONTRAST_RULES: readonly ContrastRule[] = [
  { fg: "text", on: ["bg", "surface"], min: 4.5, why: "本文（1.4.3）" },
  { fg: "muted", on: ["bg", "surface"], min: 4.5, why: "補助の文字（1.4.3）" },
  { fg: "ok", on: ["bg", "surface"], min: 4.5, why: "バッジ・状態の文字（1.4.3）" },
  { fg: "ng", on: ["bg", "surface"], min: 4.5, why: "エラー・危険な操作の文字（1.4.3）" },
  { fg: "accent", on: ["bg", "surface"], min: 4.5, why: "accent の文字・選択の線（1.4.3）" },
  { fg: "on-accent", on: ["accent"], min: 4.5, why: "主な操作のボタンの文字（1.4.3）" },
  { fg: "field-border", on: ["bg", "surface"], min: 3, why: "入力欄の枠（1.4.11）" },
  {
    fg: "focus",
    on: ["bg", "surface"],
    min: 3,
    why: "フォーカスの輪（1.4.11・2.4.7）。輪は部品の 2px 外側に描くので、隣り合う背景と面に対して測る",
  },
];

export function brandHex(theme: "light" | "dark"): string {
  return theme === "light" ? BRAND.light : BRAND.dark;
}

export function semanticHex(name: string, theme: "light" | "dark"): string {
  const s = SEMANTIC.find((x) => x.name === name);
  if (!s) throw new Error(`unknown semantic color: ${name}`);
  return swatch(theme === "light" ? s.light : s.dark).hex;
}
