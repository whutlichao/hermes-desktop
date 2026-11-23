import type {
  BridgeEvent,
  ConnectionMutationInput,
  ConnectionMutationResponse,
  LaunchMode,
  RegistryDiff,
  RegistrySnapshotView,
} from "@hermes/contracts";
import type { HostCommandHandler } from "@hermes/domain";
import type { RegistryMutationResult, RegistryStore } from "./registryStore";

function toMutationResponse(result: RegistryMutationResult): ConnectionMutationResponse {
  if (result.ok) {
    return {
      committed: true,
      snapshot: result.snapshot,
      warnings: result.warnings,
    };
  }
  return {
    committed: false,
    snapshot: result.snapshot,
    warnings: [],
    rejectedIssue: result.issue,
    conflict: result.conflict,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asConnectionInput(payload: Record<string, unknown>): ConnectionMutationInput {
  return {
    kind: payload.kind as ConnectionMutationInput["kind"],
    label: asString(payload.label),
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

export interface RegistryBridgePayload {
  snapshot: RegistrySnapshotView;
  diff?: RegistryDiff;
}

export function createRegistryBridgeHandlers(store: RegistryStore) {
  const handlers: Record<string, HostCommandHandler> = {
    "connections.list": async () => {
      const registry = store.snapshot();
      return { connections: registry.connections, registry };
    },
    "connections.add": async (payload) => {
      const res = store.add(asConnectionInput(payload));
      return toMutationResponse(res);
    },
    "connections.update": async (payload) => {
      const connectionId = asString(payload.connectionId);
      const res = store.update(connectionId, asConnectionInput(payload));
      return toMutationResponse(res);
    },
    "connections.remove": async (payload) => {
      const connectionId = asString(payload.connectionId);
      const res = store.remove(connectionId);
      return toMutationResponse(res);
    },
    "connections.setPrimary": async (payload) => {
      const connectionId = asString(payload.connectionId);
      const res = store.setPrimary(connectionId);
      return toMutationResponse(res);
    },
    "connections.setLaunchMode": async (payload) => {
      const launchMode = payload.launchMode as LaunchMode;
      const res = store.setLaunchMode(launchMode);
      return toMutationResponse(res);
    },
    "connections.setLastUsed": async (payload) => {
      const connectionId = asString(payload.connectionId);
      const res = store.setLastUsed(connectionId);
      return toMutationResponse(res);
    },
    "connections.backupAndRepair": async () => {
      const res = store.backupAndRepair();
      return toMutationResponse(res);
    },
    "connections.exportSafeSummary": async () => {
      return store.exportSafeSummary();
    },
    "registry.refresh": async () => {
      return { registry: store.refresh() };
    },
  };

  function subscribeRegistry(
    listener: (event: BridgeEvent<RegistryBridgePayload>) => void,
  ): () => void {
    let seq = 0;
    const initial = store.snapshot();
    listener({
      topic: "registry",
      scope: null,
      kind: "snapshot",
      seq,
      revision: initial.revision,
      payload: { snapshot: initial },
    });

    return store.subscribe((ev) => {
      seq += 1;
      listener({
        topic: "registry",
        scope: null,
        kind: "patch",
        seq,
        revision: ev.snapshot.revision,
        payload: {
          snapshot: ev.snapshot,
          diff: ev.diff,
        },
      });
    });
  }

  return { handlers, subscribeRegistry };
}
