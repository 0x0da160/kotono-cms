/**
 * コードブロックのハイライト（仕様 15）。対象言語は HTML・CSS・JavaScript・TypeScript・JSON・
 * YAML・Bash・Python だけ。非対応の言語指定はプレーンなコード表示にする。文法定義は同梱分だけで、
 * 外部から取得しない。解析層（Worker）の中で実行し、結果は「クラス名と文字列」の列として渡す。
 * 描画側（markdown.ts）はクラス名を検証し、文字列はすべてエスケープする。
 */
import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Nodes, Root } from "mdast";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import { KiB } from "./budgets";
import { PROVISIONAL_HIGHLIGHT_MAX_TOKENS, type HlToken } from "./highlight-tokens";

export type { HlToken };

/** PROVISIONAL：1ブロック・1文書のハイライト対象の上限（34.2 の解析時間上限の内側に収める暫定値） */
export const PROVISIONAL_HIGHLIGHT_BLOCK_MAX = 64 * KiB;
export const PROVISIONAL_HIGHLIGHT_TOTAL_MAX = 256 * KiB;

const ALIASES: Record<string, string> = {
  html: "xml",
  xml: "xml",
  css: "css",
  javascript: "javascript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  python: "python",
  py: "python",
};

let low: ReturnType<typeof createLowlight> | null = null;
function lowlight() {
  low ??= createLowlight({ bash, css, javascript, json, python, typescript, xml, yaml });
  return low;
}

export function languageOf(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return ALIASES[lang.toLowerCase()] ?? null;
}

function flatten(nodes: readonly ElementContent[], cls: string, out: HlToken[]) {
  for (const n of nodes) {
    if (n.type === "text") out.push([cls, n.value]);
    else if (n.type === "element") {
      const e = n as Element;
      const c = e.properties?.className;
      const names = Array.isArray(c) ? c.map(String) : [];
      flatten(e.children, [cls, ...names].filter(Boolean).join(" "), out);
    }
  }
}

export function highlight(code: string, lang: string | null | undefined): HlToken[] | null {
  const name = languageOf(lang);
  if (!name || code.length > PROVISIONAL_HIGHLIGHT_BLOCK_MAX) return null;
  let tree: HastRoot;
  try {
    tree = lowlight().highlight(name, code);
  } catch {
    return null;
  }
  const out: HlToken[] = [];
  flatten(tree.children as ElementContent[], "", out);
  if (out.length > PROVISIONAL_HIGHLIGHT_MAX_TOKENS) return null;
  // ハイライト結果の文字列を連結すると元のコードと一致する（取りこぼし・追加がない）
  if (out.map((t) => t[1]).join("") !== code) return null;
  return out;
}

/** 構文木のコードブロックにハイライト結果を付ける（解析層で呼ぶ） */
export function attachHighlights(tree: Root): void {
  let total = 0;
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop() as Nodes;
    if (n.type === "code") {
      if (total + n.value.length > PROVISIONAL_HIGHLIGHT_TOTAL_MAX) continue;
      const hl = highlight(n.value, n.lang);
      if (hl) {
        total += n.value.length;
        n.data = { ...(n.data ?? {}), hl } as typeof n.data;
      }
    }
    if ("children" in n) for (const c of n.children) stack.push(c);
  }
}
