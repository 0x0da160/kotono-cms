/**
 * 作業場所の zip による取り込み・書き出し（仕様 3.2 第38.2・38.3節、ADR-0006）。
 *
 * - zip は未信頼入力。パス（20.2.1 の Git 用パス検証と同じ規則）・重複・大文字小文字と
 *   Unicode 正規化での衝突・件数・合計サイズ・1 件のサイズ・圧縮率を検査し、1 つでも外れたら何も書かない。
 * - 展開先は新しい空の作業場所に限る（上書き展開しない）。完成マーカー（meta）は呼び出し側が最後に書く。
 * - zip の読み書きは fflate（固定版）。暗号化した書き出しは第39章の層で包む。
 */
import { unzipSync, zipSync, type Unzipped, type Zippable } from "fflate";
import { checkGitPath } from "../git/gitfs";
import { enumerateTree, readAllBytes, writeNewFile, type TreeLimits } from "../fs/tree";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "../fs/types";

const MiB = 1024 * 1024;

/** 取り込みの入口別予算（34.5 に追加。PROVISIONAL：TG09 で確定） */
export interface ZipLimits {
  readonly maxZipBytes: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  /** 展開後のサイズ ÷ 圧縮後のサイズの上限（zip 爆弾対策） */
  readonly maxRatio: number;
  readonly maxDepth: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: 1024 * MiB,
  maxEntries: 50_000,
  maxFileBytes: 64 * MiB,
  maxTotalBytes: 2048 * MiB,
  maxRatio: 200,
  maxDepth: 32,
};

/** 取り込み時に読み飛ばす OS の付属物（取り込んだ結果に表示する） */
const JUNK = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/];

export interface ZipPlanFile {
  readonly path: string;
  readonly size: number;
}

export type ZipPlan =
  | {
      readonly ok: true;
      readonly files: readonly ZipPlanFile[];
      readonly dirs: readonly string[];
      readonly skipped: readonly string[];
      /** zip の中身が 1 つのフォルダにまとまっていたとき、そのフォルダ名（外して展開する） */
      readonly strippedRoot: string | null;
      readonly totalBytes: number;
      readonly hasGit: boolean;
    }
  | { readonly ok: false; readonly message: string };

function foldKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

interface RawEntry {
  readonly name: string;
  readonly size: number;
  readonly originalSize: number;
}

/** zip の中央ディレクトリだけを見て、展開してよいかを判定する（中身は展開しない） */
export function planZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipPlan {
  if (bytes.length > limits.maxZipBytes)
    return { ok: false, message: `zip が大きすぎます（上限 ${Math.round(limits.maxZipBytes / MiB)} MiB）。` };
  const raw: RawEntry[] = [];
  let tooMany = false;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (raw.length >= limits.maxEntries) tooMany = true;
        else raw.push({ name: f.name, size: f.size, originalSize: f.originalSize });
        return false; // ここでは展開しない
      },
    });
  } catch {
    return { ok: false, message: "zip として読めません（壊れているか、対応しない形式です）。" };
  }
  if (tooMany)
    return { ok: false, message: `zip の項目数が上限（${limits.maxEntries.toLocaleString()}）を超えています。` };
  return planEntries(raw, limits);
}

