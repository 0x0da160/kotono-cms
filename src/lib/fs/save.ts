/**
 * 保存契約（仕様 12.1・13.2・13.3・10.1・5.3）。
 *
 * - 保存直前にディスク版を基準版とバイト単位で比較し、違えば止める（12.1）。
 * - 検証済みの候補を書き込み、クローズ後に再読込して一致したときだけ成功とする（13.2）。
 * - 失敗後は実ファイルを読み直し、基準版・候補・第三の内容を識別する（13.3）。
 * - 検証前に元ファイルを空にする、失敗後に自動削除する等の破壊的回復をしない。
 *
 * 非保証：比較後から書き込みまでの外部プロセスとの競合は完全には防げない（12.1・35）。
 * `createWritable()` の書き込みはクローズ時に反映されるが、耐電断性は保証しない（13.2）。
 */
import { ARTICLE_MAX_BYTES } from "../core/budgets";
import { bytesEqual } from "../core/bytes";
import type { Problem } from "../core/article-doc";
import { INDEX_FILE } from "./repo";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike, type FsErrorKind } from "./types";

export type DiskState =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "wrong-kind" }
  | { kind: "too-large"; size: number }
  | { kind: "error"; errorKind: FsErrorKind; message: string };

export async function readDiskFile(handle: FileHandleLike): Promise<DiskState> {
  try {
    const file = await handle.getFile();
    if (file.size > ARTICLE_MAX_BYTES) return { kind: "too-large", size: file.size };
    return { kind: "bytes", bytes: new Uint8Array(await file.arrayBuffer()) };
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "not-found") return { kind: "missing" };
    return { kind: "error", errorKind: k, message: fsErrorMessage(k) };
  }
}

export async function readDiskArticle(
  articles: DirHandleLike,
  id: string,
): Promise<{ handle: FileHandleLike | null; state: DiskState }> {
  try {
    const dir = await articles.getDirectoryHandle(id);
    const handle = await dir.getFileHandle(INDEX_FILE);
    return { handle, state: await readDiskFile(handle) };
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "not-found") return { handle: null, state: { kind: "missing" } };
    if (k === "type-mismatch") return { handle: null, state: { kind: "wrong-kind" } };
    return { handle: null, state: { kind: "error", errorKind: k, message: fsErrorMessage(k) } };
  }
}

