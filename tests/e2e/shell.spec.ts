import { expect, test, type Locator, type Page } from "@playwright/test";

const FORBIDDEN_PROTOTYPE_TEXT = ["Homelab", "SIMULATED DATA", "Bot Mode", "Memory Graph", "Kanban"];

async function readActiveFocusAudit(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || active === document.documentElement) {
      return {
        found: false,
        tag: active?.tagName ?? "none",
        label: "",
        inViewport: false,
        notObscured: false,
        hitTag: "",
      };
    }
    const rect = active.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const label =
      active.getAttribute("aria-label") ??
      active.getAttribute("data-testid") ??
      active.textContent?.trim().slice(0, 80) ??
      "";
    return {
      found: true,
      tag: active.tagName,
      label,
      inViewport:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= -1 &&
        rect.left >= -1 &&
        rect.bottom <= window.innerHeight + 1 &&
        rect.right <= window.innerWidth + 1,
      notObscured: Boolean(
        hit && (hit === active || active.contains(hit) || hit.contains(active)),
      ),
      hitTag: hit?.tagName ?? "none",
    };
  });
}

async function expectFocusAudit(page: Page, label: string) {
  const audit = await readActiveFocusAudit(page);
  expect(audit.found, `${label}: focus must land on a real element`).toBe(true);
  expect(audit.inViewport, `${label}: focused ${audit.tag} "${audit.label}" must be fully visible`).toBe(
    true,
  );
  expect(
    audit.notObscured,
    `${label}: focused ${audit.tag} "${audit.label}" is covered by ${audit.hitTag}`,
  ).toBe(true);
}

