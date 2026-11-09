/**
 * Kotono CMS のカラーパレット（正本）。デザインシステム 0.4.0。
 *
 * - ブランド6色（Petrol Blue・Iris・Apricot・Sea Glass・Paper・Ink）は確定値。OKLCH の入力値から HEX が再現されることを試験で確かめる。
 * - 8 系列 × 11 段（50〜950）と neutral の追加段 4 つを、OKLCH（Oklab の極座標）の明度 L・彩度 C・色相 h で作り、sRGB の 16 進に変換して書き出す。
 *   段番号は順序で、明度そのものではない（`neutral-100` は L = 0.95）。
 * - 色域を超える段は、明度と色相を保ったまま彩度だけを下げる（oklab.ts の gamutMapChroma）。
 * - 画面で使うのは意味のトークン（`--color-*`）だけ。パレット（`--palette-*`）を部品の CSS から直接参照しない。
 *
 * 決定の経緯は docs/knowledge/decisions/0010-design-system-0-4.md、使い方は docs/knowledge/product/design-system.md。
 * 値を変えたら `pnpm tokens` で tokens.css を書き直す（単体試験が一致とコントラストを確かめる）。
 */
import { gamutMapChroma, oklabToHex } from "./oklab";

export interface Swatch {
  /** パレットの名前（`petrol-700`・`brand-ink` など）。CSS では `--palette-<name>` */
  name: string;
  L: number;
  /** 実際の彩度（色域に収めた後） */
  C: number;
  /** 目標の彩度 */
  requestedC: number;
  h: number;
  hex: string;
}

/** ブランド6色。hex は承認済みの値で、L・C・h から再現できることを試験で確かめる */
export const BRAND = {
  petrol: { L: 0.53, C: 0.12, h: 240, hex: "#0573aa", role: "主色（Petrol Blue）" },
  iris: { L: 0.53, C: 0.135, h: 300, hex: "#7956ad", role: "副色（Iris）" },
  apricot: { L: 0.8, C: 0.1, h: 60, hex: "#eeae7b", role: "副色（Apricot）" },
  "sea-glass": { L: 0.8, C: 0.07, h: 170, hex: "#90cdb7", role: "副色（Sea Glass）" },
  paper: { L: 0.985, C: 0.004, h: 85, hex: "#fbfaf7", role: "紙（原稿の面）" },
  ink: { L: 0.28, C: 0.012, h: 235, hex: "#232a2e", role: "墨（文字）" },
} as const;

/** 段番号と明度 L */
export const LEVELS: readonly (readonly [step: number, L: number])[] = [
  [50, 0.985],
  [100, 0.95],
  [200, 0.9],
  [300, 0.82],
  [400, 0.74],
  [500, 0.66],
  [600, 0.6],
  [700, 0.53],
  [800, 0.45],
  [900, 0.35],
  [950, 0.25],
];

/** 系列（目標の彩度と色相） */
export const FAMILIES: readonly { name: string; C: number; h: number; role: string }[] = [
  { name: "neutral", C: 0.004, h: 85, role: "背景・面・文字・境界" },
  { name: "petrol", C: 0.12, h: 240, role: "主な操作・リンク・選択・フォーカス・情報" },
  { name: "iris", C: 0.135, h: 300, role: "補助の識別（状態の意味を持たない）" },
  { name: "apricot", C: 0.1, h: 60, role: "補助の識別（状態の意味を持たない）" },
  { name: "sea-glass", C: 0.07, h: 170, role: "補助の識別（状態の意味を持たない）" },
  { name: "success", C: 0.13, h: 150, role: "成功・保存済み・追加" },
  { name: "warning", C: 0.14, h: 75, role: "注意：未保存・未コミット・未送信・変更" },
  { name: "danger", C: 0.18, h: 25, role: "失敗・危険：保存失敗・競合・削除・入力の誤り" },
];

/** neutral の追加段（面の段を、どのテーマでも互いに見分けられるようにするため） */
export const EXTRA: readonly { name: string; L: number; C: number; h: number; role: string }[] = [
  { name: "neutral-150", L: 0.925, C: 0.004, h: 85, role: "ライトの hover" },
  { name: "neutral-850", L: 0.4, C: 0.004, h: 85, role: "ダークの押下" },
  { name: "neutral-925", L: 0.3, C: 0.004, h: 85, role: "ダークの浮いた面" },
  { name: "neutral-975", L: 0.19, C: 0.004, h: 85, role: "ダークの画面背景" },
];

