/**
 * リポジトリと記事フォルダ（仕様 3・4・23・24・25.2）。
 */
import { isValidArticleId, ID_DEFAULT_LENGTH, ID_MAX_LENGTH, ID_MIN_LENGTH } from "../core/article-id";
import {
  ARTICLE_MAX_BYTES,
  FRONTMATTER_MAX_BYTES,
  METADATA_IO_CONCURRENCY,
  PROVISIONAL_CONFIG_MAX_BYTES,
  PROVISIONAL_CONFIG_MAX_DEPTH,
  PROVISIONAL_SCAN_MAX_ENTRIES,
  PROVISIONAL_SCAN_MAX_MS,
} from "../core/budgets";
import { decodeUtf8Prefix, decodeUtf8Strict } from "../core/bytes";
import { validateStandard, type StandardValues } from "../core/schema";
import type { SlugEntry } from "../core/slug";
import { splitDocument, splitErrorMessage } from "../core/split";
import { parseFrontmatter } from "../core/yaml-doc";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "./types";

export const CONTENT_DIR = "content";
export const ARTICLES_DIR = "articles";
export const ARTICLES_PATH = "content/articles/";
export const CONFIG_FILE = "cms.config.json";
export const INDEX_FILE = "index.md";

// ---------------------------------------------------------------------------
// 初回フォルダ準備（3.1）

export type ArticlesDirState =
  | { kind: "ok"; dir: DirHandleLike }
  | { kind: "missing"; missing: "content" | "articles" }
  | { kind: "error"; message: string };

async function childDir(
  parent: DirHandleLike,
  name: string,
  path: string,
): Promise<DirHandleLike | "missing" | { error: string }> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "not-found") return "missing";
    if (k === "type-mismatch")
      return { error: `${path} の位置に同名の通常ファイルがあります。置き換えずに停止しました。` };
    return { error: `${path} を開けません：${fsErrorMessage(k)}` };
  }
}

/** 閲覧のために無断作成しない。存在しなければ作成予定パスを返す。 */
export async function openArticlesDir(root: DirHandleLike): Promise<ArticlesDirState> {
  const content = await childDir(root, CONTENT_DIR, "content/");
  if (content === "missing") return { kind: "missing", missing: "content" };
  if ("error" in content) return { kind: "error", message: content.error };
  const articles = await childDir(content, ARTICLES_DIR, ARTICLES_PATH);
  if (articles === "missing") return { kind: "missing", missing: "articles" };
  if ("error" in articles) return { kind: "error", message: articles.error };
  return { kind: "ok", dir: articles };
}

/** 確認後に content/articles/ を作成する（3.1）。既存の同名ファイルは置き換えない。 */
export async function createArticlesDir(root: DirHandleLike): Promise<ArticlesDirState> {
  try {
    const content = await root.getDirectoryHandle(CONTENT_DIR, { create: true });
    const articles = await content.getDirectoryHandle(ARTICLES_DIR, { create: true });
    return { kind: "ok", dir: articles };
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "type-mismatch") {
      return {
        kind: "error",
        message: "content/ または content/articles/ の位置に同名の通常ファイルがあるため作成できません。",
      };
    }
    return { kind: "error", message: `content/articles/ を作成できません：${fsErrorMessage(k)}` };
  }
}

// ---------------------------------------------------------------------------
// 設定ファイル（4）

export interface RepoConfig {
  /** default：ファイルなし。invalid：全体不正（新規作成・取り込み・設定書き込みを停止） */
  readonly state: "default" | "ok" | "invalid";
  readonly idLength: number;
  readonly idLengthValid: boolean;
  readonly mediaValid: boolean;
  /** 4.1 の取り込み上限（ユーザー設定値。固定安全上限との小さい方を使う：4.3） */
  readonly media: { readonly maxFileSizeMiB: number; readonly maxPixelCount: number; readonly maxBatchFiles: number };
  readonly errors: string[];
  readonly warnings: string[];
}

const DEFAULT_CONFIG: RepoConfig = {
  state: "default",
  idLength: ID_DEFAULT_LENGTH,
  idLengthValid: true,
  mediaValid: true,
  media: { maxFileSizeMiB: 20, maxPixelCount: 40_000_000, maxBatchFiles: 50 },
  errors: [],
  warnings: [],
};

