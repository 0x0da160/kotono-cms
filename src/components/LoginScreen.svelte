<script lang="ts">
  import FingerprintPattern from "@lucide/svelte/icons/fingerprint-pattern";
  import HelpTip from "./HelpTip.svelte";
  import RecoveryCodeNotice from "./RecoveryCodeNotice.svelte";
  import UnlockForm from "./UnlockForm.svelte";
  import { PASSPHRASE_MIN } from "../lib/crypto/vault";
  import type { LoginController } from "../lib/app/login.svelte";

  /**
   * 起動時のログイン（ADR-0011）。何よりも先に出す。
   * 初回はパスキーを登録し（使えなければパスフレーズを決め）、回復コードを保存してもらう。
   * 2 回目からはパスキーで認証する。パスキーの認証は、ボタンを押したときにだけ始める（Safari は操作なしの要求を拒む）。
   */
  let {
    login,
    onreset,
  }: {
    login: LoginController;
    /** ログインを作り直す（確認・ドラフトの削除は呼び出し側） */
    onreset: () => unknown;
  } = $props();

  let pass1 = $state("");
  let pass2 = $state("");
  /** パスキーを使える環境で、パスフレーズを選んだ */
  let usePassphrase = $state(false);
  const mismatch = $derived(pass2 !== "" && pass1 !== pass2);
  const tooShort = $derived(pass1 !== "" && pass1.normalize("NFKC").length < PASSPHRASE_MIN);

  async function registerPassphrase(e: SubmitEvent) {
    e.preventDefault();
    if (mismatch || tooShort) return;
    if (await login.register({ kind: "passphrase", passphrase: pass1 })) {
      pass1 = "";
      pass2 = "";
    }
  }
</script>

