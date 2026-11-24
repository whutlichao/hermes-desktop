import type {
  AuthStateSnapshot,
  BridgeEvent,
  ConnectionMutationInput,
  ConnectionMutationResponse,
  LaunchMode,
  RegistryDiff,
  RegistryIssue,
  RegistrySnapshotView,
} from "@hermes/contracts";
import { getCopy, type HostCommandHandler } from "@hermes/domain";
import type { GatewayClientTlsOptions } from "./gatewayClient";
import type { RegistryMutationResult, RegistryStore } from "./registryStore";
import { type RemoteAuthManager, testRemoteConnection } from "./remoteGateway";

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

export interface RegistryBridgePayload {
  snapshot: RegistrySnapshotView;
  diff?: RegistryDiff;
}

export interface RegistryBridgeDeps {
  authManager?: RemoteAuthManager;
  tls?: GatewayClientTlsOptions;
  onConnectionCommitted?: (params: {
    action: "add" | "update";
    connectionId: string;
    snapshot: RegistrySnapshotView;
    activate?: boolean;
  }) => void;
}

export function createRegistryBridgeHandlers(
  store: RegistryStore,
  deps?: RegistryBridgeDeps,
) {
  const bindOAuthTokenAfterCommit = (
    connectionId: string,
    input: ConnectionMutationInput,
    baseSnapshot: RegistrySnapshotView,
    baseWarnings: RegistryIssue[],
  ): { snapshot: RegistrySnapshotView; warnings: RegistryIssue[] } => {
    const conn = baseSnapshot.connections.find((c) => c.id === connectionId);
    if (!conn || conn.kind !== "remote") {
      return { snapshot: baseSnapshot, warnings: baseWarnings };
    }
    if (input.authMode === "token" && input.token) {
      store.clearTokenSyncFailed(connectionId);
      return { snapshot: store.snapshot(), warnings: baseWarnings };
    }
    if (input.authMode === "oauth" && input.authSessionId && deps?.authManager) {
      const pending = deps.authManager.consumePendingToken(
        input.authSessionId,
        conn.originDisplay ?? undefined,
      );
      if (pending) {
        const secretRes = store.writeSecret({
          kind: "oauth",
          connectionId,
          baseUrl: pending.origin,
          tokenSet: pending.tokenSet,
        });
        if (!secretRes.ok) {
          store.markTokenSyncFailed(connectionId);
          return {
            snapshot: store.snapshot(),
            warnings: [
              ...baseWarnings,
              {
                code: "token_sync_failed",
                severity: "warning",
                connectionId,
                messageKey: "registry.issue.tokenSyncFailed",
              },
            ],
          };
        }
        store.clearTokenSyncFailed(connectionId);
        return { snapshot: secretRes.snapshot, warnings: baseWarnings };
      }
    }
    return { snapshot: baseSnapshot, warnings: baseWarnings };
  };

  const handlers: Record<string, HostCommandHandler> = {
    "connections.list": async () => {
      const registry = store.snapshot();
      return { connections: registry.connections, registry };
    },
    "connections.test": async (payload) => {
      return testRemoteConnection({
        input: {
          kind: typeof payload.kind === "string" ? payload.kind : "remote",
          url: typeof payload.url === "string" ? payload.url : "",
          authMode: payload.authMode === "oauth" ? "oauth" : "token",
          token: typeof payload.token === "string" ? payload.token : undefined,
          authSessionId: typeof payload.authSessionId === "string" ? payload.authSessionId : undefined,
          connectionId: typeof payload.connectionId === "string" ? payload.connectionId : undefined,
        },
        registryStore: store,
        authManager: deps?.authManager,
        tls: deps?.tls,
      });
    },
    "connections.add": async (payload) => {
      const prevIds = new Set(store.snapshot().connections.map((c) => c.id));
      const input = asConnectionInput(payload);
      const res = store.add(input);
      if (!res.ok) {
        return toMutationResponse(res);
      }
      const added = res.snapshot.connections.find((c) => !prevIds.has(c.id));
      let snapshot = res.snapshot;
      let warnings = [...res.warnings];
      if (added) {
        const bound = bindOAuthTokenAfterCommit(added.id, input, snapshot, warnings);
        snapshot = bound.snapshot;
        warnings = bound.warnings;
        deps?.onConnectionCommitted?.({
          action: "add",
          connectionId: added.id,
          snapshot,
          activate: payload.activate !== false,
        });
      }
      return {
        committed: true,
        snapshot,
        warnings,
      } satisfies ConnectionMutationResponse;
    },
    "connections.update": async (payload) => {
      const connectionId = asString(payload.connectionId);
      const input = asConnectionInput(payload);
      const res = store.update(connectionId, input);
      if (!res.ok) {
        return toMutationResponse(res);
      }
      const bound = bindOAuthTokenAfterCommit(connectionId, input, res.snapshot, [...res.warnings]);
      deps?.onConnectionCommitted?.({
        action: "update",
        connectionId,
        snapshot: bound.snapshot,
        activate: payload.activate === true,
      });
      return {
        committed: true,
        snapshot: bound.snapshot,
        warnings: bound.warnings,
      } satisfies ConnectionMutationResponse;
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
    "auth.start": async (payload) => {
      if (!deps?.authManager) {
        const err = new Error(getCopy("registry.oauthManagerUnavailableError"));
        (err as { code?: string }).code = "capability_unavailable";
        throw err;
      }
      return deps.authManager.startAuth({
        kind: typeof payload.kind === "string" ? payload.kind : undefined,
        url: typeof payload.url === "string" ? payload.url : undefined,
        connectionId: typeof payload.connectionId === "string" ? payload.connectionId : undefined,
      });
    },
    "auth.cancel": async (payload) => {
      if (!deps?.authManager) {
        return { cancelled: false, authSessionId: asString(payload.authSessionId) };
      }
      return deps.authManager.cancelAuth(asString(payload.authSessionId));
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

  function subscribeAuthState(
    listener: (event: BridgeEvent<AuthStateSnapshot>) => void,
  ): () => void {
    if (!deps?.authManager) {
      return () => {};
    }
    return deps.authManager.subscribe(listener);
  }

  return { handlers, subscribeRegistry, subscribeAuthState };
}
