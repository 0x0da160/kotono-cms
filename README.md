# Kotono CMS

手元のMarkdownで記事をつくる、ローカルCMS。

Kotono CMS（コトノ シーエムエス）は、Webメディアの記事を作成・編集するためのローカルCMSです。単一のHTMLファイル `kotono-cms.html` を https の配信元（または localhost）からデスクトップ版の Chrome・Edge で開き、ユーザーが選んだローカルフォルダに Markdown＋YAML frontmatter の記事を保存します。サーバーも外部CDNも使いません。

> **現在の状態：P1 MVP（実装完了・実機検証前）**
> フォルダ選択、記事一覧（検索・絞り込み・ソート）、新規作成、frontmatter フォームと Markdown 原文の編集、外部変更を検出する手動保存、記事IDと slug の検証、ID・createdAt の専用修正、YAML の往復保持、Markdown プレビュー（対象8言語のコードハイライト）、画像の取り込み（縮小・メタデータ削除による最適化と、表示用の派生画像の生成）・挿入・カバー選択・削除、本文の見たまま編集（WYSIWYG）、前回開いたフォルダの記憶、記事の複製・削除（リポジトリ外への検証済み退避が必須）、起動時のパスキーでのログイン（パスキーだけ。`file://` では使えない）、ログインの鍵で暗号化したブラウザ内復旧ドラフト（既定で有効）とブラウザ内の作業場所、ローカル Git（記事単位のコミット・初期化・状態と履歴の表示）を実装しています。仕様の数値と方式は技術成立性ゲート（仕様 第2.2節）で確認する前の受け入れ要件であり、実機（Windows・macOS の Chrome・Edge）での検証はまだ行っていません。実装方式と未検証の項目は [ADR-0002](docs/knowledge/decisions/0002-p1-editing-and-save.md)・[ADR-0003](docs/knowledge/decisions/0003-p1-preview-media-drafts.md)・[ADR-0004](docs/knowledge/decisions/0004-p1-git-and-remaining.md)・[ADR-0005](docs/knowledge/decisions/0005-wysiwyg-images-recent-folder.md)・[ADR-0011](docs/knowledge/decisions/0011-passkey-first-and-compact-ui.md)・[ADR-0012](docs/knowledge/decisions/0012-passkey-only-login-whole-app-encryption.md) を参照してください。

## 特徴（仕様より）

- 単一HTMLに JS・CSS・依存ライブラリをすべて同梱する（パスキーを使うため、`file://` ではなく https の配信元か localhost から開く）。
- 記事は `content/articles/<記事ID>/index.md`（Markdown＋YAML frontmatter）。画像は同じフォルダの `media/` に置く。
- 本文は見たまま（WYSIWYG）でも Markdown でも編集できる。正本は Markdown で、変更していない部分の記述はそのまま保つ（[ADR-0005](docs/knowledge/decisions/0005-wysiwyg-images-recent-folder.md)）。
- 画像は取り込み時に縦横 4096px・1,600万画素・4 MiB 以内に収め、メタデータを削除したものを原本にする。表示には幅 480・960・1920px の WebP・JPEG（または PNG）の派生画像（`media/variants/`）を使う（ADR-0005。仕様 3.1 からの変更）。
- 記事情報に、任意で説明文・著者・読者向けの更新日時・訂正の記録・カバー画像のキャプションとクレジットを入れられる。公開後に slug を変えると、旧 slug を `aliases` に残してサイト側でリダイレクトを作れる（[ADR-0009](docs/knowledge/decisions/0009-optional-article-fields.md)）。
- 手動保存。保存前に外部変更を検出し、無確認で上書きしない。
- ローカルGitへの記事単位のコミットと、GitHub の REST API による push・pull・分岐時の簡易マージ（ブランチ操作・rebase・GitHub 以外は対象外）。CMS は Git のフック・署名・フィルターを実行しません。
- 記事由来のHTML・スクリプトを実行せず、自動ネットワーク通信を行わない。

詳しくは [仕様書（原本）](docs/spec/local-cms-specification-v3.1.md) と、それを章ごとに整理した [ナレッジ](docs/knowledge/index.md) を参照してください。

## 対応環境

| 項目     | 内容                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ブラウザ | デスクトップ版 Chrome・Edge の安定版、iOS・iPadOS 26 以降の Safari（仕様 3.2。実機検証は未了）                                                                                |
| OS       | Windows・macOS・iOS・iPadOS                                                                                                                                                   |
| 起動     | https の配信元（または localhost）から開き、パスキーでログインする。`file://` で直接開くとパスキーを使えないため使えない（ADR-0012）。iPhone・iPad はホーム画面に追加して使う |
| 保存先   | デスクトップは選んだフォルダ。iPhone・iPad はブラウザ内の作業場所（ログインの鍵で暗号化。`?storage=workspace` でデスクトップでも選べる）                                      |
| 対象外   | Firefox・Android                                                                                                                                                              |

## 開発

必要なもの：Node.js 22.12 以上、pnpm 10（`corepack enable` で有効化できます）。

```sh
pnpm install
pnpm dev          # 開発サーバー（http://localhost:5173）
pnpm build        # dist/kotono-cms.html を生成
```

`pnpm build` のあと、`dist/kotono-cms.html` をブラウザで直接開くと起動します。

### 配布物の確認

`pnpm build` は `dist/` に次も書き出します（仕様 第29.4節）。同じソースと lockfile からは同じハッシュになります。

