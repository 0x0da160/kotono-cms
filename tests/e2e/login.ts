/**
 * E2E 用：起動時のロック解除（ADR-0011・ADR-0012）と、上部バーのメニューでの画面の切り替え。
 * ロックはパスキーで解除するので、Chromium の仮想の認証器（PRF 対応）で登録・ロック解除する。
 * file:// ではパスキーを使えないため、試験は localhost から配信して開く（playwright.config.ts の webServer）。
 */
import { expect, type CDPSession, type Page } from "@playwright/test";

const authenticators = new WeakMap<Page, { cdp: CDPSession; authenticatorId: string }>();

/** ページに仮想の認証器を付ける（同じページには 1 回だけ）。利用者の操作なしで登録・認証を通す */
export async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const had = authenticators.get(page);
  if (had) return had;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  const a = { cdp, authenticatorId };
  authenticators.set(page, a);
  return a;
}

/** 初回：パスキーを登録し、回復コードの保存を確かめて使い始める。回復コードを返す */
export async function registerLogin(page: Page): Promise<string> {
  await virtualAuthenticator(page);
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "register");
  await page.getByTestId("login-register-passkey").click();
  const code = (await page.getByTestId("recovery-code-value").textContent()) ?? "";
  await page.getByTestId("recovery-kept").check();
  await page.getByTestId("recovery-done").click();
  await expect(page.getByTestId("login")).toHaveCount(0);
  return code;
}

/** 2 回目以降：パスキーでロックを解除する */
export async function loginAgain(page: Page): Promise<void> {
  await virtualAuthenticator(page);
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");
  await page.getByTestId("login-passkey").click();
  await expect(page.getByTestId("login")).toHaveCount(0);
}

/** メニューを開いて項目を押す */
export async function menu(page: Page, testId: string): Promise<void> {
  const item = page.getByTestId(testId);
  if (!(await item.isVisible())) await page.getByTestId("menu-toggle").click();
  await item.click();
}

/** 配信元（localhost）からの読み込み・data:・blob: を除いた、外への通信 */
export function external(requests: readonly string[], origin: string): string[] {
  return requests.filter((r) => !r.startsWith(origin) && !r.startsWith("data:") && !r.startsWith("blob:"));
}
