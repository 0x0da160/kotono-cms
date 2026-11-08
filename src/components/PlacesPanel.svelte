<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import type { PlacesController, PlaceView } from "../lib/app/places.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import type { WorkspaceMeta } from "../lib/workspaces/store";
  import type { UnlockMethod } from "../lib/crypto/vault";
  import { accountName } from "../lib/crypto/passkey";
  import RecoveryCodeNotice from "./RecoveryCodeNotice.svelte";
  import UnlockForm from "./UnlockForm.svelte";
  import StorageNotice from "./StorageNotice.svelte";

  let { places, ws }: { places: PlacesController; ws: Workspace } = $props();

  let newName = $state("");
  let encrypt = $state(true);
  let importName = $state("");
  let importEncrypt = $state(true);
  let unlocking = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  const views = $derived(places.views());
  /** 解錠の入力欄を開いている行があるか（あれば、エラーはその欄の下に出す） */
  const unlockOpen = $derived(views.some((v) => v.locked && v.id === unlocking) && places.recoveryToShow === null);

  $effect(() => {
    if (places.pendingImport) importName = places.pendingImport.name;
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const m = await places.create(newName, encrypt && places.vault !== null);
    if (!m) return;
    newName = "";
    // 回復コードを表示している間は開かない（控えたことを確かめてから開く：39.2）
    if (!places.recoveryToShow) await places.open(m);
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) await places.prepareImport(f);
  }

  async function confirmImport(e: SubmitEvent) {
    e.preventDefault();
    const m = await places.confirmImport(importName, importEncrypt);
    if (m && !places.recoveryToShow) await places.open(m);
  }

  async function unlockAndOpen(meta: WorkspaceMeta, method: UnlockMethod) {
    if (await places.unlock(meta, method)) {
      unlocking = null;
      await places.open(meta);
    }
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
      if (m.keyring) details.push("暗号化した作業場所です。書き出しがなければ、削除後は誰も内容を戻せません。");
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
    let plain = false;
    if (meta.keyring) {
      const v = await ws.ask({
        title: "書き出しの形式",
        message:
          "既定では暗号化して書き出します（.kotono）。別の端末やデスクトップ版でも、回復コードかパスフレーズで開けます。平文の zip は誰でも中身を読めます。",
        buttons: [
          { label: "暗号化して書き出す", value: "sealed", variant: "primary" },
          { label: "平文の zip にする", value: "plain" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "sealed",
      });
      if (v === "cancel") return;
      plain = v === "plain";
    }
    await places.export(meta, plain);
  }

  function fmt(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
  }

  /** パスワード管理での回復コードのユーザー名。ロック中でも分かる ID から作る */
  function recoveryAccount(id: string): string {
    return accountName(id);
  }

  async function addPasskeyTo(id: string): Promise<boolean> {
    const e = places.entries.find((x) => x.state === "ok" && x.meta.id === id);
    return e?.state === "ok" ? places.addUnlock(e.meta, { kind: "passkey" }) : false;
  }

  function hasSlot(meta: WorkspaceMeta, kind: "passphrase" | "passkey"): boolean {
    return meta.keyring?.slots.some((s) => s.kind === kind) ?? false;
  }

  function sizeText(n: number): string {
    if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<section class="card" aria-labelledby="places-heading" data-testid="places">
  <h2>
    <span id="places-heading">作業場所</span><HelpTip label="作業場所"
      >記事・画像・Git の履歴は、このブラウザ内の作業場所に保存します。作業場所ごとに別のリポジトリとして扱います。</HelpTip
    >
  </h2>

  <StorageNotice {places} />

  {#if places.fallback && !places.anyUnlocked && places.passkeyPlaces > 0}
    <p class="small" data-testid="back-to-login">
      <button type="button" class="link" onclick={() => places.backToLogin()}>パスキーでログインに戻る</button>
    </p>
  {/if}

  <!-- 解錠の失敗は、入力した欄のすぐ下に出す（パネルの先頭では目に入らない） -->
  {#if places.error && !unlockOpen}<p class="banner" role="alert" data-testid="places-error">
      {places.error}
    </p>{/if}
  {#if places.info}<p class="banner info" role="status" data-testid="places-info">{places.info}</p>{/if}

  {#if places.recoveryToShow}
    {@const rid = places.recoveryToShow.id}
    <RecoveryCodeNotice
      code={places.recoveryToShow.code}
      account={recoveryAccount(rid)}
      passkey={places.vault?.passkey ? () => addPasskeyTo(rid) : null}
      ondone={async () => {
        const id = places.recoveryToShow?.id;
        places.recoveryToShow = null;
        const e = places.entries.find((x) => x.state === "ok" && x.meta.id === id);
        if (e?.state === "ok") await places.open(e.meta);
      }}
    />
  {:else}
    {#if views.length > 0}
      <ul class="places" data-testid="places-list">
        {#each views as v (v.id)}
          {@const e = v.entry}
          <li data-testid="place" data-state={e.state} data-locked={v.locked}>
            <div class="head">
              <span class="name">{v.label}</span>
              {#if e.state === "ok" && e.meta.keyring}<span class="badge">{v.locked ? "ロック中" : "解錠中"}</span>{/if}
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
                {#if v.locked}
                  <button
                    type="button"
                    class={unlocking === v.id ? "" : "primary"}
                    onclick={() => (unlocking = unlocking === v.id ? null : v.id)}
                    aria-expanded={unlocking === v.id}
                    data-testid="place-unlock">{unlocking === v.id ? "解錠をやめる" : "解錠する"}</button
                  >
                {:else}
                  <button
                    type="button"
                    class="primary"
                    onclick={() => places.open(e.meta)}
                    disabled={places.busy}
                    data-testid="place-open">開く</button
                  >
                  <button
                    type="button"
                    onclick={() => exportPlace(e.meta)}
                    disabled={places.busy}
                    data-testid="place-export">書き出す</button
                  >
                  {#if e.meta.keyring}
                    <button type="button" onclick={() => places.lock(v.id)} data-testid="place-lock">ロック</button>
                  {/if}
                {/if}
                <button
                  type="button"
                  class="danger"
                  onclick={() => remove(v)}
                  disabled={places.busy}
                  data-testid="place-remove">削除</button
                >
              </div>
              {#if v.locked && unlocking !== v.id}
                <p class="muted small">
                  {e.state === "ok" && e.meta.name
                    ? "内容は暗号化されています。解錠すると開けます。"
                    : "名前と内容は暗号化されています。解錠すると表示されます。"}
                </p>
              {/if}
              {#if v.locked && unlocking === v.id}
                <UnlockForm
                  busy={places.busy}
                  account={recoveryAccount(e.meta.id)}
                  passphrase={hasSlot(e.meta, "passphrase")}
                  passkey={hasSlot(e.meta, "passkey") && places.vault?.passkey != null}
                  onunlock={(m) => unlockAndOpen(e.meta, m)}
                />
                {#if places.error}<p class="banner" role="alert" data-testid="places-error">{places.error}</p>{/if}
              {/if}
            {:else}
              <p class="muted small">{e.reason}</p>
              <div class="actions">
                <button type="button" class="danger" onclick={() => remove(v)} disabled={places.busy}>削除</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">作業場所はまだありません。新しく作るか、zip・暗号化した書き出しから取り込んでください。</p>
    {/if}

    {#if places.pendingSealed}
      <div class="sub" data-testid="import-sealed">
        <h3>暗号化した書き出しを開く</h3>
        <p class="small">
          「{places.pendingSealed.name}」を開くには、作成時の回復コードかパスフレーズを入力してください。
        </p>
        <UnlockForm
          busy={places.busy}
          passphrase={places.pendingSealed.passphrase}
          passkey={places.pendingSealed.passkey && places.vault?.passkey != null}
          onunlock={(m) => places.unsealImport(m)}
        />
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
          {#if p.sealed}<li>暗号化した書き出しと同じ鍵（回復コード・パスフレーズ）を引き継ぎます。</li>{/if}
        </ul>
        <label>作業場所の名前 <input bind:value={importName} maxlength="80" required data-testid="import-name" /></label
        >
        {#if !p.sealed && places.vault}
          <label class="check"
            ><input type="checkbox" bind:checked={importEncrypt} /> 暗号化する（推奨。回復コードを表示します）</label
          >
        {/if}
        <div class="actions">
          <button type="submit" class="primary" disabled={places.busy} data-testid="import-run">取り込む</button>
          <button type="button" onclick={() => places.cancelImport()}>取り消す</button>
        </div>
      </form>
    {:else}
      <form class="sub" onsubmit={create} data-testid="place-create">
        <h3>新しい作業場所</h3>
        <label>名前 <input bind:value={newName} maxlength="80" required data-testid="place-name" /></label>
        {#if places.vault}
          <label class="check"
            ><input type="checkbox" bind:checked={encrypt} data-testid="place-encrypt" /> 暗号化する（推奨。回復コードを表示します）</label
          >
        {/if}
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
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
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
    border-top: 1px solid var(--color-border);
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
    color: var(--color-ng);
    font-weight: var(--font-weight-strong);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    margin-top: var(--space-8);
  }
  .sub {
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-12);
    margin-top: var(--space-12);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-block: var(--space-8);
  }
  label.check {
    flex-direction: row;
    align-items: center;
  }
  input:not([type="checkbox"]) {
    font: inherit;
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--bg, transparent);
    color: inherit;
  }
  .banner {
    border: 1px solid var(--color-ng);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: 0 0 var(--space-12);
  }
  .banner.info {
    border-color: var(--color-border);
  }
  .small {
    font-size: var(--font-size-14);
  }
</style>
