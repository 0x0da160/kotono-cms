/**
 * iPhone 17 の Safari を主な対象にした画面（ADR-0015）。
 *
 * 画面の幅 402px・高さ 874px（iPhone 17 の論理ピクセル）、指で操作する画面（pointer: coarse）で確かめる。
 * - 押せる部品の大きさ（44px）・入力欄の文字（16px 以上）・横スクロールが出ないこと
 * - 編集：下部の操作バー、「本文」「記事情報」のタブ、「その他」にまとめた操作
 * - 書式の帯を画面の下に付け、キーボードが出ている間はその上に載せること
 * - 確認ダイアログを下から出すシートにすること、安全領域の余白
 *
 * Chromium での確認であり、iOS の Safari の実機の代替ではない。画面キーボードと安全領域は実際には出ないため、
 * アプリが使う CSS の値（--keyboard-inset・--safe-*）を直接入れて配置だけを確かめる
 * （キーボードの高さの計算は tests/unit/viewport.test.ts）。
 */
import { expect, test, type Page } from "@playwright/test";
import { menu, registerLogin } from "./login";

const W = 402;
const H = 874;
test.use({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true });

/** 作業場所を作って開く */
async function open(page: Page): Promise<void> {
  await page.goto("/kotono-cms.html?storage=workspace");
  await registerLogin(page);
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");
}

/** 新しい記事を作って保存する（狭い画面では「記事情報」から始まる） */
async function createArticle(page: Page, title: string, slug: string): Promise<void> {
  await page.getByRole("button", { name: "新規作成" }).click();
  await page.getByLabel("タイトル", { exact: true }).fill(title);
  await page.getByLabel("slug", { exact: true }).fill(slug);
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
}

/**
 * 見えている押せる部品のうち、44px に満たないもの。
 * 文の中の小さな部品（.touch-inline）は、見た目 32px 以上で、押せる範囲（::after）が 44px 以上なら良い。
 * チェックボックス・ラジオはラベルの行で押す。文の中のリンクは対象外（WCAG 2.5.8 の例外）。
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 20);
    for (const el of document.querySelectorAll<HTMLElement>(
      "button, select, textarea, summary, [role=tab], input:not([type=hidden], [type=checkbox], [type=radio], [type=file])",
    )) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      // 見えないもの（閉じたメニュー・自動入力用の隠した欄）は数えない
      if (r.width < 4 || r.height < 4 || st.visibility === "hidden") continue;
      if (el.classList.contains("touch-inline")) {
        const hit = getComputedStyle(el, "::after");
        const grow = -parseFloat(hit.top || "0") * 2;
        if (r.width < 32 || r.height < 32 || r.width + grow < 44 || r.height + grow < 44)
          out.push(`${Math.round(r.width)}x${Math.round(r.height)}（押せる範囲 +${grow}） ${name(el)}`);
        continue;
      }
      if (r.height < 43.5 || r.width < 43.5) out.push(`${Math.round(r.width)}x${Math.round(r.height)} ${name(el)}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>("input[type=checkbox], input[type=radio]")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const row = el.closest("label")?.getBoundingClientRect();
      if (!row || row.height < 43.5)
        out.push(`ラベルの行 ${Math.round(row?.height ?? 0)} ${name(el.closest("label") ?? el)}`);
    }
    return out;
  });
}

/** 入力欄の文字が 16px に満たないもの（iOS の Safari はフォーカスのたびに画面を拡大する） */
async function smallInputs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("input, select, textarea, [contenteditable=true]")]
      .filter((el) => el.getBoundingClientRect().width > 4)
      .filter((el) => !el.matches("[type=checkbox], [type=radio], [type=file]"))
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${getComputedStyle(el).fontSize} ${el.getAttribute("aria-label") ?? el.id ?? el.tagName}`),
  );
}

async function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
}

async function expectTouchReady(page: Page, where: string): Promise<void> {
  expect(await smallTargets(page), `${where}：44px に満たない部品`).toEqual([]);
  expect(await smallInputs(page), `${where}：16px に満たない入力欄`).toEqual([]);
  expect(await overflowX(page), `${where}：横スクロール`).toBe(0);
}

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} が見えません`);
  return b;
};

