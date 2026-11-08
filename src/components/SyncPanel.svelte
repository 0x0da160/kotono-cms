<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import type { SyncController } from "../lib/app/sync.svelte";
  import { PAT_EXPIRES_DAYS, parseRepoInput, patCreationUrl } from "../lib/sync/github-api";
  import type { ConflictItem } from "../lib/sync/sync";

  let { sync }: { sync: SyncController } = $props();

  let editing = $state(false);
  let repoInput = $state("");
  let branch = $state("main");
  let token = $state("");
  let save = $state(true);
  let shown = $state<Record<string, { base: string | null; local: string | null; remote: string | null } | null>>({});

  const statusText = $derived.by(() => {
    const s = sync.status;
    if (!s) return null;
    switch (s.kind) {
      case "up-to-date":
        return "GitHub と同じです。";
      case "ahead":
        return `送っていないコミットが ${s.count} 件あります。`;
      case "behind":
        return "GitHub に新しいコミットがあります。";
      case "diverged":
        return "手元と GitHub の両方に新しいコミットがあります（取得して合わせます）。";
      case "remote-empty":
        return "GitHub のリポジトリ（ブランチ）が空です。";
      case "local-empty":
        return "手元にまだコミットがありません。取得できます。";
    }
    return null;
  });

  /** 入力中のリポジトリ（作り方の案内とリンクに使う） */
  const typedRepo = $derived(parseRepoInput(repoInput));
  const patUrl = $derived(patCreationUrl(typedRepo));

  const undecided = $derived(
    sync.merge ? sync.merge.plan.conflicts.filter((c) => !sync.merge?.choices[c.path]).length : 0,
  );

  function startEdit() {
    repoInput = sync.target ? `${sync.target.owner}/${sync.target.repo}` : "";
    branch = sync.target?.branch ?? "main";
    token = "";
    editing = true;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (await sync.configure(repoInput, branch, token, save)) {
      token = "";
      editing = false;
    }
  }

  async function show(c: ConflictItem) {
    shown = { ...shown, [c.path]: shown[c.path] ? null : await sync.versions(c.path) };
  }
</script>

