import {
  HOST_BRIDGE_VERSION,
  HOST_TOPICS,
  type AppCommand,
  type AppInfo,
  type AuthStartResult,
  type AuthStateSnapshot,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type CapabilitySnapshot,
  type ChatSessionProjection,
  type ConnectionMutationInput,
  type ConnectionMutationResponse,
  type FleetSnapshot,
  type HermesHost,
  type HostCommand,
  type HostTopic,
  type LaunchMode,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type MissingSessionExport,
  type RegistryDiff,
  type RegistryIssue,
  type RegistrySnapshotView,
  type RemoteTestActionId,
  type RemoteTestResult,
  type SanitizedDiagnosticsPayload,
  type SessionSummary,
  type SessionTranscriptSnapshot,
} from "@hermes/contracts";
import {
  CapabilityRegistry,
  createBridgeDispatcher,
  createEmptyRegistryDocument,
  diffRegistries,
  formatAppInfoDisplay,
  formatDisplaySafeCliSummary,
  mapLocalFailure,
  normalizeRegistryDocument,
  projectRegistrySnapshot,
  redactSensitiveData,
  sanitizeDiagnosticsPayload,
  validateClientAddConnection,
  validateClientRemoveConnection,
  validateClientUpdateConnection,
  validateRemoteEndpointUrl,
  type NormalizedRegistryResult,
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
  transcriptEventsOnSubscribe?: Record<string, BridgeEvent[]>;
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
  const sessionsListeners = new Set<(event: BridgeEvent<{ sessions: SessionSummary[] }>) => void>();
  const chatStateListeners = new Set<(event: BridgeEvent<ChatSessionProjection>) => void>();
  const registryListeners = new Set<
    (event: BridgeEvent<{ snapshot: RegistrySnapshotView; diff?: RegistryDiff }>) => void
  >();
  const authListeners = new Set<(event: BridgeEvent<AuthStateSnapshot>) => void>();

  let currentFleet: FleetSnapshot = fixture?.fleet
    ? structuredClone(fixture.fleet)
    : EMPTY_FLEET;
  let currentChatState: ChatSessionProjection = fixture?.chatState
    ? structuredClone(fixture.chatState)
    : EMPTY_CHAT_STATE;
  const transcriptMap = new Map<string, SessionTranscriptSnapshot>(
    Object.entries(fixture?.transcripts ?? {}),
  );
  const resyncedTranscriptMap = new Map<string, SessionTranscriptSnapshot>(
    Object.entries(fixture?.resyncedTranscripts ?? {}),
  );
  const emittedTranscriptSubs = new Set<string>();

  const e2eCounts = {
    sessionsCreateCalls: 0,
    sessionsResumeCalls: 0,
    sessionsSelectCalls: 0,
  };
  if (fixture) {
    (globalThis as { __HERMES_E2E_COUNTS__?: typeof e2eCounts }).__HERMES_E2E_COUNTS__ = e2eCounts;
  }

  let currentNorm: NormalizedRegistryResult = normalizeRegistryDocument(
    createEmptyRegistryDocument(),
  );
  let registrySeq = 0;
  let fleetSeq = 0;
  let sessionsSeq = 0;
  let chatStateSeq = 0;

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
    "connections.test": async (payload): Promise<RemoteTestResult> => {
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
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev, prevIssues),
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
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev, prevIssues),
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
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev, prevIssues),
        warnings: [],
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
    "profiles.list": async () => ({ profiles: currentFleet.profiles }),
    "scopes.switch": async () => ({ ok: false, fleet: currentFleet, transcript: null }),
    "sessions.list": async () => ({ sessions: currentFleet.sessions }),
    "connections.retry": async () => ({
      ok: false,
      fleet: currentFleet,
      inspection: currentInspection,
      failure: currentInspection.failure,
    }),
    "sessions.create": async (payload, scope) => {
      e2eCounts.sessionsCreateCalls += 1;
      if (!fixture) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
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
      emitSessionsSnapshot();
      emitFleetSnapshot();
      emitChatStatePatch();
      return { session: created, transcript, fleet: currentFleet };
    },
    "sessions.select": async (payload, scope) => {
      e2eCounts.sessionsSelectCalls += 1;
      if (!fixture) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
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
      const transcript = nextSessionId
        ? lookupTranscript(transcriptMap, connectionId, profileId, nextSessionId) ??
          makeEmptyTranscript(connectionId, profileId, nextSessionId)
        : undefined;
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
      return { transcript, fleet: currentFleet };
    },
    "sessions.resume": async (payload, scope) => {
      e2eCounts.sessionsResumeCalls += 1;
      if (!fixture) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
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
      transcriptMap.set(`${connectionId}::${profileId}::${sessionId}`, transcript);
      return { transcript };
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
      const connectionId = scope?.connectionId ?? currentFleet.activeScope?.connectionId ?? "local";
      const profileId =
        typeof payload.profileId === "string"
          ? payload.profileId
          : scope?.profileId ?? currentFleet.activeScope?.profileId ?? "default";
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId : scope?.sessionId;
      if (!sessionId) return currentChatState;
      const text = typeof payload.text === "string" ? payload.text : "";
      const key = `${connectionId}::${profileId}::${sessionId}`;
      const existing = currentChatState.sessionSummaries[key];
      currentChatState = {
        ...currentChatState,
        sessionSummaries: {
          ...currentChatState.sessionSummaries,
          [key]: {
            connectionId,
            profileId,
            sessionId,
            title: existing?.title ?? sessionId,
            preview: existing?.preview,
            updatedAt: existing?.updatedAt,
            hasDraft: text.trim().length > 0,
            ...(text.trim().length > 0 ? { draftText: text } : {}),
            lastKnownMessages: existing?.lastKnownMessages,
          },
        },
      };
      emitChatStatePatch();
      return currentChatState;
    },
    "chatState.exportMissingSession": async (): Promise<MissingSessionExport | null> => {
      if (!currentChatState.missingSession) return null;
      const m = currentChatState.missingSession;
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
        draftText: m.draftText ?? "",
        messages: m.lastKnownMessages ?? [],
      };
    },
    "chatState.dismissMissingSession": async () => {
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
    "prompts.send": async () => {
      const err = new Error("Not connected to Gateway");
      (err as { code?: string }).code = "unreachable";
      throw err;
    },
    "prompts.stop": async () => {
      const err = new Error("Not connected to Gateway");
      (err as { code?: string }).code = "unreachable";
      throw err;
    },
    "prompts.steer": async () => {
      const err = new Error("Not connected to Gateway");
      (err as { code?: string }).code = "unreachable";
      throw err;
    },
    "local.inspect": async (): Promise<LocalInspectResult> => currentInspection,
    "local.selectCli": async (): Promise<LocalSelectCliResult> => ({
      cancelled: true,
      cli: currentInspection.cli,
      inspection: currentInspection,
    }),
    "local.diagnose": async (): Promise<SanitizedDiagnosticsPayload> => buildMockDiagnostics(),
    "capabilities.describe": async (): Promise<CapabilitySnapshot> => capabilityRegistry.getSnapshot(),
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
      return { opened: true };
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
      _scope: BridgeScope | null,
      listener: (event: BridgeEvent) => void,
    ): () => void {
      if (!VALID_TOPICS.has(topic)) {
        throw new Error(`Invalid host topic: ${String(topic)}`);
      }
      if (topic === "fleet") {
        fleetListeners.add(listener as (event: BridgeEvent<FleetSnapshot>) => void);
        queueMicrotask(() => {
          listener({
            topic: "fleet",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: currentFleet,
          });
        });
        return () => {
          fleetListeners.delete(listener as (event: BridgeEvent<FleetSnapshot>) => void);
        };
      } else if (topic === "profiles") {
        queueMicrotask(() => {
          listener({
            topic: "profiles",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: { profiles: currentFleet.profiles },
          });
        });
      } else if (topic === "sessions") {
        sessionsListeners.add(listener as (event: BridgeEvent<{ sessions: SessionSummary[] }>) => void);
        queueMicrotask(() => {
          listener({
            topic: "sessions",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: { sessions: currentFleet.sessions },
          });
        });
        return () => {
          sessionsListeners.delete(listener as (event: BridgeEvent<{ sessions: SessionSummary[] }>) => void);
        };
      } else if (topic === "capabilities") {
        queueMicrotask(() => {
          listener({
            topic: "capabilities",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: capabilityRegistry.getSnapshot(),
          });
        });
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
      } else if (topic === "session.transcript" && fixture && _scope?.sessionId) {
        const sid = _scope.sessionId;
        const cid = _scope.connectionId ?? "local";
        const pid = _scope.profileId ?? "default";
        const snap =
          lookupTranscript(transcriptMap, cid, pid, sid) ?? makeEmptyTranscript(cid, pid, sid);
        let active = true;
        queueMicrotask(() => {
          if (!active) return;
          listener({
            topic: "session.transcript",
            scope: _scope,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: snap,
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
