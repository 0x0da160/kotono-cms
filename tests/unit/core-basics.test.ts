import { describe, expect, it } from "vitest";
import { allocateArticleId, generateArticleId, ID_ALPHABET, isValidArticleId } from "../../src/lib/core/article-id";
import { decodeUtf8Prefix, decodeUtf8Strict, utf8ByteLength } from "../../src/lib/core/bytes";
import {
  formatLocalDateTime,
  isValidDateTime,
  parseDateTime,
  publishTiming,
  sameInstant,
} from "../../src/lib/core/datetime";
import { checkSlugFormat, checkSlugUniqueness } from "../../src/lib/core/slug";
import { splitDocument } from "../../src/lib/core/split";

describe("日時の形式（8.1）", () => {
  it.each([
    "2026-11-03T22:08:00+09:00",
    "2026-11-03T22:08:00Z",
    "2026-11-03T22:08:00.1Z",
    "2026-11-03T22:08:00.123-05:30",
    "2000-02-29T00:00:00Z",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59+14:00",
    "2026-01-01T00:00:00+00:00",
  ])("有効：%s", (s) => expect(isValidDateTime(s)).toBe(true));

  it.each([
    "1900-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-11-03T24:00:00Z",
    "2026-11-03T23:59:60Z",
    "2026-11-03T22:08:00",
    "2026-11-03T22:08Z",
    "2026-11-03 22:08:00Z",
    "2026-11-03t22:08:00Z",
    "2026-11-03T22:08:00z",
    "2026-11-03T22:08:00.1234Z",
    "2026-11-03T22:08:00+14:01",
    "2026-11-03T22:08:00+15:00",
    "2026-11-03T22:08:00-00:00",
    "2026-11-03T22:08:00+0900",
    " 2026-11-03T22:08:00Z",
    "2026-11-03T22:08:00Z ",
    "0000-01-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
  ])("無効：%s", (s) => expect(isValidDateTime(s)).toBe(false));

  it("オフセット表記が違っても同じ時刻なら同値", () => {
    expect(sameInstant("2026-11-03T22:08:00+09:00", "2026-11-03T13:08:00Z")).toBe(true);
    expect(sameInstant("2026-11-03T13:08:00.000Z", "2026-11-03T13:08:00Z")).toBe(true);
    expect(sameInstant("2026-11-03T13:08:00.001Z", "2026-11-03T13:08:00Z")).toBe(false);
  });

  it("CMS生成値は秒精度・ローカルオフセット付きで、文法に適合する", () => {
    const s = formatLocalDateTime(new Date(2026, 10, 3, 22, 8, 5, 999));
    expect(isValidDateTime(s)).toBe(true);
    expect(s).toMatch(/^2026-11-03T22:08:05[+-]\d{2}:\d{2}$/);
  });

  it("公開日時の状態軸は時間軸で比較する（文字列順ではない）", () => {
    const now = parseDateTime("2026-11-03T13:00:00Z")?.epochMs ?? 0;
    expect(publishTiming(null, now)).toBe("unset");
    expect(publishTiming("2026-11-03T21:59:00+09:00", now)).toBe("past");
    expect(publishTiming("2026-11-03T13:00:01Z", now)).toBe("future");
    expect(publishTiming("bad", now)).toBe("invalid");
  });
});

describe("記事ID（5）", () => {
  it("規定の文字集合・長さで生成する", () => {
    for (let i = 0; i < 200; i++) {
      const id = generateArticleId(7);
      expect(id).toHaveLength(7);
      expect([...id].every((c) => ID_ALPHABET.includes(c))).toBe(true);
    }
    expect(generateArticleId(32)).toHaveLength(32);
    expect(() => generateArticleId(6)).toThrow();
    expect(() => generateArticleId(33)).toThrow();
  });

  it("文字種・長さを検証する（i・l・o・u は使わない）", () => {
    expect(isValidArticleId("k7m2x9q")).toBe(true);
    expect(isValidArticleId("k7m2x9qk7m2x9qk7m2x9qk7m2x9qk7m2")).toBe(true);
    expect(isValidArticleId("k7m2x9")).toBe(false);
    expect(isValidArticleId("k7m2x9i")).toBe(false);
    expect(isValidArticleId("K7M2X9Q")).toBe(false);
    expect(isValidArticleId("k7m2x9qk7m2x9qk7m2x9qk7m2x9qk7m2x")).toBe(false);
  });

  it("既存エントリーと重なれば再生成し、初回を含め最大11候補で停止する", async () => {
    const seq = ["aaaaaaa", "bbbbbbb", "ccccccc"];
    let i = 0;
    const gen = () => seq[i++] ?? "zzzzzzz";
    const r = await allocateArticleId(7, async (id) => id !== "ccccccc", gen);
    expect(r).toEqual({ ok: true, id: "ccccccc", attempts: 3 });

    let calls = 0;
    const full = await allocateArticleId(
      7,
      async () => (calls++, true),
      () => "aaaaaaa",
    );
    expect(full).toMatchObject({ ok: false, reason: "exhausted", attempts: 11 });
    expect(calls).toBe(11);
  });

  it("存在を確認できなければ停止する", async () => {
    const r = await allocateArticleId(7, async () => {
      throw new Error("io");
    });
    expect(r).toMatchObject({ ok: false, reason: "check-failed" });
  });
});

