import { describe, expect, it } from "vitest";
import { serviceWorkerSource } from "../../build/pwa";
import { PwaController } from "../../src/lib/app/pwa.svelte";

describe("Service Worker（38.5）", () => {
  it("インストール時は HTTP キャッシュを通さずに配布物を取る", async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    let added: Request[] = [];
    let done: Promise<unknown> = Promise.resolve();
    const self = {
      addEventListener: (t: string, f: (e: unknown) => void) => (handlers[t] = f),
      location: { origin: "https://example.test" },
    };
    const caches = {
      open: async () => ({
        addAll: async (rs: Request[]) => {
          added = rs;
        },
      }),
    };
    // eslint-disable-next-line no-new-func -- 生成した Service Worker を偽の環境で動かす
    new Function("self", "caches", "Request", serviceWorkerSource("1-abc"))(
      self,
      caches,
      class {
        constructor(
          readonly url: string,
          readonly init: RequestInit,
        ) {}
      },
    );
    handlers["install"]?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(added.length).toBeGreaterThan(0);
    for (const r of added) expect((r as unknown as { init: RequestInit }).init.cache).toBe("reload");
  });
});

describe("新しい版の確認（29.3）", () => {
  type Listener = () => void;
  function fakeHost(protocol = "https:") {
    const worker = { state: "installing", listeners: [] as Listener[] };
    const reg = {
      waiting: null as { postMessage(m: unknown): void } | null,
      installing: null as null | {
        state: string;
        addEventListener(t: "statechange", f: Listener): void;
      },
      found: [] as Listener[],
      next: "none" as "none" | "found" | "fail",
      addEventListener(_t: "updatefound", f: Listener) {
        this.found.push(f);
      },
      async update() {
        if (this.next === "fail") throw new Error("offline");
        if (this.next === "found") {
          this.installing = {
            get state() {
              return worker.state;
            },
            addEventListener: (_t, f) => worker.listeners.push(f),
          };
          for (const f of this.found) f();
        }
      },
    };
    const doc = { createElement: () => ({}), head: { append: () => undefined }, location: { reload: () => undefined } };
    const host = {
      location: { protocol, hostname: "example.test" },
      document: doc as unknown as Document,
      navigator: {
        serviceWorker: {
          controller: {},
          register: async () => reg,
          addEventListener: () => undefined,
        },
      },
    };
    const finishInstall = (state: string) => {
      worker.state = state;
      for (const f of worker.listeners) f();
    };
    return { host, reg, finishInstall };
  }

  it("新しい版がなければ「最新」と示す", async () => {
    const { host } = fakeHost();
    const pwa = new PwaController(host);
    await pwa.start();
    expect(pwa.active).toBe(true);
    await pwa.check();
    expect(pwa.checkState).toBe("latest");
    expect(pwa.updateReady).toBe(false);
  });

  it("確かめられなければ失敗を示す", async () => {
    const { host, reg } = fakeHost();
    const pwa = new PwaController(host);
    await pwa.start();
    reg.next = "fail";
    await pwa.check();
    expect(pwa.checkState).toBe("failed");
  });

  it("新しい版があれば取得中を示し、取得が済むと切り替えを待つ", async () => {
    const { host, reg, finishInstall } = fakeHost();
    const pwa = new PwaController(host);
    await pwa.start();
    reg.next = "found";
    await pwa.check();
    expect(pwa.checkState).toBe("fetching");
    finishInstall("installed");
    expect(pwa.updateReady).toBe(true);
  });

  it("file:// では Service Worker を使わず、ファイルから開いていることを示す", async () => {
    const { host } = fakeHost("file:");
    const pwa = new PwaController(host);
    await pwa.start();
    expect(pwa.active).toBe(false);
    expect(pwa.fromFile).toBe(true);
  });
});
