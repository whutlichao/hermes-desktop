import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function collectTargetSizeIssues(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const selector = [
      "button:not([disabled])",
      "a[href]",
      "select:not([disabled])",
      'input:not([disabled]):not([type="hidden"])',
      "textarea:not([disabled])",
      '[role="button"]',
      '[role="option"]',
    ].join(", ");
    const issues: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (element.closest("[inert]")) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === "none" ||
        style.visibility === "hidden"
      ) {
        continue;
      }
      const text = (element.innerText || element.textContent || "").trim();
      const hasIcon = Boolean(element.querySelector("svg"));
      const iconOnly = text.length === 0 && hasIcon;
      const critical =
        element.classList.contains("button") ||
        element.classList.contains("sidebar-new-btn") ||
        element.classList.contains("icon-button") ||
        /approval-choice|approval-inspect|composer-send|composer-stop|send-message|workspace-terminal-(open|send|close)/.test(
          element.getAttribute("data-testid") ?? "",
        );
      const minimum = critical ? 32 : iconOnly ? 28 : 24;
      if (rect.width + 0.01 < minimum || rect.height + 0.01 < minimum) {
        const label =
          element.getAttribute("aria-label") ||
          element.getAttribute("data-testid") ||
          text.slice(0, 48) ||
          element.tagName;
        issues.push(
          `${label}: ${Math.round(rect.width * 10) / 10}x${Math.round(rect.height * 10) / 10} < ${minimum}x${minimum}`,
        );
      }
    }
    return issues;
  });
}

async function collectFocusReachabilityIssues(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const selector = [
      "button:not([disabled])",
      "a[href]",
      "select:not([disabled])",
      'input:not([disabled]):not([type="hidden"])',
      "textarea:not([disabled])",
      '[role="button"]',
    ].join(", ");
    const issues: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (element.closest("[inert]")) continue;
      const style = getComputedStyle(element);
      const before = element.getBoundingClientRect();
      if (
        before.width <= 0 ||
        before.height <= 0 ||
        style.display === "none" ||
        style.visibility === "hidden"
      ) {
        continue;
      }
      const label =
        element.getAttribute("aria-label") ||
        element.getAttribute("data-testid") ||
        (element.innerText || element.textContent || "").trim().slice(0, 48) ||
        element.tagName;
      element.focus();
      if (document.activeElement !== element) {
        issues.push(`${label}: not focusable`);
        continue;
      }
      const rect = element.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (
        rect.top < -1 ||
        rect.left < -1 ||
        rect.bottom > window.innerHeight + 1 ||
        rect.right > window.innerWidth + 1
      ) {
        issues.push(
          `${label}: clipped outside viewport (${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)})`,
        );
      }
      if (!hit || !(hit === element || element.contains(hit) || hit.contains(element))) {
        issues.push(`${label}: obscured or not hit-testable`);
      }
    }
    return issues;
  });
}

