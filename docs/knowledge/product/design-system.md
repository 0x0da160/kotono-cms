---
type: Design System
title: "Kotono CMS のデザインシステム（トークンと使い方の規則）"
description: "デザインシステム 0.5.0。デザイントークン（色・文字・余白・角丸・影・フォーカスの輪・重なり順・動き・画面の端とキーボード）の正本の場所、ブランド6色と OKLCH のパレット、面の段と意味の色、状態色（情報・成功・注意・危険）、部品の操作状態、指の画面の規則（44px・安全領域・画面キーボード・下の操作バー・シート）、コントラストの基準（ライト・ダーク）、部品の CSS を書くときの規則。"
tags: ["デザインシステム", "デザイントークン", "Oklab", "OKLCH", "カラーパレット", "コントラスト", "WCAG", "ダークモード", "CSS", "iPhone", "タッチ", "安全領域"]
status: stable
generated: { by: claude-code/2.1.322, at: 2026-11-11T06:00:00Z }
sources:
  - id: request-2026-11-09-design-system-0-4
    resource: "0x0da160 の依頼（2026-11-09）：添付のデザインシステム（0.3.0）を敵対的にレビューして完成させ、このプロジェクトに導入して適用する"
    title: "デザインシステム 0.4.0 の導入の依頼"
    author: human:0x0da160
    last_modified: 2026-11-09T13:02:37Z
  - id: request-2026-11-10-iphone-17
    resource: "0x0da160 の依頼（2026-11-10）：iPhone 17 Safari をメインターゲットとして UI を最適化する。UI コンポーネントやレイアウトを見直し、不足があればデザインシステムを改訂する。用語やワーディングも改善する"
    title: "iPhone 17 の Safari に向けた UI の最適化の依頼"
    author: human:0x0da160
    last_modified: 2026-11-10T16:18:30Z
  - id: design-system-0-4-zip
    resource: "Kotono-Design-System-0.4.0.zip（プロジェクトの共有フォルダ design-system/0.4.0/）"
    title: "Kotono CMS Design System 0.4.0（設計仕様・生成器・見本）"
    author: claude-code/2.1.318
    last_modified: 2026-11-09T12:37:00Z
  - id: oklab
    resource: "https://bottosson.github.io/posts/oklab/"
    title: "Björn Ottosson：A perceptual color space for image processing"
    author: human:bottosson
    last_modified: 2020-12-23T00:00:00Z
  - id: wcag22
    resource: "https://www.w3.org/TR/WCAG22/（1.4.3 コントラスト（最低限）、1.4.11 非テキストのコントラスト、2.4.7 フォーカスの可視化、2.5.5 ターゲットの大きさ（高度）、2.5.8 ターゲットの大きさ（最低限））"
    title: "Web Content Accessibility Guidelines (WCAG) 2.2"
    author: team:w3c
    last_modified: 2024-12-12T00:00:00Z
---
# デザインシステム

デザインシステム 0.5.0。色とパレットは 0.4.0 のまま（[ADR-0010](../decisions/0010-design-system-0-4.md)。その前の再構築は [ADR-0007](../decisions/0007-design-system-oklab.md)）。0.5.0 では、iPhone 17 の Safari を主な対象にして、指の画面の規則と、画面の端・キーボードのトークンを足した（[ADR-0015](../decisions/0015-iphone-17-safari-first-ui.md)）。ここには、部品の CSS を書くときに守る規則を置く。領域の配置と画面の切り替えは [アプリの外枠](app-shell.md)。

## 正本と生成物

| 場所 | 中身 | 手で直すか |
|---|---|---|
| `src/lib/design/palette.ts` | ブランド6色、系列と段、意味の色の割り当て、影と暗幕、コントラストの検査対象 | 直す |
| `src/lib/design/tokens.ts` | 文字・余白・操作部品の寸法・画面の端とキーボード・角丸・線・フォーカスの輪・重なり順・動き・ブレークポイント | 直す |
| `src/lib/design/oklab.ts` | Oklab と sRGB の変換、色域への収め方、WCAG のコントラスト比 | 通常は直さない |
| `src/styles/tokens.css` | 上の2つから作る CSS カスタムプロパティ | 直さない（`pnpm tokens`） |
| `src/app.css` | 全体の基本スタイル（`button`・`input`・`a`・`code`・`.badge` など）と操作状態、指の画面の規則、下の操作バー、シート。トークンを名前で使う | 直す |
| `src/lib/ui/viewport.ts` | 画面キーボードの高さを測り、`--keyboard-inset` と `data-keyboard` を `<html>` に書く | 通常は直さない |
| `src/lib/ui/media.svelte.ts` | 狭い画面（60rem 以下）・指の画面かどうかを、部品のスクリプトから読むための値 | 通常は直さない |

