---
type: Architecture Decision
title: "ADR-0006（案）iOS Safari で記事と Git を扱うための計画"
description: "iOS Safari（iPhone・iPad）で記事の編集とローカル Git を使えるようにする計画。File System Access API への依存の洗い出し、ブラウザ内ストレージ（OPFS または LightningFS）への置き換え、取り込みと書き出し、消去の危険とバックアップ、仕様の変更箇所、Git 層の選択、暗号化とパスキー、GitHub の REST API による push・pull、段階ごとの規模と未決事項。実装はしない。"
tags: ["iOS", "Safari", "OPFS", "LightningFS", "IndexedDB", "Git", "対応環境", "暗号化", "パスキー", "GitHub", "計画", "未決定", "要検証"]
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
  - id: request-2026-11-05-ios-decisions
    resource: "0x0da160 の回答（2026-11-05）：iPhone も含める。配信は暫定で github.io、将来は専用ドメイン。可能ならデータを暗号化し、パスキーに対応する。push はしたいが CORS のためできないと認識している"
    title: "iOS 対応の未決事項への回答"
    author: human:0x0da160
    last_modified: 2026-11-05T23:42:02Z
  - id: request-2026-11-05-ios-decisions-2
    resource: "0x0da160 の回答（2026-11-05）：将来専用ドメインへ移るので今は Organization を分けない（開発中）。ファイル名も暗号化する"
    title: "配信元とファイル名の暗号化への回答"
    author: human:0x0da160
    last_modified: 2026-11-05T23:58:41Z
  - id: github-cors
    resource: "https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests（REST API は任意のオリジンからの CORS に対応し、応答例に Access-Control-Allow-Origin: * がある）"
    title: "GitHub Docs：Using CORS and JSONP to make cross-origin requests"
    author: team:github
    last_modified: 2026-11-05T00:00:00Z
  - id: github-smart-http
    resource: "Origin を付けた https://github.com/0x0da160/kotono-cms.git/info/refs?service=git-upload-pack への GET（2026-11-05）。200 OK だが Access-Control-Allow-Origin がない"
    title: "github.com の Git の HTTP 通信が CORS に対応しないことの確認"
    author: claude-code/2.1.318
    last_modified: 2026-11-05T23:50:00Z
  - id: webauthn-prf
    resource: "https://www.corbado.com/blog/passkeys-prf-webauthn（Safari 18・iOS 18 で iCloud キーチェーンのパスキーが PRF に対応。iOS 18.0〜18.3 の不具合は 18.4 で修正とする第三者の調査）"
    title: "Passkeys & WebAuthn PRF for End-to-End Encryption"
    author: team:corbado
    last_modified: 2026-11-05T00:00:00Z
---
# 状態

**計画（一部決定）。** 実装はしていない。依頼は「LightningFS と isomorphic-git で iOS Safari でも Git を使えるか」[^request-2026-11-05-ios]。0x0da160 の回答[^request-2026-11-05-ios-decisions]で次が決まった（第6.1節）。

- 対象は iPad と iPhone。
- 配信は暫定で `github.io`、将来は専用ドメインへ移る。できるならデータを暗号化し、パスキーに対応する（第7章）。
- iOS から GitHub へ push したい（第8章：CORS を避ける方法がある）。

残りの未決事項（第6.2節）が決まったら、段階 0 の実機検証に進む。

# 結論

