---
type: Architecture Decision
title: "ADR-0005 見たまま編集・画像の最適化と派生画像・前回のフォルダの記憶"
description: "依頼により仕様 3.1 の対象外（リッチテキスト編集・原本の最適化・フォルダの永続化）を取り入れる決定。本文の見たまま編集を Markdown を正本としたまま実装する方式、取り込み時の画像の上限と派生画像、前回のフォルダの記憶。未検証の点と仕様との差。"
tags: ["エディタ", "WYSIWYG", "画像", "最適化", "派生画像", "フォルダ", "仕様からの変更", "要検証"]
status: draft
generated: { by: claude-code/2.1.318, at: 2026-11-05T16:40:00Z }
sources:
  - id: spec-v3-1
    resource: ../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
  - id: request-2026-11-05
    resource: "0x0da160 の依頼（2026-11-05）：前回のフォルダの記憶、記事内画像の埋め込みと取り込み時の最適化・表示用の派生画像、記事の見たまま編集"
    title: "見たまま編集と画像の最適化の依頼"
    author: human:0x0da160
    last_modified: 2026-11-05T16:04:45Z
  - id: browser-e2e
    resource: "ヘッドレス Chromium（Linux）で file:// から開いた成果物の E2E（tests/e2e/visual.spec.ts、2026-11-05）"
    title: "見たまま編集・画像の最適化・前回のフォルダの E2E"
    author: claude-code/2.1.318
    last_modified: 2026-11-05T16:40:00Z
---
# 決定

0x0da160 の依頼により、仕様 3.1 で対象外としていた次の3点を取り入れる。仕様書の原本（`docs/spec/`）とその転記（`spec/`）は改変せず、仕様との差をこの ADR に記録する。

| 領域 | 方式 | 主な場所 |
|---|---|---|
| 前回のフォルダ | フォルダを選んで開いたら、ディレクトリハンドルとフォルダ名を IndexedDB（`kotono-cms-settings`）に1件だけ保存する。起動時に読み込み、権限が `granted` のままなら自動で開く。そうでなければ開始画面に「前回のフォルダ「名前」を開く」を出し、押したときに権限を求めてから開く。「記憶を消す」で消せる。記事の内容は保存しない | `src/lib/app/recent-folder.ts`、`Workspace.loadRecent`・`reopenRecent`・`forgetRecent`、`src/App.svelte` |
| 画像の最適化 | 従来の検証（容量・形式・拡張子・ヘッダー画素・アニメーション・デコード）の後に、`createImageBitmap`（`imageOrientation: "from-image"` で向きを画素へ反映）と `OffscreenCanvas` で再エンコードする。縦横 4096px・1,600万画素に収まるよう縮小し、4 MiB を超えたら品質を 0.9→0.85→0.8→0.7→0.6 と下げ、なお超えれば 0.85 倍ずつ最大6回縮小する。再エンコードによりメタデータ（Exif・位置情報など）は残らない。結果は取り込み時と同じ規則で検査してから「原本」として `media/<ID>.<拡張子>` に保存する | `src/lib/fs/optimize.ts`、`Workspace.importImages` |
| 原本の形式 | JPEG・PNG・WebP はそのまま。ブラウザが書き出せない GIF（静止）は PNG、AVIF は WebP にする。アニメーション画像は再エンコードするとアニメーションを失うため加工せず、上限（4096px・1,600万画素・4 MiB）を超えるものは取り込まない | 同上 |
| 派生画像 | 原本と同じ画素から、幅 480・960・1920px（原本より狭いものだけ。原本が 480px 以下なら原寸1つ）を、WebP（品質 0.8）と JPEG（透過があれば PNG）で作り、`media/variants/<ID>-<幅>w.<拡張子>` に置く。派生画像の保存に失敗しても原本は残し、表示は原本に戻る | `src/lib/fs/optimize.ts`、`saveVariants` |
| 派生画像の表示 | プレビュー・見たまま編集・メディア一覧は、表示幅×devicePixelRatio 以上で最小の派生画像を AVIF・WebP・JPEG・PNG の順に選ぶ。表示前の検証（17.3）は派生画像にも行い、通らなければ原本を検証して表示する。本文の参照は従来どおり原本（`./media/<ID>.<拡張子>`）を指す | `loadDisplayImage`、`Preview.svelte`、`VisualEditor.svelte`、`MediaPanel.svelte` |
| 派生画像の管理 | メディア一覧には `variants/` を出さず、画像ごとの件数として示す。画像を削除するときは、その画像の派生画像も同じ退避（検証済み）に含め、一緒に削除する | `listMedia`、`Workspace.deleteMedia` |
| 見たまま編集 | 正本は Markdown の本文のまま。本文を Worker で解析した構文木から、`createElement` と文字ノードだけで編集可能な DOM（`contenteditable`）を作る。入力のたびに DOM を Markdown に戻して `session.setBody` に渡す。変更していないブロックは元の記述と前後の空行をそのまま使い、変更したブロックだけを書き直す（変更は MutationObserver で最上位のブロック単位に記録する） | `src/lib/visual/render.ts`・`serialize.ts`、`src/components/VisualEditor.svelte` |
| 見たまま編集の範囲 | 段落・見出し・強調・斜体・取り消し線・インラインコード・リンク・画像・改行・箇条書きと番号付きリスト（入れ子・チェック）・引用・コードブロック・区切り線を編集できる。表・生 HTML・参照形式のリンクや画像・参照定義・情報文字列つきのコードブロック・複雑なリスト項目は、元の記述を持つ編集不可の塊（灰色の枠）として表示し、そのまま保存する | 同上 |
| 見たまま編集の安全 | 記事由来の HTML は描画・実行しない（生 HTML は文字で表示）。リンクは `href` を持たせず、ブラウザの操作で付いた `href` も `data-href` へ移す。貼り付けは文字だけにし、ドロップは受け付けない。画像は検証済みの派生画像・原本から作った `blob:` だけを表示する | 同上 |
| 編集方法の切り替え | フォームの本文欄に「見たまま／Markdown」の切り替えを置き、既定は見たまま。選択はブラウザ内（localStorage）に記憶する。元に戻す・やり直すは従来どおり文書の共通履歴を使い、本文が外から変わったら（元に戻す・原文タブ・画像の挿入）見たまま表示を描き直す | `Editor.svelte` |
| 画像の挿入位置 | 見たまま編集では、キャレットのあるブロックの後ろに、空行で区切った独立の段落として挿入する | `EditorSession.insertIntoBody`（`bodyCaretBlock`） |

