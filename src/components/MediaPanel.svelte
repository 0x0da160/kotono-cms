<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { IMAGE_MAX_BYTES } from "../lib/core/budgets";
  import { listVariants, loadDisplayImage } from "../lib/fs/media";
  import { ORIGINAL_MAX_BYTES, ORIGINAL_MAX_PIXELS, ORIGINAL_MAX_SIDE, VARIANT_WIDTHS } from "../lib/fs/optimize";
  import HelpTip from "./HelpTip.svelte";

  let { ws, session }: { ws: Workspace; session: EditorSession } = $props();

  let input: HTMLInputElement | undefined = $state();
  let alts = $state<Record<string, string>>({});
  /** 親 UI でのサムネイル表示（CMS が検証して生成した blob: のみ：16.2） */
  let thumbs = $state<Record<string, { url: string } | { error: string }>>({});

  const media = $derived(ws.media);
  const refs = $derived(media?.refs ?? null);
  const editable = $derived(session.editable);
  const importing = $derived(ws.operation === "画像の取り込み");

  onMount(() => void ws.refreshMedia());
  onDestroy(() => {
    for (const t of Object.values(thumbs)) if ("url" in t) URL.revokeObjectURL(t.url);
  });

  function refLabel(name: string): string {
    if (!refs) return "参照：未確認";
    if (refs.names.has(name)) return "参照中（保存済み本文・cover）";
    if (refs.status === "unknown") return "参照状況不明";
    return "未参照（保存済み本文・cover）";
  }

  async function onPick() {
    const files = input?.files ? [...input.files] : [];
    if (input) input.value = "";
    if (files.length > 0) await ws.importImages(files);
  }

  async function show(name: string) {
    const articles = ws.articles;
    if (!articles) return;
    try {
      const dir = await articles.getDirectoryHandle(session.id);
      // 一覧の表示は小さい派生画像を使う（ADR-0005）。なければ原本を検証して表示する
      const want = Math.ceil(256 * (globalThis.devicePixelRatio || 1));
      const r = await loadDisplayImage(dir, name, want, IMAGE_MAX_BYTES, await listVariants(dir));
      const prev = thumbs[name];
      if (prev && "url" in prev) URL.revokeObjectURL(prev.url);
      thumbs = {
        ...thumbs,
        [name]: r.ok
          ? { url: URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: r.mime })) }
          : { error: r.message },
      };
    } catch {
      thumbs = { ...thumbs, [name]: { error: "読み込めません" } };
    }
  }

  const fmt = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);
  const statusLabel = {
    pending: "未処理",
    validating: "検証中",
    saving: "保存中",
    done: "成功",
    failed: "失敗",
    cancelled: "キャンセル",
  } as const;
</script>