- **成立する見込みはある。ただし「フォルダを開いて編集する」CMS から「ブラウザの中に作業場所を持ち、手元のフォルダとは取り込み・書き出しでやり取りする」CMS に変わる。** iOS Safari には `showDirectoryPicker` がなく、実フォルダ（ファイル App・iCloud Drive）を読み書きし続ける手段がないため。
- **保存先は LightningFS より OPFS（Origin Private File System）を第一候補にする。** CMS のファイル操作はすべて `DirHandleLike`（`src/lib/fs/types.ts`）という File System Access API の形を通っており、OPFS の `navigator.storage.getDirectory()` が返すハンドルはこの形をそのまま満たす。LightningFS は Node の `fs` の形なので、包む層を新たに書く必要があり、後述の永続化の遅れもある。LightningFS は、OPFS の書き込み（`createWritable`）が対象の iOS で使えないと分かった場合の代替とする。
- **Git は自前の Git 層（`src/lib/git/`）をそのまま使う。** isomorphic-git に切り替える理由のうち、iOS で消えるのは「Chromium が `.git/config`・`.git/hooks` への書き込みを禁止する」ことだけで、pack 全体の読み込みと `Buffer` の同梱は残る。デスクトップと iOS で別の Git 実装を持つと、相互運用試験が二重になる。GitHub への push も isomorphic-git なしで行える。GitHub の Git の通信（`github.com/<repo>.git`）は CORS に対応しないが、REST API（`api.github.com`）は対応しているので、REST API の Git Data（blob・tree・commit・ref）で送る（第8章）。
- **最大の危険はデータの消去。** OPFS も IndexedDB も Safari の「スクリプトが書き込めるストレージ」で、ブラウザでの利用では 7 日間操作がないと消されうる[^webkit-itp]。ホーム画面に追加した Web アプリとして使うこと、`navigator.storage.persist()` を求めること、書き出し（バックアップ）を習慣にさせる表示を組み合わせる。それでも「端末の中だけにある記事」は保証できないことを仕様に書く。GitHub への push ができれば、それが主なバックアップになる。
- **暗号化とパスキーは成り立つ見込み。** 作業場所の中身をアプリが鍵で暗号化して保存し、鍵はパスキーの PRF 拡張で開ける。パスキーを失ったときのために回復コードを必ず作る（第7章）。

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
- 作業場所は複数持てるようにする（サイトごと）。最初は 1 つでもよい（未決事項 9）。

## 2.2 取り込み（手元 → iOS）

| 方法 | 内容 | 判断 |
|---|---|---|
| zip の取り込み | ファイル App・iCloud Drive の zip を `<input type="file">` で選び、`.git/` を含めて作業場所へ展開する | **推奨。** デスクトップの CMS に「zip で書き出す」を足せば、往復が同じ形式になる |
| 空の作業場所 | 新規作成し、必要なら Git を初期化する | 必須 |
| フォルダの選択 | iOS の Safari は `webkitdirectory` によるフォルダ選択に対応していない見込み | 採用しない（段階 0 で確認） |
| GitHub から取得 | REST API で既存のリポジトリを取り込む（第8章の pull を空の作業場所に行う） | push・pull と同じ段階で入れる |

展開は未信頼入力の処理として扱う（第32章・第34章）。パスの検査（`checkGitPath` と同じ規則に加え、zip 特有の絶対パス・`..`・重複・大文字小文字の衝突）、展開後の合計サイズ・件数・1 件のサイズの上限、圧縮率の上限（zip 爆弾）、既存の作業場所への上書きをしない（新しい作業場所へ展開する）を必須とする。zip の読み書きは `DecompressionStream("deflate-raw")` を使った自前の実装か、小さな依存（fflate など）にする（未決事項 10）。

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
4. GitHub へ push できれば、それが端末の外の主なバックアップになる（第8章）。最後の push 日時も書き出しと同じように表示する。

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
5. （決定済み：第6.1節。回復コードと任意のパスフレーズ）

**push・pull のためにも isomorphic-git は要らない。** isomorphic-git の送受信は Git の HTTP 通信を使うため、ブラウザからは CORS プロキシが要る（github.com はこの通信に `Access-Control-Allow-Origin` を返さないことを確認した[^github-smart-http]）。GitHub に限れば、CORS に対応した REST API で同じことができる（第8章）。

**LightningFS を使うのは、OPFS の `createWritable` が対象の iOS で使えない場合。** Safari 26 で File System の WritableStream に対応したとされる[^webkit-writable]が、iOS 26 未満も対象にするなら使えない。その場合は、LightningFS の上に `DirHandleLike` を実装する包み層（推定 300〜500 行）を書き、書き込みごとに `flush()` を呼ぶ。

# 5. 規模の見積もり

1 人で作業した場合の目安。iPhone を含め、暗号化と GitHub への push・pull を入れた場合。段階 0 の結果で後の段階が増減する。

