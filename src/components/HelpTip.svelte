<script lang="ts">
  /**
   * 「?」を押すと説明を開く小さな部品。説明は常に DOM に置き、閉じている間は hidden にする
   * （入力欄の aria-describedby から参照しても、読み上げの説明として残る）。
   * 開いた位置は画面に固定し、スクロール・Esc・外側のクリックで閉じる（独立してスクロールする列に切られないように）。
   */
  import CircleQuestionMark from "@lucide/svelte/icons/circle-question-mark";
  import { tick, type Snippet } from "svelte";

  let {
    label,
    id = undefined,
    children,
  }: {
    /** 何の説明か（ボタンの読み上げ名は「{label}の説明」） */
    label: string;
    /** 説明の要素の id。入力欄の aria-describedby から参照するときに渡す */
    id?: string;
    children: Snippet;
  } = $props();

  const uid = $props.id();
  const tipId = $derived(id ?? `tip-${uid}`);
  let open = $state(false);
  let btn: HTMLButtonElement | undefined = $state();
  let pop: HTMLElement | undefined = $state();
  let pos = $state({ top: 0, left: 0 });

  async function place() {
    if (!btn) return;
    const b = btn.getBoundingClientRect();
    pos = { top: b.bottom + 6, left: b.left };
    await tick();
    if (!pop) return;
    const p = pop.getBoundingClientRect();
    const margin = 8;
    let left = b.left;
    if (left + p.width > innerWidth - margin) left = innerWidth - margin - p.width;
    let top = b.bottom + 6;
    if (top + p.height > innerHeight - margin && b.top - 6 - p.height > margin) top = b.top - 6 - p.height;
    pos = { top, left: Math.max(margin, left) };
  }

  async function toggle() {
    open = !open;
    if (open) await place();
  }

  function close(focusButton = false) {
    if (!open) return;
    open = false;
    if (focusButton) btn?.focus();
  }

  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (btn?.contains(t) || pop?.contains(t))) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (pop && e.target instanceof Node && pop.contains(e.target)) return;
      close();
    };
    const onResize = () => close();
    addEventListener("pointerdown", onDown, true);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onResize);
    };
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close(true);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="helptip" onkeydown={onKey}>
  <button
    type="button"
    class="tip-btn"
    bind:this={btn}
    onclick={toggle}
    aria-expanded={open}
    aria-controls={tipId}
    aria-label={`${label}の説明`}
    title={`${label}の説明`}
    data-testid="helptip"><CircleQuestionMark aria-hidden="true" /></button
  >
  <span
    class="tip-pop"
    id={tipId}
    role="note"
    hidden={!open}
    bind:this={pop}
    style:top={`${pos.top}px`}
    style:left={`${pos.left}px`}>{@render children()}</span
  >
</span>

<style>
  .helptip {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
  }
  .tip-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* 操作対象は 24px 以上（WCAG 2.5.8） */
    width: 1.5rem;
    height: 1.5rem;
    min-height: 1.5rem;
    padding: 0;
    margin: 0 var(--space-2);
    border: none;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--color-fg-muted);
    cursor: pointer;
  }
  .tip-btn:hover,
  .tip-btn[aria-expanded="true"] {
    color: var(--color-fg-default);
    background: var(--color-bg-hover);
  }
  .tip-btn :global(svg) {
    width: 1rem;
    height: 1rem;
  }
  @media (pointer: coarse) {
    .tip-btn {
      width: 2rem;
      height: 2rem;
      min-height: 2rem;
    }
  }
  .tip-pop {
    position: fixed;
    z-index: var(--z-tooltip);
    display: block;
    width: max-content;
    max-width: min(22rem, calc(100vw - 1rem));
    padding: var(--panel-pad-sm);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-raised);
    color: inherit;
    box-shadow: var(--shadow-2);
    font-size: var(--font-size-13);
    font-weight: normal;
    line-height: var(--line-height-body);
    text-align: start;
    white-space: normal;
  }
  .tip-pop :global(.tip-p) {
    display: block;
  }
  .tip-pop :global(.tip-p + .tip-p) {
    margin-top: var(--space-6);
  }
  .tip-pop[hidden] {
    display: none;
  }
</style>
