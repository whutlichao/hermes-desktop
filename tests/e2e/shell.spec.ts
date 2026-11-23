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
});
