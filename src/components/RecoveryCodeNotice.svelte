<script lang="ts">
  let { code, ondone }: { code: string; ondone: () => unknown } = $props();
  let kept = $state(false);
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<div
  class="recovery"
  role="alertdialog"
  aria-labelledby="rc-title"
  aria-describedby="rc-desc"
  data-testid="recovery-code"
>
  <h3 id="rc-title">回復コードを控えてください</h3>
  <p id="rc-desc" class="small">
    この作業場所は暗号化しています。回復コードは今だけ表示し、どこにも保存しません。回復コードをなくし、パスフレーズ・パスキーも使えなくなると、誰も内容を戻せません。紙に書くか、パスワード管理アプリに保存してください。
  </p>
  <p class="code mono" data-testid="recovery-code-value">{code}</p>
  <div class="actions">
    <button type="button" onclick={copy}>{copied ? "コピーしました" : "コピー"}</button>
  </div>
  <label class="check"
    ><input type="checkbox" bind:checked={kept} data-testid="recovery-kept" /> 回復コードを控えました</label
  >
  <button type="button" class="primary" disabled={!kept} onclick={() => ondone()} data-testid="recovery-done"
    >作業場所を開く</button
  >
</div>

<style>
  .recovery {
    border: 2px solid var(--focus);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-block: 0.75rem;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  .code {
    font-size: 1.25rem;
    letter-spacing: 0.05em;
    overflow-wrap: anywhere;
    user-select: all;
    margin: 0.5rem 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .small {
    font-size: 0.875rem;
  }
</style>
