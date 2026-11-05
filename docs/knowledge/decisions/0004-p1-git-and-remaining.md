---
type: Architecture Decision
title: "ADR-0004 P1 MVP：ローカル Git 機能と残りの項目の実装方式"
description: "記事単位のステージとコミット・git init・状態と履歴の表示を、外部プロセスを使わない自前の Git 実装で行う方式と、ID・createdAt の専用修正、コードハイライト、配布物の真正性情報。未検証の技術ゲートと仕様との緊張点。"
tags: ["Git", "コミット", "履歴", "修復", "ハイライト", "配布物", "技術ゲート", "要検証"]
status: draft
generated: { by: claude-code/2.1.317, at: 2026-11-04T06:47:54Z }
sources:
  - id: spec-v3-1
    resource: ../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
  - id: isomorphic-git
    resource: "https://www.npmjs.com/package/isomorphic-git/v/1.44.11（index.js の init・readObjectPacked・StreamReader・status・statusMatrix・GitWalkerFs.oid・GitIndex.insert・normalizeMode）"
    title: "isomorphic-git 1.44.11 のソース"
    author: team:isomorphic-git
    last_modified: 2026-11-05T00:00:00Z
  - id: git-interop
    resource: "Node.js 22 と Git 2.43.0（Linux）での相互運用試験（tests/unit/git.test.ts、2026-11-04）"
    title: "CMS が書いた Git メタデータのネイティブ Git による検証"
    author: claude-code/2.1.317
    last_modified: 2026-11-04T06:47:54Z
  - id: browser-git
    resource: "ヘッドレス Chromium（Linux）で file:// から開いた成果物の E2E（tests/e2e/git.spec.ts、2026-11-04）"
    title: "ブラウザの圧縮・ハッシュ API で書いた Git メタデータの検証"
    author: claude-code/2.1.317
    last_modified: 2026-11-04T06:47:54Z
---
# 決定

[第27.1節](/spec/foundation/27-mvp-and-roadmap.md) の MVP のうち、[ADR-0003](0003-p1-preview-media-drafts.md) までで未実装だった次を実装する。