function jsonDepth(v: unknown, limit: number, depth = 1): boolean {
  if (depth > limit) return false;
  if (Array.isArray(v)) return v.every((x) => jsonDepth(x, limit, depth + 1));
  if (v !== null && typeof v === "object") return Object.values(v).every((x) => jsonDepth(x, limit, depth + 1));
  return true;
}

const isInt = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function parseConfig(text: string): RepoConfig {
  const invalid = (msg: string): RepoConfig => ({
    ...DEFAULT_CONFIG,
    state: "invalid",
    idLengthValid: false,
    mediaValid: false,
    errors: [msg],
  });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return invalid("cms.config.json の JSON 構文が不正です。外部エディタで修正してください。");
  }
  if (!jsonDepth(data, PROVISIONAL_CONFIG_MAX_DEPTH)) return invalid("cms.config.json の入れ子が上限を超えています。");
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return invalid("cms.config.json のルートはオブジェクトにしてください。");
  const obj = data as Record<string, unknown>;
  const warnings: string[] = [];
  const errors: string[] = [];
  if ("schemaVersion" in obj && obj["schemaVersion"] !== 1) {
    return invalid(`未知の schemaVersion（${String(obj["schemaVersion"])}）です。外部エディタで修正してください。`);
  }
  for (const k of Object.keys(obj)) {
    if (!["schemaVersion", "articleId", "media"].includes(k))
      warnings.push(`未知の設定キー「${k}」は無視します（ファイルからは削除しません）。`);
  }
  let idLength = ID_DEFAULT_LENGTH;
  let idLengthValid = true;
  if ("articleId" in obj) {
    const a = obj["articleId"];
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      idLengthValid = false;
      errors.push("articleId はオブジェクトにしてください。新規作成・複製を停止します。");
    } else {
      const ar = a as Record<string, unknown>;
      for (const k of Object.keys(ar))
        if (k !== "length") warnings.push(`未知の設定キー「articleId.${k}」は無視します。`);
      if ("length" in ar) {
        if (isInt(ar["length"], ID_MIN_LENGTH, ID_MAX_LENGTH)) idLength = ar["length"] as number;
        else {
          idLengthValid = false;
          errors.push(
            `articleId.length は ${ID_MIN_LENGTH}〜${ID_MAX_LENGTH} の整数にしてください。新規作成・複製を停止します。`,
          );
        }
      }
    }
  }
  let mediaValid = true;
  const media = { ...DEFAULT_CONFIG.media };
  if ("media" in obj) {
    const m = obj["media"];
    if (m === null || typeof m !== "object" || Array.isArray(m)) mediaValid = false;
    else {
      const mr = m as Record<string, unknown>;
      const ranges: Record<string, [number, number]> = {
        maxFileSizeMiB: [1, 100],
        maxPixelCount: [1, 100_000_000],
        maxBatchFiles: [1, 100],
      };
      for (const [k, v] of Object.entries(mr)) {
        const r = ranges[k];
        if (!r) warnings.push(`未知の設定キー「media.${k}」は無視します。`);
        else if (!isInt(v, r[0], r[1])) mediaValid = false;
        else media[k as keyof typeof media] = v as number;
      }
    }
    if (!mediaValid) errors.push("media の設定が不正です。メディア取り込みを停止します。");
  }
  return { state: "ok", idLength, idLengthValid, mediaValid, media, errors, warnings };
}

export async function readConfig(root: DirHandleLike): Promise<RepoConfig> {
  let handle: FileHandleLike;
  try {
    handle = await root.getFileHandle(CONFIG_FILE);
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "not-found") return DEFAULT_CONFIG;
    return {
      ...DEFAULT_CONFIG,
      state: "invalid",
      idLengthValid: false,
      mediaValid: false,
      errors: [`cms.config.json を読めません：${fsErrorMessage(k)}`],
    };
  }
  try {
    const file = await handle.getFile();
    // 全文読込前にバイト上限を確認する（34.5）
    if (file.size > PROVISIONAL_CONFIG_MAX_BYTES) {
      return {
        ...DEFAULT_CONFIG,
        state: "invalid",
        idLengthValid: false,
        mediaValid: false,
        errors: ["cms.config.json が上限サイズを超えています。"],
      };
    }
    const d = decodeUtf8Strict(new Uint8Array(await file.slice(0, PROVISIONAL_CONFIG_MAX_BYTES).arrayBuffer()));
    if (!d.ok)
      return {
        ...DEFAULT_CONFIG,
        state: "invalid",
        idLengthValid: false,
        mediaValid: false,
        errors: ["cms.config.json が不正な UTF-8 です。"],
      };
    return parseConfig(d.text);
  } catch (e) {
    return {
      ...DEFAULT_CONFIG,
      state: "invalid",
      idLengthValid: false,
      mediaValid: false,
      errors: [`cms.config.json を読めません：${fsErrorMessage(classifyFsError(e))}`],
    };
  }
}