## 仕様との差

| 仕様 | 内容 | この決定 |
|---|---|---|
| [第14章](/spec/editing/14-editor-and-source-mode.md)・[第28章](/spec/foundation/28-out-of-scope.md) | リッチテキスト編集は提供しない | 依頼により、Markdown を正本としたまま見たまま編集を加える。Markdown 欄・原文タブ・プレビューは残す |
| [第17章](/spec/media/17-media-import.md)・[第28章](/spec/foundation/28-out-of-scope.md) | 原本のリサイズ・圧縮・変換・メタデータ除去をしない。元メタデータの保持を表示する | 依頼により、取り込み時に最適化したものを原本として保存する。アニメーション画像だけは従来どおり加工しない。メディア一覧の説明文を変更 |
| [第2章](/spec/foundation/02-environment-and-gates.md) | 次回起動でのフォルダ選択・権限の永続化を必須としない | 任意の追加機能として、ハンドルを記憶する。権限は開くときに改めて求める |
| [第33.2節](/spec/editing/33-recovery-drafts.md) | ハンドルを永続化する場合は事前に説明する | 開始画面に、記憶すること・保存する内容（フォルダ名とアクセス用の情報だけ）・許可を求めることがあることを示す |

## 未検証・残る課題

- 実機（Windows・macOS の Chrome・Edge）での動作は未検証。特に、ディレクトリハンドルの IndexedDB への保存と、次回起動時の権限の状態（`queryPermission` が `granted` のまま残るか）は、E2E の疑似フォルダでは確かめられない（疑似フォルダのハンドルは保存すると操作を失うため、開き直しの失敗表示までを試験している）。
- 日本語 IME での見たまま編集は、変換確定（`compositionend`）まで本文を書き直さない実装にしたが、実際の IME（Microsoft IME・ことえり等）では未検証。
- `contenteditable` と `document.execCommand`（非推奨だが Chrome・Edge で動作する）の挙動に依存する。ブラウザが作る DOM の形（`<p>` の中の `<ul>` など）は書き戻しで吸収しているが、すべての操作の組み合わせは試験していない。
- 見たまま編集で変更したブロックは、この CMS の書き方（ATX 見出し、`*` の斜体、`**` の太字、フェンスのコードブロックなど）で書き直す。元の記述の流儀（Setext 見出し、`_` の強調など）は、変更したブロックでは保たれない。
- JPEG・WebP は取り込み時に必ず再エンコードするため、既に最適化済みの画像でも画質が少し落ち、容量が増えることがある。
- 色空間（ICC プロファイル）はブラウザの描画結果で書き出すため、広色域の画像は sRGB 相当になることがある。
- 上限値（4096px・1,600万画素・4 MiB、派生画像の幅と品質）は暫定。`cms.config.json` からは変えられない。

<!-- okf:related -->

## 関連する章

* [第14章 エディタ・原文モード](/spec/editing/14-editor-and-source-mode.md) - frontmatterフォーム・原文モード・プレビューの構成、単一正本文書と共通Undo/Redo、日本語IME・アクセシビリティ。
* [第17章 メディア取り込み](/spec/media/17-media-import.md) - 画像取り込みの対象形式・命名・検証・成功確定、一括処理とキャンセル、既存画像の表示検証。
* [第28章 初期版の対象外](/spec/foundation/28-out-of-scope.md) - 初期版の対象外とする機能の一覧。
* [ADR-0003 P1 MVP：プレビュー・画像・複製・削除・復旧ドラフトの実装方式](0003-p1-preview-media-drafts.md) - 画像の検査・表示と、メディアの削除の方式。
