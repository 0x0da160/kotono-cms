<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Folders from "@lucide/svelte/icons/folders";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import List from "@lucide/svelte/icons/list";
  import Lock from "@lucide/svelte/icons/lock";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import Settings from "@lucide/svelte/icons/settings";
  import X from "@lucide/svelte/icons/x";
  import { onMount, untrack } from "svelte";
  import AppUpdate from "./components/AppUpdate.svelte";
  import ArticleList from "./components/ArticleList.svelte";
  import CommitDialog from "./components/CommitDialog.svelte";
  import GitPanel from "./components/GitPanel.svelte";
  import HelpDialog from "./components/HelpDialog.svelte";
  import Logotype from "./components/Logotype.svelte";
  import HelpTip from "./components/HelpTip.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import DraftSettings from "./components/DraftSettings.svelte";
  import Editor from "./components/Editor.svelte";
  import RecoveryPanel from "./components/RecoveryPanel.svelte";
  import LoginGate from "./components/LoginGate.svelte";
  import PlacesPanel from "./components/PlacesPanel.svelte";
  import PlaceBar from "./components/PlaceBar.svelte";
  import SyncPanel from "./components/SyncPanel.svelte";
  import { SyncController } from "./lib/app/sync.svelte";
  import { PwaController } from "./lib/app/pwa.svelte";
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
  /** 使えない API のうち、この環境で要るもの。なければ一覧は畳んでおく（毎回の起動で技術的な一覧を見せない） */
  const missing = results.filter((r) => !r.ok && !(mode && unusedIn(mode, r.id))).length;
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
  const sync = new SyncController(ws, git, places);
  const pwa = new PwaController(host);
  // フォルダを開いたとき・一覧を読み直したときに Git 状態を取り直す（23.2：自動監視はしない）
  let gitRoot: unknown = null;
  $effect(() => {
    const root = ws.root;
    const scannedAt = ws.scan?.scannedAt;
    untrack(() => {
      const opened = root !== gitRoot;
      if (opened) {
        gitRoot = root;
        git.reset();
        sync.reset();
        pane = "list";
        section = "articles";
      }
      if (root && scannedAt !== undefined)
        void git.refresh().then(() => {
          // 同期先は開いたときに一度だけ読む（.git/config の origin・作業場所に保存した設定）
          if (opened) void sync.load();
        });
    });
  });
  /** 狭い画面での単一ペイン切替（14.1） */
  let pane = $state<"list" | "editor">("list");
  /**
   * 上部バーで切り替える画面（docs/knowledge/product/app-shell.md）。
   * 切り替えても各画面は閉じずに隠すだけなので、編集中の内容・取り消し履歴・スクロール位置はそのまま残る。
   */
  type Section = "articles" | "changes" | "settings";
  let section = $state<Section>("articles");

  const configIssues = $derived(ws.config !== null && (ws.config.errors.length > 0 || ws.config.warnings.length > 0));
  /** Git の結果の通知があり、それを出す「Git と同期」の画面を見ていない */
  const gitElsewhere = $derived(workbench && git.notice !== null && section !== "changes");

  function go(s: Section, p?: "list" | "editor") {
    section = s;
    if (p) pane = p;
  }

  let workerProbe: "pending" | "ok" | "failed" = $state("pending");
  onMount(() => {
    void probeWorker().then((ok) => (workerProbe = ok ? "ok" : "failed"));
    void pwa.start();
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

  async function updateApp() {
    if (!(await ws.confirmLeave("新しい版に切り替える前に、未保存の編集をどうしますか。"))) return;
    pwa.apply();
  }

  async function reloadApp() {
    if (!(await ws.confirmLeave("ページを読み込み直す前に、未保存の編集をどうしますか。"))) return;
    location.reload();
  }

  /** ログインで解錠した作業場所を開く */
  async function openPlace(id: string) {
    const e = places?.entries.find((x) => x.state === "ok" && x.meta.id === id);
    if (places && e?.state === "ok") await places.open(e.meta);
  }

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

{#snippet appInfo()}
  <AppUpdate {pwa} onapply={updateApp} onreload={reloadApp} />
  <dl class="versions">
    <dt>アプリ版</dt>
    <dd data-testid="app-version">{appVersion}</dd>
    <dt>仕様版</dt>
    <dd data-testid="spec-version">{specVersion}</dd>
  </dl>
{/snippet}

<a class="skip" href="#main">本文へ移動</a>
<!-- 上部バー：アプリ名・画面の切り替え・開いている場所とその操作・ヘルプ（docs/knowledge/product/app-shell.md） -->
<header class="app-bar" class:workbench>
  <div class="brand">
    <h1 class="logo-title"><Logotype height={workbench ? "1.25em" : "1.4em"} /></h1>
    {#if !workbench}<p class="tagline">手元のMarkdownで記事をつくる、ローカルCMS。</p>{/if}
  </div>
  {#if workbench}
    <nav class="sections" aria-label="画面の切り替え" data-testid="app-nav">
      <!-- 広い画面：一覧と編集は同じ画面に並ぶので「記事」1つ。狭い画面：「一覧」「編集」に分ける -->
      <button
        type="button"
        class="wide-only"
        aria-current={section === "articles" ? "page" : undefined}
        onclick={() => go("articles")}
        data-testid="nav-articles"><FileText />記事</button
      >
      <button
        type="button"
        class="narrow-only"
        aria-current={section === "articles" && pane === "list" ? "page" : undefined}
        onclick={() => go("articles", "list")}
        data-testid="nav-list"><List />一覧</button
      >
      <button
        type="button"
        class="narrow-only"
        aria-current={section === "articles" && pane === "editor" ? "page" : undefined}
        onclick={() => go("articles", "editor")}
        disabled={!ws.session}
        data-testid="nav-editor"><PenLine />編集</button
      >
      <button
        type="button"
        aria-current={section === "changes" ? "page" : undefined}
        onclick={() => go("changes")}
        data-testid="nav-changes"><GitBranch />Git と同期</button
      >
      <button
        type="button"
        aria-current={section === "settings" ? "page" : undefined}
        onclick={() => go("settings")}
        data-testid="nav-settings"><Settings />設定</button
      >
    </nav>
  {/if}
  <div class="place">
    {#if places}
      {#if ws.root}
        <span class="folder-name" data-testid="folder-name">作業場所：{ws.rootName}</span>
      {/if}
      {#if places.current}
        <button type="button" onclick={() => places.leave()} data-testid="place-leave"><Folders />作業場所の一覧</button
        >
        {#if places.current.keyring !== null}
          {@const id = places.current.id}
          <button type="button" onclick={() => places.lock(id)} data-testid="place-lock-open"><Lock />ロック</button>
        {/if}
      {/if}
    {:else if supported}
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
        <FolderOpen />{ws.root ? "別のフォルダを開く" : "フォルダを選択"}
      </button>
    {/if}
  </div>
  <HelpDialog />
</header>

<main id="main" tabindex="-1" class:wide={ws.root !== null} class:workbench>
  {#if supported && drafts.mode === "undecided" && !workbench}<DraftSettings {ws} dc={drafts} />{/if}
  {#if places && ws.root === null && (places.ready || places.error)}
    {#if places.loginRequired}
      <!-- 起動時のログイン（39.3）：暗号化した作業場所があれば、一覧より先にパスキーでの解錠を求める -->
      <LoginGate {places} onopen={openPlace} />
    {:else}
      <PlacesPanel {places} {ws} />
    {/if}
  {/if}
  {#if !supported || ws.root === null}
    {#if !places}<section aria-labelledby="start-heading" class="card">
        <h2 id="start-heading">はじめに</h2>
        {#if supported}
          <p>
            記事を保存しているリポジトリのフォルダ（<code>content/articles/</code>
            を含むフォルダ）を選んでください。<HelpTip label="フォルダの選択"
              >フォルダへのアクセスはこのタブを閉じるまで有効です。開いたフォルダは次回すぐ開けるようこのブラウザ内に記憶します（フォルダ名とアクセス用の情報だけで、記事の内容は保存しません）。開くときにブラウザがアクセスの許可を求めることがあります。</HelpTip
            >
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
          このブラウザで使えます（必要なAPIを備えています）。
        {:else}
          このブラウザでは一部の必要なAPIが利用できません。デスクトップ版の Chrome・Edge、または iOS・iPadOS 26 以降の
          Safari で開いてください。
        {/if}
      </p>
      <details class="env-details" open={!supported || missing > 0 || workerProbe === "failed"}>
        <summary data-testid="env-details">確認した項目（{results.length} 件）</summary>
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
      </details>
    </section>
  {:else}
    <!-- お知らせの帯：どの画面にいても見える。書き出しの状態・新しい版・フォルダと設定の問題 -->
    {#if (workbench && pwa.updateReady) || places?.current || ws.folderError || configIssues || gitElsewhere}
      <div class="notices" data-testid="app-notices">
        {#if workbench && pwa.updateReady}
          <p class="update" role="status" data-testid="update-ready">
            新しい版を取得しました。
            <button type="button" onclick={updateApp}>新しい版に切り替える</button>
          </p>
        {/if}
        {#if places?.current}
          <PlaceBar {places} {ws} {git} meta={places.current} />
        {/if}
        {#if ws.folderError}
          <p class="banner" role="alert" data-testid="folder-error">{ws.folderError}</p>
        {/if}
        {#if ws.config && configIssues}
          <div class="banner warn" role="status">
            {#each ws.config.errors as m, i (i)}<p>設定：{m}</p>{/each}
            {#each ws.config.warnings as m, i (i)}<p>設定（警告）：{m}</p>{/each}
          </div>
        {/if}
        {#if git.notice && gitElsewhere}
          <!-- 編集画面からのコミットなど、Git の結果を「Git と同期」の外でも見えるようにする。詳細はその画面にある -->
          <div
            class="git-strip"
            data-kind={git.notice.kind}
            role={git.notice.kind === "error" ? "alert" : "status"}
            data-testid="git-notice-strip"
          >
            <span class="git-strip-text">Git：{git.notice.text}</span>
            <button type="button" onclick={() => go("changes")}>「Git と同期」で見る</button>
            <button type="button" onclick={() => (git.notice = null)} aria-label="Git の通知を閉じる"><X /></button>
          </div>
        {/if}
      </div>
    {/if}

    {#if ws.missingArticles}
      <section class="card" aria-labelledby="prep-heading">
        <h2 id="prep-heading">初回フォルダ準備</h2>
        <p>
          このフォルダには <code>{ARTICLES_PATH}</code> がありません。記事を作成するには、次のフォルダを作成します。
        </p>
        <p><code>{ws.rootName}/{ARTICLES_PATH}</code></p>
        <p class="muted small">確認なしには作成しません。Git の初期化はしません。</p>
        <button type="button" class="primary" onclick={() => ws.prepareArticles()} data-testid="prepare-articles"
          >{ARTICLES_PATH} を作成する</button
        >
      </section>
    {:else if ws.articles}
      <!-- 画面：記事（一覧｜編集） -->
      <div class="section articles" hidden={section !== "articles"} data-section="articles">
        <RecoveryPanel {ws} />
        <div class="panes" data-pane={pane}>
          {#if supported && drafts.mode === "undecided"}
            <!-- 初回の設定は編集側の列に置き、一覧を押し下げない（UI刷新 P-04） -->
            <div class="consent-slot"><DraftSettings {ws} dc={drafts} /></div>
          {/if}
          <div class="pane list-pane">
            <ArticleList {ws} {git} onopen={() => (pane = "editor")} />
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
      </div>
      <!-- 画面：Git と同期 -->
      <div class="section page" hidden={section !== "changes"} data-section="changes">
        <div class="page-inner">
          <GitPanel {ws} {git} />
          {#if git.repo}<SyncPanel {sync} />{/if}
        </div>
      </div>
      <!-- 画面：設定 -->
      <div class="section page" hidden={section !== "settings"} data-section="settings">
        <div class="page-inner">
          <!-- 新しい版の確認は、いつでも見つけられるよう設定の先頭に置く -->
          <section class="card" aria-labelledby="about-heading" data-testid="settings-app">
            <h2 id="about-heading">アプリの更新と版</h2>
            {@render appInfo()}
          </section>
          {#if supported && drafts.mode !== "undecided"}<DraftSettings {ws} dc={drafts} variant="page" />{/if}
          {#if places?.current}<PlaceBar {places} {ws} {git} meta={places.current} part="settings" />{/if}
        </div>
      </div>
    {/if}
  {/if}
</main>

{#if !workbench}
  <footer class="app-footer" class:wide={ws.root !== null}>
    {#if supported && drafts.mode !== "undecided"}<DraftSettings {ws} dc={drafts} />{/if}
    {@render appInfo()}
  </footer>
{/if}

<ConfirmDialog request={ws.dialog} />
<CommitDialog {git} />
<div class="sr-only" aria-live="polite" data-testid="announcer">{ws.announcement}</div>

<style>
  /*
   * アプリの外枠（シェル）。領域と切り替えの決定は docs/knowledge/product/app-shell.md。
   * 上部バー → お知らせの帯 → 画面（記事｜Git と同期｜設定）。最初の画面だけフッター（版・復旧ドラフト）を持つ。
   * 上部バーの左右の余白は、内容の最大幅（96rem）に合わせて中身の端をそろえる。
   */
  .skip {
    position: absolute;
    left: var(--space-8);
    top: -3rem;
    background: var(--color-surface);
    padding: var(--space-8) var(--space-12);
    border: 2px solid var(--color-focus);
    border-radius: var(--radius-md);
    z-index: var(--z-popover);
  }
  .skip:focus {
    top: var(--space-8);
  }
  main:focus {
    outline: none;
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    margin-block: var(--space-8);
  }

  /* ---- 上部バー ---- */
  .app-bar {
    --gutter: max(var(--space-16), (100% - 96rem) / 2 + var(--space-16));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-6) var(--space-12);
    padding: var(--space-8) var(--gutter);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-12);
  }
  .brand {
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--font-size-24);
    letter-spacing: 0.01em;
  }
  .app-bar.workbench {
    padding-block: var(--space-4);
    margin-bottom: 0;
  }
  .app-bar.workbench h1 {
    font-size: var(--font-size-18);
    white-space: nowrap;
  }
  .tagline {
    margin: var(--space-4) 0 0;
    color: var(--color-muted);
    font-size: var(--font-size-14);
  }
  .place {
    display: flex;
    align-items: center;
    gap: var(--control-gap) var(--space-12);
    flex-wrap: wrap;
    margin-inline-start: auto;
    min-width: 0;
  }
  .folder-name {
    font-size: var(--font-size-14);
    overflow-wrap: anywhere;
  }
  .workbench .place button,
  .app-bar.workbench > :global(.help-open) {
    font-size: var(--font-size-14);
    padding: var(--control-pad-y-sm) var(--control-pad-x-sm);
  }

  /* 画面の切り替え：選んでいる画面は文字の太さと下線で示す（色だけに頼らない：14.1） */
  .sections {
    display: flex;
    gap: var(--space-4);
  }
  .sections button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-color: transparent;
    background: transparent;
    color: var(--color-muted);
    font-size: var(--font-size-14);
    padding: var(--control-pad-y) var(--control-pad-x);
    white-space: nowrap;
  }
  .sections button:not(:disabled):hover {
    color: var(--color-text);
    background: var(--color-bg);
  }
  .sections button[aria-current="page"] {
    color: var(--color-text);
    font-weight: var(--font-weight-strong);
    box-shadow: inset 0 -2px 0 var(--color-accent);
    border-end-start-radius: 0;
    border-end-end-radius: 0;
  }
  .narrow-only {
    display: none !important;
  }

  /* ---- 画面の中身 ---- */
  main,
  .app-footer {
    max-width: 48rem;
    margin-inline: auto;
    padding-inline: var(--space-16);
  }
  main.wide,
  .app-footer.wide {
    max-width: 96rem;
  }
  main.workbench {
    padding-block-start: var(--space-8);
  }
  .section[hidden] {
    display: none !important;
  }
  .page-inner {
    max-width: 48rem;
    margin-inline: auto;
  }
  .notices {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    margin-block-end: var(--space-8);
    font-size: var(--font-size-14);
  }
  .notices .banner,
  .notices .update {
    margin: 0;
  }
  .update {
    margin: var(--space-8) 0;
  }
  .git-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4) var(--space-8);
    border: 1px solid var(--color-border);
    border-inline-start: 3px solid var(--color-field-border);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-12);
    background: var(--color-surface);
  }
  .git-strip[data-kind="ok"] {
    border-inline-start-color: var(--color-ok);
  }
  .git-strip[data-kind="error"],
  .git-strip[data-kind="warn"] {
    border-color: var(--color-ng);
  }
  .git-strip-text {
    flex: 1 1 16rem;
    min-width: 0;
  }
  .git-strip button {
    font-size: var(--font-size-14);
    padding: var(--control-pad-y-sm) var(--control-pad-x-sm);
  }
  .git-strip button :global(svg.lucide-icon) {
    margin: 0;
  }
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
  .env-details summary {
    cursor: pointer;
    font-size: var(--font-size-14);
    color: var(--color-muted);
    min-height: 1.5rem;
  }
  @media (pointer: coarse) {
    .env-details summary {
      min-height: var(--touch-target);
    }
  }
  .env-details[open] summary {
    margin-block-end: var(--space-8);
  }
  .capabilities {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .capabilities li {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    gap: var(--space-4) var(--space-8);
    padding-block: var(--space-6);
    border-top: 1px solid var(--color-border);
  }
  .capabilities li:first-child {
    border-top: none;
  }
  .mark {
    font-weight: 700;
  }
  li[data-ok="true"] .mark {
    color: var(--color-ok);
  }
  li[data-ok="false"] .mark {
    color: var(--color-ng);
  }
  .state {
    color: var(--color-muted);
    font-size: var(--font-size-14);
  }
  .impact {
    grid-column: 2 / -1;
    font-size: var(--font-size-14);
    color: var(--color-muted);
  }
  .probe {
    margin: var(--space-12) 0 0;
    font-size: var(--font-size-14);
    color: var(--color-muted);
  }
  .banner {
    border: 1px solid var(--color-ng);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: 0 0 var(--space-8);
    background: var(--color-surface);
  }
  .banner p {
    margin: 0;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(18rem, 26rem) minmax(0, 1fr);
    gap: var(--space-16);
    align-items: start;
  }

  /*
   * 狭い画面（60rem 以下：iPad の縦・iPhone を含む）：ページ全体を1つのスクロールにし、
   * 上部バーの2行目に「一覧｜編集｜Git と同期｜設定」を並べる。一覧と編集は1度に1つだけ出す（14.1）。
   */
  @media (max-width: 60rem) {
    .wide-only {
      display: none !important;
    }
    .narrow-only {
      display: inline-flex !important;
    }
    .sections {
      order: 3;
      flex: 1 0 100%;
      gap: var(--space-2);
      margin-inline: calc(var(--space-4) * -1);
    }
    .sections button {
      flex: 1 1 0;
      min-width: 0;
      padding-inline: var(--space-4);
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
   * とても狭い画面（iPhone の縦）：1行目にアプリ名とヘルプ、2行目に開いている場所とその操作、3行目に画面の切り替え。
   * 切り替えのアイコンは外して文字を優先する（ボタンの意味は常に文字で伝える：14.1）
   */
  @media (max-width: 30rem) {
    .brand {
      flex: 1 1 auto;
    }
    .app-bar > :global(.help-open) {
      order: 1;
    }
    .place {
      order: 2;
      flex: 1 0 100%;
      margin-inline-start: 0;
    }
    .folder-name {
      flex: 1 1 auto;
    }
    .sections :global(svg.lucide-icon) {
      display: none;
    }
  }

  /*
   * 作業台レイアウト（UI刷新 方向B）：広い画面では画面全体の高さを使い、上部バーとお知らせの帯は固定、
   * 「記事」は一覧と編集をそれぞれ独立してスクロールさせる。「Git と同期」「設定」は画面ごとにスクロールする。
   */
  @media (min-width: 60.0625rem) {
    :global(#app:has(> main.workbench)) {
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: clip;
    }
    .app-bar.workbench {
      flex: none;
      flex-wrap: nowrap;
    }
    main.workbench {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
      padding-block-start: var(--space-6);
    }
    main.workbench > .notices {
      flex: none;
    }
    main.workbench > .section {
      flex: 1 1 auto;
      min-height: 0;
    }
    main.workbench > .articles {
      display: flex;
      flex-direction: column;
    }
    main.workbench > .page {
      overflow: auto;
      overscroll-behavior: contain;
      padding-block-end: var(--space-24);
    }
    main.workbench .panes {
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
      border-inline-end: 1px solid var(--color-border);
      padding-inline-end: var(--space-8);
    }
    main.workbench .editor-pane {
      padding-inline-start: var(--space-12);
    }
    main.workbench .panes:has(> .consent-slot) {
      grid-template-rows: auto minmax(0, 1fr);
    }
    main.workbench .panes > .consent-slot {
      grid-column: 2;
      grid-row: 1;
      padding: var(--space-8) 0 0 var(--space-12);
    }
    main.workbench .panes:has(> .consent-slot) > .list-pane {
      grid-column: 1;
      grid-row: 1 / span 2;
    }
    main.workbench .panes:has(> .consent-slot) > .editor-pane {
      grid-column: 2;
      grid-row: 2;
    }
  }
  /* 狭い側の作業台（〜75rem）では一覧の列を最小幅にして、編集側の操作列を1行に収める（UI刷新 反復4） */
  @media (min-width: 60.0625rem) and (max-width: 75rem) {
    main.workbench .panes {
      grid-template-columns: 17rem minmax(0, 1fr);
    }
  }
  .empty {
    padding: var(--space-24) 0;
    text-align: center;
  }
  .small {
    font-size: var(--font-size-14);
  }
  .app-footer {
    padding-block: var(--space-24) var(--space-32);
    color: var(--color-muted);
    font-size: var(--font-size-14);
  }
  .versions {
    display: flex;
    gap: var(--space-4) var(--space-12);
    flex-wrap: wrap;
    margin: 0;
  }
  .versions dt::after {
    content: "：";
  }
  .versions dd {
    margin: 0 var(--space-12) 0 0;
  }
</style>
