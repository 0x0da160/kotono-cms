<script lang="ts">
  import { onMount } from "svelte";
  import ArticleList from "./components/ArticleList.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import Editor from "./components/Editor.svelte";
  import { Workspace } from "./lib/app/workspace.svelte";
  import { detectCapabilities, isSupported } from "./lib/capabilities";
  import { ARTICLES_PATH } from "./lib/fs/repo";
  import { probeWorker } from "./lib/worker-probe";

  const appVersion = __APP_VERSION__;
  const specVersion = __SPEC_VERSION__;
  const results = detectCapabilities(globalThis as unknown as Record<string, unknown>);
  const supported = isSupported(results);

  const ws = new Workspace();
  /** 狭い画面での単一ペイン切替（14.1） */
  let pane = $state<"list" | "editor">("list");

  let workerProbe: "pending" | "ok" | "failed" = $state("pending");
  onMount(() => {
    void probeWorker().then((ok) => (workerProbe = ok ? "ok" : "failed"));
  });

  function onKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!ws.session) return;
      // IME の未確定文字列を失わせない（14.1）：変換中は保存しない
      if (e.isComposing) {
        ws.session.notice = { kind: "warn", text: "変換を確定してから保存してください。" };
        ws.announce(ws.session.notice.text);
        return;
      }
      void ws.save();
    }
  }

  function onBeforeUnload(e: BeforeUnloadEvent) {
    // 離脱警告は試みるが、表示は保証されない（13.1）
    if (ws.session?.dirty && ws.session.readOnlyReason === null) e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeydown} onbeforeunload={onBeforeUnload} />

