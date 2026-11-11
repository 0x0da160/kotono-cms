<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { GitController } from "../lib/app/git.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { LIST_PAGE_SIZE } from "../lib/core/budgets";
  import { formatForDisplay, publishTiming } from "../lib/core/datetime";
  import {
    allTags,
    DEFAULT_QUERY,
    matches,
    sortItems,
    type SortDir,
    type SortKey,
    type StatusFilter,
  } from "../lib/core/list";
  import type { ListEntry } from "../lib/fs/repo";

  let { ws, onopen, git = null }: { ws: Workspace; onopen?: () => void; git?: GitController | null } = $props();

  let keyword = $state(DEFAULT_QUERY.keyword);
  let status = $state<StatusFilter>(DEFAULT_QUERY.status);
  let sort = $state<SortKey>(DEFAULT_QUERY.sort);
  let dir = $state<SortDir>(DEFAULT_QUERY.dir);
  let tags = $state<string[]>([]);
  let page = $state(0);

  const entries: ListEntry[] = $derived((ws.scan?.entries ?? []).filter((e) => e.kind !== "not-directory"));
  const items = $derived(entries.map((e) => ({ id: e.dirName, values: e.values, entry: e })));
  const knownTags = $derived(allTags(items));
  const filtered = $derived(
    sortItems(
      items.filter((it) => matches(it, { keyword, status, tags, sort, dir })),
      sort,
      dir,
    ),
  );
  const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE)));
  const visible = $derived(filtered.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE));
  const ignored = $derived((ws.scan?.entries ?? []).filter((e) => e.kind === "not-directory").length);
  const now = $derived(ws.scan?.scannedAt ?? 0);

  $effect(() => {
    // 条件が変わったら先頭ページへ
    void keyword;
    void status;
    void tags.length;
    page = 0;
  });

  /*
   * 状態・並び順・方向・タグは折り畳みにまとめる（UI刷新 P-06 の追加試行）。
   * 折り畳んでいても、今の条件を見出しで読めるようにする（計画 10.1：重要な情報を折り畳む場合）。
   */
  let filtersOpen = $state(false);
  const STATUS_LABEL: Record<StatusFilter, string> = { all: "すべて", draft: "下書き", published: "公開対象" };
  const SORT_LABEL: Record<SortKey, string> = {
    updatedAt: "更新日時",
    createdAt: "作成日時",
    publishedAt: "公開日時",
    title: "タイトル",
  };
  const conditionText = $derived(
    [
      `原稿状態：${STATUS_LABEL[status]}`,
      tags.length > 0 ? `タグ ${tags.length}件` : null,
      `${SORT_LABEL[sort]}の${dir === "desc" ? "降順" : "昇順"}`,
    ]
      .filter(Boolean)
      .join("・"),
  );

  function addTag(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    const t = sel.value;
    if (t !== "" && !tags.includes(t)) tags = [...tags, t];
    sel.value = "";
  }

  function stateLabel(e: ListEntry): string | null {
    if (e.kind === "incomplete") return "不完全";
    if (e.kind === "unreadable") return "読み取り不能";
    if (e.readOnly) return "読み取り専用";
    if (e.problems.length > 0) return "検証エラー";
    return null;
  }

  /** 狭い画面では、作った記事の編集へ切り替える（14.1） */
  async function createNew() {
    await ws.createNew();
    if (ws.session) onopen?.();
  }

  async function open(id: string) {
    await ws.openArticle(id);
    onopen?.();
  }
</script>

