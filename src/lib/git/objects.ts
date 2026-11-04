/**
 * Git object の読み書き（loose・pack v2、SHA-1 形式のみ）。仕様 20.2・34.4。
 *
 * - 1 object の展開後 64 MiB、1 要求の展開累計 256 MiB を構築中に数える（34.4）。
 * - pack は .idx で位置を引き、該当範囲だけを読む。pack 全量をメモリに持たない。
 * - 書き込みは loose object の新規作成だけ。既存 object を上書き・削除しない。
 *   未参照 object を自動掃除しない（31.2）。
 */
import {
  GIT_OBJECT_MAX_BYTES,
  GIT_REQUEST_INFLATE_MAX_BYTES,
  PROVISIONAL_GIT_DELTA_MAX_DEPTH,
  PROVISIONAL_GIT_PACK_INDEX_MAX_BYTES,
} from "../core/budgets";
import { GitFs, GitFsError } from "./gitfs";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Uint8Array;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: "budget" | "corrupt" | "missing" | "unsupported" | "io" | "cancelled" = "corrupt",
  ) {
    super(message);
    this.name = "GitError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const OID_RE = /^[0-9a-f]{40}$/;

export async function sha1(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>)));
}

export function objectBytes(type: ObjectType, data: Uint8Array): Uint8Array {
  const head = enc.encode(`${type} ${data.length}\0`);
  const out = new Uint8Array(head.length + data.length);
  out.set(head, 0);
  out.set(data, head.length);
  return out;
}

export async function hashObject(type: ObjectType, data: Uint8Array): Promise<string> {
  return sha1(objectBytes(type, data));
}

/** 1 要求の展開累計（34.4） */
export class InflateBudget {
  used = 0;
  constructor(
    readonly maxTotal = GIT_REQUEST_INFLATE_MAX_BYTES,
    readonly maxObject = GIT_OBJECT_MAX_BYTES,
    readonly signal?: AbortSignal,
  ) {}
  add(n: number) {
    this.used += n;
    if (this.used > this.maxTotal)
      throw new GitError("Git object の展開量が1要求の上限（256 MiB）を超えました。", "budget");
  }
  check() {
    if (this.signal?.aborted) throw new GitError("中止しました。", "cancelled");
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  max: number,
  budget?: InflateBudget,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        await reader.cancel().catch(() => undefined);
        throw new GitError(`Git object の展開後サイズが上限（${Math.round(max / 1048576)} MiB）を超えます。`, "budget");
      }
      budget?.add(value.length);
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof GitError) throw e;
    throw new GitError("圧縮データを展開できません（破損の可能性）。", "corrupt");
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function inflate(bytes: Uint8Array, max: number, budget?: InflateBudget): Promise<Uint8Array> {
  const s = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return readStream(s as ReadableStream<Uint8Array>, max, budget);
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return readStream(s as ReadableStream<Uint8Array>, Number.MAX_SAFE_INTEGER);
}

const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

/** delta の適用（境界を検査する） */
export function applyDelta(base: Uint8Array, delta: Uint8Array, max: number): Uint8Array {
  let p = 0;
  const varint = () => {
    let r = 0;
    let shift = 1;
    for (;;) {
      if (p >= delta.length) throw new GitError("delta が途中で終わっています。");
      const c = delta[p++] as number;
      r += (c & 0x7f) * shift;
      shift *= 128;
      if (!(c & 0x80)) return r;
      if (shift > 2 ** 49) throw new GitError("delta のサイズ表記が不正です。");
    }
  };
  const srcSize = varint();
  const dstSize = varint();
  if (srcSize !== base.length) throw new GitError("delta の基準 object のサイズが一致しません。");
  if (dstSize > max) throw new GitError("delta の展開後サイズが上限を超えます。", "budget");
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++] as number;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += (delta[p++] ?? 0) * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) size += (delta[p++] ?? 0) * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new GitError("delta のコピー範囲が不正です。");
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op > 0) {
      if (p + op > delta.length || o + op > dstSize) throw new GitError("delta の挿入範囲が不正です。");
      out.set(delta.subarray(p, p + op), o);
      p += op;
      o += op;
    } else throw new GitError("delta に予約済みの命令があります。");
  }
  if (o !== dstSize) throw new GitError("delta の展開後サイズが一致しません。");
  return out;
}

interface PackIndex {
  readonly name: string;
  readonly fanout: Uint32Array;
  readonly oids: Uint8Array;
  readonly offsets: number[];
  /** 昇順の全 offset（各 entry の終端を求める） */
  readonly sorted: number[];
  readonly packSize: number;
}

