import { describe, expect, it } from "vitest";
import type {
  ArtifactAnnotation,
  TerminalSnapshot,
  WorkspaceArtifactItem,
  WorkspaceFileEntry,
  WorkspaceGitDiffItem,
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
  reconcileWorkspaceGitDiffs,
  selectWorkspaceAgent,
  selectWorkspaceArtifact,
  selectWorkspaceCheckpoint,
  selectWorkspaceFile,
  selectWorkspaceFileLines,
  selectWorkspaceGitDiff,
  setWorkspaceActiveTab,
  setWorkspaceAgentError,
  setWorkspaceAgentSteerText,
  setWorkspaceAgentTail,
  setWorkspaceArtifactScroll,
  setWorkspaceArtifactZoom,
  setWorkspaceCheckpointDiff,
  setWorkspaceCheckpointError,
  setWorkspaceCheckpointRestorePending,
  setWorkspaceAnnotations,
  setWorkspaceTerminalScrollback,
  setWorkspaceTerminalSnapshot,
  markWorkspaceCheckpointRestored,
  resolveWorkspaceChatKey,
  resolveWorkspaceScopeKey,
  createEmptyChatWorkspaceView,
  createEmptyScopeWorkspaceView,
  switchWorkspaceContext,
  toggleWorkspaceDirectory,
  boundSubagentTailLines,
  invalidateWorkspaceGeneration,
  reconcileWorkspaceAgents,
  reconcileWorkspaceCheckpoints,
  validateCheckpointRestoreBinding,
  MAX_SUBAGENT_TAIL_LINES,
  MAX_SUBAGENT_TAIL_BYTES,
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

  it("models Subagents bounded tail, generation invalidation, read-only last-known roster, and Checkpoint restore confirmation/binding/error preservation (Ticket #41)", () => {
    expect(getWorkspaceTabBinding("checkpoints")).toBe("active_chat");

    // 1. Bounded Subagent tail (MAX_SUBAGENT_TAIL_LINES = 200)
    const manyLines = Array.from({ length: 250 }, (_, idx) => `log-line-${idx + 1}`);
    const bounded = boundSubagentTailLines(manyLines);
    expect(bounded.truncated).toBe(true);
    expect(bounded.lines).toHaveLength(MAX_SUBAGENT_TAIL_LINES);
    expect(bounded.lines[0]).toBe("log-line-51");
    expect(bounded.lines[MAX_SUBAGENT_TAIL_LINES - 1]).toBe("log-line-250");

    const scopeA = { connectionId: "local", profileId: "default", sessionId: "sess-1" };
    let state = createInitialWorkspaceSessionState(scopeA);
    state = reconcileWorkspaceAgents(
      state,
      scopeA,
      [
        {
          agentId: "sub-1",
          name: "Verifier",
          role: "Test Runner",
          status: "running",
          summary: "Running vitest",
        },
      ],
      { readOnly: true, lastKnown: true },
    );
    expect(getActiveChatWorkspaceView(state).agentsReadOnly).toBe(true);
    expect(getActiveChatWorkspaceView(state).agents[0].lastKnown).toBe(true);

    // Store tail at generation 2
    state = setWorkspaceAgentTail(
      state,
      {
        agentId: "sub-1",
        lines: ["step 1", "step 2"],
        truncated: false,
        generation: 2,
        updatedAt: "2026-11-23T09:00:00.000Z",
      },
      scopeA,
    );
    expect(getActiveChatWorkspaceView(state).agentTailById["sub-1"]?.lines).toEqual(["step 1", "step 2"]);
    expect(getActiveChatWorkspaceView(state).tailInvalidatedById["sub-1"]).toBeFalsy();

    // Generation bumps to 3 -> old tail is invalidated and cleared
    state = invalidateWorkspaceGeneration(state, 3);
    expect(getActiveChatWorkspaceView(state).agentTailById["sub-1"]).toBeUndefined();
    expect(getActiveChatWorkspaceView(state).tailInvalidatedById["sub-1"]).toBe(true);

    // Subagent error stores safe typed ErrorCode
    state = setWorkspaceAgentError(state, {
      code: "conflict",
      message: "Subagent 停止请求未被确认",
      retryable: true,
      actionId: "subagents.interrupt",
      detail: "Gateway denied interrupt while tool call is locked",
    });
    expect(getActiveChatWorkspaceView(state).agentError?.code).toBe("conflict");

    // 2. Checkpoints: list, select, diff, explicit restore confirmation, scope/generation binding, and failure preserving selection
    state = reconcileWorkspaceCheckpoints(
      state,
      scopeA,
      [
        {
          checkpointId: "ckpt-1",
          title: "Before schema migration",
          summary: "3 files tracked",
          createdAt: "2026-11-23T08:30:00.000Z",
        },
        {
          checkpointId: "ckpt-2",
          title: "After test pass",
          summary: "5 files tracked",
          createdAt: "2026-11-23T08:45:00.000Z",
        },
      ],
      { canRestore: false },
    );
    expect(getActiveChatWorkspaceView(state).checkpointsCanRestore).toBe(false);
    expect(getActiveChatWorkspaceView(state).selectedCheckpointId).toBe("ckpt-1");

    state = selectWorkspaceCheckpoint(state, "ckpt-2");
    state = setWorkspaceCheckpointDiff(
      state,
      {
        checkpointId: "ckpt-2",
        summary: "2 files changed (+14 -3)",
        patch: "@@ -1,3 +1,14 @@\n+export const ready = true;",
        filesChanged: 2,
      },
      scopeA,
    );
    expect(getActiveChatWorkspaceView(state).checkpointDiffById["ckpt-2"]?.filesChanged).toBe(2);

    // Explicit restore confirmation pending state
    state = setWorkspaceCheckpointRestorePending(state, "ckpt-2");
    expect(getActiveChatWorkspaceView(state).checkpointRestorePendingId).toBe("ckpt-2");

    // Validate restore binding against current scope & generation
    const validCheck = validateCheckpointRestoreBinding(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        checkpointId: "ckpt-2",
        generation: 3,
      },
      scopeA,
      3,
    );
    expect(validCheck).toEqual({ valid: true });

    // Cross-scope restore is rejected with scope_mismatch
    const crossScopeCheck = validateCheckpointRestoreBinding(
      {
        connectionId: "local",
        profileId: "work",
        sessionId: "sess-1",
        checkpointId: "ckpt-2",
        generation: 3,
      },
      scopeA,
      3,
    );
    expect(crossScopeCheck).toEqual({
      valid: false,
      code: "scope_mismatch",
      message: "Checkpoint 恢复绑定与当前活动 Scope 不匹配，已拒绝跨 Scope 回滚。",
    });

    // Stale generation restore is rejected with conflict
    const staleGenCheck = validateCheckpointRestoreBinding(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        checkpointId: "ckpt-2",
        generation: 2,
      },
      scopeA,
      3,
    );
    expect(staleGenCheck).toEqual({
      valid: false,
      code: "conflict",
      message: "连接代际（Generation）已变更，请重新确认后再恢复 Checkpoint。",
    });

    // Failure on restore preserves selectedCheckpointId ("ckpt-2") and records safe error
    state = setWorkspaceCheckpointError(state, {
      code: "conflict",
      message: "恢复 Checkpoint 失败，当前 Session 状态未变更",
      retryable: true,
      actionId: "checkpoint.restore",
    });
    expect(getActiveChatWorkspaceView(state).selectedCheckpointId).toBe("ckpt-2");
    expect(getActiveChatWorkspaceView(state).checkpointError?.code).toBe("conflict");
  });

  it("covers scope/chat key defaults, missing-view fallbacks, and null-target reducer branches", () => {
    expect(resolveWorkspaceScopeKey()).toBe("unconnected::default");
    expect(resolveWorkspaceScopeKey({ connectionId: "local" })).toBe("local::default");
    expect(resolveWorkspaceChatKey({ connectionId: "local", profileId: "work" })).toBe(
      "local::work::none",
    );
    expect(resolveWorkspaceChatKey()).toBe("unconnected::default::none");
    expect(createEmptyChatWorkspaceView("chat-x").chatKey).toBe("chat-x");
    expect(createEmptyScopeWorkspaceView("scope-x").scopeKey).toBe("scope-x");

    const scope = { connectionId: "local", profileId: "default", sessionId: "sess-1" };
    let state = createInitialWorkspaceSessionState(scope);
    state = openWorkspace(state);
    expect(state.frame).toEqual({ mode: "open", activeTab: "artifacts" });
    state = closeWorkspace(state);
    expect(getActiveChatWorkspaceView(state).selectedArtifactId).toBeNull();

    // Missing views resolve to empty defaults without mutating the stored state.
    const missingViewState = { ...state, activeChatKey: "missing-chat", activeScopeKey: "missing-scope" };
    expect(getActiveChatWorkspaceView(missingViewState).chatKey).toBe("missing-chat");
    expect(getActiveScopeWorkspaceView(missingViewState).scopeKey).toBe("missing-scope");
    expect(missingViewState.byChatKey["missing-chat"]).toBeUndefined();
    expect(missingViewState.byScopeKey["missing-scope"]).toBeUndefined();

    // Null targetScope paths use the active keys; unknown keys create empty views on write.
    state = reconcileWorkspaceArtifacts(state, null, [ARTIFACT_V1]);
    expect(getActiveChatWorkspaceView(state).artifacts).toHaveLength(1);
    state = markWorkspaceArtifactsExternalStale(state);
    expect(getActiveChatWorkspaceView(state).stale).toBe(true);
    state = markWorkspaceArtifactsExternalStale(
      state,
      { connectionId: "vps", profileId: "prod", sessionId: "missing-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({ connectionId: "vps", profileId: "prod", sessionId: "missing-session" })]
        .stale,
    ).toBe(true);

    const annotation: ArtifactAnnotation = {
      annotationId: "ann-coverage",
      artifactId: "art-latency",
      artifactVersion: 1,
      artifactHash: "hash-art-v1",
      xPct: 10,
      yPct: 20,
      comment: "coverage",
      createdAt: "2026-11-23T08:00:00.000Z",
    };
    state = addWorkspaceAnnotation(state, annotation);
    expect(getActiveChatWorkspaceView(state).annotations).toEqual([annotation]);
    state = addWorkspaceAnnotation(state, annotation, {
      connectionId: "vps",
      profileId: "prod",
      sessionId: "target-session",
    });
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].annotations,
    ).toEqual([annotation]);
    expect(projectArtifactAnnotations([annotation], null)).toEqual([]);
    expect(projectArtifactAnnotations([annotation], undefined)).toEqual([]);
    state = setWorkspaceAnnotations(state, [annotation]);
    expect(getActiveChatWorkspaceView(state).annotations).toEqual([annotation]);
    state = setWorkspaceAnnotations(state, [], {
      connectionId: "vps",
      profileId: "prod",
      sessionId: "target-session",
    });
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].annotations,
    ).toEqual([]);

    // Files: null target, missing view, deselection with and without a selected file.
    state = reconcileWorkspaceFiles(state, null, [FILE_DIR_SRC, FILE_INDEX_V1]);
    expect(getActiveScopeWorkspaceView(state).files).toHaveLength(2);
    state = reconcileWorkspaceFiles(
      state,
      { connectionId: "vps", profileId: "prod" },
      [FILE_README],
    );
    expect(
      state.byScopeKey[resolveWorkspaceScopeKey({ connectionId: "vps", profileId: "prod" })]
        .files,
    ).toHaveLength(1);
    state = selectWorkspaceFile(state, "src/index.ts");
    state = selectWorkspaceFileLines(state, { startLine: 1, endLine: 2 });
    state = selectWorkspaceFile(state, "src/index.ts");
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toEqual({
      startLine: 1,
      endLine: 2,
      fileHash: "file-hash-1",
    });
    state = selectWorkspaceFileLines(state, null);
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toBeNull();
    state = selectWorkspaceFile(state, null);
    state = selectWorkspaceFileLines(state, { startLine: 1, endLine: 2 });
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toBeNull();
    state = selectWorkspaceFile(state, "README.md");
    state = selectWorkspaceFileLines(state, { startLine: 3, endLine: 1 });
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toEqual({
      startLine: 1,
      endLine: 3,
      fileHash: "unhashed",
    });
    state = selectWorkspaceFile(state, "missing.ts");
    state = selectWorkspaceFileLines(state, { startLine: 1, endLine: 1 });
    expect(getActiveScopeWorkspaceView(state).selectedLineRange).toEqual({
      startLine: 1,
      endLine: 1,
      fileHash: "unhashed",
    });
    state = markWorkspaceFilesExternalStale(state);
    expect(getActiveScopeWorkspaceView(state).stale).toBe(true);
    state = markWorkspaceFilesExternalStale(state, {
      connectionId: "vps",
      profileId: "prod",
    });
    expect(
      state.byScopeKey[resolveWorkspaceScopeKey({ connectionId: "vps", profileId: "prod" })].stale,
    ).toBe(true);

    state = toggleWorkspaceDirectory(state, "src");
    state = toggleWorkspaceDirectory(state, "src");
    expect(getActiveScopeWorkspaceView(state).expandedDirs).toEqual([]);
    state = selectWorkspaceGitDiff(state, "README.md");
    expect(getActiveScopeWorkspaceView(state).diffScope).toBe("working");
    state = selectWorkspaceGitDiff(state, "README.md", "staged");
    expect(getActiveScopeWorkspaceView(state).diffScope).toBe("staged");

    // Agents: null/missing targets, empty roster, invalid-selection resets, and readOnly fallback.
    state = reconcileWorkspaceAgents(state, null, [
      {
        agentId: "agent-null",
        name: "Agent",
        role: "Runner",
        status: "idle",
      },
    ]);
    expect(getActiveChatWorkspaceView(state).selectedAgentId).toBe("agent-null");
    state = selectWorkspaceAgent(state, "agent-null");
    state = reconcileWorkspaceAgents(state, null, [
      {
        agentId: "agent-null",
        name: "Agent",
        role: "Runner",
        status: "idle",
      },
      {
        agentId: "agent-second",
        name: "Second",
        role: "Runner",
        status: "idle",
      },
    ]);
    expect(getActiveChatWorkspaceView(state).selectedAgentId).toBe("agent-null");
    state = reconcileWorkspaceAgents(state, null, []);
    expect(getActiveChatWorkspaceView(state).selectedAgentId).toBeNull();
    state = reconcileWorkspaceAgents(
      state,
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
      [
        {
          agentId: "agent-missing",
          name: "Missing",
          role: "Runner",
          status: "idle",
        },
      ],
      { readOnly: true },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].agentsReadOnly,
    ).toBe(true);
    expect(getActiveChatWorkspaceView(state).agentsReadOnly).toBe(false);

    // Bounded tails: byte cap with multiple lines, and a single oversized line is still kept.
    expect(boundSubagentTailLines(["aaaa", "bbbb"], 10, 5)).toEqual({
      lines: ["bbbb"],
      truncated: true,
    });
    expect(boundSubagentTailLines(["123456789"], 10, 5)).toEqual({
      lines: ["123456789"],
      truncated: false,
    });
    expect(MAX_SUBAGENT_TAIL_BYTES).toBe(32 * 1024);
    state = setWorkspaceAgentTail(
      state,
      {
        agentId: "tail-null",
        lines: ["one"],
        truncated: false,
        generation: 1,
        updatedAt: "2026-11-23T08:00:00.000Z",
      },
    );
    expect(getActiveChatWorkspaceView(state).agentTailById["tail-null"].lines).toEqual(["one"]);
    state = setWorkspaceAgentTail(
      state,
      {
        agentId: "tail-missing",
        lines: ["two"],
        truncated: false,
        generation: 1,
        updatedAt: "2026-11-23T08:00:00.000Z",
      },
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].agentTailById["tail-missing"].lines,
    ).toEqual(["two"]);
    state = setWorkspaceAgentError(state, null);
    expect(getActiveChatWorkspaceView(state).agentError).toBeNull();
    state = setWorkspaceAgentError(
      state,
      { code: "internal", message: "error", retryable: true },
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].agentError?.code,
    ).toBe("internal");

    // Generation invalidation: clean views are preserved, pending restores are cleared.
    let cleanState = createInitialWorkspaceSessionState(scope);
    expect(invalidateWorkspaceGeneration(cleanState, 2).byChatKey[cleanState.activeChatKey]).toBe(
      cleanState.byChatKey[cleanState.activeChatKey],
    );
    cleanState = setWorkspaceAgentTail(cleanState, {
      agentId: "tail-current",
      lines: ["current"],
      truncated: false,
      generation: 2,
      updatedAt: "2026-11-23T08:00:00.000Z",
    });
    cleanState = invalidateWorkspaceGeneration(cleanState, 2);
    expect(getActiveChatWorkspaceView(cleanState).agentTailById["tail-current"].generation).toBe(2);
    expect(getActiveChatWorkspaceView(cleanState).tailInvalidatedById["tail-current"]).toBeUndefined();
    state = setWorkspaceCheckpointRestorePending(state, "ckpt-pending");
    state = selectWorkspaceCheckpoint(state, "ckpt-pending");
    expect(getActiveChatWorkspaceView(state).checkpointRestorePendingId).toBe("ckpt-pending");
    state = invalidateWorkspaceGeneration(state, 2);
    expect(getActiveChatWorkspaceView(state).checkpointRestorePendingId).toBeNull();

    // Checkpoints: null/missing target, selection fallbacks, option fallback, restore dedupe/error.
    const checkpoint = {
      checkpointId: "ckpt-null",
      title: "Checkpoint",
      createdAt: "2026-11-23T08:00:00.000Z",
    };
    state = reconcileWorkspaceCheckpoints(state, null, [checkpoint]);
    expect(getActiveChatWorkspaceView(state).selectedCheckpointId).toBe("ckpt-null");
    state = selectWorkspaceCheckpoint(state, "ckpt-null");
    state = reconcileWorkspaceCheckpoints(state, null, [
      checkpoint,
      {
        checkpointId: "ckpt-other",
        title: "Other",
        createdAt: "2026-11-23T08:00:00.000Z",
      },
    ]);
    expect(getActiveChatWorkspaceView(state).selectedCheckpointId).toBe("ckpt-null");
    state = selectWorkspaceCheckpoint(state, "ckpt-not-there");
    state = reconcileWorkspaceCheckpoints(state, null, []);
    expect(getActiveChatWorkspaceView(state).selectedCheckpointId).toBeNull();
    state = reconcileWorkspaceCheckpoints(
      state,
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
      [checkpoint],
      { canRestore: false },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].checkpointsCanRestore,
    ).toBe(false);
    state = setWorkspaceCheckpointDiff(
      state,
      {
        checkpointId: "ckpt-diff",
        summary: "diff",
        patch: "@@",
      },
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].checkpointDiffById["ckpt-diff"].summary,
    ).toBe("diff");
    state = setWorkspaceCheckpointDiff(
      state,
      {
        checkpointId: "ckpt-diff-null",
        summary: "diff-null",
        patch: "@@",
      },
    );
    expect(getActiveChatWorkspaceView(state).checkpointDiffById["ckpt-diff-null"].summary).toBe(
      "diff-null",
    );
    state = setWorkspaceCheckpointRestorePending(
      state,
      "ckpt-missing",
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].checkpointRestorePendingId,
    ).toBe("ckpt-missing");
    state = markWorkspaceCheckpointRestored(state, "ckpt-restored");
    state = markWorkspaceCheckpointRestored(state, "ckpt-restored");
    expect(getActiveChatWorkspaceView(state).restoredCheckpointIds).toEqual(["ckpt-restored"]);
    state = markWorkspaceCheckpointRestored(
      state,
      "ckpt-restored-missing",
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].restoredCheckpointIds,
    ).toEqual(["ckpt-restored-missing"]);
    state = setWorkspaceCheckpointError(state, null);
    expect(getActiveChatWorkspaceView(state).checkpointError).toBeNull();
    state = setWorkspaceCheckpointError(
      state,
      { code: "internal", message: "checkpoint error", retryable: true },
      { connectionId: "vps", profileId: "prod", sessionId: "target-session" },
    );
    expect(
      state.byChatKey[resolveWorkspaceChatKey({
        connectionId: "vps",
        profileId: "prod",
        sessionId: "target-session",
      })].checkpointError?.code,
    ).toBe("internal");

    expect(
      validateCheckpointRestoreBinding(
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "sess-1",
          checkpointId: "ckpt-null",
          generation: 2,
        },
        null,
        2,
      ),
    ).toMatchObject({ valid: false, code: "scope_mismatch" });
    expect(
      validateCheckpointRestoreBinding(
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "sess-1",
          checkpointId: "",
          generation: 2,
        },
        scope,
        2,
      ),
    ).toEqual({
      valid: false,
      code: "invalid_request",
      message: "未指定要恢复的 Checkpoint。",
    });

    // Git diffs: null target, missing view, selection preserved/reset/empty.
    const diff: WorkspaceGitDiffItem = {
      relativePath: "README.md",
      status: "modified",
      summary: "1 file changed",
    };
    state = reconcileWorkspaceGitDiffs(state, null, [diff]);
    expect(getActiveScopeWorkspaceView(state).selectedDiffPath).toBe("README.md");
    state = selectWorkspaceGitDiff(state, "README.md", "staged");
    state = reconcileWorkspaceGitDiffs(state, null, [diff]);
    expect(getActiveScopeWorkspaceView(state).selectedDiffPath).toBe("README.md");
    state = reconcileWorkspaceGitDiffs(state, null, []);
    expect(getActiveScopeWorkspaceView(state).selectedDiffPath).toBeNull();
    state = reconcileWorkspaceGitDiffs(
      state,
      { connectionId: "vps", profileId: "prod" },
      [diff],
    );
    expect(
      state.byScopeKey[resolveWorkspaceScopeKey({ connectionId: "vps", profileId: "prod" })]
        .selectedDiffPath,
    ).toBe("README.md");

    // Terminal scrollback/snapshot across null/missing targets and both snapshot values.
    state = setWorkspaceTerminalScrollback(state, ["line"]);
    expect(getActiveScopeWorkspaceView(state).terminalScrollback).toEqual(["line"]);
    state = setWorkspaceTerminalScrollback(
      state,
      ["missing"],
      { connectionId: "vps", profileId: "prod" },
    );
    expect(
      state.byScopeKey[resolveWorkspaceScopeKey({ connectionId: "vps", profileId: "prod" })]
        .terminalScrollback,
    ).toEqual(["missing"]);
    const snapshot: TerminalSnapshot = {
      terminalId: "term-1",
      scope: { connectionId: "local", profileId: "default" },
      status: "running",
      cols: 80,
      rows: 24,
      granted: true,
      rootGranted: false,
      hasForegroundProcess: false,
      lines: ["$ pwd"],
      trimmedOldest: false,
      totalBytes: 5,
      lineCount: 1,
      attribution: {
        origin: "builtin",
        sourceLabel: "内置",
        accessibleLabel: "内置",
      },
      updatedAt: "2026-11-23T08:00:00.000Z",
    };
    state = setWorkspaceTerminalSnapshot(state, snapshot);
    expect(getActiveScopeWorkspaceView(state).terminalSnapshot?.lines).toEqual(["$ pwd"]);
    expect(getActiveScopeWorkspaceView(state).terminalScrollback).toEqual(["$ pwd"]);
    state = setWorkspaceTerminalSnapshot(
      state,
      snapshot,
      { connectionId: "vps", profileId: "prod" },
    );
    expect(
      state.byScopeKey[resolveWorkspaceScopeKey({ connectionId: "vps", profileId: "prod" })]
        .terminalSnapshot?.terminalId,
    ).toBe("term-1");
    state = setWorkspaceTerminalSnapshot(state, null);
    expect(getActiveScopeWorkspaceView(state).terminalSnapshot).toBeNull();
    expect(getActiveScopeWorkspaceView(state).terminalScrollback).toEqual([]);
  });

  it("creates missing views for every scoped writer and validates optional scope fields", () => {
    const scope = { connectionId: "local", profileId: "default", sessionId: "sess-1" };
    let state = createInitialWorkspaceSessionState(scope);

    expect(resolveWorkspaceChatKey({ connectionId: "local" })).toBe("local::default::none");

    const annotation: ArtifactAnnotation = {
      annotationId: "ann-missing-view",
      artifactId: "art-latency",
      artifactVersion: 1,
      artifactHash: "hash-art-v1",
      xPct: 1,
      yPct: 2,
      comment: "missing view",
      createdAt: "2026-11-23T08:00:00.000Z",
    };
    const chatScope = (suffix: string) => ({
      connectionId: "ghost",
      profileId: "ghost",
      sessionId: `missing-chat-${suffix}`,
    });
    const annotationsScope = chatScope("annotations");
    const agentsScope = chatScope("agents");
    const tailScope = chatScope("tail");
    const agentErrorScope = chatScope("agent-error");
    const checkpointsScope = chatScope("checkpoints");
    const diffScope = chatScope("diff");
    const restorePendingScope = chatScope("restore-pending");
    const restoredScope = chatScope("restored");
    const checkpointErrorScope = chatScope("checkpoint-error");

    state = setWorkspaceAnnotations(state, [annotation], annotationsScope);
    state = reconcileWorkspaceAgents(
      state,
      agentsScope,
      [{ agentId: "agent-missing-view", name: "Agent", role: "Runner", status: "idle" }],
      { lastKnown: true },
    );
    state = setWorkspaceAgentTail(
      state,
      {
        agentId: "tail-missing-view",
        lines: ["tail"],
        truncated: false,
        generation: 1,
        updatedAt: "2026-11-23T08:00:00.000Z",
      },
      tailScope,
    );
    state = setWorkspaceAgentError(
      state,
      { code: "internal", message: "missing", retryable: true },
      agentErrorScope,
    );
    state = reconcileWorkspaceCheckpoints(
      state,
      checkpointsScope,
      [{ checkpointId: "ckpt-missing-view", title: "Checkpoint", createdAt: "2026-11-23T08:00:00.000Z" }],
      { canRestore: false },
    );
    state = setWorkspaceCheckpointDiff(
      state,
      { checkpointId: "ckpt-missing-view", summary: "diff", patch: "@@" },
      diffScope,
    );
    state = setWorkspaceCheckpointRestorePending(state, "ckpt-missing-view", restorePendingScope);
    state = markWorkspaceCheckpointRestored(state, "ckpt-missing-view", restoredScope);
    state = setWorkspaceCheckpointError(
      state,
      { code: "internal", message: "missing", retryable: true },
      checkpointErrorScope,
    );

    const view = (scope: { connectionId: string; profileId: string; sessionId: string }) =>
      state.byChatKey[resolveWorkspaceChatKey(scope)];
    expect(view(annotationsScope).annotations).toEqual([annotation]);
    expect(view(agentsScope).agents[0].lastKnown).toBe(true);
    expect(view(tailScope).agentTailById["tail-missing-view"].lines).toEqual(["tail"]);
    expect(view(agentErrorScope).agentError?.code).toBe("internal");
    expect(view(checkpointsScope).selectedCheckpointId).toBe("ckpt-missing-view");
    expect(view(checkpointsScope).checkpointsCanRestore).toBe(false);
    expect(view(diffScope).checkpointDiffById["ckpt-missing-view"].summary).toBe("diff");
    expect(view(restorePendingScope).checkpointRestorePendingId).toBe("ckpt-missing-view");
    expect(view(restoredScope).restoredCheckpointIds).toEqual(["ckpt-missing-view"]);
    expect(view(checkpointErrorScope).checkpointError?.code).toBe("internal");

    const scopeFor = (connectionId: string, profileId: string) => ({ connectionId, profileId });
    const staleScope = scopeFor("ghost", "stale");
    const gitScope = scopeFor("ghost", "git");
    const scrollbackScope = scopeFor("ghost", "scrollback");
    const snapshotScope = scopeFor("ghost", "snapshot");
    state = markWorkspaceFilesExternalStale(state, staleScope);
    state = reconcileWorkspaceGitDiffs(
      state,
      gitScope,
      [{ relativePath: "README.md", status: "modified", summary: "1 file changed" }],
    );
    state = setWorkspaceTerminalScrollback(state, ["missing-view"], scrollbackScope);
    state = setWorkspaceTerminalSnapshot(
      state,
      {
        terminalId: "term-missing-view",
        scope: { connectionId: "ghost", profileId: "ghost" },
        status: "running",
        cols: 80,
        rows: 24,
        granted: true,
        rootGranted: false,
        hasForegroundProcess: false,
        lines: ["line"],
        trimmedOldest: false,
        totalBytes: 5,
        lineCount: 1,
        attribution: { origin: "builtin", sourceLabel: "内置", accessibleLabel: "内置" },
        updatedAt: "2026-11-23T08:00:00.000Z",
      },
      snapshotScope,
    );

    const scopeView = (scope: { connectionId: string; profileId: string }) =>
      state.byScopeKey[resolveWorkspaceScopeKey(scope)];
    expect(scopeView(staleScope).stale).toBe(true);
    expect(scopeView(gitScope).selectedDiffPath).toBe("README.md");
    expect(scopeView(scrollbackScope).terminalScrollback).toEqual(["missing-view"]);
    expect(scopeView(snapshotScope).terminalSnapshot?.terminalId).toBe("term-missing-view");
    expect(scopeView(snapshotScope).terminalScrollback).toEqual(["line"]);

    const binding = {
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-1",
      checkpointId: "ckpt-1",
      generation: 0,
    };
    expect(
      validateCheckpointRestoreBinding(
        binding,
        { connectionId: "local", sessionId: "sess-1" },
        0,
      ),
    ).toEqual({ valid: true });
    expect(
      validateCheckpointRestoreBinding(
        binding,
        { connectionId: "", sessionId: "sess-1" },
        0,
      ),
    ).toMatchObject({ valid: false, code: "scope_mismatch" });
    expect(
      validateCheckpointRestoreBinding(binding, { connectionId: "local" }, 0),
    ).toMatchObject({ valid: false, code: "scope_mismatch" });
    expect(
      validateCheckpointRestoreBinding({ ...binding, connectionId: "other" }, scope, 0),
    ).toMatchObject({ valid: false, code: "scope_mismatch" });
    expect(
      validateCheckpointRestoreBinding({ ...binding, profileId: "other" }, scope, 0),
    ).toMatchObject({ valid: false, code: "scope_mismatch" });
    expect(
      validateCheckpointRestoreBinding({ ...binding, sessionId: "other" }, scope, 0),
    ).toMatchObject({ valid: false, code: "scope_mismatch" });
    expect(validateCheckpointRestoreBinding(binding, scope, 1)).toEqual({
      valid: false,
      code: "conflict",
      message: "连接代际（Generation）已变更，请重新确认后再恢复 Checkpoint。",
    });
    expect(
      validateCheckpointRestoreBinding({ ...binding, checkpointId: "   " }, scope, 0),
    ).toMatchObject({ valid: false, code: "invalid_request" });
  });
});
