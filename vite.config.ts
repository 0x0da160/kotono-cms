import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json" with { type: "json" };
import { inlineCsp } from "./build/csp";
import { releaseInfo } from "./build/release";
import { serviceWorker } from "./build/pwa";

/**
 * decode-named-character-reference の browser 版は document を使うため Worker で動かない。
 * 同じパッケージの DOM を使わない実装（index.js）へ差し替える。
 */
function noDomEntities(): Plugin {
  return {
    name: "kotono:no-dom-entities",
    enforce: "pre",
    async resolveId(id, importer) {
      if (id !== "decode-named-character-reference") return null;
      const r = await this.resolve(id, importer, { skipSelf: true });
      return r ? { ...r, id: r.id.replace(/index\.dom\.js$/, "index.js") } : null;
    },
  };
}

/** 仕様書のバージョン（docs/spec/ の版と一致させる） */
const SPEC_VERSION = "3.2";

const release = releaseInfo({ appVersion: pkg.version, specVersion: SPEC_VERSION, html: "kotono-cms.html" });

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SPEC_VERSION__: JSON.stringify(SPEC_VERSION),
  },
  plugins: [
    svelte(),
    // JS・CSS・アセットをすべて単一の kotono-cms.html へインライン化する（仕様 2.1）
    viteSingleFile({ outputFileName: "kotono-cms.html", removeViteModuleLoader: true }),
    inlineCsp(),
    // https 配信用の Service Worker（38.5。file:// 起動では使わない）
    serviceWorker(pkg.version),
    // 配布物のハッシュ・依存一覧・ライセンス（29.4）
    release.main,
  ],
  build: {
    // iOS・iPadOS 26 以降の Safari にも対応する（仕様 3.2 第2.1節）
    target: ["chrome120", "edge120", "safari18"],
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
  worker: {
    // file:// 起動では blob: URL のモジュールWorkerが起動できないため、クラシックWorkerとして出力する
    format: "iife",
    // Worker には document がない。"worker" 条件を優先し、DOM 依存の実装
    // （decode-named-character-reference の browser 版など）を選ばない
    plugins: () => [noDomEntities(), release.collector()],
  },
});
