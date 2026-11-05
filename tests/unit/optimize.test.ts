/**
 * 画像の最適化の計画と、派生画像の名前・選択（ADR-0005）。実際の縮小・再エンコードは E2E で確かめる。
 */
import { describe, expect, it } from "vitest";
import { IdbRecentFolderStore, looksLikeDirHandle, validRecent } from "../../src/lib/app/recent-folder";
import {
  chooseVariant,
  fitWithin,
  ORIGINAL_MAX_PIXELS,
  ORIGINAL_MAX_SIDE,
  originalFormat,
  parseVariantName,
  variantName,
  variantWidths,
} from "../../src/lib/fs/optimize";
import { IDBFactory } from "fake-indexeddb";

describe("原本の寸法", () => {
  it("縦横・総画素数の上限に収め、縦横比を保ち、拡大しない", () => {
    expect(fitWithin(800, 600, ORIGINAL_MAX_SIDE, ORIGINAL_MAX_PIXELS)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(8000, 2000, ORIGINAL_MAX_SIDE, ORIGINAL_MAX_PIXELS)).toEqual({ width: 4096, height: 1024 });
    const big = fitWithin(6000, 6000, ORIGINAL_MAX_SIDE, ORIGINAL_MAX_PIXELS);
    expect(big.width * big.height).toBeLessThanOrEqual(ORIGINAL_MAX_PIXELS);
    expect(big.width).toBe(big.height);
    expect(big.width).toBeGreaterThan(3990);
    const tall = fitWithin(3000, 20000, ORIGINAL_MAX_SIDE, ORIGINAL_MAX_PIXELS);
    expect(tall.height).toBe(4096);
  });

  it("書き出せない形式は書き出せる形式にする", () => {
    expect(originalFormat("jpeg")).toBe("jpeg");
    expect(originalFormat("png")).toBe("png");
    expect(originalFormat("webp")).toBe("webp");
    expect(originalFormat("gif")).toBe("png");
    expect(originalFormat("avif")).toBe("webp");
  });
});

describe("派生画像", () => {
  it("原本より狭い幅だけを作り、小さい画像は原寸で1つ作る", () => {
    expect(variantWidths(4096)).toEqual([480, 960, 1920]);
    expect(variantWidths(1200)).toEqual([480, 960, 1200]);
    expect(variantWidths(960)).toEqual([480, 960]);
    expect(variantWidths(300)).toEqual([300]);
  });

  it("名前を作り・読み、表示幅に合うものを WebP 優先で選ぶ", () => {
    expect(variantName("abcdefghjk", 960, "webp")).toBe("abcdefghjk-960w.webp");
    expect(parseVariantName("abcdefghjk-960w.jpg")).toEqual({
      mediaId: "abcdefghjk",
      name: "abcdefghjk-960w.jpg",
      width: 960,
      format: "jpeg",
    });
    expect(parseVariantName("abcdefghjk-960.jpg")).toBeNull();
    expect(parseVariantName("../x-1w.png")).toBeNull();
    const vs = [480, 960, 1920].flatMap((w) => [
      { name: `a-${w}w.jpg`, width: w, format: "jpeg" as const },
      { name: `a-${w}w.webp`, width: w, format: "webp" as const },
    ]);
    expect(chooseVariant(vs, 700)?.name).toBe("a-960w.webp");
    expect(chooseVariant(vs, 3000)?.name).toBe("a-1920w.webp");
    expect(
      chooseVariant(
        vs.filter((v) => v.format === "jpeg"),
        100,
      )?.name,
    ).toBe("a-480w.jpg");
    expect(chooseVariant([], 100)).toBeNull();
  });
});

describe("前回のフォルダの記憶（ADR-0005）", () => {
  it("1件だけ保存し、読み戻した記録を検査する", async () => {
    const store = new IdbRecentFolderStore(new IDBFactory());
    expect(await store.load()).toBeNull();
    await store.save({ kind: "directory", name: "site" }, "site");
    expect((await store.load())?.name).toBe("site");
    await store.save({ kind: "directory", name: "other" }, "other");
    expect((await store.load())?.name).toBe("other");
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(validRecent({ name: "", at: 1, handle: {} })).toBe(false);
    expect(validRecent({ name: "x", at: Number.NaN, handle: {} })).toBe(false);
  });

  it("メソッドを失ったハンドルは使わない", () => {
    expect(looksLikeDirHandle({ kind: "directory", name: "x" })).toBe(false);
    expect(
      looksLikeDirHandle({
        kind: "directory",
        name: "x",
        getDirectoryHandle: () => null,
        getFileHandle: () => null,
        values: () => null,
      }),
    ).toBe(true);
  });
});
