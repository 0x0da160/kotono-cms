/**
 * E2E 用：起動時のログイン（ADR-0011）と、上部バーのメニューでの画面の切り替え。
 * file:// ではパスキーを使えないので、パスフレーズで登録・ログインする。
 */
import { expect, type Page } from "@playwright/test";

export const E2E_PASSPHRASE = "e2e-passphrase-0123";

/** 初回：パスフレーズで登録し、回復コードの保存を確かめて使い始める。回復コードを返す */
export async function registerLogin(page: Page): Promise<string> {
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "register");
  // パスキーを使える配信元（http://localhost）では、パスフレーズの方を選ぶ
  const alt = page.getByTestId("login-use-passphrase");
  if (await alt.isVisible()) await alt.click();
  await page.getByTestId("login-new-passphrase").fill(E2E_PASSPHRASE);
  await page.getByTestId("login-new-passphrase2").fill(E2E_PASSPHRASE);
  await page.getByTestId("login-register-passphrase").click();
  const code = (await page.getByTestId("recovery-code-value").textContent()) ?? "";
  await page.getByTestId("recovery-kept").check();
  await page.getByTestId("recovery-done").click();
  await expect(page.getByTestId("login")).toHaveCount(0);
  return code;
}

/** 2 回目以降：パスフレーズでログインする */
export async function loginAgain(page: Page): Promise<void> {
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");
  await page.getByTestId("unlock-secret").fill(E2E_PASSPHRASE);
  await page.getByTestId("unlock-run").click();
  await expect(page.getByTestId("login")).toHaveCount(0);
}

/** メニューを開いて項目を押す */
export async function menu(page: Page, testId: string): Promise<void> {
  const item = page.getByTestId(testId);
  if (!(await item.isVisible())) await page.getByTestId("menu-toggle").click();
  await item.click();
}
