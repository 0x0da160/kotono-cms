/**
 * 一覧の検索・絞り込み・ソート（仕様 23）。
 */
import { parseDateTime } from "./datetime";
import type { StandardValues } from "./schema";

export type SortKey = "updatedAt" | "createdAt" | "publishedAt" | "title";
export type SortDir = "asc" | "desc";
export type StatusFilter = "all" | "draft" | "published";

export interface ListItem {
  readonly id: string;
  readonly values: StandardValues;
}

export interface ListQuery {
  readonly keyword: string;
  readonly status: StatusFilter;
  /** 選択タグ。すべてを持つ記事に一致（大文字小文字を区別する完全一致） */
  readonly tags: readonly string[];
  readonly sort: SortKey;
  readonly dir: SortDir;
}

export const DEFAULT_QUERY: ListQuery = { keyword: "", status: "all", tags: [], sort: "updatedAt", dir: "desc" };

/** キーワードはタイトル・slug・ID・タグへの部分一致。英字大小を区別しない。 */
export function matches(item: ListItem, q: ListQuery): boolean {
  const v = item.values;
  if (q.status !== "all" && v.status !== q.status) return false;
  if (q.tags.length > 0) {
    const have = new Set(v.tags ?? []);
    if (!q.tags.every((t) => have.has(t))) return false;
  }
  const kw = q.keyword.trim().toLowerCase();
  if (kw === "") return true;
  const hay = [v.title ?? "", v.slug ?? "", item.id, ...(v.tags ?? [])];
  return hay.some((h) => h.toLowerCase().includes(kw));
}

const collator = new Intl.Collator("ja");

function codepointCompare(a: string, b: string): number {
  // 記事IDは ASCII なので UTF-16 順とコードポイント順は一致する
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ソート。不正・未設定日時は昇順・降順とも末尾。同値は記事IDのコードポイント昇順。
 */
export function sortItems<T extends ListItem>(items: readonly T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const keyOf = (it: T): number | string | null => {
    if (key === "title") return it.values.title ?? null;
    const raw = it.values[key];
    if (typeof raw !== "string") return null;
    const p = parseDateTime(raw);
    return p ? p.epochMs : null;
  };
  return [...items]
    .map((it) => ({ it, k: keyOf(it) }))
    .sort((a, b) => {
      if (a.k === null || b.k === null) {
        if (a.k === null && b.k !== null) return 1;
        if (a.k !== null && b.k === null) return -1;
        return codepointCompare(a.it.id, b.it.id);
      }
      const c =
        typeof a.k === "string" && typeof b.k === "string"
          ? collator.compare(a.k, b.k)
          : (a.k as number) - (b.k as number);
      if (c !== 0) return sign * c;
      return codepointCompare(a.it.id, b.it.id);
    })
    .map((x) => x.it);
}

export function allTags(items: readonly ListItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) for (const t of it.values.tags ?? []) set.add(t);
  return [...set].sort((a, b) => collator.compare(a, b) || codepointCompare(a, b));
}
