/**
 * Git index の読み書き（v2・v3 を読み、v2 で書く）。仕様 20.2.1・34.5。
 *
 * - intent-to-add・skip-worktree・assume-unchanged・競合ステージを認識する。
 * - 拡張は Git の規則どおり、先頭が英大文字なら任意（書き戻し時に落としてよい）、
 *   それ以外は必須として扱い、未対応なら停止する（split index・sparse index 等）。
 * - v4（パス圧縮）は未対応として停止する。
 */
import { PROVISIONAL_GIT_INDEX_MAX_ENTRIES, PROVISIONAL_GIT_PATH_MAX } from "../core/budgets";
import { GitError, hex, sha1, unhex } from "./objects";
import { compareBytes } from "./model";

const enc = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

export interface IndexEntry {
  readonly ctimeS: number;
  readonly ctimeNs: number;
  readonly mtimeS: number;
  readonly mtimeNs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly oid: string;
  readonly stage: number;
  readonly assumeValid: boolean;
  readonly skipWorktree: boolean;
  readonly intentToAdd: boolean;
  readonly path: string;
}

export interface GitIndex {
  readonly version: number;
  readonly entries: IndexEntry[];
  /** 読み込んだ拡張の署名 */
  readonly extensions: string[];
  /** 末尾のチェックサム（内容の同一性の確認に使う） */
  readonly checksum: string;
}

export const EMPTY_INDEX_CHECKSUM = "(none)";

export function emptyIndex(): GitIndex {
  return { version: 2, entries: [], extensions: [], checksum: EMPTY_INDEX_CHECKSUM };
}

export async function parseIndex(bytes: Uint8Array, maxEntries = PROVISIONAL_GIT_INDEX_MAX_ENTRIES): Promise<GitIndex> {
  if (bytes.length < 32) throw new GitError("index が短すぎます。");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x44495243) throw new GitError("index の形式が不正です。");
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3) throw new GitError(`index の版（${version}）は未対応です。`, "unsupported");
  const count = dv.getUint32(8);
  if (count > maxEntries) throw new GitError("index のエントリー数が上限を超えています。", "budget");
  const body = bytes.subarray(0, bytes.length - 20);
  const checksum = hex(bytes.subarray(bytes.length - 20));
  if ((await sha1(body)) !== checksum) throw new GitError("index のチェックサムが一致しません（破損の可能性）。");
  const entries: IndexEntry[] = [];
  let p = 12;
  for (let i = 0; i < count; i++) {
    if (p + 62 > body.length) throw new GitError("index が途中で終わっています。");
    const u = (o: number) => dv.getUint32(p + o);
    const flags = dv.getUint16(p + 60);
    const extended = (flags & 0x4000) !== 0;
    if (extended && version < 3) throw new GitError("index の拡張フラグが不正です。");
    let q = p + 62;
    let ext = 0;
    if (extended) {
      ext = dv.getUint16(q);
      q += 2;
    }
    const nul = body.indexOf(0, q);
    if (nul < 0) throw new GitError("index のパスが終端していません。");
    if (nul - q > PROVISIONAL_GIT_PATH_MAX) throw new GitError("index のパスが長すぎます。", "budget");
    let path: string;
    try {
      path = strict.decode(body.subarray(q, nul));
    } catch {
      throw new GitError("index に UTF-8 でないパスがあります。", "unsupported");
    }
    entries.push({
      ctimeS: u(0),
      ctimeNs: u(4),
      mtimeS: u(8),
      mtimeNs: u(12),
      dev: u(16),
      ino: u(20),
      mode: u(24),
      uid: u(28),
      gid: u(32),
      size: u(36),
      oid: hex(body.subarray(p + 40, p + 60)),
      stage: (flags >> 12) & 3,
      assumeValid: (flags & 0x8000) !== 0,
      skipWorktree: (ext & 0x4000) !== 0,
      intentToAdd: (ext & 0x2000) !== 0,
      path,
    });
    const len = nul - p;
    p += Math.ceil((len + 1) / 8) * 8;
  }
  const extensions: string[] = [];
  while (p < body.length) {
    if (p + 8 > body.length) throw new GitError("index の拡張領域が不正です。");
    const sig = String.fromCharCode(...body.subarray(p, p + 4));
    const size = dv.getUint32(p + 4);
    if (p + 8 + size > body.length) throw new GitError("index の拡張領域が途中で終わっています。");
    extensions.push(sig);
    p += 8 + size;
  }
  return { version, entries, extensions, checksum };
}

