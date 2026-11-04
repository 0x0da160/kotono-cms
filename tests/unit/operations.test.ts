/**
 * 画像の取り込み・削除、記事の複製・削除、削除前退避（10.2・11.3・17・18・19・19.1・37.1 T15・T24・T28）。
 * フォルダはメモリ上の実装で、実ディスク・実ブラウザの挙動の代替ではない（TG01・TG05・TG06）。
 */
import { describe, expect, it } from "vitest";
import { Workspace, type DialogRequest } from "../../src/lib/app/workspace.svelte";
import { inspectImage } from "../../src/lib/core/image";
import { checkBackupTarget, createBackup, readManifest, verifyBackup } from "../../src/lib/fs/backup";
import { enumerateTree } from "../../src/lib/fs/tree";
import { saveMedia } from "../../src/lib/fs/media";
import type { DirHandleLike } from "../../src/lib/fs/types";
import { inlineMdService } from "../../src/lib/parse/md-inline";
import { gif, png } from "./support/images";
import { MemDir, MemFile, MemFs } from "./support/memory-fs";

const ID = "k7m2x9q";
const article = (body = "本文\n", cover = "null", extra = "") =>
  `---\nid: "${ID}"\ntitle: "元の記事"\nslug: "orig"\nstatus: "published"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: "2026-11-03T22:08:00+09:00"\ntags: ["a"]\ncover: ${cover}\n${extra}---\n${body}`;

type Answer = string | ((r: Omit<DialogRequest, "resolve">) => string);

async function setup(files: Record<string, string | Uint8Array> = {}, body?: string, cover?: string, extra?: string) {
  const fs = new MemFs();
  fs.write(`content/articles/${ID}/index.md`, article(body, cover, extra));
  for (const [p, c] of Object.entries(files)) fs.write(`content/articles/${ID}/${p}`, c);
  const backup = new MemFs("backup");
  let pick: DirHandleLike | null = backup.root;
  const ws = new Workspace(
    { showDirectoryPicker: async () => pick },
    {
      md: inlineMdService,
      decoder: async (b) => {
        const r = inspectImage(b);
        if (!r.ok) throw new Error(r.message);
        return { width: r.info.width, height: r.info.height };
      },
      appVersion: "test",
      specVersion: "3.1",
    },
  );
  const answers: Answer[] = [];
  const asked: Omit<DialogRequest, "resolve">[] = [];
  const hooks: { during?: (title: string) => void } = {};
  ws.ask = async (req) => {
    asked.push(req);
    hooks.during?.(req.title);
    const a = answers.shift();
    return a === undefined ? "cancel" : typeof a === "string" ? a : a(req);
  };
  await ws.openRoot(fs.root);
  await ws.openArticle(ID);
  const s = ws.session;
  if (!s) throw new Error("no session");
  return {
    fs,
    backup,
    ws,
    s,
    answers,
    asked,
    hooks,
    setPick: (d: DirHandleLike | null) => (pick = d),
  };
}

const file = (name: string, bytes: Uint8Array, type = "") => ({
  name,
  type,
  size: bytes.length,
  arrayBuffer: async () => bytes.slice().buffer,
});

function backupFolder(backup: MemFs): MemDir {
  const dirs = [...backup.root.children.values()].filter((c): c is MemDir => c instanceof MemDir);
  expect(dirs).toHaveLength(1);
  return dirs[0] as MemDir;
}

// ---------------------------------------------------------------------------

