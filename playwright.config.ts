import { defineConfig, devices } from "@playwright/test";

/**
 * E2E は dist/kotono-cms.html を file:// で直接開いて検証する（仕様 2.1・26.1 A01）。
 * 事前に `pnpm build` が必要。
 * 既にインストール済みの Chromium を使う場合は PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH を指定する。
 */
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"];

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? "github" : "list",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
});
