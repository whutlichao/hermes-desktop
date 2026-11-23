import {
  HOST_BRIDGE_VERSION,
  HOST_TOPICS,
  type AppCommand,
  type AppInfo,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type ConnectionMutationInput,
  type ConnectionMutationResponse,
  type FleetSnapshot,
  type HermesHost,
  type HostCommand,
  type HostTopic,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type SanitizedDiagnosticsPayload,
  type LaunchMode,
  type RegistryDiff,
  type RegistrySnapshotView,
} from "@hermes/contracts";
import {
  createBridgeDispatcher,
  createEmptyRegistryDocument,
  diffRegistries,
  formatAppInfoDisplay,
  formatDisplaySafeCliSummary,
  mapLocalFailure,
  normalizeRegistryDocument,
  projectRegistrySnapshot,
  sanitizeDiagnosticsPayload,
  validateClientAddConnection,
  validateClientRemoveConnection,
  validateClientUpdateConnection,
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

  let currentNorm: NormalizedRegistryResult = normalizeRegistryDocument(
    createEmptyRegistryDocument(),
  );
  let registrySeq = 0;

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
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev),
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
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev),
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
      return {
        committed: true,
        snapshot: emitRegistryPatch(prev),
        warnings: [],
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
    "profiles.list": async () => ({ profiles: EMPTY_FLEET.profiles }),
    "sessions.list": async () => ({ sessions: EMPTY_FLEET.sessions }),
    "connections.retry": async () => ({
      ok: false,
      fleet: EMPTY_FLEET,
      inspection: currentInspection,
      failure: currentInspection.failure,
    }),
    "sessions.create": async () => {
      const err = new Error("Not connected to Gateway");
      (err as { code?: string }).code = "unreachable";
      throw err;
    },
    "sessions.select": async () => {
      const err = new Error("Not connected to Gateway");
      (err as { code?: string }).code = "unreachable";
      throw err;
    },
    "sessions.resume": async () => {
      const err = new Error("Not connected to Gateway");
      (err as { code?: string }).code = "unreachable";
      throw err;
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
        queueMicrotask(() => {
          listener({
            topic: "fleet",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: EMPTY_FLEET,
          });
        });
      } else if (topic === "profiles") {
        queueMicrotask(() => {
          listener({
            topic: "profiles",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: { profiles: EMPTY_FLEET.profiles },
          });
        });
      } else if (topic === "sessions") {
        queueMicrotask(() => {
          listener({
            topic: "sessions",
            scope: null,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: { sessions: EMPTY_FLEET.sessions },
          });
        });
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
