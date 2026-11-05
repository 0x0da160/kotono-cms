/**
 * file:// で起動した dist/kotono-cms.html の編集フロー（仕様 3.1・7・12・13・14・23）。
 *
 * フォルダはページ内の疑似実装（fake-fs.ts）で差し替えている。実フォルダ・権限ダイアログ・
 * 実ディスクへの書き込みは検証していない（TG01・TG06 は未検証）。
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installFakeFs, type FakeFsApi } from "./fake-fs";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");
const url = pathToFileURL(distHtml).href;

const A = "k7m2x9q";
const B = "p4c8n6w";
const article = (id: string, title: string, slug: string, extra = "") =>
  `---\r\nid: "${id}"\r\ntitle: "${title}" # 見出し用\r\nslug: "${slug}"\r\nstatus: "draft"\r\ncreatedAt: "2026-11-03T22:08:00+09:00"\r\nupdatedAt: "2026-11-03T22:08:00+09:00"\r\npublishedAt: null\r\ntags: ["news"]\r\ncover: null\r\n${extra}---\r\n本文です。\r\n`;

const SEED: Record<string, string> = {
  [`content/articles/${A}/index.md`]: article(A, "最初の記事", "first", "seo:\r\n  description: '未知の項目'\r\n"),
  [`content/articles/${B}/index.md`]: article(B, "二番目の記事", "second"),
  "content/articles/q5d9m3z/index.md": '---\nid: "q5d9m3z"\ntitle: [\n---\n壊れた記事\n',
  "content/articles/r6e2n4y/": "",
};

test.beforeAll(() => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
});

async function launch(page: Page, seed: Record<string, string> = SEED) {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // 本文を Markdown の欄で編集する試験（見たまま編集は visual.spec.ts）
  await page.addInitScript(() => {
    try {
      localStorage.setItem("kotono-cms:body-view", "markdown");
    } catch {
      // プレビューの sandbox iframe では localStorage を使えない
    }
  });
  await page.addInitScript(installFakeFs, seed);
  await page.goto(url);
  await page.getByTestId("choose-folder").click();
  return { requests, errors };
}

const fsRead = (page: Page, path: string) =>
  page.evaluate((p) => (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs.read(p), path);
const fsWrite = (page: Page, path: string, text: string) =>
  page.evaluate(
    ([p, t]) => (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs.write(p as string, t as string),
    [path, text],
  );
const fsWrites = (page: Page, path: string) =>
  page.evaluate((p) => (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs.writes(p), path);

test("フォルダを選ぶと記事一覧を表示し、不正・不完全な記事を区別する（23・24）", async ({ page }) => {
  const { requests, errors } = await launch(page);
  await expect(page.getByTestId("folder-name")).toHaveText("作業フォルダ：sample-media");
  await expect(page.getByTestId("list-summary")).toHaveText("4件 / 全4件");
  const rows = page.getByTestId("article-row");
  await expect(rows.filter({ hasText: "最初の記事" })).toContainText("下書き");
  await expect(rows.filter({ hasText: "q5d9m3z" })).toContainText("検証エラー");
  await expect(rows.filter({ hasText: "r6e2n4y" })).toContainText("不完全");
  // 検索（英字大小を区別しない部分一致）
  await page.getByPlaceholder("キーワードで検索").fill("SECOND");
  await expect(page.getByTestId("list-summary")).toHaveText("1件 / 全4件");
  // 自動通信なし（16.3・32.2）
  expect(requests.filter((r) => !r.startsWith("blob:"))).toEqual([url]);
  expect(errors).toEqual([]);
});

test("フォームと本文で編集し、Ctrl+S で保存する。コメント・未知項目を保持し LF で書く（13・9.3）", async ({ page }) => {
  const { errors } = await launch(page);
  await page.getByTestId("article-row").filter({ hasText: "最初の記事" }).click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");

  await page.getByLabel("タイトル", { exact: true }).fill("書き換えたタイトル");
  await page.getByTestId("body-editor").fill("新しい本文。\n");
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  await expect(page.getByTestId("notice")).toContainText("保存しました");

  const saved = (await fsRead(page, `content/articles/${A}/index.md`)) ?? "";
  expect(saved).toContain('title: "書き換えたタイトル" # 見出し用');
  expect(saved).toContain("seo:\n  description: '未知の項目'\n");
  expect(saved).toContain("---\n新しい本文。\n");
  expect(saved).not.toContain("\r");
  expect(saved).not.toContain('updatedAt: "2026-11-03T22:08:00+09:00"');
  // 一覧にも反映
  await expect(page.getByTestId("article-row").filter({ hasText: "書き換えたタイトル" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("開いて保存するだけでは書き込まない（26.2 D01）", async ({ page }) => {
  await launch(page);
  await page.getByTestId("article-row").filter({ hasText: "二番目の記事" }).click();
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("notice")).toContainText("変更がないため");
  expect(await fsWrites(page, `content/articles/${B}/index.md`)).toBe(0);
});

test("外部変更を検出したら保存を止め、3版と差分・退避を示す（12・26.3 F01）", async ({ page }) => {
  await launch(page);
  await page.getByTestId("article-row").filter({ hasText: "二番目の記事" }).click();
  await page.getByTestId("body-editor").fill("CMS での編集\n");
  await fsWrite(page, `content/articles/${B}/index.md`, article(B, "外部で変更", "second"));
  await page.getByTestId("save-button").click();
  const panel = page.getByTestId("conflict-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("現在のディスク原文");
  await expect(panel.getByRole("button", { name: "編集中の原文をコピー" })).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  await expect(page.getByTestId("save-issue")).toHaveText("外部変更で保存を停止");
  // 検出したことはパネルの見出しで読み上げ、同じ内容の通知の枠を別に出さない（UI刷新 P-08）
  await expect(panel.getByRole("alert")).toHaveText(/外部変更あり：保存を止めました/);
  await expect(page.getByTestId("notice")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "編集を破棄してディスク版を読み込む" })).toHaveClass(/danger/);
  expect(await fsRead(page, `content/articles/${B}/index.md`)).toContain("外部で変更");
});

test("新規作成：初回保存で content/articles/<ID>/index.md を作る（10.1）", async ({ page }) => {
  const seed = { ...SEED };
  delete seed["content/articles/q5d9m3z/index.md"];
  await launch(page, seed);
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  const id = (await page.getByTestId("article-id").textContent()) ?? "";
  expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{7}$/);
  expect(await fsRead(page, `content/articles/${id}/index.md`)).toBeNull();
  await page.getByLabel("タイトル", { exact: true }).fill("新しい記事");
  await page.getByLabel("slug", { exact: true }).fill("new-article");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  const saved = (await fsRead(page, `content/articles/${id}/index.md`)) ?? "";
  expect(saved).toMatch(
    new RegExp(`^---\\nid: "${id}"\\ntitle: "新しい記事"\\nslug: "new-article"\\nstatus: "draft"\\n`),
  );
  await expect(page.getByTestId("article-row").filter({ hasText: "新しい記事" })).toBeVisible();
});

test("slug の重複と、確認できない記事がある場合の「重複検査不能」を区別して保存を止める（7.1）", async ({ page }) => {
  await launch(page);
  await page.getByTestId("article-row").filter({ hasText: "二番目の記事" }).click();
  await page.getByLabel("slug", { exact: true }).fill("first");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("notice")).toContainText("重複しています");
  // 壊れた記事（q5d9m3z）の slug は確認できないため、「重複なし」とは扱わない
  await page.getByLabel("slug", { exact: true }).fill("unique-slug");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("notice")).toContainText("重複検査不能");
  expect(await fsWrites(page, `content/articles/${B}/index.md`)).toBe(0);
  // 壊れた記事を外部で直すと保存できる
  await fsWrite(page, "content/articles/q5d9m3z/index.md", article("q5d9m3z", "直した", "third"));
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
});

test("原文の構文エラー中はフォームへ切り替えず、保存しない（14）", async ({ page }) => {
  await launch(page);
  await page.getByTestId("article-row").filter({ hasText: "二番目の記事" }).click();
  await page.getByRole("tab", { name: "原文" }).click();
  const src = page.getByTestId("source-editor");
  const text = await src.inputValue();
  await src.fill(text.replace('slug: "second"', "slug: [second"));
  await page.getByRole("tab", { name: "フォーム" }).click();
  await expect(page.getByText("フォームへ切り替えられません")).toBeVisible();
  await expect(page.getByRole("tab", { name: "原文" })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("notice")).toContainText("検証エラー");
  // 次の操作を選ぶ必要があるエラーは、トーストにせず編集領域の中に残す
  await expect(page.getByTestId("notice")).not.toHaveCSS("position", "fixed");
  // 共通の Undo で戻すとフォームへ切り替えられる
  await src.press("Control+z");
  await page.getByRole("tab", { name: "フォーム" }).click();
  await expect(page.getByLabel("slug", { exact: true })).toHaveValue("second");
});

test("未保存のまま別の記事を開くと確認し、既定はキャンセル（13.1・14.1）", async ({ page }) => {
  await launch(page);
  await page.getByTestId("article-row").filter({ hasText: "二番目の記事" }).click();
  await page.getByTestId("body-editor").fill("未保存の本文\n");
  await page.getByTestId("article-row").filter({ hasText: "最初の記事" }).click();
  const dialog = page.getByRole("dialog", { name: "未保存の編集" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("body-editor")).toHaveValue("未保存の本文\n");
});

test("content/articles/ がなければ確認後に作成する（3.1）", async ({ page }) => {
  await launch(page, { "README.md": "x" });
  await expect(page.getByRole("heading", { name: "初回フォルダ準備" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs.list("content"))).toEqual(
    [],
  );
  await page.getByTestId("prepare-articles").click();
  await expect(page.getByTestId("list-summary")).toHaveText("記事がありません");
});
