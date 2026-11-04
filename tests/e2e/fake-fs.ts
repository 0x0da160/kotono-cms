/**
 * E2E 用：ページ内に疑似フォルダを用意し、showDirectoryPicker をそれに差し替える。
 *
 * ヘッドレス Chromium ではネイティブのフォルダ選択ダイアログを操作できず、file:// では
 * Origin Private File System も使えない（SecurityError）。そのため、本試験は実フォルダへの
 * 読み書き（TG01）ではなく、アプリの画面・保存手順の検証である。
 *
 * この関数は Playwright の addInitScript でページへ文字列化して渡すため、外部の識別子を参照しない。
 */
export function installFakeFs(seed: Record<string, string>, binary: Record<string, string> = {}): void {
  type Node = FakeDir | FakeFile;
  const enc = new TextEncoder();
  const err = (name: string) => Object.assign(new Error(name), { name });

  class FakeFile {
    readonly kind = "file";
    data: Uint8Array = new Uint8Array();
    lastModified = Date.now();
    writes = 0;
    constructor(
      readonly name: string,
      public parent: FakeDir | null = null,
    ) {}
    async isSameEntry(o: unknown) {
      return o === this;
    }
    async getFile() {
      const bytes = this.data.slice();
      const lm = this.lastModified;
      const mk = (b: Uint8Array) => ({
        size: b.length,
        lastModified: lm,
        arrayBuffer: async () => b.slice().buffer,
        slice: (s = 0, e = b.length) => mk(b.slice(s, e)),
      });
      return mk(bytes);
    }
    async createWritable() {
      const chunks: Uint8Array[] = [];
      return {
        write: async (d: Uint8Array) => {
          chunks.push(new Uint8Array(d));
        },
        close: async () => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) {
            out.set(c, o);
            o += c.length;
          }
          this.data = out;
          this.lastModified = Date.now();
          this.writes++;
        },
        abort: async () => undefined,
      };
    }
  }

  class FakeDir {
    readonly kind = "directory";
    children = new Map<string, Node>();
    constructor(
      readonly name: string,
      public parent: FakeDir | null = null,
    ) {}
    async isSameEntry(o: unknown) {
      return o === this;
    }
    async resolve(d: Node) {
      const path: string[] = [];
      let cur: Node | null = d;
      while (cur && cur !== this) {
        path.unshift(cur.name);
        cur = cur.parent;
      }
      return cur === this ? path : null;
    }
    async removeEntry(name: string) {
      const c = this.children.get(name);
      if (!c) throw err("NotFoundError");
      if (c instanceof FakeDir && c.children.size > 0) throw err("InvalidModificationError");
      this.children.delete(name);
    }
    async getDirectoryHandle(name: string, o?: { create?: boolean }) {
      const c = this.children.get(name);
      if (c instanceof FakeDir) return c;
      if (c) throw err("TypeMismatchError");
      if (!o?.create) throw err("NotFoundError");
      const d = new FakeDir(name, this);
      this.children.set(name, d);
      return d;
    }
    async getFileHandle(name: string, o?: { create?: boolean }) {
      const c = this.children.get(name);
      if (c instanceof FakeFile) return c;
      if (c) throw err("TypeMismatchError");
      if (!o?.create) throw err("NotFoundError");
      const f = new FakeFile(name, this);
      this.children.set(name, f);
      return f;
    }
    async *values() {
      for (const c of [...this.children.values()]) yield c;
    }
    async queryPermission() {
      return "granted";
    }
    async requestPermission() {
      return "granted";
    }
  }

  const root = new FakeDir("sample-media");
  // 退避先：リポジトリと重ならない別のフォルダ（19.1）
  const backupRoot = new FakeDir("backup-drive");
  const pickQueue: string[] = [];
  const walk = (path: string, create: boolean, base: FakeDir = root): { dir: FakeDir; name: string } => {
    const parts = path.split("/");
    let d = base;
    for (const p of parts.slice(0, -1)) {
      let c = d.children.get(p);
      if (!c && create) {
        c = new FakeDir(p, d);
        d.children.set(p, c);
      }
      if (!(c instanceof FakeDir)) throw new Error(`no dir ${p}`);
      d = c;
    }
    return { dir: d, name: parts.at(-1) ?? "" };
  };
  const api = {
    write(path: string, text: string) {
      const { dir, name } = walk(path, true);
      const f = new FakeFile(name, dir);
      f.data = enc.encode(text);
      dir.children.set(name, f);
    },
    writeBase64(path: string, b64: string) {
      const { dir, name } = walk(path, true);
      const f = new FakeFile(name, dir);
      f.data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      dir.children.set(name, f);
    },
    /** 次の showDirectoryPicker が返すフォルダ */
    pickNext(which: "repo" | "backup") {
      pickQueue.push(which);
    },
    backupList(path = ""): string[] {
      try {
        const { dir } = walk(`${path}${path ? "/" : ""}x`, false, backupRoot);
        return [...dir.children.keys()];
      } catch {
        return [];
      }
    },
    backupRead(path: string): string | null {
      try {
        const { dir, name } = walk(path, false, backupRoot);
        const f = dir.children.get(name);
        return f instanceof FakeFile ? new TextDecoder().decode(f.data) : null;
      } catch {
        return null;
      }
    },
    mkdir(path: string) {
      walk(`${path}/x`, true);
    },
    read(path: string): string | null {
      try {
        const { dir, name } = walk(path, false);
        const f = dir.children.get(name);
        return f instanceof FakeFile ? new TextDecoder().decode(f.data) : null;
      } catch {
        return null;
      }
    },
    writes(path: string): number {
      const { dir, name } = walk(path, false);
      const f = dir.children.get(name);
      return f instanceof FakeFile ? f.writes : -1;
    },
    /** 全ファイルを base64 で返す（ネイティブ Git での照合用） */
    dump(): Record<string, string> {
      const out: Record<string, string> = {};
      const walkAll = (d: FakeDir, prefix: string) => {
        for (const [n, c] of d.children) {
          const p = prefix ? `${prefix}/${n}` : n;
          if (c instanceof FakeDir) walkAll(c, p);
          else {
            let bin = "";
            for (const b of c.data) bin += String.fromCharCode(b);
            out[p] = btoa(bin);
          }
        }
      };
      walkAll(root, "");
      return out;
    },
    list(path: string): string[] {
      try {
        const { dir, name } = walk(`${path}/x`, false);
        void name;
        return [...dir.children.keys()];
      } catch {
        return [];
      }
    },
  };
  for (const [p, t] of Object.entries(seed)) {
    if (p.endsWith("/")) api.mkdir(p.slice(0, -1));
    else api.write(p, t);
  }
  for (const [p, b] of Object.entries(binary)) api.writeBase64(p, b);
  Object.assign(window, {
    __fakeFs: api,
    showDirectoryPicker: async () => (pickQueue.shift() === "backup" ? backupRoot : root),
  });
}

export interface FakeFsApi {
  write(path: string, text: string): void;
  writeBase64(path: string, b64: string): void;
  pickNext(which: "repo" | "backup"): void;
  backupList(path?: string): string[];
  backupRead(path: string): string | null;
  read(path: string): string | null;
  writes(path: string): number;
  list(path: string): string[];
  dump(): Record<string, string>;
}
