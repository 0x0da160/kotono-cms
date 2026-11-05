---
type: Architecture Decision
title: "ADR-0006（案）iOS Safari で記事と Git を扱うための計画"
description: "iOS Safari（iPhone・iPad）で記事の編集とローカル Git を使えるようにする計画。File System Access API への依存の洗い出し、ブラウザ内ストレージ（OPFS または LightningFS）への置き換え、取り込みと書き出し、消去の危険とバックアップ、仕様の変更箇所、Git 層の選択、段階ごとの規模と未決事項。実装はしない。"
tags: ["iOS", "Safari", "OPFS", "LightningFS", "IndexedDB", "Git", "対応環境", "計画", "未決定", "要検証"]
status: draft
generated: { by: claude-code/2.1.318, at: 2026-11-05T17:30:00Z }
sources:
  - id: spec-v3-1
    resource: ../../spec/local-cms-specification-v3.1.md
    title: "ローカルCMS 仕様書 改訂版 3.1"
    author: human:0x0da160
    last_modified: 2026-11-04T00:00:00+09:00
  - id: request-2026-11-05-ios
    resource: "0x0da160 の依頼（2026-11-05）：LightningFS（IndexedDB を使う fs）と isomorphic-git で iOS Safari でも Git を使えるか、計画を詰める"
    title: "iOS Safari での Git の依頼"
    author: human:0x0da160
    last_modified: 2026-11-05T16:48:02Z
  - id: lightning-fs
    resource: "https://www.npmjs.com/package/@isomorphic-git/lightning-fs/v/4.10.5（src/DefaultBackend.js の saveSuperblock・flush・rename、src/IdbBackend.js、README）"
    title: "@isomorphic-git/lightning-fs 4.10.5 のソース"
    author: team:isomorphic-git
    last_modified: 2026-11-05T00:00:00Z
  - id: isomorphic-git
    resource: "https://www.npmjs.com/package/isomorphic-git/v/1.44.11（index.js の _init・readObjectPacked）"
    title: "isomorphic-git 1.44.11 のソース"
    author: team:isomorphic-git
    last_modified: 2026-11-05T00:00:00Z
  - id: webkit-writable
    resource: "https://bugs.webkit.org/show_bug.cgi?id=231706（Safari 26 のリリースノートで File System WritableStream API の対応が告知されたとするコメント）"
    title: "WebKit Bug 231706：File System 標準の実装"
    author: team:webkit
    last_modified: 2026-11-05T00:00:00Z
  - id: webkit-itp
    resource: "https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/（7 日間操作のないサイトのスクリプト書き込み可能なストレージの消去）"
    title: "WebKit：Full Third-Party Cookie Blocking and More"
    author: team:webkit
    last_modified: 2020-03-24T00:00:00Z
---
# 状態

**計画（未決定）。** 実装はしていない。本文の「未決事項」を 0x0da160 が決めてから、段階 0 の実機検証に進む。依頼は「LightningFS と isomorphic-git で iOS Safari でも Git を使えるか」[^request-2026-11-05-ios]。

# 結論

- **成立する見込みはある。ただし「フォルダを開いて編集する」CMS から「ブラウザの中に作業場所を持ち、手元のフォルダとは取り込み・書き出しでやり取りする」CMS に変わる。** iOS Safari には `showDirectoryPicker` がなく、実フォルダ（ファイル App・iCloud Drive）を読み書きし続ける手段がないため。
- **保存先は LightningFS より OPFS（Origin Private File System）を第一候補にする。** CMS のファイル操作はすべて `DirHandleLike`（`src/lib/fs/types.ts`）という File System Access API の形を通っており、OPFS の `navigator.storage.getDirectory()` が返すハンドルはこの形をそのまま満たす。LightningFS は Node の `fs` の形なので、包む層を新たに書く必要があり、後述の永続化の遅れもある。LightningFS は、OPFS の書き込み（`createWritable`）が対象の iOS で使えないと分かった場合の代替とする。
- **Git は自前の Git 層（`src/lib/git/`）をそのまま使う。** isomorphic-git に切り替える理由のうち、iOS で消えるのは「Chromium が `.git/config`・`.git/hooks` への書き込みを禁止する」ことだけで、pack 全体の読み込みと `Buffer` の同梱は残る。デスクトップと iOS で別の Git 実装を持つと、相互運用試験が二重になる。例外は、iOS から GitHub へ push したい場合（未決事項 4）。
- **最大の危険はデータの消去。** OPFS も IndexedDB も Safari の「スクリプトが書き込めるストレージ」で、ブラウザでの利用では 7 日間操作がないと消されうる[^webkit-itp]。ホーム画面に追加した Web アプリとして使うこと、`navigator.storage.persist()` を求めること、書き出し（バックアップ）を習慣にさせる表示を組み合わせる。それでも「端末の中だけにある記事」は保証できないことを仕様に書く。