{#snippet passphraseForm()}
  <form class="pp" onsubmit={registerPassphrase} data-testid="login-passphrase-form">
    <!-- パスワード管理に保存させるためのユーザー名 -->
    <input
      class="vh"
      type="text"
      name="username"
      autocomplete="username"
      value={login.account}
      readonly
      tabindex="-1"
      aria-hidden="true"
    />
    <label
      >パスフレーズ（{PASSPHRASE_MIN} 文字以上）
      <input
        type="password"
        bind:value={pass1}
        autocomplete="new-password"
        minlength={PASSPHRASE_MIN}
        required
        data-testid="login-new-passphrase"
      /></label
    >
    <label
      >もう一度
      <input
        type="password"
        bind:value={pass2}
        autocomplete="new-password"
        required
        aria-invalid={mismatch}
        data-testid="login-new-passphrase2"
      /></label
    >
    {#if tooShort}<p class="small warn" role="status">{PASSPHRASE_MIN} 文字以上にしてください。</p>{/if}
    {#if mismatch}<p class="small warn" role="status">1 つ目と違います。</p>{/if}
    <button
      type="submit"
      class="primary"
      disabled={login.busy || mismatch || tooShort || pass1 === ""}
      data-testid="login-register-passphrase">{login.busy ? "準備中…" : "パスフレーズで始める"}</button
    >
  </form>
{/snippet}

<section class="card login" aria-labelledby="login-heading" data-testid="login" data-phase={login.phase}>
  {#if login.phase === "recovery" && login.recoveryCode}
    <RecoveryCodeNotice
      code={login.recoveryCode}
      account={login.account}
      subject="login"
      ondone={() => login.confirmRecovery()}
    />
  {:else if login.phase === "register"}
    <h2>
      <span id="login-heading">はじめに：ログインの準備</span><HelpTip label="ログイン"
        >サーバーへのログインではありません。認証はこの端末の中だけで行い、どこにも送りません。認証で開く鍵で、未保存の編集の退避（復旧ドラフト）とブラウザ内の作業場所を暗号化します。</HelpTip
      >
    </h2>
    {#if login.passkeySupported && !usePassphrase}
      <p>
        最初にパスキーを登録します。次からは、起動するたびにパスキー（Face ID・Touch ID・Windows Hello
        など）で認証してから使います。
      </p>
      <button
        type="button"
        class="primary"
        onclick={() => login.register({ kind: "passkey" })}
        disabled={login.busy}
        data-testid="login-register-passkey"><FingerprintPattern />{login.busy ? "登録中…" : "パスキーを登録"}</button
      >
      <p class="alt small">
        <button type="button" class="link" onclick={() => (usePassphrase = true)} data-testid="login-use-passphrase"
          >パスキーを使わず、パスフレーズで始める</button
        >
      </p>
    {:else}
      <p data-testid="login-passphrase-reason">
        {#if login.passkeySupported}
          パスフレーズを決めます。次からは、起動するたびにパスフレーズを入力して使います。
        {:else}
          このページはパスキーを使えない開き方（file://
          など）で開いています。代わりにパスフレーズを決めます。次からは、起動するたびにパスフレーズを入力して使います。
        {/if}
      </p>
      {@render passphraseForm()}
      {#if login.passkeySupported}
        <p class="alt small">
          <button type="button" class="link" onclick={() => (usePassphrase = false)}>パスキーを登録する方に戻る</button>
        </p>
      {/if}
    {/if}
  {:else if login.phase === "login"}
    <h2><span id="login-heading">ログイン</span></h2>
    {#if login.hasPasskey && login.passkeySupported}
      <p>パスキーで認証してください。</p>
      <button
        type="button"
        class={login.failed ? "" : "primary"}
        onclick={() => login.login({ kind: "passkey" })}
        disabled={login.busy}
        data-testid="login-passkey"><FingerprintPattern />{login.busy ? "確認中…" : "パスキーでログイン"}</button
      >
      <p class="alt small">
        パスキーを使えないときは、{login.hasPassphrase ? "パスフレーズか" : ""}回復コードでログインできます。
      </p>
    {:else if login.passkeyElsewhere || (login.hasPasskey && !login.passkeySupported)}
      <p data-testid="login-no-passkey">
        登録したパスキーは、この開き方（配信元）では使えません。{login.hasPassphrase
          ? "パスフレーズか"
          : ""}回復コードでログインしてください。
      </p>
    {/if}
    <UnlockForm
      busy={login.busy}
      account={login.account}
      passphrase={login.hasPassphrase}
      passkey={false}
      submitLabel="ログイン"
      onunlock={(m) => login.login(m)}
    />
    <details class="reset">
      <summary>パスキー・パスフレーズ・回復コードのどれも使えないとき</summary>
      <p class="small">
        ログインを作り直せます。このブラウザの復旧ドラフトはすべて削除します（暗号化しているため、もう読めません）。ブラウザ内の作業場所は残り、それぞれの回復コードで開けます。
      </p>
      <button type="button" class="danger" onclick={onreset} disabled={login.busy} data-testid="login-reset"
        >ログインを作り直す…</button
      >
    </details>
  {/if}

  {#if login.error}<p class="banner" role="alert" data-testid="login-error">{login.error}</p>{/if}
</section>

<style>
  .card {
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin-block-end: var(--space-12);
    max-width: 36rem;
  }
  h2 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-18);
  }
  p {
    margin: 0 0 var(--space-12);
  }
  .alt {
    margin: var(--space-12) 0 0;
    color: var(--color-fg-muted);
  }
  /* 別の道（パスフレーズ）：主な操作と並べず、文字のリンクの見た目にする */
  .link {
    background: none;
    border: none;
    padding: var(--space-2) 0;
    color: var(--color-link);
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .link:hover:not(:disabled) {
    background: none;
    color: var(--color-link-hover);
  }
  .pp {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    max-width: 28rem;
  }
  .pp button {
    align-self: flex-start;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: var(--font-size-14);
  }
  input:not([type="checkbox"]) {
    font: inherit;
    font-size: var(--font-size-16);
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border-control);
    border-radius: var(--radius-md);
    background: var(--color-bg-raised);
    color: inherit;
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
    padding: 0;
  }
  .reset {
    border-top: 1px solid var(--color-border-subtle);
    margin-top: var(--space-16);
    padding-top: var(--space-8);
    font-size: var(--font-size-14);
  }
  .reset summary {
    cursor: pointer;
    color: var(--color-fg-muted);
    min-height: 1.5rem;
  }
  .reset p {
    margin-block: var(--space-8);
  }
  .banner {
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: var(--space-12) 0 0;
    background: var(--color-danger-bg);
  }
  .small {
    font-size: var(--font-size-14);
  }
  .warn {
    color: var(--color-warning-fg);
    margin: 0;
  }
</style>
