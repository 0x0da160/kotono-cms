<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import Download from "@lucide/svelte/icons/download";
  import { LOCK_MINUTE_CHOICES, type PlacesController } from "../lib/app/places.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import type { GitController } from "../lib/app/git.svelte";
  import { PASSPHRASE_MIN } from "../lib/crypto/vault";
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

  let pass1 = $state("");
  let pass2 = $state("");
  const days = $derived(places.remindDays(meta));
  const encrypted = $derived(meta.keyring !== null);
  const hasPassphrase = $derived(meta.keyring?.slots.some((s) => s.kind === "passphrase") ?? false);
  const passkeys = $derived(meta.keyring?.slots.filter((s) => s.kind === "passkey").length ?? 0);

  /** 書き出し前に、未保存・未コミットを示す（38.3） */
  async function exportNow() {
    const details: string[] = [];
    if (ws.session?.dirty) details.push("編集中の記事に未保存の変更があります。書き出しには含まれません。");
    const changed = Object.values(git.statuses ?? {}).filter((s) => s.state !== "clean").length;
    if (changed > 0) details.push(`未コミットの記事が ${changed} 件あります（ファイルとしては書き出しに含まれます）。`);
    const v = await ws.ask({
      title: "作業場所を書き出します",
      message: encrypted
        ? "既定では暗号化して書き出します（.kotono）。別の端末やデスクトップ版でも、回復コードかパスフレーズで開けます。平文の zip は誰でも中身を読めます。"
        : "作業場所を .git を含めて zip にします。共有シートまたはダウンロードで保存先を選んでください。",
      details,
      buttons: encrypted
        ? [
            { label: "暗号化して書き出す", value: "sealed", variant: "primary" },
            { label: "平文の zip にする", value: "plain" },
            { label: "キャンセル", value: "cancel" },
          ]
        : [
            { label: "書き出す", value: "plain", variant: "primary" },
            { label: "キャンセル", value: "cancel" },
          ],
      initial: encrypted ? "sealed" : "plain",
    });
    if (v === "cancel") return;
    await places.export(meta, v === "plain");
  }

  async function removePasskeys() {
    const v = await ws.ask({
      title: "登録済みのパスキーを外します",
      message: `この作業場所に登録したパスキー ${passkeys} 件を、解錠の方法から外します。回復コード${hasPassphrase ? "・パスフレーズ" : ""}では今まで通り開けます。外したあと、使うパスキーを登録し直してください。`,
      details: [
        "パスキー自体はパスワードアプリや 1Password に残ります。不要なら、そちらで削除してください。",
        "複数のパスキーを同時に登録し直すと、1Password などでも開けるようになります。",
      ],
      buttons: [
        { label: "外す", value: "remove", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v === "remove") await places.removePasskeys(meta);
  }

  async function setPassphrase(e: SubmitEvent) {
    e.preventDefault();
    if (pass1 !== pass2) {
      places.error = "確認のパスフレーズが一致しません。";
      return;
    }
    if (await places.addUnlock(meta, { kind: "passphrase", passphrase: pass1 })) {
      pass1 = "";
      pass2 = "";
    }
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
      {#if places.sharedOrigin}<span class="badge err" title="他のページと保存領域を共有する配信元です">開発版</span
        >{/if}
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
{:else if encrypted}
  <section class="card settings" aria-labelledby="place-settings-heading" data-testid="place-settings">
    <h2 id="place-settings-heading">解錠の方法と自動ロック</h2>
    <p class="small muted">
      回復コードは常に使えます。{hasPassphrase ? "パスフレーズを設定済みです。" : ""}{passkeys > 0
        ? `パスキー ${passkeys} 件を登録済みです。`
        : ""}
    </p>
    <form onsubmit={setPassphrase} class="pp">
      <label
        >{hasPassphrase ? "パスフレーズを変える" : "パスフレーズを設定"}（{PASSPHRASE_MIN} 文字以上）
        <input
          type="password"
          bind:value={pass1}
          autocomplete="new-password"
          minlength={PASSPHRASE_MIN}
          required
        /></label
      >
      <label
        >確認 <input
          type="password"
          bind:value={pass2}
          autocomplete="new-password"
          minlength={PASSPHRASE_MIN}
          required
        /></label
      >
      <button type="submit" disabled={places.busy}>設定する</button>
    </form>
    {#if places.vault?.passkey}
      <div class="passkeys">
        <button
          type="button"
          onclick={() => places.addUnlock(meta, { kind: "passkey" })}
          disabled={places.busy}
          data-testid="add-passkey">パスキーを登録</button
        >
        {#if passkeys > 0}
          <button type="button" onclick={removePasskeys} disabled={places.busy} data-testid="remove-passkeys"
            >登録済みのパスキーを外す</button
          >
        {/if}
        <HelpTip label="パスキー"
          >パスキーはこの配信元（{location.hostname}）でだけ使えます。配信元を移したら登録し直してください。</HelpTip
        >
      </div>
    {/if}
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
  .passkeys {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    align-items: center;
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
  .pp {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    align-items: end;
    margin-block: var(--space-8);
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
  input,
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
