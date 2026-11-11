/**
 * ブラウザ内の作業場所（仕様 3.2 第38・39章）。OPFS は安全な配信元が要るため、dist を localhost から配信して開く。
 * iPhone の画面幅で、作成・記事の保存・ロックとロック解除・暗号化した書き出しと取り込みを通す。
 * Chromium での確認であり、iOS Safari 実機（TG13〜15）の代替ではない。
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loginAgain, menu, registerLogin, virtualAuthenticator } from "./login";

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

/** 開いて、起動時のロック解除（パスキー）を登録する。回復コードを返す */
async function open(page: Page): Promise<string> {
  await page.goto(`${base}/kotono-cms.html?storage=workspace`);
  // 何よりも先にパスキーの登録を求める。作業場所の一覧はまだ出さない
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "register");
  await expect(page.getByTestId("places")).toHaveCount(0);
  const code = await registerLogin(page);
  await expect(page.getByTestId("places")).toBeVisible();
  return code;
}

test("作業場所はロック解除の鍵で暗号化し、作業場所ごとの回復コードなしで作って開ける。暗号化した書き出しは別の端末で、書き出した端末の回復コードで取り込める（38・39、ADR-0012）", async ({
  page,
  browser,
}) => {
  const code = await open(page);
  expect(code).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
  await menu(page, "env-open");
  await expect(page.getByTestId("env-summary")).toContainText("必要なAPIを備えています");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("env-dialog")).toBeHidden();
  // 暗号化するかを選ぶ欄はない
  await expect(page.getByTestId("place-encrypt")).toHaveCount(0);
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  // 作業場所ごとの回復コードは出さずに、そのまま開く
  await expect(page.getByTestId("recovery-code")).toHaveCount(0);
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

  // ロックすると、起動時と同じロック解除の画面に戻る。ロックを解除しただけで作業場所も開ける
  await page.getByTestId("menu-toggle").click();
  await expect(page.getByTestId("app-lock")).toHaveText("ロック");
  await menu(page, "app-lock");
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");
  await expect(page.getByTestId("places")).toHaveCount(0);
  // 表現は「ロック」と「ロック解除」で対にする。「ログイン」とは呼ばない（ADR-0014）
  await expect(page.getByRole("heading", { name: "ロック解除" })).toBeVisible();
  await expect(page.getByTestId("login-passkey")).toHaveText("パスキーでロック解除");
  await expect(page.getByTestId("unlock-run")).toHaveText("ロック解除");
  await expect(page.getByTestId("login")).not.toContainText("ログイン");
  // パスフレーズの欄はない
  await expect(page.getByRole("radio", { name: "パスフレーズ" })).toHaveCount(0);
  await loginAgain(page);
  await expect(page.getByTestId("place")).toHaveAttribute("data-locked", "false");
  // 作業場所ごとのロック・ロック解除はない
  await expect(page.getByTestId("place-lock")).toHaveCount(0);
  await page.getByTestId("place-open").click();
  await expect(page.getByTestId("article-row").filter({ hasText: "iPhone の記事" })).toBeVisible();

  const dl = page.waitForEvent("download");
  await page.getByTestId("place-export-open").click();
  await page.getByRole("button", { name: "暗号化して書き出す" }).click();
  const file = await (await dl).path();
  expect(file).toBeTruthy();
  const bytes = await readFile(file);
  expect(bytes.subarray(0, 15).toString()).toBe("KOTONO-EXPORT/1");
  expect(bytes.includes(Buffer.from("iPhone の記事"))).toBe(false);

  // 別の端末（新しいプロファイル・別のロック解除の鍵）で、書き出した端末の回復コードで取り込む
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await other.newPage();
  await open(p2);
  await p2
    .getByTestId("import-file")
    .setInputFiles({ name: "blog.kotono", mimeType: "application/octet-stream", buffer: bytes });
  await expect(p2.getByTestId("import-sealed")).toBeVisible();
  await p2.getByTestId("unlock-secret").fill(code);
  await p2.getByTestId("unlock-run").click();
  await expect(p2.getByTestId("import-confirm")).toBeVisible();
  await p2.getByTestId("import-name").fill("取り込んだブログ");
  await p2.getByTestId("import-run").click();
  await expect(p2.getByTestId("folder-name")).toHaveText("作業場所：取り込んだブログ");
  await expect(p2.getByTestId("article-row").filter({ hasText: "iPhone の記事" })).toBeVisible();
  await other.close();
});

