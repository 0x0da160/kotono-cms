/**
 * 画像の取り込み時の最適化と、表示用の派生画像（ADR-0005）。
 *
 * 仕様 17・28 は「原本を加工しない」としていたが、0x0da160 の依頼により次のとおり変更した。
 * - 取り込み時に、縦横の上限・総画素数の上限まで縮小し、再エンコードしてメタデータ（Exif・位置情報・
 *   色以外の付随情報）を取り除く。向き（Exif Orientation）は再エンコードの前に画素へ反映する。
 *   ファイルサイズが上限を超えるときは、品質を下げ、それでも超えれば縮小して収める。これを「原本」として保存する。
 * - 原本から、幅の異なる表示用の派生画像を WebP と JPEG（透過があれば PNG）で作り、
 *   media/variants/ に置く。プレビュー・本文の見たまま編集・メディア一覧の表示は派生画像を使う。
 * - アニメーション画像は、ブラウザで再エンコードするとアニメーションを失うため加工しない（原本のまま保存し、
 *   派生画像も作らない）。上限を超えるものは取り込まない。
 *
 * 計画（寸法・幅・名前）の計算は純粋関数にして単体試験する。エンコードはブラウザの
 * createImageBitmap と OffscreenCanvas で行う（browserProcessor）。
 */
import { MiB } from "../core/budgets";
import { FORMAT_EXT, FORMAT_MIME, inspectImage, type ImageFormat, type ImageInfo } from "../core/image";

/** 原本の上限 */
export const ORIGINAL_MAX_SIDE = 4096;
export const ORIGINAL_MAX_PIXELS = 16_000_000;
export const ORIGINAL_MAX_BYTES = 4 * MiB;
/** 非可逆形式の品質（最初の値から、上限に収まるまで下げる） */
export const ORIGINAL_QUALITIES = [0.9, 0.85, 0.8, 0.7, 0.6] as const;
/** 品質を下げても上限を超えるときの縮小率と回数 */
export const SHRINK_STEP = 0.85;
export const SHRINK_MAX_STEPS = 6;

/** 表示用の派生画像の幅（原本より狭いものだけを作る。原本が最小幅以下なら原寸で1つ作る） */
export const VARIANT_WIDTHS = [480, 960, 1920] as const;
export const VARIANT_QUALITY = 0.8;
export const VARIANTS_DIR = "variants";

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** 縦横の上限と総画素数の上限の両方に収まる寸法（縦横比を保つ。拡大しない） */
export function fitWithin(width: number, height: number, maxSide: number, maxPixels: number): Size {
  let scale = Math.min(1, maxSide / width, maxSide / height, Math.sqrt(maxPixels / (width * height)));
  for (;;) {
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    if ((w <= maxSide && h <= maxSide && w * h <= maxPixels) || scale <= 0) return { width: w, height: h };
    scale *= 0.999;
  }
}

/** 派生画像の幅の一覧（昇順、重複なし） */
export function variantWidths(width: number): number[] {
  const out: number[] = VARIANT_WIDTHS.filter((w) => w < width);
  const top = Math.min(width, VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1] as number);
  if (!out.includes(top)) out.push(top);
  return out.sort((a, b) => a - b);
}

/** 原本の保存形式。ブラウザが書き出せない形式（GIF・AVIF）は書き出せる形式にする */
export function originalFormat(source: ImageFormat): ImageFormat {
  switch (source) {
    case "jpeg":
    case "png":
    case "webp":
      return source;
    case "gif":
      return "png";
    case "avif":
      return "webp";
  }
}

export const LOSSY: ReadonlySet<ImageFormat> = new Set(["jpeg", "webp"]);

export function variantName(mediaId: string, width: number, format: ImageFormat): string {
  return `${mediaId}-${width}w.${FORMAT_EXT[format]}`;
}

export interface VariantRef {
  readonly name: string;
  readonly width: number;
  readonly format: ImageFormat;
}

const VARIANT_RE = /^([0-9a-z]+)-([1-9][0-9]{0,4})w\.(webp|avif|jpg|png)$/;
const EXT_TO_FORMAT: Record<string, ImageFormat> = { webp: "webp", avif: "avif", jpg: "jpeg", png: "png" };

/** media/variants/ の名前を解釈する。形式に合わない名前は無視する */
export function parseVariantName(name: string): ({ mediaId: string } & VariantRef) | null {
  const m = VARIANT_RE.exec(name);
  if (!m) return null;
  const format = EXT_TO_FORMAT[m[3] ?? ""];
  if (!format) return null;
  return { mediaId: m[1] ?? "", name, width: Number(m[2]), format };
}