function parseIdx(bytes: Uint8Array, name: string, packSize: number): PackIndex {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 + 1024 || dv.getUint32(0) !== 0xff744f63)
    throw new GitError(`pack index ${name} は未対応の形式（v1 等）です。`, "unsupported");
  if (dv.getUint32(4) !== 2) throw new GitError(`pack index ${name} の版が未対応です。`, "unsupported");
  const fanout = new Uint32Array(256);
  for (let i = 0; i < 256; i++) fanout[i] = dv.getUint32(8 + i * 4);
  const n = fanout[255] as number;
  const oidStart = 8 + 1024;
  const crcStart = oidStart + n * 20;
  const offStart = crcStart + n * 4;
  const largeStart = offStart + n * 4;
  if (largeStart + 40 > bytes.length) throw new GitError(`pack index ${name} が途中で終わっています。`);
  const offsets: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = dv.getUint32(offStart + i * 4);
    if (v & 0x80000000) {
      const li = v & 0x7fffffff;
      const at = largeStart + li * 8;
      if (at + 8 > bytes.length - 40) throw new GitError(`pack index ${name} の大きな offset が不正です。`);
      offsets[i] = dv.getUint32(at) * 2 ** 32 + dv.getUint32(at + 4);
    } else offsets[i] = v;
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  return { name, fanout, oids: bytes.subarray(oidStart, crcStart), offsets, sorted, packSize };
}

function findInIdx(idx: PackIndex, oid: Uint8Array): number {
  const first = oid[0] as number;
  let lo = first === 0 ? 0 : (idx.fanout[first - 1] as number);
  let hi = idx.fanout[first] as number;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    let c = 0;
    for (let i = 0; i < 20 && c === 0; i++) c = (idx.oids[mid * 20 + i] as number) - (oid[i] as number);
    if (c === 0) return idx.offsets[mid] as number;
    if (c < 0) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

function nextOffset(idx: PackIndex, off: number): number {
  let lo = 0;
  let hi = idx.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((idx.sorted[mid] as number) <= off) lo = mid + 1;
    else hi = mid;
  }
  return lo < idx.sorted.length ? (idx.sorted[lo] as number) : idx.packSize - 20;
}

/** 復号済み object の小さなキャッシュ（delta の基準の再展開を減らす）。容量で上限を持つ */
class ObjectCache {
  #map = new Map<string, GitObject>();
  #bytes = 0;
  constructor(readonly maxBytes = 32 * 1048576) {}
  get(k: string): GitObject | undefined {
    const v = this.#map.get(k);
    if (v) {
      this.#map.delete(k);
      this.#map.set(k, v);
    }
    return v;
  }
  set(k: string, v: GitObject) {
    if (v.data.length > this.maxBytes / 4) return;
    this.#map.set(k, v);
    this.#bytes += v.data.length;
    while (this.#bytes > this.maxBytes) {
      const first = this.#map.keys().next();
      if (first.done) break;
      const old = this.#map.get(first.value);
      this.#map.delete(first.value);
      this.#bytes -= old?.data.length ?? 0;
    }
  }
}

export class ObjectStore {
  #packs: PackIndex[] | null = null;
  #cache = new ObjectCache();

  constructor(readonly fs: GitFs) {}

  /** pack の一覧を読み直す（外部 Git の gc 後など） */
  reset() {
    this.#packs = null;
    this.#cache = new ObjectCache();
  }

  async #loadPacks(): Promise<PackIndex[]> {
    if (this.#packs) return this.#packs;
    const list = (await this.fs.list(".git/objects/pack", 10_000)) ?? [];
    const packs: PackIndex[] = [];
    for (const e of list) {
      if (e.kind !== "file" || !e.name.endsWith(".idx")) continue;
      const base = e.name.slice(0, -4);
      const packPath = `.git/objects/pack/${base}.pack`;
      const packSize = await this.fs.size(packPath).catch(() => -1);
      if (packSize < 0) continue; // pack 本体のない .idx は無視する（作成途中等）
      const bytes = await this.fs.readOrNull(
        `.git/objects/pack/${e.name}`,
        PROVISIONAL_GIT_PACK_INDEX_MAX_BYTES,
        "pack index",
      );
      if (!bytes) continue;
      packs.push(parseIdx(bytes, base, packSize));
    }
    this.#packs = packs;
    return packs;
  }