test("起動し直すとパスキーでロックを解除して作業場所を開ける。パスキーが見つからなければ自動で繰り返さず、回復コードでロックを解除できる（ADR-0011）", async ({
  page,
}) => {
  const loginCode = await open(page);
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");

  // 起動し直すと、何よりも先にパスキーでのロック解除を求める
  await page.reload();
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");
  await expect(page.getByTestId("places")).toHaveCount(0);
  await expect(page.getByTestId("login-passkey")).toHaveClass(/primary/);
  await page.getByTestId("login-passkey").click();
  await expect(page.getByTestId("place")).toHaveAttribute("data-locked", "false");
  await page.getByTestId("place-open").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");

  // ロックすると、またロック解除の画面に戻る
  await menu(page, "app-lock");
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");

  // パスキーが見つからない（別の端末など）：自動で繰り返さず、回復コードでロックを解除できる
  await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
  let asked = 0;
  cdp.on("WebAuthn.credentialAsserted", () => asked++);
  await page.getByTestId("login-passkey").click();
  await expect(page.getByTestId("login-error")).toContainText("回復コード");
  await expect(page.getByTestId("login-passkey")).not.toHaveClass(/primary/);
  await expect(page.getByTestId("login-passkey")).toBeEnabled();
  await page.waitForTimeout(500);
  expect(asked).toBe(0);
  await page.getByTestId("unlock-secret").fill(loginCode);
  await page.getByTestId("unlock-run").click();
  await expect(page.getByTestId("place")).toHaveAttribute("data-locked", "false");
});

