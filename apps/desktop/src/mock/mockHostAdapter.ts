import {
  HOST_BRIDGE_VERSION,
  HOST_TOPICS,
  type AppCommand,
  type AppInfo,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type FleetSnapshot,
  type HermesHost,
  type HostCommand,
  type HostTopic,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type SanitizedDiagnosticsPayload,
} from "@hermes/contracts";
import {
  createBridgeDispatcher,
  formatDisplaySafeCliSummary,
  mapLocalFailure,
  sanitizeDiagnosticsPayload,
} from "@hermes/domain";

const VALID_TOPICS = new Set<string>(HOST_TOPICS);

const EMPTY_FLEET: FleetSnapshot = {
  connections: [],
  profiles: [],
  sessions: [],
  activeScope: null,
  activeSessionId: null,
};

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
  const currentInspection = createInitialMockInspection();

  const buildMockDiagnostics = (): SanitizedDiagnosticsPayload =>
    sanitizeDiagnosticsPayload({
      generatedAt: "2026-11-23T06:00:00.000Z",
      appName: "Hermes Desktop",
      appVersion: "0.1.0",
      bridgeVersion: HOST_BRIDGE_VERSION,
      buildMode: "mock",
      mode: "mock",
      platform: "web",
      arch: "wasm",
      hermesHomeKind: "mock",
      connectionsCount: 0,
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

  const dispatcher = createBridgeDispatcher({
    "bridge.hello": async (): Promise<AppInfo> => ({
      bridgeVersion: HOST_BRIDGE_VERSION,
      appName: "Hermes Desktop",
      appVersion: "0.1.0",
      mode: "mock",
      platform: "web",
      arch: "wasm",
      capabilitiesReady: false,
    }),
    "connections.list": async () => ({ connections: EMPTY_FLEET.connections }),
    "profiles.list": async () => ({ profiles: EMPTY_FLEET.profiles }),
    "sessions.list": async () => ({ sessions: EMPTY_FLEET.sessions }),
    "local.inspect": async (): Promise<LocalInspectResult> => currentInspection,
    "local.selectCli": async (): Promise<LocalSelectCliResult> => ({
      cancelled: true,
      cli: currentInspection.cli,
      inspection: currentInspection,
    }),
    "local.diagnose": async (): Promise<SanitizedDiagnosticsPayload> => buildMockDiagnostics(),
    "diagnostics.export": async (): Promise<SanitizedDiagnosticsPayload> => buildMockDiagnostics(),
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
