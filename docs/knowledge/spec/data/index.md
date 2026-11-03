# データ形式と記事モデル

* [第3章 リポジトリと記事フォルダ](03-repository-layout.md) - 作業リポジトリと記事フォルダ（content/articles/<ID>/index.md と media/）の構成規則と初回フォルダ準備。
* [第4章 設定ファイルとバージョン](04-config.md) - cms.config.jsonの設定項目・既定値・許容範囲、不正設定時の停止範囲、固定安全上限との関係。
* [第5章 記事ID](05-article-id.md) - 記事IDの形式（Nano ID・小文字Base32・7〜32文字）、重複検査、新規エントリーの所有確認。
* [第6章 frontmatterの標準スキーマ](06-frontmatter-schema.md) - frontmatterの標準スキーマ（id・title・slug・status・日時・tags・cover）と未知フィールドの保持。
* [第7章 slugと公開状態](07-slug-and-status.md) - slugの形式と一意性検査、draft／publishedの状態遷移、公開対象の判定とUIの状態軸。
* [第8章 日時・更新判定・改行](08-datetime-and-change-detection.md) - 日時形式（オフセット必須のRFC 3339サブセット）、未保存・書き込み・updatedAt更新の判定、意味的同値の規則。
* [第9章 YAMLと原文の保持](09-yaml-preservation.md) - 文書形式と区切り、YAML 1.2 core schemaの対応範囲と上限、保存時の保持契約とコメント帰属。
* [第10章 新規作成・複製・記事ID修正](10-create-duplicate-id-repair.md) - 新規作成・複製の手順とindex.mdを最後に確定する完成マーカー、ID不一致修正と合流時の衝突の扱い。
