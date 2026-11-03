import { createHash } from "node:crypto";
import type { Plugin } from "vite";

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
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return [...html.matchAll(re)].map((m) => m[1] ?? "").filter((body) => body.length > 0);
}

export function buildCsp(html: string): string {
  const scripts = collectInline(html, "script").map(sha256);
  const styles = collectInline(html, "style").map(sha256);
  const directives: Record<string, string[]> = {
    "default-src": ["'none'"],
    "script-src": scripts.length > 0 ? scripts : ["'none'"],
    "style-src": styles.length > 0 ? styles : ["'none'"],
    // プレビュー・画像はCMSが読み込んだ許可ファイルから生成した blob: のみ（仕様 16.2）
    "img-src": ["blob:"],
    // 解析層の Worker は file:// 起動のため blob: URL から生成する（仕様 16.1.1, TG08）
    "worker-src": ["blob:"],
    "connect-src": ["'none'"],
    "font-src": ["'none'"],
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
