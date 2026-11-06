/**
 * 暗号化する DirHandleLike（仕様 3.2 第39.4節、ADR-0006 第7.3・7.4節）。
 *
 * OPFS のハンドルを包み、上の層（記事・画像・Git）には平文の名前と内容を見せる。
 *
 * - 内容：ファイルごと・書き込みごとに乱数の IV で AES-GCM。形式は `KTN1`・版（1 バイト）・IV（12）・暗号文・タグ（16）。
 *   追加認証データは「範囲・作業場所 ID・平文の相対パス」。別のパスへの差し替えを検出する。
 *   中身が 0 バイトの実ファイルは「作成直後の空ファイル」として平文 0 バイトに見せる（writeNewFile の空確認のため）。
 * - 名前：区間ごとに決定的に暗号化する。IV = HMAC(nameIv, 範囲・親の平文パス・名前) の先頭 12 バイト。
 *   名前は 16 バイト単位に詰めてから暗号化し、IV と合わせて小文字の base32 にする。対応表は持たない。
 *   暗号化した名前が長すぎるときは `~<HMAC>` を名前にし、同じフォルダの `~<HMAC>.n` に暗号化した名前を置く。
 * - 認証できない名前・内容は「読めない項目」として上の層に渡さない。消さない（39.3）。
 * - 大きさ：暗号文の長さから平文の長さを計算する（形式の固定長 33 バイトを引く）。
 */
import type {
  BlobLike,
  DirHandleLike,
  FileHandleLike,
  FileLike,
  PermissionMode,
  PermissionStateLike,
  WritableLike,
} from "../fs/types";
import { aesDecrypt, aesEncrypt, base32, fromBase32, hmac, type DataKeys } from "./keys";

const MAGIC = [0x4b, 0x54, 0x4e, 0x31]; // "KTN1"
const VERSION = 1;
export const CONTENT_OVERHEAD = 4 + 1 + 12 + 16;
/** これより長い暗号化名は置き換える（OPFS の名前の上限は段階 0 で測る。255 バイト前後の見込み） */
export const MAX_ENCRYPTED_NAME = 200;
const LONG_PREFIX = "~";
const SIDE_SUFFIX = ".n";

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

function domError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function pad16(b: Uint8Array): Uint8Array {
  const n = Math.ceil((b.length + 1) / 16) * 16;
  const out = new Uint8Array(n);
  out.set(b);
  out[b.length] = 0x80;
  return out;
}

function unpad16(b: Uint8Array): Uint8Array | null {
  let i = b.length - 1;
  while (i >= 0 && b[i] === 0) i--;
  if (i < 0 || b[i] !== 0x80) return null;
  return b.slice(0, i);
}

/** 暗号化の文脈。範囲（作業場所か退避か）と作業場所の ID を追加認証データ・IV に入れる */
export interface EncContext {
  readonly keys: DataKeys;
  readonly scope: string;
  readonly workspaceId: string;
  /** 読めない項目を見つけたときの通知（件数の表示に使う） */
  readonly onUnreadable?: (where: string) => void;
}

function nameInput(ctx: EncContext, parent: string, name: string): Uint8Array {
  return te.encode(`${ctx.scope}\u0000${ctx.workspaceId}\u0000${parent}\u0000${name}`);
}

export async function encryptName(
  ctx: EncContext,
  parent: string,
  name: string,
): Promise<{ name: string; side: Uint8Array | null }> {
  const iv = (await hmac(ctx.keys.nameIv, nameInput(ctx, parent, name))).slice(0, 12);
  const aad = te.encode(`${ctx.scope}\u0000${ctx.workspaceId}\u0000${parent}`);
  const sealed = await aesEncrypt(ctx.keys.name, pad16(te.encode(name)), aad, iv);
  const enc = base32(sealed);
  if (enc.length <= MAX_ENCRYPTED_NAME) return { name: enc, side: null };
  const h = await hmac(ctx.keys.nameLong, nameInput(ctx, parent, name));
  return { name: `${LONG_PREFIX}${base32(h.slice(0, 20))}`, side: sealed };
}

async function decryptSealedName(ctx: EncContext, parent: string, sealed: Uint8Array): Promise<string | null> {
  const aad = te.encode(`${ctx.scope}\u0000${ctx.workspaceId}\u0000${parent}`);
  const p = await aesDecrypt(ctx.keys.name, sealed, aad);
  if (!p) return null;
  const u = unpad16(p);
  if (!u) return null;
  try {
    return td.decode(u);
  } catch {
    return null;
  }
}

function contentAad(ctx: EncContext, path: string): Uint8Array {
  return te.encode(`${ctx.scope}\u0000${ctx.workspaceId}\u0000content\u0000${path}`);
}