describe("画像の取り込み（17）", () => {
  it("内容形式を検証し、ランダム名で media/ に保存してから挿入できる", async () => {
    const { ws, s, fs } = await setup();
    await ws.importImages([file("Photo.PNG", png(4, 3), "image/png")]);
    const job = ws.importJobs[0];
    expect(job?.status).toBe("done");
    const name = job?.name ?? "";
    expect(name).toMatch(/^[0-9a-hjkmnp-tv-z]{10}\.png$/);
    const saved = fs.get(`content/articles/${ID}/media/${name}`) as MemFile;
    expect(saved.data).toEqual(png(4, 3)); // 原本を加工しない
    // 取り込みだけでは本文を変えない
    expect(s.dirty).toBe(false);
    ws.insertImage(name, "説明 [注]");
    expect(s.text).toContain(`![説明 \\[注\\]](./media/${name})`);
    expect(ws.media?.files.map((f) => f.name)).toEqual([name]);
  });

  it("偽装・SVG・上限超過は保存せず、他のファイルの成功分は保持する（17.2）", async () => {
    const { ws, fs } = await setup();
    await ws.importImages([
      file("a.jpg", png(1, 1)),
      file("b.svg", new TextEncoder().encode("<svg></svg>")),
      file("c.gif", gif(10, 10, 300)),
      file("d.png", png(2, 2)),
    ]);
    expect(ws.importJobs.map((j) => j.status)).toEqual(["failed", "failed", "failed", "done"]);
    const media = fs.get(`content/articles/${ID}/media`) as MemDir;
    expect(media.children.size).toBe(1);
  });

  it("未保存の新規記事・設定不正・一括数超過では取り込まない（10.1・4.2）", async () => {
    const { ws, fs, s } = await setup();
    fs.write("cms.config.json", '{"media":{"maxBatchFiles":1}}');
    await ws.importImages([file("a.png", png(1, 1)), file("b.png", png(1, 1))]);
    expect(s.notice?.text).toContain("1 ファイルまで");
    fs.write("cms.config.json", '{"media":{"maxFileSizeMiB":0}}');
    await ws.importImages([file("a.png", png(1, 1))]);
    expect(s.notice?.text).toContain("取り込みを停止");
    expect(fs.get(`content/articles/${ID}/media`)).toBeUndefined();
    await ws.createNew();
    await ws.importImages([file("a.png", png(1, 1))]);
    expect(ws.session?.notice?.text).toContain("一度保存");
  });

  it("同名の候補は既存エントリーと照合し、既存を上書きしない（最大11候補）", async () => {
    const fs = new MemFs();
    fs.write("a/media/aaaaaaaaaa.png", "x");
    const dir = (await fs.root.getDirectoryHandle("a")) as DirHandleLike;
    const names = ["aaaaaaaaaa", "bbbbbbbbbb"];
    const r = await saveMedia(
      dir,
      { format: "png", width: 1, height: 1, pixels: 1, frames: 1, animated: false },
      png(1, 1),
      () => names.shift() ?? "z",
    );
    expect(r).toEqual({ ok: true, name: "bbbbbbbbbb.png" });
    expect(fs.readText("a/media/aaaaaaaaaa.png")).toBe("x");
    const all = await saveMedia(
      dir,
      { format: "png", width: 1, height: 1, pixels: 1, frames: 1, animated: false },
      png(1, 1),
      () => "aaaaaaaaaa",
    );
    expect(all.ok).toBe(false);
  });

  it("中止は次のファイルの開始前に受け付け、成功分は残す", async () => {
    const { ws } = await setup();
    let n = 0;
    const slow = {
      ...file("a.png", png(1, 1)),
      arrayBuffer: async () => {
        if (n++ === 0) ws.cancelImport();
        return png(1, 1).buffer as ArrayBuffer;
      },
    };
    await ws.importImages([slow, file("b.png", png(1, 1))]);
    expect(ws.importJobs.map((j) => j.status)).toEqual(["done", "cancelled"]);
  });

  it("カバー画像は取り込み済み画像から選べ、本文への挿入は不要", async () => {
    const { ws, s } = await setup({ "media/abcdefghjk.png": png(1, 1) });
    ws.setCover("abcdefghjk.png", "表紙");
    expect(s.analysis.schema?.values.cover).toEqual({ src: "./media/abcdefghjk.png", alt: "表紙" });
  });
});

