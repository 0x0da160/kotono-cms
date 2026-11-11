---
type: Architecture Decision
title: "ADR-0007 デザインシステムの再構築と Oklab のカラーパレット"
description: "デザイントークンを TypeScript の正本から CSS に生成して一か所で定義し、カラーパレットを Oklab の明度の等間隔な段で作る決定。生成方式（16 進に変換して書き出す）、意味の色の割り当て、WCAG 2.1 AA の自動検査、旧い変数名からの移行の段取り、ヘルプ部品の作業との分担。"
tags: ["デザインシステム", "デザイントークン", "Oklab", "カラーパレット", "WCAG", "CSS", "移行"]
status: stable
generated: { by: claude-code/2.1.318, at: 2026-11-07T17:40:00Z }
sources:
  - id: request-2026-11-07-design-system
    resource: "0x0da160 の依頼（2026-11-07）：UI デザインシステムを再構築し、カラーは Oklab でパレットを作成する"
    title: "デザインシステムの再構築の依頼"
    author: human:0x0da160
    last_modified: 2026-11-07T17:17:36Z
  - id: oklab
    resource: "https://bottosson.github.io/posts/oklab/"
    title: "Björn Ottosson：A perceptual color space for image processing"
    author: human:bottosson
    last_modified: 2020-12-23T00:00:00Z
  - id: ui-refresh-stage4
    resource: "UI 刷新 段階4 の共通ルール（版 0.3、2026-11-05。プロジェクトの共有フォルダ ui-refresh/stage4/stage4-rules.md）"
    title: "UI 刷新 段階4：共通ルールの整理"
    author: claude-code/2.1.318
    last_modified: 2026-11-05T00:00:00Z
---
> **2026-11-09 更新**：パレット（決定 2 の段の名前を含む）と意味の色の割り当ては [ADR-0010](0010-design-system-0-4.md) で置き換えた。正本を TypeScript に置いて CSS を生成する方式（決定 1・3・4・5）は引き続き有効。

# 決定

1. **トークンの正本を TypeScript に置き、CSS を生成する。** 色は `src/lib/design/palette.ts`、それ以外は `src/lib/design/tokens.ts`。`pnpm tokens` で `src/styles/tokens.css` を書き出し、`src/app.css` が読み込む。生成物はリポジトリに含め、差分で値の変化を確かめられるようにする。
2. **パレットは Oklab で作る。** 色相ごとに明度 L の段を等間隔に並べ（無彩色 0.04 ごと、有彩色 0.08 ごと）、色域を超える段は彩度だけを下げて収める。段の名前は明度（`--accent-48`）。
3. **CSS には 16 進の sRGB で書き出す。** `oklab()`・`oklch()` を CSS に直接書かない。古い Safari・Chrome でも同じ色になり、コントラストを書き出した値そのもので検査できる。
4. **部品は意味の色（`--color-*`）だけを使う。** ダークモードは意味の色の割り当てだけを切り替える。
5. **コントラストを単体試験で検査する。** 文字 4.5:1、入力欄の枠とフォーカスの輪 3:1（WCAG 2.1 AA）を、ライトとダークのすべての組み合わせで確かめる。部品のスタイルに 16 進の色を書くと試験が落ちる。
6. **見た目の変化は小さく保つ。** 意味の色は、これまでの色に最も近い段を選んだ。値と規則は [デザインシステム](../product/design-system.md)。

## 理由

- HSL の明度は見た目の明るさと合わない（同じ L でも黄と青で読みやすさが大きく違う）。Oklab の L はほぼ見た目に比例するので、段を等間隔に並べるだけで、色相が違っても同じ段は同じ明るさになり、コントラストの見通しが立つ。
- これまでの色は `app.css` と UI 刷新の資料（共有フォルダ）に分かれ、根拠のない 16 進の値だった。正本を一か所にし、検査を試験にすることで、値を変えても基準を割らない。
- 生成を実行時ではなく事前に行うのは、単一 HTML・外部依存なしの制約（ADR-0001）に合わせるため。実行時のコードは増えない。

## 旧い色からの変化

| トークン | ライト（旧 → 新） | ダーク（旧 → 新） |
|---|---|---|
| bg | #f3f3f1 → #f2f2ee | #141413 → #161614 |
| surface | #ffffff → #ffffff | #1d1d1b → #1f1f1d |
| text | #1d1d1b → #1f1f1d | #ececea → #e5e5e1 |
| muted | #5c5c57 → #5e5e5b | #a8a8a2 → #a5a5a1 |
| border | #dcdcd7 → #d8d8d4 | #383835 → #3d3d3a |
| field-border | #85857f → #80807d | #73736e → #757571 |
| accent | #0b57d0 → #0852cb | #8ab4f8 → #6fa3ff |
| on-accent | #ffffff → #ffffff | #10203a → #000a2a |
| focus | #0b57d0 → #0852cb | #8ab4f8 → #6fa3ff |
| ok | #1a7f37 → #00722a | #4ac26b → #59be6c |
| ng | #b42318 → #b00d10 | #ff7b72 → #ff7264 |

ダークの `accent` は、これまでの `#8ab4f8`（彩度 0.11）より鮮やかな `#6fa3ff` になった。同じ色相の段を等間隔に並べた結果で、文字と輪のコントラストは基準を満たす（背景に対して 7.21:1）。

## 移行の段取り

1. **基盤（この ADR と同時）**：パレット・トークン・検査・文書。`app.css` の基本スタイルをトークンに置き換え、旧い短い名前（`--bg` など）は `--color-*` の別名として残す。部品の CSS は変えない。
2. **部品**：各 `.svelte` のスタイルの直書きの余白・文字の大きさ・角丸・影・重なり順をトークンに置き換え、旧い名前を `--color-*` にして別名を消す。ヘルプ（「?」の説明とヘルプ画面）の作業が同じファイルのマークアップを触るため、その変更（PR #33）が入った後に行った。見た目の変化は、ダイアログの見出しの 17px → 18px、角丸の 3px → 4px、「?」の説明の影の濃さ（18% → 16%）だけ。

## 未決・残る課題

- 警告用の色（`warning`）は持たない。使う場所が 2 か所以上になったら足す。
- プレビュー（iframe）の色とコードハイライトの色は対象外。記事の見た目として別に扱う。
- 実機（iOS Safari・Windows の高コントラスト表示）での見え方は未確認。強制カラー（`forced-colors`）への対応は別に扱う。