/** 書き戻せない（必須の未対応）拡張 */
export function requiredExtensions(idx: GitIndex): string[] {
  return idx.extensions.filter((s) => !/^[A-Z]/.test(s));
}

function pathBytes(p: string) {
  return enc.encode(p);
}

export function sortEntries(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((a, b) => compareBytes(pathBytes(a.path), pathBytes(b.path)) || a.stage - b.stage);
}

/** v2 で書く。任意拡張（TREE 等）は落とす：Git は必要に応じて作り直す */
export async function serializeIndex(entries: readonly IndexEntry[]): Promise<Uint8Array> {
  const sorted = sortEntries([...entries]);
  const chunks: Uint8Array[] = [];
  const head = new Uint8Array(12);
  const hdv = new DataView(head.buffer);
  hdv.setUint32(0, 0x44495243);
  hdv.setUint32(4, 2);
  hdv.setUint32(8, sorted.length);
  chunks.push(head);
  for (const e of sorted) {
    if (e.skipWorktree || e.intentToAdd) throw new GitError("v2 で表せない index フラグがあります。", "unsupported");
    const pb = pathBytes(e.path);
    const len = 62 + pb.length;
    const total = Math.ceil((len + 1) / 8) * 8;
    const b = new Uint8Array(total);
    const dv = new DataView(b.buffer);
    const vals = [e.ctimeS, e.ctimeNs, e.mtimeS, e.mtimeNs, e.dev, e.ino, e.mode, e.uid, e.gid, e.size];
    vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
    b.set(unhex(e.oid), 40);
    const flags = (e.assumeValid ? 0x8000 : 0) | ((e.stage & 3) << 12) | Math.min(pb.length, 0xfff);
    dv.setUint16(60, flags);
    b.set(pb, 62);
    chunks.push(b);
  }
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const body = new Uint8Array(n + 20);
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.length;
  }
  body.set(unhex(await sha1(body.subarray(0, n))), n);
  return body;
}

/** CMS が書く作業ファイルの index エントリー（31.1：取得できない属性は 0、mode は通常ファイル） */
export function entryFor(path: string, oid: string, size: number, mtimeMs: number): IndexEntry {
  const s = Math.floor(mtimeMs / 1000);
  const ns = Math.floor((mtimeMs % 1000) * 1e6);
  return {
    ctimeS: s,
    ctimeNs: ns,
    mtimeS: s,
    mtimeNs: ns,
    dev: 0,
    ino: 0,
    mode: 0o100644,
    uid: 0,
    gid: 0,
    size: size >>> 0,
    oid,
    stage: 0,
    assumeValid: false,
    skipWorktree: false,
    intentToAdd: false,
    path,
  };
}

export function modeString(mode: number): string {
  return mode.toString(8);
}

/**
 * index の意味上の内容（パス・mode・object・stage）の要約。ネイティブ Git の
 * `git status` 等が stat 情報だけを書き換えた場合は同じ値になる。
 */
export async function indexDigest(idx: GitIndex): Promise<string> {
  const s = idx.entries.map((e) => `${e.path}\u0000${e.mode}\u0000${e.oid}\u0000${e.stage}`).join("\n");
  return sha1(new TextEncoder().encode(`${idx.extensions.filter((x) => !/^[A-Z]/.test(x)).join(",")}\n${s}`));
}
