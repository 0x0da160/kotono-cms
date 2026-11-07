---
type: Design System
title: "Kotono CMS のデザインシステム（トークンと使い方の規則）"
description: "デザイントークン（色・文字・余白・角丸・影・フォーカスの輪・重なり順）の正本の場所と、Oklab で作ったパレット、意味の色の割り当て、コントラストの基準（WCAG 2.1 AA、ライト・ダーク）、部品の CSS を書くときの規則。"
tags: ["デザインシステム", "デザイントークン", "Oklab", "カラーパレット", "コントラスト", "WCAG", "ダークモード", "CSS"]
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
  - id: wcag21
    resource: "https://www.w3.org/TR/WCAG21/（1.4.3 コントラスト（最低限）、1.4.11 非テキストのコントラスト、2.4.7 フォーカスの可視化）"
    title: "Web Content Accessibility Guidelines (WCAG) 2.1"
    author: team:w3c
    last_modified: 2023-09-21T00:00:00Z
---
# デザインシステム

決定の経緯は [ADR-0007](../decisions/0007-design-system-oklab.md)。ここには、部品の CSS を書くときに守る規則を置く。

## 正本と生成物

| 場所 | 中身 | 手で直すか |
|---|---|---|
| `src/lib/design/palette.ts` | 色相ごとのパレット（Oklab の L・C・h）、意味の色の割り当て、コントラストの検査対象 | 直す |
| `src/lib/design/tokens.ts` | 文字・余白・角丸・影・フォーカスの輪・重なり順 | 直す |
| `src/lib/design/oklab.ts` | Oklab と sRGB の変換、色域への収め方、WCAG のコントラスト比 | 通常は直さない |
| `src/styles/tokens.css` | 上の2つから作る CSS カスタムプロパティ | 直さない（`pnpm tokens`） |
| `src/app.css` | 全体の基本スタイル（`button`・`input`・`.badge` など）。トークンを名前で使う | 直す |

`tests/unit/design-tokens.test.ts` が、tokens.css と正本の一致、明度の段の間隔、すべてのコントラストの基準、部品のスタイルに 16 進の色がないことを確かめる。正本を変えて tokens.css を書き直し忘れると試験が落ちる。

## 色

### パレット

色は Oklab の明度 L・彩度 C・色相 h で決め、sRGB の 16 進に変換して書き出す。段の名前は明度そのもの（`--neutral-48` は L = 0.48）。

| 色相 | h | 目標の C | 明度の段 | 用途 |
|---|---|---|---|---|
| `neutral` | 107° | 0.005 | 1.00、0.96〜0.16 を 0.04 ごと（22段） | 背景・面・文字・境界 |
| `accent` | 261° | 0.20 | 0.96〜0.16 を 0.08 ごと（11段） | 主な操作・選択・フォーカス |
| `success` | 148° | 0.15 | 同上 | 成功・保存済み・公開対象 |
| `danger` | 28° | 0.19 | 同上 | エラー・未保存・削除・警告 |

- Oklab の L は見た目の明るさにほぼ比例するので、段の間隔をそろえると、どの色相でも「同じ段なら同じ明るさ」に見える。色相を変えても、同じ段の文字は同じくらい読める。
- 有彩色の段は無彩色の段の 1 つおき（0.08 ごと）に一致させる。同じ数字の段どうしは同じ明度。
- sRGB の色域を超える段は、明度と色相を保ったまま彩度だけを下げる。明るい段・暗い段で彩度が下がるのはこのため。
- 無彩色はわずかに黄みに寄せる（これまでの色の色相を引き継ぐ）。

### 意味の色

部品の CSS は意味の色（`--color-*`）だけを使う。パレットの段（`--neutral-48` など）を部品から直接参照しない。ダークモードは `prefers-color-scheme` で、意味の色の割り当てだけを切り替える。

| トークン | 役割 | ライト | ダーク |
|---|---|---|---|
| `--color-bg` | 画面の背景 | `neutral-96` #f2f2ee | `neutral-20` #161614 |
| `--color-surface` | 面（パネル・入力欄・ボタン・選択中の行） | `neutral-100` #ffffff | `neutral-24` #1f1f1d |
| `--color-text` | 本文の文字 | `neutral-24` #1f1f1d | `neutral-92` #e5e5e1 |
| `--color-muted` | 補助の文字 | `neutral-48` #5e5e5b | `neutral-72` #a5a5a1 |
| `--color-border` | 領域の区切り・ボタンの枠（装飾） | `neutral-88` #d8d8d4 | `neutral-36` #3d3d3a |
| `--color-field-border` | 入力欄の枠（部品の境界、3:1 以上） | `neutral-60` #80807d | `neutral-56` #757571 |
| `--color-accent` | 主な操作の面・選択・リンク | `accent-48` #0852cb | `accent-72` #6fa3ff |
| `--color-on-accent` | accent の面に載せる文字 | `neutral-100` #ffffff | `accent-16` #000a2a |
| `--color-focus` | フォーカスの輪 | `accent-48` #0852cb | `accent-72` #6fa3ff |
| `--color-ok` | 成功・保存済み・公開対象 | `success-48` #00722a | `success-72` #59be6c |
| `--color-ng` | エラー・未保存・削除・警告 | `danger-48` #b00d10 | `danger-72` #ff7264 |

### コントラスト（WCAG 2.1 AA）

文字は 4.5:1（1.4.3）、入力欄の枠とフォーカスの輪は 3:1（1.4.11・2.4.7）。値は 8 ビットに丸めた後の 16 進で計算したもの。

