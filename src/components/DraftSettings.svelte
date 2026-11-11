<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import type { DraftController } from "../lib/app/drafts.svelte";
  import type { LoginController } from "../lib/app/login.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";

  let {
    ws,
    dc,
    login = null,
    variant = "footer",
  }: {
    ws: Workspace;
    dc: DraftController;
    /** 起動時のロック解除（暗号化の鍵の出どころを示す）。ロック解除を使えない環境では null */
    login?: LoginController | null;
    /** footer：最初の画面のフッターに畳んで出す。page：「設定」の画面に開いて出す（docs/knowledge/product/app-shell.md） */
    variant?: "footer" | "page";
  } = $props();

  const modeLabel = $derived(dc.mode === "enabled" ? "有効" : dc.mode === "disabled" ? "無効" : "利用できません");

  async function enable() {
    await dc.enable();
    await ws.attachDrafts();
    // 有効にする前から開いていた未保存の編集も、退避の対象にする
    if (ws.session) dc.onEdit(ws.session);
    ws.announce("復旧ドラフトを有効にしました。");
  }

  async function turnOff() {
    const v = await ws.ask({
      title: "復旧ドラフトを無効にします",
      message: "以後、未保存の編集をブラウザ内へ退避しません。既に退避したドラフトをどうしますか。",
      buttons: [
        { label: "無効にして既存を保持", value: "keep", variant: "primary" },
        { label: "無効にして既存を削除", value: "delete", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v === "cancel") return;
    await dc.disable(v === "delete");
    ws.announce(
      v === "delete" ? "復旧ドラフトを無効にし、既存のドラフトを削除しました。" : "復旧ドラフトを無効にしました。",
    );
  }

  async function removeAll() {
    const v = await ws.ask({
      title: "すべての復旧ドラフトを削除します",
      message: `このブラウザに保存されている復旧ドラフト（${dc.records.length}件）をすべて削除します。`,
      details: ["削除したドラフトは戻せません。"],
      buttons: [
        { label: "すべて削除", value: "delete", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v !== "delete") return;
    const enabled = dc.mode === "enabled";
    await dc.disable(true);
    if (enabled) {
      await dc.enable();
      await ws.attachDrafts();
    }
  }
</script>

{#snippet explanation()}
  <p class="small" data-testid="draft-encryption">
    {login?.record
      ? "起動時のロック解除（パスキー）で開く鍵で暗号化して置きます。"
      : "暗号化して置きます。"}ロック中は読み書きしません。<HelpTip label="復旧ドラフトの保存内容と期間"
      ><span class="tip-p">保存先はこのブラウザの内部（IndexedDB）です。リポジトリのフォルダには書き込みません。</span
      ><span class="tip-p"
        >保存する内容：編集中の原文、記事ID、元ファイルのハッシュ（ここまでを暗号化）、編集の番号、退避時刻、大きさ。画像やリポジトリ全体は保存しません。</span
      ><span class="tip-p"
        >ロックを解除できなくなると（パスキーも回復コードも使えない）、暗号化した復旧ドラフトは誰も読めません。</span
      ><span class="tip-p"
        >次回同じフォルダを開いたときに見分けるため、選んだフォルダの参照（ハンドル）も保存します。この参照を保存しても、次回の書き込みが許可されるわけではありません。</span
      ><span class="tip-p"
        >保持期間は、最後に退避してから7日間が目安です。期限を過ぎたものは、次に起動したときに整理します。「設定」の「復旧ドラフト」からいつでも削除できます。</span
      ><span class="tip-p">外部への送信・同期はしません。復旧できるのは、実際に退避に成功した内容までです。</span
      ></HelpTip
    >
  </p>
{/snippet}

{#snippet body()}
  {#if dc.reason}<p class="small">{dc.reason}</p>{/if}
  {#if dc.mode === "unavailable"}
    <p class="small">
      この環境ではブラウザ内に退避できません。未保存の編集は「原文をコピー」「原文をダウンロード」で手動で退避してください。
    </p>
  {:else}
    {@render explanation()}
    <p class="small">保存中のドラフト：{dc.records.length}件</p>
    <div class="buttons">
      {#if dc.mode === "enabled"}
        <button type="button" onclick={turnOff} disabled={dc.busy}>無効にする…</button>
      {:else}
        <button type="button" onclick={enable} disabled={dc.busy}>有効にする</button>
      {/if}
      <button type="button" class="danger" onclick={removeAll} disabled={dc.busy || dc.records.length === 0}
        >すべて削除…</button
      >
    </div>
  {/if}
{/snippet}
{#if variant === "page"}
  <section class="card page" aria-labelledby="draft-settings-heading" data-testid="draft-settings">
    <h2 id="draft-settings-heading">復旧ドラフト</h2>
    <p class="state">状態：{modeLabel}</p>
    {@render body()}
  </section>
{:else}
  <details class="settings">
    <summary data-testid="draft-settings-summary">復旧ドラフト：{modeLabel}</summary>
    {@render body()}
  </details>
{/if}

<style>
  .page {
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin-bottom: var(--space-12);
  }
  .state {
    margin: 0 0 var(--space-4);
  }
  h2 {
    margin: 0 0 var(--space-4);
    font-size: var(--font-size-18);
  }
  .small {
    font-size: var(--font-size-13);
    color: var(--color-fg-muted);
  }
  .buttons {
    display: flex;
    gap: var(--control-gap);
    flex-wrap: wrap;
  }
  /* フッターで文字を詰めても、操作できる高さは 24px 以上にする（段階4 4章、WCAG 2.5.8） */
  .settings summary {
    cursor: pointer;
    min-height: var(--target-min);
  }
</style>
