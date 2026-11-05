/**
 * file:// で起動した成果物の、プレビュー・画像・複製・削除・復旧ドラフト（14・16・17・18・19・33）。
 *
 * フォルダはページ内の疑似実装（fake-fs.ts）。実フォルダ・権限・実ディスク・シンボリックリンクは
 * 検証していない（TG01・TG05・TG06）。IndexedDB はヘッドレス Chromium の実装を使う。
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installFakeFs, type FakeFsApi } from "./fake-fs";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");
const url = pathToFileURL(distHtml).href;

const A = "k7m2x9q";
/** 1×1 の PNG（デコード可能） */
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMG = "abcdefghjk.png";

const body = [
  "# 見出し",
  "",
  "本文と [外部リンク](https://example.com/) と [危険](javascript:alert(1))。",
  "",
  `![ローカル画像](./media/${IMG})`,
  "",
  "![外部画像](https://example.com/x.png)",
  "",
  "<script>window.__pwned = 1</script>",
  "",
  '<img src="x" onerror="window.__pwned = 2">',
  "",
].join("\n");

const article = (text: string) =>
  `---\nid: "${A}"\ntitle: "最初の記事"\nslug: "first"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n${text}`;

const SEED = {
  [`content/articles/${A}/index.md`]: article(body),
  [`content/articles/${A}/notes.txt`]: "未知のファイル",
};
const BIN = { [`content/articles/${A}/media/${IMG}`]: PNG_1x1 };

test.beforeAll(() => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
});

async function launch(page: Page) {
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
  await page.addInitScript(installFakeFs, SEED);
  await page.addInitScript(
    ([bin]) => {
      const api = (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs;
      for (const [p, b] of Object.entries(bin as Record<string, string>)) api.writeBase64(p, b);
    },
    [BIN],
  );
  await page.goto(url);
  await page.getByTestId("choose-folder").click();
  return { requests, errors };
}

type Api = { __fakeFs: FakeFsApi };
const list = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Api).__fakeFs.list(p), path);
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Api).__fakeFs.read(p), path);
const backupList = (page: Page) => page.evaluate(() => (window as unknown as Api).__fakeFs.backupList());
const backupRead = (page: Page, path: string) =>
  page.evaluate((p) => (window as unknown as Api).__fakeFs.backupRead(p), path);

async function openA(page: Page) {
  await page.getByRole("button", { name: /最初の記事/ }).click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
}

test("プレビューはスクリプトを動かさず、生 HTML を文字で表示し、ローカル画像だけを表示する（16）", async ({ page }) => {
  const { requests, errors } = await launch(page);
  await openA(page);
  await page.getByTestId("tab-preview").click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator("h1")).toHaveText("見出し");
  await expect(frame.locator("body")).toContainText("<script>window.__pwned = 1</script>");
  await expect(frame.locator("body")).toContainText("外部画像は読み込みません");
  // リンクは遷移しない表示
  await expect(frame.locator("a")).toHaveCount(0);
  await expect(frame.locator(".link")).toHaveCount(2);
  // media の画像は検証後に data: で表示される
  const img = frame.locator("img");
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  // 親側のリンク一覧：http(s) だけを開ける
  await page.getByText("リンクの行先（2件）").click();
  await expect(page.getByRole("button", { name: "開く", exact: true })).toHaveCount(1);
  await expect(page.getByText("開けません：スキーム「javascript:」は開けません。")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // サンドボックス：スクリプト・同一オリジンを許可しない
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("sandbox", "");
  expect(requests.filter((r) => !r.startsWith("file:") && !r.startsWith("data:") && !r.startsWith("blob:"))).toEqual(
    [],
  );
  expect(errors.filter((e) => !/Blocked script execution in 'about:srcdoc'/.test(e))).toEqual([]);
});

