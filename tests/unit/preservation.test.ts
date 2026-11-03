/**
 * YAML 往復保持フィクスチャ（仕様 9.3・9.4、26.2 D02・D03、TG07）。
 * `UPDATE_FIXTURES=1` で expected を書き出す（書き出した結果は必ず目視で確認すること）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeText, editField, replaceBody } from "../../src/lib/core/article-doc";
import type { StandardKey } from "../../src/lib/core/schema";
import { splitDocument } from "../../src/lib/core/split";
import { collectComments, parseFrontmatter, type FieldValue } from "../../src/lib/core/yaml-doc";

const DIR = resolve(import.meta.dirname, "../fixtures/preservation");
type Edit = { field: StandardKey; value: FieldValue } | { body: string };
interface Case {
  name: string;
  description: string;
  edits: Edit[];
  expect: "exact" | "reject";
}
const manifest = JSON.parse(readFileSync(resolve(DIR, "cases.json"), "utf8")) as { cases: Case[] };

function applyEdits(text: string, edits: Edit[]): { ok: true; text: string } | { ok: false; message: string } {
  let t = text;
  for (const e of edits) {
    const r = "body" in e ? replaceBody(t, e.body) : editField(t, e.field, e.value);
    if (!r.ok) return r;
    t = r.text;
  }
  return { ok: true, text: t };
}

function comments(text: string): string[] {
  const s = splitDocument(text);
  if (!s.ok) throw new Error("split");
  const p = parseFrontmatter(s.frontmatter);
  if (!p.ok) throw new Error("parse");
  return collectComments(p.doc);
}

describe.each(manifest.cases.map((c) => [c.name, c] as const))("保持フィクスチャ %s", (name, c) => {
  const input = readFileSync(resolve(DIR, `${name}.input.md`), "utf8");

  it("入力は解析でき、標準スキーマを満たす", () => {
    expect(analyzeText(input, "k7m2x9q").problems).toEqual([]);
  });

  if (c.expect === "reject") {
    it("保持できない変更は拒否する（黙って保存しない）", () => {
      const r = applyEdits(input, c.edits);
      expect(r.ok).toBe(false);
    });
    return;
  }

  it("期待どおりの原文になり、コメント・未知項目・本文を保持する", () => {
    const r = applyEdits(input, c.edits);
    if (!r.ok) throw new Error(r.message);
    const expectedPath = resolve(DIR, `${name}.expected.md`);
    if (process.env["UPDATE_FIXTURES"] === "1") writeFileSync(expectedPath, r.text);
    expect(existsSync(expectedPath), `${name}.expected.md がありません`).toBe(true);
    expect(r.text).toBe(readFileSync(expectedPath, "utf8"));
    expect(analyzeText(r.text, "k7m2x9q").problems).toEqual([]);
    // コメントは同じ集合のまま（9.4）
    expect(comments(r.text)).toEqual(comments(input));
    // 本文は（本文を変える編集がない限り）変わらない（9.3）
    if (!c.edits.some((e) => "body" in e)) {
      const a = splitDocument(input);
      const b = splitDocument(r.text);
      expect(a.ok && b.ok && a.body === b.body).toBe(true);
    }
  });
});
