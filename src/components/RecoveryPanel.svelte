<script lang="ts">
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { encodeUtf8, sha256Hex } from "../lib/core/bytes";
  import type { DraftRecord } from "../lib/drafts/store";
  import { readDiskArticle } from "../lib/fs/save";

  /**
   * 復旧ドラフトの候補。上部バーのメニュー「復旧ドラフト」の窓に出す。
   * count：候補の数（メニューの項目の数と、トグルの印に使う）。
   */
  let { ws, count = $bindable(0) }: { ws: Workspace; count?: number } = $props();

  const dc = $derived(ws.drafts);
  const mine = $derived((dc?.records ?? []).filter((r) => r.ws === dc?.wsId).sort((a, b) => b.savedAt - a.savedAt));
  const others = $derived((dc?.records ?? []).filter((r) => r.ws !== dc?.wsId));
  /** 記事ごとの最新世代だけを候補に出し、古い世代は折りたたむ */
  const latest = $derived(mine.filter((r, i) => mine.findIndex((x) => x.key === r.key) === i && !isOpen(r)));
  const older = $derived(mine.filter((r) => !latest.includes(r) && !isOpen(r)));
  const total = $derived(latest.length + older.length + others.length);

  $effect(() => {
    count = total;
  });

  let disk = $state<Record<string, string>>({});
  let checks = $state<Record<string, boolean>>({});

  function isOpen(r: DraftRecord): boolean {
    const s = ws.session;
    if (!s) return false;
    return r.isNew
      ? r.key === `n:${s.draftTempKey}`
      : !s.isNew && r.articleId === s.id && r.sessionNonce === s.draftNonce;
  }

  const k = (r: DraftRecord) => `${r.ws}|${r.key}|${r.seq}`;

  $effect(() => {
    for (const r of [...latest, ...older, ...others]) void inspect(r);
  });

  async function inspect(r: DraftRecord) {
    const key = k(r);
    if (key in checks) return;
    checks = { ...checks, [key]: (await sha256Hex(encodeUtf8(r.text))) === r.checksum };
    if (r.isNew || r.ws !== dc?.wsId || !ws.articles) {
      disk = { ...disk, [key]: r.isNew ? "未保存の新規記事" : "未確認" };
      return;
    }
    const d = await readDiskArticle(ws.articles, r.articleId);
    let label = "未確認";
    if (d.state.kind === "missing") label = "ディスクに記事がありません";
    else if (d.state.kind === "bytes")
      label = (await sha256Hex(d.state.bytes)) === r.baseHash ? "基準版と一致" : "基準版と相違（外部変更）";
    disk = { ...disk, [key]: label };
  }

  function download(r: DraftRecord) {
    const blob = new Blob([encodeUtf8(r.text) as Uint8Array<ArrayBuffer>], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.articleId || "article"}-draft-${r.seq}.md`;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function remove(r: DraftRecord) {
    const v = await ws.ask({
      title: "復旧ドラフトを削除します",
      message: `${r.isNew ? "未保存の新規記事" : r.articleId} のドラフト（${new Date(r.savedAt).toLocaleString("ja-JP")}）を削除します。`,
      details: ["削除したドラフトは戻せません。必要なら先に「原文をダウンロード」してください。"],
      buttons: [
        { label: "削除する", value: "delete", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v === "delete") await dc?.remove(r);
  }
</script>

{#snippet row(r: DraftRecord, associated: boolean)}
  <li data-testid="draft-candidate">
    <div>
      <strong>{r.isNew ? "未保存の新規記事" : r.articleId}</strong>
      <span class="muted small">
        {new Date(r.savedAt).toLocaleString("ja-JP")}・リビジョン {r.revision}・基準ハッシュ
        <span class="mono">{r.baseHash ? r.baseHash.slice(0, 12) : "なし"}</span>
      </span>
    </div>
    <div class="muted small">
      ディスク：{associated ? (disk[k(r)] ?? "確認中") : "関連先未確認"}・内容：{checks[k(r)] === undefined
        ? "確認中"
        : checks[k(r)]
          ? "チェックサム一致"
          : "破損（チェックサム不一致）"}
    </div>
    <div class="buttons">
      {#if associated && checks[k(r)]}
        <button type="button" class="primary" onclick={() => ws.openDraft(r)} disabled={ws.busy}>編集として開く</button>
      {/if}
      <button type="button" onclick={() => download(r)}>原文をダウンロード</button>
      <button type="button" class="danger" onclick={() => remove(r)}>削除…</button>
    </div>
  </li>
{/snippet}

{#if dc && dc.mode === "unavailable"}
  <p class="muted" data-testid="recovery-unavailable">このブラウザでは復旧ドラフトを使えません。</p>
{:else if total === 0}
  <p class="muted" data-testid="recovery-empty">復旧ドラフトはありません。</p>
{:else}
  <div data-testid="recovery-panel">
    {#if latest.length > 0}
      <ul class="list">
        {#each latest as r (k(r))}{@render row(r, true)}{/each}
      </ul>
    {/if}
    {#if older.length > 0}
      <details>
        <summary>古い世代（{older.length}件）</summary>
        <ul class="list">
          {#each older as r (k(r))}{@render row(r, true)}{/each}
        </ul>
      </details>
    {/if}
    {#if others.length > 0}
      <details>
        <summary>関連先未確認のドラフト（{others.length}件）</summary>
        <p class="muted small">
          この作業フォルダと同じか確認できないドラフトです。別の記事へ自動では適用しません。原文をダウンロードして内容を確認してください。
        </p>
        <ul class="list">
          {#each others as r (k(r))}{@render row(r, false)}{/each}
        </ul>
      </details>
    {/if}
  </div>
{/if}

<style>
  .list {
    list-style: none;
    margin: var(--space-8) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  .list li {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .buttons {
    display: flex;
    gap: var(--control-gap);
    flex-wrap: wrap;
  }
  .small {
    font-size: var(--font-size-13);
    margin: 0;
  }
</style>