| 段階 | 内容 | 目安 |
|---|---|---|
| 0. 実機検証 | iPhone・iPad の Safari（ブラウザとホーム画面）で：OPFS の `createWritable`・`removeEntry`・`values`・`isSameEntry`・`resolve`・`getFile().lastModified`、`.git/config` の書き込み、`CompressionStream`・SHA-1、`persist()` の結果、容量、7 日後の消去、zip の取り込みと共有シートでの書き出し、`OffscreenCanvas` の WebP、`contenteditable` と日本語入力。加えて、パスキーの PRF（作成・取得・別の端末で同期したパスキーで同じ値になるか）と、REST API での commit が手元と同じ ID になるか。小さな検証用ページで記録する | 3〜4 日 |
| 1. 保存先の切り替え | 起動時の能力検査を 2 系統に分ける。作業場所の作成・選択・削除の画面。`openFolder`・`pickBackupRoot`・前回の記憶を OPFS に対応させる。記事・画像・Git の処理は変えない | 3〜5 日 |
| 2. 暗号化とパスキー | 暗号化する `DirHandleLike`（第7章）、ファイル名・フォルダ名の暗号化（第7.4節）、鍵の作成・包み直し、パスキーの登録と解錠、回復コード、ロックと自動ロック、復旧ドラフトの暗号化 | 12〜17 日 |
| 3. 取り込みと書き出し | zip の読み書き（上限・パス検査を含む）、共有シート、暗号化した書き出し、最後のバックアップ日時と警告、`persist()` と使用量の表示。デスクトップ側にも zip の書き出し・取り込みを足す | 5〜7 日 |
| 4. GitHub との同期 | REST API での push（fast-forward のみ）・pull（fast-forward のみ）、トークンの保管、送信前の照合、分岐の検出と案内（第8章） | 8〜12 日 |
| 5. 配信 | `github.io` 用のビルド、マニフェスト、Service Worker（オフライン起動と更新の扱い）、CSP の見直し、専用オリジンへの移行手順 | 3〜4 日 |
| 6. 画面 | iPhone の幅での一覧と編集の切り替え、タッチ操作、ソフトウェアキーボードで隠れる部分、見たまま編集の調整。現在の画面は 60rem（960px）未満で一覧と編集を切り替える作りがあり、iPad の横向きは今の画面に近い | 7〜12 日 |
| 7. 試験 | Playwright の WebKit での E2E（iOS の Safari そのものではない）、OPFS 用アダプターの意味論表、OPFS に書いた `.git` をネイティブ Git で検証する試験、暗号化の往復と改ざん検出、REST API の模擬サーバーでの push・pull、実機でのゲートの記録 | 6〜8 日 |
| 8. 仕様・ADR | 第3章の変更と、暗号化・同期の章の追加 | 2〜3 日 |
| 合計 | | 約 10〜14 週間 |

段階 1〜3 と 5〜6 だけ（暗号化と同期なし）なら約 5〜7 週間。段階 2 と 4 は独立しているので、どちらを先にしてもよい。LightningFS を使うことになった場合は段階 1 に 3〜4 日を足す。

# 6. 決定事項と未決事項

## 6.1 決定（2026-11-05、0x0da160）

| 項目 | 決定 | 計画への影響 |
|---|---|---|
| 対象の端末 | iPad と iPhone | 段階 6（画面）を iPhone の幅まで行う |
| 配信元 | 暫定で `github.io`。将来は専用ドメインへ移る | 第7.1節のオリジンの注意と移行手順。暗号化を入れる |
| データの暗号化 | できるならする。パスキーに対応する | 第7章 |
| GitHub への push | したい | 第8章。CORS は REST API で避けられる |
| `github.io` の置き場所 | Organization を分けず、`0x0da160.github.io` の下に置く。開発中の暫定で、公開・本番利用は専用ドメインへ移ってから[^request-2026-11-05-ios-decisions-2] | 第7.1節の注意を開発中の運用で守る |
| 暗号化の範囲 | ファイルの中身に加えて、ファイル名・フォルダ名も暗号化する[^request-2026-11-05-ios-decisions-2] | 第7.4節。段階 2 が増える |
| 仕様上の扱い | iOS を仕様 3.2 の正式な対応環境とする（2026-11-06、決定カードで選択） | 第3章の変更を仕様の改訂版として書く。ゲート（第2.2節）の iOS の記録は最初から必須 |
| iOS の最低版 | iOS・iPadOS 26 以降（2026-11-06、決定カードで選択） | 保存先は OPFS だけにする。LightningFS の代替は作らない |
| パスキー以外の解錠 | 回復コード（必須）と、任意で設定できるパスフレーズ（2026-11-06、決定カードで選択） | 第7.2節の表のとおり。パスフレーズの鍵も DK を包む |
| GitHub の認証 | 対象リポジトリ 1 つの Contents の読み書きだけを許した、有効期限つきの fine-grained personal access token を暗号化して保存（2026-11-06、決定カードで選択） | 第8.4節のとおり |