/** media/ の画像名からメディアID（拡張子を除いた部分）を得る */
export function mediaIdOf(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** 表示に使う派生画像を選ぶ：対応形式の優先順（AVIF・WebP・JPEG・PNG）で、必要な幅以上の最小のもの */
export function chooseVariant(variants: readonly VariantRef[], wantWidth: number): VariantRef | null {
  const order: ImageFormat[] = ["avif", "webp", "jpeg", "png"];
  for (const f of order) {
    const same = variants.filter((v) => v.format === f).sort((a, b) => a.width - b.width);
    if (same.length === 0) continue;
    return same.find((v) => v.width >= wantWidth) ?? (same[same.length - 1] as VariantRef);
  }
  return null;
}

// ---------------------------------------------------------------------------

export interface EncodedImage {
  readonly bytes: Uint8Array;
  readonly info: ImageInfo;
}

export interface EncodedVariant extends EncodedImage {
  readonly width: number;
}

export type ProcessResult =
  | {
      ok: true;
      original: EncodedImage;
      variants: EncodedVariant[];
      /** 何をしたかの短い説明（取り込み結果の表示に使う） */
      notes: string[];
    }
  | { ok: false; message: string };

export interface ImageProcessor {
  process(bytes: Uint8Array, info: ImageInfo): Promise<ProcessResult>;
}

/** 書き出した結果を、取り込み時と同じ規則で検査する（形式・寸法・ヘッダー） */
function check(bytes: Uint8Array, want: ImageFormat, size: Size): ImageInfo | null {
  const r = inspectImage(bytes);
  if (!r.ok || r.info.format !== want || r.info.width !== size.width || r.info.height !== size.height) return null;
  return r.info;
}

type Source = ImageBitmap;

async function encode(src: Source, size: Size, format: ImageFormat, quality: number): Promise<Uint8Array | null> {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (format === "jpeg") {
    // JPEG は透過を持てない。透過部分は白にする
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size.width, size.height);
  }
  ctx.drawImage(src, 0, 0, size.width, size.height);
  const blob = await canvas.convertToBlob({ type: FORMAT_MIME[format], quality });
  // 対応しない形式は PNG で返ってくる。求めた形式でなければ使わない
  if (blob.type !== FORMAT_MIME[format]) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** 透過画素があるか（小さく縮めて調べる） */
function hasAlpha(src: Source): boolean {
  const w = Math.max(1, Math.min(256, src.width));
  const h = Math.max(1, Math.round((src.height * w) / src.width));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 255) < 255) return true;
  return false;
}

const fmtSize = (n: number) => (n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);

export const browserProcessor: ImageProcessor = {
  async process(bytes, info) {
    if (info.animated) {
      if (info.width > ORIGINAL_MAX_SIDE || info.height > ORIGINAL_MAX_SIDE || info.pixels > ORIGINAL_MAX_PIXELS)
        return {
          ok: false,
          message: `アニメーション画像は縮小できないため、${ORIGINAL_MAX_SIDE}px・${ORIGINAL_MAX_PIXELS / 10_000}万画素以内のものだけを取り込めます。`,
        };
      if (bytes.length > ORIGINAL_MAX_BYTES)
        return {
          ok: false,
          message: `アニメーション画像は圧縮できないため、${fmtSize(ORIGINAL_MAX_BYTES)} 以内のものだけを取り込めます。`,
        };
      return { ok: true, original: { bytes, info }, variants: [], notes: ["アニメーション画像のため加工せずに保存"] };
    }
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined")
      return { ok: false, message: "この環境では画像を最適化できません（OffscreenCanvas がありません）。" };
    let src: ImageBitmap;
    try {
      // 向き（Exif Orientation）を画素へ反映してから、メタデータを持たない形で書き出す
      src = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMAT_MIME[info.format] }), {
        imageOrientation: "from-image",
      });
    } catch (e) {
      return { ok: false, message: `画像を読み込めません：${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      const notes: string[] = [];
      const format = originalFormat(info.format);
      let size = fitWithin(src.width, src.height, ORIGINAL_MAX_SIDE, ORIGINAL_MAX_PIXELS);
      if (size.width !== src.width || size.height !== src.height)
        notes.push(`${src.width}×${src.height} → ${size.width}×${size.height} に縮小`);
      let out: Uint8Array | null = null;
      for (let step = 0; step <= SHRINK_MAX_STEPS && out === null; step++) {
        if (step > 0) {
          size = {
            width: Math.max(1, Math.floor(size.width * SHRINK_STEP)),
            height: Math.max(1, Math.floor(size.height * SHRINK_STEP)),
          };
        }
        const qualities = LOSSY.has(format) ? ORIGINAL_QUALITIES : [1];
        for (const q of qualities) {
          const b = await encode(src, size, format, q);
          if (b === null) return { ok: false, message: `${format.toUpperCase()} で書き出せません。` };
          if (b.length <= ORIGINAL_MAX_BYTES) {
            out = b;
            if (q !== qualities[0]) notes.push(`容量の上限に収めるため品質 ${Math.round(q * 100)} で保存`);
            break;
          }
        }
        if (out !== null && step > 0) notes.push(`容量の上限に収めるため ${size.width}×${size.height} に縮小`);
      }
      if (out === null)
        return { ok: false, message: `容量の上限（${fmtSize(ORIGINAL_MAX_BYTES)}）に収められませんでした。` };
      const oi = check(out, format, size);
      if (!oi) return { ok: false, message: "最適化した画像を検証できませんでした。" };
      if (format !== info.format) notes.push(`${info.format.toUpperCase()} を ${format.toUpperCase()} に変換`);
      notes.push(`メタデータを削除（${fmtSize(bytes.length)} → ${fmtSize(out.length)}）`);

      // 派生画像は、保存する原本と同じ画素から作る
      const fallback: ImageFormat = info.format === "jpeg" || !hasAlpha(src) ? "jpeg" : "png";
      const variants: EncodedVariant[] = [];
      for (const w of variantWidths(size.width)) {
        const vs: Size = { width: w, height: Math.max(1, Math.round((size.height * w) / size.width)) };
        for (const f of ["webp", fallback] as const) {
          const b = await encode(src, vs, f, VARIANT_QUALITY);
          if (b === null) continue;
          const vi = check(b, f, vs);
          if (vi) variants.push({ bytes: b, info: vi, width: w });
        }
      }
      return { ok: true, original: { bytes: out, info: oi }, variants, notes };
    } finally {
      src.close();
    }
  },
};