`tests/unit/design-tokens.test.ts` が、tokens.css と正本の一致、ブランド6色の再現、パレットの明度、面の段がテーマごとに互いに異なること、すべてのコントラストの基準、部品のスタイルに 16 進の色・パレット・旧い変数名がないこと、`index.html` と manifest に直接書いたブラウザの枠の色が正本と同じことを確かめる。`tests/e2e/iphone.spec.ts` が、iPhone 17 の大きさ（402×874・タッチ）で、押せる大きさ・入力欄の文字・横スクロールのないことを確かめる。

共有フォルダの `design-system/0.4.0/` にある ZIP（仕様・独立した生成器・見本の HTML）が設計の出典。値はアプリの正本と同じで、アプリでは `--kc-*` の代わりに次の名前を使う：意味の色は `--color-<名前>`、パレットは `--palette-<名前>`、それ以外は接頭辞なし（`--space-8` など）。今後の変更はアプリの正本で行う。

## 色

### ブランドとパレット

ブランド6色は確定値：Petrol Blue `#0573aa`、Iris `#7956ad`、Apricot `#eeae7b`、Sea Glass `#90cdb7`、Paper `#fbfaf7`、Ink `#232a2e`。OKLCH の入力値（L・C・h）から HEX が再現されることを試験で確かめる。

| 系列 | h | 目標の C | 用途 |
|---|---|---|---|
| `neutral` | 85° | 0.004 | 背景・面・文字・境界 |
| `petrol` | 240° | 0.12 | 主な操作・リンク・選択・フォーカス・情報 |
| `iris`・`apricot`・`sea-glass` | 300°・60°・170° | 0.135・0.10・0.07 | 補助の識別（状態の意味を持たない） |
| `success` | 150° | 0.13 | 成功・保存済み・追加 |
| `warning` | 75° | 0.14 | 注意：未保存・未コミット・保存状態が不明・一覧が一部だけ |
| `danger` | 25° | 0.18 | 失敗・危険：保存失敗・競合・削除・入力の誤り |

段は 50・100・200・300・400・500・600・700・800・900・950（L＝0.985・0.95・0.90・0.82・0.74・0.66・0.60・0.53・0.45・0.35・0.25）。段番号は順序で、明度そのものではない。neutral には面の段のための追加段 150（L 0.925）・850（0.40）・925（0.30）・975（0.19）がある。色域を超える段は明度と色相を保ったまま彩度だけを下げるため、明るい段・暗い段では目標の彩度より低い。

### 面の段

| トークン | ライト | ダーク |
|---|---|---|
| `--color-bg-page` 画面の背景 | neutral-100 | neutral-975 |
| `--color-bg-surface` 基本の面（パネル・ボタン） | brand-paper | neutral-950 |
| `--color-bg-raised` 浮いた面（入力欄・ダイアログ・メニュー・説明） | white | neutral-925 |
| `--color-bg-sunken` 沈んだ面（読み取り専用） | neutral-100 | neutral-975 |
| `--color-bg-hover` | neutral-150 | neutral-900 |
| `--color-bg-pressed` | neutral-200 | neutral-850 |

page・surface・raised・hover・pressed は、どちらのテーマでも互いに異なる（試験で確かめる）。どの面の上でも hover と押下が見える。

### 意味の色（主なもの）

全 64 色と役割は `palette.ts` の `SEMANTIC`。部品の CSS は意味の色だけを使い、パレット（`--palette-*`）を直接参照しない。ダークモードは `prefers-color-scheme` で意味の色の割り当てだけを切り替える。

