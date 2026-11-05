<script lang="ts">
  import type { DialogRequest } from "../lib/app/workspace.svelte";

  let { request }: { request: DialogRequest | null } = $props();
  let el: HTMLDialogElement | undefined = $state();
  let returnFocus: Element | null = null;
  /** 無効のため戻せなかった戻り先（有効に戻るのを待つ） */
  let pending: { target: HTMLElement; observer: MutationObserver } | null = null;

  $effect(() => {
    const d = el;
    if (!d) return;
    if (request && !d.open) {
      const active = document.activeElement;
      // 続けて開く確認（削除の2回目など）では、前の確認の戻り先を引き継ぐ
      returnFocus = pending && (active === null || active === document.body) ? pending.target : active;
      cancelPending();
      d.showModal();
      // 危険操作を既定にしない（14.1）：指定されたボタンへ初期フォーカス
      const initial = d.querySelector<HTMLButtonElement>(`button[data-value="${CSS.escape(request.initial)}"]`);
      initial?.focus();
    } else if (!request && d.open) {
      d.close();
    }
  });

  /*
   * 閉じたらフォーカスを開いた操作へ戻す。
   * 確認の間だけ無効になる操作（「削除…」などは ws.busy で無効になる）は、閉じた時点では
   * フォーカスできない。有効に戻ったときに、フォーカスがどこにも無ければ（BODY）戻す。
   */
  function cancelPending() {
    pending?.observer.disconnect();
    pending = null;
  }
  function restoreFocus(target: Element | null) {
    cancelPending();
    if (!(target instanceof HTMLElement) || !target.isConnected) return;
    if (!target.matches(":disabled")) {
      target.focus();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!target.isConnected) return cancelPending();
      if (target.matches(":disabled")) return;
      cancelPending();
      const active = document.activeElement;
      if (active === null || active === document.body) target.focus();
    });
    observer.observe(target, { attributes: true, attributeFilter: ["disabled"] });
    pending = { target, observer };
  }
  $effect(() => cancelPending);

  function choose(value: string) {
    const r = request;
    el?.close();
    restoreFocus(returnFocus);
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
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    padding: 1.25rem;
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.125rem;
  }
  .details {
    margin: 0 0 1rem;
    padding-inline-start: 1.25rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
  }
</style>
