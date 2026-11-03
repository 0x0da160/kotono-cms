# 仕様書

* [仕様書の概要と読み方](overview.md) - ローカルCMS仕様書 改訂版3.1の版情報・状態・改訂根拠と、章構成の読み方。

# 分野別

* [基本方針・範囲・技術記録](foundation/index.md) - 製品の目的・対応環境と技術ゲート・MVP範囲・対象外・技術候補・改訂履歴。
* [データ形式と記事モデル](data/index.md) - 記事フォルダ・設定・記事ID・frontmatter・slug・日時・YAML保持・新規作成と複製。
* [編集・保存・復旧](editing/index.md) - 操作状態・同時編集と外部変更・保存契約・エディタ・Markdown・復旧ドラフト。
* [信頼境界と通信](security/index.md) - 未信頼入力・権限分離・プレビュー隔離・パス境界・外部通信の禁止。
* [メディア](media/index.md) - 画像の取り込み・表示検証・参照解析・削除。
* [記事削除と退避](deletion/index.md) - 記事削除の手順と削除前退避・手動復元案内。
* [ローカルGit](git/index.md) - Git機能範囲・コミット契約・状態と履歴表示・fsアダプター契約。
* [一覧と検証](browse/index.md) - 記事一覧・検索・再読み込みと既存記事の検証。
* [性能・予算・受け入れ試験](quality/index.md) - 性能目標・資源予算・受け入れ試験・追加試験とリリース成果物。
* [保証境界と確定点](assurance/index.md) - 操作別の保証・非保証と、確定点・中断・再試行の表。

# 章番号順

