import {
  HOST_BRIDGE_VERSION,
  HOST_TOPICS,
  type AppCommand,
  type AppInfo,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type ConnectionHealthSummary,
  type ConnectionMutationInput,
  type ConnectionMutationResponse,
  type ConnectionTestResult,
  type FleetSnapshot,
  type HermesHost,
  type HostCommand,
  type HostTopic,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type ProfileSummary,
  type SanitizedDiagnosticsPayload,
  type LaunchMode,
  type RegistryDiff,
  type RegistrySnapshotView,
  type SessionSummary,
  type SessionTranscriptSnapshot,
  type SshHostKeyConfirmResult,
} from "@hermes/contracts";
import {
  createBridgeDispatcher,
  createEmptyRegistryDocument,
  diffRegistries,
  formatAppInfoDisplay,
  formatDisplaySafeCliSummary,
  formatSshHostDisplay,
  formatSshTargetDisplay,
  getCopy,
  getSshFailureCopy,
  mapLocalFailure,
  normalizeRegistryDocument,
  projectRegistrySnapshot,
  sanitizeDiagnosticsPayload,
  validateClientAddConnection,
  validateClientRemoveConnection,
  validateClientUpdateConnection,
  validateSshTargetInput,
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
  const commandListeners = new Set<(cmd: AppCommand) => void>();
  const mockAppInfo = createMockAppInfo();
  const currentInspection = createInitialMockInspection();

  const registryListeners = new Set<
    (event: BridgeEvent<{ snapshot: RegistrySnapshotView; diff?: RegistryDiff }>) => void
  >();
  const fleetListeners = new Set<(event: BridgeEvent<FleetSnapshot>) => void>();
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

  const trustedMockHosts = new Set<string>(["lab.example.com", "lab.local", "remote.example.com"]);
  const mockConnections: ConnectionHealthSummary[] = [];
  const mockProfiles: ProfileSummary[] = [];
  const mockSessions: SessionSummary[] = [];
  const mockTranscripts = new Map<string, SessionTranscriptSnapshot>();
  let mockActiveScope: BridgeScope | null = null;
  let mockActiveSessionId: string | null = null;
  let fleetRev = 1;

  let currentNorm: NormalizedRegistryResult = normalizeRegistryDocument(
    createEmptyRegistryDocument(),
  );
  let registrySeq = 0;

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
      const profiles: ProfileSummary[] = [
        {
          connectionId,
          profileId: defaultProfile,
          displayName: defaultProfile === "default" ? "Remote Default" : `Remote ${defaultProfile}`,
          handle: defaultProfile,
          isDefault: true,
        },
        {
          connectionId,
          profileId: defaultProfile === "ops" ? "staging" : "ops",
          displayName: defaultProfile === "ops" ? "Remote Staging" : "Remote Ops",
          handle: defaultProfile === "ops" ? "staging" : "ops",
          isDefault: false,
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
      mockSessions.push(sess1);
      mockTranscripts.set(transcriptKey(connectionId, defaultProfile, sess1.sessionId), {
        connectionId,
        profileId: defaultProfile,
        sessionId: sess1.sessionId,
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
        { phase: "common_dirs", outcome: "failed", code: "hermes_not_found" },
      ],
      notes: ["浏览器 Mock 模式：未读取真实 HERMES_HOME 或执行本机进程。"],
    });

  function emitRegistryPatch(prevNorm: NormalizedRegistryResult): RegistrySnapshotView {
    registrySeq += 1;
    const snapshot = projectRegistrySnapshot(currentNorm);
    const diff = diffRegistries(prevNorm, currentNorm);
    const event: BridgeEvent<{ snapshot: RegistrySnapshotView; diff?: RegistryDiff }> = {
      topic: "registry",
      scope: null,
      kind: "patch",
      seq: registrySeq,
      revision: snapshot.revision,
      payload: { snapshot, diff },
    };
    for (const listener of registryListeners) {
      listener(event);
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
      const registry = projectRegistrySnapshot(currentNorm);
      return { connections: registry.connections, registry };
    },
    "connections.add": async (payload): Promise<ConnectionMutationResponse> => {
      const check = validateClientAddConnection(currentNorm.doc, asInput(payload));
      if (!check.ok) {
        return {
          committed: false,
          snapshot: projectRegistrySnapshot(currentNorm),
          warnings: [],
          rejectedIssue: check.issue,
          conflict: check.conflict,
        };
      }
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        connections: [...currentNorm.doc.connections, check.connection],
      });
      const snapshot = emitRegistryPatch(prev);
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
        warnings: [],
      };
    },
    "connections.update": async (payload): Promise<ConnectionMutationResponse> => {
      const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const check = validateClientUpdateConnection(currentNorm.doc, connectionId, asInput(payload));
      if (!check.ok) {
        return {
          committed: false,
          snapshot: projectRegistrySnapshot(currentNorm),
          warnings: [],
          rejectedIssue: check.issue,
          conflict: check.conflict,
        };
      }
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        connections: currentNorm.doc.connections.map((c) =>
          c.id === connectionId ? check.connection : c,
        ),
      });
      const snapshot = emitRegistryPatch(prev);
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
        warnings: [],
      };
    },
    "connections.remove": async (payload): Promise<ConnectionMutationResponse> => {
      const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const check = validateClientRemoveConnection(currentNorm.doc, connectionId);
      if (!check.ok) {
        return {
          committed: false,
          snapshot: projectRegistrySnapshot(currentNorm),
          warnings: [],
          rejectedIssue: check.issue,
        };
      }
      const prev = currentNorm;
      currentNorm = normalizeRegistryDocument({
        ...currentNorm.doc,
        revision: currentNorm.doc.revision + 1,
        primary: currentNorm.doc.primary === connectionId ? "local" : currentNorm.doc.primary,
        lastUsed: currentNorm.doc.lastUsed === connectionId ? undefined : currentNorm.doc.lastUsed,
        connections: currentNorm.doc.connections.filter((c) => c.id !== connectionId),
      });
      const snapshot = emitRegistryPatch(prev);
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
      emitMockFleet();
      return {
        committed: true,
        snapshot,
        warnings: [],
      };
    },
    "connections.test": async (payload): Promise<ConnectionTestResult> => {
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
          snapshot: projectRegistrySnapshot(currentNorm),
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
          snapshot: projectRegistrySnapshot(currentNorm),
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
          snapshot: projectRegistrySnapshot(currentNorm),
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
        snapshot: projectRegistrySnapshot(currentNorm),
        warnings: [],
      };
    },
    "connections.exportSafeSummary": async () => {
      const snap = projectRegistrySnapshot(currentNorm);
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
      registry: projectRegistrySnapshot(currentNorm),
    }),
    "profiles.list": async (payload, scope) => {
      const cid =
        typeof payload.connectionId === "string" && payload.connectionId
          ? payload.connectionId
          : scope?.connectionId;
      return {
        profiles: cid ? mockProfiles.filter((p) => p.connectionId === cid) : [...mockProfiles],
      };
    },
    "sessions.list": async (payload, scope) => {
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
      const cid = typeof payload.connectionId === "string" ? payload.connectionId : "local";
      if (cid !== "local") {
        const hit = mockConnections.find((c) => c.connectionId === cid);
        if (hit) {
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
      emitMockFleet();
      return { session, transcript: snapshot, fleet: getMockFleet() };
    },
    "sessions.select": async (payload, scope) => {
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
      const transcript = sid ? mockTranscripts.get(transcriptKey(cid, pid, sid)) ?? null : null;
      emitMockFleet();
      return { fleet: getMockFleet(), transcript };
    },
    "sessions.resume": async (payload, scope) => {
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
    "prompts.send": async (payload, scope) => {
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
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!cid || !sid || !mockConnections.some((c) => c.connectionId === cid && c.actual === "ready")) {
        const err = new Error("Not connected to Gateway");
        (err as { code?: string }).code = "unreachable";
        throw err;
      }
      const key = transcriptKey(cid, pid, sid);
      const tx = mockTranscripts.get(key);
      const now = new Date().toISOString();
      const userMsgId = `mock-u-${Date.now()}`;
      const assistantMsgId = `mock-a-${Date.now()}`;
      const turnId = `mock-turn-${Date.now()}`;
      if (tx) {
        const userMsg = {
          messageId: userMsgId,
          sessionId: sid,
          role: "user" as const,
          text,
          createdAt: now,
          status: "complete" as const,
        };
        const assistantMsg = {
          messageId: assistantMsgId,
          sessionId: sid,
          role: "assistant" as const,
          text: `SSH Mock Gateway (${cid}) received: ${text}`,
          createdAt: now,
          turnId,
          streaming: false,
          status: "complete" as const,
        };
        tx.messages.push(userMsg, assistantMsg);
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
      }
      return {
        accepted: true,
        connectionId: cid,
        profileId: pid,
        sessionId: sid,
        turnId,
      };
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
            revision: fleetRev,
            payload: getMockFleet(),
          });
        });
        return () => {
          fleetListeners.delete(typed);
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
            revision: fleetRev,
            payload: {
              profiles: cid ? mockProfiles.filter((p) => p.connectionId === cid) : [],
            },
          });
        });
        return () => {
          profileListeners.delete(entry);
        };
      } else if (topic === "sessions") {
        const entry = {
          connectionId: scope?.connectionId,
          profileId: scope?.profileId,
          listener: listener as (event: BridgeEvent<{ sessions: SessionSummary[] }>) => void,
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
            revision: fleetRev,
            payload: {
              sessions: cid
                ? mockSessions.filter((s) => s.connectionId === cid && s.profileId === pid)
                : [],
            },
          });
        });
        return () => {
          sessionListeners.delete(entry);
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
          const snapshot = projectRegistrySnapshot(currentNorm);
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