function make(name: string, L: number, C: number, h: number): Swatch {
  const lab = gamutMapChroma(L, C, h);
  return { name, L, C: Math.hypot(lab.a, lab.b), requestedC: C, h, hex: oklabToHex(lab) };
}

function buildPalette(): Swatch[] {
  const out: Swatch[] = [];
  for (const [k, b] of Object.entries(BRAND)) out.push(make(`brand-${k}`, b.L, b.C, b.h));
  for (const f of FAMILIES) for (const [step, L] of LEVELS) out.push(make(`${f.name}-${step}`, L, f.C, f.h));
  for (const e of EXTRA) out.push(make(e.name, e.L, e.C, e.h));
  out.push({ name: "white", L: 1, C: 0, requestedC: 0, h: 0, hex: "#ffffff" });
  out.push({ name: "black", L: 0, C: 0, requestedC: 0, h: 0, hex: "#000000" });
  return out;
}

export const PALETTE: readonly Swatch[] = buildPalette();
const BY_NAME = new Map(PALETTE.map((s) => [s.name, s]));

export function swatch(name: string): Swatch {
  const s = BY_NAME.get(name);
  if (!s) throw new Error(`unknown palette entry: ${name}`);
  return s;
}

/** 意味のトークン。CSS では `--color-<name>`。左がライト、右がダーク（パレットの名前で指定する）。 */
export interface SemanticColor {
  name: string;
  light: string;
  dark: string;
  /** 役割（tokens.css の注記と文書に出す） */
  role: string;
}