  async has(oid: string): Promise<boolean> {
    if (!OID_RE.test(oid)) return false;
    if ((await this.fs.kind(`.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`)) === "file") return true;
    const raw = unhex(oid);
    for (const p of await this.#loadPacks()) if (findInIdx(p, raw) >= 0) return true;
    return false;
  }

  async read(oid: string, budget = new InflateBudget()): Promise<GitObject> {
    if (!OID_RE.test(oid)) throw new GitError(`不正な object ID です（${oid}）。`);
    budget.check();
    const hit = this.#cache.get(oid);
    if (hit) return hit;
    const obj = (await this.#readLoose(oid, budget)) ?? (await this.#readPacked(oid, budget, 0));
    if (!obj) throw new GitError(`object ${oid} が見つかりません。`, "missing");
    this.#cache.set(oid, obj);
    return obj;
  }

  async #readLoose(oid: string, budget: InflateBudget): Promise<GitObject | null> {
    const path = `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    let raw: Uint8Array | null;
    try {
      // 圧縮後のサイズは展開後より小さいとは限らないため、展開後上限に余裕を足した値で読む
      raw = await this.fs.readOrNull(path, budget.maxObject + 1024 * 1024, "Git object");
    } catch (e) {
      if (e instanceof GitFsError && e.code === "too-large")
        throw new GitError(`object ${oid} が上限を超えています。`, "budget");
      throw new GitError(e instanceof Error ? e.message : String(e), "io");
    }
    if (!raw) return null;
    const full = await inflate(raw, budget.maxObject + 64, budget);
    const nul = full.indexOf(0);
    if (nul < 0 || nul > 32) throw new GitError(`object ${oid} の見出しが不正です。`);
    const m = /^(commit|tree|blob|tag) (\d+)$/.exec(dec.decode(full.subarray(0, nul)));
    if (!m) throw new GitError(`object ${oid} の種類が不正です。`);
    const data = full.subarray(nul + 1);
    if (Number(m[2]) !== data.length) throw new GitError(`object ${oid} のサイズが一致しません。`);
    if (data.length > budget.maxObject) throw new GitError(`object ${oid} が上限を超えています。`, "budget");
    const obj = { type: m[1] as ObjectType, data };
    if ((await hashObject(obj.type, obj.data)) !== oid) throw new GitError(`object ${oid} の内容がIDと一致しません。`);
    return obj;
  }

  async #readPacked(oid: string, budget: InflateBudget, depth: number): Promise<GitObject | null> {
    const raw = unhex(oid);
    for (const p of await this.#loadPacks()) {
      const off = findInIdx(p, raw);
      if (off >= 0) return this.#readAt(p, off, budget, depth);
    }
    return null;
  }

  async #readAt(p: PackIndex, off: number, budget: InflateBudget, depth: number): Promise<GitObject> {
    budget.check();
    if (depth > PROVISIONAL_GIT_DELTA_MAX_DEPTH)
      throw new GitError("pack の delta 連鎖が上限を超えています。", "budget");
    const key = `${p.name}@${off}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const end = nextOffset(p, off);
    if (end <= off || end > p.packSize - 20) throw new GitError(`pack ${p.name} の位置情報が不正です。`);
    if (end - off > budget.maxObject + 1024 * 1024)
      throw new GitError("pack 内の object が上限を超えています。", "budget");
    const bytes = await this.fs.slice(`.git/objects/pack/${p.name}.pack`, off, end);
    let i = 0;
    let c = bytes[i++] ?? 0;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 16;
    while (c & 0x80) {
      if (i >= bytes.length || shift > 2 ** 49) throw new GitError("pack の見出しが不正です。");
      c = bytes[i++] as number;
      size += (c & 0x7f) * shift;
      shift *= 128;
    }
    if (size > budget.maxObject) throw new GitError("pack 内の object が上限を超えています。", "budget");
    let obj: GitObject;
    if (type === 6 || type === 7) {
      let base: GitObject;
      if (type === 6) {
        c = bytes[i++] ?? 0;
        let rel = c & 0x7f;
        while (c & 0x80) {
          if (i >= bytes.length) throw new GitError("pack の delta 位置が不正です。");
          c = bytes[i++] as number;
          rel = (rel + 1) * 128 + (c & 0x7f);
        }
        if (rel <= 0 || rel > off) throw new GitError("pack の delta 位置が不正です。");
        base = await this.#readAt(p, off - rel, budget, depth + 1);
      } else {
        const baseOid = hex(bytes.subarray(i, i + 20));
        i += 20;
        const b = await this.#readPacked(baseOid, budget, depth + 1);
        base = b ?? (await this.read(baseOid, budget));
      }
      const delta = await inflate(bytes.subarray(i), size, budget);
      if (delta.length !== size) throw new GitError("pack の delta サイズが一致しません。");
      obj = { type: base.type, data: applyDelta(base.data, delta, budget.maxObject) };
    } else {
      const t = TYPES[type];
      if (!t) throw new GitError(`pack に未対応の object 種類（${type}）があります。`, "unsupported");
      const data = await inflate(bytes.subarray(i), size, budget);
      if (data.length !== size) throw new GitError("pack の object サイズが一致しません。");
      obj = { type: t, data };
    }
    this.#cache.set(key, obj);
    return obj;
  }

  /** loose object として書く。既にあれば書かない。書いた後に読み直して ID を確かめる */
  async write(type: ObjectType, data: Uint8Array): Promise<string> {
    const full = objectBytes(type, data);
    const oid = await sha1(full);
    if (await this.has(oid)) return oid;
    const path = `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    try {
      await this.fs.createNew(path, await deflate(full));
    } catch (e) {
      // 並行して同じ object が作られた場合は、内容の検証で受け入れる
      if (!(e instanceof GitFsError && e.code === "exists")) throw e;
    }
    const back = await this.#readLoose(oid, new InflateBudget());
    if (!back || back.type !== type) throw new GitError(`object ${oid} を書いた後に読み直せません。`, "io");
    return oid;
  }
}

export function text(bytes: Uint8Array): string {
  return dec.decode(bytes);
}
