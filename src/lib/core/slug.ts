/** slug（仕様 7.1） */

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 128;

export type SlugProblem = "required" | "format" | "too-long";

/** 形式検査。下書きの空文字は許容し、公開対象では非空必須。 */
export function checkSlugFormat(slug: string, status: string): SlugProblem | null {
  if (slug === "") return status === "published" ? "required" : null;
  if (slug.length > SLUG_MAX_LENGTH) return "too-long";
  if (!SLUG_RE.test(slug)) return "format";
  return null;
}

export function slugProblemMessage(p: SlugProblem): string {
  switch (p) {
    case "required":
      return "公開対象の記事には slug が必要です。";
    case "too-long":
      return `slug は${SLUG_MAX_LENGTH}文字以内にしてください。`;
    case "format":
      return "slug は半角英小文字・数字と、間に挟むハイフンだけで入力してください（先頭・末尾・連続ハイフン不可）。";
  }
}

/** 一意性判定に使う、記事ごとの slug の取得結果 */
export type SlugEntry = { id: string; slug: string } | { id: string; slug: null; uncheckable: true };

export type SlugUniqueness =
  { kind: "unique" } | { kind: "duplicate"; ids: string[] } | { kind: "uncheckable"; ids: string[] };

/**
 * 全記事（下書きを含む）を対象に完全一致の重複を検査する。空文字同士は重複ではない。
 * 抽出不能を「空slug」と見なさず、確認できない場合は「重複検査不能」とする。
 */
export function checkSlugUniqueness(slug: string, selfId: string, entries: readonly SlugEntry[]): SlugUniqueness {
  if (slug === "") return { kind: "unique" };
  const dup: string[] = [];
  const unknown: string[] = [];
  for (const e of entries) {
    if (e.id === selfId) continue;
    if (e.slug === null) unknown.push(e.id);
    else if (e.slug === slug) dup.push(e.id);
  }
  if (dup.length > 0) return { kind: "duplicate", ids: dup };
  if (unknown.length > 0) return { kind: "uncheckable", ids: unknown };
  return { kind: "unique" };
}
