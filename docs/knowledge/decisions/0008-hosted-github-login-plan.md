---
type: Architecture Decision
title: "ADR-0008（案）ホスト版で GitHub にログインして同期するための計画"
description: "ホスト版（https 配信）で、トークン（PAT）を作らずに GitHub へのログインだけで同期できるようにする計画。GitHub のトークン取得の窓口が CORS に対応しない問題を、配信先を Cloudflare Pages に移して同じ配信元に置く小さな関数で解く。デバイスフローを選ぶ理由、関数の範囲と安全上の制約、GitHub App の設定、配信元の変更でブラウザ内のデータが引き継がれない危険と移行手順、仕様の変更箇所、段階ごとの規模と未決事項。file:// 版は PAT のまま。"
tags: ["GitHub", "認証", "GitHub App", "デバイスフロー", "OAuth", "Cloudflare Pages", "配信", "CORS", "計画", "未決定", "要検証"]
status: draft
generated: { by: claude-code/2.1.318, at: 2026-11-08T04:15:00Z }
sources:
  - id: request-2026-11-08-login
    resource: "0x0da160 の依頼（2026-11-08）：GitHub ログインで PAT なしに同期できるか。file:// 版が無理でもホスト版はできるのでは。近い将来その方向で実装すべく計画化しておく"
    title: "ホスト版の GitHub ログインの依頼"
    author: human:0x0da160
    last_modified: 2026-11-08T04:09:54Z
  - id: spec-v3-2
    resource: ../../spec/local-cms-specification-v3.2.md
    title: "ローカルCMS 仕様書 改訂版 3.2"
    author: human:0x0da160
    last_modified: 2026-11-06T00:00:00+09:00
  - id: adr-0006
    resource: 0006-ios-safari-git-plan.md
    title: "ADR-0006（案）iOS Safari で記事と Git を扱うための計画"
    author: claude-code/2.1.318
    last_modified: 2026-11-07T00:00:00Z
  - id: github-device-flow
    resource: "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app"
    title: "GitHub Docs：Generating a user access token for a GitHub App"
    author: team:github
    last_modified: 2026-11-08T00:00:00Z
---
# 状態

**計画（未着手）。** 2026-11-08 に、PAT の作成を案内する画面（PR #37）と同時に、依頼により計画だけを書いた。実装は段階 0 の検証の後に行う。file:// 版は引き続き PAT を使う。

# 背景

- 同期には、対象リポジトリ 1 つの Contents だけを許した fine-grained personal access token（PAT）を利用者が作って貼る（仕様 3.2 第40.2節）。作る手順が長く、期限が来るたびに作り直しになる。
- GitHub のログイン（OAuth のウェブフロー・デバイスフロー）は、最後に「コードをトークンに換える」窓口（`github.com/login/oauth/access_token`。デバイスフローでは `github.com/login/device/code` も）を呼ぶ。この窓口はブラウザからの呼び出し（CORS）に応じない[^adr-0006]。そのため、ブラウザだけで動く Kotono CMS からは使えない。
- **ホスト版でも同じ。** ウェブフローなら GitHub からホスト版のページへ戻ってコードを受け取れるが、そのコードをトークンに換える呼び出しが CORS で止まる。GitHub Pages は静的ファイルの配信だけで、代わりに呼ぶ処理を置けない。
- 一方、Cloudflare Pages・Netlify などは、静的サイトと同じ配信元に小さな関数を置ける。関数がトークン取得の窓口を代わりに呼べば、別のサーバーを立てずにログインできる。

# 決定（案）

1. **ホスト版の配信先を GitHub Pages から Cloudflare Pages に移す。** 同じ配信元に Pages Functions の関数を 1 つ置く（`/api/github/login/*`）。関数は無料枠に収まる見込み（同期のたびではなく、ログインと期限の更新のときだけ呼ぶ）。Netlify Functions でも同じ形で作れる（第8章の未決事項）。
2. **ログインは GitHub App のデバイスフローで行う**[^github-device-flow]。画面にコードを出し、利用者が GitHub のページ（`github.com/login/device`）でコードを入れて承認する。アプリはその間、関数を通して承認を待つ。
3. **得たトークンは api.github.com だけに使い、これまでのトークンと同じく作業場所の鍵で暗号化して保存する**（第40.2節）。同期の処理（push・pull・簡易マージ）とファイルの形式は変えない。
4. **PAT の入力は残す。** file:// 版は PAT だけ。ホスト版でもログインが使えないとき（関数の停止・GitHub App 未インストール）の代わりにする。
5. **関数は秘密（client secret）を持つ唯一の場所にする。** 配布物（HTML）には Client ID だけを入れる。

## デバイスフローを選ぶ理由

