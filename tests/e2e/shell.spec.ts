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

  test("⌘K Command Palette uses WAI-ARIA combobox/listbox keyboard navigation sourced from CapabilityRegistry with zero deferred entries", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Wait for initial capabilities hydration and React keydown listener mount
    await expect(page.getByRole("button", { name: /能力 17 可达 4 延期/ })).toBeVisible();
    await page.getByRole("button", { name: "命令面板 ⌘K" }).focus();

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "命令面板" });
    await expect(palette).toBeVisible();
    await expect(palette).toContainText("能力 17 可达 4 延期");

    const combobox = palette.getByRole("combobox");
    await expect(combobox).toBeVisible();
    await expect(combobox).toBeFocused();
    const listbox = palette.getByRole("listbox");
    await expect(listbox).toBeVisible();

    const options = listbox.getByRole("option");
    const count = await options.count();
    expect(count).toBeGreaterThan(5);

    // Every option must carry a data-testid and never represent a deferred domain
    const optionDomains = await options.evaluateAll((els) =>
      els.map((el) => ({
        domain: el.getAttribute("data-domain"),
        testId: el.getAttribute("data-testid"),
      })),
    );
    for (const opt of optionDomains) {
      expect(opt.testId).toBeTruthy();
      expect(["voice", "bots", "memory_graph", "kanban"]).not.toContain(opt.domain);
    }

    // Keyboard ArrowDown / End / Home / ArrowUp updates aria-activedescendant cleanly
    const firstId = await combobox.getAttribute("aria-activedescendant");
    expect(firstId).toBeTruthy();
    await page.keyboard.press("ArrowDown");
    const secondId = await combobox.getAttribute("aria-activedescendant");
    expect(secondId).not.toBe(firstId);
    await page.keyboard.press("End");
    const lastId = await combobox.getAttribute("aria-activedescendant");
    expect(lastId).toBeTruthy();
    await page.keyboard.press("Home");
    expect(await combobox.getAttribute("aria-activedescendant")).toBe(firstId);

    // Filter to capabilities.open and press Enter to open Capabilities drawer
    await combobox.fill("查看能力目录");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByRole("dialog", { name: "能力目录" })).toBeVisible();
  });

  test("E2E-FAKE-01: Capabilities drawer sizes to 448px@1440 / 408px@1280, groups Core 5 / Admin 8 / Exec 4, and exposes zero deferred buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const drawer = page.getByRole("dialog", { name: "能力目录" });
    await expect(drawer).toBeVisible();

    const box1440 = await drawer.boundingBox();
    expect(box1440?.width).toBe(448);

    await expect(drawer.getByTestId("capabilities-counts-summary")).toContainText("能力 17 可达 4 延期");
    await expect(drawer.getByTestId("cap-group-core")).toContainText("核心 5");
    await expect(drawer.getByTestId("cap-group-admin")).toContainText("管理 8");
    await expect(drawer.getByTestId("cap-group-exec")).toContainText("执行 4");

    expect(await drawer.locator('[data-testid="cap-group-core"] .cap-domain-card').count()).toBe(5);
    expect(await drawer.locator('[data-testid="cap-group-admin"] .cap-domain-card').count()).toBe(8);
    expect(await drawer.locator('[data-testid="cap-group-exec"] .cap-domain-card').count()).toBe(4);

    // Bottom disclosure footnote ONLY; zero buttons/tabs/switches for deferred domains
    const footnote = drawer.getByTestId("capabilities-deferred-footnote");
    await expect(footnote).toBeVisible();
    await expect(footnote).toContainText("Voice");
    await expect(footnote.getByRole("button")).toHaveCount(0);
    await expect(drawer.locator('[data-domain="voice"], [data-domain="bots"], [data-domain="memory_graph"], [data-domain="kanban"]')).toHaveCount(0);

    // Resize to 1280x800 -> drawer adapts to 408px without horizontal overflow
    await page.setViewportSize({ width: 1280, height: 800 });
    const box1280 = await drawer.boundingBox();
    expect(box1280?.width).toBe(408);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });
});
