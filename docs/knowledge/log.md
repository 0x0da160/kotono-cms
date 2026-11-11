# Directory Update Log

## 2026-11-11
* **Update**: [Kotono CMS のアプリの外枠（シェル）](/product/app-shell.md) に、ロックしたとき（自動ロックを含む）の片付けを追加。開いているダイアログを閉じ、待っている確認とコミットの画面を取り消し、復号した復旧ドラフトの一覧と読み上げ用の文を捨てる。
* **Update**: [ADR-0013](/decisions/0013-header-menu-consolidation.md) の、メニューから開くダイアログの項目に、ロックしたときの扱いの注記を追加。

## 2026-11-10
* **Addition**: [ADR-0014 以前の版との互換をなくし、表現を「ロック」と「ロック解除」の対にする](/decisions/0014-lock-unlock-wording-and-no-backward-compat.md) を追加。ADR-0012 の互換の項目（パスフレーズの枠・以前の版の作業場所・以前の形式の書き出し）と、ADR-0013 で未決だった「ロック」の名前を置き換えた。
* **Update**: [Kotono CMS のアプリの外枠（シェル）](/product/app-shell.md) の「ログイン」を「ロック解除」に改め、パスフレーズと作業場所ごとの解錠の記述を外した。
* **Update**: [ADR-0011](/decisions/0011-passkey-first-and-compact-ui.md)・[ADR-0012](/decisions/0012-passkey-only-login-whole-app-encryption.md)・[ADR-0013](/decisions/0013-header-menu-consolidation.md) に、置き換えた項目の注記を追加。
* **Addition**: [ADR-0013 上部バーの大きさを変えず、画面とツールをメニューにまとめる](/decisions/0013-header-menu-consolidation.md) を追加。ADR-0011 の第3章1（スクロールで詰める上部バー）と第3章2（メニューの中身）を置き換えた。
* **Update**: [Kotono CMS のアプリの外枠（シェル）](/product/app-shell.md) を、説明文を外して大きさを変えない上部バー、メニューにまとめた場所・復旧ドラフト・対応環境の確認・ヘルプ・ロック、ログインの画面のメニューに更新。
* **Update**: [ADR-0011](/decisions/0011-passkey-first-and-compact-ui.md) に、置き換えた項目の注記を追加。

## 2026-11-09
* **Addition**: [ADR-0012 パスキーだけのログインと、ログインの鍵でのアプリ全体の暗号化](/decisions/0012-passkey-only-login-whole-app-encryption.md) を追加。ADR-0011 の第1章（パスフレーズ・file:// での利用・作業場所ごとの鍵）を置き換えた。
* **Addition**: [ADR-0011 起動時のパスキーでのログイン・暗号化した復旧ドラフト・詰めた画面](/decisions/0011-passkey-first-and-compact-ui.md) を追加。
* **Update**: [Kotono CMS のアプリの外枠（シェル）](/product/app-shell.md) を、起動時のログイン・固定してスクロールで詰める上部バー・メニュー（ハンバーガー）に更新。
* **Update**: [Kotono CMS のデザインシステム](/product/design-system.md) の押せる高さを、部品ごとの規則（WCAG 2.5.8・Apple HIG）に更新。
* **Addition**: [ADR-0010 デザインシステム 0.4.0 の導入](/decisions/0010-design-system-0-4.md) を追加。
* **Update**: [Kotono CMS のデザインシステム](/product/design-system.md) を 0.4.0 に更新（パレット・面の段・意味の色・状態色・操作状態・影と暗幕）。
* **Update**: [ADR-0007](/decisions/0007-design-system-oklab.md) のパレットと意味の色は ADR-0010 で置き換えた。

## 2026-11-08
* **Addition**: [ADR-0009 記事の任意の標準項目](/decisions/0009-optional-article-fields.md) を追加。[他の CMS との比較](/research/cms-comparison.md) の P1 の 5 件を実装済みと更新。
* **Addition**: [他の CMS との比較](/research/cms-comparison.md) を追加（調査・未決定）。
* **Update**: [ADR-0006](/decisions/0006-ios-safari-git-plan.md) を更新。作業場所の表示名を暗号化せず平文で保存するよう変更。
* **Update**: [Kotono CMS のアプリの外枠（シェル）](/product/app-shell.md) に、起動時のパスキーでのログインの画面を追加（仕様 3.2 第39.3節にも追記）。
* **Addition**: [ADR-0008（案）ホスト版で GitHub にログインして同期するための計画](/decisions/0008-hosted-github-login-plan.md) を追加（計画・未着手）。
* **Addition**: [Kotono CMS のアプリの外枠（シェル）](/product/app-shell.md) を追加。

## 2026-11-07
* **Addition**: [ADR-0007 デザインシステムの再構築と Oklab のカラーパレット](/decisions/0007-design-system-oklab.md) を追加。
* **Addition**: [Kotono CMS のデザインシステム](/product/design-system.md) を追加。

## 2026-11-05
* **Addition**: [ADR-0006（案）iOS Safari で記事と Git を扱うための計画](/decisions/0006-ios-safari-git-plan.md) を追加（計画・未決定）。
* **Addition**: [ADR-0005 見たまま編集・画像の最適化と派生画像・前回のフォルダの記憶](/decisions/0005-wysiwyg-images-recent-folder.md) を追加。

## 2026-11-04
* **Addition**: [ADR-0004 P1 MVP：ローカル Git 機能と残りの項目の実装方式](/decisions/0004-p1-git-and-remaining.md) を追加。
* **Addition**: [ADR-0003 P1 MVP：プレビュー・画像・複製・削除・復旧ドラフトの実装方式](/decisions/0003-p1-preview-media-drafts.md) を追加。

## 2026-11-03
* **Addition**: [ADR-0002 P1 MVP：読み込み・編集・手動保存の実装方式](/decisions/0002-p1-editing-and-save.md) を追加。
* **Initialization**: OKF v0.2 バンドルを作成。[仕様書 改訂版3.1](/spec/index.md) を全37章と概要に分割して転記し、[名称と表記ルール](/product/naming.md) と [ADR-0001 技術スタックの選定](/decisions/0001-tech-stack.md) を追加。
