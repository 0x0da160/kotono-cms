import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/lib/design/oklab";
import { BRAND, brandHex, semanticHex } from "../../src/lib/design/palette";

describe("ブランドの色", () => {
  it("design-system 0.4.0 の Petrol Blue と、そのダーク用の petrol-300 に一致する", () => {
    expect(BRAND.light).toBe("#0573aa");
    expect(BRAND.dark).toBe("#85cdff");
    expect(brandHex("light")).toBe("#0573aa");
    expect(brandHex("dark")).toBe("#85cdff");
  });

  it.each([
    ["light", "bg"],
    ["light", "surface"],
    ["dark", "bg"],
    ["dark", "surface"],
  ] as const)("%s テーマの %s の上で CMS の文字は 4.5:1 以上", (theme, bg) => {
    expect(contrastRatio(brandHex(theme), semanticHex(bg, theme))).toBeGreaterThanOrEqual(4.5);
  });
});