| 用途 | トークン | 使い方 |
|---|---|---|
| 文字 | `fg-default`・`fg-muted`・`fg-placeholder` | 入力例はラベルの代わりにしない |
| 境界 | `border-subtle`（装飾）・`border-control`（入力欄・ボタン、3:1）・`border-strong`（ダイアログ・説明など浮いた面） | 部品を見分けるのに要る境界に `border-subtle` を使わない |
| 主な操作 | `accent`・`accent-hover`・`accent-pressed`・`on-accent` | `accent` は面の色。文字には使わない（ライトの画面背景の上で 4.49:1） |
| アクセントの文字・選択中の面 | `accent-text`・`accent-subtle` | 選択中のタブ・切り替え・上部バーの現在地 |
| リンク | `link`・`link-hover` | 常に下線（`app.css`） |
| フォーカス | `focus-ring` | 輪は部品の外側 2px |
| 選択中の行 | `selection-bg`・`selection-fg`＋`accent` の太い辺 | 記事一覧の現在の記事 |
| 原稿 | `editor-bg`・`editor-fg`（7:1 以上）・`editor-caret`・`editor-selection-*` | 本文の Markdown 欄と見たまま編集 |
| コード | `code-bg`・`code-fg` | アプリ内のコード・パス。プレビュー（iframe）は対象外 |
| 無効 | `disabled-bg`・`disabled-fg`・`disabled-border` | 親の opacity で薄くしない。押せない理由は通常の文字で示す |
| 状態 | `{info,success,warning,danger}-{bg,fg,mark,border}` | fg は文字、mark は記号（3:1）、border は枠 |
| 削除の確定 | `danger-solid`（`-hover`・`-pressed`）・`on-danger` | 確認ダイアログの中の削除だけ |
| 副色 | `decor-{iris,apricot,sea-glass}-{bg,fg,mark}` | 補助の識別。状態の意味を持たせない |
| 反転 | `bg-inverse`・`fg-inverse` | 短い説明の吹き出し |
| ブランド（ロゴ） | `brand` | ロゴの記号と CMS。ライトは Petrol Blue（`accent` と同じ）、ダークは `petrol-300`。部品の文字には使わない。ロゴの規則は [ブランドのロゴ](brand-logo.md) |

### 状態の色の使い分け

| 状態 | 色 | 例 |
|---|---|---|
| 情報 | `info-*` | 処理中、お知らせ（`.banner.info`）、復旧できる下書き |
| 成功 | `success-*` | 保存済み、コミットした、追加 |
| 注意 | `warning-*` | 未保存、保存状態が不明、未コミット（Git の帯・保留中）、一覧が一部だけ、読み取り専用の理由、プレビューの停止・古い版、入力の目安を超えた |
| 失敗・危険 | `danger-*` | 保存できない、検証エラー、競合、削除、エラーの帯 |

- 未保存（注意）と保存失敗（危険）を分ける（0.4.0 で変更。以前はどちらも `ng`）。
- 「公開対象」のバッジは中立にする。サイトへの公開の完了と区別するため。
- 状態は色だけで伝えない。バッジには必ず文字を入れ、お知らせには記号を付ける（仕様 14.1）。
- お知らせ・帯・バナーは、状態の面（`*-bg`）と枠（`*-border`）を使い、文字は `fg-default`（監査済み）。

### 影と暗幕

| トークン | ライト | ダーク |
|---|---|---|
| `--shadow-1`（トースト） | `0 4px 12px` Ink 12% | `0 4px 12px` 黒 40% |
| `--shadow-2`（メニュー・ポップオーバー・ダイアログ） | `0 4px 16px` Ink 16% | `0 4px 16px` 黒 50% |
| `--color-overlay`（ダイアログの暗幕） | Ink 40% | 黒 60% |

影は補助で、浮いた面は枠線でも示す（ダークでは影がほとんど見えない）。暗幕の上に文字を置かない。

### 利用者の設定

- `prefers-contrast: more`：装飾の区切りを `border-control` に、補足の文字を `fg-default` にする（`tokens.css`）。
- `prefers-reduced-motion: reduce`：`--duration-*` を 0ms にする。

### コントラスト

