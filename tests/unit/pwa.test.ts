import { describe, expect, it } from "vitest";
import { serviceWorkerSource } from "../../build/pwa";

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
