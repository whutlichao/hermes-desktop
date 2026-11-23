import type {
  ArtifactAnnotation,
  BridgeScope,
  CheckpointDiffSnapshot,
  CheckpointRestoreBinding,
  ErrorCode,
  ProjectedArtifactAnnotation,
  SubagentTailSnapshot,
  TerminalSnapshot,
  WorkspaceAgentItem,
  WorkspaceArtifactItem,
  WorkspaceCheckpointItem,
  WorkspaceDomainError,
  WorkspaceFileEntry,
  WorkspaceFrame,
  WorkspaceGitDiffItem,
  WorkspaceLineSelection,
  WorkspaceTab,
  WorkspaceTabBinding,
} from "@hermes/contracts";
import { makeScopeKey, makeSessionKey } from "./activeChatResolver";

export const MAX_SUBAGENT_TAIL_LINES = 200;
export const MAX_SUBAGENT_TAIL_BYTES = 32 * 1024;

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
  agentsReadOnly: boolean;
  agentTailById: Record<string, SubagentTailSnapshot>;
  tailInvalidatedById: Record<string, boolean>;
  agentError: WorkspaceDomainError | null;
  checkpoints: WorkspaceCheckpointItem[];
  selectedCheckpointId: string | null;
  checkpointsCanRestore: boolean;
  checkpointDiffById: Record<string, CheckpointDiffSnapshot>;
  checkpointRestorePendingId: string | null;
  restoredCheckpointIds: string[];
  checkpointError: WorkspaceDomainError | null;
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
  terminalSnapshot: TerminalSnapshot | null;
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
    case "checkpoints":
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
    agentsReadOnly: false,
    agentTailById: {},
    tailInvalidatedById: {},
    agentError: null,
    checkpoints: [],
    selectedCheckpointId: null,
    checkpointsCanRestore: true,
    checkpointDiffById: {},
    checkpointRestorePendingId: null,
    restoredCheckpointIds: [],
    checkpointError: null,
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
    terminalSnapshot: null,
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
        agentError: null,
        checkpointRestorePendingId: null,
        checkpointError: null,
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
  options?: { readOnly?: boolean; lastKnown?: boolean },
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const nextSelectedId =
    current.selectedAgentId && agents.some((a) => a.agentId === current.selectedAgentId)
      ? current.selectedAgentId
      : (agents[0]?.agentId ?? null);
  const markLastKnown = Boolean(options?.lastKnown);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        agents: agents.map((a) => ({
          ...a,
          ...(markLastKnown ? { lastKnown: true } : {}),
        })),
        selectedAgentId: nextSelectedId,
        agentsReadOnly: options?.readOnly ?? current.agentsReadOnly,
      },
    },
  };
}

export function boundSubagentTailLines(
  rawLines: readonly string[],
  maxLines: number = MAX_SUBAGENT_TAIL_LINES,
  maxBytes: number = MAX_SUBAGENT_TAIL_BYTES,
): { lines: string[]; truncated: boolean } {
  let truncated = false;
  let sliced = [...rawLines];
  if (sliced.length > maxLines) {
    sliced = sliced.slice(sliced.length - maxLines);
    truncated = true;
  }

  const encoder = new TextEncoder();
  let totalBytes = 0;
  const keptReversed: string[] = [];
  for (let i = sliced.length - 1; i >= 0; i -= 1) {
    const line = sliced[i];
    const lineBytes = encoder.encode(line).length;
    if (totalBytes + lineBytes > maxBytes && keptReversed.length > 0) {
      truncated = true;
      break;
    }
    totalBytes += lineBytes;
    keptReversed.push(line);
  }

  return {
    lines: keptReversed.reverse(),
    truncated,
  };
}

export function setWorkspaceAgentTail(
  state: WorkspaceSessionState,
  tail: SubagentTailSnapshot,
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const bounded = boundSubagentTailLines(tail.lines);
  const nextInvalidated = { ...current.tailInvalidatedById };
  delete nextInvalidated[tail.agentId];

  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        agentTailById: {
          ...current.agentTailById,
          [tail.agentId]: {
            ...tail,
            lines: bounded.lines,
            truncated: Boolean(tail.truncated || bounded.truncated),
          },
        },
        tailInvalidatedById: nextInvalidated,
      },
    },
  };
}

export function setWorkspaceAgentError(
  state: WorkspaceSessionState,
  error: WorkspaceDomainError | null,
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
        agentError: error,
      },
    },
  };
}

