import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { PREVIEW_CSS } from "../src/lib/preview/frame";

/**
 * 単一HTMLへインライン化された <script> / <style> の SHA-256 ハッシュを計算し、
 * Content-Security-Policy の <meta> を挿入する。
 *
 * 仕様 16.1.1 / 16.3: 外部通信を行わない。meta 配信で無効なディレクティブ
 * （frame-ancestors, sandbox, report-uri 等）には依存しない。
 * CSP は多層防御の一つであり、これだけに依存しない（仕様 16.1）。
 */
export const CSP_PLACEHOLDER = "<!--kotono:csp-->";

function sha256(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

function collectInline(html: string, tag: "script" | "style"): string[] {
  // スクリプト本文の文字列（ハイライト文法の "<style" 等）を style 要素と誤認しないよう、
  // style を集めるときはスクリプト要素を取り除いてから探す
  const src = tag === "style" ? html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "") : html;
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return [...src.matchAll(re)].map((m) => m[1] ?? "").filter((body) => body.length > 0);
}

export function buildCsp(html: string): string {
  const scripts = collectInline(html, "script").map(sha256);
  // プレビューの srcdoc は親の CSP を継承するため、プレビュー用 CSS のハッシュも許可する（16.1.1）
  const styles = [...collectInline(html, "style").map(sha256), sha256(PREVIEW_CSS)];
  const directives: Record<string, string[]> = {
    "default-src": ["'none'"],
    "script-src": scripts.length > 0 ? scripts : ["'none'"],
    "style-src": styles,
    // 画像はCMSが読み込んだ許可ファイルから生成した blob:（親UI）と data:（プレビュー）のみ（仕様 16.2）。
    // sandbox iframe は opaque origin のため親の blob: を読めず、data: で渡す（ADR-0003）。
    "img-src": ["blob:", "data:", "'self'"],
    // 解析層の Worker は file:// 起動のため blob: URL から生成する（仕様 16.1.1, TG08）
    // https 配信では配布物だけをキャッシュする Service Worker（sw.js）を使う（仕様 3.2 第38.5節）
    "worker-src": ["blob:", "'self'"],
    // GitHub との同期（仕様 3.2 第40.2節）：通信先は api.github.com だけ
    "connect-src": ["https://api.github.com"],
    // ホーム画面に追加したときのマニフェスト（https 配信のみ：38.5）
    "manifest-src": ["'self'"],
    "font-src": ["'none'"],
    // プレビューは srcdoc の iframe（about:srcdoc）。外部の文書は読み込まない。
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function inlineCsp(): Plugin {
  return {
    name: "kotono:inline-csp",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "asset" || !chunk.fileName.endsWith(".html")) continue;
          const html = String(chunk.source);
          if (!html.includes(CSP_PLACEHOLDER)) {
            this.error(`${chunk.fileName}: CSP placeholder ${CSP_PLACEHOLDER} not found`);
          }
          const csp = buildCsp(html);
          chunk.source = html.replace(
            CSP_PLACEHOLDER,
            `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
          );
        }
      },
    },
  };
}
