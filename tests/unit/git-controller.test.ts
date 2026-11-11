/**
 * コミットの途中でフォルダ（作業場所）を閉じたとき（自動ロック：39.3）。
 * 開いたままのコミット画面は取り消し、閉じた後のフォルダへはコミットしない。
 */
import { describe, expect, it } from "vitest";
import { GitController, type CommitRequest } from "../../src/lib/app/git.svelte";
import { Workspace, type DialogRequest } from "../../src/lib/app/workspace.svelte";
import { GitRepo } from "../../src/lib/git/repo";
import { MemFs } from "./support/memory-fs";

const ID = "k7m2x9q";
const article = `---\nid: "${ID}"\ntitle: "題名"\nslug: "s"\nstatus: "draft"\ncreatedAt: "2026-11-06T10:00:00+09:00"\nupdatedAt: "2026-11-06T10:00:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n本文\n`;

/** 状態が現れるまで待つ（確認・コミット画面は非同期の処理の途中で開く） */
async function until<T>(read: () => T | null): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("現れませんでした");
}
const dialog = (ws: Workspace) => until<DialogRequest>(() => ws.dialog);
const commitDialog = (git: GitController) => until<CommitRequest>(() => git.commitDialog);

/** フォルダを開いて Git を初期化し、コミット画面を開くところまで進める */
async function setup() {
  const fs = new MemFs();
  fs.write(`content/articles/${ID}/index.md`, article);
  const ws = new Workspace({});
  await ws.openRoot(fs.root);
  const git = new GitController(ws);
  git.reset();
  await git.refresh();
  const init = git.init();
  (await dialog(ws)).resolve("init");
  await init;
  await git.refresh();
  const committing = git.commitArticle(ID);
  (await dialog(ws)).resolve("ok");
  const req = await commitDialog(git);
  const headOid = async () => {
    const info = await new GitRepo(fs.root).inspect();
    return info.kind === "repo" ? info.headOid : "?";
  };
  return { ws, git, committing, req, headOid };
}

describe("コミットの途中でフォルダを閉じたとき（自動ロック）", () => {
  it("開いたままのコミット画面は、フォルダを閉じると取り消して閉じる。処理中のまま残さない", async () => {
    const { ws, git, committing, req, headOid } = await setup();
    expect(req.title).toBe("題名");
    expect(git.busy).toBe(true);
    ws.close();
    git.reset();
    expect(git.commitDialog).toBeNull();
    await committing;
    expect(git.busy).toBe(false);
    expect(git.notice).toBeNull();
    expect(await headOid()).toBeNull();
  });

  it("作者の保存の確認を待つ間に閉じたら、確認を取り消してもコミットしない", async () => {
    const { ws, git, committing, req, headOid } = await setup();
    req.name = "T";
    req.email = "t@example.com";
    req.saveIdentity = true;
    req.resolve(true);
    const ask = await dialog(ws);
    expect(ask.title).toBe("作者をリポジトリ設定に保存します");
    // 自動ロック：作業場所を閉じてから、待っている確認を取り消す（この確認には「キャンセル」がなく、「保存しない」になる）
    ws.close();
    ws.dismissDialog();
    await committing;
    expect(git.busy).toBe(false);
    expect(await headOid()).toBeNull();
  });

  it("閉じなければ、作者を保存しなくてもコミットする", async () => {
    const { ws, git, committing, req, headOid } = await setup();
    req.name = "T";
    req.email = "t@example.com";
    req.saveIdentity = true;
    req.resolve(true);
    await dialog(ws);
    ws.dismissDialog();
    await committing;
    expect(git.notice?.kind).toBe("ok");
    expect(await headOid()).toMatch(/^[0-9a-f]{40}$/);
  });
});
