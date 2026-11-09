<script lang="ts">
  import FingerprintPattern from "@lucide/svelte/icons/fingerprint-pattern";
  import type { UnlockMethod } from "../lib/crypto/vault";

  let {
    busy,
    account = null,
    passphrase,
    passkey,
    onunlock,
  }: {
    busy: boolean;
    /** 回復コードをパスワード管理から自動入力させるときのユーザー名 */
    account?: string | null;
    passphrase: boolean;
    passkey: boolean;
    onunlock: (m: UnlockMethod) => unknown;
  } = $props();

  let kind = $state<"recovery" | "passphrase">("recovery");
  let secret = $state("");
  let show = $state(false);

  $effect(() => {
    // パスフレーズの枠があればパスフレーズを既定にする（回復コードは控えを探す手間がかかる）
    if (passphrase) kind = "passphrase";
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const m: UnlockMethod = kind === "recovery" ? { kind, code: secret } : { kind, passphrase: secret };
    await onunlock(m);
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
  {#if account && kind === "recovery"}
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
  {#if passphrase}
    <div class="kinds" role="radiogroup" aria-label="解錠の方法">
      <label><input type="radio" bind:group={kind} value="passphrase" /> パスフレーズ</label>
      <label><input type="radio" bind:group={kind} value="recovery" /> 回復コード</label>
    </div>
  {/if}
  <label class="field">
    {kind === "recovery" ? "回復コード（例：ABCDE-FGHIJ-…）" : "パスフレーズ"}
    <input
      type={show || (kind === "recovery" && !account) ? "text" : "password"}
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
    >{busy ? "確認中…" : "解錠"}</button
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
  .kinds {
    display: flex;
    gap: var(--space-16);
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