文字 4.5:1（1.4.3）、部品の境界・記号・フォーカスの輪 3:1（1.4.11・2.4.7）、原稿 7:1（プロジェクトの目標。AAA 全体の適合ではない）、無効の文字 3:1（プロジェクトの下限。WCAG の対象外）。検査対象は `CONTRAST_RULES` の 180 組（ライト・ダークで 360 組）で、8 ビットに丸めた後の 16 進で、比を丸める前に判定する。半透明の影と暗幕は対象外。指定外の組み合わせを使うときは、先に検査対象に足す。

## 文字

| トークン | 値 | 用途 |
|---|---|---|
| `--font-sans` | OS 標準の日本語フォント | 全体。外部フォントは使わない（仕様 2.1・16.3） |
| `--font-mono` | OS 標準の等幅 | コード・ID・パス |
| `--font-size-12` | 12px | バッジ、一覧のメタ情報、補足文 |
| `--font-size-13` | 13px | 記事情報の説明文 |
| `--font-size-14` | 14px | ラベル、詰めた操作、副見出し（太字）、状態の文 |
| `--font-size-15` | 15px | 本文欄（等幅）、一覧のタイトル |
| `--font-size-16` | 16px | 標準の入力値と操作 |
| `--font-size-18` | 18px | 作業中の見出し（上部バーのアプリ名・記事名）、ダイアログの見出し（以前の 17px はここにまとめた） |
| `--font-size-20` | 20px | 1 枚だけの画面（回復コード・確認ページ）の見出し |
| `--font-size-24` | 24px | 最初の画面（フォルダを開く前）のアプリ名 |
| `--line-height-body`・`-tight`・`-prose` | 1.6・1.5・1.75 | 基本・一覧のタイトル・本文の見たまま編集とプレビュー |
| `--font-weight-regular`・`-strong` | 400・600 | |

段の外の大きさは使わない。値は rem で書き出すので、文字の拡大に追従する。指で操作する画面では、入力欄・選択欄・本文欄・見たまま編集を 16px 以上にする（`app.css` の 1 か所で指定する。部品で小さい文字を指定していても 16px になる）。16px より小さいと、iOS の Safari がフォーカスのときに画面を拡大するため。

## 余白・間隔

`--space-2`・`4`・`6`・`8`・`10`・`12`・`16`・`20`・`24`・`32`（数字は px、値は rem）。4px の倍数を基本にし、詰めた部品の内側の余白にだけ 2・6・10 を使う。

- 部品の高さは「文字 × 行間 ＋ 上下の余白 ＋ 枠」で決まる。固定の高さは指定しない。
- 操作部品（ボタン・入力欄・選択欄）の余白と間隔は、次の意味のトークンで指定する。段（`--space-*`）を部品から直接選ばず、ここを変えれば全体の密度が変わる。

| トークン | 値 | 用途 |
|---|---|---|
| `--control-line-height` | 1.5 | ボタン・入力欄の行間（本文の 1.6 より詰める） |
| `--control-pad-y`・`--control-pad-x` | 4px・10px | 標準の部品（16px）。高さ 34px |
| `--control-pad-y-sm`・`--control-pad-x-sm` | 2px・8px | 詰めた部品（14px：上部バー・編集の操作列・Git の画面）。高さ 27px |
| `--control-gap` | 6px | 横に並べた操作の間隔 |
| `--panel-pad` | 12px 16px | カード・パネルの内側 |
| `--panel-pad-sm` | 8px 12px | 入れ子の枠・お知らせ・問題の一覧の内側 |
| `--touch-target` | 44px | 指の画面の、押せる部品すべての下限（Apple HIG・WCAG 2.5.5） |
| `--touch-target-inline` | 32px | 文や行の中の小さな部品の見た目の下限。押せる範囲は 44px に広げる（`.touch-inline`） |

- 指で操作する画面の規則は、下の「指の画面」にまとめた。0.4.0 の `--touch-target-md`（36px）・`--touch-target-sm`（32px）はなくした。
- マウスの画面での押せる大きさは 24px 以上（WCAG 2.2 の 2.5.8）。詰めた部品でも 27px あり、「?」の説明（24px）がいちばん小さい。
- 2026-11-08 に詰めた（標準 40px → 34px、詰め 32px → 27px、並べた操作の間隔 8px → 6px、外側のカードの余白 16px 20px → 12px 16px）。

