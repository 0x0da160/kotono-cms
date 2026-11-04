import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCsp } from "../../build/csp";
import { PREVIEW_CSS } from "../../src/lib/preview/frame";

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

describe("buildCsp", () => {
  it("インラインの script・style をハッシュで許可し、通信を禁止する", () => {
    const html = `<style>body{}</style><script type="module">console.log(1)</script>`;
    const csp = buildCsp(html);
    expect(csp).toContain(`script-src ${hash("console.log(1)")}`);
    expect(csp).toContain(`style-src ${hash("body{}")} ${hash(PREVIEW_CSS)}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("インラインコードがなければ script を 'none' にし、style はプレビュー用 CSS だけを許可する", () => {
    const csp = buildCsp("<p>empty</p>");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain(`style-src ${hash(PREVIEW_CSS)};`);
  });

  it("画像は blob: と data: だけ、フレーム・フォーム・通信は禁止（16.1.1）", () => {
    const csp = buildCsp("<p>x</p>");
    expect(csp).toContain("img-src blob: data:;");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});
