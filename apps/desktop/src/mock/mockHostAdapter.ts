import {
  DRAFT_MAX_BYTES,
  DRAFTS_TOTAL_MAX_BYTES,
  HOST_BRIDGE_VERSION,
  HOST_TOPICS,
  type AppCommand,
  type AppInfo,
  type ApprovalHighRiskSheetRequest,
  type ApprovalTopicSnapshot,
  type AuthStartResult,
  type AuthStateSnapshot,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type CapabilityDomainId,
  type CapabilitySnapshot,
  type CronMutationResult,
  type CronStateView,
  type ChatSessionProjection,
  type ConnectionHealthSummary,
  type ConnectionMutationInput,
  type ConnectionMutationResponse,
  type ConnectionTestResult,
  type DraftAttachment,
  type DraftComposerState,
  type DraftContextItem,
  type DraftDeliveryStatus,
  type DraftExportBundle,
  type DraftOrigin,
  type DraftRecord,
  type FleetSnapshot,
  type GatewayConfigSnapshot,
  type GatewayConfigUpdateResult,
  type GatewayConfigValue,
  type HermesHost,
  type HostCommand,
  type HostTopic,
  type LaunchMode,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type MissingSessionExport,
  type OrphanedDraftReason,
  type ProfileSummary,
  type PromptSteerResult,
  type QueuedAdmissionState,
  type RegistryDiff,
  type RegistryIssue,
  type RegistrySnapshotView,
  type RemoteTestActionId,
  type RemoteTestResult,
  type SanitizedDiagnosticsPayload,
  type SessionSummary,
  type SessionTranscriptSnapshot,
  type SshHostKeyConfirmResult,
  type SteerFailureReason,
  type ArtifactAnnotation,
  type CheckpointDiffSnapshot,
  type ErrorCode,
  type ExternalAttribution,
  type SubagentTailSnapshot,
  type TerminalCloseResult,
  type TerminalOpenResult,
  type TerminalSnapshot,
  type TranscriptPatchPayload,
  type TurnRecoveryTopicSnapshot,
  type WorkspaceAgentItem,
  type WorkspaceArtifactItem,
  type WorkspaceCheckpointItem,
  type WorkspaceFileEntry,
  type WorkspaceGitDiffItem,
  SUPPORTED_GATEWAY_CONFIG_KEYS,
} from "@hermes/contracts";
import {
  ApprovalAndRecoveryCoordinator,
  CAPABILITY_DOMAIN_CATALOG,
  CapabilityRegistry,
  SETTINGS_FIELD_CATALOG,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  appendTerminalChunk,
  TurnRecoveryCoordinator,
  boundSubagentTailLines,
  computeSessionPinned,
  assertApprovalDismissPayloadSafe,
  assertApprovalRespondPayloadSafe,
  buildOrphanedDraftExport,
  checkDraftCapacity,
  createBridgeDispatcher,
  createEmptyRegistryDocument,
  createEmptyTerminalSnapshot,
  createTerminalScrollbackState,
  diffRegistries,
  formatAppInfoDisplay,
  formatDisplaySafeCliSummary,
  formatSshHostDisplay,
  formatSshTargetDisplay,
  getCopy,
  getSshFailureCopy,
  isAllowedGatewayConfigKey,
  makeScopeKey,
  isDraftRecordEmpty,
  makeActiveChatDraftKey,
  makeNewChatDraftKey,
  mapLocalFailure,
  measureTotalDraftsBytes,
  normalizeRegistryDocument,
  projectRegistrySnapshot,
  projectTerminalScrollbackLines,
  redactSensitiveData,
  resolveExternalAttribution,
  sanitizeDiagnosticsPayload,
  shouldClearDraftForReceipt,
  validateCheckpointRestoreBinding,
  validateClientAddConnection,
  validateClientRemoveConnection,
  validateClientUpdateConnection,
  validateRemoteEndpointUrl,
  validateSshTargetInput,
  type ApprovalIngestInput,
  type NormalizedRegistryResult,
  type TerminalScrollbackState,
  type RawGatewayQueueItem,
  type RawGatewayUnknownTurn,
} from "@hermes/domain";

declare const __HERMES_MOCK_BUILD_META__:
  | {
      gitSha: string;
      gitDirty: boolean;
      source: "git" | "unknown";
      appVersion: string;
      electronVersion: string;
      chromiumVersion: string;
      nodeVersion: string;
    }
  | undefined;

const VALID_TOPICS = new Set<string>(HOST_TOPICS);

const EMPTY_FLEET: FleetSnapshot = {
  connections: [],
  profiles: [],
  sessions: [],
  activeScope: null,
  activeSessionId: null,
};

const EMPTY_CHAT_STATE: ChatSessionProjection = {
  windowId: "primary",
  paneId: "main",
  lastActiveChat: null,
  lastSessionByScope: {},
  lastValidProfileByConnection: {},
  lastValidScopes: [],
  sessionSummaries: {},
  draftsByKey: {},
  orphanedDrafts: [],
  draftStorageUsage: {
    totalBytes: 0,
    maxDraftBytes: DRAFT_MAX_BYTES,
    maxTotalBytes: DRAFTS_TOTAL_MAX_BYTES,
    overTotalLimit: false,
    draftCount: 0,
    orphanedCount: 0,
  },
  activeStatus: "empty",
  lastKnownUnverified: false,
  missingSession: null,
  routeBanner: null,
};

interface MockE2EFixture {
  fleet?: FleetSnapshot;
  chatState?: ChatSessionProjection;
  transcripts?: Record<string, SessionTranscriptSnapshot>;
  resyncedTranscripts?: Record<string, SessionTranscriptSnapshot>;
  resyncRequiredSessions?: Record<string, boolean>;
  transcriptEventsOnSubscribe?: Record<string, BridgeEvent[]>;
  artifacts?: Record<string, WorkspaceArtifactItem[]>;
  artifactsStale?: Record<string, boolean>;
  files?: Record<string, WorkspaceFileEntry[]>;
  filesStale?: Record<string, boolean>;
  gitDiffs?: Record<string, WorkspaceGitDiffItem[]>;
  agents?: Record<string, WorkspaceAgentItem[]>;
  capabilities?: {
    servedMethods?: string[];
    olderMethods?: string[];
    refusedMethods?: string[];
    capabilityTags?: string[];
    probedDomains?: Record<string, "ok" | "method_not_found" | "refused" | "timeout">;
    plugins?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      items?: Array<Record<string, unknown>>;
      errorCode?: string;
    };
    skills?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      items?: Array<Record<string, unknown>>;
      errorCode?: string;
    };
    tools?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      items?: Array<Record<string, unknown>>;
      errorCode?: string;
    };
    mcp?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      items?: Array<Record<string, unknown>>;
      errorCode?: string;
    };
    memory?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      sourceMethod?: "session.context_breakdown" | "session.info";
      rawPayload?: unknown;
      errorCode?: string;
    };
    messaging?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      rawPayload?: unknown;
      errorCode?: string;
    };
    cron?: {
      outcome?: "ok" | "method_not_found" | "refused" | "older" | "error";
      rawPayload?: unknown;
      errorCode?: string;
    };
  };
  config?: {
    supported?: boolean;
    readOnly?: boolean;
    supportedKeys?: string[];
    values?: Record<string, GatewayConfigValue>;
  };
  subagentTails?: Record<string, string[]>;
  subagentNotFoundMethods?: string[];
  subagentErrorByAction?: Partial<
    Record<
      "subagents.list" | "subagents.steer" | "subagents.interrupt" | "subagents.tail",
      { code: ErrorCode; message: string }
    >
  >;
  checkpoints?: Record<string, WorkspaceCheckpointItem[]>;
  checkpointDiffs?: Record<string, CheckpointDiffSnapshot>;
  checkpointNotFoundMethods?: string[];
  checkpointErrorByAction?: Partial<
    Record<
      "checkpoints.list" | "checkpoints.diff" | "checkpoints.restore",
      { code: ErrorCode; message: string }
    >
  >;
  servedMethods?: string[];
  refusedMethods?: string[];
  bumpGenerationCount?: number;
  approvals?: ApprovalIngestInput[];
  highRiskConfirmResult?: boolean;
  approvalRespondOutcome?: "settled" | "settled_elsewhere_by_server";
  approvalRespondFailure?: boolean;
  terminal?: {
    denyFirstGrant?: boolean;
    denyRootGrant?: boolean;
    initialLines?: string[];
    foregroundBusy?: boolean;
    foregroundProcessName?: string;
    attribution?: ExternalAttribution;
  };
  promptReceiptMode?: "accepted" | "admitted" | "delivery_unknown";
  failSessionCreate?: boolean;
  failPromptSend?: boolean;
  turnRecovery?: {
    sessions?: Array<{
      connectionId?: string;
      profileId?: string;
      sessionId: string;
      activeTurnId?: string | null;
      executionGeneration?: number;
      ownerGeneration?: number;
      unknownTurns?: RawGatewayUnknownTurn[];
      queuedAdmissions?: RawGatewayQueueItem[];
      lastTurnOutcome?: "completed" | "stopped" | "interrupted" | "error" | null;
      offline?: boolean;
    }>;
    stopMode?: "ack_stopping" | "ack_loss" | "terminal_stopped" | "owner_changed";
    stopDelayedTerminalMs?: number;
    queueAckMode?: "admitted" | "ack_loss_already_admitted" | "ack_loss_unadmitted" | "ack_loss";
    queueRetryMode?: "admitted" | "delivery_unknown" | "ack_loss";
    queueCancelOutcome?: "cancelled" | "stopped" | "already_started" | "completed" | "ack_loss";
    queueCancelReconcileOutcome?: QueuedAdmissionState;
    steerMode?: "ok" | "turn_finished" | "generation_mismatch" | "rejected";
    offline?: boolean;
    keepSendRunning?: boolean;
    autoFollowerOnDiscard?:
      | RawGatewayQueueItem
      | { text: string; turnId?: string; executionGeneration?: number };
  };
}

function readE2EFixture(): MockE2EFixture | undefined {
  return (globalThis as { __HERMES_E2E_FIXTURE__?: MockE2EFixture }).__HERMES_E2E_FIXTURE__;
}
function createMockAppInfo(): AppInfo {
  const meta =
    typeof __HERMES_MOCK_BUILD_META__ !== "undefined"
      ? __HERMES_MOCK_BUILD_META__
      : {
          gitSha: "unknown",
          gitDirty: false,
          source: "unknown" as const,
          appVersion: "0.1.0",
          electronVersion: "45.4.1",
          chromiumVersion: "134.0.0.0",
          nodeVersion: "22.13.0",
        };
  return {
    bridgeVersion: HOST_BRIDGE_VERSION,
    appName: "Hermes Desktop",
    appVersion: meta.appVersion,
    gitSha: meta.gitSha,
    gitDirty: meta.gitDirty,
    buildMode: "dev",
    distribution: "local-unsigned",
    electronVersion: meta.electronVersion,
    chromiumVersion: meta.chromiumVersion,
    nodeVersion: meta.nodeVersion,
    arch: "arm64",
    source: meta.source,
    mode: "mock",
    platform: "darwin",
    capabilitiesReady: false,
  };
}

function createInitialMockInspection(): LocalInspectResult {
  return {
    connectionId: "local",
    label: "This device",
    actual: "blocked",
    cli: formatDisplaySafeCliSummary({
      status: "missing",
      sourceKind: "none",
      hasOverride: false,
      supportsEnsureJson: false,
      supportsAttachJson: false,
      supportsTicketsProbe: false,
    }),
    failure: mapLocalFailure("hermes_not_found", "locate_cli"),
    checkedAt: "2026-11-23T06:00:00.000Z",
  };
}

function isSafeExternalHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function createMockHostBridge(): HermesHost {
  let reqSeq = 0;
  const fixture = readE2EFixture();
  let authSeq = 0;
  const commandListeners = new Set<(cmd: AppCommand) => void>();
  const capabilityRegistry = new CapabilityRegistry();
  const mockAppInfo = createMockAppInfo();
  const currentInspection = createInitialMockInspection();

  const fleetListeners = new Set<(event: BridgeEvent<FleetSnapshot>) => void>();
  const healthListeners = new Set<(event: BridgeEvent<ConnectionHealthSummary[]>) => void>();
  const sessionsListeners = new Set<(event: BridgeEvent<{ sessions: SessionSummary[] }>) => void>();
  const chatStateListeners = new Set<(event: BridgeEvent<ChatSessionProjection>) => void>();
  const capabilitiesListeners = new Set<(event: BridgeEvent<CapabilitySnapshot>) => void>();
  const approvalListeners = new Set<(event: BridgeEvent<ApprovalTopicSnapshot>) => void>();
  const turnRecoveryListeners = new Set<(event: BridgeEvent<TurnRecoveryTopicSnapshot>) => void>();
  let capabilitiesSeq = 0;
  let approvalSeq = 0;
  let turnRecoverySeq = 0;
  const registryListeners = new Set<
    (event: BridgeEvent<{ snapshot: RegistrySnapshotView; diff?: RegistryDiff }>) => void
  >();
  const authListeners = new Set<(event: BridgeEvent<AuthStateSnapshot>) => void>();
  const profileListeners = new Set<{
    connectionId?: string;
    listener: (event: BridgeEvent<{ profiles: ProfileSummary[] }>) => void;
  }>();
  const sessionListeners = new Set<{
    connectionId?: string;
    profileId?: string;
    listener: (event: BridgeEvent<{ sessions: SessionSummary[] }>) => void;
  }>();
  const transcriptListeners = new Set<{
    scope: BridgeScope | null;
    seq: number;
    listener: (event: BridgeEvent) => void;
  }>();

  interface MockTerminalRecord {
    scopeKey: string;
    scope: BridgeScope;
    terminalId: string | null;
    status: TerminalSnapshot["status"];
    cols: number;
    rows: number;
    granted: boolean;
    rootGranted: boolean;
    hasForegroundProcess: boolean;
    foregroundProcessName?: string;
    scrollback: TerminalScrollbackState;
    exitCode: number | null;
    revision: number;
    attribution: ExternalAttribution;
  }

  const MOCK_TERMINAL_STORAGE_KEY = "hermes-mock-terminal-state";
  const mockTerminals = new Map<string, MockTerminalRecord>();
  const terminalListeners = new Set<{
    scopeKey: string;
    seq: number;
    listener: (event: BridgeEvent<TerminalSnapshot>) => void;
  }>();

  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      const savedRaw = window.sessionStorage.getItem(MOCK_TERMINAL_STORAGE_KEY);
      if (savedRaw) {
        const parsed = JSON.parse(savedRaw) as Record<string, MockTerminalRecord>;
        for (const [k, rec] of Object.entries(parsed)) {
          mockTerminals.set(k, rec);
        }
      }
    }
  } catch {
    // Ignore storage read issues in non-browser/restricted mode
  }

  function persistMockTerminals() {
    try {
      if (typeof window !== "undefined" && window.sessionStorage) {
        const serializable: Record<string, MockTerminalRecord> = {};
        for (const [k, rec] of mockTerminals.entries()) {
          serializable[k] = rec;
        }
        window.sessionStorage.setItem(MOCK_TERMINAL_STORAGE_KEY, JSON.stringify(serializable));
      }
    } catch {
      // Ignore storage quota issues
    }
  }

  function getMockTerminalRecord(scope: BridgeScope): MockTerminalRecord {
    const cid = scope.connectionId;
    const pid = scope.profileId ?? "default";
    const key = makeScopeKey(cid, pid);
    let rec = mockTerminals.get(key);
    if (!rec) {
      rec = {
        scopeKey: key,
        scope: { connectionId: cid, profileId: pid },
        terminalId: null,
        status: "idle",
        cols: TERMINAL_DEFAULT_COLS,
        rows: TERMINAL_DEFAULT_ROWS,
        granted: false,
        rootGranted: false,
        hasForegroundProcess: false,
        scrollback: createTerminalScrollbackState(),
        exitCode: null,
        revision: 0,
        attribution:
          readE2EFixture()?.terminal?.attribution ??
          fixture?.terminal?.attribution ??
          resolveExternalAttribution({ source: "bundled" }),
      };
      mockTerminals.set(key, rec);
    }
    return rec;
  }

  function toMockTerminalSnapshot(rec: MockTerminalRecord): TerminalSnapshot {
    const lines = projectTerminalScrollbackLines(rec.scrollback);
    return {
      terminalId: rec.terminalId,
      scope: { ...rec.scope },
      status: rec.status,
      cols: rec.cols,
      rows: rec.rows,
      granted: rec.granted,
      rootGranted: rec.rootGranted,
      hasForegroundProcess: rec.hasForegroundProcess,
      ...(rec.foregroundProcessName ? { foregroundProcessName: rec.foregroundProcessName } : {}),
      lines,
      trimmedOldest: rec.scrollback.trimmedOldest,
      totalBytes: rec.scrollback.totalBytes,
      lineCount: lines.length,
      exitCode: rec.exitCode,
      attribution: rec.attribution,
      updatedAt: new Date().toISOString(),
    };
  }

  function emitMockTerminalSnapshot(rec: MockTerminalRecord) {
    rec.revision += 1;
    const snapshot = toMockTerminalSnapshot(rec);
    for (const sub of terminalListeners) {
      if (sub.scopeKey !== rec.scopeKey) continue;
      sub.seq += 1;
      sub.listener({
        topic: "terminal",
        scope: { ...rec.scope },
        kind: "patch",
        seq: sub.seq,
        revision: rec.revision,
        payload: snapshot,
      });
    }
  }

  let currentFleet: FleetSnapshot = fixture?.fleet
    ? structuredClone(fixture.fleet)
    : EMPTY_FLEET;
  let currentChatState: ChatSessionProjection = fixture?.chatState
    ? recomputeMockDraftState({
        ...EMPTY_CHAT_STATE,
        ...structuredClone(fixture.chatState),
        sessionSummaries: structuredClone(fixture.chatState.sessionSummaries ?? {}),
        lastSessionByScope: structuredClone(fixture.chatState.lastSessionByScope ?? {}),
        lastValidProfileByConnection: structuredClone(
          fixture.chatState.lastValidProfileByConnection ?? {},
        ),
        lastValidScopes: structuredClone(fixture.chatState.lastValidScopes ?? []),
        draftsByKey: structuredClone(fixture.chatState.draftsByKey ?? {}),
        orphanedDrafts: structuredClone(fixture.chatState.orphanedDrafts ?? []),
      })
    : EMPTY_CHAT_STATE;
  const transcriptMap = new Map<string, SessionTranscriptSnapshot>(
    Object.entries(fixture?.transcripts ?? {}),
  );
  const resyncedTranscriptMap = new Map<string, SessionTranscriptSnapshot>(
    Object.entries(fixture?.resyncedTranscripts ?? {}),
  );
  const resyncRequiredSet = new Set<string>(
    Object.entries(fixture?.resyncRequiredSessions ?? {})
      .filter(([, required]) => Boolean(required))
      .map(([key]) => key),
  );
  const emittedTranscriptSubs = new Set<string>();
  let mockWindowFocused = true;

  const isResyncRequired = (cid: string, pid: string, sid: string): boolean =>
    resyncRequiredSet.has(`${cid}::${pid}::${sid}`) || resyncRequiredSet.has(sid);

  const clearResyncRequired = (cid: string, pid: string, sid: string): void => {
    resyncRequiredSet.delete(`${cid}::${pid}::${sid}`);
    resyncRequiredSet.delete(sid);
  };

  const e2eCounts = {
    sessionsCreateCalls: 0,
    sessionsResumeCalls: 0,
    sessionsSelectCalls: 0,
    sessionsMarkReadCalls: 0,
    connectionsRetryCalls: 0,
    pluginsListCalls: 0,
    skillsListCalls: 0,
    skillsReloadCalls: 0,
    toolsShowCalls: 0,
    mcpListCalls: 0,
    mcpReloadCalls: 0,
    terminalOpenCalls: 0,
    terminalWriteCalls: 0,
    terminalResizeCalls: 0,
    terminalCloseCalls: 0,
    externalLinksOpened: [] as string[],
    resolveUnknownCalls: 0,
    promptsSendCalls: 0,
    promptsStopCalls: 0,
    promptsQueueCalls: 0,
    promptsCheckQueueReceiptCalls: 0,
    promptsRetryQueueCalls: 0,
    promptsCancelQueuedCalls: 0,
    promptsSteerCalls: 0,
    approvalRespondCalls: 0,
    cronSubmitCalls: 0,
    cronCancelCalls: 0,
    cronRecoverCalls: 0,
    capabilitiesDescribeCalls: 0,
    capabilitiesDescribeDomains: [] as string[],
    queueSubmittedIds: [] as string[],
    stopPayloads: [] as Array<{ turnId?: string; executionGeneration?: number }>,
    steerPayloads: [] as Array<{ turnId?: string; executionGeneration?: number; text?: string }>,
    resolveUnknownPayloads: [] as Array<{ admission_id: string; execution_generation: number }>,
  };
  if (fixture) {
    (globalThis as { __HERMES_E2E_COUNTS__?: typeof e2eCounts }).__HERMES_E2E_COUNTS__ = e2eCounts;
  }

  const defaultConfigValues: Record<string, GatewayConfigValue> = {};
  for (const field of SETTINGS_FIELD_CATALOG) {
    defaultConfigValues[field.key] = field.defaultValue;
  }
  let mockConfigValues: Record<string, GatewayConfigValue> = {
    ...defaultConfigValues,
    ...(fixture?.config?.values ?? {}),
  };
  const mockConfigSupportedKeys: string[] = (
    fixture?.config?.supportedKeys ?? [...SUPPORTED_GATEWAY_CONFIG_KEYS]
  ).filter((k) => isAllowedGatewayConfigKey(k));
  const mockConfigSupported =
    fixture?.config?.supported !== undefined
      ? fixture.config.supported
      : mockConfigSupportedKeys.length > 0;
  const mockConfigReadOnly = Boolean(fixture?.config?.readOnly ?? false);

  function emitCapabilitiesPatch() {
    capabilitiesSeq += 1;
    const snap = capabilityRegistry.getSnapshot();
    for (const listener of capabilitiesListeners) {
      listener({
        topic: "capabilities",
        scope: null,
        kind: "patch",
        seq: capabilitiesSeq,
        revision: snap.generation,
        payload: snap,
      });
    }
  }
  (
    globalThis as { __HERMES_E2E_DISPATCH_COMMAND__?: (cmd: AppCommand) => void }
  ).__HERMES_E2E_DISPATCH_COMMAND__ = (cmd: AppCommand) => {
    for (const listener of commandListeners) {
      listener(cmd);
    }
  };

  const trustedMockHosts = new Set<string>(["lab.example.com", "lab.local", "remote.example.com"]);
  const mockConnections: ConnectionHealthSummary[] = [];
  const mockProfiles: ProfileSummary[] = [];
  const mockSessions: SessionSummary[] = [];
  const mockTranscripts = new Map<string, SessionTranscriptSnapshot>();
  let mockActiveScope: BridgeScope | null = null;
  let mockActiveSessionId: string | null = null;
  const mockCronJobsByScope = new Map<string, Array<Record<string, unknown>>>();
  let mockCronSeq = 0;
  const cronScopeKey = (connectionId: string, profileId: string) =>
    `${connectionId}::${profileId}`;
  const mockCronPayloadForScope = (connectionId: string, profileId: string): unknown => {
    const key = cronScopeKey(connectionId, profileId);
    const existing = mockCronJobsByScope.get(key);
    if (existing) return { jobs: existing };
    const liveFixture = readE2EFixture() ?? fixture;
    const raw = liveFixture?.capabilities?.cron?.rawPayload;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const list = Array.isArray(obj.jobs) ? obj.jobs : [];
      const copied = list
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({ ...item }));
      mockCronJobsByScope.set(key, copied);
      return { ...obj, jobs: copied };
    }
    mockCronJobsByScope.set(key, []);
    return { jobs: [] };
  };
  let fleetRev = 1;
  let registrySeq = 0;
  let fleetSeq = 0;
  let sessionsSeq = 0;
  let chatStateSeq = 0;
  let mockOwnerGen = 1;
  let lastSeenBumpCount = fixture?.bumpGenerationCount ?? 0;
  const lastKnownMockSubagents = new Map<string, WorkspaceAgentItem[]>();

  const DEFAULT_MOCK_SERVED_METHODS = [
    "prompt.submit",
    "prompt.cancel",
    "session.steer",
    "approval.list",
    "session.create",
    "session.list",
    "session.resume",
    "shell.exec",
    "profiles.list",
    "config.get",
    "config.update",
    "skills.list",
    "tools.show",
    "mcp.list",
    "session.context_breakdown",
    "cron.status",
    "messaging.status",
    "plugins.list",
    "rollback.list",
    "rollback.diff",
    "rollback.restore",
    "files.list",
    "subagent.list",
    "subagent.steer",
    "subagent.interrupt",
    "subagent.tail",
  ];

  function applyMockCapabilityHandshake(
    liveFix?: MockE2EFixture,
    overrideScope?: { connectionId?: string; profileId?: string },
  ) {
    const activeConn =
      currentFleet.connections.find((c) => c.actual === "ready") ??
      mockConnections.find((c) => c.actual === "ready");
    if (!activeConn && !liveFix?.capabilities) return;
    const cid =
      overrideScope?.connectionId ??
      currentFleet.activeScope?.connectionId ??
      activeConn?.connectionId ??
      "local";
    const pid = overrideScope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
    const served =
      liveFix?.capabilities?.servedMethods ??
      liveFix?.servedMethods ??
      DEFAULT_MOCK_SERVED_METHODS;
    const older = liveFix?.capabilities?.olderMethods ?? [];
    const refused = liveFix?.capabilities?.refusedMethods ?? liveFix?.refusedMethods ?? [];
    capabilityRegistry.applyConnectHandshake({
      connectionId: cid,
      profileId: pid,
      ownerGeneration: mockOwnerGen,
      authorityEpoch: 1,
      gatewayVersionOrSha: `mock-sha-${mockOwnerGen}`,
      serverRequestsSupported: true,
      describeResult: {
        served_methods: served,
        older_methods: older,
        refused_methods: refused,
        ...(liveFix?.capabilities?.capabilityTags
          ? { capabilities: liveFix.capabilities.capabilityTags }
          : {}),
        session_create: { sources: ["desktop"], parameters: ["title", "profile_id"] },
      },
    });
    if (liveFix?.capabilities?.probedDomains) {
      for (const [dom, outcome] of Object.entries(liveFix.capabilities.probedDomains)) {
        const meta = CAPABILITY_DOMAIN_CATALOG.find((m) => m.domain === dom);
        if (meta?.probeMethod) {
          capabilityRegistry.applyProbeOutcome({
            domain: dom as CapabilityDomainId,
            method: meta.probeMethod,
            outcome,
            expectedOwnerGeneration: mockOwnerGen,
            expectedAuthorityEpoch: 1,
          });
        }
      }
    }
  }

  if (fixture) {
    applyMockCapabilityHandshake(fixture);
  }

  function syncFixtureGenerationIfNeeded(liveFix?: MockE2EFixture) {
    const nextBump = liveFix?.bumpGenerationCount ?? 0;
    if (nextBump > lastSeenBumpCount) {
      lastSeenBumpCount = nextBump;
      mockOwnerGen += 1;
      applyMockCapabilityHandshake(liveFix);
      emitCapabilitiesPatch();
    }
  }

  function syncSessionNeedsInput(snap: ApprovalTopicSnapshot): void {
    const needsSet = new Set<string>();
    for (const item of snap.approvals) {
      if (
        item.state === "actionable" ||
        item.state === "context_incomplete" ||
        item.state === "submitting" ||
        item.state === "unverified" ||
        item.state === "delivery_unknown"
      ) {
        needsSet.add(`${item.connectionId}::${item.profileId}::${item.sessionId}`);
      }
    }
    let changed = false;
    if (fixture) {
      currentFleet = {
        ...currentFleet,
        sessions: currentFleet.sessions.map((s) => {
          const next = needsSet.has(`${s.connectionId}::${s.profileId}::${s.sessionId}`);
          if (s.needsInput !== next) changed = true;
          return s.needsInput === next ? s : { ...s, needsInput: next };
        }),
      };
    } else {
      for (let i = 0; i < mockSessions.length; i += 1) {
        const s = mockSessions[i];
        const next = needsSet.has(`${s.connectionId}::${s.profileId}::${s.sessionId}`);
        if (s.needsInput !== next) {
          mockSessions[i] = { ...s, needsInput: next };
          changed = true;
        }
      }
    }
    if (changed) {
      if (fixture) {
        emitSessionsSnapshot();
        emitFleetSnapshot();
      } else {
        emitMockFleet();
      }
    }
  }

  let approvalEmitSuppressed = false;
  const approvalCoordinator = new ApprovalAndRecoveryCoordinator({
    confirmHighRiskApproval: async (req) => {
      const sheetLog = ((
        globalThis as { __HERMES_E2E_HIGH_RISK_SHEETS__?: ApprovalHighRiskSheetRequest[] }
      ).__HERMES_E2E_HIGH_RISK_SHEETS__ ??= []);
      sheetLog.push(req);
      const customConfirm = (
        globalThis as {
          __HERMES_E2E_HIGH_RISK_CONFIRM__?: (
            r: ApprovalHighRiskSheetRequest,
          ) => Promise<boolean> | boolean;
        }
      ).__HERMES_E2E_HIGH_RISK_CONFIRM__;
      if (customConfirm) {
        return await customConfirm(req);
      }
      const liveFixture = readE2EFixture() ?? fixture;
      return liveFixture?.highRiskConfirmResult ?? true;
    },
    sendApprovalRespond: async (payload) => {
      const liveFixture = readE2EFixture() ?? fixture;
      return {
        status: liveFixture?.approvalRespondOutcome ?? "settled",
        choice: payload.choice,
      };
    },
    fetchPendingApprovals: async () => [],
    onChange: (snap) => {
      if (approvalEmitSuppressed) return;
      syncSessionNeedsInput(snap);
      approvalSeq += 1;
      for (const listener of approvalListeners) {
        listener({
          topic: "approval",
          scope: null,
          kind: "patch",
          seq: approvalSeq,
          revision: approvalSeq + 1,
          payload: snap,
        });
      }
    },
  });

  if (fixture?.approvals && fixture.approvals.length > 0) {
    approvalEmitSuppressed = true;
    if (currentFleet.activeScope) {
      approvalCoordinator.setActiveScope({
        connectionId: currentFleet.activeScope.connectionId,
        ...(currentFleet.activeScope.profileId ? { profileId: currentFleet.activeScope.profileId } : {}),
        ...(currentFleet.activeSessionId
          ? { sessionId: currentFleet.activeSessionId }
          : currentFleet.activeScope.sessionId
            ? { sessionId: currentFleet.activeScope.sessionId }
            : {}),
      });
    }
    for (const item of fixture.approvals) {
      approvalCoordinator.receive(item);
    }
    approvalEmitSuppressed = false;
    syncSessionNeedsInput(approvalCoordinator.snapshot());
  }

  let turnEmitSuppressed = false;
  let mockTurnSeq = 0;
  let mockQueueAdmissionSeq = 0;
  let mockTurnGlobalOffline = Boolean(fixture?.turnRecovery?.offline);
  const mockGatewayQueueStore = new Map<string, RawGatewayQueueItem[]>();
  const mockQueueAttemptBySubId = new Map<string, number>();

  function syncSessionQueuedAdmission(snap: TurnRecoveryTopicSnapshot): void {
    const queuedSet = new Set<string>();
    for (const v of snap.sessions) {
      if (
        v.queuedAdmissions.some(
          (q) => q.state === "queued" || q.state === "cancelling" || q.state === "cancel_unknown",
        )
      ) {
        queuedSet.add(`${v.connectionId}::${v.profileId}::${v.sessionId}`);
      }
    }
    let changed = false;
    if (fixture) {
      currentFleet = {
        ...currentFleet,
        sessions: currentFleet.sessions.map((s) => {
          const next = queuedSet.has(`${s.connectionId}::${s.profileId}::${s.sessionId}`);
          if (Boolean(s.queuedAdmission) !== next) changed = true;
          return Boolean(s.queuedAdmission) === next ? s : { ...s, queuedAdmission: next };
        }),
      };
    } else {
      for (let i = 0; i < mockSessions.length; i += 1) {
        const s = mockSessions[i];
        const next = queuedSet.has(`${s.connectionId}::${s.profileId}::${s.sessionId}`);
        if (Boolean(s.queuedAdmission) !== next) {
          mockSessions[i] = { ...s, queuedAdmission: next };
          changed = true;
        }
      }
    }
    if (changed) {
      if (fixture) {
        emitSessionsSnapshot();
        emitFleetSnapshot();
      } else {
        emitMockFleet();
      }
    }
  }

  const turnCoordinator = new TurnRecoveryCoordinator({
    onChange: (snap) => {
      if (turnEmitSuppressed) return;
      syncSessionQueuedAdmission(snap);
      turnRecoverySeq += 1;
      for (const listener of turnRecoveryListeners) {
        listener({
          topic: "turn.recovery",
          scope: null,
          kind: "patch",
          seq: turnRecoverySeq,
          revision: turnRecoverySeq + 1,
          payload: snap,
        });
      }
    },
  });

  if (fixture?.turnRecovery?.sessions && fixture.turnRecovery.sessions.length > 0) {
    turnEmitSuppressed = true;
    for (const sess of fixture.turnRecovery.sessions) {
      const cid = sess.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const pid = sess.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sid = sess.sessionId;
      const storeKey = `${cid}::${pid}::${sid}`;
      if (Array.isArray(sess.queuedAdmissions)) {
        mockGatewayQueueStore.set(
          storeKey,
          sess.queuedAdmissions.map((item) => ({ ...item })),
        );
      }
      turnCoordinator.reconcileFromResume({
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
        ownerGeneration: sess.ownerGeneration ?? mockOwnerGen,
        activeTurnId: sess.activeTurnId ?? null,
        ...(sess.executionGeneration !== undefined
          ? { executionGeneration: sess.executionGeneration }
          : {}),
        ...(Array.isArray(sess.unknownTurns) ? { unknownTurns: sess.unknownTurns } : {}),
        ...(Array.isArray(sess.queuedAdmissions)
          ? { queuedAdmissions: sess.queuedAdmissions }
          : {}),
        ...(sess.lastTurnOutcome !== undefined ? { lastTurnOutcome: sess.lastTurnOutcome } : {}),
      });
      if (sess.offline || mockTurnGlobalOffline) {
        turnCoordinator.onConnectionOffline(cid, pid);
      }
    }
    turnEmitSuppressed = false;
    syncSessionQueuedAdmission(turnCoordinator.snapshot());
  }

  if (fixture) {
    turnEmitSuppressed = true;
    for (const tx of transcriptMap.values()) {
      if (tx.activeTurnId && !turnCoordinator.getSessionView({
        connectionId: tx.connectionId,
        profileId: tx.profileId,
        sessionId: tx.sessionId,
      })) {
        turnCoordinator.noteTurnStarted({
          connectionId: tx.connectionId,
          profileId: tx.profileId,
          sessionId: tx.sessionId,
          turnId: tx.activeTurnId,
          ...(tx.executionGeneration !== undefined
            ? { executionGeneration: tx.executionGeneration }
            : {}),
          ownerGeneration: mockOwnerGen,
        });
        if (mockTurnGlobalOffline) {
          turnCoordinator.onConnectionOffline(tx.connectionId, tx.profileId);
        }
      }
    }
    turnEmitSuppressed = false;
  }

  const fixtureRegistryConnections = (fixture?.fleet?.connections ?? [])
    .filter((c) => c.connectionId !== "local" && c.kind === "remote" && Boolean(c.originDisplay))
    .map((c) => ({
      id: c.connectionId,
      kind: "remote" as const,
      label: c.label,
      url: c.originDisplay,
    }));

  let currentNorm: NormalizedRegistryResult = normalizeRegistryDocument({
    ...createEmptyRegistryDocument(),
    connections: [...createEmptyRegistryDocument().connections, ...fixtureRegistryConnections],
  });

  function emitFleetSnapshot() {
    fleetSeq += 1;
    for (const listener of fleetListeners) {
      listener({
        topic: "fleet",
        scope: null,
        kind: "patch",
        seq: fleetSeq,
        revision: 1,
        payload: currentFleet,
      });
    }
    for (const listener of healthListeners) {
      listener({
        topic: "connection.health",
        scope: null,
        kind: "patch",
        seq: fleetSeq,
        revision: 1,
        payload: currentFleet.connections.map((c) => ({ ...c })),
      });
    }
  }

  function emitSessionsSnapshot() {
    sessionsSeq += 1;
    for (const listener of sessionsListeners) {
      listener({
        topic: "sessions",
        scope: null,
        kind: "patch",
        seq: sessionsSeq,
        revision: 1,
        payload: { sessions: currentFleet.sessions },
      });
    }
  }

  function emitChatStatePatch() {
    chatStateSeq += 1;
    for (const listener of chatStateListeners) {
      listener({
        topic: "chat.state",
        scope: null,
        kind: "patch",
        seq: chatStateSeq,
        revision: 1,
        payload: currentChatState,
      });
    }
  }

  let mockDraftCounter = 0;
  function makeMockDraftId(): string {
    mockDraftCounter += 1;
    return `mock-draft-${Date.now()}-${mockDraftCounter}`;
  }

  function recomputeMockDraftState(nextState: ChatSessionProjection): ChatSessionProjection {
    const draftsByKey = { ...(nextState.draftsByKey ?? {}) };
    const orphanedDrafts = [...(nextState.orphanedDrafts ?? [])];
    const nextSummaries = { ...nextState.sessionSummaries };

    for (const [sumKey, summary] of Object.entries(nextSummaries)) {
      const chatKey = makeActiveChatDraftKey(
        summary.connectionId,
        summary.profileId,
        summary.sessionId,
      );
      const draft = draftsByKey[chatKey];
      if (draft) {
        nextSummaries[sumKey] = {
          ...summary,
          hasDraft: !isDraftRecordEmpty(draft),
          ...(draft.text.trim().length > 0 ? { draftText: draft.text } : { draftText: undefined }),
          ...(draft.annotations && draft.annotations.length > 0
            ? { annotations: draft.annotations }
            : { annotations: undefined }),
        };
      } else if (summary.hasDraft || summary.draftText || summary.annotations?.length) {
        nextSummaries[sumKey] = {
          ...summary,
          hasDraft: false,
          draftText: undefined,
          annotations: undefined,
        };
      }
    }

    for (const draft of Object.values(draftsByKey)) {
      if (!draft.sessionId) continue;
      const sumKey = `${draft.scope.connectionId}::${draft.scope.profileId ?? "default"}::${draft.sessionId}`;
      const existingSum = nextSummaries[sumKey];
      nextSummaries[sumKey] = {
        connectionId: draft.scope.connectionId,
        profileId: draft.scope.profileId ?? "default",
        sessionId: draft.sessionId,
        title: existingSum?.title ?? draft.sessionId,
        preview: existingSum?.preview,
        updatedAt: existingSum?.updatedAt,
        hasDraft: !isDraftRecordEmpty(draft),
        ...(draft.text.trim().length > 0 ? { draftText: draft.text } : {}),
        ...(draft.annotations && draft.annotations.length > 0
          ? { annotations: draft.annotations }
          : {}),
        lastKnownMessages: existingSum?.lastKnownMessages,
      };
    }

    const totalBytes = measureTotalDraftsBytes(draftsByKey, orphanedDrafts);
    return {
      ...nextState,
      sessionSummaries: nextSummaries,
      draftsByKey,
      orphanedDrafts,
      draftStorageUsage: {
        totalBytes,
        maxDraftBytes: DRAFT_MAX_BYTES,
        maxTotalBytes: DRAFTS_TOTAL_MAX_BYTES,
        overTotalLimit: totalBytes > DRAFTS_TOTAL_MAX_BYTES,
        draftCount: Object.keys(draftsByKey).length,
        orphanedCount: orphanedDrafts.length,
      },
    };
  }

  function resolveMockDraftOrigin(
    connectionId: string,
    profileId: string,
    sessionId?: string,
    override?: Partial<DraftOrigin>,
  ): DraftOrigin {
    const sess = sessionId
      ? currentFleet.sessions.find(
          (s) =>
            s.connectionId === connectionId &&
            s.profileId === profileId &&
            s.sessionId === sessionId,
        ) ??
        mockSessions.find(
          (s) =>
            s.connectionId === connectionId &&
            s.profileId === profileId &&
            s.sessionId === sessionId,
        )
      : undefined;
    return {
      connectionId,
      profileId,
      ...(sessionId ? { sessionId } : {}),
      ...(override?.title || sess?.title ? { title: override?.title ?? sess?.title } : {}),
    };
  }

  function sanitizeMockAttachments(raw: unknown): DraftAttachment[] {
    if (!Array.isArray(raw)) return [];
    const out: DraftAttachment[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i];
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.handle !== "string" || typeof obj.displayName !== "string") continue;
      const kind =
        obj.kind === "image" || obj.kind === "text" || obj.kind === "binary" ? obj.kind : "file";
      out.push({
        attachmentId:
          typeof obj.attachmentId === "string" && obj.attachmentId
            ? obj.attachmentId
            : `att-${i + 1}-${obj.handle}`,
        handle: obj.handle,
        displayName: obj.displayName,
        kind,
        ...(typeof obj.sizeBytes === "number" ? { sizeBytes: obj.sizeBytes } : {}),
        ...(typeof obj.expired === "boolean" ? { expired: obj.expired } : {}),
      });
    }
    return out;
  }

  function sanitizeMockContexts(raw: unknown): DraftContextItem[] {
    if (!Array.isArray(raw)) return [];
    const out: DraftContextItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.contextId !== "string" || typeof obj.label !== "string") continue;
      const kind =
        obj.kind === "artifact" || obj.kind === "line_range" || obj.kind === "snippet"
          ? obj.kind
          : "file";
      out.push({
        contextId: obj.contextId,
        kind,
        ref: typeof obj.ref === "string" ? obj.ref : obj.label,
        label: obj.label,
        ...(typeof obj.version === "string" || typeof obj.version === "number"
          ? { version: obj.version }
          : {}),
      });
    }
    return out;
  }

  function sanitizeMockComposer(raw: unknown, existing?: DraftComposerState): DraftComposerState {
    if (!raw || typeof raw !== "object") return existing ?? {};
    const obj = raw as Record<string, unknown>;
    return {
      ...(typeof obj.selectionStart === "number"
        ? { selectionStart: obj.selectionStart }
        : existing?.selectionStart !== undefined
          ? { selectionStart: existing.selectionStart }
          : {}),
      ...(typeof obj.selectionEnd === "number"
        ? { selectionEnd: obj.selectionEnd }
        : existing?.selectionEnd !== undefined
          ? { selectionEnd: existing.selectionEnd }
          : {}),
      ...(typeof obj.sendOnEnter === "boolean"
        ? { sendOnEnter: obj.sendOnEnter }
        : existing?.sendOnEnter !== undefined
          ? { sendOnEnter: existing.sendOnEnter }
          : {}),
    };
  }

  function orphanMockDraftsMatching(
    predicate: (key: string, draft: DraftRecord) => boolean,
    reason: OrphanedDraftReason,
  ): number {
    const draftsByKey = { ...(currentChatState.draftsByKey ?? {}) };
    const orphanedDrafts = [...(currentChatState.orphanedDrafts ?? [])];
    let count = 0;
    for (const [key, draft] of Object.entries(draftsByKey)) {
      if (!predicate(key, draft)) continue;
      delete draftsByKey[key];
      if (isDraftRecordEmpty(draft)) continue;
      mockDraftCounter += 1;
      orphanedDrafts.unshift({
        orphanedId: `orphan-${Date.now()}-${mockDraftCounter}`,
        draftId: draft.draftId,
        text: draft.text,
        attachments: draft.attachments.map((a) => ({ ...a })),
        contexts: draft.contexts.map((c) => ({ ...c })),
        ...(draft.annotations?.length ? { annotations: [...draft.annotations] } : {}),
        origin: { ...draft.origin },
        reason,
        orphanedAt: new Date().toISOString(),
      });
      count += 1;
    }
    if (count > 0) {
      currentChatState = recomputeMockDraftState({
        ...currentChatState,
        draftsByKey,
        orphanedDrafts,
      });
      emitChatStatePatch();
    }
    return count;
  }

  function migrateMockNewChatDraft(
    connectionId: string,
    profileId: string,
    draftId: string | undefined,
    sessionId: string,
  ): void {
    const draftsByKey = { ...(currentChatState.draftsByKey ?? {}) };
    let sourceKey: string | undefined;
    if (draftId) {
      const candidateKey = makeNewChatDraftKey(connectionId, profileId, draftId);
      if (draftsByKey[candidateKey]) sourceKey = candidateKey;
    }
    if (!sourceKey) return;
    const source = draftsByKey[sourceKey];
    const targetKey = makeActiveChatDraftKey(connectionId, profileId, sessionId);
    delete draftsByKey[sourceKey];
    draftsByKey[targetKey] = {
      ...source,
      sessionId,
      scope: { connectionId, profileId },
      origin: resolveMockDraftOrigin(connectionId, profileId, sessionId, source.origin),
      revision: source.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    currentChatState = recomputeMockDraftState({
      ...currentChatState,
      draftsByKey,
    });
    emitChatStatePatch();
  }

  function markMockDraftDeliveryStatus(
    connectionId: string,
    profileId: string,
    sessionId: string | undefined,
    draftId: string | undefined,
    status: DraftDeliveryStatus,
  ): void {
    const draftsByKey = { ...(currentChatState.draftsByKey ?? {}) };
    const key = sessionId
      ? makeActiveChatDraftKey(connectionId, profileId, sessionId)
      : draftId
        ? makeNewChatDraftKey(connectionId, profileId, draftId)
        : undefined;
    if (!key || !draftsByKey[key]) return;
    draftsByKey[key] = {
      ...draftsByKey[key],
      deliveryStatus: status,
      revision: draftsByKey[key].revision + 1,
      updatedAt: new Date().toISOString(),
    };
    currentChatState = recomputeMockDraftState({
      ...currentChatState,
      draftsByKey,
    });
    emitChatStatePatch();
  }

  function clearMockDraftOnReceipt(
    connectionId: string,
    profileId: string,
    sessionId: string | undefined,
    draftId: string | undefined,
    receiptStatus: "accepted" | "admitted",
  ): void {
    if (!shouldClearDraftForReceipt(receiptStatus)) return;
    const draftsByKey = { ...(currentChatState.draftsByKey ?? {}) };
    let changed = false;
    if (sessionId) {
      const activeKey = makeActiveChatDraftKey(connectionId, profileId, sessionId);
      if (draftsByKey[activeKey]) {
        delete draftsByKey[activeKey];
        changed = true;
      }
    }
    if (draftId) {
      const newKey = makeNewChatDraftKey(connectionId, profileId, draftId);
      if (draftsByKey[newKey]) {
        delete draftsByKey[newKey];
        changed = true;
      }
    }
    if (changed) {
      currentChatState = recomputeMockDraftState({
        ...currentChatState,
        draftsByKey,
      });
      emitChatStatePatch();
    }
  }

  function lookupTranscript(
    map: Map<string, SessionTranscriptSnapshot>,
    connectionId: string,
    profileId: string,
    sessionId: string,
  ): SessionTranscriptSnapshot | undefined {
    return (
      map.get(`${connectionId}::${profileId}::${sessionId}`) ??
      map.get(sessionId)
    );
  }

  function makeEmptyTranscript(
    connectionId: string,
    profileId: string,
    sessionId: string,
  ): SessionTranscriptSnapshot {
    return {
      connectionId,
      profileId,
      sessionId,
      messages: [],
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
    };
  }

  let authRev = 0;
  let authEventSeq = 0;

  const oauthBoundIds = new Set<string>();
  const tokenSyncFailedIds = new Set<string>();
  const grantedAuthTokens = new Map<string, string>();
  const activeAuthTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const activeAuthMeta = new Map<string, { originDisplay: string; connectionId?: string }>();
  let latestAuthState: AuthStateSnapshot | null = null;

  const getExtraIssues = (): RegistryIssue[] =>
    [...tokenSyncFailedIds].map((connectionId) => ({
      code: "token_sync_failed",
      severity: "warning",
      connectionId,
      messageKey: "registry.issue.tokenSyncFailed",
    }));

  const currentRegistrySnapshot = (): RegistrySnapshotView =>
    projectRegistrySnapshot(currentNorm, {
      oauthTokenIds: oauthBoundIds,
      extraIssues: getExtraIssues(),
    });

  const emitAuthState = (snapshot: AuthStateSnapshot) => {
    const safe = redactSensitiveData(snapshot);
    latestAuthState = safe;
    authRev += 1;
    authEventSeq += 1;
    const scope = safe.connectionId ? { connectionId: safe.connectionId } : null;
    for (const listener of authListeners) {
      listener({
        topic: "auth.state",
        scope,
        kind: "patch",
        seq: authEventSeq,
        revision: authRev,
        payload: safe,
      });
    }
  };

  function getMockFleet(): FleetSnapshot {
    return {
      connections: mockConnections.map((c) => ({ ...c })),
      profiles: mockProfiles.map((p) => ({ ...p })),
      sessions: mockSessions.map((s) => ({ ...s })),
      activeScope: mockActiveScope ? { ...mockActiveScope } : null,
      activeSessionId: mockActiveSessionId,
    };
  }

  function emitMockFleet(): void {
    fleetRev += 1;
    const snap = getMockFleet();
    for (const listener of fleetListeners) {
      listener({
        topic: "fleet",
        scope: null,
        kind: "snapshot",
        seq: 0,
        revision: fleetRev,
        payload: snap,
      });
    }
    for (const listener of healthListeners) {
      listener({
        topic: "connection.health",
        scope: null,
        kind: "snapshot",
        seq: 0,
        revision: fleetRev,
        payload: snap.connections,
      });
    }
    for (const sub of profileListeners) {
      const cid = sub.connectionId ?? mockActiveScope?.connectionId ?? "";
      sub.listener({
        topic: "profiles",
        scope: cid ? { connectionId: cid } : null,
        kind: "snapshot",
        seq: 0,
        revision: fleetRev,
        payload: {
          profiles: cid ? mockProfiles.filter((p) => p.connectionId === cid) : [],
        },
      });
    }
    for (const sub of sessionListeners) {
      const cid = sub.connectionId ?? mockActiveScope?.connectionId ?? "";
      const pid = sub.profileId ?? mockActiveScope?.profileId ?? "default";
      sub.listener({
        topic: "sessions",
        scope: cid ? { connectionId: cid, profileId: pid } : null,
        kind: "snapshot",
        seq: 0,
        revision: fleetRev,
        payload: {
          sessions: cid
            ? mockSessions.filter((s) => s.connectionId === cid && s.profileId === pid)
            : [],
        },
      });
    }
  }

  function transcriptKey(connectionId: string, profileId: string, sessionId: string): string {
    return `${connectionId}::${profileId}::${sessionId}`;
  }

  function emitTranscriptEvent(scope: BridgeScope, kind: "snapshot" | "patch", payload: unknown): void {
    fleetRev += 1;
    for (const sub of transcriptListeners) {
      if (
        sub.scope &&
        sub.scope.connectionId === scope.connectionId &&
        (sub.scope.profileId ?? "default") === (scope.profileId ?? "default") &&
        sub.scope.sessionId === scope.sessionId
      ) {
        sub.seq = kind === "snapshot" ? 0 : sub.seq + 1;
        sub.listener({
          topic: "session.transcript",
          scope,
          kind,
          seq: sub.seq,
          revision: fleetRev,
          payload,
        });
      }
    }
  }

  function seedMockSshConnection(connectionId: string, label: string, host: string, remoteProfile?: string): void {
    const defaultProfile = remoteProfile?.trim() || "default";
    const health: ConnectionHealthSummary = {
      connectionId,
      label,
      kind: "ssh",
      originDisplay: host,
      actual: "ready",
      degraded: false,
      latencyMs: 14,
      nextRetryAt: null,
    };
    const existingIdx = mockConnections.findIndex((c) => c.connectionId === connectionId);
    if (existingIdx >= 0) {
      mockConnections[existingIdx] = health;
    } else {
      mockConnections.push(health);
      const secondaryProfile = defaultProfile === "ops" ? "staging" : "ops";
      const profiles: ProfileSummary[] = [
        {
          connectionId,
          profileId: defaultProfile,
          displayName: defaultProfile === "default" ? "Remote Default" : `Remote ${defaultProfile}`,
          handle: defaultProfile,
          isDefault: true,
          actual: "ready",
        },
        {
          connectionId,
          profileId: secondaryProfile,
          displayName: defaultProfile === "ops" ? "Remote Staging" : "Remote Ops",
          handle: secondaryProfile,
          isDefault: false,
          actual: "idle",
        },
      ];
      mockProfiles.push(...profiles);
      const sess1: SessionSummary = {
        connectionId,
        profileId: defaultProfile,
        sessionId: `${connectionId}-sess-1`,
        title: `Remote SSH (${label})`,
        preview: host,
        updatedAt: new Date().toISOString(),
        pinned: false,
        unreadCount: 0,
        needsInput: false,
        activeTurnId: null,
        status: "idle",
      };
      const sess2: SessionSummary = {
        connectionId,
        profileId: secondaryProfile,
        sessionId: `${connectionId}-${secondaryProfile}-sess-1`,
        title: `Remote ${secondaryProfile} (${label})`,
        preview: host,
        updatedAt: new Date().toISOString(),
        pinned: false,
        unreadCount: 0,
        needsInput: false,
        activeTurnId: null,
        status: "idle",
      };
      mockSessions.push(sess1, sess2);
      for (const s of [sess1, sess2]) {
        mockTranscripts.set(transcriptKey(connectionId, s.profileId, s.sessionId), {
          connectionId,
          profileId: s.profileId,
          sessionId: s.sessionId,
          messages: [],
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
        });
      }
    }
    emitMockFleet();
  }

  const buildMockDiagnostics = (): SanitizedDiagnosticsPayload =>
    sanitizeDiagnosticsPayload({
      generatedAt: "2026-11-23T06:00:00.000Z",
      appName: "Hermes Desktop",
      appVersion: mockAppInfo.appVersion,
      bridgeVersion: HOST_BRIDGE_VERSION,
      buildMode: "mock",
      mode: "mock",
      platform: "web",
      arch: "wasm",
      hermesHomeKind: "mock",
      connectionsCount: currentNorm.doc.connections.length,
      cliSummary: currentInspection.cli,
      typedFailureCode: currentInspection.failure?.code ?? null,
      failurePhase: currentInspection.failure?.phase ?? null,
      stages: [
        { phase: "override", outcome: "skipped" },
        { phase: "login_shell_ilc", outcome: "skipped" },
        { phase: "login_shell_lc", outcome: "skipped" },
        { phase: "common_dirs", outcome: "failed" },
      ],
      notes: ["MockHostBridge mode"],
    });

  function emitRegistryPatch(
    prev: NormalizedRegistryResult,
    prevIssues: RegistryIssue[] = [],
  ): RegistrySnapshotView {
    const nextIssues = getExtraIssues();
    const diff = diffRegistries(prev, currentNorm, {
      extraPrevIssues: prevIssues,
      extraNextIssues: nextIssues,
    });
    const snapshot = currentRegistrySnapshot();
    registrySeq += 1;
    for (const listener of registryListeners) {
      listener({
        topic: "registry",
        scope: null,
        kind: "patch",
        seq: registrySeq,
        revision: snapshot.revision,
        payload: { snapshot, diff },
      });
    }
    return snapshot;
  }

  function asInput(payload: Record<string, unknown>): ConnectionMutationInput {
    return {
      kind: payload.kind as ConnectionMutationInput["kind"],
      label: typeof payload.label === "string" ? payload.label : "",
      url: typeof payload.url === "string" ? payload.url : undefined,
      authMode: payload.authMode === "oauth" ? "oauth" : payload.authMode === "token" ? "token" : undefined,
      token: typeof payload.token === "string" ? payload.token : undefined,
      authSessionId: typeof payload.authSessionId === "string" ? payload.authSessionId : undefined,
      clearToken: Boolean(payload.clearToken),
      host: typeof payload.host === "string" ? payload.host : undefined,
      user: typeof payload.user === "string" ? payload.user : undefined,
      port: typeof payload.port === "number" ? payload.port : undefined,
      keyPath: typeof payload.keyPath === "string" ? payload.keyPath : undefined,
      remoteHermesPath:
        typeof payload.remoteHermesPath === "string" ? payload.remoteHermesPath : undefined,
      remoteProfile: typeof payload.remoteProfile === "string" ? payload.remoteProfile : undefined,
      org: typeof payload.org === "string" ? payload.org : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
    };
  }

  const dispatcher = createBridgeDispatcher({
    "bridge.hello": async (): Promise<AppInfo> => mockAppInfo,
    "connections.list": async () => {
      const registry = currentRegistrySnapshot();
      return { connections: registry.connections, registry };
    },
    "connections.test": async (payload): Promise<ConnectionTestResult | RemoteTestResult> => {
      if (payload.kind === "ssh") {
        const host = typeof payload.host === "string" ? payload.host.trim() : "";
        const user = typeof payload.user === "string" ? payload.user.trim() : undefined;
        const port = typeof payload.port === "number" ? payload.port : undefined;
        const preferLegacyAttach = Boolean(payload.preferLegacyAttach);
        const sshTargetDisplay = formatSshTargetDisplay({ host, user, port });
        const validation = validateSshTargetInput({ host, user, port });
        if (!validation.valid) {
          return {
            ok: false,
            kind: "ssh",
            status: "failed",
            failureCode: "ssh_unreachable",
            message: validation.reason,
            actions: ["edit_target", "retry"],
            sshTargetDisplay,
          };
        }

        const hostLower = host.toLowerCase();
        if (hostLower === "changed-host.example.com") {
          return {
            ok: false,
            kind: "ssh",
            status: "blocked",
            failureCode: "host_key_changed",
            message: getSshFailureCopy("host_key_changed"),
            actions: ["edit_target"],
            sshTargetDisplay,
          };
        }
        if (hostLower === "unknown-host.example.com" && !trustedMockHosts.has(hostLower)) {
          return {
            ok: false,
            kind: "ssh",
            status: "blocked",
            failureCode: "host_key_unknown",
            message: getSshFailureCopy("host_key_unknown"),
            hostKeyChallenge: {
              hostDisplay: formatSshHostDisplay(host, port),
              keyType: "ED25519",
              fingerprint: "SHA256:MockUnknownHostFingerprint88",
            },
            actions: ["confirm_host_key", "edit_target", "retry"],
            sshTargetDisplay,
          };
        }
        if (hostLower === "fail-host.example.com" && !preferLegacyAttach) {
          return {
            ok: false,
            kind: "ssh",
            status: "failed",
            failureCode: "protocol_unsupported",
            message: getSshFailureCopy("protocol_unsupported"),
            actions: ["edit_target", "retry", "legacy_attach"],
            sshTargetDisplay,
          };
        }
        if (hostLower === "fail-host.example.com" && preferLegacyAttach) {
          return {
            ok: true,
            kind: "ssh",
            status: "ready",
            sshMode: "attach_only",
            legacyNotice: true,
            windowsServiceSession: false,
            message: getCopy("gateways.testPassedLegacy"),
            actions: [],
            sshTargetDisplay,
          };
        }
        if (hostLower === "legacy-host.example.com") {
          return {
            ok: true,
            kind: "ssh",
            status: "ready",
            sshMode: "attach_only",
            legacyNotice: true,
            windowsServiceSession: false,
            message: getCopy("gateways.testPassedLegacy"),
            actions: [],
            sshTargetDisplay,
          };
        }
        if (hostLower === "win0-host.example.com") {
          return {
            ok: true,
            kind: "ssh",
            status: "ready",
            sshMode: "attach_only",
            legacyNotice: true,
            windowsServiceSession: true,
            message: getCopy("gateways.testPassedLegacy"),
            actions: [],
            sshTargetDisplay,
          };
        }
        return {
          ok: true,
          kind: "ssh",
          status: "ready",
          sshMode: "tickets_serve",
          legacyNotice: false,
          windowsServiceSession: false,
          message: getCopy("gateways.testPassedModern"),
          actions: [],
          sshTargetDisplay,
        };
      }

      const authMode = payload.authMode === "oauth" ? "oauth" : "token";
      const rawUrl = typeof payload.url === "string" ? payload.url : "";
      const token = typeof payload.token === "string" ? payload.token : "";
      const authSessionId =
        typeof payload.authSessionId === "string" ? payload.authSessionId : "";
      const connectionId =
        typeof payload.connectionId === "string" ? payload.connectionId : "";
      const checkedAt = new Date().toISOString();

      const check = validateRemoteEndpointUrl(rawUrl);
      if (!check.valid) {
        return redactSensitiveData<RemoteTestResult>({
          ok: false,
          kind: "remote",
          originDisplay: rawUrl.split(/[?#]/)[0]?.replace(/:\/\/[^/@]+@/, "://") ?? "",
          authMode,
          httpLeg: { ok: false, status: "skipped" },
          wsLeg: { ok: false, status: "skipped" },
          failedStage: "validation",
          errorCode: check.code,
          messageKey: check.messageKey,
          actions: ["edit_endpoint"],
          checkedAt,
        });
      }

      const hostname = new URL(check.normalizedUrl).hostname.toLowerCase();
      if (hostname.includes("http-fail")) {
        return redactSensitiveData<RemoteTestResult>({
          ok: false,
          kind: "remote",
          originDisplay: check.originDisplay,
          authMode,
          httpLeg: {
            ok: false,
            status: "failed",
            statusCode: 503,
            latencyMs: 14,
            errorCode: "unreachable",
            messageKey: "remote.test.httpFailed",
          },
          wsLeg: { ok: false, status: "skipped" },
          failedStage: "http",
          errorCode: "unreachable",
          messageKey: "remote.test.httpFailed",
          actions: ["edit_endpoint", "retry_test"],
          checkedAt,
        });
      }

      if (hostname.includes("ws-fail")) {
        return redactSensitiveData<RemoteTestResult>({
          ok: false,
          kind: "remote",
          originDisplay: check.originDisplay,
          authMode,
          httpLeg: { ok: true, status: "ok", statusCode: 200, latencyMs: 9 },
          wsLeg: {
            ok: false,
            status: "failed",
            latencyMs: 15,
            errorCode: "unreachable",
            messageKey: "remote.test.wsFailed",
          },
          failedStage: "ws",
          errorCode: "unreachable",
          messageKey: "remote.test.wsFailed",
          actions: ["edit_endpoint", "retry_test"],
          checkedAt,
        });
      }

      const existingConn = connectionId
        ? currentNorm.doc.connections.find((c) => c.id === connectionId)
        : undefined;
      const hasExistingStatic = Boolean(existingConn?.token?.value);
      const hasGrantedOAuth =
        (Boolean(authSessionId) && grantedAuthTokens.get(authSessionId) === check.normalizedUrl) ||
        (Boolean(connectionId) && oauthBoundIds.has(connectionId));

      const authFailure =
        hostname.includes("auth-fail") ||
        (authMode === "token" && (token === "bad-token" || (!token && !hasExistingStatic))) ||
        (authMode === "oauth" && !hasGrantedOAuth);

      if (authFailure) {
        const authAction: RemoteTestActionId =
          authMode === "oauth" ? "reauthorize_oauth" : "edit_auth";
        return redactSensitiveData<RemoteTestResult>({
          ok: false,
          kind: "remote",
          originDisplay: check.originDisplay,
          authMode,
          httpLeg: {
            ok: false,
            status: "failed",
            statusCode: 401,
            latencyMs: 8,
            errorCode: "auth_required",
            messageKey: "remote.test.authRequired",
          },
          wsLeg: { ok: false, status: "skipped" },
          failedStage: "auth",
          errorCode: "auth_required",
          messageKey: "remote.test.authRequired",
          actions: [authAction, "retry_test"],
          checkedAt,
        });
      }

      return redactSensitiveData<RemoteTestResult>({
        ok: true,
        kind: "remote",
        originDisplay: check.originDisplay,
        authMode,
        httpLeg: { ok: true, status: "ok", statusCode: 200, latencyMs: 11 },
        wsLeg: { ok: true, status: "ok", latencyMs: 16 },
        messageKey: "remote.test.ok",
        actions: [],
        checkedAt,
      });
    },
    "auth.start": async (payload): Promise<AuthStartResult> => {
      const rawUrl = typeof payload.url === "string" ? payload.url : "";
      const connectionId =
        typeof payload.connectionId === "string" && payload.connectionId.trim()
          ? payload.connectionId.trim()
          : undefined;
      const check = validateRemoteEndpointUrl(rawUrl);
      if (!check.valid) {
        const err = new Error(check.messageKey);
        (err as { code?: string }).code = check.code;
        throw err;
      }

      authSeq += 1;
      const authSessionId = `mock-auth-${authSeq}`;
      const originDisplay = check.originDisplay;
      activeAuthMeta.set(authSessionId, { originDisplay, connectionId });

      emitAuthState({
        authSessionId,
        ...(connectionId ? { connectionId } : {}),
        originDisplay,
        status: "waiting",
        messageKey: "gateways.oauthWaiting",
        updatedAt: new Date().toISOString(),
      });

      const hostname = new URL(check.normalizedUrl).hostname.toLowerCase();
      if (!hostname.includes("oauth-wait")) {
        const timer = setTimeout(() => {
          activeAuthTimers.delete(authSessionId);
          activeAuthMeta.delete(authSessionId);
          if (hostname.includes("oauth-fail")) {
            emitAuthState({
              authSessionId,
              ...(connectionId ? { connectionId } : {}),
              originDisplay,
              status: "failed",
              errorCode: "auth_failed",
              messageKey: "gateways.oauthFailed",
              updatedAt: new Date().toISOString(),
            });
            return;
          }
          if (connectionId) {
            const prevIssues = getExtraIssues();
            oauthBoundIds.add(connectionId);
            tokenSyncFailedIds.delete(connectionId);
            emitRegistryPatch(currentNorm, prevIssues);
          } else {
            grantedAuthTokens.set(authSessionId, check.normalizedUrl);
          }
          emitAuthState({
            authSessionId,
            ...(connectionId ? { connectionId } : {}),
            originDisplay,
            status: "granted",
            messageKey: "gateways.oauthGranted",
            updatedAt: new Date().toISOString(),
          });
        }, 30);
        activeAuthTimers.set(authSessionId, timer);
      }

      return redactSensitiveData<AuthStartResult>({
        authSessionId,
        ...(connectionId ? { connectionId } : {}),
        originDisplay,
        status: "waiting",
        messageKey: "gateways.oauthWaiting",
        updatedAt: new Date().toISOString(),
      });
    },
    "auth.cancel": async (payload) => {
      const authSessionId = typeof payload.authSessionId === "string" ? payload.authSessionId : "";
      const timer = activeAuthTimers.get(authSessionId);
      if (timer) {
        clearTimeout(timer);
        activeAuthTimers.delete(authSessionId);
      }
      const meta = activeAuthMeta.get(authSessionId);
      activeAuthMeta.delete(authSessionId);
      if (meta) {
        emitAuthState({
          authSessionId,
          ...(meta.connectionId ? { connectionId: meta.connectionId } : {}),
          originDisplay: meta.originDisplay,
          status: "cancelled",
          errorCode: "cancelled",
          messageKey: "gateways.oauthCancelled",
          updatedAt: new Date().toISOString(),
        });
        return { cancelled: true, authSessionId };
      }
      return { cancelled: false, authSessionId };
    },
    "connections.add": async (payload): Promise<ConnectionMutationResponse> => {
      const input = asInput(payload);
      const prevIssues = getExtraIssues();
      const check = validateClientAddConnection(currentNorm.doc, input, oauthBoundIds);
      if (!check.ok) {
        return {
          committed: false,
          snapshot: currentRegistrySnapshot(),
          warnings: [],
          rejectedIssue: check.issue,
          conflict: check.conflict,
        };
      }
      const prev = currentNorm;
      const warnings: RegistryIssue[] = [];
      const addedId = check.connection.id;
      if (
        check.connection.kind === "remote" &&
        input.authMode === "oauth" &&
        input.authSessionId
      ) {
        if (check.connection.url?.includes("sync-fail")) {
          tokenSyncFailedIds.add(addedId);
          warnings.push({
            code: "token_sync_failed",
            severity: "warning",
            connectionId: addedId,
            messageKey: "registry.issue.tokenSyncFailed",
          });
        } else if (grantedAuthTokens.has(input.authSessionId)) {
          oauthBoundIds.add(addedId);
          grantedAuthTokens.delete(input.authSessionId);
        }
      }
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        connections: [...currentNorm.doc.connections, check.connection],
      });
      const snapshot = emitRegistryPatch(prev, prevIssues);
      if (check.connection.kind === "ssh") {
        seedMockSshConnection(
          check.connection.id,
          check.connection.label,
          formatSshTargetDisplay(check.connection) ?? check.connection.host ?? check.connection.id,
          check.connection.remoteProfile,
        );
      }
      return {
        committed: true,
        snapshot,
        warnings,
      };
    },
    "connections.update": async (payload): Promise<ConnectionMutationResponse> => {
      const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const input = asInput(payload);
      const prevIssues = getExtraIssues();
      const check = validateClientUpdateConnection(currentNorm.doc, connectionId, input, oauthBoundIds);
      if (!check.ok) {
        return {
          committed: false,
          snapshot: currentRegistrySnapshot(),
          warnings: [],
          rejectedIssue: check.issue,
          conflict: check.conflict,
        };
      }
      const prev = currentNorm;
      const warnings: RegistryIssue[] = [];
      if (input.authMode === "token" && input.token) {
        tokenSyncFailedIds.delete(connectionId);
      } else if (input.authMode === "oauth" && input.authSessionId) {
        if (check.connection.url?.includes("sync-fail")) {
          tokenSyncFailedIds.add(connectionId);
          warnings.push({
            code: "token_sync_failed",
            severity: "warning",
            connectionId,
            messageKey: "registry.issue.tokenSyncFailed",
          });
        } else if (grantedAuthTokens.has(input.authSessionId)) {
          oauthBoundIds.add(connectionId);
          tokenSyncFailedIds.delete(connectionId);
          grantedAuthTokens.delete(input.authSessionId);
        }
      }
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        connections: currentNorm.doc.connections.map((c) =>
          c.id === connectionId ? check.connection : c,
        ),
      });
      const snapshot = emitRegistryPatch(prev, prevIssues);
      if (check.connection.kind === "ssh") {
        seedMockSshConnection(
          check.connection.id,
          check.connection.label,
          formatSshTargetDisplay(check.connection) ?? check.connection.host ?? check.connection.id,
          check.connection.remoteProfile,
        );
      }
      return {
        committed: true,
        snapshot,
        warnings,
      };
    },
    "connections.remove": async (payload): Promise<ConnectionMutationResponse> => {
      const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const prevIssues = getExtraIssues();
      const check = validateClientRemoveConnection(currentNorm.doc, connectionId);
      if (!check.ok) {
        return {
          committed: false,
          snapshot: currentRegistrySnapshot(),
          warnings: [],
          rejectedIssue: check.issue,
        };
      }
      oauthBoundIds.delete(connectionId);
      tokenSyncFailedIds.delete(connectionId);
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        primary: currentNorm.doc.primary === connectionId ? "local" : currentNorm.doc.primary,
        lastUsed: currentNorm.doc.lastUsed === connectionId ? undefined : currentNorm.doc.lastUsed,
        connections: currentNorm.doc.connections.filter((c) => c.id !== connectionId),
      });
      const snapshot = emitRegistryPatch(prev, prevIssues);
      if (fixture) {
        const nextConns = currentFleet.connections.filter((c) => c.connectionId !== connectionId);
        const nextProfs = currentFleet.profiles.filter((p) => p.connectionId !== connectionId);
        const nextSessions = currentFleet.sessions.filter((s) => s.connectionId !== connectionId);
        let nextScope = currentFleet.activeScope;
        let nextSessionId = currentFleet.activeSessionId;
        if (nextScope?.connectionId === connectionId) {
          const fallbackConn = nextConns[0];
          const fallbackProf = fallbackConn
            ? nextProfs.find((p) => p.connectionId === fallbackConn.connectionId)
            : undefined;
          const fallbackSess =
            fallbackConn && fallbackProf
              ? nextSessions.find(
                  (s) =>
                    s.connectionId === fallbackConn.connectionId &&
                    s.profileId === fallbackProf.profileId,
                )
              : undefined;
          nextScope = fallbackConn
            ? {
                connectionId: fallbackConn.connectionId,
                profileId: fallbackProf?.profileId ?? "default",
                ...(fallbackSess ? { sessionId: fallbackSess.sessionId } : {}),
              }
            : null;
          nextSessionId = fallbackSess?.sessionId ?? null;
        }
        currentFleet = {
          ...currentFleet,
          connections: nextConns,
          profiles: nextProfs,
          sessions: nextSessions,
          activeScope: nextScope,
          activeSessionId: nextSessionId,
        };
        approvalCoordinator.onScopeRemoved({ connectionId });
        approvalCoordinator.setActiveScope(currentFleet.activeScope);
        emitFleetSnapshot();
        emitSessionsSnapshot();
      } else {
        const idx = mockConnections.findIndex((c) => c.connectionId === connectionId);
        if (idx >= 0) mockConnections.splice(idx, 1);
        for (let i = mockProfiles.length - 1; i >= 0; i -= 1) {
          if (mockProfiles[i].connectionId === connectionId) mockProfiles.splice(i, 1);
        }
        for (let i = mockSessions.length - 1; i >= 0; i -= 1) {
          if (mockSessions[i].connectionId === connectionId) mockSessions.splice(i, 1);
        }
        if (mockActiveScope?.connectionId === connectionId) {
          mockActiveScope = null;
          mockActiveSessionId = null;
        }
        approvalCoordinator.onScopeRemoved({ connectionId });
        approvalCoordinator.setActiveScope(mockActiveScope);
        emitMockFleet();
      }
      orphanMockDraftsMatching(
        (_k, draft) => draft.scope.connectionId === connectionId,
        "connection_removed",
      );
      return {
        committed: true,
        snapshot,
        warnings: [],
      };
    },
    "connections.confirmHostKey": async (payload): Promise<SshHostKeyConfirmResult> => {
      const host = typeof payload.host === "string" ? payload.host.trim() : "";
      const user = typeof payload.user === "string" ? payload.user.trim() : undefined;
      const port = typeof payload.port === "number" ? payload.port : undefined;
      const sshTargetDisplay = formatSshTargetDisplay({ host, user, port });
      const hostLower = host.toLowerCase();
      if (hostLower === "changed-host.example.com") {
        return {
          confirmed: false,
          cancelled: false,
          hardBlocked: true,
          sshTargetDisplay,
          message: getSshFailureCopy("host_key_changed"),
        };
      }
      if (hostLower) {
        trustedMockHosts.add(hostLower);
      }
      return {
        confirmed: true,
        cancelled: false,
        hardBlocked: false,
        sshTargetDisplay,
      };
    },
    "connections.setPrimary": async (payload): Promise<ConnectionMutationResponse> => {
      const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const exists = currentNorm.doc.connections.some((c) => c.id === connectionId);
      if (!exists || currentNorm.duplicateIds.has(connectionId)) {
        return {
          committed: false,
          snapshot: currentRegistrySnapshot(),
          warnings: [],
          rejectedIssue: {
            code: "registry_invalid",
            severity: "error",
            connectionId,
            messageKey: "registry.issue.invalidPrimary",
          },
        };
      }
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        primary: connectionId,
      });
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev),
        warnings: [],
      };
    },
    "connections.setLaunchMode": async (payload): Promise<ConnectionMutationResponse> => {
      const launchMode = payload.launchMode as LaunchMode;
      if (launchMode !== "primary" && launchMode !== "last-used") {
        return {
          committed: false,
          snapshot: currentRegistrySnapshot(),
          warnings: [],
          rejectedIssue: {
            code: "registry_invalid",
            severity: "error",
            messageKey: "registry.issue.invalidInput",
          },
        };
      }
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        launchMode,
      });
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev),
        warnings: [],
      };
    },
    "connections.setLastUsed": async (payload): Promise<ConnectionMutationResponse> => {
      const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const exists = currentNorm.doc.connections.some((c) => c.id === connectionId);
      if (!exists || currentNorm.duplicateIds.has(connectionId)) {
        return {
          committed: false,
          snapshot: currentRegistrySnapshot(),
          warnings: [],
          rejectedIssue: {
            code: "registry_invalid",
            severity: "error",
            connectionId,
            messageKey: "registry.issue.notFound",
          },
        };
      }
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        lastUsed: connectionId,
      });
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev),
        warnings: [],
      };
    },
    "connections.backupAndRepair": async (): Promise<ConnectionMutationResponse> => {
      return {
        committed: true,
        snapshot: currentRegistrySnapshot(),
        warnings: [],
      };
    },
    "connections.exportSafeSummary": async () => {
      const snap = currentRegistrySnapshot();
      return {
        exportedAt: new Date().toISOString(),
        version: snap.version,
        revision: snap.revision,
        launchMode: snap.launchMode,
        primary: snap.primary,
        lastUsed: snap.lastUsed,
        connectionCount: snap.connections.length,
        quarantinedCount: snap.quarantinedCount,
        readOnly: snap.readOnly,
        issues: snap.issues,
        connections: snap.connections.map((c) => ({
          id: c.id,
          kind: c.kind,
          label: c.label,
          dialable: c.dialable,
          hasToken: c.hasToken,
          originDisplay: c.originDisplay,
          sshTargetDisplay: c.sshTargetDisplay,
        })),
      };
    },
    "registry.refresh": async () => ({
      registry: currentRegistrySnapshot(),
    }),
    "profiles.list": async (payload, scope) => {
      if (fixture) {
        return { profiles: currentFleet.profiles };
      }
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId;
      return {
        profiles: cid ? mockProfiles.filter((p) => p.connectionId === cid) : [...mockProfiles],
      };
    },
    "scopes.switch": async (payload, scope) => {
      if (fixture) {
        const cid =
          typeof payload.connectionId === "string" && payload.connectionId
            ? payload.connectionId
            : scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
        const hit = cid ? currentFleet.connections.find((c) => c.connectionId === cid) : null;
        if (!cid || !hit) {
          return { ok: false, fleet: currentFleet, transcript: null };
        }
        const profs = currentFleet.profiles.filter((p) => p.connectionId === cid);
        const pid =
          typeof payload.profileId === "string" && payload.profileId
            ? payload.profileId
            : scope?.profileId ?? profs[0]?.profileId ?? "default";
        const candidates = currentFleet.sessions.filter(
          (s) => s.connectionId === cid && s.profileId === pid,
        );
        const requestedSid =
          typeof payload.sessionId === "string" && payload.sessionId
            ? payload.sessionId
            : scope?.sessionId ?? null;
        const rememberedSid = currentChatState.lastSessionByScope[`${cid}::${pid}`] ?? null;
        const validRemembered =
          rememberedSid && candidates.some((s) => s.sessionId === rememberedSid)
            ? rememberedSid
            : null;
        const nextSessionId = requestedSid ?? validRemembered ?? candidates[0]?.sessionId ?? null;
        currentFleet = {
          ...currentFleet,
          profiles: currentFleet.profiles.map((p) =>
            p.connectionId === cid && p.profileId === pid
              ? { ...p, actual: "ready" }
              : p,
          ),
          activeScope: {
            connectionId: cid,
            profileId: pid,
            ...(nextSessionId ? { sessionId: nextSessionId } : {}),
          },
          activeSessionId: nextSessionId,
        };
        currentChatState = {
          ...currentChatState,
          lastActiveChat: {
            connectionId: cid,
            profileId: pid,
            ...(nextSessionId ? { sessionId: nextSessionId } : {}),
          },
          lastSessionByScope: {
            ...currentChatState.lastSessionByScope,
            ...(nextSessionId ? { [`${cid}::${pid}`]: nextSessionId } : {}),
          },
          activeStatus: nextSessionId ? "ready" : "empty",
          missingSession: null,
        };
        const needsResync = nextSessionId ? isResyncRequired(cid, pid, nextSessionId) : false;
        const transcript =
          nextSessionId && !needsResync
            ? lookupTranscript(transcriptMap, cid, pid, nextSessionId) ??
              makeEmptyTranscript(cid, pid, nextSessionId)
            : null;
        const capKey = capabilityRegistry.getSnapshot().key;
        if (capKey.connectionId !== cid || capKey.profileId !== pid) {
          mockOwnerGen += 1;
          applyMockCapabilityHandshake(readE2EFixture() ?? fixture, {
            connectionId: cid,
            profileId: pid,
          });
          emitCapabilitiesPatch();
        }
        emitFleetSnapshot();
        emitChatStatePatch();
        approvalCoordinator.setActiveScope(currentFleet.activeScope);
        return {
          ok: true,
          fleet: currentFleet,
          transcript,
          ...(needsResync ? { resyncRequired: true } : {}),
        };
      }
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ?? mockActiveScope?.connectionId;
      const hit = cid ? mockConnections.find((c) => c.connectionId === cid) : null;
      if (!cid || !hit) {
        return { ok: false, fleet: getMockFleet(), transcript: null };
      }
      const profs = mockProfiles.filter((p) => p.connectionId === cid);
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ?? profs[0]?.profileId ?? "default";
      for (const p of mockProfiles) {
        if (p.connectionId === cid && p.profileId === pid) {
          p.actual = "ready";
        }
      }
      const candidates = mockSessions.filter((s) => s.connectionId === cid && s.profileId === pid);
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : candidates[0]?.sessionId ?? null;
      mockActiveScope = { connectionId: cid, profileId: pid, ...(sid ? { sessionId: sid } : {}) };
      mockActiveSessionId = sid;
      approvalCoordinator.setActiveScope(mockActiveScope);
      const transcript = sid ? mockTranscripts.get(transcriptKey(cid, pid, sid)) ?? null : null;
      emitMockFleet();
      return { ok: true, fleet: getMockFleet(), transcript };
    },
    "sessions.list": async (payload, scope) => {
      if (fixture) {
        return { sessions: currentFleet.sessions };
      }
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId;
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId;
      return {
        sessions: mockSessions.filter(
          (s) => (!cid || s.connectionId === cid) && (!pid || s.profileId === pid),
        ),
      };
    },
    "connections.retry": async (payload) => {
      e2eCounts.connectionsRetryCalls += 1;
      const cid = typeof payload.connectionId === "string" ? payload.connectionId : "local";
      if (fixture) {
        mockTurnGlobalOffline = false;
        const hit = currentFleet.connections.find((c) => c.connectionId === cid);
        if (hit) {
          currentFleet = {
            ...currentFleet,
            connections: currentFleet.connections.map((c) =>
              c.connectionId === cid
                ? {
                    ...c,
                    actual: "ready",
                    aggregateState: "ready",
                    degraded: false,
                    latencyMs: c.latencyMs ?? 12,
                    nextRetryAt: null,
                    profileExceptionCount: 0,
                    message: undefined,
                    errorCode: undefined,
                  }
                : c,
            ),
            profiles: currentFleet.profiles.map((p) =>
              p.connectionId === cid
                ? {
                    ...p,
                    actual: "ready",
                    degraded: false,
                    isException: false,
                    unavailableCode: undefined,
                    errorCode: undefined,
                    message: undefined,
                  }
                : p,
            ),
          };
          const liveFix = readE2EFixture() ?? fixture;
          for (const view of turnCoordinator.snapshot().sessions) {
            if (view.connectionId !== cid) continue;
            const storeKey = `${view.connectionId}::${view.profileId}::${view.sessionId}`;
            const rawQueue = (mockGatewayQueueStore.get(storeKey) ?? []).map((item) => {
              const st = String(item.state ?? item.status ?? "queued");
              if (st === "cancel_unknown" || st === "cancelling") {
                return {
                  ...item,
                  state: liveFix?.turnRecovery?.queueCancelReconcileOutcome ?? "cancelled",
                };
              }
              return item;
            });
            mockGatewayQueueStore.set(storeKey, rawQueue);
            const reconciled = turnCoordinator.reconcileFromResume({
              connectionId: view.connectionId,
              profileId: view.profileId,
              sessionId: view.sessionId,
              ownerGeneration: mockOwnerGen,
              activeTurnId: view.stopState === "cancel_outcome_unknown" ? null : view.activeTurnId,
              executionGeneration: view.executionGeneration,
              ...(view.unknownTurn
                ? {
                    unknownTurns: [
                      {
                        admissionId: view.unknownTurn.admissionId,
                        executionGeneration: view.unknownTurn.executionGeneration,
                        turnId: view.unknownTurn.turnId,
                        originalInput: view.unknownTurn.originalInput,
                        lostReason: view.unknownTurn.lostReason,
                        message: view.unknownTurn.message,
                      },
                    ],
                  }
                : {}),
              queuedAdmissions: rawQueue,
              ...(view.stopState === "cancel_outcome_unknown"
                ? { lastTurnOutcome: "stopped" as const }
                : {}),
            });
            if (view.stopState === "cancel_outcome_unknown") {
              const existingTx = lookupTranscript(
                transcriptMap,
                view.connectionId,
                view.profileId,
                view.sessionId,
              );
              if (existingTx) {
                const updatedTx: SessionTranscriptSnapshot = {
                  ...existingTx,
                  activeTurnId: null,
                  turnStopping: false,
                  executionGeneration: reconciled.executionGeneration,
                  stopState: reconciled.stopState,
                };
                transcriptMap.set(storeKey, updatedTx);
                emitTranscriptEvent(
                  {
                    connectionId: view.connectionId,
                    profileId: view.profileId,
                    sessionId: view.sessionId,
                  },
                  "patch",
                  {
                    type: "turn_state",
                    sessionId: view.sessionId,
                    activeTurnId: null,
                    turnStopping: false,
                    executionGeneration: reconciled.executionGeneration,
                    stopState: reconciled.stopState,
                    status: "stopped",
                  } satisfies TranscriptPatchPayload,
                );
              }
            }
          }
          emitFleetSnapshot();
          return {
            ok: true,
            fleet: currentFleet,
          };
        }
        return {
          ok: false,
          fleet: currentFleet,
          inspection: currentInspection,
          failure: currentInspection.failure,
        };
      }
      if (cid !== "local") {
        const hit = mockConnections.find((c) => c.connectionId === cid);
        if (hit) {
          hit.actual = "ready";
          hit.aggregateState = "ready";
          hit.degraded = false;
          hit.latencyMs = hit.latencyMs ?? 14;
          hit.nextRetryAt = null;
          hit.profileExceptionCount = 0;
          hit.message = undefined;
          hit.errorCode = undefined;
          emitMockFleet();
          return {
            ok: true,
            fleet: getMockFleet(),
          };
        }
      }
      return {
        ok: false,
        fleet: getMockFleet(),
        inspection: currentInspection,
        failure: currentInspection.failure,
      };
    },
    "sessions.create": async (payload, scope) => {
      e2eCounts.sessionsCreateCalls += 1;
      const liveFixture = readE2EFixture() ?? fixture;
      const draftId = typeof payload.draftId === "string" && payload.draftId ? payload.draftId : undefined;
      if (liveFixture?.failSessionCreate) {
        const err = new Error("session.create failed");
        (err as { code?: string }).code = "unavailable";
        throw err;
      }
      if (fixture) {
        const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
        const profileId =
          typeof payload.profileId === "string"
            ? payload.profileId
            : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
        const sessionId = `sess-${Date.now()}-${e2eCounts.sessionsCreateCalls}`;
        const title = typeof payload.title === "string" ? payload.title : "新对话";
        const created: SessionSummary = {
          connectionId,
          profileId,
          sessionId,
          title,
          preview: "",
          updatedAt: new Date().toISOString(),
          pinned: false,
          unreadCount: 0,
          needsInput: false,
          activeTurnId: null,
          status: "idle",
        };
        currentFleet = {
          ...currentFleet,
          sessions: [created, ...currentFleet.sessions],
          activeScope: { connectionId, profileId, sessionId },
          activeSessionId: sessionId,
        };
        const transcript = makeEmptyTranscript(connectionId, profileId, sessionId);
        transcriptMap.set(`${connectionId}::${profileId}::${sessionId}`, transcript);
        currentChatState = {
          ...currentChatState,
          lastActiveChat: { connectionId, profileId, sessionId },
          activeStatus: "ready",
          missingSession: null,
        };
        if (draftId) {
          migrateMockNewChatDraft(connectionId, profileId, draftId, sessionId);
        } else {
          emitChatStatePatch();
        }
        emitSessionsSnapshot();
        emitFleetSnapshot();
        approvalCoordinator.setActiveScope(currentFleet.activeScope);
        return { session: created, transcript, fleet: currentFleet };
      }

      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ?? mockActiveScope?.connectionId;
      if (!cid || !mockConnections.some((c) => c.connectionId === cid && c.actual === "ready")) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ?? mockActiveScope?.profileId ?? "default";
      const title =
        typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "新对话";
      const sessionId = `${cid}-sess-${Date.now()}`;
      const session: SessionSummary = {
        connectionId: cid,
        profileId: pid,
        sessionId,
        title,
        preview: "",
        updatedAt: new Date().toISOString(),
        pinned: false,
        unreadCount: 0,
        needsInput: false,
        activeTurnId: null,
        status: "idle",
      };
      mockSessions.unshift(session);
      const snapshot: SessionTranscriptSnapshot = {
        connectionId: cid,
        profileId: pid,
        sessionId,
        messages: [],
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
      };
      mockTranscripts.set(transcriptKey(cid, pid, sessionId), snapshot);
      mockActiveScope = { connectionId: cid, profileId: pid, sessionId };
      mockActiveSessionId = sessionId;
      approvalCoordinator.setActiveScope(mockActiveScope);
      if (draftId) {
        migrateMockNewChatDraft(cid, pid, draftId, sessionId);
      }
      emitMockFleet();
      return { session, transcript: snapshot, fleet: getMockFleet() };
    },
    "sessions.select": async (payload, scope) => {
      e2eCounts.sessionsSelectCalls += 1;
      if (fixture) {
        const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
        const profileId =
          typeof payload.profileId === "string"
            ? payload.profileId
            : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
        const requestedSessionId =
          typeof payload.sessionId === "string" ? payload.sessionId : scope?.sessionId;
        const targetSession =
          (requestedSessionId
            ? currentFleet.sessions.find(
                (s) => s.connectionId === connectionId && s.sessionId === requestedSessionId,
              )
            : currentFleet.sessions.find(
                (s) => s.connectionId === connectionId && s.profileId === profileId,
              )) ?? null;
        const nextSessionId = targetSession?.sessionId ?? requestedSessionId ?? null;
        currentFleet = {
          ...currentFleet,
          activeScope: {
            connectionId,
            profileId,
            ...(nextSessionId ? { sessionId: nextSessionId } : {}),
          },
          activeSessionId: nextSessionId,
        };
        const needsResync = nextSessionId
          ? isResyncRequired(connectionId, profileId, nextSessionId)
          : false;
        const transcript =
          nextSessionId && !needsResync
            ? lookupTranscript(transcriptMap, connectionId, profileId, nextSessionId) ??
              makeEmptyTranscript(connectionId, profileId, nextSessionId)
            : null;
        currentChatState = {
          ...currentChatState,
          lastActiveChat: {
            connectionId,
            profileId,
            ...(nextSessionId ? { sessionId: nextSessionId } : {}),
          },
          activeStatus: nextSessionId ? "ready" : "empty",
          missingSession: null,
        };
        emitFleetSnapshot();
        emitChatStatePatch();
        approvalCoordinator.setActiveScope(currentFleet.activeScope);
        return {
          transcript,
          fleet: currentFleet,
          ...(needsResync ? { resyncRequired: true } : {}),
        };
      }

      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ?? mockActiveScope?.connectionId;
      if (!cid || !mockConnections.some((c) => c.connectionId === cid && c.actual === "ready")) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
      const profs = mockProfiles.filter((p) => p.connectionId === cid);
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ?? profs[0]?.profileId ?? "default";
      const candidates = mockSessions.filter((s) => s.connectionId === cid && s.profileId === pid);
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? candidates[0]?.sessionId ?? null;
      mockActiveScope = { connectionId: cid, profileId: pid, ...(sid ? { sessionId: sid } : {}) };
      mockActiveSessionId = sid;
      approvalCoordinator.setActiveScope(mockActiveScope);
      const transcript = sid ? mockTranscripts.get(transcriptKey(cid, pid, sid)) ?? null : null;
      emitMockFleet();
      return { fleet: getMockFleet(), transcript };
    },
    "sessions.resume": async (payload, scope) => {
      e2eCounts.sessionsResumeCalls += 1;
      if (fixture) {
        const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
        const profileId =
          typeof payload.profileId === "string"
            ? payload.profileId
            : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
        const sessionId =
          typeof payload.sessionId === "string"
            ? payload.sessionId
            : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
        const resync = Boolean(payload.resync || payload.replace);
        const baseTranscript =
          (resync
            ? lookupTranscript(resyncedTranscriptMap, connectionId, profileId, sessionId)
            : undefined) ??
          lookupTranscript(transcriptMap, connectionId, profileId, sessionId) ??
          makeEmptyTranscript(connectionId, profileId, sessionId);
        const transcript: SessionTranscriptSnapshot = {
          ...baseTranscript,
          snapshotSeq: 0,
          ...(resync ? { resynced: true } : {}),
        };
        clearResyncRequired(connectionId, profileId, sessionId);
        transcriptMap.set(`${connectionId}::${profileId}::${sessionId}`, transcript);
        return { transcript };
      }

      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ?? mockActiveScope?.connectionId;
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ?? mockActiveScope?.profileId ?? "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? mockActiveSessionId;
      if (!cid || !sid || !mockConnections.some((c) => c.connectionId === cid && c.actual === "ready")) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
      return {
        transcript: mockTranscripts.get(transcriptKey(cid, pid, sid)) ?? null,
      };
    },
    "sessions.markRead": async (payload, scope) => {
      e2eCounts.sessionsMarkReadCalls += 1;
      if (fixture) {
        const connectionId =
          typeof payload.connectionId === "string" && payload.connectionId
            ? payload.connectionId
            : scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
        const profileId =
          typeof payload.profileId === "string" && payload.profileId
            ? payload.profileId
            : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
        const sessionId =
          typeof payload.sessionId === "string" && payload.sessionId
            ? payload.sessionId
            : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
        if (!sessionId) {
          const err = new Error("Missing target sessionId");
          (err as { code?: string }).code = "invalid_request";
          throw err;
        }
        currentFleet = {
          ...currentFleet,
          sessions: currentFleet.sessions.map((s) => {
            if (
              s.connectionId !== connectionId ||
              s.profileId !== profileId ||
              s.sessionId !== sessionId
            ) {
              return s;
            }
            const nextPinnedReasons = {
              ...(s.pinnedReasons ?? {}),
              runningTurn: s.status === "running" || Boolean(s.activeTurnId),
              pendingInput: s.needsInput,
              unread: false,
              queuedAdmission: s.queuedAdmission,
            };
            return {
              ...s,
              unreadCount: 0,
              lastReadSeq: s.progressSeq ?? s.lastReadSeq,
              pinnedReasons: nextPinnedReasons,
              pinned: computeSessionPinned(nextPinnedReasons, 0),
            };
          }),
        };
        emitSessionsSnapshot();
        emitFleetSnapshot();
        return { ok: true, connectionId, profileId, sessionId, unreadCount: 0 };
      }

      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ?? mockActiveScope?.connectionId ?? "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ?? mockActiveScope?.profileId ?? "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? mockActiveSessionId ?? "";
      if (!sid) {
        const err = new Error("Missing target sessionId");
        (err as { code?: string }).code = "invalid_request";
        throw err;
      }
      for (let i = 0; i < mockSessions.length; i += 1) {
        const s = mockSessions[i];
        if (s.connectionId === cid && s.profileId === pid && s.sessionId === sid) {
          const nextPinnedReasons = {
            ...(s.pinnedReasons ?? {}),
            runningTurn: s.status === "running" || Boolean(s.activeTurnId),
            pendingInput: s.needsInput,
            unread: false,
            queuedAdmission: s.queuedAdmission,
          };
          mockSessions[i] = {
            ...s,
            unreadCount: 0,
            pinnedReasons: nextPinnedReasons,
            pinned: computeSessionPinned(nextPinnedReasons, 0),
          };
        }
      }
      emitMockFleet();
      return { ok: true, connectionId: cid, profileId: pid, sessionId: sid, unreadCount: 0 };
    },
    "app.setFocused": async (payload) => {
      mockWindowFocused = Boolean(payload.focused);
      return { ok: true, focused: mockWindowFocused };
    },
    "chatState.get": async () => currentChatState,
    "chatState.dismissRouteBanner": async () => {
      currentChatState = {
        ...currentChatState,
        routeBanner: null,
      };
      emitChatStatePatch();
      return currentChatState;
    },
    "chatState.saveDraft": async (payload, scope) => {
      const connectionId =
        scope?.connectionId ??
        currentFleet.activeScope?.connectionId ??
        mockActiveScope?.connectionId ??
        "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ??
            currentFleet.activeScope?.profileId ??
            mockActiveScope?.profileId ??
            "default";
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId;
      const requestedDraftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      const key = sessionId
        ? makeActiveChatDraftKey(connectionId, profileId, sessionId)
        : makeNewChatDraftKey(connectionId, profileId, requestedDraftId ?? makeMockDraftId());
      const existing = currentChatState.draftsByKey?.[key];
      const existingSummary = sessionId
        ? currentChatState.sessionSummaries[`${connectionId}::${profileId}::${sessionId}`]
        : undefined;
      const draftId = existing?.draftId ?? requestedDraftId ?? makeMockDraftId();
      const nextText =
        typeof payload.text === "string"
          ? payload.text
          : existing?.text ?? existingSummary?.draftText ?? "";
      const nextAttachments = Array.isArray(payload.attachments)
        ? sanitizeMockAttachments(payload.attachments)
        : existing?.attachments ?? [];
      const nextContexts = Array.isArray(payload.contexts)
        ? sanitizeMockContexts(payload.contexts)
        : existing?.contexts ?? [];
      const nextComposer = sanitizeMockComposer(payload.composer, existing?.composer);
      const nextAnnotations = Array.isArray(payload.annotations)
        ? (payload.annotations as ArtifactAnnotation[])
        : existing?.annotations ?? existingSummary?.annotations;
      const candidate: DraftRecord = {
        draftId,
        ...(sessionId ? { sessionId } : {}),
        scope: { connectionId, profileId },
        text: nextText,
        attachments: nextAttachments,
        contexts: nextContexts,
        ...(nextAnnotations && nextAnnotations.length > 0 ? { annotations: nextAnnotations } : {}),
        composer: nextComposer,
        updatedAt: new Date().toISOString(),
        revision: (existing?.revision ?? 0) + 1,
        origin: resolveMockDraftOrigin(
          connectionId,
          profileId,
          sessionId,
          payload.origin && typeof payload.origin === "object"
            ? (payload.origin as Partial<DraftOrigin>)
            : existing?.origin,
        ),
        ...(typeof payload.deliveryStatus === "string"
          ? { deliveryStatus: payload.deliveryStatus as DraftDeliveryStatus }
          : existing?.deliveryStatus
            ? { deliveryStatus: existing.deliveryStatus }
            : {}),
      };

      const draftsByKey = { ...(currentChatState.draftsByKey ?? {}) };
      if (isDraftRecordEmpty(candidate)) {
        delete draftsByKey[key];
      } else {
        const capacity = checkDraftCapacity(
          candidate,
          draftsByKey,
          key,
          currentChatState.orphanedDrafts ?? [],
        );
        if (!capacity.ok) {
          const err = new Error(
            capacity.reason === "over_single_limit"
              ? getCopy("draft.capacityExceededSingle")
              : getCopy("draft.capacityExceededTotal"),
          );
          (err as { code?: ErrorCode }).code = "invalid_request";
          throw err;
        }
        draftsByKey[key] = candidate;
      }

      currentChatState = recomputeMockDraftState({
        ...currentChatState,
        draftsByKey,
      });
      emitChatStatePatch();
      return currentChatState;
    },
    "chatState.clearDraft": async (payload, scope) => {
      const connectionId =
        scope?.connectionId ??
        currentFleet.activeScope?.connectionId ??
        mockActiveScope?.connectionId ??
        "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ??
            currentFleet.activeScope?.profileId ??
            mockActiveScope?.profileId ??
            "default";
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId;
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      const key = sessionId
        ? makeActiveChatDraftKey(connectionId, profileId, sessionId)
        : draftId
          ? makeNewChatDraftKey(connectionId, profileId, draftId)
          : undefined;
      if (key && currentChatState.draftsByKey?.[key]) {
        const draftsByKey = { ...(currentChatState.draftsByKey ?? {}) };
        delete draftsByKey[key];
        currentChatState = recomputeMockDraftState({
          ...currentChatState,
          draftsByKey,
        });
        emitChatStatePatch();
      }
      return currentChatState;
    },
    "chatState.markAttachmentExpired": async (payload, scope) => {
      const connectionId =
        scope?.connectionId ??
        currentFleet.activeScope?.connectionId ??
        mockActiveScope?.connectionId ??
        "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ??
            currentFleet.activeScope?.profileId ??
            mockActiveScope?.profileId ??
            "default";
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId;
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      const handle = typeof payload.handle === "string" ? payload.handle : "";
      const key = sessionId
        ? makeActiveChatDraftKey(connectionId, profileId, sessionId)
        : draftId
          ? makeNewChatDraftKey(connectionId, profileId, draftId)
          : undefined;
      const existing = key ? currentChatState.draftsByKey?.[key] : undefined;
      if (key && existing && handle) {
        const draftsByKey = {
          ...(currentChatState.draftsByKey ?? {}),
          [key]: {
            ...existing,
            attachments: existing.attachments.map((att) =>
              att.handle === handle ? { ...att, expired: true } : att,
            ),
            revision: existing.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        };
        currentChatState = recomputeMockDraftState({
          ...currentChatState,
          draftsByKey,
        });
        emitChatStatePatch();
      }
      return currentChatState;
    },
    "chatState.deleteOrphanedDraft": async (payload) => {
      const orphanId =
        typeof payload.orphanedId === "string"
          ? payload.orphanedId
          : typeof payload.orphanId === "string"
            ? payload.orphanId
            : "";
      if (
        orphanId &&
        (currentChatState.orphanedDrafts ?? []).some((o) => o.orphanedId === orphanId)
      ) {
        currentChatState = recomputeMockDraftState({
          ...currentChatState,
          orphanedDrafts: (currentChatState.orphanedDrafts ?? []).filter(
            (o) => o.orphanedId !== orphanId,
          ),
        });
        emitChatStatePatch();
      }
      return currentChatState;
    },
    "chatState.exportOrphanedDraft": async (payload): Promise<DraftExportBundle> => {
      const orphanId =
        typeof payload.orphanedId === "string"
          ? payload.orphanedId
          : typeof payload.orphanId === "string"
            ? payload.orphanId
            : "";
      const hit = (currentChatState.orphanedDrafts ?? []).find((o) => o.orphanedId === orphanId);
      if (!hit) {
        const err = new Error(`Orphaned draft not found: ${orphanId}`);
        (err as { code?: ErrorCode }).code = "not_found";
        throw err;
      }
      return buildOrphanedDraftExport(hit, new Date().toISOString());
    },
    "artifacts.list": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const fullKey = `${connectionId}::${profileId}::${sessionId}`;
      const map = liveFixture?.artifacts ?? {};
      const list = map[fullKey] ?? (sessionId ? map[sessionId] : undefined) ?? [];
      const staleMap = liveFixture?.artifactsStale ?? {};
      const stale = Boolean(staleMap[fullKey] ?? (sessionId ? staleMap[sessionId] : false));
      const agentsMap = liveFixture?.agents ?? {};
      const agents = agentsMap[fullKey] ?? (sessionId ? agentsMap[sessionId] : undefined) ?? [];
      return {
        artifacts: list.map((item) => ({ ...item, ...(stale ? { stale: true } : {}) })),
        stale,
        agents,
      };
    },
    "artifacts.read": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : "";
      const fullKey = `${connectionId}::${profileId}::${sessionId}`;
      const map = liveFixture?.artifacts ?? {};
      const list = map[fullKey] ?? (sessionId ? map[sessionId] : undefined) ?? [];
      const found = list.find((item) => item.artifactId === artifactId) ?? null;
      return { artifact: found ? { ...found } : null };
    },
    "files.list": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const scopeKey = `${connectionId}::${profileId}`;
      const map = liveFixture?.files ?? {};
      const list = map[scopeKey] ?? map[connectionId] ?? [];
      const staleMap = liveFixture?.filesStale ?? {};
      const stale = Boolean(staleMap[scopeKey] ?? staleMap[connectionId] ?? false);
      const gitMap = liveFixture?.gitDiffs ?? {};
      const gitDiffs = gitMap[scopeKey] ?? gitMap[connectionId] ?? [];
      return {
        files: list.map((item) => ({ ...item, ...(stale ? { stale: true } : {}) })),
        stale,
        gitDiffs,
      };
    },
    "files.read": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const relativePath = typeof payload.relativePath === "string" ? payload.relativePath : "";
      const scopeKey = `${connectionId}::${profileId}`;
      const map = liveFixture?.files ?? {};
      const list = map[scopeKey] ?? map[connectionId] ?? [];
      const found = list.find((item) => item.relativePath === relativePath) ?? null;
      return { file: found ? { ...found } : null };
    },
    "subagents.list": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const fullKey = `${connectionId}::${profileId}::${sessionId}`;
      const agentsMap = liveFixture?.agents ?? {};
      const configuredAgents =
        agentsMap[fullKey] ?? (sessionId ? agentsMap[sessionId] : undefined) ?? [];
      if (configuredAgents.length > 0 && !lastKnownMockSubagents.has(fullKey)) {
        lastKnownMockSubagents.set(
          fullKey,
          configuredAgents.map((a) => ({ ...a })),
        );
      }

      const notFoundList = liveFixture?.subagentNotFoundMethods ?? [];
      if (notFoundList.includes("subagent.list") || notFoundList.includes("subagents.list")) {
        capabilityRegistry.markMethodNotFound({
          method: "subagent.list",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        capabilityRegistry.markMethodNotFound({
          method: "subagent.steer",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        capabilityRegistry.markMethodNotFound({
          method: "subagent.interrupt",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        emitCapabilitiesPatch();
        const fallback = (
          lastKnownMockSubagents.get(fullKey) ??
          configuredAgents
        ).map((a) => ({ ...a, lastKnown: true }));
        return {
          agents: fallback,
          readOnly: true,
          lastKnown: true,
          generation: capabilityRegistry.getSnapshot().generation,
        };
      }

      const customErr = liveFixture?.subagentErrorByAction?.["subagents.list"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }

      const list = configuredAgents.map((a) => ({ ...a }));
      lastKnownMockSubagents.set(fullKey, list);
      const snap = capabilityRegistry.getSnapshot();
      const steerEntry = snap.entries.find((e) => e.actionId === "subagents.steer");
      const interruptEntry = snap.entries.find((e) => e.actionId === "subagents.interrupt");
      const readOnly =
        (!steerEntry || steerEntry.runtimeStatus === "unavailable") &&
        (!interruptEntry || interruptEntry.runtimeStatus === "unavailable");
      return {
        agents: list,
        readOnly,
        lastKnown: false,
        generation: snap.generation,
      };
    },
    "subagents.tail": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      if (!sessionId || !agentId) {
        const err = new Error("未选择要查看 Tail 的 Subagent");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const notFoundList = liveFixture?.subagentNotFoundMethods ?? [];
      if (notFoundList.includes("subagent.tail") || notFoundList.includes("subagents.tail")) {
        capabilityRegistry.markMethodNotFound({
          method: "subagent.tail",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        emitCapabilitiesPatch();
        const err = new Error("当前 Gateway 未提供 Subagent Tail 能力");
        (err as { code?: ErrorCode }).code = "capability_unavailable";
        throw err;
      }
      const customErr = liveFixture?.subagentErrorByAction?.["subagents.tail"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }
      const fullKey = `${connectionId}::${profileId}::${sessionId}::${agentId}`;
      const sessionAgentKey = `${sessionId}::${agentId}`;
      const tailMap = liveFixture?.subagentTails ?? {};
      const rawLines = tailMap[fullKey] ?? tailMap[sessionAgentKey] ?? tailMap[agentId] ?? [];
      const bounded = boundSubagentTailLines(rawLines);
      const tail: SubagentTailSnapshot = {
        agentId,
        lines: bounded.lines,
        truncated: bounded.truncated,
        generation: capabilityRegistry.getSnapshot().generation,
        updatedAt: new Date().toISOString(),
      };
      return { tail };
    },
    "subagents.steer": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !agentId || !text) {
        const err = new Error("请输入针对该 Subagent 的补充指令");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const notFoundList = liveFixture?.subagentNotFoundMethods ?? [];
      if (notFoundList.includes("subagent.steer") || notFoundList.includes("subagents.steer")) {
        capabilityRegistry.markMethodNotFound({
          method: "subagent.steer",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        emitCapabilitiesPatch();
        const err = new Error("当前 Gateway 不支持 Subagent 补充指令");
        (err as { code?: ErrorCode }).code = "capability_unavailable";
        throw err;
      }
      const customErr = liveFixture?.subagentErrorByAction?.["subagents.steer"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }
      return {
        steered: true,
        agentId,
      };
    },
    "subagents.interrupt": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      if (!sessionId || !agentId) {
        const err = new Error("未选择要停止的 Subagent");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const notFoundList = liveFixture?.subagentNotFoundMethods ?? [];
      if (
        notFoundList.includes("subagent.interrupt") ||
        notFoundList.includes("subagents.interrupt")
      ) {
        capabilityRegistry.markMethodNotFound({
          method: "subagent.interrupt",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        emitCapabilitiesPatch();
        const err = new Error("当前 Gateway 不支持停止 Subagent");
        (err as { code?: ErrorCode }).code = "capability_unavailable";
        throw err;
      }
      const customErr = liveFixture?.subagentErrorByAction?.["subagents.interrupt"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }
      const fullKey = `${connectionId}::${profileId}::${sessionId}`;
      const agentsMap = liveFixture?.agents ?? {};
      const list = agentsMap[fullKey] ?? (sessionId ? agentsMap[sessionId] : undefined);
      if (list) {
        for (const a of list) {
          if (a.agentId === agentId) {
            a.status = "stopped";
          }
        }
      }
      const cached = lastKnownMockSubagents.get(fullKey);
      if (cached) {
        lastKnownMockSubagents.set(
          fullKey,
          cached.map((a) => (a.agentId === agentId ? { ...a, status: "stopped" } : a)),
        );
      }
      return {
        interrupted: true,
        agentId,
        status: "stopped" as const,
      };
    },
    "checkpoints.list": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const fullKey = `${connectionId}::${profileId}::${sessionId}`;
      const ckptMap = liveFixture?.checkpoints ?? {};
      const checkpoints = (
        ckptMap[fullKey] ??
        (sessionId ? ckptMap[sessionId] : undefined) ??
        []
      ).map((c) => ({ ...c }));
      const notFoundList = liveFixture?.checkpointNotFoundMethods ?? [];
      if (
        notFoundList.includes("rollback.restore") ||
        notFoundList.includes("checkpoint.restore")
      ) {
        capabilityRegistry.markMethodNotFound({
          method: "rollback.restore",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        emitCapabilitiesPatch();
      }
      const customErr = liveFixture?.checkpointErrorByAction?.["checkpoints.list"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }
      const snap = capabilityRegistry.getSnapshot();
      const restoreEntry = snap.entries.find((e) => e.actionId === "checkpoint.restore");
      const canRestore = Boolean(restoreEntry && restoreEntry.runtimeStatus !== "unavailable");
      return {
        checkpoints,
        canRestore,
        generation: snap.generation,
      };
    },
    "checkpoints.diff": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
      const checkpointId =
        typeof payload.checkpointId === "string" ? payload.checkpointId.trim() : "";
      if (!sessionId || !checkpointId) {
        const err = new Error("未选择要对比的 Checkpoint");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const customErr = liveFixture?.checkpointErrorByAction?.["checkpoints.diff"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }
      const diffMap = (liveFixture?.checkpointDiffs ?? {}) as Record<
        string,
        CheckpointDiffSnapshot | string
      >;
      const rawDiff = diffMap[`${sessionId}::${checkpointId}`] ?? diffMap[checkpointId];
      const diff: CheckpointDiffSnapshot =
        typeof rawDiff === "string"
          ? {
              checkpointId,
              summary: "Checkpoint 差异摘要",
              patch: rawDiff,
              filesChanged: 1,
            }
          : (rawDiff ?? {
              checkpointId,
              summary: "Checkpoint 差异摘要",
              patch: "",
              filesChanged: 0,
            });
      return { diff: { ...diff } };
    },
    "checkpoints.restore": async (payload, scope) => {
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      if (payload.confirmed !== true) {
        const err = new Error("恢复 Checkpoint 需要显式确认");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const snap = capabilityRegistry.getSnapshot();
      const restoreEntry = snap.entries.find((e) => e.actionId === "checkpoint.restore");
      const notFoundList = liveFixture?.checkpointNotFoundMethods ?? [];
      if (
        !restoreEntry ||
        restoreEntry.runtimeStatus === "unavailable" ||
        notFoundList.includes("rollback.restore") ||
        notFoundList.includes("checkpoint.restore")
      ) {
        capabilityRegistry.markMethodNotFound({
          method: "rollback.restore",
          expectedOwnerGeneration: mockOwnerGen,
          expectedAuthorityEpoch: 1,
        });
        emitCapabilitiesPatch();
        const err = new Error(
          "当前 Gateway 未提供 rollback.restore 能力，仅支持只读浏览与 Diff 对比",
        );
        (err as { code?: ErrorCode }).code = "capability_unavailable";
        throw err;
      }

      const checkpointId =
        typeof payload.checkpointId === "string" ? payload.checkpointId.trim() : "";
      const boundConnectionId =
        typeof payload.connectionId === "string"
          ? payload.connectionId.trim()
          : (scope?.connectionId ?? "");
      const boundProfileId =
        typeof payload.profileId === "string"
          ? payload.profileId.trim()
          : (scope?.profileId ?? "default");
      const boundSessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId.trim()
          : (scope?.sessionId ?? "");
      const boundGeneration =
        typeof payload.generation === "number" ? payload.generation : -1;

      const activeConnectionId =
        currentFleet.activeScope?.connectionId ?? scope?.connectionId ?? "local";
      const activeProfileId =
        currentFleet.activeScope?.profileId ?? scope?.profileId ?? "default";
      const activeSessionId =
        currentFleet.activeSessionId ??
        currentFleet.activeScope?.sessionId ??
        scope?.sessionId ??
        "";

      const check = validateCheckpointRestoreBinding(
        {
          connectionId: boundConnectionId,
          profileId: boundProfileId,
          sessionId: boundSessionId,
          checkpointId,
          generation: boundGeneration,
        },
        {
          connectionId: activeConnectionId,
          profileId: activeProfileId,
          sessionId: activeSessionId,
        },
        snap.generation,
      );
      if (!check.valid) {
        const err = new Error(check.message);
        (err as { code?: ErrorCode }).code = check.code;
        throw err;
      }

      const customErr = liveFixture?.checkpointErrorByAction?.["checkpoints.restore"];
      if (customErr) {
        const err = new Error(customErr.message);
        (err as { code?: ErrorCode }).code = customErr.code;
        throw err;
      }

      return {
        restored: true,
        checkpointId,
        sessionId: activeSessionId,
      };
    },
    "chatState.exportMissingSession": async (): Promise<MissingSessionExport | null> => {
      if (!currentChatState.missingSession) return null;
      const m = currentChatState.missingSession;
      const key = makeActiveChatDraftKey(m.connectionId, m.profileId, m.sessionId);
      const draft = currentChatState.draftsByKey?.[key];
      orphanMockDraftsMatching(
        (k) => k === key,
        "session_missing_exported",
      );
      return {
        exportedAt: "2026-11-23T07:00:00.000Z",
        windowId: "primary",
        paneId: "main",
        scope: {
          connectionId: m.connectionId,
          profileId: m.profileId,
          sessionId: m.sessionId,
        },
        sessionTitle: m.title,
        draftText: draft?.text ?? m.draftText ?? "",
        ...(draft?.attachments.length ? { attachments: draft.attachments } : {}),
        ...(draft?.contexts.length ? { contexts: draft.contexts } : {}),
        messages: m.lastKnownMessages ?? [],
      };
    },
    "chatState.dismissMissingSession": async () => {
      const m = currentChatState.missingSession;
      if (m) {
        const key = makeActiveChatDraftKey(m.connectionId, m.profileId, m.sessionId);
        orphanMockDraftsMatching(
          (k) => k === key,
          "session_missing_closed",
        );
      }
      const fallback = currentFleet.sessions[0] ?? null;
      currentFleet = {
        ...currentFleet,
        activeScope: fallback
          ? {
              connectionId: fallback.connectionId,
              profileId: fallback.profileId,
              sessionId: fallback.sessionId,
            }
          : currentFleet.activeScope,
        activeSessionId: fallback ? fallback.sessionId : null,
      };
      currentChatState = {
        ...currentChatState,
        lastActiveChat: fallback
          ? {
              connectionId: fallback.connectionId,
              profileId: fallback.profileId,
              sessionId: fallback.sessionId,
            }
          : null,
        activeStatus: fallback ? "ready" : "empty",
        missingSession: null,
      };
      emitFleetSnapshot();
      emitChatStatePatch();
      return currentChatState;
    },
    "prompts.send": async (payload, scope) => {
      e2eCounts.promptsSendCalls += 1;
      const liveFixture = readE2EFixture() ?? fixture;
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      if (fixture) {
        const cid =
          typeof payload.connectionId === "string" && payload.connectionId
            ? payload.connectionId
            : scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "";
        const pid =
          typeof payload.profileId === "string" && payload.profileId
            ? payload.profileId
            : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
        const sid =
          typeof payload.sessionId === "string" && payload.sessionId
            ? payload.sessionId
            : scope?.sessionId ?? currentFleet.activeSessionId ?? "";
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        const connReady = currentFleet.connections.some(
          (c) => c.connectionId === cid && c.actual === "ready",
        );
        if (!cid || !sid || !connReady) {
          const err = new Error("Not connected to Gateway");
          (err as { code?: string }).code = "unreachable";
          throw err;
        }
        if (liveFixture?.failPromptSend) {
          markMockDraftDeliveryStatus(cid, pid, sid, draftId, "delivery_unknown");
          const err = new Error("Delivery status unknown");
          (err as { code?: string }).code = "gateway_error";
          throw err;
        }
        const receiptMode = liveFixture?.promptReceiptMode ?? "accepted";
        if (receiptMode === "delivery_unknown") {
          markMockDraftDeliveryStatus(cid, pid, sid, draftId, "delivery_unknown");
          return {
            accepted: false,
            deliveryUnknown: true,
            receipt: "delivery_unknown",
            receiptStatus: "delivery_unknown",
            connectionId: cid,
            profileId: pid,
            sessionId: sid,
          };
        }

        const now = new Date().toISOString();
        const turnId = `mock-turn-${Date.now()}`;
        const txKey = `${cid}::${pid}::${sid}`;
        const baseTx =
          lookupTranscript(transcriptMap, cid, pid, sid) ??
          makeEmptyTranscript(cid, pid, sid);
        const userMsg = {
          messageId: `mock-u-${Date.now()}`,
          sessionId: sid,
          role: "user" as const,
          text,
          createdAt: now,
          status: "complete" as const,
        };
        const assistantMsg = {
          messageId: `mock-a-${Date.now() + 1}`,
          sessionId: sid,
          role: "assistant" as const,
          text: `Mock Gateway (${cid}) received: ${text}`,
          createdAt: now,
          turnId,
          streaming: false,
          status: "complete" as const,
        };
        const nextTx: SessionTranscriptSnapshot = {
          ...baseTx,
          messages: [...baseTx.messages, userMsg, assistantMsg],
        };
        transcriptMap.set(txKey, nextTx);
        emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
          type: "message_upsert",
          sessionId: sid,
          message: userMsg,
        });
        emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
          type: "message_upsert",
          sessionId: sid,
          message: assistantMsg,
        });
        clearMockDraftOnReceipt(cid, pid, sid, draftId, receiptMode);
        return {
          accepted: receiptMode === "accepted",
          admitted: receiptMode === "admitted",
          receipt: receiptMode,
          receiptStatus: receiptMode,
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          turnId,
        };
      }

      const liveFix = liveFixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            (fixture ? "local" : undefined);
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const online = fixture
        ? Boolean(
            cid &&
              sid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              sid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      if (!online || !cid || !sid) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: ErrorCode }).code = "unreachable";
        throw err;
      }
      const existingRec = turnCoordinator.getSessionView({
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
      });
      if (existingRec?.queuePaused || existingRec?.unknownTurn) {
        const err = new Error(getCopy("turn.queue.pausedNotice"));
        (err as { code?: ErrorCode }).code = "conflict";
        throw err;
      }
      if (payload.queued === true) {
        e2eCounts.promptsQueueCalls += 1;
        const subId =
          typeof payload.submissionId === "string" && payload.submissionId.trim()
            ? payload.submissionId.trim()
            : undefined;
        return await turnCoordinator.submitQueued(
          {
            connectionId: cid,
            profileId: pid,
            sessionId: sid,
            text,
            online: true,
            ...(subId ? { submissionId: subId } : {}),
          },
          async (rpcPayload) => {
            e2eCounts.queueSubmittedIds.push(rpcPayload.submission_id);
            const attempt = (mockQueueAttemptBySubId.get(rpcPayload.submission_id) ?? 0) + 1;
            mockQueueAttemptBySubId.set(rpcPayload.submission_id, attempt);
            const ackMode = liveFix?.turnRecovery?.queueAckMode ?? "admitted";
            const storeKey = `${cid}::${pid}::${sid}`;
            const currentQueue = mockGatewayQueueStore.get(storeKey) ?? [];
            if (attempt === 1 && ackMode === "ack_loss_already_admitted") {
              mockQueueAdmissionSeq += 1;
              const admId = `adm-srv-${mockQueueAdmissionSeq}`;
              currentQueue.push({
                admission_id: admId,
                submission_id: rpcPayload.submission_id,
                text: rpcPayload.text,
                position: currentQueue.length + 1,
                state: "queued",
              });
              mockGatewayQueueStore.set(storeKey, currentQueue);
              const err = new Error("Queue submit ACK timeout");
              err.name = "GatewayTransportError";
              (err as { code?: ErrorCode }).code = "timeout";
              throw err;
            }
            if (
              (attempt === 1 && ackMode === "ack_loss_unadmitted") ||
              ackMode === "ack_loss"
            ) {
              const err = new Error("Queue submit ACK timeout");
              err.name = "GatewayTransportError";
              (err as { code?: ErrorCode }).code = "timeout";
              throw err;
            }
            mockQueueAdmissionSeq += 1;
            const admId = `adm-srv-${mockQueueAdmissionSeq}`;
            const pos = currentQueue.length + 1;
            currentQueue.push({
              admission_id: admId,
              submission_id: rpcPayload.submission_id,
              text: rpcPayload.text,
              position: pos,
              state: "queued",
            });
            mockGatewayQueueStore.set(storeKey, currentQueue);
            return {
              admitted: true,
              admission_id: admId,
              position: pos,
              status: "queued",
            };
          },
        );
      }

      const key = transcriptKey(cid, pid, sid);
      const tx = fixture
        ? lookupTranscript(transcriptMap, cid, pid, sid) ?? makeEmptyTranscript(cid, pid, sid)
        : mockTranscripts.get(key);
      const now = new Date().toISOString();
      mockTurnSeq += 1;
      const turnId = `mock-turn-${mockTurnSeq}`;
      const recovery = turnCoordinator.noteTurnStarted({
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
        turnId,
        ownerGeneration: mockOwnerGen,
      });
      const userMsgId = `mock-u-${Date.now()}-${mockTurnSeq}`;
      const assistantMsgId = `mock-a-${Date.now()}-${mockTurnSeq}`;
      const keepRunning = Boolean(liveFix?.turnRecovery?.keepSendRunning);
      const userMsg = {
        messageId: userMsgId,
        sessionId: sid,
        role: "user" as const,
        text,
        createdAt: now,
        turnId,
        status: "complete" as const,
      };
      const assistantMsg = {
        messageId: assistantMsgId,
        sessionId: sid,
        role: "assistant" as const,
        text: keepRunning ? "" : `Mock Gateway (${cid}) received: ${text}`,
        createdAt: now,
        turnId,
        streaming: keepRunning,
        status: keepRunning ? ("streaming" as const) : ("complete" as const),
      };
      if (tx) {
        const nextTx: SessionTranscriptSnapshot = {
          ...tx,
          messages: [...tx.messages, userMsg, assistantMsg],
          activeTurnId: keepRunning ? turnId : null,
          turnStopping: false,
          executionGeneration: recovery.executionGeneration,
          stopState: "idle",
        };
        if (fixture) {
          transcriptMap.set(key, nextTx);
        } else {
          tx.messages.push(userMsg, assistantMsg);
          tx.activeTurnId = keepRunning ? turnId : null;
          tx.executionGeneration = recovery.executionGeneration;
        }
        emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
          type: "message_upsert",
          sessionId: sid,
          message: userMsg,
        });
        emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
          type: "message_upsert",
          sessionId: sid,
          message: assistantMsg,
        });
        emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
          type: "turn_state",
          sessionId: sid,
          activeTurnId: keepRunning ? turnId : null,
          turnStopping: false,
          executionGeneration: recovery.executionGeneration,
          stopState: "idle",
        } satisfies TranscriptPatchPayload);
      }
      if (!keepRunning) {
        turnCoordinator.noteTurnTerminal({
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          turnId,
          executionGeneration: recovery.executionGeneration,
          outcome: "completed",
        });
      }
      clearMockDraftOnReceipt(cid, pid, sid, draftId, "accepted");
      return {
        accepted: true,
        receiptStatus: "accepted",
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
        turnId,
        executionGeneration: recovery.executionGeneration,
      };
    },
    "prompts.stop": async (payload, scope) => {
      e2eCounts.promptsStopCalls += 1;
      e2eCounts.stopPayloads.push({
        ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
        ...(typeof payload.executionGeneration === "number"
          ? { executionGeneration: payload.executionGeneration }
          : {}),
      });
      const liveFix = readE2EFixture() ?? fixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            (fixture ? "local" : undefined);
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId);
      const online = fixture
        ? Boolean(
            cid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      const existingView =
        cid && sid
          ? turnCoordinator.getSessionView({ connectionId: cid, profileId: pid, sessionId: sid })
          : null;
      const existingTx =
        cid && sid
          ? fixture
            ? lookupTranscript(transcriptMap, cid, pid, sid)
            : mockTranscripts.get(transcriptKey(cid, pid, sid))
          : null;
      const turnId =
        typeof payload.turnId === "string" && payload.turnId.trim()
          ? payload.turnId.trim()
          : existingView?.activeTurnId ?? existingTx?.activeTurnId ?? "";

      if (!online && !turnId) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: ErrorCode }).code = "unreachable";
        throw err;
      }
      if (!cid || !sid || !turnId) {
        const err = new Error("当前没有可停止的 Turn");
        (err as { code?: ErrorCode }).code = "unknown_turn";
        throw err;
      }
      const execGen =
        typeof payload.executionGeneration === "number"
          ? payload.executionGeneration
          : existingView?.executionGeneration ?? existingTx?.executionGeneration;

      const stopMode = liveFix?.turnRecovery?.stopMode ?? "ack_stopping";
      const result = await turnCoordinator.requestStop(
        {
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          turnId,
          ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
        },
        async ({ executionGeneration: g }) => {
          if (!online || stopMode === "ack_loss") {
            const err = new Error("Interrupt ACK lost");
            err.name = "GatewayTransportError";
            (err as { code?: ErrorCode }).code = online ? "timeout" : "unreachable";
            throw err;
          }
          if (stopMode === "owner_changed") {
            mockOwnerGen += 1;
            turnCoordinator.onOwnerGenerationChanged(cid, mockOwnerGen);
            return { status: "stopping", execution_generation: g };
          }
          if (stopMode === "terminal_stopped") {
            return { status: "stopped", execution_generation: g };
          }
          return { status: "stopping", execution_generation: g };
        },
      );

      const isStopped = result.status === "stopped";
      const isStopping = result.status === "stopping";
      if (existingTx) {
        const updatedTx: SessionTranscriptSnapshot = {
          ...existingTx,
          activeTurnId: isStopped ? null : turnId,
          turnStopping: isStopping,
          executionGeneration: result.executionGeneration,
          stopState: result.status,
        };
        if (fixture) {
          transcriptMap.set(transcriptKey(cid, pid, sid), updatedTx);
        } else {
          mockTranscripts.set(transcriptKey(cid, pid, sid), updatedTx);
        }
      }
      emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
        type: "turn_state",
        sessionId: sid,
        activeTurnId: isStopped ? null : turnId,
        turnStopping: isStopping,
        executionGeneration: result.executionGeneration,
        stopState: result.status,
        ...(isStopped ? { status: "stopped" as const } : {}),
      } satisfies TranscriptPatchPayload);

      const delayedMs = liveFix?.turnRecovery?.stopDelayedTerminalMs;
      if (isStopping && typeof delayedMs === "number" && delayedMs > 0) {
        setTimeout(() => {
          const settled = turnCoordinator.noteTurnTerminal({
            connectionId: cid,
            profileId: pid,
            sessionId: sid,
            turnId,
            executionGeneration: result.executionGeneration,
            outcome: "stopped",
          });
          emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
            type: "turn_state",
            sessionId: sid,
            activeTurnId: null,
            turnStopping: false,
            executionGeneration: settled.executionGeneration,
            stopState: settled.stopState,
            status: "stopped",
          } satisfies TranscriptPatchPayload);
        }, delayedMs);
      }

      return {
        stopped: isStopped,
        status: result.status,
        sessionId: sid,
        turnId,
        executionGeneration: result.executionGeneration,
      };
    },
    "prompts.resolveUnknown": async (payload, scope) => {
      e2eCounts.resolveUnknownCalls += 1;
      const liveFix = readE2EFixture() ?? fixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      const online = fixture
        ? Boolean(
            cid &&
              sid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              sid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      if (!online || !sid) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: ErrorCode }).code = "unreachable";
        throw err;
      }
      const admissionId =
        typeof payload.admissionId === "string" && payload.admissionId.trim()
          ? payload.admissionId.trim()
          : undefined;
      const executionGeneration =
        typeof payload.executionGeneration === "number" ? payload.executionGeneration : undefined;
      const res = await turnCoordinator.resolveUnknown(
        {
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          admissionId,
          executionGeneration,
        },
        async (rpcPayload) => {
          e2eCounts.resolveUnknownPayloads.push(rpcPayload);
          return { resolved: true, status: "interrupted" };
        },
      );
      const existingTx = fixture
        ? lookupTranscript(transcriptMap, cid, pid, sid)
        : mockTranscripts.get(transcriptKey(cid, pid, sid));
      if (existingTx) {
        const updatedTx: SessionTranscriptSnapshot = {
          ...existingTx,
          activeTurnId: null,
          turnStopping: false,
          stopState: "stopped",
        };
        if (fixture) {
          transcriptMap.set(transcriptKey(cid, pid, sid), updatedTx);
        } else {
          mockTranscripts.set(transcriptKey(cid, pid, sid), updatedTx);
        }
      }
      emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
        type: "turn_state",
        sessionId: sid,
        activeTurnId: null,
        turnStopping: false,
        stopState: "stopped",
      } satisfies TranscriptPatchPayload);

      const followerCfg = liveFix?.turnRecovery?.autoFollowerOnDiscard;
      if (followerCfg) {
        const storeKey = `${cid}::${pid}::${sid}`;
        const rawQueue = mockGatewayQueueStore.get(storeKey) ?? [];
        const firstQueued = rawQueue[0];
        const nextTurnId =
          ("turnId" in followerCfg && followerCfg.turnId) || `turn-follower-${++mockTurnSeq}`;
        const nextGen =
          ("executionGeneration" in followerCfg && followerCfg.executionGeneration) ||
          res.executionGeneration + 1;
        const started = turnCoordinator.noteTurnStarted({
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          turnId: nextTurnId,
          executionGeneration: nextGen,
          ownerGeneration: mockOwnerGen,
        });
        if (firstQueued) {
          const admId = String(firstQueued.admissionId ?? firstQueued.admission_id ?? "");
          if (admId) {
            turnCoordinator.applyAdmissionEvent({
              connectionId: cid,
              profileId: pid,
              sessionId: sid,
              admissionId: admId,
              state: "already_started",
              turnId: nextTurnId,
              executionGeneration: started.executionGeneration,
            });
          }
        }
        emitTranscriptEvent({ connectionId: cid, profileId: pid, sessionId: sid }, "patch", {
          type: "turn_state",
          sessionId: sid,
          activeTurnId: nextTurnId,
          turnStopping: false,
          executionGeneration: started.executionGeneration,
          stopState: "idle",
        } satisfies TranscriptPatchPayload);
      }

      return res;
    },
    "prompts.queue": async (payload, scope) => {
      e2eCounts.promptsQueueCalls += 1;
      const liveFix = readE2EFixture() ?? fixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sid || !text) {
        const err = new Error("请输入内容后再排队");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const existingRec = turnCoordinator.getSessionView({
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
      });
      if (existingRec?.queuePaused || existingRec?.unknownTurn) {
        const err = new Error(getCopy("turn.queue.pausedNotice"));
        (err as { code?: ErrorCode }).code = "conflict";
        throw err;
      }
      const online = fixture
        ? Boolean(
            cid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      const subId =
        typeof payload.submissionId === "string" && payload.submissionId.trim()
          ? payload.submissionId.trim()
          : undefined;
      return await turnCoordinator.submitQueued(
        {
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          text,
          online,
          ...(subId ? { submissionId: subId } : {}),
        },
        async (rpcPayload) => {
          e2eCounts.queueSubmittedIds.push(rpcPayload.submission_id);
          const attempt = (mockQueueAttemptBySubId.get(rpcPayload.submission_id) ?? 0) + 1;
          mockQueueAttemptBySubId.set(rpcPayload.submission_id, attempt);
          const ackMode = liveFix?.turnRecovery?.queueAckMode ?? "admitted";
          const storeKey = `${cid}::${pid}::${sid}`;
          const currentQueue = mockGatewayQueueStore.get(storeKey) ?? [];
          if (attempt === 1 && ackMode === "ack_loss_already_admitted") {
            mockQueueAdmissionSeq += 1;
            const admId = `adm-srv-${mockQueueAdmissionSeq}`;
            currentQueue.push({
              admission_id: admId,
              submission_id: rpcPayload.submission_id,
              text: rpcPayload.text,
              position: currentQueue.length + 1,
              state: "queued",
            });
            mockGatewayQueueStore.set(storeKey, currentQueue);
            const err = new Error("Queue submit ACK timeout");
            err.name = "GatewayTransportError";
            (err as { code?: ErrorCode }).code = "timeout";
            throw err;
          }
          if (
            (attempt === 1 && ackMode === "ack_loss_unadmitted") ||
            ackMode === "ack_loss"
          ) {
            const err = new Error("Queue submit ACK timeout");
            err.name = "GatewayTransportError";
            (err as { code?: ErrorCode }).code = "timeout";
            throw err;
          }
          mockQueueAdmissionSeq += 1;
          const admId = `adm-srv-${mockQueueAdmissionSeq}`;
          const pos = currentQueue.length + 1;
          currentQueue.push({
            admission_id: admId,
            submission_id: rpcPayload.submission_id,
            text: rpcPayload.text,
            position: pos,
            state: "queued",
          });
          mockGatewayQueueStore.set(storeKey, currentQueue);
          return {
            admitted: true,
            admission_id: admId,
            position: pos,
            status: "queued",
          };
        },
      );
    },
    "prompts.checkQueueReceipt": async (payload, scope) => {
      e2eCounts.promptsCheckQueueReceiptCalls += 1;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      const submissionId =
        typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
      const online = fixture
        ? Boolean(
            cid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      if (!online || !sid || !submissionId) {
        const err = new Error(online ? "缺少 submissionId" : "Not connected to Gateway");
        (err as { code?: ErrorCode }).code = online ? "invalid_request" : "unreachable";
        throw err;
      }
      const storeKey = `${cid}::${pid}::${sid}`;
      return await turnCoordinator.checkQueueReceipt(
        { connectionId: cid, profileId: pid, sessionId: sid, submissionId },
        async (subId) => {
          const list = mockGatewayQueueStore.get(storeKey) ?? [];
          const match = list.find(
            (item) => (item.submission_id ?? item.submissionId) === subId,
          );
          return {
            found: Boolean(match),
            ...(match ? { admission: match } : {}),
            queuedAdmissions: list,
          };
        },
      );
    },
    "prompts.retryQueue": async (payload, scope) => {
      e2eCounts.promptsRetryQueueCalls += 1;
      const liveFix = readE2EFixture() ?? fixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      const submissionId =
        typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
      const online = fixture
        ? Boolean(
            cid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      if (!online || !sid || !submissionId) {
        const err = new Error(online ? "缺少 submissionId" : "Not connected to Gateway");
        (err as { code?: ErrorCode }).code = online ? "invalid_request" : "unreachable";
        throw err;
      }
      const storeKey = `${cid}::${pid}::${sid}`;
      return await turnCoordinator.retryQueued(
        { connectionId: cid, profileId: pid, sessionId: sid, submissionId, online: true },
        async (rpcPayload) => {
          e2eCounts.queueSubmittedIds.push(rpcPayload.submission_id);
          const retryMode = liveFix?.turnRecovery?.queueRetryMode;
          if (retryMode === "ack_loss" || liveFix?.turnRecovery?.queueAckMode === "ack_loss") {
            const err = new Error("Retry ACK lost");
            err.name = "GatewayTransportError";
            (err as { code?: ErrorCode }).code = "timeout";
            throw err;
          }
          if (retryMode === "delivery_unknown") {
            return {
              admitted: true,
              status: "queued",
            };
          }
          const currentQueue = mockGatewayQueueStore.get(storeKey) ?? [];
          mockQueueAdmissionSeq += 1;
          const admId = `adm-srv-${mockQueueAdmissionSeq}`;
          const pos = currentQueue.length + 1;
          currentQueue.push({
            admission_id: admId,
            submission_id: rpcPayload.submission_id,
            text: rpcPayload.text,
            position: pos,
            state: "queued",
          });
          mockGatewayQueueStore.set(storeKey, currentQueue);
          return {
            admitted: true,
            admission_id: admId,
            position: pos,
            status: "queued",
          };
        },
      );
    },
    "prompts.cancelQueued": async (payload, scope) => {
      e2eCounts.promptsCancelQueuedCalls += 1;
      const liveFix = readE2EFixture() ?? fixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      const admissionId =
        typeof payload.admissionId === "string" ? payload.admissionId.trim() : "";
      const online = fixture
        ? Boolean(
            cid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      if (!online || !sid || !admissionId) {
        const err = new Error(online ? "缺少排队 admissionId" : "Not connected to Gateway");
        (err as { code?: ErrorCode }).code = online ? "invalid_request" : "unreachable";
        throw err;
      }
      const storeKey = `${cid}::${pid}::${sid}`;
      return await turnCoordinator.cancelQueued(
        { connectionId: cid, profileId: pid, sessionId: sid, admissionId },
        async ({ admission_id }) => {
          const outcome = liveFix?.turnRecovery?.queueCancelOutcome ?? "cancelled";
          if (outcome === "ack_loss") {
            const err = new Error("Queued cancel ACK timeout");
            err.name = "GatewayTransportError";
            (err as { code?: ErrorCode }).code = "timeout";
            throw err;
          }
          const list = (mockGatewayQueueStore.get(storeKey) ?? []).map((item) => {
            const itemId = String(item.admission_id ?? item.admissionId ?? "");
            return itemId === admission_id ? { ...item, state: outcome } : item;
          });
          mockGatewayQueueStore.set(storeKey, list);
          return { status: outcome };
        },
      );
    },
    "prompts.steer": async (payload, scope): Promise<PromptSteerResult> => {
      e2eCounts.promptsSteerCalls += 1;
      e2eCounts.steerPayloads.push({
        ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
        ...(typeof payload.executionGeneration === "number"
          ? { executionGeneration: payload.executionGeneration }
          : {}),
        ...(typeof payload.text === "string" ? { text: payload.text } : {}),
      });
      const liveFix = readE2EFixture() ?? fixture;
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            (fixture ? "local" : undefined);
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      const online = fixture
        ? Boolean(
            cid &&
              !mockTurnGlobalOffline &&
              currentFleet.connections.some((c) => c.connectionId === cid && c.actual === "ready"),
          )
        : Boolean(
            cid &&
              mockConnections.some((c) => c.connectionId === cid && c.actual === "ready"),
          );
      if (!online || !cid || !sid) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: ErrorCode }).code = "unreachable";
        throw err;
      }
      const turnId = typeof payload.turnId === "string" ? payload.turnId.trim() : "";
      const executionGeneration =
        typeof payload.executionGeneration === "number" ? payload.executionGeneration : undefined;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        const err = new Error("缺少补充指令内容");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const hasHistory = turnCoordinator.hasTurnHistory({
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
      });
      if (hasHistory || executionGeneration !== undefined) {
        const precheck = turnCoordinator.evaluateSteerPrecheck({
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          ...(turnId ? { turnId } : {}),
          ...(executionGeneration !== undefined ? { executionGeneration } : {}),
          text,
          requireRunning: true,
        });
        if (!precheck.allowed) {
          return turnCoordinator.recordSteerFailure({
            connectionId: cid,
            profileId: pid,
            sessionId: sid,
            ...(turnId ? { turnId } : {}),
            ...(executionGeneration !== undefined ? { executionGeneration } : {}),
            text,
            reason: precheck.reason,
            message: precheck.message,
          });
        }
      }

      const steerMode = liveFix?.turnRecovery?.steerMode ?? "ok";
      if (steerMode !== "ok") {
        const reason: SteerFailureReason = steerMode;
        return turnCoordinator.recordSteerFailure({
          connectionId: cid,
          profileId: pid,
          sessionId: sid,
          ...(turnId ? { turnId } : {}),
          ...(executionGeneration !== undefined ? { executionGeneration } : {}),
          text,
          reason,
          message: getCopy("turn.steer.fallbackBody"),
        });
      }
      return turnCoordinator.recordSteerSuccess({
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
        ...(turnId ? { turnId } : {}),
        ...(executionGeneration !== undefined ? { executionGeneration } : {}),
      });
    },
    "prompts.dismissSteerFallback": async (payload, scope) => {
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId ??
            (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ??
            "local";
      const pid =
        typeof payload.profileId === "string" && payload.profileId
          ? payload.profileId
          : scope?.profileId ??
            (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ??
            "default";
      const sid =
        typeof payload.sessionId === "string" && payload.sessionId
          ? payload.sessionId
          : scope?.sessionId ?? (fixture ? currentFleet.activeSessionId : mockActiveSessionId) ?? "";
      if (!sid) return { ok: true };
      turnCoordinator.clearSteerFallback({ connectionId: cid, profileId: pid, sessionId: sid });
      return { ok: true };
    },
    "local.inspect": async (): Promise<LocalInspectResult> => currentInspection,
    "local.selectCli": async (): Promise<LocalSelectCliResult> => ({
      cancelled: true,
      cli: currentInspection.cli,
      inspection: currentInspection,
    }),
    "local.diagnose": async (): Promise<SanitizedDiagnosticsPayload> => buildMockDiagnostics(),
    "capabilities.describe": async (payload, scope): Promise<CapabilitySnapshot> => {
      e2eCounts.capabilitiesDescribeCalls += 1;
      if (typeof payload.domain === "string") {
        e2eCounts.capabilitiesDescribeDomains.push(payload.domain);
      }
      const liveFixture = readE2EFixture() ?? fixture;
      syncFixtureGenerationIfNeeded(liveFixture);
      const cid =
        (typeof payload.connectionId === "string" && payload.connectionId) ||
        scope?.connectionId ||
        (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ||
        "local";
      const pid =
        (typeof payload.profileId === "string" && payload.profileId) ||
        scope?.profileId ||
        (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ||
        "default";
      const domain =
        typeof payload.domain === "string" ? (payload.domain as CapabilityDomainId) : undefined;
      const action = payload.action === "reload" ? "reload" : undefined;
      const snap = capabilityRegistry.getSnapshot();
      if (domain && snap.capabilitiesReady) {
        const meta = CAPABILITY_DOMAIN_CATALOG.find((m) => m.domain === domain);
        if (meta?.probeMethod) {
          const overrideOutcome = liveFixture?.capabilities?.probedDomains?.[domain];
          const tier = capabilityRegistry.getMethodTier(meta.probeMethod);
          const baseOutcome =
            overrideOutcome ??
            (tier === "refused"
              ? "refused"
              : tier === "served" || tier === "older"
                ? "ok"
                : "method_not_found");

          if (domain === "plugins") {
            e2eCounts.pluginsListCalls += 1;
            const plugCfg = liveFixture?.capabilities?.plugins;
            const extOutcome =
              plugCfg?.outcome ??
              (tier === "refused"
                ? "refused"
                : tier === "older"
                  ? "older"
                  : baseOutcome === "ok"
                    ? "ok"
                    : "method_not_found");
            capabilityRegistry.applyPluginsInventory({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: extOutcome,
              rawPlugins: plugCfg?.items ?? [],
              errorCode: plugCfg?.errorCode,
            });
          } else if (domain === "skills") {
            if (action === "reload") {
              e2eCounts.skillsReloadCalls += 1;
            }
            e2eCounts.skillsListCalls += 1;
            const skillCfg = liveFixture?.capabilities?.skills;
            const extOutcome =
              skillCfg?.outcome ??
              (baseOutcome === "ok" ? "ok" : baseOutcome === "refused" ? "refused" : "method_not_found");
            capabilityRegistry.applySkillsInventory({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: extOutcome,
              rawSkills: skillCfg?.items ?? [],
              reloaded: action === "reload",
              errorCode: skillCfg?.errorCode,
            });
          } else if (domain === "tools") {
            e2eCounts.toolsShowCalls += 1;
            const toolCfg = liveFixture?.capabilities?.tools;
            const extOutcome =
              toolCfg?.outcome ??
              (baseOutcome === "ok" ? "ok" : baseOutcome === "refused" ? "refused" : "method_not_found");
            capabilityRegistry.applyToolsInventory({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: extOutcome,
              rawTools: toolCfg?.items ?? [],
              errorCode: toolCfg?.errorCode,
            });
          } else if (domain === "mcp") {
            if (action === "reload") {
              e2eCounts.mcpReloadCalls += 1;
            }
            e2eCounts.mcpListCalls += 1;
            const mcpCfg = liveFixture?.capabilities?.mcp;
            const extOutcome =
              mcpCfg?.outcome ??
              (baseOutcome === "ok" ? "ok" : baseOutcome === "refused" ? "refused" : "method_not_found");
            capabilityRegistry.applyMcpInventory({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: extOutcome,
              rawServers: mcpCfg?.items ?? [],
              reloaded: action === "reload",
              errorCode: mcpCfg?.errorCode,
            });
          } else if (domain === "memory") {
            const memCfg = liveFixture?.capabilities?.memory;
            const normalizedOutcome = baseOutcome === "timeout" ? "older" : baseOutcome;
            capabilityRegistry.applyMemoryState({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: memCfg?.outcome ?? (normalizedOutcome === "ok" ? "ok" : normalizedOutcome),
              sourceMethod: memCfg?.sourceMethod ?? "session.context_breakdown",
              rawPayload: memCfg?.rawPayload ?? {},
              errorCode: memCfg?.errorCode,
            });
          } else if (domain === "messaging") {
            const msgCfg = liveFixture?.capabilities?.messaging;
            const normalizedOutcome = baseOutcome === "timeout" ? "older" : baseOutcome;
            capabilityRegistry.applyMessagingState({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: msgCfg?.outcome ?? (normalizedOutcome === "ok" ? "ok" : normalizedOutcome),
              rawPayload: msgCfg?.rawPayload ?? {},
              errorCode: msgCfg?.errorCode,
            });
          } else if (domain === "cron") {
            const cronCfg = liveFixture?.capabilities?.cron;
            const normalizedOutcome = baseOutcome === "timeout" ? "older" : baseOutcome;
            capabilityRegistry.applyCronState({
              expectedOwnerGeneration: snap.key.ownerGeneration,
              expectedAuthorityEpoch: snap.key.authorityEpoch,
              expectedGeneration: snap.generation,
              outcome: cronCfg?.outcome ?? (normalizedOutcome === "ok" ? "ok" : normalizedOutcome),
              rawPayload: mockCronPayloadForScope(cid, pid),
              errorCode: cronCfg?.errorCode,
            });
          }

          capabilityRegistry.applyProbeOutcome({
            domain,
            method: meta.probeMethod,
            outcome: baseOutcome,
            expectedOwnerGeneration: snap.key.ownerGeneration,
            expectedAuthorityEpoch: snap.key.authorityEpoch,
            expectedGeneration: capabilityRegistry.getSnapshot().generation,
          });
          emitCapabilitiesPatch();
        }
      }
      return capabilityRegistry.getSnapshot();
    },
    "cron.status": async (_payload, scope): Promise<CronStateView> => {
      const snap = capabilityRegistry.getSnapshot();
      const cid = scope?.connectionId ?? (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ?? "local";
      const pid = scope?.profileId ?? (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ?? "default";
      capabilityRegistry.applyCronState({
        expectedOwnerGeneration: snap.key.ownerGeneration,
        expectedAuthorityEpoch: snap.key.authorityEpoch,
        expectedGeneration: snap.generation,
        outcome: "ok",
        rawPayload: mockCronPayloadForScope(cid, pid),
      });
      emitCapabilitiesPatch();
      return capabilityRegistry.getSnapshot().cron;
    },
    "cron.submit": async (payload, scope): Promise<CronMutationResult> => {
      e2eCounts.cronSubmitCalls += 1;
      const snap = capabilityRegistry.getSnapshot();
      if (!snap.cron.supportedActions.canSubmit) {
        const err = new Error("Cron submit unavailable");
        (err as { code?: ErrorCode }).code = "capability_unavailable";
        throw err;
      }
      const cid = scope?.connectionId ?? (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ?? "local";
      const pid = scope?.profileId ?? (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ?? "default";
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const schedule = typeof payload.schedule === "string" ? payload.schedule.trim() : "";
      const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!name || !schedule || !prompt) {
        const err = new Error("Missing cron fields");
        (err as { code?: ErrorCode }).code = "invalid_request";
        throw err;
      }
      const store = mockCronJobsByScope.get(cronScopeKey(cid, pid)) ?? [];
      mockCronSeq += 1;
      const jobId = `cron-mock-${mockCronSeq}`;
      store.push({
        id: jobId,
        name,
        schedule,
        prompt,
        prompt_summary: prompt,
        status: "scheduled",
        next_run_at: new Date(Date.now() + 60_000).toISOString(),
      });
      mockCronJobsByScope.set(cronScopeKey(cid, pid), store);
      capabilityRegistry.applyCronState({
        expectedOwnerGeneration: snap.key.ownerGeneration,
        expectedAuthorityEpoch: snap.key.authorityEpoch,
        expectedGeneration: snap.generation,
        outcome: "ok",
        rawPayload: { jobs: store },
      });
      emitCapabilitiesPatch();
      return { ok: true, jobId, cron: capabilityRegistry.getSnapshot().cron };
    },
    "cron.cancel": async (payload, scope): Promise<CronMutationResult> => {
      e2eCounts.cronCancelCalls += 1;
      const cid = scope?.connectionId ?? (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ?? "local";
      const pid = scope?.profileId ?? (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ?? "default";
      const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
      const store = mockCronJobsByScope.get(cronScopeKey(cid, pid)) ?? [];
      const job = store.find((item) => item.id === jobId);
      if (!job) {
        const err = new Error("Cron job not found");
        (err as { code?: ErrorCode }).code = "not_found";
        throw err;
      }
      job.status = "cancelled";
      const snap = capabilityRegistry.getSnapshot();
      capabilityRegistry.applyCronState({
        expectedOwnerGeneration: snap.key.ownerGeneration,
        expectedAuthorityEpoch: snap.key.authorityEpoch,
        expectedGeneration: snap.generation,
        outcome: "ok",
        rawPayload: { jobs: store },
      });
      emitCapabilitiesPatch();
      return { ok: true, jobId, cron: capabilityRegistry.getSnapshot().cron };
    },
    "cron.recover": async (payload, scope): Promise<CronMutationResult> => {
      e2eCounts.cronRecoverCalls += 1;
      const cid = scope?.connectionId ?? (fixture ? currentFleet.activeScope?.connectionId : mockActiveScope?.connectionId) ?? "local";
      const pid = scope?.profileId ?? (fixture ? currentFleet.activeScope?.profileId : mockActiveScope?.profileId) ?? "default";
      const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
      const store = mockCronJobsByScope.get(cronScopeKey(cid, pid)) ?? [];
      const job = store.find((item) => item.id === jobId);
      if (!job) {
        const err = new Error("Cron job not found");
        (err as { code?: ErrorCode }).code = "not_found";
        throw err;
      }
      job.status = "scheduled";
      const snap = capabilityRegistry.getSnapshot();
      capabilityRegistry.applyCronState({
        expectedOwnerGeneration: snap.key.ownerGeneration,
        expectedAuthorityEpoch: snap.key.authorityEpoch,
        expectedGeneration: snap.generation,
        outcome: "ok",
        rawPayload: { jobs: store },
      });
      emitCapabilitiesPatch();
      return { ok: true, jobId, cron: capabilityRegistry.getSnapshot().cron };
    },
    "config.get": async (_payload, scope): Promise<GatewayConfigSnapshot> => {
      const activeScope = scope ?? (fixture ? currentFleet.activeScope : mockActiveScope);
      return {
        scope: activeScope,
        supported: mockConfigSupported,
        readOnly: mockConfigReadOnly,
        supportedKeys: [...mockConfigSupportedKeys],
        values: { ...mockConfigValues },
        updatedAt: new Date().toISOString(),
      };
    },
    "config.update": async (payload, scope): Promise<GatewayConfigUpdateResult> => {
      const key = typeof payload.key === "string" ? payload.key.trim() : "";
      const value = payload.value as GatewayConfigValue;
      if (!key || !isAllowedGatewayConfigKey(key) || !mockConfigSupportedKeys.includes(key)) {
        const err = new Error("Unsupported config key");
        (err as { code?: string }).code = "invalid_request";
        throw err;
      }
      mockConfigValues = {
        ...mockConfigValues,
        [key]: value,
      };
      const activeScope = scope ?? (fixture ? currentFleet.activeScope : mockActiveScope);
      return {
        ok: true,
        snapshot: {
          scope: activeScope,
          supported: mockConfigSupported,
          readOnly: mockConfigReadOnly,
          supportedKeys: [...mockConfigSupportedKeys],
          values: { ...mockConfigValues },
          updatedAt: new Date().toISOString(),
        },
      };
    },
    "diagnostics.export": async () => ({
      ...buildMockDiagnostics(),
      appInfo: mockAppInfo,
      display: formatAppInfoDisplay(mockAppInfo),
    }),
    "links.openExternal": async (payload) => {
      const rawUrl = typeof payload.url === "string" ? payload.url : "";
      if (!isSafeExternalHttpUrl(rawUrl)) {
        const err = new Error("Unsupported URL scheme");
        (err as { code?: string }).code = "permission_denied";
        throw err;
      }
      e2eCounts.externalLinksOpened.push(rawUrl);
      return { opened: true };
    },
    "approvals.list": async (): Promise<ApprovalTopicSnapshot> => {
      approvalCoordinator.onExpiryTick();
      return approvalCoordinator.snapshot();
    },
    "approvals.respond": async (payload) => {
      e2eCounts.approvalRespondCalls += 1;
      const { approvalKey, choice } = assertApprovalRespondPayloadSafe(payload);
      if ((readE2EFixture() ?? fixture)?.approvalRespondFailure) {
        const err = new Error("Approval action failed");
        (err as { code?: string }).code = "conflict";
        throw err;
      }
      return await approvalCoordinator.respond(approvalKey, choice);
    },
    "approvals.dismissOrphaned": async (payload) => {
      const { approvalKey } = assertApprovalDismissPayloadSafe(payload);
      return approvalCoordinator.dismissOrphaned(approvalKey);
    },
    "terminal.get": async (_payload, scope) => {
      const targetScope = scope?.connectionId ? scope : mockActiveScope;
      if (!targetScope?.connectionId) {
        return { snapshot: createEmptyTerminalSnapshot(null) };
      }
      const rec = getMockTerminalRecord(targetScope);
      return { snapshot: toMockTerminalSnapshot(rec) };
    },
    "terminal.open": async (payload, scope): Promise<TerminalOpenResult> => {
      e2eCounts.terminalOpenCalls += 1;
      const targetScope = scope?.connectionId ? scope : mockActiveScope;
      if (!targetScope?.connectionId) {
        const err = new Error("Scope required for terminal.open");
        (err as { code?: string }).code = "invalid_request";
        throw err;
      }
      const liveFixture = readE2EFixture() ?? fixture;
      const rec = getMockTerminalRecord(targetScope);
      const cols =
        typeof payload.cols === "number" && Number.isFinite(payload.cols)
          ? Math.max(20, Math.round(payload.cols))
          : rec.cols;
      const rows =
        typeof payload.rows === "number" && Number.isFinite(payload.rows)
          ? Math.max(5, Math.round(payload.rows))
          : rec.rows;
      const mode =
        payload.mode === "new" || payload.mode === "grant_root" ? payload.mode : "open";
      const wantGrantRoot = Boolean(payload.grantRoot) || mode === "grant_root";

      if (rec.status === "ended" && mode === "open" && !wantGrantRoot) {
        return {
          ok: false,
          granted: rec.granted,
          snapshot: toMockTerminalSnapshot(rec),
        };
      }

      if ((rec.status === "running" || rec.status === "detached") && rec.terminalId) {
        if (wantGrantRoot && !rec.rootGranted) {
          if (liveFixture?.terminal?.denyRootGrant) {
            return {
              ok: false,
              granted: false,
              deniedReason: "root_denied",
              snapshot: toMockTerminalSnapshot(rec),
            };
          }
          rec.rootGranted = true;
        }
        rec.status = "running";
        rec.cols = cols;
        rec.rows = rows;
        persistMockTerminals();
        emitMockTerminalSnapshot(rec);
        return { ok: true, granted: true, snapshot: toMockTerminalSnapshot(rec) };
      }

      if (wantGrantRoot && !rec.rootGranted) {
        if (liveFixture?.terminal?.denyRootGrant) {
          rec.status = "grant_denied";
          rec.granted = false;
          rec.rootGranted = false;
          persistMockTerminals();
          emitMockTerminalSnapshot(rec);
          return {
            ok: false,
            granted: false,
            deniedReason: "root_denied",
            snapshot: toMockTerminalSnapshot(rec),
          };
        }
        rec.granted = true;
        rec.rootGranted = true;
      } else if (!rec.granted) {
        if (liveFixture?.terminal?.denyFirstGrant) {
          rec.status = "grant_denied";
          rec.granted = false;
          persistMockTerminals();
          emitMockTerminalSnapshot(rec);
          return {
            ok: false,
            granted: false,
            deniedReason: "user_denied",
            snapshot: toMockTerminalSnapshot(rec),
          };
        }
        rec.granted = true;
      }

      rec.terminalId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      rec.status = "running";
      rec.cols = cols;
      rec.rows = rows;
      rec.exitCode = null;
      rec.hasForegroundProcess = Boolean(liveFixture?.terminal?.foregroundBusy);
      rec.foregroundProcessName = liveFixture?.terminal?.foregroundProcessName;
      rec.scrollback = createTerminalScrollbackState();
      if (liveFixture?.terminal?.initialLines?.length) {
        rec.scrollback = appendTerminalChunk(
          rec.scrollback,
          `${liveFixture.terminal.initialLines.join("\n")}\n`,
        );
      } else {
        rec.scrollback = appendTerminalChunk(rec.scrollback, "$ \n");
      }
      if (liveFixture?.terminal?.attribution) {
        rec.attribution = liveFixture.terminal.attribution;
      }
      persistMockTerminals();
      emitMockTerminalSnapshot(rec);
      return {
        ok: true,
        granted: true,
        snapshot: toMockTerminalSnapshot(rec),
      };
    },
    "terminal.write": async (payload, scope) => {
      e2eCounts.terminalWriteCalls += 1;
      const targetScope = scope?.connectionId ? scope : mockActiveScope;
      if (!targetScope?.connectionId) {
        const err = new Error("Scope required");
        (err as { code?: string }).code = "invalid_request";
        throw err;
      }
      const rec = getMockTerminalRecord(targetScope);
      if (!rec.terminalId || (rec.status !== "running" && rec.status !== "detached")) {
        const err = new Error("Terminal not active");
        (err as { code?: string }).code = "not_found";
        throw err;
      }
      const data = typeof payload.data === "string" ? payload.data : "";
      const cmd = data.replace(/\r?\n$/, "").trim();
      let chunk = `$ ${cmd}\n`;
      if (cmd === "exit") {
        chunk += "[process exited 0]\n";
        rec.scrollback = appendTerminalChunk(rec.scrollback, chunk);
        rec.terminalId = null;
        rec.status = "ended";
        rec.hasForegroundProcess = false;
        rec.foregroundProcessName = undefined;
        rec.exitCode = 0;
      } else if (cmd.startsWith("sleep")) {
        rec.hasForegroundProcess = true;
        rec.foregroundProcessName = "sleep";
        chunk += "[foreground running: sleep]\n";
        rec.scrollback = appendTerminalChunk(rec.scrollback, chunk);
      } else if (cmd.startsWith("burst:")) {
        const count = Math.min(12_000, Math.max(1, Number(cmd.slice(6)) || 10_050));
        const bulk = Array.from({ length: count }, (_, idx) => `burst-line-${idx + 1}`).join("\n");
        rec.scrollback = appendTerminalChunk(rec.scrollback, `${chunk}${bulk}\n`);
      } else if (cmd.startsWith("echo ")) {
        chunk += `${cmd.slice(5)}\n`;
        rec.scrollback = appendTerminalChunk(rec.scrollback, chunk);
      } else if (cmd) {
        chunk += `mock-pty: ${cmd} (cols=${rec.cols}, rows=${rec.rows})\n`;
        rec.scrollback = appendTerminalChunk(rec.scrollback, chunk);
      }
      persistMockTerminals();
      emitMockTerminalSnapshot(rec);
      return { ok: true };
    },
    "terminal.resize": async (payload, scope) => {
      e2eCounts.terminalResizeCalls += 1;
      const targetScope = scope?.connectionId ? scope : mockActiveScope;
      if (!targetScope?.connectionId) {
        const err = new Error("Scope required");
        (err as { code?: string }).code = "invalid_request";
        throw err;
      }
      const rec = getMockTerminalRecord(targetScope);
      if (!rec.terminalId || (rec.status !== "running" && rec.status !== "detached")) {
        const err = new Error("Terminal not active");
        (err as { code?: string }).code = "not_found";
        throw err;
      }
      rec.cols =
        typeof payload.cols === "number" && Number.isFinite(payload.cols)
          ? Math.max(20, Math.round(payload.cols))
          : rec.cols;
      rec.rows =
        typeof payload.rows === "number" && Number.isFinite(payload.rows)
          ? Math.max(5, Math.round(payload.rows))
          : rec.rows;
      persistMockTerminals();
      emitMockTerminalSnapshot(rec);
      return { ok: true, cols: rec.cols, rows: rec.rows };
    },
    "terminal.close": async (payload, scope): Promise<TerminalCloseResult> => {
      e2eCounts.terminalCloseCalls += 1;
      const targetScope = scope?.connectionId ? scope : mockActiveScope;
      if (!targetScope?.connectionId) {
        const err = new Error("Scope required");
        (err as { code?: string }).code = "invalid_request";
        throw err;
      }
      const rec = getMockTerminalRecord(targetScope);
      const mode =
        payload.mode === "detach" || payload.mode === "terminate" ? payload.mode : "auto";
      if (!rec.terminalId || (rec.status !== "running" && rec.status !== "detached")) {
        rec.terminalId = null;
        rec.status = "idle";
        rec.hasForegroundProcess = false;
        rec.foregroundProcessName = undefined;
        rec.exitCode = null;
        rec.scrollback = createTerminalScrollbackState();
        persistMockTerminals();
        emitMockTerminalSnapshot(rec);
        return { ok: true, outcome: "closed", snapshot: toMockTerminalSnapshot(rec) };
      }
      if (mode === "detach") {
        rec.status = "detached";
        persistMockTerminals();
        emitMockTerminalSnapshot(rec);
        return { ok: true, outcome: "detached", snapshot: toMockTerminalSnapshot(rec) };
      }
      if (mode === "auto" && rec.hasForegroundProcess) {
        return { ok: false, outcome: "confirm_required", snapshot: toMockTerminalSnapshot(rec) };
      }
      rec.terminalId = null;
      rec.hasForegroundProcess = false;
      rec.foregroundProcessName = undefined;
      rec.scrollback = createTerminalScrollbackState();
      rec.status = mode === "terminate" ? "ended" : "idle";
      rec.exitCode = 0;
      persistMockTerminals();
      emitMockTerminalSnapshot(rec);
      return {
        ok: true,
        outcome: mode === "terminate" ? "terminated" : "closed",
        snapshot: toMockTerminalSnapshot(rec),
      };
    },
  });

  const bridge: HermesHost = {
    version: HOST_BRIDGE_VERSION,

    async request<T = unknown>(
      command: HostCommand,
      payload: Record<string, unknown> = {},
      scope: BridgeScope | null = null,
    ): Promise<BridgeResult<T>> {
      reqSeq += 1;
      const requestId = `mock-${reqSeq}`;
      return dispatcher.dispatch({
        version: HOST_BRIDGE_VERSION,
        requestId,
        command,
        scope,
        payload,
      }) as Promise<BridgeResult<T>>;
    },

    subscribe(
      topic: HostTopic,
      scope: BridgeScope | null,
      listener: (event: BridgeEvent) => void,
    ): () => void {
      if (!VALID_TOPICS.has(topic)) {
        throw new Error(`Invalid host topic: ${String(topic)}`);
      }
      if (topic === "fleet") {
        const typed = listener as (event: BridgeEvent<FleetSnapshot>) => void;
        fleetListeners.add(typed);
        queueMicrotask(() => {
          listener({
            topic: "fleet",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: fixture ? 1 : fleetRev,
            payload: fixture ? currentFleet : getMockFleet(),
          });
        });
        return () => {
          fleetListeners.delete(typed);
        };
      } else if (topic === "connection.health") {
        const typed = listener as (event: BridgeEvent<ConnectionHealthSummary[]>) => void;
        healthListeners.add(typed);
        queueMicrotask(() => {
          listener({
            topic: "connection.health",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: fixture ? 1 : fleetRev,
            payload: (fixture ? currentFleet.connections : mockConnections).map((c) => ({ ...c })),
          });
        });
        return () => {
          healthListeners.delete(typed);
        };
      } else if (topic === "profiles") {
        const entry = {
          connectionId: scope?.connectionId,
          listener: listener as (event: BridgeEvent<{ profiles: ProfileSummary[] }>) => void,
        };
        profileListeners.add(entry);
        queueMicrotask(() => {
          const cid = scope?.connectionId ?? mockActiveScope?.connectionId;
          listener({
            topic: "profiles",
            scope: cid ? { connectionId: cid } : null,
            kind: "snapshot",
            seq: 0,
            revision: fixture ? 1 : fleetRev,
            payload: {
              profiles: fixture
                ? currentFleet.profiles
                : cid
                  ? mockProfiles.filter((p) => p.connectionId === cid)
                  : [],
            },
          });
        });
        return () => {
          profileListeners.delete(entry);
        };
      } else if (topic === "sessions") {
        const typed = listener as (event: BridgeEvent<{ sessions: SessionSummary[] }>) => void;
        sessionsListeners.add(typed);
        const entry = {
          connectionId: scope?.connectionId,
          profileId: scope?.profileId,
          listener: typed,
        };
        sessionListeners.add(entry);
        queueMicrotask(() => {
          const cid = scope?.connectionId ?? mockActiveScope?.connectionId;
          const pid = scope?.profileId ?? mockActiveScope?.profileId ?? "default";
          listener({
            topic: "sessions",
            scope: cid ? { connectionId: cid, profileId: pid } : null,
            kind: "snapshot",
            seq: 0,
            revision: fixture ? 1 : fleetRev,
            payload: {
              sessions: fixture
                ? currentFleet.sessions
                : cid
                  ? mockSessions.filter((s) => s.connectionId === cid && s.profileId === pid)
                  : [],
            },
          });
        });
        return () => {
          sessionsListeners.delete(typed);
          sessionListeners.delete(entry);
        };
      } else if (topic === "capabilities") {
        const typed = listener as (event: BridgeEvent<CapabilitySnapshot>) => void;
        capabilitiesListeners.add(typed);
        queueMicrotask(() => {
          if (!capabilitiesListeners.has(typed)) return;
          listener({
            topic: "capabilities",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: capabilityRegistry.getSnapshot().generation,
            payload: capabilityRegistry.getSnapshot(),
          });
        });
        return () => {
          capabilitiesListeners.delete(typed);
        };
      } else if (topic === "chat.state") {
        chatStateListeners.add(listener as (event: BridgeEvent<ChatSessionProjection>) => void);
        queueMicrotask(() => {
          listener({
            topic: "chat.state",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: currentChatState,
          });
        });
        return () => {
          chatStateListeners.delete(listener as (event: BridgeEvent<ChatSessionProjection>) => void);
        };
      } else if (topic === "session.transcript" && fixture && scope?.sessionId) {
        const sid = scope.sessionId;
        const cid = scope.connectionId ?? "local";
        const pid = scope.profileId ?? "default";
        const entry = { scope, seq: 0, listener };
        transcriptListeners.add(entry);
        let active = true;
        queueMicrotask(() => {
          if (!active) return;
          if (isResyncRequired(cid, pid, sid)) {
            listener({
              topic: "session.transcript",
              scope,
              kind: "resync_required",
              seq: 0,
              revision: 1,
              payload: { reason: "overflow" },
            });
            return;
          }
          const snap =
            lookupTranscript(transcriptMap, cid, pid, sid) ?? makeEmptyTranscript(cid, pid, sid);
          entry.seq = 0;
          listener({
            topic: "session.transcript",
            scope,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: { ...snap, messages: [...snap.messages] },
          });
          const events = fixture.transcriptEventsOnSubscribe?.[sid];
          if (events && !emittedTranscriptSubs.has(sid)) {
            emittedTranscriptSubs.add(sid);
            events.forEach((ev, idx) => {
              setTimeout(() => {
                if (!active) return;
                listener(ev);
              }, 20 * (idx + 1));
            });
          }
        });
        return () => {
          active = false;
          transcriptListeners.delete(entry);
        };
      } else if (topic === "session.transcript") {
        const entry = { scope, seq: 0, listener };
        transcriptListeners.add(entry);
        queueMicrotask(() => {
          const cid = scope?.connectionId ?? mockActiveScope?.connectionId ?? "";
          const pid = scope?.profileId ?? mockActiveScope?.profileId ?? "default";
          const sid = scope?.sessionId ?? mockActiveSessionId ?? "";
          const tx = cid && sid ? mockTranscripts.get(transcriptKey(cid, pid, sid)) : null;
          if (tx) {
            entry.seq = 0;
            listener({
              topic: "session.transcript",
              scope,
              kind: "snapshot",
              seq: 0,
              revision: fleetRev,
              payload: { ...tx, messages: [...tx.messages] },
            });
          }
        });
        return () => {
          transcriptListeners.delete(entry);
        };
      } else if (topic === "registry") {
        registryListeners.add(
          listener as (event: BridgeEvent<{ snapshot: RegistrySnapshotView; diff?: RegistryDiff }>) => void,
        );
        queueMicrotask(() => {
          const snapshot = currentRegistrySnapshot();
          listener({
            topic: "registry",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: snapshot.revision,
            payload: { snapshot },
          });
        });
        return () => {
          registryListeners.delete(
            listener as (event: BridgeEvent<{ snapshot: RegistrySnapshotView; diff?: RegistryDiff }>) => void,
          );
        };
      } else if (topic === "auth.state") {
        const typed = listener as (event: BridgeEvent<AuthStateSnapshot>) => void;
        authListeners.add(typed);
        if (latestAuthState) {
          queueMicrotask(() => {
            if (!authListeners.has(typed) || !latestAuthState) return;
            typed({
              topic: "auth.state",
              scope: latestAuthState.connectionId ? { connectionId: latestAuthState.connectionId } : null,
              kind: "snapshot",
              seq: 0,
              revision: authRev,
              payload: latestAuthState,
            });
          });
        }
        return () => {
          authListeners.delete(typed);
        };
      } else if (topic === "approval") {
        const typed = listener as (event: BridgeEvent<ApprovalTopicSnapshot>) => void;
        approvalListeners.add(typed);
        queueMicrotask(() => {
          if (!approvalListeners.has(typed)) return;
          approvalCoordinator.onExpiryTick();
          typed({
            topic: "approval",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: approvalSeq + 1,
            payload: approvalCoordinator.snapshot(),
          });
        });
        return () => {
          approvalListeners.delete(typed);
        };
      } else if (topic === "terminal") {
        const targetScope = scope?.connectionId ? scope : mockActiveScope;
        if (targetScope?.connectionId) {
          const scopeKey = makeScopeKey(targetScope.connectionId, targetScope.profileId ?? "default");
          const entry = {
            scopeKey,
            seq: 0,
            listener: listener as (event: BridgeEvent<TerminalSnapshot>) => void,
          };
          terminalListeners.add(entry);
          queueMicrotask(() => {
            if (!terminalListeners.has(entry)) return;
            const rec = getMockTerminalRecord(targetScope);
            entry.listener({
              topic: "terminal",
              scope: { ...rec.scope },
              kind: "snapshot",
              seq: 0,
              revision: rec.revision,
              payload: toMockTerminalSnapshot(rec),
            });
          });
          return () => {
            terminalListeners.delete(entry);
          };
        }
      } else if (topic === "turn.recovery") {
        const typed = listener as (event: BridgeEvent<TurnRecoveryTopicSnapshot>) => void;
        turnRecoveryListeners.add(typed);
        queueMicrotask(() => {
          if (!turnRecoveryListeners.has(typed)) return;
          typed({
            topic: "turn.recovery",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: turnRecoverySeq + 1,
            payload: turnCoordinator.snapshot(),
          });
        });
        return () => {
          turnRecoveryListeners.delete(typed);
        };
      }
      return () => {
        // No background network resources in MockHostBridge
      };
    },

    onCommand(listener: (command: AppCommand) => void): () => void {
      commandListeners.add(listener);
      return () => {
        commandListeners.delete(listener);
      };
    },
  };

  return Object.freeze(bridge);
}

export const host: HermesHost = createMockHostBridge();
