<script lang="ts">
  import FingerprintPattern from "@lucide/svelte/icons/fingerprint-pattern";
  import HelpTip from "./HelpTip.svelte";
  import RecoveryCodeNotice from "./RecoveryCodeNotice.svelte";
  import UnlockForm from "./UnlockForm.svelte";
  import type { LoginController } from "../lib/app/login.svelte";

  /**
   * 起動時のロック解除（ADR-0011・ADR-0012）。何よりも先に出す。ロックはパスキーで解除する（パスフレーズはない）。
   * 初回はパスキーを登録し、回復コードを保存してもらう。2 回目からはパスキーで認証する（使えなければ回復コード）。
   * パスキーの認証は、ボタンを押したときにだけ始める（Safari は操作なしの要求を拒む）。
   * パスキーを使えない開き方（file://）では使えない。https の配信元か localhost から開くよう案内する。
   */
  let {
    login,
    onreset,
    hosted = null,
  }: {
    login: LoginController;
    /** ロック解除の鍵を作り直す（確認・ドラフトの削除は呼び出し側） */
    onreset: () => unknown;
    /** パスキーを使える配信元（https）の URL。分からなければ null */
    hosted?: string | null;
  } = $props();
</script>

{#snippet resetBlock()}
  <details class="reset">
    <summary>パスキーも回復コードも使えないとき</summary>
    <p class="small">
      ロック解除の鍵を作り直せます。このブラウザの復旧ドラフトはすべて削除します（暗号化しているため、もう読めません）。ブラウザ内の作業場所もいまの鍵で暗号化しているため、開けなくなります。
    </p>
    <button type="button" class="danger" onclick={onreset} disabled={login.busy} data-testid="login-reset"
      >ロック解除の鍵を作り直す…</button
    >
  </details>
{/snippet}

<section class="card login" aria-labelledby="login-heading" data-testid="login" data-phase={login.phase}>
  {#if login.phase === "recovery" && login.recoveryCode}
    <RecoveryCodeNotice code={login.recoveryCode} account={login.account} ondone={() => login.confirmRecovery()} />
  {:else if login.phase === "register"}
    <h2>
      <span id="login-heading">はじめに：パスキーの登録</span><HelpTip label="ロック解除"
        >パスキーは、このアプリのロックを解除するために使います。認証はこの端末の中だけで行い、サーバーには何も送りません。ロックを解除すると開く鍵で、未保存の編集の退避（復旧ドラフト）とブラウザ内の作業場所をまとめて暗号化します。</HelpTip
      >
    </h2>
    <p>
      最初にパスキーを登録します。次からは、起動するたびにパスキー（Face ID・Touch ID・Windows Hello
      など）で認証してから使います。パスキーを使えなくなったときのために、登録の直後に回復コードを表示します。
    </p>
    <button
      type="button"
      class="primary"
      onclick={() => login.register()}
      disabled={login.busy}
      data-testid="login-register-passkey"><FingerprintPattern />{login.busy ? "登録中…" : "パスキーを登録"}</button
    >
  {:else if login.phase === "passkey"}
    <h2><span id="login-heading">パスキーの登録</span></h2>
    <p data-testid="login-need-passkey">
      回復コードでロックを解除しました。この配信元（{login.vault.passkey?.rpId ??
        ""}）で使えるパスキーがないため、パスキーを登録してください。次からはパスキーでロックを解除します。
    </p>
    <button
      type="button"
      class="primary"
      onclick={() => login.addPasskey()}
      disabled={login.busy}
      data-testid="login-add-passkey-now"><FingerprintPattern />{login.busy ? "登録中…" : "パスキーを登録"}</button
    >
  {:else if login.phase === "login"}
    <h2><span id="login-heading">ロック解除</span></h2>
    {#if login.hasPasskey}
      <p>パスキーで認証してください。</p>
      <button
        type="button"
        class={login.failed ? "" : "primary"}
        onclick={() => login.login({ kind: "passkey" })}
        disabled={login.busy}
        data-testid="login-passkey"><FingerprintPattern />{login.busy ? "確認中…" : "パスキーでロック解除"}</button
      >
      <p class="alt small">パスキーを使えないときは、回復コードでロックを解除できます。</p>
    {:else}
      <p data-testid="login-no-passkey">
        登録したパスキーは、この配信元では使えません（別の配信元で登録したものです）。回復コードでロックを解除し、パスキーを登録し直してください。
      </p>
    {/if}
    <UnlockForm
      busy={login.busy}
      account={login.account}
      passkey={false}
      submitLabel="ロック解除"
      onunlock={(m) => login.login(m)}
    />
    {@render resetBlock()}
  {:else if login.phase === "nopasskey"}
    <h2><span id="login-heading">この開き方では使えません</span></h2>
    <p data-testid="login-nopasskey">
      ファイルを直接開いたとき（file://）は、ブラウザがパスキーを使わせません。Kotono CMS
      はパスキーでロックを解除してから使うので、https の配信元{hosted ? "" : "（GitHub Pages など）"}か localhost
      から開いてください。
    </p>
    {#if hosted}<p><a href={hosted} rel="noopener" data-testid="login-hosted">{hosted}</a></p>{/if}
    <p class="small">
      デスクトップでも、https
      の配信元から開けば実フォルダを選んで編集できます（Chrome・Edge）。手元で使うときは、kotono-cms.html
      を置いたフォルダで <code>npx serve</code> などを起動し、http://localhost から開いてください。
    </p>
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
</style>