test("画面の端まで使う指定（viewport-fit=cover）と、ブラウザの枠の色を持つ", async ({ page }) => {
  await page.goto("/kotono-cms.html?storage=workspace");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  // 拡大を止めない
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute("content", /user-scalable|maximum-scale/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
});

test("どの画面でも、押せる部品は 44px 以上・入力欄の文字は 16px 以上で、横スクロールが出ない", async ({ page }) => {
  await page.goto("/kotono-cms.html?storage=workspace");
  await expect(page.getByTestId("login")).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await expectTouchReady(page, "ロック解除（登録）");
  await page.getByTestId("menu-toggle").click();
  await expectTouchReady(page, "メニュー（ロック解除の前）");
  await page.keyboard.press("Escape");

  await registerLogin(page);
  await expect(page.getByTestId("places")).toBeVisible();
  await expectTouchReady(page, "作業場所の一覧（空）");
  await page.getByTestId("place-name").fill("ブログ");
  await page.getByTestId("place-create-run").click();
  await expect(page.getByTestId("folder-name")).toHaveText("作業場所：ブログ");
  await expectTouchReady(page, "記事一覧（空）");

  await createArticle(page, "長いタイトルの記事：スマートフォンの狭い画面でどう折り返すかを確かめる", "long-title");
  await expectTouchReady(page, "編集（記事情報）");
  await page.getByTestId("tab-body").click();
  await expectTouchReady(page, "編集（本文・見たまま）");
  await page.getByTestId("visual-editor").click();
  await expect(page.getByTestId("fmt-bar")).toBeVisible();
  await page.getByTestId("fmt-more").click();
  await expectTouchReady(page, "編集（書式の帯）");
  await page.getByTestId("body-view-markdown").click();
  await expectTouchReady(page, "編集（本文・Markdown）");
  await page.getByRole("tab", { name: "原文" }).click();
  await expectTouchReady(page, "編集（原文）");
  await page.getByTestId("tab-preview").click();
  await expectTouchReady(page, "編集（プレビュー）");
  await page.getByTestId("more-actions").click();
  await expectTouchReady(page, "編集（その他）");
  await page.getByTestId("more-actions").click();

  await page.getByTestId("menu-toggle").click();
  await expectTouchReady(page, "メニュー");
  await page.getByTestId("nav-list").click();
  await page.getByTestId("list-conditions").locator("summary").click();
  await expectTouchReady(page, "記事一覧（絞り込み）");

  await menu(page, "nav-changes");
  await expectTouchReady(page, "Git と同期");
  await menu(page, "nav-settings");
  await expectTouchReady(page, "設定");
  await menu(page, "help-open");
  await expectTouchReady(page, "ヘルプ");
  await page.keyboard.press("Escape");
  await menu(page, "env-open");
  await page.getByTestId("env-details").click();
  await expectTouchReady(page, "対応環境の確認");
  await page.keyboard.press("Escape");

  await menu(page, "place-leave");
  await expect(page.getByTestId("place")).toBeVisible();
  await page.getByTestId("place-more").click();
  await expectTouchReady(page, "作業場所の一覧");
  // 「…」の中身が画面の外へはみ出さない
  const more = await box(page, "place-more-list");
  expect(more.x).toBeGreaterThanOrEqual(0);
  expect(more.x + more.width).toBeLessThanOrEqual(W);
});

test("作業場所の「…」は、「開く」がない行（開けない作業場所）でも右端に置き、一覧を画面の中に開く", async ({
  page,
}) => {
  await open(page);
  await menu(page, "place-leave");
  await expect(page.getByTestId("place")).toBeVisible();
  // 開けない作業場所の行は「開く」がなく、「…」だけが行の左に並ぶ。その形を作って確かめる
  await page.getByTestId("place-open").evaluate((el) => {
    (el as HTMLElement).style.display = "none";
  });
  await page.getByTestId("place-more").click();
  const toggle = await box(page, "place-more");
  expect(toggle.x).toBeGreaterThan(W / 2);
  const more = await box(page, "place-more-list");
  expect(more.x).toBeGreaterThanOrEqual(0);
  expect(more.x + more.width).toBeLessThanOrEqual(W);
  await expect(page.getByTestId("place-remove")).toBeVisible();
});

test("編集は「本文」「記事情報」をタブで分け、記事の操作を画面の下のバーに置く", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "新規作成" }).click();
  // 新しい記事は、タイトルと slug を入れる「記事情報」から始まる
  await expect(page.getByTestId("tab-meta")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("タイトル", { exact: true })).toBeVisible();
  await expect(page.getByTestId("visual-editor")).toBeHidden();
  // 広い画面の「フォーム」のタブは出さない
  await expect(page.getByRole("tab", { name: "フォーム" })).toHaveCount(0);

  // 操作バーは画面の下に固定し、幅いっぱいに取る。「保存」を広く取る
  const bar = page.getByRole("toolbar", { name: "記事の操作" });
  const b = await bar.boundingBox();
  expect(b && Math.round(b.y + b.height)).toBe(H);
  expect(b?.width).toBe(W);
  const save = await box(page, "save-button");
  expect(save.width).toBeGreaterThan(W / 2);
  // 「元に戻す」「やり直す」「その他」はアイコンだけにするが、名前は読み上げに残す
  await expect(bar.getByRole("button", { name: "元に戻す" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "やり直す" })).toBeVisible();
  await expect(page.getByTestId("more-actions")).toHaveText("原文の退避・その他");

  await page.getByLabel("タイトル", { exact: true }).fill("iPhone の記事");
  await page.getByLabel("slug", { exact: true }).fill("iphone");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-status")).toHaveText("保存済み");
  // 通知は上部バーの下に出し、メニューの開閉と操作バーに重ならない
  const toast = await box(page, "notice");
  const top = await box(page, "app-bar");
  expect(toast.y).toBeGreaterThanOrEqual(top.y + top.height);
  expect(toast.y + toast.height).toBeLessThan(save.y);

  // 「本文」へ切り替えると、記事情報を隠して本文だけを出す。入れた内容は残る
  await page.getByTestId("tab-body").click();
  await expect(page.getByTestId("tab-body")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("visual-editor")).toBeVisible();
  await expect(page.getByLabel("タイトル", { exact: true })).toBeHidden();
  await page.getByTestId("tab-meta").click();
  await expect(page.getByLabel("タイトル", { exact: true })).toHaveValue("iPhone の記事");

  // 複製・削除・閉じるは「その他」にまとめ、操作バーの上へ開く
  await expect(page.getByTestId("delete-button")).toBeHidden();
  await page.getByTestId("more-actions").click();
  await expect(page.getByTestId("duplicate-button")).toBeVisible();
  await expect(page.getByTestId("delete-button")).toBeVisible();
  const del = await box(page, "delete-button");
  expect(del.y + del.height).toBeLessThanOrEqual(save.y);
  expect(del.x + del.width).toBeLessThanOrEqual(W);

  // 削除の確認は、画面の下から出るシート。ボタンは幅いっぱいに縦へ積む
  await page.getByTestId("delete-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const d = await dialog.boundingBox();
  expect(d?.width).toBe(W);
  expect(d && Math.round(d.y + d.height)).toBe(H);
  const buttons = await dialog.getByRole("button").all();
  expect(buttons.length).toBeGreaterThan(1);
  for (const x of buttons) expect((await x.boundingBox())?.width).toBeGreaterThan(W * 0.8);
  await page.keyboard.press("Escape");

  // 「記事を閉じる」で一覧に戻る
  await page.getByTestId("more-actions").click();
  await page.getByRole("button", { name: "記事を閉じる" }).click();
  await expect(page.getByTestId("article-row").filter({ hasText: "iPhone の記事" })).toBeVisible();
  // 既存の記事は「本文」から始まる
  await page.getByTestId("article-row").first().click();
  await expect(page.getByTestId("tab-body")).toHaveAttribute("aria-selected", "true");
});

