import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("E2E-A11Y-01 Quiet Relay accessibility baseline", () => {
  test("passes axe-core serious/critical = 0 on shell, palette, settings, capabilities, workspace, and 1280 popover", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Landmarks & live region
    await expect(page.locator("header.window-titlebar")).toBeVisible();
    await expect(page.locator("nav.sidebar")).toBeVisible();
    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.locator("footer.status-footer")).toBeVisible();
    await expect(page.locator('[aria-live="polite"]')).toBeAttached();

    const checkAxe = async (label: string) => {
      const results = await new AxeBuilder({ page }).analyze();
      const severe = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(severe, `axe serious/critical violations on ${label}`).toEqual([]);
    };

    await checkAxe("1440 empty shell");

    // Command Palette
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
    await checkAxe("command palette");
    await page.keyboard.press("Escape");

    // Settings & Gateways form
    await page.keyboard.press("Control+,");
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();
    await checkAxe("settings modal");
    await settingsDialog.getByRole("button", { name: "添加连接" }).click();
    await checkAxe("settings gateways add form");
    await settingsDialog.getByLabel("Gateway 地址").fill("https://ws-fail.example.com");
    await settingsDialog.getByRole("button", { name: "测试连接" }).click();
    await checkAxe("settings remote wizard test failure card");

    await settingsDialog.getByLabel("连接类型").selectOption("ssh");
    await checkAxe("settings gateways ssh wizard form");
    await settingsDialog.getByLabel("设备名称").fill("A11y SSH");
    await settingsDialog.getByLabel("SSH 主机").fill("unknown-host.example.com");
    await settingsDialog.getByRole("button", { name: "测试连接" }).click();
    await expect(settingsDialog).toContainText("SHA256:");
    await checkAxe("settings gateways ssh host key prompt");
    await page.keyboard.press("Escape");

    // Capabilities drawer
    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    await expect(page.getByRole("dialog", { name: "能力目录" })).toBeVisible();
    await checkAxe("capabilities drawer");
    await page.keyboard.press("Escape");

    // Workspace drawer
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
    await checkAxe("workspace drawer");
    await page.keyboard.press("Control+b");

    // 1280x800 Sessions popover
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /Sessions\s+0/ }).click();
    await expect(page.getByRole("dialog", { name: "Sessions" })).toBeVisible();
    await checkAxe("1280 sessions popover");
    await page.keyboard.press("Escape");

    // Local Remote/SSH escape hatch modal
    await page.getByRole("button", { name: "改连 Remote / SSH" }).click();
    await expect(page.getByRole("dialog", { name: "改连 Remote / SSH" })).toBeVisible();
    await checkAxe("remote escape modal");
  });

  test("passes axe-core serious/critical = 0 on populated session rail, route banner, 1280 popover, and session_missing recovery card", async ({
    page,
  }) => {
    const checkAxe = async (label: string) => {
      const results = await new AxeBuilder({ page }).analyze();
      const severe = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(severe, `axe serious/critical violations on ${label}`).toEqual([]);
    };

    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "This device",
              targetDisplay: "local-control-socket",
              actual: "ready",
              activeProfileId: "default",
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              availability: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a",
              title: "Session A",
              preview: "First",
              updatedAt: "2026-11-23T06:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-b",
              title: "Session B",
              preview: "Second",
              updatedAt: "2026-11-23T06:01:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-a" },
          activeSessionId: "sess-a",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-a" },
          lastSessionByScope: { "local::default": "sess-a" },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [{ connectionId: "local", profileId: "default" }],
          sessionSummaries: {},
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: {
            id: "rb-a11y",
            fromScope: { connectionId: "vps", profileId: "prod" },
            toScope: { connectionId: "local", profileId: "default" },
            reason: "connection_removed",
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator(".route-fallback-banner")).toBeVisible();
    await checkAxe("populated 1440 rail + route banner");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /Sessions\s+2/ }).click();
    await expect(page.getByRole("dialog", { name: "Sessions" })).toBeVisible();
    await checkAxe("populated 1280 sessions popover");
    await page.keyboard.press("Escape");

    // session_missing recovery card a11y
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "This device",
              targetDisplay: "local-control-socket",
              actual: "ready",
              activeProfileId: "default",
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              availability: "ready",
            },
          ],
          sessions: [],
          activeScope: { connectionId: "local", profileId: "default" },
          activeSessionId: null,
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-missing" },
          lastSessionByScope: { "local::default": "sess-missing" },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [{ connectionId: "local", profileId: "default" }],
          sessionSummaries: {},
          activeStatus: "session_missing",
          lastKnownUnverified: false,
          missingSession: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-missing",
            title: "Missing Session",
            hasDraft: true,
            draftText: "Important unsent prompt",
            lastKnownMessages: [],
          },
          routeBanner: null,
        },
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator(".session-missing-card")).toBeVisible();
    await checkAxe("session_missing read-only recovery card");
  });
});
