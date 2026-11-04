---
type: Architecture Decision
title: "ADR-0003 P1 MVP：プレビュー・画像・複製・削除・復旧ドラフトの実装方式"
description: "Markdown プレビュー、画像の取り込みと削除、記事の複製と削除（リポジトリ外への検証済み退避）、ブラウザ内復旧ドラフトの実装方式と、未検証の技術ゲート、仕様との緊張点。"
tags: ["プレビュー", "画像", "複製", "削除", "退避", "復旧ドラフト", "技術ゲート", "要検証"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-04T00:34:31Z }
sources:
  - id: spec-v3-1
    resource: ../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
  - id: file-probe
    resource: "ヘッドレス Chromium（Linux）で file:// から開いた検証用 HTML の観測（2026-11-04、1回測定）"
    title: "srcdoc の CSP 継承・sandbox iframe の blob: 読込・IndexedDB の可否"
    author: claude-code/2.1.317
    last_modified: 2026-11-04T00:34:31Z
  - id: md-bench
    resource: "Node.js 22 上での mdast-util-from-markdown 2.1.0 の計測（2026-11-04、1回測定）"
    title: "Markdown 解析時間の予備測定"
    author: claude-code/2.1.317
    last_modified: 2026-11-04T00:34:31Z
---
# 決定

[第27.1節](/spec/foundation/27-mvp-and-roadmap.md) の MVP のうち、[ADR-0002](0002-p1-editing-and-save.md) で未実装だった次を実装する。Git は今回も範囲外。

| 領域 | 方式 | 主な場所 |
|---|---|---|
| Markdown 解析 | micromark / mdast 系（`mdast-util-from-markdown` 2.1.0 と GFM の表・取り消し線・チェックリスト）。脚注・数式・自動リンクは有効にしない。描画と画像参照の抽出で同じ構文木を使う | `src/lib/core/markdown-parse.ts` |
| 解析の隔離 | 終了可能な Worker（`?worker&inline`、クラシック形式）で解析し、2 秒で Worker を終了する。Worker を起動できなければ主スレッドで代わりに解析せず、プレビュー停止・参照状況不明にする | `src/lib/parse/` |
| 描画 | 構文木から許可要素だけの HTML 文字列を組み立てる（全文字列をエスケープ）。生 HTML は文字で表示。リンクは番号付きの非遷移表示にし、行先は親側の一覧で確認して http・https・mailto だけを開く | `src/lib/core/markdown.ts` |
| プレビュー層 | `sandbox=""`（許可なし）の iframe の `srcdoc`。画像は親で検証したローカル画像の `data:` URL だけ | `src/components/Preview.svelte`、`src/lib/preview/frame.ts` |
| 画像の検査 | 先頭バイトで形式判定、拡張子・申告 MIME と照合、ヘッダーから画素数、GIF・APNG・アニメーション WebP のフレーム数と累積画素を全展開せずに数える。アニメーション AVIF は拒否。最後に `createImageBitmap` で実寸を照合 | `src/lib/core/image.ts`、`src/lib/fs/media.ts` |
| 画像の保存 | 10 文字の Nano ID＋小文字拡張子。media/ の全エントリーと照合し、作成直前にも存在を再確認。作成直後に空であることを確かめて書き、再読込で一致を確認 | `src/lib/fs/media.ts`、`src/lib/fs/tree.ts` |
| 参照の判定 | 保存済み本文と cover だけを対象にする。生 HTML・解析しない記法・曖昧なパスに `media` の文字列があれば記事全体を参照状況不明にする | `src/lib/core/markdown.ts`（`refsFromTree`） |
| 削除前退避 | ユーザーが選んだフォルダで、`isSameEntry` と `resolve` により同一・配下・祖先を拒否。操作ごとの新しいフォルダへバイト列のままコピーし、マニフェスト（相対パス・種類・サイズ・SHA-256・日時・版）を書き、読み直して集合と内容を検証 | `src/lib/fs/backup.ts` |
| 記事削除 | 最初の確認画面から結果判定まで対象記事の編集を止める。退避検証後と実行直前に元を再照合し、ファイル→深いフォルダ→浅いフォルダの順に 1 件ずつ削除して消失を確認。削除後の記事は読み取り専用で残し、原文のコピーだけを許す | `src/lib/app/workspace.svelte.ts`、`src/lib/fs/article-ops.ts` |
| 画像削除 | 確認・退避中の編集は許すが、確認時からリビジョンが変わったら中止。削除 API の直前に編集を止め、未保存なし・リビジョン一致・ディスクの保存済み本文での参照・画像の内容ハッシュを再照合してから削除し、消失を確認するまで編集を再開しない | 同上 |
| 複製 | 元の最新状態を基準版と比較し、全エントリーを列挙・ハッシュ。index.md 以外を先にコピー・検証し、元を再照合してから index.md を最後に確定 | `src/lib/fs/article-ops.ts`、`duplicateText` |
| 復旧ドラフト | IndexedDB。要求ごとの世代番号と記事ごとの制御記録（破棄済み世代・保存済みリビジョン）を、有効設定と同じトランザクションで照合して書く。書いた後に読み直してチェックサムが一致したリビジョンだけを「退避済み」と表示 | `src/lib/drafts/store.ts`、`src/lib/app/drafts.svelte.ts` |
| ワークスペース識別 | ランダム ID。フォルダのハンドルを保存し、次回は `isSameEntry` で照合する。フォルダ名では認定しない | 同上 |
| 依存 | `mdast-util-from-markdown` 2.1.0、`micromark` 4.0.3、GFM 拡張（表 2.1.2・2.0.0、取り消し線 2.1.0・2.0.1、チェックリスト 2.1.0・2.0.0）を固定版で追加。試験用に `fake-indexeddb` 6.2.6 | `package.json` |

