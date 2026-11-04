/** 専用の修復操作（仕様 10.3・24.1）：差分を示し、確認後に適用する。他の項目は変えない */
import { describe, expect, it } from "vitest";
import { addTopLevelString, analyzeText, proposeCreatedAtFix, proposeIdFix } from "../../src/lib/core/article-doc";
import { Workspace } from "../../src/lib/app/workspace.svelte";
import { EditorSession } from "../../src/lib/app/session.svelte";
import { MemFs } from "./support/memory-fs";

const doc = (over: Record<string, string | null> = {}) => {
  const v: Record<string, string | null> = {
    id: '"k7m2x9q"',
    title: '"T" # 見出し',
    slug: '"s"',
    status: '"draft"',
    createdAt: '"2026-11-03T22:08:00+09:00"',
    updatedAt: '"2026-11-04T10:00:00+09:00"',
    publishedAt: "null",
    tags: "[]",
    cover: "null",
    custom: "{ a: 1 }",
    ...over,
  };
  const lines = Object.entries(v)
    .filter(([, x]) => x !== null)
    .map(([k, x]) => `${k}: ${x}`);
  return `---\n${lines.join("\n")}\n---\n本文\n`;
};

describe("ID 不一致の修正（10.3）", () => {
  it("フォルダ名を正として id だけを直す", () => {
    const text = doc({ id: '"p4c8n6w"' });
    const p = proposeIdFix(text, "k7m2x9q");
    if ("error" in p) throw new Error(p.error);
    expect(p.before).toBe('id: "p4c8n6w"');
    expect(p.after).toBe('id: "k7m2x9q"');
    expect(p.text).toBe(doc());
    expect(analyzeText(p.text, "k7m2x9q").problems).toEqual([]);
  });

  it("一致していれば提案しない", () => {
    expect(proposeIdFix(doc(), "k7m2x9q")).toHaveProperty("error");
  });
});

describe("createdAt の修正（24.1）", () => {
  it("不足していれば末尾に追加し、他の項目・コメントを保持する", () => {
    const text = doc({ createdAt: null });
    const p = proposeCreatedAtFix(text, "k7m2x9q", "2026-11-04T10:00:00+09:00");
    if ("error" in p) throw new Error(p.error);
    expect(p.before).toBeNull();
    expect(p.text).toContain('custom: { a: 1 }\ncreatedAt: "2026-11-04T10:00:00+09:00"\n---');
    expect(p.text).toContain('title: "T" # 見出し');
    expect(analyzeText(p.text, "k7m2x9q").problems).toEqual([]);
  });

  it("不正な値を置き換える", () => {
    const p = proposeCreatedAtFix(doc({ createdAt: '"昨日"' }), "k7m2x9q", "2026-11-04T10:00:00+09:00");
    if ("error" in p) throw new Error(p.error);
    expect(p.before).toBe('createdAt: "昨日"');
    expect(analyzeText(p.text, "k7m2x9q").problems).toEqual([]);
  });

  it("既にある項目は追加しない", () => {
    expect(addTopLevelString(doc(), "createdAt", "x").ok).toBe(false);
  });

  it("確認後に編集内容へ適用し、ディスクは保存まで変えない", async () => {
    const fs = new MemFs();
    const text = doc({ id: '"p4c8n6w"' });
    fs.write("content/articles/k7m2x9q/index.md", text);
    const ws = new Workspace({});
    await ws.openRoot(fs.root);
    await ws.openArticle("k7m2x9q");
    const s = ws.session as EditorSession;
    const asked: string[][] = [];
    ws.ask = async (r) => {
      asked.push([...(r.details ?? [])]);
      return "apply";
    };
    await ws.repairId();
    expect(asked[0]?.slice(0, 2)).toEqual(['変更前：id: "p4c8n6w"', '変更後：id: "k7m2x9q"']);
    expect(s.text).toBe(doc());
    expect(fs.readText("content/articles/k7m2x9q/index.md")).toBe(text);
    ws.ask = async () => "cancel";
    s.setText(doc({ createdAt: null }), null);
    await ws.repairCreatedAt("updatedAt");
    expect(s.text).toBe(doc({ createdAt: null }));
  });
});
