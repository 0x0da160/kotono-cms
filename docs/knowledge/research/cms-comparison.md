---
type: Research Report
title: "他の CMS との比較：Web メディア・ブログ向けに取り入れる機能とデータ構造"
description: "WordPress・Ghost・Hugo・Decap CMS・Kirby・Sanity・Astro のコンテンツコレクションの機能とデータ構造を、Kotono CMS の現状（記事フォルダ・Markdown＋YAML frontmatter・暗号化した作業場所・記事単位の簡易マージ）と比べた調査。取り入れる候補ごとに理由・Kotono CMS でのコスト・優先度を示し、設計に合わないものを区別する。実装は含まない。"
tags: ["調査", "CMS比較", "データ構造", "frontmatter", "WordPress", "Ghost", "Hugo", "Decap CMS", "Kirby", "Sanity", "Astro", "未決定"]
status: draft
generated: { by: claude-code/2.1.318, at: 2026-11-08T05:30:00Z }
sources:
  - id: request-2026-11-08-cms-survey
    resource: "0x0da160 の依頼（2026-11-08）：Webメディア・ニュース・記事サイト・ブログ用のCMSとしての機能やデータ構造など、他のCMSと比較して取り入れるべきものが無いか調査して"
    title: "他の CMS との比較調査の依頼"
    author: human:0x0da160
    last_modified: 2026-11-08T05:04:03Z
  - id: spec-v3-2
    resource: ../../spec/local-cms-specification-v3.2.md
    title: "ローカルCMS 仕様書 改訂版 3.2"
    author: human:0x0da160
    last_modified: 2026-11-06T00:00:00+09:00
  - id: wp-post-status
    resource: "https://wordpress.org/documentation/article/post-status/"
    title: "WordPress Documentation：Post Status"
    author: team:wordpress
    last_modified: 2026-11-08T00:00:00Z
  - id: wp-taxonomies
    resource: "https://developer.wordpress.org/themes/basics/categories-tags-custom-taxonomies/"
    title: "WordPress Theme Handbook：Categories, Tags, & Custom Taxonomies"
    author: team:wordpress
    last_modified: 2026-11-08T00:00:00Z
  - id: ghost-posts
    resource: "https://docs.ghost.org/content-api/posts"
    title: "Ghost Content API：Posts"
    author: team:ghost
    last_modified: 2026-11-08T00:00:00Z
  - id: hugo-front-matter
    resource: "https://gohugo.io/content-management/front-matter/"
    title: "Hugo Docs：Front matter"
    author: team:hugo
    last_modified: 2026-11-08T00:00:00Z
  - id: hugo-bundles
    resource: "https://gohugo.io/content-management/page-bundles/"
    title: "Hugo Docs：Page bundles"
    author: team:hugo
    last_modified: 2026-11-08T00:00:00Z
  - id: hugo-archetypes
    resource: "https://gohugo.io/content-management/archetypes/"
    title: "Hugo Docs：Archetypes"
    author: team:hugo
    last_modified: 2026-11-08T00:00:00Z
  - id: decap-config
    resource: "https://decapcms.org/docs/configuration-options/"
    title: "Decap CMS Docs：Configuration Options"
    author: team:decap
    last_modified: 2026-11-08T00:00:00Z
  - id: decap-i18n
    resource: "https://decapcms.org/docs/i18n/"
    title: "Decap CMS Docs：i18n Support"
    author: team:decap
    last_modified: 2026-11-08T00:00:00Z
  - id: kirby-files
    resource: "https://getkirby.com/docs/guide/content/files"
    title: "Kirby Guide：Files"
    author: team:kirby
    last_modified: 2026-11-08T00:00:00Z
  - id: kirby-file-meta
    resource: "https://getkirby.com/docs/guide/files/meta-data"
    title: "Kirby Guide：File meta data"
    author: team:kirby
    last_modified: 2026-11-08T00:00:00Z
  - id: sanity-reference
    resource: "https://www.sanity.io/docs/reference-type"
    title: "Sanity Docs：Reference type"
    author: team:sanity
    last_modified: 2026-11-08T00:00:00Z
  - id: sanity-scheduling
    resource: "https://www.sanity.io/docs/scheduled-publishing"
    title: "Sanity Docs：Scheduled publishing"
    author: team:sanity
    last_modified: 2026-11-08T00:00:00Z
  - id: astro-collections
    resource: "https://docs.astro.build/en/guides/content-collections/"
    title: "Astro Docs：Content collections"
    author: team:astro
    last_modified: 2026-11-08T00:00:00Z
  - id: google-article
    resource: "https://developers.google.com/search/docs/appearance/structured-data/article"
    title: "Google Search Central：Article structured data"
    author: team:google
    last_modified: 2026-11-08T00:00:00Z
  - id: google-dates
    resource: "https://developers.google.com/search/docs/appearance/publication-dates"
    title: "Google Search Central：Influencing your byline dates"
    author: team:google
    last_modified: 2026-11-08T00:00:00Z