# 理由

- **sandbox iframe は親の `blob:` 画像を読めない。** opaque origin の文書から `blob:null/…` は "Not allowed to load local resource" で拒否された。[^file-probe] `allow-same-origin` は [第16.1.1節](/spec/security/16-trust-boundary-preview-network.md) が禁じるため、検証済み画像を `data:` URL で渡す。
- **srcdoc は親の CSP を継承する。** 親の `style-src` にない `<style>` は srcdoc 側で許可しても止まった。[^file-probe] そのため、プレビュー用 CSS のハッシュを親の CSP にも加え、親の `img-src` に `data:` を加えた。
- **Markdown 解析は主スレッドに置けない。** 強調記号を 20,000 個並べた約 80 KB の本文で約 2.5 秒、リストやリンク 20,000 件でも 1〜1.5 秒かかった。[^md-bench] 5 MiB まで編集できる記事で主 UI が止まるため、Worker に移して時間で打ち切る。
- **Worker 内では DOM 依存の実装を選ばない。** `decode-named-character-reference` の browser 版は `document` を使い、Worker で異常終了した。ビルド時に同じパッケージの DOM を使わない実装へ差し替えた（`vite.config.ts`）。

# 未検証の技術ゲート

[ADR-0002](0002-p1-editing-and-save.md) の表を更新する。記載のないゲートは ADR-0002 のまま。

| ゲート | 状態 | 根拠と不足 |
|---|---|---|
| TG01 | 一部 | 退避先の選択・重なり判定・削除はページ内の疑似フォルダで確認。実フォルダ・権限ダイアログ・Windows と macOS は未実施 |
| TG05 | 未着手 | File System Access API はシンボリックリンク・ジャンクションを区別して返さない。複製・削除・退避の列挙で間接参照を検出・拒否できるかは未測定 |
| TG06 | 一部 | 退避の書き込み失敗、削除の途中失敗、複製中の元の変更をメモリ上の実装で注入。実ディスクは未実施 |
| TG08 | 一部 | ヘッドレス Chromium の file:// で、sandbox iframe でスクリプトが止まること、生 HTML が文字で表示されること、外部への要求が出ないことを E2E で確認。Chrome・Edge の実機、フォームや埋め込み要素を使う攻撃の網羅、コードハイライトは未実施 |
| TG09 | 一部 | Markdown の資源上限（ノード 200,000・入れ子 100・リンクと画像 10,000・要素 20,000・2 秒）、画像の固定上限、列挙の上限（10,000 件・深度 32・2 GiB・10 秒）を実装。プレビュー画像の `data:` 上限（1 枚 8 MiB・合計 48 MiB）、マニフェスト（8 MiB・パス 1,024 文字）、ドラフト付随メタデータ（256 文字）は暫定値で未承認 |
| TG10 | 一部 | 順序保証（破棄・保存成功・無効化の後に完了した古い要求を保存しない）を fake-indexeddb で確認し、ヘッドレス Chromium で同意・退避・再読み込み後の候補表示を確認。ブラウザ再起動・ストレージ消去・プライベートモード・別プロファイル・HTML の移動と改名（T13・T14）は未実施 |
| TG11 | 未着手 | 性能・メモリ（大量画像、2 時間運用）は未測定 |
| TG12 | 一部 | スキップリンク、キーボードでの記事選択と保存、危険操作を既定にしない確認ダイアログを E2E で確認。NVDA・VoiceOver・200% ズームは未実施 |

