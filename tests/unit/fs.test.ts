/**
 * ファイル層の契約試験（3.1・4.2・7.1・12.1・13.2・13.3・10.1・5.3）。
 * メモリ上の実装での失敗注入であり、実フォルダでの TG01・TG04・TG06 の代替ではない。
 */
import { describe, expect, it } from "vitest";
import { encodeUtf8 } from "../../src/lib/core/bytes";
import { newArticleText } from "../../src/lib/core/article-doc";
import {
  canCreateArticles,
  createArticlesDir,
  openArticlesDir,
  parseConfig,
  readConfig,
  scanArticles,
  slugEntries,
} from "../../src/lib/fs/repo";
import { createArticle, saveExisting, SerialQueue } from "../../src/lib/fs/save";
import { MemDir, MemFile, MemFs } from "./support/memory-fs";

const ID = "k7m2x9q";
const article = (id: string, extra = "", slug = "s") =>
  `---\nid: "${id}"\ntitle: "T"\nslug: "${slug}"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n${extra}---\n本文\n`;

describe("初回フォルダ準備（3.1）", () => {
  it("content/articles/ がなければ作成せずに報告し、確認後に作成する", async () => {
    const fs = new MemFs();
    expect(await openArticlesDir(fs.root)).toEqual({ kind: "missing", missing: "content" });
    expect(fs.root.children.size).toBe(0);
    expect((await createArticlesDir(fs.root)).kind).toBe("ok");
    expect((await openArticlesDir(fs.root)).kind).toBe("ok");
  });
  it("期待するディレクトリ位置に同名の通常ファイルがあればエラーとし、置換しない", async () => {
    const fs = new MemFs();
    fs.write("content", "x");
    expect((await openArticlesDir(fs.root)).kind).toBe("error");
    expect((await createArticlesDir(fs.root)).kind).toBe("error");
    expect(fs.readText("content")).toBe("x");
  });
});

describe("設定ファイル（4・26.1 A05）", () => {
  it("ない場合は既定値", async () => {
    const c = await readConfig(new MemFs().root);
    expect(c).toMatchObject({ state: "default", idLength: 7 });
    expect(canCreateArticles(c)).toBeNull();
  });
  it("構文エラー・ルート型不正・未知の版は全体不正（新規作成停止）", () => {
    for (const t of ["{", "[]", '{"schemaVersion": 2}']) {
      const c = parseConfig(t);
      expect(c.state, t).toBe("invalid");
      expect(canCreateArticles(c)).not.toBeNull();
    }
  });
  it("ID 長だけ不正なら新規作成だけを止め、メディア設定だけ不正なら取り込みだけを止める", () => {
    const id = parseConfig('{"articleId": {"length": 6}}');
    expect(id).toMatchObject({ state: "ok", idLengthValid: false, mediaValid: true });
    expect(canCreateArticles(id)).not.toBeNull();
    const media = parseConfig('{"media": {"maxBatchFiles": 0}}');
    expect(media).toMatchObject({ state: "ok", idLengthValid: true, mediaValid: false });
    expect(canCreateArticles(media)).toBeNull();
  });
  it("未知キーは警告して無視する", () => {
    const c = parseConfig('{"schemaVersion": 1, "articleId": {"length": 10}, "extra": true}');
    expect(c).toMatchObject({ state: "ok", idLength: 10 });
    expect(c.warnings.length).toBe(1);
  });
  it("上限サイズを超える設定は読み込まずに全体不正とする", async () => {
    const fs = new MemFs();
    fs.write("cms.config.json", " ".repeat(64 * 1024 + 1));
    expect((await readConfig(fs.root)).state).toBe("invalid");
  });
});

describe("一覧（23・24・26.5 S07）", () => {
  it("正常・不完全・不正・非対応を記事単位に隔離して一覧化する", async () => {
    const fs = new MemFs();
    fs.write(`content/articles/${ID}/index.md`, article(ID, "", "a"));
    fs.write("content/articles/p4c8n6w/index.md", article("p4c8n6w", "x: [\n", "b"));
    fs.write("content/articles/q5d9m3z/index.md", article("q5d9m3z", "x: &a 1\n", "c"));
    fs.mkdir("content/articles/r6e2n4y");
    fs.write("content/articles/BADNAME/index.md", article("BADNAME"));
    fs.write("content/articles/s7f3p5a/index.md", new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]));
    fs.write("content/articles/README.txt", "x");
    const st = await openArticlesDir(fs.root);
    if (st.kind !== "ok") throw new Error();
    const scan = await scanArticles(st.dir);
    const by = Object.fromEntries(scan.entries.map((e) => [e.dirName, e]));
    expect(by[ID]).toMatchObject({ kind: "article", problems: [], readOnly: false, values: { slug: "a" } });
    expect(by["p4c8n6w"]).toMatchObject({ kind: "article", readOnly: false, slugKnown: false });
    expect(by["p4c8n6w"]?.problems.length).toBeGreaterThan(0);
    expect(by["q5d9m3z"]).toMatchObject({ kind: "article", readOnly: true });
    expect(by["r6e2n4y"]).toMatchObject({ kind: "incomplete" });
    expect(by["BADNAME"]).toMatchObject({ readOnly: true });
    expect(by["s7f3p5a"]).toMatchObject({ readOnly: true });
    expect(by["README.txt"]).toMatchObject({ kind: "not-directory" });
    expect(scan.complete).toBe(true);

    // 抽出不能は「空slug」と見なさず検査不能とする（7.1）
    const slugs = slugEntries(scan);
    expect(slugs.find((e) => e.id === "p4c8n6w")).toEqual({ id: "p4c8n6w", slug: null, uncheckable: true });
    expect(slugs.find((e) => e.id === "r6e2n4y")).toBeUndefined();
  });
});