export function invalidateWorkspaceGeneration(
  state: WorkspaceSessionState,
  nextGeneration: number,
): WorkspaceSessionState {
  const nextByChatKey: Record<string, ActiveChatWorkspaceView> = {};
  for (const [chatKey, view] of Object.entries(state.byChatKey)) {
    const nextTailById: Record<string, SubagentTailSnapshot> = {};
    const nextInvalidatedById: Record<string, boolean> = { ...view.tailInvalidatedById };
    let changed = false;

    for (const [agentId, snapshot] of Object.entries(view.agentTailById)) {
      if (snapshot.generation !== nextGeneration) {
        nextInvalidatedById[agentId] = true;
        changed = true;
      } else {
        nextTailById[agentId] = snapshot;
      }
    }

    if (changed || view.checkpointRestorePendingId !== null) {
      nextByChatKey[chatKey] = {
        ...view,
        agentTailById: nextTailById,
        tailInvalidatedById: nextInvalidatedById,
        checkpointRestorePendingId: null,
      };
    } else {
      nextByChatKey[chatKey] = view;
    }
  }

  return {
    ...state,
    byChatKey: nextByChatKey,
  };
}

export function reconcileWorkspaceCheckpoints(
  state: WorkspaceSessionState,
  targetScope: BridgeScope | null,
  checkpoints: WorkspaceCheckpointItem[],
  options?: { canRestore?: boolean },
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const nextSelectedId =
    current.selectedCheckpointId &&
    checkpoints.some((c) => c.checkpointId === current.selectedCheckpointId)
      ? current.selectedCheckpointId
      : (checkpoints[0]?.checkpointId ?? null);

  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        checkpoints: checkpoints.map((c) => ({ ...c })),
        selectedCheckpointId: nextSelectedId,
        checkpointsCanRestore: options?.canRestore ?? current.checkpointsCanRestore,
      },
    },
  };
}

export function selectWorkspaceCheckpoint(
  state: WorkspaceSessionState,
  checkpointId: string | null,
): WorkspaceSessionState {
  const current = getActiveChatWorkspaceView(state);
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [state.activeChatKey]: {
        ...current,
        selectedCheckpointId: checkpointId,
        checkpointRestorePendingId:
          current.checkpointRestorePendingId === checkpointId
            ? current.checkpointRestorePendingId
            : null,
      },
    },
  };
}

export function setWorkspaceCheckpointDiff(
  state: WorkspaceSessionState,
  diff: CheckpointDiffSnapshot,
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
        checkpointDiffById: {
          ...current.checkpointDiffById,
          [diff.checkpointId]: { ...diff },
        },
      },
    },
  };
}

export function setWorkspaceCheckpointRestorePending(
  state: WorkspaceSessionState,
  checkpointId: string | null,
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
        checkpointRestorePendingId: checkpointId,
      },
    },
  };
}

export function markWorkspaceCheckpointRestored(
  state: WorkspaceSessionState,
  checkpointId: string,
  targetScope?: BridgeScope | null,
): WorkspaceSessionState {
  const chatKey = targetScope ? resolveWorkspaceChatKey(targetScope) : state.activeChatKey;
  const current = state.byChatKey[chatKey] ?? createEmptyChatWorkspaceView(chatKey);
  const nextRestored = current.restoredCheckpointIds.includes(checkpointId)
    ? current.restoredCheckpointIds
    : [...current.restoredCheckpointIds, checkpointId];
  return {
    ...state,
    byChatKey: {
      ...state.byChatKey,
      [chatKey]: {
        ...current,
        checkpointRestorePendingId: null,
        restoredCheckpointIds: nextRestored,
      },
    },
  };
}

export function setWorkspaceCheckpointError(
  state: WorkspaceSessionState,
  error: WorkspaceDomainError | null,
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
        checkpointError: error,
      },
    },
  };
}

export function validateCheckpointRestoreBinding(
  binding: CheckpointRestoreBinding,
  activeScope: BridgeScope | null | undefined,
  currentGeneration: number,
): { valid: true } | { valid: false; code: ErrorCode; message: string } {
  if (
    !activeScope ||
    !activeScope.connectionId ||
    !activeScope.sessionId ||
    binding.connectionId !== activeScope.connectionId ||
    binding.profileId !== (activeScope.profileId ?? "default") ||
    binding.sessionId !== activeScope.sessionId
  ) {
    return {
      valid: false,
      code: "scope_mismatch",
      message: "Checkpoint 恢复绑定与当前活动 Scope 不匹配，已拒绝跨 Scope 回滚。",
    };
  }

  if (binding.generation !== currentGeneration) {
    return {
      valid: false,
      code: "conflict",
      message: "连接代际（Generation）已变更，请重新确认后再恢复 Checkpoint。",
    };
  }

  if (!binding.checkpointId || binding.checkpointId.trim() === "") {
    return {
      valid: false,
      code: "invalid_request",
      message: "未指定要恢复的 Checkpoint。",
    };
  }

  return { valid: true };
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

export function setWorkspaceTerminalSnapshot(
  state: WorkspaceSessionState,
  snapshot: TerminalSnapshot | null,
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
        terminalSnapshot: snapshot
          ? {
              ...snapshot,
              scope: { ...snapshot.scope },
              lines: [...snapshot.lines],
            }
          : null,
        terminalScrollback: snapshot ? [...snapshot.lines] : [],
      },
    },
  };
}
