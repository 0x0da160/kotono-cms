import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json" with { type: "json" };
import { inlineCsp } from "./build/csp";

/** 仕様書のバージョン（docs/spec/ の版と一致させる） */
const SPEC_VERSION = "3.1";

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
  ],
  build: {
    target: ["chrome120", "edge120"],
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
  worker: {
    // file:// 起動では blob: URL のモジュールWorkerが起動できないため、クラシックWorkerとして出力する
    format: "iife",
  },
});