| 領域 | 方式 | 主な場所 |
|---|---|---|
| Git 実装 | 外部プロセス・フック・フィルターを実行しない自前の実装。loose object と pack v2（OFS・REF delta）を読み、loose object・index v2・ブランチ ref・既存の reflog だけを書く。圧縮は `CompressionStream`／`DecompressionStream`、ハッシュは `crypto.subtle`（SHA-1） | `src/lib/git/` |
| fs アダプター | 選択ルートから相対パスのセグメントだけを辿る。`..`・空区間・区切り文字・制御文字・`:`・末尾のドットと空白を拒否する。書き込みは `.git/` の内側だけ。作業ツリー（記事・画像）へは書かない（checkout・復元をしない） | `src/lib/git/gitfs.ts` |
| 対応構成の判定 | `.git` がフォルダの非 bare リポジトリで、ブランチ上、進行中の操作（merge・rebase・cherry-pick・revert・bisect・sequencer）とロック（index・HEAD・config・packed-refs・shallow・対象 ref）がなく、include／includeIf・alternates・commondir・worktree・sparse checkout・submodule・`core.worktree`・`core.hooksPath`・有効なフック・署名必須・SHA-1 以外の形式・未知の拡張・filter／LFS／working-tree-encoding／ident の属性がないこと。index は v2・v3 で、必須拡張（先頭が英大文字でない署名）・skip-worktree・intent-to-add・assume-unchanged・競合・gitlink がないこと。どれかに当たれば Git 書き込みを止め、理由を表示する | `src/lib/git/repo.ts`（`inspect`） |
| 状態 | 記事フォルダごとに HEAD・index・作業ファイルを突き合わせ、ステージ済み・未ステージ・未追跡・削除・競合・無視を区別する。index とサイズ・更新時刻が一致するファイルは読まない（同一秒内の更新は内容で確かめる）。開始前の既存ステージは、index から作った tree の ID と HEAD の tree の ID の比較でリポジトリ全体について判定する | 同上（`articleStatuses`・`stagedPaths`） |
| コミット | 記事フォルダ 1 つ。未保存の編集・既存ステージ・競合・実行属性やシンボリックリンクとして記録されたファイルがあれば止める。無視対象は強制追加しない。確認画面に対象ファイル・無視対象・メッセージ・作者・ブランチを示す。実行直前に HEAD・index（パス・mode・object・stage の要約）・対象ファイルの内容を再確認し、違えば何も書かない。object → index（ここから「ステージ済み」）→ tree・commit → ref の順に書き、ref を読み直して親と tree を確かめる | 同上（`plan`・`commit`） |
| 失敗・再試行 | index を書いた後に失敗したら「ステージ済み・未コミット」とし、ステージを解除しない。同一セッションで HEAD と index が今回書いた内容と一致する場合に限り、確認後に commit から再試行する。ref 更新の結果が分からなければ、既知のコミット ID と ref を照合する。照合できなければ結果不明として止める | 同上、`src/lib/app/git.svelte.ts` |
| 作者 | `.git/config` の user.name・user.email だけを読む。OS のグローバル設定は読まない。未設定なら入力を求め、今回だけ使うか、別の確認を経て `.git/config` の該当 2 行だけを書く（他の行は原文のまま。書き換え後に他の項目が変わっていないことを確かめる）。ブラウザが書き込みを禁止した場合は、外部の Git で設定するよう案内し、今回だけ使う | `src/lib/git/config.ts` |
| git init | `.git` がないことを確かめ、objects・refs・info・logs と config・description を作り、HEAD（`ref: refs/heads/main`）を最後に作る。ブラウザが `.git/config` の作成を禁止したら作らずに進める（緊張点 11）。途中で止まったら、この操作で作ったものだけを深い順に 1 件ずつ消し（中身のあるフォルダは消えない）、消せなかったものを表示する | `src/lib/git/repo.ts`（`init`） |
| 履歴 | コミット日時の新しい順に辿る。1 回の取得は 50 件、内部走査は 1,000 コミット・10,000 tree・5 秒の先到達で止め、継続カーソルと「未調査あり」を返す。記事別は現在の ID のパスに限る。親が見つからない（shallow 等）場合は終端不確かと表示する | 同上（`history`） |
| 削除確認の Git 状態 | [第19章](/spec/deletion/19-article-deletion-and-backup.md) の区別（Git 管理・コミット済み、未コミットの変更あり、未追跡、無視対象）をファイルごとに示す。Git 未使用・対応外の構成ではそう表示する | `GitController.hooks.describe` |
| 競合中の記事 | 未解決の競合がある記事は読み取り専用で開く（[第24章](/spec/browse/24-existing-article-validation.md)） | 同上 |
| ID・createdAt の修正 | [第10.3節](/spec/data/10-create-duplicate-id-repair.md)・[第24.1節](/spec/browse/24-existing-article-validation.md) の専用操作。フォルダ名を正とした id の書き換え、createdAt の不足・不正を updatedAt または現在時刻で直す提案を、変更前後の差分とともに確認してから編集内容へ適用する。ディスクは通常の手動保存まで変えない | `src/lib/core/article-doc.ts`、`Workspace.repairId`・`repairCreatedAt` |
| コードハイライト | `lowlight` 3.3.0（`highlight.js` 11.11.1）に HTML・CSS・JavaScript・TypeScript・JSON・YAML・Bash・Python の文法だけを登録し、解析層の Worker で実行する。結果は「クラス名と文字列」の列で渡し、描画側でクラス名の文字種・件数と、連結した文字列が元のコードと一致することを検証してから使う | `src/lib/core/highlight.ts`、`highlight-tokens.ts` |
| 配布物 | ビルドの最後に `kotono-cms.html.sha256`（`sha256sum -c` 形式）、`release-info.json`（アプリ版・仕様版・同梱した依存の名前・版・ライセンス）、`THIRD-PARTY-LICENSES.txt` を書き出す。実行ごとに変わる値を含めず、同じ入力で同じハッシュになることを確認した | `build/release.ts` |
| 依存 | `ignore` 7.0.11（.gitignore の判定）、`lowlight` 3.3.0、`highlight.js` 11.11.1 を固定版で追加。試験用に `@types/hast` 3.0.4 | `package.json` |

# 理由

