/**
 * 削除前退避（仕様 19.1・34.5・35）。
 *
 * 1. 退避先はユーザーが選んだリポジトリ外のフォルダ。自動作成・自動探索しない。
 * 2. 選択フォルダと同一・配下・祖先の重なりを、ハンドルの同一性と相対解決で拒否する。
 *    判定 API がなければ「証明不能」として止める。
 * 3. 操作ごとに新しい退避フォルダを作り、作成直後に空であることを確かめる。
 * 4. 確認済みのファイルをバイト列のままコピーし、空フォルダも記録する。
 * 5. 相対パス・種類・サイズ・SHA-256・操作日時・アプリ版のマニフェストを作る（絶対パスは含めない）。
 * 6. 退避先を読み直して内容・集合を検証する。元側の再照合は呼び出し側が行う。
 *
 * 非保証：別ディスク・別媒体のバックアップや耐電断性ではない。OS 固有属性は保存しない。
 */
import { PROVISIONAL_MANIFEST_MAX_BYTES, PROVISIONAL_MANIFEST_MAX_PATH, TREE_MAX_ENTRIES } from "../core/budgets";
import { decodeUtf8Strict, encodeUtf8, sha256Hex } from "../core/bytes";
import { nowDateTime } from "../core/datetime";
import { enumerateTree, readAllBytes, resolvePath, writeNewFile, type Fingerprint, type TreeEntry } from "./tree";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "./types";

export const MANIFEST_FILE = "manifest.json";
export const FILES_DIR = "files";
export const MANIFEST_FORMAT = "kotono-cms-backup";

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly formatVersion: 1;
  readonly appVersion: string;
  readonly specVersion: string;
  readonly operation: "delete-article" | "delete-media";
  /** 記事フォルダからの相対の基点（例：`content/articles/k7m2x9q`） */
  readonly sourceBase: string;
  readonly articleId: string;
  readonly createdAt: string;
  readonly entries: readonly Fingerprint[];
}

export type OverlapCheck = { ok: true } | { ok: false; message: string };

/** 退避先と選択リポジトリの重なりを判定する（19.1 手順2・37.1 T24） */
export async function checkBackupTarget(backup: DirHandleLike, repo: DirHandleLike): Promise<OverlapCheck> {
  if (!backup.isSameEntry || !backup.resolve || !repo.resolve)
    return { ok: false, message: "このブラウザでは退避先とリポジトリの重なりを判定できないため、退避できません。" };
  try {
    if (await backup.isSameEntry(repo)) return { ok: false, message: "退避先に作業フォルダ自身は選べません。" };
    if ((await repo.resolve(backup)) !== null)
      return { ok: false, message: "退避先に作業フォルダの中のフォルダは選べません。リポジトリの外を選んでください。" };
    if ((await backup.resolve(repo)) !== null)
      return {
        ok: false,
        message: "退避先に作業フォルダを含むフォルダ（祖先）は選べません。リポジトリと重ならない場所を選んでください。",
      };
  } catch (e) {
    return { ok: false, message: `退避先の重なりを判定できません：${fsErrorMessage(classifyFsError(e))}` };
  }
  return { ok: true };
}

export interface BackupItem {
  /** 記事フォルダ内の相対パス */
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly handle: FileHandleLike | DirHandleLike;
}

export interface BackupParams {
  readonly backupRoot: DirHandleLike;
  readonly repoRoot: DirHandleLike;
  readonly operation: Manifest["operation"];
  readonly articleId: string;
  readonly items: readonly BackupItem[];
  readonly appVersion: string;
  readonly specVersion: string;
  readonly randomSuffix?: () => string;
}

export type BackupResult =
  | {
      ok: true;
      folderName: string;
      manifest: Manifest;
      totalBytes: number;
      verifiedAt: string;
    }
  /** folderName があれば、途中まで作成した退避フォルダが残っている（自動掃除しない：19.1 手順8） */
  | { ok: false; message: string; folderName: string | null };

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const defaultSuffix = () => Math.random().toString(36).slice(2, 6);

