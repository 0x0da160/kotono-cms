<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import { formatForDisplay, formatLocalDateTime, publishTiming } from "../lib/core/datetime";
  import type { StandardKey } from "../lib/core/schema";
  import type { FieldValue } from "../lib/core/yaml-doc";

  let { session }: { session: EditorSession } = $props();

  const values = $derived(session.analysis.schema?.values ?? {});
  const fieldErrors = $derived(
    (session.analysis.problems ?? []).filter((p) => p.field !== undefined) as { field: StandardKey; message: string }[],
  );
  let rejected = $state<Partial<Record<StandardKey, string>>>({});
  let tagDraft = $state("");
  let composing = false;

  // 読み取り専用・削除手続き中の編集停止（11.3）ではフォーム全体を無効にする
  const readOnly = $derived(!session.editable);
  const timing = $derived(publishTiming(values.publishedAt ?? null, Date.now()));

  function errorsFor(k: StandardKey): string[] {
    const out = fieldErrors.filter((e) => e.field === k).map((e) => e.message);
    const r = rejected[k];
    if (r) out.push(r);
    return out;
  }

  function apply(k: StandardKey, v: FieldValue, input?: HTMLInputElement | HTMLSelectElement) {
    const r = session.setField(k, v);
    if (!r.ok) {
      rejected = { ...rejected, [k]: r.message };
      // 正本文書は変えないので、入力欄の表示も元へ戻す
      if (input) input.value = String(currentValue(k) ?? "");
    } else if (rejected[k]) {
      rejected = Object.fromEntries(Object.entries(rejected).filter(([key]) => key !== k));
    }
  }

  function currentValue(k: StandardKey): unknown {
    return (values as Record<string, unknown>)[k];
  }

  function onStatus(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    const r = session.setStatus(sel.value as "draft" | "published", values.publishedAt ?? null);
    if (!r.ok) {
      rejected = { ...rejected, status: r.message };
      sel.value = values.status ?? "draft";
    }
  }

  function addTag() {
    const t = tagDraft;
    if (t === "") return;
    apply("tags", [...(values.tags ?? []), t]);
    tagDraft = "";
  }

  function onTagKey(e: KeyboardEvent) {
    // IME 変換確定の Enter でタグを確定しない（14.1）
    if (e.key === "Enter" && !e.isComposing && !composing) {
      e.preventDefault();
      addTag();
    }
  }

  const tagDraftHasEdgeSpace = $derived(tagDraft !== "" && tagDraft.trim() !== tagDraft);
  const visibleSpaces = (s: string) => s.replace(/^\s+|\s+$/g, (m) => "␣".repeat(m.length));
</script>

