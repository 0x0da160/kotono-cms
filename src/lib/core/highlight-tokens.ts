/** ハイライト結果の受け渡し形式と検証（主スレッドの描画側で使う。文法定義を含まない） */

/** PROVISIONAL：1ブロックのトークン数の上限 */
export const PROVISIONAL_HIGHLIGHT_MAX_TOKENS = 20_000;

/** [クラス名（空なら装飾なし）, 文字列] */
export type HlToken = readonly [string, string];

/** 描画で許可するクラス名（英小文字・数字・_・- だけ） */
export function safeClasses(cls: unknown): string | null {
  if (typeof cls !== "string") return null;
  const names = cls.split(" ").filter((c) => c !== "");
  if (names.length === 0) return "";
  if (names.length > 8 || !names.every((c) => /^[a-z][a-z0-9_-]{0,40}$/.test(c))) return null;
  return names.join(" ");
}

/** 解析層から受け取ったハイライト結果の検証（型・件数・連結結果の一致） */
export function validTokens(v: unknown, code: string): HlToken[] | null {
  if (!Array.isArray(v) || v.length > PROVISIONAL_HIGHLIGHT_MAX_TOKENS) return null;
  let joined = "";
  for (const t of v) {
    if (!Array.isArray(t) || t.length !== 2 || typeof t[1] !== "string" || safeClasses(t[0]) === null) return null;
    joined += t[1];
  }
  return joined === code ? (v as HlToken[]) : null;
}