## 6.2 未決事項（0x0da160 が決める）

1. （決定済み：第6.1節。仕様 3.2 として正式に対応する）
2. （決定済み：第6.1節。iOS 26 以降）
3. （決定済み：第6.1節）
4. （決定済み：第6.1節。中身・名前とも暗号化する）
5. **パスキーが使えないときの解錠方法。** 推奨：回復コード（必須）に加え、パスフレーズを任意で設定できるようにする。
6. （決定済み：第6.1節。1 リポジトリ用の fine-grained personal access token）
7. **デスクトップとの往復。** push・pull ができれば GitHub 経由が主になり、zip は予備（バックアップ・オフライン）になる。デスクトップ版の CMS にも同じ push・pull を入れるか。推奨：入れる（REST API は `file://` からも同じく使える見込みで、段階 0 で確かめる）。入れない場合は、デスクトップではネイティブ Git で push・pull する。
8. **分岐したときの扱い。** iPhone とデスクトップの両方でコミットして GitHub と食い違った場合、CMS はマージしない（仕様 20.1）。推奨：push・pull を止め、分岐を表示し、デスクトップのネイティブ Git で合流してもらう。
9. **作業場所の数。** 推奨：最初から複数（サイトごと）。
10. **zip の実装。** 推奨：小さな依存（fflate など）を固定版で入れ、上限とパス検査は CMS 側で行う。
11. **LightningFS の位置づけ。** 本 ADR は OPFS を第一候補にし、LightningFS は代替としている。

# 7. 暗号化とパスキー

## 7.1 `github.io` に置くときの注意

- オリジンは `https://<アカウント名>.github.io` 単位。同じアカウントの他のリポジトリのページ（`/<他のリポジトリ>/`）は同じオリジンなので、OPFS・IndexedDB の中身を読み書き・削除できる。特に `<アカウント名>.github.io` リポジトリ（ルートのページ）があると、ルートを範囲とする Service Worker を登録でき、CMS のページに割り込める。
- 暗号化は「読まれる」「書き換えられる」ことへの対策になるが、「消される」ことと「CMS のページ自体を差し替えられる」ことは防げない。
- **決定：開発中は `0x0da160.github.io` の下に置き、Organization は分けない。** 専用ドメインへ移るまでの運用として次を守る。
  - 実際の記事は置かない（試験用のデータだけ）。消えても GitHub か書き出しから戻せるものに限る。
  - `0x0da160.github.io` リポジトリ（ルートのページ）を作らない。作る場合は Service Worker を登録しないものに限る。
  - 同じアカウントの他の Pages に、第三者のスクリプト（解析・広告・外部 CDN）を載せない。
  - 画面に「開発版：保存場所は他のページと共有されています」を出す（配信元のホスト名で判定する）。
- 専用ドメインへ移るとオリジンが変わり、保存領域もパスキーも引き継がれない。移行は「旧オリジンで書き出し（暗号化した zip）または push → 新オリジンで取り込みまたは pull → 新オリジンでパスキーを登録し直す」の手順にする。旧オリジンのページは、移行先を案内する版に差し替えてから消す。WebAuthn の Related Origin Requests（`/.well-known/webauthn`）で旧 RP ID のパスキーを使い続けられる可能性があるが、`github.io` では `/.well-known/` の配置に制約があり、Safari の対応も未確認のため、当てにしない。

## 7.2 鍵の構成

