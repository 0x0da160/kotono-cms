<script lang="ts">
  import type { SyncController } from "../lib/app/sync.svelte";
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
      <label
        >トークン（fine-grained personal access token）
        <input
          type="password"
          bind:value={token}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-testid="sync-token"
        /></label
      >
      <p class="small muted">
        GitHub の Settings → Developer settings → Fine-grained tokens で、このリポジトリだけを選び、「Contents」を Read
        and write、有効期限つきで作ってください。通信先は api.github.com だけです。
      </p>
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
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    margin-top: 1rem;
    background: var(--surface);
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  h4 {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.9375rem;
  }
  .notice {
    font-size: 0.875rem;
    border-inline-start: 3px solid var(--border);
    padding-inline-start: 0.5rem;
    margin: 0 0 0.5rem;
  }
  .notice[data-kind="error"],
  .notice[data-kind="warn"] {
    border-color: var(--ng);
  }
  .notice[data-kind="ok"] {
    border-color: var(--ok);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin-block: 0.375rem;
  }
  .config label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    margin-block: 0.375rem;
  }
  .config label.check {
    flex-direction: row;
    align-items: center;
  }
  input:not([type="checkbox"]):not([type="radio"]) {
    font: inherit;
    font-size: 1rem;
    padding: 0.375rem 0.5rem;
    min-height: 2.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }
  .conflicts {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .conflicts li {
    border-top: 1px solid var(--border);
    padding-block: 0.5rem;
  }
  .path {
    display: block;
    overflow-wrap: anywhere;
    font-size: 0.8125rem;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
    max-height: 16rem;
    overflow: auto;
    margin: 0.25rem 0;
  }
  .small {
    font-size: 0.8125rem;
  }
</style>