export async function sealContent(ctx: EncContext, path: string, plain: Uint8Array): Promise<Uint8Array> {
  const s = await aesEncrypt(ctx.keys.data, plain, contentAad(ctx, path));
  const out = new Uint8Array(5 + s.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out.set(s, 5);
  return out;
}

export async function openContent(ctx: EncContext, path: string, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length === 0) return new Uint8Array(0);
  if (sealed.length < CONTENT_OVERHEAD) return null;
  for (let i = 0; i < 4; i++) if (sealed[i] !== MAGIC[i]) return null;
  if (sealed[4] !== VERSION) return null;
  return aesDecrypt(ctx.keys.data, sealed.slice(5), contentAad(ctx, path));
}

function join(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

class PlainBlob implements BlobLike {
  constructor(private readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer as ArrayBuffer;
  }
}

/** 中身は arrayBuffer・slice のときに初めて復号する（一覧の大きさだけなら読まない） */
class EncFileSnapshot implements FileLike {
  private plain: Promise<Uint8Array> | null = null;
  constructor(
    private readonly inner: FileLike,
    private readonly ctx: EncContext,
    private readonly path: string,
  ) {}
  get size(): number {
    return this.inner.size === 0 ? 0 : this.inner.size - CONTENT_OVERHEAD;
  }
  get lastModified(): number {
    return this.inner.lastModified;
  }
  private load(): Promise<Uint8Array> {
    this.plain ??= (async () => {
      const sealed = new Uint8Array(await this.inner.arrayBuffer());
      const p = await openContent(this.ctx, this.path, sealed);
      if (!p) {
        this.ctx.onUnreadable?.(this.path);
        throw domError("NotReadableError", `暗号を解けないファイルです（改ざん・破損の可能性）：${this.path}`);
      }
      return p;
    })();
    return this.plain;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.load()).slice().buffer as ArrayBuffer;
  }
  slice(start?: number, end?: number): BlobLike {
    const n = this.size;
    const s = Math.max(0, Math.min(n, start ?? 0));
    const e = Math.max(s, Math.min(n, end ?? n));
    const load = () => this.load();
    return {
      size: e - s,
      async arrayBuffer() {
        return new PlainBlob((await load()).slice(start, end)).arrayBuffer();
      },
    };
  }
}

class EncWritable implements WritableLike {
  private chunks: Uint8Array[] = [];
  private done = false;
  constructor(
    private readonly file: EncFile,
    initial: Uint8Array | null,
    private readonly mode: "exclusive" | "siloed" | undefined,
  ) {
    if (initial) this.chunks.push(initial);
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.done) throw domError("InvalidStateError", "書き込みは終了しています。");
    this.chunks.push(data.slice());
  }
  async close(): Promise<void> {
    if (this.done) throw domError("InvalidStateError", "書き込みは終了しています。");
    this.done = true;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const plain = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      plain.set(c, o);
      o += c.length;
    }
    const sealed = await sealContent(this.file.ctx, this.file.path, plain);
    // 内側の書き込みも close 時にだけ反映される。失敗時は元のファイルが残る（13.3）
    const w = await this.file.inner.createWritable({
      keepExistingData: false,
      ...(this.mode ? { mode: this.mode } : {}),
    });
    try {
      await w.write(sealed);
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
    await w.close();
  }
  async abort(): Promise<void> {
    this.done = true;
    this.chunks = [];
  }
}

export class EncFile implements FileHandleLike {
  readonly kind = "file" as const;
  constructor(
    readonly inner: FileHandleLike,
    readonly ctx: EncContext,
    readonly path: string,
    readonly name: string,
  ) {}
  async getFile(): Promise<FileLike> {
    const f = await this.inner.getFile();
    if (f.size !== 0 && f.size < CONTENT_OVERHEAD) {
      this.ctx.onUnreadable?.(this.path);
      throw domError("NotReadableError", `暗号を解けないファイルです（短すぎます）：${this.path}`);
    }
    return new EncFileSnapshot(f, this.ctx, this.path);
  }
  async createWritable(options?: { keepExistingData?: boolean; mode?: "exclusive" | "siloed" }): Promise<WritableLike> {
    let initial: Uint8Array | null = null;
    if (options?.keepExistingData) initial = new Uint8Array(await (await this.getFile()).arrayBuffer());
    return new EncWritable(this, initial, options?.mode);
  }
  async isSameEntry(other: FileHandleLike | DirHandleLike): Promise<boolean> {
    const o = unwrap(other);
    return (await this.inner.isSameEntry?.(o)) ?? false;
  }
}

function unwrap(h: FileHandleLike | DirHandleLike): FileHandleLike | DirHandleLike {
  if (h instanceof EncFile || h instanceof EncDir) return h.inner;
  return h;
}

