/**
 * 画像の内容形式・寸法・アニメーション構造の検査（仕様 17・17.3・34.3）。
 *
 * - 拡張子や申告 MIME ではなく先頭バイトで形式を判定する。
 * - デコード前にヘッダーから画素数を求める。アニメーションは全フレームを展開せず、
 *   構造から フレーム数・累積画素 を数える。構造を安全に確認できない形式は拒否する。
 * - 原本は変更しない。
 */
import { IMAGE_MAX_FRAMES, IMAGE_MAX_PIXELS, IMAGE_MAX_TOTAL_FRAME_PIXELS } from "./budgets";

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "avif";

export const FORMAT_EXT: Record<ImageFormat, string> = {
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  avif: "avif",
};

export const FORMAT_MIME: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

const EXT_FORMAT: Record<string, ImageFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  gif: "gif",
  webp: "webp",
  avif: "avif",
};

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly frames: number;
  readonly animated: boolean;
}

export type Inspect = { ok: true; info: ImageInfo } | { ok: false; code: InspectCode; message: string };

export type InspectCode =
  | "unknown-format"
  | "svg"
  | "malformed"
  | "pixels"
  | "frames"
  | "animation-unverifiable"
  | "extension-mismatch"
  | "mime-mismatch";

const fail = (code: InspectCode, message: string): Inspect => ({ ok: false, code, message });

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) * 0x1000000 + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0))) >>> 0;
const u32le = (b: Uint8Array, o: number) =>
  u32be(new Uint8Array([b[o + 3] ?? 0, b[o + 2] ?? 0, b[o + 1] ?? 0, b[o] ?? 0]), 0);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function sniffFormat(b: Uint8Array): ImageFormat | "svg" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brands = ftypBrands(b);
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
  }
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, 512))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

function ftypBrands(b: Uint8Array): string[] {
  const size = u32be(b, 0);
  if (size < 16 || size > b.length || size > 4096) return [];
  const out = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= size; o += 4) out.push(ascii(b, o, 4));
  return out;
}

/** 拡張子（小文字化）と申告 MIME を内容形式と照合したうえで検査する（17.1） */
export function inspectImage(
  bytes: Uint8Array,
  opts: { fileName?: string; declaredType?: string; maxPixels?: number } = {},
): Inspect {
  const fmt = sniffFormat(bytes);
  if (fmt === "svg") return fail("svg", "SVG は取り込み・プレビューの対象外です。");
  if (fmt === null) return fail("unknown-format", "JPEG・PNG・GIF・WebP・AVIF のいずれでもありません。");
  if (opts.fileName !== undefined) {
    const m = /\.([^./\\]+)$/.exec(opts.fileName);
    const ext = m?.[1]?.toLowerCase();
    if (ext === undefined || EXT_FORMAT[ext] !== fmt)
      return fail(
        "extension-mismatch",
        `拡張子（${ext ?? "なし"}）と内容の形式（${fmt.toUpperCase()}）が一致しません。`,
      );
  }
  if (opts.declaredType && opts.declaredType !== "" && opts.declaredType !== FORMAT_MIME[fmt]) {
    // image/jpg などの非標準表記は jpeg として扱う
    if (!(fmt === "jpeg" && /^image\/(jpg|pjpeg)$/i.test(opts.declaredType)))
      return fail("mime-mismatch", `申告された形式（${opts.declaredType}）と内容の形式が一致しません。`);
  }
  let r: Inspect;
  switch (fmt) {
    case "png":
      r = inspectPng(bytes);
      break;
    case "gif":
      r = inspectGif(bytes);
      break;
    case "jpeg":
      r = inspectJpeg(bytes);
      break;
    case "webp":
      r = inspectWebp(bytes);
      break;
    case "avif":
      r = inspectAvif(bytes);
      break;
  }
  if (!r.ok) return r;
  const maxPixels = Math.min(opts.maxPixels ?? IMAGE_MAX_PIXELS, IMAGE_MAX_PIXELS);
  const { info } = r;
  if (info.width <= 0 || info.height <= 0) return fail("malformed", "画像の寸法を読み取れません。");
  if (info.pixels > maxPixels)
    return fail(
      "pixels",
      `画素数（${info.width}×${info.height}＝${info.pixels.toLocaleString()}）が上限（${maxPixels.toLocaleString()}）を超えています。`,
    );
  return r;
}