test.describe("E2E-A11Y-01 Quiet Relay accessibility baseline", () => {
  test("E2E-A11Y-01: passes axe-core serious/critical = 0 on shell, palette, settings, capabilities, workspace, and 1280 popover", async ({
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
    await expect(page.locator('[aria-live="assertive"]')).toBeAttached();

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

    // Onboarding empty state: add a Remote/SSH connection through Settings
    await page.getByRole("button", { name: "添加 SSH" }).click();
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.getByLabel("SSH 主机")).toBeVisible();
    await checkAxe("settings ssh add form from onboarding");
    await page.keyboard.press("Escape");
    await expect(settingsDialog).toBeHidden();
  });

  test("E2E-A11Y-02: passes axe-core serious/critical = 0 on populated session rail, route banner, 1280 popover, and session_missing recovery card", async ({
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

  test("E2E-A11Y-03: passes axe-core serious/critical = 0 on populated Workspace Artifacts, Annotations, Files, Git, Agents, and Terminal tabs", async ({
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
              sessionId: "sess-a11y",
              title: "Workspace A11y Session",
              preview: "Checking tabs",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-a11y" },
          activeSessionId: "sess-a11y",
        },
        artifacts: {
          "sess-a11y": [
            {
              artifactId: "art-a11y",
              title: "A11y Artifact",
              kind: "markdown",
              content: "# Accessible Artifact\nContent body",
              version: 2,
              hash: "hash-v2",
              updatedAt: "2026-11-23T08:00:00.000Z",
              stale: true,
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
              relativePath: "src/index.ts",
              name: "index.ts",
              kind: "file",
              parentPath: "src",
              hash: "h1",
              content: "export const ready = true;",
            },
          ],
        },
        agents: {
          "sess-a11y": [
            {
              agentId: "sub-a11y",
              name: "A11y Subagent",
              status: "running",
              summary: "Checking accessibility",
              updatedAt: "2026-11-23T08:00:00.000Z",
            },
          ],
        },
        subagentTails: {
          "sess-a11y::sub-a11y": ["line 1: starting", "line 2: running checks"],
        },
        checkpoints: {
          "sess-a11y": [
            {
              checkpointId: "ckpt-a11y",
              title: "Initial A11y Checkpoint",
              summary: "Snapshot before edits",
              createdAt: "2026-11-23T08:00:00.000Z",
            },
          ],
        },
        checkpointDiffs: {
          "sess-a11y::ckpt-a11y": "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;",
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.locator(".route-strip").getByRole("button", { name: /Workspace/ }).click();
    const drawer = page.getByRole("complementary", { name: "Workspace" });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("标注内容").fill("Accessible annotation");
    await drawer.getByRole("button", { name: "添加标注到 Draft" }).click();
    await checkAxe("populated workspace artifacts + annotations");

    await drawer.getByRole("tab", { name: "Files" }).click();
    await drawer.getByTestId("workspace-dir-src").click();
    await drawer.getByTestId("workspace-file-src/index.ts").click();
    await checkAxe("populated workspace files preview");

    await drawer.getByRole("tab", { name: "Git" }).click();
    await checkAxe("workspace git tab");

    await drawer.getByRole("tab", { name: "Agents" }).click();
    await expect(drawer.getByTestId("workspace-agent-item-sub-a11y")).toBeVisible();
    await checkAxe("workspace agents tab");

    await drawer.getByRole("tab", { name: "Checkpoints" }).click();
    await expect(drawer.getByTestId("workspace-checkpoint-item-ckpt-a11y")).toBeVisible();
    await drawer.getByTestId("workspace-checkpoint-restore-btn").click();
    await expect(drawer.getByTestId("workspace-checkpoint-confirm-card")).toBeVisible();
    await checkAxe("workspace checkpoints tab + restore confirmation");

    await drawer.getByRole("tab", { name: "Terminal" }).click();
    await checkAxe("workspace terminal tab");
  });

  test("E2E-A11Y-04: passes axe-core serious/critical = 0 on Extensions drawer, Settings Plugins section, and transcript attribution/approval cards", async ({
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
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a11y-42",
              title: "Extensions A11y Session",
              preview: "Checking a11y",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-a11y-42" },
          activeSessionId: "sess-a11y-42",
        },
        transcripts: {
          "local::default::sess-a11y-42": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-a11y-42",
            messages: [
              {
                messageId: "m-a11y-1",
                sessionId: "sess-a11y-42",
                role: "assistant",
                text: "Testing attribution accessibility.",
                createdAt: "2026-11-23T08:00:00.000Z",
                toolRows: [
                  {
                    toolCallId: "tc-a11y-ext",
                    name: "mcp_read",
                    status: "completed",
                    attribution: {
                      origin: "external",
                      provider: { kind: "mcp", id: "filesystem", label: "MCP · filesystem" },
                      sourceLabel: "外部提供 · MCP · filesystem",
                      accessibleLabel: "外部提供 · MCP · filesystem",
                    },
                  },
                  {
                    toolCallId: "tc-a11y-unk",
                    name: "unknown_tool",
                    status: "completed",
                  },
                ],
              },
            ],
            pendingApprovals: [
              {
                approvalId: "appr-a11y-1",
                sessionId: "sess-a11y-42",
                toolName: "git_commit_external",
                summary: "Approval attribution a11y check",
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
                version: "1.4.2",
                enabled: true,
                status: "loaded",
                tool_count: 2,
                hook_count: 1,
                command_count: 3,
              },
            ],
          },
          skills: {
            outcome: "ok",
            items: [{ id: "git-review", name: "git-review", source: "plugin", plugin_name: "git-helper" }],
          },
          tools: {
            outcome: "ok",
            items: [{ id: "fs-read", name: "read_file", toolset: "filesystem", origin: "builtin" }],
          },
          mcp: {
            outcome: "ok",
            items: [{ id: "filesystem", name: "filesystem", status: "connected", tool_count: 4 }],
          },
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("pending-approvals-section")).toBeVisible();
    await checkAxe("transcript with tool attribution and pending approvals");

    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    await page.getByTestId("capabilities-open-extensions-drawer").click();
    const extDrawer = page.getByRole("dialog", { name: "扩展清单（只读）" });
    await expect(extDrawer).toBeVisible();
    await checkAxe("extensions drawer plugins tab");

    await extDrawer.getByTestId("ext-drawer-tab-skills").click();
    await checkAxe("extensions drawer skills tab");

    await extDrawer.getByTestId("ext-drawer-tab-tools").click();
    await checkAxe("extensions drawer tools tab");

    await extDrawer.getByTestId("ext-drawer-tab-mcp").click();
    await checkAxe("extensions drawer mcp tab");

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await checkAxe("settings modal with plugins inventory");
  });


  test("E2E-A11Y-02 & E2E-A11Y-04: passes axe-core serious/critical = 0 on background attention badges, mark-read action, route attention chips, and 1280 popover (Ticket #37)", async ({
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
              sessionId: "sess-active",
              title: "Active Session",
              preview: "Ready",
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
              sessionId: "sess-unread-input",
              title: "Needs Attention Session",
              preview: "Waiting decision",
              updatedAt: "2026-11-23T09:01:00.000Z",
              pinned: true,
              pinnedReasons: { pendingInput: true, unread: true },
              unreadCount: 3,
              needsInput: true,
              activeTurnId: "t-1",
              status: "running",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-active" },
          activeSessionId: "sess-active",
        },
        transcripts: {
          "local::default::sess-active": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-active",
            messages: [
              {
                messageId: "m-1",
                sessionId: "sess-active",
                role: "assistant",
                text: "Foreground thread",
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
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.getByTestId("session-mark-read-sess-unread-input")).toBeVisible();
    await expect(page.getByTestId("route-strip-attention-needs-input")).toBeVisible();
    await expect(page.getByTestId("route-strip-attention-unread")).toBeVisible();
    await checkAxe("1440 rail + route strip attention badges");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /Sessions\s+2/ }).click();
    await expect(page.getByRole("dialog", { name: "Sessions" })).toBeVisible();
    await checkAxe("1280 popover with attention badges");
    await page.keyboard.press("Escape");

    // Workspace Git deep links & Terminal running + busy inline confirmation a11y
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: /Workspace/ }).click();
    const workspace = page.getByRole("complementary", { name: "Workspace" });
    await expect(workspace).toBeVisible();

    await workspace.getByRole("tab", { name: "Git" }).click();
    await expect(workspace.getByTestId("workspace-git-panel")).toBeVisible();
    await checkAxe("workspace Git deep links tab");

    await workspace.getByRole("tab", { name: "Terminal" }).click();
    await workspace.getByTestId("workspace-terminal-open-btn").click();
    await expect(workspace.getByTestId("workspace-terminal-status")).toContainText("运行中");
    await workspace.getByTestId("workspace-terminal-input").fill("sleep 30");
    await workspace.getByTestId("workspace-terminal-send-btn").click();
    await workspace.getByTestId("workspace-terminal-close-btn").click();
    await expect(workspace.getByTestId("workspace-terminal-busy-confirm")).toBeVisible();
    await checkAxe("workspace Terminal tab with inline busy close confirmation");
  });


  test("E2E-A11Y-05: Ticket #39 passes axe-core serious/critical = 0 on actionable, context_incomplete, orphaned Approval cards, rail badge, and inspect modal", async ({
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
              sessionId: "sess-a11y-apr",
              title: "Approval A11y Session",
              preview: "Waiting for decision",
              updatedAt: "2026-11-23T09:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-a11y-1",
              status: "running",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a11y-bg",
              title: "Background Badge Session",
              preview: "Background pending",
              updatedAt: "2026-11-23T08:55:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-a11y-bg",
              status: "running",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-a11y-apr" },
          activeSessionId: "sess-a11y-apr",
        },
        approvals: [
          {
            gateway: {
              approvalId: "apr-a11y-sudo",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a11y-apr",
              turnId: "turn-a11y-1",
              executionGeneration: 1,
              command: "sudo systemctl status hermes",
              description: "Inspect service status",
              choices: ["once", "always", "deny"],
              persistentGrant: {
                pattern: "sudo systemctl status *",
                scope: "local/default",
                revokeHint: "hermes approvals revoke apr-a11y-sudo",
              },
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Approval A11y Session",
              cwd: "/srv/hermes/app",
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
          {
            gateway: {
              approvalId: "apr-a11y-incomplete",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a11y-apr",
              turnId: "turn-a11y-2",
              executionGeneration: 1,
              command: "rm -rf /tmp/scratch",
              description: "Destructive command without cwd",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Approval A11y Session",
              cwd: null,
              ownerGeneration: 1,
              authorityEpoch: 1,
              connectionOnline: true,
            },
          },
          {
            gateway: {
              approvalId: "apr-a11y-bg",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a11y-bg",
              turnId: "turn-a1y-bg",
              executionGeneration: 1,
              command: "ls -la",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Background Badge Session",
              cwd: "/srv/hermes/bg",
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

    await expect(page.locator('[data-testid="approval-card"]')).toHaveCount(2);
    await expect(page.getByTestId("session-needs-input-badge")).toHaveCount(2);
    await checkAxe("approval cards + needs-input badge");

    await page.locator('[data-testid="approval-inspect-btn"]').first().click();
    await expect(page.getByRole("dialog", { name: "Approval 只读详情" })).toBeVisible();
    await checkAxe("approval inspect modal");
  });
});

test.describe("E2E-A11Y-01 read-only domains", () => {
  test("E2E-A11Y-01: Memory, Messaging, and Cron drawers pass axe-core serious/critical = 0", async ({
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
              sessionId: "sess-a11y-domains",
              title: "Domain A11y",
              preview: "Ready",
              updatedAt: "2026-11-23T12:20:00.000Z",
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
            sessionId: "sess-a11y-domains",
          },
          activeSessionId: "sess-a11y-domains",
        },
        chatState: {
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-a11y-domains",
          },
          lastSessionByScope: { "local::default": "sess-a11y-domains" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-a11y-domains": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-a11y-domains",
            messages: [
              {
                messageId: "m-a11y-domains",
                sessionId: "sess-a11y-domains",
                role: "assistant",
                text: "Domain inventory ready",
                createdAt: "2026-11-23T12:20:00.000Z",
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
          memory: {
            outcome: "ok",
            rawPayload: {
              total_tokens: 1200,
              max_tokens: 128000,
              sections: [{ id: "system", label: "系统提示词", tokens: 1200 }],
            },
          },
          messaging: {
            outcome: "ok",
            rawPayload: {
              connectors: [
                { id: "slack", platform: "Slack", label: "Slack", status: "connected" },
              ],
            },
          },
          cron: {
            outcome: "ok",
            rawPayload: {
              jobs: [
                {
                  id: "cron-a11y",
                  name: "A11y job",
                  schedule: "0 7 * * *",
                  prompt: "Check accessibility",
                  status: "scheduled",
                },
              ],
            },
          },
        },
      };
    });

    const checkAxe = async (label: string) => {
      const results = await new AxeBuilder({ page }).analyze();
      const severe = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(severe, `axe serious/critical violations on ${label}`).toEqual([]);
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    await page.getByTestId("cap-action-memory-inspect").click();
    const inspect = page.getByRole("dialog", { name: "只读域与 Cron 管理" });
    await expect(inspect).toBeVisible();
    await checkAxe("domain inspect memory");
    await inspect.getByRole("tab", { name: "Messaging 通道" }).click();
    await checkAxe("domain inspect messaging");
    await inspect.getByRole("tab", { name: "Cron 定时任务" }).click();
    await checkAxe("domain inspect cron");
  });
});

test.describe("E2E-MOTION-01 / E2E-ZOOM-01 / E2E-CONTRAST-01", () => {
  test("E2E-MOTION-01: reduced motion removes animation and exposes static streaming status text", async ({
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
              sessionId: "sess-motion",
              title: "Streaming Session",
              preview: "Working",
              updatedAt: "2026-11-23T12:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-motion-1",
              status: "running",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-motion",
          },
          activeSessionId: "sess-motion",
        },
        chatState: {
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-motion",
          },
          lastSessionByScope: { "local::default": "sess-motion" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-motion": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-motion",
            messages: [
              {
                messageId: "m-motion",
                sessionId: "sess-motion",
                role: "assistant",
                text: "Generating the response",
                createdAt: "2026-11-23T12:00:00.000Z",
                turnId: "turn-motion-1",
                streaming: true,
                status: "streaming",
              },
            ],
            activeTurnId: "turn-motion-1",
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
      };
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.locator(".transcript-list").getByText("正在输出")).toBeVisible();
    await expect(page.locator(".streaming-caret, .spinner, .skeleton, .pulse").first()).toHaveCount(0);

    const motion = await page.evaluate(() => {
      const animated = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .map((el) => {
          const style = getComputedStyle(el);
          return {
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            transitionDuration: style.transitionDuration,
            scrollBehavior: style.scrollBehavior,
          };
        })
        .filter(
          (item) =>
            item.animationName !== "none" ||
            Number.parseFloat(item.transitionDuration) > 0 ||
            Number.parseFloat(item.animationDuration) > 0 ||
            item.scrollBehavior === "smooth",
        );
      return animated;
    });
    expect(motion).toEqual([]);
  });

  test("E2E-ZOOM-01: 200% root font keeps 1440/1280/1120 free of page-level horizontal overflow and preserves the 720px column", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const longUrl = `https://example.com/reports/${"a".repeat(220)}`;
      const longPath = `/Users/example/workspaces/${"deep-segment/".repeat(20)}artifact.json`;
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
              sessionId: "sess-zoom",
              title: "Zoom Session",
              preview: "Long content",
              updatedAt: "2026-11-23T12:10:00.000Z",
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
            sessionId: "sess-zoom",
          },
          activeSessionId: "sess-zoom",
        },
        chatState: {
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-zoom",
          },
          lastSessionByScope: { "local::default": "sess-zoom" },
          activeStatus: "ready",
          sessionSummaries: {},
          missingSession: null,
          routeBanner: null,
        },
        transcripts: {
          "local::default::sess-zoom": {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-zoom",
            messages: [
              {
                messageId: "m-zoom-1",
                sessionId: "sess-zoom",
                role: "assistant",
                text: `Report URL: ${longUrl}`,
                createdAt: "2026-11-23T12:10:00.000Z",
                status: "complete",
              },
              {
                messageId: "m-zoom-2",
                sessionId: "sess-zoom",
                role: "assistant",
                text: `Artifact path: ${longPath}`,
                createdAt: "2026-11-23T12:10:01.000Z",
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
        approvals: [
          {
            gateway: {
              approvalId: "apr-zoom",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-zoom",
              turnId: "turn-zoom",
              executionGeneration: 1,
              command: `cat ${longPath}`,
              description: "Verify long-path wrapping in Approval context",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Zoom Session",
              cwd: longPath,
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
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "26px";
    });

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 1120, height: 700 },
    ]) {
      await page.setViewportSize(viewport);

      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const column = document.querySelector<HTMLElement>(".thread-column");
              const root = getComputedStyle(document.documentElement);
              const heading = document.querySelector<HTMLElement>(
                ".transcript-message, .empty-relay-card h1",
              );
              const pageOverflow =
                document.documentElement.scrollWidth > window.innerWidth ||
                document.body.scrollWidth > document.body.clientWidth;
              const columnWidth = column?.getBoundingClientRect().width ?? 0;
              return {
                rootFont: root.fontSize,
                pageOverflow,
                columnReady: columnWidth > 680 && columnWidth <= 721,
                headingReady:
                  heading !== null &&
                  Number.parseFloat(getComputedStyle(heading).fontSize) >= 24,
                railVisible: Boolean(document.querySelector("nav.sidebar")),
              };
            }),
          { message: `layout settles at ${viewport.width}x${viewport.height}` },
        )
        .toEqual({
          rootFont: "26px",
          pageOverflow: false,
          columnReady: true,
          headingReady: true,
          railVisible: viewport.width > 1340,
        });

      const metrics = await page.evaluate(() => {
        const column = document.querySelector<HTMLElement>(".thread-column");
        const root = getComputedStyle(document.documentElement);
        const heading = document.querySelector<HTMLElement>(".transcript-message, .empty-relay-card h1");
        return {
          rootFont: root.fontSize,
          pageOverflow:
            document.documentElement.scrollWidth > window.innerWidth ||
            document.body.scrollWidth > document.body.clientWidth,
          columnWidth: column?.getBoundingClientRect().width ?? 0,
          headingFont: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
          railVisible: Boolean(document.querySelector("nav.sidebar")),
        };
      });
      expect(metrics.rootFont).toBe("26px");
      expect(metrics.pageOverflow, `page overflow at ${viewport.width}x${viewport.height}`).toBe(false);
      expect(metrics.columnWidth, `column at ${viewport.width}`).toBeLessThanOrEqual(721);
      expect(metrics.columnWidth, `column at ${viewport.width}`).toBeGreaterThan(680);
      expect(metrics.headingFont).toBeGreaterThanOrEqual(24);
      expect(metrics.railVisible).toBe(viewport.width > 1340);

      const messageOverflow = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".transcript-message")).map(
          (el) => el.scrollWidth > el.clientWidth + 1,
        ),
      );
      expect(messageOverflow).not.toContain(true);

      expect(
        await collectTargetSizeIssues(page),
        `shell target sizes at ${viewport.width}x${viewport.height}`,
      ).toEqual([]);
      expect(
        await collectFocusReachabilityIssues(page),
        `shell focus reachability at ${viewport.width}x${viewport.height}`,
      ).toEqual([]);

      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "命令面板" });
      await expect(palette).toBeVisible();
      expect(await collectTargetSizeIssues(page), `palette targets at ${viewport.width}`).toEqual([]);
      expect(
        await collectFocusReachabilityIssues(page),
        `palette reachability at ${viewport.width}`,
      ).toEqual([]);
      const paletteOverflow = await palette.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(paletteOverflow, `palette internal overflow at ${viewport.width}`).toBe(false);
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();

      await page.keyboard.press("Control+,");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      const settingsBox = await settings.boundingBox();
      expect((settingsBox?.width ?? 0) + 32).toBeLessThanOrEqual(viewport.width);
      expect(
        await collectTargetSizeIssues(page),
        `settings targets at ${viewport.width}`,
      ).toEqual([]);
      expect(
        await collectFocusReachabilityIssues(page),
        `settings reachability at ${viewport.width}`,
      ).toEqual([]);
      const settingsOverflow = await settings.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(settingsOverflow, `settings internal overflow at ${viewport.width}`).toBe(false);
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();

      await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
      const capabilities = page.getByRole("dialog", { name: "能力目录" });
      await expect(capabilities).toBeVisible();
      expect(
        await collectTargetSizeIssues(page),
        `capabilities targets at ${viewport.width}`,
      ).toEqual([]);
      expect(
        await collectFocusReachabilityIssues(page),
        `capabilities reachability at ${viewport.width}`,
      ).toEqual([]);
      const capabilitiesOverflow = await capabilities.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(capabilitiesOverflow, `capabilities internal overflow at ${viewport.width}`).toBe(false);
      await page.keyboard.press("Escape");
      await expect(capabilities).toBeHidden();

      await page.getByRole("button", { name: "Workspace ⌘B" }).click();
      const workspace = page.getByRole("complementary", { name: "Workspace" });
      await expect(workspace).toBeVisible();
      const workspaceBox = await workspace.boundingBox();
      expect((workspaceBox?.width ?? 0) + 32).toBeLessThanOrEqual(viewport.width);
      expect(
        await collectTargetSizeIssues(page),
        `Workspace targets at ${viewport.width}`,
      ).toEqual([]);
      expect(
        await collectFocusReachabilityIssues(page),
        `Workspace reachability at ${viewport.width}`,
      ).toEqual([]);
      const workspaceOverflow = await workspace.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(workspaceOverflow, `Workspace internal overflow at ${viewport.width}`).toBe(false);
      await page.keyboard.press("Control+b");
      await expect(workspace).toBeHidden();
    }
  });

  test("E2E-CONTRAST-01: control-line and focus ring tokens, focus not obscured, forced colors, targets, landmarks and live region", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.locator("header.window-titlebar")).toBeVisible();
    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.locator("nav.sidebar")).toBeVisible();
    await expect(page.locator("footer.status-footer")).toBeVisible();
    const liveRegion = page.getByTestId("live-region-polite");
    const assertiveRegion = page.getByTestId("live-region-assertive");
    await expect(liveRegion).toHaveAttribute("aria-atomic", "false");
    await expect(liveRegion).toHaveText("");
    await expect(liveRegion).toHaveAttribute("data-announcement-seq", "0");
    await expect(assertiveRegion).toHaveAttribute("aria-atomic", "false");
    await expect(assertiveRegion).toHaveText("");
    await expect(assertiveRegion).toHaveAttribute("data-announcement-seq", "0");

    const tokenValues = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        controlLine: style.getPropertyValue("--control-line").trim(),
        focusRing: style.getPropertyValue("--focus-ring-color").trim(),
        statusReady: style.getPropertyValue("--status-ready").trim(),
        statusConnecting: style.getPropertyValue("--status-connecting").trim(),
        statusBlocked: style.getPropertyValue("--status-blocked").trim(),
      };
    });
    expect(tokenValues.controlLine).toBe("#8a8a80");
    expect(tokenValues.focusRing).toBe("#c8442e");
    expect(tokenValues.statusReady).toBe("#376d4a");
    expect(tokenValues.statusConnecting).toBe("#8a6215");
    expect(tokenValues.statusBlocked).toBe("#9e2d1e");

    const paletteButton = page.getByRole("button", { name: /命令面板/ });
    await paletteButton.focus();
    const focusStyle = await paletteButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        borderColor: style.borderColor,
        height: el.getBoundingClientRect().height,
      };
    });
    expect(focusStyle.outlineColor).toBe("rgb(200, 68, 46)");
    expect(focusStyle.outlineWidth).toBe("2px");
    expect(focusStyle.outlineOffset).toBe("2px");
    expect(focusStyle.borderColor).toBe("rgb(138, 138, 128)");
    expect(focusStyle.height).toBeGreaterThanOrEqual(28);

    expect(await collectTargetSizeIssues(page), "shell/onboarding target sizes").toEqual([]);

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "命令面板" });
    await expect(palette).toBeVisible();
    expect(await collectTargetSizeIssues(page), "command palette target sizes").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    await page.keyboard.press("Control+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    expect(await collectTargetSizeIssues(page), "settings target sizes").toEqual([]);
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("Tab");
      const rect = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const box = el?.getBoundingClientRect();
        return box
          ? {
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              right: box.right,
            }
          : null;
      });
      if (!rect) continue;
      expect(rect.top).toBeGreaterThanOrEqual(-1);
      expect(rect.left).toBeGreaterThanOrEqual(-1);
      expect(rect.bottom).toBeLessThanOrEqual(901);
      expect(rect.right).toBeLessThanOrEqual(1441);
    }

    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    await page.getByRole("button", { name: /能力 17 可达 4 延期/ }).click();
    const capabilities = page.getByRole("dialog", { name: "能力目录" });
    await expect(capabilities).toBeVisible();
    expect(await collectTargetSizeIssues(page), "capabilities target sizes").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(capabilities).toBeHidden();

    await page.getByRole("button", { name: "Workspace ⌘B" }).click();
    const workspace = page.getByRole("complementary", { name: "Workspace" });
    await expect(workspace).toBeVisible();
    expect(await collectTargetSizeIssues(page), "Workspace target sizes").toEqual([]);
    await page.keyboard.press("Control+b");
    await expect(workspace).toBeHidden();

    await page.emulateMedia({ forcedColors: "active" });
    await page.keyboard.press("Tab");
    await paletteButton.focus();
    await expect(paletteButton).toBeFocused();
    const forcedStyle = await paletteButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(forcedStyle.outlineStyle).toBe("solid");
    expect(forcedStyle.outlineWidth).toBe("2px");
  });

  test("E2E-A11Y-06: polite and assertive live regions stay mounted, start empty, and dedupe the same event id", async ({
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
              sessionId: "sess-live-region",
              title: "Live Region Session",
              preview: "Waiting for approval",
              updatedAt: "2026-11-23T09:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: "turn-live-region",
              status: "running",
            },
          ],
          activeScope: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-live-region",
          },
          activeSessionId: "sess-live-region",
        },
        chatState: {
          windowId: "primary",
          paneId: "main",
          lastActiveChat: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-live-region",
          },
          lastSessionByScope: { "local::default": "sess-live-region" },
          lastValidProfileByConnection: { local: "default" },
          lastValidScopes: [{ connectionId: "local", profileId: "default" }],
          sessionSummaries: {
            "local::default::sess-live-region": {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-live-region",
              title: "Live Region Session",
              hasDraft: true,
              draftText: "session missing surface probe",
            },
          },
          draftsByKey: {
            "local::default::sess-live-region": {
              draftId: "draft-live-region",
              sessionId: "sess-live-region",
              scope: { connectionId: "local", profileId: "default" },
              text: "session missing surface probe",
              attachments: [],
              contexts: [],
              composer: {},
              updatedAt: "2026-11-23T09:00:00.000Z",
              revision: 1,
              origin: {
                connectionId: "local",
                profileId: "default",
                sessionId: "sess-live-region",
                title: "Live Region Session",
              },
              deliveryStatus: "idle",
            },
          },
          draftStorageUsage: {
            totalBytes: 30,
            maxDraftBytes: 1024 * 1024,
            maxTotalBytes: 50 * 1024 * 1024,
            overTotalLimit: false,
            draftCount: 1,
            orphanedCount: 0,
          },
          activeStatus: "ready",
          lastKnownUnverified: false,
          missingSession: null,
          routeBanner: null,
        },
        approvalRespondFailure: true,
        failPromptSend: true,
        missingSessionOnPromptFailure: true,
        approvals: [
          {
            gateway: {
              approvalId: "apr-live-region",
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-live-region",
              turnId: "turn-live-region",
              executionGeneration: 1,
              command: "sudo systemctl restart hermes",
              description: "Restart the local service",
              choices: ["once", "deny"],
            },
            main: {
              connectionLabel: "This device",
              connectionKind: "local",
              hostDisplay: "local-control-socket",
              profileDisplayName: "Default",
              sessionTitle: "Live Region Session",
              cwd: "/srv/hermes/app",
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

    const politeRegion = page.getByTestId("live-region-polite");
    const assertiveRegion = page.getByTestId("live-region-assertive");
    const surfaceAlert = page.getByTestId("chat-surface-alert");
    const surfaceErrorText = "宿主内部处理失败，请重试或导出脱敏诊断信息。";
    await expect(politeRegion).toHaveCount(1);
    await expect(assertiveRegion).toHaveCount(1);
    await expect(assertiveRegion).not.toHaveAttribute("role", "alert");
    await expect(politeRegion).toHaveAttribute("aria-atomic", "false");
    await expect(assertiveRegion).toHaveAttribute("aria-atomic", "false");
    await expect(politeRegion).toHaveText("");
    await expect(assertiveRegion).toHaveText("");
    await expect(politeRegion).toHaveAttribute("data-announcement-seq", "0");
    await expect(assertiveRegion).toHaveAttribute("data-announcement-seq", "0");
    await expect(page.locator(".status-dot.is-ready")).toHaveCSS(
      "background-color",
      "rgb(55, 109, 74)",
    );
    for (const region of [politeRegion, assertiveRegion]) {
      const style = await region.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          display: computed.display,
          visibility: computed.visibility,
          position: computed.position,
          width: computed.width,
          height: computed.height,
          overflow: computed.overflow,
        };
      });
      expect(style.display).not.toBe("none");
      expect(style.visibility).not.toBe("hidden");
      expect(style.position).toBe("absolute");
      expect(style.width).toBe("1px");
      expect(style.height).toBe("1px");
      expect(style.overflow).toBe("hidden");
    }

    await expect(page.locator("#composer-input")).toHaveValue("session missing surface probe");
    const assertiveSeqBeforeEarlyReturnFailure =
      await assertiveRegion.getAttribute("data-announcement-seq");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".session-missing-card")).toBeVisible();
    await expect(surfaceAlert).toBeVisible();
    await expect(surfaceAlert).toHaveAttribute("role", "alert");
    await expect(surfaceAlert).toContainText(surfaceErrorText);
    await expect(surfaceAlert).toHaveCount(1);
    await expect(
      page
        .locator('[role="alert"], [aria-live]:not([aria-live="off"])')
        .filter({ hasText: surfaceErrorText }),
    ).toHaveCount(1);
    await expect(assertiveRegion).not.toContainText(surfaceErrorText);
    await expect(assertiveRegion).toHaveAttribute(
      "data-announcement-seq",
      assertiveSeqBeforeEarlyReturnFailure ?? "0",
    );

    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          __HERMES_E2E_FIXTURE__: {
            failPromptSend?: boolean;
            missingSessionOnPromptFailure?: boolean;
          };
        }
      ).__HERMES_E2E_FIXTURE__;
      fixture.failPromptSend = false;
      fixture.missingSessionOnPromptFailure = false;
    });
    await page.getByRole("button", { name: "关闭并切换可用 Session" }).click();
    await expect(page.locator(".session-missing-card")).toHaveCount(0);
    await expect(surfaceAlert).toHaveCount(1);

    const scopeButton = page.locator(".route-strip").getByRole("button", {
      name: /未连接|已连接/,
    });
    await scopeButton.click();
    const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
    await scopeDialog.getByRole("button", { name: /This device/ }).click();
    await expect(politeRegion).toHaveText("已切换当前 Scope");
    const politeSeq = await politeRegion.getAttribute("data-announcement-seq");
    await scopeButton.click();
    await scopeDialog.getByRole("button", { name: /This device/ }).click();
    await expect(politeRegion).toHaveAttribute("data-announcement-seq", politeSeq ?? "1");

    const approve = page.getByTestId("approval-choice-once");
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(assertiveRegion).toContainText("审批操作未完成");
    const assertiveSeq = await assertiveRegion.getAttribute("data-announcement-seq");
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(assertiveRegion).toHaveAttribute(
      "data-announcement-seq",
      assertiveSeq ?? "1",
    );

    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          __HERMES_E2E_FIXTURE__: {
            failPromptSend?: boolean;
            promptReceiptMode?: "accepted" | "admitted" | "delivery_unknown";
            missingSessionOnPromptFailure?: boolean;
          };
        }
      ).__HERMES_E2E_FIXTURE__;
      fixture.failPromptSend = true;
    });
    const assertiveSeqBeforeSurfaceFailure =
      await assertiveRegion.getAttribute("data-announcement-seq");
    await page.locator("#composer-input").fill("surface announcement probe");
    const sendButton = page
      .locator(".composer-shell")
      .getByRole("button", { name: "发送消息", exact: true });
    await sendButton.click();

    await expect(surfaceAlert).toBeVisible();
    await expect(surfaceAlert).toHaveAttribute("role", "alert");
    await expect(surfaceAlert).toContainText(surfaceErrorText);
    await expect(
      page
        .locator('[role="alert"], [aria-live]:not([aria-live="off"])')
        .filter({ hasText: surfaceErrorText }),
    ).toHaveCount(1);
    await expect(assertiveRegion).not.toContainText(surfaceErrorText);
    await expect(assertiveRegion).toHaveAttribute(
      "data-announcement-seq",
      assertiveSeqBeforeSurfaceFailure ?? "1",
    );

    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          __HERMES_E2E_FIXTURE__: {
            failPromptSend?: boolean;
            promptReceiptMode?: "accepted" | "admitted" | "delivery_unknown";
            missingSessionOnPromptFailure?: boolean;
          };
        }
      ).__HERMES_E2E_FIXTURE__;
      fixture.failPromptSend = false;
      fixture.promptReceiptMode = "accepted";
      fixture.missingSessionOnPromptFailure = false;
    });
    await sendButton.click();
    await expect(surfaceAlert).toHaveCount(0);

    await page.locator("#composer-input").fill("x".repeat(1024 * 1024 + 64));
    const capacityAlert = page.getByTestId("draft-capacity-alert");
    await expect(capacityAlert).toHaveAttribute("role", "alert");
    await expect(page.getByRole("alert")).toHaveCount(1);
  });
});

