<script lang="ts">
  import type { EditorSession } from "../lib/app/session.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { encodeUtf8 } from "../lib/core/bytes";
  import { publishTiming } from "../lib/core/datetime";
  import ConflictPanel from "./ConflictPanel.svelte";
  import FrontmatterForm from "./FrontmatterForm.svelte";

  let { ws, session }: { ws: Workspace; session: EditorSession } = $props();

  let mode = $state<"form" | "source">("form");
  let modeError = $state<string | null>(null);
  let composing = $state(false);
  let clock = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (clock = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const a = $derived(session.analysis);
  const values = $derived(a.schema?.values ?? {});
  const body = $derived(a.split.ok ? a.split.body : "");
  const formAvailable = $derived(a.split.ok && a.parse?.ok === true);
  const readOnly = $derived(session.readOnlyReason !== null);
  const timing = $derived(publishTiming(values.publishedAt ?? null, clock));

  // 構文エラーのある文書はフォームで編集できない（14）
  $effect(() => {
    if (mode === "form" && !formAvailable && !readOnly) mode = "source";
  });

  const statusLabel = $derived(
    readOnly
      ? "読み取り専用"
      : { unsaved: "未保存", saving: "保存中", saved: "保存済み", unknown: "結果不明" }[session.status],
  );

  function switchMode(next: "form" | "source") {
    if (next === mode) return;
    if (next === "form" && !formAvailable) {
      const first = a.problems[0];
      modeError = `原文に構文エラーがあるため、フォームへ切り替えられません${first?.line !== undefined ? `（${first.line}行目）` : ""}：${first?.message ?? ""}`;
      return;
    }
    modeError = null;
    session.sealHistory();
    mode = next;
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z" || k === "y") {
      // フォームと原文で共通の文書履歴を使う（14）
      if (e.isComposing || composing) return;
      e.preventDefault();
      if (k === "y" || e.shiftKey) session.redo();
      else session.undo();
    }
  }

  function onBeforeInput(e: InputEvent) {
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      if (e.inputType === "historyUndo") session.undo();
      else session.redo();
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      session.notice = { kind: "ok", text: "原文をクリップボードにコピーしました。" };
    } catch {
      session.notice = { kind: "error", text: "コピーできませんでした。原文をダウンロードしてください。" };
    }
    ws.announce(session.notice.text);
  }

  function download(text: string, suffix = "editing") {
    // ユーザー操作によるダウンロード退避（12.2・13.1）。保存先への保存完了は検証できない。
    const blob = new Blob([encodeUtf8(text) as Uint8Array<ArrayBuffer>], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${session.id || "article"}-${suffix}.md`;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function savedAgo(t: number | null): string {
    if (t === null) return "このセッションでは未保存";
    const min = Math.floor((clock - t) / 60_000);
    return `${new Date(t).toLocaleTimeString("ja-JP")}（${min < 1 ? "1分以内" : `${min}分前`}）`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="editor"
  aria-labelledby="editor-heading"
  onkeydown={onKeydown}
  onbeforeinput={onBeforeInput}
  oncompositionstart={() => (composing = true)}
  oncompositionend={() => (composing = false)}
>
  <header class="ed-head">
    <div class="ed-title">
      <h2 id="editor-heading">
        {#if values.title && values.title.trim() !== ""}{values.title}{:else}<span class="untitled">無題</span>{/if}
      </h2>
      <p class="ids">
        <span class="mono">{session.id}</span>
        {#if session.isNew}<span class="badge">新規（未作成）</span>{/if}
      </p>
    </div>
    <ul class="axes" aria-label="状態">
      <li>
        <span class="axis">保存</span>
        <span class="badge {session.status}" data-testid="save-status">{statusLabel}</span>
      </li>
      <li>
        <span class="axis">原稿</span>
        <span class="badge"
          >{values.status === "published" ? "公開対象" : values.status === "draft" ? "下書き" : "不明"}</span
        >
      </li>
      <li>
        <span class="axis">公開日時</span>
        <span class="badge"
          >{timing === "unset"
            ? "未設定"
            : timing === "future"
              ? "公開予定日時を設定済み"
              : timing === "past"
                ? "過去または現在"
                : "不正"}</span
        >
      </li>
      <li><span class="axis">配信</span> <span class="badge muted">本CMSでは未確認</span></li>
    </ul>
  </header>

  <div class="toolbar" role="toolbar" aria-label="記事の操作">
    <button
      type="button"
      class="primary"
      onclick={() => ws.save()}
      disabled={readOnly || session.saving}
      aria-keyshortcuts="Control+S Meta+S"
      data-testid="save-button"
    >
      {session.saving ? "保存中…" : session.isNew ? "保存（作成）" : "保存"}
    </button>
    <button
      type="button"
      onclick={() => session.undo()}
      disabled={!session.canUndo || readOnly}
      aria-keyshortcuts="Control+Z">元に戻す</button
    >
    <button
      type="button"
      onclick={() => session.redo()}
      disabled={!session.canRedo || readOnly}
      aria-keyshortcuts="Control+Shift+Z Control+Y">やり直す</button
    >
    <button type="button" onclick={() => copy(session.text)} disabled={session.text === ""}>原文をコピー</button>
    <button type="button" onclick={() => download(session.text)} disabled={session.text === ""}
      >原文をダウンロード</button
    >
    {#if !session.isNew}
      <button type="button" onclick={() => ws.reloadCurrent()} disabled={ws.busy}>ディスクから再読み込み</button>
    {/if}
    <button type="button" onclick={() => ws.closeArticle()} disabled={ws.busy}>閉じる</button>
  </div>

  {#if session.notice}
    <div
      class="notice {session.notice.kind}"
      role={session.notice.kind === "error" ? "alert" : "status"}
      data-testid="notice"
    >
      <p>{session.notice.text}</p>
      {#if session.notice.details?.length}
        <ul>
          {#each session.notice.details as d, i (i)}<li>{d}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if session.historyTruncated}
    <p class="muted small">履歴の上限に達したため、古い編集履歴を切り捨てました（現在の文書は保持しています）。</p>
  {/if}

  {#if session.conflict}
    <ConflictPanel
      conflict={session.conflict}
      id={session.id}
      oncopy={copy}
      ondownload={download}
      ontakedisk={() => ws.takeDisk()}
      onrecheck={() => ws.recheckDisk()}
    />
  {/if}

  {#if !readOnly && a.problems.length > 0}
    <details class="problems" open>
      <summary>検証エラー（{a.problems.length}件）：解消するまで保存できません</summary>
      <ul>
        {#each a.problems as p, i (i)}
          <li>{p.line !== undefined ? `${p.line}行目：` : ""}{p.message}</li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if readOnly}
    <p class="readonly" role="note">読み取り専用：{session.readOnlyReason}</p>
    {#if session.text !== ""}
      <label class="src">
        <span>原文（閲覧のみ）</span>
        <textarea readonly value={session.text} rows="20" spellcheck="false"></textarea>
      </label>
    {/if}
  {:else}
    <div class="tabs" role="tablist" aria-label="編集モード">
      <button
        type="button"
        role="tab"
        id="tab-form"
        aria-selected={mode === "form"}
        aria-controls="panel-edit"
        onclick={() => switchMode("form")}>フォーム</button
      >
      <button
        type="button"
        role="tab"
        id="tab-source"
        aria-selected={mode === "source"}
        aria-controls="panel-edit"
        onclick={() => switchMode("source")}>原文</button
      >
    </div>
    {#if modeError}<p class="err" role="alert">{modeError}</p>{/if}

    <div id="panel-edit" role="tabpanel" aria-labelledby={mode === "form" ? "tab-form" : "tab-source"} class="panel">
      {#if mode === "form" && formAvailable}
        <FrontmatterForm {session} />
        <label class="src">
          <span>本文（Markdown）</span>
          <textarea
            value={body}
            oninput={(e) => session.setBody(e.currentTarget.value)}
            rows="18"
            spellcheck="false"
            data-testid="body-editor"></textarea>
        </label>
      {:else}
        <label class="src">
          <span>原文（frontmatter と本文）</span>
          <textarea
            value={session.text}
            oninput={(e) => session.setText(e.currentTarget.value, "source")}
            rows="24"
            spellcheck="false"
            data-testid="source-editor"></textarea>
        </label>
      {/if}
    </div>
  {/if}

  <footer class="ed-foot">
    <span>最後のリポジトリ保存：{savedAgo(session.lastSavedAt)}</span>
    <span>復旧退避なし（ブラウザ内復旧ドラフトは本版では未実装）</span>
    <span>プレビュー：本版では未実装</span>
  </footer>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .ed-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1.25rem;
    overflow-wrap: anywhere;
  }
  .untitled {
    color: var(--muted);
  }
  .ids {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
    display: flex;
    gap: 0.5rem;
  }
  .axes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    font-size: 0.8125rem;
  }
  .axis {
    color: var(--muted);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .notice {
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .notice p {
    margin: 0;
  }
  .notice ul {
    margin: 0.25rem 0 0;
    padding-inline-start: 1.25rem;
    font-size: 0.875rem;
  }
  .notice.error {
    border-color: var(--ng);
  }
  .notice.error p::before {
    content: "⚠ ";
  }
  .notice.ok {
    border-color: var(--ok);
  }
  .notice.ok p::before {
    content: "✓ ";
  }
  .problems {
    border: 1px solid var(--ng);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
  }
  .problems ul {
    margin: 0.25rem 0 0;
    padding-inline-start: 1.25rem;
    font-size: 0.875rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    background: var(--bg);
    padding: 0.375rem 1rem;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .tabs button[aria-selected="true"] {
    background: var(--surface);
    font-weight: 600;
    box-shadow: inset 0 -3px 0 var(--focus);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .src {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-weight: 600;
    font-size: 0.875rem;
  }
  textarea {
    width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "BIZ UDGothic", monospace;
    font-size: 0.9375rem;
    line-height: 1.6;
    font-weight: 400;
    resize: vertical;
    tab-size: 4;
  }
  .readonly {
    border: 1px solid var(--ng);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0;
  }
  .err {
    margin: 0;
    color: var(--ng);
  }
  .ed-foot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .small {
    font-size: 0.8125rem;
    margin: 0;
  }
</style>