const ok = (format: ImageFormat, width: number, height: number, frames = 1, animated = false): Inspect => ({
  ok: true,
  info: { format, width, height, pixels: width * height, frames, animated },
});

function checkAnimation(frames: number, cumulative: number): Inspect | null {
  if (frames > IMAGE_MAX_FRAMES)
    return fail("frames", `フレーム数（${frames}）が上限（${IMAGE_MAX_FRAMES}）を超えています。`);
  if (cumulative > IMAGE_MAX_TOTAL_FRAME_PIXELS)
    return fail(
      "frames",
      `アニメーションの累積画素（${cumulative.toLocaleString()}）が上限（${IMAGE_MAX_TOTAL_FRAME_PIXELS.toLocaleString()}）を超えています。`,
    );
  return null;
}

function inspectPng(b: Uint8Array): Inspect {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return fail("malformed", "PNG のヘッダーが不正です。");
  const w = u32be(b, 16);
  const h = u32be(b, 20);
  // IDAT より前の acTL で APNG を判定する
  let o = 8;
  let frames = 1;
  let animated = false;
  while (o + 8 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (o + 12 + len > b.length) return fail("malformed", "PNG のチャンクが途中で切れています。");
    if (type === "acTL") {
      animated = true;
      frames = u32be(b, o + 8);
    }
    if (type === "IDAT" || type === "IEND") break;
    o += 12 + len;
  }
  if (animated) {
    const bad = checkAnimation(frames, frames * w * h);
    if (bad) return bad;
  }
  return ok("png", w, h, frames, animated);
}

function inspectGif(b: Uint8Array): Inspect {
  if (b.length < 13) return fail("malformed", "GIF のヘッダーが不正です。");
  const w = u16le(b, 6);
  const h = u16le(b, 8);
  const flags = b[10] ?? 0;
  let o = 13;
  if (flags & 0x80) o += 3 * (1 << ((flags & 7) + 1));
  let frames = 0;
  let cumulative = 0;
  const skipSubBlocks = (): boolean => {
    while (o < b.length) {
      const n = b[o] ?? 0;
      o += 1;
      if (n === 0) return true;
      o += n;
    }
    return false;
  };
  for (;;) {
    if (o >= b.length) return fail("malformed", "GIF の終端がありません。");
    const tag = b[o];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      o += 2;
      if (!skipSubBlocks()) return fail("malformed", "GIF の拡張ブロックが途中で切れています。");
    } else if (tag === 0x2c) {
      if (o + 10 > b.length) return fail("malformed", "GIF の画像記述子が途中で切れています。");
      const fw = u16le(b, o + 5);
      const fh = u16le(b, o + 7);
      const fflags = b[o + 9] ?? 0;
      o += 10;
      if (fflags & 0x80) o += 3 * (1 << ((fflags & 7) + 1));
      o += 1; // LZW 最小符号長
      if (!skipSubBlocks()) return fail("malformed", "GIF の画像データが途中で切れています。");
      frames++;
      cumulative += fw * fh;
      const bad = checkAnimation(frames, cumulative);
      if (bad) return bad;
    } else return fail("malformed", "GIF に不明なブロックがあります。");
  }
  if (frames === 0) return fail("malformed", "GIF に画像がありません。");
  return ok("gif", w, h, frames, frames > 1);
}

function inspectJpeg(b: Uint8Array): Inspect {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return fail("malformed", "JPEG のマーカーが不正です。");
    const marker = b[o + 1] ?? 0;
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16be(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) return fail("malformed", "JPEG のセグメントが途中で切れています。");
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return fail("malformed", "JPEG のフレームヘッダーが不正です。");
      return ok("jpeg", u16be(b, o + 7), u16be(b, o + 5));
    }
    o += 2 + len;
  }
  return fail("malformed", "JPEG の寸法を読み取れません。");
}

