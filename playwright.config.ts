import { defineConfig, devices } from "@playwright/test";

/**
 * E2E は dist を localhost から配信して検証する（tests/e2e/static-server.mjs）。
 * ロックはパスキーで解除し、file:// ではパスキーを使えないため（ADR-0012）。file:// の案内は file-launch.spec.ts で確かめる。
 * 事前に `pnpm build` が必要。
 * 既にインストール済みの Chromium を使う場合は PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH を指定する。
 */
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"];
const port = Number(process.env["E2E_PORT"] ?? 4319);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? "github" : "list",
  webServer: {
    command: "node tests/e2e/static-server.mjs",
    url: `http://localhost:${port}/kotono-cms.html`,
    reuseExistingServer: !process.env["CI"],
    env: { E2E_PORT: String(port) },
  },
  use: { baseURL: `http://localhost:${port}` },
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
