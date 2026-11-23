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
    state = shellReducer(state, { type: "OPEN_SURFACE", surface: "shortcuts" });
    expect(getTopmostSurface(state)).toBe("shortcuts");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBe("palette");

    state = shellReducer(state, { type: "CLOSE_TOPMOST_SURFACE" });
    expect(getTopmostSurface(state)).toBeNull();

    state = shellReducer(state, { type: "TOGGLE_WORKSPACE" });
    expect(state.workspace.mode).toBe("open");
    state = shellReducer(state, { type: "TOGGLE_WORKSPACE" });
    expect(state.workspace.mode).toBe("hidden");
  });
});
