<script lang="ts">
  import { onMount } from "svelte";
  import { detectCapabilities, isSupported } from "./lib/capabilities";
  import { probeWorker } from "./lib/worker-probe";

  const appVersion = __APP_VERSION__;
  const specVersion = __SPEC_VERSION__;
  const results = detectCapabilities(globalThis as unknown as Record<string, unknown>);
  const supported = isSupported(results);

  let workerProbe: "pending" | "ok" | "failed" = $state("pending");
  onMount(() => {
    void probeWorker().then((ok) => (workerProbe = ok ? "ok" : "failed"));
  });
</script>

<header class="app-header">
  <h1>Kotono CMS</h1>
  <p class="tagline">手元のMarkdownで記事をつくる、ローカルCMS。</p>
</header>

<main>
  <section aria-labelledby="notice-heading" class="card">
    <h2 id="notice-heading">開発版</h2>
    <p>
      この画面はリポジトリ初期セットアップ用のプレースホルダーです。記事の作成・編集・保存などの機能はまだ実装されていません。
    </p>
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
</main>

<footer class="app-footer">
  <dl>
    <dt>アプリ版</dt>
    <dd data-testid="app-version">{appVersion}</dd>
    <dt>仕様版</dt>
    <dd data-testid="spec-version">{specVersion}</dd>
  </dl>
</footer>

<style>
  .app-header,
  main,
  .app-footer {
    max-width: 48rem;
    margin-inline: auto;
    padding-inline: 1rem;
  }

  .app-header {
    padding-block: 2rem 1rem;
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
    letter-spacing: 0.01em;
  }

  .tagline {
    margin: 0.25rem 0 0;
    color: var(--muted);
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

  .app-footer {
    padding-block: 1rem 2rem;
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
