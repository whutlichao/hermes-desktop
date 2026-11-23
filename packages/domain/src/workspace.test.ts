import { describe, expect, it } from "vitest";
import type {
  ArtifactAnnotation,
  WorkspaceArtifactItem,
  WorkspaceFileEntry,
} from "@hermes/contracts";
import {
  addWorkspaceAnnotation,
  closeWorkspace,
  createInitialWorkspaceSessionState,
  deriveWorkspaceDrawerWidth,
  getActiveChatWorkspaceView,
  getActiveScopeWorkspaceView,
  getWorkspaceTabBinding,
  hideWorkspace,
  markWorkspaceArtifactsExternalStale,
  markWorkspaceFilesExternalStale,
  openWorkspace,
  projectArtifactAnnotations,
  reconcileWorkspaceArtifacts,
  reconcileWorkspaceFiles,
  selectWorkspaceAgent,
  selectWorkspaceArtifact,
  selectWorkspaceFile,
  selectWorkspaceFileLines,
  selectWorkspaceGitDiff,
  setWorkspaceActiveTab,
  setWorkspaceAgentSteerText,
  setWorkspaceArtifactScroll,
  setWorkspaceArtifactZoom,
  setWorkspaceTerminalScrollback,
  switchWorkspaceContext,
  toggleWorkspaceDirectory,
} from "./workspace";

const ARTIFACT_V1: WorkspaceArtifactItem = {
  artifactId: "art-latency",
  title: "Latency Report",
  kind: "markdown",
  content: "# Latency\nP99: 42ms",
  version: 1,
  hash: "hash-art-v1",
  updatedAt: "2026-11-23T08:00:00.000Z",
};

const ARTIFACT_V2: WorkspaceArtifactItem = {
  ...ARTIFACT_V1,
  content: "# Latency\nP99: 19ms",
  version: 2,
  hash: "hash-art-v2",
  updatedAt: "2026-11-23T08:05:00.000Z",
};

const ARTIFACT_SECOND: WorkspaceArtifactItem = {
  artifactId: "art-schema",
  title: "Schema Diagram",
  kind: "code",
  content: "type Scope = { connectionId: string; profileId: string };",
  version: 1,
  hash: "hash-schema-v1",
  updatedAt: "2026-11-23T08:01:00.000Z",
};

const FILE_DIR_SRC: WorkspaceFileEntry = {
  relativePath: "src",
  name: "src",
  kind: "directory",
  parentPath: null,
};

const FILE_INDEX_V1: WorkspaceFileEntry = {
  relativePath: "src/index.ts",
  name: "index.ts",
  kind: "file",
  parentPath: "src",
  hash: "file-hash-1",
  content: "export const a = 1;\nexport const b = 2;\nexport const c = 3;",
  sizeBytes: 58,
  updatedAt: "2026-11-23T08:00:00.000Z",
};

const FILE_INDEX_V2: WorkspaceFileEntry = {
  ...FILE_INDEX_V1,
  hash: "file-hash-2",
  content: "export const a = 10;\nexport const b = 20;\nexport const c = 30;",
  updatedAt: "2026-11-23T08:06:00.000Z",
};

const FILE_README: WorkspaceFileEntry = {
  relativePath: "README.md",
  name: "README.md",
  kind: "file",
  parentPath: null,
  hash: "file-hash-readme",
  content: "# Hermes Workspace",
  sizeBytes: 18,
  updatedAt: "2026-11-23T08:00:00.000Z",
};

