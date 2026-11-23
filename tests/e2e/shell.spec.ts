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

    // Add Remote connection with token (Save disabled until Test passes, cleared after save, only Main only shown)
    await settings.getByRole("button", { name: "添加连接" }).click();
    await settings.getByLabel("设备名称").fill("Prod VPS");
    await settings.getByLabel("Gateway 地址").fill("https://vps.example.com/");
    await settings.getByLabel("静态 Token（仅写入 Main）").fill("secret-token-should-not-echo");
    await expect(settings.getByRole("button", { name: "保存连接" })).toBeDisabled();
    await settings.getByRole("button", { name: "测试连接" }).click();
    await expect(settings.getByText("HTTP 与 WebSocket 双端测试通过，可以保存此 Remote 连接。")).toBeVisible();
    await expect(settings.getByRole("button", { name: "保存连接" })).toBeEnabled();
    await settings.getByRole("button", { name: "保存连接" }).click();

    const prodRow = settings.locator('[data-connection-id="prod-vps"]');
    await expect(prodRow).toBeVisible();
    await expect(prodRow).toContainText("https://vps.example.com");
    await expect(prodRow).toContainText("Main 已保存凭据（Main only）");
    await expect(settings).not.toContainText("secret-token-should-not-echo");

    // Reopen edit -> plaintext token is NEVER pre-filled, only Main only hint shown
    await prodRow.getByRole("button", { name: "编辑 / 改名" }).click();
    await expect(settings.getByLabel("静态 Token（仅写入 Main）")).toHaveValue("");
    await expect(settings).toContainText("Main 已保存凭据（Main only）");
    await settings.getByRole("button", { name: "放弃编辑" }).click();

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
    await settings.getByLabel("静态 Token（仅写入 Main）").fill("mirror-tok");
    await settings.getByRole("button", { name: "测试连接" }).click();
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

  test("Remote wizard verifies two-leg test failure/invalidation, OAuth waiting/cancel/grant, and token_sync_failed re-auth", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: "打开 Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();

    // 1. Two-leg WS failure preserves draft & keeps Save disabled; editing endpoint invalidates Test pass state
    await settings.getByRole("button", { name: "添加连接" }).click();
    await settings.getByLabel("设备名称").fill("WS Broken VPS");
    await settings.getByLabel("Gateway 地址").fill("https://ws-fail.example.com");
    await settings.getByLabel("静态 Token（仅写入 Main）").fill("draft-tok-keep");
    await settings.getByRole("button", { name: "测试连接" }).click();

    const failAlert = settings.getByRole("alert");
    await expect(failAlert).toContainText("HTTP 探测");
    await expect(failAlert).toContainText("通过");
    await expect(failAlert).toContainText("WebSocket 握手");
    await expect(failAlert).toContainText("失败");
    await expect(settings.getByRole("button", { name: "保存连接" })).toBeDisabled();
    await expect(settings.getByLabel("设备名称")).toHaveValue("WS Broken VPS");
    await expect(settings.getByLabel("Gateway 地址")).toHaveValue("https://ws-fail.example.com");

    await settings.getByLabel("Gateway 地址").fill("https://vps-ready.example.com");
    await settings.getByRole("button", { name: "测试连接" }).click();
    await expect(settings.getByRole("button", { name: "保存连接" })).toBeEnabled();

    // Editing URL invalidates passed test state -> Save disables again
    await settings.getByLabel("Gateway 地址").fill("https://vps-ready-2.example.com");
    await expect(settings.getByRole("button", { name: "保存连接" })).toBeDisabled();

    // 2. OAuth waiting + cancel makes 0 registry writes and preserves draft
    await settings.getByLabel("认证方式").selectOption("oauth");
    await settings.getByLabel("设备名称").fill("OAuth Wait VPS");
    await settings.getByLabel("Gateway 地址").fill("https://oauth-wait.example.com");
    await settings.getByRole("button", { name: "通过浏览器授权" }).click();
    await expect(settings.getByText("正在等待浏览器完成 OAuth 授权")).toBeVisible();
    await settings.getByRole("button", { name: "取消授权" }).click();
    await expect(settings.getByText("已取消 OAuth 授权")).toBeVisible();
    await expect(settings.locator(".gateway-row")).toHaveCount(1);
    await expect(settings.getByLabel("设备名称")).toHaveValue("OAuth Wait VPS");

    // 3. OAuth grant -> Test -> Save with token_sync_failed warning -> Re-authorize clears warning
    await settings.getByLabel("设备名称").fill("Sync Fail Remote");
    await settings.getByLabel("Gateway 地址").fill("https://sync-fail.example.com");
    await settings.getByRole("button", { name: "通过浏览器授权" }).click();
    await expect(settings.getByText("浏览器 OAuth 授权已完成")).toBeVisible();
    await settings.getByRole("button", { name: "测试连接" }).click();
    await expect(settings.getByRole("button", { name: "保存连接" })).toBeEnabled();
    await settings.getByRole("button", { name: "保存连接" }).click();

    const syncRow = settings.locator('[data-connection-id="sync-fail-remote"]');
    await expect(syncRow).toBeVisible();
    await expect(syncRow).toContainText("需重新授权");
    await expect(syncRow).toContainText("OAuth Token 同步失败");

    await syncRow.getByRole("button", { name: "重新授权" }).click();
    await expect(syncRow.getByText("需重新授权")).toHaveCount(0);
    await expect(syncRow).toContainText("Main 已保存凭据（Main only）");
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
