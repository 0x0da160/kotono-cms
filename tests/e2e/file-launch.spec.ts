import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { external, registerLogin } from "./login";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");

test.beforeAll(() => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
});

test("単一HTMLを配信元から起動できる（仕様 2.1・A01）", async ({ page }) => {
  const requests: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto("/kotono-cms.html");
  await registerLogin(page);

  await expect(page).toHaveTitle("Kotono CMS");
  await expect(page.getByRole("heading", { level: 1, name: "Kotono CMS" })).toBeVisible();
  await expect(page.getByTestId("spec-version")).toHaveText("3.2");
  // 対応環境の確認はメニューの中にある。すべて使えるときは、項目の一覧を畳んで要約だけを見せる
  await page.getByTestId("menu-toggle").click();
  await page.getByTestId("env-open").click();
  const env = page.getByTestId("env-dialog");
  await expect(env.getByRole("heading", { name: "対応環境の確認" })).toBeVisible();
  await expect(page.locator('[data-capability="secure-context"]')).toHaveAttribute("data-ok", "true");
  await expect(env.getByTestId("env-summary")).toContainText("このブラウザで使えます");
  await expect(page.locator('[data-capability="secure-context"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(env).toBeHidden();

  // インラインWorkerが CSP の下で起動する（仕様 16.1.1）
  await expect(page.getByTestId("worker-probe")).toHaveAttribute("data-state", "ok");

  // 自動ネットワーク通信を行わない（仕様 16.3・32.2）: 配信元以外へのリクエストがない
  expect(external(requests, new URL(page.url()).origin)).toEqual([]);
  // CSP 違反やスクリプトエラーがない
  expect(consoleErrors).toEqual([]);
});

test("file:// で開くと、パスキーを使えないため案内だけを出し、何もできない（ADR-0012）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(pathToFileURL(distHtml).href);
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "nopasskey");
  await expect(page.getByTestId("login-nopasskey")).toContainText("localhost");
  // 登録・ログイン・フォルダの選択・ロックは出さない。メニューには対応環境の確認とヘルプだけ
  await expect(page.getByTestId("login-register-passkey")).toHaveCount(0);
  await expect(page.getByTestId("unlock-form")).toHaveCount(0);
  await expect(page.getByTestId("choose-folder")).toHaveCount(0);
  await page.getByTestId("menu-toggle").click();
  await expect(page.getByTestId("env-open")).toBeVisible();
  await expect(page.getByTestId("help-open")).toBeVisible();
  await expect(page.getByTestId("recovery-open")).toHaveCount(0);
  await expect(page.getByTestId("app-lock")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("配布HTMLは外部リソースを参照しない（仕様 2.1）", () => {
  const html = readFileSync(distHtml, "utf8");
  expect(html).not.toMatch(/<(script|link|img|iframe)\b[^>]*\b(src|href)=["']?(https?:)?\/\//i);
  expect(html).not.toMatch(/<link\b[^>]*rel=["']?(stylesheet|modulepreload|preload)/i);
  expect(html).toContain('http-equiv="Content-Security-Policy"');
});

test("CSP が許可していないインラインスクリプトを止める（仕様 16.1.1・TG08 の一部）", async ({ page }) => {
  await page.goto("/kotono-cms.html");
  await registerLogin(page);
  const result = await page.evaluate(
    () =>
      new Promise<string>((resolveResult) => {
        document.addEventListener("securitypolicyviolation", (e) => resolveResult(e.violatedDirective));
        const s = document.createElement("script");
        s.textContent = "window.__injected = true";
        document.head.append(s);
        setTimeout(() => resolveResult("not-blocked"), 1000);
      }),
  );
  expect(result).toBe("script-src-elem");
});
