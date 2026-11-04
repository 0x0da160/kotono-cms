/**
 * 失敗注入できるメモリ上の File System Access API 実装（単体試験用）。
 * 実ブラウザの挙動の代替ではない（TG01・TG06 の実機試験は別途必要）。
 */
import type {
  BlobLike,
  DirHandleLike,
  FileHandleLike,
  FileLike,
  PermissionStateLike,
  WritableLike,
} from "../../../src/lib/fs/types";

function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export interface Faults {
  /** write() の前に呼ばれ、例外を投げれば書き込み失敗 */
  beforeWrite?: (path: string) => void;
  /** close() の前に呼ばれ、例外を投げればクローズ失敗（内容は反映されない） */
  beforeClose?: (path: string) => void;
  /** close() の後に内容を差し替える（再読込不一致の注入） */
  afterClose?: (path: string, file: MemFile) => void;
  /** getDirectoryHandle / getFileHandle の直前に呼ばれる（競合注入） */
  beforeGet?: (path: string, create: boolean) => void;
  permission?: PermissionStateLike;
  requestResult?: PermissionStateLike;
  /** removeEntry の直前に呼ばれ、例外を投げれば削除失敗 */
  beforeRemove?: (path: string) => void;
}

class MemBlob implements BlobLike {
  constructor(private readonly data: Uint8Array) {}
  get size() {
    return this.data.length;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice().buffer;
  }
}

class MemFileSnapshot extends MemBlob implements FileLike {
  constructor(
    private readonly bytes: Uint8Array,
    readonly lastModified: number,
  ) {
    super(bytes);
  }
  slice(start = 0, end = this.bytes.length): BlobLike {
    return new MemBlob(this.bytes.slice(start, end));
  }
}

export class MemFile implements FileHandleLike {
  readonly kind = "file" as const;
  data: Uint8Array = new Uint8Array();
  lastModified = Date.now();
  readonly writes: Uint8Array[] = [];
  constructor(
    readonly name: string,
    readonly path: string,
    private readonly fs: MemFs,
  ) {}

  async getFile(): Promise<FileLike> {
    if (!this.fs.exists(this)) throw domError("NotFoundError");
    return new MemFileSnapshot(this.data.slice(), this.lastModified);
  }

  async createWritable(): Promise<WritableLike> {
    if (this.fs.faults.permission === "denied") throw domError("NotAllowedError");
    const chunks: Uint8Array[] = [];
    let closed = false;
    return {
      write: async (d: Uint8Array) => {
        this.fs.faults.beforeWrite?.(this.path);
        chunks.push(d.slice());
      },
      close: async () => {
        this.fs.faults.beforeClose?.(this.path);
        if (closed) return;
        closed = true;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        this.data = out;
        this.lastModified = Date.now();
        this.writes.push(out);
        this.fs.faults.afterClose?.(this.path, this);
      },
      abort: async () => {
        closed = true;
      },
    };
  }

  text(): string {
    return new TextDecoder().decode(this.data);
  }

  get owner(): MemFs {
    return this.fs;
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
}

export class MemDir implements DirHandleLike {
  readonly kind = "directory" as const;
  readonly children = new Map<string, MemDir | MemFile>();
  constructor(
    readonly name: string,
    readonly path: string,
    private readonly fs: MemFs,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike> {
    this.fs.faults.beforeGet?.(`${this.path}${name}/`, options?.create ?? false);
    const c = this.children.get(name);
    if (c instanceof MemDir) return c;
    if (c) throw domError("TypeMismatchError");
    if (!options?.create) throw domError("NotFoundError");
    const d = new MemDir(name, `${this.path}${name}/`, this.fs);
    this.children.set(name, d);
    return d;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    this.fs.faults.beforeGet?.(`${this.path}${name}`, options?.create ?? false);
    const c = this.children.get(name);
    if (c instanceof MemFile) return c;
    if (c) throw domError("TypeMismatchError");
    if (!options?.create) throw domError("NotFoundError");
    const f = new MemFile(name, `${this.path}${name}`, this.fs);
    this.children.set(name, f);
    return f;
  }

  async *values(): AsyncIterable<FileHandleLike | DirHandleLike> {
    for (const c of [...this.children.values()]) yield c;
  }

  async queryPermission(): Promise<PermissionStateLike> {
    return this.fs.faults.permission ?? "granted";
  }

  async requestPermission(): Promise<PermissionStateLike> {
    return this.fs.faults.requestResult ?? this.fs.faults.permission ?? "granted";
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const c = this.children.get(name);
    if (!c) throw domError("NotFoundError");
    this.fs.faults.beforeRemove?.(`${this.path}${name}`);
    if (c instanceof MemDir && c.children.size > 0 && !options?.recursive) throw domError("InvalidModificationError");
    this.children.delete(name);
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }

  async resolve(d: FileHandleLike | DirHandleLike): Promise<string[] | null> {
    if (!(d instanceof MemDir || d instanceof MemFile) || d.owner !== this.fs) return null;
    if (d.path === this.path) return [];
    if (!d.path.startsWith(this.path)) return null;
    return d.path.slice(this.path.length).replace(/\/$/, "").split("/");
  }

  get owner(): MemFs {
    return this.fs;
  }
}

export class MemFs {
  faults: Faults = {};
  readonly root: MemDir;
  constructor(name = "repo") {
    this.root = new MemDir(name, "", this);
  }

  exists(f: MemFile): boolean {
    const parts = f.path.split("/");
    let d: MemDir = this.root;
    for (const p of parts.slice(0, -1)) {
      const c = d.children.get(p);
      if (!(c instanceof MemDir)) return false;
      d = c;
    }
    return d.children.get(parts.at(-1) ?? "") === f;
  }

  /** パス（`a/b/c.md` または `a/b/`）でエントリーを作る */
  write(path: string, content: string | Uint8Array): MemFile {
    const parts = path.split("/");
    let d = this.root;
    for (const p of parts.slice(0, -1)) {
      let c = d.children.get(p);
      if (!c) {
        c = new MemDir(p, `${d.path}${p}/`, this);
        d.children.set(p, c);
      }
      if (!(c instanceof MemDir)) throw new Error(`not a dir: ${p}`);
      d = c;
    }
    const name = parts.at(-1) ?? "";
    const f = new MemFile(name, path, this);
    f.data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    d.children.set(name, f);
    return f;
  }

  mkdir(path: string): MemDir {
    const parts = path.replace(/\/$/, "").split("/");
    let d = this.root;
    for (const p of parts) {
      let c = d.children.get(p);
      if (!c) {
        c = new MemDir(p, `${d.path}${p}/`, this);
        d.children.set(p, c);
      }
      if (!(c instanceof MemDir)) throw new Error(`not a dir: ${p}`);
      d = c;
    }
    return d;
  }

  get(path: string): MemDir | MemFile | undefined {
    if (path === "" || path === "/") return this.root;
    const parts = path.replace(/\/$/, "").split("/");
    let cur: MemDir | MemFile | undefined = this.root;
    for (const p of parts) {
      if (!(cur instanceof MemDir)) return undefined;
      cur = cur.children.get(p);
    }
    return cur;
  }

  remove(path: string): void {
    const parts = path.replace(/\/$/, "").split("/");
    const parent = this.get(parts.slice(0, -1).join("/"));
    if (parent instanceof MemDir) parent.children.delete(parts.at(-1) ?? "");
  }

  readText(path: string): string | undefined {
    const f = this.get(path);
    return f instanceof MemFile ? f.text() : undefined;
  }
}