async function setup(content = article(ID)) {
  const fs = new MemFs();
  const file = fs.write(`content/articles/${ID}/index.md`, content);
  const st = await openArticlesDir(fs.root);
  if (st.kind !== "ok") throw new Error();
  return { fs, file, articles: st.dir, base: encodeUtf8(content) };
}

const ok = (t: string) => () => ({ ok: true as const, bytes: encodeUtf8(t) });

describe("保存契約（12.1・13.2・13.3・26.3）", () => {
  it("基準版と一致すれば書き込み、再読込一致で成功", async () => {
    const { fs, file, articles, base } = await setup();
    const next = article(ID).replace("本文", "変更");
    const r = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: null,
      buildCandidate: ok(next),
    });
    expect(r.kind).toBe("saved");
    expect(file.text()).toBe(next);
  });

  it("F01：外部で内容変更・削除・別種エントリーへの置換があれば保存を止め、上書きしない", async () => {
    for (const mutate of [
      (fs: MemFs, f: MemFile) => (f.data = encodeUtf8("external")),
      (fs: MemFs) => fs.remove(`content/articles/${ID}/index.md`),
      (fs: MemFs) => {
        fs.remove(`content/articles/${ID}/index.md`);
        fs.mkdir(`content/articles/${ID}/index.md`);
      },
      (fs: MemFs) => fs.remove(`content/articles/${ID}`),
    ]) {
      const { fs, file, articles, base } = await setup();
      mutate(fs, file);
      let built = false;
      const r = await saveExisting({
        root: fs.root,
        articles,
        id: ID,
        baseBytes: base,
        previousCandidate: null,
        buildCandidate: () => ((built = true), { ok: true, bytes: encodeUtf8("mine") }),
      });
      expect(r.kind).toBe("external-change");
      expect(built).toBe(false);
      expect(file.writes).toHaveLength(0);
    }
  });

  it("同じサイズ・同じ mtime でも内容が違えば外部変更とする", async () => {
    const { fs, file, articles, base } = await setup();
    const lm = file.lastModified;
    file.data = encodeUtf8(article(ID).replace("本文", "本分"));
    file.lastModified = lm;
    const r = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: null,
      buildCandidate: ok("x"),
    });
    expect(r.kind).toBe("external-change");
  });

  it("権限拒否では書き込まず、権限不足として返す（A02）", async () => {
    const { fs, file, articles, base } = await setup();
    fs.faults.permission = "prompt";
    fs.faults.requestResult = "denied";
    const r = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: null,
      buildCandidate: ok("x"),
    });
    expect(r.kind).toBe("permission-denied");
    expect(file.writes).toHaveLength(0);
  });

  it("F02：書き込み・クローズ失敗では成功とせず、ディスクを読み直して状態を識別する", async () => {
    for (const fault of ["beforeWrite", "beforeClose"] as const) {
      const { fs, file, articles, base } = await setup();
      fs.faults[fault] = () => {
        const e = new Error("disk full");
        e.name = "QuotaExceededError";
        throw e;
      };
      const r = await saveExisting({
        root: fs.root,
        articles,
        id: ID,
        baseBytes: base,
        previousCandidate: null,
        buildCandidate: ok("new"),
      });
      expect(r).toMatchObject({ kind: "write-failed", disk: "base" });
      expect(file.text()).toBe(article(ID));
    }
  });

  it("F03：書き込み後の検証失敗は成功表示せず結果不明。再試行で実状態を照合する", async () => {
    const { fs, articles, base } = await setup();
    fs.faults.afterClose = (_p, f) => (f.data = encodeUtf8("corrupted"));
    const r = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: null,
      buildCandidate: ok("new"),
    });
    expect(r).toMatchObject({ kind: "unknown", disk: "third" });
    // ディスクが第三の内容なら、再試行は外部変更として止まる
    fs.faults = {};
    const again = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: r.kind === "unknown" ? r.bytes : null,
      buildCandidate: ok("new2"),
    });
    expect(again.kind).toBe("external-change");
  });

  it("候補どおり保存済みと確認できれば、重複書き込みせず成功へ遷移する（13.3）", async () => {
    const { fs, file, articles, base } = await setup();
    const cand = encodeUtf8("candidate");
    file.data = cand.slice();
    const r = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: cand,
      buildCandidate: ok("other"),
    });
    expect(r).toMatchObject({ kind: "saved", adoptedPrevious: true });
    expect(file.writes).toHaveLength(0);
  });

  it("最終候補が検証を通らなければ書き込まない（13.2.2）", async () => {
    const { fs, file, articles, base } = await setup();
    const r = await saveExisting({
      root: fs.root,
      articles,
      id: ID,
      baseBytes: base,
      previousCandidate: null,
      buildCandidate: () => ({ ok: false, problems: [{ message: "too big" }] }),
    });
    expect(r.kind).toBe("candidate-invalid");
    expect(file.writes).toHaveLength(0);
  });

  it("ディスク操作は直列化する（11.2）", async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const a = q.run(async () => {
      order.push("a1");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a2");
    });
    const b = q.run(async () => {
      order.push("b");
    });
    expect(q.busy).toBe(true);
    await Promise.all([a, b]);
    expect(order).toEqual(["a1", "a2", "b"]);
    expect(q.busy).toBe(false);
  });
});

