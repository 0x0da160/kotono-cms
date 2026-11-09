/**
 * 見たまま編集・画像の最適化と派生画像・前回のフォルダ（ADR-0005）。
 *
 * フォルダはページ内の疑似実装（fake-fs.ts）。画像の縮小・再エンコードはヘッドレス Chromium の
 * createImageBitmap・OffscreenCanvas を使う（実機の Chrome・Edge・Windows・macOS では未検証）。
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installFakeFs, type FakeFsApi } from "./fake-fs";
import { loginAgain, registerLogin } from "./login";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");
/** localhost から配信する（パスキーは file:// では使えない：ADR-0012） */
const url = "/kotono-cms.html";

const A = "k7m2x9q";
const IMG = "abcdefghjk.png";
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const BODY = [
  "# 見出し",
  "",
  "最初の段落と **太字**。",
  "",
  "* 項目1",
  "* 項目2",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  `![既存の画像](./media/${IMG})`,
  "",
  "最後の段落",
  "",
].join("\n");

const article = (text: string) =>
  `---\nid: "${A}"\ntitle: "最初の記事"\nslug: "first"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n${text}`;

type Api = { __fakeFs: FakeFsApi };
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Api).__fakeFs.read(p), path);
const list = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Api).__fakeFs.list(p), path);

test.beforeAll(() => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
});

async function launch(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(installFakeFs, { [`content/articles/${A}/index.md`]: article(BODY) });
  await page.addInitScript(
    ([p, b]) => (window as unknown as Api).__fakeFs.writeBase64(p as string, b as string),
    [`content/articles/${A}/media/${IMG}`, PNG_1x1],
  );
  await page.goto(url);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();
  await page.getByRole("button", { name: /最初の記事/ }).click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  return { errors };
}

/** 本文の Markdown（Markdown の欄に切り替えずに、保存前の文書を読む） */
async function bodyMarkdown(page: Page): Promise<string> {
  await page.getByTestId("body-view-markdown").click();
  const v = await page.getByTestId("body-editor").inputValue();
  await page.getByTestId("body-view-visual").click();
  // 描き直しが終わり、編集できる状態に戻るまで待つ
  await expect(page.getByTestId("visual-editor")).toHaveAttribute("contenteditable", "true");
  return v;
}

test("本文は既定で見たまま表示し、対応しない記法は元の記述のまま残す", async ({ page }) => {
  const { errors } = await launch(page);
  const ed = page.getByTestId("visual-editor");
  await expect(ed.locator("h1")).toHaveText("見出し");
  await expect(ed.locator("strong")).toHaveText("太字");
  await expect(ed.locator("ul > li")).toHaveCount(2);
  // 表は編集できない塊のまま、罫線（グリッド線）つきの表として見せる
  await expect(ed.locator(".v-table th")).toHaveText(["a", "b"]);
  await expect(ed.locator(".v-table td")).toHaveText(["1", "2"]);
  await expect(ed.locator(".v-table td").first()).toHaveCSS("border-top-style", "solid");
  await expect(ed.locator(".v-table")).toHaveAttribute("contenteditable", "false");
  // 既存の画像は検証してから blob: で表示する
  const img = ed.locator(".v-img img");
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.src.startsWith("blob:"))).toBe(true);
  expect(errors).toEqual([]);
});