async function expectFocusableTargetsAudit(
  page: Page,
  root: Locator,
  label: string,
  limit = 12,
) {
  const targets = root.locator(
    'button:not([disabled]):visible, a[href]:visible, input:not([type="hidden"]):not([disabled]):visible, select:not([disabled]):visible, textarea:not([disabled]):visible',
  );
  const count = Math.min(await targets.count(), limit);
  expect(count, `${label}: expected at least one focusable target`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    await target.focus();
    await expect(target).toBeFocused();
    await expectFocusAudit(page, `${label} control ${index + 1}`);
  }
}

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

    // Wait for initial React render before sending the first keyboard Tab
    const skipLink = page.getByRole("link", { name: "跳到对话输入" });
    await expect(skipLink).toBeAttached();
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");

    const composer = page.locator("#composer-input");
    await expect(composer).toBeFocused();

    // Verify visible focus ring on focused button
    const paletteBtn = page.getByRole("button", { name: /命令面板/ });
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

  test("E2E-KB-01 & E2E-FAKE-01: Onboarding empty state exposes at most three reachable actions and zero fake buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const onboarding = page.locator("section.onboarding-empty-card");
    await expect(onboarding).toBeVisible();
    await expect(onboarding.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();
    await expect(onboarding).toContainText("发生了什么");
    await expect(onboarding).toContainText("可能原因");
    await expect(onboarding).toContainText("下一步");
    await expect(onboarding).toContainText("Cron");

    // E2E-KB-01: onboarding is limited to three actions and all are keyboard reachable
    const onboardingActions = onboarding.locator(".empty-relay-actions button");
    await expect(onboardingActions).toHaveCount(3);
    const repairBtn = onboarding.getByRole("button", { name: "修复 Local" });
    const remoteBtn = onboarding.getByRole("button", { name: "添加 Remote" });
    const sshBtn = onboarding.getByRole("button", { name: "添加 SSH" });
    await expect(repairBtn).toBeVisible();
    await expect(remoteBtn).toBeVisible();
    await expect(sshBtn).toBeVisible();

    await repairBtn.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="status"]')).toContainText("已取消选择 CLI");

    // Adding a Remote goes through Settings and returns focus on Esc
    await remoteBtn.focus();
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.getByLabel("Gateway 地址")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(remoteBtn).toBeFocused();

    // Adding an SSH connection goes through Settings with the SSH form preselected
    await sshBtn.focus();
    await page.keyboard.press("Enter");
    await expect(settings).toBeVisible();
    await expect(settings.getByLabel("SSH 主机")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(sshBtn).toBeFocused();

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

    await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();
    await page.keyboard.press("Control+,");
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

    await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();
    await page.keyboard.press("Control+,");
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

  test("E2E-KB-02: ⌘K Command Palette uses WAI-ARIA combobox/listbox keyboard navigation sourced from CapabilityRegistry with zero deferred entries and ignores IME composition", async ({
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

    // IME composition must not move the active option or execute on Enter
    await combobox.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
    });
    expect(await combobox.getAttribute("aria-activedescendant")).toBe(firstId);
    await expect(palette).toBeVisible();

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
    await expect(footnote).toContainText("4 延期 · 无 v1 入口");
    await expect(footnote).toContainText("Voice");
    await expect(footnote).toContainText("TTS 与 wake word");
    await expect(footnote).toContainText("官方 CLI/Desktop 的 Voice");
    await expect(footnote).toContainText("Bot Mode");
    await expect(footnote).toContainText("账号绑定、群聊与投递");
    await expect(footnote).toContainText("Routines 使用 Cron");
    await expect(footnote).toContainText("Memory Graph");
    await expect(footnote).toContainText("learning 与 insights");
    await expect(footnote).toContainText("只读 Memory 上下文");
    await expect(footnote).toContainText("Kanban");
    await expect(footnote).toContainText("稳定 Gateway method");
    await expect(footnote).toContainText("Workspace 管理产物");
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

test.describe("Ticket #31 Session rail, recovery, route banner, and transcript resync", () => {
  test("E2E-KB-03: 1440 session rail & 1280 Sessions popover support search, keyboard nav, IME composition, aria-current, mouse focus retention, New Chat, and Session Details", async ({
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

    // IME composition must not be intercepted by Home/End/Arrow navigation
    await betaBtn.focus();
    await sidebar.locator("ul.session-list").evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          isComposing: true,
          bubbles: true,
        }),
      );
    });
    await expect(betaBtn).toBeFocused();

    // Search filter
    const searchInput = sidebar.getByPlaceholder("搜索 Session……");
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

    await expect(popDialog.getByPlaceholder("搜索 Session……")).toBeVisible();
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

  test("E2E-SSH-01: SSH wizard enforces Test before Save, host key confirmation/hard-block, legacy attach-only, draft retention, and remote chat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();
    await page.keyboard.press("Control+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();

    await settings.getByRole("button", { name: "添加连接" }).click();
    await settings.getByLabel("连接类型").selectOption("ssh");

    // Save MUST be disabled for SSH until Test passes
    const saveBtn = settings.getByRole("button", { name: "保存连接" });
    await expect(saveBtn).toBeDisabled();
    await expect(settings).toContainText("请先通过连接测试后再保存 SSH Connection");

    // 1. Changed host key -> hard-blocked (no confirm button, no legacy bypass, draft preserved)
    await settings.getByLabel("设备名称").fill("GPU Node");
    await settings.getByLabel("SSH 主机").fill("changed-host.example.com");
    await settings.getByLabel("SSH 用户名").fill("ops");
    await settings.getByLabel("SSH 端口（默认 22）").fill("2222");
    await settings.getByLabel("远端 Profile（可选）").fill("train");
    await settings.getByLabel("私钥 Passphrase（仅驻留 Main 内存，不落盘）").fill("e2e-pass-secret");

    await settings.getByRole("button", { name: "测试连接" }).click();
    await expect(settings).toContainText("已记录的 SSH 主机密钥发生变更");
    await expect(settings.getByRole("button", { name: "确认并信任主机密钥" })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "改用 legacy attach-only" })).toHaveCount(0);
    await expect(saveBtn).toBeDisabled();
    await expect(settings.getByLabel("设备名称")).toHaveValue("GPU Node");
    await expect(settings.getByLabel("SSH 用户名")).toHaveValue("ops");
    await expect(settings.getByLabel("SSH 端口（默认 22）")).toHaveValue("2222");
    await expect(settings.getByLabel("远端 Profile（可选）")).toHaveValue("train");

    // 2. Protocol unsupported -> legacy_attach recovery action + attach-only badge
    await settings.getByLabel("SSH 主机").fill("fail-host.example.com");
    await settings.getByRole("button", { name: "测试连接" }).click();
    const legacyBtn = settings.getByRole("button", { name: "改用 legacy attach-only" });
    await expect(legacyBtn).toBeVisible();
    await legacyBtn.click();
    await expect(settings).toContainText("旧版 attach-only 模式");
    await expect(saveBtn).toBeEnabled();

    // 3. Unknown host key -> manual fingerprint confirm -> Test passes -> Save
    await settings.getByLabel("SSH 主机").fill("unknown-host.example.com");
    await expect(saveBtn).toBeDisabled();
    await settings.getByRole("button", { name: "测试连接" }).click();
    await expect(settings).toContainText("尚未在系统 known_hosts 中信任");
    await expect(settings).toContainText("SHA256:");
    await expect(saveBtn).toBeDisabled();

    // Verify Test did NOT write registry prematurely
    await expect(settings.locator('[data-connection-id="gpu-node"]')).toHaveCount(0);

    await settings.getByRole("button", { name: "确认并信任主机密钥" }).click();
    await expect(settings).toContainText("tickets --serve + 本地端口转发");
    await expect(saveBtn).toBeEnabled();

    await saveBtn.click();
    const gpuRow = settings.locator('[data-connection-id="gpu-node"]');
    await expect(gpuRow).toBeVisible();
    await expect(gpuRow).toContainText("ops@unknown-host.example.com:2222");
    await expect(settings).not.toContainText("e2e-pass-secret");

    await page.keyboard.press("Escape");

    // Switch Scope to SSH Gateway and verify remote sessions + chat
    const scopeBtn = page.locator(".route-strip").getByRole("button", { name: /未连接|已连接/ });
    await scopeBtn.click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await expect(scopeDialog).toContainText("GPU Node");
    await scopeDialog.getByRole("button", { name: /GPU Node/ }).click();

    await expect(page.locator(".route-strip")).toContainText("已连接");
    await expect(page.locator("nav.sidebar")).toContainText("Remote SSH");
    await page.locator("#composer-input").fill("ping remote gateway");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".transcript-list")).toContainText("ping remote gateway");
    await expect(page.locator(".transcript-list")).toContainText("Mock Gateway (gpu-node)");
  });

  test("Ticket #35: Workspace shell bindings, 448/408 overlay geometry, Artifacts/Files preview & stale, annotations version, Hide vs Close, and FocusReturnController", async ({
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
            {
              connectionId: "local",
              profileId: "research",
              displayName: "Research",
              handle: "research",
              isDefault: false,
              availability: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a",
              title: "Session Alpha",
              preview: "Alpha preview",
              updatedAt: "2026-11-23T08:00:00.000Z",
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
              title: "Session Beta",
              preview: "Beta preview",
              updatedAt: "2026-11-23T08:01:00.000Z",
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
          lastValidScopes: [
            { connectionId: "local", profileId: "default" },
            { connectionId: "local", profileId: "research" },
          ],
          sessionSummaries: {},
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: null,
        },
        artifacts: {
          "sess-a": [
            {
              artifactId: "art-spec",
              title: "Workspace Spec",
              kind: "markdown",
              content: "# Workspace Spec v1\nInitial content",
              version: 1,
              hash: "hash-spec-v1",
              updatedAt: "2026-11-23T08:00:00.000Z",
            },
          ],
          "sess-b": [
            {
              artifactId: "art-beta",
              title: "Beta Diagram",
              kind: "svg",
              content: "<svg><text>Beta SVG</text></svg>",
              version: 1,
              hash: "hash-beta-v1",
              updatedAt: "2026-11-23T08:01:00.000Z",
            },
          ],
        },
        files: {
          "local::default": [
            {
              relativePath: "src",
              name: "src",
              kind: "directory",
              parentPath: null,
            },
            {
              relativePath: "src/main.ts",
              name: "main.ts",
              kind: "file",
              parentPath: "src",
              hash: "file-hash-1",
              content: "const alpha = 1;\nconst beta = 2;\nexport { alpha, beta };",
              sizeBytes: 56,
            },
          ],
          "local::research": [
            {
              relativePath: "notes.md",
              name: "notes.md",
              kind: "file",
              parentPath: null,
              hash: "notes-hash-1",
              content: "# Research Scope Notes",
              sizeBytes: 22,
            },
          ],
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // 1. Mouse click on Session row leaves focus on that row
    const sessAlphaRow = page.locator("nav.sidebar").getByRole("button", { name: /Session Alpha/ });
    await sessAlphaRow.click();
    await expect(sessAlphaRow).toBeFocused();

    // 2. Open Workspace via trigger button -> 448px at 1440x900, overlay does not compress 720px thread column
    const workspaceBtn = page.locator(".route-strip").getByRole("button", { name: /Workspace/ });
    await workspaceBtn.focus();
    await workspaceBtn.click();

    const drawer = page.getByRole("complementary", { name: "Workspace" });
    await expect(drawer).toBeVisible();
    const drawerBox1440 = await drawer.boundingBox();
    expect(drawerBox1440?.width).toBe(448);

    const threadBox1440 = await page.locator(".thread-column").boundingBox();
    expect(threadBox1440?.width).toBe(720);

    // 1280x800 -> Workspace drawer is 408px
    await page.setViewportSize({ width: 1280, height: 800 });
    const drawerBox1280 = await drawer.boundingBox();
    expect(drawerBox1280?.width).toBe(408);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 3. Artifacts preview, zoom, and Draft annotation anchored to artifactId + version/hash + xPct/yPct + comment
    await expect(drawer).toContainText("绑定 ActiveChat");
    await expect(drawer).toContainText("Workspace Spec");
    await expect(drawer.getByTestId("workspace-artifact-preview")).toContainText(
      "# Workspace Spec v1",
    );

    await drawer.getByRole("button", { name: "放大预览" }).click();
    await expect(drawer.getByTestId("workspace-artifact-zoom")).toHaveText("125%");

    await drawer.getByLabel("标注 X 坐标（%）").fill("30");
    await drawer.getByLabel("标注 Y 坐标（%）").fill("70");
    await drawer.getByLabel("标注内容").fill("Check section header");
    await drawer.getByRole("button", { name: "添加标注到 Draft" }).click();

    const annCard = drawer.getByTestId("workspace-annotation-item").first();
    await expect(annCard).toContainText("Check section header");
    await expect(annCard).toContainText("(30%, 70%)");
    await expect(annCard).not.toContainText("基于旧版本");

    // 4. Artifact update marks existing annotation as "基于旧版本" without recalculating xPct/yPct
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      (fix.artifacts as Record<string, unknown>)["sess-a"] = [
        {
          artifactId: "art-spec",
          title: "Workspace Spec",
          kind: "markdown",
          content: "# Workspace Spec v2\nUpdated specification",
          version: 2,
          hash: "hash-spec-v2",
          updatedAt: "2026-11-23T08:05:00.000Z",
        },
      ];
    });
    await drawer.getByRole("button", { name: "刷新 Workspace" }).click();
    await expect(drawer.getByTestId("workspace-artifact-preview")).toContainText(
      "# Workspace Spec v2",
    );
    await expect(annCard).toContainText("(30%, 70%)");
    await expect(annCard).toContainText("基于旧版本");

    // 5. Switching Session swaps ActiveChat-bound Artifacts without closing drawer or switching tab
    await page.locator("nav.sidebar").getByRole("button", { name: /Session Beta/ }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Beta Diagram");
    await expect(drawer.getByTestId("workspace-artifact-preview")).toContainText("Beta SVG");
    await page.locator("nav.sidebar").getByRole("button", { name: /Session Alpha/ }).click();
    await expect(drawer).toContainText("Workspace Spec");

    // 6. Files tab: expand directory, select file, select line, hash change invalidates line selection, external stale badge
    await drawer.getByRole("tab", { name: "Files" }).click();
    await expect(drawer).toContainText("绑定 Scope");
    await drawer.getByTestId("workspace-dir-src").click();
    await drawer.getByTestId("workspace-file-src/main.ts").click();
    await expect(drawer.getByTestId("workspace-file-preview")).toContainText("const alpha = 1;");

    await drawer.getByTestId("workspace-file-line-2").click();
    await expect(drawer.getByTestId("workspace-line-selection-badge")).toContainText("L2");

    // File hash change invalidates line selection
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      (fix.files as Record<string, unknown>)["local::default"] = [
        {
          relativePath: "src",
          name: "src",
          kind: "directory",
          parentPath: null,
        },
        {
          relativePath: "src/main.ts",
          name: "main.ts",
          kind: "file",
          parentPath: "src",
          hash: "file-hash-2",
          content: "const alpha = 10;\nconst beta = 20;\nexport { alpha, beta };",
          sizeBytes: 58,
        },
      ];
      (fix.filesStale as Record<string, boolean>) = { "local::default": true };
    });
    await drawer.getByRole("button", { name: "刷新 Workspace" }).click();
    await expect(drawer.getByTestId("workspace-line-invalidated-notice")).toContainText(
      "原行选择已失效",
    );
    await expect(drawer.getByTestId("workspace-stale-badge")).toContainText("上次已知 · 外部已变更");

    // 7. Switching Scope keeps Workspace open and activeTab ("Files") while swapping Scope-keyed files
    await page.locator(".route-strip").getByRole("button", { name: /已连接/ }).click();
    const scopePopover = page.getByRole("dialog", { name: "选择 Scope" });
    await scopePopover.getByRole("button", { name: /Research/ }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(drawer.getByTestId("workspace-file-notes.md")).toBeVisible();

    // Switch back to Default profile
    await page.locator(".route-strip").getByRole("button", { name: /已连接/ }).click();
    await page.getByRole("dialog", { name: "选择 Scope" }).getByRole("button", { name: /Default/ }).click();

    // 8. Agents steer text & Hide vs Close semantics + FocusReturnController
    await drawer.getByRole("tab", { name: "Agents" }).click();
    await drawer.getByLabel("向选中 Subagent 发送补充指令").fill("Focus on unit tests");

    // Hide preserves tab, zoom, file selection, annotations, and steer text; returns focus to workspace trigger
    await drawer.getByRole("button", { name: "隐藏 Workspace" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(workspaceBtn).toBeFocused();

    // Reopen via ⌘B -> preserved state intact
    await page.keyboard.press("Control+b");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(drawer.getByLabel("向选中 Subagent 发送补充指令")).toHaveValue(
      "Focus on unit tests",
    );

    // Close resets preview/zoom/file selection/steer text, but keeps annotations in Draft!
    await page.locator("#composer-input").fill("Keep composer draft across workspace close");
    await drawer.getByRole("button", { name: "关闭 Workspace" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue(
      "Keep composer draft across workspace close",
    );

    // Reopen and verify steer & zoom were reset, while Draft annotation was preserved
    await workspaceBtn.click();
    await expect(drawer.getByLabel("向选中 Subagent 发送补充指令")).toHaveValue("");
    await drawer.getByRole("tab", { name: "Artifacts" }).click();
    await expect(drawer.getByTestId("workspace-artifact-zoom")).toHaveText("100%");
    await expect(drawer.getByTestId("workspace-annotation-item").first()).toContainText(
      "Check section header",
    );
  });

  test("Ticket #36: Scope popover Profile switching & capability-gated management, Session non-refused details & CLI deep links, Settings 9 sections & focus return", async ({
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
              originDisplay: "local-control-socket",
              actual: "ready",
              degraded: false,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
            },
            {
              connectionId: "local",
              profileId: "work",
              displayName: "Work",
              handle: "work",
              isDefault: false,
              actual: "idle",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-def-1",
              title: "Default Active Turn",
              preview: "Streaming in progress",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-running-1",
              status: "running",
            },
            {
              connectionId: "local",
              profileId: "work",
              sessionId: "sess-work-1",
              title: "Work Architecture Notes",
              preview: "Ready on work profile",
              updatedAt: "2026-11-23T08:01:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
          activeSessionId: "sess-def-1",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
          lastSessionByScope: {
            "local::default": "sess-def-1",
            "local::work": "sess-work-1",
          },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [
            { connectionId: "local", profileId: "default" },
            { connectionId: "local", profileId: "work" },
          ],
          sessionSummaries: {},
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-def-1": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-def-1",
            messages: [
              {
                messageId: "m-def-1",
                sessionId: "sess-def-1",
                role: "assistant",
                text: "Running background task...",
                createdAt: "2026-11-23T08:00:00.000Z",
                turnId: "turn-running-1",
                streaming: true,
                status: "streaming",
              },
            ],
            activeTurnId: "turn-running-1",
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: true,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
          "local::work::sess-work-1": {
            connectionId: "local",
            profileId: "work",
            sessionId: "sess-work-1",
            messages: [
              {
                messageId: "m-work-1",
                sessionId: "sess-work-1",
                role: "assistant",
                text: "Work profile transcript ready.",
                createdAt: "2026-11-23T08:01:00.000Z",
                status: "complete",
              },
            ],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: true,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        capabilities: {
          servedMethods: [
            "prompt.submit",
            "prompt.cancel",
            "session.steer",
            "session.list",
            "session.create",
            "session.resume",
            "profiles.list",
            "config.get",
            "config.update",
          ],
          refusedMethods: [
            "session.delete",
            "session.title",
            "session.branch",
            "session.archive",
            "session.compress",
            "session.undo",
          ],
        },
        config: {
          supported: true,
          readOnly: false,
          supportedKeys: ["model.default", "chat.send_on_enter"],
          values: {
            "model.default": "claude-3-7-sonnet",
            "chat.send_on_enter": true,
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // 1. Session Details: shows security info, never renders refused methods, and exposes 6 CLI deep links
    const detailsCard = page.locator(".session-details-card");
    await expect(detailsCard).toBeVisible();
    await expect(detailsCard).toContainText("安全与隔离");
    await expect(detailsCard).toContainText("审批与执行严格绑定当前 Scope");
    await expect(detailsCard).not.toContainText("session.delete");
    await expect(detailsCard).not.toContainText("session.title");
    await expect(detailsCard).not.toContainText("session.branch");
    await expect(detailsCard).not.toContainText("session.archive");
    await expect(detailsCard).not.toContainText("session.compress");
    await expect(detailsCard).not.toContainText("session.undo");
    await expect(detailsCard).toContainText("只读深链 · 不会在此客户端执行");

    for (const actionId of ["rename", "delete", "branch", "archive", "compress", "undo"]) {
      const btn = detailsCard.locator(`[data-cli-action="${actionId}"]`);
      await expect(btn).toBeVisible();
    }
    await detailsCard.locator('[data-cli-action="rename"]').click();
    await expect(page.locator('[aria-live="polite"]')).toContainText(
      "已复制 Session CLI 命令（不会在此客户端执行）",
    );

    // 2. Scope Popover: lists current Connection's Profiles, default badge, health status, and probed Profile management action
    const scopeChip = page.locator(".route-strip").getByRole("button", { name: "已连接" });
    await scopeChip.click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await expect(scopeDialog).toBeVisible();
    await expect(scopeDialog).toContainText("Default");
    await expect(scopeDialog).toContainText("default");
    await expect(scopeDialog).toContainText("已连接");
    await expect(scopeDialog).toContainText("Work");
    await expect(scopeDialog).toContainText("待激活");
    await expect(scopeDialog.getByRole("button", { name: "刷新 Profile 列表" })).toBeVisible();

    // Switch to Work profile -> updates active scope & thread without tearing down connection or stopping default's running turn
    await scopeDialog.getByRole("button", { name: /Work/ }).click();
    await expect(scopeDialog).toBeHidden();
    await expect(page.locator(".route-strip")).toContainText("Work");
    await expect(page.locator(".transcript-list")).toContainText("Work profile transcript ready.");
    await expect(detailsCard.locator('[data-cli-action="delete"]')).toHaveAttribute(
      "data-cli-command",
      "hermes session delete --profile work sess-work-1",
    );

    // Switch back to Default profile -> in-flight turn is still running (Stop button visible)
    await scopeChip.click();
    await expect(scopeDialog).toBeVisible();
    await scopeDialog.getByRole("button", { name: /Default/ }).click();
    await expect(page.locator(".route-strip")).toContainText("Default");
    await expect(page.getByRole("button", { name: "停止 Turn" })).toBeVisible();

    // 3. Settings Modal: opened from rail gear button -> Esc returns focus to rail gear button
    const railGearBtn = page.locator("#rail-settings-gear");
    await railGearBtn.focus();
    await railGearBtn.click();
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();

    for (const sectionName of [
      "Model",
      "Workspace",
      "Safety",
      "Memory & Context",
      "Chat",
      "Gateways",
      "Updates",
      "About",
      "Diagnostics",
    ]) {
      await expect(
        settingsDialog.locator(`section.settings-section[aria-label="${sectionName}"]`),
      ).toBeVisible();
    }
    // Voice / Cloud / Account / Billing must have zero entry
    await expect(settingsDialog).not.toContainText("Voice");
    await expect(settingsDialog).not.toContainText("Cloud");
    await expect(settingsDialog).not.toContainText("Billing");

    // Updates section shows only "本地开发构建，不检查更新" and has 0 buttons
    const updatesSection = settingsDialog.locator('section.settings-section[aria-label="Updates"]');
    await expect(updatesSection).toContainText("本地开发构建，不检查更新");
    await expect(updatesSection.locator("button")).toHaveCount(0);

    // AppInfo in Settings -> About and Settings -> Diagnostics match single source
    const aboutHeadline = await settingsDialog
      .locator('section.settings-section[aria-label="About"] .settings-about-headline')
      .innerText();
    const diagHeadline = await settingsDialog
      .locator('section.settings-section[aria-label="Diagnostics"] .settings-about-headline')
      .innerText();
    expect(aboutHeadline).toBe(diagHeadline);

    // Feature-detected config field update round-trip
    const modelSelect = settingsDialog.getByLabel("默认模型");
    await expect(modelSelect).toHaveValue("claude-3-7-sonnet");
    await modelSelect.selectOption("gpt-4.1");
    await expect(modelSelect).toHaveValue("gpt-4.1");
    // Unsupported key (推理强度) is hidden
    await expect(settingsDialog.getByLabel("推理强度")).toHaveCount(0);

    // Esc closes Settings and returns focus to rail gear button
    await page.keyboard.press("Escape");
    await expect(settingsDialog).toBeHidden();
    await expect(railGearBtn).toBeFocused();

    // Opening Settings via ⌘, while composer is focused returns focus to composer on Esc
    const composer = page.locator("#composer-input");
    await composer.focus();
    await page.keyboard.press("Control+,");
    await expect(settingsDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settingsDialog).toBeHidden();
    await expect(composer).toBeFocused();

    // 4. 1280x800 adaptive check: Scope popover, Settings modal, and Sessions popover CLI deep links
    await page.setViewportSize({ width: 1280, height: 800 });
    await scopeChip.click();
    await expect(scopeDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scopeDialog).toBeHidden();
    await expect(scopeChip).toBeFocused();

    const sessionsTrigger = page.getByRole("button", { name: /Sessions/ });
    await sessionsTrigger.click();
    const sessionsDialog = page.getByRole("dialog", { name: "Sessions" });
    await expect(sessionsDialog).toBeVisible();
    await expect(sessionsDialog.locator(".session-details-card")).toContainText(
      "只读深链 · 不会在此客户端执行",
    );
    await page.keyboard.press("Escape");
    await expect(sessionsDialog).toBeHidden();
  });

  test("Ticket #36: Scope popover hides Profile management when profiles.list capability is unsupported and renders CLI/docs deep links", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              displayName: "本机 Hermes",
              kind: "local",
              authorityRole: "primary",
              desired: "connected",
              actual: "ready",
              reconnectAttempt: 0,
              updatedAt: "2026-11-23T08:00:00.000Z",
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
            },
          ],
          sessions: [],
          activeScope: { connectionId: "local", profileId: "default", sessionId: null },
          activeSessionId: null,
        },
        capabilities: {
          servedMethods: [
            "prompt.submit",
            "prompt.cancel",
            "session.list",
            "session.create",
            "session.resume",
          ],
          refusedMethods: ["session.delete"],
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const scopeChip = page.locator(".route-strip").getByRole("button", { name: "已连接" });
    await scopeChip.click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await expect(scopeDialog).toBeVisible();

    // Read-only probe fails for profiles.list -> management action hidden, CLI & docs deep links visible
    await expect(scopeDialog.getByRole("button", { name: "刷新 Profile 列表" })).toHaveCount(0);
    await expect(scopeDialog).toContainText("只读探测未通过或需变更 Profile：请复制 CLI 命令或查阅官方文档（不会在此客户端执行）");
    await expect(scopeDialog).toContainText("hermes profile list");
    await expect(scopeDialog.getByRole("button", { name: "复制 Profile CLI 命令" })).toBeVisible();
    await expect(scopeDialog.getByRole("button", { name: "打开 Profile 官方文档" })).toBeVisible();

    await scopeDialog.getByRole("button", { name: "复制 Profile CLI 命令" }).click();
    await expect(page.locator('[aria-live="polite"]')).toContainText("已复制只读 CLI 命令");
  });

  test("E2E-FLEET-01: route strip and Gateway rows render health/degraded/latencyUnknown/nextRetryAt/profileException/safeError, Retry recovers, and focus_scope switches Scope", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const retryTarget = Date.now() + 8000;
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "This device",
              originDisplay: "local://control-socket",
              desired: "enabled",
              actual: "reconnecting",
              aggregateState: "reconnecting",
              degraded: true,
              latencyMs: null,
              nextRetryAt: retryTarget,
              profileExceptionCount: 1,
              message: "Gateway 连接已中断，正在等待退避重连。",
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              desired: "enabled",
              actual: "reconnecting",
              degraded: false,
              pinned: true,
              isException: false,
            },
            {
              connectionId: "local",
              profileId: "work",
              displayName: "Work",
              handle: "work",
              isDefault: false,
              desired: "enabled",
              actual: "blocked",
              degraded: true,
              pinned: false,
              isException: true,
              unavailableCode: "profile_unavailable",
              message: "该 Profile 未在当前 Gateway 启用",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-default-1",
              title: "Default Session",
              preview: "default preview",
              updatedAt: "2026-11-23T06:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "local",
              profileId: "work",
              sessionId: "sess-work-1",
              title: "Work Session",
              preview: "work preview",
              updatedAt: "2026-11-23T06:01:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-default-1" },
          activeSessionId: "sess-default-1",
        },
        transcripts: {
          "local::default::sess-default-1": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-default-1",
            messages: [
              {
                messageId: "m-def-1",
                sessionId: "sess-default-1",
                role: "assistant",
                text: "Default scope transcript",
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
          "local::work::sess-work-1": {
            connectionId: "local",
            profileId: "work",
            sessionId: "sess-work-1",
            messages: [
              {
                messageId: "m-work-1",
                sessionId: "sess-work-1",
                role: "assistant",
                text: "Work scope transcript after notification focus",
                createdAt: "2026-11-23T06:01:00.000Z",
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

    const routeStrip = page.locator(".route-strip");
    await expect(routeStrip).toContainText("正在重连");
    await expect(routeStrip).toContainText("降级");
    await expect(routeStrip).toContainText("延迟未知");
    await expect(routeStrip).toContainText("下次重试");
    await expect(routeStrip).toContainText("1 Profile 异常");
    await expect(routeStrip).toContainText("Gateway 连接已中断，正在等待退避重连。");

    // Check Settings -> Gateways row shows health, latencyUnknown, nextRetryAt, profile exception, safe error, and Retry
    await page.keyboard.press("Control+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    const localRow = settings.locator('[data-connection-id="local"]');
    await expect(localRow).toContainText("正在重连");
    await expect(localRow).toContainText("降级");
    await expect(localRow).toContainText("延迟未知");
    await expect(localRow).toContainText("下次重试");
    await expect(localRow).toContainText("1 Profile 异常");
    await expect(localRow).toContainText("Gateway 连接已中断，正在等待退避重连。");

    await page.keyboard.press("Escape");

    // Open Scope Popover to verify Profile exceptions & 已固定 badges are visible
    await routeStrip.getByRole("button", { name: /正在重连/ }).click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await expect(scopeDialog).toContainText("已固定");
    await expect(scopeDialog).toContainText("该 Profile 未在当前 Gateway 启用");
    await page.keyboard.press("Escape");

    // Click Retry in route strip -> transitions to Ready + shows latency sample
    await routeStrip.getByTestId("route-strip-retry").click();
    await expect(routeStrip).toContainText("已连接");
    await expect(routeStrip).toContainText("12ms");
    await expect(routeStrip).not.toContainText("下次重试");

    // Simulate clicking background OS notification -> dispatches focus_scope command -> switches Scope to local/work/sess-work-1
    await page.evaluate(() => {
      const dispatch = (
        window as unknown as {
          __HERMES_E2E_DISPATCH_COMMAND__?: (cmd: unknown) => void;
        }
      ).__HERMES_E2E_DISPATCH_COMMAND__;
      dispatch?.({
        type: "focus_scope",
        scope: { connectionId: "local", profileId: "work", sessionId: "sess-work-1" },
      });
    });

    await expect(routeStrip).toContainText("Work");
    await expect(page.locator(".transcript-list")).toContainText(
      "Work scope transcript after notification focus",
    );
  });

  test("Ticket #39: Approval session confinement, context completeness, high-risk sheet cancel/confirm, inspect modal focus return, and orphaned read-only recovery", async ({
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
              originDisplay: "local-control-socket",
              actual: "ready",
              degraded: false,
              nextRetryAt: null,
            },
            {
              connectionId: "vps",
              kind: "remote",
              label: "Prod VPS",
              originDisplay: "https://vps.example.com",
              actual: "ready",
              degraded: false,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
            },
            {
              connectionId: "local",
              profileId: "work",
              displayName: "Work",
              handle: "work",
              isDefault: false,
              actual: "ready",
            },
            {
              connectionId: "vps",
              profileId: "prod",
              displayName: "Prod",
              handle: "prod",
              isDefault: true,
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-fg",
              title: "Foreground Approval Session",
              preview: "awaiting decision",
              updatedAt: "2026-11-23T09:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-fg-1",
              status: "running",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-bg",
              title: "Background Waiting Session",
              preview: "background prompt",
              updatedAt: "2026-11-23T08:50:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-bg-1",
              status: "running",
            },
            {
              connectionId: "local",
              profileId: "work",
              sessionId: "sess-work",
              title: "Work Distraction Session",
              preview: "clean profile",
              updatedAt: "2026-11-23T08:40:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "vps",
              profileId: "prod",
              sessionId: "sess-vps",
              title: "VPS Prod Session",
              preview: "remote task",
              updatedAt: "2026-11-23T08:30:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-vps-1",
              status: "running",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-fg" },
          activeSessionId: "sess-fg",
        },
        approvals: [
          {
            gateway: {
              approvalId: "apr-fg-sudo",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-fg",
              turnId: "turn-fg-1",
              executionGeneration: 1,
              command: "sudo systemctl reload nginx",
              description: "Reload reverse proxy",
              choices: ["once", "session", "always", "deny"],
              persistentGrant: {
                pattern: "sudo systemctl reload *",
                scope: "local/default",
                revokeHint: "hermes approvals revoke apr-fg-sudo",
              },
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Foreground Approval Session",
              cwd: "/srv/app/current",
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
          {
            gateway: {
              approvalId: "apr-fg-incomplete",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-fg",
              turnId: "turn-fg-2",
              executionGeneration: 2,
              command: "git status",
              description: "Check repo without verified cwd",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Foreground Approval Session",
              cwd: null,
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
          {
            gateway: {
              approvalId: "apr-bg-smart",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-bg",
              turnId: "turn-bg-1",
              executionGeneration: 1,
              command: "cat ~/.ssh/config",
              description: "Inspect ssh config",
              choices: ["once", "session", "always", "deny"],
              smartDenied: true,
              smartDeniedReason: "Blocked automatic broad grant",
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Background Waiting Session",
              cwd: "/Users/dev/project",
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
          {
            gateway: {
              approvalId: "apr-vps-orphan",
              connectionId: "vps",
              profileId: "prod",
              sessionId: "sess-vps",
              turnId: "turn-vps-1",
              executionGeneration: 1,
              command: "docker ps",
              description: "List running containers",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "Prod VPS",
              connectionKind: "remote",
              hostDisplay: "vps.example.com",
              profileDisplayName: "Prod",
              sessionTitle: "VPS Prod Session",
              cwd: "/opt/deploy",
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
        ],
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // 1. Owning-session confinement & zero writable fields inside ApprovalCard
    const cards = page.locator('[data-testid="approval-card"]');
    await expect(cards).toHaveCount(2);

    const sudoCard = cards.filter({ hasText: "sudo systemctl reload nginx" });
    const incompleteCard = cards.filter({ hasText: "git status" });
    await expect(sudoCard).toBeVisible();
    await expect(incompleteCard).toBeVisible();
    await expect(cards.filter({ hasText: "cat ~/.ssh/config" })).toHaveCount(0);
    await expect(cards.filter({ hasText: "docker ps" })).toHaveCount(0);

    // Verify no writable target/command/scope controls exist inside ApprovalCards
    await expect(sudoCard.locator("input, select, textarea")).toHaveCount(0);
    await expect(sudoCard).toContainText("/srv/app/current");
    await expect(sudoCard).toContainText("sudo systemctl reload *");
    await expect(sudoCard.getByTestId("approval-choice-always")).toBeVisible();

    // Background session gets needs-input badge in Session Rail
    const sidebar = page.locator("nav.sidebar");
    const bgRow = sidebar.getByRole("button", { name: /Background Waiting Session/ });
    await expect(bgRow.getByTestId("session-needs-input-badge")).toHaveText("待处理 Approval");

    // 2. context_incomplete blocks Approve choices, allows Inspect & Deny, and Esc closes Inspect modal cleanly
    await expect(incompleteCard).toHaveAttribute("data-approval-state", "context_incomplete");
    await expect(incompleteCard.getByTestId("approval-choice-once")).toHaveCount(0);
    await expect(incompleteCard.getByTestId("approval-choice-deny")).toBeVisible();

    const inspectBtn = incompleteCard.getByTestId("approval-inspect-btn");
    await inspectBtn.click();
    const inspectDialog = page.getByRole("dialog", { name: "Approval 只读详情" });
    await expect(inspectDialog).toBeVisible();
    await expect(inspectDialog.locator("input, select, textarea")).toHaveCount(0);
    await expect(inspectDialog).toContainText("owner=1 · execution=2");
    await page.keyboard.press("Escape");
    await expect(inspectDialog).toBeHidden();
    await expect(inspectBtn).toBeFocused();
    await expect(incompleteCard).toHaveAttribute("data-approval-state", "context_incomplete");

    // 3. Switching Profile / Session or hiding Workspace never migrates or resolves owning session's Approval
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
    await page.keyboard.press("Control+b");
    await expect(sudoCard).toHaveAttribute("data-approval-state", "actionable");

    // Switch to Background Waiting Session -> check smartDenied + missing persistentGrant gating
    await bgRow.click();
    const smartCard = page.locator('[data-testid="approval-card"]').filter({ hasText: "cat ~/.ssh/config" });
    await expect(smartCard).toBeVisible();
    await expect(smartCard.getByTestId("approval-smart-denied-badge")).toBeVisible();
    await expect(smartCard.getByTestId("approval-choice-session")).toHaveCount(0);
    await expect(smartCard.getByTestId("approval-choice-always")).toHaveCount(0);
    await expect(smartCard.getByTestId("approval-choice-once")).toBeVisible();

    // Switch to Work profile -> zero Approvals shown, never leaked across profiles
    await page.locator(".route-strip").getByRole("button", { name: /已连接/ }).click();
    await page.getByRole("dialog", { name: "选择 Scope" }).getByRole("button", { name: /Work/ }).click();
    await expect(page.locator('[data-testid="approval-card"]')).toHaveCount(0);

    // Return to Default -> Foreground Approval Session -> sudoCard & incompleteCard still pending!
    await page.locator(".route-strip").getByRole("button", { name: /已连接/ }).click();
    await page.getByRole("dialog", { name: "选择 Scope" }).getByRole("button", { name: /Default/ }).click();
    await sidebar.getByRole("button", { name: /Foreground Approval Session/ }).click();
    await expect(sudoCard).toHaveAttribute("data-approval-state", "actionable");

    // 4. High-risk Main native sheet: cancelling keeps actionable + cancelled notice; confirming sends sheet request & settles
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_HIGH_RISK_CONFIRM__ = () => false;
    });
    await sudoCard.getByTestId("approval-choice-always").click();
    await expect(sudoCard).toHaveAttribute("data-approval-state", "actionable");
    await expect(sudoCard.getByTestId("approval-cancelled-notice")).toContainText(
      "已取消高风险确认，Approval 仍保持待处理。",
    );

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_HIGH_RISK_CONFIRM__ = () => true;
    });
    await sudoCard.getByTestId("approval-choice-always").click();
    await expect(sudoCard).toHaveAttribute("data-approval-state", "settled");
    await expect(sudoCard.getByTestId("approval-state-badge")).toHaveText("已处理");
    const sheetLog = await page.evaluate(() => {
      return (window as unknown as { __HERMES_E2E_HIGH_RISK_SHEETS__?: Array<Record<string, unknown>> })
        .__HERMES_E2E_HIGH_RISK_SHEETS__;
    });
    expect(sheetLog?.length).toBeGreaterThanOrEqual(2);
    expect(sheetLog?.[0]).toMatchObject({
      choice: "always",
      connectionLabel: "This device",
      profileDisplayName: "Default",
      sessionTitle: "Foreground Approval Session",
      cwd: "/srv/app/current",
      command: "sudo systemctl reload nginx",
    });

    // Deny still works on context_incomplete card
    await incompleteCard.getByTestId("approval-choice-deny").click();
    await expect(incompleteCard).toHaveAttribute("data-approval-state", "settled");

    // 5. Removing owning non-local connection marks its approval orphaned (read-only) & dismisses cleanly
    await page.locator("#rail-settings-gear").click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.locator('[data-connection-id="vps"]').getByRole("button", { name: "移除连接" }).click();
    await page.keyboard.press("Escape");

    const orphanedSection = page.getByRole("region", { name: "已孤立的只读 Approval 记录" });
    await expect(orphanedSection).toBeVisible();
    const orphanCard = orphanedSection.locator('[data-testid="approval-card"]');
    await expect(orphanCard).toHaveAttribute("data-approval-state", "orphaned");
    await expect(orphanCard).toContainText("docker ps");
    await expect(orphanCard.getByTestId("approval-choice-once")).toHaveCount(0);
    await expect(orphanCard.getByTestId("approval-choice-deny")).toHaveCount(0);

    await orphanCard.getByTestId("approval-dismiss-orphaned-btn").click();
    await expect(orphanedSection).toHaveCount(0);
  });
});

test.describe("Ticket #45 approval keyboard safety", () => {
  test("E2E-KB-05: approval never auto-focuses Approve, ignores repeat and global keys, Esc does not resolve, and native-sheet cancel is not deny", async ({
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
              originDisplay: "local-control-socket",
              actual: "ready",
              degraded: false,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-kb05",
              title: "Approval Keyboard Session",
              preview: "awaiting approval",
              updatedAt: "2026-11-23T09:30:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: true,
              activeTurnId: "turn-kb05",
              status: "running",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-kb05",
          },
          activeSessionId: "sess-kb05",
        },
        approvals: [
          {
            gateway: {
              approvalId: "apr-kb05-sudo",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-kb05",
              turnId: "turn-kb05",
              executionGeneration: 1,
              command: "sudo systemctl reload nginx",
              description: "Reload reverse proxy",
              choices: ["once", "always", "deny"],
              persistentGrant: {
                pattern: "sudo systemctl reload *",
                scope: "local/default",
                revokeHint: "hermes approvals revoke apr-kb05-sudo",
              },
              riskCategories: ["sudo"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Approval Keyboard Session",
              cwd: "/srv/app/current",
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
        ],
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const card = page
      .locator('[data-testid="approval-card"]')
      .filter({ hasText: "sudo systemctl reload nginx" });
    const approve = card.getByTestId("approval-choice-once");
    await expect(card).toHaveAttribute("data-approval-state", "actionable");
    await expect(approve).toBeVisible();
    await expect(approve).not.toBeFocused();
    expect(await card.getAttribute("role")).toBeNull();

    const approvedCount = () =>
      page.evaluate(
        () =>
          (window as unknown as { __HERMES_E2E_COUNTS__: { approvalRespondCalls: number } })
            .__HERMES_E2E_COUNTS__.approvalRespondCalls,
      );

    // Opening the owning Session must not move focus onto an Approve action.
    await page
      .locator("nav.sidebar")
      .getByRole("button", { name: /Approval Keyboard Session/ })
      .click();
    await expect(card).toHaveAttribute("data-approval-state", "actionable");
    await expect(approve).not.toBeFocused();

    // No bare-key or modifier global approve/deny shortcut may resolve the Approval.
    for (const key of ["Enter", "Space", "a", "y", "n", "d", "Control+Enter", "Meta+Enter"]) {
      await page.keyboard.press(key);
    }
    expect(await approvedCount()).toBe(0);
    await expect(card).toHaveAttribute("data-approval-state", "actionable");

    await page.keyboard.press("Control+Shift+/");
    const shortcuts = page.getByRole("dialog", { name: "键盘快捷键" });
    await expect(shortcuts).toBeVisible();
    await expect(shortcuts).not.toContainText("Approval");
    await page.keyboard.press("Escape");
    await expect(shortcuts).toBeHidden();
    expect(await approvedCount()).toBe(0);

    // Repeated Enter keydown is cancelled before native activation can re-fire.
    await approve.focus();
    const repeatPrevented = await approve.evaluate((el) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(repeatPrevented).toBe(true);
    expect(await approvedCount()).toBe(0);

    // Esc never resolves; it only dismisses the topmost non-Approval surface.
    await page.keyboard.press("Escape");
    expect(await approvedCount()).toBe(0);
    await expect(card).toHaveAttribute("data-approval-state", "actionable");

    // Cancelling the native high-risk sheet leaves the Approval actionable, not denied.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_HIGH_RISK_CONFIRM__ = () => false;
    });
    await approve.click();
    await expect(card).toHaveAttribute("data-approval-state", "actionable");
    await expect(card.getByTestId("approval-cancelled-notice")).toContainText(
      "已取消高风险确认，Approval 仍保持待处理。",
    );
    expect(await approvedCount()).toBe(1);

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_HIGH_RISK_CONFIRM__ = () => true;
    });
    await approve.focus();
    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("data-approval-state", "settled");
    expect(await approvedCount()).toBe(2);

    await page.keyboard.press("Enter");
    expect(await approvedCount()).toBe(2);
  });
});

test.describe("Ticket #45 focus visibility and modal layering", () => {
  test("E2E-KB-06: shell, onboarding, Settings, palette, Capabilities, Workspace, and pending Approval keep focus visible, inert and topmost-only", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Onboarding is the first focus surface before a connection exists.
    const onboarding = page.locator("section.onboarding-empty-card");
    await expect(onboarding).toBeVisible();
    await page.keyboard.press("Tab");
    await expectFocusAudit(page, "onboarding first Tab");
    await expectFocusableTargetsAudit(page, onboarding, "onboarding");

    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "This device",
              originDisplay: "local-control-socket",
              actual: "ready",
              degraded: false,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-kb06",
              title: "Focus Audit Session",
              preview: "keyboard audit",
              updatedAt: "2026-11-23T09:40:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: true,
              activeTurnId: "turn-kb06",
              status: "running",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-kb06",
          },
          activeSessionId: "sess-kb06",
        },
        approvals: [
          {
            gateway: {
              approvalId: "apr-kb06",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-kb06",
              turnId: "turn-kb06",
              executionGeneration: 1,
              command: "git status --short",
              description: "Inspect working tree",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Focus Audit Session",
              cwd: "/srv/app/current",
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
        ],
      };
    });
    await page.goto("/");

    const shell = page.locator(".app-window");
    const composer = page.locator("#composer-input");
    await expect(composer).toBeVisible();
    await composer.focus();
    await expectFocusAudit(page, "shell composer");
    await expectFocusableTargetsAudit(page, shell, "shell", 16);

    await page.keyboard.press("Control+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(shell).toHaveAttribute("inert", "");
    for (let index = 0; index < 16; index += 1) {
      await page.keyboard.press("Tab");
      await expect(settings.locator(":focus")).toHaveCount(1);
      await expectFocusAudit(page, `Settings Tab ${index + 1}`);
    }
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press("Shift+Tab");
      await expect(settings.locator(":focus")).toHaveCount(1);
      await expectFocusAudit(page, `Settings Shift+Tab ${index + 1}`);
    }

    // A second modal stacks above Settings; Esc closes only the topmost one.
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "命令面板" });
    await expect(palette).toBeVisible();
    await expect(settings).toBeVisible();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      await expect(palette.locator(":focus")).toHaveCount(1);
      await expectFocusAudit(page, `palette Tab ${index + 1}`);
    }
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(settings.locator(":focus")).toHaveCount(1);
    await expect(shell).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(shell).not.toHaveAttribute("inert", "");

    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const capabilities = page.getByRole("dialog", { name: "能力目录" });
    await expect(capabilities).toBeVisible();
    await expect(shell).toHaveAttribute("inert", "");
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
      await expect(capabilities.locator(":focus")).toHaveCount(1);
      await expectFocusAudit(page, `Capabilities Tab ${index + 1}`);
    }
    await page.keyboard.press("Escape");
    await expect(capabilities).toBeHidden();
    await expect(shell).not.toHaveAttribute("inert", "");

    await page.getByRole("button", { name: "Workspace ⌘B" }).click();
    const workspace = page.getByRole("complementary", { name: "Workspace" });
    await expect(workspace).toBeVisible();
    await expect(shell).not.toHaveAttribute("inert", "");
    await workspace.getByRole("button").first().focus();
    await expectFocusAudit(page, "Workspace first control");
    await expectFocusableTargetsAudit(page, workspace, "Workspace");
    await page.keyboard.press("Control+b");
    await expect(workspace).toBeHidden();

    const approve = page.getByTestId("approval-choice-once");
    await expect(approve).toBeVisible();
    await expectFocusableTargetsAudit(
      page,
      page.locator('[data-testid="approval-card"]'),
      "pending Approval",
      6,
    );
  });
});

test.describe("Ticket #41 Subagents (list/steer/interrupt/tail) and Checkpoint (list/diff/restore) & degradations", () => {
  test("Subagents and Checkpoints enter via ⌘K / CapabilitiesDrawer, bind CapabilityEntry + evidenceTestId, enforce bounded tail & generation invalidation, handle -32601 read-only degradation, and confirm scope-bound checkpoint restore", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const longTailLines = Array.from({ length: 240 }, (_, i) => `tail-line-${i + 1}`);
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
              sessionId: "sess-41",
              title: "Session 41",
              preview: "Subagents and Checkpoints",
              updatedAt: "2026-11-23T09:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-41" },
          activeSessionId: "sess-41",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-41" },
          lastSessionByScope: { "local::default": "sess-41" },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [{ connectionId: "local", profileId: "default" }],
          sessionSummaries: {},
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: null,
        },
        agents: {
          "sess-41": [
            {
              agentId: "sub-1",
              name: "Code Explorer",
              status: "running",
              summary: "Scanning packages",
              updatedAt: "2026-11-23T09:00:00.000Z",
            },
            {
              agentId: "sub-2",
              name: "Test Runner",
              status: "completed",
              summary: "All unit tests green",
              updatedAt: "2026-11-23T09:01:00.000Z",
            },
          ],
        },
        subagentTails: {
          "sess-41::sub-1": longTailLines,
        },
        checkpoints: {
          "sess-41": [
            {
              checkpointId: "ckpt-1",
              title: "Before refactor",
              summary: "Clean baseline state",
              createdAt: "2026-11-23T08:50:00.000Z",
            },
            {
              checkpointId: "ckpt-2",
              title: "After schema update",
              summary: "Added contracts and domain state",
              createdAt: "2026-11-23T08:55:00.000Z",
            },
          ],
        },
        checkpointDiffs: {
          "sess-41::ckpt-2": "--- a/packages/contracts/src/index.ts\n+++ b/packages/contracts/src/index.ts\n@@ -1,2 +1,4 @@\n+export interface WorkspaceCheckpointItem {}",
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // 1. Open Command Palette (⌘K) and enter Subagents via capability action `subagents.list`
    await expect(page.getByRole("button", { name: /能力 17 可达 4 延期/ })).toBeVisible();
    await page.getByRole("button", { name: "命令面板 ⌘K" }).click();
    const cmdDialog = page.getByRole("dialog", { name: "命令面板" });
    await expect(cmdDialog).toBeVisible();
    const subagentsCmdBtn = cmdDialog.getByTestId("cap-action-subagents-list");
    await expect(subagentsCmdBtn).toHaveAttribute("data-action-id", "subagents.list");
    await subagentsCmdBtn.click();

    const drawer = page.getByRole("complementary", { name: "Workspace" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // 2. Verify Subagents roster, CapabilityEntry + evidenceTestId bindings, and bounded tail (200 lines max)
    const sub1Chip = drawer.getByTestId("workspace-agent-item-sub-1");
    await expect(sub1Chip).toContainText("Code Explorer (running)");

    const tailBtn = drawer.getByTestId("workspace-agent-tail-btn");
    const interruptBtn = drawer.getByTestId("workspace-agent-interrupt-btn");
    const steerBtn = drawer.getByTestId("workspace-agent-steer-btn");
    await expect(tailBtn).toHaveAttribute("data-evidence-testid", "cap-action-subagents-tail");
    await expect(interruptBtn).toHaveAttribute("data-evidence-testid", "cap-action-subagents-interrupt");
    await expect(steerBtn).toHaveAttribute("data-evidence-testid", "cap-action-subagents-steer");

    await expect(drawer.getByTestId("workspace-agent-tail-truncated")).toContainText("已截断至最近有界窗口");
    const tailText = await drawer.getByTestId("workspace-agent-tail-content").innerText();
    expect(tailText).toContain("tail-line-41");
    expect(tailText).toContain("tail-line-240");
    expect(tailText).not.toContain("tail-line-40\n");

    // 3. Steer Subagent
    const steerInput = drawer.getByLabel("向选中 Subagent 发送补充指令");
    await steerInput.fill("Prioritize contract tests");
    await steerBtn.click();
    await expect(steerInput).toHaveValue("");

    // 4. Failed interrupt must NOT pretend stop succeeded, shows safe typed error code + retry/details
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.subagentErrorByAction = {
        "subagents.interrupt": {
          code: "timeout",
          message: "请求超时，请检查目标主机响应状态后重试。",
        },
      };
    });
    await interruptBtn.click();
    await expect(drawer.getByTestId("workspace-agent-error")).toBeVisible();
    await expect(drawer.getByTestId("workspace-agent-error-code")).toHaveText("[timeout]");
    await expect(sub1Chip).toContainText("Code Explorer (running)");

    await drawer.getByTestId("workspace-agent-error-details").click();
    await expect(drawer.getByTestId("workspace-agent-error-detail-body")).toContainText(
      "code=timeout requestId=",
    );

    // Clear error injection and retry interrupt -> succeeds and updates status to stopped
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.subagentErrorByAction = {};
    });
    await drawer.getByTestId("workspace-agent-error-retry").click();
    await expect(drawer.getByTestId("workspace-agent-error")).toHaveCount(0);
    await expect(sub1Chip).toContainText("Code Explorer (stopped)");

    // 5. Generation change invalidates old tail
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.bumpGenerationCount = 1;
    });
    await drawer.getByRole("button", { name: "刷新 Workspace" }).click();
    await expect(drawer.getByTestId("workspace-agent-tail-invalidated")).toContainText(
      "连接世代已变更，旧输出已失效",
    );

    // Clicking refresh tail fetches fresh tail for the new generation
    await tailBtn.click();
    await expect(drawer.getByTestId("workspace-agent-tail-invalidated")).toHaveCount(0);
    await expect(drawer.getByTestId("workspace-agent-tail-content")).toContainText("tail-line-240");

    // 6. -32601 on subagent.list degrades to read-only last-known roster and hides steer/interrupt
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.subagentNotFoundMethods = ["subagent.list"];
    });
    await drawer.getByRole("button", { name: "刷新 Workspace" }).click();
    await expect(drawer.getByTestId("workspace-agents-readonly-notice")).toBeVisible();
    await expect(drawer.getByTestId("workspace-agent-lastknown-sub-1")).toHaveText("上次已知");
    await expect(drawer.getByTestId("workspace-agent-steer-btn")).toHaveCount(0);
    await expect(drawer.getByTestId("workspace-agent-interrupt-btn")).toHaveCount(0);

    // 7. Hide Workspace, then enter Checkpoints from CapabilitiesDrawer (`checkpoint.list`)
    await drawer.getByRole("button", { name: "隐藏 Workspace" }).click();
    await expect(drawer).toHaveCount(0);
    const capTriggerBtn = page.getByRole("button", { name: /能力 \d+ 可达 \d+ 延期/ });
    await capTriggerBtn.click();
    const capDialog = page.getByRole("dialog", { name: "能力目录" });
    await expect(capDialog).toBeVisible();
    const ckptListAction = capDialog.getByTestId("cap-action-checkpoint-list");
    await expect(ckptListAction).toHaveAttribute("data-action-id", "checkpoint.list");
    await ckptListAction.click();
    await expect(capDialog).toHaveCount(0);

    await expect(drawer.getByRole("tab", { name: "Checkpoints" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(drawer.getByTestId("workspace-checkpoint-item-ckpt-1")).toContainText(
      "Before refactor",
    );
    const ckpt2Chip = drawer.getByTestId("workspace-checkpoint-item-ckpt-2");
    await expect(ckpt2Chip).toContainText("After schema update");
    await ckpt2Chip.click();

    // 8. View Checkpoint diff and initiate explicit confirmation restore bound to session/connection/profile/generation
    const ckptDiffBtn = drawer.getByTestId("workspace-checkpoint-diff-btn");
    const ckptRestoreBtn = drawer.getByTestId("workspace-checkpoint-restore-btn");
    await expect(ckptDiffBtn).toHaveAttribute("data-evidence-testid", "cap-action-checkpoint-diff");
    await expect(ckptRestoreBtn).toHaveAttribute("data-evidence-testid", "cap-action-checkpoint-restore");

    await expect(drawer.getByTestId("workspace-checkpoint-diff-preview")).toContainText(
      "export interface WorkspaceCheckpointItem",
    );

    await ckptRestoreBtn.click();
    const confirmCard = drawer.getByTestId("workspace-checkpoint-confirm-card");
    await expect(confirmCard).toBeVisible();
    await expect(drawer.getByTestId("workspace-checkpoint-confirm-binding")).toContainText(
      "local / default / sess-41 · gen",
    );

    // 9. Restore failure preserves checkpoint selection and provides safe recovery action
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.checkpointErrorByAction = {
        "checkpoints.restore": {
          code: "timeout",
          message: "请求超时，请检查目标主机响应状态后重试。",
        },
      };
    });
    await drawer.getByTestId("workspace-checkpoint-confirm-btn").click();
    await expect(drawer.getByTestId("workspace-checkpoint-error")).toBeVisible();
    await expect(drawer.getByTestId("workspace-checkpoint-error-code")).toHaveText("[timeout]");
    await expect(ckpt2Chip).toHaveClass(/is-active/);

    // Clear error and retry restore -> succeeds and marks checkpoint restored
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.checkpointErrorByAction = {};
    });
    await drawer.getByTestId("workspace-checkpoint-error-retry").click();
    await expect(drawer.getByTestId("workspace-checkpoint-error")).toHaveCount(0);
    await expect(drawer.getByTestId("workspace-checkpoint-restored-ckpt-2")).toHaveText("已恢复");

    // 10. Missing `rollback.restore` (-32601) keeps list/diff read-only and hides Restore button
    await page.evaluate(() => {
      const fix = (window as unknown as { __HERMES_E2E_FIXTURE__: Record<string, unknown> })
        .__HERMES_E2E_FIXTURE__;
      fix.checkpointNotFoundMethods = ["rollback.restore"];
    });
    await drawer.getByRole("button", { name: "刷新 Workspace" }).click();
    await expect(drawer.getByTestId("workspace-checkpoints-readonly-notice")).toBeVisible();
    await expect(drawer.getByTestId("workspace-checkpoint-restore-btn")).toHaveCount(0);
    await expect(drawer.getByTestId("workspace-checkpoint-diff-btn")).toBeVisible();
    await expect(drawer.getByTestId("workspace-checkpoint-diff-preview")).toContainText(
      "export interface WorkspaceCheckpointItem",
    );
  });
});

