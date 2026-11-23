import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  projects: [
    {
      name: "e2e",
      testDir: "./tests/e2e",
      testMatch: /shell\.spec\.ts/,
      use: {
        browserName: "chromium",
        baseURL: "http://127.0.0.1:4173",
      },
    },
    {
      name: "a11y",
      testDir: "./tests/e2e",
      testMatch: /a11y\.spec\.ts/,
      use: {
        browserName: "chromium",
        baseURL: "http://127.0.0.1:4173",
      },
    },
  ],
  webServer: {
    command: "pnpm --filter @hermes/desktop dev:web",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
