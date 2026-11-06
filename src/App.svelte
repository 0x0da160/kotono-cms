<script lang="ts">
  import { onMount, untrack } from "svelte";
  import ArticleList from "./components/ArticleList.svelte";
  import CommitDialog from "./components/CommitDialog.svelte";
  import GitPanel from "./components/GitPanel.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import DraftSettings from "./components/DraftSettings.svelte";
  import Editor from "./components/Editor.svelte";
  import RecoveryPanel from "./components/RecoveryPanel.svelte";
  import PlacesPanel from "./components/PlacesPanel.svelte";
  import PlaceBar from "./components/PlaceBar.svelte";
  import { PlacesController, browserDeliver } from "./lib/app/places.svelte";
  import { Vault } from "./lib/crypto/vault";
  import { browserPasskey } from "./lib/crypto/passkey";
  import { SealedDraftStore } from "./lib/drafts/sealed";
  import { opfsRoot } from "./lib/workspaces/store";
  import { DraftController } from "./lib/app/drafts.svelte";
  import { GitController } from "./lib/app/git.svelte";
  import { Workspace } from "./lib/app/workspace.svelte";
  import { IdbDraftStore } from "./lib/drafts/store";
  import { IdbRecentFolderStore } from "./lib/app/recent-folder";
  import { WorkerMdService } from "./lib/parse/md-worker-service";
  import { detectCapabilities, supportedMode, unusedIn } from "./lib/capabilities";
  import { ARTICLES_PATH } from "./lib/fs/repo";
  import { probeWorker } from "./lib/worker-probe";

  const appVersion = __APP_VERSION__;
  const specVersion = __SPEC_VERSION__;
  const results = detectCapabilities(globalThis as unknown as Record<string, unknown>);
  // 実フォルダを選べる環境では実フォルダを使う。`?storage=workspace` でブラウザ内の作業場所を選べる（2.1・38.1）
  const prefer = new URLSearchParams(location.search).get("storage") === "workspace" ? "workspace" : null;
  const mode = supportedMode(results, prefer);
  const supported = mode !== null;
  const inPlaces = mode === "workspace";

  const sealedDrafts = typeof indexedDB === "undefined" ? null : new SealedDraftStore(new IdbDraftStore(indexedDB));
  const drafts = new DraftController(sealedDrafts, appVersion);
  const ws = new Workspace(globalThis as unknown as ConstructorParameters<typeof Workspace>[0], {
    drafts,
    appVersion,
    specVersion,
    md: new WorkerMdService(),
    recent: typeof indexedDB === "undefined" ? null : new IdbRecentFolderStore(indexedDB),
  });
  const workbench = $derived(ws.root !== null && ws.articles !== null && !ws.missingArticles);
  const git = new GitController(ws);
  ws.git = git.hooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ブラウザの大域を各層の最小の型へ渡す
  const host = globalThis as any;
  const places = inPlaces
    ? new PlacesController(ws, host, browserDeliver(host), {
        vault: new Vault(browserPasskey(host)),
        sealed: sealedDrafts,
      })
    : null;
  // フォルダを開いたとき・一覧を読み直したときに Git 状態を取り直す（23.2：自動監視はしない）
  let gitRoot: unknown = null;
  $effect(() => {
    const root = ws.root;
    const scannedAt = ws.scan?.scannedAt;
    untrack(() => {
      if (root !== gitRoot) {
        gitRoot = root;
        git.reset();
      }
      if (root && scannedAt !== undefined) void git.refresh();
    });
  });
  /** 狭い画面での単一ペイン切替（14.1） */
  let pane = $state<"list" | "editor">("list");

  let workerProbe: "pending" | "ok" | "failed" = $state("pending");
  onMount(() => {
    void probeWorker().then((ok) => (workerProbe = ok ? "ok" : "failed"));
    if (supported) void drafts.init();
    // 前回のフォルダ：権限が残っていればそのまま開く。残っていなければ「前回のフォルダを開く」を示す（ADR-0005）
    if (mode === "folder") void ws.loadRecent();
    if (places) {
      void opfsRoot(host).then(async (root) => {
        if (root) await places.init(root);
        else places.error = "ブラウザ内の保存領域（OPFS）を開けません。";
      });
      // 自動ロック（39.3）：無操作の時間を数える。非表示の間はタイマーが止まることがあるので、戻ったときにも調べる
      const t = setInterval(() => void places.tick(), 30_000);
      const onVis = () => void places.visibility(document.visibilityState === "hidden");
      document.addEventListener("visibilitychange", onVis);
      return () => {
        clearInterval(t);
        document.removeEventListener("visibilitychange", onVis);
      };
    }
  });

  function onActivity() {
    places?.activity();
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    // IME 変換中は key が "Process" になることがある（Microsoft IME など）。物理キー（code）でも判定し、確定を案内する（14.1）
    const isS = e.key.toLowerCase() === "s" || (e.isComposing && e.code === "KeyS");
    if (mod && !e.altKey && isS) {
      // IME が処理中のキー（"Process"）は IME に任せ、既定動作を止めない
      if (e.key !== "Process") e.preventDefault();
      if (!ws.session) return;
      // IME の未確定文字列を失わせない（14.1）：変換中は保存しない
      if (e.isComposing) {
        ws.session.notice = { kind: "warn", text: "変換を確定してから保存してください。" };
        ws.announce(ws.session.notice.text);
        return;
      }
      void ws.save();
    }
  }

  function onBeforeUnload(e: BeforeUnloadEvent) {
    // 離脱警告は試みるが、表示は保証されない（13.1）
    if (ws.session?.dirty && ws.session.readOnlyReason === null) {
      e.preventDefault();
      // 退避を試みる（完了は保証されない：33.4）
      void drafts.flush(ws.session);
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    onActivity();
    onKeydown(e);
  }}
  onpointerdown={onActivity}
  onbeforeunload={onBeforeUnload}