<section class="media" aria-labelledby="media-heading" data-testid="media-panel">
  <div class="head">
    <h3>
      <span id="media-heading">画像（media/）</span><HelpTip label="画像"
        ><span class="tip-p"
          >JPEG・PNG・GIF・WebP・AVIF を取り込めます。取り込むときに、縦横 {ORIGINAL_MAX_SIDE}px・{ORIGINAL_MAX_PIXELS /
            10_000}万画素・{ORIGINAL_MAX_BYTES / 1_048_576} MiB 以内に収め、撮影情報・位置情報などのメタデータを削除したものを原本として保存します。表示には幅
          {VARIANT_WIDTHS.join("・")}px の派生画像（WebP
          など、media/variants/）を使います。アニメーション画像は加工せずに保存します。</span
        ><span class="tip-p">取り込んだ画像は、編集を破棄しても削除されません。</span><span class="tip-p"
          >「参照あり／なし」の確認範囲は、この記事の保存済み本文と cover
          だけです。別の記事や独自の項目からの参照は確認しません。</span
        ></HelpTip
      >
    </h3>
    <div class="actions">
      <input
        bind:this={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
        class="sr-only"
        tabindex="-1"
        aria-hidden="true"
        onchange={onPick}
        data-testid="media-input"
      />
      <button type="button" onclick={() => input?.click()} disabled={!editable || ws.busy} data-testid="media-import"
        >画像を取り込む</button
      >
      {#if importing}
        <button type="button" onclick={() => ws.cancelImport()}>次のファイルから中止</button>
      {/if}
      <button type="button" onclick={() => ws.refreshMedia()} disabled={ws.busy}>一覧を更新</button>
    </div>
  </div>

  {#if ws.importJobs.length > 0}
    <ul class="jobs" aria-label="取り込みの状況">
      {#each ws.importJobs as j, i (i)}
        <li data-status={j.status}>
          <span class="badge">{statusLabel[j.status]}</span>
          <span class="mono">{j.fileName}</span>
          <span class="muted small">{j.message}</span>
          {#if j.status === "done" && j.name}
            <label class="alt"
              ><span>alt</span>
              <input
                type="text"
                bind:value={j.alt}
                placeholder="装飾画像なら空のまま"
                disabled={!editable}
                data-testid="job-alt"
              /></label
            >
            <button
              type="button"
              onclick={() => j.name && ws.insertImage(j.name, j.alt)}
              disabled={!editable}
              data-testid="job-insert">{j.inserted ? "もう一度挿入" : "本文に挿入"}</button
            >
            <button type="button" onclick={() => j.name && ws.setCover(j.name, j.alt)} disabled={!editable}
              >カバーにする</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if media?.error}
    <p class="err" role="alert">{media.error}</p>
  {:else if media && media.files.length === 0}
    <p class="muted small">この記事の media/ に画像はありません。</p>
  {:else if media}
    {#if refs?.status === "unknown"}
      <details class="muted small">
        <summary>参照状況不明：この記事の画像は CMS からは削除できません</summary>
        <ul>
          {#each refs.reasons as r, i (i)}<li>{r}</li>{/each}
        </ul>
      </details>
    {/if}
    <ul class="files">
      {#each media.files as f (f.name)}
        <li data-testid="media-file">
          <div class="row">
            <span class="mono name">{f.name}</span>
            {#if f.kind === "dir"}
              <span class="muted small">フォルダ（CMS では扱いません）</span>
            {:else}
              <span class="muted small"
                >{fmt(f.size)}・{refLabel(f.name)}{f.variants ? `・派生画像 ${f.variants} 件` : ""}</span
              >
            {/if}
          </div>
          {#if f.kind === "file"}
            <div class="row">
              <label class="alt"
                ><span>alt</span><input
                  type="text"
                  value={alts[f.name] ?? ""}
                  oninput={(e) => (alts = { ...alts, [f.name]: e.currentTarget.value })}
                  disabled={!editable}
                /></label
              >
              <button type="button" onclick={() => ws.insertImage(f.name, alts[f.name] ?? "")} disabled={!editable}
                >本文に挿入</button
              >
              <button type="button" onclick={() => ws.setCover(f.name, alts[f.name] ?? "")} disabled={!editable}
                >カバーにする</button
              >
              <button type="button" onclick={() => show(f.name)}>表示</button>
              <button
                type="button"
                class="danger"
                onclick={() => ws.deleteMedia(f.name)}
                disabled={ws.busy || !editable || refs === null || refs.status === "unknown" || refs.names.has(f.name)}
                data-testid="media-delete">削除…</button
              >
            </div>
            {#if thumbs[f.name]}
              {@const t = thumbs[f.name]}
              {#if t && "url" in t}
                <img src={t.url} alt={alts[f.name] ?? ""} class="thumb" />
              {:else if t}
                <p class="muted small">表示しません：{t.error}</p>
              {/if}
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .media {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  h3 {
    margin: 0;
    font-size: 1rem;
  }
  .small {
    font-size: 0.8125rem;
    margin: 0;
  }
  .jobs,
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .jobs li,
  .files li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 0.5rem;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.375rem 0.5rem;
  }
  .files li {
    flex-direction: column;
    align-items: stretch;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 0.5rem;
    align-items: center;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .alt {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    font-size: 0.8125rem;
  }
  .thumb {
    max-width: 16rem;
    max-height: 12rem;
    object-fit: contain;
    border: 1px solid var(--border);
  }
  li[data-status="failed"] .badge {
    border-color: var(--ng);
  }
  .err {
    color: var(--ng);
    margin: 0;
  }
</style>