export const SEMANTIC: readonly SemanticColor[] = [
  // 面の段：どのテーマでも page／surface／raised／hover／pressed がすべて異なる
  { name: "bg-page", light: "neutral-100", dark: "neutral-975", role: "画面の背景" },
  { name: "bg-surface", light: "brand-paper", dark: "neutral-950", role: "基本の面（パネル・ボタン・カード）" },
  {
    name: "bg-raised",
    light: "white",
    dark: "neutral-925",
    role: "浮いた面（入力欄・ダイアログ・メニュー・トースト）",
  },
  { name: "bg-sunken", light: "neutral-100", dark: "neutral-975", role: "沈んだ面（読み取り専用の入力欄）" },
  { name: "bg-hover", light: "neutral-150", dark: "neutral-900", role: "hover" },
  { name: "bg-pressed", light: "neutral-200", dark: "neutral-850", role: "押下" },
  // 文字
  { name: "fg-default", light: "brand-ink", dark: "neutral-100", role: "本文の文字" },
  { name: "fg-muted", light: "neutral-800", dark: "neutral-300", role: "補足の文字" },
  { name: "fg-placeholder", light: "neutral-800", dark: "neutral-300", role: "入力例（ラベルの代わりにしない）" },
  // 境界
  { name: "border-subtle", light: "neutral-200", dark: "neutral-800", role: "装飾の区切り（基準の対象外）" },
  { name: "border-control", light: "neutral-600", dark: "neutral-500", role: "入力欄・ボタンの枠（3:1 以上）" },
  { name: "border-strong", light: "neutral-700", dark: "neutral-400", role: "浮いた面の枠など、強い境界" },
  // 主な操作
  { name: "accent", light: "brand-petrol", dark: "petrol-300", role: "主な操作の面（文字には使わない）" },
  { name: "accent-hover", light: "petrol-800", dark: "petrol-200", role: "主な操作の hover" },
  { name: "accent-pressed", light: "petrol-900", dark: "petrol-400", role: "主な操作の押下" },
  { name: "on-accent", light: "white", dark: "brand-ink", role: "accent の面に載せる文字" },
  { name: "accent-text", light: "petrol-800", dark: "petrol-200", role: "アクセント色の文字（選択中のタブなど）" },
  { name: "accent-subtle", light: "petrol-100", dark: "petrol-950", role: "選択中の切り替え・タブの面" },
  { name: "link", light: "petrol-800", dark: "petrol-300", role: "リンク（常に下線）" },
  { name: "link-hover", light: "petrol-900", dark: "petrol-200", role: "リンクの hover" },
  { name: "focus-ring", light: "petrol-700", dark: "petrol-300", role: "フォーカスの輪" },
  { name: "selection-bg", light: "petrol-200", dark: "petrol-900", role: "選択中の行の面" },
  { name: "selection-fg", light: "brand-ink", dark: "neutral-100", role: "選択中の行の文字" },
  // 原稿
  { name: "editor-bg", light: "brand-paper", dark: "neutral-950", role: "原稿の面" },
  { name: "editor-fg", light: "brand-ink", dark: "neutral-100", role: "原稿の文字（7:1 以上）" },
  { name: "editor-caret", light: "petrol-800", dark: "petrol-200", role: "原稿のカーソル" },
  { name: "editor-selection-bg", light: "petrol-200", dark: "petrol-800", role: "原稿の選択範囲" },
  { name: "editor-selection-fg", light: "brand-ink", dark: "neutral-100", role: "原稿の選択範囲の文字" },
  { name: "code-bg", light: "neutral-100", dark: "neutral-900", role: "アプリ内のコード・パスの面" },
  { name: "code-fg", light: "brand-ink", dark: "neutral-100", role: "アプリ内のコード・パスの文字" },
  // 無効（WCAG の対象外。プロジェクトの下限として文字 3:1）
  { name: "disabled-bg", light: "neutral-200", dark: "neutral-900", role: "無効な部品の面" },
  { name: "disabled-fg", light: "neutral-700", dark: "neutral-500", role: "無効な部品の文字" },
  { name: "disabled-border", light: "neutral-200", dark: "neutral-800", role: "無効な部品の枠" },
  // 状態：bg（面）・fg（文字）・mark（記号）・border（枠）
  { name: "info-bg", light: "petrol-100", dark: "petrol-950", role: "情報・処理中・復旧の面" },
  { name: "info-fg", light: "petrol-800", dark: "petrol-300", role: "情報の文字" },
  { name: "info-mark", light: "petrol-700", dark: "petrol-400", role: "情報の記号" },
  { name: "info-border", light: "petrol-700", dark: "petrol-400", role: "情報の枠" },
  { name: "success-bg", light: "success-100", dark: "success-950", role: "成功の面" },
  { name: "success-fg", light: "success-800", dark: "success-300", role: "成功・保存済み・追加の文字" },
  { name: "success-mark", light: "success-700", dark: "success-400", role: "成功の記号" },
  { name: "success-border", light: "success-700", dark: "success-400", role: "成功の枠" },
  { name: "warning-bg", light: "warning-100", dark: "warning-950", role: "注意の面" },
  { name: "warning-fg", light: "warning-800", dark: "warning-300", role: "注意（未保存・未コミット・一部だけ）の文字" },
  { name: "warning-mark", light: "warning-700", dark: "warning-400", role: "注意の記号" },
  { name: "warning-border", light: "warning-700", dark: "warning-400", role: "注意の枠" },
  { name: "danger-bg", light: "danger-100", dark: "danger-950", role: "失敗・危険の面" },
  { name: "danger-fg", light: "danger-800", dark: "danger-300", role: "失敗・競合・削除・入力の誤りの文字" },
  { name: "danger-mark", light: "danger-700", dark: "danger-400", role: "失敗・危険の記号" },
  { name: "danger-border", light: "danger-700", dark: "danger-400", role: "失敗・危険の枠" },
  { name: "danger-solid", light: "danger-700", dark: "danger-300", role: "削除の確定ボタンの面" },
  { name: "danger-solid-hover", light: "danger-800", dark: "danger-200", role: "削除の確定ボタンの hover" },
  { name: "danger-solid-pressed", light: "danger-900", dark: "danger-400", role: "削除の確定ボタンの押下" },
  { name: "on-danger", light: "white", dark: "brand-ink", role: "danger-solid に載せる文字" },
  // 副色：補助の識別だけ（状態の意味を持たせない）
  { name: "decor-iris-bg", light: "iris-100", dark: "iris-950", role: "副色 Iris の面" },
  { name: "decor-iris-fg", light: "iris-800", dark: "iris-300", role: "副色 Iris の文字" },
  { name: "decor-iris-mark", light: "iris-700", dark: "iris-400", role: "副色 Iris の記号・枠" },
  { name: "decor-apricot-bg", light: "apricot-100", dark: "apricot-950", role: "副色 Apricot の面" },
  { name: "decor-apricot-fg", light: "apricot-800", dark: "apricot-300", role: "副色 Apricot の文字" },
  { name: "decor-apricot-mark", light: "apricot-700", dark: "apricot-400", role: "副色 Apricot の記号・枠" },
  { name: "decor-sea-glass-bg", light: "sea-glass-100", dark: "sea-glass-950", role: "副色 Sea Glass の面" },
  { name: "decor-sea-glass-fg", light: "sea-glass-800", dark: "sea-glass-300", role: "副色 Sea Glass の文字" },
  { name: "decor-sea-glass-mark", light: "sea-glass-700", dark: "sea-glass-400", role: "副色 Sea Glass の記号・枠" },
  // 反転（「?」の説明の吹き出し）
  { name: "bg-inverse", light: "brand-ink", dark: "neutral-100", role: "反転の面（説明の吹き出し）" },
  { name: "fg-inverse", light: "brand-paper", dark: "neutral-950", role: "反転の面の文字" },
];

