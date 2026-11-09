<script lang="ts">
  /**
   * 本文の見たまま編集（WYSIWYG、ADR-0005）。
   *
   * 正本は Markdown の本文のまま。本文を DOM に描いて編集し、入力のたびに Markdown へ戻して
   * session.setBody に渡す。元に戻す・やり直すは従来と同じ文書の履歴を使い、本文が外から変わったら
   * （元に戻す・原文タブ・画像の挿入）描き直す。
   */
  import { onDestroy, onMount } from "svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { PREVIEW_MAX_IMAGES, PROVISIONAL_PREVIEW_IMAGE_MAX_BYTES } from "../lib/core/budgets";
  import { classifyUrl } from "../lib/core/markdown";
  import { listVariants, loadDisplayImage } from "../lib/fs/media";
  import { renderTree } from "../lib/visual/render";
  import { serializeRoot, type PristineBlock, type VNode } from "../lib/visual/serialize";

  let { ws, session }: { ws: Workspace; session: EditorSession } = $props();

  let root: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  let rendering = $state(true);
  let linkOpen = $state(false);
  let linkUrl = $state("");
  let linkInput: HTMLInputElement | undefined = $state();

  const body = $derived(session.analysis.split.ok ? session.analysis.split.body : null);
  const editable = $derived(session.editable && error === null && !rendering);

  /** 描いた DOM が表す本文。これと違う本文になったら描き直す */
  let shown: string | null = null;
  let pristine = new WeakMap<Node, PristineBlock>();
  let dirty = new WeakSet<Node>();
  let observer: MutationObserver | null = null;
  let token = 0;
  let savedRange: Range | null = null;
  /** 画像の表示用資源（検証済みの派生画像・原本から作った blob:）。記事を閉じたら解放する */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 描画の内部キャッシュ（表示状態ではない）
  const urls = new Map<string, string | { error: string }>();
  let urlsKey = "";

  function topBlock(n: Node | null): Node | null {
    let cur = n;
    while (cur && cur.parentNode && cur.parentNode !== root) cur = cur.parentNode;
    return cur && cur.parentNode === root ? cur : null;
  }

  function markDirty(records: MutationRecord[]) {
    for (const r of records) {
      if (r.target === root) continue;
      const b = topBlock(r.target);
      if (b) dirty.add(b);
    }
  }

  function observe() {
    if (!root) return;
    observer?.disconnect();
    observer = new MutationObserver(markDirty);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
  }

  /** キャレットの位置を、編集領域の文字数で表す（描き直した後に戻すため） */
  function caretOffset(): number | null {
    const sel = document.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }

  function restoreCaret(offset: number) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let left = offset;
    let last: Text | null = null;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      last = t;
      if (left <= t.length) {
        document.getSelection()?.collapse(t, left);
        return;
      }
      left -= t.length;
    }
    if (last) document.getSelection()?.collapse(last, last.length);
  }

  async function rebuild(text: string) {
    const my = ++token;
    const el = root;
    if (!el) return;
    rendering = shown === null;
    const p = await ws.md.tree(text);
    if (my !== token || !root) return;
    rendering = false;
    if (!p.ok) {
      error = `見たまま編集で表示できません：${p.message}「Markdown」に切り替えて編集してください。`;
      shown = null;
      el.replaceChildren();
      return;
    }
    error = null;
    const hadFocus = el.contains(document.activeElement) || document.activeElement === el;
    const caret = hadFocus ? caretOffset() : null;
    observer?.disconnect();
    const out = renderTree(document, p.tree, text);
    pristine = new WeakMap();
    dirty = new WeakSet();
    for (const b of out.blocks) pristine.set(b.el, b.info);
    el.replaceChildren(...out.blocks.map((b) => b.el));
    if (out.blocks.length === 0) {
      const p0 = document.createElement("p");
      p0.append(document.createElement("br"));
      el.append(p0);
    }
    shown = text;
    observe();
    if (caret !== null) restoreCaret(caret);
    void loadImages(out.images, my);
  }

  async function loadImages(images: HTMLElement[], my: number) {
    const mediaKey = ws.media ? ws.media.files.map((f) => `${f.name}:${f.size}:${f.variants ?? 0}`).join("|") : "";
    if (mediaKey !== urlsKey) {
      for (const u of urls.values()) if (typeof u === "string") URL.revokeObjectURL(u);
      urls.clear();
      urlsKey = mediaKey;
    }
    let dir = null;
    if (!session.isNew && ws.articles) {
      try {
        dir = await ws.articles.getDirectoryHandle(session.id);
      } catch {
        dir = null;
      }
    }
    const variants = dir ? await listVariants(dir) : new Map();
    const want = Math.ceil((root?.clientWidth || 800) * (globalThis.devicePixelRatio || 1));
    let shownCount = 0;
    for (const el of images) {
      if (my !== token) return;
      const target = classifyUrl(el.getAttribute("data-src") ?? "");
      let res: string | { error: string };
      if (target.kind !== "media")
        res = { error: target.kind === "external" ? "外部画像は読み込みません" : "表示しません" };
      else if (shownCount >= PREVIEW_MAX_IMAGES) res = { error: "表示する画像の上限を超えました" };
      else if (!dir) res = { error: "保存前の記事には画像がありません" };
      else {
        const cached = urls.get(target.name);
        if (cached) res = cached;
        else {
          const r = await loadDisplayImage(dir, target.name, want, PROVISIONAL_PREVIEW_IMAGE_MAX_BYTES, variants);
          res = r.ok
            ? URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: r.mime }))
            : { error: r.message };
          urls.set(target.name, res);
        }
      }
      if (my !== token) return;
      // 画像の資源の差し替えは本文の変更ではない。監視を止めて入れ替える
      if (observer) markDirty(observer.takeRecords());
      observer?.disconnect();
      if (typeof res === "string") {
        const img = document.createElement("img");
        img.src = res;
        img.alt = el.getAttribute("data-alt") ?? "";
        img.draggable = false;
        el.replaceChildren(img);
        shownCount++;
      } else {
        const ph = document.createElement("span");
        ph.className = "v-img-ph";
        ph.textContent = `画像：${el.getAttribute("data-alt") || "alt なし"}（${res.error}）`;
        el.replaceChildren(ph);
      }
      observe();
    }
  }

  $effect(() => {
    const b = body;
    if (b === null || !root) return;
    if (b === shown) return;
    void rebuild(b);
  });

  onMount(() => {
    // Enter で作る段落を p にする（既定は div）
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      // 対応しない環境では既定のまま（div も段落として扱う）
    }
  });

  onDestroy(() => {
    token++;
    observer?.disconnect();
    for (const u of urls.values()) if (typeof u === "string") URL.revokeObjectURL(u);
    urls.clear();
  });

  /** DOM から Markdown を作って本文にする */
  function commit() {
    if (!root || !editable || session.composing || shown === null) return;
    // 監視の通知は非同期に届く。直前の変更を取りこぼさないよう、ここで受け取る
    if (observer) markDirty(observer.takeRecords());
    // ブラウザが作った href 付きのリンクは data-href に移す（編集領域から遷移しない）
    for (const a of root.querySelectorAll("a[href]")) {
      a.setAttribute("data-href", a.getAttribute("href") ?? "");
      a.removeAttribute("href");
    }
    const r = serializeRoot(root as unknown as VNode, {
      pristine: (el) => (dirty.has(el as unknown as Node) ? null : (pristine.get(el as unknown as Node) ?? null)),
    });
    shown = r.markdown;
    session.setBody(r.markdown);
    updateCaret(r.ends);
  }

  /** 画像の挿入位置：キャレットのあるブロックの後ろ */
  function updateCaret(ends?: Map<VNode, number>) {
    if (!root) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return;
    if (!ends && observer) markDirty(observer.takeRecords());
    const e =
      ends ??
      serializeRoot(root as unknown as VNode, {
        pristine: (el) => (dirty.has(el as unknown as Node) ? null : (pristine.get(el as unknown as Node) ?? null)),
      }).ends;
    const b = topBlock(sel.anchorNode);
    let at: number | undefined;
    // ブロックにまとめられなかった位置は、それより前の最後のブロックの後ろにする
    for (let cur: Node | null = b; cur && at === undefined; cur = cur.previousSibling)
      at = e.get(cur as unknown as VNode);
    session.bodyCaret = at ?? 0;
    session.bodyCaretBlock = true;
  }

  function onInput(e: Event) {
    if ((e as InputEvent).isComposing) return;
    commit();
  }

  function onPaste(e: ClipboardEvent) {
    // 貼り付けは文字だけにする（記事由来でない HTML・スタイルを持ち込まない）
    e.preventDefault();
    if (!editable) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text !== "") document.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      // コードブロックの中の Enter は改行にする（ブロックを分けない）
      const sel = document.getSelection();
      const pre = sel?.anchorNode ? (sel.anchorNode.parentElement?.closest("pre") ?? null) : null;
      if (pre && root?.contains(pre)) {
        e.preventDefault();
        document.execCommand("insertText", false, "\n");
      }
    }
  }

  function onClick(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (!t || !root) return;
    // リンクは編集領域から開かない
    if (t.closest("a")) e.preventDefault();
    const box = t.closest<HTMLElement>('[data-ui="check"]');
    if (box && editable) {
      const li = box.closest("li");
      if (!li) return;
      const next = li.getAttribute("data-checked") !== "true";
      li.setAttribute("data-checked", String(next));
      box.setAttribute("aria-checked", String(next));
      box.textContent = next ? "☑" : "☐";
      const b = topBlock(li);
      if (b) dirty.add(b);
      commit();
    }
    updateCaret();
  }

  // ---------------------------------------------------------------------------
  // 書式の操作

  function exec(cmd: string, value?: string) {
    if (!editable || !root) return;
    root.focus();
    if (savedRange) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRange);
      savedRange = null;
    }
    document.execCommand(cmd, false, value);
    commit();
  }

  /** 選択範囲が編集領域の中にあるか */
  function selectionRange(): Range | null {
    const sel = document.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    return root.contains(r.commonAncestorContainer) ? r : null;
  }

  function inlineCode() {
    if (!editable || !root) return;
    const r = selectionRange();
    if (!r || r.collapsed) return;
    const code = document.createElement("code");
    code.textContent = r.toString();
    r.deleteContents();
    r.insertNode(code);
    const b = topBlock(code);
    if (b) dirty.add(b);
    document.getSelection()?.collapse(code.nextSibling ?? code, 0);
    commit();
  }

  function openLink() {
    if (!editable) return;
    const r = selectionRange();
    savedRange = r ? r.cloneRange() : null;
    const a = r ? (r.startContainer.parentElement?.closest("a") ?? null) : null;
    linkUrl = a?.getAttribute("data-href") ?? "https://";
    linkOpen = true;
    queueMicrotask(() => linkInput?.select());
  }

  function applyLink() {
    const url = linkUrl.trim();
    linkOpen = false;
    if (!root || url === "") return;
    root.focus();
    const r = savedRange;
    savedRange = null;
    if (!r) return;
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    const existing = r.startContainer.parentElement?.closest("a");
    if (existing && root.contains(existing)) {
      existing.setAttribute("data-href", url);
      const b = topBlock(existing);
      if (b) dirty.add(b);
      commit();
      return;
    }
    if (r.collapsed) {
      const a = document.createElement("a");
      a.setAttribute("data-href", url);
      a.textContent = url;
      r.insertNode(a);
      const b = topBlock(a);
      if (b) dirty.add(b);
      sel?.collapse(a.nextSibling ?? a, 0);
      commit();
    } else exec("createLink", url);
  }

  function removeLink() {
    linkOpen = false;
    if (!root) return;
    const r = savedRange ?? selectionRange();
    savedRange = null;
    const a = r?.startContainer.parentElement?.closest("a");
    if (!a || !root.contains(a)) return;
    const b = topBlock(a);
    a.replaceWith(...a.childNodes);
    if (b) dirty.add(b);
    commit();
  }

  function onLinkKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      applyLink();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      linkOpen = false;
      root?.focus();
    }
  }

  /** ツールバーのボタンで選択範囲を失わない */
  const keep = (e: MouseEvent) => e.preventDefault();
