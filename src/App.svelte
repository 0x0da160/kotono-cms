<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Folders from "@lucide/svelte/icons/folders";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import List from "@lucide/svelte/icons/list";
  import Lock from "@lucide/svelte/icons/lock";
  import Menu from "@lucide/svelte/icons/menu";
  import CircleQuestionMark from "@lucide/svelte/icons/circle-question-mark";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import Settings from "@lucide/svelte/icons/settings";
  import X from "@lucide/svelte/icons/x";
  import { onMount, untrack } from "svelte";
  import AppUpdate from "./components/AppUpdate.svelte";
  import ArticleList from "./components/ArticleList.svelte";
  import CommitDialog from "./components/CommitDialog.svelte";
  import GitPanel from "./components/GitPanel.svelte";
  import HelpDialog from "./components/HelpDialog.svelte";
  import HelpTip from "./components/HelpTip.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import DraftSettings from "./components/DraftSettings.svelte";
  import Editor from "./components/Editor.svelte";
  import RecoveryPanel from "./components/RecoveryPanel.svelte";
  import LoginScreen from "./components/LoginScreen.svelte";
  import LoginSettings from "./components/LoginSettings.svelte";
  import PlacesPanel from "./components/PlacesPanel.svelte";
  import PlaceBar from "./components/PlaceBar.svelte";
  import SyncPanel from "./components/SyncPanel.svelte";
  import { SyncController } from "./lib/app/sync.svelte";
  import { PwaController } from "./lib/app/pwa.svelte";
  import { PlacesController, browserDeliver } from "./lib/app/places.svelte";
  import { Vault } from "./lib/crypto/vault";
  import { browserPasskey } from "./lib/crypto/passkey";
  import { SealedDraftStore } from "./lib/drafts/sealed";
  import { openOpfs } from "./lib/workspaces/store";
  import { DraftController } from "./lib/app/drafts.svelte";
  import { LoginController } from "./lib/app/login.svelte";
  import { IdbLoginStore } from "./lib/login/store";
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
  const vault = new Vault(browserPasskey(host));
  /** 起動時のログイン（ADR-0011）：何よりも先にパスキー（使えなければパスフレーズ）で認証する */
  const login = new LoginController(
    vault,
    typeof indexedDB === "undefined" ? null : new IdbLoginStore(indexedDB),
    sealedDrafts,
  );
  const places = inPlaces
    ? new PlacesController(ws, host, browserDeliver(host), {
        vault,
        sealed: sealedDrafts,
        hooks: {
          unlocked: (id) => login.rememberPlace(id),
          removed: (id) => login.forgetPlace(id),
          autoLocked: () => void lockApp(true),
          active: () => login.unlocked,
        },
      })
    : null;
  /** ログインの画面を出している間は、ほかの画面を出さない */
  const gated = $derived(supported && login.phase !== "ready" && login.phase !== "unavailable");
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
  let placesReady: Promise<void> = Promise.resolve();
  onMount(() => {
    void probeWorker().then((ok) => (workerProbe = ok ? "ok" : "failed"));
    void pwa.start();
    if (supported) {
      void drafts.init();
      void login.init();
    }
    if (places) {
      placesReady = places.start(() => openOpfs(host));
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

  /** ログインしたら（ログインできない環境では最初から）、フォルダ・作業場所を開く準備をする */
  $effect(() => {
    if (!supported || gated || login.phase === "loading") return;
    untrack(() => void afterLogin());
  });

  async function afterLogin() {
    // ログインの画面が消えてフォーカスを失ったら、画面の中身へ移す（キーボードの位置を見失わせない）
    if (document.activeElement === document.body || document.activeElement === null)
      document.getElementById("main")?.focus();
    // 前回のフォルダ：権限が残っていればそのまま開く。残っていなければ「前回のフォルダを開く」を示す（ADR-0005）
    if (mode === "folder" && ws.root === null) await ws.loadRecent();
    if (places) {
      await placesReady;
      // ログインで覚えていた暗号化した作業場所は、解錠済みにする
      places.adoptUnlocked(await login.unlockPlaces());
    }
  }

  /**
   * ロックする（ログインの画面に戻る）。未保存の編集は、復旧ドラフトへ退避してから閉じる。
   * 退避できないとき（ドラフトが無効など）は、手動のロックなら閉じる前に確かめる。
   */
  async function lockApp(auto = false) {
    menuOpen = false;
    if (places) await places.lockAll();
    if (ws.root) {
      const s = ws.session;
      let kept = true;
      if (s?.dirty && s.readOnlyReason === null) {
        await drafts.flush(s).catch(() => undefined);
        kept = s.draft.kind === "saved" && s.draft.revision === s.revision;
      }
      if (!kept && !auto && !(await ws.confirmLeave("ロックする前に、未保存の編集をどうしますか。"))) return;
      ws.close();
    }
    login.lock();
  }

  /** ログインを作り直す（どの方法でもログインできないとき） */
  async function resetLogin() {
    const v = await ws.ask({
      title: "ログインを作り直します",
      message:
        "登録したパスキー・パスフレーズ・回復コードの情報をこのブラウザから消し、登録からやり直します。このブラウザの復旧ドラフトはすべて削除します（もう読めないため）。",
      details: [
        "ブラウザ内の作業場所は消しません。それぞれの回復コード・パスフレーズで開けます。",
        "パスキー管理アプリに残るパスキーは、不要なら管理アプリで削除してください。",
      ],
      buttons: [
        { label: "作り直す", value: "reset", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v !== "reset") return;
    const on = drafts.mode === "enabled";
    await drafts.disable(true);
    if (on) await drafts.enable();
    await login.reset();
  }

  // ---------------------------------------------------------------------------
  // 上部バー：スクロールで詰める・メニュー（docs/knowledge/product/app-shell.md）

  let menuOpen = $state(false);
  let compact = $state(false);
  let menuToggle: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLElement | undefined = $state();
  let barEl: HTMLElement | undefined = $state();
  let help: { show: (from?: HTMLElement | null) => void } | undefined = $state();
  /** メニューを出せるか（ログインの前は出さない。ヘルプはボタンで出す） */
  const menuAvailable = $derived(supported && !gated);

  const sectionLabel = $derived(
    section === "changes" ? "Git と同期" : section === "settings" ? "設定" : pane === "editor" ? "記事・編集" : "記事",
  );

  function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) queueMicrotask(() => menuEl?.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
  }

  function closeMenu(refocus = true) {
    if (!menuOpen) return;
    menuOpen = false;
    if (refocus) menuToggle?.focus();
  }

  function pick(s: Section, p?: "list" | "editor") {
    go(s, p);
    closeMenu();
  }

  function onMenuKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  }

  function onDocPointer(e: PointerEvent) {
    if (!menuOpen) return;
    const t = e.target as Node | null;
    if (t && (menuEl?.contains(t) || menuToggle?.contains(t))) return;
    closeMenu(false);
  }

  /**
   * スクロールしたら上部バーを詰める。狭い画面はページ全体、広い画面は一覧・編集の領域がスクロールする。
   * 行き来でちらつかないよう、詰めるのは 24px より下、戻すのは 4px より上に来たとき。
   */
  function onAnyScroll(e: Event) {
    const t = e.target;
    let y: number;
    if (t === document || t === document.documentElement || t === document.body) y = scrollY;
    else if (t instanceof HTMLElement && t.closest("main")) y = t.scrollTop;
    else return;
    if (y > 24) compact = true;
    else if (y < 4) compact = false;
  }

  onMount(() => {
    document.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
    // 上部バーの高さ（固定した上部バーの下に、フォーカスした部品が隠れないようにする）
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() =>
            document.documentElement.style.setProperty("--app-bar-h", `${barEl?.offsetHeight ?? 0}px`),
          );
    if (barEl) ro?.observe(barEl);
    return () => {
      document.removeEventListener("scroll", onAnyScroll, { capture: true });
      ro?.disconnect();
    };
  });

  async function updateApp() {
    if (!(await ws.confirmLeave("新しい版に切り替える前に、未保存の編集をどうしますか。"))) return;
    pwa.apply();
  }

  async function reloadApp() {
    if (!(await ws.confirmLeave("ページを読み込み直す前に、未保存の編集をどうしますか。"))) return;
    location.reload();
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
  onpointerdown={(e) => {
    onActivity();
    onDocPointer(e);
  }}
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
<!--
  上部バー：アプリ名・いまの画面・開いている場所・メニュー（docs/knowledge/product/app-shell.md）。
  画面の上に固定し、スクロールすると詰める。画面の切り替えと場所の操作・ヘルプ・ロックはメニューにまとめる。
-->
<header class="app-bar" class:workbench class:compact bind:this={barEl} data-sticky-chrome data-testid="app-bar">
  <div class="brand">
    <h1>Kotono CMS</h1>
    {#if !workbench && !ws.root}<p class="tagline">手元のMarkdownで記事をつくる、ローカルCMS。</p>{/if}
  </div>
  {#if workbench}<p class="where" data-testid="current-section">{sectionLabel}</p>{/if}
  {#if ws.root}
    <span class="folder-name" data-testid="folder-name">{places ? "作業場所" : "作業フォルダ"}：{ws.rootName}</span>
  {/if}
  {#if menuAvailable}
    <button
      type="button"
      class="menu-toggle"
      bind:this={menuToggle}
      aria-expanded={menuOpen}
      aria-controls="app-menu"
      onclick={toggleMenu}
      data-testid="menu-toggle"><Menu /><span class="menu-label">メニュー</span></button
    >
  {/if}
  <HelpDialog bind:this={help} button={!menuAvailable} />
  {#if menuAvailable}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <nav
      id="app-menu"
      class="menu"
      aria-label="メニュー"
      hidden={!menuOpen}
      bind:this={menuEl}
      onkeydown={onMenuKeydown}
      data-testid="app-menu"
    >
      {#if workbench}
        <div class="menu-group" data-testid="app-nav">
          <p class="menu-title">画面</p>
          <!-- 広い画面：一覧と編集は同じ画面に並ぶので「記事」1つ。狭い画面：「一覧」「編集」に分ける -->
          <button
            type="button"
            class="wide-only"
            aria-current={section === "articles" ? "page" : undefined}
            onclick={() => pick("articles")}
            data-testid="nav-articles"><FileText />記事</button
          >
          <button
            type="button"
            class="narrow-only"
            aria-current={section === "articles" && pane === "list" ? "page" : undefined}
            onclick={() => pick("articles", "list")}
            data-testid="nav-list"><List />一覧</button
          >
          <button
            type="button"
            class="narrow-only"
            aria-current={section === "articles" && pane === "editor" ? "page" : undefined}
            onclick={() => pick("articles", "editor")}
            disabled={!ws.session}
            data-testid="nav-editor"><PenLine />編集</button
          >
          <button
            type="button"
            aria-current={section === "changes" ? "page" : undefined}
            onclick={() => pick("changes")}
            data-testid="nav-changes"><GitBranch />Git と同期</button
          >
          <button
            type="button"
            aria-current={section === "settings" ? "page" : undefined}
            onclick={() => pick("settings")}
            data-testid="nav-settings"><Settings />設定</button
          >
        </div>
      {/if}
      <div class="menu-group">
        {#if workbench}<p class="menu-title">場所</p>{/if}
        {#if places}
          {#if places.current}
            <button
              type="button"
              onclick={() => {
                closeMenu();
                void places.leave();
              }}
              data-testid="place-leave"><Folders />作業場所の一覧</button
            >
          {/if}
        {:else if supported && ws.root}
          <button
            type="button"
            onclick={() => {
              closeMenu();
              void ws.chooseFolder();
            }}
            disabled={ws.busy}
            data-testid="choose-folder"><FolderOpen />別のフォルダを開く</button
          >
        {/if}
        <button
          type="button"
          onclick={() => {
            const from = menuToggle;
            closeMenu(false);
            help?.show(from);
          }}
          data-testid="help-open"><CircleQuestionMark />ヘルプ</button
        >
        {#if login.unlocked}
          <button type="button" onclick={() => lockApp()} data-testid="app-lock"><Lock />ロック</button>
        {/if}
      </div>
    </nav>
  {/if}
</header>

<main id="main" tabindex="-1" class:wide={ws.root !== null} class:workbench>
  {#if gated}
    <!-- 起動時のログイン（ADR-0011）：何よりも先に、パスキーの登録・認証を求める -->
    {#if login.phase !== "loading"}<LoginScreen {login} onreset={resetLogin} />{/if}
  {:else}
    {#if login.info && !workbench}<p class="banner info" role="status" data-testid="login-info">{login.info}</p>{/if}
    {#if places && ws.root === null && (places.ready || places.error || places.storageError)}
      <PlacesPanel {places} {ws} />
    {/if}
  {/if}
  {#if !supported || (ws.root === null && !gated)}
    {#if !places}<section aria-labelledby="start-heading" class="card">
        <h2 id="start-heading">はじめに</h2>
        {#if supported}
          <p>
            記事を保存しているリポジトリのフォルダ（<code>content/articles/</code>
            を含むフォルダ）を選んでください。<HelpTip label="フォルダの選択"
              >フォルダへのアクセスはこのタブを閉じるまで有効です。開いたフォルダは次回すぐ開けるようこのブラウザ内に記憶します（フォルダ名とアクセス用の情報だけで、記事の内容は保存しません）。開くときにブラウザがアクセスの許可を求めることがあります。</HelpTip
            >
          </p>
          <div class="recent">
            <button
              type="button"
              class={ws.recent ? "" : "primary"}
              onclick={() => ws.chooseFolder()}
              disabled={ws.busy}
              data-testid="choose-folder"><FolderOpen />フォルダを選択</button
            >
          </div>
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
          {#if supported}<DraftSettings {ws} dc={drafts} {login} variant="page" />{/if}
          {#if supported && login.record}<LoginSettings {login} />{/if}
          {#if places?.current}<PlaceBar {places} {ws} {git} meta={places.current} part="settings" />{/if}
        </div>
      </div>
    {/if}
  {/if}
</main>

{#if !workbench}
  <footer class="app-footer" class:wide={ws.root !== null}>
    {#if supported && !gated}<DraftSettings {ws} dc={drafts} {login} />{/if}
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
    background: var(--color-bg-surface);
    padding: var(--space-8) var(--space-12);
    border: 2px solid var(--color-focus-ring);
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

  /*
   * ---- 上部バー ----
   * 画面の上に固定する（sticky）。スクロールすると上下の余白と文字を詰め、説明文と場所の名前を外す。
   * 画面の切り替え・場所の操作・ヘルプ・ロックは右端の「メニュー」にまとめる（ハンバーガーメニュー）。
   */
  .app-bar {
    --gutter: max(var(--space-16), (100% - 96rem) / 2 + var(--space-16));
    position: sticky;
    top: 0;
    z-index: var(--z-raised);
    display: flex;
    align-items: center;
    gap: var(--space-4) var(--space-12);
    padding: var(--space-8) var(--gutter);
    background: var(--color-bg-surface);
    border-bottom: 1px solid var(--color-border-subtle);
    margin-bottom: var(--space-12);
    transition: padding var(--duration-fast) var(--easing-standard);
  }
  .brand {
    min-width: 0;
    flex: 0 1 auto;
  }
  h1 {
    margin: 0;
    font-size: var(--font-size-24);
    letter-spacing: 0.01em;
    white-space: nowrap;
  }
  .app-bar.workbench {
    padding-block: var(--space-4);
    margin-bottom: 0;
  }
  .app-bar.workbench h1 {
    font-size: var(--font-size-18);
  }
  .app-bar.compact {
    padding-block: var(--space-2);
    box-shadow: var(--shadow-1);
  }
  .app-bar.compact h1 {
    font-size: var(--font-size-16);
  }
  .tagline {
    margin: 0;
    color: var(--color-fg-muted);
    font-size: var(--font-size-14);
  }
  .compact .tagline {
    display: none;
  }
  /* いまの画面の名前（メニューを開かなくても、どこにいるか分かるように） */
  .where {
    margin: 0;
    padding-inline-start: var(--space-12);
    border-inline-start: 1px solid var(--color-border-subtle);
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-strong);
    color: var(--color-accent-text);
    white-space: nowrap;
  }
  .folder-name {
    margin-inline-start: auto;
    min-width: 0;
    font-size: var(--font-size-14);
    color: var(--color-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .menu-toggle {
    margin-inline-start: auto;
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-14);
    padding: var(--control-pad-y-sm) var(--control-pad-x-sm);
  }
  .folder-name + .menu-toggle {
    margin-inline-start: 0;
  }
  .app-bar > :global(.help-open) {
    margin-inline-start: auto;
    font-size: var(--font-size-14);
    padding: var(--control-pad-y-sm) var(--control-pad-x-sm);
  }
  /* メニューの開閉は画面の端で頻繁に押すので、指の画面では 44px（Apple HIG）にする */
  @media (pointer: coarse) {
    .menu-toggle {
      min-height: var(--touch-target);
      min-width: var(--touch-target);
    }
  }

  /* メニュー：上部バーの右端の下に重ねる。選んでいる画面は文字の太さと左の線で示す（色だけに頼らない：14.1） */
  .menu {
    position: absolute;
    top: calc(100% + var(--space-4));
    right: var(--gutter);
    z-index: var(--z-popover);
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    min-width: 14rem;
    max-width: calc(100vw - 2 * var(--space-16));
    max-height: calc(100dvh - var(--app-bar-h, 3rem) - var(--space-16));
    overflow: auto;
    padding: var(--space-8);
    background: var(--color-bg-raised);
    border: 1px solid var(--color-border-control);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
  }
  .menu[hidden] {
    display: none;
  }
  .menu-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .menu-group + .menu-group {
    border-top: 1px solid var(--color-border-subtle);
    padding-top: var(--space-8);
  }
  .menu-title {
    margin: 0 0 var(--space-2);
    padding-inline: var(--space-8);
    font-size: var(--font-size-12);
    color: var(--color-fg-muted);
  }
  .menu button {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    text-align: start;
    border-color: transparent;
    background: transparent;
    padding: var(--control-pad-y) var(--space-8);
    white-space: nowrap;
  }
  .menu button:not(:disabled):hover {
    background: var(--color-bg-hover);
  }
  .menu button:disabled {
    background: transparent;
  }
  .menu button[aria-current="page"] {
    color: var(--color-accent-text);
    background: var(--color-accent-subtle);
    font-weight: var(--font-weight-strong);
    box-shadow: inset var(--focus-ring-width) 0 0 var(--color-accent);
  }
  /* メニューの項目は指の画面で 44px（Apple HIG：頻繁に押す移動） */
  @media (pointer: coarse) {
    .menu button {
      min-height: var(--touch-target);
    }
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
    border: 1px solid var(--color-border-subtle);
    border-inline-start: 3px solid var(--color-border-control);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-12);
    background: var(--color-bg-surface);
  }
  .git-strip[data-kind="ok"] {
    border-inline-start-color: var(--color-success-border);
    background: var(--color-success-bg);
  }
  .git-strip[data-kind="error"] {
    border-color: var(--color-danger-border);
    background: var(--color-danger-bg);
  }
  .git-strip[data-kind="warn"] {
    border-color: var(--color-warning-border);
    background: var(--color-warning-bg);
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
  .env-details summary {
    cursor: pointer;
    font-size: var(--font-size-14);
    color: var(--color-fg-muted);
    min-height: 1.5rem;
  }
  @media (pointer: coarse) {
    .env-details summary {
      min-height: var(--touch-target-sm);
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
  /* 確認した項目：行と列の罫線を引いた表にする */
  .capabilities {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .capabilities li {
    display: grid;
    grid-template-columns: 2rem 1fr auto;
    border-top: 1px solid var(--color-border-subtle);
  }
  .capabilities li > * {
    padding: var(--space-4) var(--space-8);
  }
  .capabilities li > :not(:first-child, .impact) {
    border-inline-start: 1px solid var(--color-border-subtle);
  }
  .capabilities .mark {
    text-align: center;
  }
  .capabilities .impact {
    border-top: 1px dashed var(--color-border-subtle);
  }
  .capabilities li:first-child {
    border-top: none;
  }
  .mark {
    font-weight: 700;
  }
  li[data-ok="true"] .mark {
    color: var(--color-success-fg);
  }
  li[data-ok="false"] .mark {
    color: var(--color-danger-fg);
  }
  .state {
    color: var(--color-fg-muted);
    font-size: var(--font-size-14);
  }
  .impact {
    grid-column: 2 / -1;
    font-size: var(--font-size-14);
    color: var(--color-fg-muted);
  }
  .probe {
    margin: var(--space-12) 0 0;
    font-size: var(--font-size-14);
    color: var(--color-fg-muted);
  }
  .banner {
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin: 0 0 var(--space-8);
    background: var(--color-danger-bg);
  }
  .banner p {
    margin: 0;
  }
  .banner.info {
    border-color: var(--color-info-border);
    background: var(--color-info-bg);
    max-width: 36rem;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(18rem, 26rem) minmax(0, 1fr);
    gap: var(--space-16);
    align-items: start;
  }

  /*
   * 狭い画面（60rem 以下：iPad の縦・iPhone を含む）：ページ全体を1つのスクロールにし、
   * メニューの画面に「一覧｜編集｜Git と同期｜設定」を並べる。一覧と編集は1度に1つだけ出す（14.1）。
   * 固定した上部バーの下に、フォーカスした部品・見出しが隠れないようにする。
   */
  @media (max-width: 60rem) {
    :global(html) {
      scroll-padding-top: calc(var(--app-bar-h, 0px) + var(--space-8));
    }
    .wide-only {
      display: none !important;
    }
    .narrow-only {
      display: flex !important;
    }
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }
    .panes[data-pane="list"] .editor-pane,
    .panes[data-pane="editor"] .list-pane {
      display: none;
    }
  }
  /* とても狭い画面（iPhone の縦）：場所の名前は外し（メニューと画面の中にある）、メニューの文字は残す */
  @media (max-width: 30rem) {
    .folder-name {
      display: none;
    }
    .folder-name + .menu-toggle {
      margin-inline-start: auto;
    }
    .where {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
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
      border-inline-end: 1px solid var(--color-border-subtle);
      padding-inline-end: var(--space-8);
    }
    main.workbench .editor-pane {
      padding-inline-start: var(--space-12);
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
    color: var(--color-fg-muted);
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
