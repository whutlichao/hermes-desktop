import fs from "node:fs";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createTestSandbox } from "../helpers/sandbox";

test.describe("Packaged macOS .app smoke", () => {
  test("launches packaged Hermes Desktop.app without official Desktop, passes hardening, and renders same-source AppInfo", async () => {
    const appPath = process.env.HERMES_PACKAGED_APP_PATH;
    if (!appPath) {
      throw new Error("HERMES_PACKAGED_APP_PATH must be set");
    }
    const executablePath = path.join(appPath, "Contents", "MacOS", "Hermes Desktop");
    expect(fs.existsSync(executablePath)).toBe(true);

    const sandbox = createTestSandbox("hermes-packaged-smoke-");
    let passed = false;

    const electronApp = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        // Simulate a clean host without official Hermes CLI or official Desktop in PATH
        PATH: "/usr/bin:/bin",
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      const windowHardening = await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const prefs = win.webContents.getLastWebPreferences() as Record<string, unknown>;
        return {
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          nodeIntegration: prefs.nodeIntegration,
          webSecurity: prefs.webSecurity,
        };
      });

      expect(windowHardening).toEqual({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      });

      // Verify packaged AppInfo & absence of Node/mock globals via window.hermesHost
      const helloRes = await page.evaluate(async () => {
        const w = window as unknown as Record<string, unknown>;
        const host = w.hermesHost as {
          request: (cmd: string, payload?: Record<string, unknown>) => Promise<unknown>;
        };
        const hello = await host.request("bridge.hello", {});
        return {
          hasRequire: typeof w.require !== "undefined",
          hasProcess: typeof w.process !== "undefined",
          hasMockGlobal: typeof w.__HERMES_MOCK_HOST__ !== "undefined",
          hello,
        };
      });

      expect(helloRes.hasRequire).toBe(false);
      expect(helloRes.hasProcess).toBe(false);
      expect(helloRes.hasMockGlobal).toBe(false);
      expect(helloRes.hello).toMatchObject({
        ok: true,
        value: {
          appName: "Hermes Desktop",
          buildMode: "packaged",
          distribution: "local-unsigned",
          mode: "electron",
        },
      });

      // Open Settings via button and verify About & Updates copy
      await page.getByRole("button", { name: "管理连接" }).click();
      const settingsDialog = page.getByRole("dialog", { name: "Settings" });
      await expect(settingsDialog).toBeVisible();
      await expect(settingsDialog).toContainText("Hermes Desktop 0.1.0 (");
      await expect(settingsDialog).toContainText("本地开发构建 · ");
      await expect(settingsDialog).toContainText("Electron ");
      await expect(settingsDialog).toContainText("本地开发构建，不检查更新");
      await expect(settingsDialog.getByRole("button", { name: /检查更新|Update/i })).toHaveCount(0);

      passed = true;
    } finally {
      await electronApp.close();
      sandbox.cleanup(passed);
    }
  });
});