/>

<a class="skip" href="#main">本文へ移動</a>
<header class="app-header">
  <div class="brand">
    <h1>Kotono CMS</h1>
    <p class="tagline">手元のMarkdownで記事をつくる、ローカルCMS。</p>
  </div>
  {#if places}
    {#if ws.root}
      <div class="folder">
        <span class="folder-name" data-testid="folder-name">作業場所：{ws.rootName}</span>
      </div>
    {/if}
  {:else if supported}
    <div class="folder">
      {#if ws.root}
        <span class="folder-name" data-testid="folder-name">作業フォルダ：{ws.rootName}</span>
      {/if}
      <button
        type="button"
        class={ws.root || ws.recent ? "" : "primary"}
        onclick={() => ws.chooseFolder()}
        disabled={ws.busy}
        data-testid="choose-folder"
      >
        {ws.root ? "別のフォルダを開く" : "フォルダを選択"}
      </button>
    </div>
  {/if}
</header>

<main id="main" tabindex="-1" class:wide={ws.root !== null} class:workbench>
  {#if supported && drafts.mode === "undecided" && !workbench}<DraftSettings {ws} dc={drafts} />{/if}
  {#if places && ws.root === null}
    <PlacesPanel {places} {ws} />
  {/if}
  {#if !supported || ws.root === null}
    {#if !places}<section aria-labelledby="start-heading" class="card">
        <h2 id="start-heading">はじめに</h2>
        {#if supported}
          <p>
            記事を保存しているリポジトリのフォルダ（<code>content/articles/</code> を含むフォルダ）を選んでください。フォルダへのアクセスはこのタブを閉じるまで有効です。
          </p>
          {#if ws.recent}
            <div class="recent" data-testid="recent-folder">
              <button
                type="button"
                class="primary"
                onclick={() => ws.reopenRecent()}
                disabled={ws.busy}
                data-testid="reopen-recent">前回のフォルダ「{ws.recent.name}」を開く</button
              >
              <button type="button" onclick={() => ws.forgetRecent()} data-testid="forget-recent">記憶を消す</button>
            </div>
            {#if ws.folderError}<p class="banner" role="alert" data-testid="folder-error">{ws.folderError}</p>{/if}
          {/if}
          <p class="muted small">
            開いたフォルダは、次回すぐ開けるようこのブラウザ内に記憶します（フォルダ名とアクセス用の情報だけで、記事の内容は保存しません）。開くときにブラウザがアクセスの許可を求めることがあります。
          </p>
          <p class="muted small">
            記事は手動で保存します。Git を使う場合は、記事単位でコミットできます（push・pull は行いません）。
          </p>
        {:else}
          <p>
            このブラウザでは編集を開始できません。デスクトップ版の Chrome・Edge、または iOS・iPadOS 26 以降の Safari
            で開いてください。
          </p>
        {/if}
      </section>{/if}

    <section aria-labelledby="env-heading" class="card">
      <h2 id="env-heading">対応環境の確認</h2>
      <p role="status" data-testid="env-summary">
        {#if supported}
          このブラウザは必要なAPIを備えています（実機検証の代替ではありません）。
        {:else}
          このブラウザでは一部の必要なAPIが利用できません。デスクトップ版の Chrome・Edge、または iOS・iPadOS 26 以降の
          Safari で開いてください。
        {/if}
      </p>
      <ul class="capabilities">
        {#each results as r (r.id)}
          <li data-capability={r.id} data-ok={r.ok}>
            <span class="mark" aria-hidden="true">{r.ok ? "✓" : "✕"}</span>
            <span class="label">{r.label}</span>
            <span class="state"
              >{r.ok ? "利用可能" : mode && unusedIn(mode, r.id) ? "この環境では不要" : "利用不可"}</span
            >
            {#if !r.ok && !(mode && unusedIn(mode, r.id))}
              <span class="impact">{r.impact}</span>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="probe" data-testid="worker-probe" data-state={workerProbe}>
        隔離処理の起動確認：
        {#if workerProbe === "pending"}
          確認中…
        {:else if workerProbe === "ok"}
          Worker が起動し、応答しました。
        {:else}
          Worker を起動できませんでした。
        {/if}
      </p>
    </section>
  {:else}
    {#if places?.current}
      <PlaceBar {places} {ws} {git} meta={places.current} />
    {/if}
    {#if ws.folderError}
      <p class="banner" role="alert" data-testid="folder-error">{ws.folderError}</p>
    {/if}
    {#if ws.config && (ws.config.errors.length > 0 || ws.config.warnings.length > 0)}
      <div class="banner warn" role="status">
        {#each ws.config.errors as m, i (i)}<p>設定：{m}</p>{/each}
        {#each ws.config.warnings as m, i (i)}<p>設定（警告）：{m}</p>{/each}
      </div>
    {/if}

    {#if ws.missingArticles}
      <section class="card" aria-labelledby="prep-heading">
        <h2 id="prep-heading">初回フォルダ準備</h2>
        <p>
          このフォルダには <code>{ARTICLES_PATH}</code> がありません。記事を作成するには、次のフォルダを作成します。
        </p>
        <p><code>{ws.rootName}/{ARTICLES_PATH}</code></p>
        <p class="muted small">確認なしには作成しません。Git の初期化は行いません。</p>
        <button type="button" class="primary" onclick={() => ws.prepareArticles()} data-testid="prepare-articles"
          >{ARTICLES_PATH} を作成する</button
        >
      </section>
    {:else if ws.articles}
      <RecoveryPanel {ws} />
      <div class="pane-switch" role="group" aria-label="表示する領域">
        <button type="button" aria-pressed={pane === "list"} onclick={() => (pane = "list")}>一覧</button>
        <button type="button" aria-pressed={pane === "editor"} onclick={() => (pane = "editor")} disabled={!ws.session}
          >編集</button
        >
      </div>
      <div class="panes" data-pane={pane}>
        {#if supported && drafts.mode === "undecided"}
          <!-- 初回の設定は編集側の列に置き、一覧を押し下げない（UI刷新 P-04） -->
          <div class="consent-slot"><DraftSettings {ws} dc={drafts} /></div>
        {/if}
        <div class="pane list-pane">
          <ArticleList {ws} {git} onopen={() => (pane = "editor")} />
          <GitPanel {ws} {git} />
        </div>
        <div class="pane editor-pane">
          {#if ws.session}
            {#key ws.session}
              <Editor {ws} session={ws.session} {git} />
            {/key}
          {:else}
            <p class="muted empty">一覧から記事を選ぶか、「新規作成」を押してください。</p>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</main>

<footer class="app-footer" class:wide={ws.root !== null} class:workbench>
  {#if supported && drafts.mode !== "undecided"}<DraftSettings {ws} dc={drafts} />{/if}
  <p class="keys small">
    キーボード：Ctrl/⌘+S 保存、Ctrl/⌘+Z 元に戻す、Ctrl/⌘+Shift+Z または Ctrl+Y やり直す。IME 変換中は保存しません。
  </p>
  <dl>
    <dt>アプリ版</dt>
    <dd data-testid="app-version">{appVersion}</dd>
    <dt>仕様版</dt>
    <dd data-testid="spec-version">{specVersion}</dd>
  </dl>
</footer>

<ConfirmDialog request={ws.dialog} />
<CommitDialog {git} />
<div class="sr-only" aria-live="polite" data-testid="announcer">{ws.announcement}</div>

<style>
  .skip {
    position: absolute;
    left: 0.5rem;
    top: -3rem;
    background: var(--surface);
    padding: 0.5rem 0.75rem;
    border: 2px solid var(--focus);
    border-radius: 6px;
    z-index: 10;
  }
  .skip:focus {
    top: 0.5rem;
  }
  main:focus {
    outline: none;
  }
  .keys {
    margin: 0.5rem 0;
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block: 0.5rem;
  }
  .app-header,
  main,
  .app-footer {
    max-width: 48rem;
    margin-inline: auto;
    padding-inline: 1rem;
  }
  main.wide,
  .app-footer.wide,
  .app-header {
    max-width: 96rem;
  }
  .app-header {
    padding-block: 1rem 0.75rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: 0.01em;
  }
  .tagline {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .folder {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .folder-name {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-block-end: 1rem;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.125rem;
  }
  .capabilities {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .capabilities li {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    gap: 0.25rem 0.5rem;
    padding-block: 0.375rem;
    border-top: 1px solid var(--border);
  }
  .capabilities li:first-child {
    border-top: none;
  }
  .mark {
    font-weight: 700;
  }
  li[data-ok="true"] .mark {
    color: var(--ok);
  }
  li[data-ok="false"] .mark {
    color: var(--ng);
  }
  .state {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .impact {
    grid-column: 2 / -1;
    font-size: 0.875rem;
    color: var(--muted);
  }
  .probe {
    margin: 0.75rem 0 0;
    font-size: 0.875rem;
    color: var(--muted);
  }
  .banner {
    border: 1px solid var(--ng);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0 0 0.75rem;
    background: var(--surface);
  }
  .banner p {
    margin: 0;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(18rem, 26rem) minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
  }
  .pane-switch {
    display: none;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .pane-switch button[aria-pressed="true"] {
    font-weight: 600;
    border-color: var(--focus);
  }
  @media (max-width: 60rem) {
    .pane-switch {
      display: flex;
    }
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }
    .panes[data-pane="list"] .editor-pane,
    .panes[data-pane="editor"] .list-pane {
      display: none;
    }
  }
  /*
   * 作業台レイアウト（UI刷新 方向B）：広い画面では一覧と編集をそれぞれ独立してスクロールさせ、
   * 画面の高さ全体で作業する。狭い画面（60rem 以下）は従来の単一ペイン切替のまま。
   */
  @media (min-width: 60.0625rem) {
    :global(#app:has(> main.workbench)) {
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: clip;
    }
    :global(#app:has(> main.workbench)) > .app-header {
      flex: none;
      width: 100%;
      padding-block: 0.5rem;
      margin-bottom: 0.5rem;
    }
    :global(#app:has(> main.workbench)) h1 {
      font-size: 1.125rem;
    }
    /* 作業中は名前と説明を1行にして、縦の領域を空ける（UI刷新 P-10） */
    :global(#app:has(> main.workbench)) .brand {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0 0.75rem;
    }
    main.workbench {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
    }
    main.workbench > .panes {
      flex: 1 1 auto;
      min-height: 0;
      grid-template-columns: minmax(17rem, 22rem) minmax(0, 1fr);
      gap: 0;
      align-items: stretch;
    }
    main.workbench .pane {
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
    }
    main.workbench .list-pane {
      border-inline-end: 1px solid var(--border);
      padding-inline-end: 0.75rem;
    }
    main.workbench .editor-pane {
      padding-inline-start: 1rem;
    }
    main.workbench > .panes:has(> .consent-slot) {
      grid-template-rows: auto minmax(0, 1fr);
    }
    main.workbench > .panes > .consent-slot {
      grid-column: 2;
      grid-row: 1;
      padding: 0.75rem 0 0 1rem;
    }
    main.workbench > .panes:has(> .consent-slot) > .list-pane {
      grid-column: 1;
      grid-row: 1 / span 2;
    }
    main.workbench > .panes:has(> .consent-slot) > .editor-pane {
      grid-column: 2;
      grid-row: 2;
    }
    .app-footer.workbench {
      flex: none;
      width: 100%;
      max-height: 40vh;
      overflow: auto;
      padding-block: 0.25rem 0.375rem;
      border-top: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0 1rem;
      font-size: 0.75rem;
    }
    .app-footer.workbench .keys {
      margin: 0;
      font-size: 0.75rem;
    }
  }
  /* 狭い側の作業台（〜75rem）では一覧の列を最小幅にして、編集側の操作列を1行に収める（UI刷新 反復4） */
  @media (min-width: 60.0625rem) and (max-width: 75rem) {
    main.workbench > .panes {
      grid-template-columns: 17rem minmax(0, 1fr);
    }
  }
  .empty {
    padding: 2rem 0;
    text-align: center;
  }
  .small {
    font-size: 0.875rem;
  }
  .app-footer {
    padding-block: 1.5rem 2rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .app-footer dl {
    display: flex;
    gap: 0.25rem 0.75rem;
    flex-wrap: wrap;
    margin: 0;
  }
  .app-footer dt::after {
    content: "：";
  }
  .app-footer dd {
    margin: 0 0.75rem 0 0;
  }
</style>