describe("画像の削除（18.2・19.1・11.3）", () => {
  const IMG = "abcdefghjk.png";

  it("未参照の画像は、検証済みの退避の後に確認して削除する", async () => {
    const { ws, s, fs, backup, answers } = await setup({ [`media/${IMG}`]: png(1, 1) });
    await ws.refreshMedia();
    expect(ws.media?.refs?.status).toBe("ok");
    answers.push("backup", "delete");
    await ws.deleteMedia(IMG);
    expect(s.notice?.kind).toBe("ok");
    expect(fs.get(`content/articles/${ID}/media/${IMG}`)).toBeUndefined();
    const op = backupFolder(backup);
    expect(op.name).toMatch(new RegExp(`^kotono-backup-\\d{8}-\\d{6}-${ID}-`));
    const m = await readManifest(op);
    expect(m.ok && m.manifest.entries).toEqual([
      expect.objectContaining({ path: `media/${IMG}`, kind: "file", size: png(1, 1).length }),
    ]);
    expect(JSON.stringify(m.ok && m.manifest)).not.toContain("repo");
    expect(s.locked).toBeNull();
  });

  it("参照中・参照状況不明の画像は削除しない", async () => {
    const a = await setup({ [`media/${IMG}`]: png(1, 1) }, `![x](./media/${IMG})\n`);
    await a.ws.deleteMedia(IMG);
    expect(a.s.notice?.text).toContain("参照されています");
    expect(a.asked).toHaveLength(0);
    const b = await setup({ [`media/${IMG}`]: png(1, 1) }, "本文\n", `{src: "./media/${IMG}", alt: ""}`);
    await b.ws.deleteMedia(IMG);
    expect(b.s.notice?.text).toContain("参照されています");
    const c = await setup({ [`media/${IMG}`]: png(1, 1) }, `<img src="media/${IMG}">\n`);
    await c.ws.deleteMedia(IMG);
    expect(c.s.notice?.text).toContain("参照状況不明");
    expect(c.fs.get(`content/articles/${ID}/media/${IMG}`)).toBeDefined();
  });

  it("確認・退避の後に編集されたら削除を止め、退避は保持する（11.3・T28）", async () => {
    const { ws, s, fs, backup, answers, hooks } = await setup({ [`media/${IMG}`]: png(1, 1) });
    answers.push("backup", "delete");
    hooks.during = (t) => {
      if (t === "画像を削除します") s.setBody("退避中の編集\n");
    };
    await ws.deleteMedia(IMG);
    expect(s.notice?.text).toContain("確認の後に記事が編集された");
    expect(fs.get(`content/articles/${ID}/media/${IMG}`)).toBeDefined();
    expect(backupFolder(backup)).toBeDefined();
  });

  it("未保存の編集があれば先に保存または破棄を選ばせる", async () => {
    const { ws, s, asked } = await setup({ [`media/${IMG}`]: png(1, 1) });
    s.setBody("未保存\n");
    await ws.deleteMedia(IMG);
    expect(asked[0]?.title).toBe("未保存の編集があります");
    expect(asked).toHaveLength(1);
  });

  it("退避先がリポジトリと重なれば退避・削除を始めない（T24）", async () => {
    const { ws, s, fs, answers, setPick } = await setup({ [`media/${IMG}`]: png(1, 1) });
    setPick(fs.root.children.get("content") as MemDir);
    answers.push("backup");
    await ws.deleteMedia(IMG);
    expect(s.notice?.text).toContain("作業フォルダの中");
    expect(fs.get(`content/articles/${ID}/media/${IMG}`)).toBeDefined();
  });

  it("退避の書き込みに失敗したら削除しない（T15）", async () => {
    const { ws, s, fs, backup, answers } = await setup({ [`media/${IMG}`]: png(1, 1) });
    backup.faults.beforeClose = (p) => {
      if (p.endsWith(".png")) throw Object.assign(new Error("q"), { name: "QuotaExceededError" });
    };
    answers.push("backup", "delete");
    await ws.deleteMedia(IMG);
    expect(s.notice?.text).toContain("退避できなかった");
    expect(s.notice?.details?.[0]).toContain("途中まで作成した退避フォルダ");
    expect(fs.get(`content/articles/${ID}/media/${IMG}`)).toBeDefined();
  });
});