function inspectWebp(b: Uint8Array): Inspect {
  const riff = u32le(b, 4);
  if (riff + 8 > b.length || riff < 4) return fail("malformed", "WebP の RIFF サイズが不正です。");
  let o = 12;
  let w = 0;
  let h = 0;
  let animated = false;
  let frames = 0;
  let cumulative = 0;
  let sawImage = false;
  while (o + 8 <= riff + 8) {
    const type = ascii(b, o, 4);
    const len = u32le(b, o + 4);
    const data = o + 8;
    if (data + len > b.length) return fail("malformed", "WebP のチャンクが途中で切れています。");
    if (type === "VP8X") {
      if (len < 10) return fail("malformed", "WebP の拡張ヘッダーが不正です。");
      animated = ((b[data] ?? 0) & 0x02) !== 0;
      w = u24le(b, data + 4) + 1;
      h = u24le(b, data + 7) + 1;
    } else if (type === "VP8 " && !sawImage) {
      if (len < 10 || ascii(b, data + 3, 3) !== "\x9d\x01\x2a")
        return fail("malformed", "WebP（VP8）のヘッダーが不正です。");
      if (w === 0) {
        w = u16le(b, data + 6) & 0x3fff;
        h = u16le(b, data + 8) & 0x3fff;
      }
      sawImage = true;
    } else if (type === "VP8L" && !sawImage) {
      if (len < 5 || b[data] !== 0x2f) return fail("malformed", "WebP（VP8L）のヘッダーが不正です。");
      if (w === 0) {
        const bits = u32le(b, data + 1);
        w = (bits & 0x3fff) + 1;
        h = ((bits >>> 14) & 0x3fff) + 1;
      }
      sawImage = true;
    } else if (type === "ANMF") {
      if (len < 16) return fail("malformed", "WebP のアニメーションフレームが不正です。");
      frames++;
      cumulative += (u24le(b, data + 6) + 1) * (u24le(b, data + 9) + 1);
      const bad = checkAnimation(frames, cumulative);
      if (bad) return bad;
      sawImage = true;
    }
    o = data + len + (len & 1);
  }
  if (!sawImage || w === 0 || h === 0) return fail("malformed", "WebP の画像データがありません。");
  if (animated && frames === 0) return fail("malformed", "WebP のアニメーションにフレームがありません。");
  return ok("webp", w, h, animated ? frames : 1, animated);
}

function inspectAvif(b: Uint8Array): Inspect {
  const brands = ftypBrands(b);
  // 画像シーケンス（avis）のフレーム構造は全展開せずに検査する方法を実装していないため拒否する（34.3）
  if (brands[0] === "avis" || (brands.includes("avis") && !brands.includes("avif")))
    return fail("animation-unverifiable", "アニメーション AVIF は構造を安全に検査できないため対象外です。");
  // ボックス構造を有界に辿って ispe（画像の寸法）を探す
  let best: [number, number] | null = null;
  let boxes = 0;
  const walk = (start: number, end: number, depth: number): boolean => {
    let o = start;
    while (o + 8 <= end) {
      if (++boxes > 10_000 || depth > 8) return false;
      let size = u32be(b, o);
      const type = ascii(b, o + 4, 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) return false;
        size = u32be(b, o + 8) * 0x100000000 + u32be(b, o + 12);
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header || o + size > end) return false;
      const body = o + header;
      if (type === "meta") {
        if (!walk(body + 4, o + size, depth + 1)) return false;
      } else if (type === "iprp" || type === "ipco") {
        if (!walk(body, o + size, depth + 1)) return false;
      } else if (type === "ispe" && size >= header + 12) {
        const w = u32be(b, body + 4);
        const h = u32be(b, body + 8);
        if (best === null || w * h > best[0] * best[1]) best = [w, h];
      }
      o += size;
    }
    return true;
  };
  if (!walk(0, b.length, 0)) return fail("malformed", "AVIF のボックス構造が不正です。");
  const found = best as [number, number] | null;
  if (found === null) return fail("malformed", "AVIF の寸法（ispe）がありません。");
  return ok("avif", found[0], found[1]);
}

/** 本文へ挿入する alt を Markdown の画像記法に合わせてエスケープする（17.1） */
export function escapeAlt(alt: string): string {
  return alt.replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1");
}

export function imageMarkdown(alt: string, name: string): string {
  return `![${escapeAlt(alt)}](./media/${name})`;
}