# 1. 何が File System Access API と Chrome・Edge に依存しているか

## 1.1 コード

| 場所 | 依存 | iOS での扱い |
|---|---|---|
| `src/lib/fs/types.ts` | `DirHandleLike`・`FileHandleLike`・`WritableLike`。File System Access API の最小の形 | **そのまま使える。** OPFS のハンドルは同じ形。`queryPermission`・`requestPermission` は OPFS にないが、既に省略可能として扱っている |
| `src/lib/app/workspace.svelte.ts` の `openFolder`（249 行目付近） | `showDirectoryPicker({ mode: "readwrite" })` でルートを得る | OPFS の中の作業場所（例 `workspaces/<名前>/`）を選ぶ画面に置き換える。以降は同じ `DirHandleLike` を渡すので、記事一覧・保存・画像・Git の処理は変えない |
| 同 `pickBackupRoot`（936 行目付近） | 削除前の退避先を `showDirectoryPicker` で選ぶ（第19章） | OPFS の作業場所の外（例 `backups/`）を退避先にする。`isSameEntry`・`resolve` による重なりの判定（`src/lib/fs/backup.ts`）は OPFS でも使える |
| `src/lib/app/recent-folder.ts` | ディレクトリハンドルを IndexedDB に保存し、権限を問い直す（ADR-0005） | OPFS では権限の問い直しが要らない。最後に開いた作業場所の名前だけを覚える |
| `src/lib/capabilities.ts` | `showDirectoryPicker` と `FileSystemFileHandle.prototype.createWritable` がなければ非対応として編集させない | 「実フォルダ」と「ブラウザ内の作業場所」の 2 系統に分け、どちらかが成り立てば起動する。`navigator.storage.getDirectory` を検査に加える |
| `src/lib/git/gitfs.ts` | `DirHandleLike` を通して `.git/` だけに書く。`BROWSER_BLOCKED_MESSAGE` は Chromium の `.git/config` 書き込み禁止の説明 | **そのまま使える。** OPFS には Chromium の禁止（ADR-0004 の緊張点 11）がない見込みなので、`.git/config` を作れる（段階 0 で確認） |
| `src/lib/git/objects.ts` | `crypto.subtle.digest("SHA-1")`、`CompressionStream`・`DecompressionStream("deflate")` | Safari 16.4 以降にある。安全なコンテキスト（https）が要る |
| `src/lib/drafts/store.ts` | 復旧ドラフトを IndexedDB に保存 | そのまま使える。ただし記事本体と同じオリジンのストレージに入るため、消去されるときは一緒に消える（第4章） |
| ビルド（`vite-plugin-singlefile`、`build/release.ts` の CSP 算出） | 単一 HTML を `file://` で開く前提 | iOS は `file://` で HTML を開いて実行できないため、https で配信する。単一 HTML のまま配信でき、オフライン用に Service Worker とマニフェストを足す |
| `src/lib/fs/optimize.ts`（ADR-0005） | `OffscreenCanvas` で WebP・JPEG に再エンコード | Safari が WebP を書き出せるかは未確認。書き出せなければ派生画像を JPEG・PNG だけにする（段階 0） |
| `src/components/VisualEditor.svelte`（ADR-0005） | `contenteditable` と `document.execCommand` | iOS の日本語入力・選択操作での挙動は未確認（段階 0） |

## 1.2 仕様

