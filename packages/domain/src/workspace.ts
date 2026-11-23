import type {
  ArtifactAnnotation,
  BridgeScope,
  ProjectedArtifactAnnotation,
  WorkspaceAgentItem,
  WorkspaceArtifactItem,
  WorkspaceFileEntry,
  WorkspaceFrame,
  WorkspaceGitDiffItem,
  WorkspaceLineSelection,
  WorkspaceTab,
  WorkspaceTabBinding,
} from "@hermes/contracts";
import { makeScopeKey, makeSessionKey } from "./activeChatResolver";

export interface ActiveChatWorkspaceView {
  chatKey: string;
  artifacts: WorkspaceArtifactItem[];
  selectedArtifactId: string | null;
  scrollTop: number;
  zoom: number;
  stale: boolean;
  annotations: ArtifactAnnotation[];
  agents: WorkspaceAgentItem[];
  selectedAgentId: string | null;
  steerText: string;
}

export interface ScopeWorkspaceView {
  scopeKey: string;
  files: WorkspaceFileEntry[];
  selectedFilePath: string | null;
  expandedDirs: string[];
  selectedLineRange: WorkspaceLineSelection | null;
  lineSelectionInvalidated: boolean;
  stale: boolean;
  gitDiffs: WorkspaceGitDiffItem[];
  selectedDiffPath: string | null;
  diffScope: "working" | "staged";
  terminalScrollback: string[];
}

export interface WorkspaceSessionState {
  windowId: "primary";
  paneId: "main";
  frame: WorkspaceFrame;
  activeScopeKey: string;
  activeChatKey: string;
  byChatKey: Record<string, ActiveChatWorkspaceView>;
  byScopeKey: Record<string, ScopeWorkspaceView>;
}

const DEFAULT_SCOPE_KEY = "unconnected::default";
const DEFAULT_CHAT_KEY = "unconnected::default::none";

export function getWorkspaceTabBinding(tab: WorkspaceTab): WorkspaceTabBinding {
  switch (tab) {
    case "artifacts":
    case "agents":
      return "active_chat";
    case "files":
    case "git":
    case "terminal":
      return "scope";
  }
}

export function deriveWorkspaceDrawerWidth(viewportWidth: number): 448 | 408 {
  return viewportWidth <= 1340 ? 408 : 448;
}

export function resolveWorkspaceScopeKey(scope?: BridgeScope | null): string {
  if (!scope?.connectionId) return DEFAULT_SCOPE_KEY;
  return makeScopeKey(scope.connectionId, scope.profileId ?? "default");
}

export function resolveWorkspaceChatKey(scope?: BridgeScope | null): string {
  if (!scope?.connectionId) return DEFAULT_CHAT_KEY;
  return makeSessionKey(
    scope.connectionId,
    scope.profileId ?? "default",
    scope.sessionId ?? "none",
  );
}

export function createEmptyChatWorkspaceView(chatKey: string): ActiveChatWorkspaceView {
  return {
    chatKey,
    artifacts: [],
    selectedArtifactId: null,
    scrollTop: 0,
    zoom: 100,
    stale: false,
    annotations: [],
    agents: [],
    selectedAgentId: null,
    steerText: "",
  };
}

export function createEmptyScopeWorkspaceView(scopeKey: string): ScopeWorkspaceView {
  return {
    scopeKey,
    files: [],
    selectedFilePath: null,
    expandedDirs: [],
    selectedLineRange: null,
    lineSelectionInvalidated: false,
    stale: false,
    gitDiffs: [],
    selectedDiffPath: null,
    diffScope: "working",
    terminalScrollback: [],
  };
}

export function createInitialWorkspaceSessionState(
  initialScope?: BridgeScope | null,
): WorkspaceSessionState {
  const activeScopeKey = resolveWorkspaceScopeKey(initialScope);
  const activeChatKey = resolveWorkspaceChatKey(initialScope);
  return {
    windowId: "primary",
    paneId: "main",
    frame: {
      mode: "closed",
      activeTab: "artifacts",
    },
    activeScopeKey,
    activeChatKey,
    byChatKey: {
      [activeChatKey]: createEmptyChatWorkspaceView(activeChatKey),
    },
    byScopeKey: {
      [activeScopeKey]: createEmptyScopeWorkspaceView(activeScopeKey),
    },
  };
}

