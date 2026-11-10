<script lang="ts">
  /**
   * 上部バーのメニューから開く窓（ダイアログ）の枠。見出しと「閉じる」を持ち、閉じたら開いたボタン（メニューの開閉）へ戻る。
   * 中身は呼び出し側が書く。閉じている間も中身は残す（復旧ドラフトの候補の数を数えるため）。
   */
  import type { Snippet } from "svelte";
  import X from "@lucide/svelte/icons/x";

  let { id, title, testid, children }: { id: string; title: string; testid: string; children: Snippet } = $props();

  let el: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;

  export function show(from?: HTMLElement | null) {
    opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    el?.showModal();
  }

  function onClose() {
    opener?.focus();
    opener = null;
  }
</script>

<dialog bind:this={el} onclose={onClose} aria-labelledby="{id}-title" class="app-dialog" data-testid={testid}>
  <div class="top">
    <h2 id="{id}-title">{title}</h2>
    <button type="button" onclick={() => el?.close()} aria-label="{title}を閉じる"
      ><X aria-hidden="true" />閉じる</button
    >
  </div>
  {@render children()}
</dialog>

<style>
  .app-dialog {
    width: min(40rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-bg-raised);
    box-shadow: var(--shadow-2);
    color: var(--color-fg-default);
    padding: var(--space-16) var(--space-20) var(--space-20);
    font-size: var(--font-size-14);
    line-height: 1.7;
  }
  .app-dialog::backdrop {
    background: var(--color-overlay);
  }
  .top {
    position: sticky;
    top: -1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-16);
    margin: -1rem -1.25rem var(--space-8);
    padding: var(--space-12) var(--space-20);
    background: var(--color-bg-surface);
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .top button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }
  .top button :global(svg) {
    width: 1em;
    height: 1em;
  }
  h2 {
    margin: 0;
    font-size: var(--font-size-18);
  }
</style>
