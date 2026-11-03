---
type: Specification Section
title: "第3章 リポジトリと記事フォルダ"
description: "作業リポジトリと記事フォルダ（content/articles/<ID>/index.md と media/）の構成規則と初回フォルダ準備。"
tags: ["仕様3.1", "フォルダ構成", "記事フォルダ"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-03T17:10:46Z }
sources:
  - id: spec-v3-1
    resource: ../../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
spec_version: "3.1"
spec_chapter: 3
---
## 3. リポジトリと記事フォルダ

```text
repository/
├── .git/                         # Git機能使用時
├── .gitattributes                # 存在する場合。CMSは自動変更しない
├── cms.config.json               # 省略可
└── content/
    └── articles/
        ├── k7m2x9q/
        │   ├── index.md
        │   └── media/
        │       ├── q7m2k9w4ac.jpg
        │       └── n6p3x8r5tz.webp
        └── p4c8n6w/
            └── index.md
```

- 1記事を1フォルダとする。本文ファイル名は `index.md` 固定。
- 記事フォルダは `content/articles/` の直下のみを対象とする。
- 記事IDがフォルダ名となる。タイトル・slug・日時の変更でフォルダ名を変えない。
- 記事固有メディアは `media/` に置く。メディアがなければ省略可。
- CMSが生成する画像参照は `./media/ファイル名` とする。
- 未知のファイル・サブフォルダは通常保存では保持する。
- 隠しファイルを含め、フォルダ内の全ファイルが記事削除の対象となる。削除時は一覧で確認させる。
- 記事領域やメディア領域から外へ出るパス、シンボリックリンク等の間接参照を辿って読み書きしない。文字列パス検証と実エントリー検証を分離する。観測API・停止条件・OS別試験は第31・32章に従う。観測能力が足りず通常操作の成立を証明できない場合も、技術ゲート未合格とする。
- `index.md` がないフォルダは不完全な記事として表示し、自動生成・自動削除しない。
- 期待するディレクトリ位置に同名の通常ファイルがある場合はエラーとし、置換しない。

### 3.1 初回フォルダ準備

`content/articles/` がない場合は作成予定パスを示し、確認後に作成する。閲覧のために無断作成しない。`cms.config.json` がない場合は既定値で動作する。Gitの初期化は独立した明示操作とする。


<!-- okf:related -->

## 関連する章

* [第31章 実フォルダ用fsアダプターの契約（P0）](/spec/git/31-fs-adapter-contract.md) - 実フォルダ用fsアダプターの意味論記録（メソッド別の必要記録と禁止事項）と、Git書き込みの観測・中断安全性。
* [第32章 境界・間接参照・未信頼入力の追加契約](/spec/security/32-boundaries-and-untrusted-input.md) - 実ファイルと文字列パスの境界、間接参照の観測、権限境界図とデータ経路、通信試験と診断ログ。