describe("新規作成（10.1・5.3・26.3 F04・37.1 T01）", () => {
  async function empty() {
    const fs = new MemFs();
    const st = await createArticlesDir(fs.root);
    if (st.kind !== "ok") throw new Error();
    return { fs, articles: st.dir };
  }
  const text = newArticleText(ID, "2026-11-03T22:08:00+09:00");

  it("作成先がなければフォルダと index.md を作り、再読込一致で完成", async () => {
    const { fs, articles } = await empty();
    const r = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: new Set(),
      previousCandidate: null,
      buildCandidate: ok(text),
    });
    expect(r.kind).toBe("created");
    expect(fs.readText(`content/articles/${ID}/index.md`)).toBe(text);
  });

  it("同名エントリーがあれば既存を再利用せず止める（記事として正常かは問わない）", async () => {
    const { fs, articles } = await empty();
    fs.mkdir(`content/articles/${ID}`);
    const r = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: new Set(),
      previousCandidate: null,
      buildCandidate: ok(text),
    });
    expect(r.kind).toBe("exists");
    fs.remove(`content/articles/${ID}`);
    fs.write(`content/articles/${ID}`, "file");
    const r2 = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: new Set(),
      previousCandidate: null,
      buildCandidate: ok(text),
    });
    expect(r2.kind).toBe("exists");
  });

  it("T01：存在確認直後に外部で同名フォルダ・ファイルが作られたら、外部内容を上書きしない", async () => {
    const { fs, articles } = await empty();
    let injected = false;
    fs.faults.beforeGet = (path, create) => {
      // フォルダ作成直前に、外部プロセスが同名フォルダと中身を作る
      if (create && path === `content/articles/${ID}/` && !injected) {
        injected = true;
        fs.write(`content/articles/${ID}/index.md`, "外部の内容");
      }
    };
    const r = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: new Set(),
      previousCandidate: null,
      buildCandidate: ok(text),
    });
    expect(r.kind).toBe("not-owned");
    expect(fs.readText(`content/articles/${ID}/index.md`)).toBe("外部の内容");
  });

  it("F04：index.md の書き込み失敗は不完全として返し、再試行で所有を確認してから完成させる", async () => {
    const { fs, articles } = await empty();
    const owned = new Set<string>();
    fs.faults.beforeClose = () => {
      throw Object.assign(new Error("x"), { name: "QuotaExceededError" });
    };
    const r = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: owned,
      previousCandidate: null,
      buildCandidate: ok(text),
    });
    expect(r).toMatchObject({ kind: "incomplete", path: `content/articles/${ID}/` });
    expect(owned.has(ID)).toBe(true);
    fs.faults = {};
    const r2 = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: owned,
      previousCandidate: r.kind === "incomplete" ? r.bytes : null,
      buildCandidate: ok(text),
    });
    expect(r2.kind).toBe("created");
  });

  it("再試行時に想定外のエントリーが増えていれば書き込まない", async () => {
    const { fs, articles } = await empty();
    const owned = new Set<string>([ID]);
    fs.write(`content/articles/${ID}/media/x.jpg`, "x");
    const r = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: owned,
      previousCandidate: null,
      buildCandidate: ok(text),
    });
    expect(r.kind).toBe("not-owned");
  });

  it("候補が検証を通らなければフォルダを作らない（初回保存前のキャンセル相当で残さない）", async () => {
    const { fs, articles } = await empty();
    const r = await createArticle({
      root: fs.root,
      articles,
      id: ID,
      ownedDirs: new Set(),
      previousCandidate: null,
      buildCandidate: () => ({ ok: false, problems: [{ message: "x" }] }),
    });
    expect(r.kind).toBe("candidate-invalid");
    expect((fs.get("content/articles") as MemDir).children.size).toBe(0);
  });
});
