/**
 * 作業場所の鍵（仕様 3.2 第39.2節、ADR-0006 第7.2節）。
 *
 * データ鍵（DK）は 32 バイトの乱数。DK から HKDF で用途別の鍵を作る。
 * - data：ファイル内容の AES-GCM 鍵
 * - name：名前の AES-GCM 鍵
 * - nameIv：名前の IV を作る HMAC 鍵
 * - nameLong：長い名前の置き換え名を作る HMAC 鍵
 * - meta：表示名・トークン等の AES-GCM 鍵
 * - export：書き出しの AES-GCM 鍵
 */

export interface DataKeys {
  readonly data: CryptoKey;
  readonly name: CryptoKey;
  readonly nameIv: CryptoKey;
  readonly nameLong: CryptoKey;
  readonly meta: CryptoKey;
  readonly exportKey: CryptoKey;
}

const te = new TextEncoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveDataKeys(dk: Uint8Array): Promise<DataKeys> {
  if (dk.length !== 32) throw new Error("データ鍵の長さが違います。");
  const base = await crypto.subtle.importKey("raw", dk as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  const salt = te.encode("kotono-cms/v1");
  const aes = (info: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  const hmac = (info: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
  return {
    data: await aes("data"),
    name: await aes("name"),
    nameIv: await hmac("name-iv"),
    nameLong: await hmac("name-long"),
    meta: await aes("meta"),
    exportKey: await aes("export"),
  };
}

export async function aesEncrypt(
  key: CryptoKey,
  plain: Uint8Array,
  aad: Uint8Array,
  iv: Uint8Array = randomBytes(12),
): Promise<Uint8Array> {
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer> },
      key,
      plain as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

/** 認証に失敗したら null（改ざん・別の鍵・破損：39.3） */
export async function aesDecrypt(key: CryptoKey, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < 12 + 16) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.slice(0, 12) as Uint8Array<ArrayBuffer>,
          additionalData: aad as Uint8Array<ArrayBuffer>,
        },
        key,
        sealed.slice(12) as Uint8Array<ArrayBuffer>,
      ),
    );
  } catch {
    return null;
  }
}

export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>));
}

// ---------------------------------------------------------------------------
// 包む鍵（回復コード・パスキー）

/** PBKDF2 の反復回数（PROVISIONAL：TG14 で iPhone の所要時間を測って確定する） */
export const PBKDF2_ITERATIONS = 600_000;

export async function keyFromSecret(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(secret.normalize("NFKC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** パスキーの PRF の出力（32 バイト）から包む鍵を作る */
export async function keyFromPrf(prf: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prf as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("kotono-cms/prf/v1"), info: te.encode("wrap") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const WRAP_AAD = te.encode("kotono-cms/dk/v1");

export function wrapDk(wrapping: CryptoKey, dk: Uint8Array): Promise<Uint8Array> {
  return aesEncrypt(wrapping, dk, WRAP_AAD);
}

export async function unwrapDk(wrapping: CryptoKey, wrapped: Uint8Array): Promise<Uint8Array | null> {
  const dk = await aesDecrypt(wrapping, wrapped, WRAP_AAD);
  return dk && dk.length === 32 ? dk : null;
}

// ---------------------------------------------------------------------------
// 回復コード

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 回復コード：125 ビットの乱数を 5 文字 × 5 組で表す（大文字小文字・区切りを問わず受け付ける） */
export function newRecoveryCode(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(25);
  let s = "";
  for (const b of bytes) s += B32[b & 31];
  return (s.match(/.{5}/g) ?? []).join("-").toUpperCase();
}

export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, "");
  if (s.length !== 25 || [...s].some((c) => !B32.includes(c))) return null;
  return s;
}

// ---------------------------------------------------------------------------
// base64url・base32

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
