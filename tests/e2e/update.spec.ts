/**
 * アプリの新しい版を確かめて切り替える操作（仕様 29.3・38.5）が、見つけられる場所にあること。
 *
 * Service Worker は https か localhost でしか動かないので、dist/ を localhost の簡易サーバーで配信して確かめる。
 * 配信する sw.js の中身を変えると、ブラウザは新しい版として取得する。
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installFakeFs } from "./fake-fs";
import { loginAgain, menu, registerLogin } from "./login";

const dist = resolve(import.meta.dirname, "../../dist");
const distHtml = resolve(dist, "kotono-cms.html");

const A = "k7m2x9q";
const SEED = {
  [`content/articles/${A}/index.md`]: `---\nid: "${A}"\ntitle: "最初の記事"\nslug: "first"\nstatus: "draft"\ncreatedAt: "2026-11-03T22:08:00+09:00"\nupdatedAt: "2026-11-03T22:08:00+09:00"\npublishedAt: null\ntags: []\ncover: null\n---\n本文\n`,
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let server: Server;
let origin = "";
/** 配信する sw.js の末尾に足す文字列。変えると新しい版として扱われる */
let swSuffix = "";

test.beforeAll(async () => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // GitHub Pages への配置と同じく、kotono-cms.html を index.html としても配信する（.github/workflows/pages.yml）
    const name = path === "/" || path === "/index.html" ? "kotono-cms.html" : path.slice(1);
    const file = resolve(dist, name);
    if (!file.startsWith(dist + "/") || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    let body: Buffer | string = readFileSync(file);
    if (name === "sw.js") body = `${body.toString()}\n${swSuffix}`;
    res.writeHead(200, {
      "content-type": TYPES[extname(name)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

test.beforeEach(() => {
  swSuffix = "";
});

/** Service Worker の登録が済み、制御下に入ってから返す */
async function launchServed(page: Page) {
  await page.addInitScript(installFakeFs, SEED);
  await page.goto(`${origin}/`);
  await registerLogin(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // 初回は制御下にないので読み込み直す（2回目以降の起動と同じ状態にする）
  await page.reload();
  await loginAgain(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("最初の画面のフッターで新しい版を確かめられ、新しい版がなければ最新と示す", async ({ page }) => {
  await launchServed(page);
  const update = page.locator("footer").getByTestId("app-update");
  await update.getByRole("button", { name: "新しい版を確かめる" }).click();
  await expect(update.getByTestId("update-check-result")).toHaveText("いまの版が最新です。");
});

test("作業中は「設定」の先頭で新しい版を確かめられ、取得した版にお知らせの帯からも切り替えられる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launchServed(page);
  await page.getByTestId("choose-folder").click();

  await menu(page, "nav-settings");
  const card = page.getByTestId("settings-app");
  // 設定の画面の最初の項目として見える
  await expect(page.locator('[data-section="settings"] .page-inner > *').first()).toHaveAttribute(
    "data-testid",
    "settings-app",
  );
  await expect(card.getByRole("heading", { name: "アプリの更新と版" })).toBeVisible();
  await expect(card.getByTestId("app-version")).toBeVisible();
  const check = card.getByRole("button", { name: "新しい版を確かめる" });
  await expect(check).toBeVisible();

  // 配信側に新しい版を置いてから確かめる
  swSuffix = "/* next */";
  await check.click();
  const apply = card.getByRole("button", { name: "新しい版に切り替える" });
  await expect(apply).toBeVisible();
  // どの画面にいても、お知らせの帯に出る
  await menu(page, "nav-articles");
  const band = page.getByTestId("app-notices").getByTestId("update-ready");
  await expect(band).toContainText("新しい版を取得しました。");

  // 切り替えると読み込み直して新しい版で動く
  const reloaded = page.waitForEvent("framenavigated");
  await band.getByRole("button", { name: "新しい版に切り替える" }).click();
  await reloaded;
  await expect(page.getByRole("heading", { level: 1, name: "Kotono CMS" })).toBeVisible();
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");
  const sw = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { waiting: !!r?.waiting, active: r?.active?.scriptURL ?? "" };
  });
  expect(sw.waiting).toBe(false);
  expect(sw.active).toContain("/sw.js");
});

test("file:// で開いたときは、新しい版にする方法を「設定」で示す", async ({ page }) => {
  await page.addInitScript(installFakeFs, SEED);
  await page.goto(pathToFileURL(distHtml).href);
  await registerLogin(page);
  await page.getByTestId("choose-folder").click();
  await menu(page, "nav-settings");
  await expect(page.getByTestId("settings-app").getByTestId("update-unavailable")).toContainText(
    "kotono-cms.html に差し替えてから開き直してください",
  );
});
