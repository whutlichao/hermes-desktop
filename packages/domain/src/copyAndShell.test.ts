import { describe, expect, it } from "vitest";
import {
  COPY_CATALOG,
  createInitialShellState,
  deriveViewportMode,
  getCopy,
  getTopmostSurface,
  lintCopyCatalog,
  shellReducer,
  validateTerminology,
} from "@hermes/domain";

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
    expect(validateTerminology("确定")).not.toEqual([]);
    expect(validateTerminology("取消")).not.toEqual([]);
    expect(validateTerminology("在当前 Scope 新建 Session")).toEqual([]);
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
});
