import { describe, expect, it } from "vitest";
import { canonicalFloat, getValueNode, nodesEqual, parseFrontmatter } from "../../src/lib/core/yaml-doc";

function value(src: string) {
  const p = parseFrontmatter(`v: ${src}\n`);
  if (!p.ok) throw new Error(JSON.stringify(p.problems));
  return getValueNode(p.root, "v");
}

describe("YAML の対応範囲（9.2）", () => {
  it("ルートは文字列キーのマッピング", () => {
    expect(parseFrontmatter("- a\n")).toMatchObject({ ok: false, problems: [{ kind: "root" }] });
    expect(parseFrontmatter("")).toMatchObject({ ok: false, problems: [{ kind: "root" }] });
    expect(parseFrontmatter("1: a\n")).toMatchObject({ ok: false, problems: [{ kind: "unsupported" }] });
    expect(parseFrontmatter("? [a]\n: 1\n")).toMatchObject({ ok: false, problems: [{ kind: "unsupported" }] });
    expect(parseFrontmatter('"1": a\n').ok).toBe(true);
  });

  it("キーの重複はエラー", () => {
    expect(parseFrontmatter("a: 1\na: 2\n")).toMatchObject({
      ok: false,
      problems: [{ kind: "duplicate-key", line: 2 }],
    });
  });

  it.each([
    ["アンカー", "a: &x 1\n"],
    ["エイリアス", "a: &x 1\nb: *x\n"],
    ["マージキー", "base: {a: 1}\nc:\n  <<: {a: 1}\n"],
    ["独自タグ", "a: !custom x\n"],
    ["非コアタグ", "a: !!binary aGk=\n"],
  ])("%s を含む文書は非対応（読み取り専用）", (_n, src) => {
    const p = parseFrontmatter(src);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.problems.some((x) => x.kind === "unsupported" || x.kind === "syntax")).toBe(true);
  });

  it("コアスキーマのタグは許容する", () => {
    expect(parseFrontmatter("a: !!str 123\n").ok).toBe(true);
  });

  it("構文エラーは行・列つきで報告する", () => {
    const p = parseFrontmatter("a: 1\nb: [\n");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.problems[0]?.line).toBeGreaterThan(0);
  });

  it("入れ子の上限（50段）を超えると予算超過", () => {
    const deep = (n: number) => `a: ${"[".repeat(n)}${"]".repeat(n)}\n`;
    expect(parseFrontmatter(deep(48)).ok).toBe(true);
    expect(parseFrontmatter(deep(60))).toMatchObject({ ok: false, problems: [{ kind: "budget" }] });
  });

  it("単一スカラーの上限（256 KiB）を超えると予算超過", () => {
    expect(parseFrontmatter(`a: "${"x".repeat(256 * 1024 + 1)}"\n`)).toMatchObject({
      ok: false,
      problems: [{ kind: "budget" }],
    });
  });

  it("ノード数・キー数の上限を超えると予算超過", () => {
    const many = Array.from({ length: 20_001 }, (_, i) => `k${i}: 1`).join("\n");
    expect(parseFrontmatter(`${many}\n`)).toMatchObject({ ok: false, problems: [{ kind: "budget" }] });
  });

  it("巨大整数を Number へ丸めない", () => {
    const n = value("123456789012345678901234567890");
    expect(n && "value" in n ? n.value : null).toBe(123456789012345678901234567890n);
  });
});

describe("意味的同値（8.3）", () => {
  const eq = (a: string, b: string) => nodesEqual(value(a), value(b));

  it.each([
    ["引用符の違い", '"abc"', "'abc'"],
    ["plain と引用符", "abc", '"abc"'],
    ["巨大整数", "123456789012345678901234567890", "123456789012345678901234567890"],
    ["指数表記の正規化", "1.50e3", "1500.0"],
    ["小数の末尾ゼロ", "0.10", "0.1"],
    ["NaN 同士", ".nan", ".NaN"],
    ["正負のゼロ（浮動小数）", "-0.0", "0.0"],
    ["正負のゼロ（整数）", "-0", "0"],
    ["16進と10進の整数", "0x10", "16"],
    ["null の表記", "null", "~"],
    ["マッピングのキー順", "{a: 1, b: 2}", "{b: 2, a: 1}"],
    ["フローとブロック", "[a, b]", "[ a , b ]"],
  ])("同値：%s", (_n, a, b) => expect(eq(a, b)).toBe(true));

  it.each([
    ["数値と文字列", "1", '"1"'],
    ["null と空文字", "null", '""'],
    ["配列とマッピング", "[]", "{}"],
    ["配列の順序", "[a, b]", "[b, a]"],
    ["整数と浮動小数", "1", "1.0"],
    ["正負の無限大", ".inf", "-.inf"],
    ["巨大整数の末尾", "123456789012345678901234567890", "123456789012345678901234567891"],
    ["精度を超える小数", "0.1000000000000000000001", "0.1"],
    ["真偽値と文字列", "true", '"true"'],
    ["日時は文字列としては別表記", '"2026-11-03T22:08:00+09:00"', '"2026-11-03T13:08:00Z"'],
  ])("非同値：%s", (_n, a, b) => expect(eq(a, b)).toBe(false));

  it("十進数・指数を精度を保って正規化する", () => {
    expect(canonicalFloat("1.50e3")).toBe("15e2");
    expect(canonicalFloat("-0.0")).toBe("0");
    expect(canonicalFloat(".inf")).toBe("+inf");
    expect(canonicalFloat("-.Inf")).toBe("-inf");
    expect(canonicalFloat("abc")).toBeNull();
  });
});
