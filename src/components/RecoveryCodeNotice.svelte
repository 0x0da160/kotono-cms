<script lang="ts">
  import { normalizeRecoveryCode } from "../lib/crypto/keys";

  let {
    code,
    account,
    passkey = null,
    ondone,
  }: {
    code: string;
    /** パスワード管理に保存するときのユーザー名（解錠画面と同じ値にする） */
    account: string;
    /** パスキーを登録する。この環境で使えなければ null */
    passkey?: (() => Promise<boolean>) | null;
    ondone: () => unknown;
  } = $props();

  let kept = $state(false);
  let copied = $state(false);
  let registering = $state(false);
  let registered = $state(false);
  // パスワード管理に保存させるための欄。初期値は回復コードで、書き換えられたら開かない
  let field = $derived(code);
  const fieldOk = $derived(normalizeRecoveryCode(field) === normalizeRecoveryCode(code));

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch {
      copied = false;
    }
  }

  async function addPasskey() {
    if (!passkey || registering) return;
    registering = true;
    try {
      registered = await passkey();
    } finally {
      registering = false;
    }
  }

  /**
   * フォームとして送信すると、Safari などがパスワードとして保存するか尋ねる（iCloud キーチェーン等）。
   * 送信後にこのフォームが消えることを、ブラウザは保存の合図に使う。
   */
  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!kept || !fieldOk) return;
    ondone();
  }
</script>

<div
  class="recovery"
  role="alertdialog"
  aria-labelledby="rc-title"
  aria-describedby="rc-desc"
  data-testid="recovery-code"
>
  <form onsubmit={submit}>
    <h3 id="rc-title">回復コードを保存してください</h3>
    <p id="rc-desc" class="small">
      この作業場所は暗号化しています。回復コードはこの画面でだけ表示し、CMS
      には保存しません。「作業場所を開く」を押すと、ブラウザがパスワードとして保存するか尋ねます（iPhone・Mac では
      iCloud
      キーチェーン）。保存しておけば、覚えたり書き写したりする必要はありません。回復コードをなくし、パスフレーズ・パスキーも使えなくなると、誰も内容を戻せません。
    </p>
    <p class="code mono" data-testid="recovery-code-value">{code}</p>
    <!-- パスワード管理に保存させるための欄（ユーザー名と新しいパスワード） -->
    <input
      class="vh"
      type="text"
      name="username"
      autocomplete="username"
      value={account}
      readonly
      tabindex="-1"
      aria-hidden="true"
      data-testid="recovery-account"
    />
    <label class="field small">
      保存される回復コード
      <input
        type="password"
        name="password"
        autocomplete="new-password"
        bind:value={field}
        autocapitalize="off"
        spellcheck="false"
        data-testid="recovery-save-field"
      />
    </label>
    {#if !fieldOk}<p class="small warn" role="alert">回復コードと違います。上の回復コードに戻してください。</p>{/if}
    <div class="actions">
      <button type="button" onclick={copy}>{copied ? "コピーしました" : "コピー"}</button>
    </div>

    {#if passkey}
      <div class="passkey" data-testid="recovery-passkey">
        <p class="small">
          普段はパスキー（Face ID・Touch ID）で開けるようにしておくと、回復コードを使う場面はほぼなくなります。
        </p>
        <button
          type="button"
          class={registered ? "" : "primary"}
          disabled={registering || registered}
          onclick={addPasskey}
          data-testid="recovery-add-passkey"
          >{registered ? "パスキーを登録しました" : registering ? "登録中…" : "パスキーを登録"}</button
        >
      </div>
    {/if}

    <label class="check"
      ><input type="checkbox" bind:checked={kept} data-testid="recovery-kept" /> 回復コードを保存しました（または控えました）</label
    >
    <button type="submit" class="primary" disabled={!kept || !fieldOk} data-testid="recovery-done"
      >作業場所を開く</button
    >
  </form>
</div>

<style>
  .recovery {
    border: 2px solid var(--color-focus);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin-block: var(--space-12);
  }
  h3 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-16);
  }
  .code {
    font-size: var(--font-size-20);
    letter-spacing: 0.05em;
    overflow-wrap: anywhere;
    user-select: all;
    margin: var(--space-8) 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 28rem;
    margin-block: var(--space-8);
  }
  .field input {
    font: inherit;
    font-size: var(--font-size-16);
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
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
  .actions {
    display: flex;
    gap: var(--control-gap);
  }
  .passkey {
    margin-block: var(--space-12);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    margin-block: var(--space-12);
  }
  .small {
    font-size: var(--font-size-14);
  }
  .warn {
    color: var(--color-ng);
  }
</style>
