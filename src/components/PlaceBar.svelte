<script lang="ts">
  import Download from "@lucide/svelte/icons/download";
  import { LOCK_MINUTE_CHOICES, type PlacesController } from "../lib/app/places.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import type { GitController } from "../lib/app/git.svelte";
  import type { WorkspaceMeta } from "../lib/workspaces/store";
  import type { Snippet } from "svelte";

  let {
    places,
    ws,
    git,
    meta,
    sync,
    part = "status",
  }: {
    places: PlacesController;
    ws: Workspace;
    git: GitController;
    meta: WorkspaceMeta;
    sync?: Snippet;
    /**
     * アプリの外枠（docs/knowledge/product/app-shell.md）のどこに出すか。
     * status：お知らせの帯（書き出しの状態・書き出す操作・お知らせ）。settings：「設定」の画面（解錠の方法と自動ロック）。
     * 作業場所の一覧・ロックは上部バーにある。
     */
    part?: "status" | "settings";
  } = $props();

  const days = $derived(places.remindDays(meta));

  /** 書き出し前に、未保存・未コミットを示す（38.3） */
  async function exportNow() {
    const details: string[] = [];
    if (ws.session?.dirty) details.push("編集中の記事に未保存の変更があります。書き出しには含まれません。");
    const changed = Object.values(git.statuses ?? {}).filter((s) => s.state !== "clean").length;
    if (changed > 0) details.push(`未コミットの記事が ${changed} 件あります（ファイルとしては書き出しに含まれます）。`);
    const v = await ws.ask({
      title: "作業場所を書き出します",
      message:
        "既定では暗号化して書き出します（.kotono）。別の端末でも、このログインの回復コード（またはこのログインで登録した、同期しているパスキー）で開けます。平文の zip は誰でも中身を読めます。",
      details,
      buttons: [
        { label: "暗号化して書き出す", value: "sealed", variant: "primary" },
        { label: "平文の zip にする", value: "plain" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "sealed",
    });
    if (v === "cancel") return;
    await places.export(meta, v === "plain");
  }
</script>

{#if part === "status"}
  <div class="placebar" data-testid="placebar">
    <div class="status">
      {#if days !== null}
        <span class="unsynced" class:warn={places.shouldRemind(meta)} data-testid="unsynced"
          >書き出し・同期していない変更あり（{days} 日）</span
        >
      {:else}
        <span class="muted small" data-testid="unsynced-none">書き出し・同期していない変更はありません</span>
      {/if}
      {#if places.persist !== "persisted"}<span class="badge unknown" title="ブラウザが保存領域を消去することがあります"
          >消去されることがあります</span
        >{/if}
      <button
        type="button"
        class="export"
        onclick={exportNow}
        disabled={places.busy || ws.busy}
        data-testid="place-export-open"><Download />書き出す</button
      >
    </div>
    {#if places.error}<p class="banner" role="alert">{places.error}</p>{/if}
    {#if places.info}<p class="banner info" role="status">{places.info}</p>{/if}
    {#if places.shouldRemind(meta)}
      <p class="banner" role="status" data-testid="backup-remind">
        最後の書き出し・同期から {days} 日たちました。ブラウザのデータ消去に備えて、書き出すか同期してください。
      </p>
    {/if}
    {@render sync?.()}
  </div>
{:else}
  <section class="card settings" aria-labelledby="place-settings-heading" data-testid="place-settings">
    <h2 id="place-settings-heading">自動ロック</h2>
    <p class="small muted">
      作業場所は起動時のログインの鍵で暗号化しています。ロックするとログインの画面に戻り、パスキーか回復コードでログインし直すと開けます。
    </p>
    <label class="row"
      >自動ロック
      <select bind:value={places.lockMinutes} data-testid="lock-minutes">
        {#each LOCK_MINUTE_CHOICES as m (m)}
          <option value={m}>{m === 0 ? "しない" : `${m} 分操作がなければ`}</option>
        {/each}
      </select>
    </label>
  </section>
{/if}

<style>
  /* お知らせの帯の1行目：状態の文と「書き出す」。帯の外枠（余白・区切り）は App.svelte が持つ */
  .status {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-8);
    align-items: center;
  }
  .export {
    margin-inline-start: auto;
  }
  .card {
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin-block-end: var(--space-12);
  }
  h2 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-18);
  }
  .unsynced {
    font-size: var(--font-size-14);
  }
  .warn {
    color: var(--color-warning-fg);
    font-weight: var(--font-weight-strong);
  }
  .banner {
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: var(--space-8) 0 0;
    font-size: var(--font-size-14);
    background: var(--color-danger-bg);
  }
  .banner.info {
    border-color: var(--color-info-border);
    background: var(--color-info-bg);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: var(--font-size-14);
  }
  label.row {
    flex-direction: row;
    align-items: center;
    gap: var(--control-gap);
    margin-top: var(--space-8);
  }
  select {
    font: inherit;
    font-size: var(--font-size-16);
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
  }
  .small {
    font-size: var(--font-size-13);
  }
</style>
