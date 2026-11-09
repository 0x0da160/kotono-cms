<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { PwaController } from "../lib/app/pwa.svelte";

  /**
   * アプリの新しい版を確かめ、切り替える操作（仕様 29.3・38.5）。
   * 「設定」の画面と最初の画面のフッターに置く。配信のしかたによって使えないときも、その理由と新しい版にする方法を示す。
   */
  let {
    pwa,
    onapply,
    onreload,
  }: {
    pwa: PwaController;
    /** 新しい版へ切り替える（未保存の編集の確認は呼び出し側） */
    onapply: () => void;
    /** ページを読み込み直す（未保存の編集の確認は呼び出し側） */
    onreload: () => void;
  } = $props();
</script>

<div class="app-update" data-testid="app-update">
  {#if pwa.updateReady}
    <p class="ready" role="status">
      新しい版を取得しました。
      <button type="button" class="primary" onclick={onapply} data-testid="update-apply">新しい版に切り替える</button>
    </p>
  {:else if pwa.active}
    <p class="row">
      <button
        type="button"
        onclick={() => pwa.check()}
        disabled={pwa.checkState === "checking" || pwa.checkState === "fetching"}
        data-testid="update-check"><RefreshCw />新しい版を確かめる</button
      >
      <span role="status" data-testid="update-check-result" data-state={pwa.checkState}>
        {#if pwa.checkState === "checking"}
          確かめています…
        {:else if pwa.checkState === "fetching"}
          新しい版を取得しています…
        {:else if pwa.checkState === "latest"}
          いまの版が最新です。
        {:else if pwa.checkState === "failed"}
          新しい版を確かめられませんでした。ネットワークにつながっているか確認してください。
        {/if}
      </span>
    </p>
  {:else if pwa.fromFile}
    <p class="muted" data-testid="update-unavailable">
      ファイルから開いているため、新しい版は自動では取得しません。新しい版の <code>kotono-cms.html</code>
      に差し替えてから開き直してください。
    </p>
  {:else}
    <p class="row">
      <button type="button" onclick={onreload} data-testid="update-reload"><RefreshCw />ページを読み込み直す</button>
      <span class="muted" data-testid="update-unavailable"
        >このブラウザでは新しい版を確かめられません。読み込み直すと、配信されている版になります。</span
      >
    </p>
  {/if}
</div>

<style>
  .app-update p {
    margin: var(--space-8) 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--control-gap) var(--space-12);
  }
  .ready {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--control-gap) var(--space-12);
  }
  .muted {
    color: var(--color-fg-muted);
  }
</style>