<section class="sync" aria-labelledby="sync-heading" data-testid="sync-panel">
  <h3 id="sync-heading">GitHub との同期</h3>
  {#if sync.notice}
    <p
      class="notice"
      data-kind={sync.notice.kind}
      role={sync.notice.kind === "error" ? "alert" : "status"}
      data-testid="sync-notice"
    >
      {sync.notice.text}
    </p>
  {/if}

  {#if !editing && sync.target}
    <p class="small">
      同期先：<span class="mono">{sync.target.owner}/{sync.target.repo}</span>（ブランチ {sync.target.branch}）
      {#if sync.hasToken}・トークン{sync.tokenSaved
          ? "は暗号化して保存済み"
          : "はこのタブを閉じるまで保持"}{:else}・トークン未入力{/if}
    </p>
    {#if statusText}<p class="small" data-testid="sync-status">{statusText}</p>{/if}
    <div class="actions">
      <button
        type="button"
        onclick={() => sync.pull()}
        disabled={sync.busy || !sync.hasToken || sync.merge !== null}
        data-testid="sync-pull">取得（pull）</button
      >
      <button
        type="button"
        class="primary"
        onclick={() => sync.push()}
        disabled={sync.busy || !sync.hasToken || sync.merge !== null}
        data-testid="sync-push">送る（push）</button
      >
      <button type="button" onclick={() => sync.check()} disabled={sync.busy || !sync.hasToken}>状態を確認</button>
      <button type="button" onclick={startEdit}>設定</button>
    </div>
    {#if sync.busy}<p class="small muted" role="status">GitHub と通信しています…</p>{/if}
    {#if sync.rateRemaining !== null && sync.rateRemaining < 500}
      <p class="small muted">GitHub の残りの回数：{sync.rateRemaining}（1 時間ごとに戻ります）</p>
    {/if}
  {:else}
    <form onsubmit={submit} class="config" data-testid="sync-config">
      <label
        >リポジトリ（所有者/名前 または URL）<input
          bind:value={repoInput}
          required
          autocapitalize="off"
          spellcheck="false"
          data-testid="sync-repo"
        /></label
      >
      <label>ブランチ <input bind:value={branch} required autocapitalize="off" spellcheck="false" /></label>
      <div class="field">
        <span class="lab"
          ><label for="sync-token">トークン（fine-grained personal access token）</label><HelpTip label="トークンとは"
            >GitHub
            のアカウントの代わりに、このリポジトリの中身の読み書きだけを許す鍵です。パスワードは使いません。通信先は
            api.github.com だけです。</HelpTip
          ></span
        >
        <details class="howto" open={!sync.hasToken} data-testid="sync-pat-howto">
          <summary>トークンの作り方（2 分ほど）</summary>
          <ol>
            <li>
              <a href={patUrl} target="_blank" rel="noopener noreferrer" data-testid="sync-pat-link"
                >GitHub のトークン作成ページを開く</a
              >（名前・有効期限 {PAT_EXPIRES_DAYS} 日・「Contents」の読み書きは入力済みで開きます）
            </li>
            <li>
              「Repository access」で「Only select repositories」を選び、<span class="mono"
                >{typedRepo ? `${typedRepo.owner}/${typedRepo.repo}` : "同期するリポジトリ"}</span
              >だけを選びます。
            </li>
            <li>
              「Permissions」の「Contents」が「Read and write」になっていることを確かめます（他の権限は要りません）。
            </li>
            <li>
              「Generate token」を押し、表示された <span class="mono">github_pat_</span>
              で始まる文字列をコピーして、下の欄に貼り付けます。
            </li>
          </ol>
          <p class="small muted">
            トークンは作った直後にしか表示されません。期限が切れたら同じ手順で作り直し、ここに貼り直してください。
          </p>
        </details>
        <input
          id="sync-token"
          type="password"
          bind:value={token}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-testid="sync-token"
        />
      </div>
      {#if sync.canSaveToken}
        <label class="check"
          ><input type="checkbox" bind:checked={save} /> トークンを作業場所の鍵で暗号化して保存する</label
        >
      {:else}
        <p class="small muted">トークンは保存しません。このタブを閉じるまでだけ使います。</p>
      {/if}
      <div class="actions">
        <button type="submit" class="primary" data-testid="sync-save">設定する</button>
        {#if sync.target}<button type="button" onclick={() => (editing = false)}>キャンセル</button>{/if}
        {#if sync.hasToken}<button type="button" class="danger" onclick={() => sync.forgetToken()}
            >トークンを消す</button
          >{/if}
      </div>
    </form>
  {/if}

  {#if sync.merge}
    {@const m = sync.merge}
    <div class="merge" data-testid="sync-merge">
      <h4>手元と GitHub を合わせる</h4>
      <p class="small">
        自動で決まったファイル {m.plan.resolved.size} 件{m.plan.mergedBlobs.size > 0
          ? `（うち記事の行単位の自動マージ ${m.plan.mergedBlobs.size} 件）`
          : ""}。
        {#if m.plan.conflicts.length > 0}残り {m.plan.conflicts.length} 件は選んでください。どちらかを採った後で、記事を編集してコミットし直せます。{/if}
      </p>
      <ul class="conflicts">
        {#each m.plan.conflicts as c (c.path)}
          <li data-testid="sync-conflict">
            <span class="mono path">{c.path}</span>
            <span class="small muted">{c.reason}</span>
            <div class="actions" role="radiogroup" aria-label="{c.path} の扱い">
              <label
                ><input
                  type="radio"
                  name={c.path}
                  checked={m.choices[c.path] === "local"}
                  onchange={() => sync.choose(c.path, "local")}
                />
                手元を採る{c.local ? "" : "（削除）"}</label
              >
              <label
                ><input
                  type="radio"
                  name={c.path}
                  checked={m.choices[c.path] === "remote"}
                  onchange={() => sync.choose(c.path, "remote")}
                />
                GitHub を採る{c.remote ? "" : "（削除）"}</label
              >
              <button type="button" onclick={() => show(c)} aria-expanded={shown[c.path] != null}>3 版を見る</button>
            </div>
            {#if shown[c.path]}
              {@const v = shown[c.path]}
              <div class="versions">
                {#each [["祖先", v?.base], ["手元", v?.local], ["GitHub", v?.remote]] as [label, text] (label)}
                  <details open={label !== "祖先"}>
                    <summary>{label}</summary>
                    <pre>{text ?? "（なし・文字として読めない）"}</pre>
                  </details>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="actions">
        <button
          type="button"
          class="primary"
          disabled={sync.busy || undecided > 0}
          onclick={() => sync.completeMerge()}
          data-testid="sync-merge-run">合わせて送る{undecided > 0 ? `（未選択 ${undecided} 件）` : ""}</button
        >
        <button type="button" onclick={() => sync.abortMerge()} disabled={sync.busy}>中止</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .sync {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-12);
    margin-top: var(--space-12);
    background: var(--color-surface);
  }
  h3 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-16);
  }
  h4 {
    margin: var(--space-12) 0 var(--space-4);
    font-size: var(--font-size-15);
  }
  .notice {
    font-size: var(--font-size-14);
    border-inline-start: 3px solid var(--color-border);
    padding-inline-start: var(--space-8);
    margin: 0 0 var(--space-8);
  }
  .notice[data-kind="error"],
  .notice[data-kind="warn"] {
    border-color: var(--color-ng);
  }
  .notice[data-kind="ok"] {
    border-color: var(--color-ok);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    align-items: center;
    margin-block: var(--space-6);
  }
  .config label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: var(--font-size-14);
    margin-block: var(--space-6);
  }
  .config .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: var(--font-size-14);
    margin-block: var(--space-6);
  }
  .config .lab {
    display: flex;
    align-items: center;
  }
  .config .lab label {
    margin: 0;
  }
  .howto {
    font-size: var(--font-size-14);
    margin-block: var(--space-4);
  }
  .howto summary {
    cursor: pointer;
  }
  .howto ol {
    margin: var(--space-6) 0;
    padding-inline-start: var(--space-20);
  }
  .howto li {
    margin-block: var(--space-4);
  }
  .config label.check {
    flex-direction: row;
    align-items: center;
  }
  input:not([type="checkbox"]):not([type="radio"]) {
    font: inherit;
    font-size: var(--font-size-16);
    line-height: var(--control-line-height);
    padding: var(--control-pad-y) var(--space-8);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
  }
  .conflicts {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .conflicts li {
    border-top: 1px solid var(--color-border);
    padding-block: var(--space-8);
  }
  .path {
    display: block;
    overflow-wrap: anywhere;
    font-size: var(--font-size-13);
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--font-size-12);
    max-height: 16rem;
    overflow: auto;
    margin: var(--space-4) 0;
  }
  .small {
    font-size: var(--font-size-13);
  }
</style>
