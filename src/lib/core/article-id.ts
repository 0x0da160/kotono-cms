/**
 * 記事ID（仕様 第5章）。Nano ID の安全な乱数生成と小文字 Base32 の32文字。
 */
import { customAlphabet } from "nanoid";
import { ID_MAX_CANDIDATES } from "./budgets";

export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_MIN_LENGTH = 7;
export const ID_MAX_LENGTH = 32;
export const ID_DEFAULT_LENGTH = 7;

const ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{7,32}$/;

/** 既存記事は 7〜32 文字かつ規定の文字種であれば、設定と異なる長さを許容する（5.1） */
export function isValidArticleId(id: string): boolean {
  return ID_RE.test(id);
}

export function generateArticleId(length: number): string {
  if (!Number.isInteger(length) || length < ID_MIN_LENGTH || length > ID_MAX_LENGTH) {
    throw new RangeError(`記事IDの長さは${ID_MIN_LENGTH}〜${ID_MAX_LENGTH}です: ${length}`);
  }
  return customAlphabet(ID_ALPHABET, length)();
}

export type AllocateResult =
  | { ok: true; id: string; attempts: number }
  | { ok: false; reason: "exhausted"; attempts: number }
  | { ok: false; reason: "check-failed"; attempts: number; error: unknown };

/**
 * 重複検査（5.2）：作成先に同名エントリーがあれば再生成する。初回を含め最大11候補。
 * `exists` は記事として正常かを問わず、同名エントリーの有無を返す。
 * 判定できない（例外）場合は停止する。既存エントリーを再利用しない。
 */
export async function allocateArticleId(
  length: number,
  exists: (id: string) => Promise<boolean>,
  generate: (length: number) => string = generateArticleId,
): Promise<AllocateResult> {
  for (let attempt = 1; attempt <= ID_MAX_CANDIDATES; attempt++) {
    const id = generate(length);
    let taken: boolean;
    try {
      taken = await exists(id);
    } catch (error) {
      return { ok: false, reason: "check-failed", attempts: attempt, error };
    }
    if (!taken) return { ok: true, id, attempts: attempt };
  }
  return { ok: false, reason: "exhausted", attempts: ID_MAX_CANDIDATES };
}