| 章 | 現在の記述 | iOS での問題 |
|---|---|---|
| [第1章](/spec/foundation/01-purpose.md) | 単一 HTML をデスクトップブラウザで `file://` 起動する | iOS は対象外。https 配信が要る |
| [第2.1節](/spec/foundation/02-environment-and-gates.md) | デスクトップ版 Chrome・Edge、Windows・macOS。Safari・モバイルは動作保証対象外。外部 CDN 非依存、サーバー不要 | 対応環境の追加。「サーバー不要」を「静的配信のみ・通信は配布物の取得だけ」に改める |
| [第2.2節](/spec/foundation/02-environment-and-gates.md) | TG01〜TG12 を Chrome・Edge、Windows・macOS で分けて記録 | iOS Safari（ブラウザ・ホーム画面）の記録欄を足す。TG01・TG02・TG05・TG10・TG11 は意味が変わる |
| [第29.1節](/spec/foundation/29-technology-candidates-and-records.md) | ファイルアクセスは File System Access API の `showDirectoryPicker`、Git は isomorphic-git と実フォルダ用 fs アダプター | OPFS（または LightningFS）を候補に加える |
| [第31章](/spec/git/31-fs-adapter-contract.md) | 実フォルダ用 fs アダプターの意味論表 | OPFS 用の表を別に作る。rename・ロック・mode の扱いが実フォルダと違う |
| [第12章](/spec/editing/12-concurrency-and-external-changes.md) | 外部変更の検出、タブ間検出はベストエフォート | OPFS は外部のアプリから変わらない。変わるのは別タブと取り込みだけになる |
| [第19章](/spec/deletion/19-article-deletion-and-backup.md) | リポジトリ外の退避ディレクトリをユーザーが明示選択する | 同じオリジンの別領域になる。「リポジトリ外」ではあるが「端末のストレージ消去からは守られない」ことを書く |
| [第33章](/spec/editing/33-recovery-drafts.md) | 復旧ドラフトはブラウザ内。保存先がブラウザ内であることを説明する | 記事本体もブラウザ内になるため、復旧ドラフトは「本体が消えたときの備え」にならない |
| [第35章](/spec/assurance/35-guarantee-boundaries.md) | 保証の境界 | 「iOS ではブラウザが作業場所を消すことがある。書き出したものだけが端末の外に残る」を追加 |
| [第16章](/spec/security/16-trust-boundary-preview-network.md)・[第32章](/spec/security/32-boundaries-and-untrusted-input.md) | `file://` 前提の隔離と通信禁止 | https オリジンでの CSP・プレビュー隔離を見直す。取り込む zip は未信頼入力として扱う |
| [第26章](/spec/quality/26-acceptance-tests.md) | A01：Chrome・Edge、Windows・macOS で起動 | iOS の受け入れ試験を追加 |
| [第27章](/spec/foundation/27-mvp-and-roadmap.md)・[第28章](/spec/foundation/28-out-of-scope.md) | MVP と対象外 | iOS 対応を MVP の後の段階として載せる |

# 2. データの置き場所と、手元のフォルダとのやり取り

## 2.1 iOS での置き場所

```
OPFS のルート
├─ workspaces/
│   └─ <作業場所の名前>/        ← これまでの「選択したフォルダ」と同じ構成（第3章）
│       ├─ cms.config.json
│       ├─ content/ …           ← 記事（Markdown）
│       ├─ media/ …             ← 画像と派生画像
│       └─ .git/                ← 自前の Git 層が書く
├─ backups/                     ← 削除前の退避（第19章）
└─ meta.json                    ← 最後の書き出し日時など（作業場所ごと）
IndexedDB
├─ 復旧ドラフト（既存、src/lib/drafts/store.ts）
└─ 設定（既存の kotono-cms-settings）
```

- 作業場所の中身は、デスクトップで開くフォルダと同じ構成にする。そうすれば記事・画像・Git の処理は変えずに済み、書き出した zip をデスクトップでそのまま開ける。
- 作業場所は複数持てるようにする（サイトごと）。最初は 1 つでもよい（未決事項 6）。

## 2.2 取り込み（手元 → iOS）

| 方法 | 内容 | 判断 |
|---|---|---|
| zip の取り込み | ファイル App・iCloud Drive の zip を `<input type="file">` で選び、`.git/` を含めて作業場所へ展開する | **推奨。** デスクトップの CMS に「zip で書き出す」を足せば、往復が同じ形式になる |
| 空の作業場所 | 新規作成し、必要なら Git を初期化する | 必須 |
| フォルダの選択 | iOS の Safari は `webkitdirectory` によるフォルダ選択に対応していない見込み | 採用しない（段階 0 で確認） |
| clone | GitHub などから取得 | 仕様 20.1 で対象外。採るなら isomorphic-git と CORS の問題が出る（未決事項 4） |

展開は未信頼入力の処理として扱う（第32章・第34章）。パスの検査（`checkGitPath` と同じ規則に加え、zip 特有の絶対パス・`..`・重複・大文字小文字の衝突）、展開後の合計サイズ・件数・1 件のサイズの上限、圧縮率の上限（zip 爆弾）、既存の作業場所への上書きをしない（新しい作業場所へ展開する）を必須とする。zip の読み書きは `DecompressionStream("deflate-raw")` を使った自前の実装か、小さな依存（fflate など）にする（未決事項 7）。