export class EncDir implements DirHandleLike {
  readonly kind = "directory" as const;
  constructor(
    readonly inner: DirHandleLike,
    readonly ctx: EncContext,
    /** 包んだ根からの平文の相対パス（根は空文字） */
    readonly path: string,
    readonly name: string,
  ) {}

  private async innerName(name: string, create: boolean): Promise<string> {
    if (name === "" || name.includes("/")) throw domError("TypeError", "名前が不正です。");
    const e = await encryptName(this.ctx, this.path, name);
    if (e.side && create) {
      // 置き換え名の元の名前を先に書く（読めない置き換え名を残さない）
      const h = await this.inner.getFileHandle(`${e.name}${SIDE_SUFFIX}`, { create: true });
      const w = await h.createWritable({ keepExistingData: false });
      await w.write(e.side);
      await w.close();
    }
    return e.name;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike> {
    const n = await this.innerName(name, options?.create ?? false);
    const d = await this.inner.getDirectoryHandle(n, options);
    return new EncDir(d, this.ctx, join(this.path, name), name);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    const n = await this.innerName(name, options?.create ?? false);
    const f = await this.inner.getFileHandle(n, options);
    return new EncFile(f, this.ctx, join(this.path, name), name);
  }

  private async plainName(innerName: string): Promise<string | null> {
    if (innerName.startsWith(LONG_PREFIX)) {
      try {
        const h = await this.inner.getFileHandle(`${innerName}${SIDE_SUFFIX}`);
        const f = await h.getFile();
        if (f.size > 4096) return null;
        const name = await decryptSealedName(this.ctx, this.path, new Uint8Array(await f.arrayBuffer()));
        if (name === null) return null;
        // 置き換え名がその名前から作られたものか確かめる（別の置き換え名への付け替えを検出する）
        const again = await encryptName(this.ctx, this.path, name);
        return again.name === innerName ? name : null;
      } catch {
        return null;
      }
    }
    const sealed = fromBase32(innerName);
    if (!sealed) return null;
    const name = await decryptSealedName(this.ctx, this.path, sealed);
    if (name === null) return null;
    // IV が名前から作られたものか確かめる（同じ親の別の暗号文の付け替えを検出する）
    const again = await encryptName(this.ctx, this.path, name);
    return again.name === innerName ? name : null;
  }

  async *values(): AsyncIterable<FileHandleLike | DirHandleLike> {
    for await (const c of this.inner.values()) {
      if (c.kind === "file" && c.name.startsWith(LONG_PREFIX) && c.name.endsWith(SIDE_SUFFIX)) continue;
      const name = await this.plainName(c.name);
      if (name === null) {
        this.ctx.onUnreadable?.(join(this.path, `（読めない名前：${c.name.slice(0, 12)}…）`));
        continue;
      }
      const path = join(this.path, name);
      yield c.kind === "directory" ? new EncDir(c, this.ctx, path, name) : new EncFile(c, this.ctx, path, name);
    }
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (!this.inner.removeEntry) throw domError("NotSupportedError", "削除できません。");
    const e = await encryptName(this.ctx, this.path, name);
    await this.inner.removeEntry(e.name, options);
    if (e.side) await this.inner.removeEntry(`${e.name}${SIDE_SUFFIX}`).catch(() => undefined);
  }

  async isSameEntry(other: FileHandleLike | DirHandleLike): Promise<boolean> {
    return (await this.inner.isSameEntry?.(unwrap(other))) ?? false;
  }

  async resolve(d: FileHandleLike | DirHandleLike): Promise<string[] | null> {
    if (!this.inner.resolve) return null;
    const r = await this.inner.resolve(unwrap(d));
    if (r === null) return null;
    const out: string[] = [];
    let parent = this.path;
    let dir: DirHandleLike = this.inner;
    for (const seg of r) {
      const sub = new EncDir(dir, this.ctx, parent, "");
      const name = await sub.plainName(seg);
      // 包んだ範囲の外（別の鍵・別の範囲）の項目は、平文の名前がない。中にあることだけは返す
      out.push(name ?? seg);
      parent = join(parent, name ?? seg);
      try {
        dir = await dir.getDirectoryHandle(seg);
      } catch {
        break;
      }
    }
    return out;
  }

  queryPermission(descriptor: PermissionMode): Promise<PermissionStateLike> {
    return this.inner.queryPermission?.(descriptor) ?? Promise.resolve("granted");
  }

  requestPermission(descriptor: PermissionMode): Promise<PermissionStateLike> {
    return this.inner.requestPermission?.(descriptor) ?? Promise.resolve("granted");
  }
}

/** 根を包む。根の名前（表示に使わない）は内側の名前をそのまま見せる */
export function encryptedRoot(inner: DirHandleLike, ctx: EncContext): EncDir {
  return new EncDir(inner, ctx, "", inner.name);
}