| 鍵 | 作り方 | 保存 |
|---|---|---|
| データ鍵（DK） | 作業場所ごとに `crypto.subtle.generateKey`（AES-GCM 256 bit、取り出し不可にはしない：包み直しに使う） | 平文では保存しない。下の鍵で包んで（AES-KW または AES-GCM）`meta.json` に置く |
| パスキー由来の鍵 | WebAuthn の PRF 拡張（`prf.eval.first` に作業場所ごとの salt）で得た 32 バイトを HKDF で AES 鍵にする。RP ID は配信元のホスト名 | パスキーは iCloud キーチェーンが持つ。CMS は credential ID・salt・包んだ DK だけを持つ |
| 回復コード由来の鍵 | 作成時に 128 bit 以上の乱数を表示し、紙・パスワード管理アプリに控えてもらう。PBKDF2-SHA-256（反復回数は段階 0 で測定して決める）で AES 鍵にする | 回復コードは保存しない |
| パスフレーズ由来の鍵（任意） | 回復コードと同じ方式 | 同上 |

- 起動時はロック状態。「パスキーで開く」→ PRF の値で DK を開き、メモリにだけ持つ。一定時間操作がない・タブが隠れたら DK を捨ててロックする（時間は設定）。
- パスキーを消した・別の Apple アカウントに移った等で PRF が使えなくなっても、回復コードで開ける。**回復コードも失うと、データは誰も開けない**ことを作成時に説明し、確認を求める。PRF だけに頼る設計は危険とされているため、回復コードを必須にする。
- パスキーは iCloud キーチェーンで同期されるので、同じ Apple アカウントの iPhone と iPad で同じパスキーが使える見込み（PRF の値が端末間で一致するかは段階 0 で確認）。
- ここでのパスキーは「サーバーへのログイン」ではなく「端末内の鍵を開ける手段」。サーバーは関与しない。

## 7.3 何をどう暗号化するか

- **暗号化する `DirHandleLike` を 1 層挟む。** OPFS のハンドルを包み、`getFile()` で読んだ中身を復号し、`createWritable()` の `close()` で暗号化して書く。上の層（記事・画像・Git）は平文の `DirHandleLike` として扱うので、変更はこの層に閉じる。
- 形式：ファイルごとに `マジック・形式版・12 バイトの IV・暗号文・認証タグ`。追加認証データ（AAD）に作業場所の ID とファイルのパスを入れ、別のパスへの差し替えを検出する。IV はファイルの書き込みごとに乱数で作る。
- 改ざん・破損で復号できないファイルは「読めない」として扱い、上書きしない（第13章・第31章の「失敗時に元を消さない」と同じ）。
- `size` は平文の大きさを返す必要がある（Git の index の比較に使う）。形式の先頭に平文の長さを置くか、暗号文の長さから計算する。`lastModified` は OPFS の値をそのまま使う。
- 大きな画像は一度に暗号化すると一時的にメモリを倍使う。第34章の上限（1 ファイル 64 MiB など）の範囲で一括とし、分割はしない（段階 0 で iPhone のメモリを測る）。
- **ファイル名・フォルダ名も暗号化する**（決定。方式は第7.4節）。
- 復旧ドラフト（IndexedDB）も同じ DK で暗号化する。記事の ID や題名を含むキー・索引も暗号化した値（または DK から作った HMAC）にする。作業場所の表示名は暗号化し、ロック中は「ロック中の作業場所」と作成日時だけを示す。最後の書き出し日時は平文でよい。
- 書き出しの zip は、中身を平文で zip にしたものを DK とは別の鍵（書き出しごとの鍵を回復コードまたはパスフレーズで包む）で暗号化し、`.kotono` のような拡張子にする。デスクトップで開くにはデスクトップ版の CMS での取り込みが要る。平文の zip を書き出す選択肢も残す（確認を挟む）。
- GitHub へ送る内容は平文（GitHub のリポジトリの公開・非公開に従う）。暗号化は端末内とブラウザの保存領域に対するもの。

## 7.4 ファイル名・フォルダ名の暗号化

**方式：名前を 1 区間ずつ、決定的に暗号化する。** フォルダの木の形はそのまま OPFS に残し、各区間の名前だけを暗号文に置き換える。

