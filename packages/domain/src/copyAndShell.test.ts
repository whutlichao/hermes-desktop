import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COPY_CATALOG,
  createInitialShellState,
  deriveViewportMode,
  getCopy,
  getTopmostSurface,
  lintCopyCatalog,
  lintVisibleErrorLiterals,
  shellReducer,
  validateTerminology,
} from "@hermes/domain";
import type { CapabilitySnapshot, SessionTranscriptSnapshot } from "@hermes/contracts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function collectSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(absolute);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [absolute];
  });
}

describe("zh-CN copy catalog & terminology lint", () => {
  it("contains zero missing/raw keys and passes terminology lint", () => {
    const violations = lintCopyCatalog(COPY_CATALOG);
    expect(violations).toEqual([]);
    expect(getCopy("app.name")).toBe("Hermes Desktop");
    expect(getCopy("skip.toComposer")).toBe("跳到对话输入");
    expect(lintCopyCatalog({})).toEqual([]);
    const catalogViolations = lintCopyCatalog({
      "empty.value": "",
      "raw.key": "raw.key",
      "space.value": "   ",
      "chat.sendFailed": "发生了什么，请求失败。",
      "memory.stateError": "发生了什么：session 不可用。可能原因：断线。下一步：重连...",
    });
    expect(catalogViolations.some((v) => v.key === "empty.value" && v.reason.includes("缺失"))).toBe(true);
    expect(catalogViolations.some((v) => v.key === "raw.key" && v.reason.includes("原始 key"))).toBe(true);
    expect(catalogViolations.filter((v) => v.reason.includes("错误文案必须包含")).length).toBe(2);
    expect(catalogViolations.some((v) => v.reason.includes("全角省略号"))).toBe(true);
    expect(catalogViolations.some((v) => v.reason.includes("大小写错误"))).toBe(true);
    expect(
      lintVisibleErrorLiterals(
        [
          {
            path: "apps/desktop/src/main/noMatch.ts",
            content: 'throw makeBridgeError("invalid_request", "english only");',
          },
          {
            path: "apps/desktop/src/main/multiline.ts",
            content: 'throw new Error("第一行\n第二行");',
          },
          {
            path: "apps/desktop/src/main/nearbyCopy.ts",
            content:
              'throw makeBridgeError("invalid_request", getCopy("copy.key"));\nconst title = "新对话";',
          },
        ],
        {},
      ),
    ).toEqual([]);
    expect(
      lintVisibleErrorLiterals(
        [
          {
            path: "apps/desktop/src/main/escaped.ts",
            content: 'throw new Error("第一行\\"续");',
          },
        ],
        {},
      ),
    ).toHaveLength(1);
    expect(
      lintVisibleErrorLiterals(
        [
          {
            path: "apps/desktop/src/main/allowed.ts",
            content: 'throw new Error("已登记");',
          },
        ],
        {
          "apps/desktop/src/main/allowed.ts": { 已登记: 1 },
        },
      ),
    ).toEqual([]);
  });

  it("catches banned translations, missing CJK-ASCII spacing, and bare ok/cancel buttons", () => {
    expect(validateTerminology("正在连接本地网关与工作区")).not.toEqual([]);
    expect(validateTerminology("新建Session并查看Workspace")).not.toEqual([]);
    expect(validateTerminology("正在连接...")).not.toEqual([]);
    expect(validateTerminology("搜索 Session...")).not.toEqual([]);
    expect(validateTerminology("输入命令或文本后发送至 PTY（例如 pwd）...")).not.toEqual([]);
    expect(validateTerminology("已连接到 Gateway,正在同步")).not.toEqual([]);
    expect(validateTerminology("已连接，等待数据")).toEqual([]);
    expect(validateTerminology("已连接（等待）")).toEqual([]);
    expect(validateTerminology("session 已连接")).not.toEqual([]);
    expect(validateTerminology("SESSION 已连接")).toEqual([]);
    expect(validateTerminology("Gateway Session 已连接")).toEqual([]);
    expect(validateTerminology("确定")).not.toEqual([]);
    expect(validateTerminology("取消")).not.toEqual([]);
    expect(validateTerminology("在当前 Scope 新建 Session")).toEqual([]);
  });

  it("rejects new user-visible error literals in Main/domain unless they use the copy catalog", () => {
    const sourceFiles = [
      ...collectSourceFiles(path.join(REPO_ROOT, "apps/desktop/src/main")),
      ...collectSourceFiles(path.join(REPO_ROOT, "packages/domain/src")),
    ]
      .filter((file) => file !== path.join(REPO_ROOT, "packages/domain/src/copy.ts"))
      .map((file) => ({
        path: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
        content: fs.readFileSync(file, "utf8"),
      }));

    expect(lintVisibleErrorLiterals(sourceFiles, {})).toEqual([]);
    expect(
      lintVisibleErrorLiterals(
        [
          {
            path: "apps/desktop/src/main/newSurface.ts",
            content: 'throw makeBridgeError("invalid_request", "新的未入目录错误");',
          },
        ],
        {},
      ),
    ).toHaveLength(1);
    expect(
      lintVisibleErrorLiterals(
        [
          {
            path: "apps/desktop/src/main/newSurface.ts",
            content: 'throw createCodedError("invalid_request", "新的未入目录错误");',
          },
        ],
        {},
      ),
    ).toHaveLength(1);
  });
});

