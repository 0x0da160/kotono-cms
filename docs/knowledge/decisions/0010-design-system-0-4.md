---
type: Architecture Decision
title: "ADR-0010 デザインシステム 0.4.0 の導入（ブランド色・面の段・状態色・操作状態）"
description: "敵対的レビューで完成させたデザインシステム 0.4.0 をアプリに導入する決定。正本は引き続き palette.ts・tokens.ts とし、ブランド6色と OKLCH の段、面の段、64 の意味の色、注意（warning）の追加、影と暗幕のテーマ別化、操作状態、検査対象 178 組を取り込む。旧い --color-* の 11 色からの対応表と、見た目の変化。"
tags: ["デザインシステム", "デザイントークン", "OKLCH", "カラーパレット", "WCAG", "CSS", "移行"]
status: stable
generated: { by: claude-code/2.1.318, at: 2026-11-09T13:30:00Z }
sources:
  - id: request-2026-11-09-design-system-0-4
    resource: "0x0da160 の依頼（2026-11-09）：添付のデザインシステム（0.3.0）を敵対的にレビューして完成させ、このプロジェクトに導入して適用する"
    title: "デザインシステム 0.4.0 の導入の依頼"
    author: human:0x0da160
    last_modified: 2026-11-09T13:02:37Z
  - id: design-system-0-4-zip
    resource: "Kotono-Design-System-0.4.0.zip（プロジェクトの共有フォルダ design-system/0.4.0/）"
    title: "Kotono CMS Design System 0.4.0（設計仕様・生成器・見本）"
    author: claude-code/2.1.318
    last_modified: 2026-11-09T12:37:00Z
---
# 決定

1. **デザインシステム 0.4.0 をアプリの色の正本にする。** 正本の場所と生成の方式は [ADR-0007](0007-design-system-oklab.md) のまま（`palette.ts`・`tokens.ts` → `pnpm tokens` → `tokens.css`）。値と規則は 0.4.0 の設計仕様と同じにし、以後の変更はアプリの正本で行う。ZIP の生成器（`build.mjs`）は設計の出典として共有フォルダに残し、二重管理しない。
2. **パレットを 0.4.0 に置き換える。** ブランド6色（Petrol Blue・Iris・Apricot・Sea Glass・Paper・Ink）と、8 系列 × 11 段（50〜950）＋ neutral の追加段 4 つ。ADR-0007 の「段の名前は明度（`neutral-48`）」は廃止し、段番号（`neutral-100`）にする。パレットは `--palette-*` に書き出し、部品からは参照しない。
3. **意味の色を 11 色から 64 色にする。** 名前は `--color-<0.4.0 の名前>`（`--color-bg-page`・`--color-fg-muted` など）。面の段（page・surface・raised・sunken・hover・pressed）、主な操作の状態、リンク、選択、原稿、コード、無効、4 つの状態（情報・成功・注意・危険）の面・文字・記号・枠、削除の確定、副色、反転を持つ。
4. **注意（warning）を足し、未保存と失敗を分ける。** ADR-0007 で保留していた `warning` を導入する。未保存・保存状態が不明・未コミット・一覧が一部だけ・読み取り専用の理由・プレビューの停止は注意、保存失敗・検証エラー・競合・削除は危険。「公開対象」は中立のバッジにする。
5. **影と暗幕をテーマ別にする。** ライトは Ink を、ダークは黒を濃くして使う。
6. **操作状態を基本スタイルに入れる。** ボタンの hover・押下、主な操作の hover・押下、無効（opacity をやめて無効の色）、入力の誤り・読み取り専用、選択中のタブと切り替え、一覧の現在の記事、リンクの下線と hover、原稿の面とカーソル・選択範囲、確認ダイアログの中の削除の確定。
7. **検査対象を 178 組（2 テーマで 356 組）にする。** 0.4.0 の 170 組に、お知らせの面の上の本文と補足を足した。

# 理由

- 旧い 11 色では、未保存（注意）と保存失敗（危険）が同じ赤で、hover・押下・無効・選択の色がなかった（部品ごとに `bg` や `border` の色で代用し、無効は opacity で文字のコントラストまで下げていた）。
- 0.4.0 の敵対的レビューで、0.3.0 の hover が画面背景・浮いた面と同じ値で見えないこと、ダークの選択行の上の補足が 4.5:1 未満であることなどを直した。導入はその修正済みの値で行う。
- 寸法のトークンは 0.4.0 がアプリの値に合わせて作ったため、変えない（追加だけ）。

# 旧い名前からの対応

| 旧い | 新しい |
|---|---|
| `--color-bg` | `--color-bg-page` |
| `--color-surface` | `--color-bg-surface`（入力欄・ダイアログ・説明は `--color-bg-raised`） |
| `--color-text` | `--color-fg-default` |
| `--color-muted` | `--color-fg-muted` |
| `--color-border` | `--color-border-subtle`（ボタンの枠は `--color-border-control`） |
| `--color-field-border` | `--color-border-control` |
| `--color-accent` | `--color-accent`（面だけ。文字は `--color-link`・`--color-accent-text`） |
| `--color-on-accent` | `--color-on-accent` |
| `--color-focus` | `--color-focus-ring` |
| `--color-ok` | `--color-success-fg`・`--color-success-border` |
| `--color-ng` | 失敗・危険は `--color-danger-*`、注意は `--color-warning-*`（用途ごとに選んだ） |

# 見た目の変化

- 色相：主な操作は青（h 261°）から Petrol Blue（h 240°）に、無彩色はわずかに暖かい紙の色（h 85°）に、ライトの面は白から Paper に変わる。入力欄・ダイアログは白（ダークは一段明るい面）。
- お知らせ・帯・バナー・バッジは、枠だけから状態の面の色つきになる。
- ボタンの枠は装飾の区切りから部品の枠（3:1 以上）になり、hover と押下で面の色が変わる。
- 無効は薄くするのをやめ、無効の色にする。
- 選択中のタブ・切り替え・上部バーの現在地は、薄い Petrol の面と Petrol の文字になる。

# 未決・残る課題

- 実機（iOS Safari）、Windows の強制カラー、読み上げでの確認は未了。
- プレビュー（iframe）の色とコードハイライトの色は、引き続き対象外。
- 0.4.0 の見本にある部品（メニュー・トースト・タブの矢印キー操作など）のうち、アプリにない部品は作っていない。