test("プレビューは未保存の内容を反映し、Markdown 解析は Worker で行う（14・16.1.1）", async ({ page }) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("body-editor").fill("## 未保存の見出し\n\n- [x] 済\n- [ ] 未\n");
  await page.getByTestId("tab-preview").click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator("h2")).toHaveText("未保存の見出し");
  await expect(frame.locator("li")).toHaveCount(2);
  expect(await read(page, `content/articles/${A}/index.md`)).toContain("# 見出し");
});

test("画像を取り込み、alt を付けて本文へ挿入し、保存する（17）", async ({ page }) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("media-input").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1, "base64"),
  });
  await expect(page.getByTestId("notice")).toContainText("画像を 1 件取り込みました");
  const names = await list(page, `content/articles/${A}/media`);
  const added = names.filter((n) => n !== IMG && n !== "variants");
  expect(added).toHaveLength(1);
  expect(added[0]).toMatch(/^[0-9a-hjkmnp-tv-z]{10}\.png$/);
  // 表示用の派生画像（ADR-0005）：1×1 の画像は原寸の1幅だけ、WebP と PNG（透過あり）
  const id = (added[0] ?? "").replace(/\.png$/, "");
  expect((await list(page, `content/articles/${A}/media/variants`)).sort()).toEqual([`${id}-1w.png`, `${id}-1w.webp`]);
  await page.getByTestId("job-alt").fill("写真");
  await page.getByTestId("job-insert").click();
  await expect(page.getByTestId("body-editor")).toHaveValue(new RegExp(`!\\[写真\\]\\(\\./media/${added[0]}\\)`));
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
});

test("偽装した画像は取り込まない（17.1）", async ({ page }) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("media-input").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(PNG_1x1, "base64"),
  });
  await expect(page.getByTestId("media-panel")).toContainText("拡張子（jpg）と内容の形式（PNG）が一致しません");
});

test("記事を複製すると、未知ファイルも含めてコピーし、下書きとして開く（10.2）", async ({ page }) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("more-actions").click();
  await page.getByTestId("duplicate-button").click();
  await expect(page.getByRole("dialog")).toContainText("記事を複製します");
  await page.getByRole("button", { name: "複製する" }).click();
  await expect(page.getByTestId("notice")).toContainText(`記事 ${A} を複製し`);
  const dirs = await list(page, "content/articles");
  const newId = dirs.find((d) => d !== A) ?? "";
  expect(newId).toMatch(/^[0-9a-hjkmnp-tv-z]{7}$/);
  expect(await read(page, `content/articles/${newId}/notes.txt`)).toBe("未知のファイル");
  expect(await list(page, `content/articles/${newId}/media`)).toEqual([IMG]);
  const text = (await read(page, `content/articles/${newId}/index.md`)) ?? "";
  expect(text).toContain('status: "draft"');
  expect(text).toContain('slug: ""');
});

test("記事の削除は、リポジトリ外へ退避・検証してから確認し、既定は削除しない（19・19.1・14.1）", async ({ page }) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("delete-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("記事を削除します");
  await expect(dialog).toContainText(`content/articles/${A}/notes.txt`);
  // 削除中は対象記事を編集できない（11.3）
  await expect(page.getByTestId("locked")).toBeVisible();
  // 退避先を選ぶ
  await page.evaluate(() => (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs.pickNext("backup"));
  await page.getByRole("button", { name: "退避先を選んで退避する" }).click();
  await expect(dialog).toContainText("退避を検証しました");
  // 危険操作は既定のフォーカスにしない
  await expect(page.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await page.getByRole("button", { name: "記事を削除する" }).click();
  await expect(page.getByTestId("notice")).toContainText(`記事 ${A} を削除しました`);
  expect(await list(page, "content/articles")).toEqual([]);
  const [folder] = await backupList(page);
  expect(folder).toMatch(new RegExp(`^kotono-backup-.*-${A}-`));
  const manifest = JSON.parse((await backupRead(page, `${folder}/manifest.json`)) ?? "{}");
  expect(manifest.entries.map((e: { path: string }) => e.path).sort()).toEqual([
    "index.md",
    "media",
    `media/${IMG}`,
    "notes.txt",
  ]);
  await expect(page.getByTestId("save-button")).toBeDisabled();
});

test("キーボードで開いた削除の確認を閉じると、フォーカスは「削除…」に戻る（14.1）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launch(page);
  await openA(page);
  const del = page.getByTestId("delete-button");
  const dialog = page.getByRole("dialog");
  const cancel = page.getByRole("button", { name: "キャンセル" });
  // 確認の間「削除…」は無効になる（11.3）。閉じた後、有効に戻ってからフォーカスを戻す
  // Esc で閉じる
  await del.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("記事を削除します");
  await expect(cancel).toBeFocused();
  await expect(del).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(del).toBeFocused();
  // 「キャンセル」で閉じる
  await page.keyboard.press("Enter");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(del).toBeFocused();
  // 退避を検証した後の、2回目の確認を取り消した場合も戻る
  await page.evaluate(() => (window as unknown as Api).__fakeFs.pickNext("backup"));
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "退避先を選んで退避する" }).click();
  await expect(dialog).toContainText("退避を検証しました");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByText("削除を取り消しました")).toBeVisible();
  await expect(del).toBeFocused();
  expect(await list(page, "content/articles")).toEqual([A]);
});