| ファイル                   | 内容                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `kotono-cms.html.sha256`   | `kotono-cms.html` の SHA-256。`cd dist && sha256sum -c kotono-cms.html.sha256` で照合できます |
| `release-info.json`        | アプリ版・仕様版・成果物のハッシュ・同梱した依存ライブラリ（名前・版・ライセンス）            |
| `THIRD-PARTY-LICENSES.txt` | 同梱した依存ライブラリのライセンス本文                                                        |

ハッシュを配布物と同じ場所に置くだけでは、配布元の真正性は証明できません。署名や別経路での公開方法は、正式リリースまでに決めます。

### 検査とテスト

| コマンド         | 内容                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`      | ESLint と Prettier の検査                                                                                                                 |
| `pnpm format`    | Prettier で整形                                                                                                                           |
| `pnpm typecheck` | svelte-check（TypeScript の型検査）                                                                                                       |
| `pnpm test`      | Vitest の単体テスト（OKF ナレッジの適合検査を含む）                                                                                       |
| `pnpm test:e2e`  | Playwright で `dist` を localhost から配信して検証（仮想の認証器でパスキーを通す。先に `pnpm build`）。フォルダはページ内の疑似実装で代替 |
| `pnpm check`     | 上記すべてとビルドを順に実行                                                                                                              |

E2E の初回は `pnpm exec playwright install chromium` でブラウザを入れてください。インストール済みの Chromium を使う場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` にパスを指定します。

## 技術スタック

| 領域           | 採用                                                       |
| -------------- | ---------------------------------------------------------- |
| 言語           | TypeScript 6（strict）                                     |
| UI             | Svelte 5                                                   |
| ビルド         | Vite 8 ＋ vite-plugin-singlefile（単一HTMLへインライン化） |
| テスト         | Vitest（単体）、Playwright（localhost から配信した E2E）   |
| 静的検査       | ESLint 10、Prettier、svelte-check                          |
| パッケージ管理 | pnpm（lockfile で依存を固定）                              |

選定理由：

- **単一HTMLと外部CDN非依存を素直に満たせる。** Vite の成果物を vite-plugin-singlefile で `kotono-cms.html` 1ファイルに畳み込みます。フォントは同梱せず OS 標準の日本語フォントを使います。
- **速くて小さい。** Svelte 5 はコンパイル時に最適化され、ランタイムが小さく、仮想DOMの差分コストがありません。現在のビルドは約630 kB（yaml・Markdown 解析・ハイライトのライブラリを含む）です。
- **安全側の既定値。** ビルド時にインラインの script・style の SHA-256 ハッシュから CSP を生成し、`default-src 'none'`・`connect-src 'none'` で通信を禁止します。`{@html}` と `eval` 系は ESLint でエラーにします。
- **安定版を選ぶ。** TypeScript 7（ネイティブ版）は svelte-check・typescript-eslint が未対応のため、6.0 系を使います。

YAML は `yaml`（Document API）、記事IDは `nanoid` を固定版で採用しました（[ADR-0002](docs/knowledge/decisions/0002-p1-editing-and-save.md)）。Markdown は micromark / mdast 系を固定版で採用し、終了可能な Worker の中で解析します（[ADR-0003](docs/knowledge/decisions/0003-p1-preview-media-drafts.md)）。Git は外部プロセスを使わない自前の実装で、書き込みを `.git/` の内側に限っています（isomorphic-git を採用しなかった理由は [ADR-0004](docs/knowledge/decisions/0004-p1-git-and-remaining.md)）。.gitignore の判定に `ignore`、コードハイライトに `lowlight`（`highlight.js`）を固定版で使います。操作・状態のアイコンは `@lucide/svelte`（ISC）を固定版で使い、アイコンごとに読み込んで使うものだけを同梱します（アイコンは飾りで、意味は常に文字で示します）。代替案と要検証点は [ADR-0001 技術スタックの選定](docs/knowledge/decisions/0001-tech-stack.md) にまとめています。

## ディレクトリ構成

```text
.
├── index.html               # エントリーHTML（ビルドで kotono-cms.html になる）
├── src/                     # アプリ本体（Svelte + TypeScript）
├── build/                   # ビルド用プラグイン（CSP 生成）
├── tests/
│   ├── unit/                # Vitest
│   └── e2e/                 # Playwright（localhost から配信）
└── docs/
    ├── spec/                # 仕様書の原本（改変しない）
    └── knowledge/           # 仕様の OKF v0.2 ナレッジバンドル
```

## ナレッジ（OKF v0.2）

`docs/knowledge/` は [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) のバンドルです。

- `spec/`：仕様書を概要と全37章に分け、分野別のディレクトリへ整理したもの。各章の本文は原本どおりに転記し、末尾に関連する章へのリンクを追加しています。
- `product/`：名称と表記ルール。
- `decisions/`：設計判断（ADR）。

`pnpm test` は、OKF の適合条件（frontmatter と `type`、`index.md`・`log.md` の形式、`generated`・`sources` 等の形式、リンクの解決、`index.md` の網羅）に加えて、各章の転記本文を連結すると原本と完全一致することを検査します。仕様書を改訂したときは、原本とナレッジを同時に更新してください。

## 名称

正式名称は「Kotono CMS」（「Kotono」と「CMS」の間に半角スペース）、リポジトリ名・英字識別子は小文字の `kotono-cms` です。詳しくは [名称と表記ルール](docs/knowledge/product/naming.md) を参照してください。

## ライセンス

未定です。