| 前景 | 背景 | 基準 | ライト | ダーク |
|---|---|---|---|---|
| `text` | `bg` | 4.5:1 | 14.71 | 14.35 |
| `text` | `surface` | 4.5:1 | 16.51 | 13.07 |
| `muted` | `bg` | 4.5:1 | 5.80 | 7.33 |
| `muted` | `surface` | 4.5:1 | 6.51 | 6.68 |
| `ok` | `bg` | 4.5:1 | 5.44 | 7.77 |
| `ok` | `surface` | 4.5:1 | 6.10 | 7.08 |
| `ng` | `bg` | 4.5:1 | 6.43 | 6.77 |
| `ng` | `surface` | 4.5:1 | 7.21 | 6.17 |
| `accent` | `bg` | 4.5:1 | 6.08 | 7.21 |
| `accent` | `surface` | 4.5:1 | 6.82 | 6.57 |
| `on-accent` | `accent` | 4.5:1 | 6.82 | 7.76 |
| `field-border` | `bg` | 3:1 | 3.53 | 3.92 |
| `field-border` | `surface` | 3:1 | 3.96 | 3.57 |
| `focus` | `bg` | 3:1 | 6.08 | 7.21 |
| `focus` | `surface` | 3:1 | 6.82 | 6.57 |

- `border` は装飾の区切り（領域・ボタンの枠）で、基準の対象外。部品を見分けるのに必要な境界には `field-border` を使う。
- 無効なボタン（`opacity: 0.55`）は WCAG の対象外。
- 状態は色だけで伝えない。バッジには必ず文字を入れ、通知には記号を付ける（仕様 14.1）。
- 警告用の色は持たない（`ng` と記号で区別する）。使う場所が 2 か所以上になったら、`warning` の色相を足して同じ規則で検査する。

## 文字

| トークン | 値 | 用途 |
|---|---|---|
| `--font-sans` | OS 標準の日本語フォント | 全体。外部フォントは使わない（仕様 2.1・16.3） |
| `--font-mono` | OS 標準の等幅 | コード・ID・パス |
| `--font-size-12` | 12px | バッジ、一覧のメタ情報、補足文、フッター |
| `--font-size-13` | 13px | 記事情報の説明文 |
| `--font-size-14` | 14px | ラベル、詰めた操作、副見出し（太字）、状態の文 |
| `--font-size-15` | 15px | 本文欄（等幅）、一覧のタイトル |
| `--font-size-16` | 16px | 標準の入力値と操作 |
| `--font-size-18` | 18px | 作業台での見出し（アプリ名・記事名）、ダイアログの見出し（以前の 17px はここにまとめた） |
| `--font-size-20` | 20px | 1 枚だけの画面（回復コード・確認ページ）の見出し |
| `--font-size-24` | 24px | 狭い画面のアプリ名 |
| `--line-height-body`・`-tight`・`-prose` | 1.6・1.5・1.75 | 基本・一覧のタイトル・本文の見たまま編集とプレビュー |
| `--font-weight-regular`・`-strong` | 400・600 | |

段の外の大きさは使わない。値は rem で書き出すので、文字の拡大に追従する。指で操作する画面では入力欄を 16px 以上にする（`app.css`）。

## 余白・間隔

`--space-2`・`4`・`6`・`8`・`10`・`12`・`16`・`20`・`24`・`32`（数字は px、値は rem）。4px の倍数を基本にし、詰めた部品の内側の余白にだけ 2・6・10 を使う。

- 部品の高さは「文字 × 行間 ＋ 上下の余白 ＋ 枠」で決まる。固定の高さは指定しない。
- 詰め（14px・余白 4px）で 32px、標準（16px・余白 6px）で 40px。指で操作する画面のボタンは 44px 以上（`app.css`）。

## 角丸・影・重なり順

| トークン | 値 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | 小さな部品 |
| `--radius-md` | 6px | ボタン・入力欄・パネル |
| `--radius-lg` | 8px | ダイアログ・メニュー・トースト |
| `--radius-pill` | 999px | バッジ |
| `--shadow-1` | `0 4px 12px` 黒 12% | トースト |
| `--shadow-2` | `0 4px 16px` 黒 16% | メニュー・ポップオーバー |
| `--color-overlay` | 黒 40% | ダイアログの暗幕 |
| `--z-sticky`・`--z-raised`・`--z-popover`・`--z-toast`・`--z-tooltip` | 3・4・10・20・50 | 固定領域・その上の部品・メニュー・トースト・「?」の説明 |

影は面の重なりを示す補助で、境界は枠線でも示す（ダークモードでは影がほとんど見えないため）。

## フォーカスの輪

`:focus-visible` に `outline: var(--focus-ring)`（2px・`--color-focus`）と `outline-offset: var(--focus-ring-offset)`（2px）。輪は部品の外側に描くので、隣り合う `bg` と `surface` の両方に対して 3:1 以上を保つ。部品ごとに輪を消したり色を変えたりしない。

## 新しい CSS を書くとき

1. 色は `--color-*` だけを使う。16 進・`rgb()`・`hsl()` を直接書かない（試験が検出する）。影と暗幕も `--shadow-*`・`--color-overlay` を使う。
2. 寸法は `--space-*`・`--font-size-*`・`--radius-*` から選ぶ。段にない値が要るときは、2 か所以上で使うと決まってから正本に足す。
3. 新しい意味の色を足すときは、`palette.ts` の `SEMANTIC` と `CONTRAST_RULES` の両方に足し、`pnpm tokens` で書き直す。
4. 旧い短い名前（`--bg`・`--surface`・`--text` など）は 2026-11-07 に廃止した。使うと試験が落ちる。
5. 親の文字に比例させたい所（`code` の 0.9em など）は em のままでよい。

## 対象外

- プレビュー（`src/lib/preview/frame.ts`）は記事の見た目を表す別の文書（iframe）で、コードハイライトの色を含め、このパレットの対象外。