describe("削除前退避（19.1）", () => {
  it("同一・配下・祖先の退避先を拒否し、判定 API がなければ止める", async () => {
    const fs = new MemFs();
    const repo = fs.mkdir("work/repo");
    fs.mkdir("work/repo/sub");
    expect(await checkBackupTarget(repo, repo)).toMatchObject({ ok: false });
    expect(await checkBackupTarget(fs.get("work/repo/sub") as MemDir, repo)).toMatchObject({ ok: false });
    expect(await checkBackupTarget(fs.get("work") as MemDir, repo)).toMatchObject({ ok: false });
    expect(await checkBackupTarget(fs.mkdir("elsewhere"), repo)).toEqual({ ok: true });
    const bare: DirHandleLike = {
      kind: "directory",
      name: "x",
      getDirectoryHandle: () => Promise.reject(new Error()),
      getFileHandle: () => Promise.reject(new Error()),
      values: async function* () {},
    };
    expect(await checkBackupTarget(bare, repo)).toMatchObject({
      ok: false,
      message: expect.stringContaining("判定できない"),
    });
  });

  it("空フォルダも記録し、改ざん・追加を検証で検出する（T23）", async () => {
    const fs = new MemFs();
    fs.write("a/index.md", "x");
    fs.mkdir("a/empty");
    fs.write("a/sub/f.bin", new Uint8Array([1, 2, 3]));
    const src = fs.get("a") as MemDir;
    const t = await enumerateTree(src);
    if (!t.ok) throw new Error(t.message);
    const b = new MemFs("b");
    const r = await createBackup({
      backupRoot: b.root,
      repoRoot: fs.mkdir("repo"),
      operation: "delete-article",
      articleId: "a",
      items: t.entries.map((e) => ({ path: e.path, kind: e.kind, handle: e.handle })),
      appVersion: "t",
      specVersion: "3.1",
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.manifest.entries.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "dir:empty",
      "file:index.md",
      "dir:sub",
      "file:sub/f.bin",
    ]);
    const op = b.get(r.folderName) as MemDir;
    expect(await verifyBackup(op, r.manifest)).toEqual({ ok: true });
    (b.get(`${r.folderName}/files/sub/f.bin`) as MemFile).data = new Uint8Array([9]);
    expect((await verifyBackup(op, r.manifest)).ok).toBe(false);
    (b.get(`${r.folderName}/files/sub/f.bin`) as MemFile).data = new Uint8Array([1, 2, 3]);
    b.write(`${r.folderName}/files/extra.txt`, "x");
    expect((await verifyBackup(op, r.manifest)).ok).toBe(false);
    b.write(
      `${r.folderName}/manifest.json`,
      '{"format":"kotono-cms-backup","formatVersion":1,"entries":[{"path":"../x","kind":"file","size":1,"sha256":"0"}]}',
    );
    expect((await readManifest(op)).ok).toBe(false);
  });
});

describe("記事の複製（10.2）", () => {
  it("未知ファイルを含めてコピーし、index.md を最後に確定する。状態・slug・日時を初期化する", async () => {
    const { ws, s, fs, answers } = await setup(
      { "media/abcdefghjk.png": png(1, 1), "notes/memo.txt": "メモ", ".hidden": "h" },
      "![x](./media/abcdefghjk.png)\n",
      "null",
      'seo: {ref: "k7m2x9q"}\n',
    );
    const order: string[] = [];
    fs.faults.afterClose = (p) => order.push(p);
    answers.push((req) => {
      expect(req.details?.join("\n")).toContain("seo");
      return "ok";
    });
    await ws.duplicateCurrent();
    const n = ws.session;
    expect(n).not.toBe(s);
    const newId = n?.id ?? "";
    expect(newId).not.toBe(ID);
    expect(n?.notice?.kind).toBe("ok");
    const text = fs.readText(`content/articles/${newId}/index.md`) ?? "";
    expect(text).toContain(`id: "${newId}"`);
    expect(text).toContain('status: "draft"');
    expect(text).toContain('slug: ""');
    expect(text).toContain("publishedAt: null");
    expect(text).toContain('title: "元の記事"');
    expect(text).toContain('seo: {ref: "k7m2x9q"}'); // 未知フィールドは変換しない
    const c = /createdAt: "([^"]+)"/.exec(text)?.[1];
    expect(c).not.toBe("2026-11-03T22:08:00+09:00");
    expect(text).toContain(`updatedAt: "${c}"`);
    expect(fs.readText(`content/articles/${newId}/notes/memo.txt`)).toBe("メモ");
    expect(fs.readText(`content/articles/${newId}/.hidden`)).toBe("h");
    expect(order.at(-1)).toBe(`content/articles/${newId}/index.md`);
    // 元は変わらない
    expect(fs.readText(`content/articles/${ID}/index.md`)).toBe(
      article("![x](./media/abcdefghjk.png)\n", "null", 'seo: {ref: "k7m2x9q"}\n'),
    );
  });

  it("コピー中に元が変わったら index.md を作らず、残存先を示す（T03）", async () => {
    const { ws, s, fs, answers } = await setup({ "a.txt": "1", "b.txt": "2" });
    answers.push("ok");
    let once = false;
    fs.faults.afterClose = (p) => {
      if (!once && p.endsWith("a.txt")) {
        once = true;
        fs.write(`content/articles/${ID}/c.txt`, "追加");
      }
    };
    await ws.duplicateCurrent();
    expect(s.notice?.text).toContain("複製元が変わった");
    const left = s.notice?.details?.[0] ?? "";
    const newId = /articles\/([^/]+)\//.exec(left)?.[1] ?? "";
    expect(fs.get(`content/articles/${newId}`)).toBeDefined();
    expect(fs.get(`content/articles/${newId}/index.md`)).toBeUndefined();
    expect(ws.scan?.entries.find((e) => e.dirName === newId)?.kind).toBe("incomplete");
  });

  it("読み込み後に元が変わっていたら複製しない", async () => {
    const { ws, s, fs } = await setup();
    fs.write(`content/articles/${ID}/index.md`, article("外部で変更\n"));
    await ws.duplicateCurrent();
    expect(s.notice?.text).toContain("再読み込み");
  });
});

