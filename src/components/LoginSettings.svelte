<script lang="ts">
  import type { LoginController } from "../lib/app/login.svelte";

  /** 「設定」の画面：起動時のログイン（ADR-0011・ADR-0012）。ログインはパスキーだけ。別のパスキーを足せる */
  let { login }: { login: LoginController } = $props();

  const passkeys = $derived(login.record?.keyring.slots.filter((s) => s.kind === "passkey").length ?? 0);
</script>

<section class="card" aria-labelledby="login-settings-heading" data-testid="login-settings">
  <h2 id="login-settings-heading">ログイン</h2>
  <ul class="small methods">
    <li>パスキー：{passkeys > 0 ? `登録済み（${passkeys} 件）` : "未登録"}</li>
    <li>回復コード：登録時に表示したもの（CMS には保存していません）</li>
  </ul>
  <p class="small muted">
    このログインの鍵で、復旧ドラフトとブラウザ内の作業場所をまとめて暗号化しています。パスキーと回復コードの両方を失うと、誰も内容を戻せません。
  </p>
  {#if login.passkeySupported}
    <button
      type="button"
      onclick={() => login.addPasskey()}
      disabled={login.busy || !login.unlocked}
      data-testid="login-add-passkey">{passkeys > 0 ? "別のパスキーを登録" : "パスキーを登録"}</button
    >
  {:else}
    <p class="small muted">この開き方（file:// など）ではパスキーを使えません。</p>
  {/if}
  {#if login.error}<p class="banner" role="alert">{login.error}</p>{/if}
  {#if login.info}<p class="banner info" role="status">{login.info}</p>{/if}
</section>

<style>
  .card {
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin-block-end: var(--space-12);
  }
  h2 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-18);
  }
  .methods {
    margin: 0 0 var(--space-8);
    padding-inline-start: 1.25em;
  }
  .banner {
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: var(--space-8) 0 0;
    background: var(--color-danger-bg);
  }
  .banner.info {
    border-color: var(--color-info-border);
    background: var(--color-info-bg);
  }
  .small {
    font-size: var(--font-size-14);
  }
</style>