| 観点 | デバイスフロー | ウェブフロー（リダイレクト） |
| --- | --- | --- |
| iPhone・iPad のホーム画面のアプリ | アプリの画面を離れない。GitHub は別に開いて承認するだけ | GitHub から戻る先が Safari になることがあり、ホーム画面のアプリとは保存領域が別のため、得たトークンをアプリへ渡せないおそれがある |
| 戻り先の URL | 不要 | 配信先ごとに登録が要る。移行・独自ドメインで変わる |
| CSRF・コードの横取り | コードは利用者が手で入れる。state・PKCE の管理が要らない | state と PKCE の管理、URL からコードを消す処理、Service Worker で戻り先をキャッシュしない注意が要る |
| file:// 版への将来の拡張 | 関数が配信元 `null` を許せば、同じ仕組みで使える | 戻り先に file:// を使えないので不可 |
| 手間 | コードを入れる 1 手間が増える | GitHub で「Authorize」を押すだけ |

## 関数の範囲（`functions/api/github/login/[op].ts`）

- **3 つの操作だけ**を中継する。いずれも POST。
  - `device`：`github.com/login/device/code` に Client ID を付けて送り、`device_code`・`user_code`・`verification_uri`・`interval`・`expires_in` を返す。
  - `token`：`device_code` を受け取り、`github.com/login/oauth/access_token` に送る（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）。承認待ち（`authorization_pending`・`slow_down`）はそのまま返す。
  - `refresh`：期限の近いトークンを更新する。`refresh_token` と、関数の環境変数の client secret を付けて送る。
- **送り先は `https://github.com` の上の 2 つの窓口に固定する。** 受け付ける項目は決めたものだけにし、ほかの値は捨てる。Client ID は関数の設定値を使い、呼び出し側から指定させない（他のアプリの中継にさせない）。
- **配信元を確かめる。** 同じ配信元からの呼び出しだけを受け付ける（`Origin`・`Sec-Fetch-Site`）。CORS のヘッダーは返さない。
- **何も保存・記録しない。** 応答は `Cache-Control: no-store`。関数のログにトークン・コードを出さない（エラーは種類だけ）。
- **回数を絞る。** Cloudflare の Rate Limiting で、同じ IP からの呼び出しを 1 分あたり数十回に抑える。
- 試験：関数を単体で読み込み、GitHub の窓口を偽の応答に替えて、許す操作・拒む操作・項目の除去・配信元の検査を確かめる。

## アプリ側

- `src/lib/sync/github-login.ts`：デバイスフローの手順（コードの発行・承認待ち・期限・`slow_down` での間隔の延長・中止）、資格情報の保存形式、期限の更新。応答は未信頼入力として形を確かめる。
- 資格情報の保存形式：PAT はこれまでどおり文字列のまま。ログインのトークンは `{"v":1,"kind":"app",…}` の JSON（アクセストークン・期限・更新用トークンとその期限・ユーザー名）を、これまでと同じ `remote.token` の欄に暗号化して入れる。読めない形なら入力し直しを求める。保存済みの PAT はそのまま読める。
- `SyncController`：`startLogin`・`cancelLogin`・同期の前の期限の確認と更新。401 ならログインし直しを求め、403・404 なら「GitHub App をこのリポジトリにインストールしたか」を案内する。
- 画面（「Git と同期」）：「GitHub でログイン」ボタン、コードの表示と「コードをコピーして GitHub を開く」、承認待ちの表示と「やめる」、ログイン中のユーザー名と「ログアウト」。PAT は「ログインの代わりにトークンを貼り付ける」として畳んで残す。
- ログインのボタンは、https で開いていて、Client ID がビルドに入っているときだけ出す。file:// では出さない。
- CSP：`connect-src` に `'self'` を足す（file:// では意味を持たない）。Service Worker は `/api/` を扱わない（今も同じ配信元の GET だけを扱う）。
- 2026-11-08 に試作したデバイスフローの処理（中継を別に置く案。依頼により取りやめ）を流用できる。

## GitHub App の設定（利用者が行う）

| 項目 | 値 |
| --- | --- |
| 作成場所 | GitHub の Settings → Developer settings → GitHub Apps → New GitHub App |
| 名前 | 例：Kotono CMS（0x0da160） |
| Homepage URL | ホスト版の URL |
| Callback URL | 空でよい（デバイスフローでは使わない） |
| Enable Device Flow | オン |
| Expire user authorization tokens | オン（8 時間で切れ、更新用トークンで延ばす） |
| Webhook | オフ |
| Repository permissions | Contents：Read and write（Metadata：Read-only は自動） |
| インストール先 | 同期するリポジトリだけ（Only select repositories） |
| 控えるもの | Client ID（HTML に入れる）、Client secret（Cloudflare の関数の環境変数に入れる。リポジトリには入れない） |

