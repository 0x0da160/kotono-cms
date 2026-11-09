<script lang="ts">
  import { PASSPHRASE_MIN } from "../lib/crypto/vault";
  import type { LoginController } from "../lib/app/login.svelte";

  /** 「設定」の画面：起動時のログインの方法（ADR-0011）。パスキーを足す・パスフレーズを決め直す */
  let { login }: { login: LoginController } = $props();

  let pass1 = $state("");
  let pass2 = $state("");
  const passkeys = $derived(login.record?.keyring.slots.filter((s) => s.kind === "passkey").length ?? 0);

  async function setPassphrase(e: SubmitEvent) {
    e.preventDefault();
    if (pass1 !== pass2) {
      login.error = "パスフレーズが一致しません。";
      return;
    }
    if (await login.addMethod({ kind: "passphrase", passphrase: pass1 })) {
      pass1 = "";
      pass2 = "";
    }
  }
</script>

<section class="card" aria-labelledby="login-settings-heading" data-testid="login-settings">
  <h2 id="login-settings-heading">ログイン</h2>
  <ul class="small methods">
    <li>パスキー：{passkeys > 0 ? `登録済み（${passkeys} 件）` : "未登録"}</li>
    <li>パスフレーズ：{login.hasPassphrase ? "設定済み" : "未設定"}</li>
    <li>回復コード：登録時に表示したもの（CMS には保存していません）</li>
  </ul>
  {#if login.passkeySupported}
    <button
      type="button"
      onclick={() => login.addMethod({ kind: "passkey" })}
      disabled={login.busy || !login.unlocked}
      data-testid="login-add-passkey">{passkeys > 0 ? "別のパスキーを登録" : "パスキーを登録"}</button
    >
  {:else}
    <p class="small muted">この開き方（file:// など）ではパスキーを使えません。</p>
  {/if}
  <form class="pp" onsubmit={setPassphrase}>
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
      >{login.hasPassphrase ? "新しいパスフレーズ" : "パスフレーズ"}（{PASSPHRASE_MIN} 文字以上）
      <input
        type="password"
        bind:value={pass1}
        autocomplete="new-password"
        minlength={PASSPHRASE_MIN}
        required
      /></label
    >
    <label>もう一度 <input type="password" bind:value={pass2} autocomplete="new-password" required /></label>
    <button type="submit" disabled={login.busy || !login.unlocked}
      >{login.hasPassphrase ? "パスフレーズを変える" : "パスフレーズを設定"}</button
    >
  </form>
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
  .pp {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    align-items: end;
    margin-block: var(--space-8);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: var(--font-size-14);
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
