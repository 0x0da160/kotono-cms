---
type: Architecture Decision
title: "ADR-0009 記事の任意の標準項目（説明文・旧 slug・読者向けの更新日時・訂正・著者・カバーのキャプションとクレジット）"
description: "他の CMS との比較調査の P1 の 5 件を、frontmatter の任意の標準項目として実装する決定。項目の形と検証、ない項目をフォームで足す方式、公開後の slug 変更で旧 slug を aliases に残す流れと重複検査、content/authors/ からの著者の読み込み、複製時の扱い、未対応の点。"
tags: ["frontmatter", "スキーマ", "slug", "リダイレクト", "著者", "訂正", "画像", "仕様からの変更"]
status: draft
generated: { by: claude-code/2.1.318, at: 2026-11-08T05:40:00Z }
sources:
  - id: request-2026-11-08-implement
    resource: "0x0da160 の依頼（2026-11-08）：他の CMS との比較調査を受けて「実装して」"
    title: "比較調査の P1 の実装の依頼"
    author: human:0x0da160
    last_modified: 2026-11-08T05:12:51Z
  - id: cms-comparison
    resource: ../research/cms-comparison.md
    title: "他の CMS との比較：Web メディア・ブログ向けに取り入れる機能とデータ構造"
    author: claude-code/2.1.318
    last_modified: 2026-11-08T05:30:00Z
  - id: spec-v3-2
    resource: ../../spec/local-cms-specification-v3.2.md
    title: "ローカルCMS 仕様書 改訂版 3.2"
    author: human:0x0da160
    last_modified: 2026-11-08T00:00:00+09:00
---
# 決定

[他の CMS との比較](../research/cms-comparison.md) で P1 とした 5 件を、frontmatter の**任意の標準項目**として実装する[^request-2026-11-08-implement][^cms-comparison]。仕様 3.2 に第6.1節を足し、第3章・第7.1節・第23章を合わせて直した[^spec-v3-2]。

| 項目 | 形 | 検証 | フォーム |
|---|---|---|---|
| 説明文 | `description: string` | 文字列 | タイトルの下の複数行の欄。文字数と目安（120文字前後）を出し、超えたら警告だけ |
| 旧 slug | `aliases: string[]` | 各要素が slug の形式で非空、重複なし、現在の slug と一致しない | slug の下。ある記事だけチップで表示し、手でも足せる |
| 読者向けの更新日時 | `revisedAt: datetime \| null` | 第8章の日時 | 公開日時の下。「現在時刻」「未設定にする」 |
| 訂正・追記 | `corrections: { at, note }[]` | `at` は日時、`note` は空白だけでない文字列 | 「訂正・追記を記録」で現在時刻の 1 件を足し、日時と内容を直せる |
| 著者 | `authors: string[]`（著者 ID） | slug と同じ形式で 64 文字以内、重複なし | タグの下。著者の一覧（datalist）から ID か表示名で選ぶ。未登録の ID は警告 |
| カバーのキャプション・クレジット | `cover.caption`・`cover.credit: string` | 文字列 | カバー画像の欄に 2 つ足す |

- **ない記事は今までどおり**。項目がないことを検証エラーにせず、CMS は勝手に補わない。フォームで初めて値を入れたときだけ、frontmatter の末尾に足す（`addTopLevelValue`）。足したあとも、他の項目・コメント・未知の項目が変わらないことを再解析で確かめる。
- **`updatedAt` の意味は変えない**。`revisedAt` は保存で自動に変わらず、利用者が決める。
- **意味はフロントが決める**。CMS は形と重複だけを検証する。

# 公開後の slug 変更と旧 slug

- 公開対象の記事の slug を変えて保存すると、確認の画面に「旧 slug を残して保存」（主な操作）・「残さずに保存」・「キャンセル」を出す。残す場合は、保存のスナップショットを取る前に `aliases` へ旧 slug を足す（同じ値はすでにあれば足さない）。この確認はスナップショットの前に 1 回だけ出す。
- slug を `aliases` のどれかに戻した場合は、保存のときにその値を `aliases` から外す。入力中に外すと、続けて入力したときに旧 slug を失うため、保存のときに行う。
- 重複検査（第7.1節）は他の記事の `aliases` も対象にする。`aliases` を変えた保存では、slug と同じく記事領域を再走査する。読めない記事があれば「重複検査不能」で止める。

# 著者

- 著者のプロフィールは `content/authors/<著者ID>/index.md` に置き、frontmatter の `name` を表示名とする。一覧の再読み込みのときに読み（最大 1000 件、frontmatter の上限内）、候補と表示名に使う。
- CMS は著者のファイルを**作成・変更しない**。デスクトップでは外部のエディタで、iPhone・iPad では GitHub から同期して用意する。CMS の中で著者を作る・直す画面は、必要になったら別に作る。
- 未登録の著者 ID は警告にとどめ、保存は止めない（Sanity の弱い参照に近い扱い）。

# 複製

`aliases`・`revisedAt`・`corrections` は元の記事の履歴なので、ある場合だけ空の配列・`null`・空の配列にする。`description`・`authors`・カバーのキャプションとクレジットは残す。

# 主な場所

| 内容 | 場所 |
|---|---|
| 検証 | `src/lib/core/schema.ts`（`OPTIONAL_KEYS`・`validateOptional`） |
| 書式を保った編集 | `src/lib/core/yaml-doc.ts`（`replaceMapSeq`・`addMapChild`）、`src/lib/core/article-doc.ts`（`editField`・`addTopLevelValue`・`duplicateText`） |
| 重複検査 | `src/lib/core/slug.ts`（`checkAliasUniqueness`）、`src/lib/fs/repo.ts`（`slugEntries`） |
| 保存の流れ | `src/lib/app/workspace.svelte.ts`（`save`） |
| 著者の読み込み | `src/lib/fs/repo.ts`（`readAuthors`） |
| フォーム | `src/components/FrontmatterForm.svelte` |
| 試験 | `tests/unit/optional-fields.test.ts`、`tests/e2e/editing.spec.ts` |

# 未対応・未検証

- 著者を CMS の中で作成・編集する画面はない。
- 本文中の画像ごとのキャプション・クレジット（調査の C4 の後半）は対象外。
- 一覧には新しい項目を表示していない（キーワード検索の対象には説明文と著者 ID を足した）。
- 実機（Windows・macOS の Chrome・Edge、iOS Safari）での確認はしていない。E2E はヘッドレス Chromium で、フォルダはページ内の疑似実装。
