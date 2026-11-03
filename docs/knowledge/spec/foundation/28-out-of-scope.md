---
type: Specification Section
title: "第28章 初期版の対象外"
description: "初期版の対象外とする機能の一覧。"
tags: ["仕様3.1", "対象外", "スコープ"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-03T17:10:46Z }
sources:
  - id: spec-v3-1
    resource: ../../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
spec_version: "3.1"
spec_chapter: 28
---
## 28. 初期版の対象外

- 記事配信用API、サイトレンダリング、完全な公開サイトプレビュー。
- GitHub等との同期、CORSプロキシ、API同期。
- Gitのブランチ操作・マージ・競合解決・復元・変更破棄・amend。
- 複数記事一括コミット、ファイル単位のコミット選択。
- リッチテキスト、本文全文検索、共同編集、複数タブの正式な並行編集。
- 動画・音声・PDF・SVGの取り込みUI。
- 保存原本の自動変換・最適化・メタデータ除去・自動削除。原本を変えない安全な表示用縮小処理は対象に含む。
- CMS独自のリポジトリ内ゴミ箱と自動復元。ブラウザ内復旧ドラフトと、削除前の外部退避は対象に含む。
- 脚注・数式・MDX等のプレビュー、任意HTML実行。
- 外部画像の取得、自動テレメトリー、自動更新確認。
- 外部ファイル自動監視、自動マージ、強制上書き。
- worktree等の特殊Git構成への書き込み、OSグローバルGit設定参照、Gitフックやフィルターの実行。
- 汎用設定エディタ、未知フィールドの専用フォーム。