test("保存領域（OPFS）を開けないときは、理由とやり直しを示し、押しても反応しない作成欄を出さない", async ({ page }) => {
  // 起動時の 3 回の試行はすべて失敗させ、「もう一度試す」で開けるようにする
  await page.addInitScript(() => {
    const st = navigator.storage;
    const real = st.getDirectory.bind(st);
    let n = 0;
    st.getDirectory = () => {
      n++;
      if (n <= 3)
        return Promise.reject(new DOMException("The operation failed for an unknown transient reason", "UnknownError"));
      return real();
    };
  });
  await open(page);
  const err = page.getByTestId("storage-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("UnknownError");
  await expect(page.getByTestId("place-create")).toHaveCount(0);
  await page.getByTestId("storage-retry").click();
  await expect(page.getByTestId("storage-error")).toHaveCount(0);
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");
});

test("保存領域を消さないよう求めると、ブラウザが許可したかどうかを示す（38.4）", async ({ page }) => {
  // ブラウザが永続化を許可しない場合を固定する（headless Chromium の判断に左右されないように）
  await page.addInitScript(() => {
    const st = navigator.storage;
    Object.defineProperty(st, "persisted", { configurable: true, value: () => Promise.resolve(false) });
    Object.defineProperty(st, "persist", { configurable: true, value: () => Promise.resolve(false) });
  });
  await open(page);
  await expect(page.getByTestId("persist-answer")).toHaveText("");
  await page.getByTestId("persist-ask").click();
  await expect(page.getByTestId("persist-answer")).toContainText("ブラウザは許可しませんでした");
  await expect(page.getByTestId("persist-ask")).toBeEnabled();
});

/** 作業場所を作り、記事を 1 件保存する */
async function createArticle(page: Page, title: string): Promise<void> {
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");
  await page.getByRole("button", { name: "新規作成" }).click();
  await page.getByLabel("タイトル", { exact: true }).fill(title);
  await page.getByLabel("slug", { exact: true }).fill("himitsu");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
}

/** 無操作のまま 16 分たつ（既定の自動ロックは 15 分）。ロック解除の画面に戻る */
async function idleUntilLocked(page: Page): Promise<void> {
  await page.clock.fastForward("16:00");
  await expect(page.getByTestId("login")).toHaveAttribute("data-phase", "login");
}

test("復旧ドラフトの窓と確認を開いたまま自動ロックがかかっても、ロック解除の画面に復号した内容を残さない（39.3）", async ({
  page,
}) => {
  // 無操作の時間を進めるために、時計を差し替える（時間はそのまま流れ、fastForward で先へ進める）
  await page.clock.install();
  await open(page);
  await createArticle(page, "ひみつの記事");
  // 未保存の編集を退避してから読み込み直すと、復旧ドラフトの候補になる
  await page.getByLabel("タイトル", { exact: true }).fill("ひみつの下書き");
  await expect(page.getByTestId("draft-status")).toContainText("復旧退避済み", { timeout: 10_000 });
  await page.reload();
  await loginAgain(page);
  await page.getByTestId("place-open").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");
  await menu(page, "recovery-open");
  const dialog = page.getByTestId("recovery-dialog");
  const candidate = dialog.getByTestId("draft-candidate").first();
  await expect(candidate).toBeVisible();
  const id = (await candidate.locator("strong").textContent()) ?? "";
  expect(id).toMatch(/^[0-9a-z]{7}$/);
  // 候補の削除の確認を開いたまま、席を離れる
  await candidate.getByRole("button", { name: "削除" }).click();
  await expect(page.getByRole("button", { name: "削除する" })).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(2);

  await idleUntilLocked(page);
  // ロック解除の画面の上に、窓・候補・記事の ID（読み上げ用の文を含む）を残さない
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByTestId("draft-candidate")).toHaveCount(0);
  await expect(page.getByTestId("announcer")).toHaveText("");
  await expect(page.locator("#app")).not.toContainText(id);

  // 確認は取り消しただけで、ドラフトは消していない。ロックを解除して開き直すと、また候補に出る
  await loginAgain(page);
  await page.getByTestId("place-open").click();
  await menu(page, "recovery-open");
  await expect(candidate).toContainText(id);
  await expect(candidate.getByRole("button", { name: "原文を退避" })).toBeVisible();
});

test("コミットの窓を開いたまま自動ロックがかかっても、ロック解除の画面に題名を残さない。ロックを解除すると、またコミットできる（39.3）", async ({
  page,
}) => {
  await page.clock.install();
  await open(page);
  await createArticle(page, "ひみつの記事");
  await menu(page, "nav-changes");
  await page.getByTestId("git-init").click();
  await page.getByRole("button", { name: "初期化する", exact: true }).click();
  await expect(page.getByTestId("git-notice")).toContainText("初期化しました");
  await menu(page, "nav-editor");
  await page.getByTestId("commit-button").click();
  await page.getByRole("button", { name: "理解して続ける" }).click();
  const commit = page.getByTestId("commit-dialog");
  await expect(commit).toBeVisible();
  await expect(commit).toContainText("ひみつの記事");

  await idleUntilLocked(page);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#app")).not.toContainText("ひみつの記事");

  // コミットは取り消しただけで、処理中のまま残さない。ロックを解除すると、またコミットできる
  await loginAgain(page);
  await page.getByTestId("place-open").click();
  await page.getByRole("button", { name: /ひみつの記事/ }).click();
  await page.getByTestId("commit-button").click();
  await page.getByRole("button", { name: "理解して続ける" }).click();
  await expect(commit).toContainText("ひみつの記事");
  await page.getByTestId("commit-name").fill("山田 太郎");
  await page.getByTestId("commit-email").fill("taro@example.com");
  await page.getByTestId("commit-confirm").click();
  await expect(page.getByTestId("git-notice-strip")).toContainText("コミットしました");
});
