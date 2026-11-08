/**
 * https 配信のときだけ、マニフェストと Service Worker を使う（仕様 3.2 第38.5節）。
 * 新しい版は自動で切り替えず、利用者が「更新」を押したときだけ切り替える（29.3）。
 */
interface SwRegistration {
  waiting: { postMessage(m: unknown): void } | null;
  installing: { addEventListener(t: "statechange", f: () => void): void; state: string } | null;
  addEventListener(t: "updatefound", f: () => void): void;
  update(): Promise<unknown>;
}

/** 「新しい版を確かめる」の結果。画面に結果を示し、押しても何も起きないように見せない */
export type UpdateCheck = "idle" | "checking" | "fetching" | "latest" | "failed";

export interface PwaHost {
  location: { protocol: string; hostname: string };
  document: Document;
  navigator: {
    serviceWorker?: {
      register(url: string, opts?: { scope?: string }): Promise<SwRegistration>;
      controller: unknown;
      addEventListener(t: "controllerchange", f: () => void): void;
    };
  };
}

export class PwaController {
  /** 新しい版の取得が済み、切り替えを待っている */
  updateReady = $state(false);
  active = $state(false);
  /** 直近の「新しい版を確かめる」の状態 */
  checkState = $state<UpdateCheck>("idle");
  #reg: SwRegistration | null = null;

  constructor(private readonly host: PwaHost) {}

  /** file:// で開いている（配布物の HTML を差し替えて開き直すと新しい版になる） */
  get fromFile(): boolean {
    return this.host.location.protocol === "file:";
  }

  /** https（または開発用の localhost）で、Service Worker を使えるときだけ有効にする */
  get eligible(): boolean {
    const { protocol, hostname } = this.host.location;
    return (protocol === "https:" || hostname === "localhost") && !!this.host.navigator.serviceWorker;
  }

  async start(): Promise<void> {
    if (!this.eligible) return;
    const doc = this.host.document;
    for (const [rel, href] of [
      ["manifest", "manifest.webmanifest"],
      ["apple-touch-icon", "apple-touch-icon.png"],
      ["icon", "icon.svg"],
    ] as const) {
      const l = doc.createElement("link");
      l.rel = rel;
      l.href = href;
      doc.head.append(l);
    }
    const sw = this.host.navigator.serviceWorker;
    if (!sw) return;
    try {
      const reg = await sw.register("sw.js", { scope: "./" });
      this.#reg = reg;
      this.active = true;
      const hadController = !!sw.controller;
      if (reg.waiting && hadController) this.updateReady = true;
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && sw.controller) this.updateReady = true;
        });
      });
      let reloading = false;
      sw.addEventListener("controllerchange", () => {
        if (!hadController || reloading) return;
        reloading = true;
        this.host.document.location.reload();
      });
    } catch {
      // 登録できなくても、オンラインでは使える
    }
  }

  /** 新しい版を確かめる（明示操作） */
  async check(): Promise<void> {
    if (this.checkState === "checking") return;
    this.checkState = "checking";
    const ok = await (this.#reg?.update() ?? Promise.reject(new Error("未登録"))).then(
      () => true,
      () => false,
    );
    if (this.#reg?.waiting) this.updateReady = true;
    const w = this.#reg?.installing;
    if (!this.updateReady && w) {
      // 取得中の新しい版は、インストールが済むと updatefound の側で updateReady になる
      this.checkState = "fetching";
      w.addEventListener("statechange", () => {
        if (w.state === "redundant") this.checkState = "failed";
      });
      return;
    }
    this.checkState = this.updateReady ? "idle" : ok ? "latest" : "failed";
  }

  /** 新しい版へ切り替える。未保存の編集は呼び出し側で確認すること */
  apply(): void {
    this.#reg?.waiting?.postMessage("skip-waiting");
  }
}