test("退避先にリポジトリ自身を選ぶと退避・削除を始めない（19.1・T24）", async ({ page }) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("delete-button").click();
  await page.getByRole("button", { name: "退避先を選んで退避する" }).click();
  await expect(page.getByTestId("notice")).toContainText("退避先に作業フォルダ自身は選べません");
  expect(await list(page, "content/articles")).toEqual([A]);
  await expect(page.getByTestId("locked")).toHaveCount(0);
});

test("画像の削除は、未参照の画像だけを退避の後に削除する（18.2）", async ({ page }) => {
  await launch(page);
  await openA(page);
  // 参照中の画像は削除できない
  await expect(page.getByTestId("media-delete")).toBeDisabled();
  await page.getByTestId("body-editor").fill("画像なし\n");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  await page.getByRole("button", { name: "一覧を更新" }).click();
  await expect(page.getByText("未参照（保存済み本文・cover）")).toBeVisible();
  await page.getByTestId("media-delete").click();
  await page.evaluate(() => (window as unknown as { __fakeFs: FakeFsApi }).__fakeFs.pickNext("backup"));
  await page.getByRole("button", { name: "退避先を選んで退避する" }).click();
  await page.getByRole("button", { name: "画像を削除する" }).click();
  await expect(page.getByTestId("notice")).toContainText("画像を削除しました");
  expect(await list(page, `content/articles/${A}/media`)).toEqual([]);
});

test("復旧ドラフトは同意後にだけ退避し、退避済みを表示する。再読み込み後に候補として出す（33）", async ({ page }) => {
  await launch(page);
  await expect(page.getByTestId("draft-consent")).toBeVisible();
  await openA(page);
  await page.getByTestId("body-editor").fill("同意前の編集\n");
  await expect(page.getByTestId("draft-status")).toContainText("復旧退避なし（ブラウザ内復旧ドラフトは未設定）");
  await page.getByTestId("draft-enable").click();
  // 有効化前の内容は保存していない。次の入力から退避する
  await page.getByTestId("body-editor").fill("退避される編集\n");
  await expect(page.getByTestId("draft-status")).toContainText("復旧退避済み", { timeout: 10_000 });
  // 再読み込み：疑似フォルダは作り直されるため、同じフォルダとは確認できない（関連先未確認）
  await page.reload();
  await page.getByTestId("choose-folder").click();
  await expect(page.getByTestId("draft-consent")).toHaveCount(0);
  const panel = page.getByTestId("recovery-panel");
  await expect(panel).toBeVisible();
  await panel.getByText(/関連先未確認のドラフト/).click();
  await expect(panel.getByTestId("draft-candidate").first()).toContainText("チェックサム一致");
  await expect(panel.getByRole("button", { name: "編集として開く" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "原文を退避" }).first()).toBeVisible();
});

