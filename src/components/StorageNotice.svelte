<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import type { PlacesController } from "../lib/app/places.svelte";

  let { places }: { places: PlacesController } = $props();

  /** 「保存領域を消さないよう求める」を押して、結果を待っている間 */
  let asking = $state(false);
  /** 求めた結果（押したあとに、許可されたか・できないかを示す）。空のときは何も出さない */
  let answer = $state("");

  function mb(n: number): string {
    return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  async function askPersist() {
    asking = true;
    answer = "";
    try {
      await places.checkPersist(true);
    } finally {
      asking = false;
    }
    answer =
      places.persist === "persisted"
        ? "許可されました。このブラウザは、保存領域を消さないようにします。"
        : places.persist === "not-persisted"
          ? "ブラウザは許可しませんでした。ブラウザの判断で保存領域が消されることがあります。こまめに書き出すか、GitHub と同期してください。"
          : "このブラウザでは、保存領域を消さないよう求められません。こまめに書き出すか、GitHub と同期してください。";
  }
</script>

<div class="notices" data-testid="storage-notice">
  <p class="note" class:warn={places.persist !== "persisted"} data-testid="persist-state" data-state={places.persist}>
    {#if places.persist === "persisted"}
      このブラウザに保存領域を消さないよう求めました（許可済み）。それでも、ブラウザのデータ消去・アプリの削除では消えます。
    {:else}
      ブラウザが保存領域を消去することがあります（作業場所・復旧ドラフト・設定を含みます）。こまめに書き出すか、GitHub
      と同期してください。
    {/if}
    {#if places.usage}
      <span class="muted">使用量 {mb(places.usage.usage)} ／ 上限の目安 {mb(places.usage.quota)}</span>
    {/if}
  </p>
  {#if places.persist === "not-persisted" || !places.standalone}
    <div class="row">
      {#if places.persist === "not-persisted"}
        <button type="button" onclick={askPersist} disabled={asking} data-testid="persist-ask"
          >{asking ? "確認しています…" : "保存領域を消さないよう求める"}</button
        >
      {/if}
      {#if !places.standalone}
        <span data-testid="homescreen-tip"
          ><HelpTip label="保存領域"
            >iPhone・iPad では、共有メニューの「ホーム画面に追加」から開くと、保存領域が消されにくくなります。</HelpTip
          ></span
        >
      {/if}
    </div>
  {/if}
  <!-- 求めた結果。空のときは何も出さないが、中身が変わったときに読み上げられるよう、要素は残しておく -->
  <p class="answer" role="status" data-testid="persist-answer">{answer}</p>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .notices {
    margin-block: var(--space-8) var(--space-12);
  }
  .note {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-14);
  }
  .note.warn {
    border-inline-start: 3px solid var(--color-warning-border);
    padding-inline-start: var(--space-8);
  }
  .note .muted {
    display: block;
  }
  .answer {
    margin: 0;
    font-size: var(--font-size-14);
  }
  .answer:not(:empty) {
    margin-block: var(--space-4) var(--space-8);
  }
</style>