export function getActiveChatWorkspaceView(
  state: WorkspaceSessionState,
): ActiveChatWorkspaceView {
  return (
    state.byChatKey[state.activeChatKey] ??
    createEmptyChatWorkspaceView(state.activeChatKey)
  );
}

export function getActiveScopeWorkspaceView(
  state: WorkspaceSessionState,
): ScopeWorkspaceView {
  return (
    state.byScopeKey[state.activeScopeKey] ??
    createEmptyScopeWorkspaceView(state.activeScopeKey)
  );
}

export function openWorkspace(
  state: WorkspaceSessionState,
  tab?: WorkspaceTab,
): WorkspaceSessionState {
  return {
    ...state,
    frame: {
      mode: "open",
      activeTab: tab ?? state.frame.activeTab,
    },
  };
}

export function hideWorkspace(state: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...state,
    frame: {
      ...state.frame,
      mode: "hidden",
    },
  };
}

export function closeWorkspace(state: WorkspaceSessionState): WorkspaceSessionState {
  const chatView = getActiveChatWorkspaceView(state);
  const scopeView = getActiveScopeWorkspaceView(state);
  const firstArtifactId = chatView.artifacts[0]?.artifactId ?? null;

  return {
    ...state,
    frame: {
      ...state.frame,
      mode: "closed",
    },
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...chatView,
        selectedArtifactId: firstArtifactId,
        scrollTop: 0,
        zoom: 100,
        selectedAgentId: null,
        steerText: "",
        // Annotations belong to Draft and MUST NOT be deleted on Close
        annotations: [...chatView.annotations],
      },
    },
    byScopeKey: {
      ...state.byScopeKey,
      [state.activeScopeKey]: {
        ...scopeView,
        selectedFilePath: null,
        expandedDirs: [],
        selectedLineRange: null,
        lineSelectionInvalidated: false,
        selectedDiffPath: null,
        diffScope: "working",
        // Terminal scrollback is preserved across Hide / Close-detach
        terminalScrollback: [...scopeView.terminalScrollback],
      },
    },
  };
}

export function setWorkspaceActiveTab(
  state: WorkspaceSessionState,
  tab: WorkspaceTab,
): WorkspaceSessionState {
  return {
    ...state,
    frame: {
      ...state.frame,
      activeTab: tab,
    },
  };
}

export function switchWorkspaceContext(
  state: WorkspaceSessionState,
  nextScope: BridgeScope | null,
): WorkspaceSessionState {
  const nextScopeKey = resolveWorkspaceScopeKey(nextScope);
  const nextChatKey = resolveWorkspaceChatKey(nextScope);

  return {
    ...state,
    activeScopeKey: nextScopeKey,
    activeChatKey: nextChatKey,
    byChatKey: state.byChatKey[nextChatKey]
      ? state.byChatKey
      : {
          ...state.byChatKey,
          [nextChatKey]: createEmptyChatWorkspaceView(nextChatKey),
        },
    byScopeKey: state.byScopeKey[nextScopeKey]
      ? state.byScopeKey
      : {
          ...state.byScopeKey,
          [nextScopeKey]: createEmptyScopeWorkspaceView(nextScopeKey),
        },
  };
}

export function reconcileWorkspaceArtifacts(
  state: WorkspaceSessionState,
  targetScope: BridgeScope | null,
  artifacts: WorkspaceArtifactItem[],
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const normalized = artifacts.map((item) => ({ ...item, stale: Boolean(item.stale) }));

  let nextSelectedId = current.selectedArtifactId;
  if (normalized.length === 0) {
    nextSelectedId = null;
  } else if (
    !nextSelectedId ||
    !normalized.some((item) => item.artifactId === nextSelectedId)
  ) {
    nextSelectedId = normalized[0].artifactId;
  }

  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        artifacts: normalized,
        selectedArtifactId: nextSelectedId,
        stale: false,
      },
    },
  };
}

export function markWorkspaceArtifactsExternalStale(
  state: WorkspaceSessionState,
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);

  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        stale: true,
        artifacts: current.artifacts.map((item) => ({ ...item, stale: true })),
      },
    },
  };
}

export function selectWorkspaceArtifact(
  state: WorkspaceSessionState,
  artifactId: string | null,
): WorkspaceSessionState {
  const current = getActiveChatWorkspaceView(state);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...current,
        selectedArtifactId: artifactId,
      },
    },
  };
}