test("書式の帯は画面の下に付き、キーボードが出ている間は操作バーごとその上に載る", async ({ page }) => {
  await open(page);
  await createArticle(page, "書式の記事", "format");
  await page.getByTestId("tab-body").click();
  await page.getByTestId("visual-editor").click();
  await page.keyboard.type("太字にする文");

  // カーソルの近くではなく、操作バーのすぐ上に、幅いっぱいで出す
  const fmt = page.getByTestId("fmt-bar");
  await expect(fmt).toBeVisible();
  await expect(fmt).toHaveClass(/docked/);
  const bar = page.getByRole("toolbar", { name: "記事の操作" });
  const edge = async () => {
    const f = await fmt.boundingBox();
    const t = await bar.boundingBox();
    if (!f || !t) throw new Error("帯が見えません");
    return { fmtBottom: Math.round(f.y + f.height), barTop: Math.round(t.y), barBottom: Math.round(t.y + t.height), f };
  };
  let e = await edge();
  expect(e.f.width).toBe(W);
  expect(e.fmtBottom).toBe(e.barTop);
  expect(e.barBottom).toBe(H);

  // 画面キーボードが 336px 覆ったとき（viewport.ts が html に書く値を入れる）：操作バーと書式の帯がその上に載る
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--keyboard-inset", "336px");
    document.documentElement.setAttribute("data-keyboard", "open");
  });
  await expect.poll(async () => (await edge()).barBottom).toBe(H - 336);
  e = await edge();
  expect(e.fmtBottom).toBe(e.barTop);
  // 通常の文字入力の場所が残る（上部バー・タブの下から書式の帯まで）
  expect(e.f.y).toBeGreaterThan(300);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--keyboard-inset", "0px");
    document.documentElement.removeAttribute("data-keyboard");
  });

  // 帯のボタンで書式を付けられる（本文のフォーカスと選択範囲を失わない）
  await page.keyboard.press("ControlOrMeta+A");
  await page.getByTestId("fmt-bold").click();
  await page.getByTestId("body-view-markdown").click();
  await expect(page.getByTestId("body-editor")).toHaveValue(/\*\*太字にする文\*\*/);
});

test("安全領域（ノッチ・ホームインジケーター）の分だけ、上部バーと操作バーの余白を広げる", async ({ page }) => {
  await open(page);
  await createArticle(page, "安全領域の記事", "safe-area");
  const bar = page.getByRole("toolbar", { name: "記事の操作" });
  const before = { top: await box(page, "app-bar"), bottom: await bar.boundingBox() };
  // ホーム画面から開いた iPhone 17 の安全領域（上 62px・下 34px）を入れる
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "62px");
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });
  await expect.poll(async () => (await box(page, "app-bar")).height).toBe(before.top.height + 62);
  const after = await bar.boundingBox();
  expect(after?.height).toBe((before.bottom?.height ?? 0) + 34);
  expect(after && Math.round(after.y + after.height)).toBe(H);
  // メニューの開閉は、ステータスバーの下（安全領域の中）にある
  const toggle = await box(page, "menu-toggle");
  expect(toggle.y).toBeGreaterThanOrEqual(62);
});
