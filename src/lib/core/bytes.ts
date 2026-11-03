/** UTF-8 とバイト列の扱い（仕様 9.1・12.1）。 */

const BOM = [0xef, 0xbb, 0xbf] as const;

export type DecodeResult = { ok: true; text: string; bom: boolean } | { ok: false };

export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
}

/** 不正な UTF-8 を代替文字へ置換せず、失敗として返す。BOM は取り除いて報告する。 */
export function decodeUtf8Strict(bytes: Uint8Array): DecodeResult {
  const bom = hasBom(bytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
    return { ok: true, text, bom };
  } catch {
    return { ok: false };
  }
}

/**
 * 先頭部分だけを読んだバイト列を厳密に復号する。末尾で途中切れになった
 * マルチバイト文字（最大3バイト）だけを落とし、それ以外の不正は失敗とする。
 */
export function decodeUtf8Prefix(bytes: Uint8Array, truncated: boolean): DecodeResult {
  if (!truncated) return decodeUtf8Strict(bytes);
  let end = bytes.length;
  // 末尾から、継続バイト(10xxxxxx)の並びと先頭バイトを確認する
  let i = end - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i >= 0) {
    const lead = bytes[i] ?? 0;
    const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
    if (need > cont) end = i;
  }
  return decodeUtf8Strict(bytes.subarray(0, end));
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 暗号学的ハッシュ（SHA-256）の16進表記。内容識別子として表示に使う。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 改行コードを LF に統一する（仕様 8.2：実際に保存する場合のみ適用） */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