<fieldset class="form" disabled={readOnly} aria-labelledby="fm-legend">
  <legend
    ><span id="fm-legend">記事情報（frontmatter）</span><HelpTip label="記事情報"
      >記事ID・作成日時・更新日時は CMS が管理します。この欄にない項目は「原文」で編集してください。</HelpTip
    ></legend
  >

  <div class="grid">
    <div class="field wide">
      <label for="f-title">タイトル</label>
      <input
        id="f-title"
        type="text"
        value={values.title ?? ""}
        oninput={(e) => apply("title", e.currentTarget.value, e.currentTarget)}
        aria-describedby="f-title-err"
      />
      {#each errorsFor("title") as m, i (i)}<p class="err" id="f-title-err">{m}</p>{/each}
    </div>

    <div class="field">
      <div class="lab">
        <label for="f-slug">slug</label><HelpTip label="slug" id="f-slug-hint"
          >半角英小文字・数字とハイフン。下書きは空でも保存できます。自動生成しません。</HelpTip
        >
      </div>
      <input
        id="f-slug"
        type="text"
        value={values.slug ?? ""}
        spellcheck="false"
        autocomplete="off"
        oninput={(e) => apply("slug", e.currentTarget.value, e.currentTarget)}
        aria-describedby="f-slug-hint"
      />
      {#each errorsFor("slug") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>

    <div class="field">
      <label for="f-status">原稿状態</label>
      <select id="f-status" value={values.status ?? "draft"} onchange={onStatus}>
        <option value="draft">下書き</option>
        <option value="published">公開対象</option>
      </select>
      {#each errorsFor("status") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>

    <div class="field wide">
      <label for="f-published">公開日時</label>
      <div class="inline">
        <input
          id="f-published"
          type="text"
          value={values.publishedAt ?? ""}
          placeholder="未設定（例：2026-11-03T22:08:00+09:00）"
          spellcheck="false"
          oninput={(e) =>
            apply("publishedAt", e.currentTarget.value === "" ? null : e.currentTarget.value, e.currentTarget)}
          aria-describedby="f-published-hint"
        />
        <button type="button" onclick={() => apply("publishedAt", formatLocalDateTime(new Date()))}>現在時刻</button>
        <button type="button" onclick={() => apply("publishedAt", null)} disabled={values.publishedAt === null}
          >未設定にする</button
        >
      </div>
      <p class="hint" id="f-published-hint">
        {#if timing === "unset"}公開日時：未設定。{:else if timing === "future"}公開予定日時を設定済み（{formatForDisplay(
            values.publishedAt ?? "",
          )}）。{:else if timing === "past"}公開日時：過去または現在（{formatForDisplay(
            values.publishedAt ?? "",
          )}）。{/if}
        公開日時を設定しただけでは、サイトのビルド・配信は行われません。配信の状態は本CMSでは確認しません。
      </p>
      {#each errorsFor("publishedAt") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>

    <div class="field wide">
      <div class="lab">
        <span id="f-tags-label">タグ</span><HelpTip label="タグ"
          >大文字小文字を区別して保存します。自動で統合・トリムしません。</HelpTip
        >
      </div>
      {#if (values.tags ?? []).length > 0}
        <ul class="chips" aria-labelledby="f-tags-label">
          {#each values.tags ?? [] as t, i (i)}
            <li>
              <span class="chip-text">{visibleSpaces(t)}</span>
              <button
                type="button"
                class="chip-x"
                aria-label={`タグ「${t}」を外す`}
                onclick={() =>
                  apply(
                    "tags",
                    (values.tags ?? []).filter((_, j) => j !== i),
                  )}>×</button
              >
            </li>
          {/each}
        </ul>
      {/if}
      <div class="inline">
        <input
          type="text"
          aria-labelledby="f-tags-label"
          placeholder="タグを入力して Enter"
          bind:value={tagDraft}
          onkeydown={onTagKey}
          oncompositionstart={() => (composing = true)}
          oncompositionend={() => (composing = false)}
        />
        <button type="button" onclick={addTag} disabled={tagDraft === ""}>追加</button>
      </div>
      {#if tagDraftHasEdgeSpace}<p class="warn">
          前後に空白があります：「{visibleSpaces(tagDraft)}」（自動では取り除きません）
        </p>{/if}
      {#each errorsFor("tags") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>

    <div class="field wide">
      <span class="label">カバー画像</span>
      {#if values.cover === null || values.cover === undefined}
        <button
          type="button"
          onclick={() => apply("cover", { src: "./media/", alt: "" })}
          disabled={values.cover === undefined}>カバー画像を設定</button
        >
      {:else}
        <div class="cover">
          <label>
            <span>画像パス（./media/ファイル名）</span>
            <input
              type="text"
              value={values.cover.src}
              spellcheck="false"
              oninput={(e) =>
                apply("cover", { src: e.currentTarget.value, alt: values.cover?.alt ?? "" }, e.currentTarget)}
            />
          </label>
          <label>
            <span>代替テキスト（装飾画像は空でも可）</span>
            <input
              type="text"
              value={values.cover.alt}
              oninput={(e) =>
                apply("cover", { src: values.cover?.src ?? "", alt: e.currentTarget.value }, e.currentTarget)}
            />
          </label>
          <button type="button" onclick={() => apply("cover", null)}>カバー画像を外す</button>
        </div>
      {/if}
      {#each errorsFor("cover") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>
  </div>

  <dl class="managed">
    <dt>記事ID</dt>
    <dd data-testid="article-id">{values.id ?? "（不明）"}</dd>
    <dt>作成日時</dt>
    <dd>{values.createdAt ? `${formatForDisplay(values.createdAt)}（${values.createdAt}）` : "（不明）"}</dd>
    <dt>更新日時</dt>
    <dd data-testid="updated-at">
      {values.updatedAt ? `${formatForDisplay(values.updatedAt)}（${values.updatedAt}）` : "（不明）"}
    </dd>
  </dl>
  {#each [...errorsFor("id"), ...errorsFor("createdAt"), ...errorsFor("updatedAt")] as m, i (i)}<p class="err">
      {m}
    </p>{/each}
</fieldset>

<style>
  .form {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem 1rem;
    margin: 0;
    min-width: 0;
  }
  legend {
    font-weight: 600;
    padding-inline: 0.25rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem 1rem;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .field > label,
  .label,
  .lab {
    font-weight: 600;
    font-size: 0.875rem;
  }
  .lab {
    display: flex;
    align-items: center;
  }
  .inline {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .inline input {
    flex: 1 1 14rem;
    min-width: 0;
  }
  .cover {
    display: grid;
    gap: 0.5rem;
  }
  .cover label {
    display: flex;
    flex-direction: column;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .err {
    margin: 0;
    color: var(--ng);
    font-size: 0.875rem;
  }
  .err::before {
    content: "エラー：";
    font-weight: 600;
  }
  .warn {
    margin: 0;
    color: var(--ng);
    font-size: 0.8125rem;
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .chips li {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding-inline-start: 0.5rem;
  }
  .chip-text {
    white-space: pre;
  }
  .chip-x {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0 0.5rem;
  }
  .managed {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.125rem 0.75rem;
    margin: 0.75rem 0 0.25rem;
    font-size: 0.875rem;
  }
  .managed dt {
    color: var(--muted);
  }
  .managed dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
