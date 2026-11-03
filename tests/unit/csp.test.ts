import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCsp } from "../../build/csp";

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

describe("buildCsp", () => {
  it("インラインの script・style をハッシュで許可し、通信を禁止する", () => {
    const html = `<style>body{}</style><script type="module">console.log(1)</script>`;
    const csp = buildCsp(html);
    expect(csp).toContain(`script-src ${hash("console.log(1)")}`);
    expect(csp).toContain(`style-src ${hash("body{}")}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("インラインコードがなければ script・style を 'none' にする", () => {
    const csp = buildCsp("<p>empty</p>");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'none'");
  });
});
