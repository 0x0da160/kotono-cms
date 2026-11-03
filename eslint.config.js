// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

export default ts.config(
  { ignores: ["dist/", "coverage/", "playwright-report/", "test-results/", "node_modules/"] },
  js.configs.recommended,
  ...ts.configs.strict,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // 仕様 16.1: 記事由来のコードを実行しない。アプリ側でも動的評価を禁止する。
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "svelte/no-at-html-tags": "error",
    },
  },
  {
    // 型検査は TypeScript / svelte-check が行う（typescript-eslint 推奨設定）
    files: ["**/*.ts", "**/*.svelte"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
);