## 2.3 書き出し（iOS → 手元）

- 作業場所を `.git/` ごと zip にし、共有シート（`navigator.share` のファイル共有）または `<a download>` でファイル App・iCloud Drive へ保存する。
- デスクトップへ戻すときは、**zip を展開して上書きするのではなく、ネイティブ Git で取り込む**手順を案内する（例：展開したフォルダを remote にして `git pull`）。iOS 側のコミット履歴が残るので、デスクトップ側の変更と Git で合流できる。CMS 自身はマージをしない（仕様 20.1 の対象外のまま）。
- コミットしていない変更も zip に入る（作業ツリーごと書き出すため）。書き出し前に未コミットの記事を表示する。

## 2.4 消去の危険とバックアップ

| 危険 | 内容 | 対策 |
|---|---|---|
| 7 日間の消去 | Safari は、ブラウザで 7 日間操作のなかったサイトのスクリプト書き込み可能なストレージ（IndexedDB を含む）を消す[^webkit-itp]。OPFS も同じ扱いの見込み | ホーム画面に追加して使うよう案内する（ホーム画面の Web アプリは Safari とは別に数える）。段階 0 で、ホーム画面からの利用で消えないことを確かめる |
| 容量・端末の空き不足 | 端末の空きが少ないとブラウザがデータを消すことがある | `navigator.storage.persist()` を求め、結果を表示する。`navigator.storage.estimate()` で使用量を示す。拒否されたら「消えることがある」状態として常に表示する |
| ユーザーの操作 | 設定の「履歴と Web サイトデータを消去」、ホーム画面のアプリの削除 | 防げない。説明に書く |
| オリジンの変更 | 配信元の URL が変わると別の保存領域になり、見えなくなる | 配信元を固定する。他の用途と共有しない専用のオリジンにする（第5章） |

バックアップの方針：

1. **書き出しを唯一の確実なバックアップとする。** 最後の書き出し日時を作業場所ごとに記録し、書き出し後にコミットや保存があれば「未書き出しの変更あり（○日前から）」を画面上部に出し続ける。
2. 一定日数（例 3 日）書き出していなければ、起動時に書き出しを促す。閉じても次回また出る。
3. 復旧ドラフトは同じストレージにあるため、消去への備えにならないと説明を改める。
4. push による自動バックアップは仕様の対象外。必要なら未決事項 4 で決める。

# 3. 仕様と ADR の変更箇所

方針：仕様書の原本（`docs/spec/`）と転記（`spec/`）は改変せず、ADR-0005 と同じく仕様との差を ADR に記録する。対象環境の追加は仕様の改訂に当たるため、改訂版を作るかどうかは未決事項 1。

| 対象 | 変更 |
|---|---|
| 第2.1節 対応環境 | 行を追加：「iOS・iPadOS の Safari（版は検証記録で固定）。ホーム画面に追加した Web アプリとしての利用を推奨。保存先はブラウザ内の作業場所。実フォルダは扱わない」。「起動」は「デスクトップは `file://`、iOS は固定オリジンからの https 配信」。「ローカルサーバー：不要」は維持し、「静的ファイルの配信元が 1 つ必要（iOS のみ）。配布物の取得以外の通信をしない」を加える。「Firefox・Safari・モバイル」の対象外の行から iOS Safari を除く |
| 第2.2節 技術成立性ゲート | iOS Safari の列を追加。TG01（フォルダ選択→作業場所の作成・取り込み・書き出し）、TG02（OPFS 用アダプターと Git）、TG05（シンボリックリンクなし。OPFS では該当なしと記録）、TG10（復旧ドラフトと本体が同じストレージ）、TG11（退避先が同じストレージ）を iOS 向けに書き直す。新しいゲート TG13「ブラウザ内ストレージの永続性（消去条件・persist の結果・容量）」を追加 |
| 第12章 | OPFS では外部アプリによる変更がない。別タブ・取り込みによる変更の検出に絞る |
| 第19章 | 退避先が同じオリジンの別領域であることと、その限界 |
| 第29.1節・第31章 | OPFS 用 fs アダプターの意味論表（rename・ロック・sync の扱い）。LightningFS を採る場合はその表 |
| 第33章・第35章 | 本体もブラウザ内にあるときの保証の境界と、書き出しの位置づけ |
| 第16章・第32章・第34章 | https オリジンでの CSP、Service Worker の範囲、zip の取り込みの入口別予算 |
| 第26章・第27章・第28章 | iOS の受け入れ試験、ロードマップへの追加 |
| ADR-0001 | 配布形態に https 配信版（同じ単一 HTML＋マニフェスト＋Service Worker）を追加 |
| ADR-0004 | 緊張点 11（`.git/config` の禁止）が OPFS では当てはまらないこと。OPFS での相互運用試験 |
| ADR-0005 | 前回のフォルダの記憶（iOS では作業場所の名前だけ）、WebP の書き出し、`contenteditable` の iOS での検証 |
| 本 ADR | 未決事項が決まったら「決定」に改め、`status` を更新する |

