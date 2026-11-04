/**
 * プレビュー層の文書（仕様 16.1.1）。
 *
 * - `sandbox` 属性に何も許可しない iframe の srcdoc に入れる。`allow-scripts`・`allow-same-origin`
 *   を与えないため、スクリプトは動かず、文書は独立した opaque origin になる。
 * - srcdoc 文書は親文書の CSP を継承する（Chromium で実測）。そのため、この CSS のハッシュを
 *   親の style-src にも加え（build/csp.ts）、画像は親で検証したローカル画像の data: URL だけを使う。
 *   opaque origin の文書は親の blob: URL を読めない（Chromium・file:// で実測）。
 */

export const PREVIEW_CSS = `:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--soft:#f6f8fa}@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--soft:#151b23}}html{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif;line-height:1.75;color:var(--fg);background:transparent}body{margin:0;padding:1rem;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{background:var(--soft);padding:.75rem;border-radius:6px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}.raw-html{color:var(--muted);white-space:pre-wrap}blockquote{margin:0;padding-left:1rem;border-left:4px solid var(--line);color:var(--muted)}table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:.25rem .5rem}.a-center{text-align:center}.a-right{text-align:right}.link{text-decoration:underline dotted}.ref{color:var(--muted);font-size:.75em;margin-left:.1em}.img-ph{display:inline-block;border:1px dashed var(--line);padding:.5rem;color:var(--muted);font-size:.875em}li.task{list-style:none}`;

/** srcdoc 自身の CSP。親の CSP と重ねて適用される（どちらも満たす必要がある）。 */
export function previewCsp(styleHash: string): string {
  return [
    "default-src 'none'",
    `style-src ${styleHash}`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** HTML 本体は markdown.ts の renderHtml が許可要素だけで作ったもの */
export function buildSrcdoc(bodyHtml: string, styleHash: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp(styleHash)}"><meta name="referrer" content="no-referrer"><style>${PREVIEW_CSS}</style></head><body>${bodyHtml}</body></html>`;
}
