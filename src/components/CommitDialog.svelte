<script lang="ts">
  import type { GitController } from "../lib/app/git.svelte";
  import { checkIdentity, checkMessage } from "../lib/git/model";

  let { git }: { git: GitController } = $props();
  let el: HTMLDialogElement | undefined = $state();
  let returnFocus: Element | null = null;
  const req = $derived(git.commitDialog);

  const msgErr = $derived(req ? checkMessage(req.message) : null);
  const idErr = $derived(req ? checkIdentity(req.name, req.email) : null);
  const label: Record<string, string> = { added: "追加", modified: "変更", deleted: "削除" };

  $effect(() => {
    const d = el;
    if (!d) return;
    if (req && !d.open) {
      returnFocus = document.activeElement;
      d.showModal();
      d.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else if (!req && d.open) d.close();
  });

  function finish(ok: boolean) {
    const r = req;
    el?.close();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
    r?.resolve(ok);
  }
</script>

<dialog
  bind:this={el}
  oncancel={(e) => {
    e.preventDefault();
    finish(false);
  }}
  aria-labelledby="commit-title"
  class="dialog"
  data-testid="commit-dialog"
>
  {#if req}
    <h2 id="commit-title">記事をコミットします</h2>
    <p class="small">
      ブランチ <strong data-testid="commit-branch">{req.branch}</strong> に、「{req.title}」（{req.plan
        .articleId}）の記事フォルダの変更だけをコミットします。他の記事・設定・記事外のファイルは含めません。
    </p>
    <h3>対象ファイル（{req.plan.targets.length} 件）</h3>
    <ul class="files" data-testid="commit-files">
      {#each req.plan.targets as t (t.path)}
        <li><span class="kind" data-kind={t.change}>{label[t.change]}</span> <code>{t.path}</code></li>
      {/each}
    </ul>
    {#if req.plan.ignored.length > 0}
      <details>
        <summary>無視対象（{req.plan.ignored.length} 件、コミットしません）</summary>
        <ul class="files">
          {#each req.plan.ignored as p (p)}<li><code>{p}</code>（.gitignore 等で無視）</li>{/each}
        </ul>
      </details>
    {/if}
    <label class="field">
      <span>コミットメッセージ（必須）</span>
      <textarea rows="3" bind:value={req.message} data-testid="commit-message" aria-invalid={msgErr !== null}
      ></textarea>
    </label>
    {#if msgErr}<p class="err small" role="alert">{msgErr}</p>{/if}
    <fieldset>
      <legend>作者とコミッター（同じ値を使います）</legend>
      {#if req.identityFromConfig}
        <p class="small muted">このリポジトリの設定（.git/config の user.name・user.email）から読み込みました。</p>
      {:else}
        <p class="small muted">
          このリポジトリには作者が設定されていません。OS
          のグローバル設定は参照しません。今回だけ使う値を入力してください。
        </p>
      {/if}
      <label class="field"><span>名前</span><input type="text" bind:value={req.name} data-testid="commit-name" /></label
      >
      <label class="field"
        ><span>メールアドレス</span><input type="text" bind:value={req.email} data-testid="commit-email" /></label
      >
      {#if !req.identityFromConfig}
        <label class="check"
          ><input type="checkbox" bind:checked={req.saveIdentity} /> リポジトリの設定にも保存する（保存前に確認します）</label
        >
      {/if}
      {#if idErr}<p class="err small" role="alert">{idErr}</p>{/if}
    </fieldset>
    <div class="buttons">
      <button type="button" onclick={() => finish(false)} data-testid="commit-cancel">キャンセル</button>
      <button
        type="button"
        class="primary"
        onclick={() => finish(true)}
        disabled={msgErr !== null || idErr !== null}
        data-testid="commit-confirm">コミットする</button
      >
    </div>
  {/if}
</dialog>

<style>
  .dialog {
    max-width: min(40rem, calc(100vw - 2rem));
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    padding: 1.25rem;
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.125rem;
  }
  h3 {
    margin: 0.75rem 0 0.25rem;
    font-size: 1rem;
  }
  .files {
    margin: 0 0 0.5rem;
    padding-inline-start: 1.25rem;
    font-size: 0.875rem;
    max-height: 12rem;
    overflow: auto;
  }
  .kind {
    font-weight: 600;
  }
  .kind[data-kind="deleted"] {
    color: var(--ng);
  }
  .field {
    display: grid;
    gap: 0.25rem;
    margin-block: 0.5rem;
  }
  textarea,
  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 0.75rem 0;
  }
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.875rem;
  }
  .err {
    color: var(--ng);
    margin: 0.25rem 0;
  }
  .small {
    font-size: 0.875rem;
  }
  .muted {
    color: var(--muted);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
  }
</style>
