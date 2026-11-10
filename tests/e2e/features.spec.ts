/**
 * localhost から配信した成果物の、プレビュー・画像・複製・削除・復旧ドラフト（14・16・17・18・19・33）。
 *
 * フォルダはページ内の疑似実装（fake-fs.ts）。実フォルダ・権限・実ディスク・シンボリックリンクは
 * 検証していない（TG01・TG05・TG06）。IndexedDB はヘッドレス Chromium の実装を使う。
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installFakeFs, type FakeFsApi } from "./fake-fs";
import { external, loginAgain, menu, registerLogin } from "./login";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");
/** localhost から配信する（パスキーは file:// では使えない：ADR-0012） */
const url = "/kotono-cms.html";

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
  await registerLogin(page);
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
  expect(external(requests, new URL(page.url()).origin)).toEqual([]);
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

test("復旧ドラフトは既定で有効で、暗号化して退避する。ロックを解除し直すと候補として出す（33・ADR-0011）", async ({
  page,
}) => {
  await launch(page);
  await openA(page);
  await page.getByTestId("body-editor").fill("退避される編集\n");
  await expect(page.getByTestId("draft-status")).toContainText("復旧退避済み", { timeout: 10_000 });
  // ブラウザ内（IndexedDB）には本文を平文で置かない
  const raw = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const r = indexedDB.open("kotono-cms-drafts");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const q = r.result.transaction("drafts").objectStore("drafts").getAll();
          q.onsuccess = () => resolve(JSON.stringify(q.result));
          q.onerror = () => reject(q.error);
        };
      }),
  );
  expect(raw).not.toContain("退避される編集");
  expect(raw).not.toBe("[]");
  // 再読み込み：ロックを解除し直す。疑似フォルダは作り直されるため、同じフォルダとは確認できない（関連先未確認）
  await page.reload();
  await loginAgain(page);
  await page.getByTestId("choose-folder").click();
  // 復旧ドラフトはメニューの中の窓にある。候補があるとトグルに印が付く
  await expect(page.getByTestId("menu-toggle")).toHaveAttribute("data-attention", "info");
  await menu(page, "recovery-open");
  const panel = page.getByTestId("recovery-dialog").getByTestId("recovery-panel");
  await expect(panel).toBeVisible();
  await panel.getByText(/関連先未確認のドラフト/).click();
  await expect(panel.getByTestId("draft-candidate").first()).toContainText("チェックサム一致");
  await expect(panel.getByRole("button", { name: "編集として開く" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "原文を退避" }).first()).toBeVisible();
});

test("復旧ドラフトは「設定」で無効にでき、無効の間は退避しない（ADR-0011）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launch(page);
  await menu(page, "nav-settings");
  const card = page.getByTestId("draft-settings");
  await expect(card).toContainText("状態：有効");
  await expect(card.getByTestId("draft-encryption")).toContainText("パスキー");
  await card.getByRole("button", { name: "無効にする…" }).click();
  await page.getByRole("button", { name: "無効にして既存を保持" }).click();
  await expect(card).toContainText("状態：無効（復旧退避なし）");
  await menu(page, "nav-articles");
  await openA(page);
  await page.getByTestId("body-editor").fill("退避しない編集\n");
  await expect(page.getByTestId("draft-status")).toContainText("復旧退避なし（ブラウザ内復旧ドラフトは無効）");
});

