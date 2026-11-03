---
type: Architecture Decision
title: "ADR-0002 P1 MVP：読み込み・編集・手動保存の実装方式"
description: "フォルダ選択・記事一覧・作成と編集・手動保存（外部変更検出と保存契約）・ID と slug・YAML 往復保持の実装方式と、未検証の技術ゲート、仕様との緊張点。"
tags: ["編集", "保存", "YAML保持", "技術ゲート", "要検証"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-03T18:20:11Z }
sources:
  - id: spec-v3-1
    resource: ../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
  - id: yaml-bench
    resource: "Node.js 22 上での yaml 2.9.1 parseDocument の計測（2026-11-03、1回測定）"
    title: "キー重複検査の計算量の予備測定"
    author: claude-code/2.1.317
    last_modified: 2026-11-03T18:20:11Z
---
# 決定

[第27.2節](/spec/foundation/27-mvp-and-roadmap.md) の手順3「Gitなしでも安全な読み込み・編集・リビジョン管理・手動保存」のうち、次を実装する。Git、公開、設定エディタ、プレビュー、復旧ドラフト、画像、複製、削除は今回の範囲外。

| 領域 | 方式 | 主な場所 |
|---|---|---|
| フォルダ | `showDirectoryPicker({ mode: "readwrite" })`。`content/articles/` がなければ作成予定パスを示し、確認後に作成 | `src/lib/fs/repo.ts` |
| 一覧 | frontmatter までの有界読込（先頭 1 MiB＋区切り分）、I/O 並列度 8、記事単位にエラーを隔離 | `src/lib/fs/repo.ts` |
| 正本文書 | LF・BOM なしの全文文字列1つとリビジョン番号。フォーム・原文・本文はすべてこれを編集 | `src/lib/app/session.svelte.ts` |
| YAML | `yaml` 2.9.1 の Document API（core schema、`intAsBigInt`）。フォームの変更は対象ノードの原文範囲だけを置換し、再解析して「対象値が意図どおり」「他の項目が意味的に同値」「コメントの集合が同じ」を検証。満たせなければ変更を拒否 | `src/lib/core/yaml-doc.ts` |
| 意味的同値 | 型付き比較。整数は BigInt、浮動小数は元表現から十進正規化、NaN 同値、±0 同値、キー順は表現差 | `src/lib/core/yaml-doc.ts` |
| 保存 | スナップショット固定 → 検証（slug 再走査を含む）→ ディスクと基準版のバイト比較 → 候補確定（必要時のみ updatedAt）→ 最終 UTF-8 候補の再検証 → `createWritable` で書込・クローズ → 再読込一致で成功 | `src/lib/fs/save.ts`、`src/lib/app/workspace.svelte.ts` |
| 失敗後 | 実ファイルを読み直して基準版・候補・第三の内容を識別。候補と一致すれば重複書き込みせず成功へ | `src/lib/fs/save.ts` |
| 新規作成 | 作成開始時に ID と createdAt を確定し、初回保存までディスクに何も作らない。保存直前に ID 重複を再確認し、作成直後のフォルダが空であることを確認 | `src/lib/fs/save.ts` |
| 依存 | [ADR-0001](0001-tech-stack.md) の候補から `nanoid` 5.1.16（記事ID、`customAlphabet`）と `yaml` 2.9.1 を固定版で採用 | `package.json` |
| Undo/Redo | 文書レベルの共通履歴（1,000 操作・20 MiB）。保存の管理値反映は履歴全体へ適用し Undo 対象にしない | `src/lib/core/history.ts` |

# 理由

- [第9.3節](/spec/data/09-yaml-preservation.md) は「変更した項目の書式：必要なノードだけ変更」を求める。Document 全体の `toString()` は未変更ノードのインデント等を変えることがあるため、範囲置換と再解析検証を選んだ。保持フィクスチャは `tests/fixtures/preservation/` にある。
- [第12.1節](/spec/editing/12-concurrency-and-external-changes.md) はサイズ・mtime だけでの同一判定を禁じるため、保存直前に全文をバイト比較する（記事は 5 MiB 以下）。