test.describe("Ticket #38 Drafts A11y", () => {
  test("E2E-A11Y-04: Ticket #38 draft alerts, expired attachment chips, and Settings -> Data orphaned drafts have zero critical/serious axe violations", async ({
    page,
  }) => {
    const checkAxe = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const seriousOrCritical = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(
        seriousOrCritical,
        `${label}: ${JSON.stringify(seriousOrCritical, null, 2)}`,
      ).toEqual([]);
    };

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
              label: "Default",
              actual: "ready",
              degraded: false,
              isException: false,
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-a11y",
              title: "Draft A11y Session",
              preview: "hello",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-a11y" },
          activeSessionId: "sess-a11y",
        },
        chatState: {
          lastActiveChat: { connectionId: "local", profileId: "default", sessionId: "sess-a11y" },
          lastSessionByScope: { "local::default": "sess-a11y" },
          activeStatus: "ready",
          draftsByKey: {
            "chat::local::default::sess-a11y": {
              draftId: "draft-a11y-1",
              sessionId: "sess-a11y",
              scope: { connectionId: "local", profileId: "default" },
              text: "Unconfirmed draft with expired attachment",
              attachments: [
                {
                  attachmentId: "att-a11y-1",
                  handle: "opaque://a11y",
                  displayName: "diagram.png",
                  kind: "image",
                  expired: true,
                },
              ],
              contexts: [],
              composer: {},
              deliveryStatus: "delivery_unknown",
              updatedAt: "2026-11-23T08:02:00.000Z",
              revision: 1,
              origin: { connectionId: "local", profileId: "default", sessionId: "sess-a11y" },
            },
          },
          orphanedDrafts: [
            {
              orphanedId: "orphan-a11y-1",
              draftId: "draft-orphan-a11y",
              reason: "connection_removed",
              text: "Orphaned draft for Settings Data a11y audit",
              attachments: [],
              contexts: [],
              origin: { connectionId: "remote-a11y", profileId: "default" },
              orphanedAt: "2026-11-23T07:55:00.000Z",
            },
          ],
        },
      };
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("draft-delivery-unknown-alert")).toBeVisible();
    await expect(page.getByTestId("draft-attachment-expired-alert")).toBeVisible();
    await checkAxe("composer with delivery_unknown alert and expired attachment");

    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByTestId("orphaned-draft-list")).toBeVisible();
    await checkAxe("settings modal with Data orphaned drafts");
  });
});
