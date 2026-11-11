---
type: Design System
title: "Kotono CMS のロゴ（記号・ロゴタイプ・アプリアイコン）"
description: "ロゴの構成（記号・Kotono・CMS）、ブランドの色（Petrol Blue・Ink・Paper と、ダーク用の petrol-300）、寸法と字詰めの規則、アプリでの使い場所（上部バー・アイコン・PWA）と、ロゴの資産の場所。"
tags: ["ブランド", "ロゴ", "ロゴタイプ", "アプリアイコン", "デザインシステム", "SVG"]
status: stable
---
# Kotono CMS のロゴ

ロゴの資産は `brand/` にある（SVG・見本・生成スクリプト）。ブランドの色はアプリのトークン（`--color-brand`。`src/lib/design/palette.ts` の意味の色 `brand`）が正本で、ライトは 0.4.0 の Petrol Blue（`brand-petrol`）、ダークは `petrol-300` を指す。

## 構成

- **記号**：参考画像の輪郭から作った K の形。曲線は曲率が継ぎ目で連続するように並べる（Bézier 約 87 本、元画像との一致は IoU 0.997）。
- **ロゴタイプ**：記号・「Kotono」・「CMS」。文字は Inter（可変フォントの太さ 740、表示用の字形 opsz 32）をアウトライン化した図形で、フォントの導入は要らない。「Kotono」は文字の色、記号と「CMS」はブランドの色。
- **アプリアイコン**：Petrol Blue の角丸の正方形に記号を置く（`icon.svg`）。iOS 用の `apple-touch-icon.png` は角を丸めない正方形にする（iOS が角を付けるため）。

## 寸法と字詰め

- 記号の高さ 32（`space-32`）、記号と文字の間 10（`space-10`）。大文字の高さ 24、上端 4、ベースライン 28。記号は上下に 4 ずつはみ出す。
- 周囲の余白は記号の高さの半分（`space-16`）以上。
- 字詰めは光学的に調整する：「Kotono」は −12/2048em、o–t −54、t–o −56、o–n −26、n–o −34。「CMS」は C–M −14、M–S −6。「Kotono」と「CMS」の間は字面間 0.18em。
- 最小の大きさ：ロゴタイプは高さ 20px。記号だけは 16px まで。

## 色

| 用途 | 明るい背景 | ダーク背景 | トークン |
|---|---|---|---|
| 記号・CMS | #0573aa（Petrol Blue） | #85cdff（petrol-300） | `--color-brand` |
| Kotono | #232a2e（Ink） | 文字の色（Paper） | `currentColor` |

## アプリでの使い場所

- 上部バー：`src/components/Logotype.svelte`（`brand/kotono-logotype.svg` と同じ形）。見出し `h1` の中に置き、`aria-label="Kotono CMS"` で名前を与える。
- 上部バーには説明文を置かない（ADR-0013）。ロゴタイプの高さは、上部バーの文字の 1.25 倍に固定する。
- ファビコン・PWA：`public/icon.svg`、`public/icon-192.png`、`public/icon-512.png`、`public/apple-touch-icon.png`。ブラウザの枠の色（`theme-color` と `manifest.webmanifest`）は、上部バーの面の色（ライト #fbfaf7）に合わせる。値は `tests/unit/design-tokens.test.ts` が確かめる。

## 資産と再生成

- `brand/*.svg`：アイコン（通常・モノクロ・32px・16px）、記号単体、ロゴタイプ（カラー・ダーク・モノクロ・反転）。
- `brand/source/`：輪郭の抽出（`extract_contours.py`）→ 曲線のフィット（`g2.py`）→ 記号の JSON（`make_symbol.py`）→ SVG の生成（`final2.py`）→ svgo（`optall.mjs`）。手順は `brand/README.md`。
- 見本：`brand/preview.html`。
