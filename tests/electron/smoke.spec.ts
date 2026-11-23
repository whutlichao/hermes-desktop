import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createTestSandbox } from "../helpers/sandbox";

test.describe("Electron hardened smoke", () => {
  test("launches real BrowserWindow with sandbox, contextIsolation, frozen window.hermesHost, no Node globals, and real empty state", async () => {
    const sandbox = createTestSandbox("hermes-electron-smoke-");
    let passed = false;

    const electronApp = await electron.launch({
      args: [path.resolve(process.cwd(), "apps/desktop/out/main/index.js")],
      env: {
        ...process.env,
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      // Verify BrowserWindow webPreferences from Main process
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

      // Verify Renderer has no Node exposure and only frozen window.hermesHost
      const bridgeFacts = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const host = w.hermesHost as Record<string, unknown> | undefined;
        return {
          hasRequire: typeof w.require !== "undefined",
          hasProcess: typeof w.process !== "undefined",
          hasBuffer: typeof w.Buffer !== "undefined",
          hasMockGlobal: typeof w.__HERMES_MOCK_HOST__ !== "undefined",
          hostExists: Boolean(host),
          hostFrozen: host ? Object.isFrozen(host) : false,
          hostVersion: host ? host.version : null,
        };
      });

      expect(bridgeFacts).toEqual({
        hasRequire: false,
        hasProcess: false,
        hasBuffer: false,
        hasMockGlobal: false,
        hostExists: true,
        hostFrozen: true,
        hostVersion: 1,
      });

      // Verify native menu accelerators in Main
      const menuAccelerators = await electronApp.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        if (!menu) return [];
        const list: string[] = [];
        const walk = (items: Electron.MenuItem[]) => {
          for (const item of items) {
            if (item.accelerator) list.push(item.accelerator);
            if (item.submenu) walk(item.submenu.items);
          }
        };
        walk(menu.items);
        return list;
      });
      for (const acc of [
        "CmdOrCtrl+K",
        "CmdOrCtrl+,",
        "CmdOrCtrl+B",
        "CmdOrCtrl+N",
        "CmdOrCtrl+W",
        "CmdOrCtrl+Q",
        "CmdOrCtrl+Shift+/",
      ]) {
        expect(menuAccelerators).toContain(acc);
      }

      // Verify real empty state and Electron host mode label
      await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();
      await expect(page.locator("footer.status-footer")).toContainText("Electron 宿主模式");
      await expect(page.locator("body")).not.toContainText("Homelab");
      await expect(page.locator("body")).not.toContainText("SIMULATED DATA");

      // Verify same-source AppInfo across bridge.hello, diagnostics.export, and Settings -> About/Updates
      const diagnosticsCheck = await page.evaluate(async () => {
        const w = window as unknown as {
          hermesHost: {
            request: (cmd: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; value: unknown }>;
          };
        };
        const hello = await w.hermesHost.request("bridge.hello", {});
        const diag = await w.hermesHost.request("diagnostics.export", {});
        return { hello, diag };
      });
      expect(diagnosticsCheck.hello.ok).toBe(true);
      expect(diagnosticsCheck.diag.ok).toBe(true);

      const helloInfo = diagnosticsCheck.hello.value as {
        appVersion: string;
        gitSha: string;
        buildMode: string;
        distribution: string;
        arch: string;
      };
      const diagPayload = diagnosticsCheck.diag.value as {
        appInfo: typeof helloInfo;
        display: { headline: string; buildLine: string; runtimeLine: string; updatesNotice: string };
      };
      expect(diagPayload.appInfo).toEqual(helloInfo);
      expect(helloInfo.buildMode).toBe("dev");
      expect(helloInfo.distribution).toBe("local-unsigned");
      expect(JSON.stringify(diagPayload)).not.toContain(process.cwd());

      await page.getByRole("button", { name: "打开 Settings" }).click();
      const settingsDialog = page.getByRole("dialog", { name: "Settings" });
      await expect(settingsDialog).toBeVisible();
      await expect(settingsDialog).toContainText(diagPayload.display.headline);
      await expect(settingsDialog).toContainText(diagPayload.display.buildLine);
      await expect(settingsDialog).toContainText(diagPayload.display.runtimeLine);
      await expect(settingsDialog).toContainText("本地开发构建，不检查更新");
      await expect(settingsDialog.getByRole("button", { name: /检查更新|Update/i })).toHaveCount(0);

      passed = true;
    } finally {
      await electronApp.close();
      sandbox.cleanup(passed);
    }
  });
});