- 鍵：DK から HKDF で名前用の鍵 2 つ（IV 用の HMAC 鍵 `Kiv` と暗号化用の AES-GCM 鍵 `Kname`）を作る。
- 暗号化：`IV = HMAC-SHA256(Kiv, 親フォルダの平文パス ‖ 0x00 ‖ 名前)` の先頭 12 バイトとし、`AES-GCM(Kname, IV, 名前を 16 バイト単位に詰めたもの)` の結果を、IV と合わせて base32（小文字・パディングなし）にする。同じ親・同じ名前からは必ず同じ暗号文になるので、`getFileHandle(名前)`・`getDirectoryHandle(名前)` は暗号化した名前を引くだけで済み、対応表が要らない。IV が名前ごとに違うので、Web Crypto に AES-SIV がなくても、同じ IV と鍵で別の内容を暗号化することは起きない。
- 復号：`values()` で得た名前を復号し、認証タグが合わないもの（CMS が作っていないもの・壊れたもの）は「読めない項目」として上の層に渡さず、件数を表示する。勝手に消さない。
- 親のパスを IV に含めるので、同じ名前でも別のフォルダでは別の暗号文になる。フォルダを別の場所へ移すと名前を作り直す必要があるが、CMS は rename を使わない（第4章）ので問題にならない。
- **対応表（一覧ファイル）方式は採らない。** 名前を乱数にして対応表を 1 つのファイルに持つ方式は木の形も隠せるが、対応表が壊れる・書きかけで止まると作業場所全体が読めなくなる。OPFS には原子的な置き換えがないため、第31.2節の中断安全性を満たしにくい。区間ごとの方式なら、壊れても影響はその項目だけで済む。

**名前の長さ：** 長い日本語の slug は UTF-8 で 1 文字 3 バイトになり、暗号化と base32 で約 1.6 倍以上に増える。OPFS の名前の上限（段階 0 で測る。255 バイト前後の見込み）を超える場合は、暗号化した名前の HMAC（先頭 26 文字）を名前にし、元の暗号化した名前を同じフォルダの小さなファイル（`<HMAC>.n`）に置く。このファイルが読めない項目は上と同じく「読めない項目」にする。

**隠せないこと（仕様に書く）：**

- フォルダの木の形（深さ・各フォルダの項目数）と、各ファイルの大きさ（中身の暗号化でも、パディングをしない限り近い値が分かる）、更新日時。
- 名前のおおよその長さ（16 バイト単位に詰めるので、16 バイト刻みまで）。
- `.git/objects/<2 文字>/<38 文字>` のような名前は、暗号化しても区間の数と項目数から「Git の object が何個あるか」が分かる。

**影響する箇所：**

| 箇所 | 対応 |
|---|---|
| 暗号化する `DirHandleLike` | 名前の暗号化・復号、`values()` での読めない項目の除外、`name` プロパティは平文を返す |
| `resolve`・`isSameEntry`（`src/lib/fs/backup.ts`） | OPFS の `resolve` が返す暗号化した区間を、親から順に復号して平文のパスに戻す |
| 名前の検査（`checkGitPath`、slug の規則、大文字小文字・Unicode 正規化の衝突） | 暗号化の前の平文に対して行う。OPFS では暗号化した名前同士が衝突しないので、正規化の衝突の検査は平文の側で CMS が行う必要がある（同じ親で NFC にすると同じになる名前を拒否する） |
| 取り込み・書き出しの zip | zip の中は平文の名前（zip 全体を暗号化する：第7.3節）。展開時に暗号化して OPFS に書く |
| 作業場所のフォルダ名（`workspaces/<名前>/`） | 作業場所ごとに乱数の ID をフォルダ名にし、表示名は暗号化して `meta.json` に置く |
| 段階 0 | OPFS の名前の上限と使える文字、`values()` の順序、名前が長いときの性能 |

規模：段階 2 に 5〜7 日を足す。

# 8. GitHub への push・pull

## 8.1 CORS について

認識のとおり、Git の通常の通信（`https://github.com/<owner>/<repo>.git` の `info/refs`・`git-upload-pack`・`git-receive-pack`）は CORS に対応していない。`Origin` を付けて `info/refs` を取得すると 200 が返るが `Access-Control-Allow-Origin` がなく、ブラウザは応答を読めない[^github-smart-http]。isomorphic-git が CORS プロキシを前提にしているのはこのため。

