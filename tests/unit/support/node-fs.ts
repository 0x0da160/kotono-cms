/**
 * 実フォルダ（Node の fs）を File System Access API の形で包む。単体試験で
 * ネイティブ Git との相互運用（TG02 の一部）を確かめるために使う。
 * ブラウザの File System Access API の挙動そのものの代替ではない。
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { BlobLike, DirHandleLike, FileHandleLike, FileLike, WritableLike } from "../../../src/lib/fs/types";

/** 失敗注入：close の直前に呼ばれ、例外を投げれば書き込みは反映されない */
export const nodeFaults: { beforeClose?: ((path: string) => void) | undefined } = {};

function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function mapErr(e: unknown): Error {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return domError("NotFoundError");
  if (code === "ENOTDIR" || code === "EISDIR") return domError("TypeMismatchError");
  if (code === "ENOTEMPTY") return domError("InvalidModificationError");
  return e instanceof Error ? e : new Error(String(e));
}

class NodeBlob implements BlobLike {
  constructor(private readonly data: Uint8Array) {}
  get size() {
    return this.data.length;
  }
  async arrayBuffer() {
    return this.data.slice().buffer;
  }
}

class NodeFile implements FileLike {
  constructor(
    private readonly data: Uint8Array,
    readonly lastModified: number,
  ) {}
  get size() {
    return this.data.length;
  }
  async arrayBuffer() {
    return this.data.slice().buffer;
  }
  slice(start = 0, end = this.data.length): BlobLike {
    return new NodeBlob(this.data.slice(start, end));
  }
}

export class NodeFileHandle implements FileHandleLike {
  readonly kind = "file" as const;
  constructor(
    readonly path: string,
    readonly name: string,
  ) {}
  async getFile(): Promise<FileLike> {
    try {
      const [b, st] = await Promise.all([fsp.readFile(this.path), fsp.stat(this.path)]);
      return new NodeFile(new Uint8Array(b), Math.floor(st.mtimeMs));
    } catch (e) {
      throw mapErr(e);
    }
  }
  async createWritable(): Promise<WritableLike> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array) => {
        chunks.push(new Uint8Array(d));
      },
      close: async () => {
        nodeFaults.beforeClose?.(this.path);
        await fsp.writeFile(this.path, Buffer.concat(chunks));
      },
      abort: async () => undefined,
    };
  }
  async isSameEntry(o: FileHandleLike | DirHandleLike): Promise<boolean> {
    return o instanceof NodeFileHandle && o.path === this.path;
  }
}

export class NodeDirHandle implements DirHandleLike {
  readonly kind = "directory" as const;
  constructor(
    readonly path: string,
    readonly name = "root",
  ) {}
  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandleLike> {
    const p = join(this.path, name);
    try {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) throw domError("TypeMismatchError");
    } catch (e) {
      if ((e as Error).name === "TypeMismatchError") throw e;
      if (!o?.create) throw mapErr(e);
      await fsp.mkdir(p);
    }
    return new NodeDirHandle(p, name);
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike> {
    const p = join(this.path, name);
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) throw domError("TypeMismatchError");
    } catch (e) {
      if ((e as Error).name === "TypeMismatchError") throw e;
      if (!o?.create) throw mapErr(e);
      await fsp.writeFile(p, new Uint8Array());
    }
    return new NodeFileHandle(p, name);
  }
  async *values(): AsyncIterable<FileHandleLike | DirHandleLike> {
    const list = await fsp.readdir(this.path, { withFileTypes: true });
    for (const d of list) {
      const p = join(this.path, d.name);
      yield d.isDirectory() ? new NodeDirHandle(p, d.name) : new NodeFileHandle(p, d.name);
    }
  }
  async removeEntry(name: string) {
    const p = join(this.path, name);
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) await fsp.rmdir(p);
      else await fsp.unlink(p);
    } catch (e) {
      throw mapErr(e);
    }
  }
  async isSameEntry(o: FileHandleLike | DirHandleLike): Promise<boolean> {
    return o instanceof NodeDirHandle && o.path === this.path;
  }
}
