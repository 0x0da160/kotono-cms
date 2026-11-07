<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import { tick } from "svelte";
  import type { DraftController } from "../lib/app/drafts.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";

  let { ws, dc }: { ws: Workspace; dc: DraftController } = $props();

  // 初回の設定を閉じたら、設定の移り先（フッターの「復旧ドラフト」）へフォーカスを移す。ページの先頭に飛ばさない
  async function focusSettings() {
    await tick();
    document.querySelector<HTMLElement>('[data-testid="draft-settings-summary"]')?.focus();
  }

  async function enable() {
    await dc.enable();
    await ws.attachDrafts();
    // 同意の前から開いていた未保存の編集も、同意の後は退避の対象にする
    if (ws.session) dc.onEdit(ws.session);
    ws.announce("ブラウザ内復旧ドラフトを有効にしました。");
  }

  async function enableFirst() {
    await enable();
    await focusSettings();
  }

  async function decline() {
    await dc.disable(false);
    ws.announce("ブラウザ内復旧ドラフトを無効にしました。");
    await focusSettings();
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
  <p class="small">
    暗号化はしません。このブラウザのプロファイルにアクセスできる人は読める可能性があります。共有の端末では有効にしないでください。<HelpTip
      label="復旧ドラフトの保存内容と期間"
      ><span class="tip-p">保存先はこのブラウザの内部（IndexedDB）です。リポジトリのフォルダには書き込みません。</span
      ><span class="tip-p"
        >保存する内容：編集中の原文、記事ID、編集の番号、元ファイルのハッシュ、退避時刻。画像やリポジトリ全体は保存しません。</span
      ><span class="tip-p"
        >次回同じフォルダを開いたときに見分けるため、選んだフォルダの参照（ハンドル）も保存します。これは次回の書き込み許可ではありません。</span
      ><span class="tip-p"
        >保持期間は最終退避から7日間が目安です。期限後、次に起動したときに整理します。フッターの「復旧ドラフト」からいつでも削除できます。</span
      ><span class="tip-p">file:// で開いたローカルの HTML どうしでは、保存領域が共有されることがあります。</span><span
        class="tip-p">外部への送信・同期はしません。復旧できるのは、実際に退避に成功した内容までです。</span
      ></HelpTip
    >
  </p>
{/snippet}

{#if dc.mode === "undecided"}
  <section class="card consent" aria-labelledby="consent-heading" data-testid="draft-consent">
    <h2 id="consent-heading">ブラウザ内復旧ドラフトを有効にしますか</h2>
    <p>未保存の編集を、ブラウザの中に自動で退避します。タブを閉じたりブラウザが落ちたりしても、次回復旧できます。</p>
    {@render explanation()}
    <div class="buttons">
      <button type="button" class="primary" onclick={enableFirst} data-testid="draft-enable">有効にする（推奨）</button>
      <button type="button" onclick={decline}>今は有効にしない</button>
    </div>
  </section>
{:else}
  <details class="settings">
    <summary data-testid="draft-settings-summary">
      復旧ドラフト：{dc.mode === "enabled"
        ? "有効"
        : dc.mode === "disabled"
          ? "無効（復旧退避なし）"
          : "利用できません"}
    </summary>
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
  </details>
{/if}

<style>
  .consent {
    border: 1px solid var(--focus);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    background: var(--surface);
  }
  h2 {
    margin: 0 0 0.25rem;
    font-size: 1.0625rem;
  }
  .small {
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  /* フッターで文字を詰めても、操作できる高さは 24px 以上にする（段階4 4章、WCAG 2.5.8） */
  .settings summary {
    cursor: pointer;
    min-height: 1.5rem;
    padding-block: 0.15rem;
  }
</style>
