import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/**
 * https 配信用の Service Worker（仕様 3.2 第38.5節）。
 *
 * - 配布物（HTML・マニフェスト・アイコン）だけをキャッシュする。記事データ・GitHub との通信は扱わない。
 * - 版ごとに別のキャッシュを使う。新しい版は待機させ、利用者が画面で「更新」を押したときだけ切り替える。
 * file:// 起動では使わない（登録はアプリ側で https のときだけ行う）。
 */
export const SW_FILES = [
  "./",
  "./index.html",
  "./kotono-cms.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

export function serviceWorkerSource(version: string): string {
  return `/* Kotono CMS ${version}：配布物だけをキャッシュする（記事データは扱わない） */
const CACHE = ${JSON.stringify(`kotono-${version}`)};
const FILES = ${JSON.stringify(SW_FILES)};
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("kotono-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 同じ配信元の配布物の GET だけを扱う（api.github.com などには触れない）
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const key = req.mode === "navigate" ? "./index.html" : req;
  e.respondWith(
    caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }).then((hit) => hit || fetch(req))),
  );
});
`;
}

export function serviceWorker(appVersion: string, html = "kotono-cms.html"): Plugin {
  return {
    name: "kotono:service-worker",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const page = bundle[html];
        if (!page || page.type !== "asset") return;
        const hash = createHash("sha256").update(String(page.source)).digest("hex").slice(0, 12);
        const version = `${appVersion}-${hash}`;
        this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource(version) });
      },
    },
  };
}
