<script lang="ts">
  import HelpTip from "./HelpTip.svelte";
  import type { EditorSession } from "../lib/app/session.svelte";
  import { formatForDisplay, formatLocalDateTime, publishTiming } from "../lib/core/datetime";
  import { isValidAuthorId, type Correction, type FieldKey } from "../lib/core/schema";
  import type { AuthorsState } from "../lib/fs/repo";
  import type { FieldValue } from "../lib/core/yaml-doc";

  let { session, authors = null }: { session: EditorSession; authors?: AuthorsState | null } = $props();

  /** 説明文の目安の文字数（超えても保存は止めない） */
  const DESCRIPTION_GUIDE = 120;

  const values = $derived(session.analysis.schema?.values ?? {});
  const fieldErrors = $derived(
    (session.analysis.problems ?? []).filter((p) => p.field !== undefined) as { field: FieldKey; message: string }[],
  );
  let rejected = $state<Partial<Record<FieldKey, string>>>({});
  let tagDraft = $state("");
  let aliasDraft = $state("");
  let authorDraft = $state("");
  let composing = false;

  // 読み取り専用・削除手続き中の編集停止（11.3）ではフォーム全体を無効にする
  const readOnly = $derived(!session.editable);
  const timing = $derived(publishTiming(values.publishedAt ?? null, Date.now()));

  function errorsFor(k: FieldKey): string[] {
    const out = fieldErrors.filter((e) => e.field === k).map((e) => e.message);
    const r = rejected[k];
    if (r) out.push(r);
    return out;
  }

  function apply(k: FieldKey, v: FieldValue, input?: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
    const r = session.setField(k, v);
    if (!r.ok) {
      rejected = { ...rejected, [k]: r.message };
      // 正本文書は変えないので、入力欄の表示も元へ戻す
      if (input) input.value = String(currentValue(k) ?? "");
    } else if (rejected[k]) {
      rejected = Object.fromEntries(Object.entries(rejected).filter(([key]) => key !== k));
    }
  }

  function currentValue(k: FieldKey): unknown {
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

  // 著者（content/authors/ の一覧から選ぶ。未登録の ID は警告だけ）
  const knownAuthors = $derived(authors?.kind === "ok" ? authors.authors : []);
  const authorName = (id: string) => knownAuthors.find((a) => a.id === id)?.name ?? null;
  const unknownAuthors = $derived(
    authors === null ? [] : (values.authors ?? []).filter((id) => !knownAuthors.some((a) => a.id === id)),
  );

  function addAuthor() {
    // 表示名で入力した場合は ID に置き換える
    const typed = authorDraft.trim();
    if (typed === "") return;
    const byName = knownAuthors.find((a) => a.name === typed);
    apply("authors", [...(values.authors ?? []), byName ? byName.id : typed]);
    authorDraft = "";
  }

  function addAlias() {
    const a = aliasDraft.trim();
    if (a === "") return;
    apply("aliases", [...(values.aliases ?? []), a]);
    aliasDraft = "";
  }

  function onEnter(e: KeyboardEvent, fn: () => void) {
    if (e.key === "Enter" && !e.isComposing && !composing) {
      e.preventDefault();
      fn();
    }
  }

  const corrections = $derived<Correction[]>(values.corrections ?? []);
  function setCorrection(i: number, patch: Partial<Correction>, input?: HTMLInputElement | HTMLTextAreaElement) {
    apply(
      "corrections",
      corrections.map((c, j) => (j === i ? { ...c, ...patch } : c)),
      input,
    );
  }

  const descriptionLength = $derived([...(values.description ?? "")].length);

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

    <div class="field wide">
      <div class="lab">
        <label for="f-description">説明文</label><HelpTip label="説明文"
          >記事一覧のリード文・検索結果・SNS
          のカードに使う要約です（description）。サイト側での使い方はサイトが決めます。</HelpTip
        >
      </div>
      <textarea
        id="f-description"
        rows="2"
        value={values.description ?? ""}
        oninput={(e) => apply("description", e.currentTarget.value, e.currentTarget)}
        aria-describedby="f-description-hint"></textarea>
      <p class="hint" id="f-description-hint" data-testid="description-count">
        {descriptionLength}文字（目安は{DESCRIPTION_GUIDE}文字前後）
      </p>
      {#if descriptionLength > DESCRIPTION_GUIDE}<p class="warn">
          目安より長いため、検索結果などで途中までしか表示されないことがあります。
        </p>{/if}
      {#each errorsFor("description") as m, i (i)}<p class="err">{m}</p>{/each}
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
      {#if (values.aliases ?? []).length > 0 || errorsFor("aliases").length > 0}
        <div class="lab">
          <span id="f-aliases-label">旧 slug</span><HelpTip label="旧 slug"
            >公開後に slug を変えたときの旧い slug です（aliases）。サイト側で旧 URL
            からのリダイレクトを作るのに使います。</HelpTip
          >
        </div>
        <ul class="chips" aria-labelledby="f-aliases-label" data-testid="aliases">
          {#each values.aliases ?? [] as a, i (i)}
            <li>
              <span class="chip-text">{a}</span>
              <button
                type="button"
                class="chip-x"
                aria-label={`旧 slug「${a}」を外す`}
                onclick={() =>
                  apply(
                    "aliases",
                    (values.aliases ?? []).filter((_, j) => j !== i),
                  )}>×</button
              >
            </li>
          {/each}
        </ul>
        <div class="inline">
          <input
            type="text"
            aria-labelledby="f-aliases-label"
            placeholder="旧 slug を入力して Enter"
            spellcheck="false"
            autocomplete="off"
            bind:value={aliasDraft}
            onkeydown={(e) => onEnter(e, addAlias)}
          />
          <button type="button" onclick={addAlias} disabled={aliasDraft.trim() === ""}>追加</button>
        </div>
        {#each errorsFor("aliases") as m, i (i)}<p class="err">{m}</p>{/each}
      {/if}
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
        公開日時を設定しただけでは、サイトはビルドも配信もされません。配信の状態は本CMSでは確認しません。
      </p>
      {#each errorsFor("publishedAt") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>

    <div class="field wide">
      <div class="lab">
        <label for="f-revised">読者向けの更新日時</label><HelpTip label="読者向けの更新日時"
          >内容を更新したことを読者に示す日時です（revisedAt）。誤字の修正などでは変えません。保存のたびに変わる更新日時（updatedAt）とは別です。</HelpTip
        >
      </div>
      <div class="inline">
        <input
          id="f-revised"
          type="text"
          value={values.revisedAt ?? ""}
          placeholder="未設定（例：2026-11-03T22:08:00+09:00）"
          spellcheck="false"
          oninput={(e) =>
            apply("revisedAt", e.currentTarget.value === "" ? null : e.currentTarget.value, e.currentTarget)}
        />
        <button type="button" onclick={() => apply("revisedAt", formatLocalDateTime(new Date()))}>現在時刻</button>
        <button
          type="button"
          onclick={() => apply("revisedAt", null)}
          disabled={values.revisedAt === null || values.revisedAt === undefined}>未設定にする</button
        >
      </div>
      {#if values.revisedAt}<p class="hint">
          更新日時（読者向け）：{formatForDisplay(values.revisedAt)}
        </p>{/if}
      {#each errorsFor("revisedAt") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>

    <div class="field wide">
      <div class="lab">
        <span id="f-corrections-label">訂正・追記</span><HelpTip label="訂正・追記"
          >記事の訂正や追記の記録です（corrections）。サイト側で記事の末尾などに表示できます。</HelpTip
        >
      </div>
      {#if corrections.length > 0}
        <ol class="corrections" aria-labelledby="f-corrections-label" data-testid="corrections">
          {#each corrections as c, i (i)}
            <li>
              <label>
                <span>日時</span>
                <input
                  type="text"
                  value={c.at}
                  spellcheck="false"
                  oninput={(e) => setCorrection(i, { at: e.currentTarget.value }, e.currentTarget)}
                />
              </label>
              <label>
                <span>内容</span>
                <textarea
                  rows="2"
                  value={c.note}
                  oninput={(e) => setCorrection(i, { note: e.currentTarget.value }, e.currentTarget)}></textarea>
              </label>
              <button
                type="button"
                onclick={() =>
                  apply(
                    "corrections",
                    corrections.filter((_, j) => j !== i),
                  )}>この記録を消す</button
              >
            </li>
          {/each}
        </ol>
      {/if}
      <div class="inline">
        <button
          type="button"
          onclick={() => apply("corrections", [...corrections, { at: formatLocalDateTime(new Date()), note: "" }])}
          >訂正・追記を記録</button
        >
      </div>
      {#each errorsFor("corrections") as m, i (i)}<p class="err">{m}</p>{/each}
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
      <div class="lab">
        <span id="f-authors-label">著者</span><HelpTip label="著者"
          >著者 ID で記録します（authors）。先頭が主な著者です。著者の一覧は content/authors/&lt;著者ID&gt;/index.md の
          name から読みます。</HelpTip
        >
      </div>
      {#if (values.authors ?? []).length > 0}
        <ul class="chips" aria-labelledby="f-authors-label" data-testid="authors">
          {#each values.authors ?? [] as a, i (i)}
            <li>
              <span class="chip-text">{authorName(a) ? `${authorName(a)}（${a}）` : a}</span>
              <button
                type="button"
                class="chip-x"
                aria-label={`著者「${authorName(a) ?? a}」を外す`}
                onclick={() =>
                  apply(
                    "authors",
                    (values.authors ?? []).filter((_, j) => j !== i),
                  )}>×</button
              >
            </li>
          {/each}
        </ul>
      {/if}
      <div class="inline">
        <input
          type="text"
          aria-labelledby="f-authors-label"
          placeholder={knownAuthors.length > 0 ? "著者を選ぶか、著者 ID を入力して Enter" : "著者 ID を入力して Enter"}
          list="f-authors-list"
          spellcheck="false"
          autocomplete="off"
          bind:value={authorDraft}
          onkeydown={(e) => onEnter(e, addAuthor)}
          oncompositionstart={() => (composing = true)}
          oncompositionend={() => (composing = false)}
        />
        <button type="button" onclick={addAuthor} disabled={authorDraft.trim() === ""}>追加</button>
        <datalist id="f-authors-list">
          {#each knownAuthors as a (a.id)}<option value={a.id}>{a.name ?? a.id}</option>{/each}
        </datalist>
      </div>
      {#if authorDraft.trim() !== "" && !isValidAuthorId(authorDraft.trim()) && !knownAuthors.some((a) => a.name === authorDraft.trim())}<p
          class="warn"
        >
          著者 ID は半角英小文字・数字とハイフンで入力してください。
        </p>{/if}
      {#if unknownAuthors.length > 0}<p class="warn" data-testid="unknown-authors">
          content/authors/ にない著者 ID です：{unknownAuthors.join("、")}（保存はできます）
        </p>{/if}
      {#if authors?.kind === "ok" && authors.message}<p class="hint">{authors.message}</p>{/if}
      {#each errorsFor("authors") as m, i (i)}<p class="err">{m}</p>{/each}
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
          <label>
            <span>キャプション（任意）</span>
            <input
              type="text"
              value={values.cover.caption ?? ""}
              oninput={(e) =>
                apply(
                  "cover",
                  { src: values.cover?.src ?? "", alt: values.cover?.alt ?? "", caption: e.currentTarget.value },
                  e.currentTarget,
                )}
            />
          </label>
          <label>
            <span>クレジット（任意。撮影者・提供元など）</span>
            <input
              type="text"
              value={values.cover.credit ?? ""}
              oninput={(e) =>
                apply(
                  "cover",
                  { src: values.cover?.src ?? "", alt: values.cover?.alt ?? "", credit: e.currentTarget.value },
                  e.currentTarget,
                )}
            />
          </label>
          <button type="button" onclick={() => apply("cover", null)}>カバー画像を外す</button>
        </div>
      {/if}
      {#each errorsFor("cover") as m, i (i)}<p class="err">{m}</p>{/each}
    </div>
  </div>

  <dl class="managed grid-table">
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
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    margin: 0;
    min-width: 0;
  }
  legend {
    font-weight: var(--font-weight-strong);
    padding-inline: var(--space-4);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-8) var(--space-12);
  }
  .wide {
    grid-column: 1 / -1;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .field > label,
  .label,
  .lab {
    font-weight: var(--font-weight-strong);
    font-size: var(--font-size-14);
  }
  .lab {
    display: flex;
    align-items: center;
  }
  .inline {
    display: flex;
    gap: var(--space-8);
    flex-wrap: wrap;
  }
  .inline input {
    flex: 1 1 14rem;
    min-width: 0;
  }
  .cover {
    display: grid;
    gap: var(--space-8);
  }
  textarea {
    font: inherit;
    resize: vertical;
    min-width: 0;
  }
  .corrections {
    margin: 0;
    padding-inline-start: var(--space-20);
    display: grid;
    gap: var(--space-8);
  }
  .corrections li {
    display: grid;
    gap: var(--space-4);
  }
  .corrections button {
    justify-self: start;
  }
  .corrections label,
  .cover label {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-13);
    color: var(--color-fg-muted);
  }
  .hint {
    margin: 0;
    color: var(--color-fg-muted);
    font-size: var(--font-size-13);
  }
  .err {
    margin: 0;
    color: var(--color-danger-fg);
    font-size: var(--font-size-14);
  }
  .err::before {
    content: "エラー：";
    font-weight: var(--font-weight-strong);
  }
  .warn {
    margin: 0;
    color: var(--color-warning-fg);
    font-size: var(--font-size-13);
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
  .chips li {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-pill);
    padding-inline-start: var(--space-8);
  }
  .chip-text {
    white-space: pre;
  }
  .chip-x {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0 var(--space-8);
  }
  .managed {
    margin: var(--space-8) 0 var(--space-4);
    font-size: var(--font-size-14);
  }
</style>
