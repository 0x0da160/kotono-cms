<script lang="ts">
  import FingerprintPattern from "@lucide/svelte/icons/fingerprint-pattern";
  import type { UnlockMethod } from "../lib/crypto/vault";

  let {
    busy,
    account = null,
    passkey,
    onunlock,
    submitLabel = "解錠",
  }: {
    busy: boolean;
    /** 回復コードをパスワード管理から自動入力させるときのユーザー名 */
    account?: string | null;
    /** パスキーで開くボタンを出すか */
    passkey: boolean;
    onunlock: (m: UnlockMethod) => unknown;
    submitLabel?: string;
  } = $props();

  let secret = $state("");
  let show = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    await onunlock({ kind: "recovery", code: secret });
    secret = "";
  }
</script>

<form class="unlock" onsubmit={submit} data-testid="unlock-form">
  {#if passkey}
    <button
      type="button"
      class="primary"
      disabled={busy}
      onclick={() => onunlock({ kind: "passkey" })}
      data-testid="unlock-passkey"><FingerprintPattern />パスキーで解錠</button
    >
  {/if}
  {#if account}
    <input
      class="vh"
      type="text"
      name="username"
      autocomplete="username"
      value={account}
      readonly
      tabindex="-1"
      aria-hidden="true"
    />
  {/if}
  <label class="field">
    回復コード（例：ABCDE-FGHIJ-…）
    <input
      type={show || !account ? "text" : "password"}
      bind:value={secret}
      autocomplete="current-password"
      autocapitalize="off"
      spellcheck="false"
      required
      data-testid="unlock-secret"
    />
  </label>
  <label class="show small"
    ><input type="checkbox" bind:checked={show} data-testid="unlock-show" /> 入力内容を表示</label
  >
  <button type="submit" class={passkey ? "" : "primary"} disabled={busy || secret === ""} data-testid="unlock-run"
    >{busy ? "確認中…" : submitLabel}</button
  >
</form>

<style>
  .unlock {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    margin-top: var(--space-8);
    max-width: 28rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: var(--font-size-14);
  }
  input:not([type="radio"]) {
    font: inherit;
    font-size: var(--font-size-16);
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
  }
  .show {
    display: flex;
    align-items: center;
    gap: var(--space-8);
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
  button {
    align-self: flex-start;
  }
</style>