test("上部バーは固定して大きさを変えず、画面の切り替えはメニューにまとめる。切り替えても編集中の内容は残る（アプリの外枠）", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launch(page);
  const bar = page.getByTestId("app-bar");
  await expect(bar).toHaveCSS("position", "sticky");
  const toggle = page.getByTestId("menu-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("app-menu")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const nav = page.getByTestId("app-nav");
  // 広い画面：記事・Git と同期・設定の3つ
  await expect(nav.getByRole("button").filter({ visible: true })).toHaveText(["記事", "Git と同期", "設定"]);
  await expect(page.getByTestId("nav-articles")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-articles")).toBeFocused();
  // Esc で閉じて、開閉のボタンへ戻る
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("app-menu")).toBeHidden();
  await expect(toggle).toBeFocused();
  await openA(page);
  await page.getByLabel("タイトル", { exact: true }).fill("編集中のタイトル");
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  await menu(page, "nav-changes");
  await expect(page.getByTestId("current-section")).toHaveText("Git と同期");
  await expect(page.getByTestId("git-panel")).toBeVisible();
  await expect(page.getByTestId("save-status")).toBeHidden();
  await menu(page, "nav-settings");
  await expect(page.getByTestId("app-version")).toBeVisible();
  await menu(page, "nav-articles");
  await expect(page.getByLabel("タイトル", { exact: true })).toHaveValue("編集中のタイトル");
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  // ヘルプもメニューにある
  await menu(page, "help-open");
  await expect(page.getByTestId("help-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // 狭い画面：一覧・編集・Git と同期・設定の4つ。記事を開くと「編集」に移る
  await page.setViewportSize({ width: 900, height: 800 });
  await toggle.click();
  await expect(nav.getByRole("button").filter({ visible: true })).toHaveText(["一覧", "編集", "Git と同期", "設定"]);
  await expect(page.getByTestId("nav-editor")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("nav-list").click();
  await expect(page.getByTestId("app-menu")).toBeHidden();
  await expect(page.getByTestId("current-section")).toHaveText("記事");
  await expect(page.getByTestId("save-status")).toBeHidden();
  await page
    .getByRole("button", { name: /編集中のタイトル|最初の記事/ })
    .first()
    .click();
  await toggle.click();
  await expect(page.getByTestId("nav-editor")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  // 上部バーは最初からコンパクトで、スクロールしても大きさは変えず、画面の上に残す
  await page.setViewportSize({ width: 900, height: 360 });
  const before = await bar.evaluate((el) => (el as HTMLElement).offsetHeight);
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(24);
  expect(await bar.evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
  expect(await bar.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(before);
});

test("上部バーは最初からコンパクトで、スクロールしても大きさが変わらない（ちらつかない）。メニューの開閉はアイコンだけ", async ({
  page,
}) => {
  await page.goto(url);
  await registerLogin(page);
  const toggle = page.getByTestId("menu-toggle");
  await expect(toggle).toHaveAccessibleName("メニュー");
  await expect(toggle).toHaveText("");
  const bar = page.getByTestId("app-bar");
  // 最初の画面（以前は説明文を詰めると高さが大きく変わった）。画面より長いページになる高さで、スクロールしても高さと位置が変わらないことを確かめる
  await page.setViewportSize({ width: 390, height: 900 });
  const contentH = await page.evaluate(() => document.querySelector("footer")?.getBoundingClientRect().bottom ?? 0);
  for (const height of [Math.floor(contentH * 0.75), Math.floor(contentH * 0.55)]) {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => scrollTo(0, 0));
    const before = await bar.evaluate((el) => (el as HTMLElement).offsetHeight);
    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.mouse.move(200, height - 60);
    for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 2);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(24);
    expect(await bar.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(before);
    expect(await bar.evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
    // ページの高さも変わらない（位置が戻らない）
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(docH);
    await page.evaluate(() => scrollTo(0, 0));
  }
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
  // （ロック解除の画面でも同じ）
  await page.goto(url);
  await expect(page.getByTestId("login")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  await loginAgain(page);
});

test("広い画面の作業台レイアウトの上書きが効いている（UI刷新 段階3〜4）", async ({ page }) => {
  await launch(page);
  await page.getByRole("button", { name: /最初の記事/ }).click();
  const body = page.getByTestId("body-editor");
  // 本文欄は内容に合わせて伸び、手で高さを変えるつまみは出さない（段階3 4章で承認）
  await expect(body).toHaveCSS("resize", "none");
  // 一覧の絞り込み欄の入力値は 14px（段階4）
  await expect(page.getByPlaceholder("キーワードで検索")).toHaveCSS("font-size", "14px");
  // 入力欄の枠は 3:1 以上の色を使う（WCAG 1.4.11）。--color-border-control（ライト：neutral-600 = #81807d）
  await expect(body).toHaveCSS("border-top-color", "rgb(129, 128, 125)");
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

test("説明は「?」で開いて Esc で閉じ、長い説明は上部バーの「ヘルプ」にまとめる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launch(page);
  // 一覧のキーワード：説明は閉じているが、入力欄の説明としては読める
  const kw = page.getByPlaceholder("キーワードで検索");
  await expect(kw).toHaveAccessibleDescription(/部分一致/);
  const tip = page.getByRole("button", { name: "キーワードの説明" });
  await expect(page.locator("#kw-hint")).toBeHidden();
  await tip.click();
  await expect(tip).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#kw-hint")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#kw-hint")).toBeHidden();
  await expect(tip).toBeFocused();
  // 外側を押しても閉じる
  await tip.click();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#kw-hint")).toBeHidden();

  // ヘルプ：キーボードの説明はここにある（メニューの中）
  await page.getByTestId("menu-toggle").click();
  const open = page.getByTestId("help-open");
  await open.click();
  const dialog = page.getByTestId("help-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Ctrl/⌘+S");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("menu-toggle")).toBeFocused();
});
