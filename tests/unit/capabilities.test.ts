import { describe, expect, it } from "vitest";
import { detectCapabilities, isSupported } from "../../src/lib/capabilities";

class FakeHandle {
  createWritable(): void {}
}

function supportedHost(): Record<string, unknown> {
  return {
    isSecureContext: true,
    showDirectoryPicker: () => undefined,
    FileSystemFileHandle: FakeHandle,
    Worker: function Worker() {},
    Blob: function Blob() {},
    URL,
    crypto: globalThis.crypto,
    indexedDB: {},
    TextDecoder,
  };
}

describe("detectCapabilities", () => {
  it("必要なAPIがすべてあれば対応環境と判定する", () => {
    const results = detectCapabilities(supportedHost());
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(isSupported(results)).toBe(true);
  });

  it("空の環境ではすべて非対応とし、影響を説明する", () => {
    const results = detectCapabilities({});
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => r.impact.length > 0)).toBe(true);
    expect(isSupported(results)).toBe(false);
  });

  it("フォルダ選択APIがなければ非対応とする（Firefox・Safari 等）", () => {
    const host = supportedHost();
    delete host["showDirectoryPicker"];
    const results = detectCapabilities(host);
    expect(results.find((r) => r.id === "directory-picker")?.ok).toBe(false);
    expect(isSupported(results)).toBe(false);
  });

  it("不正な UTF-8 を置換する TextDecoder は厳密デコード非対応とする", () => {
    class LenientDecoder {
      decode(): string {
        return "�";
      }
    }
    const host = { ...supportedHost(), TextDecoder: LenientDecoder };
    expect(detectCapabilities(host).find((r) => r.id === "strict-utf8")?.ok).toBe(false);
  });
});
