/**
 * docs/knowledge/ が Open Knowledge Format (OKF) v0.2 に適合するかを検査する。
 * https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
 *
 * - §11 適合条件（frontmatter・type・予約ファイル）
 * - §5・§7 の任意フィールド（generated / verified / status / stale_after / sources）の形式
 * - §6 リンクの解決（OKF の利用側は壊れたリンクを許容するが、本リポジトリでは生成側として壊さない）
 * - §8 index.md の網羅
 * - 仕様書原本との一致（各章の本文を連結すると原本と完全一致すること）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const BUNDLE = resolve(import.meta.dirname, "../../docs/knowledge");
const SPEC = resolve(import.meta.dirname, "../../docs/spec/local-cms-specification-v3.1.md");
const RELATED_MARKER = "\n<!-- okf:related -->";
const RESERVED = new Set(["index.md", "log.md"]);

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ACTOR = /^(?:human:[^\s]+|process:[^\s]+|[^\s:/]+\/[^\s]+)$/;

interface Doc {
  rel: string; // bundle-relative POSIX path
  abs: string;
  raw: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  if (!raw.startsWith("---\n")) return { yaml: null, body: raw };
  const end = raw.indexOf("\n---\n", 3);
  if (end < 0) throw new Error("frontmatter が閉じていません");
  return { yaml: raw.slice(4, end + 1), body: raw.slice(end + 5) };
}

function load(abs: string): Doc {
  const raw = readFileSync(abs, "utf8");
  const { yaml, body } = splitFrontmatter(raw);
  let frontmatter: Record<string, unknown> | null = null;
  if (yaml !== null) {
    const doc = parseDocument(yaml, { uniqueKeys: true, strict: true });
    if (doc.errors.length > 0) throw new Error(`${abs}: ${doc.errors.map((e) => e.message).join("; ")}`);
    frontmatter = doc.toJS() as Record<string, unknown>;
  }
  return { rel: relative(BUNDLE, abs).split("\\").join("/"), abs, raw, frontmatter, body };
}

const docs = walk(BUNDLE).map(load);
const concepts = docs.filter((d) => !RESERVED.has(posix.basename(d.rel)));

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

describe("OKF v0.2 適合（§11）", () => {
  it("バンドルに概念文書がある", () => {
    expect(concepts.length).toBeGreaterThan(0);
  });

  it.each(concepts.map((d) => [d.rel, d] as const))("%s: frontmatter と空でない type を持つ", (_rel, d) => {
    expect(d.frontmatter).not.toBeNull();
    expect(typeof d.frontmatter?.["type"]).toBe("string");
    expect(String(d.frontmatter?.["type"]).trim()).not.toBe("");
  });

  it.each(concepts.map((d) => [d.rel, d] as const))("%s: 任意フィールドが §5・§7 の形式に従う", (_rel, d) => {
    const fm = d.frontmatter ?? {};
    for (const key of ["title", "description", "resource"]) {
      if (key in fm) expect(typeof fm[key], key).toBe("string");
    }
    if ("tags" in fm) {
      expect(Array.isArray(fm["tags"])).toBe(true);
      for (const t of fm["tags"] as unknown[]) expect(typeof t).toBe("string");
    }
    if ("status" in fm) expect(["draft", "stable", "deprecated"]).toContain(fm["status"]);
    if ("stale_after" in fm) expect(String(fm["stale_after"])).toMatch(ISO_DATETIME);

    if ("generated" in fm) {
      const g = fm["generated"] as Record<string, unknown>;
      expect(String(g["by"])).toMatch(ACTOR);
      if ("at" in g) expect(String(g["at"])).toMatch(ISO_DATETIME);
    }
    for (const v of asList(fm["verified"])) {
      const e = v as Record<string, unknown>;
      expect(String(e["by"])).toMatch(ACTOR);
      expect(String(e["at"])).toMatch(ISO_DATETIME);
    }

    const sources = asList(fm["sources"]) as Record<string, unknown>[];
    const ids = sources.map((s) => s["id"]).filter((id): id is string => typeof id === "string");
    expect(new Set(ids).size, "sources[].id は一意").toBe(ids.length);
    for (const s of sources) {
      expect(typeof s["resource"], "sources[].resource は必須").toBe("string");
      if ("author" in s) expect(String(s["author"])).toMatch(/^(?:human:|process:|team:|[^\s:/]+\/)/);
      if ("last_modified" in s) expect(String(s["last_modified"])).toMatch(ISO_DATETIME);
    }

    // §5.1 主張単位の帰属: 脚注ラベルは sources[].id に対応する
    const labels = new Set([...d.body.matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]));
    for (const label of labels) expect(ids, `脚注 [^${label}]`).toContain(label);
  });

  it("index.md は frontmatter を持たない（ルートの okf_version を除く・§8・§12）", () => {
    for (const d of docs.filter((x) => posix.basename(x.rel) === "index.md")) {
      if (d.rel === "index.md") {
        expect(d.frontmatter).toEqual({ okf_version: "0.2" });
      } else {
        expect(d.frontmatter, d.rel).toBeNull();
      }
      for (const line of d.body.split("\n").filter((l) => l.trim() !== "")) {
        expect(line, d.rel).toMatch(/^(?:# .+|\* \[[^\]]+\]\([^)]+\)(?: - .+)?)$/);
      }
    }
  });

  it("log.md は ISO 8601 の日付見出しで新しい順に並ぶ（§9）", () => {
    for (const d of docs.filter((x) => posix.basename(x.rel) === "log.md")) {
      expect(d.frontmatter).toBeNull();
      const dates = [...d.body.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? "");
      expect(dates.length).toBeGreaterThan(0);
      for (const date of dates) {
        expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(`${date}T00:00:00Z`))).toBe(false);
      }
      expect([...dates].sort().reverse()).toEqual(dates);
    }
  });
});

describe("リンクと index の網羅（§6・§8）", () => {
  const exists = (p: string) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  };

  it("バンドル内リンクと sources の相対パスがすべて解決する", () => {
    const broken: string[] = [];
    for (const d of docs) {
      for (const m of d.body.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (m[1] ?? "").split("#")[0] ?? "";
        if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const abs = target.startsWith("/") ? join(BUNDLE, target) : resolve(dirname(d.abs), target);
        if (!exists(abs)) broken.push(`${d.rel} -> ${target}`);
      }
      for (const s of asList(d.frontmatter?.["sources"]) as Record<string, unknown>[]) {
        const r = String(s["resource"]);
        if (/^[a-z][a-z0-9+.-]*:/i.test(r) || /\s/.test(r)) continue; // URL またはスコープ記述
        const abs = r.startsWith("/") ? join(BUNDLE, r) : resolve(dirname(d.abs), r);
        if (!exists(abs)) broken.push(`${d.rel} sources -> ${r}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("各ディレクトリの index.md が概念文書と下位ディレクトリをすべて列挙する", () => {
    const missing: string[] = [];
    const dirs = new Set(docs.map((d) => posix.dirname(d.rel)));
    for (const dir of dirs) {
      const index = docs.find((d) => d.rel === posix.join(dir, "index.md"));
      if (!index) {
        missing.push(`${dir}/index.md`);
        continue;
      }
      const linked = new Set([...index.body.matchAll(/\]\(([^)]+)\)/g)].map((m) => posix.normalize(m[1] ?? "")));
      for (const d of concepts.filter((c) => posix.dirname(c.rel) === dir)) {
        if (!linked.has(posix.basename(d.rel))) missing.push(d.rel);
      }
      for (const sub of [...dirs].filter((x) => x !== dir && posix.dirname(x) === dir)) {
        const name = posix.relative(dir, sub);
        if (![...linked].some((l) => l === `${name}/index.md` || l === `${name}/`)) missing.push(`${sub}/`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("仕様書原本との一致", () => {
  const chapters = concepts
    .filter((d) => typeof d.frontmatter?.["spec_chapter"] === "number")
    .sort((a, b) => Number(a.frontmatter?.["spec_chapter"]) - Number(b.frontmatter?.["spec_chapter"]));

  it("概要と第1〜37章がそろっている", () => {
    expect(chapters.map((d) => d.frontmatter?.["spec_chapter"])).toEqual(Array.from({ length: 38 }, (_, i) => i));
  });

  it("各章の転記本文を連結すると原本と完全一致する", () => {
    const original = readFileSync(SPEC, "utf8");
    const transcribed = chapters
      .map((d) => {
        const i = d.body.indexOf(RELATED_MARKER);
        return i < 0 ? d.body : d.body.slice(0, i);
      })
      .join("");
    expect(transcribed).toBe(original);
  });
});