export async function createBackup(p: BackupParams): Promise<BackupResult> {
  const overlap = await checkBackupTarget(p.backupRoot, p.repoRoot);
  if (!overlap.ok) return { ok: false, message: overlap.message, folderName: null };

  // 3. 新しい退避フォルダ（既存は再利用しない）
  const folderName = `kotono-backup-${stamp()}-${p.articleId}-${(p.randomSuffix ?? defaultSuffix)()}`;
  try {
    await p.backupRoot.getDirectoryHandle(folderName);
    return {
      ok: false,
      message: `同名の退避フォルダ（${folderName}）が既にあります。もう一度試してください。`,
      folderName: null,
    };
  } catch (e) {
    const k = classifyFsError(e);
    if (k !== "not-found")
      return { ok: false, message: `退避先を確認できません：${fsErrorMessage(k)}`, folderName: null };
  }
  let opDir: DirHandleLike;
  try {
    opDir = await p.backupRoot.getDirectoryHandle(folderName, { create: true });
    for await (const c of opDir.values())
      return { ok: false, message: `作成した退避フォルダに想定外のエントリー（${c.name}）があります。`, folderName };
  } catch (e) {
    return {
      ok: false,
      message: `退避フォルダを作成できません：${fsErrorMessage(classifyFsError(e))}`,
      folderName: null,
    };
  }

  // 4. コピー（バイト列のまま）
  let filesDir: DirHandleLike;
  try {
    filesDir = await opDir.getDirectoryHandle(FILES_DIR, { create: true });
  } catch (e) {
    return { ok: false, message: `退避フォルダを作成できません：${fsErrorMessage(classifyFsError(e))}`, folderName };
  }
  const entries: Fingerprint[] = [];
  let totalBytes = 0;
  const sorted = [...p.items].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const it of sorted) {
    const parts = it.path.split("/");
    let d = filesDir;
    try {
      for (const seg of it.kind === "dir" ? parts : parts.slice(0, -1))
        d = await d.getDirectoryHandle(seg, { create: true });
    } catch (e) {
      return {
        ok: false,
        message: `${it.path} の退避先フォルダを作れません：${fsErrorMessage(classifyFsError(e))}`,
        folderName,
      };
    }
    if (it.kind === "dir") {
      entries.push({ path: it.path, kind: "dir", size: 0, sha256: null });
      continue;
    }
    const src = await readAllBytes(it.handle as FileHandleLike, Number.MAX_SAFE_INTEGER);
    if (!src.ok) return { ok: false, message: `${it.path} を読み取れません：${src.message}`, folderName };
    const w = await writeNewFile(d, parts.at(-1) ?? "", src.bytes);
    if (!w.ok) return { ok: false, message: `${it.path} を退避できません：${w.message}`, folderName };
    totalBytes += src.bytes.length;
    entries.push({ path: it.path, kind: "file", size: src.bytes.length, sha256: await sha256Hex(src.bytes) });
  }

  // 5. マニフェスト
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    formatVersion: 1,
    appVersion: p.appVersion,
    specVersion: p.specVersion,
    operation: p.operation,
    sourceBase: `content/articles/${p.articleId}`,
    articleId: p.articleId,
    createdAt: nowDateTime(),
    entries,
  };
  const manifestBytes = encodeUtf8(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBytes.length > PROVISIONAL_MANIFEST_MAX_BYTES)
    return { ok: false, message: "退避マニフェストが上限を超えます。", folderName };
  const mw = await writeNewFile(opDir, MANIFEST_FILE, manifestBytes);
  if (!mw.ok) return { ok: false, message: `マニフェストを書き込めません：${mw.message}`, folderName };

  // 6. 退避先の再読込検証
  const v = await verifyBackup(opDir, manifest);
  if (!v.ok) return { ok: false, message: `退避の検証に失敗しました：${v.message}`, folderName };
  return { ok: true, folderName, manifest, totalBytes, verifiedAt: nowDateTime() };
}