* [第1章 目的と基本方針](foundation/01-purpose.md) - 単一HTMLのfile://起動、Markdown＋YAML frontmatter保存、ヘッドレスCMSとしての基本方針と、操作の意味・不変条件・要件優先度。
* [第2章 対応環境と技術成立性ゲート](foundation/02-environment-and-gates.md) - 対応環境（デスクトップ版Chrome・Edge、Windows・macOS、file://起動、外部CDN非依存）と技術成立性ゲートTG01〜TG12。
* [第3章 リポジトリと記事フォルダ](data/03-repository-layout.md) - 作業リポジトリと記事フォルダ（content/articles/<ID>/index.md と media/）の構成規則と初回フォルダ準備。
* [第4章 設定ファイルとバージョン](data/04-config.md) - cms.config.jsonの設定項目・既定値・許容範囲、不正設定時の停止範囲、固定安全上限との関係。
* [第5章 記事ID](data/05-article-id.md) - 記事IDの形式（Nano ID・小文字Base32・7〜32文字）、重複検査、新規エントリーの所有確認。
* [第6章 frontmatterの標準スキーマ](data/06-frontmatter-schema.md) - frontmatterの標準スキーマ（id・title・slug・status・日時・tags・cover）と未知フィールドの保持。
* [第7章 slugと公開状態](data/07-slug-and-status.md) - slugの形式と一意性検査、draft／publishedの状態遷移、公開対象の判定とUIの状態軸。
* [第8章 日時・更新判定・改行](data/08-datetime-and-change-detection.md) - 日時形式（オフセット必須のRFC 3339サブセット）、未保存・書き込み・updatedAt更新の判定、意味的同値の規則。
* [第9章 YAMLと原文の保持](data/09-yaml-preservation.md) - 文書形式と区切り、YAML 1.2 core schemaの対応範囲と上限、保存時の保持契約とコメント帰属。
* [第10章 新規作成・複製・記事ID修正](data/10-create-duplicate-id-repair.md) - 新規作成・複製の手順とindex.mdを最後に確定する完成マーカー、ID不一致修正と合流時の衝突の扱い。
* [第11章 操作状態と遷移](editing/11-operation-states.md) - 操作状態と遷移、ディスク変更操作の直列化と編集リビジョン、削除中の対象編集制御と確定点。
* [第12章 同時編集・外部変更・排他の保証](editing/12-concurrency-and-external-changes.md) - 単一CMS運用と別タブ検出、保存前のバイト比較による外部変更検出、3版比較による支援。
* [第13章 保存契約と失敗時の安全性](editing/13-save-contract.md) - 手動保存と単一ファイル保存の成功条件、後続編集との整合、最終保存候補の再読込可能性、失敗・再試行・複数ファイル操作。
* [第14章 エディタ・原文モード](editing/14-editor-and-source-mode.md) - frontmatterフォーム・原文モード・プレビューの構成、単一正本文書と共通Undo/Redo、日本語IME・アクセシビリティ。
* [第15章 Markdown対応範囲](editing/15-markdown-support.md) - GFM相当のMarkdown対応範囲、生HTMLの扱い、コードハイライト対象言語。
* [第16章 信頼境界・プレビュー・通信](security/16-trust-boundary-preview-network.md) - 未信頼入力の扱い、権限保持層・解析層・プレビュー層の分離、ローカルパス検証、外部URLと自動通信の禁止。
* [第17章 メディア取り込み](media/17-media-import.md) - 画像取り込みの対象形式・命名・検証・成功確定、一括処理とキャンセル、既存画像の表示検証。
* [第18章 画像参照・削除](media/18-image-references-and-deletion.md) - 画像参照の解析と保護範囲、参照状況不明の扱い、画像削除の条件。
* [第19章 記事削除・復元](deletion/19-article-deletion-and-backup.md) - 記事削除の確認・照合・部分失敗の扱い、リポジトリ外への検証済み削除前退避と手動復元の案内。
* [第20章 ローカルGit機能と互換性](git/20-local-git-compatibility.md) - ローカルGitの機能範囲、書き込みを許可する構成条件、Git由来パス・特殊index・設定の扱い、非対応時の停止。
* [第21章 コミット契約](git/21-commit-contract.md) - 記事単位コミットの対象と事前条件、作成者とコミッター、確認・実行、失敗後の照合と再試行。
* [第22章 Git状態・履歴表示](git/22-git-status-and-history.md) - ブランチ・変更一覧・履歴の表示と、予算付き履歴走査・継続カーソル。
* [第23章 一覧・検索・再読み込み](browse/23-list-search-reload.md) - 記事一覧の表示・ソート・キーワード検索・絞り込み、入力支援、範囲別の再読み込み。
* [第24章 既存記事の検証](browse/24-existing-article-validation.md) - 既存記事の状態別の検証と処理、エラー表示、CMS内／外での修復保存の方針。
* [第25章 規模・性能・応答性](quality/25-scale-and-performance.md) - 初期検証データセット（B／L／F／H／M／E／R）、読み込みとUIの方針、性能合格値の確定手順。
* [第26章 受け入れ試験](quality/26-acceptance-tests.md) - 起動・データ保持・外部変更と失敗注入・Git相互運用・悪意ある入力・一覧性能の受け入れ試験（A／D／F／G／S／P）。
* [第27章 MVP完成条件・開発順序](foundation/27-mvp-and-roadmap.md) - MVPに含める機能、開発順序、リリース判定の必須条件。
* [第28章 初期版の対象外](foundation/28-out-of-scope.md) - 初期版の対象外とする機能の一覧。
* [第29章 技術候補とリリース前の確定記録](foundation/29-technology-candidates-and-records.md) - 技術候補（File System Access API・isomorphic-git等）、リリース前に埋める技術記録、アプリ更新と配布物の真正性・依存管理。
* [第30章 改訂履歴と判断の追跡](foundation/30-revision-history.md) - 仕様3.1・3.0・2.0の改訂履歴と判断の追跡。
* [第31章 実フォルダ用fsアダプターの契約（P0）](git/31-fs-adapter-contract.md) - 実フォルダ用fsアダプターの意味論記録（メソッド別の必要記録と禁止事項）と、Git書き込みの観測・中断安全性。
* [第32章 境界・間接参照・未信頼入力の追加契約](security/32-boundaries-and-untrusted-input.md) - 実ファイルと文字列パスの境界、間接参照の観測、権限境界図とデータ経路、通信試験と診断ログ。
* [第33章 ブラウザ内復旧ドラフト（P1）](editing/33-recovery-drafts.md) - ブラウザ内復旧ドラフトの同意・保存内容・更新と容量・非同期退避の順序保証・復旧手順。
* [第34章 性能・資源予算表（P1）](quality/34-resource-budgets.md) - UI応答の初期受け入れ値と、入力・解析・描画・画像・再帰・Git・メモリの固定資源予算、未信頼入力の入口別予算。
* [第35章 操作別の保証境界表（P0／P1）](assurance/35-guarantee-boundaries.md) - 操作別の観測・判定根拠、保証、非保証、回復先を示す保証境界表。
* [第36章 操作確定点・中断・再試行表（P1）](assurance/36-commit-points-and-retry.md) - 操作別の完了条件・確定点、取消可能な境界、中断後・再試行条件と日時の扱い。
* [第37章 追加受け入れ試験・レビュー追跡（P0／P1）](quality/37-additional-tests-and-review-tracking.md) - 故障・攻撃シナリオ試験T01〜T28、追加レビューへの対応表、リリース判定用成果物。