export function planEntries(raw: readonly RawEntry[], limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipPlan {
  const skipped: string[] = [];
  const kept: RawEntry[] = [];
  for (const e of raw) {
    if (JUNK.some((re) => re.test(e.name))) skipped.push(e.name);
    else kept.push(e);
  }
  // 1 つのフォルダにまとまっていれば外す（デスクトップで「フォルダを圧縮」した zip）
  const tops = new Set(kept.map((e) => e.name.split("/")[0]));
  let strip: string | null = null;
  if (tops.size === 1 && kept.every((e) => e.name.includes("/"))) {
    const t = [...tops][0] ?? "";
    // 外すフォルダ名自体も検査する（`..`・空・絶対パスの先頭を「外す」ことで隠さない）
    if (t !== "content" && t !== ".git" && checkGitPath(t) === null) strip = t;
  }
  const files: ZipPlanFile[] = [];
  const dirs = new Set<string>();
  const seen = new Map<string, string>();
  let total = 0;
  for (const e of kept) {
    let name = e.name;
    if (strip !== null) name = name.slice(strip.length + 1);
    const isDir = name.endsWith("/");
    const path = isDir ? name.slice(0, -1) : name;
    if (path === "") continue;
    const bad = checkGitPath(path);
    if (bad) return { ok: false, message: `zip に使えないパスがあります：${bad}` };
    const depth = path.split("/").length;
    if (depth > limits.maxDepth)
      return { ok: false, message: `フォルダの深さが上限（${limits.maxDepth}）を超えています：${path}` };
    const key = foldKey(path);
    const prev = seen.get(key);
    if (prev !== undefined) {
      if (prev === path && isDir && dirs.has(path)) continue;
      return {
        ok: false,
        message:
          prev === path
            ? `zip に同じパスが重複しています：${path}`
            : `大文字小文字または Unicode の正規化で衝突するパスがあります：${prev} と ${path}`,
      };
    }
    seen.set(key, path);
    // 親フォルダをすべて記録する
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    if (isDir) {
      dirs.add(path);
      continue;
    }
    if (e.originalSize > limits.maxFileBytes)
      return {
        ok: false,
        message: `zip の中のファイルが大きすぎます：${path}（上限 ${Math.round(limits.maxFileBytes / MiB)} MiB）`,
      };
    if (e.originalSize > 1024 && e.originalSize / Math.max(1, e.size) > limits.maxRatio)
      return { ok: false, message: `圧縮率が異常に高いファイルがあります：${path}` };
    total += e.originalSize;
    if (total > limits.maxTotalBytes)
      return {
        ok: false,
        message: `展開後の合計が上限（${Math.round(limits.maxTotalBytes / MiB)} MiB）を超えています。`,
      };
    files.push({ path, size: e.originalSize });
  }
  // ファイルとフォルダが同じパスにある
  for (const f of files)
    if (dirs.has(f.path)) return { ok: false, message: `ファイルとフォルダが同じパスにあります：${f.path}` };
  if (files.length === 0) return { ok: false, message: "zip にファイルがありません。" };
  return {
    ok: true,
    files,
    dirs: [...dirs].sort(),
    skipped,
    strippedRoot: strip,
    totalBytes: total,
    hasGit: dirs.has(".git"),
  };
}

export type ImportResult =
  | { readonly ok: true; readonly files: number; readonly skipped: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly written: number };

/**
 * 計画どおりに空のフォルダへ展開する。各ファイルは新規作成・再読込で確かめる（writeNewFile）。
 * 途中で失敗したら止め、書いた件数を返す（自動で消さない：呼び出し側が不完全な作業場所として扱う）。
 */
export async function extractZip(
  bytes: Uint8Array,
  target: DirHandleLike,
  plan: Extract<ZipPlan, { ok: true }>,
): Promise<ImportResult> {
  const wanted = new Map<string, string>();
  for (const f of plan.files)
    wanted.set(plan.strippedRoot === null ? f.path : `${plan.strippedRoot}/${f.path}`, f.path);
  let data: Unzipped;
  try {
    data = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  } catch {
    return { ok: false, message: "zip の展開に失敗しました。", written: 0 };
  }
  const sizes = new Map(plan.files.map((f) => [f.path, f.size]));
  let written = 0;
  const dirCache = new Map<string, DirHandleLike>([["", target]]);
  const dirOf = async (path: string): Promise<DirHandleLike> => {
    const c = dirCache.get(path);
    if (c) return c;
    const i = path.lastIndexOf("/");
    const parent = await dirOf(i < 0 ? "" : path.slice(0, i));
    const d = await parent.getDirectoryHandle(i < 0 ? path : path.slice(i + 1), { create: true });
    dirCache.set(path, d);
    return d;
  };
  try {
    for (const d of plan.dirs) await dirOf(d);
  } catch (e) {
    return { ok: false, message: `フォルダを作れません：${fsErrorMessage(classifyFsError(e))}`, written };
  }
  for (const [zipName, path] of wanted) {
    const content = data[zipName];
    if (!content) return { ok: false, message: `zip から読めないファイルがあります：${path}`, written };
    // 宣言されたサイズと実際の展開結果が違えば止める（未信頼な見出し）
    if (content.length !== sizes.get(path))
      return { ok: false, message: `zip の見出しと中身の大きさが一致しません：${path}`, written };
    const i = path.lastIndexOf("/");
    let dir: DirHandleLike;
    try {
      dir = await dirOf(i < 0 ? "" : path.slice(0, i));
    } catch (e) {
      return { ok: false, message: `フォルダを作れません：${fsErrorMessage(classifyFsError(e))}`, written };
    }
    const r = await writeNewFile(dir, i < 0 ? path : path.slice(i + 1), content);
    if (!r.ok) return { ok: false, message: `${path}：${r.message}`, written };
    written++;
  }
  return { ok: true, files: written, skipped: plan.skipped };
}

/** 書き出しの予算。取り込みの予算に収まるものだけを書き出す（往復できることを保つ） */
export function exportTreeLimits(limits: ZipLimits = DEFAULT_ZIP_LIMITS): TreeLimits {
  return { maxEntries: limits.maxEntries, maxDepth: limits.maxDepth, maxBytes: limits.maxTotalBytes, maxMs: 120_000 };
}

/** 圧縮しても小さくならない形式は格納だけにする */
const STORED = /\.(jpe?g|png|webp|avif|gif|zip|pack|idx)$/i;

export type ExportResult = { ok: true; bytes: Uint8Array; files: number } | { ok: false; message: string };

/** 作業場所を `.git` を含めて zip にする（38.3） */
export async function exportZip(root: DirHandleLike, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ExportResult> {
  const tree = await enumerateTree(root, exportTreeLimits(limits));
  if (!tree.ok) return { ok: false, message: tree.message };
  const z: Zippable = {};
  let files = 0;
  for (const e of tree.entries) {
    const bad = checkGitPath(e.path);
    if (bad) return { ok: false, message: `書き出せない名前があります：${bad}` };
    if (e.kind === "dir") {
      z[`${e.path}/`] = new Uint8Array(0);
      continue;
    }
    const r = await readAllBytes(e.handle as FileHandleLike, limits.maxFileBytes);
    if (!r.ok) return { ok: false, message: `${e.path}：${r.message}` };
    z[e.path] = [r.bytes, { level: STORED.test(e.path) || e.path.startsWith(".git/objects/") ? 0 : 6 }];
    files++;
  }
  try {
    // 時刻は固定しない（fflate は既定で現在時刻を入れる）。中身の照合はハッシュで行う
    return { ok: true, bytes: zipSync(z), files };
  } catch {
    return { ok: false, message: "zip を作れませんでした。" };
  }
}
