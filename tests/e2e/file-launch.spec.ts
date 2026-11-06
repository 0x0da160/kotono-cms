import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const distHtml = resolve(import.meta.dirname, "../../dist/kotono-cms.html");

test.beforeAll(() => {
  if (!existsSync(distHtml))
    throw new Error("dist/kotono-cms.html がありません。先に `pnpm build` を実行してください。");
});

test("単一HTMLを file:// で起動できる（仕様 2.1・A01）", async ({ page }) => {
  const requests: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  const url = pathToFileURL(distHtml).href;
  await page.goto(url);

  await expect(page).toHaveTitle("Kotono CMS");
  await expect(page.getByRole("heading", { level: 1, name: "Kotono CMS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "対応環境の確認" })).toBeVisible();
  await expect(page.getByTestId("spec-version")).toHaveText("3.2");
  // file:// でも安全なコンテキストとして扱われること
  await expect(page.locator('[data-capability="secure-context"]')).toHaveAttribute("data-ok", "true");

  // インラインWorkerが file:// と CSP の下で起動する（仕様 16.1.1）
  await expect(page.getByTestId("worker-probe")).toHaveAttribute("data-state", "ok");

  // 自動ネットワーク通信を行わない（仕様 16.3・32.2）: 自身以外のリクエストがない
  // （CMSが内部生成した blob: URL は通信ではないため除外する）
  expect(requests.filter((r) => !r.startsWith("blob:"))).toEqual([url]);
  // CSP 違反やスクリプトエラーがない
  expect(consoleErrors).toEqual([]);
});

test("配布HTMLは外部リソースを参照しない（仕様 2.1）", () => {
  const html = readFileSync(distHtml, "utf8");
  expect(html).not.toMatch(/<(script|link|img|iframe)\b[^>]*\b(src|href)=["']?(https?:)?\/\//i);
  expect(html).not.toMatch(/<link\b[^>]*rel=["']?(stylesheet|modulepreload|preload)/i);
  expect(html).toContain('http-equiv="Content-Security-Policy"');
});

test("CSP が許可していないインラインスクリプトを止める（仕様 16.1.1・TG08 の一部）", async ({ page }) => {
  await page.goto(pathToFileURL(distHtml).href);
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