# 4. Git 層：自前の実装か isomorphic-git か

**自前の Git 層を使い、保存先を OPFS にする。** 確かめたこと：

1. **自前の Git 層は保存先に依存していない。** `src/lib/git/gitfs.ts` の `GitFs` はコンストラクタで `DirHandleLike` を受け取るだけで、`showDirectoryPicker` を呼ばない。単体試験と E2E は既にメモリ上の疑似ハンドルで動いている（`tests/unit/support/memory-fs.ts`・`tests/e2e/fake-fs.ts`）。OPFS のハンドルを渡せば同じ処理になる。
2. **isomorphic-git を退けた理由のうち、iOS で消えるのは 1 つだけ。** ADR-0004 の理由 1（`init` が `.git/hooks`・`.git/config` を作り、Chromium が禁止する）は、isomorphic-git 1.44.11 の `_init` が `hooks` を含むフォルダを作り `config` を書くことを再確認した[^isomorphic-git]。OPFS・LightningFS ではこの禁止がないので、iOS では理由にならない。一方、理由 2（`readObjectPacked` が `.idx` から見つけた `.pack` を丸ごと読む）と理由 3（`Buffer` の代替の同梱と約 270 KB の増加）は保存先に関係なく残る。
3. **LightningFS は書いた直後の中断に弱い。** 4.10.5 のソースでは、ファイルの中身は書くたびに IndexedDB へ入るが、ディレクトリの木（superblock）は 500 ms の debounce の後にまとめて保存する（`DefaultBackend.js` の `saveSuperblock`）[^lightning-fs]。`mkdir`・`rename`・`stat` はメモリ上の操作で、保存されるまでの間にタブが閉じられると、中身はあるのに木から見えないファイルや、ref の更新が失われた状態になりうる。`flush()` を毎回呼べば狭められるが、第31.2節の「close 前後の中断で誤成功を起こさない」を満たすことは別途の試験が要る。OPFS は `createWritable` の `close()` でファイルごとに反映されるので、現在の実フォルダと同じ説明（原子性は保証しないが、close 後は反映済み）で済む見込み。
4. **LightningFS の `rename` はメモリ上で原子的だが、自前の Git 層は rename を使っていない。** ADR-0004 の書き込み順（object → index → tree・commit → ref と読み直し）は rename なしで設計してあるので、LightningFS の rename は利点にならない。
5. **二つの実装を持つ費用。** iOS だけ isomorphic-git にすると、ネイティブ Git との相互運用試験（`tests/unit/git.test.ts`）・対応構成の判定（`inspect`）・上限（第34章）を二重に持つことになる。

**isomorphic-git を選ぶ価値があるのは、iOS から GitHub などへ push・pull したい場合だけ。** その場合も、ローカルの読み書きは自前の層のまま、送受信だけを isomorphic-git の HTTP 実装に任せる形を先に検討する（CORS のため、GitHub へはプロキシが要る。仕様 20.1 は CORS プロキシを対象外にしている）。

**LightningFS を使うのは、OPFS の `createWritable` が対象の iOS で使えない場合。** Safari 26 で File System の WritableStream に対応したとされる[^webkit-writable]が、iOS 26 未満も対象にするなら使えない。その場合は、LightningFS の上に `DirHandleLike` を実装する包み層（推定 300〜500 行）を書き、書き込みごとに `flush()` を呼ぶ。

# 5. 規模の見積もり

1 人で作業した場合の目安。段階 0 の結果で後の段階が増減する。

