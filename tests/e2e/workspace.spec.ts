/**
 * ブラウザ内の作業場所（仕様 3.2 第38・39章）。OPFS は安全な配信元が要るため、dist を localhost から配信して開く。
 * iPhone の画面幅で、作成・回復コード・記事の保存・ロックと解錠・暗号化した書き出しと取り込みを通す。
 * Chromium での確認であり、iOS Safari 実機（TG13〜15）の代替ではない。
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const DIST = resolve(import.meta.dirname, "../../dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/$/, "/kotono-cms.html");
    readFile(join(DIST, path.replace(/\.\./g, "")))
      .then((b) => {
        res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
        res.end(b);
      })
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
});

test.afterAll(() => {
  server.close();
});

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function open(page: Page) {
  await page.goto(`${base}/kotono-cms.html?storage=workspace`);
  await expect(page.getByTestId("places")).toBeVisible();
  // 復旧ドラフトは使う（暗号化して置く）
  await page.getByRole("button", { name: "有効にする（推奨）" }).click();
}

test("作業場所を作り、記事を保存し、ロックと解錠、暗号化した書き出しと取り込みができる（38・39）", async ({
  page,
  browser,
}) => {
  await open(page);
  await expect(page.getByTestId("env-summary")).toContainText("必要なAPIを備えています");
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  const code = (await page.getByTestId("recovery-code-value").textContent()) ?? "";
  expect(code).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
  await expect(page.getByTestId("recovery-done")).toBeDisabled();
  // パスワード管理に保存させる欄（ユーザー名と新しいパスワード）に回復コードが入っている
  const save = page.getByTestId("recovery-save-field");
  await expect(save).toHaveAttribute("autocomplete", "new-password");
  await expect(save).toHaveValue(code);
  await expect(page.getByTestId("recovery-account")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByTestId("recovery-account")).toHaveValue(/^kotono-[0-9a-z-]{8}$/);
  await page.getByTestId("recovery-kept").check();
  // 書き換えられた回復コードは保存させない
  await save.fill("abc");
  await expect(page.getByTestId("recovery-done")).toBeDisabled();
  await save.fill(code.toLowerCase());
  await expect(page.getByTestId("recovery-done")).toBeEnabled();
  await page.getByTestId("recovery-done").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");

  await page.getByRole("button", { name: "新規作成" }).click();
  await page.getByLabel("タイトル", { exact: true }).fill("iPhone の記事");
  await page.getByLabel("slug", { exact: true }).fill("iphone");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  await expect(page.getByTestId("unsynced")).toContainText("書き出し・同期していない変更あり");

  // 保存領域に記事の名前・本文が平文で残らない
  const names = await page.evaluate(async () => {
    const out: string[] = [];
    const walk = async (d: FileSystemDirectoryHandle, p: string) => {
      for await (const [n, h] of d as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        out.push(`${p}${n}`);
        if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${p}${n}/`);
        else if ((await (h as FileSystemFileHandle).getFile().then((f) => f.text())).includes("iPhone の記事"))
          out.push("PLAINTEXT");
      }
    };
    await walk(await navigator.storage.getDirectory(), "");
    return out.join("\n");
  });
  expect(names).not.toContain("content");
  expect(names).not.toContain("index.md");
  expect(names).not.toContain("PLAINTEXT");

  await page.getByTestId("place-lock-open").click();
  // すべてロックすると、起動時と同じログインの画面に戻る。パスキーがないので回復コードを主な操作にする
  await expect(page.getByTestId("login-gate")).toBeVisible();
  await expect(page.getByTestId("login-no-passkey")).toBeVisible();
  await expect(page.getByTestId("login-passkey")).toHaveCount(0);
  await expect(page.getByTestId("places")).toHaveCount(0);
  await page.getByTestId("login-recovery").click();
  await expect(page.getByTestId("place")).toHaveAttribute("data-locked", "true");
  await page.getByTestId("place-unlock").click();
  await expect(page.getByTestId("unlock-secret")).toHaveAttribute("autocomplete", "current-password");
  await page.getByTestId("unlock-secret").fill(code.toLowerCase());
  await page.getByTestId("unlock-run").click();
  await expect(page.getByTestId("article-row").filter({ hasText: "iPhone の記事" })).toBeVisible();
  // 回復コードで開いたので、次の起動からパスキーでログインできるよう登録を勧める
  await expect(page.getByTestId("suggest-passkey")).toBeVisible();
  await page.getByTestId("suggest-passkey-later").click();
  await expect(page.getByTestId("suggest-passkey")).toHaveCount(0);

  const dl = page.waitForEvent("download");
  await page.getByTestId("place-export-open").click();
  await page.getByRole("button", { name: "暗号化して書き出す" }).click();
  const file = await (await dl).path();
  expect(file).toBeTruthy();
  const bytes = await readFile(file);
  expect(bytes.subarray(0, 15).toString()).toBe("KOTONO-EXPORT/1");
  expect(bytes.includes(Buffer.from("iPhone の記事"))).toBe(false);

  // 別の端末（新しいプロファイル）で取り込む
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await other.newPage();
  await open(p2);
  await p2
    .getByTestId("import-file")
    .setInputFiles({ name: "blog.kotono", mimeType: "application/octet-stream", buffer: bytes });
  await p2.getByTestId("unlock-secret").fill(code);
  await p2.getByTestId("unlock-run").click();
  await expect(p2.getByTestId("import-confirm")).toBeVisible();
  await p2.getByTestId("import-name").fill("取り込んだブログ");
  await p2.getByTestId("import-run").click();
  await expect(p2.getByTestId("folder-name")).toHaveText("作業場所：取り込んだブログ");
  await expect(p2.getByTestId("article-row").filter({ hasText: "iPhone の記事" })).toBeVisible();
  await other.close();
});

/** Chromium の仮想の認証器（PRF 対応）。パスキーの登録・認証を、利用者の操作なしで通す */
async function virtualAuthenticator(page: Page) {
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
  return { cdp, authenticatorId };
}