- **isomorphic-git を採用しなかった。** [第29.1節](/spec/foundation/29-technology-candidates-and-records.md) の候補だが、isomorphic-git 1.44.11 のソース（npm 配布の `index.js`、2026-11-05 確認）[^isomorphic-git] で次を確かめた。
  1. `init` は `.git/hooks` と `.git/config` を作る。どちらも Chromium 系ブラウザが書き込みを禁止する場所（緊張点 11）のため、Chrome・Edge では初期化が必ず失敗する。
  2. pack から object を読むとき（`readObjectPacked`）は `.pack` 全体を読み込む。[第34章](/spec/quality/34-resource-budgets.md) の object・1 要求のメモリ上限を守れない。CMS の実装は `.idx` の位置から必要な範囲だけを読む。
  3. 内部で `Buffer` を多用し（`StreamReader` は `Buffer` がなければ例外）、ブラウザでは代替実装の同梱が要る。本体だけで圧縮後約 270 KB あり、成果物（約 627 KB）が大きく増える。
  4. `status`・`statusMatrix` は既定（`refresh = true`）で index の stat 情報を書き戻す。File System Access API では mode が取れず 100644 として書かれるため、`status` は常に、`statusMatrix` は `core.filemode` が false か未設定のとき、実行属性付きファイルの mode 変更がステージされた状態になりうる。ただし `refresh: false` で避けられる（不採用の決め手ではない）。

  CMS が必要とする操作（記事単位の追加・変更・削除のコミット、初期化、履歴）は小さく、仕様が求める判定・上限・書き込み範囲の制限はいずれにせよ CMS 側に要る。書き込み先を `.git/` に閉じた実装の方が [第31章](/spec/git/31-fs-adapter-contract.md) の「実現済み・近似・実現不能」を説明しやすい。
- **ネイティブ Git で検証できる。** 単体試験では一時フォルダの実リポジトリに対して CMS の実装でコミットし、`git fsck --strict`・`git status`・`git log`・`git show` で整合を確かめた。gc 後の pack（delta を含む）からの読み取り、記事別の履歴が `git log -- <path>` と一致すること、ネイティブ Git でステージした変更の検出も確かめた。[^git-interop] ヘッドレス Chromium の E2E では、ブラウザの圧縮・ハッシュ API で書いた `.git` を取り出してネイティブ Git で検証した。[^browser-git]
- **index の比較は stat を除いた内容で行う。** ネイティブ Git の `git status` は stat 情報だけを書き換えて index を書き直すため、バイト列の一致で比べると、確認後に外部で `git status` を実行しただけで再試行できなくなった。パス・mode・object・stage の要約で比べる。
- **ビルド時の CSP 算出を直した。** ハイライトの文法に `<style` という文字列が含まれ、インラインの style 要素を探す処理がスクリプト本文の中を誤って拾い、実際の style のハッシュが CSP から抜けた（E2E のコンソールエラーで検出）。style を探す前にスクリプト要素を取り除く。

# 未検証の技術ゲート

[ADR-0003](0003-p1-preview-media-drafts.md) の表を更新する。記載のないゲートは ADR-0003 のまま。

| ゲート | 状態 | 根拠と不足 |
|---|---|---|
| TG02 | 一部 | 初期化・追加・変更・削除コミットを、Node の fs を包んだアダプターとネイティブ Git 2.43.0（Linux）で検証。ヘッドレス Chromium では疑似フォルダに書いた `.git` をネイティブ Git で検証。実フォルダでの File System Access API（Windows・macOS、Chrome・Edge）と I/O トレースは未実施。[第31.1節](/spec/git/31-fs-adapter-contract.md) の意味論表は本 ADR の記述が初版で、実測による確定は未実施 |
| TG03 | 一部 | index・ref の書き込み失敗を注入し、index・ブランチが変わらないこと、ステージ済みからの再試行でネイティブ Git が整合と認めることを確認。object・config・reflog の各境界での中断、ブラウザの再起動、close 前後の中断は未実施 |
| TG05 | 未着手 | 作業ファイル側のシンボリックリンク・ジャンクションは File System Access API で区別できない。index・HEAD にシンボリックリンクとして記録されたファイルは止める |
| TG09 | 一部 | Git object（1 件 64 MiB・1 要求 256 MiB）と履歴（1,000 コミット・10,000 tree・5 秒）は仕様の値。index（64 MiB・500,000 件）・パス（4,096）・config（256 KiB）・ref（4 KiB）・packed-refs（16 MiB）・ref 数（100,000）・delta の深さ（100）・pack index（256 MiB）・状態算出（500,000 項目・10 秒）・無視規則（256 KiB）・ハイライト（1 ブロック 64 KiB・1 文書 256 KiB・20,000 トークン）は暫定値で未承認 |
| TG11 | 未着手 | 大きなリポジトリ（記事数・履歴・pack の大きさ）での状態算出・履歴の所要時間とメモリは未測定 |

# 仕様との緊張点（要再合意）