| 段階 | 内容 | 目安 |
|---|---|---|
| 0. 実機検証 | iPhone・iPad の Safari（ブラウザとホーム画面）で：OPFS の `createWritable`・`removeEntry`・`values`・`isSameEntry`・`resolve`・`getFile().lastModified`、`.git/config` の書き込み、`CompressionStream`・SHA-1、`persist()` の結果、容量、7 日後の消去、zip の取り込みと共有シートでの書き出し、`OffscreenCanvas` の WebP、`contenteditable` と日本語入力。小さな検証用ページで記録する | 2〜3 日 |
| 1. 保存先の切り替え | 起動時の能力検査を 2 系統に分ける。作業場所の作成・選択・削除の画面。`openFolder`・`pickBackupRoot`・前回の記憶を OPFS に対応させる。記事・画像・Git の処理は変えない | 3〜5 日 |
| 2. 取り込みと書き出し | zip の読み書き（上限・パス検査を含む）、共有シート、最後の書き出し日時と警告、`persist()` と使用量の表示。デスクトップ側にも zip の書き出し・取り込みを足す | 5〜7 日 |
| 3. 配信 | https 配信用のビルド、マニフェスト、Service Worker（オフライン起動と更新の扱い）、CSP の見直し、専用オリジンの用意 | 3〜4 日 |
| 4. 画面 | iPhone の幅での一覧と編集の切り替え、タッチ操作、ソフトウェアキーボードで隠れる部分、見たまま編集の調整。現在の画面は 60rem（960px）未満で一覧と編集を切り替える作りがあり、iPad の横向きは今の画面に近い | iPad のみ 3〜5 日／iPhone も 7〜12 日 |
| 5. 試験 | Playwright の WebKit での E2E（iOS の Safari そのものではない）、OPFS 用アダプターの意味論表、OPFS に書いた `.git` をネイティブ Git で検証する試験、実機でのゲートの記録 | 4〜6 日 |
| 6. 仕様・ADR | 第3章の変更 | 1〜2 日 |
| 合計 | | iPad のみ：約 4〜5 週間／iPhone も：約 5〜7 週間 |

LightningFS を使うことになった場合は段階 1 に 3〜4 日を足す。push を加える場合は別に 2〜3 週間（認証・CORS・プロキシの用意を含む）。

# 6. 未決事項（0x0da160 が決める）

1. **対応環境を正式に広げるか。** 仕様 3.1 の改訂（3.2）として iOS を対応環境に入れるか、ADR に差を記録した「試験的な対応」に留めるか。推奨：まず試験的な対応とし、段階 0 の結果で改訂を判断する。
2. **対象の端末と版。** iPad だけか、iPhone も含めるか。対象の iOS の最低版（OPFS の書き込みに Safari 26 以降が要る見込み。それより古い版も対象なら LightningFS が要る）。推奨：iPad、iOS 26 以降。
3. **配信元。** iOS は `file://` で開けないため、https の配信元が要る。GitHub Pages を使う場合、`<user>.github.io` のオリジンは同じアカウントの他のリポジトリのページと保存領域・権限を共有するので、専用の独自ドメイン（またはサブドメイン）にすべき。どこで配信するか。
4. **iOS から GitHub へ push するか。** しないなら Git はローカルの記録だけで、端末の外へ出す手段は zip の書き出しになる。するなら isomorphic-git の送受信、トークンの保管、CORS プロキシが要り、仕様 20.1 の対象外を変えることになる。推奨：最初はしない。
5. **デスクトップとの往復の形。** 推奨は「zip（`.git` を含む）を書き出し、デスクトップではネイティブ Git で取り込む」。CMS に Git での取り込み（fetch とマージ）を持たせないことでよいか。
6. **作業場所の数。** 1 つ（単一サイト）か、複数か。推奨：最初から複数（構造は同じで、選ぶ画面が 1 つ増えるだけ）。
7. **zip の実装。** 自前（`DecompressionStream("deflate-raw")` を使う）か、小さな依存（fflate など）か。推奨：依存を固定版で入れ、上限とパス検査は CMS 側で行う。
8. **LightningFS をどう位置づけるか。** 本 ADR は OPFS を第一候補にし、LightningFS は代替としている。依頼の文言どおり LightningFS を使う理由（たとえば既存の isomorphic-git の例に合わせたい）があれば知らせてほしい。

[^request-2026-11-05-ios]: iOS Safari での Git の依頼
[^isomorphic-git]: isomorphic-git 1.44.11 のソース
[^lightning-fs]: @isomorphic-git/lightning-fs 4.10.5 のソース
[^webkit-writable]: WebKit Bug 231706：File System 標準の実装
[^webkit-itp]: WebKit：Full Third-Party Cookie Blocking and More
