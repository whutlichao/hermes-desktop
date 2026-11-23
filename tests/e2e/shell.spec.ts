import { expect, test } from "@playwright/test";

const FORBIDDEN_PROTOTYPE_TEXT = ["Homelab", "SIMULATED DATA", "Bot Mode", "Memory Graph", "Kanban"];

test.describe("E2E-SHELL-01 & E2E-KB-01 Quiet Relay shell", () => {
  test("E2E-SHELL-01: 1440x900 shows 232px rail, 720px column, route strip, and real empty state without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const rail = page.locator("nav.sidebar");
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox?.width).toBe(232);

    const column = page.locator(".thread-column");
    await expect(column).toBeVisible();
    const columnBox = await column.boundingBox();
    expect(columnBox?.width).toBeLessThanOrEqual(720);
    expect(columnBox?.width).toBeGreaterThan(680);

    const routeStrip = page.locator(".route-strip");
    await expect(routeStrip).toBeVisible();
    await expect(routeStrip).toContainText("未连接 Gateway");

    await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    for (const forbidden of FORBIDDEN_PROTOTYPE_TEXT) {
      expect(bodyText).not.toContain(forbidden);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test("E2E-SHELL-01: 1280x800 collapses rail into Sessions popover without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    await expect(page.locator("nav.sidebar")).toBeHidden();
    const trigger = page.getByRole("button", { name: /Sessions\s+0/ });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Sessions" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("尚无可用 Session");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test("E2E-KB-01: skip link jumps to composer with visible focus ring, Esc closes topmost only, and reduced motion applies", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Skip link on first Tab
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "跳到对话输入" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");

    const composer = page.locator("#composer-input");
    await expect(composer).toBeFocused();

    // Verify visible focus ring on focused button
    const paletteBtn = page.getByRole("button", { name: "打开命令面板" });
    await paletteBtn.focus();
    const ring = await paletteBtn.evaluate((el) => {
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(ring.outlineStyle).not.toBe("none");
    expect(ring.outlineWidth).toBe("2px");

    // Open Command Palette via shortcut (Meta+K / Control+K)
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "命令面板" });
    await expect(palette).toBeVisible();

    // Open Shortcuts from Command Palette or shortcut so two surfaces are stacked
    await page.keyboard.press("Control+Shift+/");
    const shortcuts = page.getByRole("dialog", { name: "键盘快捷键" });
    await expect(shortcuts).toBeVisible();

    // Esc closes ONLY topmost (shortcuts), leaving palette open
    await page.keyboard.press("Escape");
    await expect(shortcuts).toBeHidden();
    await expect(palette).toBeVisible();

    // Second Esc closes palette
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // Toggle Workspace via shortcut
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();

    // Reduced motion media check
    await page.emulateMedia({ reducedMotion: "reduce" });
    const transitionDuration = await page
      .locator(".button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.001);
  });

  test("E2E-KB-01 & E2E-FAKE-01: Local first-run blocked card exposes reachable repair actions and zero fake buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const localCard = page.locator("section.local-repair-card");
    await expect(localCard).toBeVisible();
    await expect(localCard).toContainText("This device");
    await expect(localCard).toContainText("连接受阻");
    await expect(localCard).toContainText("发生了什么");
    await expect(localCard).toContainText("可能原因");
    await expect(localCard).toContainText("下一步");

    // E2E-KB-01: repair actions and Remote/SSH escape hatch are keyboard reachable
    const chooseBtn = localCard.getByRole("button", { name: "选择本机 CLI" });
    const docsBtn = localCard.getByRole("button", { name: "查看安装文档" });
    const retryBtn = localCard.getByRole("button", { name: "重新检测" });
    const escapeBtn = localCard.getByRole("button", { name: "改连 Remote / SSH" });

    await expect(chooseBtn).toBeVisible();
    await expect(docsBtn).toBeVisible();
    await expect(retryBtn).toBeVisible();
    await expect(escapeBtn).toBeVisible();

    await chooseBtn.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="status"]')).toContainText("已取消选择 CLI");

    await retryBtn.focus();
    await page.keyboard.press("Enter");

    await escapeBtn.focus();
    await page.keyboard.press("Enter");
    const escapeDialog = page.getByRole("dialog", { name: "改连 Remote / SSH" });
    await expect(escapeDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(escapeDialog).toBeHidden();
    await expect(escapeBtn).toBeFocused();

    // E2E-FAKE-01: zero fake runtime install, fake health, or fake chat buttons
    const bodyText = await page.locator("body").innerText();
    for (const forbidden of [
      "自动安装 Python",
      "下载 Python",
      "一键安装",
      "连接成功",
      "启动模拟 Gateway",
      "/Users/",
    ]) {
      expect(bodyText).not.toContain(forbidden);
    }
    await expect(page.locator("#composer-input")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });

  test("Settings -> Gateways supports Local row, rename, Remote/SSH add, Primary/launchMode/NEXT LAUNCH, duplicate conflict preserving draft, and zero fake Test/Update buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();

    await page.keyboard.press("Control+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();

    // Zero fake Test / Update buttons
    await expect(settings.getByRole("button", { name: /Test|测试|Update|检查更新/ })).toHaveCount(0);

    // Local row is present, has NEXT LAUNCH, and has no Remove button
    const localRow = settings.locator('[data-connection-id="local"]');
    await expect(localRow).toBeVisible();
    await expect(localRow).toContainText("This device");
    await expect(localRow).toContainText("NEXT LAUNCH");
    await expect(localRow.getByRole("button", { name: "移除连接" })).toHaveCount(0);

    // Rename Local
    await localRow.getByRole("button", { name: "编辑 / 改名" }).click();
    await settings.getByLabel("设备名称").fill("MacBook Studio");
    await settings.getByRole("button", { name: "保存连接" }).click();
    await expect(localRow).toContainText("MacBook Studio");

    // Add Remote connection with token (cleared after save, only hasToken shown)
    await settings.getByRole("button", { name: "添加连接" }).click();
    await settings.getByLabel("设备名称").fill("Prod VPS");
    await settings.getByLabel("Gateway 地址").fill("https://vps.example.com/");
    await settings.getByLabel("静态 Token（仅写入 Main）").fill("secret-token-should-not-echo");
    await settings.getByRole("button", { name: "保存连接" }).click();

    const prodRow = settings.locator('[data-connection-id="prod-vps"]');
    await expect(prodRow).toBeVisible();
    await expect(prodRow).toContainText("https://vps.example.com");
    await expect(prodRow).toContainText("Main 已保存凭据（Main only）");
    await expect(settings).not.toContainText("secret-token-should-not-echo");

    // Set Primary to Prod VPS and verify NEXT LAUNCH moves immediately
    await prodRow.getByRole("button", { name: "设为 Primary" }).click();
    await expect(prodRow).toContainText("Primary");
    await expect(prodRow).toContainText("NEXT LAUNCH");

    // Mark Local as last-used and switch launchMode to last-used -> NEXT LAUNCH moves to Local
    await localRow.getByRole("button", { name: "标记为上次使用" }).click();
    await settings.getByRole("button", { name: /优先启动上次使用/ }).click();
    await expect(localRow).toContainText("NEXT LAUNCH");

    // Duplicate identity preserves draft and shows display-safe conflict summary
    await settings.getByRole("button", { name: "添加连接" }).click();
    await settings.getByLabel("设备名称").fill("Prod Mirror");
    await settings.getByLabel("Gateway 地址").fill("HTTPS://VPS.EXAMPLE.COM");
    await settings.getByRole("button", { name: "保存连接" }).click();

    const conflictAlert = settings.getByRole("alert");
    await expect(conflictAlert).toBeVisible();
    await expect(conflictAlert).toContainText("Prod VPS");
    await expect(conflictAlert).toContainText("Main 已保存凭据（Main only）");
    await expect(settings.getByLabel("设备名称")).toHaveValue("Prod Mirror");
    await expect(settings.getByLabel("Gateway 地址")).toHaveValue("HTTPS://VPS.EXAMPLE.COM");

    // Remove Prod VPS cleanly
    await settings.getByRole("button", { name: "保留既有连接" }).click();
    await prodRow.getByRole("button", { name: "移除连接" }).click();
    await expect(prodRow).toHaveCount(0);
    await expect(localRow).toContainText("NEXT LAUNCH");
  });

  test("Settings modal displays same-source About info and Updates notice with zero fake update buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: "打开 Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings).toContainText("Hermes Desktop 0.1.0 (dev+");
    await expect(settings).toContainText("本地开发构建 · arm64");
    await expect(settings).toContainText("Electron ");
    await expect(settings).toContainText("本地开发构建，不检查更新");
    await expect(settings.getByRole("button", { name: /检查更新|Update/i })).toHaveCount(0);
  });

  test("Scope popover renders honest empty state and supports Esc dismissal", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const scopeBtn = page.locator(".route-strip").getByRole("button", { name: "未连接" });
    await scopeBtn.click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await expect(scopeDialog).toBeVisible();
    await expect(scopeDialog).toContainText("当前无可用 Connection 或 Profile。");

    await page.keyboard.press("Escape");
    await expect(scopeDialog).toBeHidden();
    await expect(scopeBtn).toBeFocused();
  });
});