describe("記事の削除（19・11.3）", () => {
  it("確認から結果判定まで対象記事の編集を止め、退避後に個別削除して消失を確認する", async () => {
    const { ws, s, fs, backup, answers, hooks } = await setup({ "media/abcdefghjk.png": png(1, 1) });
    fs.mkdir(`content/articles/${ID}/emptydir`);
    answers.push("backup", "delete");
    const seen: (string | null)[] = [];
    hooks.during = () => {
      seen.push(s.locked);
      // 本文・Undo・挿入の全経路を拒否する
      s.setBody("確認中の編集\n");
      s.undo();
      expect(s.insertIntoBody("x").ok).toBe(false);
    };
    await ws.deleteCurrent();
    expect(seen.every((l) => l !== null)).toBe(true);
    expect(s.text).not.toContain("確認中の編集");
    expect(fs.get(`content/articles/${ID}`)).toBeUndefined();
    const ro = ws.session;
    expect(ro?.readOnlyReason).toContain("削除しました");
    expect(ro?.notice?.kind).toBe("ok");
    const m = await readManifest(backupFolder(backup));
    expect(m.ok && m.manifest.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(["index.md", "media/abcdefghjk.png", "emptydir"]),
    );
    expect(ws.scan?.entries.some((e) => e.dirName === ID)).toBe(false);
  });

  it("キャンセルすれば編集の停止を解除し、何も消さない", async () => {
    const { ws, s, fs } = await setup();
    await ws.deleteCurrent();
    expect(s.locked).toBeNull();
    expect(fs.get(`content/articles/${ID}/index.md`)).toBeDefined();
  });

  it("退避の後に未知のファイルが追加されたら削除しない（T11）", async () => {
    const { ws, s, fs, answers } = await setup();
    answers.push("backup", (r) => {
      fs.write(`content/articles/${ID}/late.txt`, "後から");
      void r;
      return "delete";
    });
    await ws.deleteCurrent();
    expect(s.notice?.text).toContain("追加されたエントリー");
    expect(fs.get(`content/articles/${ID}/index.md`)).toBeDefined();
  });

  it("途中で失敗したら削除済み・残存を区別して表示する", async () => {
    const { ws, fs, answers } = await setup({ "a.txt": "1", "b.txt": "2" });
    answers.push("backup", "delete");
    fs.faults.beforeRemove = (p) => {
      if (p.endsWith("b.txt")) throw Object.assign(new Error("x"), { name: "NoModificationAllowedError" });
    };
    await ws.deleteCurrent();
    const n = ws.session;
    expect(n?.notice?.text).toContain("削除は完了していません");
    expect(n?.notice?.details).toEqual(expect.arrayContaining(["削除済み：a.txt", "不明：b.txt"]));
    expect(n?.readOnlyReason).not.toBeNull();
  });

  it("退避先が選ばれなければ削除しない", async () => {
    const { ws, s, fs, answers, setPick } = await setup();
    setPick(null);
    answers.push("backup");
    await ws.deleteCurrent();
    expect(s.notice?.text).toContain("退避先が選ばれなかった");
    expect(fs.get(`content/articles/${ID}/index.md`)).toBeDefined();
    expect(s.locked).toBeNull();
  });
});
