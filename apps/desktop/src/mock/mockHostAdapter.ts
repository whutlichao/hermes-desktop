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
} from "@hermes/contracts";
import { createBridgeDispatcher, formatAppInfoDisplay } from "@hermes/domain";

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

export function createMockHostBridge(): HermesHost {
  let reqSeq = 0;
  const commandListeners = new Set<(cmd: AppCommand) => void>();
  const mockAppInfo = createMockAppInfo();

  const dispatcher = createBridgeDispatcher({
    "bridge.hello": async (): Promise<AppInfo> => mockAppInfo,
    "connections.list": async () => ({ connections: EMPTY_FLEET.connections }),
    "profiles.list": async () => ({ profiles: EMPTY_FLEET.profiles }),
    "sessions.list": async () => ({ sessions: EMPTY_FLEET.sessions }),
    "diagnostics.export": async () => ({
      appInfo: mockAppInfo,
      display: formatAppInfoDisplay(mockAppInfo),
      connectionsCount: 0,
    }),
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