test("起動時はパスキーでログインして作業場所を開き、失敗したら回復コードで開ける（39.3）", async ({ page }) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  await open(page);
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  const code = (await page.getByTestId("recovery-code-value").textContent()) ?? "";
  await page.getByTestId("recovery-add-passkey").click();
  await expect(page.getByTestId("recovery-passkey")).toContainText("登録しました");
  await page.getByTestId("recovery-kept").check();
  await page.getByTestId("recovery-done").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");

  // 起動し直すと、作業場所の一覧より先にログインを求める
  await page.reload();
  await expect(page.getByTestId("login-gate")).toBeVisible();
  await expect(page.getByTestId("places")).toHaveCount(0);
  await expect(page.getByTestId("login-passkey")).toHaveClass(/primary/);
  await page.getByTestId("login-passkey").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");

  // ロックすると、またログインの画面に戻る
  await page.getByTestId("place-lock-open").click();
  await expect(page.getByTestId("login-gate")).toBeVisible();

  // パスキーが見つからない（別の端末など）：自動で繰り返さず、回復コードを主な操作にする
  await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
  let asked = 0;
  cdp.on("WebAuthn.credentialAsserted", () => asked++);
  await page.getByTestId("login-passkey").click();
  await expect(page.getByTestId("login-error")).toContainText("回復コード");
  await expect(page.getByTestId("login-recovery")).toHaveClass(/primary/);
  await expect(page.getByTestId("login-passkey")).not.toHaveClass(/primary/);
  await expect(page.getByTestId("login-passkey")).toBeEnabled();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("login-gate")).toBeVisible();
  expect(asked).toBe(0);

  await page.getByTestId("login-recovery").click();
  await expect(page.getByTestId("back-to-login")).toBeVisible();
  await page.getByTestId("place-unlock").click();
  await page.getByTestId("unlock-secret").fill(code);
  await page.getByTestId("unlock-run").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");
});

test("パスキーのない作業場所を回復コードで開くと、パスキーの登録を勧め、次からパスキーでログインできる（39.3）", async ({
  page,
}) => {
  await virtualAuthenticator(page);
  await open(page);
  await page.getByTestId("place-name").fill("日記");
  await page.getByTestId("place-create-run").click();
  const code = (await page.getByTestId("recovery-code-value").textContent()) ?? "";
  await page.getByTestId("recovery-kept").check();
  await page.getByTestId("recovery-done").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：日記");

  await page.reload();
  await expect(page.getByTestId("login-gate")).toBeVisible();
  await expect(page.getByTestId("login-no-passkey")).toBeVisible();
  await expect(page.getByTestId("login-recovery")).toHaveClass(/primary/);
  await page.getByTestId("login-recovery").click();
  await page.getByTestId("place-unlock").click();
  await page.getByTestId("unlock-secret").fill(code);
  await page.getByTestId("unlock-run").click();
  await expect(page.getByTestId("suggest-passkey")).toBeVisible();
  await page.getByTestId("suggest-passkey-add").click();
  await expect(page.getByTestId("suggest-passkey")).toHaveCount(0);

  await page.reload();
  await page.getByTestId("login-passkey").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：日記");
});