test.describe("Ticket #42 Skills/Tools/MCP/Plugins read-only inventory, states, lazy fetch, and ExternalAttribution", () => {
  test("lazy-fetches on open without polling, renders whitelisted fields & safe errors, native reloads, CLI/docs links, and invalidates on Scope switch", async ({
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
              actual: "ready",
            },
            {
              connectionId: "local",
              profileId: "work",
              displayName: "Work",
              handle: "work",
              isDefault: false,
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-ext-1",
              title: "Extensions E2E Session",
              preview: "Checking extensions",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-ext-1" },
          activeSessionId: "sess-ext-1",
        },
        capabilities: {
          servedMethods: [
            "prompt.submit",
            "prompt.cancel",
            "session.list",
            "session.create",
            "session.resume",
            "profiles.list",
            "plugins.list",
            "skills.list",
            "reload.skills",
            "tools.show",
            "mcp.list",
            "reload.mcp",
          ],
          capabilityTags: ["plugin-rpc-v1"],
          plugins: {
            outcome: "ok",
            items: [
              {
                name: "git-helper",
                key: "git-helper-v2",
                version: "1.4.2",
                enabled: true,
                status: "loaded",
                tool_count: 2,
                hook_count: 1,
                command_count: 3,
                skills: ["git-review"],
                install_dir: "/Users/secret/.hermes/plugins/git",
                settings_schema: { secretKey: "top-secret" },
                tools: ["raw_leaked_tool"],
              },
              {
                name: "broken-plugin",
                version: "0.2.0",
                enabled: false,
                status: "failed",
                error: "Crash at /Users/secret/token=abc123",
                error_code: "PLUGIN_INIT_ERR",
              },
            ],
          },
          skills: {
            outcome: "ok",
            items: [
              {
                id: "git-review",
                name: "git-review",
                description: "Review git diffs read-only",
                category: "git",
                source: "plugin",
                plugin: "git-helper",
                enabled: true,
              },
            ],
          },
          tools: {
            outcome: "ok",
            items: [
              {
                id: "fs-read",
                name: "read_file",
                description: "Read files cleanly",
                toolset: "filesystem",
                origin: "external",
                mcp_server: "filesystem",
                enabled: true,
              },
            ],
          },
          mcp: {
            outcome: "ok",
            items: [
              {
                id: "filesystem",
                name: "filesystem",
                status: "connected",
                tool_count: 4,
              },
              {
                id: "broken-mcp",
                name: "broken-mcp",
                status: "error",
                error: "Dial /Users/secret failed token=xyz",
                error_code: "MCP_CONN_ERR",
              },
            ],
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Zero extension list fetches before opening Extensions drawer or Settings
    const initialCounts = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: Record<string, number> }).__HERMES_E2E_COUNTS__,
    );
    expect(initialCounts.pluginsListCalls).toBe(0);
    expect(initialCounts.skillsListCalls).toBe(0);
    expect(initialCounts.toolsShowCalls).toBe(0);
    expect(initialCounts.mcpListCalls).toBe(0);

    // Open Capabilities -> click "打开扩展清单（只读）"
    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const capDrawer = page.getByRole("dialog", { name: "能力目录" });
    await expect(capDrawer).toBeVisible();
    await capDrawer.getByTestId("capabilities-open-extensions-drawer").click();

    const extDrawer = page.getByRole("dialog", { name: "扩展清单（只读）" });
    await expect(extDrawer).toBeVisible();
    await expect(extDrawer.getByTestId("ext-drawer-plugins-state")).toHaveAttribute(
      "data-inventory-status",
      "available",
    );

    // Only plugins was fetched once; no polling after waiting
    await page.waitForTimeout(450);
    const afterPluginsOpen = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: Record<string, number> }).__HERMES_E2E_COUNTS__,
    );
    expect(afterPluginsOpen.pluginsListCalls).toBe(1);
    expect(afterPluginsOpen.skillsListCalls).toBe(0);
    expect(afterPluginsOpen.toolsShowCalls).toBe(0);
    expect(afterPluginsOpen.mcpListCalls).toBe(0);

    // Top 3-line notice, Gateway reported badge, conditional plugin-rpc-v1 notice, docs & CLI note
    await expect(extDrawer).toContainText("Hermes 的插件运行在 Gateway / CLI 侧。");
    await expect(extDrawer).toContainText("本客户端不加载官方桌面插件代码，也不提供插件商店。");
    await expect(extDrawer).toContainText("安装、启停、移除或更新请使用 Hermes CLI 或官方文档。");
    await expect(extDrawer).toContainText("Gateway 报告");
    await expect(extDrawer.getByTestId("ext-drawer-plugin-rpc-notice")).toBeVisible();
    await expect(extDrawer).toContainText("不会在此客户端执行");
    await expect(extDrawer.getByTestId("ext-drawer-docs-plugins")).toBeVisible();

    // Whitelisted fields only + safe error code; zero raw path/secret/schema leakage
    const healthyRow = extDrawer.getByTestId("ext-drawer-plugin-row-git-helper-v2");
    await expect(healthyRow).toContainText("git-helper");
    await expect(healthyRow).toContainText("1.4.2");
    await expect(healthyRow).toContainText("git-helper-v2");
    await expect(healthyRow).toContainText("Tools 数量: 2");
    await expect(healthyRow).toContainText("Hooks 数量: 1");
    await expect(healthyRow).toContainText("Commands 数量: 3");
    await expect(healthyRow).toContainText("外部提供 · Plugin · git-helper");

    const failedRow = extDrawer.getByTestId("ext-drawer-plugin-row-broken-plugin");
    await expect(failedRow).toContainText("加载失败");
    await expect(failedRow).toContainText("PLUGIN_INIT_ERR");

    const drawerText = await extDrawer.innerText();
    expect(drawerText).not.toContain("install_dir");
    expect(drawerText).not.toContain("settings_schema");
    expect(drawerText).not.toContain("top-secret");
    expect(drawerText).not.toContain("raw_leaked_tool");
    expect(drawerText).not.toContain("/Users/secret");
    expect(drawerText).not.toContain("token=abc123");

    // Clicking "查看 Skills 清单" switches to Skills tab & fetches Skills once
    await extDrawer.getByTestId("ext-drawer-plugin-view-skills-git-helper-v2").click();
    await expect(extDrawer.getByTestId("ext-drawer-skills-state")).toHaveAttribute(
      "data-inventory-status",
      "available",
    );
    await expect(extDrawer).toContainText("git-review");
    await expect(extDrawer.getByTestId("ext-drawer-reload-skills")).toBeVisible();
    await expect(extDrawer.getByRole("button", { name: /安装|卸载|启用|禁用/ })).toHaveCount(0);

    await extDrawer.getByTestId("ext-drawer-reload-skills").click();
    const afterSkillsReload = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: Record<string, number> }).__HERMES_E2E_COUNTS__,
    );
    expect(afterSkillsReload.skillsReloadCalls).toBe(1);
    expect(afterSkillsReload.skillsListCalls).toBe(2);

    // Switch to Tools tab: read-only, no configure button
    await extDrawer.getByTestId("ext-drawer-tab-tools").click();
    await expect(extDrawer.getByTestId("ext-drawer-tools-state")).toHaveAttribute(
      "data-inventory-status",
      "available",
    );
    await expect(extDrawer).toContainText("read_file");
    await expect(extDrawer).toContainText("外部提供 · MCP · filesystem");
    await expect(extDrawer.getByRole("button", { name: /配置|configure/i })).toHaveCount(0);

    // Switch to MCP tab: status + toolCount + safe errorCode + native reload
    await extDrawer.getByTestId("ext-drawer-tab-mcp").click();
    await expect(extDrawer.getByTestId("ext-drawer-mcp-state")).toHaveAttribute(
      "data-inventory-status",
      "available",
    );
    await expect(extDrawer).toContainText("filesystem");
    await expect(extDrawer).toContainText("Tools 数量: 4");
    await expect(extDrawer).toContainText("MCP_CONN_ERR");
    expect(await extDrawer.innerText()).not.toContain("token=xyz");
    await expect(extDrawer.getByRole("button", { name: /新增|删除|OAuth/i })).toHaveCount(0);

    await extDrawer.getByTestId("ext-drawer-reload-mcp").click();
    const afterMcpReload = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: Record<string, number> }).__HERMES_E2E_COUNTS__,
    );
    expect(afterMcpReload.mcpReloadCalls).toBe(1);

    // Manual Refresh on Plugins increments pluginsListCalls
    await extDrawer.getByTestId("ext-drawer-tab-plugins").click();
    await extDrawer.getByTestId("ext-drawer-refresh-plugins").click();
    const afterManualRefresh = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: Record<string, number> }).__HERMES_E2E_COUNTS__,
    );
    expect(afterManualRefresh.pluginsListCalls).toBe(2);

    // Close Extensions + Capabilities, switch Profile -> invalidates & refetches on next open
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator(".route-strip").getByRole("button", { name: "已连接" }).click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await scopeDialog.getByRole("button", { name: /Work/ }).click();

    await page.keyboard.press("Control+,");
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();
    const settingsPlugins = settingsDialog.locator('section[data-settings-section="plugins"]');
    await expect(settingsPlugins).toBeVisible();
    await expect(settingsPlugins.getByTestId("ext-settings-plugins-state")).toHaveAttribute(
      "data-inventory-status",
      "available",
    );
    const afterScopeSwitchOpen = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: Record<string, number> }).__HERMES_E2E_COUNTS__,
    );
    expect(afterScopeSwitchOpen.pluginsListCalls).toBe(3);
  });

  test("renders empty/unsupported/unknown/error states, hides plugin-rpc-v1 when unadvertised, and enforces ExternalAttribution across all 5 surfaces", async ({
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
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-attr-1",
              title: "Attribution Session",
              preview: "Checking 5 surfaces",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-attr-1" },
          activeSessionId: "sess-attr-1",
        },
        transcripts: {
          "local::default::sess-attr-1": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-attr-1",
            messages: [
              {
                messageId: "m-attr-1",
                sessionId: "sess-attr-1",
                role: "assistant",
                text: "Running external tool and checking provenance.",
                createdAt: "2026-11-23T08:00:00.000Z",
                toolRows: [
                  {
                    toolCallId: "tc-ext",
                    name: "mcp_read",
                    status: "completed",
                    summary: "Read file",
                    attribution: {
                      origin: "external",
                      provider: { kind: "mcp", id: "filesystem", label: "MCP · filesystem" },
                      sourceLabel: "外部提供 · MCP · filesystem",
                      accessibleLabel: "外部提供 · MCP · filesystem",
                    },
                  },
                  {
                    toolCallId: "tc-missing-attr",
                    name: "opaque_tool",
                    status: "completed",
                    summary: "Omitted attribution must never default to builtin",
                  },
                ],
              },
            ],
            pendingApprovals: [
              {
                approvalId: "appr-1",
                sessionId: "sess-attr-1",
                toolName: "git_commit_external",
                summary: "Confirm external plugin tool execution",
                status: "pending",
                requestedAt: "2026-11-23T08:00:01.000Z",
                attribution: {
                  origin: "external",
                  provider: { kind: "plugin", id: "git-helper", label: "Plugin · git-helper" },
                  sourceLabel: "外部提供 · Plugin · git-helper",
                  accessibleLabel: "外部提供 · Plugin · git-helper",
                },
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
        capabilities: {
          servedMethods: [
            "prompt.submit",
            "prompt.cancel",
            "session.list",
            "session.create",
            "session.resume",
            "plugins.list",
            "skills.list",
          ],
          olderMethods: ["skills.reload", "skills.install", "tools.configure"],
          plugins: {
            outcome: "ok",
            items: [],
          },
          skills: {
            outcome: "error",
            errorCode: "SKILL_SCAN_ERR",
          },
          tools: {
            outcome: "method_not_found",
          },
          mcp: {
            outcome: "older",
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Surface 3 & 4: Transcript tool rows (external + missing -> 来源未知) & pending Approval cards
    await expect(page.getByTestId("tool-attribution-tc-ext")).toHaveText("外部提供 · MCP · filesystem");
    await expect(page.getByTestId("tool-attribution-tc-missing-attr")).toHaveText("来源未知");
    await expect(page.getByTestId("pending-approvals-section")).toBeVisible();
    await expect(page.getByTestId("approval-attribution-appr-1")).toHaveText(
      "外部提供 · Plugin · git-helper",
    );

    // Surface 1: Command Palette (⌘K) shows Builtin attribution badges
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "命令面板" });
    await expect(palette).toBeVisible();
    await expect(palette.locator('.attribution-badge[data-attribution-origin="builtin"]').first()).toHaveText("内置");
    await page.keyboard.press("Escape");

    // Surface 2: Capabilities Drawer shows Builtin attribution badges + opens Extensions drawer
    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const capDrawer = page.getByRole("dialog", { name: "能力目录" });
    await expect(capDrawer.locator('.attribution-badge[data-attribution-origin="builtin"]').first()).toHaveText("内置");
    await capDrawer.getByTestId("capabilities-open-extensions-drawer").click();

    const extDrawer = page.getByRole("dialog", { name: "扩展清单（只读）" });
    await expect(extDrawer).toBeVisible();
    // Unadvertised plugin-rpc-v1 notice is hidden
    await expect(extDrawer.getByTestId("ext-drawer-plugin-rpc-notice")).toHaveCount(0);
    // Empty state on Plugins
    await expect(extDrawer.getByTestId("ext-drawer-plugins-state")).toHaveAttribute(
      "data-inventory-status",
      "empty",
    );
    await expect(extDrawer).toContainText("Gateway 报告 0 个已加载插件");

    // Unprobed MCP shows unknown state before tab is clicked? Wait: clicking tab probes; check unprobed via Settings before switching or check error & unsupported tabs directly
    // Error state on Skills + older skills.reload keeps reload button hidden
    await extDrawer.getByTestId("ext-drawer-tab-skills").click();
    await expect(extDrawer.getByTestId("ext-drawer-skills-state")).toHaveAttribute(
      "data-inventory-status",
      "error",
    );
    await expect(extDrawer).toContainText("Skills 清单加载失败。");
    await expect(extDrawer).toContainText("SKILL_SCAN_ERR");
    await expect(extDrawer.getByTestId("ext-drawer-reload-skills")).toHaveCount(0);

    // Unsupported state on Tools: never fabricates local tools
    await extDrawer.getByTestId("ext-drawer-tab-tools").click();
    await expect(extDrawer.getByTestId("ext-drawer-tools-state")).toHaveAttribute(
      "data-inventory-status",
      "unsupported",
    );
    await expect(extDrawer).toContainText("此 Gateway 不提供 Tools 清单（不伪造本地清单）。");
    await expect(extDrawer.locator(".ext-card")).toHaveCount(0);

    // Unknown state on MCP when compatibility tier is older
    await extDrawer.getByTestId("ext-drawer-tab-mcp").click();
    await expect(extDrawer.getByTestId("ext-drawer-mcp-state")).toHaveAttribute(
      "data-inventory-status",
      "unknown",
    );
    await expect(extDrawer).toContainText("无法确认 MCP 状态清单，请点击刷新清单探测。");
  });
});

test.describe("Ticket #37 Background journal, attention badges, unread mark-read, and resync_required", () => {
  test("never fetches full transcript for background sessions on boot, clears unread without switching active session, resyncs overflowed session cleanly, and focuses exact Scope from route strip badges without global approval actions", async ({
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
              originDisplay: "local://control-socket",
              desired: "enabled",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 3,
              nextRetryAt: null,
            },
            {
              connectionId: "remote-ops",
              kind: "remote",
              label: "Remote Ops",
              originDisplay: "https://ops.example.com",
              desired: "enabled",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 14,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              desired: "enabled",
              actual: "ready",
              degraded: false,
            },
            {
              connectionId: "remote-ops",
              profileId: "ops",
              displayName: "Ops",
              handle: "ops",
              isDefault: true,
              desired: "enabled",
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "s-fg",
              title: "当前前台会话",
              preview: "Active foreground",
              updatedAt: "2026-11-23T09:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "s-bg-unread",
              title: "后台未读会话",
              preview: "2 条新进展",
              updatedAt: "2026-11-23T09:01:00.000Z",
              pinned: true,
              pinnedReasons: { unread: true },
              unreadCount: 2,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "s-bg-overflow",
              title: "溢出待同步会话",
              preview: "需要重同步",
              updatedAt: "2026-11-23T09:02:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "remote-ops",
              profileId: "ops",
              sessionId: "s-remote-approval",
              title: "远程审批会话",
              preview: "等待确认",
              updatedAt: "2026-11-23T09:03:00.000Z",
              pinned: true,
              pinnedReasons: { pendingInput: true, unread: true },
              unreadCount: 1,
              needsInput: true,
              activeTurnId: "turn-remote-1",
              status: "running",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "s-fg" },
          activeSessionId: "s-fg",
        },
        resyncRequiredSessions: {
          "local::default::s-bg-overflow": true,
        },
        transcripts: {
          "local::default::s-fg": {
            connectionId: "local",
            profileId: "default",
            sessionId: "s-fg",
            messages: [
              {
                messageId: "m-fg",
                sessionId: "s-fg",
                role: "assistant",
                text: "Foreground session ready",
                createdAt: "2026-11-23T09:00:00.000Z",
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
          "local::default::s-bg-overflow": {
            connectionId: "local",
            profileId: "default",
            sessionId: "s-bg-overflow",
            messages: [
              {
                messageId: "m-stale",
                sessionId: "s-bg-overflow",
                role: "assistant",
                text: "Stale partial history",
                createdAt: "2026-11-23T09:00:30.000Z",
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
          "remote-ops::ops::s-remote-approval": {
            connectionId: "remote-ops",
            profileId: "ops",
            sessionId: "s-remote-approval",
            messages: [
              {
                messageId: "m-remote",
                sessionId: "s-remote-approval",
                role: "assistant",
                text: "Remote scope awaiting user decision",
                createdAt: "2026-11-23T09:03:00.000Z",
              },
            ],
            activeTurnId: "turn-remote-1",
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
          "local::default::s-bg-overflow": {
            connectionId: "local",
            profileId: "default",
            sessionId: "s-bg-overflow",
            messages: [
              {
                messageId: "m-clean",
                sessionId: "s-bg-overflow",
                role: "assistant",
                text: "Whole replaced gateway history",
                createdAt: "2026-11-23T09:02:30.000Z",
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

    await expect(page.locator(".transcript-list")).toContainText("Foreground session ready");
    // Background sessions must NOT trigger sessions.resume on boot
    const bootCounts = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__?: { sessionsResumeCalls: number } }).__HERMES_E2E_COUNTS__,
    );
    expect(bootCounts?.sessionsResumeCalls ?? 0).toBe(0);

    // Rail renders unread badge + pinned badge + sibling 标记已读 button, with zero Approve/Deny buttons
    const sidebar = page.locator("nav.sidebar");
    await expect(sidebar).toContainText("后台未读会话");
    await expect(sidebar).toContainText("2 条未读");
    await expect(sidebar).toContainText("已固定");
    await expect(sidebar.getByRole("button", { name: /Approve|Deny|批准|拒绝/ })).toHaveCount(0);

    const markReadBtn = sidebar.getByTestId("session-mark-read-s-bg-unread");
    await expect(markReadBtn).toBeVisible();
    await markReadBtn.click();

    // Unread clears while staying on active foreground session
    await expect(sidebar.getByTestId("session-mark-read-s-bg-unread")).toHaveCount(0);
    await expect(sidebar).not.toContainText("2 条未读");
    await expect(page.locator(".transcript-list")).toContainText("Foreground session ready");

    // Switching to overflowed background session triggers resync_required -> sessions.resume -> whole replacement
    await sidebar.getByRole("button", { name: /溢出待同步会话/ }).click();
    await expect(page.locator(".transcript-list")).toContainText("Whole replaced gateway history");
    await expect(page.locator(".transcript-list")).not.toContainText("Stale partial history");

    const afterResyncCounts = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__?: { sessionsResumeCalls: number } }).__HERMES_E2E_COUNTS__,
    );
    expect(afterResyncCounts?.sessionsResumeCalls).toBe(1);

    // Route strip renders attention badges (navigation only, no approval action controls)
    const routeStrip = page.locator(".route-strip");
    await expect(routeStrip.getByRole("button", { name: /Approve|Deny|批准|拒绝/ })).toHaveCount(0);
    const needsInputBadge = routeStrip.getByTestId("route-strip-attention-needs-input");
    await expect(needsInputBadge).toBeVisible();
    await expect(needsInputBadge).toContainText("1");

    // 1280x800 popover still exposes session badges cleanly without global approval inbox
    await page.setViewportSize({ width: 1280, height: 800 });
    await routeStrip.getByRole("button", { name: /Sessions\s+3/ }).click();
    const popover = page.getByRole("dialog", { name: "Sessions" });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("后台未读会话");
    await expect(popover.getByRole("button", { name: /Approve|Deny|批准|拒绝/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Clicking route strip needsInput badge focuses exact cross-Scope remote-ops/ops/s-remote-approval
    await needsInputBadge.click();
    await expect(routeStrip).toContainText("Remote Ops");
    await expect(routeStrip).toContainText("Ops");
    await expect(page.locator(".transcript-list")).toContainText("Remote scope awaiting user decision");
  });
});

test.describe("Ticket #40 Terminal PTY lifecycle & Git CLI deep links", () => {
  test("Ticket #40: Terminal PTY grant denial, bounded scrollback, reload survival, busy detach/terminate/Esc, and Git CLI deep links", async ({
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
              originDisplay: "local://control-socket",
              desired: "enabled",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 3,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              desired: "enabled",
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-term-1",
              title: "Terminal Session",
              preview: "Ready",
              updatedAt: "2026-11-23T09:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-term-1" },
          activeSessionId: "sess-term-1",
        },
        transcripts: {
          "local::default::sess-term-1": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-term-1",
            messages: [
              {
                messageId: "m-t1",
                sessionId: "sess-term-1",
                role: "assistant",
                text: "Workspace ready",
                createdAt: "2026-11-23T09:00:00.000Z",
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
        terminal: {
          denyFirstGrant: true,
          denyRootGrant: true,
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    // Open Workspace -> Terminal tab
    await page.getByRole("button", { name: /^Workspace/ }).click();
    const drawer = page.getByRole("complementary", { name: "Workspace" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("tab", { name: "Terminal" }).click();

    // Attribution renders "内置" without relying on color alone
    const termAttr = drawer.getByTestId("workspace-terminal-attribution");
    await expect(termAttr).toHaveText("内置");
    await expect(termAttr).toHaveAttribute("data-attribution-origin", "builtin");

    // 1. Grant denial blocks opening PTY cleanly
    await drawer.getByTestId("workspace-terminal-open-btn").click();
    await expect(drawer.getByTestId("workspace-terminal-status")).toContainText("未授权（已拒绝）");
    await expect(drawer.getByTestId("workspace-terminal-grant-denied-notice")).toBeVisible();
    await expect(drawer.getByTestId("workspace-terminal-id")).toHaveCount(0);

    // Root grant denial also keeps root badge absent
    await drawer.getByTestId("workspace-terminal-grant-root-btn").click();
    await expect(drawer.getByTestId("workspace-terminal-root-badge")).toHaveCount(0);
    await expect(drawer.getByTestId("workspace-terminal-id")).toHaveCount(0);

    // 2. Approve first grant -> open PTY -> write + resize + bounded scrollback trim notice
    await page.evaluate(() => {
      const w = window as unknown as {
        __HERMES_E2E_FIXTURE__: { terminal: { denyFirstGrant: boolean; denyRootGrant: boolean } };
      };
      w.__HERMES_E2E_FIXTURE__.terminal.denyFirstGrant = false;
      w.__HERMES_E2E_FIXTURE__.terminal.denyRootGrant = false;
    });
    await drawer.getByTestId("workspace-terminal-open-btn").click();
    await expect(drawer.getByTestId("workspace-terminal-status")).toContainText("运行中");
    const firstTerminalId = await drawer.getByTestId("workspace-terminal-id").innerText();
    expect(firstTerminalId).toMatch(/^term_/);

    await drawer.getByTestId("workspace-terminal-cols-input").fill("112");
    await drawer.getByTestId("workspace-terminal-rows-input").fill("32");
    await drawer.getByTestId("workspace-terminal-resize-btn").click();

    await drawer.getByTestId("workspace-terminal-input").fill("echo HELLO_E2E_TERM");
    await drawer.getByTestId("workspace-terminal-send-btn").click();
    await expect(drawer.getByTestId("workspace-terminal-scrollback")).toContainText("HELLO_E2E_TERM");

    // Burst > 10,000 lines triggers bounded oldest-line trimming + notice
    await drawer.getByTestId("workspace-terminal-input").fill("burst:10050");
    await drawer.getByTestId("workspace-terminal-send-btn").click();
    await expect(drawer.getByTestId("workspace-terminal-trimmed-notice")).toContainText("更早输出已修剪");
    const trimmedText = await drawer.getByTestId("workspace-terminal-scrollback").innerText();
    const lines = trimmedText.split("\n");
    expect(lines).toHaveLength(10_000);
    expect(lines[lines.length - 1]).toBe("burst-line-10050");

    // 3. Reload preserves terminalId + bounded scrollback
    await page.reload();
    await page.getByRole("button", { name: "Workspace ⌘B" }).click();
    const drawerAfterReload = page.getByRole("complementary", { name: "Workspace" });
    await drawerAfterReload.getByRole("tab", { name: "Terminal" }).click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-id")).toHaveText(firstTerminalId);
    await expect(drawerAfterReload.getByTestId("workspace-terminal-trimmed-notice")).toContainText("更早输出已修剪");

    // 4. Busy foreground close -> inline confirmation defaulting to "仅分离，保留运行", Esc cancels safely
    await drawerAfterReload.getByTestId("workspace-terminal-input").fill("sleep 30");
    await drawerAfterReload.getByTestId("workspace-terminal-send-btn").click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-fg-badge")).toContainText("前台进程运行中");

    const closeTermBtn = drawerAfterReload.getByTestId("workspace-terminal-close-btn");
    await closeTermBtn.click();
    const busyConfirm = drawerAfterReload.getByTestId("workspace-terminal-busy-confirm");
    await expect(busyConfirm).toBeVisible();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-detach-btn")).toBeFocused();

    // Esc cancels inline confirmation WITHOUT closing Workspace or altering PTY state, and returns focus
    await page.keyboard.press("Escape");
    await expect(busyConfirm).toBeHidden();
    await expect(drawerAfterReload).toBeVisible();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-status")).toContainText("运行中");
    await expect(closeTermBtn).toBeFocused();

    // Re-open busy confirm -> choose default "仅分离，保留运行" -> re-attach retains same terminalId
    await closeTermBtn.click();
    await drawerAfterReload.getByTestId("workspace-terminal-detach-btn").click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-status")).toContainText("detached");
    await expect(drawerAfterReload.getByTestId("workspace-terminal-id")).toHaveText(firstTerminalId);

    await drawerAfterReload.getByTestId("workspace-terminal-reattach-btn").click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-status")).toContainText("运行中");
    await expect(drawerAfterReload.getByTestId("workspace-terminal-id")).toHaveText(firstTerminalId);

    // Choose "结束终端" -> kills PTY + clears scrollback + requires explicit "新建 Terminal"
    await drawerAfterReload.getByTestId("workspace-terminal-close-btn").click();
    await drawerAfterReload.getByTestId("workspace-terminal-terminate-btn").click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-status")).toContainText("ended");
    await expect(drawerAfterReload.getByTestId("workspace-terminal-empty")).toBeVisible();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-input")).toHaveCount(0);

    // Explicit "新建 Terminal" -> fresh terminalId -> natural "exit" shows ended
    await drawerAfterReload.getByTestId("workspace-terminal-new-btn").click();
    const secondTerminalId = await drawerAfterReload.getByTestId("workspace-terminal-id").innerText();
    expect(secondTerminalId).not.toBe(firstTerminalId);
    await drawerAfterReload.getByTestId("workspace-terminal-input").fill("exit");
    await drawerAfterReload.getByTestId("workspace-terminal-send-btn").click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-status")).toContainText("ended");
    await expect(drawerAfterReload.getByTestId("workspace-terminal-ended-notice")).toBeVisible();

    // 5. Git/Worktree deep_link tab: exact copyable CLI + "不会在此客户端执行" + https docs + ExternalAttribution
    await drawerAfterReload.getByRole("tab", { name: "Git" }).click();
    const gitPanel = drawerAfterReload.getByTestId("workspace-git-panel");
    await expect(gitPanel.getByTestId("workspace-git-boundary")).toContainText("不会在此客户端执行");
    await expect(gitPanel.getByTestId("workspace-git-never-executed-git-worktree-list")).toContainText("不会在此客户端执行");

    const gitAttr = gitPanel.getByTestId("workspace-git-attribution-git-worktree-list");
    await expect(gitAttr).toContainText("外部提供");
    await expect(gitAttr).toHaveAttribute("data-attribution-origin", "external");

    const countsBeforeGit = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: { terminalWriteCalls: number; externalLinksOpened: string[] } }).__HERMES_E2E_COUNTS__,
    );
    await gitPanel.getByTestId("workspace-git-copy-git-worktree-list").click();
    await expect(gitPanel.getByTestId("workspace-git-copied-notice")).toContainText("不会在此客户端执行");

    await gitPanel.getByTestId("workspace-git-doc-git-worktree-docs").click();
    const countsAfterGit = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: { terminalWriteCalls: number; externalLinksOpened: string[] } }).__HERMES_E2E_COUNTS__,
    );
    expect(countsAfterGit.terminalWriteCalls).toBe(countsBeforeGit.terminalWriteCalls);
    expect(countsAfterGit.externalLinksOpened).toContain("https://git-scm.com/docs/git-worktree");

    // "打开 Terminal 面板" navigates without auto-pasting/executing git commands
    await gitPanel.getByTestId("workspace-git-open-terminal-btn").click();
    await expect(drawerAfterReload.getByTestId("workspace-terminal-panel")).toBeVisible();
    const countsAfterOpenTerm = await page.evaluate(
      () => (window as unknown as { __HERMES_E2E_COUNTS__: { terminalWriteCalls: number } }).__HERMES_E2E_COUNTS__,
    );
    expect(countsAfterOpenTerm.terminalWriteCalls).toBe(countsBeforeGit.terminalWriteCalls);

    // 6. Verify unknown ExternalAttribution state renders "来源未知" cleanly
    await page.addInitScript(() => {
      window.sessionStorage.removeItem("hermes-mock-terminal-state");
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "This device",
              originDisplay: "local://control-socket",
              desired: "enabled",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 3,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              desired: "enabled",
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [],
          activeScope: { connectionId: "local", profileId: "default" },
          activeSessionId: null,
        },
        terminal: {
          attribution: {
            origin: "unknown",
            sourceLabel: "来源未知",
            accessibleLabel: "来源未知",
          },
        },
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Workspace ⌘B" }).click();
    const drawerUnknown = page.getByRole("complementary", { name: "Workspace" });
    await drawerUnknown.getByRole("tab", { name: "Terminal" }).click();
    const unknownAttr = drawerUnknown.getByTestId("workspace-terminal-attribution");
    await expect(unknownAttr).toHaveText("来源未知");
    await expect(unknownAttr).toHaveAttribute("data-attribution-origin", "unknown");
  });
});

test.describe("Ticket #38 Drafts and OrphanedDrafts", () => {
  test("Ticket #38: Draft persistence across Session/Scope switch, expired attachment reattach, multi-draft new chat, receipt clear vs delivery_unknown, atomic migration, capacity limit, and Settings -> Data orphaned drafts", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "Local Hermes",
              originDisplay: "127.0.0.1:47371",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              profileExceptionCount: 0,
              latencyMs: 9,
              nextRetryAt: null,
              isPrimary: true,
              isLastUsed: true,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              handle: "default",
              displayName: "Default",
              isDefault: true,
              actual: "ready",
              degraded: false,
              isException: false,
            },
            {
              connectionId: "local",
              profileId: "empty-prof",
              handle: "empty-prof",
              displayName: "Empty Profile",
              actual: "ready",
              degraded: false,
              isException: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a",
              title: "Alpha Session",
              preview: "first",
              updatedAt: "2026-11-23T08:00:00.000Z",
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
              title: "Beta Session",
              preview: "second",
              updatedAt: "2026-11-23T08:01:00.000Z",
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
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-a" },
          lastSessionByScope: { "local::default": "sess-a" },
          activeStatus: "ready",
          draftsByKey: {
            "chat::local::default::sess-a": {
              draftId: "draft-a",
              sessionId: "sess-a",
              scope: { connectionId: "local", profileId: "default" },
              text: "Draft for Alpha with expired file",
              attachments: [
                {
                  attachmentId: "att-expired",
                  handle: "opaque://expired-1",
                  displayName: "spec.pdf",
                  kind: "file",
                  expired: true,
                },
              ],
              contexts: [],
              composer: {},
              updatedAt: "2026-11-23T08:02:00.000Z",
              revision: 1,
              origin: { connectionId: "local", profileId: "default", sessionId: "sess-a" },
            },
          },
          orphanedDrafts: [
            {
              orphanedId: "orphan-e2e-1",
              draftId: "draft-orphan-1",
              reason: "session_deleted",
              text: "Recovered orphaned prompt text",
              attachments: [
                {
                  attachmentId: "att-orph-1",
                  handle: "opaque://orph",
                  displayName: "trace.log",
                  kind: "text",
                },
              ],
              contexts: [],
              origin: {
                connectionId: "remote-1",
                profileId: "prod",
                sessionId: "sess-deleted",
                title: "Deleted Session",
              },
              orphanedAt: "2026-11-23T07:50:00.000Z",
            },
          ],
        },
        transcripts: {
          "sess-a": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-a",
            messages: [],
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
          "sess-b": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-b",
            messages: [],
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

    // 1. Expired attachment shows badge + alert + blocks Send until reattached
    const composer = page.locator("#composer-input");
    const sendBtn = page.getByRole("button", { name: "发送消息" });
    await expect(composer).toHaveValue("Draft for Alpha with expired file");
    await expect(page.getByTestId("draft-attachment-expired-alert")).toBeVisible();
    await expect(page.getByTestId("draft-attachment-att-expired")).toContainText("spec.pdf");
    await expect(page.getByTestId("draft-attachment-att-expired")).toContainText("需重新附加");
    await expect(sendBtn).toBeDisabled();

    // 2. Switch to Beta Session -> clean composer; write Draft for Beta; switch back -> Alpha Draft still there!
    await page.locator("nav.sidebar").getByRole("button", { name: /Beta Session/ }).click();
    await expect(composer).toHaveValue("");
    await composer.fill("Draft for Beta");
    await page.locator("nav.sidebar").getByRole("button", { name: /Alpha Session/ }).click();
    await expect(composer).toHaveValue("Draft for Alpha with expired file");

    // 3. Reattach expired attachment via file chooser -> Send unlocks
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("draft-attachment-att-expired").getByRole("button", { name: "重新附加" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "spec-v2.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("pdf-bytes"),
    });
    await expect(page.getByTestId("draft-attachment-expired-alert")).toHaveCount(0);
    await expect(page.getByTestId("draft-attachments-bar")).toContainText("spec-v2.pdf");
    await expect(sendBtn).toBeEnabled();

    // 4. delivery_unknown retains Draft and marks "未确定是否送达"
    await page.evaluate(() => {
      (window as unknown as { __HERMES_E2E_FIXTURE__: { promptReceiptMode?: string } })
        .__HERMES_E2E_FIXTURE__.promptReceiptMode = "delivery_unknown";
    });
    await sendBtn.click();
    await expect(page.getByTestId("draft-delivery-unknown-alert")).toContainText("未确定是否送达");
    await expect(composer).toHaveValue("Draft for Alpha with expired file");

    // 5. accepted receipt clears Alpha Draft
    await page.evaluate(() => {
      (window as unknown as { __HERMES_E2E_FIXTURE__: { promptReceiptMode?: string } })
        .__HERMES_E2E_FIXTURE__.promptReceiptMode = "accepted";
    });
    await sendBtn.click();
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("draft-delivery-unknown-alert")).toHaveCount(0);
    await expect(page.getByTestId("draft-attachments-bar")).toHaveCount(0);

    // 6. Capacity limit (> 1 MiB) prompts Export/Clear and does not lose prior Beta Draft
    await page.locator("nav.sidebar").getByRole("button", { name: /Beta Session/ }).click();
    await expect(composer).toHaveValue("Draft for Beta");
    const oversizedText = "x".repeat(1024 * 1024 + 64);
    await composer.fill(oversizedText);
    await expect(page.getByTestId("draft-capacity-alert")).toContainText("1 MiB");
    await page.getByTestId("draft-capacity-alert").getByRole("button", { name: "导出当前 Draft" }).click();
    await expect(page.getByTestId("draft-export-preview")).toContainText("draftId");
    await page.getByTestId("draft-capacity-alert").getByRole("button", { name: "清空当前 Draft" }).click();
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("draft-capacity-alert")).toHaveCount(0);

    // 7. Empty Scope supports multiple Scope+draftId drafts + failed session.create retains draft vs success migrates atomically
    await page.locator(".route-strip").getByRole("button", { name: /已连接/ }).click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await scopeDialog.getByRole("button", { name: /Empty Profile/ }).click();
    await composer.fill("New scope first draft");
    await expect(page.getByTestId("scope-new-drafts-bar")).toBeVisible();
    await page.getByTestId("scope-new-drafts-bar").getByRole("button", { name: "新建本地 Draft" }).click();
    await expect(composer).toHaveValue("");
    await composer.fill("New scope second draft");

    // Switch back to first new-chat draft and verify session.create failure retains draftId & text
    await page
      .getByTestId("scope-new-drafts-bar")
      .getByRole("button", { name: /New scope first/ })
      .click();
    await expect(composer).toHaveValue("New scope first draft");

    await page.evaluate(() => {
      (window as unknown as { __HERMES_E2E_FIXTURE__: { failSessionCreate?: boolean } })
        .__HERMES_E2E_FIXTURE__.failSessionCreate = true;
    });
    await sendBtn.click();
    await expect(composer).toHaveValue("New scope first draft");

    // Allow session.create -> atomic migration + accepted receipt clears draft and starts transcript
    await page.evaluate(() => {
      (window as unknown as { __HERMES_E2E_FIXTURE__: { failSessionCreate?: boolean } })
        .__HERMES_E2E_FIXTURE__.failSessionCreate = false;
    });
    await sendBtn.click();
    await expect(composer).toHaveValue("");
    await expect(page.locator(".transcript-list")).toContainText("New scope first draft");

    // 8. Settings -> Data lists OrphanedDraft with Copy, Export JSON, Delete
    await page.getByRole("button", { name: "管理连接" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const dataSection = settings.locator('[data-settings-section="data"]');
    await expect(dataSection).toContainText("本地 Draft");
    await expect(dataSection).toContainText("Recovered orphaned prompt text");
    await expect(dataSection).toContainText("trace.log");
    await expect(dataSection).toContainText("原 Session 已删除");

    await dataSection.getByRole("button", { name: "复制文本" }).click();
    await expect(page.locator('[aria-live="polite"]')).toContainText("已复制本地 Draft 文本");

    await dataSection.getByRole("button", { name: "导出 JSON" }).click();
    await expect(settings.getByTestId("orphaned-draft-export-preview")).toContainText(
      "Recovered orphaned prompt text",
    );

    await dataSection.getByRole("button", { name: "删除本地 Draft" }).click();
    await expect(settings.getByTestId("orphaned-drafts-empty")).toBeVisible();
  });

  test("Ticket #38: offline established Scope keeps local Draft editable while Send stays disabled", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              kind: "local",
              label: "Local Hermes",
              originDisplay: "127.0.0.1:47371",
              actual: "reconnecting",
              aggregateState: "reconnecting",
              degraded: true,
              profileExceptionCount: 0,
              latencyMs: null,
              nextRetryAt: "2026-11-23T08:05:00.000Z",
              isPrimary: true,
              isLastUsed: true,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              label: "Default",
              actual: "reconnecting",
              degraded: true,
              isException: false,
            },
          ],
          sessions: [],
          activeScope: { connectionId: "local", profileId: "default" },
          activeSessionId: null,
        },
        chatState: {
          lastActiveChat: { connectionId: "local", profileId: "default" },
          activeStatus: "offline",
          draftsByKey: {
            "new::local::default::draft-offline-1": {
              draftId: "draft-offline-1",
              scope: { connectionId: "local", profileId: "default" },
              text: "Offline saved local draft",
              attachments: [],
              contexts: [],
              composer: {},
              updatedAt: "2026-11-23T08:00:00.000Z",
              revision: 1,
              origin: { connectionId: "local", profileId: "default" },
            },
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const composer = page.locator("#composer-input");
    await expect(composer).toHaveValue("Offline saved local draft");
    await expect(composer).toBeEditable();
    await composer.fill("Offline saved local draft + updated locally");
    await expect(page.locator(".composer-hint")).toContainText("离线 · 仅保存本地 Draft");
    await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });

});

test.describe("Ticket #43 Turn & queue recovery", () => {
  test("Ticket #43: unknown turn pauses Session/queue, never auto-discards, and Discard sends admission_id + execution_generation", async ({
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
              originDisplay: "local://control-socket",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 4,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-43",
              title: "Recovery Session",
              preview: "Deploy the staging build",
              updatedAt: "2026-11-23T10:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-43" },
          activeSessionId: "sess-43",
        },
        chatState: {
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-43" },
          lastSessionByScope: { "local::default": "sess-43" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-43": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43",
            messages: [
              {
                messageId: "m-43-user",
                sessionId: "sess-43",
                role: "user",
                text: "Deploy the staging build",
                createdAt: "2026-11-23T10:00:00.000Z",
                turnId: "turn-lost-1",
                status: "complete",
              },
              {
                messageId: "m-43-assistant",
                sessionId: "sess-43",
                role: "assistant",
                text: "Deployment started...",
                createdAt: "2026-11-23T10:00:01.000Z",
                turnId: "turn-lost-1",
                streaming: false,
                status: "interrupted",
              },
            ],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: true,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        turnRecovery: {
          sessions: [
            {
              sessionId: "sess-43",
              activeTurnId: null,
              executionGeneration: 3,
              ownerGeneration: 2,
              unknownTurns: [
                {
                  admissionId: "adm-lost-1",
                  executionGeneration: 3,
                  turnId: "turn-lost-1",
                  originalInput: "Deploy the staging build",
                  lostReason: "owner_restarted",
                },
              ],
              queuedAdmissions: [
                {
                  admissionId: "adm-lost-follow",
                  submissionId: "sub-lost-follow",
                  text: "Follow-up after restart",
                  position: 1,
                  state: "queued",
                },
              ],
            },
          ],
          autoFollowerOnDiscard: { text: "Follow-up after restart", turnId: "turn-follower-1" },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const unknown = page.getByTestId("unknown-turn-card");
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText("Turn lost during restart");
    await expect(unknown).toContainText("Session 已暂停");
    await expect(unknown).toContainText("不会自动重发或继续后续排队");
    await expect(unknown.getByRole("button")).toHaveCount(1);
    await expect(unknown.getByRole("button", { name: "放弃丢失 Turn" })).toBeVisible();
    await expect(page.locator(".transcript-list")).toContainText("Deploy the staging build");
    await expect(page.getByTestId("queue-item-adm-lost-follow")).toBeVisible();

    await page.waitForTimeout(400);
    const beforeDiscard = await page.evaluate(
      () =>
        (window as unknown as { __HERMES_E2E_COUNTS__: { resolveUnknownCalls: number } })
          .__HERMES_E2E_COUNTS__.resolveUnknownCalls,
    );
    expect(beforeDiscard).toBe(0);

    await unknown.getByText("查看详情").click();
    await expect(unknown).toContainText("adm-lost-1");
    await expect(unknown).toContainText("Execution 代际");
    await expect(unknown).toContainText("执行进程已重启");
    await expect(unknown).toContainText("Deploy the staging build");

    await unknown.getByRole("button", { name: "放弃丢失 Turn" }).click();
    await expect(unknown).toHaveCount(0);
    const discardPayloads = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: {
            resolveUnknownPayloads: Array<{
              admission_id: string;
              execution_generation: number;
            }>;
          };
        }).__HERMES_E2E_COUNTS__.resolveUnknownPayloads,
    );
    expect(discardPayloads).toEqual([{ admission_id: "adm-lost-1", execution_generation: 3 }]);
    await expect(page.getByTestId("queue-item-adm-lost-follow")).toContainText("已开始执行");
    await expect(page.locator(".transcript-list")).toContainText("Deploy the staging build");
  });

  test("Ticket #43: Stop reaches at most 'stopping', ACK loss becomes cancel_outcome_unknown, and never auto-resends across generations", async ({
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
              originDisplay: "local://control-socket",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 4,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-43-stop",
              title: "Stop Session",
              preview: "Long running turn",
              updatedAt: "2026-11-23T10:10:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-stop-1",
              status: "running",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43-stop",
          },
          activeSessionId: "sess-43-stop",
        },
        chatState: {
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43-stop",
          },
          lastSessionByScope: { "local::default": "sess-43-stop" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-43-stop": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43-stop",
            messages: [
              {
                messageId: "m-43-stop",
                sessionId: "sess-43-stop",
                role: "assistant",
                text: "Still running the migration",
                createdAt: "2026-11-23T10:10:00.000Z",
                turnId: "turn-stop-1",
                streaming: true,
                status: "streaming",
              },
            ],
            activeTurnId: "turn-stop-1",
            turnStopping: false,
            executionGeneration: 4,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: true,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        turnRecovery: {
          sessions: [
            {
              sessionId: "sess-43-stop",
              activeTurnId: "turn-stop-1",
              executionGeneration: 4,
              ownerGeneration: 2,
            },
          ],
          stopMode: "ack_loss",
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: "停止 Turn" }).click();
    const stopUnknown = page.getByTestId("stop-outcome-unknown-card");
    await expect(stopUnknown).toBeVisible();
    await expect(stopUnknown).toContainText("停止结果待确认");
    await expect(stopUnknown).toContainText("不会跨代际自动重发");
    await expect(page.locator(".transcript-list")).toContainText("Still running the migration");
    await expect(page.getByRole("button", { name: "已停止" })).toHaveCount(0);

    await page.waitForTimeout(500);
    const stopPayloads = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: {
            promptsStopCalls: number;
            stopPayloads: Array<{ turnId?: string; executionGeneration?: number }>;
          };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(stopPayloads.promptsStopCalls).toBe(1);
    expect(stopPayloads.stopPayloads).toEqual([
      { turnId: "turn-stop-1", executionGeneration: 4 },
    ]);
  });

  test("Ticket #43: queue shows only admitted receipt, reconciles delivery_unknown with the same submissionId, cancels by admissionId, and steer failure requires an explicit fallback", async ({
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
              originDisplay: "local://control-socket",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 4,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-43-queue",
              title: "Queue Session",
              preview: "Running and queued",
              updatedAt: "2026-11-23T10:20:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-queue-1",
              status: "running",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43-queue",
          },
          activeSessionId: "sess-43-queue",
        },
        chatState: {
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43-queue",
          },
          lastSessionByScope: { "local::default": "sess-43-queue" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-43-queue": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-43-queue",
            messages: [
              {
                messageId: "m-43-queue",
                sessionId: "sess-43-queue",
                role: "assistant",
                text: "Working on the release",
                createdAt: "2026-11-23T10:20:00.000Z",
                turnId: "turn-queue-1",
                streaming: true,
                status: "streaming",
              },
            ],
            activeTurnId: "turn-queue-1",
            turnStopping: false,
            executionGeneration: 5,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: true,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        turnRecovery: {
          sessions: [
            {
              sessionId: "sess-43-queue",
              activeTurnId: "turn-queue-1",
              executionGeneration: 5,
              ownerGeneration: 2,
            },
          ],
          queueAckMode: "ack_loss_unadmitted",
          steerMode: "turn_finished",
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const composer = page.locator("#composer-input");
    await composer.fill("Queued receipt prompt");
    await page.getByRole("button", { name: "加入排队" }).click();

    const deliveryUnknown = page.getByTestId("queue-delivery-unknown");
    await expect(deliveryUnknown).toBeVisible();
    await expect(page.getByTestId("queue-card")).toHaveCount(0);
    const firstSubmissionId = await deliveryUnknown.locator("code").first().innerText();
    await expect(deliveryUnknown).toContainText("未收到 Gateway 排队确认");

    await deliveryUnknown.getByRole("button", { name: "检查回执" }).click();
    await expect(deliveryUnknown.getByRole("button", { name: "按原 ID 重试排队" })).toBeVisible();
    await deliveryUnknown.getByRole("button", { name: "按原 ID 重试排队" }).click();

    const queueCard = page.getByTestId("queue-card");
    await expect(queueCard).toBeVisible();
    await expect(queueCard.locator(".turn-recovery-row")).toHaveCount(1);
    await expect(queueCard).toContainText("Queued receipt prompt");
    const queueCounts = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: { queueSubmittedIds: string[] };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(queueCounts.queueSubmittedIds).toHaveLength(2);
    expect(queueCounts.queueSubmittedIds[0]).toBe(firstSubmissionId);
    expect(queueCounts.queueSubmittedIds[1]).toBe(firstSubmissionId);

    await page.evaluate(() => {
      const fixture = (window as unknown as { __HERMES_E2E_FIXTURE__: { turnRecovery: { queueCancelOutcome: string } } })
        .__HERMES_E2E_FIXTURE__;
      fixture.turnRecovery.queueCancelOutcome = "already_started";
    });
    await queueCard.getByRole("button", { name: "取消排队" }).click();
    await expect(queueCard).toContainText("已开始执行");
    await expect(queueCard.getByRole("button", { name: "取消排队" })).toHaveCount(0);

    await page.locator("#turn-steer-input").fill("Prefer staging only");
    await page.getByRole("button", { name: "发送纠偏" }).click();
    const fallback = page.getByTestId("steer-fallback-card");
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText("纠偏未送达当前 Turn");
    await expect(fallback).toContainText("Turn 已结束");
    await expect(fallback.getByRole("button")).toHaveCount(3);
    const countsBeforeFallback = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: {
            promptsSendCalls: number;
            steerPayloads: Array<{ turnId?: string; executionGeneration?: number; text?: string }>;
          };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(countsBeforeFallback.promptsSendCalls).toBe(0);
    expect(countsBeforeFallback.steerPayloads).toEqual([
      { turnId: "turn-queue-1", executionGeneration: 5, text: "Prefer staging only" },
    ]);

    await fallback.getByRole("button", { name: "作为新 Turn 发送" }).click();
    await expect(fallback).toHaveCount(0);
    const countsAfterFallback = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: { promptsSendCalls: number };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(countsAfterFallback.promptsSendCalls).toBe(1);
  });
});

test.describe("Ticket #44 read-only domains, Cron & capability completeness", () => {
  const SERVED_WITH_CRON = [
    "prompt.submit",
    "prompt.cancel",
    "session.steer",
    "approval.list",
    "session.create",
    "session.list",
    "session.resume",
    "profiles.list",
    "config.get",
    "config.update",
    "session.info",
    "messaging.status",
    "cron.status",
    "cron.submit",
    "cron.cancel",
    "cron.recover",
  ];

  test("Ticket #44 & E2E-FAKE-01 & E2E-KB-04: Memory and Messaging are read-only, Cron submits/cancels/recovers, tabs support arrows/Home/End/IME, and 17 reachable / 4 deferred stays disclosed", async ({
    page,
  }) => {
    await page.addInitScript(
      (servedMethods) => {
        (window as unknown as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
          fleet: {
            connections: [
              {
                connectionId: "local",
                kind: "local",
                label: "This device",
                originDisplay: "local://control-socket",
                actual: "ready",
                aggregateState: "ready",
                degraded: false,
                latencyMs: 4,
                nextRetryAt: null,
              },
            ],
            profiles: [
              {
                connectionId: "local",
                profileId: "default",
                displayName: "Default",
                handle: "default",
                isDefault: true,
                actual: "ready",
                degraded: false,
              },
            ],
            sessions: [
              {
                connectionId: "local",
                profileId: "default",
                sessionId: "sess-44",
                title: "Capability Session",
                preview: "Ready",
                updatedAt: "2026-11-23T11:00:00.000Z",
                pinned: false,
                unreadCount: 0,
                needsInput: false,
                activeTurnId: null,
                status: "idle",
              },
            ],
            activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-44" },
            activeSessionId: "sess-44",
          },
          chatState: {
            lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-44" },
            lastSessionByScope: { "local::default": "sess-44" },
            activeStatus: "ready",
            sessionSummaries: {},
            missingSession: null,
            routeBanner: null,
          },
          transcripts: {
            "local::default::sess-44": {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-44",
              messages: [
                {
                  messageId: "m-44",
                  sessionId: "sess-44",
                  role: "assistant",
                  text: "Capability inventory ready",
                  createdAt: "2026-11-23T11:00:00.000Z",
                  status: "complete",
                },
              ],
              activeTurnId: null,
              turnStopping: false,
              chatAvailable: true,
              supportedActions: {
                promptSubmit: true,
                promptCancel: true,
                promptSteer: true,
                sessionCreate: true,
                sessionResume: true,
              },
              snapshotSeq: 0,
            },
          },
          capabilities: {
            servedMethods,
            memory: {
              outcome: "ok",
              sourceMethod: "session.info",
              rawPayload: {
                total_tokens: 18400,
                max_tokens: 128000,
                sections: [
                  { id: "system", label: "系统提示词", tokens: 4000, percentage: 21.7 },
                  { id: "tools", label: "工具结果", tokens: 14400, percentage: 78.3 },
                ],
                notes: ["Memory 预算健康"],
              },
            },
            messaging: {
              outcome: "ok",
              rawPayload: {
                connectors: [
                  {
                    id: "slack",
                    platform: "Slack",
                    label: "Slack",
                    status: "connected",
                    gateway_id: "gw-slack",
                    detail: "已连接工作区",
                  },
                  {
                    id: "email",
                    platform: "Email",
                    label: "Email",
                    status: "disconnected",
                  },
                ],
              },
            },
            cron: {
              outcome: "ok",
              rawPayload: {
                jobs: [
                  {
                    id: "cron-daily",
                    name: "Daily digest",
                    schedule: "0 9 * * *",
                    prompt: "Summarize the overnight build",
                    status: "scheduled",
                    next_run_at: "2026-11-24T01:00:00.000Z",
                  },
                ],
                recent_run_summary: "今日 09:00 成功",
              },
            },
          },
        };
      },
      SERVED_WITH_CRON,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const capabilitiesDrawer = page.getByRole("dialog", { name: "能力目录" });
    await expect(capabilitiesDrawer).toBeVisible();
    await expect(capabilitiesDrawer.getByTestId("capabilities-counts-summary")).toContainText(
      "能力 17 可达 4 延期",
    );

    // Memory: session.context_breakdown missing, session.info fallback remains read-only and actionable
    await expect(capabilitiesDrawer.getByTestId("cap-action-memory-inspect")).toBeEnabled();
    await capabilitiesDrawer.getByTestId("cap-action-memory-inspect").click();
    const inspect = page.getByRole("dialog", { name: "只读域与 Cron 管理" });
    await expect(inspect).toBeVisible();
    await expect(inspect.getByTestId("memory-sections").locator("li")).toHaveCount(2);
    await expect(inspect.getByTestId("memory-sections")).toContainText("系统提示词");
    await expect(inspect).toContainText("18400 / 128000");
    await expect(inspect.getByTestId("memory-state-notice")).toHaveCount(0);
    await expect(inspect.getByRole("button", { name: /编辑|删除|关闭 Memory|开启 Memory/ })).toHaveCount(0);

    const memoryTab = inspect.getByRole("tab", { name: "Memory 上下文" });
    const messagingTab = inspect.getByRole("tab", { name: "Messaging 通道" });
    const cronTab = inspect.getByRole("tab", { name: "Cron 定时任务" });
    await memoryTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(messagingTab).toBeFocused();
    await expect(messagingTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(cronTab).toBeFocused();
    await page.keyboard.press("Home");
    await expect(memoryTab).toBeFocused();
    await inspect.getByRole("tablist").evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, bubbles: true }),
      );
    });
    await expect(memoryTab).toBeFocused();

    // Messaging: connector state + attribution + official docs only; never a connect-account OAuth CTA
    await messagingTab.click();
    await expect(inspect.getByTestId("messaging-connectors").locator("li")).toHaveCount(2);
    await expect(inspect.getByTestId("messaging-connectors")).toContainText("Slack");
    await expect(inspect.getByTestId("messaging-connectors")).toContainText("已连接");
    await expect(inspect.getByTestId("messaging-attribution-slack")).toContainText("外部提供");
    await expect(inspect.getByTestId("messaging-attribution-slack")).toHaveAttribute(
      "data-attribution-origin",
      "external",
    );
    await expect(inspect.getByRole("button", { name: /连接账号|OAuth|授权/ })).toHaveCount(0);
    await expect(inspect.getByRole("button", { name: "打开官方文档" })).toBeVisible();

    // Cron: native submit/cancel/recover, Routines folded in, no fake task buttons when unsupported
    await inspect.getByRole("tab", { name: "Cron 定时任务" }).click();
    await expect(inspect.getByTestId("cron-jobs")).toContainText("Daily digest");
    await expect(inspect).toContainText("Routines 已折叠归入 Cron");
    await inspect.getByLabel("任务名称").fill("Nightly backup");
    await inspect.getByLabel("Cron 表达式").fill("0 2 * * *");
    await inspect.getByLabel("执行提示词").fill("Run the nightly backup");
    await inspect.getByRole("button", { name: "新建任务" }).click();
    await expect(inspect.getByTestId("cron-jobs")).toContainText("Nightly backup");
    const cronCountsAfterSubmit = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: { cronSubmitCalls: number };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(cronCountsAfterSubmit.cronSubmitCalls).toBe(1);

    const dailyJob = inspect.getByTestId("cron-job-cron-daily");
    await dailyJob.getByRole("button", { name: "取消任务" }).click();
    await expect(dailyJob).toContainText("已取消");
    await dailyJob.getByRole("button", { name: "恢复任务" }).click();
    await expect(dailyJob).toContainText("已调度");
    const cronCounts = await page.evaluate(
      () =>
        (window as unknown as {
          __HERMES_E2E_COUNTS__: { cronCancelCalls: number; cronRecoverCalls: number };
        }).__HERMES_E2E_COUNTS__,
    );
    expect(cronCounts.cronCancelCalls).toBe(1);
    expect(cronCounts.cronRecoverCalls).toBe(1);

    await page.keyboard.press("Escape");
    await expect(inspect).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(capabilitiesDrawer).toBeHidden();

    // After the fallback probe, the domain/action stay read_only so the drawer entry remains enabled.
    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const refreshedCapabilities = page.getByRole("dialog", { name: "能力目录" });
    await expect(refreshedCapabilities.getByTestId("cap-domain-memory")).toContainText("只读");
    await expect(
      refreshedCapabilities.getByTestId("cap-action-memory-inspect"),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(refreshedCapabilities).toBeHidden();
  });

  test("Ticket #44 & E2E-FAKE-01: Cron without submit stays read-only, and missing cron.status exposes no fake create button", async ({
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
              originDisplay: "local://control-socket",
              actual: "ready",
              aggregateState: "ready",
              degraded: false,
              latencyMs: 4,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
              degraded: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-44-ro",
              title: "Read-only Cron",
              preview: "Ready",
              updatedAt: "2026-11-23T11:10:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-44-ro",
          },
          activeSessionId: "sess-44-ro",
        },
        chatState: {
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-44-ro",
          },
          lastSessionByScope: { "local::default": "sess-44-ro" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-44-ro": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-44-ro",
            messages: [
              {
                messageId: "m-44-ro",
                sessionId: "sess-44-ro",
                role: "assistant",
                text: "Read-only inventory ready",
                createdAt: "2026-11-23T11:10:00.000Z",
                status: "complete",
              },
            ],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: true,
            supportedActions: {
              promptSubmit: true,
              promptCancel: true,
              promptSteer: true,
              sessionCreate: true,
              sessionResume: true,
            },
            snapshotSeq: 0,
          },
        },
        capabilities: {
          servedMethods: [
            "prompt.submit",
            "prompt.cancel",
            "session.create",
            "session.list",
            "session.resume",
            "profiles.list",
            "cron.status",
          ],
          cron: {
            outcome: "ok",
            rawPayload: {
              jobs: [
                {
                  id: "cron-read-only",
                  name: "Read-only job",
                  schedule: "0 6 * * *",
                  prompt: "List the corpus",
                  status: "scheduled",
                },
              ],
            },
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const capabilitiesDrawer = page.getByRole("dialog", { name: "能力目录" });
    await capabilitiesDrawer.getByTestId("cap-action-cron-status").click();
    const inspect = page.getByRole("dialog", { name: "只读域与 Cron 管理" });
    await expect(inspect.getByTestId("cron-read-only-notice")).toContainText(
      "已隐藏新建任务按钮",
    );
    await expect(inspect.getByTestId("cron-jobs")).toContainText("Read-only job");
    await expect(inspect.getByRole("button", { name: "新建任务" })).toHaveCount(0);
    await expect(inspect.getByRole("button", { name: /新建|添加 Cron|创建任务/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(inspect).toBeHidden();
  });
});
