<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import { commitDate, UNOBSERVABLE_NOTE, type GitController } from "../lib/app/git.svelte";
  import type { Workspace } from "../lib/app/workspace.svelte";
  import { tick } from "svelte";
  import { stagedChange, unstagedChange, type FileState } from "../lib/git/repo";

  let { ws, git }: { ws: Workspace; git: GitController } = $props();

  // 操作の結果が画面の外にあれば、見える位置へ移す（段階4 1章：パネルの通知はパネルの先頭。行からコミットした後など）
  let noticeEl: HTMLElement | undefined = $state();
  $effect(() => {
    if (!git.notice) return;
    void tick().then(() => noticeEl?.scrollIntoView({ block: "nearest" }));
  });

  let showIgnored = $state(false);
  const repo = $derived(git.repo);
  const changed = $derived(
    Object.values(git.statuses ?? {})
      .filter((s) => s.state !== "clean")
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  const ignored = $derived(
    Object.values(git.statuses ?? {}).flatMap((s) => s.files.filter((f) => f.ignored).map((f) => f.path)),
  );
  const stateLabel: Record<string, string> = {
    changed: "未コミットの変更",
    untracked: "未追跡（新規）",
    deleted: "削除（未コミット）",
    conflict: "競合",
    unknown: "状態不明",
  };
  function fileLabel(f: FileState): string {
    if (f.conflict) return "競合";
    const st = stagedChange(f);
    const un = unstagedChange(f);
    const parts: string[] = [];
    if (st) parts.push(`ステージ済み（${st === "added" ? "追加" : st === "deleted" ? "削除" : "変更"}）`);
    if (un === "untracked") parts.push("未追跡");
    else if (un) parts.push(`未ステージ（${un === "deleted" ? "削除" : "変更"}）`);
    return parts.join("・");
  }
  const loadedAt = $derived(git.loadedAt ? new Date(git.loadedAt).toLocaleTimeString("ja-JP") : null);
  const currentId = $derived(ws.session && !ws.session.isNew ? ws.session.id : null);
</script>

<section class="git card" aria-labelledby="git-heading" data-testid="git-panel">
  <div class="head">
    <h2>
      <span id="git-heading">Git</span><HelpTip label="Git"
        ><span class="tip-p"
          >Git の状態は自動では監視しません。外部で変更したときは「Git 状態を再読み込み」を押してください。</span
        ><span class="tip-p">{UNOBSERVABLE_NOTE}</span></HelpTip
      >
    </h2>
    <button type="button" onclick={() => git.refresh()} disabled={git.loading || git.busy} data-testid="git-refresh"
      >Git 状態を再読み込み</button
    >
  </div>
  <p class="small muted" role="status">
    {#if git.loading}
      Git の状態を取得しています…
    {:else if loadedAt}
      最終読み込み：{loadedAt}
    {:else}
      未取得
    {/if}
  </p>
  {#if git.error}<p class="err small" role="alert">{git.error}</p>{/if}
  <!-- 操作の結果はパネルの先頭に出す（UI刷新 段階6：変更の一覧が長いと、末尾では初期化の結果が見えない） -->
  {#if git.notice}
    <div
      bind:this={noticeEl}
      class="notice"
      data-kind={git.notice.kind}
      role={git.notice.kind === "error" ? "alert" : "status"}
      data-testid="git-notice"
    >
      <p>{git.notice.text}</p>
      {#if git.notice.details?.length}
        <ul class="small">
          {#each git.notice.details as d, i (i)}<li>{d}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if git.info?.kind === "none"}
    <p data-testid="git-none">
      Git で管理されていません。記事はこのまま編集できます。初期化すると、記事ごとにコミットして履歴を残せます。
    </p>
    <button type="button" onclick={() => git.init()} disabled={git.busy} data-testid="git-init">Git を初期化する</button
    >
  {:else if git.info?.kind === "unsupported"}
    <p class="err" data-testid="git-unsupported">{git.info.message}</p>
  {:else if repo}
    <dl class="summary">
      <dt>ブランチ</dt>
      <dd data-testid="git-branch">{repo.branch ?? "（ブランチではありません）"}</dd>
      <dt>書き込み</dt>
      <dd data-testid="git-writable">{repo.blockers.length === 0 ? "可能" : "停止中"}</dd>
      <dt>作者</dt>
      <dd>{repo.identity ? `${repo.identity.name} <${repo.identity.email}>` : "未設定（コミット時に入力）"}</dd>
    </dl>
    {#if repo.blockers.length > 0}
      <ul class="blockers" data-testid="git-blockers">
        {#each repo.blockers as b, i (i)}<li>{b.message}</li>{/each}
      </ul>
      <p class="small muted">
        記事の編集・保存は Git 書き込みとは別に判定しています。外部の Git で状態を解消してから再読み込みしてください。
      </p>
    {/if}
    {#each repo.notes as n, i (i)}<p class="small muted">{n}</p>{/each}

    {#if git.staged.length > 0}
      <h3>開始前からステージされている変更（{git.staged.length} 件）</h3>
      <p class="small">CMS は既存のステージを解除しません。この状態ではコミットできません。</p>
      <ul class="files">
        {#each git.staged.slice(0, 50) as p (p)}<li><code>{p}</code></li>{/each}
      </ul>
      {#if git.staged.length > 50}<p class="small muted">ほか {git.staged.length - 50} 件</p>{/if}
    {/if}

    <h3>記事フォルダの変更（{changed.length} 記事）</h3>
    {#if changed.length === 0}
      <p class="small muted">
        記事フォルダに未コミットの変更はありません（記事フォルダ外の未ステージの変更は表示しません）。
      </p>
    {:else}
      <ul class="articles" data-testid="git-changes">
        {#each changed.slice(0, 100) as st (st.id)}
          <li data-article={st.id}>
            <div class="row">
              <span><code>{st.id}</code>：{stateLabel[st.state] ?? st.state}</span>
              {#if st.state !== "conflict" && st.state !== "unknown"}
                <button
                  type="button"
                  onclick={() => git.commitArticle(st.id)}
                  disabled={git.busy || ws.busy || repo.blockers.length > 0 || git.staged.length > 0}
                  data-testid="git-commit-article">この記事をコミット</button
                >
              {/if}
            </div>
            {#if st.unsupported}<p class="err small">{st.unsupported}</p>{/if}
            <details>
              <summary class="small"
                >ファイル（{st.files.filter((f) => !f.ignored && fileLabel(f) !== "").length}）</summary
              >
              <ul class="files">
                {#each st.files.filter((f) => !f.ignored) as f (f.path)}
                  {#if fileLabel(f) !== ""}<li><code>{f.path}</code>：{fileLabel(f)}</li>{/if}
                {/each}
              </ul>
            </details>
          </li>
        {/each}
      </ul>
      {#if changed.length > 100}<p class="small muted">ほか {changed.length - 100} 記事</p>{/if}
    {/if}
    {#if ignored.length > 0}
      <button type="button" class="link" onclick={() => (showIgnored = !showIgnored)} aria-expanded={showIgnored}
        >無視対象（{ignored.length} 件）を{showIgnored ? "隠す" : "表示"}</button
      >
      {#if showIgnored}
        <ul class="files">
          {#each ignored.slice(0, 200) as p (p)}<li><code>{p}</code></li>{/each}
        </ul>
      {/if}
    {/if}

    {#if git.pending}
      <div class="pending" role="alert">
        {#if git.pending.kind === "staged"}
          <p>前回のコミットはステージまで完了しています（{git.pending.plan.articleId}）。</p>
          <button
            type="button"
            class="primary"
            onclick={() => git.resolvePending()}
            disabled={git.busy}
            data-testid="git-retry">状態を照合して再試行</button
          >
        {:else}
          <p>前回のコミットの結果が不明です（{git.pending.commitOid.slice(0, 7)}）。</p>
          <button type="button" class="primary" onclick={() => git.resolvePending()} disabled={git.busy}
            >結果を照合</button
          >
        {/if}
      </div>
    {/if}

    <h3>履歴</h3>
    <div class="row actions">
      <button
        type="button"
        onclick={() => git.loadHistory("repo")}
        disabled={git.history?.loading}
        data-testid="git-history-repo">リポジトリ全体</button
      >
      <button
        type="button"
        onclick={() => git.loadHistory("article", currentId)}
        disabled={!currentId || git.history?.loading}
        data-testid="git-history-article">開いている記事</button
      >
    </div>
    {#if git.history}
      {@const h = git.history}
      <p class="small muted">
        {h.scope === "repo" ? "リポジトリ全体" : `記事 ${h.articleId}（現在の ID のパスのみ）`}：{h.items.length} 件表示
      </p>
      <ol class="history" data-testid="git-history">
        {#each h.items as c (c.oid)}
          <li>
            <code title={c.oid}>{c.oid.slice(0, 7)}</code>
            <span class="date">{commitDate(c)}</span>
            <span class="who">{c.commit.author?.name ?? "（作者不明）"}</span>
            <span class="msg">{c.commit.message.split("\n")[0]}</span>
          </li>
        {/each}
      </ol>
      {#if h.loading}
        <p class="small" role="status">
          調査中… <button type="button" onclick={() => git.cancelHistory()}>中止</button>
        </p>
      {:else if h.error}
        <p class="err small">{h.error}</p>
      {:else if h.cursor}
        <p class="small muted">
          {h.partial ? `${h.partial}未調査の履歴があります。` : "続きがあります。"}
        </p>
        <button type="button" onclick={() => git.moreHistory()} data-testid="git-history-more"
          >{h.partial ? "続きを調査" : "さらに50件"}</button
        >
      {:else if h.items.length === 0 && !h.truncated}
        <p class="small muted">コミットはありません。</p>
      {/if}
      {#if h.truncated}<p class="small muted">
          親コミットが見つからないため、これより前は調べられません（shallow 等）。
        </p>{/if}
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin-block: var(--space-12);
  }
  .head,
  .row {
    display: flex;
    gap: var(--control-gap);
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: var(--font-size-18);
  }
  h3 {
    margin: var(--space-12) 0 var(--space-4);
    font-size: var(--font-size-16);
  }
  .summary {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2) var(--space-12);
    margin: var(--space-8) 0;
  }
  .summary dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .blockers {
    color: var(--color-ng);
    margin: var(--space-4) 0;
    padding-inline-start: var(--space-20);
  }
  .articles,
  .files,
  .history {
    margin: 0;
    padding-inline-start: var(--space-20);
    font-size: var(--font-size-14);
  }
  /* 記事ごとの行は罫線で区切る（方向B、一覧の行と同じ） */
  .articles {
    list-style: none;
    padding-inline-start: 0;
    border-top: 1px solid var(--color-border);
  }
  .articles > li {
    padding-block: var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }
  .history li {
    display: flex;
    gap: var(--space-8);
    flex-wrap: wrap;
  }
  .history .msg {
    overflow-wrap: anywhere;
  }
  .history .date,
  .history .who {
    color: var(--color-muted);
  }
  .pending,
  .notice {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--panel-pad-sm);
    margin-top: var(--space-12);
  }
  .notice[data-kind="error"],
  .pending {
    border-color: var(--color-ng);
  }
  .notice[data-kind="ok"] {
    border-color: var(--color-ok);
  }
  .notice p,
  .pending p {
    margin: 0 0 var(--space-4);
  }
  .err {
    color: var(--color-ng);
  }
  .small {
    font-size: var(--font-size-14);
  }
  .muted {
    color: var(--color-muted);
  }
  .link {
    background: none;
    border: none;
    padding: var(--space-2) 0;
    color: var(--color-focus);
    text-decoration: underline;
    cursor: pointer;
    font-size: var(--font-size-14);
  }
  /* 履歴の2つの操作は1つのグループ。両端に離さない（段階4 4章：グループ内は 6px） */
  .row.actions {
    justify-content: flex-start;
    gap: var(--space-6);
  }
  /* 「ファイル（n）」も 24px 以上にする（段階4 7章4、WCAG 2.5.8） */
  summary {
    padding-block: var(--space-2);
    cursor: pointer;
  }
  /* ID とパスは周りの文字と同じ大きさにする。共通の 0.9em では 14px の中で 12.6px になり、段階4 3章の段階にない */
  code {
    font-size: 1em;
  }
  /* 状態は色だけで伝えない：通知の先頭に記号を付ける（段階4 5章） */
  .notice[data-kind="ok"] > p::before {
    content: "✓ ";
  }
  .notice[data-kind="error"] > p::before {
    content: "⚠ ";
  }
  /*
   * 作業台（広い画面）：Git パネルは一覧の列にあり、画面を占め続けるので詰める（段階4 2章）。
   * 見出しは一覧の「記事」と同じ 16px。幅に応じた上書きはスタイルの末尾に置く（段階4 7章1）。
   */
  @media (min-width: 60.0625rem) {
    h2 {
      font-size: var(--font-size-16);
    }
    h3 {
      font-size: var(--font-size-14);
    }
    .summary {
      font-size: var(--font-size-14);
    }
    button:not(.link) {
      padding: var(--control-pad-y-sm) var(--control-pad-x-sm);
      font-size: var(--font-size-14);
    }
  }
</style>
