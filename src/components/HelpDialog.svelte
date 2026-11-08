<script lang="ts">
  /** 画面に常に出していた長めの説明をまとめたヘルプ。上部バーの「ヘルプ」から開く */
  import CircleQuestionMark from "@lucide/svelte/icons/circle-question-mark";
  import X from "@lucide/svelte/icons/x";

  let el: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;

  function show() {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.showModal();
  }

  function onClose() {
    opener?.focus();
    opener = null;
  }
</script>

<button type="button" class="help-open" onclick={show} data-testid="help-open"
  ><CircleQuestionMark aria-hidden="true" />ヘルプ</button
>

<dialog bind:this={el} onclose={onClose} aria-labelledby="help-title" class="help" data-testid="help-dialog">
  <div class="top">
    <h2 id="help-title">ヘルプ</h2>
    <button type="button" onclick={() => el?.close()} aria-label="ヘルプを閉じる"><X aria-hidden="true" />閉じる</button
    >
  </div>

  <section>
    <h3>画面の構成</h3>
    <p>
      フォルダ（作業場所）を開くと、上部に「記事」「Git
      と同期」「設定」が並びます。「記事」では左に記事の一覧、右に編集中の記事を表示します。画面の幅が狭いときは「一覧」と「編集」を切り替えて使います。画面を切り替えても、編集中の内容はそのまま残ります。
    </p>
  </section>

  <section>
    <h3>保存とキーボード</h3>
    <p>
      記事は手動で保存します（自動では保存しません）。Git を使う場合は、記事単位でコミットでき、GitHub
      と送る・取得する（push・pull）ができます。
    </p>
    <ul>
      <li>Ctrl/⌘+S：保存</li>
      <li>Ctrl/⌘+Z：元に戻す</li>
      <li>Ctrl/⌘+Shift+Z または Ctrl+Y：やり直す</li>
    </ul>
    <p>日本語の変換中（IME）は保存しません。変換を確定してから保存してください。</p>
  </section>

  <section>
    <h3>フォルダを開いて使う</h3>
    <p>
      記事を保存しているリポジトリのフォルダ（<code>content/articles/</code> を含むフォルダ）を選びます。フォルダへのアクセスはタブを閉じるまで有効です。
    </p>
    <p>
      開いたフォルダは、次回すぐ開けるようこのブラウザ内に記憶します（フォルダ名とアクセス用の情報だけで、記事の内容は保存しません）。開くときにブラウザがアクセスの許可を求めることがあります。
    </p>
  </section>

  <section>
    <h3>ブラウザ内の作業場所</h3>
    <p>記事・画像・Git の履歴を、このブラウザの中に保存します。作業場所ごとに別のリポジトリとして扱います。</p>
    <p>
      ブラウザは保存領域を消去することがあります。こまめに書き出すか、GitHub と同期してください。iPhone・iPad
      では、共有メニューの「ホーム画面に追加」から開くと、保存領域が消されにくくなります。
    </p>
  </section>

  <section>
    <h3>復旧ドラフト</h3>
    <p>
      未保存の編集を、ブラウザの中に自動で退避します。タブを閉じたりブラウザが落ちたりしても、次回の起動で戻せます。ディスクへは自動で書き込みません。設定は上部の「設定」（フォルダを開く前はフッターの「復旧ドラフト」）から変えられます。
    </p>
  </section>

  <section>
    <h3>本文と記事情報</h3>
    <p>
      本文は「見たまま」「Markdown」「原文」で編集できます。表・生
      HTML・参照形式のリンクなどは、見たままでは灰色の枠で表示します。その部分は「Markdown」か「原文」で編集してください。
    </p>
    <p>記事ID・作成日時・更新日時は CMS が管理します。記事情報の欄にない項目は「原文」で編集してください。</p>
  </section>

  <p class="more">各欄の横の <CircleQuestionMark aria-hidden="true" /> を押すと、その欄の説明を表示します。</p>
</dialog>

<style>
  .help-open {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }
  .help-open :global(svg),
  .more :global(svg) {
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;
  }
  .help {
    width: min(40rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-text);
    padding: var(--space-16) var(--space-20) var(--space-20);
    font-size: var(--font-size-14);
    line-height: 1.7;
  }
  .help::backdrop {
    background: var(--color-overlay);
  }
  .top {
    position: sticky;
    top: -1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-16);
    margin: -1rem -1.25rem var(--space-8);
    padding: var(--space-12) var(--space-20);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }
  .top button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }
  .top button :global(svg) {
    width: 1em;
    height: 1em;
  }
  h2 {
    margin: 0;
    font-size: var(--font-size-18);
  }
  h3 {
    margin: var(--space-16) 0 var(--space-4);
    font-size: var(--font-size-15);
  }
  p,
  ul {
    margin: var(--space-4) 0;
  }
  ul {
    padding-inline-start: var(--space-20);
  }
  .more {
    margin-top: var(--space-12);
    color: var(--color-muted);
  }
</style>
