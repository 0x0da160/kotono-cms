/**
 * 記事の media/ フォルダ（仕様 17・17.3・18.2・34.3）。
 */
import { customAlphabet } from "nanoid";
import { ID_ALPHABET } from "../core/article-id";
import { ID_MAX_CANDIDATES, IMAGE_MAX_BYTES, MEDIA_ID_LENGTH, MiB } from "../core/budgets";
import { FORMAT_EXT, inspectImage, type ImageInfo, type Inspect } from "../core/image";
import { readAllBytes, writeNewFile } from "./tree";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "./types";

export const MEDIA_DIR = "media";

export interface MediaFile {
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly size: number;
}

export type MediaList = { ok: true; files: MediaFile[]; exists: boolean } | { ok: false; message: string };

export async function openMediaDir(article: DirHandleLike, create = false): Promise<DirHandleLike | null> {
  try {
    return await article.getDirectoryHandle(MEDIA_DIR, create ? { create: true } : undefined);
  } catch (e) {
    if (classifyFsError(e) === "not-found") return null;
    throw e;
  }
}

export async function listMedia(article: DirHandleLike): Promise<MediaList> {
  let dir: DirHandleLike | null;
  try {
    dir = await openMediaDir(article);
  } catch (e) {
    return { ok: false, message: `media/ を開けません：${fsErrorMessage(classifyFsError(e))}` };
  }
  if (!dir) return { ok: true, files: [], exists: false };
  const files: MediaFile[] = [];
  try {
    for await (const c of dir.values()) {
      if (c.kind === "directory") files.push({ name: c.name, kind: "dir", size: 0 });
      else files.push({ name: c.name, kind: "file", size: (await c.getFile()).size });
      if (files.length > 10_000) return { ok: false, message: "media/ のエントリーが多すぎます。" };
    }
  } catch (e) {
    return { ok: false, message: `media/ を読み取れません：${fsErrorMessage(classifyFsError(e))}` };
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { ok: true, files, exists: true };
}

export interface MediaLimits {
  readonly maxBytes: number;
  readonly maxPixels: number;
  readonly maxBatch: number;
}

/** 実効上限は設定値と固定安全上限の小さい方（4.3） */
export function effectiveLimits(cfg: {
  maxFileSizeMiB: number;
  maxPixelCount: number;
  maxBatchFiles: number;
}): MediaLimits {
  return {
    maxBytes: Math.min(cfg.maxFileSizeMiB * MiB, IMAGE_MAX_BYTES),
    maxPixels: Math.min(cfg.maxPixelCount, 40_000_000),
    maxBatch: cfg.maxBatchFiles,
  };
}

/** ブラウザでデコードできるか確かめる（実寸を返す）。単体試験では差し替える。 */
export type Decoder = (bytes: Uint8Array, mime: string) => Promise<{ width: number; height: number }>;

export const browserDecoder: Decoder = async (bytes, mime) => {
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  try {
    return { width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
};

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export type ValidateResult = { ok: true; info: ImageInfo; bytes: Uint8Array } | { ok: false; message: string };

/** 取り込み前の検証（17.1）：容量 → 形式・拡張子 → ヘッダー画素・アニメーション → デコード */
export async function validateImport(
  file: { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  limits: MediaLimits,
  decode: Decoder,
  timeoutMs: number,
): Promise<ValidateResult> {
  if (file.size > limits.maxBytes)
    return {
      ok: false,
      message: `容量（${(file.size / MiB).toFixed(1)} MiB）が上限（${(limits.maxBytes / MiB).toFixed(0)} MiB）を超えています。`,
    };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) return { ok: false, message: "読み込み中にファイルが変わりました。" };
  const r: Inspect = inspectImage(bytes, { fileName: file.name, declaredType: file.type, maxPixels: limits.maxPixels });
  if (!r.ok) return { ok: false, message: r.message };
  try {
    const d = await withTimeout(
      decode(bytes, `image/${r.info.format}`),
      timeoutMs,
      "画像の読み込みが時間上限を超えました。",
    );
    if (d.width !== r.info.width || d.height !== r.info.height)
      return { ok: false, message: "ヘッダーの寸法とデコード結果が一致しません。" };
  } catch (e) {
    return {
      ok: false,
      message: `画像として読み込めません（形式不正、またはこの環境が対応していない形式）：${e instanceof Error ? e.message : ""}`,
    };
  }
  return { ok: true, info: r.info, bytes };
}

const mediaId = customAlphabet(ID_ALPHABET, MEDIA_ID_LENGTH);

export type SaveMediaResult = { ok: true; name: string } | { ok: false; message: string; leftover: string | null };

/** 名前を決めて保存する（17：ランダムID＋小文字拡張子、全エントリーとの同名検査、最大11候補） */
export async function saveMedia(
  article: DirHandleLike,
  info: ImageInfo,
  bytes: Uint8Array,
  gen: () => string = mediaId,
): Promise<SaveMediaResult> {
  let dir: DirHandleLike | null;
  try {
    dir = await openMediaDir(article, true);
  } catch (e) {
    return { ok: false, message: `media/ を作成できません：${fsErrorMessage(classifyFsError(e))}`, leftover: null };
  }
  if (!dir) return { ok: false, message: "media/ を作成できません。", leftover: null };
  const existing = new Set<string>();
  try {
    for await (const c of dir.values()) existing.add(c.name.toLowerCase());
  } catch (e) {
    return { ok: false, message: `media/ を確認できません：${fsErrorMessage(classifyFsError(e))}`, leftover: null };
  }
  for (let i = 0; i < ID_MAX_CANDIDATES; i++) {
    const name = `${gen()}.${FORMAT_EXT[info.format]}`;
    if (existing.has(name)) continue;
    // 保存直前にも存在を再確認し、既存は上書きしない（17.1）
    const w = await writeNewFile(dir, name, bytes);
    if (w.ok) return { ok: true, name };
    if (!w.created && /既に存在/.test(w.message)) {
      existing.add(name);
      continue;
    }
    return { ok: false, message: w.message, leftover: w.created ? `media/${name}` : null };
  }
  return { ok: false, message: "画像の名前の候補がすべて既存のエントリーと重なりました。", leftover: null };
}

export type DisplayLoad =
  { ok: true; bytes: Uint8Array; info: ImageInfo; mime: string } | { ok: false; message: string };

/**
 * 表示前の検証（17.3）：取り込み時の検証を流用しない。存在・形式・サイズ・画素・固定上限を確認する。
 * アニメーションは自動再生しない。静止フレームを安全に取り出す方法を実装していないため表示しない。
 */
export async function loadForDisplay(article: DirHandleLike, name: string, maxBytes: number): Promise<DisplayLoad> {
  let h: FileHandleLike;
  try {
    const dir = await article.getDirectoryHandle(MEDIA_DIR);
    h = await dir.getFileHandle(name);
  } catch (e) {
    const k = classifyFsError(e);
    return { ok: false, message: k === "not-found" ? "ファイルがありません" : fsErrorMessage(k) };
  }
  const r = await readAllBytes(h, maxBytes);
  if (!r.ok) return { ok: false, message: r.missing ? "ファイルがありません" : "表示の上限を超えています" };
  const ins = inspectImage(r.bytes, { fileName: name });
  if (!ins.ok) return { ok: false, message: ins.message };
  if (ins.info.animated) return { ok: false, message: "アニメーション画像は表示しません" };
  return { ok: true, bytes: r.bytes, info: ins.info, mime: `image/${ins.info.format}` };
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return `data:${mime};base64,${btoa(bin)}`;
}