/** 影と暗幕（半透明。コントラストの検査対象外で、上に文字を置かない） */
export interface Effect {
  name: string;
  geometry?: string;
  light: { color: string; alpha: number };
  dark: { color: string; alpha: number };
  role: string;
}

export const EFFECTS: readonly Effect[] = [
  {
    name: "shadow-1",
    geometry: "0 4px 12px",
    light: { color: "brand-ink", alpha: 0.12 },
    dark: { color: "black", alpha: 0.4 },
    role: "画面の上に浮く通知（トースト）",
  },
  {
    name: "shadow-2",
    geometry: "0 4px 16px",
    light: { color: "brand-ink", alpha: 0.16 },
    dark: { color: "black", alpha: 0.5 },
    role: "メニュー・ポップオーバー・ダイアログ",
  },
  {
    name: "color-overlay",
    light: { color: "brand-ink", alpha: 0.4 },
    dark: { color: "black", alpha: 0.6 },
    role: "ダイアログの背後の暗幕",
  },
];

export function effectValue(e: Effect, theme: "light" | "dark"): string {
  const { color, alpha } = e[theme];
  const hex = swatch(color).hex;
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
  return `${e.geometry ? `${e.geometry} ` : ""}rgb(${rgb} / ${alpha})`;
}

/**
 * コントラストの検査対象。`on` に並べた背景のすべてに対して満たすこと。
 * 文字 4.5:1（1.4.3）、部品の境界・記号・フォーカスの輪 3:1（1.4.11・2.4.7）、
 * 原稿 7:1（プロジェクトの目標）、無効の文字 3:1（プロジェクトの下限。WCAG の対象外）。
 */
export interface ContrastRule {
  fg: string;
  on: readonly string[];
  min: number;
  why: string;
}

const SURFACES = ["bg-page", "bg-surface", "bg-raised", "bg-sunken", "bg-hover"] as const;
const STATUS_BG = ["info-bg", "success-bg", "warning-bg", "danger-bg"] as const;

