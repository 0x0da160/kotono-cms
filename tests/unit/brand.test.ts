import { describe, expect, it } from "vitest";
import { semanticHex } from "../../src/lib/design/palette";

describe("ロゴの色", () => {
  it("記号と CMS は 0.4.0 の Petrol Blue。ダークは petrol-300（accent と同じ値）", () => {
    expect(semanticHex("brand", "light")).toBe("#0573aa");
    expect(semanticHex("brand", "dark")).toBe("#85cdff");
  });
});
