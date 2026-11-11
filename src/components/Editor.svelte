<script lang="ts">
  import type { GitController } from "../lib/app/git.svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import { EXTERNAL_CHANGE_NOTICE, type Workspace } from "../lib/app/workspace.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { encodeUtf8 } from "../lib/core/bytes";
  import { publishTiming } from "../lib/core/datetime";
  import ConflictPanel from "./ConflictPanel.svelte";
  import FrontmatterForm from "./FrontmatterForm.svelte";
  import MediaPanel from "./MediaPanel.svelte";
  import Preview from "./Preview.svelte";
  import VisualEditor from "./VisualEditor.svelte";
  import Check from "@lucide/svelte/icons/check";
  import CircleDot from "@lucide/svelte/icons/circle-dot";
  import ClipboardList from "@lucide/svelte/icons/clipboard-list";
  import Code from "@lucide/svelte/icons/code";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import Copy from "@lucide/svelte/icons/copy";
  import CopyPlus from "@lucide/svelte/icons/copy-plus";
  import Download from "@lucide/svelte/icons/download";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Eye from "@lucide/svelte/icons/eye";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Lock from "@lucide/svelte/icons/lock";
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";
  import Trash from "@lucide/svelte/icons/trash";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import X from "@lucide/svelte/icons/x";
  import HelpTip from "./HelpTip.svelte";
  import { narrowScreen } from "../lib/ui/media.svelte";

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

  /**
   * 外部変更を検出した通知は、外部変更パネルが出ている間はパネルの見出しで伝え、別の枠に出さない
   * （UI刷新 P-08：同じことを二重に言わない）。読み上げはパネルの見出しの role="alert" が引き継ぐ。
   * 他のエラー（コピーの失敗など）は従来どおり編集領域の通知に出す。
   */
  const conflictAlert = $derived(
    session.conflict !== null && session.notice?.kind === "error" && session.notice.text === EXTERNAL_CHANGE_NOTICE,
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

  // エラーの通知と外部変更パネルが出たら、見える位置へ移す（本文の途中を見ていても気づけるように）
  $effect(() => {
    const kind = session.notice?.kind;
    const conflict = session.conflict;
    if (kind !== "error" && !conflict) return;
    void tick().then(() => {
      // 状態の欄に「外部変更で保存を停止」が加わると固定領域が高くなる（1280px で 2 行になる）。
      // ResizeObserver より先に scroll-margin の値を取り直し、パネルの見出しが固定領域に隠れないようにする（P-08）
      if (stickyEl) editorEl?.style.setProperty("--sticky-h", `${stickyEl.offsetHeight}px`);
      (conflictEl ?? noticeEl)?.scrollIntoView({ block: "nearest" });
    });
  });

  /*
   * 成功・案内・警告は右上のトーストに出す（UI刷新 反復4、0x0da160 の決定）。本文の位置をずらさない。
   * 次の操作を選ぶ必要があるエラーは、従来どおり編集領域の中に残す。
   * 一定時間で隠すが、ポインターやフォーカスがある間は隠さない。通知の内容（session.notice）は変えない。
   */
  const TOAST_MS = { ok: 5000, info: 5000, warn: 10000 } as const;
  const toast = $derived(session.notice && session.notice.kind !== "error" ? session.notice : null);
  let toastHidden = $state(false);
  let toastHold = $state(false);
  /** 閉じたらフォーカスを本文へ戻す（閉じるボタンが消えてフォーカスを失わないように） */
  function closeToast() {
    toastHidden = true;
    toastHold = false;
    editorEl?.querySelector<HTMLElement>("[data-body-focus]")?.focus();
  }
  // 新しい通知が来たら表示し直す
  $effect.pre(() => {
    void toast;
    toastHidden = false;
    toastHold = false;
  });
  $effect(() => {
    const t = toast;
    if (!t || toastHold) return;
    const timer = setTimeout(() => (toastHidden = true), TOAST_MS[t.kind as keyof typeof TOAST_MS] ?? 5000);
    return () => clearTimeout(timer);
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
  /**
   * 狭い画面（iPhone）では「フォーム」を「本文」と「記事情報」のタブに分け、1度に1つだけ出す（ADR-0015）。
   * 新しい記事はタイトルと slug から入れるので「記事情報」、既存の記事は「本文」から始める。
   */
  let formPart = $state<"body" | "meta">(untrack(() => (session.isNew ? "meta" : "body")));
  const narrow = $derived(narrowScreen.matches);
  /** いま選んでいるタブの id（タブパネルの名前に使う） */
  const currentTab = $derived(mode === "form" && narrow ? `tab-${formPart}` : `tab-${mode}`);
  function switchPart(part: "body" | "meta") {
    switchMode("form");
    if (mode === "form") formPart = part;
  }
  /** 本文の編集方法（ADR-0005）：見たまま（既定）か Markdown。ブラウザ内に記憶する */
  const BODY_VIEW_KEY = "kotono-cms:body-view";
  let bodyView = $state<"visual" | "markdown">(readBodyView());
  function readBodyView(): "visual" | "markdown" {
    try {
      return globalThis.localStorage?.getItem(BODY_VIEW_KEY) === "markdown" ? "markdown" : "visual";
    } catch {
      return "visual";
    }
  }
  function setBodyView(v: "visual" | "markdown") {
    if (v === bodyView) return;
    session.sealHistory();
    session.bodyCaret = null;
    session.bodyCaretBlock = false;
    bodyView = v;
    try {
      globalThis.localStorage?.setItem(BODY_VIEW_KEY, v);
    } catch {
      // 記憶できなくても切り替えは使える
    }
  }
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
    if (m === "unavailable") return "復旧ドラフト：使えません（この環境ではブラウザ内に退避できません）";
    if (m !== "enabled") return "復旧ドラフト：無効";
    if (readOnly) return "復旧ドラフト：対象外（読み取り専用）";
    if (!session.dirty) return "復旧ドラフト：未保存の編集なし";
    const d = session.draft;
    const t = (at: number) => new Date(at).toLocaleTimeString("ja-JP");
    if (d.kind === "saved")
      return d.revision === session.revision
        ? `復旧ドラフト：退避済み（${t(d.at)}）`
        : `復旧ドラフト：退避待ち（前回 ${t(d.at)}）`;
    if (d.kind === "failed")
      return `復旧ドラフト：退避に失敗（${d.message}）${d.lastAt ? `（前回の退避 ${t(d.lastAt)}）` : ""}`;
    return "復旧ドラフト：退避待ち";
  });

  function savedAgo(t: number | null): string {
    if (t === null) return "開いてからは未保存";
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
  <div class="ed-sticky" bind:this={stickyEl} data-sticky-chrome>
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
          <span class="badge {session.status}" data-testid="save-status"
            >{#if readOnly}<Lock />{:else if session.status === "saved"}<Check
              />{:else if session.status === "saving"}<LoaderCircle
              />{:else if session.status === "unknown"}<TriangleAlert />{:else}<CircleDot />{/if}{statusLabel}</span
          >
          {#if saveIssue}<span class="badge err" data-testid="save-issue"><TriangleAlert />{saveIssue}</span>{/if}
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
        <li><span class="axis">配信</span> <span class="badge muted">CMS では未確認</span></li>
      </ul>
    </header>

    <!-- 狭い画面では、画面の下に固定する操作バーになる（app.css の [data-bottom-bar]） -->
    <div class="toolbar" role="toolbar" aria-label="記事の操作" data-bottom-bar>
      <button
        type="button"
        class="primary"
        onclick={() => ws.save()}
        disabled={readOnly || locked || session.saving}
        aria-keyshortcuts="Control+S Meta+S"
        data-testid="save-button"
      >
        <Save />{session.saving ? "保存中…" : session.isNew ? "保存（作成）" : "保存"}
      </button>
      <button
        type="button"
        class="group-start"
        onclick={() => session.undo()}
        disabled={!session.canUndo || readOnly || locked}
        aria-keyshortcuts="Control+Z"><Undo2 /><span class="t">元に戻す</span></button
      >
      <button
        type="button"
        onclick={() => session.redo()}
        disabled={!session.canRedo || readOnly || locked}
        aria-keyshortcuts="Control+Shift+Z Control+Y"><Redo2 /><span class="t">やり直す</span></button
      >
      <!-- 使う頻度の低い操作はまとめる（UI刷新 反復3：操作列の折り返しを減らす）。ホバーでは開かない -->
      <details class="more group-start" bind:open={moreOpen} onkeydown={onMoreKeydown}>
        <summary bind:this={moreSummary} data-testid="more-actions"
          ><span class="more-icon"><Ellipsis /></span><span class="t">原文の退避・その他</span></summary
        >
        <div class="more-menu" role="group" aria-label="原文の退避・その他">
          {#if narrow && !session.isNew && git?.repo}
            <button
              type="button"
              onclick={() => fromMore(() => git.commitArticle(session.id))}
              disabled={ws.busy || git.busy || locked || session.dirty || !git.writable}
              data-testid="commit-button"><GitCommitHorizontal />コミット…</button
            >
            {#if session.dirty}<p class="more-note">コミットは、保存してからできます。</p>{/if}
          {/if}
          <button type="button" onclick={() => fromMore(() => copy(session.text))} disabled={session.text === ""}
            ><Copy />原文をコピー</button
          >
          <button type="button" onclick={() => fromMore(() => download(session.text))} disabled={session.text === ""}
            ><Download />原文をダウンロード</button
          >
          {#if !session.isNew}
            <button type="button" onclick={() => fromMore(() => ws.reloadCurrent())} disabled={ws.busy || locked}
              ><RefreshCw />ディスクから再読み込み</button
            >
            <button
              type="button"
              onclick={() => fromMore(() => ws.duplicateCurrent())}
              disabled={ws.busy || readOnly || locked}
              data-testid="duplicate-button"><CopyPlus />複製…</button
            >
          {/if}
          {#if narrow}
            {#if !session.isNew}
              <button
                type="button"
                class="danger"
                onclick={() => fromMore(() => ws.deleteCurrent())}
                disabled={ws.busy || locked}
                data-testid="delete-button"><Trash />削除…</button
              >
            {/if}
            <button type="button" class="close" onclick={() => fromMore(() => ws.closeArticle())} disabled={ws.busy}
              ><X />記事を閉じる</button
            >
          {/if}
        </div>
      </details>
      {#if !narrow && !session.isNew}
        {#if git?.repo}
          <button
            type="button"
            onclick={() => git.commitArticle(session.id)}
            disabled={ws.busy || git.busy || locked || session.dirty || !git.writable}
            title={session.dirty ? "保存してからコミットしてください" : ""}
            data-testid="commit-button"><GitCommitHorizontal />コミット…</button
          >
        {/if}
        <button
          type="button"
          class="danger group-start"
          onclick={() => ws.deleteCurrent()}
          disabled={ws.busy || locked}
          data-testid="delete-button"><Trash />削除…</button
        >
      {/if}
      {#if !narrow}
        <button type="button" class="close" onclick={() => ws.closeArticle()} disabled={ws.busy}><X />閉じる</button>
      {/if}
    </div>
  </div>

  {#if ws.operation}
    <p class="op" role="status" data-testid="operation">処理中：{ws.operation}</p>
  {/if}
  {#if session.locked}
    <p class="readonly" role="status" data-testid="locked">{session.locked}</p>
  {/if}

  {#if toast && !toastHidden}
    <div
      class="toast notice {toast.kind}"
      role="status"
      data-testid="notice"
      onpointerenter={() => (toastHold = true)}
      onpointerleave={() => (toastHold = false)}
      onfocusin={() => (toastHold = true)}
      onfocusout={() => (toastHold = false)}
    >
      <p>{toast.text}</p>
      {#if toast.details?.length}
        <ul>
          {#each toast.details as d, i (i)}<li>{d}</li>{/each}
        </ul>
      {/if}
      <button type="button" class="toast-close touch-inline" aria-label="通知を閉じる" onclick={closeToast}>×</button>
    </div>
  {/if}
  {#if session.notice && session.notice.kind === "error" && !conflictAlert}
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
        alert={conflictAlert}
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
    <div class="tabs" role="tablist" aria-label="編集モード" data-sticky-chrome>
      {#if narrow}
        <button
          type="button"
          role="tab"
          id="tab-body"
          aria-selected={mode === "form" && formPart === "body"}
          aria-controls="panel-edit"
          onclick={() => switchPart("body")}
          data-testid="tab-body"><PenLine />本文</button
        >
        <button
          type="button"
          role="tab"
          id="tab-meta"
          aria-selected={mode === "form" && formPart === "meta"}
          aria-controls="panel-edit"
          onclick={() => switchPart("meta")}
          data-testid="tab-meta"><ClipboardList />記事情報</button
        >
      {:else}
        <button
          type="button"
          role="tab"
          id="tab-form"
          aria-selected={mode === "form"}
          aria-controls="panel-edit"
          onclick={() => switchMode("form")}><ClipboardList />フォーム</button
        >
      {/if}
      <button
        type="button"
        role="tab"
        id="tab-source"
        aria-selected={mode === "source"}
        aria-controls="panel-edit"
        onclick={() => switchMode("source")}><Code />原文</button
      >
      <button
        type="button"
        role="tab"
        id="tab-preview"
        aria-selected={mode === "preview"}
        aria-controls="panel-edit"
        onclick={() => switchMode("preview")}
        data-testid="tab-preview"><Eye />プレビュー</button
      >
    </div>
    {#if modeError}<p class="err" role="alert">{modeError}</p>{/if}

    <div id="panel-edit" role="tabpanel" aria-labelledby={currentTab} class="panel">
      {#if mode === "preview"}
        <Preview {ws} {session} />
      {:else if mode === "form" && formAvailable}
        <div class="form-layout" data-part={formPart}>
          <div class="src body">
            <div class="body-head">
              <span class="body-name"
                ><span id="body-label">本文</span><HelpTip label="本文の編集方法"
                  >「見たまま」は書式を表示したまま編集します。表・生
                  HTML・参照形式のリンクなどは灰色の枠で表示します。その部分は「Markdown」または「原文」で編集してください。</HelpTip
                ></span
              >
              <div class="seg" role="group" aria-label="本文の編集方法">
                <button
                  type="button"
                  aria-pressed={bodyView === "visual"}
                  onclick={() => setBodyView("visual")}
                  data-testid="body-view-visual">見たまま</button
                >
                <button
                  type="button"
                  aria-pressed={bodyView === "markdown"}
                  onclick={() => setBodyView("markdown")}
                  data-testid="body-view-markdown">Markdown</button
                >
              </div>
            </div>
            {#if bodyView === "visual"}
              <VisualEditor {ws} {session} />
            {:else}
              <textarea
                value={body}
                aria-labelledby="body-label"
                oninput={(e) => {
                  session.setBody(e.currentTarget.value);
                  session.bodyCaret = e.currentTarget.selectionStart;
                  session.bodyCaretBlock = false;
                }}
                onselect={(e) => (session.bodyCaret = e.currentTarget.selectionStart)}
                onclick={(e) => {
                  session.bodyCaret = e.currentTarget.selectionStart;
                  session.bodyCaretBlock = false;
                }}
                onkeyup={(e) => (session.bodyCaret = e.currentTarget.selectionStart)}
                readonly={locked}
                rows="18"
                spellcheck="false"
                data-testid="body-editor"
                data-body-focus></textarea>
            {/if}
          </div>
          <FrontmatterForm {session} authors={ws.authors} />
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
            autocapitalize="off"
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
    <span>最後の保存：{savedAgo(session.lastSavedAt)}</span>
    <span data-testid="draft-status">{draftLabel}</span>
  </footer>
</section>

<style>
  .ed-sticky {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .toolbar .group-start {
    margin-inline-start: var(--space-8);
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
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    padding: var(--control-pad-y) var(--control-pad-x);
    line-height: var(--control-line-height);
    background: var(--color-bg-surface);
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
    top: calc(100% + var(--space-4));
    z-index: var(--z-raised);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
    min-width: 14rem;
    padding: var(--space-4);
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-1);
  }
  .more-menu button {
    text-align: start;
  }
  /* 「その他」の印（…）は、狭い画面の操作バーでだけ出す */
  .more-icon {
    display: none;
  }
  .more-note {
    margin: 0;
    padding: 0 var(--space-8) var(--space-4);
    font-size: var(--font-size-13);
    color: var(--color-fg-muted);
  }
  /* 本文を主、記事情報を右の補助列に置く（UI刷新 方向B：P-02）。幅が足りないときは従来どおり縦に積む */
  .panel {
    container-type: inline-size;
  }
  .form-layout {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  /*
   * DOM は本文→記事情報（Tab 順を見た目に合わせる）。広い画面では縦積みのときも本文を先に表示する（P-02）。
   * 狭い画面（60rem 以下）は「本文」「記事情報」のタブで1つずつ出す（下の「狭い画面」）。
   */
  @container (min-width: 46rem) {
    .form-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 19rem;
      gap: 0 var(--space-12);
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
      border-inline-start: 1px solid var(--color-border-subtle);
      border-radius: 0;
      padding: 0 0 0 var(--space-12);
    }
    .form-layout :global(.form .grid) {
      grid-template-columns: minmax(0, 1fr);
    }
    .form-layout :global(.form .grid > *) {
      grid-column: 1 / -1;
    }
  }
  .body-name {
    display: inline-flex;
    align-items: center;
  }
  .body-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4) var(--space-8);
  }
  .seg {
    display: inline-flex;
  }
  .seg button {
    padding: var(--space-2) var(--space-10);
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-regular);
    border-radius: 0;
  }
  .seg button:first-child {
    border-radius: var(--radius-md) 0 0 var(--radius-md);
  }
  .seg button:last-child {
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    margin-inline-start: -1px;
  }
  .seg button[aria-pressed="true"] {
    background: var(--color-accent-subtle);
    color: var(--color-accent-text);
    font-weight: var(--font-weight-strong);
    box-shadow: inset 0 -3px 0 var(--color-accent);
  }
  .repairs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    margin-top: var(--space-8);
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    min-width: 0;
  }
  .ed-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-8);
  }
  h2 {
    margin: 0;
    font-size: var(--font-size-20);
    overflow-wrap: anywhere;
  }
  .untitled {
    color: var(--color-fg-muted);
  }
  .ids {
    margin: 0;
    color: var(--color-fg-muted);
    font-size: var(--font-size-14);
    display: flex;
    gap: var(--space-8);
  }
  .axes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-12);
    font-size: var(--font-size-13);
  }
  .axis {
    color: var(--color-fg-muted);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
  }
  .notice {
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    border: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface);
  }
  .notice p {
    margin: 0;
  }
  .notice ul {
    margin: var(--space-4) 0 0;
    padding-inline-start: var(--space-20);
    font-size: var(--font-size-14);
  }
  .notice.error {
    border-color: var(--color-danger-border);
    background: var(--color-danger-bg);
  }
  .notice.error p::before {
    content: "⚠ ";
  }
  .notice.ok {
    border-color: var(--color-success-border);
    background: var(--color-success-bg);
  }
  .notice.ok p::before {
    content: "✓ ";
  }
  .notice.warn {
    border-color: var(--color-warning-border);
    background: var(--color-warning-bg);
  }
  .notice.warn p::before {
    content: "! ";
  }
  /* 上部バーの下に出す（メニューの開閉・下部の操作バー・書式の帯・キーボードのどれとも重ならない） */
  .toast {
    position: fixed;
    top: calc(var(--app-bar-h, 0px) + var(--space-8));
    inset-inline-end: calc(var(--page-gutter) + var(--safe-right));
    z-index: var(--z-toast);
    max-width: min(26rem, calc(100vw - 2rem));
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0 var(--space-8);
    padding-inline-end: var(--space-6);
    box-shadow: var(--shadow-2);
  }
  .toast > :not(.toast-close) {
    grid-column: 1;
  }
  .toast-close {
    grid-column: 2;
    grid-row: 1;
    border: none;
    background: transparent;
    padding: 0;
    width: var(--target-min);
    height: var(--target-min);
    line-height: 1;
    color: var(--color-fg-muted);
  }
  .problems {
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    background: var(--color-danger-bg);
  }
  .problems ul {
    margin: var(--space-4) 0 0;
    padding-inline-start: var(--space-20);
    font-size: var(--font-size-14);
  }
  .tabs {
    display: flex;
    gap: var(--space-4);
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .tabs button {
    border: 1px solid var(--color-border-subtle);
    border-bottom: none;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    background: var(--color-bg-page);
    padding: var(--control-pad-y) var(--space-12);
    color: inherit;
    font: inherit;
    line-height: var(--control-line-height);
    cursor: pointer;
  }
  @media (hover: hover) {
    .tabs button:not([aria-selected="true"]):hover {
      background: var(--color-bg-hover);
    }
  }
  .tabs button[aria-selected="true"] {
    background: var(--color-accent-subtle);
    color: var(--color-accent-text);
    font-weight: var(--font-weight-strong);
    box-shadow: inset 0 calc(-1 * var(--border-width-edge)) 0 var(--color-accent);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  .src {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-weight: var(--font-weight-strong);
    font-size: var(--font-size-14);
  }
  textarea {
    width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "BIZ UDGothic", monospace;
    font-size: var(--font-size-15);
    line-height: var(--line-height-body);
    font-weight: var(--font-weight-regular);
    resize: vertical;
    tab-size: 4;
    background: var(--color-editor-bg);
    color: var(--color-editor-fg);
    caret-color: var(--color-editor-caret);
  }
  textarea::selection {
    background: var(--color-editor-selection-bg);
    color: var(--color-editor-selection-fg);
  }
  .readonly {
    border: 1px solid var(--color-warning-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: 0;
    background: var(--color-warning-bg);
  }
  .err {
    margin: 0;
    color: var(--color-danger-fg);
  }
  .op {
    margin: 0;
    font-size: var(--font-size-14);
    color: var(--color-fg-muted);
  }
  .ed-foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-16);
    color: var(--color-fg-muted);
    font-size: var(--font-size-13);
  }
  .small {
    font-size: var(--font-size-13);
    margin: 0;
  }
  /*
   * ---- 狭い画面（60rem 以下：iPhone・iPad の縦。ADR-0015）----
   * - 記事の操作は、画面の下に固定した操作バーに置く（位置と面は app.css の [data-bottom-bar]）。
   *   「保存」を広く取り、「元に戻す」「やり直す」「その他」はアイコンだけにする（名前は読み上げに残す）。
   *   コミット・複製・削除・閉じるは「その他」にまとめる。
   * - タブは上部バーの下に固定し、「本文」「記事情報」を1つずつ出す。
   * - 状態のバッジは 1 行にして横へ送る。
   */
  @media (max-width: 60rem) {
    .editor :global(*) {
      scroll-margin-top: var(--space-32);
    }
    h2 {
      font-size: var(--font-size-18);
      line-height: var(--line-height-heading);
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }
    .axes {
      flex-wrap: nowrap;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
      margin-inline: calc(-1 * var(--page-gutter));
      padding-inline: var(--page-gutter);
      font-size: var(--font-size-12);
    }
    .axes::-webkit-scrollbar {
      display: none;
    }
    .axes li {
      flex: none;
      white-space: nowrap;
    }
    .toolbar {
      flex-wrap: nowrap;
      gap: var(--space-8);
    }
    .toolbar .group-start {
      margin-inline-start: 0;
    }
    .toolbar > button.primary {
      flex: 1 1 auto;
    }
    .toolbar > button:not(.primary),
    .more > summary {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: var(--touch-target);
      min-height: var(--touch-target);
      padding: 0;
    }
    .toolbar > button:not(.primary) :global(svg.lucide-icon),
    .more > summary :global(svg.lucide-icon) {
      margin: 0;
      width: 1.375rem;
      height: 1.375rem;
    }
    /* 名前は読み上げに残し、見た目はアイコンだけにする */
    .toolbar > button:not(.primary) .t,
    .more > summary .t {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .more > summary {
      border-color: var(--color-border-control);
    }
    .more > summary::after,
    .more[open] > summary::after {
      content: none;
    }
    .more[open] > summary {
      background: var(--color-bg-pressed);
    }
    .more-icon {
      display: inline-flex;
    }
    /* 「その他」は操作バーの上へ開く */
    .more-menu {
      top: auto;
      bottom: calc(100% + var(--space-12));
      inset-inline: auto 0;
      min-width: 16rem;
      max-height: calc(
        100dvh - var(--bottom-bar-height) - var(--keyboard-inset) - var(--app-bar-h, 3rem) - var(--space-24)
      );
      overflow: auto;
      overscroll-behavior: contain;
      padding: var(--space-8);
      background: var(--color-bg-raised);
      border-color: var(--color-border-control);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-2);
    }
    .more-menu button {
      display: flex;
      align-items: center;
      min-height: var(--touch-target);
      border-color: transparent;
      background: transparent;
    }
    .more-menu button:active:not(:disabled) {
      background: var(--color-bg-pressed);
    }
    .more-menu .close {
      margin: 0;
    }
    .tabs {
      position: sticky;
      top: var(--app-bar-h, 0px);
      z-index: var(--z-sticky);
      gap: 0;
      margin-inline: calc(-1 * var(--page-gutter));
      padding: var(--space-4) var(--page-gutter) 0;
      background: var(--color-bg-page);
    }
    .tabs button {
      flex: 1 1 0;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding-inline: var(--space-4);
      white-space: nowrap;
      font-size: var(--font-size-15);
    }
    .tabs button + button {
      margin-inline-start: calc(-1 * var(--border-width));
    }
    .form-layout[data-part="body"] > :global(.form),
    .form-layout[data-part="meta"] > .body {
      display: none;
    }
    textarea {
      min-height: 50dvh;
    }
    .toast {
      inset-inline: calc(var(--page-gutter) + var(--safe-left)) calc(var(--page-gutter) + var(--safe-right));
      max-width: none;
    }
  }
  /* iPhone の縦：タブが 4 つ並ぶので、アイコンを外して名前だけにする */
  @media (max-width: 30rem) {
    .tabs button :global(svg.lucide-icon) {
      display: none;
    }
  }
  /*
   * 以下の広い画面用の上書きは、同じ詳細度の基本ルールより後に置く（前に置くと基本ルールに打ち消される）。
   */
  /*
   * 作業台レイアウト（広い画面）：見出し・状態・操作列を編集領域の上に固定する（P-03）。
   * 本文欄は内容に合わせて伸ばし、スクロールを編集領域の1つにまとめる（二重スクロールを避ける）。
   */
  @media (min-width: 60.0625rem) {
    .ed-sticky {
      position: sticky;
      top: 0;
      z-index: var(--z-sticky);
      background: var(--color-bg-page);
      padding-block: var(--space-4) var(--space-6);
      border-bottom: 1px solid var(--color-border-subtle);
    }
    .editor :global(*) {
      scroll-margin-top: calc(var(--sticky-h, 0px) + var(--space-8));
    }
    h2 {
      font-size: var(--font-size-18);
    }
    .axes {
      font-size: var(--font-size-12);
    }
    .toolbar button,
    .more > summary {
      padding: var(--control-pad-y-sm) var(--control-pad-x-sm);
      font-size: var(--font-size-14);
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
  /* 狭い側の作業台（〜75rem）では操作列の余白を詰めて1行に収める（UI刷新 反復4：OS 標準フォントでの折り返し） */
  @media (min-width: 60.0625rem) and (max-width: 75rem) {
    .toolbar {
      gap: var(--space-4);
    }
    .toolbar .group-start {
      margin-inline-start: var(--space-4);
    }
    .toolbar button,
    .more > summary {
      padding-inline: var(--space-6);
    }
  }
</style>