describe("WorkspaceFrame & WorkspaceSessionState domain model (Ticket #35)", () => {
  it("binds Artifacts/Agents to ActiveChat and Files/Git/Terminal to Scope, and derives 448px vs 408px drawer widths", () => {
    expect(getWorkspaceTabBinding("artifacts")).toBe("active_chat");
    expect(getWorkspaceTabBinding("agents")).toBe("active_chat");
    expect(getWorkspaceTabBinding("files")).toBe("scope");
    expect(getWorkspaceTabBinding("git")).toBe("scope");
    expect(getWorkspaceTabBinding("terminal")).toBe("scope");

    expect(deriveWorkspaceDrawerWidth(1440)).toBe(448);
    expect(deriveWorkspaceDrawerWidth(1341)).toBe(448);
    expect(deriveWorkspaceDrawerWidth(1340)).toBe(408);
    expect(deriveWorkspaceDrawerWidth(1280)).toBe(408);

    const initial = createInitialWorkspaceSessionState();
    expect(initial.windowId).toBe("primary");
    expect(initial.paneId).toBe("main");
    expect(initial.frame).toEqual({ mode: "closed", activeTab: "artifacts" });
  });

  it("keeps drawer mode and activeTab on Session switch (swapping only session-keyed Artifacts/Agents) and on Scope switch (swapping scope-keyed Files/Git/Terminal)", () => {
    let state = createInitialWorkspaceSessionState({
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-1",
    });
    state = openWorkspace(state, "artifacts");
    state = reconcileWorkspaceArtifacts(
      state,
      { connectionId: "local", profileId: "default", sessionId: "sess-1" },
      [ARTIFACT_V1, ARTIFACT_SECOND],
    );
    state = selectWorkspaceArtifact(state, "art-schema");
    state = setWorkspaceArtifactScroll(state, 180);
    state = setWorkspaceArtifactZoom(state, 125);
    state = selectWorkspaceAgent(state, "agent-1");
    state = setWorkspaceAgentSteerText(state, "focus on tests");

    state = reconcileWorkspaceFiles(
      state,
      { connectionId: "local", profileId: "default" },
      [FILE_DIR_SRC, FILE_INDEX_V1],
    );
    state = toggleWorkspaceDirectory(state, "src");
    state = selectWorkspaceFile(state, "src/index.ts");
    state = setWorkspaceTerminalScrollback(state, ["$ pnpm test", "PASS"]);

    //Populate sess-2 artifacts separately
    state = reconcileWorkspaceArtifacts(
      state,
      { connectionId: "local", profileId: "default", sessionId: "sess-2" },
      [ARTIFACT_V1],
    );

    // Switch Session within same Scope: mode ("open") & activeTab ("artifacts") stay; scope-keyed Files/Terminal stay; session-keyed view switches to sess-2
    state = switchWorkspaceContext(state, {
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-2",
    });
    expect(state.frame).toEqual({ mode: "open", activeTab: "artifacts" });
    expect(getActiveChatWorkspaceView(state).selectedArtifactId).toBe("art-latency");
    expect(getActiveChatWorkspaceView(state).scrollTop).toBe(0);
    expect(getActiveChatWorkspaceView(state).steerText).toBe("");
    // Scope-keyed state is untouched
    expect(getActiveScopeWorkspaceView(state).selectedFilePath).toBe("src/index.ts");
    expect(getActiveScopeWorkspaceView(state).terminalScrollback).toEqual(["$ pnpm test", "PASS"]);

    // Switch back to sess-1: sess-1 selections & zoom/scroll are still intact
    state = switchWorkspaceContext(state, {
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-1",
    });
    expect(getActiveChatWorkspaceView(state).selectedArtifactId).toBe("art-schema");
    expect(getActiveChatWorkspaceView(state).scrollTop).toBe(180);
    expect(getActiveChatWorkspaceView(state).zoom).toBe(125);
    expect(getActiveChatWorkspaceView(state).steerText).toBe("focus on tests");

    // Switch Scope to vps/prod while hidden on files tab: keeps mode="hidden" and activeTab="files", switches scope-keyed view
    state = setWorkspaceActiveTab(state, "files");
    state = hideWorkspace(state);
    state = switchWorkspaceContext(state, {
      connectionId: "vps",
      profileId: "prod",
      sessionId: "sess-remote-1",
    });
    expect(state.frame).toEqual({ mode: "hidden", activeTab: "files" });
    expect(getActiveScopeWorkspaceView(state).selectedFilePath).toBeNull();
    expect(getActiveScopeWorkspaceView(state).terminalScrollback).toEqual([]);
  });

  it("Hide preserves tab, scrollback, preview/scroll/zoom, annotations, Git/Agents selection, and steer; Close resets preview/selections/steer but keeps annotations in Draft", () => {
    const scope = { connectionId: "local", profileId: "default", sessionId: "sess-1" };
    let state = createInitialWorkspaceSessionState(scope);
    state = openWorkspace(state, "git");
    state = reconcileWorkspaceArtifacts(state, scope, [ARTIFACT_V1, ARTIFACT_SECOND]);
    state = selectWorkspaceArtifact(state, "art-schema");
    state = setWorkspaceArtifactScroll(state, 240);
    state = setWorkspaceArtifactZoom(state, 150);

    const annotation: ArtifactAnnotation = {
      annotationId: "ann-1",
      artifactId: "art-schema",
      artifactVersion: 1,
      artifactHash: "hash-schema-v1",
      xPct: 32.5,
      yPct: 64.2,
      comment: "Check profileId requirement here",
      createdAt: "2026-11-23T08:02:00.000Z",
    };
    state = addWorkspaceAnnotation(state, annotation);

    state = reconcileWorkspaceFiles(state, scope, [FILE_DIR_SRC, FILE_INDEX_V1]);
    state = toggleWorkspaceDirectory(state, "src");
    state = selectWorkspaceFile(state, "src/index.ts");
    state = selectWorkspaceFileLines(state, { startLine: 1, endLine: 2 });
    state = selectWorkspaceGitDiff(state, "src/index.ts", "staged");
    state = selectWorkspaceAgent(state, "subagent-research");
    state = setWorkspaceAgentSteerText(state, "check edge cases");
    state = setWorkspaceTerminalScrollback(state, ["line 1", "line 2"]);

    // Hide: mode becomes "hidden", everything is preserved
    state = hideWorkspace(state);
    expect(state.frame.mode).toBe("hidden");
    expect(state.frame.activeTab).toBe("git");
    const chatAfterHide = getActiveChatWorkspaceView(state);
    const scopeAfterHide = getActiveScopeWorkspaceView(state);
    expect(chatAfterHide.selectedArtifactId).toBe("art-schema");
    expect(chatAfterHide.scrollTop).toBe(240);
    expect(chatAfterHide.zoom).toBe(150);
    expect(chatAfterHide.annotations).toEqual([annotation]);
    expect(chatAfterHide.selectedAgentId).toBe("subagent-research");
    expect(chatAfterHide.steerText).toBe("check edge cases");
    expect(scopeAfterHide.selectedFilePath).toBe("src/index.ts");
    expect(scopeAfterHide.expandedDirs).toEqual(["src"]);
    expect(scopeAfterHide.selectedLineRange).toEqual({
      startLine: 1,
      endLine: 2,
      fileHash: "file-hash-1",
    });
    expect(scopeAfterHide.selectedDiffPath).toBe("src/index.ts");
    expect(scopeAfterHide.diffScope).toBe("staged");
    expect(scopeAfterHide.terminalScrollback).toEqual(["line 1", "line 2"]);

    // Close: mode becomes "closed", preview/selections/expand/diff/agents/steer reset, but annotations stay in Draft and terminal scrollback stays
    state = closeWorkspace(state);
    expect(state.frame.mode).toBe("closed");
    const chatAfterClose = getActiveChatWorkspaceView(state);
    const scopeAfterClose = getActiveScopeWorkspaceView(state);
    expect(chatAfterClose.selectedArtifactId).toBe("art-latency"); // reset to first available
    expect(chatAfterClose.scrollTop).toBe(0);
    expect(chatAfterClose.zoom).toBe(100);
    expect(chatAfterClose.selectedAgentId).toBeNull();
    expect(chatAfterClose.steerText).toBe("");
    // Annotations belong to Draft and MUST NOT be deleted on Close
    expect(chatAfterClose.annotations).toEqual([annotation]);

    expect(scopeAfterClose.selectedFilePath).toBeNull();
    expect(scopeAfterClose.expandedDirs).toEqual([]);
    expect(scopeAfterClose.selectedLineRange).toBeNull();
    expect(scopeAfterClose.selectedDiffPath).toBeNull();
    expect(scopeAfterClose.diffScope).toBe("working");
    expect(scopeAfterClose.terminalScrollback).toEqual(["line 1", "line 2"]);
  });

  it("handles artifact disappearance (fallback to first available or empty state), file deletion (clear selection), file hash change (invalidate line selection), and external changes (keep last-known + stale)", () => {
    const scope = { connectionId: "local", profileId: "default", sessionId: "sess-1" };
    let state = createInitialWorkspaceSessionState(scope);
    state = openWorkspace(state, "artifacts");

    // 1. Load two artifacts and select the second one
    state = reconcileWorkspaceArtifacts(state, scope, [ARTIFACT_V1, ARTIFACT_SECOND]);
    state = selectWorkspaceArtifact(state, "art-schema");
    expect(getActiveChatWorkspaceView(state).selectedArtifactId).toBe("art-schema");

    // Second artifact disappears -> falls back to first available ("art-latency")
    state = reconcileWorkspaceArtifacts(state, scope, [ARTIFACT_V1]);
    expect(getActiveChatWorkspaceView(state).selectedArtifactId).toBe("art-latency");

    // External change on artifacts -> retains last-known items and marks stale=true
    state = markWorkspaceArtifactsExternalStale(state, scope);
    expect(getActiveChatWorkspaceView(state).stale).toBe(true);
    expect(getActiveChatWorkspaceView(state).artifacts).toHaveLength(1);
    expect(getActiveChatWorkspaceView(state).artifacts[0].stale).toBe(true);

    // Remaining artifact disappears -> empty state (selectedArtifactId = null)
    state = reconcileWorkspaceArtifacts(state, scope, []);
    expect(getActiveChatWorkspaceView(state).selectedArtifactId).toBeNull();
    expect(getActiveChatWorkspaceView(state).artifacts).toEqual([]);
    expect(getActiveChatWorkspaceView(state).stale).toBe(false);

    // 2. Files: select src/index.ts and lines 1..2
    state = reconcileWorkspaceFiles(state, scope, [FILE_DIR_SRC, FILE_INDEX_V1, FILE_README]);
    state = selectWorkspaceFile(state, "src/index.ts");
    state = selectWorkspaceFileLines(state, { startLine: 1, endLine: 2 });
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toEqual({
      startLine: 1,
      endLine: 2,
      fileHash: "file-hash-1",
    });
    expect(getActiveScopeWorkspaceView(state).lineSelectionInvalidated).toBe(false);

    // File hash changes (FILE_INDEX_V2) -> keeps file selected, invalidates line selection
    state = reconcileWorkspaceFiles(state, scope, [FILE_DIR_SRC, FILE_INDEX_V2, FILE_README]);
    expect(getActiveScopeWorkspaceView(state).selectedFilePath).toBe("src/index.ts");
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toBeNull();
    expect(getActiveScopeWorkspaceView(state).lineSelectionInvalidated).toBe(true);

    // External change on files -> keeps last-known files and marks stale=true
    state = markWorkspaceFilesExternalStale(state, scope);
    expect(getActiveScopeWorkspaceView(state).stale).toBe(true);
    expect(getActiveScopeWorkspaceView(state).files.find((f) => f.relativePath === "src/index.ts")?.stale).toBe(true);

    // Selected file deleted -> clears selectedFilePath and line selection state
    state = reconcileWorkspaceFiles(state, scope, [FILE_README]);
    expect(getActiveScopeWorkspaceView(state).selectedFilePath).toBeNull();
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toBeNull();
    expect(getActiveScopeWorkspaceView(state).lineSelectionInvalidated).toBe(false);
    expect(getActiveScopeWorkspaceView(state).stale).toBe(false);
  });

  it("anchors annotations to artifactId + version/hash + xPct/yPct + comment and marks '基于旧版本' without recalculating coordinates on artifact update", () => {
    const scope = { connectionId: "local", profileId: "default", sessionId: "sess-1" };
    let state = createInitialWorkspaceSessionState(scope);
    state = reconcileWorkspaceArtifacts(state, scope, [ARTIFACT_V1]);

    const ann: ArtifactAnnotation = {
      annotationId: "ann-v1",
      artifactId: "art-latency",
      artifactVersion: 1,
      artifactHash: "hash-art-v1",
      xPct: 45.8,
      yPct: 12.3,
      comment: "Verify P99 threshold",
      createdAt: "2026-11-23T08:03:00.000Z",
    };
    state = addWorkspaceAnnotation(state, ann);

    // Before update: outdatedVersion is false
    const projectedV1 = projectArtifactAnnotations(
      getActiveChatWorkspaceView(state).annotations,
      ARTIFACT_V1,
    );
    expect(projectedV1).toEqual([
      {
        ...ann,
        outdatedVersion: false,
      },
    ]);

    // Artifact updates to V2 (new version & hash): coordinates xPct/yPct are untouched, outdatedVersion is true
    state = reconcileWorkspaceArtifacts(state, scope, [ARTIFACT_V2]);
    const projectedV2 = projectArtifactAnnotations(
      getActiveChatWorkspaceView(state).annotations,
      ARTIFACT_V2,
    );
    expect(projectedV2).toEqual([
      {
        ...ann,
        xPct: 45.8,
        yPct: 12.3,
        outdatedVersion: true,
      },
    ]);
  });
});
