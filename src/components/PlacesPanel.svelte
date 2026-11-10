<script lang="ts">
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import HelpTip from "./HelpTip.svelte";
  import type { PlacesController, PlaceView } from "../lib/app/places.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import type { WorkspaceMeta } from "../lib/workspaces/store";
  import UnlockForm from "./UnlockForm.svelte";
  import StorageNotice from "./StorageNotice.svelte";

  let { places, ws }: { places: PlacesController; ws: Workspace } = $props();

  let newName = $state("");
  let importName = $state("");
  /** 「…」（書き出す・削除をまとめる）を開いている行の ID */
  let moreOpen = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  const views = $derived(places.views());

  $effect(() => {
    if (places.pendingImport) importName = places.pendingImport.name;
  });

  /** 「…」を開く・閉じる（別の行の「…」を押したら、その行へ移る） */
  function toggleMore(id: string) {
    moreOpen = moreOpen === id ? null : id;
  }

  /** 「…」を閉じる。refocus のとき、その「…」へ戻す（キーボードの位置を失わせない） */
  function closeMore(refocus = false) {
    const id = moreOpen;
    moreOpen = null;
    if (refocus && id !== null) document.querySelector<HTMLElement>(`[data-more-toggle="${CSS.escape(id)}"]`)?.focus();
  }

  /** 「…」の外を押したら閉じる */
  function onWindowPointer(e: PointerEvent) {
    if (moreOpen === null) return;
    if (e.target instanceof Element && e.target.closest(".more")) return;
    moreOpen = null;
  }

  /** Esc で「…」を閉じて、その「…」へ戻す */
  function onWindowKey(e: KeyboardEvent) {
    if (moreOpen !== null && e.key === "Escape") {
      e.preventDefault();
      closeMore(true);
    }
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const m = await places.create(newName);
    if (!m) return;
    newName = "";
    await places.open(m);
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) await places.prepareImport(f);
  }

  async function confirmImport(e: SubmitEvent) {
    e.preventDefault();
    const m = await places.confirmImport(importName);
    if (m) await places.open(m);
  }

  async function remove(v: PlaceView) {
    const e = v.entry;
    const details: string[] = [];
    if (e.state === "ok") {
      const m = e.meta;
      const since = places.remindDays(m);
      details.push(
        m.lastExportAt ? `最後に書き出しを開始した日時：${fmt(m.lastExportAt)}` : "まだ書き出していません。",
        m.lastSyncAt ? `最後に同期した日時：${fmt(m.lastSyncAt)}` : "GitHub と同期していません。",
      );
      if (since !== null) details.push(`書き出し・同期していない変更があります（${since} 日前から）。`);
      details.push("暗号化した作業場所です。書き出しがなければ、削除後は誰も内容を戻せません。");
      if (v.locked) details.push("このログインでは開けない作業場所です（ログインを作り直す前に作りました）。");
    } else details.push("作成・取り込みの途中で止まった作業場所です。");
    details.push("削除前の退避（退避領域）は残しますが、退避領域もブラウザのデータ消去から守られません。");
    const ok = await ws.ask({
      title: `「${v.label}」を削除します`,
      message: "作業場所の中身（記事・画像・.git・設定）をこの端末から削除します。元に戻せません。",
      details,
      buttons: [
        { label: "削除する", value: "delete", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (ok === "delete") await places.remove(v.id);
  }

  async function exportPlace(meta: WorkspaceMeta) {
    const v = await ws.ask({
      title: "書き出しの形式",
      message:
        "既定では暗号化して書き出します（.kotono）。別の端末でも、このログインの回復コード（またはこのログインで登録した、同期しているパスキー）で開けます。平文の zip は誰でも中身を読めます。",
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

  function fmt(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
  }

  function sizeText(n: number): string {
    if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onWindowKey} />

<!-- 行の「…」：書き出す（暗号化・平文の選択つき）と削除をまとめる。書き出せるのは開ける作業場所だけ -->
{#snippet more(v: PlaceView, exportMeta: WorkspaceMeta | null)}
  <div class="more">
    <button
      type="button"
      class="more-toggle"
      aria-expanded={moreOpen === v.id}
      aria-label="「{v.label}」のほかの操作"
      title="ほかの操作"
      data-more-toggle={v.id}
      onclick={() => toggleMore(v.id)}
      data-testid="place-more"><Ellipsis aria-hidden="true" /></button
    >
    {#if moreOpen === v.id}
      <div class="more-list" data-testid="place-more-list">
        {#if exportMeta}
          <button
            type="button"
            onclick={() => {
              closeMore(true);
              void exportPlace(exportMeta);
            }}
            disabled={places.busy}
            data-testid="place-export">書き出す</button
          >
        {/if}
        <button
          type="button"
          class="danger"
          onclick={() => {
            closeMore(true);
            void remove(v);
          }}
          disabled={places.busy}
          data-testid="place-remove">削除</button
        >
      </div>
    {/if}
  </div>
{/snippet}

<!-- 新しい作業場所・取り込み。作業場所がもうあるときは、折り畳んだ中に出す -->
{#snippet addForms()}
  <form class="sub" onsubmit={create} data-testid="place-create">
    <h3>新しい作業場所</h3>
    <label>名前 <input bind:value={newName} maxlength="80" required data-testid="place-name" /></label>
    <p class="small muted">記事・画像・Git の履歴は、ログインの鍵で暗号化して保存します。</p>
    <div class="actions">
      <button type="submit" class="primary" disabled={places.busy} data-testid="place-create-run">作る</button>
    </div>
  </form>
  <div class="sub">
    <h3>
      取り込む<HelpTip label="取り込み"
        >リポジトリのフォルダを zip にしたもの、または Kotono CMS
        で暗号化して書き出したファイル（.kotono）を選びます。既存の作業場所へは上書きしません。</HelpTip
      >
    </h3>
    <input
      bind:this={fileInput}
      type="file"
      accept=".zip,.kotono,application/zip"
      class="sr-only"
      onchange={onFile}
      data-testid="import-file"
    />
    <button type="button" onclick={() => fileInput?.click()} disabled={places.busy}>ファイルを選ぶ</button>
  </div>
{/snippet}

<section class="card" aria-labelledby="places-heading" data-testid="places">
  <h2>
    <span id="places-heading">作業場所</span><HelpTip label="作業場所"
      >記事・画像・Git の履歴は、このブラウザ内の作業場所に保存します。作業場所ごとに別のリポジトリとして扱います。</HelpTip
    >
  </h2>

  {#if places.storageError !== null}
    <!-- 保存領域を開けないと、作業場所を作る・取り込むことができない。欄は出さず、理由とやり直しを示す -->
    <div class="banner" role="alert" data-testid="storage-error">
      <p><strong>ブラウザ内の保存領域（OPFS）を開けません。</strong>作業場所を作る・開くことができません。</p>
      <p class="small">理由：{places.storageError}</p>
      <ul class="small">
        <li>プライベートブラウズでは使えません。通常のタブで開いてください。</li>
        <li>iPhone・iPad では、「設定」の Safari で「すべての Cookie をブロック」がオフか確かめてください。</li>
        <li>それでも開けないときは、Safari を終了してから開き直してください。</li>
      </ul>
      <button type="button" onclick={() => places.retry()} disabled={places.busy} data-testid="storage-retry"
        >もう一度試す</button
      >
    </div>
  {:else}
    <StorageNotice {places} />
  {/if}

  {#if places.error}<p class="banner" role="alert" data-testid="places-error">{places.error}</p>{/if}
  {#if places.info}<p class="banner info" role="status" data-testid="places-info">{places.info}</p>{/if}

  {#if places.needsLogin}
    <p class="banner info" role="status" data-testid="places-need-login">
      ブラウザ内の作業場所は、起動時のログイン（パスキー）の鍵で暗号化します。ログインしていないため、作業場所を作る・開くことはできません。https
      の配信元から開いてログインしてください。
    </p>
  {:else}
    {#if views.length > 0}
      <ul class="places" data-testid="places-list">
        {#each views as v (v.id)}
          {@const e = v.entry}
          <li data-testid="place" data-state={e.state} data-locked={v.locked}>
            <div class="head">
              <span class="name">{v.label}</span>
              {#if e.state === "ok"}<span class="badge">{v.locked ? "開けません" : "解錠中"}</span>{/if}
              {#if e.state !== "ok"}<span class="badge err">不完全</span>{/if}
            </div>
            {#if e.state === "ok"}
              {@const days = places.remindDays(e.meta)}
              <p class="muted small meta">
                {#if days !== null}
                  <span class:warn={places.shouldRemind(e.meta)}>書き出し・同期していない変更あり（{days} 日）</span>
                {:else if e.meta.lastExportAt || e.meta.lastSyncAt}
                  書き出し・同期していない変更はありません
                {/if}
                {#if e.meta.lastExportAt}・書き出し開始：{fmt(e.meta.lastExportAt)}{/if}
                {#if e.meta.lastSyncAt}・同期：{fmt(e.meta.lastSyncAt)}{/if}
              </p>
              <div class="actions">
                {#if !v.locked}
                  <button
                    type="button"
                    class="primary"
                    onclick={() => places.open(e.meta)}
                    disabled={places.busy}
                    data-testid="place-open">開く</button
                  >
                {/if}
                {@render more(v, v.locked ? null : e.meta)}
              </div>
              {#if v.locked}
                <p class="muted small" data-testid="place-other-login">
                  このログインでは開けません。ログインを作り直す前に作った作業場所です。書き出し（.kotono）があれば、その時のログインの回復コードで取り込めます。
                </p>
              {/if}
            {:else}
              <p class="muted small">{e.reason}</p>
              <div class="actions">
                {@render more(v, null)}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">作業場所はまだありません。新しく作るか、zip・暗号化した書き出しから取り込んでください。</p>
    {/if}

    {#if places.pendingSealed}
      {@const s = places.pendingSealed}
      <div class="sub" data-testid="import-sealed">
        <h3>暗号化した書き出しを開く</h3>
        <p class="small">
          「{s.name}」は、別の端末（または作り直す前のログイン）で書き出したものです。書き出したログインの回復コード{s.passkey
            ? "か、そのログインで登録したパスキー"
            : ""}で開けます。
        </p>
        <UnlockForm busy={places.busy} passkey={s.passkey} onunlock={(m) => places.unsealImport(m)} />
        <button type="button" onclick={() => places.cancelImport()}>取り消す</button>
      </div>
    {:else if places.pendingImport}
      {@const p = places.pendingImport}
      <form class="sub" onsubmit={confirmImport} data-testid="import-confirm">
        <h3>取り込みの確認</h3>
        <ul class="small">
          <li>ファイル {p.plan.files.length} 件・合計 {sizeText(p.plan.totalBytes)}</li>
          {#if p.plan.strippedRoot}<li>先頭のフォルダ「{p.plan.strippedRoot}」を外して展開します。</li>{/if}
          <li>{p.plan.hasGit ? "Git の履歴（.git）を含みます。" : "Git の履歴（.git）は含まれていません。"}</li>
          {#if p.plan.skipped.length > 0}<li>OS の付属物 {p.plan.skipped.length} 件は取り込みません。</li>{/if}
          <li>このログインの鍵で暗号化して保存します。</li>
        </ul>
        <label>作業場所の名前 <input bind:value={importName} maxlength="80" required data-testid="import-name" /></label
        >
        <div class="actions">
          <button type="submit" class="primary" disabled={places.busy} data-testid="import-run">取り込む</button>
          <button type="button" onclick={() => places.cancelImport()}>取り消す</button>
        </div>
      </form>
    {:else if places.store}
      {#if views.length === 0}
        {@render addForms()}
      {:else}
        <details class="add" data-testid="place-add">
          <summary>新しい作業場所・取り込み</summary>
          {@render addForms()}
        </details>
      {/if}
    {/if}
  {/if}
</section>

<style>
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
  h3 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-16);
  }
  .places {
    list-style: none;
    margin: 0 0 var(--space-16);
    padding: 0;
  }
  .places li {
    border-top: 1px solid var(--color-border-subtle);
    padding-block: var(--space-10);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--control-gap);
    flex-wrap: wrap;
  }
  .name {
    font-weight: var(--font-weight-strong);
    overflow-wrap: anywhere;
  }
  .meta {
    margin: var(--space-4) 0;
  }
  .warn {
    color: var(--color-warning-fg);
    font-weight: var(--font-weight-strong);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    margin-top: var(--space-8);
  }
  /* 「…」：行の中の操作を1つにまとめる。開いた一覧は、ほかの要素の上に重ねる */
  .more {
    position: relative;
  }
  .more-toggle {
    padding-inline: var(--space-8);
  }
  .more-list {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + var(--space-4));
    z-index: var(--z-popover);
    display: flex;
    flex-direction: column;
    min-width: 9rem;
    padding: var(--space-4);
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-control);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-2);
  }
  .more-list button {
    justify-content: flex-start;
    text-align: start;
    border-color: transparent;
    background: transparent;
  }
  .more-list button:not(:disabled):hover {
    background: var(--color-bg-hover);
  }
  @media (pointer: coarse) {
    .more-toggle,
    .more-list button {
      min-height: var(--touch-target);
    }
  }
  /* 新しい作業場所・取り込み：作業場所がもうあるときは、折り畳んでおく */
  .add {
    border-top: 1px solid var(--color-border-subtle);
    padding-top: var(--space-12);
    margin-top: var(--space-12);
  }
  .add > summary {
    display: flex;
    align-items: center;
    min-height: 2rem;
    cursor: pointer;
    font-weight: var(--font-weight-strong);
  }
  .add[open] > summary {
    margin-block-end: var(--space-8);
  }
  @media (pointer: coarse) {
    .add > summary {
      min-height: var(--touch-target-sm);
    }
  }
  .sub {
    border-top: 1px solid var(--color-border-subtle);
    padding-top: var(--space-12);
    margin-top: var(--space-12);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-block: var(--space-8);
  }
  input:not([type="checkbox"]) {
    font: inherit;
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg, transparent);
    color: inherit;
  }
  .banner {
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: 0 0 var(--space-12);
    background: var(--color-danger-bg);
  }
  div.banner > :first-child {
    margin-block-start: 0;
  }
  div.banner ul {
    margin: var(--space-4) 0 var(--space-8);
    padding-inline-start: 1.2em;
  }
  .banner.info {
    border-color: var(--color-info-border);
    background: var(--color-info-bg);
  }
  .small {
    font-size: var(--font-size-14);
  }
</style>