test.describe("Ticket #31 Session rail, recovery, route banner, and transcript resync", () => {
  test("1440 session rail & 1280 Sessions popover support search, keyboard nav, aria-current, mouse focus retention, New Chat, and Session Details", async ({
    page,
  }) => {
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
              sessionId: "sess-1",
              title: "Alpha Plan",
              preview: "roadmap notes",
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
              sessionId: "sess-2",
              title: "Beta Review",
              preview: "pr feedback",
              updatedAt: "2026-11-23T06:01:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-3",
              title: "Gamma Fix",
              preview: "bug trace",
              updatedAt: "2026-11-23T06:02:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-1" },
          activeSessionId: "sess-1",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-1" },
          lastSessionByScope: { "local::default": "sess-1" },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [{ connectionId: "local", profileId: "default" }],
          sessionSummaries: {},
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-1": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            messages: [
              {
                messageId: "m-1",
                sessionId: "sess-1",
                role: "assistant",
                text: "Alpha transcript ready",
                createdAt: "2026-11-23T06:00:00.000Z",
              },
            ],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: false,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const sidebar = page.locator("nav.sidebar");
    const alphaBtn = sidebar.getByRole("button", { name: /Alpha Plan/ });
    const betaBtn = sidebar.getByRole("button", { name: /Beta Review/ });
    const gammaBtn = sidebar.getByRole("button", { name: /Gamma Fix/ });

    await expect(alphaBtn).toHaveAttribute("aria-current", "page");

    // Session Details skeleton shows served capabilities and safe scope without refused actions
    const details = sidebar.locator(".session-details-card");
    await expect(details).toContainText("local / default / sess-1");
    await expect(details).toContainText("prompt.submit");
    await expect(details).toContainText("session.resume");
    await expect(details).not.toContainText("session.steer");

    // Mouse click retains focus on the clicked session row
    await betaBtn.click();
    await expect(betaBtn).toHaveAttribute("aria-current", "page");
    await expect(betaBtn).toBeFocused();

    // Keyboard navigation (ArrowDown / Home / End / Enter)
    await page.keyboard.press("ArrowDown");
    await expect(gammaBtn).toBeFocused();
    await page.keyboard.press("Home");
    await expect(alphaBtn).toBeFocused();
    await page.keyboard.press("End");
    await expect(gammaBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(gammaBtn).toHaveAttribute("aria-current", "page");

    // Search filter
    const searchInput = sidebar.getByPlaceholder("搜索 Session...");
    await searchInput.fill("Beta");
    await expect(betaBtn).toBeVisible();
    await expect(alphaBtn).toHaveCount(0);
    await searchInput.fill("nonexistent");
    await expect(sidebar).toContainText("没有匹配的 Session。");
    await searchInput.fill("");

    // 1280x800 Sessions popover (~378x456) with search, New Chat (Cmd+N), and Session Details
    await page.setViewportSize({ width: 1280, height: 800 });
    const popTrigger = page.getByRole("button", { name: /Sessions\s+3/ });
    await popTrigger.click();
    const popDialog = page.getByRole("dialog", { name: "Sessions" });
    await expect(popDialog).toBeVisible();
    const popBox = await popDialog.boundingBox();
    expect(popBox?.width).toBeGreaterThanOrEqual(360);
    expect(popBox?.width).toBeLessThanOrEqual(400);
    expect(popBox?.height).toBeGreaterThanOrEqual(420);

    await expect(popDialog.getByPlaceholder("搜索 Session...")).toBeVisible();
    await expect(popDialog.locator(".session-details-card")).toContainText("local / default / sess-3");

    await popDialog.getByRole("button", { name: /新建 Session/ }).click();
    await expect(popDialog).toBeHidden();
    await expect(page.getByRole("button", { name: /Sessions\s+4/ })).toBeVisible();
  });

  test("startup route fallback banner dismisses without stealing focus, and non-ready keeps unverified indicator", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "vps",
              kind: "remote",
              label: "Prod VPS",
              targetDisplay: "https://vps.example.com",
              actual: "ready",
              activeProfileId: "prod",
            },
          ],
          profiles: [
            {
              connectionId: "vps",
              profileId: "prod",
              displayName: "Prod",
              handle: "prod",
              isDefault: true,
              availability: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "vps",
              profileId: "prod",
              sessionId: "sess-prod-1",
              title: "Prod Chat",
              updatedAt: "2026-11-23T06:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "vps", profileId: "prod", sessionId: "sess-prod-1" },
          activeSessionId: "sess-prod-1",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "vps", profileId: "prod", sessionId: "sess-prod-1" },
          lastSessionByScope: { "vps::prod": "sess-prod-1" },
          lastValidProfileByConnection: { vps: "prod" },
          lastValidScopes: [{ connectionId: "vps", profileId: "prod" }],
          sessionSummaries: {},
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: {
            id: "rb-1",
            fromScope: { connectionId: "local", profileId: "work" },
            toScope: { connectionId: "vps", profileId: "prod" },
            reason: "profile_removed",
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const banner = page.locator(".route-fallback-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("local / work → vps / prod");
    await expect(banner).toContainText("原 Profile 已不可用");

    // Banner must never steal focus away from composer when user focuses composer
    const composer = page.locator("#composer-input");
    await composer.focus();
    await expect(composer).toBeFocused();

    await banner.getByRole("button", { name: "关闭回退提示" }).click();
    await expect(banner).toHaveCount(0);

    // Verify non-ready connection keeps lastKnownUnverified badge and summary
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "vps",
              kind: "remote",
              label: "Prod VPS",
              targetDisplay: "https://vps.example.com",
              actual: "reconnecting",
              activeProfileId: "prod",
            },
          ],
          profiles: [],
          sessions: [],
          activeScope: { connectionId: "vps", profileId: "prod", sessionId: "sess-prod-1" },
          activeSessionId: "sess-prod-1",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "vps", profileId: "prod", sessionId: "sess-prod-1" },
          lastSessionByScope: { "vps::prod": "sess-prod-1" },
          lastValidProfileByConnection: { vps: "prod" },
          lastValidScopes: [{ connectionId: "vps", profileId: "prod" }],
          sessionSummaries: {
            "vps::prod::sess-prod-1": {
              connectionId: "vps",
              profileId: "prod",
              sessionId: "sess-prod-1",
              title: "Saved Unverified Thread",
              hasDraft: false,
            },
          },
          activeStatus: "unverified",
          lastKnownUnverified: true,
          missingSession: null,
          routeBanner: null,
        },
      };
    });
    await page.goto("/");
    await expect(page.locator(".route-strip")).toContainText("上次已知 · 待校验");
    await expect(page.locator(".unverified-card")).toContainText("Saved Unverified Thread");
  });

  test("session_missing renders read-only recovery card with draft, exports JSON without auto session.create, and gap triggers clean resync", async ({
    page,
  }) => {
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
              sessionId: "sess-sync",
              title: "Sync Session",
              updatedAt: "2026-11-23T06:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default" },
          activeSessionId: null,
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-gone" },
          lastSessionByScope: { "local::default": "sess-gone" },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [{ connectionId: "local", profileId: "default" }],
          sessionSummaries: {},
          activeStatus: "session_missing",
          lastKnownUnverified: false,
          missingSession: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-gone",
            title: "Gone Session",
            hasDraft: true,
            draftText: "Keep this unsent draft!",
            lastKnownMessages: [],
          },
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-sync": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-sync",
            messages: [
              {
                messageId: "m1",
                sessionId: "sess-sync",
                role: "assistant",
                text: "Initial snap",
                createdAt: "2026-11-23T06:00:00.000Z",
              },
            ],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: false,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        resyncedTranscripts: {
          "local::default::sess-sync": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-sync",
            messages: [
              {
                messageId: "m1",
                sessionId: "sess-sync",
                role: "assistant",
                text: "Clean Resynced Transcript",
                createdAt: "2026-11-23T06:00:00.000Z",
              },
            ],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: false,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        transcriptEventsOnSubscribe: {
          "sess-sync": [
            {
              topic: "session.transcript",
              scope: { connectionId: "local", profileId: "default", sessionId: "sess-sync" },
              kind: "patch",
              seq: 0,
              revision: 2,
              payload: {
                type: "token_delta",
                sessionId: "sess-sync",
                messageId: "m1",
                delta: "DUPE_SHOULD_IGNORE",
              },
            },
            {
              topic: "session.transcript",
              scope: { connectionId: "local", profileId: "default", sessionId: "sess-sync" },
              kind: "patch",
              seq: 1,
              revision: 3,
              payload: {
                type: "token_delta",
                sessionId: "sess-sync",
                messageId: "m1",
                delta: " + contiguous",
              },
            },
            {
              topic: "session.transcript",
              scope: { connectionId: "local", profileId: "default", sessionId: "sess-sync" },
              kind: "patch",
              seq: 5,
              revision: 4,
              payload: {
                type: "token_delta",
                sessionId: "sess-sync",
                messageId: "m1",
                delta: " + TORN_GAP",
              },
            },
          ],
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const missingCard = page.locator(".session-missing-card");
    await expect(missingCard).toBeVisible();
    await expect(missingCard).toContainText("Keep this unsent draft!");
    await expect(page.locator("form.composer-shell")).toHaveCount(0);

    // Zero automatic session.create calls
    const countsBefore = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: { sessionsCreateCalls: number } }).__HERMES_E2E_COUNTS__,
    );
    expect(countsBefore.sessionsCreateCalls).toBe(0);

    // Export missing session backup JSON
    await missingCard.getByRole("button", { name: "导出 Session 备份" }).click();
    await expect(missingCard).toContainText("已导出 Session 备份 JSON");
    await expect(missingCard.locator("pre.diagnostics-json")).toContainText("Keep this unsent draft!");

    // Dismiss switches cleanly to sess-sync and triggers gap -> resync replacement
    await missingCard.getByRole("button", { name: "关闭并切换可用 Session" }).click();
    await expect(missingCard).toHaveCount(0);

    await expect(page.locator(".resync-notice")).toContainText("已重新同步");
    const thread = page.locator(".transcript-list");
    await expect(thread).toContainText("Clean Resynced Transcript");
    await expect(thread).not.toContainText("DUPE_SHOULD_IGNORE");
    await expect(thread).not.toContainText("TORN_GAP");

    const countsAfter = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: { sessionsCreateCalls: number; sessionsResumeCalls: number };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(countsAfter.sessionsCreateCalls).toBe(0);
    expect(countsAfter.sessionsResumeCalls).toBeGreaterThanOrEqual(1);
  });
});
