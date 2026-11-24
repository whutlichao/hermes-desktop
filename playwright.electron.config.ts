import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  testDir: "./tests/electron",
  testMatch: process.env.HERMES_PACKAGED_APP_PATH ? /packaged\.spec\.ts/ : /smoke\.spec\.ts/,
});
