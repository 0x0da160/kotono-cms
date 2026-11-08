<script lang="ts">
  import type { Conflict } from "../lib/app/session.svelte";
  import { lineDiff } from "../lib/core/diff";
  import { analyzeText } from "../lib/core/article-doc";
  import { OPTIONAL_KEYS, STANDARD_KEYS, type FieldKey } from "../lib/core/schema";

  let {
    conflict,
    id,
    alert = false,
    oncopy,
    ondownload,
    ontakedisk,
    onrecheck,
  }: {
    conflict: Conflict;
    id: string;
    /** 保存の前に外部変更を検出した直後。見出しを role="alert" で読み上げる（編集領域の通知の代わり：P-08） */
    alert?: boolean;
    oncopy: (text: string) => void;
    ondownload: (text: string, suffix: string) => void;
    ontakedisk: () => void;
    onrecheck: () => void;
  } = $props();

  const diskDesc = $derived.by(() => {
    const d = conflict.disk;
    switch (d.kind) {
      case "bytes":
        return conflict.diskText === null ? "内容あり（CMS では表示できない形式）" : "内容あり";
      case "missing":
        return "ファイルが削除されています";
      case "wrong-kind":
        return "別種のエントリー（フォルダ等）に置き換わっています";
      case "too-large":
        return `5 MiB を超えるファイルに置き換わっています（${d.size.toLocaleString()} バイト）`;
      case "error":
        return `比較できません：${d.message}`;
    }
  });

  const metaRows = $derived.by(() => {
    const val = (t: string | null) => (t === null ? null : (analyzeText(t, id).schema?.values ?? null));
    const b = val(conflict.baseText);
    const d = val(conflict.diskText);
    const e = val(conflict.editingText);
    const optional = new Set<string>(OPTIONAL_KEYS);
    const show = (v: Record<string, unknown> | null, k: FieldKey) => {
      if (v === null) return "—";
      const x = v[k];
      return x === undefined ? (optional.has(k) ? "（なし）" : "（読取不能）") : JSON.stringify(x);
    };
    // 任意の項目は、どれかの版にあるときだけ並べる
    const present = OPTIONAL_KEYS.filter((k) =>
      [b, d, e].some((v) => v !== null && (v as Record<string, unknown>)[k] !== undefined),
    );
    return [...STANDARD_KEYS, ...present].map((k) => {
      const row = {
        key: k,
        base: show(b as Record<string, unknown> | null, k),
        disk: show(d as Record<string, unknown> | null, k),
        editing: show(e as Record<string, unknown> | null, k),
      };
      return { ...row, differs: row.base !== row.disk || row.disk !== row.editing };
    });
  });

  const diff = $derived(conflict.diskText === null ? null : lineDiff(conflict.diskText, conflict.editingText));
  const time = (t: number) => new Date(t).toLocaleString("ja-JP");
  const short = (h: string | null) => (h === null ? "—" : `${h.slice(0, 12)}…`);
</script>

{#snippet heading()}
  <h3 id="conflict-heading">外部変更あり：保存を止めました</h3>
{/snippet}

<section class="conflict" aria-labelledby="conflict-heading" data-testid="conflict-panel">
  <!-- 検出した直後は、見出しを要素ごと出し直して role="alert" の読み上げを起こす（通知の枠を出していた時と同じ契機） -->
  {#if alert}
    <div role="alert" data-testid="conflict-alert">{@render heading()}</div>
  {:else}
    {@render heading()}
  {/if}
  <p>
    読み込み後に、ディスク上の <code>index.md</code> が CMS 以外で変更されました。自動マージ・強制上書きはしません。編集中の原文を退避してから、ディスク版を読み込むか、外部で内容を確認してください。
  </p>

  <table class="versions">
    <thead>
      <tr><th scope="col">版</th><th scope="col">取得時点</th><th scope="col">内容識別子（SHA-256）</th></tr>
    </thead>
    <tbody>
      <tr
        ><th scope="row">読み込み時の原文（基準版）</th><td>{time(conflict.baseReadAt)}</td><td
          ><code title={conflict.baseHash}>{short(conflict.baseHash)}</code></td
        ></tr
      >
      <tr
        ><th scope="row">現在のディスク原文</th><td>{time(conflict.diskReadAt)}（{diskDesc}）</td><td
          ><code title={conflict.diskHash ?? ""}>{short(conflict.diskHash)}</code></td
        ></tr
      >
      <tr
        ><th scope="row">編集中の原文</th><td>{time(conflict.editingAt)}</td><td
          ><code title={conflict.editingHash}>{short(conflict.editingHash)}</code></td
        ></tr
      >
    </tbody>
  </table>

  <div class="actions">
    <button type="button" class="primary" onclick={() => oncopy(conflict.editingText)}>編集中の原文をコピー</button>
    <button type="button" onclick={() => ondownload(conflict.editingText, "editing")}>編集中の原文をダウンロード</button
    >
    {#if conflict.diskText !== null}
      <button type="button" onclick={() => ondownload(conflict.diskText ?? "", "disk")}>ディスク版をダウンロード</button
      >
    {/if}
    <button type="button" onclick={onrecheck}>ディスクを再確認</button>
    <button type="button" class="danger" onclick={ontakedisk}>編集を破棄してディスク版を読み込む</button>
  </div>

  <details>
    <summary>標準メタデータの差分</summary>
    <table class="meta">
      <thead
        ><tr
          ><th scope="col">項目</th><th scope="col">基準版</th><th scope="col">ディスク</th><th scope="col">編集中</th
          ></tr
        ></thead
      >
      <tbody>
        {#each metaRows as r (r.key)}
          <tr class:differs={r.differs}>
            <th scope="row"
              >{r.key}{#if r.differs}<span class="sr-only">（違いあり）</span> *{/if}</th
            >
            <td>{r.base}</td><td>{r.disk}</td><td>{r.editing}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>

  <details>
    <summary>原文の行差分（ディスク → 編集中）</summary>
    {#if diff === null}
      <p>ディスク版の原文を表示できないため、差分を出せません。内容が同じという意味ではありません。</p>
    {:else if !diff.ok}
      <p>{diff.reason}</p>
    {:else}
      {#if diff.truncated}<p>
          描画上限（2,000行）までを表示しています。全体は各版をダウンロードして確認してください。
        </p>{/if}
      <pre class="diff" aria-label="行差分">{#each diff.lines as l, i (i)}<span
            class={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}
            >{l.op} {l.text}
</span>{/each}</pre>
    {/if}
  </details>
</section>

<style>
  .conflict {
    border: 2px solid var(--color-ng);
    border-radius: var(--radius-lg);
    padding: var(--panel-pad);
    background: var(--color-surface);
  }
  h3 {
    margin: 0 0 var(--space-8);
    color: var(--color-ng);
    font-size: var(--font-size-16);
  }
  /* エラーの通知と同じ記号を付ける（状態を色だけで伝えない。段階4 5章） */
  h3::before {
    content: "⚠ ";
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: var(--font-size-13);
    margin-block: var(--space-8);
  }
  th,
  td {
    border: 1px solid var(--color-border);
    padding: var(--space-4) var(--space-8);
    text-align: start;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  tr.differs th {
    color: var(--color-ng);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--control-gap);
    margin-block: var(--space-8);
  }
  .diff {
    max-height: 24rem;
    overflow: auto;
    font-size: var(--font-size-13);
    background: var(--color-bg);
    padding: var(--space-8);
    border-radius: var(--radius-sm);
  }
  .add {
    color: var(--color-ok);
  }
  .del {
    color: var(--color-ng);
  }
</style>
