<script lang="ts">
  import type { PlacesController } from "../lib/app/places.svelte";

  let { places }: { places: PlacesController } = $props();

  function mb(n: number): string {
    return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
</script>

<div class="notices" data-testid="storage-notice">
  {#if places.sharedOrigin}
    <p class="note warn" data-testid="shared-origin">
      開発版です。この配信元（github.io）は他のページと保存領域を共有するため、実際の記事データでの利用は推奨しません。
    </p>
  {/if}
  <p class="note" class:warn={places.persist !== "persisted"} data-testid="persist-state" data-state={places.persist}>
    {#if places.persist === "persisted"}
      このブラウザに、保存領域を消さないよう求めました（許可済み）。それでも、ブラウザのデータ消去・アプリの削除では消えます。
    {:else}
      ブラウザが保存領域を消去することがあります（作業場所・復旧ドラフト・設定を含みます）。こまめに書き出すか、GitHub
      と同期してください。
    {/if}
    {#if places.usage}
      <span class="muted">使用量 {mb(places.usage.usage)} ／ 上限の目安 {mb(places.usage.quota)}</span>
    {/if}
  </p>
  {#if places.persist === "not-persisted"}
    <button type="button" onclick={() => places.checkPersist(true)} data-testid="persist-ask"
      >保存領域を消さないよう求める</button
    >
  {/if}
  {#if !places.standalone}
    <p class="note muted small" data-testid="homescreen-tip">
      iPhone・iPad では、共有メニューの「ホーム画面に追加」から開くと、保存領域が消されにくくなります。
    </p>
  {/if}
</div>

<style>
  .notices {
    margin-block: 0.5rem 0.75rem;
  }
  .note {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
  }
  .note.warn {
    border-inline-start: 3px solid var(--ng);
    padding-inline-start: 0.5rem;
  }
  .note .muted {
    display: block;
  }
  .small {
    font-size: 0.8125rem;
  }
</style>