export function setWorkspaceArtifactScroll(
  state: WorkspaceSessionState,
  scrollTop: number,
): WorkspaceSessionState {
  const current = getActiveChatWorkspaceView(state);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...current,
        scrollTop: Math.max(0, Math.round(scrollTop)),
      },
    },
  };
}

export function setWorkspaceArtifactZoom(
  state: WorkspaceSessionState,
  zoom: number,
): WorkspaceSessionState {
  const current = getActiveChatWorkspaceView(state);
  const clampedZoom = Math.max(50, Math.min(200, Math.round(zoom)));
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...current,
        zoom: clampedZoom,
      },
    },
  };
}

export function addWorkspaceAnnotation(
  state: WorkspaceSessionState,
  annotation: ArtifactAnnotation,
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const filtered = current.annotations.filter(
    (item) => item.annotationId !== annotation.annotationId,
  );
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        annotations: [
          ...filtered,
          {
            ...annotation,
            xPct: annotation.xPct,
            yPct: annotation.yPct,
          },
        ],
      },
    },
  };
}

export function setWorkspaceAnnotations(
  state: WorkspaceSessionState,
  annotations: ArtifactAnnotation[],
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        annotations: annotations.map((item) => ({ ...item })),
      },
    },
  };
}

export function projectArtifactAnnotations(
  annotations: readonly ArtifactAnnotation[],
  artifact: Pick<WorkspaceArtifactItem, "artifactId" | "version" | "hash"> | null | undefined,
): ProjectedArtifactAnnotation[] {
  if (!artifact) return [];
  return annotations
    .filter((ann) => ann.artifactId === artifact.artifactId)
    .map((ann) => ({
      ...ann,
      // Coordinates xPct/yPct are NEVER recalculated when artifact version/hash changes
      xPct: ann.xPct,
      yPct: ann.yPct,
      outdatedVersion:
        ann.artifactVersion !== artifact.version || ann.artifactHash !== artifact.hash,
    }));
}

export function reconcileWorkspaceFiles(
  state: WorkspaceSessionState,
  targetScope: BridgeScope | null,
  files: WorkspaceFileEntry[],
): WorkspaceSessionState {
  const scopeKey = targetScope ? resolveWorkspaceScopeKey(targetScope) : state.activeScopeKey;
  const current = state.byScopeKey[scopeKey] ?? createEmptyScopeWorkspaceView(scopeKey);
  const normalized = files.map((file) => ({ ...file, stale: Boolean(file.stale) }));

  let nextSelectedFilePath = current.selectedFilePath;
  let nextLineRange = current.selectedLineRange;
  let nextInvalidated = current.lineSelectionInvalidated;

  if (nextSelectedFilePath) {
    const matched = normalized.find(
      (f) => f.relativePath === nextSelectedFilePath && f.kind === "file",
    );
    if (!matched) {
      // File deleted -> clear selection and line selection
      nextSelectedFilePath = null;
      nextLineRange = null;
      nextInvalidated = false;
    } else if (
      nextLineRange &&
      matched.hash &&
      matched.hash !== nextLineRange.fileHash
    ) {
      // File hash changed -> invalidate line selection
      nextLineRange = null;
      nextInvalidated = true;
    }
  } else {
    nextLineRange = null;
    nextInvalidated = false;
  }

  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [scopeKey]: {
        ...current,
        files: normalized,
        selectedFilePath: nextSelectedFilePath,
        selectedLineRange: nextLineRange,
        lineSelectionInvalidated: nextInvalidated,
        stale: false,
      },
    },
  };
}

export function markWorkspaceFilesExternalStale(
  state: WorkspaceSessionState,
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const scopeKey = targetScope ? resolveWorkspaceScopeKey(targetScope) : state.activeScopeKey;
  const current = state.byScopeKey[scopeKey] ?? createEmptyScopeWorkspaceView(scopeKey);

  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [scopeKey]: {
        ...current,
        stale: true,
        files: current.files.map((file) => ({ ...file, stale: true })),
      },
    },
  };
}

export function toggleWorkspaceDirectory(
  state: WorkspaceSessionState,
  dirRelativePath: string,
): WorkspaceSessionState {
  const current = getActiveScopeWorkspaceView(state);
  const exists = current.expandedDirs.includes(dirRelativePath);
  const expandedDirs = exists
    ? current.expandedDirs.filter((d) => d !== dirRelativePath)
    : [...current.expandedDirs, dirRelativePath];

  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [state.activeScopeKey]: {
        ...current,
        expandedDirs,
      },
    },
  };
}