/** マニフェストの読込（未信頼入力として上限・形式を検査する：34.5・37.1 T23） */
export async function readManifest(
  opDir: DirHandleLike,
): Promise<{ ok: true; manifest: Manifest } | { ok: false; message: string }> {
  let h: FileHandleLike;
  try {
    h = await opDir.getFileHandle(MANIFEST_FILE);
  } catch (e) {
    return { ok: false, message: `マニフェストがありません：${fsErrorMessage(classifyFsError(e))}` };
  }
  const r = await readAllBytes(h, PROVISIONAL_MANIFEST_MAX_BYTES);
  if (!r.ok) return { ok: false, message: r.message };
  const dec = decodeUtf8Strict(r.bytes);
  if (!dec.ok) return { ok: false, message: "マニフェストが UTF-8 ではありません。" };
  let data: unknown;
  try {
    data = JSON.parse(dec.text);
  } catch {
    return { ok: false, message: "マニフェストの JSON が不正です。" };
  }
  const m = data as Partial<Manifest> | null;
  if (
    m === null ||
    typeof m !== "object" ||
    m.format !== MANIFEST_FORMAT ||
    m.formatVersion !== 1 ||
    !Array.isArray(m.entries) ||
    m.entries.length > TREE_MAX_ENTRIES
  )
    return { ok: false, message: "マニフェストの形式が不正です。" };
  for (const e of m.entries as unknown[]) {
    const f = e as Partial<Fingerprint> | null;
    if (
      f === null ||
      typeof f !== "object" ||
      typeof f.path !== "string" ||
      f.path.length > PROVISIONAL_MANIFEST_MAX_PATH ||
      f.path.split("/").some((s) => s === "" || s === "." || s === "..") ||
      (f.kind !== "file" && f.kind !== "dir") ||
      typeof f.size !== "number" ||
      (f.kind === "file" && (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)))
    )
      return { ok: false, message: "マニフェストの項目が不正です。" };
  }
  return { ok: true, manifest: m as Manifest };
}

/** 退避フォルダの集合・内容がマニフェストと一致するか（19.1 手順6） */
export async function verifyBackup(
  opDir: DirHandleLike,
  expected: Manifest,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const read = await readManifest(opDir);
  if (!read.ok) return read;
  if (JSON.stringify(read.manifest) !== JSON.stringify(expected))
    return { ok: false, message: "読み直したマニフェストが書き込んだ内容と一致しません。" };
  let filesDir: DirHandleLike;
  try {
    filesDir = await opDir.getDirectoryHandle(FILES_DIR);
  } catch (e) {
    return { ok: false, message: fsErrorMessage(classifyFsError(e)) };
  }
  const tree = await enumerateTree(filesDir);
  if (!tree.ok) return { ok: false, message: tree.message };
  // 親フォルダは自動で作られるため、記録した項目とその親だけを許す
  const expectedPaths = new Set(expected.entries.map((e) => e.path));
  const parents = new Set<string>();
  for (const e of expected.entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
  }
  for (const e of tree.entries) {
    if (!expectedPaths.has(e.path) && !(e.kind === "dir" && parents.has(e.path)))
      return { ok: false, message: `退避先に記録にないエントリーがあります：${e.path}` };
  }
  for (const f of expected.entries) {
    let h;
    try {
      h = await resolvePath(filesDir, f.path, f.kind);
    } catch {
      return { ok: false, message: `退避先に ${f.path} がありません。` };
    }
    if (f.kind === "dir") continue;
    const r = await readAllBytes(h as FileHandleLike, f.size);
    if (!r.ok) return { ok: false, message: `${f.path}：${r.message}` };
    if (r.bytes.length !== f.size || (await sha256Hex(r.bytes)) !== f.sha256)
      return { ok: false, message: `退避した ${f.path} の内容が一致しません。` };
  }
  return { ok: true };
}

/** 元側を再照合するための項目（列挙結果から作る） */
export function itemsFromTree(entries: readonly TreeEntry[]): BackupItem[] {
  return entries.map((e) => ({ path: e.path, kind: e.kind, handle: e.handle }));
}
