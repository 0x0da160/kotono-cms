<script lang="ts">
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
  }: { places: PlacesController; ws: Workspace; git: GitController; meta: WorkspaceMeta; sync?: Snippet } = $props();

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
        ? "既定では暗号化して書き出します（.kotono）。回復コード・パスフレーズで、別の端末やデスクトップ版で開けます。平文の zip は誰でも中身を読めます。"
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

<div class="placebar" data-testid="placebar">
  <div class="status">
    {#if days !== null}
      <span class="unsynced" class:warn={places.shouldRemind(meta)} data-testid="unsynced"
        >端末の外にない変更あり（{days} 日）</span
      >
    {:else}
      <span class="muted small" data-testid="unsynced-none">端末の外にない変更はありません</span>
    {/if}
    {#if places.sharedOrigin}<span class="badge err" title="他のページと保存領域を共有する配信元です">開発版</span>{/if}
    {#if places.persist !== "persisted"}<span class="badge unknown" title="ブラウザが保存領域を消去することがあります"
        >消去されることがあります</span
      >{/if}
  </div>
  <div class="actions">
    <button type="button" onclick={() => places.leave()} data-testid="place-leave">作業場所の一覧</button>
    <button type="button" onclick={exportNow} disabled={places.busy || ws.busy} data-testid="place-export-open"
      >書き出す</button
    >
    {#if encrypted}
      <button type="button" onclick={() => places.lock(meta.id)} data-testid="place-lock-open">ロック</button>
    {/if}
  </div>
  {#if places.error}<p class="banner" role="alert">{places.error}</p>{/if}
  {#if places.info}<p class="banner info" role="status">{places.info}</p>{/if}
  {#if places.shouldRemind(meta)}
    <p class="banner" role="status" data-testid="backup-remind">
      最後の書き出し・同期から {days} 日たちました。ブラウザのデータ消去に備えて、書き出すか同期してください。
    </p>
  {/if}
  {@render sync?.()}
  {#if encrypted}
    <details class="settings">
      <summary data-testid="place-settings">解錠の方法と自動ロック</summary>
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
        <button
          type="button"
          onclick={() => places.addUnlock(meta, { kind: "passkey" })}
          disabled={places.busy}
          data-testid="add-passkey">パスキーを登録</button
        >
        <p class="small muted">
          パスキーは、この配信元（{location.hostname}）でだけ使えます。配信元を移したら登録し直してください。
        </p>
      {/if}
      <label class="row"
        >自動ロック
        <select bind:value={places.lockMinutes} data-testid="lock-minutes">
          {#each LOCK_MINUTE_CHOICES as m (m)}
            <option value={m}>{m === 0 ? "しない" : `${m} 分操作がなければ`}</option>
          {/each}
        </select>
      </label>
    </details>
  {/if}
</div>

<style>
  .placebar {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
    background: var(--surface);
  }
  .status,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .actions {
    margin-top: 0.5rem;
  }
  .unsynced {
    font-size: 0.875rem;
  }
  .warn {
    color: var(--ng);
    font-weight: 600;
  }
  .banner {
    border: 1px solid var(--ng);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
  .banner.info {
    border-color: var(--border);
  }
  .settings {
    margin-top: 0.5rem;
  }
  .pp {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: end;
    margin-block: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  label.row {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  input,
  select {
    font: inherit;
    font-size: 1rem;
    padding: 0.375rem 0.5rem;
    min-height: 2.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }
  .small {
    font-size: 0.8125rem;
  }
</style>
