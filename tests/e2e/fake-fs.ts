/**
 * E2E 用：ページ内に疑似フォルダを用意し、showDirectoryPicker をそれに差し替える。
 *
 * ヘッドレス Chromium ではネイティブのフォルダ選択ダイアログを操作できず、file:// では
 * Origin Private File System も使えない（SecurityError）。そのため、本試験は実フォルダへの
 * 読み書き（TG01）ではなく、アプリの画面・保存手順の検証である。
 *
 * この関数は Playwright の addInitScript でページへ文字列化して渡すため、外部の識別子を参照しない。
 */
export function installFakeFs(seed: Record<string, string>): void {
  type Node = FakeDir | FakeFile;
  const enc = new TextEncoder();
  const err = (name: string) => Object.assign(new Error(name), { name });

  class FakeFile {
    readonly kind = "file";
    data: Uint8Array = new Uint8Array();
    lastModified = Date.now();
    writes = 0;
    constructor(readonly name: string) {}
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
    constructor(readonly name: string) {}
    async getDirectoryHandle(name: string, o?: { create?: boolean }) {
      const c = this.children.get(name);
      if (c instanceof FakeDir) return c;
      if (c) throw err("TypeMismatchError");
      if (!o?.create) throw err("NotFoundError");
      const d = new FakeDir(name);
      this.children.set(name, d);
      return d;
    }
    async getFileHandle(name: string, o?: { create?: boolean }) {
      const c = this.children.get(name);
      if (c instanceof FakeFile) return c;
      if (c) throw err("TypeMismatchError");
      if (!o?.create) throw err("NotFoundError");
      const f = new FakeFile(name);
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
  const walk = (path: string, create: boolean): { dir: FakeDir; name: string } => {
    const parts = path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let c = d.children.get(p);
      if (!c && create) {
        c = new FakeDir(p);
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
      const f = new FakeFile(name);
      f.data = enc.encode(text);
      dir.children.set(name, f);
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
  Object.assign(window, { __fakeFs: api, showDirectoryPicker: async () => root });
}

export interface FakeFsApi {
  write(path: string, text: string): void;
  read(path: string): string | null;
  writes(path: string): number;
  list(path: string): string[];
}