export function selectWorkspaceFile(
  state: WorkspaceSessionState,
  relativePath: string | null,
): WorkspaceSessionState {
  const current = getActiveScopeWorkspaceView(state);
  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [state.activeScopeKey]: {
        ...current,
        selectedFilePath: relativePath,
        selectedLineRange:
          relativePath === current.selectedFilePath ? current.selectedLineRange : null,
        lineSelectionInvalidated: false,
      },
    },
  };
}

export function selectWorkspaceFileLines(
  state: WorkspaceSessionState,
  range: { startLine: number; endLine: number } | null,
): WorkspaceSessionState {
  const current = getActiveScopeWorkspaceView(state);
  if (!range || !current.selectedFilePath) {
    return {
      ...state,
      byScopeKey: {
        ...state.byScopeKey,
        [state.activeScopeKey]: {
          ...current,
          selectedLineRange: null,
          lineSelectionInvalidated: false,
        },
      },
    };
  }
  const activeFile = current.files.find(
    (f) => f.relativePath === current.selectedFilePath && f.kind === "file",
  );
  const fileHash = activeFile?.hash ?? "unhashed";
  const startLine = Math.max(1, Math.min(range.startLine, range.endLine));
  const endLine = Math.max(startLine, Math.max(range.startLine, range.endLine));

  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [state.activeScopeKey]: {
        ...current,
        selectedLineRange: {
          startLine,
          endLine,
          fileHash,
        },
        lineSelectionInvalidated: false,
      },
    },
  };
}

export function selectWorkspaceGitDiff(
  state: WorkspaceSessionState,
  relativePath: string | null,
  diffScope?: "working" | "staged",
): WorkspaceSessionState {
  const current = getActiveScopeWorkspaceView(state);
  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [state.activeScopeKey]: {
        ...current,
        selectedDiffPath: relativePath,
        diffScope: diffScope ?? current.diffScope,
      },
    },
  };
}

export function selectWorkspaceAgent(
  state: WorkspaceSessionState,
  agentId: string | null,
): WorkspaceSessionState {
  const current = getActiveChatWorkspaceView(state);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...current,
        selectedAgentId: agentId,
      },
    },
  };
}

export function reconcileWorkspaceAgents(
  state: WorkspaceSessionState,
  targetScope: BridgeScope | null,
  agents: WorkspaceAgentItem[],
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const nextSelectedId =
    current.selectedAgentId && agents.some((a) => a.agentId === current.selectedAgentId)
      ? current.selectedAgentId
      : (agents[0]?.agentId ?? null);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        agents: agents.map((a) => ({ ...a })),
        selectedAgentId: nextSelectedId,
      },
    },
  };
}

export function reconcileWorkspaceGitDiffs(
  state: WorkspaceSessionState,
  targetScope: BridgeScope | null,
  gitDiffs: WorkspaceGitDiffItem[],
): WorkspaceSessionState {
  const scopeKey = targetScope ? resolveWorkspaceScopeKey(targetScope) : state.activeScopeKey;
  const current = state.byScopeKey[scopeKey] ?? createEmptyScopeWorkspaceView(scopeKey);
  const nextSelectedPath =
    current.selectedDiffPath &&
    gitDiffs.some((d) => d.relativePath === current.selectedDiffPath)
      ? current.selectedDiffPath
      : (gitDiffs[0]?.relativePath ?? null);
  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [scopeKey]: {
        ...current,
        gitDiffs: gitDiffs.map((d) => ({ ...d })),
        selectedDiffPath: nextSelectedPath,
      },
    },
  };
}

export function setWorkspaceAgentSteerText(
  state: WorkspaceSessionState,
  steerText: string,
): WorkspaceSessionState {
  const current = getActiveChatWorkspaceView(state);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...current,
        steerText,
      },
    },
  };
}

export function setWorkspaceTerminalScrollback(
  state: WorkspaceSessionState,
  scrollback: string[],
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const scopeKey = targetScope ? resolveWorkspaceScopeKey(targetScope) : state.activeScopeKey;
  const current = state.byScopeKey[scopeKey] ?? createEmptyScopeWorkspaceView(scopeKey);
  return {
    ...state,
    byScopeKey: {
      ...state.byScopeKey,
      [scopeKey]: {
        ...current,
        terminalScrollback: [...scrollback],
      },
    },
  };
}