## 指の画面（iPhone の Safari が主な対象）

[ADR-0015](../decisions/0015-iphone-17-safari-first-ui.md)。規則は `app.css` に置き、部品には書かない。

### 押せる大きさ

| 部品 | 指の画面（`pointer: coarse`） | 指定の場所 |
|---|---|---|
| ボタン・選択欄・入力欄・タブ・開閉の見出し・メニューの項目 | 高さ 44px 以上 | `app.css`（部品では指定しない） |
| アイコンだけのボタン | 44×44px 以上 | 部品で `min-width: var(--touch-target)` |
| 文や行の中の小さな部品（「?」・チップの「×」・トーストの「×」） | 見た目 32px、押せる範囲 44px | クラス `touch-inline` |
| チェックボックス・ラジオ | 22px。ラベルの行が 44px | `app.css` |
| 文の中のリンク | 文字の大きさのまま（WCAG 2.5.8 の例外） | — |

- 隣り合う `touch-inline` は、押せる範囲が重ならないよう 12px 以上あける。
- hover の見た目は `@media (hover: hover)` の中に書く。押している間の色（`:active`）は外に書く。
- 押下の灰色の反転（`-webkit-tap-highlight-color`）は消してある。押下の色は `bg-pressed` などで出す。

### 画面の端とキーボード

| トークン | 値 | 用途 |
|---|---|---|
| `--safe-top`・`--safe-right`・`--safe-bottom`・`--safe-left` | `env(safe-area-inset-*, 0px)` | 安全領域（ノッチ・Dynamic Island・ホームインジケーター）。`viewport-fit=cover` で画面の端まで使うので、端に付く部品はこれを余白に足す |
| `--page-gutter` | 16px | 画面の左右の余白。安全領域はこれに足す |
| `--keyboard-inset` | 0px（`viewport.ts` が書く） | 画面キーボードが下から覆っている高さ。出ている間は `html[data-keyboard="open"]` |
| `--bottom-bar-height` | 0px（`app.css` が書く） | 下の操作バーの高さ。バーのない画面では 0px |

- 画面の下に固定する部品は `bottom: var(--keyboard-inset)` で置く。キーボードが出ている間は `--safe-bottom` を足さない。
- 下に固定した部品の上に、スクロールする中身の余白を取る（`--bottom-bar-height` ＋ `--keyboard-inset`）。フォーカスした欄が隠れないよう、`scroll-padding-bottom` にも同じ値を足す。
- 高さに `100vh` を使わない。iOS の Safari ではアドレスバーの分だけ大きくなる。`100dvh` を使う。

### 下の操作バー（`[data-bottom-bar]`）

狭い画面（60rem 以下）で、その画面の主な操作を画面の下に固定する帯。属性を付けるだけで、位置・余白・安全領域・キーボードへの追従が付く。いまは編集画面の操作列だけが使う。

- 主な操作（`button.primary`）を 1 つ、幅を使って置く。そのほかはアイコン（44px）にし、名前は読み上げ用に残す（`.t` を見えなくする）。
- 4 つより多く置かない。頻度の低い操作は「…」に入れ、メニューは上へ開く。
- 1 つの画面に 1 つだけ。

### シート（30rem 以下のダイアログ）

`dialog:modal` は、30rem 以下では画面の下から出すシートになる（`app.css`）。幅は画面いっぱい、上の角だけ `--radius-lg`、高さは上部バーの分を残し、キーボードが出ている間はその上に載る。`.buttons` は縦に並び、幅いっぱいになる。部品の側では何も指定しない。

## 角丸・線・重なり順・動き

| トークン | 値 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | 小さな部品 |
| `--radius-md` | 6px | ボタン・入力欄・パネル |
| `--radius-lg` | 8px | ダイアログ・メニュー・トースト |
| `--radius-pill` | 999px | バッジ |
| `--border-width`・`--border-width-edge` | 1px・4px | 枠・区切り／現在地・お知らせ・差分の太い辺 |
| `--z-sticky`・`--z-raised`・`--z-popover`・`--z-toast`・`--z-tooltip` | 3・4・10・20・50 | 固定領域・その上の部品・メニュー・トースト・「?」の説明 |
| `--duration-fast`・`--duration-normal`・`--easing-standard` | 120ms・200ms | hover・押下の色の変化・開閉。動きを減らす設定では 0ms |
| `--breakpoint-sm`・`-md`・`-lg` | 30rem・60rem・75rem | 参照用（`@media` では変数を使えない）。各部品の `@media` と同じ値 |
| `--line-height-heading` | 1.35 | 見出し |
| `--target-min` | 24px | マウスで押せる最小の大きさ（指の画面は `--touch-target`） |

