import { defineConfig } from "@playwright/test";

const webPort = Number(process.env.HERMES_WEB_PORT || 4173);
const baseURL = `http://127.0.0.1:${webPort}`;

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
        baseURL,
      },
    },
    {
      name: "a11y",
      testDir: "./tests/e2e",
      testMatch: /a11y\.spec\.ts/,
      use: {
        browserName: "chromium",
        baseURL,
      },
    },
  ],
  webServer: {
    command: "pnpm --filter @hermes/desktop dev:web",
    url: baseURL,
    reuseExistingServer: !process.env.CI && !process.env.HERMES_WEB_PORT,
    timeout: 30_000,
  },
});