<section class="list" aria-labelledby="list-heading">
  <div class="list-head">
    <h2 id="list-heading">記事一覧</h2>
    <div class="actions">
      <button type="button" class="primary" onclick={createNew} disabled={ws.busy || !ws.articles}
        ><Plus />新規作成</button
      >
      <button type="button" onclick={() => ws.refreshList()} disabled={ws.busy}><RefreshCw />一覧を再読み込み</button>
    </div>
  </div>

  <div class="filters" role="search">
    <div class="kw">
      <span class="kw-head"
        ><label for="kw-input">キーワード</label><HelpTip label="キーワード" id="kw-hint"
          >タイトル・slug・ID・タグの部分一致で探します。英字の大小は区別しません。</HelpTip
        ></span
      >
      <input
        id="kw-input"
        type="search"
        bind:value={keyword}
        placeholder="キーワードで検索"
        autocapitalize="off"
        autocorrect="off"
        enterkeyhint="search"
        aria-describedby="kw-hint"
      />
    </div>
    <details class="cond" bind:open={filtersOpen} data-testid="list-conditions">
      <summary
        ><span class="cond-name">絞り込み・並び順</span>
        <span class="cond-now" data-testid="list-conditions-summary">{conditionText}</span></summary
      >
      <div class="row">
        <label>
          <span>原稿状態</span>
          <select bind:value={status}>
            <option value="all">すべて</option>
            <option value="draft">下書き</option>
            <option value="published">公開対象</option>
          </select>
        </label>
        <label>
          <span>並び順</span>
          <select bind:value={sort}>
            <option value="updatedAt">更新日時</option>
            <option value="createdAt">作成日時</option>
            <option value="publishedAt">公開日時</option>
            <option value="title">タイトル</option>
          </select>
        </label>
        <label>
          <span>方向</span>
          <select bind:value={dir}>
            <option value="desc">降順</option>
            <option value="asc">昇順</option>
          </select>
        </label>
        <label>
          <span>タグ（完全一致・大小区別）</span>
          <select onchange={addTag} disabled={knownTags.length === 0}>
            <option value="">タグを追加…</option>
            {#each knownTags as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
        </label>
      </div>
    </details>
    {#if tags.length > 0}
      <ul class="chips" aria-label="選択中のタグ（すべてを持つ記事）">
        {#each tags as t (t)}
          <li>
            <span class="chip-text">{t}</span>
            <button
              type="button"
              class="chip-x touch-inline"
              aria-label={`タグ「${t}」の絞り込みを外す`}
              onclick={() => (tags = tags.filter((x) => x !== t))}>×</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <p class="summary" role="status" data-testid="list-summary">
    {#if ws.scanning}
      読み込み中…{#if ws.scanProgress && ws.scanProgress.total > 0}（{ws.scanProgress.done} / {ws.scanProgress
          .total}）{/if}
    {:else if !ws.scan}
      まだ読み込んでいません
    {:else if entries.length === 0}
      記事はまだありません。「新規作成」から始められます。
    {:else if filtered.length === 0}
      条件に一致する記事はありません（全{entries.length}件）
    {:else}
      {filtered.length}件 / 全{entries.length}件
    {/if}
  </p>
  {#if ws.scan && !ws.scan.complete}
    <p class="warn" role="alert">
      {ws.scan.incompleteReason ?? "一覧は一部だけです。"}（検索・重複検査は完全な結果ではありません）
    </p>
  {/if}
  {#if ignored > 0}
    <p class="muted small">content/articles/ 直下の記事フォルダではないファイル {ignored}件 は無視しています。</p>
  {/if}

  <ol class="rows">
    {#each visible as it (it.id)}
      {@const e = it.entry}
      {@const label = stateLabel(e)}
      {@const current = ws.session?.id === it.id && !ws.session.isNew}
      {@const timing = publishTiming(e.values.publishedAt ?? null, now)}
      <li>
        <button
          type="button"
          class="row-btn"
          class:current
          aria-current={current ? "true" : undefined}
          onclick={() => open(it.id)}
          data-testid="article-row"
          data-id={it.id}
        >
          <span class="title">
            {#if e.values.title && e.values.title.trim() !== ""}{e.values.title}{:else}<span class="untitled">無題</span
              >{/if}
            {#if current && ws.session?.dirty}<span class="badge unsaved">未保存</span>{/if}
          </span>
          <span class="meta">
            <span class="id">{it.id}</span>
            {#if e.values.status === "published"}<span class="badge pub">公開対象</span
              >{:else if e.values.status === "draft"}<span class="badge">下書き</span>{/if}
            {#if label}<span class="badge err" title={e.problems.join("\n")}><TriangleAlert />{label}</span>{/if}
            {#if git?.label(it.id)}<span class="badge git" data-testid="git-badge">{git.label(it.id)}</span>{/if}
          </span>
          <span class="dates">
            {#if e.values.updatedAt}<span>更新 {formatForDisplay(e.values.updatedAt)}</span>{/if}
            {#if timing === "future" && e.values.publishedAt}<span
                >公開予定日時 {formatForDisplay(e.values.publishedAt)}</span
              >{:else if timing === "past" && e.values.publishedAt}<span
                >公開日時 {formatForDisplay(e.values.publishedAt)}</span
              >{/if}
          </span>
          {#if e.values.tags && e.values.tags.length > 0}
            <span class="tags"
              >{#each e.values.tags as t, i (i)}<span class="tag">{t}</span>{/each}</span
            >
          {/if}
        </button>
      </li>
    {/each}
  </ol>

  {#if pageCount > 1}
    <nav class="pager" aria-label="ページ">
      <button type="button" onclick={() => (page = Math.max(0, page - 1))} disabled={page === 0}>前へ</button>
      <span>{page + 1} / {pageCount}</span>
      <button type="button" onclick={() => (page = Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}
        >次へ</button
      >
    </nav>
  {/if}
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-width: 0;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: var(--font-size-16);
  }
  .actions {
    display: flex;
    gap: var(--control-gap);
  }
  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .filters label {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-12);
    color: var(--color-fg-muted);
    gap: var(--space-2);
  }
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
    gap: var(--space-6) var(--space-8);
  }
  .row select {
    width: 100%;
  }
  /* 入力値はラベルの補助の文字設定を受け継がない（UI刷新 段階4：12px を入力値に使わない） */
  .filters input,
  .filters select {
    font-size: var(--font-size-14);
    color: var(--color-fg-default);
  }
  .kw {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .kw-head {
    display: flex;
    align-items: center;
    font-size: var(--font-size-12);
    color: var(--color-fg-muted);
  }
  .cond > summary {
    cursor: pointer;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-8);
    min-height: 1.5rem;
    font-size: var(--font-size-12);
    color: var(--color-fg-muted);
  }
  @media (pointer: coarse) {
    .cond > summary {
      align-items: center;
    }
  }
  /* display: flex にすると既定の開閉マーカーが消えるので、記号を付けて開閉できることを示す */
  .cond > summary::-webkit-details-marker {
    display: none;
  }
  .cond > summary::before {
    content: "▸";
    color: var(--color-fg-default);
  }
  .cond[open] > summary::before {
    content: "▾";
  }
  .cond-now {
    color: var(--color-fg-default);
    font-size: var(--font-size-13);
  }
  .cond[open] > summary {
    margin-bottom: var(--space-6);
  }
  .row label:last-child {
    grid-column: 1 / -1;
  }
  .kw input {
    width: 100%;
  }
  .summary {
    margin: 0;
    font-size: var(--font-size-14);
    color: var(--color-fg-muted);
  }
  /* 行は罫線で区切る（UI刷新 方向B：P-06）。選択中は面と左の太線で示し、色だけに頼らない */
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--color-border-subtle);
  }
  .row-btn {
    width: 100%;
    text-align: start;
    display: flex;
    flex-flow: row wrap;
    align-items: baseline;
    gap: 0 var(--space-8);
    padding: var(--space-4) var(--space-8);
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--color-border-subtle);
    border-radius: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .row-btn:hover {
    background: var(--color-bg-hover);
  }
  .row-btn:active {
    background: var(--color-bg-pressed);
  }
  /* 現在地：面の色・太い辺・aria-current（色だけで伝えない） */
  .row-btn.current {
    background: var(--color-selection-bg);
    color: var(--color-selection-fg);
    box-shadow: inset var(--border-width-edge) 0 0 var(--color-accent);
  }
  .title,
  .tags {
    flex-basis: 100%;
  }
  .title {
    font-size: var(--font-size-15);
    line-height: var(--line-height-tight);
    font-weight: var(--font-weight-strong);
    overflow-wrap: anywhere;
  }
  .untitled {
    color: var(--color-fg-muted);
    font-weight: var(--font-weight-regular);
  }
  .meta,
  .dates,
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-8);
    font-size: var(--font-size-12);
    color: var(--color-fg-muted);
  }
  .id {
    font-family: var(--font-mono);
  }
  .tag {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    padding: 0 var(--space-8);
    white-space: pre;
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
  .chips li {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    padding-inline-start: var(--space-8);
  }
  .chip-text {
    white-space: pre;
  }
  .chip-x {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0 var(--space-8);
  }
  .pager {
    display: flex;
    gap: var(--control-gap);
    align-items: center;
    justify-content: center;
  }
  .warn {
    margin: 0;
    color: var(--color-warning-fg);
    font-size: var(--font-size-14);
  }
  .small {
    font-size: var(--font-size-13);
    margin: 0;
  }
</style>