<header class="app-header">
  <div class="brand">
    <h1>Kotono CMS</h1>
    <p class="tagline">手元のMarkdownで記事をつくる、ローカルCMS。</p>
  </div>
  {#if supported}
    <div class="folder">
      {#if ws.root}
        <span class="folder-name" data-testid="folder-name">作業フォルダ：{ws.rootName}</span>
      {/if}
      <button
        type="button"
        class={ws.root ? "" : "primary"}
        onclick={() => ws.chooseFolder()}
        disabled={ws.busy}
        data-testid="choose-folder"
      >
        {ws.root ? "別のフォルダを開く" : "フォルダを選択"}
      </button>
    </div>
  {/if}
</header>

<main class:wide={ws.root !== null}>
  {#if !supported || ws.root === null}
    <section aria-labelledby="start-heading" class="card">
      <h2 id="start-heading">はじめに</h2>
      {#if supported}
        <p>
          記事を保存しているリポジトリのフォルダ（<code>content/articles/</code> を含むフォルダ）を選んでください。フォルダへのアクセスはこのタブを閉じるまで有効です。
        </p>
        <p class="muted small">
          記事は手動で保存します。ブラウザ内復旧ドラフト・Markdownプレビュー・Git機能は本版では未実装です。
        </p>
      {:else}
        <p>このブラウザでは編集を開始できません。デスクトップ版の Chrome または Edge で開いてください。</p>
      {/if}
    </section>

    <section aria-labelledby="env-heading" class="card">
      <h2 id="env-heading">対応環境の確認</h2>
      <p role="status" data-testid="env-summary">
        {#if supported}
          このブラウザは必要なAPIを備えています（実機検証の代替ではありません）。
        {:else}
          このブラウザでは一部の必要なAPIが利用できません。デスクトップ版の Chrome または Edge で開いてください。
        {/if}
      </p>
      <ul class="capabilities">
        {#each results as r (r.id)}
          <li data-capability={r.id} data-ok={r.ok}>
            <span class="mark" aria-hidden="true">{r.ok ? "✓" : "✕"}</span>
            <span class="label">{r.label}</span>
            <span class="state">{r.ok ? "利用可能" : "利用不可"}</span>
            {#if !r.ok}
              <span class="impact">{r.impact}</span>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="probe" data-testid="worker-probe" data-state={workerProbe}>
        隔離処理の起動確認：
        {#if workerProbe === "pending"}
          確認中…
        {:else if workerProbe === "ok"}
          Worker が起動し、応答しました。
        {:else}
          Worker を起動できませんでした。
        {/if}
      </p>
    </section>
  {:else}
    {#if ws.folderError}
      <p class="banner" role="alert" data-testid="folder-error">{ws.folderError}</p>
    {/if}
    {#if ws.config && (ws.config.errors.length > 0 || ws.config.warnings.length > 0)}
      <div class="banner warn" role="status">
        {#each ws.config.errors as m, i (i)}<p>設定：{m}</p>{/each}
        {#each ws.config.warnings as m, i (i)}<p>設定（警告）：{m}</p>{/each}
      </div>
    {/if}

    {#if ws.missingArticles}
      <section class="card" aria-labelledby="prep-heading">
        <h2 id="prep-heading">初回フォルダ準備</h2>
        <p>
          このフォルダには <code>{ARTICLES_PATH}</code> がありません。記事を作成するには、次のフォルダを作成します。
        </p>
        <p><code>{ws.rootName}/{ARTICLES_PATH}</code></p>
        <p class="muted small">確認なしには作成しません。Git の初期化は行いません。</p>
        <button type="button" class="primary" onclick={() => ws.prepareArticles()} data-testid="prepare-articles"
          >{ARTICLES_PATH} を作成する</button
        >
      </section>
    {:else if ws.articles}
      <div class="pane-switch" role="group" aria-label="表示する領域">
        <button type="button" aria-pressed={pane === "list"} onclick={() => (pane = "list")}>一覧</button>
        <button type="button" aria-pressed={pane === "editor"} onclick={() => (pane = "editor")} disabled={!ws.session}
          >編集</button
        >
      </div>
      <div class="panes" data-pane={pane}>
        <div class="pane list-pane">
          <ArticleList {ws} onopen={() => (pane = "editor")} />
        </div>
        <div class="pane editor-pane">
          {#if ws.session}
            {#key ws.session}
              <Editor {ws} session={ws.session} />
            {/key}
          {:else}
            <p class="muted empty">一覧から記事を選ぶか、「新規作成」を押してください。</p>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</main>

<footer class="app-footer" class:wide={ws.root !== null}>
  <dl>
    <dt>アプリ版</dt>
    <dd data-testid="app-version">{appVersion}</dd>
    <dt>仕様版</dt>
    <dd data-testid="spec-version">{specVersion}</dd>
  </dl>
</footer>

<ConfirmDialog request={ws.dialog} />
<div class="sr-only" aria-live="polite" data-testid="announcer">{ws.announcement}</div>

<style>
  .app-header,
  main,
  .app-footer {
    max-width: 48rem;
    margin-inline: auto;
    padding-inline: 1rem;
  }
  main.wide,
  .app-footer.wide,
  .app-header {
    max-width: 96rem;
  }
  .app-header {
    padding-block: 1rem 0.75rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: 0.01em;
  }
  .tagline {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .folder {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .folder-name {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-block-end: 1rem;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.125rem;
  }
  .capabilities {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .capabilities li {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    gap: 0.25rem 0.5rem;
    padding-block: 0.375rem;
    border-top: 1px solid var(--border);
  }
  .capabilities li:first-child {
    border-top: none;
  }
  .mark {
    font-weight: 700;
  }
  li[data-ok="true"] .mark {
    color: var(--ok);
  }
  li[data-ok="false"] .mark {
    color: var(--ng);
  }
  .state {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .impact {
    grid-column: 2 / -1;
    font-size: 0.875rem;
    color: var(--muted);
  }
  .probe {
    margin: 0.75rem 0 0;
    font-size: 0.875rem;
    color: var(--muted);
  }
  .banner {
    border: 1px solid var(--ng);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0 0 0.75rem;
    background: var(--surface);
  }
  .banner p {
    margin: 0;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(18rem, 26rem) minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
  }
  .pane-switch {
    display: none;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .pane-switch button[aria-pressed="true"] {
    font-weight: 600;
    border-color: var(--focus);
  }
  @media (max-width: 60rem) {
    .pane-switch {
      display: flex;
    }
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }
    .panes[data-pane="list"] .editor-pane,
    .panes[data-pane="editor"] .list-pane {
      display: none;
    }
  }
  .empty {
    padding: 2rem 0;
    text-align: center;
  }
  .small {
    font-size: 0.875rem;
  }
  .app-footer {
    padding-block: 1.5rem 2rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .app-footer dl {
    display: flex;
    gap: 0.25rem 0.75rem;
    flex-wrap: wrap;
    margin: 0;
  }
  .app-footer dt::after {
    content: "：";
  }
  .app-footer dd {
    margin: 0 0.75rem 0 0;
  }
</style>