export function canCreateArticles(c: RepoConfig): string | null {
  if (c.state === "invalid") return "設定ファイルが不正なため、新規作成を停止しています。";
  if (!c.idLengthValid) return "記事IDの長さの設定が不正なため、新規作成を停止しています。";
  return null;
}

/** 4.2：全体不正またはメディア設定の不正では取り込みだけを止める */
export function canImportMedia(c: RepoConfig): string | null {
  if (c.state === "invalid") return "設定ファイルが不正なため、画像の取り込みを停止しています。";
  if (!c.mediaValid) return "media の設定が不正なため、画像の取り込みを停止しています。";
  return null;
}

// ---------------------------------------------------------------------------
// 一覧（23・24・25.2）：frontmatter の有界読込

export type EntryKind = "article" | "incomplete" | "unreadable" | "not-directory";

export interface ListEntry {
  /** 記事フォルダ名（記事ID） */
  readonly dirName: string;
  readonly kind: EntryKind;
  readonly values: StandardValues;
  /** 一意性検査のために slug を安全に取得できたか */
  readonly slugKnown: boolean;
  /** 保存を止める検証エラー・読み取りエラー */
  readonly problems: string[];
  /** 読み取り専用（ID 不正・上限超過・非対応形式等） */
  readonly readOnly: boolean;
  readonly size?: number;
}

export interface ScanResult {
  readonly entries: ListEntry[];
  /** 列挙が予算内で完了したか。未完了を全件として扱わない。 */
  readonly complete: boolean;
  readonly incompleteReason?: string;
  readonly scannedAt: number;
}

/** 区切りまでの有界読込に使う先頭バイト数：BOM・開始区切り・frontmatter 上限・閉じ区切り */
const PREFIX_BYTES = 3 + 5 + FRONTMATTER_MAX_BYTES + 7;

export async function readEntryMeta(dir: DirHandleLike): Promise<ListEntry> {
  const dirName = dir.name;
  const idOk = isValidArticleId(dirName);
  const base = { dirName, values: {}, slugKnown: false, readOnly: !idOk };
  const idProblem = idOk
    ? []
    : ["フォルダ名が記事IDの形式（7〜32文字の小文字Base32）ではありません。閲覧・コピーのみ可能です。"];
  let handle: FileHandleLike;
  try {
    handle = await dir.getFileHandle(INDEX_FILE);
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "not-found")
      return {
        ...base,
        slugKnown: true,
        kind: "incomplete",
        problems: [...idProblem, "index.md がありません（不完全な記事）。"],
      };
    if (k === "type-mismatch")
      return {
        ...base,
        slugKnown: true,
        kind: "incomplete",
        problems: [...idProblem, "index.md の位置にフォルダがあります。"],
      };
    return { ...base, kind: "unreadable", problems: [...idProblem, `index.md を開けません：${fsErrorMessage(k)}`] };
  }
  try {
    const file = await handle.getFile();
    const truncated = file.size > PREFIX_BYTES;
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, PREFIX_BYTES)).arrayBuffer());
    const tooLarge = file.size > ARTICLE_MAX_BYTES;
    const problems = [...idProblem];
    if (tooLarge) problems.push("記事ファイルが 5 MiB を超えているため、CMS では編集できません。");
    const d = decodeUtf8Prefix(bytes, truncated);
    if (!d.ok) {
      return {
        ...base,
        kind: "article",
        readOnly: true,
        size: file.size,
        problems: [...problems, "不正な UTF-8 を含みます。"],
      };
    }
    const split = splitDocument(d.text);
    if (!split.ok) {
      return {
        ...base,
        kind: "article",
        readOnly: base.readOnly || tooLarge || split.code === "frontmatter-too-large",
        size: file.size,
        problems: [...problems, splitErrorMessage(split.code)],
      };
    }
    const parse = parseFrontmatter(split.frontmatter);
    if (!parse.ok) {
      const unsupported = parse.problems.some((p) => p.kind === "unsupported" || p.kind === "budget");
      return {
        ...base,
        kind: "article",
        readOnly: base.readOnly || tooLarge || unsupported,
        size: file.size,
        problems: [...problems, ...parse.problems.map((p) => p.message)],
      };
    }
    const schema = validateStandard(parse.root, dirName);
    // 型付きで取得できた slug は、不正記事でも重複検査に含める（7.1）
    return {
      dirName,
      kind: "article",
      values: schema.values,
      slugKnown: true,
      readOnly: base.readOnly || tooLarge || schema.errors.some((e) => e.code === "id-format"),
      size: file.size,
      problems: [...problems, ...schema.errors.map((e) => e.message)],
    };
  } catch (e) {
    return {
      ...base,
      kind: "unreadable",
      problems: [...idProblem, `index.md を読めません：${fsErrorMessage(classifyFsError(e))}`],
    };
  }
}

