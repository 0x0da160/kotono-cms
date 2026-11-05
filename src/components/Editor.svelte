<script lang="ts">
  import type { GitController } from "../lib/app/git.svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { onMount, tick } from "svelte";
  import { encodeUtf8 } from "../lib/core/bytes";
  import { publishTiming } from "../lib/core/datetime";
  import ConflictPanel from "./ConflictPanel.svelte";
  import FrontmatterForm from "./FrontmatterForm.svelte";
  import MediaPanel from "./MediaPanel.svelte";
  import Preview from "./Preview.svelte";

  let { ws, session, git = null }: { ws: Workspace; session: EditorSession; git?: GitController | null } = $props();

  const gitLabel = $derived.by(() => {
    if (!git || !git.info) return "未確認";
    if (git.info.kind === "none") return "Git 未使用";
    if (git.info.kind === "unsupported") return "対応外の構成";
    if (session.isNew) return "未作成";
    return git.label(session.id) ?? "コミット済み";
  });
  const idMismatch = $derived(session.analysis.problems.some((p) => p.code === "id-mismatch"));
  const createdAtProblem = $derived(session.analysis.problems.some((p) => p.field === "createdAt"));

  /**
   * 保存できなかったことを状態の欄でも示す（UI刷新 P-07：表示のみ。状態モデルは変えない）。
   * 外部変更での停止と、前回の保存候補が書き込めなかった場合だけを示す。
   */
  const saveIssue = $derived(
    session.conflict
      ? "外部変更で保存を停止"
      : session.status === "unsaved" && session.pendingCandidate !== null
        ? "前回の保存に失敗"
        : null,
  );

  let editorEl: HTMLElement | undefined = $state();
  let stickyEl: HTMLElement | undefined = $state();
  let noticeEl: HTMLElement | undefined = $state();
  let conflictEl: HTMLElement | undefined = $state();

  onMount(() => {
    // 記事を開いたら、編集領域を先頭から表示する（独立スクロール時：P-01）
    const scroller = editorEl?.parentElement;
    if (scroller) scroller.scrollTop = 0;
    // 固定した見出し・操作列の高さ。フォーカスやスクロール先が隠れないよう scroll-margin に使う（WCAG 2.4.11）
    if (!stickyEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => editorEl?.style.setProperty("--sticky-h", `${stickyEl?.offsetHeight ?? 0}px`));
    ro.observe(stickyEl);
    return () => ro.disconnect();
  });

  // エラー・警告の通知、外部変更パネルが出たら、見える位置へ移す（本文の途中を見ていても気づけるように）
  $effect(() => {
    const kind = session.notice?.kind;
    const conflict = session.conflict;
    if (kind !== "error" && kind !== "warn" && !conflict) return;
    void tick().then(() => (conflictEl ?? noticeEl)?.scrollIntoView({ block: "nearest" }));
  });

  let moreOpen = $state(false);
  let moreSummary: HTMLElement | undefined = $state();
  /** まとめた操作を実行する前に閉じ、フォーカスを「原文の退避・その他」へ戻す（確認ダイアログの復帰先になる） */
  function fromMore(run: () => unknown) {
    moreOpen = false;
    moreSummary?.focus();
    void run();
  }
  function onMoreKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && moreOpen) {
      e.preventDefault();
      e.stopPropagation();
      moreOpen = false;
      moreSummary?.focus();
    }
  }

  let mode = $state<"form" | "source" | "preview">("form");
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
  const locked = $derived(session.locked !== null);
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

  function switchMode(next: "form" | "source" | "preview") {
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
      if (!session.editable) return;
      if (k === "y" || e.shiftKey) session.redo();
      else session.undo();
    }
  }

  function onBeforeInput(e: InputEvent) {
    if (!session.editable) {
      // 削除手続き中など、対象記事の内容を変える全経路を止める（11.3）
      e.preventDefault();
      return;
    }
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

  const draftLabel = $derived.by(() => {
    const m = ws.drafts?.mode ?? "unavailable";
    if (m === "unavailable") return "復旧退避なし（この環境ではブラウザ内に退避できません）";
    if (m === "undecided") return "復旧退避なし（ブラウザ内復旧ドラフトは未設定）";
    if (m !== "enabled") return "復旧退避なし（ブラウザ内復旧ドラフトは無効）";
    if (readOnly) return "復旧退避：対象外（読み取り専用）";
    if (!session.dirty) return "復旧退避：未保存の編集なし";
    const d = session.draft;
    const t = (at: number) => new Date(at).toLocaleTimeString("ja-JP");
    if (d.kind === "saved")
      return d.revision === session.revision ? `復旧退避済み（${t(d.at)}）` : `復旧退避待ち（前回 ${t(d.at)}）`;
    if (d.kind === "failed") return `復旧退避に失敗：${d.message}${d.lastAt ? `（前回の退避 ${t(d.lastAt)}）` : ""}`;
    return "復旧退避待ち";
  });

  function savedAgo(t: number | null): string {
    if (t === null) return "このセッションでは未保存";
    const min = Math.floor((clock - t) / 60_000);
    return `${new Date(t).toLocaleTimeString("ja-JP")}（${min < 1 ? "1分以内" : `${min}分前`}）`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="editor"
  bind:this={editorEl}
  aria-labelledby="editor-heading"
  onkeydown={onKeydown}
  onbeforeinput={onBeforeInput}
  oncompositionstart={() => (composing = session.composing = true)}
  oncompositionend={() => (composing = session.composing = false)}
>
  <div class="ed-sticky" bind:this={stickyEl}>
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
          {#if saveIssue}<span class="badge err" data-testid="save-issue">{saveIssue}</span>{/if}
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
        <li><span class="axis">Git</span> <span class="badge" data-testid="git-status">{gitLabel}</span></li>
        <li><span class="axis">配信</span> <span class="badge muted">本CMSでは未確認</span></li>
      </ul>
    </header>

    <div class="toolbar" role="toolbar" aria-label="記事の操作">
      <button
        type="button"
        class="primary"
        onclick={() => ws.save()}
        disabled={readOnly || locked || session.saving}
        aria-keyshortcuts="Control+S Meta+S"
        data-testid="save-button"
      >
        {session.saving ? "保存中…" : session.isNew ? "保存（作成）" : "保存"}
      </button>
      <button
        type="button"
        class="group-start"
        onclick={() => session.undo()}
        disabled={!session.canUndo || readOnly || locked}
        aria-keyshortcuts="Control+Z">元に戻す</button
      >
      <button
        type="button"
        onclick={() => session.redo()}
        disabled={!session.canRedo || readOnly || locked}
        aria-keyshortcuts="Control+Shift+Z Control+Y">やり直す</button
      >
      <!-- 使う頻度の低い操作はまとめる（UI刷新 反復3：操作列の折り返しを減らす）。ホバーでは開かない -->
      <details class="more group-start" bind:open={moreOpen} onkeydown={onMoreKeydown}>
        <summary bind:this={moreSummary} data-testid="more-actions">原文の退避・その他</summary>
        <div class="more-menu" role="group" aria-label="原文の退避・その他">
          <button type="button" onclick={() => fromMore(() => copy(session.text))} disabled={session.text === ""}
            >原文をコピー</button
          >
          <button type="button" onclick={() => fromMore(() => download(session.text))} disabled={session.text === ""}
            >原文をダウンロード</button
          >
          {#if !session.isNew}
            <button type="button" onclick={() => fromMore(() => ws.reloadCurrent())} disabled={ws.busy || locked}
              >ディスクから再読み込み</button
            >
            <button
              type="button"
              onclick={() => fromMore(() => ws.duplicateCurrent())}
              disabled={ws.busy || readOnly || locked}
              data-testid="duplicate-button">複製…</button
            >
          {/if}
        </div>
      </details>
      {#if !session.isNew}
        {#if git?.repo}
          <button
            type="button"
            onclick={() => git.commitArticle(session.id)}
            disabled={ws.busy || git.busy || locked || session.dirty || !git.writable}
            title={session.dirty ? "保存してからコミットしてください" : ""}
            data-testid="commit-button">コミット…</button
          >
        {/if}
        <button
          type="button"
          class="danger group-start"
          onclick={() => ws.deleteCurrent()}
          disabled={ws.busy || locked}
          data-testid="delete-button">削除…</button
        >
      {/if}
      <button type="button" class="close" onclick={() => ws.closeArticle()} disabled={ws.busy}>閉じる</button>
    </div>
  </div>

  {#if ws.operation}
    <p class="op" role="status" data-testid="operation">処理中：{ws.operation}</p>
  {/if}
  {#if session.locked}
    <p class="readonly" role="status" data-testid="locked">{session.locked}</p>
  {/if}

  {#if session.notice}
    <div
      bind:this={noticeEl}
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
    <div bind:this={conflictEl}>
      <ConflictPanel
        conflict={session.conflict}
        id={session.id}
        oncopy={copy}
        ondownload={download}
        ontakedisk={() => ws.takeDisk()}
        onrecheck={() => ws.recheckDisk()}
      />
    </div>
  {/if}

  {#if !readOnly && a.problems.length > 0}
    <details class="problems" open>
      <summary>検証エラー（{a.problems.length}件）：解消するまで保存できません</summary>
      <ul>
        {#each a.problems as p, i (i)}
          <li>{p.line !== undefined ? `${p.line}行目：` : ""}{p.message}</li>
        {/each}
      </ul>
      {#if !session.isNew && (idMismatch || createdAtProblem)}
        <div class="repairs">
          {#if idMismatch}
            <button type="button" onclick={() => ws.repairId()} disabled={locked} data-testid="repair-id"
              >id をフォルダ名（{session.id}）に合わせる…</button
            >
          {/if}
          {#if createdAtProblem}
            {#if values.updatedAt}
              <button
                type="button"
                onclick={() => ws.repairCreatedAt("updatedAt")}
                disabled={locked}
                data-testid="repair-created-updated">createdAt を updatedAt と同じにする…</button
              >
            {/if}
            <button
              type="button"
              onclick={() => ws.repairCreatedAt("now")}
              disabled={locked}
              data-testid="repair-created-now">createdAt を現在時刻にする…</button
            >
          {/if}
        </div>
      {/if}
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
      <button
        type="button"
        role="tab"
        id="tab-preview"
        aria-selected={mode === "preview"}
        aria-controls="panel-edit"
        onclick={() => switchMode("preview")}
        data-testid="tab-preview">プレビュー</button
      >
    </div>
    {#if modeError}<p class="err" role="alert">{modeError}</p>{/if}

    <div id="panel-edit" role="tabpanel" aria-labelledby={`tab-${mode}`} class="panel">
      {#if mode === "preview"}
        <Preview {ws} {session} />
      {:else if mode === "form" && formAvailable}
        <div class="form-layout">
          <label class="src body">
            <span>本文（Markdown）</span>
            <textarea
              value={body}
              oninput={(e) => {
                session.setBody(e.currentTarget.value);
                session.bodyCaret = e.currentTarget.selectionStart;
              }}
              onselect={(e) => (session.bodyCaret = e.currentTarget.selectionStart)}
              onclick={(e) => (session.bodyCaret = e.currentTarget.selectionStart)}
              onkeyup={(e) => (session.bodyCaret = e.currentTarget.selectionStart)}
              readonly={locked}
              rows="18"
              spellcheck="false"
              data-testid="body-editor"></textarea>
          </label>
          <FrontmatterForm {session} />
        </div>
      {:else}
        <label class="src">
          <span>原文（frontmatter と本文）</span>
          <textarea
            value={session.text}
            oninput={(e) => session.setText(e.currentTarget.value, "source")}
            readonly={locked}
            rows="24"
            spellcheck="false"
            data-testid="source-editor"></textarea>
        </label>
      {/if}
    </div>
    {#if !session.isNew}
      <MediaPanel {ws} {session} />
    {:else}
      <p class="muted small">画像の取り込みは、記事を一度保存した後にできます。</p>
    {/if}
  {/if}

  <footer class="ed-foot">
    <span>最後のリポジトリ保存：{savedAgo(session.lastSavedAt)}</span>
    <span data-testid="draft-status">{draftLabel}</span>
  </footer>
</section>

<style>
  .ed-sticky {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .toolbar .group-start {
    margin-inline-start: 0.5rem;
  }
  .toolbar .close {
    margin-inline-start: auto;
  }
  .more {
    position: relative;
  }
  .more > summary {
    list-style: none;
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.375rem 0.75rem;
    background: var(--surface);
    white-space: nowrap;
  }
  .more > summary::-webkit-details-marker {
    display: none;
  }
  .more > summary::after {
    content: " ▾";
  }
  .more[open] > summary::after {
    content: " ▴";
  }
  .more-menu {
    position: absolute;
    inset-inline-start: 0;
    top: calc(100% + 0.25rem);
    z-index: 4;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
    min-width: 14rem;
    padding: 0.375rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
  }
  .more-menu button {
    text-align: start;
  }
  /* 本文を主、記事情報を右の補助列に置く（UI刷新 方向B：P-02）。幅が足りないときは従来どおり縦に積む */
  .panel {
    container-type: inline-size;
  }
  .form-layout {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  /*
   * DOM は本文→記事情報（Tab 順を見た目に合わせる）。広い画面では縦積みのときも本文を先に表示する（P-02）。
   * 狭い画面（60rem 以下、今回の対象外）は従来どおり記事情報を上に表示する。
   */
  @media (max-width: 60rem) {
    .form-layout > :global(.form) {
      order: -1;
    }
  }
  @container (min-width: 46rem) {
    .form-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 19rem;
      gap: 0 1rem;
      align-items: start;
    }
    .form-layout > .body {
      grid-column: 1;
      grid-row: 1;
    }
    .form-layout > :global(.form) {
      grid-column: 2;
      grid-row: 1;
      margin: 0;
      border: none;
      border-inline-start: 1px solid var(--border);
      border-radius: 0;
      padding: 0 0 0 0.75rem;
    }
    .form-layout :global(.form .grid) {
      grid-template-columns: minmax(0, 1fr);
    }
    .form-layout :global(.form .grid > *) {
      grid-column: 1 / -1;
    }
  }
  /*
   * 作業台レイアウト（広い画面）：見出し・状態・操作列を編集領域の上に固定する（P-03）。
   * 本文欄は内容に合わせて伸ばし、スクロールを編集領域の1つにまとめる（二重スクロールを避ける）。
   */
  @media (min-width: 60.0625rem) {
    .ed-sticky {
      position: sticky;
      top: 0;
      z-index: 3;
      background: var(--bg);
      padding-block: 0.25rem 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    .editor :global(*) {
      scroll-margin-top: calc(var(--sticky-h, 0px) + 0.5rem);
    }
    h2 {
      font-size: 1.125rem;
    }
    .axes {
      font-size: 0.75rem;
    }
    .toolbar {
      gap: 0.375rem;
    }
    .toolbar button,
    .more > summary {
      padding: 0.25rem 0.625rem;
      font-size: 0.875rem;
    }
    .toolbar button:not(.primary):not(.danger) {
      background: transparent;
    }
    textarea {
      field-sizing: content;
      min-height: max(20rem, calc(100dvh - 16rem));
      resize: none;
    }
  }
  .repairs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
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
  .op {
    margin: 0;
    font-size: 0.875rem;
    color: var(--muted);
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
