<script lang="ts">
  import FingerprintPattern from "@lucide/svelte/icons/fingerprint-pattern";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import HelpTip from "./HelpTip.svelte";
  import type { PlacesController } from "../lib/app/places.svelte";

  /**
   * 起動時のログイン（仕様 3.2 第39.3節）。暗号化した作業場所があり、どれも解錠していない間は、
   * 作業場所の一覧より先にこの画面を出す。サーバーへのログインではなく、端末内の鍵をパスキーで開く操作。
   *
   * - パスキーの認証は、ボタンを押したときにだけ始める（Safari は利用者の操作なしの要求を拒むことがある）。
   * - 失敗・取り消しのときは自動で繰り返さず、回復コードで開く道を先に示す。
   */
  let { places, onopen }: { places: PlacesController; onopen: (id: string) => unknown } = $props();

  const available = $derived(places.passkeyPlaces > 0);
  /** パスキーを使えない・失敗したときは、回復コードの方を主な操作にする */
  const recoveryFirst = $derived(!available || places.loginFailed);

  async function login() {
    const m = await places.loginWithPasskey();
    if (m) await onopen(m.id);
  }
</script>

<section class="card login" aria-labelledby="login-heading" data-testid="login-gate">
  <h2>
    <span id="login-heading">ログイン</span><HelpTip label="ログイン"
      >作業場所の中身はこの端末の中で暗号化しています。パスキーで認証すると鍵が開き、作業場所を開けます。認証はこの端末の中だけで行い、どこにも送りません。</HelpTip
    >
  </h2>

  {#if available}
    <p>パスキーで認証して、作業場所を開いてください。</p>
    <button
      type="button"
      class={recoveryFirst ? "" : "primary"}
      onclick={login}
      disabled={places.busy}
      data-testid="login-passkey"><FingerprintPattern />{places.busy ? "確認中…" : "パスキーでログイン"}</button
    >
  {:else if places.vault?.passkey}
    <p data-testid="login-no-passkey">
      この端末で使えるパスキーが、まだ登録されていません。回復コードで開いたあと、パスキーを登録すると、次からパスキーでログインできます。
    </p>
  {:else}
    <p data-testid="login-no-passkey">
      このブラウザではパスキーを使えません。回復コードかパスフレーズで開いてください。
    </p>
  {/if}

  {#if places.error}<p class="banner" role="alert" data-testid="login-error">{places.error}</p>{/if}
  {#if places.info}<p class="banner info" role="status" data-testid="login-info">{places.info}</p>{/if}

  <div class="fallback">
    {#if available}<p class="small muted">パスキーが使えないときは、回復コードで開けます。</p>{/if}
    <button
      type="button"
      class={recoveryFirst ? "primary" : ""}
      onclick={() => places.useFallback()}
      disabled={places.busy}
      data-testid="login-recovery"><KeyRound />回復コード・パスフレーズで開く</button
    >
  </div>
</section>

<style>
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
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
  .fallback {
    border-top: 1px solid var(--color-border);
    margin-top: var(--space-16);
    padding-top: var(--space-12);
  }
  .fallback p {
    margin-bottom: var(--space-8);
  }
  .banner {
    border: 1px solid var(--color-ng);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: var(--space-12) 0 0;
  }
  .banner.info {
    border-color: var(--color-border);
  }
  .small {
    font-size: var(--font-size-14);
  }
</style>
