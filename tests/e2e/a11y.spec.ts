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

  test("passes axe-core serious/critical = 0 on populated Workspace Artifacts, Annotations, Files, Git, Agents, and Terminal tabs", async ({
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

  test("passes axe-core serious/critical = 0 on Extensions drawer, Settings Plugins section, and transcript attribution/approval cards", async ({
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


  test("passes axe-core serious/critical = 0 on background attention badges, mark-read action, route attention chips, and 1280 popover (Ticket #37)", async ({
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
});
