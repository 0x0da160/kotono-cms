<script lang="ts">
  import type { UnlockMethod } from "../lib/crypto/vault";

  let {
    busy,
    passphrase,
    passkey,
    onunlock,
  }: { busy: boolean; passphrase: boolean; passkey: boolean; onunlock: (m: UnlockMethod) => unknown } = $props();

  let kind = $state<"recovery" | "passphrase">("recovery");
  let secret = $state("");

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
      data-testid="unlock-passkey">パスキーで解錠</button
    >
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
      type={kind === "recovery" ? "text" : "password"}
      bind:value={secret}
      autocomplete={kind === "recovery" ? "off" : "current-password"}
      autocapitalize="off"
      spellcheck="false"
      required
      data-testid="unlock-secret"
    />
  </label>
  <button type="submit" class={passkey ? "" : "primary"} disabled={busy || secret === ""} data-testid="unlock-run"
    >{busy ? "確認中…" : "解錠"}</button
  >
</form>

<style>
  .unlock {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
    max-width: 28rem;
  }
  .kinds {
    display: flex;
    gap: 1rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  input:not([type="radio"]) {
    font: inherit;
    font-size: 1rem;
    padding: 0.5rem;
    min-height: 2.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }
  button {
    align-self: flex-start;
  }
</style>