test("見たままで入力すると、編集したブロックだけが Markdown に書き直され、保存できる", async ({ page }) => {
  await launch(page);
  const ed = page.getByTestId("visual-editor");
  const last = ed.locator("p", { hasText: "最後の段落" });
  await last.click();
  await page.keyboard.press("End");
  await page.keyboard.type("を編集 *記号*");
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  expect(await bodyMarkdown(page)).toBe(BODY.replace("最後の段落\n", "最後の段落を編集 \\*記号\\*\n"));

  // 選択して太字にする
  await ed.locator("p", { hasText: "最初の段落" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  // 書式の帯は、選択範囲の近く（上）に出る
  const bar = page.getByTestId("fmt-bar");
  await expect(bar).toBeVisible();
  const selTop = await page.evaluate(() => document.getSelection()?.getRangeAt(0).getBoundingClientRect().top ?? 0);
  const barBox = await bar.boundingBox();
  if (!barBox) throw new Error("書式の帯の位置を取得できません");
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(selTop);
  expect(selTop - (barBox.y + barBox.height)).toBeLessThan(24);
  await page.getByTestId("fmt-bold").click();
  const md = await bodyMarkdown(page);
  expect(md).toContain("**最初**の段落と **太字**。");
  // 編集していない表・リスト・画像の記述は変わらない
  expect(md).toContain("* 項目1\n* 項目2\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  expect(md).toContain(`![既存の画像](./media/${IMG})`);

  // 元に戻すは文書の履歴を使い、見たまま表示も戻る
  await page.keyboard.press("Control+z");
  await expect(ed.locator("p strong")).toHaveCount(1);

  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  expect(await read(page, `content/articles/${A}/index.md`)).toContain("最後の段落を編集 \\*記号\\*");
});

test("見たままで箇条書き・リンクを付ける", async ({ page }) => {
  await launch(page);
  const ed = page.getByTestId("visual-editor");
  await ed.locator("p", { hasText: "最後の段落" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("新しい項目");
  await page.getByTestId("fmt-more").click();
  await page.getByRole("button", { name: "箇条書き" }).click();
  // 項目の文字を選択する
  await ed.locator("li", { hasText: "新しい項目" }).evaluate((li) => {
    const r = document.createRange();
    r.selectNodeContents(li);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(r);
  });
  await page.getByTestId("fmt-link").click();
  await page.getByTestId("link-url").fill("https://example.com/");
  await page.getByTestId("link-apply").click();
  const md = await bodyMarkdown(page);
  expect(md).toMatch(/最後の段落\n\n- \[新しい項目\]\(https:\/\/example\.com\/\)\n$/);
  // 編集領域のリンクは遷移しない（href を持たない）
  await expect(ed.locator("a[href]")).toHaveCount(0);
  // 本文からフォーカスが外れると、書式の帯を隠す
  await page.getByLabel("タイトル", { exact: true }).click();
  await expect(page.getByTestId("fmt-bar")).toBeHidden();
});

test("画像は取り込み時に縮小・メタデータ削除して原本にし、派生画像を作って見たまま表示に使う", async ({ page }) => {
  await launch(page);
  // 5000×3000 の JPEG に Exif（APP1）を足したものを作る
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(5000, 3000);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const g = ctx.createLinearGradient(0, 0, 5000, 3000);
    g.addColorStop(0, "#c33");
    g.addColorStop(1, "#33c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 5000, 3000);
    const jpg = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
    const payload = new TextEncoder().encode("Exif\0\0MM\0*\0\0\0\x08\0\0GPS-SECRET");
    const len = payload.length + 2;
    const app1 = new Uint8Array([0xff, 0xe1, len >> 8, len & 255, ...payload]);
    const out = new Uint8Array([...jpg.subarray(0, 2), ...app1, ...jpg.subarray(2)]);
    let s = "";
    for (const x of out) s += String.fromCharCode(x);
    return btoa(s);
  });
  const input = Buffer.from(b64, "base64");
  expect(input.includes(Buffer.from("GPS-SECRET"))).toBe(true);
  await page.getByTestId("media-input").setInputFiles({ name: "big.jpg", mimeType: "image/jpeg", buffer: input });
  await expect(page.getByTestId("notice")).toContainText("画像を 1 件取り込みました", { timeout: 20_000 });
  await expect(page.getByTestId("media-panel")).toContainText("5000×3000 → 4096×2457 に縮小");
  const names = (await list(page, `content/articles/${A}/media`)).filter((n) => n !== IMG && n !== "variants");
  expect(names).toHaveLength(1);
  const name = names[0] ?? "";
  expect(name).toMatch(/^[0-9a-hjkmnp-tv-z]{10}\.jpg$/);
  const id = name.replace(/\.jpg$/, "");
  // 原本：メタデータなし・上限内
  const saved = await page.evaluate(async (p) => {
    const bytes = (window as unknown as Api).__fakeFs.readBytes(p);
    const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    const s = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 65536)));
    return {
      size: bytes.length,
      w: bmp.width,
      h: bmp.height,
      exif: s.includes("Exif"),
      secret: s.includes("GPS-SECRET"),
    };
  }, `content/articles/${A}/media/${name}`);
  expect(saved).toEqual(expect.objectContaining({ w: 4096, h: 2457, exif: false, secret: false }));
  expect(saved.size).toBeLessThanOrEqual(4 * 1024 * 1024);
  // 派生画像：幅 480・960・1920 の WebP と JPEG
  expect((await list(page, `content/articles/${A}/media/variants`)).sort()).toEqual(
    [480, 960, 1920].flatMap((w) => [`${id}-${w}w.jpg`, `${id}-${w}w.webp`]).sort(),
  );

  // 見たまま表示の段落の後ろに挿入すると、独立した段落になり、派生画像（WebP）で表示する
  await page.getByTestId("visual-editor").locator("p", { hasText: "最初の段落" }).click();
  await page.getByTestId("job-alt").fill("グラデーション");
  await page.getByTestId("job-insert").click();
  const md = await bodyMarkdown(page);
  expect(md).toContain(`最初の段落と **太字**。\n\n![グラデーション](./media/${name})\n\n* 項目1`);
  const img = page.getByTestId("visual-editor").locator(".v-img img").first();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(400);
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeLessThanOrEqual(1920);
});

test("前回のフォルダを記憶し、次回の起動で開き直す操作を示す", async ({ page }) => {
  await launch(page);
  await expect(page.getByTestId("folder-name")).toContainText("作業フォルダ");
  await page.reload();
  await loginAgain(page);
  // 疑似フォルダのハンドルは IndexedDB へ保存すると操作を失うため、開き直しの失敗表示までを確かめる
  // （実際のフォルダハンドルの永続化・権限の再要求は実機で未検証）
  const recent = page.getByTestId("reopen-recent");
  await expect(recent).toBeVisible();
  await expect(recent).toContainText("前回のフォルダ");
  await recent.click();
  await expect(page.getByTestId("folder-error")).toContainText("選び直してください");
  await page.getByTestId("forget-recent").click();
  await expect(page.getByTestId("reopen-recent")).toHaveCount(0);
  await page.reload();
  await loginAgain(page);
  await expect(page.getByTestId("choose-folder")).toBeVisible();
  await expect(page.getByTestId("reopen-recent")).toHaveCount(0);
});

test("日本語の変換中は本文を書き直さず、確定してから反映する（14.1）", async ({ page }) => {
  await launch(page);
  const ed = page.getByTestId("visual-editor");
  await ed.locator("p", { hasText: "最後の段落" }).click();
  await page.keyboard.press("End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "へんかん", selectionStart: 4, selectionEnd: 4 });
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  await cdp.send("Input.insertText", { text: "変換" });
  await expect(page.getByTestId("save-status")).toHaveText("未保存");
  expect(await bodyMarkdown(page)).toContain("最後の段落変換\n");
});
