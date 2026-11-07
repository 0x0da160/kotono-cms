<script lang="ts">
  import { focusReturn } from "../lib/ui/focus-return";
  import type { DialogRequest } from "../lib/app/workspace.svelte";

  let { request }: { request: DialogRequest | null } = $props();
  let el: HTMLDialogElement | undefined = $state();
  let returnFocus: Element | null = null;

  $effect(() => {
    const d = el;
    if (!d) return;
    if (request && !d.open) {
      // 続けて開く確認（削除の2回目など）では、前の確認の戻り先を引き継ぐ
      returnFocus = focusReturn.capture();
      d.showModal();
      // 危険操作を既定にしない（14.1）：指定されたボタンへ初期フォーカス
      const initial = d.querySelector<HTMLButtonElement>(`button[data-value="${CSS.escape(request.initial)}"]`);
      initial?.focus();
    } else if (!request && d.open) {
      d.close();
    }
  });

  function choose(value: string) {
    const r = request;
    el?.close();
    focusReturn.restore(returnFocus);
    returnFocus = null;
    r?.resolve(value);
  }

  function onCancel(e: Event) {
    e.preventDefault();
    const cancel = request?.buttons.find((b) => b.value === "cancel") ?? request?.buttons.at(-1);
    if (cancel) choose(cancel.value);
  }
</script>

<dialog
  bind:this={el}
  oncancel={onCancel}
  aria-labelledby="dialog-title"
  aria-describedby="dialog-message"
  class="dialog"
>
  {#if request}
    <h2 id="dialog-title">{request.title}</h2>
    <p id="dialog-message">{request.message}</p>
    {#if request.details?.length}
      <ul class="details">
        {#each request.details as d, i (i)}
          <li>{d}</li>
        {/each}
      </ul>
    {/if}
    <div class="buttons">
      {#each request.buttons as b (b.value)}
        <button type="button" class={b.variant ?? "default"} data-value={b.value} onclick={() => choose(b.value)}
          >{b.label}</button
        >
      {/each}
    </div>
  {/if}
</dialog>

<style>
  .dialog {
    max-width: min(32rem, calc(100vw - 2rem));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-text);
    padding: var(--space-20);
  }
  .dialog::backdrop {
    background: var(--color-overlay);
  }
  h2 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-18);
  }
  .details {
    margin: 0 0 var(--space-16);
    padding-inline-start: var(--space-20);
    color: var(--color-muted);
    font-size: var(--font-size-14);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    justify-content: flex-end;
  }
</style>
