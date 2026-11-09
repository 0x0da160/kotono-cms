/**
 * localhost から配信した成果物の Git 機能（仕様 20〜22）。ブラウザの圧縮・ハッシュ API で書いた
 * Git メタデータを取り出し、ネイティブ Git で整合性を確かめる（TG02 の一部）。
 *
 * フォルダはページ内の疑似実装（fake-fs.ts）。実フォルダでの File System Access API の挙動
 * （TG01・TG02 の実機試験）の代替ではない。
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installFakeFs, type FakeFsApi } from "./fake-fs";
import { external, menu, registerLogin } from "./login";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");
/** localhost から配信する（パスキーは file:// では使えない：ADR-0012） */
const url = "/kotono-cms.html";
const A = "k7m2x9q";
const article = (title: string) =>
  `---\nid: "${A}"\ntitle: "${title}"\nslug: "first"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n本文\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
const SEED = { [`content/articles/${A}/index.md`]: article("最初の記事"), "README.md": "記事外\n" };
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

test.beforeAll(() => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
});

type Api = { __fakeFs: FakeFsApi };

/** ページ内のフォルダを実フォルダへ書き出し、ネイティブ Git を実行する */
async function nativeGit(page: Page, ...args: string[][]): Promise<string[]> {
  const files = await page.evaluate(() => (window as unknown as Api).__fakeFs.dump());
  const dir = mkdtempSync(join(tmpdir(), "kotono-e2e-git-"));
  try {
    for (const [p, b64] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), Buffer.from(b64, "base64"));
    }
    return args.map((a) => execFileSync("git", a, { cwd: dir, env: ENV, encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function commitCurrent(page: Page, expectMessage: string, first: boolean) {
  await page.getByTestId("commit-button").click();
  if (first) await page.getByRole("button", { name: "理解して続ける" }).click();
  const dlg = page.getByTestId("commit-dialog");
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId("commit-message")).toHaveValue(expectMessage);
  await expect(page.getByTestId("commit-files")).toContainText(`content/articles/${A}/index.md`);
  await expect(page.getByTestId("commit-files")).not.toContainText("README.md");
  if (first) {
    await page.getByTestId("commit-name").fill("山田 太郎");
    await page.getByTestId("commit-email").fill("taro@example.com");
  }
  await page.getByTestId("commit-confirm").click();
  await expect(page.getByTestId("git-notice")).toContainText("コミットしました");
  // 編集画面からのコミットの結果は、お知らせの帯にも出る（アプリの外枠：Git の画面は隠れている）
  await expect(page.getByTestId("git-notice-strip")).toContainText("コミットしました");
}

test("Git を初期化し、記事を追加・更新コミットして、ネイティブ Git が整合と認める", async ({ page }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.addInitScript(installFakeFs, SEED);
  await page.goto(url);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();

  // Git の操作は上部バーの「Git と同期」の画面にある
  await menu(page, "nav-changes");
  await expect(page.getByTestId("git-none")).toBeVisible();
  await page.getByTestId("git-init").click();
  // 危険・不可逆な操作は既定にしない（14.1）
  await expect(page.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await page.getByRole("button", { name: "初期化する", exact: true }).click();
  // 疑似フォルダは Chromium と同じく .git/config の作成を禁止する。作らずに初期化を終える
  await expect(page.getByTestId("git-notice")).toContainText("初期化しました");
  await expect(page.getByTestId("git-notice")).toContainText(".git/config は作っていません");
  await expect(page.getByTestId("git-branch")).toHaveText("main");
  await expect(page.getByTestId("git-writable")).toHaveText("可能");
  await menu(page, "nav-articles");
  await expect(page.getByTestId("git-badge")).toHaveText("未追跡");

  await page.getByRole("button", { name: /最初の記事/ }).click();
  await expect(page.getByTestId("git-status")).toHaveText("未追跡");
  await commitCurrent(page, "記事を追加: 最初の記事", true);
  await expect(page.getByTestId("git-status")).toHaveText("コミット済み");
  await expect(page.getByTestId("git-badge")).toHaveCount(0);

  // 編集・保存してから更新をコミットする。未保存のままではコミットできない（21.1）
  await page.getByLabel("タイトル", { exact: true }).fill("変更後の記事");
  await expect(page.getByTestId("commit-button")).toBeDisabled();
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  await expect(page.getByTestId("git-status")).toHaveText("未コミット");
  await commitCurrent(page, "記事を更新: 変更後の記事", false);

  await page.getByTestId("git-notice-strip").getByRole("button", { name: "「Git と同期」で見る" }).click();
  await expect(page.getByTestId("nav-changes")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("git-history-article").click();
  await expect(page.getByTestId("git-history").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("git-history")).toContainText("記事を更新: 変更後の記事");

  const [fsck, log, status, author] = await nativeGit(
    page,
    ["fsck", "--strict", "--no-dangling"],
    ["log", "--format=%s"],
    ["status", "--porcelain"],
    ["log", "-1", "--format=%an <%ae>"],
  );
  expect(fsck).toBe("");
  expect(log).toBe("記事を更新: 変更後の記事\n記事を追加: 最初の記事\n");
  // 記事外のファイルはコミットしない
  expect(status).toBe("?? README.md\n");
  expect(author).toBe("山田 太郎 <taro@example.com>\n");
  expect(errors).toEqual([]);
  expect(external(requests, new URL(page.url()).origin)).toEqual([]);
});

test("プレビューで対象言語のコードをハイライトする", async ({ page }) => {
  await page.addInitScript(installFakeFs, SEED);
  await page.goto(url);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();
  await page.getByRole("button", { name: /最初の記事/ }).click();
  await page.getByRole("tab", { name: "プレビュー" }).click();
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("code.hljs .hljs-keyword")).toHaveText("const");
});

test("キーボードで開いたコミット画面を閉じると、フォーカスは「コミット…」に戻る（14.1）", async ({ page }) => {
  await page.addInitScript(installFakeFs, SEED);
  await page.goto(url);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();
  await menu(page, "nav-changes");
  await page.getByTestId("git-init").click();
  await page.getByRole("button", { name: "初期化する", exact: true }).click();
  await expect(page.getByTestId("git-notice")).toContainText("初期化しました");
  await menu(page, "nav-articles");
  await page.getByRole("button", { name: /最初の記事/ }).click();
  const commit = page.getByTestId("commit-button");
  await commit.focus();
  await page.keyboard.press("Enter");
  // 初回だけ出る注意を読んで進む
  await page.getByRole("button", { name: "理解して続ける" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("commit-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("commit-dialog")).toBeHidden();
  await expect(commit).toBeFocused();
  // 2回目（注意なし）も同じ
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("commit-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(commit).toBeFocused();
});

test("Git パネルの行からコミットすると、結果の通知が見える位置に出る（UI刷新 段階6）", async ({ page }) => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    const id = `k7m2x${String.fromCharCode(97 + i)}q`;
    many[`content/articles/${id}/index.md`] = article(`記事 ${i}`).replace(/k7m2x9q/g, id);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(installFakeFs, many);
  await page.goto(url);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();
  await menu(page, "nav-changes");
  await page.getByTestId("git-init").click();
  await page.getByRole("button", { name: "初期化する", exact: true }).click();
  await expect(page.getByTestId("git-notice")).toContainText("初期化しました");
  const last = page.getByTestId("git-commit-article").last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await page.getByRole("button", { name: "理解して続ける" }).click();
  await page.getByTestId("commit-name").fill("山田 太郎");
  await page.getByTestId("commit-email").fill("taro@example.com");
  await page.getByTestId("commit-confirm").click();
  await expect(page.getByTestId("git-notice")).toContainText("コミットしました");
  await expect(page.getByTestId("git-notice")).toBeInViewport();
});

test("同期の設定に、入力済みで開くトークンの作成ページへのリンクと手順を出す（40.2）", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.addInitScript(installFakeFs, SEED);
  await page.goto(url);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();
  await menu(page, "nav-changes");
  await page.getByTestId("git-init").click();
  await page.getByRole("button", { name: "初期化する", exact: true }).click();
  await expect(page.getByTestId("git-notice")).toContainText("初期化しました");

  // トークン未入力のうちは手順を開いて見せる
  const howto = page.getByTestId("sync-pat-howto");
  await expect(howto).toHaveAttribute("open", "");
  await expect(howto).toContainText("Only select repositories");
  await expect(howto).toContainText("同期するリポジトリ");

  // 入力したリポジトリに合わせて、リンクと手順が変わる
  await page.getByTestId("sync-repo").fill("https://github.com/0x0da160/blog");
  await expect(howto).toContainText("0x0da160/blog");
  const link = page.getByTestId("sync-pat-link");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const href = new URL((await link.getAttribute("href")) ?? "");
  expect(href.origin + href.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
  expect(href.searchParams.get("target_name")).toBe("0x0da160");
  expect(href.searchParams.get("contents")).toBe("write");

  // リンクを出すだけで、github.com とは通信しない
  expect(external(requests, new URL(page.url()).origin)).toEqual([]);
});