トークンが届くのは「App の権限」と「インストール先のリポジトリ」の重なりだけで、PAT と同じ「1 リポジトリの Contents だけ」になる。

# 配信先の移行と危険

- **配信元が変わると、ブラウザ内の作業場所は引き継がれない。** OPFS・IndexedDB・復旧ドラフト・パスキーは配信元ごとに分かれている。iPhone・iPad で GitHub Pages 版に作った作業場所は、新しい配信先では空に見える。
- 移行の手順（画面と README に書く）：
  1. 旧い配信先で、すべての作業場所を GitHub へ送る（push）か、暗号化して書き出す。
  2. 新しい配信先をホーム画面に追加し直す。
  3. 作業場所を作り直し、GitHub から取得するか、書き出したものを取り込む。
- 旧い配信先（GitHub Pages）は、移行の期間が終わるまで残す。消すと、旧い配信先にだけあるデータへ戻れなくなる。旧い配信先の画面に、移行の案内を出す。
- パスキーは配信元（rpId）に結びつくので、作業場所の解錠に使っていた場合は回復コードで開き直し、新しい配信元で登録し直す。
- 独自ドメインを先に決めておけば、将来また配信先を変えても配信元は変わらない（第8章の未決事項）。

# 安全上の注意

- トークンは関数を通る。関数のコードはこのリポジトリで管理し、Cloudflare のアカウントは利用者本人のものにする。第三者の中継は使わない。
- client secret は関数の環境変数だけに置く。配布物・リポジトリ・ログに出さない。
- 関数が乗っ取られた場合の被害は、ログイン中の利用者のトークン（1 リポジトリの Contents）に限られる。GitHub App の設定で secret を作り直し、インストールを外せば止められる。
- 「ログアウト」は端末のトークンを消すだけ。GitHub 側の承認を取り消す手順（Settings → Applications）を画面に示す。

# 仕様の変更箇所（3.2 からの差分の案）

- 第40.2節：認証の方法に「ホスト版での GitHub App のデバイスフロー」を加える。通信先に「同じ配信元の関数（ログインと期限の更新のときだけ）」を加える。同期の通信先は api.github.com のまま。
- 第38.5節：ホスト版の配信先と、配信元が変わるときの移行手順。
- 第16.1.1節：CSP の `connect-src` に `'self'`。
- 第3.2節：「自動ネットワーク通信を行わない」の範囲は変えない（期限の更新は、利用者が同期を押したときだけ行う）。

# 段階と規模

1 人で作業した場合の目安。

| 段階 | 内容 | 目安 |
| --- | --- | --- |
| 0. 検証 | Cloudflare Pages に今の成果物を置き、Service Worker・CSP・ホーム画面への追加が GitHub Pages と同じに動くか。試験用の GitHub App で、関数を通したデバイスフローと期限の更新が通るか。iPhone のホーム画面のアプリで、GitHub を開いて承認して戻る流れ | 1〜2 日 |
| 1. 関数 | 3 つの操作、配信元の検査、回数の制限、単体試験 | 1 日 |
| 2. アプリ | ログインの手順・保存形式・期限の更新・画面・E2E（関数の応答を偽に替える） | 2〜3 日 |
| 3. 配信と移行 | Cloudflare Pages への自動配信（GitHub Actions）、移行の案内、README・ナレッジ・仕様の更新 | 1〜2 日 |

# 未決事項

| 項目 | 選択肢 | 案 |
| --- | --- | --- |
| 配信先 | Cloudflare Pages ／ Netlify | Cloudflare Pages（無料枠の関数の回数が多く、Rate Limiting を同じ場所で設定できる） |
| 独自ドメイン | 使う ／ `*.pages.dev` のまま | 使う（今後の配信先の変更で配信元を変えないため） |
| GitHub Pages | 移行期間の後に止める ／ 残す | 移行の案内だけを出す版にして、一定期間の後に止める |
| file:// 版のログイン | PAT のまま ／ 関数が配信元 `null` を許してデバイスフローを使う | まず PAT のまま。ホスト版で安定してから検討 |
| トークンの期限 | 8 時間＋更新 ／ 期限なし | 8 時間＋更新（漏れたときの被害を小さくする） |

[^adr-0006]: ADR-0006 第8.4節。GitHub のブラウザ向け OAuth（デバイスフローを含む）のトークン取得の窓口は CORS に対応していない。
[^github-device-flow]: GitHub App のユーザーアクセストークンは、デバイスフローで得られ、Client ID だけで要求できる（client secret は更新のときに使う）。