export const CONTRAST_RULES: readonly ContrastRule[] = [
  {
    fg: "fg-default",
    on: [...SURFACES, "bg-pressed", "selection-bg", "accent-subtle", ...STATUS_BG],
    min: 4.5,
    why: "本文（お知らせの面の上も）",
  },
  {
    fg: "fg-muted",
    on: [...SURFACES, "bg-pressed", "selection-bg", "accent-subtle", ...STATUS_BG],
    min: 4.5,
    why: "補足の文字（選択中・押下中の行、お知らせの面の上も）",
  },
  { fg: "fg-placeholder", on: [...SURFACES, "editor-bg"], min: 4.5, why: "入力例" },
  { fg: "link", on: [...SURFACES, ...STATUS_BG], min: 4.5, why: "リンク（お知らせの中も）" },
  { fg: "link-hover", on: SURFACES, min: 4.5, why: "リンクの hover" },
  { fg: "border-control", on: SURFACES, min: 3, why: "入力欄・ボタンの枠（1.4.11）" },
  { fg: "border-strong", on: SURFACES, min: 3, why: "強い境界" },
  {
    fg: "focus-ring",
    on: [...SURFACES, "bg-pressed", "selection-bg", ...STATUS_BG, "editor-bg", "code-bg", "accent-subtle"],
    min: 3,
    why: "フォーカスの輪（2.4.7・1.4.11）。部品の 2px 外側、または内側に描くので、載る面のすべてに対して測る",
  },
  { fg: "on-accent", on: ["accent", "accent-hover", "accent-pressed"], min: 4.5, why: "主な操作のボタンの文字" },
  {
    fg: "accent",
    on: ["bg-page", "bg-surface", "bg-raised", "selection-bg", "accent-subtle"],
    min: 3,
    why: "主な操作の面・選択の辺",
  },
  { fg: "accent-hover", on: ["bg-page", "bg-surface", "bg-raised"], min: 3, why: "主な操作の面（hover）" },
  { fg: "accent-pressed", on: ["bg-page", "bg-surface", "bg-raised"], min: 3, why: "主な操作の面（押下）" },
  {
    fg: "accent-text",
    on: ["accent-subtle", "bg-page", "bg-surface", "bg-raised", "bg-hover"],
    min: 4.5,
    why: "アクセント色の文字",
  },
  { fg: "selection-fg", on: ["selection-bg"], min: 4.5, why: "選択中の行の文字" },
  { fg: "editor-fg", on: ["editor-bg"], min: 7, why: "原稿（プロジェクトの目標。AAA 全体の適合ではない）" },
  { fg: "editor-selection-fg", on: ["editor-selection-bg"], min: 4.5, why: "原稿の選択範囲" },
  { fg: "editor-caret", on: ["editor-bg", "editor-selection-bg"], min: 3, why: "原稿のカーソル" },
  { fg: "code-fg", on: ["code-bg"], min: 4.5, why: "アプリ内のコード" },
  ...(["info", "success", "warning", "danger"] as const).flatMap((k) => [
    {
      fg: `${k}-fg`,
      on: [`${k}-bg`, ...SURFACES, ...(k === "danger" ? ["bg-pressed"] : [])],
      min: 4.5,
      why: "状態の文字",
    },
    { fg: `${k}-mark`, on: [`${k}-bg`, ...SURFACES], min: 3, why: "状態の記号" },
    {
      fg: `${k}-border`,
      on: [`${k}-bg`, "bg-surface", "bg-page", "bg-raised"],
      min: 3,
      why: "状態の枠（入力欄の誤りも）",
    },
  ]),
  {
    fg: "on-danger",
    on: ["danger-solid", "danger-solid-hover", "danger-solid-pressed"],
    min: 4.5,
    why: "削除の確定ボタンの文字",
  },
  { fg: "danger-solid", on: ["bg-page", "bg-surface", "bg-raised"], min: 3, why: "削除の確定ボタンの面" },
  {
    fg: "danger-solid-hover",
    on: ["bg-page", "bg-surface", "bg-raised"],
    min: 3,
    why: "削除の確定ボタンの面（hover）",
  },
  {
    fg: "danger-solid-pressed",
    on: ["bg-page", "bg-surface", "bg-raised"],
    min: 3,
    why: "削除の確定ボタンの面（押下）",
  },
  ...(["iris", "apricot", "sea-glass"] as const).flatMap((k) => [
    { fg: `decor-${k}-fg`, on: [`decor-${k}-bg`], min: 4.5, why: "副色のバッジの文字" },
    { fg: `decor-${k}-mark`, on: [`decor-${k}-bg`], min: 3, why: "副色のバッジの記号・枠" },
  ]),
  { fg: "fg-inverse", on: ["bg-inverse"], min: 4.5, why: "説明の吹き出しの文字" },
  { fg: "disabled-fg", on: ["disabled-bg"], min: 3, why: "無効の文字（プロジェクトの下限）" },
];

export function semanticHex(name: string, theme: "light" | "dark"): string {
  const s = SEMANTIC.find((x) => x.name === name);
  if (!s) throw new Error(`unknown semantic color: ${name}`);
  return swatch(theme === "light" ? s.light : s.dark).hex;
}