---
# 状態

調査結果と提案。**P1 の 5 件（C1〜C5。C4 はカバー画像の分だけ）は実装済み**（[ADR-0009](../decisions/0009-optional-article-fields.md)）。それ以外は未決定。採用する項目は、仕様（第6章の標準スキーマ、第28章の対象外）の改訂と ADR で決める[^request-2026-11-08-cms-survey]。他の CMS についての記述は、2026-11-08 に各公式ドキュメントで確認した内容に基づく（出典は脚注）。

# 結論：先に取り入れる 5 件

| 順 | 項目 | 一言で | コスト | 優先度 |
| --- | --- | --- | --- | --- |
| 1 | [説明文（`description`）](#c1-説明文description) | 一覧・検索結果・SNS に出す要約。主要 CMS のほぼすべてが持つ | 小 | P1 |
| 2 | [旧 slug の記録（`aliases`）](#c2-旧-slug-の記録aliases) | 公開後に slug を変えたとき、旧 URL を記事に残してフロントがリダイレクトを作れるようにする | 小 | P1 |
| 3 | [読者向けの更新日と訂正の記録（`revisedAt`・`corrections`）](#c3-読者向けの更新日と訂正の記録) | 保存のたびに変わる `updatedAt` と、「記事を更新しました」と読者に示す日を分ける | 小〜中 | P1 |
| 4 | [カバー画像のキャプションとクレジット（`cover.caption`・`cover.credit`）](#c4-画像のキャプションとクレジット) | 報道写真の出典表示。cover はすでに未知フィールドを保持するので足しやすい | 小 | P1 |
| 5 | [著者（`authors`）と著者プロフィール](#c5-著者authorsと著者プロフィール) | 署名（バイライン）と著者ページ。記事 ID と同じ形で ID 参照する | 中 | P1 |

5 件とも、記事ごとの frontmatter に収まる追加で、Markdown＋YAML の正本・暗号化・記事単位の簡易マージという今の設計を変えない。次点はコンテンツモデル（カスタムフィールドの定義）と、フロント向けのスキーマの書き出し（[P2 の候補](#p2次の段階で検討)）。

# 前提：Kotono CMS の現状

比べる側の現状を、仕様 3.2 と実装から要約する[^spec-v3-2]。

- **保存形式**：`content/articles/<記事ID>/index.md`（Markdown＋YAML frontmatter）。画像は同じフォルダの `media/`（派生画像は `media/variants/`）。Hugo の「リーフバンドル」（`index.md` と同じフォルダの資源）とほぼ同じ形で、静的サイト生成器と相性がよい[^hugo-bundles]。
- **標準スキーマ**：`id`・`title`・`slug`・`status`（`draft`／`published`）・`createdAt`・`updatedAt`・`publishedAt`・`tags`・`cover`（`src`・`alt`）。未知のフィールドは保持するが、専用のフォームは出さない（第28章の対象外）。
- **分類**：タグ（文字列配列）だけ。カテゴリ・著者・記事どうしの参照はない。
- **設定**：`cms.config.json` は ID 長とメディアの上限だけ。コンテンツモデル（フィールド定義）はない。
- **公開**：`status == published` かつ `publishedAt <= 現在` をフロントが判定する。CMS はビルド・配信・予約実行をしない（第7.2節）。
- **保存先と同期**：デスクトップは選んだフォルダ、iOS・iPadOS は暗号化したブラウザ内の作業場所（ファイル内容と名前をファイルごとに AES-GCM で暗号化、第39章）。GitHub とは REST API で push・pull し、分岐時は本文の行単位と **frontmatter のキー単位** で自動マージする。画像・設定・その他のファイルは自動マージしない（第40.5節）。
- **安全**：記事由来の HTML・スクリプトを実行せず、自動のネットワーク通信をしない（第16章）。

この前提から、取り入れる案は次の基準で評価した。

1. **記事ごとのデータに置く**。frontmatter のキー単位の自動マージが効き、暗号化もファイル単位で自動的にかかる。全記事で共有する中央のファイル（設定・登録簿）は自動マージされず競合しやすいので、変更頻度の低いものだけにする。
2. **任意の項目として足す**。既存の記事を書き換えずに読めること。項目がない記事は今と同じに扱う。
3. **意味はフロントが解釈する**。CMS は値の形と参照先の存在を検証し、配信の結果を推定表示しない（第7.3節の方針を保つ）。
4. **ネットワークもサーバーも要らない**。

# 比較表

○ は標準機能、△ は設定・拡張で可能、— はなし。各 CMS の欄は脚注の出典で確認した範囲。

| 機能・データ | WordPress | Ghost | Hugo | Decap CMS | Kirby | Sanity | Astro | Kotono CMS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 要約・説明文 | ○ 抜粋 | ○ `custom_excerpt`・`meta_description` | ○ `summary`・`description` | △ フィールド定義 | △ | △ | △ スキーマ | — |
| 旧 URL のリダイレクト | △ | △ | ○ `aliases` | — | △ | — | △ | — |
| 予約・期限 | ○ `future` | ○ | ○ `publishDate`・`expiryDate` | — | — | ○ サーバー側 | — | `publishedAt` のみ（フロント判定） |
| 状態の段階 | ○ draft・pending・private・publish ほか | ○ | `draft` | ○ 編集ワークフロー | ○ draft・unlisted・listed | ○ | — | draft・published |
| 分類 | ○ 階層カテゴリ＋タグ＋独自分類 | ○ タグ（主タグ・内部タグ） | ○ 設定で任意の分類 | △ | △ | △ | △ | タグのみ |
| 著者 | ○ | ○ 複数著者・`primary_author` | △ | △ relation | △ | ○ 参照 | ○ `reference()` | — |
| 画像のキャプション・クレジット | ○ | ○ `feature_image_caption` | △ | △ | ○ 画像ごとの `.txt` | ○ | △ | `cover.alt` のみ |
| 記事どうしの参照 | △ | — | △ | △ relation | △ | ○ 強い参照・弱い参照 | ○ `reference()` | — |
| フィールド定義（コンテンツモデル） | △ | — | — | ○ `fields`・`widget` | ○ blueprint | ○ スキーマ | ○ zod スキーマ | 固定の標準スキーマ |
| 新規作成のひな形 | △ | — | ○ archetypes | △ 既定値 | ○ | ○ | — | — |
| 多言語 | △ | — | ○ `translationKey` | ○ 3 方式 | ○ | ○ | △ | — |
| 改訂履歴 | ○ リビジョン | ○ | Git | Git | △ | ○ | Git | Git（記事単位コミット） |

出典：WordPress[^wp-post-status][^wp-taxonomies]、Ghost[^ghost-posts]、Hugo[^hugo-front-matter][^hugo-archetypes]、Decap CMS[^decap-config][^decap-i18n]、Kirby[^kirby-files][^kirby-file-meta]、Sanity[^sanity-reference][^sanity-scheduling]、Astro[^astro-collections]。△ のうち出典で個別に確認していないものは、プラグイン・独自フィールドで実現できるという一般的な評価であり、詳細は未確認。

# 取り入れる候補

コストは「仕様の改訂・スキーマの検証・フォーム・テスト」を含めた Kotono CMS 側の目安。小は数日、中は 1〜2 週間、大はそれ以上。優先度は P1（次に入れる）・P2（次の段階で検討）・P3（必要が出たら）。

## P1：次に入れる

### C1. 説明文（`description`）

- **他の CMS**：Ghost は自動の `excerpt` と手で書く `custom_excerpt`、検索用の `meta_description` を持つ[^ghost-posts]。Hugo は `summary`（一覧のティーザー）と `description`（メタタグ用）を分けて持つ[^hugo-front-matter]。
- **理由**：記事一覧のリード文、検索結果、SNS のカードに必ず要る。今はフロントが本文から切り出すしかなく、意図しない文が出る。
- **Kotono CMS での形**：`description: string`（任意。ない記事は空と同じ）。フォームに複数行の欄と文字数を出し、目安（例：全角 120 字前後）を超えたら警告だけ出す。一覧のキーワード検索の対象に加える。
- **コスト**：小。第6章の表に 1 行、フォームに 1 欄、検証は型だけ。
- **設計との相性**：よい。frontmatter のキー単位でマージされる。

### C2. 旧 slug の記録（`aliases`）

- **他の CMS**：Hugo の `aliases` は、現在のページへリダイレクトするパスの一覧[^hugo-front-matter]。
- **理由**：仕様は公開後の slug 変更に警告を出し、リダイレクトはフロントの責務としている（第7.1節）。しかしフロントが旧 slug を知る手段がない。変更の瞬間を知っているのは CMS だけなので、CMS が記録するのが最も確実。ニュースでは見出しの修正に伴う slug 変更が起きやすく、リンク切れは被リンクと検索順位を失う。
- **Kotono CMS での形**：`aliases: string[]`（slug と同じ形式）。公開対象の記事の slug を変えて保存するとき、確認ダイアログで「旧 slug を `aliases` に残す」を既定で選ぶ。slug の重複検査（第7.1節）の対象に `aliases` も含め、他記事の slug・aliases と衝突しないことを確かめる。
- **コスト**：小〜中。保存時の差分判定と重複検査の拡張。重複検査の再走査はすでにあるので、抽出する値を増やすだけ。
- **設計との相性**：よい。URL の形（`/articles/<slug>` か等）はフロントが決めるので、記録するのは slug だけにする。

### C3. 読者向けの更新日と訂正の記録

- **他の CMS・外部の基準**：Google は、表示する公開日・更新日と構造化データの `datePublished`・`dateModified` を一致させ、日付はページの公開や更新を表すものにするよう勧めている[^google-dates][^google-article]。
- **理由**：`updatedAt` は保存のたびに CMS が更新する（第8章）。誤字の修正でも変わるため、そのまま「更新日」として読者や検索エンジンに出すと不正確になる。報道では、内容の更新や訂正を本文の末尾に明示する運用が一般的で、その記録が記事に残っていると便利。
- **Kotono CMS での形**：
  - `revisedAt: datetime | null`：読者向けの更新日。保存ダイアログに「重要な更新として記録する」を設け、選んだときだけ現在時刻を入れる。手入力も可（第8章の日時形式）。
  - `corrections: [{ at: datetime, note: string }]`：訂正・追記の記録。本文とは別の構造化データにして、フロントが定型の書式で出せるようにする。
  - `updatedAt` の意味（CMS が管理する最終保存時刻）は変えない。
- **コスト**：小〜中。日時の検証は既存の関数を使える。保存ダイアログとフォームの追加。
- **設計との相性**：よい。どちらも記事ごとの frontmatter。

### C4. 画像のキャプションとクレジット

- **他の CMS**：Ghost は `feature_image_alt` と `feature_image_caption` を持つ[^ghost-posts]。Kirby はファイルごとに `<ファイル名>.txt` の付随ファイルを置き、キャプション・撮影者などの任意の項目を持たせる[^kirby-file-meta]。
- **理由**：報道写真・提供画像はクレジット表記が必要で、キャプションも記事の一部として扱われる。今はカバー画像に `alt` しかない。
- **Kotono CMS での形**：まずカバー画像に `cover.caption`・`cover.credit`（任意の文字列）を加える。`cover` は未知フィールドを保持する仕様なので、既存データとの互換は保たれる（第6章）。本文中の画像は、Markdown の画像の title（`![alt](./media/x.jpg "キャプション")`）で足りるかを先に確かめる。足りなければ P3 として、Kirby のような画像ごとの付随ファイル（例：`media/x.jpg.meta.yaml`）を検討する。
- **コスト**：カバー画像は小。本文画像の付随ファイルは中（画像の削除・参照確認（第18章）・派生画像と連動させる必要があり、簡易マージでは「その他のファイル」で自動マージされない）。
- **設計との相性**：カバー画像はよい。付随ファイルは、画像と一緒に暗号化されるので秘匿の面は問題ないが、ファイルが増える分だけ削除・移動の整合の手間が増える。

### C5. 著者（`authors`）と著者プロフィール

- **他の CMS・外部の基準**：Ghost は複数の `authors` と `primary_author` を持つ[^ghost-posts]。Astro は `reference("authors")` で別のコレクションの項目を ID で参照する[^astro-collections]。Google は著者ごとに別の `author` を並べ、著者を一意に示すページ（`author.url`）を示すよう勧めている[^google-article]。
- **理由**：Web メディアでは署名と著者ページは基本の要素。寄稿者が複数いるサイトでは、表記ゆれ（「山田太郎」「山田 太郎」）を防ぐため、名前の文字列ではなく ID で参照したい。
- **Kotono CMS での形**：
  - 記事：`authors: string[]`（著者 ID の配列。先頭を主著者とする）。
  - 著者：`content/authors/<著者ID>/index.md`（frontmatter に `name`・`bio`・`url`・`avatar`、本文に紹介文）。記事フォルダと同じ形にして、ID の形式（第5章）・画像の扱い（`media/`）・暗号化・同期の仕組みをそのまま使う。
  - 記事の編集画面では著者の一覧から選ぶ。存在しない著者 ID は検証エラーではなく警告にする（Sanity の「弱い参照」に近い扱い[^sanity-reference]）。著者を削除するとき、参照している記事を一覧で示す（画像の参照確認（第18章）と同じ考え方）。
- **コスト**：中。リポジトリの構成（第3章）に `content/authors/` を足し、一覧・編集画面を著者にも広げる。記事の一覧・編集の部品を流用できるかで大きく変わる。
- **設計との相性**：よい。著者は記事と同じく 1 件 1 フォルダなので、中央の登録簿を作らずに済み、マージの競合も記事単位に収まる。1 人で書くブログでは不要なので、`authors` がなければ今と同じ表示にする。

## P2：次の段階で検討

### C6. コンテンツモデル（カスタムフィールドの定義）

- **他の CMS**：Decap CMS は `collections` の `fields` に `name`・`label`・`widget`・`required`・`pattern`・`hint` を書いてフォームを作る[^decap-config]。Kirby は YAML の blueprint、Astro は zod のスキーマで検証と型を生成する[^astro-collections]。
- **理由**：サイトごとに要る項目（例：`featured`・`sponsored`・`location`・`series`）は違う。今は未知フィールドとして原文モードで書くしかなく、型の検証もない。標準スキーマを増やし続けるより、サイト側で足せるほうが長く持つ。
- **Kotono CMS での形**：`cms.config.json` に `fields`（名前・ラベル・型（文字列・複数行・真偽・日時・選択肢・記事参照・著者参照・画像）・必須・選択肢・説明）を足し、フォームの「その他の項目」に描く。定義にない未知フィールドは今どおり保持する。
- **コスト**：大。第28章の対象外（汎用設定エディタ・未知フィールドの専用フォーム）を外す仕様改訂、設定の検証と予算（第34.5節）、型ごとのフォーム部品、原文モードとの往復保持（第9章）の試験が要る。
- **設計との相性**：条件つきでよい。設定ファイルは簡易マージで自動解決されないが（第40.5節）、フィールド定義は変更の頻度が低いので実害は小さい。C1〜C5 を個別の標準項目で先に入れ、このしくみに後から載せ替えるかを ADR で決める。

### C7. フロント向けのスキーマの書き出し

- **他の CMS**：Astro はスキーマで全項目を検証し、型を生成する[^astro-collections]。
- **理由**：Kotono CMS はヘッドレス CMS で、記事をどう解釈するかはフロントに任せている（第1章）。フロントが同じ規則で検証できるよう、frontmatter の JSON Schema（と C6 を入れた場合はその定義）を書き出せると、規則のずれを防げる。仕様はすでに「フロント側へ描画規則とテスト用記事を提供する」としている（第15章）。
- **Kotono CMS での形**：リポジトリに `kotono.schema.json` を書き出す明示操作、または配布物に同梱する。
- **コスト**：小（標準スキーマだけなら）。
- **設計との相性**：よい。

### C8. 記事どうしの参照（関連記事・連載）

- **他の CMS**：Sanity の参照は相手の ID を `_ref` に持ち、既定（強い参照）では参照されている文書を削除できない。`weak: true` で存在しない相手も許す[^sanity-reference]。Astro は `z.array(reference("blog"))` で関連記事を表す[^astro-collections]。
- **理由**：連載・続報・関連記事はニュースサイトとブログで頻繁に使う。slug は変わりうるので、変わらない記事 ID で参照したい。Kotono CMS は記事 ID がフォルダ名で通常変えない（第1.2節）ので、参照の基盤がすでにある。
- **Kotono CMS での形**：`related: string[]`（記事 ID）、`series: { id: string, order: number }`（連載。連載そのものを `content/series/` に置くか、ID の文字列だけにするかは要検討）。記事の削除時に、参照している記事を示す。
- **コスト**：中。記事を選ぶ部品と、削除時の逆参照の走査。
- **設計との相性**：よい。

### C9. カテゴリ（主分類）とタグの整理

- **他の CMS**：WordPress は階層のあるカテゴリと階層のないタグを分ける[^wp-taxonomies]。Ghost はタグのうち先頭を `primary_tag` とする[^ghost-posts]。Hugo は分類の種類を設定で増やせる[^hugo-front-matter]。
- **理由**：メディアのサイトでは「政治」「経済」のような主分類が URL・ナビゲーションの軸になる。タグだけだと、どれが主分類か判別できない。また、タグの表記ゆれを一括で直す手段がない（タグは大文字小文字を区別して保持し、自動で統合しない（第6章））。
- **Kotono CMS での形**：`category: string`（1 つ）。選べる値は `cms.config.json` の一覧から選ぶ（自由入力も保持する）。タグとカテゴリの「一括の名前の変更」操作を設け、対象の記事一覧を示してから、記事ごとに保存する（複数ファイル操作の規則（第13.4節）に従う）。
- **コスト**：カテゴリの項目だけなら小、一括の名前の変更は中（多数の記事の保存と部分失敗の表示）。
- **設計との相性**：よい。分類の値は記事ごとに持ち、設定には選択肢だけを置く。

### C10. 新規作成のひな形

- **他の CMS**：Hugo の archetypes は、新しいコンテンツを作るときの frontmatter と本文のひな形[^hugo-archetypes]。Decap CMS はフィールドの `default` を持つ[^decap-config]。
- **理由**：定型の記事（イベント告知、インタビュー、訂正のお知らせ）を同じ構成で始められる。複製（第10.2節）はあるが、既存記事の本文や日時を毎回消す手間がある。
- **Kotono CMS での形**：`content/templates/<名前>/index.md`。新規作成のときにひな形を選ぶと、`id`・日時・`status` は新規作成の規則で入れ直し、それ以外の項目と本文を写す。
- **コスト**：小〜中。複製の処理をほぼ流用できる。
- **設計との相性**：よい。

### C11. 公開前の点検（品質チェック）

- **理由**：CMS が手元で完結するので、公開前の点検は CMS の中でできる。例：説明文の長さ、画像の `alt` の未入力、見出しの階層の飛び、存在しない記事 ID への参照、本文中の旧 slug へのリンク、文字数と読了時間の目安（Ghost は `reading_time` を持つ[^ghost-posts]）。
- **Kotono CMS での形**：編集画面の点検パネルに警告として出す。保存は止めない（公開対象の必須条件（第7.2節）は今どおり）。
- **コスト**：小〜中（項目ごとに足せる）。
- **設計との相性**：よい。ネットワークを使わない点検に限る（外部リンクの死活確認はしない）。

## P3：必要が出たら

| 項目 | 他の CMS | Kotono CMS での形とコスト |
| --- | --- | --- |
| 掲載期限（`expiresAt`） | Hugo の `expiryDate`[^hugo-front-matter] | 期間限定の告知記事向け。フロントが判定する。小 |
| 注目記事（`featured`） | Ghost の `featured`[^ghost-posts] | 真偽の項目。C6 を入れればカスタムフィールドで足りる。小 |
| SEO・SNS 用の上書き（`metaTitle`・`ogImage`・`canonicalUrl`） | Ghost の `meta_title`・`og_*`・`twitter_*`・`canonical_url`[^ghost-posts] | 転載記事の `canonicalUrl` は報道で需要がある。C6 で足りる。小 |
| 編集の段階（執筆中・確認待ち・公開可） | WordPress の `pending`[^wp-post-status]、Decap CMS の編集ワークフロー[^decap-config]、Kirby の状態[^kirby-files] | `status` の意味（公開対象の判定）は変えず、別の項目（例：`stage`）にする。1 人の運用では不要。小 |
| 固定ページ・複数のコレクション | Hugo のセクション[^hugo-bundles]、Decap CMS のコレクション[^decap-config] | 「会社概要」等の記事でないページ。`content/pages/` を足すとリポジトリ構成（第3章）と一覧が広がる。大 |
| 多言語（翻訳の対応づけ） | Hugo の `translationKey`[^hugo-front-matter]、Decap CMS の 3 方式[^decap-i18n] | 記事ごとに `lang` と `translationOf`（元記事の ID）を持つ形なら今の構成に合う。中 |
| 本文中の画像ごとのメタデータ | Kirby の付随ファイル[^kirby-file-meta] | C4 を参照。中 |
| 本文の全文検索 | — | 第23章で対象外。暗号化した作業場所でも、索引をメモリだけに持てば秘匿は保てる。中 |
| 脚注のプレビュー | — | 第15章で対象外（原文は保持）。ブログで需要がある。中 |

# 設計に合わないもの

次は、Kotono CMS の「手元で完結・ファイルが正本・暗号化・自動通信なし」の設計と合わないため、取り入れない。フロントや外部のしくみに任せる。

| 機能 | 他の CMS | 合わない理由 | 代わりの考え方 |
| --- | --- | --- | --- |
| 予約公開の実行 | WordPress の `future`[^wp-post-status]、Sanity の予約公開（Sanity 側で実行）[^sanity-scheduling] | CMS は常駐せず、サーバーもない。指定時刻に何かを実行できない | 今どおり `publishedAt` を未来にし、フロントのビルド（例：定期実行）で反映する。CMS は「公開予定日時」とだけ表示する（第7.2節） |
| 配信用の API・Webhook | Ghost の Content API[^ghost-posts] | 第1章で CMS は配信 API を持たないと決めている。自動通信もしない | Git のリポジトリそのものがフロントへの受け渡しの形 |
| コメント・会員・ニュースレター・有料記事 | Ghost の `visibility`・`access`[^ghost-posts] | 読者を扱うサーバー機能 | 外部サービスに任せる。必要なら記事に `visibility` 等の値だけ持たせ、意味はフロントが決める |
| コードの差し込み | Ghost の `codeinjection_head`・`codeinjection_foot`[^ghost-posts] | 記事由来のスクリプトを扱わない方針（第16章）。プレビューで実行できない | フロントのテンプレートで扱う |
| プルリクエストを使う編集ワークフロー | Decap CMS の `editorial_workflow`[^decap-config] | ブランチ操作は対象外（第40.1節） | P3 の「編集の段階」を項目で持つ |
| 外部サービスの埋め込みの表示（oEmbed 等） | — | 自動の通信をしない（第16.3節） | 埋め込みは原文として保持し、プレビューでは URL だけの置き換え表示にする |
| リアルタイムの共同編集・利用者ごとの権限 | — | 単一の CMS インスタンスでの運用が前提（第12章） | 共同作業は GitHub の権限と同期（第40章）で行う |
| 全記事を 1 つにまとめた中央の索引ファイル | — | 簡易マージで自動解決されず競合が増える（第40.5節）。暗号化の単位もファイルごと | 値は記事ごとに持ち、一覧は走査で作る（今の方式） |
| 外部 URL の画像・画像 CDN の変換 | — | 外部画像を取得しない（第28章） | 取り込み時の最適化と派生画像（ADR-0005）を使う |

# 未決事項

1. C1〜C5 を標準スキーマ（第6章）に足すか、C6 のカスタムフィールドのしくみを先に作ってそこへ載せるか。標準に足すほうが早く、フロントとの契約も明確になる。この調査は前者を推す。
2. 著者・連載・ひな形の置き場所（`content/authors/` 等）を、第3章の「記事フォルダは `content/articles/` の直下のみ」との関係でどう定義するか。
3. `aliases` の重複検査を、公開対象の記事だけにするか、下書きも含めるか（slug は下書きも含める（第7.1節））。
4. `revisedAt` を保存ダイアログで入れる操作が、手動保存の流れ（第13章）を重くしないか。実際の編集の頻度で確かめる。
5. 採用を決めた項目ごとに、フロント側のテスト用記事（第15章）を足す。
