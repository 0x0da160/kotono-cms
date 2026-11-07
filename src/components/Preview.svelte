<script lang="ts">
  import { onDestroy } from "svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import {
    PREVIEW_MAX_IMAGES,
    PROVISIONAL_PREVIEW_IMAGE_MAX_BYTES,
    PROVISIONAL_PREVIEW_TOTAL_IMAGE_BYTES,
  } from "../lib/core/budgets";
  import { collectImages, renderHtml, type ImageSource, type PreviewLink } from "../lib/core/markdown";
  import { listVariants, loadDisplayImage, toDataUrl } from "../lib/fs/media";
  import type { VariantRef } from "../lib/fs/optimize";
  import { buildSrcdoc, PREVIEW_CSS } from "../lib/preview/frame";

  let { ws, session }: { ws: Workspace; session: EditorSession } = $props();

  let srcdoc = $state("");
  let links = $state<PreviewLink[]>([]);
  /** 最後に描画したリビジョン。現在の文書と違えば「古い版」と表示する（14） */
  let renderedRevision = $state<number | null>(null);
  let stopped = $state<string | null>(null);
  let imageNote = $state<string | null>(null);
  let styleHash: string | null = null;
  let frameEl: HTMLIFrameElement | undefined = $state();
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 画像の表示用資源。記事の切替・画像の取り込み・削除・再読込で破棄する（16.2・17.3） */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 描画の内部キャッシュ（表示状態ではない）
  let cache = new Map<string, ImageSource>();
  let cacheKey = "";

  const body = $derived(session.analysis.split.ok ? session.analysis.split.body : null);
  const stale = $derived(renderedRevision !== null && renderedRevision !== session.revision);

  async function hash(): Promise<string> {
    if (styleHash) return styleHash;
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PREVIEW_CSS));
    styleHash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`;
    return styleHash;
  }

  $effect(() => {
    const b = body;
    const rev = session.revision;
    // メディア一覧が変わったら画像の表示用資源を作り直す
    const mediaKey = ws.media ? ws.media.files.map((f) => `${f.name}:${f.size}`).join("|") : "";
    if (mediaKey !== cacheKey) {
      cache = new Map();
      cacheKey = mediaKey;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void render(b, rev), 250);
  });

  onDestroy(() => {
    if (timer) clearTimeout(timer);
    token++;
    cache.clear();
  });

  async function render(b: string | null, rev: number) {
    const my = ++token;
    if (b === null) {
      stopped = "frontmatter の区切りが不正なため、本文を特定できません。";
      return;
    }
    const p = await ws.md.tree(b);
    if (my !== token) return;
    if (!p.ok) {
      // 全文プレビューは止める。最後の正常な表示は「古い版」として残す（34.2・14）
      stopped = p.message;
      return;
    }
    const imgs = collectImages(p.tree);
    const sources: (ImageSource | null)[] = [];
    let total = 0;
    let shown = 0;
    let dir = null;
    let variants: Map<string, VariantRef[]> = new Map();
    if (!session.isNew && ws.articles) {
      try {
        dir = await ws.articles.getDirectoryHandle(session.id);
        variants = await listVariants(dir);
      } catch {
        dir = null;
      }
    }
    // 表示幅に合う派生画像を使う（ADR-0005）
    const want = Math.ceil((frameEl?.clientWidth || 800) * (globalThis.devicePixelRatio || 1));
    for (const im of imgs) {
      if (im.target.kind !== "media") {
        sources.push({
          kind: "placeholder",
          reason:
            im.target.kind === "external"
              ? "外部画像は読み込みません"
              : im.target.kind === "rejected"
                ? im.target.reason
                : "この記事の media/ 以外の画像は表示しません",
        });
        continue;
      }
      if (shown >= PREVIEW_MAX_IMAGES) {
        sources.push({ kind: "placeholder", reason: `同時に表示する画像の上限（${PREVIEW_MAX_IMAGES}）を超えました` });
        continue;
      }
      const cached = cache.get(im.target.name);
      if (cached) {
        sources.push(cached);
        if (cached.kind === "data") shown++;
        continue;
      }
      if (!dir) {
        sources.push({ kind: "placeholder", reason: session.isNew ? "保存前の記事には画像がありません" : "未読込" });
        continue;
      }
      const r = await loadDisplayImage(dir, im.target.name, want, PROVISIONAL_PREVIEW_IMAGE_MAX_BYTES, variants);
      if (my !== token) return;
      let src: ImageSource;
      if (!r.ok) src = { kind: "placeholder", reason: r.message };
      else if (total + r.bytes.length > PROVISIONAL_PREVIEW_TOTAL_IMAGE_BYTES)
        src = { kind: "placeholder", reason: "プレビューの画像容量の上限を超えました" };
      else {
        total += r.bytes.length;
        src = { kind: "data", url: toDataUrl(r.bytes, r.mime), width: r.info.width, height: r.info.height };
      }
      cache.set(im.target.name, src);
      if (src.kind === "data") shown++;
      sources.push(src);
    }
    const out = renderHtml(p.tree, sources);
    if (out.overBudget) {
      stopped = "プレビューの要素数が上限（20,000）を超えたため、全文の表示を止めました。原文の編集は続けられます。";
      return;
    }
    const h = await hash();
    if (my !== token) return;
    srcdoc = buildSrcdoc(out.html, h);
    links = out.links;
    renderedRevision = rev;
    stopped = null;
    const ph = sources.filter((s) => s?.kind === "placeholder").length;
    imageNote = ph > 0 ? `${ph} 件の画像はプレースホルダーで表示しています。` : null;
  }

  async function openLink(l: PreviewLink) {
    if (l.target.kind !== "external") return;
    const v = await ws.ask({
      title: "外部のリンクを開きます",
      message: `新しいタブで次の行先を開きます。外部との通信が発生します。`,
      details: [l.target.url],
      buttons: [
        { label: "開く", value: "open", variant: "primary" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    // 遷移先から CMS へアクセスさせない（16.3）
    if (v === "open") window.open(l.target.url, "_blank", "noopener,noreferrer");
  }

  function reloadImages() {
    cache = new Map();
    void render(body, session.revision);
  }
</script>

<section class="preview" aria-labelledby="preview-heading">
  <div class="head">
    <h3 id="preview-heading">プレビュー</h3>
    <button type="button" onclick={reloadImages}>画像を読み直す</button>
  </div>
  <p class="muted small">
    未保存の内容を表示します。公開サイトの見た目・URL は保証しません。スクリプト・生 HTML・外部画像は表示しません。
  </p>
  {#if stopped}
    <p class="warn" role="status" data-testid="preview-stopped">プレビュー停止：{stopped}</p>
  {/if}
  {#if stale || (stopped && renderedRevision !== null)}
    <p class="warn" data-testid="preview-stale">古い版：現在の原文ではなく、以前の内容を表示しています。</p>
  {/if}
  {#if imageNote}<p class="muted small">{imageNote}</p>{/if}
  <iframe
    bind:this={frameEl}
    sandbox=""
    title="記事のプレビュー（操作できません）"
    {srcdoc}
    referrerpolicy="no-referrer"
    data-testid="preview-frame"
  ></iframe>
  {#if links.length > 0}
    <details class="links">
      <summary>リンクの行先（{links.length}件）</summary>
      <ol>
        {#each links as l (l.n)}
          <li>
            <span class="mono">[{l.n}]</span>
            {l.text || "（文字なし）"} —
            <span class="mono url">{l.url}</span>
            {#if l.target.kind === "external"}
              <button type="button" onclick={() => openLink(l)}>開く</button>
            {:else if l.target.kind === "rejected"}
              <span class="muted">開けません：{l.target.reason}</span>
            {:else}
              <span class="muted">サイト内の行先として解決しません</span>
            {/if}
          </li>
        {/each}
      </ol>
    </details>
  {/if}
</section>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-8);
  }
  h3 {
    margin: 0;
    font-size: var(--font-size-16);
  }
  iframe {
    width: 100%;
    min-height: 24rem;
    height: 60vh;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    resize: vertical;
  }
  .warn {
    margin: 0;
    border: 1px solid var(--color-ng);
    border-radius: var(--radius-md);
    padding: var(--space-6) var(--space-10);
  }
  .small {
    font-size: var(--font-size-13);
    margin: 0;
  }
  .links ol {
    margin: var(--space-4) 0 0;
    padding-inline-start: var(--space-20);
    font-size: var(--font-size-14);
  }
  .url {
    overflow-wrap: anywhere;
  }
</style>