</script>

<div class="visual">
  <div class="fmt" role="toolbar" aria-label="書式">
    <button type="button" onmousedown={keep} onclick={() => exec("formatBlock", "p")} disabled={!editable}>段落</button>
    <button type="button" onmousedown={keep} onclick={() => exec("formatBlock", "h2")} disabled={!editable}
      >見出し2</button
    >
    <button type="button" onmousedown={keep} onclick={() => exec("formatBlock", "h3")} disabled={!editable}
      >見出し3</button
    >
    <span class="sep" aria-hidden="true"></span>
    <button
      type="button"
      onmousedown={keep}
      onclick={() => exec("bold")}
      disabled={!editable}
      aria-keyshortcuts="Control+B"
      data-testid="fmt-bold"><b>太字</b></button
    >
    <button
      type="button"
      onmousedown={keep}
      onclick={() => exec("italic")}
      disabled={!editable}
      aria-keyshortcuts="Control+I"><i>斜体</i></button
    >
    <button type="button" onmousedown={keep} onclick={() => exec("strikeThrough")} disabled={!editable}
      ><s>取り消し</s></button
    >
    <button type="button" onmousedown={keep} onclick={inlineCode} disabled={!editable}><code>コード</code></button>
    <button type="button" onmousedown={keep} onclick={openLink} disabled={!editable} data-testid="fmt-link"
      >リンク</button
    >
    <span class="sep" aria-hidden="true"></span>
    <button type="button" onmousedown={keep} onclick={() => exec("insertUnorderedList")} disabled={!editable}
      >箇条書き</button
    >
    <button type="button" onmousedown={keep} onclick={() => exec("insertOrderedList")} disabled={!editable}
      >番号付き</button
    >
    <button type="button" onmousedown={keep} onclick={() => exec("formatBlock", "blockquote")} disabled={!editable}
      >引用</button
    >
    <button type="button" onmousedown={keep} onclick={() => exec("formatBlock", "pre")} disabled={!editable}
      >コードブロック</button
    >
  </div>
  {#if linkOpen}
    <div class="link-row">
      <label
        >リンク先 <input
          bind:this={linkInput}
          bind:value={linkUrl}
          type="url"
          onkeydown={onLinkKeydown}
          data-testid="link-url"
        /></label
      >
      <button type="button" class="primary" onclick={applyLink} data-testid="link-apply">適用</button>
      <button type="button" onclick={removeLink}>リンクを外す</button>
      <button type="button" onclick={() => (linkOpen = false)}>キャンセル</button>
    </div>
  {/if}
  {#if error}<p class="err" role="status" data-testid="visual-error">{error}</p>{/if}
  <div
    bind:this={root}
    class="surface"
    contenteditable={editable}
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label="本文（見たまま）"
    aria-readonly={!editable}
    spellcheck="false"
    oninput={onInput}
    oncompositionend={() => setTimeout(commit, 0)}
    onpaste={onPaste}
    ondrop={(e) => e.preventDefault()}
    onkeydown={onKeydown}
    onkeyup={() => updateCaret()}
    onclick={onClick}
    data-testid="visual-editor"
    data-body-focus
  ></div>
</div>

<style>
  .visual {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-width: 0;
  }
  .fmt {
    display: flex;
    flex-wrap: wrap;
    gap: 0.1875rem;
    align-items: center;
  }
  .fmt button {
    padding: var(--space-2) var(--space-6);
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-regular);
  }
  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--color-border-subtle);
    margin-inline: var(--space-2);
  }
  .link-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-6);
    align-items: center;
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-regular);
  }
  .link-row input {
    min-width: 18rem;
  }
  .surface {
    border: 1px solid var(--color-border-control);
    border-radius: var(--radius-md);
    background: var(--color-editor-bg);
    color: var(--color-editor-fg);
    caret-color: var(--color-editor-caret);
    padding: var(--space-12) var(--space-16);
    min-height: max(20rem, calc(100dvh - 18rem));
    font-weight: var(--font-weight-regular);
    font-size: var(--font-size-16);
    line-height: var(--line-height-prose);
    overflow-wrap: anywhere;
    cursor: text;
  }
  .surface:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 1px;
  }
  .surface :global(::selection) {
    background: var(--color-editor-selection-bg);
    color: var(--color-editor-selection-fg);
  }
  /* 読み取り専用：薄くせず（opacity は文字のコントラストを下げる）、沈んだ面と点線の枠で示す */
  .surface[aria-readonly="true"] {
    cursor: default;
    background: var(--color-bg-sunken);
    color: var(--color-fg-default);
    border-style: dashed;
  }
  .surface :global(p),
  .surface :global(li),
  .surface :global(h1),
  .surface :global(h2),
  .surface :global(h3),
  .surface :global(h4),
  .surface :global(h5),
  .surface :global(h6) {
    white-space: pre-wrap;
  }
  .surface :global(p) {
    margin: 0 0 0.75em;
  }
  .surface :global(h1),
  .surface :global(h2),
  .surface :global(h3),
  .surface :global(h4) {
    margin: 1em 0 0.5em;
    line-height: 1.4;
  }
  .surface > :global(:first-child) {
    margin-top: 0;
  }
  .surface :global(blockquote) {
    margin: 0 0 0.75em;
    padding-left: var(--space-16);
    border-left: 4px solid var(--color-border-subtle);
    color: var(--color-fg-muted);
  }
  .surface :global(pre) {
    background: var(--color-code-bg);
    color: var(--color-code-fg);
    padding: var(--space-8) var(--space-12);
    border-radius: var(--radius-md);
    white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "BIZ UDGothic", monospace;
    font-size: 0.9em;
  }
  .surface :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "BIZ UDGothic", monospace;
    font-size: 0.9em;
    background: var(--color-code-bg);
    color: var(--color-code-fg);
    border-radius: var(--radius-sm);
    padding: 0 0.2em;
  }
  .surface :global(a) {
    color: var(--color-focus-ring);
    text-decoration: underline;
    cursor: text;
  }
  .surface :global(li[data-checked]) {
    list-style: none;
  }
  .surface :global(.v-check) {
    cursor: pointer;
    margin-inline-end: 0.25em;
    user-select: none;
  }
  .surface :global(.v-img) {
    display: inline-block;
    max-width: 100%;
    vertical-align: top;
  }
  .surface :global(.v-img img) {
    max-width: 100%;
    height: auto;
    display: block;
  }
  .surface :global(.v-img-ph),
  .surface :global(.v-raw),
  .surface :global(.v-raw-inline) {
    border: 1px dashed var(--color-border-subtle);
    border-radius: var(--radius-sm);
    color: var(--color-fg-muted);
    background: var(--color-bg-page);
    font-size: 0.875em;
  }
  .surface :global(.v-img-ph) {
    display: inline-block;
    padding: var(--space-4) var(--space-8);
  }
  .surface :global(.v-raw) {
    white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "BIZ UDGothic", monospace;
    padding: var(--space-6) var(--space-10);
    margin: 0 0 0.75em;
    user-select: text;
  }
  .surface :global(.v-raw-inline) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "BIZ UDGothic", monospace;
    padding: 0 0.2em;
  }
  .err {
    margin: 0;
    color: var(--color-danger-fg);
  }
</style>