# 未検証の技術ゲート

| ゲート | 状態 | 根拠と不足 |
|---|---|---|
| TG01 | 一部 | ヘッドレス Chromium（Linux）で file:// 起動と能力検査のみ。フォルダ選択・権限付与・失効・実ファイルの読み書きは、file:// で OPFS が `SecurityError` になるためページ内の疑似フォルダで代替した。Windows・macOS の Chrome・Edge では未実施 |
| TG02・TG03 | 未着手 | Git は範囲外 |
| TG04 | 一部 | メモリ上の実装で存在確認直後の外部作成を注入（T01 相当）。実フォルダでの競合窓は未測定 |
| TG05 | 未着手 | シンボリックリンク・ジャンクションの観測は未実装 |
| TG06 | 一部 | メモリ上の実装で書込失敗・クローズ失敗・再読込不一致・再試行を注入。実ディスクは未実施 |
| TG07 | 一部 | 保持フィクスチャ12件と同値表を単体試験で確認。外部の YAML 実装との相互読取は未確認 |
| TG08 | 一部 | 既存の CSP 試験のみ。プレビューは未実装 |
| TG09 | 一部 | 記事 5 MiB、frontmatter 1 MiB・深度・ノード・キー・単一スカラーを実装。第34.5節の値（設定 64 KiB、列挙 20,000 件・10 秒）は暫定値で未承認。解析の 2 秒上限は未実装（主スレッドで解析） |
| TG10〜TG12 | 未着手 | 復旧ドラフト・削除前退避は範囲外。性能・IME・支援技術は未測定 |

# 仕様との緊張点（要再合意）

1. **壊れた記事が1件あると、slug を持つ新規記事・slug 変更の保存がすべて止まる。** [第7.1節](/spec/data/07-slug-and-status.md) どおり「重複検査不能」として停止している。YAML 構文エラーの記事から slug を安全に取り出す方法がないため。
2. **frontmatter の資源上限は構築後に検査している。** [第34.2節](/spec/quality/34-resource-budgets.md) は「構築中に適用」を求めるが、採用パーサーは文書全体を構築してから返す。1 MiB の読込前上限で増幅を抑えている。なお、`yaml` のキー重複検査（`uniqueKeys`）はキー数の2乗の時間がかかり、10,000 キーで約1.3秒、20,000 キーで10秒超だったため、独自の O(n) 検査に置き換えた。[^yaml-bench]
3. **解析層の Worker 隔離は未実装。** [第16.1.1節](/spec/security/16-trust-boundary-preview-network.md) の「終了可能な Worker 等で解析」に対し、YAML 解析は主スレッドで行う。
4. **単独の CR を含む記事は読み取り専用にした。** テキスト入力欄が CR を LF に変換するため、保持できない。仕様には明記がない。
5. **null や空の値を日時文字列へ変えるときは二重引用符で書く。** YAML 1.2 core schema では plain でも文字列だが、YAML 1.1 系の読み手では日付型になるため。既存の plain の文字列は plain のまま保つ。仕様に規定はない。
6. **updatedAt の時刻を原文で変えた保存は、他の変更があっても拒否する。** [第8.2節](/spec/data/08-datetime-and-change-detection.md) の「updatedAt だけの原文編集は拒否」を、CMS 管理項目として広めに解釈した。オフセット表記だけの変更は許可する。
7. **`createWritable({ mode: "exclusive" })` を指定しているが、対応環境での挙動は未確認。** [第12章](/spec/editing/12-concurrency-and-external-changes.md) の検証方針どおり、外部プロセスを含む排他とは扱わない。

# 結果

- `pnpm test` で単体試験、`pnpm test:e2e` で file:// 起動した成果物の編集フローを試験する。
- 上記の未検証ゲートは、リリース判定（[第27.3節](/spec/foundation/27-mvp-and-roadmap.md)）の前に実機で確認する必要がある。

[^yaml-bench]: キー重複検査の計算量の予備測定
