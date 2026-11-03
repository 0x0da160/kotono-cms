---
type: Specification Section
title: "第6章 frontmatterの標準スキーマ"
description: "frontmatterの標準スキーマ（id・title・slug・status・日時・tags・cover）と未知フィールドの保持。"
tags: ["仕様3.1", "frontmatter", "スキーマ"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-03T17:10:46Z }
sources:
  - id: spec-v3-1
    resource: ../../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
spec_version: "3.1"
spec_chapter: 6
---
## 6. frontmatterの標準スキーマ

```yaml
---
id: "k7m2x9q"
title: "記事タイトル"
slug: "article-slug"
status: "draft"
createdAt: "2026-11-03T22:08:00+09:00"
updatedAt: "2026-11-03T22:08:00+09:00"
publishedAt: null
tags: []
cover: null
---
```

| 項目 | 型・制約 |
| --- | --- |
| `id` | 文字列。記事フォルダ名と一致。通常変更不可 |
| `title` | 文字列。下書きは空文字可。公開状態は空白だけでない値が必須 |
| `slug` | 文字列。第7章に従う |
| `status` | `draft` または `published` |
| `createdAt` | 第8章の日時文字列。通常変更不可 |
| `updatedAt` | 第8章の日時文字列。保存時にCMSが管理 |
| `publishedAt` | 第8章の日時文字列または `null`。公開状態は日時必須 |
| `tags` | 文字列配列。空配列可。空・空白のみの要素と完全一致の重複は禁止 |
| `cover` | `null` または `src`・`alt` を持つマッピング |

```yaml
cover:
  src: "./media/q7m2k9w4ac.jpg"
  alt: "画像の説明"
```

- `cover.src`・`cover.alt` は文字列。altの空文字は許容する。
- coverは当該記事の `media/` 内のローカル画像を指す。外部URLや記事領域外の値は保存時の検証エラー。
- 未知のトップレベルフィールドと、cover内の未知フィールドを保持する。
- タグは大文字小文字を区別して保持し、自動統合・自動トリムしない。フォーム入力時は確定前に空白を可視化して検証する。
- 下書きでも標準項目の存在と型は必須。未知フィールドだけを理由に保存を止めない。
- createdAtは原文モードでも通常変更不可。既存記事の不足・型不正を修正する場合に限り、専用の確認付きメタデータ修正操作で変更できる。正常な値の任意変更は外部ツールで行う。


<!-- okf:related -->

## 関連する章

* [第7章 slugと公開状態](/spec/data/07-slug-and-status.md) - slugの形式と一意性検査、draft／publishedの状態遷移、公開対象の判定とUIの状態軸。
* [第8章 日時・更新判定・改行](/spec/data/08-datetime-and-change-detection.md) - 日時形式（オフセット必須のRFC 3339サブセット）、未保存・書き込み・updatedAt更新の判定、意味的同値の規則。
