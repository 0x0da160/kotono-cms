/**
 * デザイントークンの正本。色（palette.ts）と、文字・余白・角丸・影・フォーカスの輪・重なり順をここで定義し、
 * `renderTokensCss()` で `src/styles/tokens.css` を作る。tokens.css は生成物なので手で直さない（`pnpm tokens`）。
 *
 * 寸法の名前は px の値（`--space-12` は 12px）。rem で書き出すので、文字の拡大に追従する。
 * 段の選び方は docs/knowledge/product/design-system.md。
 */
import { HUES, SCALES, SEMANTIC } from "./palette";

type TokenGroup = { title: string; tokens: readonly (readonly [name: string, value: string, note?: string])[] };

const rem = (px: number) => `${px / 16}rem`;

export const FONT_SANS = [
  "system-ui",
  "-apple-system",
  '"Segoe UI"',
  '"Hiragino Sans"',
  '"Hiragino Kaku Gothic ProN"',
  '"Yu Gothic UI"',
  "Meiryo",
  "sans-serif",
].join(", ");

export const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** 文字の大きさ（px）。段階の外の大きさは使わない */
export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 24] as const;
/** 余白・間隔（px）。4px の倍数を基本に、詰めた部品のための 2・6・10px を足す */
export const SPACES = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32] as const;

export const STATIC_GROUPS: readonly TokenGroup[] = [
  {
    title: "文字",
    tokens: [
      ["font-sans", FONT_SANS, "外部フォントは使わない（仕様 2.1・16.3）"],
      ["font-mono", FONT_MONO],
      ...FONT_SIZES.map((px) => [`font-size-${px}`, rem(px)] as const),
      ["line-height-body", "1.6", "基本の行間"],
      ["line-height-tight", "1.5", "一覧のタイトルなど、行を詰める所"],
      ["line-height-prose", "1.75", "本文の見たまま編集とプレビュー"],
      ["font-weight-regular", "400"],
      ["font-weight-strong", "600"],
    ],
  },
  {
    title: "余白・間隔",
    tokens: SPACES.map((px) => [`space-${px}`, rem(px)] as const),
  },
  {
    /*
     * 操作部品（ボタン・入力欄・選択欄）の内側の余白と、並べたときの間隔・面の余白。
     * 高さ＝文字 × 行間 ＋ 上下の余白 ＋ 枠：標準 16px で 34px、詰め 14px で 27px。
     * 指で操作する画面では、見た目の余白は同じまま、押せる高さを --touch-target 以上にする（app.css）。
     */
    title: "操作部品の寸法",
    tokens: [
      ["control-line-height", "1.5", "ボタン・入力欄の行間（本文の 1.6 より詰める）"],
      ["control-pad-y", "var(--space-4)", "標準の部品の上下"],
      ["control-pad-x", "var(--space-10)", "標準の部品の左右"],
      ["control-pad-y-sm", "var(--space-2)", "詰めた部品（14px）の上下"],
      ["control-pad-x-sm", "var(--space-8)", "詰めた部品（14px）の左右"],
      ["control-gap", "var(--space-6)", "横に並べた操作の間隔"],
      ["panel-pad", "var(--space-12) var(--space-16)", "カード・パネルの内側"],
      ["panel-pad-sm", "var(--space-8) var(--space-12)", "中に入れ子にした枠・お知らせの内側"],
      ["touch-target", "2.75rem", "指で押せる最小の高さ（44px。pointer: coarse のとき）"],
    ],
  },
  {
    title: "角丸",
    tokens: [
      ["radius-sm", "4px", "小さな部品（等幅の囲み・つまみ）"],
      ["radius-md", "6px", "ボタン・入力欄・パネル"],
      ["radius-lg", "8px", "ダイアログ・まとめのメニュー・トースト"],
      ["radius-pill", "999px", "バッジ"],
    ],
  },
  {
    title: "影（重なり）",
    tokens: [
      ["shadow-1", "0 4px 12px rgb(0 0 0 / 0.12)", "画面の上に浮く通知（トースト）"],
      ["shadow-2", "0 4px 16px rgb(0 0 0 / 0.16)", "メニュー・ポップオーバー"],
      ["color-overlay", "rgb(0 0 0 / 0.4)", "ダイアログの背後の暗幕"],
    ],
  },
  {
    title: "フォーカスの輪",
    tokens: [
      ["focus-ring-width", "2px"],
      ["focus-ring-offset", "2px"],
      ["focus-ring", "var(--focus-ring-width) solid var(--color-focus)"],
    ],
  },
  {
    title: "重なり順",
    tokens: [
      ["z-sticky", "3", "編集の固定領域"],
      ["z-raised", "4", "固定領域の上に出る部品"],
      ["z-popover", "10", "メニュー・ポップオーバー"],
      ["z-toast", "20", "通知（トースト）"],
      ["z-tooltip", "50", "「?」の説明（ダイアログの中でも前に出す）"],
    ],
  },
];

function line(name: string, value: string, note?: string): string {
  return `  --${name}: ${value};${note ? ` /* ${note} */` : ""}`;
}

export function renderTokensCss(): string {
  const out: string[] = [];
  out.push(
    "/*",
    " * デザイントークン（生成物。手で直さない）。",
    " * 正本：src/lib/design/tokens.ts・palette.ts。書き直し：pnpm tokens",
    " * 規則：docs/knowledge/product/design-system.md",
    " */",
    ":root {",
    "  color-scheme: light dark;",
    "",
  );
  for (const hue of HUES) {
    out.push(`  /* パレット：${hue.name}（Oklab。色相 ${hue.h}°、目標の彩度 ${hue.C}、明度 ${hue.step} ごと） */`);
    for (const s of SCALES.get(hue.name) ?? []) {
      out.push(line(s.token, s.hex, `L ${s.L.toFixed(2)} C ${s.C.toFixed(3)}`));
    }
    out.push("");
  }
  out.push("  /* 意味の色（ライト） */");
  for (const s of SEMANTIC) out.push(line(`color-${s.name}`, `var(--${s.light})`, s.role));
  for (const g of STATIC_GROUPS) {
    out.push("", `  /* ${g.title} */`);
    for (const [n, v, note] of g.tokens) out.push(line(n, v, note));
  }
  out.push("}", "", "@media (prefers-color-scheme: dark) {", "  :root {", "    /* 意味の色（ダーク） */");
  for (const s of SEMANTIC) out.push(`  ${line(`color-${s.name}`, `var(--${s.dark})`)}`);
  out.push("  }", "}", "");
  return out.join("\n");
}