/** 上限付きの並列実行 */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function scanArticles(
  articles: DirHandleLike,
  onProgress?: (done: number, total: number) => void,
  now: () => number = Date.now,
): Promise<ScanResult> {
  const started = now();
  const dirs: DirHandleLike[] = [];
  const others: ListEntry[] = [];
  let complete = true;
  let incompleteReason: string | undefined;
  let count = 0;
  try {
    for await (const entry of articles.values()) {
      if (++count > PROVISIONAL_SCAN_MAX_ENTRIES || now() - started > PROVISIONAL_SCAN_MAX_MS) {
        complete = false;
        incompleteReason = "記事フォルダの列挙が上限に達したため、一覧は一部だけです。";
        break;
      }
      if (entry.kind === "directory") dirs.push(entry);
      else
        others.push({
          dirName: entry.name,
          kind: "not-directory",
          values: {},
          slugKnown: true,
          readOnly: true,
          problems: ["記事フォルダではないファイルです（無視します）。"],
        });
    }
  } catch (e) {
    complete = false;
    incompleteReason = `記事フォルダの列挙に失敗しました：${fsErrorMessage(classifyFsError(e))}`;
  }
  let done = 0;
  const metas = await pool(dirs, METADATA_IO_CONCURRENCY, async (d) => {
    const m = await readEntryMeta(d);
    onProgress?.(++done, dirs.length);
    return m;
  });
  return {
    entries: [...metas, ...others],
    complete,
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
    scannedAt: now(),
  };
}

/** 一意性検査用の slug 一覧。抽出不能・列挙未完了は「検査不能」として残す（7.1）。 */
export function slugEntries(scan: ScanResult): SlugEntry[] {
  const out: SlugEntry[] = [];
  for (const e of scan.entries) {
    if (e.kind === "not-directory" || e.kind === "incomplete") continue;
    if (!e.slugKnown) out.push({ id: e.dirName, slug: null, uncheckable: true });
    else out.push({ id: e.dirName, slug: typeof e.values.slug === "string" ? e.values.slug : "" });
  }
  if (!scan.complete) out.push({ id: "（未列挙の記事）", slug: null, uncheckable: true });
  return out;
}

// ---------------------------------------------------------------------------
// 記事の全文読込

export type ReadArticle =
  | { kind: "ok"; bytes: Uint8Array; lastModified: number; readAt: number }
  | { kind: "too-large"; size: number }
  | { kind: "error"; message: string; errorKind: ReturnType<typeof classifyFsError> };

export async function getArticleFile(articles: DirHandleLike, id: string): Promise<FileHandleLike> {
  const dir = await articles.getDirectoryHandle(id);
  return dir.getFileHandle(INDEX_FILE);
}

export async function readArticle(articles: DirHandleLike, id: string): Promise<ReadArticle> {
  try {
    const file = await (await getArticleFile(articles, id)).getFile();
    if (file.size > ARTICLE_MAX_BYTES) return { kind: "too-large", size: file.size };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > ARTICLE_MAX_BYTES) return { kind: "too-large", size: bytes.length };
    return { kind: "ok", bytes, lastModified: file.lastModified, readAt: Date.now() };
  } catch (e) {
    const k = classifyFsError(e);
    return { kind: "error", errorKind: k, message: fsErrorMessage(k) };
  }
}
