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

    // Settings
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await checkAxe("settings modal");
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
  });
});