一方、**GitHub の REST API（`api.github.com`）は任意のオリジンからの CORS に対応している**[^github-cors]。REST API の Git Data（blob・tree・commit・ref）を使えば、プロキシなしで push・pull と同じことができる。GitHub 以外（GitLab 等）は対象外とする。

## 8.2 push（fast-forward のみ）

1. `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` でリモートの先頭を得る。手元の履歴にそのコミットがなければ「分岐」として止める（未決事項 8）。
2. リモートの先頭から手元の先頭までのコミットを古い順に並べ、各コミットについて、リモートにない blob を `POST /git/blobs`（base64）、tree を `POST /git/trees`、commit を `POST /git/commits`（作者・コミッター・日時・メッセージ・親を手元と同じにする）で作る。
3. **API が返したコミット ID が手元のコミット ID と一致することを確かめる。** 中身が同じなら Git の object ID は同じになるはず。一致しなければ（GitHub が署名を付けた等）ref を更新せずに止める。作られた object はリモートに残るが、ref から辿れないので害はない。
4. `PATCH /git/refs/heads/{branch}`（`force: false`）で先頭を進める。他から push されていれば GitHub が拒否するので、上書きは起きない。
5. 結果を読み直して確かめる。

## 8.3 pull（fast-forward のみ）

1. リモートの先頭が手元の先頭の子孫かを、`GET /git/commits/{sha}` で親を辿って確かめる（上限つき：第34章）。手元に未 push のコミットがあれば止める。
2. 新しいコミット・tree・blob を REST API で取得し、ID を自前で計算し直して一致を確かめてから、自前の Git 層で loose object として書く。
3. 作業ツリー（記事・画像）を新しい tree に合わせて書き換える。**これは CMS がこれまでしなかった checkout に当たる**（ADR-0004：作業ツリーへは書かない）。未保存・未コミットの記事があれば止め、変わる記事の一覧を確認してから書く。仕様 20.1 の「pull は対象外」と ADR-0004 の書き込み範囲を変える。
4. index とブランチの ref を更新する。

## 8.4 認証とトークン

- GitHub のブラウザ向け OAuth（Device Flow を含む）のトークン取得の窓口は CORS に対応していないため、サーバーなしでは使えない。**fine-grained personal access token** を利用者に作ってもらい、貼り付けてもらう。権限は対象リポジトリ 1 つの Contents の読み書きだけ、有効期限つきを案内する。
- トークンは DK で暗号化して保存し、ロック中は使えない。画面にも履歴にも出さない。
- 送信先は `api.github.com` だけに固定し、CSP の `connect-src` もそれだけにする（第16章の通信禁止の例外として明記する）。
- 回数制限（認証済みで 1 時間 5,000 回）に対し、1 回の push は「変更したファイル数＋tree 数＋コミット数＋2」程度。大量の画像を一度に push する場合は制限に近づくことがあるので、残り回数を見て分ける。

## 8.5 仕様への影響

- 第20.1節の対象外（push・pull・GitHub API 同期）から、GitHub の REST API による fast-forward の push・pull を外す。CORS プロキシは引き続き対象外。
- 第16章：`api.github.com` への通信を、利用者が操作したときだけ許す例外として加える。
- 第21章・第31章：pull による作業ツリーの書き換えの確定点と中断時の扱い（どの記事まで書いたかを記録し、途中なら再実行で揃える）。
- 第35章：GitHub に送ったものが端末の外のバックアップになること。

[^request-2026-11-05-ios]: iOS Safari での Git の依頼
[^isomorphic-git]: isomorphic-git 1.44.11 のソース
[^lightning-fs]: @isomorphic-git/lightning-fs 4.10.5 のソース
[^webkit-writable]: WebKit Bug 231706：File System 標準の実装
[^webkit-itp]: WebKit：Full Third-Party Cookie Blocking and More
[^request-2026-11-05-ios-decisions]: iOS 対応の未決事項への回答
[^github-cors]: GitHub Docs：Using CORS and JSONP to make cross-origin requests
[^github-smart-http]: github.com の Git の HTTP 通信が CORS に対応しないことの確認
[^webauthn-prf]: Passkeys & WebAuthn PRF for End-to-End Encryption
