/**
 * デザイントークンの正本。色（palette.ts）と、文字・余白・角丸・影・フォーカスの輪・重なり順をここで定義し、
 * `renderTokensCss()` で `src/styles/tokens.css` を作る。tokens.css は生成物なので手で直さない（`pnpm tokens`）。
 *
 * 寸法の名前は px の値（`--space-12` は 12px）。rem で書き出すので、文字の拡大に追従する。
 * 段の選び方は docs/knowledge/product/design-system.md。
 */
import { EFFECTS, effectValue, FAMILIES, PALETTE, SEMANTIC } from "./palette";

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
      ["line-height-heading", "1.35", "見出し"],
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
     * 指で操作する画面では、見た目の余白は同じまま、押せる高さを部品の種類ごとの下限まで広げる（app.css・ADR-0011）。
     * 下限の根拠：WCAG 2.2 の 2.5.8（AA：24px）を全体の床にし、画面の端で頻繁に押すものだけ Apple HIG の 44pt にする。
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
      [
        "touch-target",
        "2.75rem",
        "指で押す主な移動（メニューの項目・上部バーの開閉）の高さ（44px。Apple HIG の 44pt）",
      ],
      [
        "touch-target-md",
        "2.25rem",
        "指で押す標準のボタン・入力欄・選択欄の高さ（36px。WCAG 2.5.8 の 24px に余裕を足す）",
      ],
      ["touch-target-sm", "2rem", "指で押す詰めた部品（行の中・道具の帯・開閉の見出し）の高さ（32px。WCAG 2.5.8）"],
      ["target-min", "1.5rem", "押せる最小の大きさ（24px。WCAG 2.2 の 2.5.8。マウスでも指でも下回らない）"],
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
    title: "線",
    tokens: [
      ["border-width", "1px", "枠・区切り"],
      ["border-width-edge", "4px", "現在地・お知らせ・差分の太い辺"],
    ],
  },
  {
    title: "フォーカスの輪",
    tokens: [
      ["focus-ring-width", "2px"],
      ["focus-ring-offset", "2px"],
      ["focus-ring-offset-inset", "-2px", "スクロール・クリップする入れ物の中では内側に描く"],
      ["focus-ring", "var(--focus-ring-width) solid var(--color-focus-ring)"],
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
  {
    title: "動き",
    tokens: [
      ["duration-fast", "120ms", "hover・押下の色の変化"],
      ["duration-normal", "200ms", "開閉"],
      ["easing-standard", "cubic-bezier(0.2, 0, 0, 1)"],
    ],
  },
  {
    /* @media の中では変数を使えないので参照用。値は各部品の @media と同じ */
    title: "ブレークポイント（参照用）",
    tokens: [
      ["breakpoint-sm", "30rem", "これより狭い：1 列"],
      ["breakpoint-md", "60rem", "これより狭い：一覧と編集を切り替える"],
      ["breakpoint-lg", "75rem", "これより広い：3 列"],
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
    " * デザイントークン（生成物。手で直さない）。デザインシステム 0.4.0。",
    " * 正本：src/lib/design/tokens.ts・palette.ts。書き直し：pnpm tokens",
    " * 規則：docs/knowledge/product/design-system.md",
    " */",
    ":root {",
    "  color-scheme: light dark;",
    "",
  );
  for (const f of FAMILIES) {
    out.push(`  /* パレット：${f.name}（OKLCH。色相 ${f.h}°、目標の彩度 ${f.C}）：${f.role} */`);
    for (const s of PALETTE.filter((p) => p.name.startsWith(`${f.name}-`))) {
      out.push(line(`palette-${s.name}`, s.hex, `L ${s.L} C ${s.C.toFixed(3)}`));
    }
    out.push("");
  }
  out.push("  /* パレット：ブランドと白・黒 */");
  for (const s of PALETTE.filter((p) => p.name.startsWith("brand-") || p.name === "white" || p.name === "black")) {
    out.push(line(`palette-${s.name}`, s.hex));
  }
  out.push("", "  /* 意味の色（ライト） */");
  for (const s of SEMANTIC) out.push(line(`color-${s.name}`, `var(--palette-${s.light})`, s.role));
  for (const e of EFFECTS) out.push(line(e.name, effectValue(e, "light"), e.role));
  for (const g of STATIC_GROUPS) {
    out.push("", `  /* ${g.title} */`);
    for (const [n, v, note] of g.tokens) out.push(line(n, v, note));
  }
  out.push("}", "", "@media (prefers-color-scheme: dark) {", "  :root {", "    /* 意味の色（ダーク） */");
  for (const s of SEMANTIC) out.push(`  ${line(`color-${s.name}`, `var(--palette-${s.dark})`)}`);
  for (const e of EFFECTS) out.push(`  ${line(e.name, effectValue(e, "dark"))}`);
  out.push(
    "  }",
    "}",
    "",
    "/* コントラストを上げる設定：装飾の区切りを部品の枠に、補足の文字を本文の色にする */",
    "@media (prefers-contrast: more) {",
    "  :root {",
    "    --color-border-subtle: var(--color-border-control);",
    "    --color-fg-muted: var(--color-fg-default);",
    "  }",
    "}",
    "",
    "/* 動きを減らす設定 */",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root {",
    "    --duration-fast: 0ms;",
    "    --duration-normal: 0ms;",
    "  }",
    "}",
    "",
  );
  return out.join("\n");
}
