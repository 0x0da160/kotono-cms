import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // .svelte.ts（runes を使う状態クラス）を単体試験で読み込むために Svelte を通す
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __SPEC_VERSION__: JSON.stringify("3.1"),
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
