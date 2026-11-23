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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LEGACY_VISIBLE_ERROR_LITERALS = {
  "apps/desktop/src/main/chatSessionStateStore.ts": {
    "当前 Draft 体积超过 1 MiB 上限，请清理部分内容或导出后缩减。": 1,
  },
  "apps/desktop/src/main/connectionSupervisor.ts": {
    "Gateway 尚未就绪": 1,
    "应用正在退出": 1,
    "当前 Gateway 未提供此能力": 1,
    "Gateway 连接中断或超时": 1,
    "Gateway 执行请求失败": 1,
    "请求失败": 1,
    "请填写任务名称、Cron 表达式与执行提示词": 1,
    "当前 Gateway 不支持新建 Cron 任务": 1,
    "缺少 Cron 任务 ID": 2,
    "当前 Gateway 不支持取消 Cron 任务": 1,
    "当前 Gateway 不支持恢复 Cron 任务": 1,
    "缺少目标 Session": 3,
    "当前 Gateway 不支持新建 Session": 1,
    "请输入对话内容后再发送": 1,
    "当前 Gateway 不支持发送对话": 2,
    "当前没有可停止的 Turn": 1,
    "当前 Gateway 不支持停止当前 Turn": 1,
    "请输入内容后再排队": 1,
    "缺少排队 admissionId": 1,
    "当前 Gateway 不支持取消排队": 1,
    "缺少补充指令内容": 1,
    "当前 Gateway 不支持中途纠偏": 1,
    "当前 Gateway 已拒绝 Subagents 能力": 1,
    "未选择要查看 Tail 的 Subagent": 1,
    "当前 Gateway 未提供 Subagent Tail 能力": 1,
    "请输入针对该 Subagent 的补充指令": 1,
    "当前 Gateway 不支持 Subagent 补充指令": 1,
    "未选择要停止的 Subagent": 1,
    "当前 Gateway 不支持停止 Subagent": 1,
    "Gateway 未确认停止该 Subagent，当前运行状态保持不变": 1,
    "当前 Gateway 未提供 Checkpoint 列表能力": 1,
    "未选择要对比的 Checkpoint": 1,
    "当前 Gateway 未提供 Checkpoint Diff 能力": 1,
    "恢复 Checkpoint 需要显式确认": 1,
    "当前 Gateway 未提供 rollback.restore 能力，仅支持只读浏览与 Diff 对比": 1,
    "Gateway 未能恢复到所选 Checkpoint": 1,
    "不支持更新该配置项": 1,
    "当前 Gateway 拒绝更新配置": 1,
    "当前 Gateway 未提供 config.update 能力": 1,
    "更新配置失败": 1,
    "当前 Gateway 未连接，无法校验待处理 Approval": 1,
    "所属 Gateway 连接代次已变更，旧 Approval 已失效": 1,
  },
  "apps/desktop/src/main/registryBridge.ts": {
    "OAuth 授权管理器不可用": 1,
  },
  "packages/domain/src/turnRecoveryCoordinator.ts": {
    "当前 Session 没有待处理的丢失 Turn": 1,
    "丢失 Turn 的 admission_id 不匹配": 1,
    "丢失 Turn 的 execution_generation 不匹配": 1,
    "正在放弃丢失的 Turn，请等待完成": 1,
    "Gateway 未确认放弃丢失 Turn": 1,
    "当前没有运行中的 Turn 可停止": 1,
    "目标 Turn 的 Execution 代际已变更，无法跨代际停止": 1,
    "请输入内容后再排队": 1,
    "未找到待重试的排队记录": 1,
    "未找到目标排队条目": 2,
  },
} as const;

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
  });

  it("catches banned translations, missing CJK-ASCII spacing, and bare ok/cancel buttons", () => {
    expect(validateTerminology("正在连接本地网关与工作区")).not.toEqual([]);
    expect(validateTerminology("新建Session并查看Workspace")).not.toEqual([]);
    expect(validateTerminology("正在连接...")).not.toEqual([]);
    expect(validateTerminology("搜索 Session...")).not.toEqual([]);
    expect(validateTerminology("输入命令或文本后发送至 PTY（例如 pwd）...")).not.toEqual([]);
    expect(validateTerminology("已连接到 Gateway,正在同步")).not.toEqual([]);
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

    expect(lintVisibleErrorLiterals(sourceFiles, LEGACY_VISIBLE_ERROR_LITERALS)).toEqual([]);
    expect(
      lintVisibleErrorLiterals(
        [
          {
            path: "apps/desktop/src/main/newSurface.ts",
            content: 'throw makeBridgeError("invalid_request", "新的未入目录错误");',
          },
        ],
        LEGACY_VISIBLE_ERROR_LITERALS,
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

  it("derives 1440 rail vs 1280 popover layout at 1340px breakpoint", () => {
    expect(deriveViewportMode(1440)).toBe("rail");
    expect(deriveViewportMode(1341)).toBe("rail");
    expect(deriveViewportMode(1340)).toBe("popover");
    expect(deriveViewportMode(1280)).toBe("popover");
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
});