describe("slug（7.1）", () => {
  it.each(["a", "article-slug", "a1-b2-c3", "x".repeat(128)])("有効：%s", (s) =>
    expect(checkSlugFormat(s, "published")).toBeNull(),
  );
  it.each(["-a", "a-", "a--b", "A", "a_b", "あ", "a b", "x".repeat(129)])("無効：%s", (s) =>
    expect(checkSlugFormat(s, "draft")).not.toBeNull(),
  );
  it("下書きは空文字を許容し、公開対象は必須", () => {
    expect(checkSlugFormat("", "draft")).toBeNull();
    expect(checkSlugFormat("", "published")).toBe("required");
  });
  it("重複・検査不能を区別する。空文字同士は重複ではない", () => {
    const entries = [
      { id: "aaaaaaa", slug: "hello" },
      { id: "bbbbbbb", slug: "" },
      { id: "ccccccc", slug: null, uncheckable: true as const },
    ];
    expect(checkSlugUniqueness("hello", "zzzzzzz", entries)).toEqual({ kind: "duplicate", ids: ["aaaaaaa"] });
    expect(checkSlugUniqueness("hello", "aaaaaaa", entries)).toEqual({ kind: "uncheckable", ids: ["ccccccc"] });
    expect(checkSlugUniqueness("", "zzzzzzz", entries)).toEqual({ kind: "unique" });
    expect(checkSlugUniqueness("other", "ccccccc", entries)).toEqual({ kind: "unique" });
  });
});

describe("UTF-8（9.1）", () => {
  it("不正な UTF-8 は置換せず失敗とする。BOM は報告して除く", () => {
    expect(decodeUtf8Strict(new Uint8Array([0x61, 0xff]))).toEqual({ ok: false });
    expect(decodeUtf8Strict(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ ok: true, text: "a", bom: true });
  });
  it("先頭部分の読込では、末尾で途中切れの文字だけを落とす", () => {
    const bytes = new TextEncoder().encode("あい");
    expect(decodeUtf8Prefix(bytes.subarray(0, 4), true)).toEqual({ ok: true, text: "あ", bom: false });
    expect(decodeUtf8Prefix(new Uint8Array([0x61, 0xff, 0x61]), true)).toEqual({ ok: false });
  });
  it("UTF-8 バイト数", () => {
    expect(utf8ByteLength("aあ😀")).toBe(1 + 3 + 4);
  });
});

describe("frontmatter の区切り（9.1）", () => {
  it("LF・CRLF の独立行 --- で区切る", () => {
    const r = splitDocument("---\ntitle: a\n---\nbody\n---\nmore");
    expect(r).toMatchObject({ ok: true, frontmatter: "title: a\n", body: "body\n---\nmore" });
    const c = splitDocument("---\r\ntitle: a\r\n---\r\nbody");
    expect(c).toMatchObject({ ok: true, frontmatter: "title: a\r\n", body: "body" });
  });
  it("インデントされた --- や前後空白付きは区切りではない。... は閉じ区切りにしない", () => {
    const r = splitDocument("---\na: |\n  ---\nb: 1\n...\n---  \n--- \n---\nbody");
    expect(r).toMatchObject({ ok: true, frontmatter: "a: |\n  ---\nb: 1\n...\n---  \n--- \n", body: "body" });
  });
  it("開始区切りがない・閉じていない・上限超過を区別する", () => {
    expect(splitDocument("title: a\n")).toEqual({ ok: false, code: "no-frontmatter" });
    expect(splitDocument(" ---\n")).toEqual({ ok: false, code: "no-frontmatter" });
    expect(splitDocument("---\na: 1\n")).toEqual({ ok: false, code: "unclosed" });
    expect(splitDocument(`---\n${"a: 1\n".repeat(10)}---\n`, 20)).toEqual({ ok: false, code: "frontmatter-too-large" });
  });
  it("閉じ区切りが末尾（改行なし）でも本文は空", () => {
    expect(splitDocument("---\na: 1\n---")).toMatchObject({ ok: true, body: "" });
  });
  it("上限はUTF-8バイト数で数える", () => {
    const fm = "t: あああ\n"; // 3 + 9 + 1 = 13 bytes, 7 chars
    expect(splitDocument(`---\n${fm}---\n`, 12)).toEqual({ ok: false, code: "frontmatter-too-large" });
    expect(splitDocument(`---\n${fm}---\n`, 13)).toMatchObject({ ok: true });
  });
});