test("初回の復旧ドラフトの設定は編集側の列に出し、決めたらフッターの設定へフォーカスを移す（UI刷新 P-04）", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launch(page);
  const consent = page.getByTestId("draft-consent");
  await expect(consent).toBeVisible();
  // 一覧を押し下げない：一覧と同意の欄は横に並ぶ
  const listBox = await page.locator(".list-pane").boundingBox();
  const consentBox = await consent.boundingBox();
  if (!listBox || !consentBox) throw new Error("領域の位置を取得できません");
  expect(consentBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  expect(consentBox.y).toBeLessThan(listBox.y + 40);
  // 説明はすべて表示したまま
  await expect(consent.locator("li")).toHaveCount(7);
  await consent.getByRole("button", { name: "今は有効にしない" }).focus();
  await page.keyboard.press("Enter");
  await expect(consent).toHaveCount(0);
  await expect(page.getByTestId("draft-settings-summary")).toBeFocused();
});

test("キーボードだけで記事を開き、保存できる（14.1）", async ({ page }) => {
  await launch(page);
  await page.getByRole("button", { name: /最初の記事/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  await page.getByTestId("body-editor").focus();
  await page.keyboard.type("追記");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  // IME 変換中の Ctrl+S（Microsoft IME などでは key が "Process" になる）は保存せず、確定を案内する（14.1）
  await page.keyboard.type("変換中");
  await page.getByTestId("body-editor").dispatchEvent("keydown", {
    key: "Process",
    code: "KeyS",
    ctrlKey: true,
    isComposing: true,
    bubbles: true,
  });
  await expect(page.getByTestId("notice")).toContainText("変換を確定してから保存してください。");
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  // 警告は本文の位置をずらさないトーストで出し、閉じられる（UI刷新 反復4）
  await expect(page.getByTestId("notice")).toHaveCSS("position", "fixed");
  await page.getByRole("button", { name: "通知を閉じる" }).click();
  await expect(page.getByTestId("notice")).toHaveCount(0);
  await expect(page.getByTestId("body-editor")).toBeFocused();
  // スキップリンク：読み込み直後の最初の Tab で到達する
  await page.goto(url);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
});

test("広い画面の作業台レイアウトの上書きが効いている（UI刷新 段階3〜4）", async ({ page }) => {
  await launch(page);
  await page.getByRole("button", { name: /最初の記事/ }).click();
  const body = page.getByTestId("body-editor");
  // 本文欄は内容に合わせて伸び、手で高さを変えるつまみは出さない（段階3 4章で承認）
  await expect(body).toHaveCSS("resize", "none");
  // 一覧の絞り込み欄の入力値は 14px（段階4）
  await expect(page.getByPlaceholder("キーワードで検索")).toHaveCSS("font-size", "14px");
  // 入力欄の枠は 3:1 以上の色を使う（WCAG 1.4.11、段階4）
  await expect(body).toHaveCSS("border-top-color", "rgb(133, 133, 127)");
  await expect(page.locator("#editor-heading")).toHaveCSS("font-size", "18px");
  await expect(page.getByRole("toolbar", { name: "記事の操作" })).toHaveCSS("column-gap", "6px");
  // 961〜1200px では操作列をさらに詰める（反復4）
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.getByRole("toolbar", { name: "記事の操作" })).toHaveCSS("column-gap", "4px");
  // 狭い画面（60rem 以下）は従来どおり
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(body).toHaveCSS("resize", "vertical");
});

test("一覧の絞り込み・並び順は折り畳んでも今の条件を見出しで示す（UI刷新 P-06）", async ({ page }) => {
  await launch(page);
  const cond = page.getByTestId("list-conditions");
  await expect(cond).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("list-conditions-summary")).toHaveText("状態：すべて・更新日時の降順");
  // キーボードで開いて条件を変える
  await cond.locator("summary").focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("状態").selectOption("draft");
  await page.getByLabel("方向").selectOption("asc");
  await cond.locator("summary").click();
  await expect(page.getByTestId("list-conditions-summary")).toHaveText("状態：下書き・更新日時の昇順");
});