# 仕様との緊張点（要再合意）

1. **プレビュー層の CSP をアプリ用と分離できない。** [第16.1.1節](/spec/security/16-trust-boundary-preview-network.md) は「アプリ用・Worker 用・プレビュー用ポリシーを分離する」とするが、srcdoc は親の CSP を継承するため、親側にプレビュー用 CSS のハッシュと `img-src data:` を加えた。親 UI は記事由来の HTML を描画しない（Svelte のエスケープ、`{@html}` 禁止）ため、影響は限定的と判断した。
2. **Markdown の資源上限は構文木を構築した後に検査している。** [第34.2節](/spec/quality/34-resource-budgets.md) は構築中の適用を求めるが、採用パーサーは打切りフックを持たない。時間は Worker の終了で打ち切るが、メモリの増幅は Worker の中で上限なく起こりうる。
3. **画像の表示用資源は、メディア一覧の変化と「画像を読み直す」操作で作り直す。** [第17.3節](/spec/media/17-media-import.md) は「mtime・サイズだけで差替えなしと判断しない」とするが、プレビューの描画ごとに全画像を読み直すと重いため、一覧（名前とサイズ）が変わらない外部差し替えは再読込操作まで反映しない。
4. **全量をメモリに読んでハッシュしている。** [第34.4節](/spec/quality/34-resource-budgets.md) は 1 MiB 以下のチャンクを基本とするが、SubtleCrypto に逐次ハッシュがないため、複製・削除・退避では 1 ファイルずつ全体を読む。
5. **コードハイライトは未実装。** [第15章](/spec/editing/15-markdown-support.md) の対象言語のハイライトは行わず、すべてプレーンなコードで表示する。
6. **Git 状態は「未確認」と表示している。** [第19章](/spec/deletion/19-article-deletion-and-backup.md) は Git 管理済み・未追跡・無視対象の区別を求めるが、Git 機能が範囲外のため区別できない。
7. **削除前退避の重なり判定は `resolve` と `isSameEntry` だけに依存する。** [第19.1節](/spec/deletion/19-article-deletion-and-backup.md) の「間接参照で重なる場合」を区別できるかは TG05 と合わせて未確認。
8. **ドラフトのワークスペース識別にはフォルダのハンドルを保存する。** 保存できない環境（疑似フォルダを含む）では次回は「関連先未確認」になり、編集として開けない（原文の退避と削除だけができる）。
9. **復旧ドラフトの基準本文は保存しない。** [第33.2節](/spec/editing/33-recovery-drafts.md) の任意事項。ディスクが基準ハッシュと違う場合は、ディスク版とドラフトの 2 版比較と、置き換え前の確認で扱う。

ADR-0002 の緊張点（壊れた記事による slug の「重複検査不能」、YAML のキー重複検査の置き換え等）は変更していない。

# 結果

- `pnpm test` に、描画の安全性・参照抽出・画像の検査・退避・複製・削除・ドラフトの順序保証の単体試験を追加した。
- `pnpm test:e2e` に、file:// 起動の成果物でのプレビュー・画像の取り込みと削除・複製・削除・復旧ドラフト・キーボード操作の試験を追加した。
- 上記の未検証ゲートは、リリース判定（[第27.3節](/spec/foundation/27-mvp-and-roadmap.md)）の前に実機で確認する必要がある。

[^file-probe]: srcdoc の CSP 継承・sandbox iframe の blob: 読込・IndexedDB の可否
[^md-bench]: Markdown 解析時間の予備測定