/** 書き込み権限を確認し、必要なら（ユーザー操作の中で）要求する */
export async function ensureWritePermission(root: DirHandleLike): Promise<boolean> {
  try {
    const q = (await root.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    if (q === "granted") return true;
    const r = (await root.requestPermission?.({ mode: "readwrite" })) ?? "denied";
    return r === "granted";
  } catch {
    return false;
  }
}

export type DiskClass = "base" | "candidate" | "third" | "missing" | "unreadable";

function classify(state: DiskState, base: Uint8Array | null, candidate: Uint8Array): DiskClass {
  if (state.kind === "missing") return "missing";
  if (state.kind !== "bytes") return state.kind === "error" ? "unreadable" : "third";
  if (bytesEqual(state.bytes, candidate)) return "candidate";
  if (base !== null && bytesEqual(state.bytes, base)) return "base";
  if (base === null && state.bytes.length === 0) return "base";
  return "third";
}

export type WriteOutcome =
  | { kind: "saved" }
  | {
      kind: "write-failed";
      phase: "open" | "write" | "close";
      errorKind: FsErrorKind;
      message: string;
      disk: DiskClass;
    }
  | { kind: "unknown"; message: string; disk: DiskClass };

/** 候補を書き込み・クローズし、再読込で候補との一致を確認する */
export async function writeAndVerify(
  handle: FileHandleLike,
  candidate: Uint8Array,
  base: Uint8Array | null,
): Promise<WriteOutcome> {
  let phase: "open" | "write" | "close" = "open";
  try {
    // exclusive モードは対応環境で使用する方針（12）。外部プロセスを含む完全排他ではない。
    const w = await handle.createWritable({ keepExistingData: false, mode: "exclusive" });
    try {
      phase = "write";
      await w.write(candidate);
      phase = "close";
      await w.close();
    } catch (e) {
      try {
        await w.abort();
      } catch {
        // abort の失敗は実状態の再読込で判定する
      }
      throw e;
    }
  } catch (e) {
    const k = classifyFsError(e);
    const disk = classify(await readDiskFile(handle), base, candidate);
    if (disk === "candidate") return { kind: "saved" };
    return { kind: "write-failed", phase, errorKind: k, message: fsErrorMessage(k), disk };
  }
  const after = await readDiskFile(handle);
  const disk = classify(after, base, candidate);
  if (disk === "candidate") return { kind: "saved" };
  return {
    kind: "unknown",
    disk,
    message:
      after.kind === "error"
        ? `保存後の再読み込みに失敗しました：${after.message}`
        : "保存後に読み直した内容が保存候補と一致しません。",
  };
}

// ---------------------------------------------------------------------------
// 既存記事の保存

export type SaveResult =
  | { kind: "saved"; bytes: Uint8Array; adoptedPrevious: boolean }
  | { kind: "external-change"; disk: DiskState }
  | { kind: "candidate-invalid"; problems: Problem[] }
  | { kind: "permission-denied" }
  | { kind: "write-failed"; message: string; disk: DiskClass; bytes: Uint8Array }
  | { kind: "unknown"; message: string; disk: DiskClass; bytes: Uint8Array };

export interface SaveExistingParams {
  readonly root: DirHandleLike;
  readonly articles: DirHandleLike;
  readonly id: string;
  /** 読み込み時のファイル全体（基準版） */
  readonly baseBytes: Uint8Array;
  /** 前回の失敗した試行の候補。ディスクと一致すれば重複書き込みせず成功へ遷移する（13.3） */
  readonly previousCandidate: Uint8Array | null;
  /** ディスク比較の後に候補を確定・検証する（13.2 手順4・5） */
  readonly buildCandidate: () => { ok: true; bytes: Uint8Array } | { ok: false; problems: Problem[] };
}

export async function saveExisting(p: SaveExistingParams): Promise<SaveResult> {
  if (!(await ensureWritePermission(p.root))) return { kind: "permission-denied" };
  const { handle, state } = await readDiskArticle(p.articles, p.id);
  if (handle === null || state.kind !== "bytes") return { kind: "external-change", disk: state };
  if (p.previousCandidate !== null && bytesEqual(state.bytes, p.previousCandidate)) {
    return { kind: "saved", bytes: p.previousCandidate, adoptedPrevious: true };
  }
  if (!bytesEqual(state.bytes, p.baseBytes)) return { kind: "external-change", disk: state };
  const c = p.buildCandidate();
  if (!c.ok) return { kind: "candidate-invalid", problems: c.problems };
  const out = await writeAndVerify(handle, c.bytes, p.baseBytes);
  if (out.kind === "saved") return { kind: "saved", bytes: c.bytes, adoptedPrevious: false };
  return { kind: out.kind, message: out.message, disk: out.disk, bytes: c.bytes };
}

// ---------------------------------------------------------------------------
// 新規記事の初回保存（10.1・5.3・13.4）

export type CreateResult =
  | { kind: "created"; bytes: Uint8Array; adoptedPrevious: boolean }
  | { kind: "exists" }
  | { kind: "not-owned"; message: string }
  | { kind: "permission-denied" }
  | { kind: "candidate-invalid"; problems: Problem[] }
  | { kind: "incomplete"; message: string; path: string; disk: DiskClass | "none"; bytes: Uint8Array };

export interface CreateParams {
  readonly root: DirHandleLike;
  readonly articles: DirHandleLike;
  readonly id: string;
  /** このセッションで作成した記事フォルダ（再試行時の所有判断に使う） */
  readonly ownedDirs: Set<string>;
  readonly previousCandidate: Uint8Array | null;
  readonly buildCandidate: () => { ok: true; bytes: Uint8Array } | { ok: false; problems: Problem[] };
}

/**
 * 所有確認の根拠：作成前に同名エントリーがないこと、作成直後のフォルダが空であること、
 * index.md が空であること。`create: true` でハンドルを得た事実だけを根拠にしない。
 * 確認と作成の間の外部作成は完全には排除できない（5.3・35：非保証）。
 */
export async function createArticle(p: CreateParams): Promise<CreateResult> {
  if (!(await ensureWritePermission(p.root))) return { kind: "permission-denied" };
  const path = `content/articles/${p.id}/`;
  let dir: DirHandleLike | null = null;
  let fresh = false;
  const owned = p.ownedDirs.has(p.id);
  try {
    dir = await p.articles.getDirectoryHandle(p.id);
    if (!owned) return { kind: "exists" };
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "type-mismatch") return { kind: "exists" };
    if (k !== "not-found") return { kind: "not-owned", message: `作成先を確認できません：${fsErrorMessage(k)}` };
  }
  // 候補の確定と検証は、ディスクへ何も作らないうちに一度だけ行う（13.2.2）
  const c = p.buildCandidate();
  if (!c.ok) return { kind: "candidate-invalid", problems: c.problems };
  if (dir === null) {
    try {
      dir = await p.articles.getDirectoryHandle(p.id, { create: true });
    } catch (e2) {
      return { kind: "not-owned", message: `記事フォルダを作成できません：${fsErrorMessage(classifyFsError(e2))}` };
    }
    fresh = true;
  }

  // 作成直後（または前回この画面で作成した）フォルダの中身を確認する
  let indexHandle: FileHandleLike | null = null;
  try {
    for await (const entry of dir.values()) {
      // 作成直後のフォルダは空であること。前回この画面で作成したフォルダは index.md だけを許す。
      if (!fresh && entry.kind === "file" && entry.name === INDEX_FILE) indexHandle = entry;
      else
        return {
          kind: "not-owned",
          message: `${path} に想定外のエントリー（${entry.name}）があります。書き込みを止めました。`,
        };
    }
    if (fresh) p.ownedDirs.add(p.id);
  } catch (e) {
    return { kind: "not-owned", message: `${path} の内容を確認できません：${fsErrorMessage(classifyFsError(e))}` };
  }

  try {
    if (indexHandle === null) indexHandle = await dir.getFileHandle(INDEX_FILE, { create: true });
  } catch (e) {
    return {
      kind: "incomplete",
      path,
      disk: "none",
      bytes: c.bytes,
      message: `index.md を作成できません：${fsErrorMessage(classifyFsError(e))}`,
    };
  }
  const existing = await readDiskFile(indexHandle);
  if (existing.kind === "bytes" && existing.bytes.length > 0) {
    if (p.previousCandidate !== null && bytesEqual(existing.bytes, p.previousCandidate)) {
      return { kind: "created", bytes: p.previousCandidate, adoptedPrevious: true };
    }
    if (bytesEqual(existing.bytes, c.bytes)) return { kind: "created", bytes: c.bytes, adoptedPrevious: true };
    return { kind: "not-owned", message: `${path}index.md に想定外の内容があります。上書きせずに止めました。` };
  }
  if (existing.kind !== "bytes") {
    return {
      kind: "incomplete",
      path,
      disk: "unreadable",
      bytes: c.bytes,
      message: "作成した index.md を確認できません。",
    };
  }
  const out = await writeAndVerify(indexHandle, c.bytes, null);
  if (out.kind === "saved") return { kind: "created", bytes: c.bytes, adoptedPrevious: false };
  return { kind: "incomplete", path, disk: out.disk, bytes: c.bytes, message: out.message };
}

/** ディスク変更操作を直列化するキュー（11.2） */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get busy(): boolean {
    return this.pending > 0;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending--;
    });
  }
}
