<script lang="ts">
  import type { GitController } from "../lib/app/git.svelte";
  import { checkIdentity, checkMessage } from "../lib/git/model";
  import { focusReturn } from "../lib/ui/focus-return";

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
      returnFocus = focusReturn.capture();
      d.showModal();
      d.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else if (!req && d.open) d.close();
  });

  function finish(ok: boolean) {
    const r = req;
    el?.close();
    // 「コミット…」はコミット画面の間無効になる。有効に戻ったらフォーカスを戻す
    focusReturn.restore(returnFocus);
    returnFocus = null;
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
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-text);
    padding: var(--space-16);
  }
  .dialog::backdrop {
    background: var(--color-overlay);
  }
  h2 {
    margin: 0 0 var(--space-8);
    font-size: var(--font-size-18);
  }
  h3 {
    margin: var(--space-12) 0 var(--space-4);
    font-size: var(--font-size-16);
  }
  .files {
    margin: 0 0 var(--space-8);
    padding-inline-start: var(--space-20);
    font-size: var(--font-size-14);
    max-height: 12rem;
    overflow: auto;
  }
  .kind {
    font-weight: var(--font-weight-strong);
  }
  .kind[data-kind="deleted"] {
    color: var(--color-ng);
  }
  .field {
    display: grid;
    gap: var(--space-4);
    margin-block: var(--space-8);
  }
  textarea,
  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
  }
  fieldset {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    margin: var(--space-12) 0;
  }
  .check {
    display: flex;
    gap: var(--space-8);
    align-items: center;
    font-size: var(--font-size-14);
  }
  .err {
    color: var(--color-ng);
    margin: var(--space-4) 0;
  }
  .small {
    font-size: var(--font-size-14);
  }
  .muted {
    color: var(--color-muted);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    justify-content: flex-end;
  }
</style>
