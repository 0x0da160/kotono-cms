---
type: Architecture Decision
title: "ADR-0001 技術スタックの選定"
description: "単一HTML・file://起動・外部CDN非依存の制約下で、Vite 8 + Svelte 5 + TypeScript と vite-plugin-singlefile を採用する決定と、仕様との要検証点。"
tags: ["技術スタック", "ビルド", "単一HTML", "要検証"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-03T17:12:26Z }
sources:
  - id: spec-v3-1
    resource: ../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
  - id: file-probe
    resource: "Playwright 1.63 同梱の Chromium（ヘッドレス、Linux）での file:// 起動の実測（2026-11-03）"
    title: "file:// 起動時の Worker・ストレージ挙動の予備測定"
    author: claude-code/2.1.317
    last_modified: 2026-11-03T17:12:26Z
---
# 決定

| 領域 | 採用 | 版（初期セットアップ時） |
|---|---|---|
| 言語 | TypeScript（strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`） | 6.0 |
| UI | Svelte 5（runes） | 5.57 |
| ビルド | Vite + `@sveltejs/vite-plugin-svelte` | 8.3 |
| 単一HTML化 | `vite-plugin-singlefile`（JS・CSSを `kotono-cms.html` へインライン化） | 2.3 |
| CSP | 自前のビルドプラグイン（インライン script・style の SHA-256 ハッシュで `<meta>` CSP を生成） | — |
| 単体テスト | Vitest | 5.1 |
| E2E | Playwright（`dist/kotono-cms.html` を `file://` で開いて検証） | 1.63 |
| 静的検査 | ESLint 10（typescript-eslint, eslint-plugin-svelte）、Prettier、svelte-check | — |
| パッケージ管理 | pnpm（`pnpm-lock.yaml` で依存を固定） | 10 |

# 理由

- **単一HTML・外部CDN非依存**（[第2章](/spec/foundation/02-environment-and-gates.md)）: Vite のビルド成果物を vite-plugin-singlefile で1ファイルへ畳み込める。フォントは同梱せずOS標準の日本語フォントを使い、外部取得を発生させない。
- **高速・小さいランタイム**: Svelte 5 はコンパイル時に最適化され、ランタイムが小さい。初期プレースホルダーのビルド成果物は約42 kB。大きな一覧の仮想化や入力応答の目標（[第34章](/spec/quality/34-resource-budgets.md)）に対し、仮想DOMの差分コストを持たない。
- **安全性**: `{@html}` を ESLint でエラーにし、`eval` 系を禁止する。CSP は `default-src 'none'`、`connect-src 'none'`、インラインコードはハッシュでのみ許可する（[第16章](/spec/security/16-trust-boundary-preview-network.md)）。
- **型安全**: frontmatter・日時・ID 等の厳密な検証（[第6章](/spec/data/06-frontmatter-schema.md)、[第8章](/spec/data/08-datetime-and-change-detection.md)）を型で支える。
- **依存固定と再現性**: lockfile で依存を固定し、配布物の真正性・依存一覧の要件（[第29章](/spec/foundation/29-technology-candidates-and-records.md) 29.4）に備える。
- TypeScript 7（ネイティブ版）は svelte-check・typescript-eslint の対応範囲外のため、安定した 6.0 系を採用した。

## 検討した代替案

- **React 19**: エコシステムは最大だが、ランタイムが大きく、単一HTMLの容量と初期応答で不利。
- **SolidJS**: 性能は同等以上だが、エディタ周辺・アクセシビリティ部品の層が薄い。
- **フレームワークなし（Web Components）**: 依存は最小だが、状態管理・一覧仮想化を自作する負担が大きい。

## 今回は導入しない候補

仕様 29.1 のとおり、Nano ID 以外のライブラリは技術ゲートで採用・版・設定を固定する。以下は候補として記録するにとどめ、依存には追加していない。

| 用途 | 候補 | 関連ゲート |
|---|---|---|
| 記事ID・メディアID | `nanoid`（`customAlphabet`） | 仕様で指定済み（[第5章](/spec/data/05-article-id.md)） |
| YAML保持 | `yaml`（eemeli/yaml の Document API） | TG07 |
| Markdown | micromark / mdast 系（参照抽出と描画で同じ構文解析系を共有） | TG08 |
| エディタ | CodeMirror 6 | TG12 |
| Git | isomorphic-git + 実フォルダ用 fs アダプター | TG02・TG03 |

# 仕様との要検証点（未解決）

実装を始める前に、技術成立性ゲートで確認・再合意が必要な点。いずれも予備測定であり、対応環境（Windows・macOS の Chrome・Edge 安定版）での実測ではない。[^file-probe]

1. **file:// ではモジュールWorkerが起動しない**: blob: URL からの `type: "module"` の Worker は起動に失敗し、クラシックWorkerは起動した。このため Worker は IIFE 形式（クラシック）で出力する設定にした。解析層の隔離（仕様 16.1.1）はクラシックWorkerで成立させる前提になる。
2. **Worker 用・プレビュー用 CSP の分離**: 仕様 16.1.1 は「アプリ用・Worker用・プレビュー用ポリシーを分離する」とするが、file:// では Worker は blob: URL から、プレビューは sandbox 付き srcdoc iframe から作る見込みで、どちらも親文書の CSP を継承する。分離は「親より厳しい方向にのみ追加できる」形になる。この解釈で要件を満たすかを TG08 で確認する。
3. **file:// のブラウザ内ストレージは全ローカルHTMLで共有される**: 別フォルダの別 HTML ファイル間で localStorage・IndexedDB の内容が共有された。復旧ドラフト（[第33章](/spec/editing/33-recovery-drafts.md)）は、同じブラウザプロファイルで開いた任意のローカルHTMLから読める可能性がある。33.1 のプライバシー説明、33.2 のワークスペース識別、T14（HTMLの移動・改名）の期待結果に影響する。TG10 で実機確認する。
4. **フォルダ選択APIは存在するが、実操作は未確認**: file:// で `showDirectoryPicker` と安全なコンテキストは確認できた。ピッカー操作・権限付与・失効（TG01）はヘッドレスでは確認できない。

# 結果

- `pnpm build` で `dist/kotono-cms.html` が1ファイルで生成される。
- E2E で、file:// 起動、自身以外の通信なし、CSP がインライン注入スクリプトを止めること、インラインWorkerの起動を確認する。

[^file-probe]: file:// 起動時の Worker・ストレージ挙動の予備測定