describe("Quiet Relay shell state & layout invariants", () => {
  it("starts with real empty/unconnected state and zero fake gateways, sessions, or deferred features", () => {
    const state = createInitialShellState();
    expect(state.connections).toEqual([]);
    expect(state.profiles).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.activeScope).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.workspace.mode).toBe("closed");
    expect(state.surfaceStack).toEqual([]);
  });

  it("derives rail layout above 1120px and popover at or below 1120px", () => {
    expect(deriveViewportMode(1440)).toBe("rail");
    expect(deriveViewportMode(1280)).toBe("rail");
    expect(deriveViewportMode(1121)).toBe("rail");
    expect(deriveViewportMode(1120)).toBe("popover");
  });

  it("closes only the topmost surface on Esc and supports command palette, settings, workspace, and shortcuts", () => {
    let state = createInitialShellState();
    state = shellReducer(state, { type: "OPEN_SURFACE", surface: "palette" });
    state = shellReducer(state, { type: "OPEN_SURFACE", surface: "extensions" });
    expect(getTopmostSurface(state)).toBe("extensions");

    state = shellReducer(state, { type: "OPEN_SURFACE", surface: "shortcuts" });
    expect(getTopmostSurface(state)).toBe("shortcuts");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBe("extensions");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBe("palette");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBeNull();

    state = shellReducer(state, { type: "TOGGLE_WORKSPACE" });
    expect(state.workspace.mode).toBe("open");
    state = shellReducer(state, { type: "TOGGLE_WORKSPACE" });
    expect(state.workspace.mode).toBe("hidden");
  });

  it("tracks Local inspection state, diagnostics surface, and Remote/SSH escape hatch surface", () => {
    let state = createInitialShellState();
    expect(state.localInspection).toBeNull();
    expect(state.diagnosticsReport).toBeNull();

    state = shellReducer(state, {
      type: "APPLY_LOCAL_INSPECTION",
      inspection: {
        connectionId: "local",
        label: "This device",
        actual: "blocked",
        cli: {
          status: "missing",
          displayName: "未检测到 hermes CLI",
          sourceKind: "none",
          hasOverride: false,
          supportsEnsureJson: false,
          supportsAttachJson: false,
          supportsTicketsProbe: false,
        },
        failure: {
          code: "hermes_not_found",
          phase: "locate_cli",
          retryable: true,
          autoRetry: false,
          actual: "blocked",
          actions: ["choose_cli", "open_install_docs", "retry"],
        },
        checkedAt: "2026-11-23T06:00:00.000Z",
      },
    });
    expect(state.localInspection?.failure?.code).toBe("hermes_not_found");

    state = shellReducer(state, {
      type: "APPLY_DIAGNOSTICS_REPORT",
      report: {
        generatedAt: "2026-11-23T06:00:00.000Z",
        appName: "Hermes Desktop",
        appVersion: "0.1.0",
        bridgeVersion: 1,
        buildMode: "mock",
        mode: "mock",
        platform: "web",
        arch: "wasm",
        hermesHomeKind: "mock",
        connectionsCount: 0,
        cliSummary: null,
        typedFailureCode: "hermes_not_found",
        failurePhase: "locate_cli",
        stages: [],
        notes: [],
      },
    });
    state = shellReducer(state, { type: "OPEN_SURFACE", surface: "diagnostics" });
    expect(getTopmostSurface(state)).toBe("diagnostics");
    expect(state.diagnosticsReport?.typedFailureCode).toBe("hermes_not_found");

    expect(getCopy("local.action.choose_cli")).toBe("选择本机 CLI");
    expect(getCopy("local.escapeRemoteSsh")).toBe("改连 Remote / SSH");
    expect(getCopy("diagnostics.title")).toBe("脱敏诊断摘要");
  });

  it("tracks ApprovalTopicSnapshot and approvalInspect modal surface with Esc topmost dismissal", () => {
    let state = createInitialShellState();
    expect(state.approvals).toEqual({ approvals: [], pendingCount: 0, orphanedCount: 0 });
    expect(state.inspectedApprovalKey).toBeNull();

    state = shellReducer(state, {
      type: "APPLY_APPROVAL_SNAPSHOT",
      snapshot: {
        approvals: [],
        pendingCount: 2,
        orphanedCount: 1,
      },
    });
    expect(state.approvals.pendingCount).toBe(2);
    expect(state.approvals.orphanedCount).toBe(1);

    state = shellReducer(state, { type: "OPEN_APPROVAL_INSPECT", approvalKey: "apr-key-1" });
    expect(getTopmostSurface(state)).toBe("approvalInspect");
    expect(state.inspectedApprovalKey).toBe("apr-key-1");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBeNull();
    expect(state.inspectedApprovalKey).toBeNull();
  });

  it("tracks domainInspect overlay surface & tab and closes topmost cleanly (Ticket #44)", () => {
    let state = createInitialShellState();
    expect(state.domainInspectTab).toBe("memory");

    state = shellReducer(state, { type: "OPEN_DOMAIN_INSPECT", tab: "cron" });
    expect(getTopmostSurface(state)).toBe("domainInspect");
    expect(state.domainInspectTab).toBe("cron");

    state = shellReducer(state, { type: "OPEN_DOMAIN_INSPECT", tab: "messaging" });
    expect(getTopmostSurface(state)).toBe("domainInspect");
    expect(state.domainInspectTab).toBe("messaging");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBeNull();

    // New #44 copy keys pass terminology rules
    expect(getCopy("empty.actionRepairLocal")).toBe("修复 Local");
    expect(getCopy("empty.actionAddRemote")).toBe("添加 Remote");
    expect(getCopy("empty.actionAddSsh")).toBe("添加 SSH");
    expect(getCopy("chat.emptyContinueRecent")).toBe("继续最近 Session");
    expect(getCopy("chat.emptyCapabilities")).toBe("能力目录 ⌘K");
    expect(getCopy("chat.emptyOpenWorkspace")).toBe("打开 Workspace");
    expect(getCopy("cron.title")).toBe("Cron 定时任务");
  });

  it("starts with empty polite/assertive live regions and dedupes each event id independently", () => {
    let state = createInitialShellState();
    expect(state.liveAnnouncement).toBe("");
    expect(state.liveAnnouncementEventId).toBeNull();
    expect(state.assertiveAnnouncement).toBe("");
    expect(state.assertiveAnnouncementEventId).toBeNull();

    state = shellReducer(state, {
      type: "ANNOUNCE",
      message: "已复制本地 Draft 文本",
      eventId: "copy-draft-1",
    });
    expect(state.liveAnnouncement).toBe("已复制本地 Draft 文本");

    const duplicated = shellReducer(state, {
      type: "ANNOUNCE",
      message: "已复制本地 Draft 文本",
      eventId: "copy-draft-1",
    });
    expect(duplicated).toBe(state);

    state = shellReducer(state, {
      type: "ANNOUNCE",
      message: "已切换到当前 Scope",
      eventId: "scope-switch-2",
    });
    expect(state.liveAnnouncement).toBe("已切换到当前 Scope");

    state = shellReducer(state, {
      type: "ANNOUNCE",
      message: "发生了什么：停止失败。可能原因：连接中断。下一步：恢复连接后重试。",
      eventId: "stop-error-1",
      priority: "assertive",
    });
    expect(state.assertiveAnnouncement).toContain("停止失败");
    const duplicatedAssertive = shellReducer(state, {
      type: "ANNOUNCE",
      message: "发生了什么：停止失败。可能原因：连接中断。下一步：恢复连接后重试。",
      eventId: "stop-error-1",
      priority: "assertive",
    });
    expect(duplicatedAssertive).toBe(state);

    state = shellReducer(state, {
      type: "ANNOUNCE",
      message: "发生了什么：投递状态未知。可能原因：回执丢失。下一步：检查回执。",
      eventId: "queue-error-2",
      priority: "assertive",
    });
    expect(state.assertiveAnnouncement).toContain("投递状态未知");
    expect(state.liveAnnouncement).toBe("已切换到当前 Scope");
  });

  it("handles every remaining ShellAction branch and generation/stack guards (Ticket #45 coverage)", () => {
    let state = createInitialShellState();
    const appInfo = {
      bridgeVersion: 1,
      appName: "Hermes Desktop",
      appVersion: "0.1.0",
      gitSha: "abc123",
      gitDirty: false,
      buildMode: "dev",
      distribution: "local-unsigned",
      electronVersion: "45.4.1",
      chromiumVersion: "134.0.0.0",
      nodeVersion: "22.13.0",
      arch: "arm64",
      macOSVersion: "15.3.1",
      source: "git",
      mode: "electron",
      platform: "darwin",
      capabilitiesReady: false,
    } as const;
    state = shellReducer(state, { type: "HYDRATE_HELLO", appInfo });
    expect(state.appInfo?.gitSha).toBe("abc123");

    state = shellReducer(state, {
      type: "APPLY_FLEET_SNAPSHOT",
      connections: [],
      profiles: [],
      sessions: [],
      activeScope: { connectionId: "local", profileId: "default" },
      activeSessionId: "sess-1",
    });
    expect(state.activeScope).toEqual({ connectionId: "local", profileId: "default" });
    expect(state.activeSessionId).toBe("sess-1");

    const transcript: SessionTranscriptSnapshot = {
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-1",
      messages: [
        {
          messageId: "m-1",
          sessionId: "sess-1",
          role: "user",
          text: "你好",
          createdAt: "2026-11-23T06:00:00.000Z",
        },
      ],
      activeTurnId: "t-1",
      turnStopping: false,
      chatAvailable: true,
      supportedActions: {
        promptSubmit: true,
        promptCancel: true,
        promptSteer: true,
        sessionCreate: true,
        sessionResume: true,
      },
      snapshotSeq: 2,
    };
    state = shellReducer(state, { type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: transcript });
    expect(state.transcript?.messages).toHaveLength(1);
    expect(state.transcript?.messages).not.toBe(transcript.messages);
    expect(state.transcript?.snapshotSeq).toBe(2);

    state = shellReducer(state, {
      type: "APPLY_TRANSCRIPT_EVENT",
      event: {
        topic: "session.transcript",
        scope: { connectionId: "local", profileId: "default", sessionId: "sess-1" },
        kind: "patch",
        seq: 3,
        revision: 3,
        payload: {
          type: "token_delta",
          sessionId: "sess-1",
          turnId: "t-1",
          messageId: "m-2",
          delta: "回复",
        },
      },
    });
    expect(state.transcript?.messages).toHaveLength(2);
    expect(state.transcript?.messages[1].text).toBe("回复");

    state = shellReducer(state, { type: "CLEAR_TRANSCRIPT" });
    expect(state.transcript).toBeNull();

    state = shellReducer(state, {
      type: "APPLY_CHAT_STATE",
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
    });
    expect(state.chatState?.activeStatus).toBe("ready");

    state = shellReducer(state, { type: "SET_STOP_ERROR", message: "停止失败" });
    expect(state.stopError).toBe("停止失败");
    state = shellReducer(state, { type: "SET_STOP_ERROR", message: null });
    expect(state.stopError).toBeNull();
    state = shellReducer(state, { type: "SET_CHAT_BUSY", busy: true });
    expect(state.chatBusy).toBe(true);
    state = shellReducer(state, { type: "SET_CHAT_BUSY", busy: false });
    expect(state.chatBusy).toBe(false);

    const capabilities: CapabilitySnapshot = {
      ...state.capabilities,
      generation: 5,
    };
    state = shellReducer(state, { type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: capabilities });
    expect(state.capabilities.generation).toBe(5);
    const staleCapabilities = { ...state.capabilities, generation: 4 };
    expect(
      shellReducer(state, { type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: staleCapabilities }),
    ).toBe(state);

    state = shellReducer(state, {
      type: "APPLY_TURN_RECOVERY_SNAPSHOT",
      snapshot: {
        sessions: [
          {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            queuePaused: false,
            activeTurnId: null,
            stopState: "idle",
            executionGeneration: 1,
            ownerGeneration: 1,
            unknownTurns: [],
            unknownTurn: null,
            queuedAdmissions: [],
            pendingDeliveryUnknown: [],
            pendingSteerFallback: null,
            lastKnownUnverified: false,
            updatedAt: "2026-11-23T08:00:00.000Z",
          },
        ],
      },
    });
    expect(state.turnRecovery.sessions).toHaveLength(1);

    state = shellReducer(state, { type: "OPEN_DOMAIN_INSPECT", tab: "memory" });
    state = shellReducer(state, { type: "OPEN_SURFACE", surface: "settings" });
    state = shellReducer(state, { type: "SET_DOMAIN_INSPECT_TAB", tab: "cron" });
    expect(state.domainInspectTab).toBe("cron");
    expect(getTopmostSurface(state)).toBe("settings");

    state = shellReducer(state, { type: "CLOSE_SURFACE", surface: "settings" });
    expect(getTopmostSurface(state)).toBe("domainInspect");
    state = shellReducer(state, { type: "CLOSE_SURFACE", surface: "domainInspect" });
    expect(state.surfaceStack).toEqual([]);
    expect(shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" })).toBe(state);

    state = shellReducer(state, { type: "OPEN_APPROVAL_INSPECT", approvalKey: "apr-1" });
    expect(state.inspectedApprovalKey).toBe("apr-1");
    state = shellReducer(state, { type: "OPEN_APPROVAL_INSPECT", approvalKey: "apr-2" });
    expect(state.surfaceStack).toEqual(["approvalInspect"]);
    expect(state.inspectedApprovalKey).toBe("apr-2");
    state = shellReducer(state, { type: "CLOSE_APPROVAL_INSPECT" });
    expect(state.inspectedApprovalKey).toBeNull();
    state = shellReducer(state, { type: "OPEN_APPROVAL_INSPECT", approvalKey: "apr-3" });
    state = shellReducer(state, { type: "CLOSE_SURFACE", surface: "approvalInspect" });
    expect(state.inspectedApprovalKey).toBeNull();
    state = shellReducer(state, { type: "OPEN_APPROVAL_INSPECT", approvalKey: "apr-4" });
    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(state.inspectedApprovalKey).toBeNull();

    state = shellReducer(state, { type: "SET_WORKSPACE_MODE", mode: "open" });
    expect(state.workspace.mode).toBe("open");
    state = shellReducer(state, { type: "SET_WORKSPACE_TAB", tab: "terminal" });
    expect(state.workspace.activeTab).toBe("terminal");

    const beforeUnidentifiedPolite = shellReducer(state, {
      type: "ANNOUNCE",
      message: "无事件 ID 的提示",
    });
    expect(beforeUnidentifiedPolite.liveAnnouncementEventId).toBeNull();
    expect(beforeUnidentifiedPolite.liveAnnouncementSeq).toBe(1);
    const afterUnidentifiedPolite = shellReducer(beforeUnidentifiedPolite, {
      type: "ANNOUNCE",
      message: "另一条无事件 ID 的提示",
    });
    expect(afterUnidentifiedPolite.liveAnnouncementSeq).toBe(2);
    const firstAssertive = shellReducer(state, {
      type: "ANNOUNCE",
      message: "无事件 ID 的紧急提示",
      priority: "assertive",
    });
    expect(firstAssertive.assertiveAnnouncementEventId).toBeNull();
    expect(firstAssertive.assertiveAnnouncementSeq).toBe(1);
    expect(
      shellReducer(firstAssertive, {
        type: "ANNOUNCE",
        message: "第二条无事件 ID 的紧急提示",
        priority: "assertive",
      }).assertiveAnnouncementSeq,
    ).toBe(2);
  });
});