1. **[第29.1節](/spec/foundation/29-technology-candidates-and-records.md) の候補（isomorphic-git）ではなく自前の実装にした。** 理由は上記。採用 Git 実装の版を固定する代わりに、相互運用試験を回帰試験として維持する。
2. **CMS は Git のロックファイルを作らない。** [第21.3節](/spec/git/21-commit-contract.md) の「ロック検出時は停止」は満たすが、CMS の書き込み中に外部の Git が動くことは防げない（File System Access API に rename・排他作成がない）。外部 Git の同時実行は禁止運用とする。
3. **index は v2 で書き直し、任意拡張（TREE 等）を落とす。** dev・ino・uid・gid は 0、mode は通常ファイル（100644）、時刻は `lastModified` のミリ秒で書く。ネイティブ Git は次回の操作で stat を取り直し、TREE を作り直す。
4. **改行変換は行わない。** `core.autocrlf` が true・input、または `text`・`eol`・`crlf` の属性があるリポジトリでは、CR を含むテキスト（先頭 8,000 バイトに NUL がないもの）のコミットを止める。変換が要らない内容はそのまま保存しても Git と同じ結果になる。属性のパターンと対象パスの照合はしていない（保守的に止める）。
5. **記事フォルダ外の未ステージの変更は表示しない。** [第22章](/spec/git/22-git-status-and-history.md) の変更一覧は記事フォルダについて示し、既存ステージはリポジトリ全体について示す。記事フォルダ外の作業ファイルの全走査は重いため行わない。
6. **履歴の記事別絞り込みは簡易な規則。** 親のどれかと対象パスの tree が同じならそのコミットを省く（マージの扱いが `git log -- <path>` の既定と異なる場合がある）。
7. **reflog は既存のファイルにだけ追記する。** ない場合は作らない。4 MiB を超える reflog には追記しない（結果に表示する）。
8. **git init の config は `filemode = false` とし、`ignorecase` を設定しない。** File System Access API で実行属性と大文字小文字の扱いを観測できないため。
9. **YAML の解析は今回も主スレッドで行う。** [ADR-0002](0002-p1-editing-and-save.md) の緊張点 3（[第16.1.1節](/spec/security/16-trust-boundary-preview-network.md) の Worker 隔離）は未解消。Markdown とハイライトは Worker で行う。
10. **配布物のハッシュは配布元の真正性を証明しない。** [第29.4節](/spec/foundation/29-technology-candidates-and-records.md) の署名・別経路での公開方法は未決定。
11. **Chromium 系ブラウザは `.git/config` への書き込みを禁止する。** Chrome・Edge の File System Access API は、パスの末尾が `.git/config`・`.git/hooks`・`.git/modules` の場所への作成・書き込みを SecurityError で止める（`chrome_file_system_access_permission_context.cc` の kBlockWrite。2026-11-04 の main で確認）。そのため次のようにした。
    - `.git/config` がないリポジトリを止めずに Git の既定値（形式 0・bare でない）で扱う。ネイティブ Git も設定ファイルなしで動く（相互運用試験で確認）。
    - git init は `.git/config` を作れなければ作らずに完了し、外部の Git で `git init` を再実行すれば設定ファイルが作られる（既存の内容は消えない）ことを案内する。この場合、緊張点 8 の `filemode = false` は書かれない。
    - 作者の保存（[第21.2節](/spec/git/21-commit-contract.md)）は Chromium 系では常に失敗するため、外部の Git での設定を案内し、今回だけ使う。仕様の「リポジトリローカル設定への保存」は実質的に外部 Git の手順になる。
    - CMS が書くそれ以外の場所（objects・index・refs/heads・logs・HEAD・description）は禁止の対象外。単体試験と E2E の疑似フォルダはこの禁止を再現する。

ADR-0002 の緊張点（壊れた記事による slug の「重複検査不能」、YAML のキー重複検査の置き換え）は変更していない。

# 結果

- `pnpm test` に、Git の相互運用・対応構成の判定・状態・コミット・失敗注入・pack・履歴・初期化・作者設定、ID と createdAt の修正、ハイライトの試験を追加した。
- `pnpm test:e2e` に、file:// 起動の成果物で Git を初期化し、記事の追加・更新をコミットしてネイティブ Git で検証する試験と、プレビューのハイライトの試験を追加した。
- 上記の未検証ゲートは、リリース判定（[第27.3節](/spec/foundation/27-mvp-and-roadmap.md)）の前に実機で確認する必要がある。

[^isomorphic-git]: isomorphic-git 1.44.11 のソース
[^git-interop]: CMS が書いた Git メタデータのネイティブ Git による検証
[^browser-git]: ブラウザの圧縮・ハッシュ API で書いた Git メタデータの検証