## 操作状態（`app.css`）

| 部品 | 通常 | hover | 押下 | 無効 |
|---|---|---|---|---|
| ボタン | `bg-surface`＋`border-control` | `bg-hover` | `bg-pressed` | `disabled-*` |
| `button.primary` | `accent`＋`on-accent`、太字 | `accent-hover` | `accent-pressed` | `disabled-*` |
| `button.danger`（削除の入口） | `danger-fg`＋`danger-border` | `bg-hover` | `bg-pressed` | `disabled-*` |
| 確認ダイアログの削除 | `danger-solid`＋`on-danger` | `danger-solid-hover` | `danger-solid-pressed` | — |
| 入力欄・選択欄 | `bg-raised`＋`border-control` | 変えない | — | `disabled-*` |
| 入力の誤り `[aria-invalid="true"]` | `danger-border`＋左の太い辺 | | | |
| 読み取り専用 `[readonly]` | `bg-sunken`＋点線の枠 | | | |
| 選択中のタブ・切り替え・上部バーの現在地 | `accent-subtle`＋`accent-text`＋`accent` の下辺、太字 | | | |
| 一覧の現在の記事 | `selection-bg`＋`selection-fg`＋`accent` の太い左辺 | | | |

## フォーカスの輪

`:focus-visible` に `outline: var(--focus-ring)`（2px・`--color-focus-ring`）と `outline-offset: var(--focus-ring-offset)`（2px）。輪は部品の外側に描くので、載りうる面（画面背景・面・浮いた面・hover・押下・選択中の行・お知らせ・原稿・コード）のすべてに対して 3:1 以上を保つ。スクロール・クリップする入れ物の中では `--focus-ring-offset-inset`（−2px）で内側に描く。部品ごとに輪を消したり色を変えたりしない。

## 新しい CSS を書くとき

1. 色は意味の色（`--color-*`）だけを使う。16 進・`rgb()`・`hsl()`・パレット（`--palette-*`）を直接書かない（試験が検出する）。影と暗幕も `--shadow-*`・`--color-overlay` を使う。
2. 状態の色は「情報・成功・注意・危険」の使い分け（上の表）に従う。未保存などの注意に `danger-*` を使わない。
3. hover・押下は `bg-hover`・`bg-pressed`、無効は `disabled-*` を使う。`opacity` で薄くしない（文字のコントラストが下がる）。
4. 寸法は `--space-*`・`--font-size-*`・`--radius-*`・`--border-width*` から選ぶ。段にない値が要るときは、2 か所以上で使うと決まってから正本に足す。
5. 新しい意味の色を足すときは、`palette.ts` の `SEMANTIC` と `CONTRAST_RULES` の両方に足し、`pnpm tokens` で書き直す。
6. 旧い名前（`--color-bg`・`--color-surface`・`--color-text`・`--color-muted`・`--color-border`・`--color-field-border`・`--color-focus`・`--color-ok`・`--color-ng`、さらに古い `--bg` など）は廃止した。使うと試験が落ちる。
7. 親の文字に比例させたい所（`code` の 0.9em など）は em のままでよい。
8. 指の画面のための高さ・文字の大きさを部品に書かない（`app.css` が付ける）。アイコンだけのボタンの幅と、`touch-inline` だけを部品で指定する。
9. hover は `@media (hover: hover)` の中に書く。
10. 画面の端（上・下・左右）に付く部品は、安全領域（`--safe-*`）を余白に足す。下に固定する部品は `--keyboard-inset` の上に置く。

## 対象外

- プレビュー（`src/lib/preview/frame.ts`）は記事の見た目を表す別の文書（iframe）で、コードハイライトの色を含め、このパレットの対象外。
