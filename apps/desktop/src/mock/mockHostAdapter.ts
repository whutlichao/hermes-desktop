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
import { createBridgeDispatcher } from "@hermes/domain";

const VALID_TOPICS = new Set<string>(HOST_TOPICS);

const EMPTY_FLEET: FleetSnapshot = {
  connections: [],
  profiles: [],
  sessions: [],
  activeScope: null,
  activeSessionId: null,
};

export function createMockHostBridge(): HermesHost {
  let reqSeq = 0;
  const commandListeners = new Set<(cmd: AppCommand) => void>();

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
    "diagnostics.export": async () => ({
      appName: "Hermes Desktop",
      appVersion: "0.1.0",
      bridgeVersion: HOST_BRIDGE_VERSION,
      mode: "mock",
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
