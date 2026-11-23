import type {
  ActivityEventPayload,
  BridgeEvent,
  BridgeScope,
  ConnectionHealthSummary,
  ErrorCode,
  FleetSnapshot,
  LocalInspectResult,
  LocalTypedFailure,
  ProfileSummary,
  PromptEventPayload,
  RegistryDiff,
  RegistrySnapshotView,
  SessionSummary,
  SessionTranscriptSnapshot,
  SshFailureCode,
  SupportedChatActions,
  ToolExecutionRow,
  TranscriptMessage,
  TranscriptPatchPayload,
} from "@hermes/contracts";
import {
  classifyRuntimeCapabilities,
  getLocalFailureCopy,
  isJsonRpcMethodNotFound,
  reduceTranscriptEvent,
  toSupportedChatActions,
  type ClassifiedRuntimeCapabilities,
  type HostCommandHandler,
} from "@hermes/domain";
import {
  GatewayClient,
  GatewayRpcError,
  GatewayTransportError,
} from "./gatewayClient";
import type { LocalBackendManager, LocalDialMaterial } from "./localBackendManager";
import type { RegistryStore } from "./registryStore";
import type { SshDialMaterial, SshTargetConfig, SshTransportManager } from "./sshTransport";

export interface SupervisorConnectResult {
  ok: boolean;
  failure?: LocalTypedFailure;
  fleet: FleetSnapshot;
}

type DialMaterial = LocalDialMaterial | SshDialMaterial;

interface GatewayTransportEntry {
  key: string;
  connectionId: string;
  kind: "local" | "ssh";
  transportMode: "shared-host-scope" | "per-profile";
  client: GatewayClient;
  dial: DialMaterial;
  capabilities: ClassifiedRuntimeCapabilities;
  supportedActions: SupportedChatActions;
  capabilitiesReported: boolean;
  subscribedToGateway: boolean;
  disposed: boolean;
  unsubNotification: () => void;
  unsubClose: () => void;
}

interface SubscriberRecord {
  id: number;
  topic: BridgeEvent["topic"];
  scope: BridgeScope | null;
  seq: number;
  listener: (event: BridgeEvent) => void;
}

function makeBridgeError(code: ErrorCode, safeMessage: string): Error {
  const err = new Error(safeMessage);
  (err as { code?: ErrorCode }).code = code;
  return err;
}

function mapLocalFailureToErrorCode(failure: LocalTypedFailure | undefined): ErrorCode {
  if (!failure) return "unreachable";
  switch (failure.code) {
    case "socket_permission_denied":
    case "cli_not_executable":
      return "permission_denied";
    case "protocol_unsupported":
      return "protocol_unsupported";
    case "gateway_starting_timeout":
    case "control_timeout":
      return "timeout";
    case "authorization":
      return "auth_failed";
    case "hermes_not_found":
      return "not_found";
    default:
      return "unreachable";
  }
}

function mapSshFailureToErrorCode(code: SshFailureCode): ErrorCode {
  switch (code) {
    case "ssh_auth_failed":
      return "auth_failed";
    case "ssh_timeout":
      return "timeout";
    case "protocol_unsupported":
      return "protocol_unsupported";
    case "host_key_unknown":
    case "host_key_changed":
      return "permission_denied";
    case "remote_hermes_not_found":
      return "not_found";
    default:
      return "unreachable";
  }
}

function defaultChatActions(): SupportedChatActions {
  return {
    promptSubmit: false,
    promptCancel: false,
    promptSteer: false,
    sessionCreate: false,
    sessionResume: false,
  };
}

function scopeKey(connectionId: string, profileId: string): string {
  return `${connectionId}::${profileId}`;
}

function transcriptKey(connectionId: string, profileId: string, sessionId: string): string {
  return `${connectionId}::${profileId}::${sessionId}`;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function mapRawSession(
  raw: Record<string, unknown>,
  connectionId: string,
  fallbackProfileId: string,
): SessionSummary | null {
  const sessionId = asString(raw.session_id ?? raw.sessionId ?? raw.id).trim();
  if (!sessionId) return null;
  const profileId =
    asString(raw.profile_id ?? raw.profileId, fallbackProfileId).trim() || fallbackProfileId;
  const title = asString(raw.title ?? raw.name, "新对话") || "新对话";
  const preview = asString(raw.preview ?? raw.last_message ?? raw.lastMessage, "");
  const updatedAt = asString(raw.updated_at ?? raw.updatedAt, new Date().toISOString());
  const activeTurnIdRaw = raw.active_turn_id ?? raw.activeTurnId;
  const activeTurnId =
    typeof activeTurnIdRaw === "string" && activeTurnIdRaw ? activeTurnIdRaw : null;
  return {
    connectionId,
    profileId,
    sessionId,
    title,
    preview,
    updatedAt,
    pinned: Boolean(raw.pinned),
    unreadCount: typeof raw.unread_count === "number" ? raw.unread_count : 0,
    needsInput: Boolean(raw.needs_input ?? raw.needsInput),
    activeTurnId,
    status: activeTurnId ? "running" : "idle",
  };
}

function mapRawMessage(raw: Record<string, unknown>, sessionId: string): TranscriptMessage | null {
  const messageId = asString(raw.message_id ?? raw.messageId ?? raw.id).trim();
  if (!messageId) return null;
  const rawRole = asString(raw.role, "assistant");
  const role: TranscriptMessage["role"] =
    rawRole === "user" || rawRole === "system" ? rawRole : "assistant";
  const text = asString(raw.text ?? raw.content, "");
  const createdAt = asString(raw.created_at ?? raw.createdAt, new Date().toISOString());
  const turnIdRaw = raw.turn_id ?? raw.turnId;
  const turnId = typeof turnIdRaw === "string" && turnIdRaw ? turnIdRaw : undefined;
  const toolRowsRaw = Array.isArray(raw.tool_rows ?? raw.toolRows)
    ? ((raw.tool_rows ?? raw.toolRows) as Array<Record<string, unknown>>)
    : [];
  const toolRows: ToolExecutionRow[] | undefined =
    toolRowsRaw.length > 0
      ? toolRowsRaw.map((row, idx) => ({
          toolCallId: asString(
            row.tool_call_id ?? row.toolCallId ?? row.id,
            `${messageId}-tool-${idx}`,
          ),
          name: asString(row.name ?? row.tool, "tool"),
          status:
            row.status === "running" ||
            row.status === "failed" ||
            row.status === "cancelled"
              ? row.status
              : "completed",
          summary: typeof row.summary === "string" ? row.summary : undefined,
          durationMs: typeof row.duration_ms === "number" ? row.duration_ms : undefined,
        }))
      : undefined;
  return {
    messageId,
    sessionId,
    role,
    text,
    createdAt,
    ...(turnId ? { turnId } : {}),
    ...(toolRows ? { toolRows } : {}),
    streaming: Boolean(raw.streaming),
    status: raw.streaming ? "streaming" : "complete",
  };
}

export class ConnectionSupervisor {
  private readonly localBackend: LocalBackendManager;
  private readonly getLocalLabel: () => string;
  private readonly registryStore?: RegistryStore;
  private readonly sshTransport?: SshTransportManager;

  private revision = 1;
  private subscriberSeq = 0;
  private disposed = false;

  private localHealth: ConnectionHealthSummary;
  private readonly sshHealthById = new Map<string, ConnectionHealthSummary>();
  private readonly profilesByConnection = new Map<string, ProfileSummary[]>();
  private readonly sessionsByScope = new Map<string, SessionSummary[]>();
  private readonly transcripts = new Map<string, SessionTranscriptSnapshot>();
  private readonly transports = new Map<string, GatewayTransportEntry>();
  private readonly connectingByKey = new Map<string, Promise<SupervisorConnectResult>>();
  private readonly subscribers = new Map<number, SubscriberRecord>();

  private activeScope: BridgeScope | null = null;
  private activeSessionId: string | null = null;

  constructor(
    localBackend: LocalBackendManager,
    options?: {
      getLocalLabel?: () => string;
      registryStore?: RegistryStore;
      sshTransport?: SshTransportManager;
    },
  ) {
    this.localBackend = localBackend;
    this.getLocalLabel = options?.getLocalLabel ?? (() => "This device");
    this.registryStore = options?.registryStore;
    this.sshTransport = options?.sshTransport;
    this.localHealth = {
      connectionId: "local",
      label: this.getLocalLabel(),
      kind: "local",
      originDisplay: "127.0.0.1",
      actual: "idle",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
    };

    if (this.registryStore) {
      this.syncHealthPlaceholdersFromRegistry(this.registryStore.snapshot());
    }
  }

  getLocalHealth(): ConnectionHealthSummary {
    return { ...this.localHealth, label: this.getLocalLabel() };
  }

  private getConnectionHealth(connectionId: string): ConnectionHealthSummary | null {
    if (connectionId === "local") return this.getLocalHealth();
    const ssh = this.sshHealthById.get(connectionId);
    return ssh ? { ...ssh } : null;
  }

  private getAllProfiles(): ProfileSummary[] {
    const out: ProfileSummary[] = [];
    for (const list of this.profilesByConnection.values()) {
      out.push(...list);
    }
    return out;
  }

  getFleetSnapshot(): FleetSnapshot {
    const allSessions: SessionSummary[] = [];
    for (const list of this.sessionsByScope.values()) {
      allSessions.push(...list);
    }
    const localProfiles = this.profilesByConnection.get("local") ?? [];
    const localSessions = allSessions.filter((s) => s.connectionId === "local");
    const includeLocal = !(
      this.localHealth.actual === "idle" &&
      localProfiles.length === 0 &&
      localSessions.length === 0 &&
      !this.localHealth.errorCode
    );

    const connections: ConnectionHealthSummary[] = [];
    if (includeLocal) {
      connections.push(this.getLocalHealth());
    }
    for (const sshHealth of this.sshHealthById.values()) {
      connections.push({ ...sshHealth });
    }

    return {
      connections,
      profiles: this.getAllProfiles(),
      sessions: allSessions,
      activeScope: this.activeScope ? { ...this.activeScope } : null,
      activeSessionId: this.activeSessionId,
    };
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  private emitTopic(
    topic: BridgeEvent["topic"],
    scope: BridgeScope | null,
    kind: BridgeEvent["kind"],
    payload: unknown,
    matcher?: (sub: SubscriberRecord) => boolean,
  ): void {
    const rev = this.nextRevision();
    for (const sub of this.subscribers.values()) {
      if (sub.topic !== topic) continue;
      if (matcher && !matcher(sub)) continue;
      sub.seq = kind === "snapshot" ? 0 : sub.seq + 1;
      try {
        sub.listener({
          topic,
          scope,
          kind,
          seq: sub.seq,
          revision: rev,
          payload,
        });
      } catch {
        // Isolate broken subscribers
      }
    }
  }

  private emitFleet(connectionId = "local"): void {
    const snapshot = this.getFleetSnapshot();
    this.emitTopic("fleet", null, "snapshot", snapshot);
    const health = this.getConnectionHealth(connectionId);
    if (health) {
      this.emitTopic(
        "connection.health",
        { connectionId },
        "patch",
        health,
        (sub) => !sub.scope || sub.scope.connectionId === connectionId,
      );
    }
  }

  private emitProfiles(connectionId = "local"): void {
    const list = this.profilesByConnection.get(connectionId) ?? [];
    this.emitTopic(
      "profiles",
      { connectionId },
      "snapshot",
      { profiles: [...list] },
      (sub) => !sub.scope || sub.scope.connectionId === connectionId,
    );
  }

  private emitSessions(connectionId: string, profileId: string): void {
    const list = this.sessionsByScope.get(scopeKey(connectionId, profileId)) ?? [];
    this.emitTopic(
      "sessions",
      { connectionId, profileId },
      "snapshot",
      { sessions: [...list] },
      (sub) =>
        !sub.scope ||
        (sub.scope.connectionId === connectionId &&
          (!sub.scope.profileId || sub.scope.profileId === profileId)),
    );
  }

  private emitTranscriptPatch(
    connectionId: string,
    profileId: string,
    sessionId: string,
    patch: TranscriptPatchPayload,
  ): void {
    this.emitTopic(
      "session.transcript",
      { connectionId, profileId, sessionId },
      "patch",
      patch,
      (sub) =>
        Boolean(
          sub.scope &&
            sub.scope.connectionId === connectionId &&
            (sub.scope.profileId ?? "default") === profileId &&
            sub.scope.sessionId === sessionId,
        ),
    );
  }

  private getTransportForScope(
    connectionId: string,
    profileId: string,
  ): GatewayTransportEntry | null {
    const shared = this.transports.get(`${connectionId}::shared`);
    if (shared && !shared.disposed && shared.client.isOpen()) {
      return shared;
    }
    const perProfile = this.transports.get(`${connectionId}::profile:${profileId}`);
    if (perProfile && !perProfile.disposed && perProfile.client.isOpen()) {
      return perProfile;
    }
    return null;
  }

  private getSshTargetForConnection(connectionId: string): {
    target: SshTargetConfig;
    label: string;
    sshTargetDisplay: string;
    defaultProfile: string;
  } | null {
    if (!this.registryStore) return null;
    const rawDoc = this.registryStore.getDocument();
    const rawConn = rawDoc.connections.find((c) => c.id === connectionId);
    const snap = this.registryStore.snapshot();
    const dispConn = snap.connections.find((c) => c.id === connectionId);
    if (!rawConn || rawConn.kind !== "ssh" || !rawConn.host || (dispConn && !dispConn.dialable)) {
      return null;
    }
    return {
      label: rawConn.label,
      sshTargetDisplay: dispConn?.sshTargetDisplay ?? rawConn.host,
      defaultProfile: rawConn.remoteProfile?.trim() || "default",
      target: {
        connectionId: rawConn.id,
        host: rawConn.host,
        ...(rawConn.user ? { user: rawConn.user } : {}),
        ...(rawConn.port ? { port: rawConn.port } : {}),
        ...(rawConn.keyPath ? { keyPath: rawConn.keyPath } : {}),
        ...(rawConn.remoteHermesPath ? { remoteHermesPath: rawConn.remoteHermesPath } : {}),
        ...(rawConn.remoteProfile ? { remoteProfile: rawConn.remoteProfile } : {}),
      },
    };
  }

  private syncHealthPlaceholdersFromRegistry(snapshot: RegistrySnapshotView): void {
    const validSshIds = new Set<string>();
    for (const conn of snapshot.connections) {
      if (conn.kind !== "ssh" || !conn.dialable) continue;
      validSshIds.add(conn.id);
      const existing = this.sshHealthById.get(conn.id);
      if (existing) {
        this.sshHealthById.set(conn.id, {
          ...existing,
          label: conn.label,
          originDisplay: conn.sshTargetDisplay ?? conn.sshHost ?? existing.originDisplay,
        });
      } else {
        this.sshHealthById.set(conn.id, {
          connectionId: conn.id,
          label: conn.label,
          kind: "ssh",
          originDisplay: conn.sshTargetDisplay ?? conn.sshHost ?? conn.id,
          actual: "idle",
          degraded: false,
          latencyMs: null,
          nextRetryAt: null,
        });
      }
    }
    for (const id of [...this.sshHealthById.keys()]) {
      if (!validSshIds.has(id)) {
        this.sshHealthById.delete(id);
      }
    }
  }

  async handleRegistrySnapshot(snapshot: RegistrySnapshotView, diff?: RegistryDiff): Promise<void> {
    this.syncHealthPlaceholdersFromRegistry(snapshot);
    if (diff) {
      for (const change of diff.changes) {
        if (change.connectionId === "local") continue;
        if (change.kind === "connection_removed") {
          await this.removeConnection(change.connectionId);
          continue;
        }
        if (change.kind === "connection_updated") {
          if (!change.dialMaterialChanged) {
            // Label-only edit: update label without reconnecting!
            this.emitFleet(change.connectionId);
          } else {
            await this.connectSsh(change.connectionId, { forceReconnect: true });
          }
          continue;
        }
        if (change.kind === "connection_added") {
          const added = snapshot.connections.find((c) => c.id === change.connectionId);
          if (added?.kind === "ssh" && added.dialable) {
            await this.connectSsh(change.connectionId, { activateScope: false });
          }
        }
      }
    }
    this.emitFleet();
  }

  async removeConnection(connectionId: string): Promise<void> {
    if (connectionId === "local") return;
    for (const [key, entry] of [...this.transports.entries()]) {
      if (entry.connectionId === connectionId) {
        this.disposeTransportEntry(key, entry);
      }
    }
    await this.sshTransport?.disposeConnection(connectionId);
    this.sshTransport?.clearSessionPassphrase(connectionId);
    this.sshHealthById.delete(connectionId);
    this.profilesByConnection.delete(connectionId);
    for (const key of [...this.sessionsByScope.keys()]) {
      if (key.startsWith(`${connectionId}::`)) {
        this.sessionsByScope.delete(key);
      }
    }
    for (const key of [...this.transcripts.keys()]) {
      if (key.startsWith(`${connectionId}::`)) {
        this.transcripts.delete(key);
      }
    }
    if (this.activeScope?.connectionId === connectionId) {
      const localProfiles = this.profilesByConnection.get("local") ?? [];
      if (this.localHealth.actual === "ready" || localProfiles.length > 0) {
        const pid = localProfiles[0]?.profileId ?? "default";
        const localSessions = this.sessionsByScope.get(scopeKey("local", pid)) ?? [];
        const sid = localSessions[0]?.sessionId ?? null;
        this.activeScope = {
          connectionId: "local",
          profileId: pid,
          ...(sid ? { sessionId: sid } : {}),
        };
        this.activeSessionId = sid;
      } else {
        this.activeScope = null;
        this.activeSessionId = null;
      }
    }
    this.emitFleet();
  }

  private async ensureScopeTransport(
    connectionId: string,
    profileId: string,
    options?: { forceReconnect?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (!options?.forceReconnect) {
      const existing = this.getTransportForScope(connectionId, profileId);
      if (existing) {
        await this.refreshSessionsForProfile(existing, profileId);
        return { ok: true, fleet: this.getFleetSnapshot() };
      }
    }

    const inflightKey = options?.forceReconnect
      ? `retry:${connectionId}::${profileId}`
      : `${connectionId}::${profileId}`;
    const inflight = this.connectingByKey.get(inflightKey);
    if (inflight) {
      return inflight;
    }

    const runner =
      connectionId === "local"
        ? this.connectLocalInternal(profileId, options)
        : this.connectSshInternal(connectionId, profileId, options);

    const promise = runner.finally(() => {
      this.connectingByKey.delete(inflightKey);
    });
    this.connectingByKey.set(inflightKey, promise);
    return promise;
  }

  async connectLocal(
    profileId = "default",
    options?: { forceReconnect?: boolean },
  ): Promise<SupervisorConnectResult> {
    return this.ensureScopeTransport("local", profileId, options);
  }

  async connectSsh(
    connectionId: string,
    options?: { profileId?: string; forceReconnect?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    const info = this.getSshTargetForConnection(connectionId);
    const profileId = options?.profileId ?? info?.defaultProfile ?? "default";
    return this.ensureScopeTransport(connectionId, profileId, options);
  }

  private setHealth(connectionId: string, next: ConnectionHealthSummary): void {
    if (connectionId === "local") {
      this.localHealth = next;
    } else {
      this.sshHealthById.set(connectionId, next);
    }
  }

  private async connectLocalInternal(
    profileId: string,
    options?: { forceReconnect?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    if (options?.forceReconnect) {
      for (const [k, entry] of this.transports.entries()) {
        if (
          entry.connectionId === "local" &&
          (entry.transportMode === "shared-host-scope" ||
            k === `local::profile:${profileId}` ||
            !entry.client.isOpen())
        ) {
          this.disposeTransportEntry(k, entry);
        }
      }
    }

    this.localHealth = {
      ...this.localHealth,
      label: this.getLocalLabel(),
      actual: "connecting",
      degraded: false,
      errorCode: undefined,
      message: undefined,
      nextRetryAt: null,
    };
    this.emitFleet("local");

    const startedAt = Date.now();
    const dialResult = await this.localBackend.prepareDial({ profileId });
    if (!dialResult.ok) {
      this.localHealth = {
        ...this.localHealth,
        label: this.getLocalLabel(),
        actual: dialResult.inspection.actual === "reconnecting" ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        errorCode: mapLocalFailureToErrorCode(dialResult.failure),
        message: getLocalFailureCopy(dialResult.failure.code).whatHappened,
      };
      this.emitFleet("local");
      return {
        ok: false,
        failure: dialResult.failure,
        fleet: this.getFleetSnapshot(),
      };
    }

    const dial = dialResult.dial;
    const transportKey =
      dial.transportMode === "shared-host-scope"
        ? "local::shared"
        : `local::profile:${dial.profileId}`;

    let ticket = dial.consumeTicket();
    if (!ticket) {
      const minted = await this.localBackend.mintReconnectTicket(dial);
      if (!minted.ok) {
        this.localHealth = {
          ...this.localHealth,
          label: this.getLocalLabel(),
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          errorCode: mapLocalFailureToErrorCode(minted.failure),
          message: getLocalFailureCopy(minted.failure.code).whatHappened,
        };
        this.emitFleet("local");
        return {
          ok: false,
          failure: minted.failure,
          fleet: this.getFleetSnapshot(),
        };
      }
      ticket = minted.consumeTicket();
    }

    if (!ticket) {
      this.localHealth = {
        ...this.localHealth,
        label: this.getLocalLabel(),
        actual: "blocked",
        degraded: true,
        errorCode: "auth_failed",
      };
      this.emitFleet("local");
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    return this.finishGatewayHandshake({
      connectionId: "local",
      kind: "local",
      label: this.getLocalLabel(),
      originDisplay: "127.0.0.1",
      transportKey,
      dial,
      ticket,
      startedAt,
      activateScope: options?.activateScope,
    });
  }

  private async connectSshInternal(
    connectionId: string,
    profileId: string,
    options?: { forceReconnect?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed || !this.sshTransport) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const info = this.getSshTargetForConnection(connectionId);
    if (!info) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    if (options?.forceReconnect) {
      for (const [k, entry] of [...this.transports.entries()]) {
        if (entry.connectionId === connectionId) {
          this.disposeTransportEntry(k, entry);
        }
      }
      await this.sshTransport.disposeConnection(connectionId);
    }

    this.setHealth(connectionId, {
      connectionId,
      label: info.label,
      kind: "ssh",
      originDisplay: info.sshTargetDisplay,
      actual: "connecting",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
    });
    this.emitFleet(connectionId);

    const startedAt = Date.now();
    const dialResult = await this.sshTransport.prepareDial(info.target, profileId);
    if (!dialResult.ok) {
      this.setHealth(connectionId, {
        connectionId,
        label: info.label,
        kind: "ssh",
        originDisplay: info.sshTargetDisplay,
        actual: dialResult.status === "blocked" ? "blocked" : "reconnecting",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: mapSshFailureToErrorCode(dialResult.failureCode),
        message: dialResult.message,
      });
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const dial = dialResult.dial;
    const transportKey =
      dial.transportMode === "shared-host-scope"
        ? `${connectionId}::shared`
        : `${connectionId}::profile:${dial.profileId}`;

    let ticket = dial.consumeTicket();
    if (!ticket) {
      const minted = await this.sshTransport.mintReconnectTicket(
        connectionId,
        info.target,
        dial.profileId,
        dial.instanceId,
      );
      if (!minted.ok) {
        this.setHealth(connectionId, {
          connectionId,
          label: info.label,
          kind: "ssh",
          originDisplay: info.sshTargetDisplay,
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: mapSshFailureToErrorCode(minted.failureCode),
          message: minted.message,
        });
        this.emitFleet(connectionId);
        return { ok: false, fleet: this.getFleetSnapshot() };
      }
      dial.wsUrl = minted.wsUrl;
      ticket = minted.consumeTicket();
    }

    if (!ticket) {
      this.setHealth(connectionId, {
        connectionId,
        label: info.label,
        kind: "ssh",
        originDisplay: info.sshTargetDisplay,
        actual: "blocked",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: "auth_failed",
      });
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    return this.finishGatewayHandshake({
      connectionId,
      kind: "ssh",
      label: info.label,
      originDisplay: info.sshTargetDisplay,
      transportKey,
      dial,
      ticket,
      startedAt,
      activateScope: options?.activateScope,
    });
  }

  private async finishGatewayHandshake(params: {
    connectionId: string;
    kind: "local" | "ssh";
    label: string;
    originDisplay: string;
    transportKey: string;
    dial: DialMaterial;
    ticket: string;
    startedAt: number;
    activateScope?: boolean;
  }): Promise<SupervisorConnectResult> {
    const { connectionId, kind, label, originDisplay, transportKey, dial, startedAt } = params;
    let ticket: string | null = params.ticket;

    let client: GatewayClient;
    try {
      client = await GatewayClient.connect({
        wsUrl: dial.wsUrl,
        ticket,
        ticketProtocolPrefix: dial.ticketProtocolPrefix,
        connectTimeoutMs: 10_000,
      });
    } catch (err) {
      const errCode: ErrorCode = err instanceof GatewayTransportError ? err.code : "unreachable";
      this.setHealth(connectionId, {
        connectionId,
        label,
        kind,
        originDisplay,
        actual: errCode === "timeout" ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: errCode,
      });
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    } finally {
      // Clear local reference immediately after handshake
      ticket = null;
    }

    // Negotiate runtime capabilities & server_requests
    let describeRes: Record<string, unknown> | undefined;
    try {
      describeRes = await client.call<Record<string, unknown>>("runtime.describe", {});
    } catch (err) {
      if (!isJsonRpcMethodNotFound(err)) {
        client.close();
        this.setHealth(connectionId, {
          connectionId,
          label,
          kind,
          originDisplay,
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: "protocol_unsupported",
        });
        this.emitFleet(connectionId);
        return { ok: false, fleet: this.getFleetSnapshot() };
      }
    }

    const capabilities = classifyRuntimeCapabilities(describeRes);
    const supportedActions = toSupportedChatActions(capabilities);

    let capabilitiesReported = false;
    try {
      await client.call("client.capabilities", { server_requests: true });
      capabilitiesReported = true;
    } catch {
      // Non-fatal
    }

    let subscribedToGateway = false;
    try {
      await client.call("subscribe", {
        topics: ["session.transcript", "prompt", "activity", "sessions", "profiles"],
      });
      subscribedToGateway = true;
    } catch {
      // Optional
    }

    const entry: GatewayTransportEntry = {
      key: transportKey,
      connectionId,
      kind,
      transportMode: dial.transportMode,
      client,
      dial,
      capabilities,
      supportedActions,
      capabilitiesReported,
      subscribedToGateway,
      disposed: false,
      unsubNotification: () => {},
      unsubClose: () => {},
    };

    entry.unsubNotification = client.onNotification((method, notifParams) => {
      this.handleGatewayNotification(entry, method, notifParams);
    });

    entry.unsubClose = client.onClose((reason) => {
      if (this.disposed || entry.disposed || reason === "client_closed") return;
      this.disposeTransportEntry(transportKey, entry);
      const hasRemaining = [...this.transports.values()].some(
        (t) => t.connectionId === connectionId && !t.disposed && t.client.isOpen(),
      );
      if (!hasRemaining) {
        this.setHealth(connectionId, {
          connectionId,
          label: connectionId === "local" ? this.getLocalLabel() : label,
          kind,
          originDisplay,
          actual: "reconnecting",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: "unreachable",
        });
        this.emitFleet(connectionId);
      }

      if (kind === "ssh" && this.sshTransport) {
        void this.reconnectSshAfterDrop(connectionId, entry.dial.profileId, entry.dial.instanceId);
      }
    });

    const previous = this.transports.get(transportKey);
    if (previous) {
      this.disposeTransportEntry(transportKey, previous);
    }
    this.transports.set(transportKey, entry);

    const latencyMs = Math.max(1, Date.now() - startedAt);
    this.setHealth(connectionId, {
      connectionId,
      label: connectionId === "local" ? this.getLocalLabel() : label,
      kind,
      originDisplay,
      actual: "ready",
      degraded: false,
      latencyMs,
      nextRetryAt: null,
    });

    await this.refreshProfiles(entry, dial.profileId);
    const sessions = await this.refreshSessionsForProfile(entry, dial.profileId);

    const shouldActivate =
      Boolean(params.activateScope) ||
      !this.activeScope ||
      (connectionId === "local" && this.activeScope.connectionId === "local");
    if (shouldActivate && (!this.activeScope || params.activateScope)) {
      const initialSessionId = sessions[0]?.sessionId ?? null;
      this.activeScope = {
        connectionId,
        profileId: dial.profileId,
        ...(initialSessionId ? { sessionId: initialSessionId } : {}),
      };
      this.activeSessionId = initialSessionId;
    }

    if (
      this.activeSessionId &&
      this.activeScope?.connectionId === connectionId &&
      this.activeScope?.profileId === dial.profileId
    ) {
      await this.loadTranscriptSnapshot(entry, dial.profileId, this.activeSessionId);
    }

    this.emitFleet(connectionId);
    return {
      ok: true,
      fleet: this.getFleetSnapshot(),
    };
  }

  private async reconnectSshAfterDrop(
    connectionId: string,
    profileId: string,
    instanceId: string,
  ): Promise<void> {
    if (this.disposed || !this.sshTransport) return;
    const info = this.getSshTargetForConnection(connectionId);
    if (!info) return;

    const inflightKey = `ssh-drop:${connectionId}::${profileId}`;
    if (this.connectingByKey.has(inflightKey)) return;

    const runner = (async (): Promise<SupervisorConnectResult> => {
      const startedAt = Date.now();
      const minted = await this.sshTransport!.mintReconnectTicket(
        connectionId,
        info.target,
        profileId,
        instanceId,
      );
      if (!minted.ok) {
        this.setHealth(connectionId, {
          connectionId,
          label: info.label,
          kind: "ssh",
          originDisplay: info.sshTargetDisplay,
          actual: "reconnecting",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: mapSshFailureToErrorCode(minted.failureCode),
          message: minted.message,
        });
        this.emitFleet(connectionId);
        return { ok: false, fleet: this.getFleetSnapshot() };
      }

      const ticket = minted.consumeTicket();
      if (!ticket) {
        return { ok: false, fleet: this.getFleetSnapshot() };
      }

      const dial: SshDialMaterial = {
        connectionId,
        profileId,
        instanceId,
        authorityEpoch: 1,
        wsUrl: minted.wsUrl,
        wsProtocol: "hermes-gateway-v1",
        ticketProtocolPrefix: "hermes-gateway-ticket.",
        transportMode: "shared-host-scope",
        endpointCapabilities: ["session-authority-v1"],
        expiresAt: minted.expiresAt,
        consumeTicket: () => null,
      };
      const transportKey = `${connectionId}::shared`;
      return this.finishGatewayHandshake({
        connectionId,
        kind: "ssh",
        label: info.label,
        originDisplay: info.sshTargetDisplay,
        transportKey,
        dial,
        ticket,
        startedAt,
      });
    })().finally(() => {
      this.connectingByKey.delete(inflightKey);
    });

    this.connectingByKey.set(inflightKey, runner);
    await runner;
  }

  private disposeTransportEntry(key: string, entry: GatewayTransportEntry): void {
    entry.disposed = true;
    entry.unsubNotification();
    entry.unsubClose();
    entry.client.close();
    if (this.transports.get(key) === entry) {
      this.transports.delete(key);
    }
  }

  private async refreshProfiles(
    entry: GatewayTransportEntry,
    activeProfileId: string,
  ): Promise<ProfileSummary[]> {
    const connectionId = entry.connectionId;
    let rawProfiles: Array<Record<string, unknown>> = [];
    if (entry.capabilities.profilesList) {
      try {
        const res = await entry.client.call<{ profiles?: Array<Record<string, unknown>> }>(
          "profiles.list",
          {},
        );
        if (Array.isArray(res?.profiles)) {
          rawProfiles = res.profiles;
        }
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          entry.capabilities.profilesList = false;
        }
      }
    }

    const current = this.profilesByConnection.get(connectionId) ?? [];
    let updated: ProfileSummary[];
    if (rawProfiles.length === 0) {
      const hasExisting = current.some((p) => p.profileId === activeProfileId);
      updated = hasExisting
        ? current
        : [
            ...current,
            {
              connectionId,
              profileId: activeProfileId,
              displayName: activeProfileId === "default" ? "Default" : activeProfileId,
              handle: activeProfileId,
              isDefault: activeProfileId === "default",
              actual: "ready",
            },
          ];
    } else {
      const existingById = new Map(current.map((p) => [p.profileId, p]));
      for (const raw of rawProfiles) {
        const pid = asString(raw.profile_id ?? raw.profileId ?? raw.id).trim();
        if (!pid) continue;
        const displayName = asString(raw.display_name ?? raw.displayName, pid) || pid;
        const handle = asString(raw.handle, pid) || pid;
        const isDefault = Boolean(raw.is_default ?? raw.isDefault ?? pid === "default");
        existingById.set(pid, {
          connectionId,
          profileId: pid,
          displayName,
          handle,
          isDefault,
          actual: pid === activeProfileId ? "ready" : existingById.get(pid)?.actual ?? "idle",
        });
      }
      updated = [...existingById.values()];
    }

    this.profilesByConnection.set(connectionId, updated);
    this.emitProfiles(connectionId);
    return [...updated];
  }

  private async refreshSessionsForProfile(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<SessionSummary[]> {
    const connectionId = entry.connectionId;
    let rawList: Array<Record<string, unknown>> = [];
    const callList = async (method: string) => {
      const res = await entry.client.call<{ sessions?: Array<Record<string, unknown>> }>(method, {
        profile_id: profileId,
      });
      return Array.isArray(res?.sessions) ? res.sessions : [];
    };

    if (entry.capabilities.sessionList) {
      try {
        rawList = await callList("session.list");
      } catch (err) {
        try {
          rawList = await callList("sessions.list");
        } catch (err2) {
          if (isJsonRpcMethodNotFound(err2)) {
            entry.capabilities.sessionList = false;
          }
        }
      }
    }

    const mapped = rawList
      .map((item) => mapRawSession(item, connectionId, profileId))
      .filter((item): item is SessionSummary => item !== null && item.profileId === profileId);

    this.sessionsByScope.set(scopeKey(connectionId, profileId), mapped);
    this.emitSessions(connectionId, profileId);
    return mapped;
  }

  private buildInitialTranscriptSnapshot(
    entry: GatewayTransportEntry,
    profileId: string,
    sessionId: string,
  ): SessionTranscriptSnapshot {
    const chatAvailable = entry.supportedActions.promptSubmit;
    return {
      connectionId: entry.connectionId,
      profileId,
      sessionId,
      messages: [],
      activeTurnId: null,
      turnStopping: false,
      chatAvailable,
      ...(chatAvailable ? {} : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      supportedActions: { ...entry.supportedActions },
    };
  }

  private async loadTranscriptSnapshot(
    entry: GatewayTransportEntry,
    profileId: string,
    sessionId: string,
  ): Promise<SessionTranscriptSnapshot> {
    const connectionId = entry.connectionId;
    const key = transcriptKey(connectionId, profileId, sessionId);
    const existing = this.transcripts.get(key);
    let rawResult: Record<string, unknown> | null = null;

    if (entry.supportedActions.sessionResume) {
      try {
        rawResult = await entry.client.call<Record<string, unknown>>("session.resume", {
          profile_id: profileId,
          session_id: sessionId,
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          entry.supportedActions.sessionResume = false;
        }
      }
    }

    if (!rawResult && entry.capabilities.sessionTranscript) {
      try {
        rawResult = await entry.client.call<Record<string, unknown>>("session.transcript", {
          profile_id: profileId,
          session_id: sessionId,
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          entry.capabilities.sessionTranscript = false;
        }
      }
    }

    const base = existing ?? this.buildInitialTranscriptSnapshot(entry, profileId, sessionId);
    const gatewayMessagesRaw = Array.isArray(rawResult?.messages)
      ? (rawResult.messages as Array<Record<string, unknown>>)
      : [];
    const gatewayMessages = gatewayMessagesRaw
      .map((m) => mapRawMessage(m, sessionId))
      .filter((m): m is TranscriptMessage => m !== null);

    const mergedById = new Map<string, TranscriptMessage>();
    for (const gm of gatewayMessages) {
      mergedById.set(gm.messageId, gm);
    }
    for (const localMsg of base.messages) {
      const fromGw = mergedById.get(localMsg.messageId);
      if (!fromGw) {
        mergedById.set(localMsg.messageId, localMsg);
      } else {
        mergedById.set(localMsg.messageId, {
          ...fromGw,
          text: localMsg.text.length >= fromGw.text.length ? localMsg.text : fromGw.text,
          toolRows: localMsg.toolRows ?? fromGw.toolRows,
          streaming: localMsg.streaming ?? fromGw.streaming,
          status: localMsg.status ?? fromGw.status,
          turnId: localMsg.turnId ?? fromGw.turnId,
        });
      }
    }

    const gwTurnId =
      rawResult && typeof (rawResult.active_turn_id ?? rawResult.activeTurnId) === "string"
        ? String(rawResult.active_turn_id ?? rawResult.activeTurnId)
        : null;

    const merged: SessionTranscriptSnapshot = {
      ...base,
      connectionId,
      profileId,
      sessionId,
      messages: [...mergedById.values()],
      activeTurnId: base.activeTurnId ?? gwTurnId,
      chatAvailable: entry.supportedActions.promptSubmit,
      ...(entry.supportedActions.promptSubmit
        ? {}
        : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      supportedActions: { ...entry.supportedActions },
    };

    this.transcripts.set(key, merged);
    this.emitTopic(
      "session.transcript",
      { connectionId, profileId, sessionId },
      "snapshot",
      merged,
      (sub) =>
        Boolean(
          sub.scope &&
            sub.scope.connectionId === connectionId &&
            (sub.scope.profileId ?? "default") === profileId &&
            sub.scope.sessionId === sessionId,
        ),
    );
    return merged;
  }

  private applyPatchToTranscript(
    entry: GatewayTransportEntry,
    profileId: string,
    sessionId: string,
    patch: TranscriptPatchPayload,
  ): void {
    const connectionId = entry.connectionId;
    const key = transcriptKey(connectionId, profileId, sessionId);
    const current =
      this.transcripts.get(key) ?? this.buildInitialTranscriptSnapshot(entry, profileId, sessionId);

    const next = reduceTranscriptEvent(current, {
      topic: "session.transcript",
      scope: { connectionId, profileId, sessionId },
      kind: "patch",
      seq: 1,
      revision: this.revision,
      payload: patch,
    });
    if (next) {
      this.transcripts.set(key, next);
    }
    this.emitTranscriptPatch(connectionId, profileId, sessionId, patch);
  }

  private downgradeSingleAction(
    entry: GatewayTransportEntry,
    action: keyof SupportedChatActions,
  ): void {
    if (!entry.supportedActions[action]) return;
    entry.supportedActions = {
      ...entry.supportedActions,
      [action]: false,
    };
    const chatAvailable = entry.supportedActions.promptSubmit;
    for (const [key, snap] of this.transcripts.entries()) {
      if (snap.connectionId !== entry.connectionId) continue;
      const updated: SessionTranscriptSnapshot = {
        ...snap,
        chatAvailable,
        supportedActions: { ...entry.supportedActions },
        ...(chatAvailable
          ? {}
          : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      };
      this.transcripts.set(key, updated);
      this.emitTranscriptPatch(snap.connectionId, snap.profileId, snap.sessionId, {
        type: "capabilities_update",
        sessionId: snap.sessionId,
        chatAvailable,
        supportedActions: { ...entry.supportedActions },
        ...(chatAvailable
          ? {}
          : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      });
    }
  }

  private handleGatewayNotification(
    entry: GatewayTransportEntry,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const connectionId = entry.connectionId;
    const sessionId = asString(params.session_id ?? params.sessionId).trim();
    const profileId =
      asString(params.profile_id ?? params.profileId, entry.dial.profileId).trim() ||
      entry.dial.profileId;
    const resolvedProfileId = this.findProfileIdForSession(connectionId, sessionId) ?? profileId;

    if (!sessionId) return;

    if (method === "prompt.delta" || method === "prompt.token") {
      const messageId = asString(params.message_id ?? params.messageId, `assistant-${Date.now()}`);
      const turnId = asString(params.turn_id ?? params.turnId) || undefined;
      const delta = asString(params.delta ?? params.text, "");
      this.applyPatchToTranscript(entry, resolvedProfileId, sessionId, {
        type: "token_delta",
        sessionId,
        turnId,
        messageId,
        delta,
      });
      const promptPayload: PromptEventPayload = {
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        turnId: turnId ?? "",
        kind: "delta",
        delta,
        messageId,
      };
      this.emitTopic(
        "prompt",
        { connectionId, profileId: resolvedProfileId, sessionId },
        "patch",
        promptPayload,
      );
      return;
    }

    if (method === "activity" || method === "tool.execution" || method === "tool.call") {
      const rawTool = (
        params.tool_row && typeof params.tool_row === "object" ? params.tool_row : params
      ) as Record<string, unknown>;
      const toolRow: ToolExecutionRow = {
        toolCallId: asString(
          rawTool.tool_call_id ?? rawTool.toolCallId ?? rawTool.id,
          `tc-${Date.now()}`,
        ),
        name: asString(rawTool.name ?? rawTool.tool, "tool"),
        status:
          rawTool.status === "completed" ||
          rawTool.status === "failed" ||
          rawTool.status === "cancelled"
            ? rawTool.status
            : "running",
        summary: typeof rawTool.summary === "string" ? rawTool.summary : undefined,
        durationMs: typeof rawTool.duration_ms === "number" ? rawTool.duration_ms : undefined,
      };
      const turnId = asString(params.turn_id ?? params.turnId) || undefined;
      const messageId = asString(params.message_id ?? params.messageId) || undefined;
      this.applyPatchToTranscript(entry, resolvedProfileId, sessionId, {
        type: "tool_row",
        sessionId,
        turnId,
        messageId,
        toolRow,
      });
      const activityPayload: ActivityEventPayload = {
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        turnId,
        toolRow,
      };
      this.emitTopic(
        "activity",
        { connectionId, profileId: resolvedProfileId, sessionId },
        "patch",
        activityPayload,
      );
      return;
    }

    if (
      method === "prompt.completed" ||
      method === "prompt.done" ||
      method === "prompt.stopped" ||
      method === "prompt.error"
    ) {
      const turnId = asString(params.turn_id ?? params.turnId, "");
      const messageId = asString(params.message_id ?? params.messageId) || undefined;
      const status: TranscriptMessage["status"] =
        method === "prompt.stopped"
          ? "stopped"
          : method === "prompt.error"
            ? "error"
            : "complete";
      this.applyPatchToTranscript(entry, resolvedProfileId, sessionId, {
        type: "turn_state",
        sessionId,
        activeTurnId: null,
        turnStopping: false,
        messageId,
        status,
      });
      const kind: PromptEventPayload["kind"] =
        method === "prompt.stopped"
          ? "stopped"
          : method === "prompt.error"
            ? "error"
            : "completed";
      this.emitTopic("prompt", { connectionId, profileId: resolvedProfileId, sessionId }, "patch", {
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        turnId,
        kind,
        messageId,
      } satisfies PromptEventPayload);
    }
  }

  private findProfileIdForSession(connectionId: string, sessionId: string): string | null {
    if (!sessionId) return null;
    for (const [k, list] of this.sessionsByScope.entries()) {
      if (!k.startsWith(`${connectionId}::`)) continue;
      const hit = list.find((s) => s.sessionId === sessionId);
      if (hit) return hit.profileId;
    }
    return null;
  }

  private resolveTargetConnectionId(
    payload: Record<string, unknown>,
    scope: BridgeScope | null,
  ): string {
    if (typeof payload.connectionId === "string" && payload.connectionId.trim()) {
      return payload.connectionId.trim();
    }
    if (scope?.connectionId && scope.connectionId.trim()) {
      return scope.connectionId.trim();
    }
    if (this.activeScope?.connectionId && this.activeScope.connectionId.trim()) {
      return this.activeScope.connectionId.trim();
    }
    return "local";
  }

  private resolveTargetProfile(
    payload: Record<string, unknown>,
    scope: BridgeScope | null,
    connectionId: string,
  ): string {
    if (typeof payload.profileId === "string" && payload.profileId.trim()) {
      return payload.profileId.trim();
    }
    if (scope?.profileId && scope.profileId.trim()) {
      return scope.profileId.trim();
    }
    if (
      this.activeScope?.connectionId === connectionId &&
      this.activeScope?.profileId &&
      this.activeScope.profileId.trim()
    ) {
      return this.activeScope.profileId.trim();
    }
    if (connectionId !== "local") {
      const sshInfo = this.getSshTargetForConnection(connectionId);
      if (sshInfo?.defaultProfile) return sshInfo.defaultProfile;
    }
    return "default";
  }

  private resolveTargetSessionId(
    payload: Record<string, unknown>,
    scope: BridgeScope | null,
    connectionId: string,
  ): string | null {
    if (typeof payload.sessionId === "string" && payload.sessionId.trim()) {
      return payload.sessionId.trim();
    }
    if (scope?.sessionId && scope.sessionId.trim()) {
      return scope.sessionId.trim();
    }
    if (this.activeScope?.connectionId === connectionId) {
      return this.activeSessionId;
    }
    return null;
  }

  private requireTransport(connectionId: string, profileId: string): GatewayTransportEntry {
    const entry = this.getTransportForScope(connectionId, profileId);
    if (!entry) {
      throw makeBridgeError("unreachable", "目标 Gateway 尚未就绪");
    }
    return entry;
  }

  private translateRpcFailure(
    entry: GatewayTransportEntry,
    err: unknown,
    singleAction?: keyof SupportedChatActions,
  ): never {
    if (isJsonRpcMethodNotFound(err)) {
      if (singleAction) {
        this.downgradeSingleAction(entry, singleAction);
      }
      throw makeBridgeError("capability_unavailable", "当前 Gateway 未提供此能力");
    }
    if (err instanceof GatewayTransportError) {
      throw makeBridgeError(err.code, "Gateway 连接中断或超时");
    }
    if (err instanceof GatewayRpcError) {
      throw makeBridgeError("internal", "Gateway 执行请求失败");
    }
    throw makeBridgeError("internal", "请求失败");
  }

  subscribe(
    topic: BridgeEvent["topic"],
    scope: BridgeScope | null,
    listener: (event: BridgeEvent) => void,
  ): () => void {
    this.subscriberSeq += 1;
    const id = this.subscriberSeq;
    const record: SubscriberRecord = {
      id,
      topic,
      scope,
      seq: 0,
      listener,
    };
    this.subscribers.set(id, record);

    queueMicrotask(() => {
      if (!this.subscribers.has(id)) return;
      const rev = this.revision;
      if (topic === "fleet") {
        listener({
          topic,
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.getFleetSnapshot(),
        });
      } else if (topic === "connection.health") {
        const cid = scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
        listener({
          topic,
          scope: { connectionId: cid },
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.getConnectionHealth(cid) ?? this.getLocalHealth(),
        });
      } else if (topic === "profiles") {
        const cid = scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
        listener({
          topic,
          scope: { connectionId: cid },
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: { profiles: [...(this.profilesByConnection.get(cid) ?? [])] },
        });
      } else if (topic === "sessions") {
        const cid = scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
        const pid = scope?.profileId ?? this.activeScope?.profileId ?? "default";
        const list = this.sessionsByScope.get(scopeKey(cid, pid)) ?? [];
        listener({
          topic,
          scope: { connectionId: cid, profileId: pid },
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: { sessions: [...list] },
        });
      } else if (topic === "session.transcript") {
        const cid = scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
        const pid = scope?.profileId ?? this.activeScope?.profileId ?? "default";
        const sid = scope?.sessionId ?? this.activeSessionId;
        const existing = sid ? this.transcripts.get(transcriptKey(cid, pid, sid)) : null;
        const transport = this.getTransportForScope(cid, pid);
        const snap: SessionTranscriptSnapshot =
          existing ??
          (transport && sid
            ? this.buildInitialTranscriptSnapshot(transport, pid, sid)
            : {
                connectionId: cid,
                profileId: pid,
                sessionId: sid ?? "",
                messages: [],
                activeTurnId: null,
                turnStopping: false,
                chatAvailable: false,
                supportedActions: defaultChatActions(),
              });
        listener({
          topic,
          scope: { connectionId: cid, profileId: pid, ...(sid ? { sessionId: sid } : {}) },
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: snap,
        });
      }
    });

    return () => {
      this.subscribers.delete(id);
    };
  }

  readonly handlers: Record<
    | "connections.retry"
    | "profiles.list"
    | "sessions.list"
    | "sessions.create"
    | "sessions.select"
    | "sessions.resume"
    | "prompts.send"
    | "prompts.stop"
    | "prompts.steer",
    HostCommandHandler
  > = {
    "connections.retry": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      if (connectionId !== "local") {
        const res = await this.connectSsh(connectionId, {
          profileId,
          forceReconnect: true,
        });
        return {
          ok: res.ok,
          fleet: res.fleet,
          failure: res.failure ?? null,
        };
      }
      const res = await this.connectLocal(profileId, { forceReconnect: true });
      const inspection: LocalInspectResult = await this.localBackend.inspect();
      return {
        ok: res.ok,
        fleet: res.fleet,
        inspection,
        failure: res.failure ?? null,
      };
    },

    "profiles.list": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.getTransportForScope(connectionId, profileId);
      if (!entry) {
        return { profiles: [...(this.profilesByConnection.get(connectionId) ?? [])] };
      }
      const profiles = await this.refreshProfiles(entry, profileId);
      return { profiles };
    },

    "sessions.list": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.getTransportForScope(connectionId, profileId);
      if (!entry) {
        return { sessions: this.sessionsByScope.get(scopeKey(connectionId, profileId)) ?? [] };
      }
      const sessions = await this.refreshSessionsForProfile(entry, profileId);
      this.emitFleet(connectionId);
      return { sessions };
    },

    "sessions.select": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId ?? null;

      await this.ensureScopeTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      const sessions = await this.refreshSessionsForProfile(entry, profileId);
      const resolvedSessionId = sessionId ?? sessions[0]?.sessionId ?? null;

      this.activeScope = {
        connectionId,
        profileId,
        ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      };
      this.activeSessionId = resolvedSessionId;

      let transcript: SessionTranscriptSnapshot | null = null;
      if (resolvedSessionId) {
        transcript = await this.loadTranscriptSnapshot(entry, profileId, resolvedSessionId);
      }
      this.emitFleet(connectionId);
      return {
        fleet: this.getFleetSnapshot(),
        transcript,
      };
    },

    "sessions.create": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      await this.ensureScopeTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.sessionCreate) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持新建 Session");
      }

      const title =
        typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "新对话";

      let res: Record<string, unknown>;
      try {
        res = await entry.client.call<Record<string, unknown>>("session.create", {
          profile_id: profileId,
          title,
        });
      } catch (err) {
        this.translateRpcFailure(entry, err, "sessionCreate");
      }

      const rawSession =
        res.session && typeof res.session === "object"
          ? (res.session as Record<string, unknown>)
          : res;
      const created =
        mapRawSession(rawSession, connectionId, profileId) ?? {
          connectionId,
          profileId,
          sessionId: `sess-${Date.now()}`,
          title,
          preview: "",
          updatedAt: new Date().toISOString(),
          pinned: false,
          unreadCount: 0,
          needsInput: false,
          activeTurnId: null,
          status: "idle" as const,
        };

      const key = scopeKey(connectionId, profileId);
      const existingList = this.sessionsByScope.get(key) ?? [];
      const nextList = [created, ...existingList.filter((s) => s.sessionId !== created.sessionId)];
      this.sessionsByScope.set(key, nextList);

      this.activeScope = {
        connectionId,
        profileId,
        sessionId: created.sessionId,
      };
      this.activeSessionId = created.sessionId;

      const snapshot = this.buildInitialTranscriptSnapshot(entry, profileId, created.sessionId);
      this.transcripts.set(transcriptKey(connectionId, profileId, created.sessionId), snapshot);

      this.emitSessions(connectionId, profileId);
      this.emitTopic(
        "session.transcript",
        { connectionId, profileId, sessionId: created.sessionId },
        "snapshot",
        snapshot,
        (sub) =>
          Boolean(
            sub.scope &&
              sub.scope.connectionId === connectionId &&
              (sub.scope.profileId ?? "default") === profileId &&
              sub.scope.sessionId === created.sessionId,
          ),
      );
      this.emitFleet(connectionId);
      return { session: created, transcript: snapshot, fleet: this.getFleetSnapshot() };
    },

    "sessions.resume": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      if (!sessionId) {
        throw makeBridgeError("invalid_request", "缺少目标 Session");
      }
      await this.ensureScopeTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      const transcript = await this.loadTranscriptSnapshot(entry, profileId, sessionId);
      return { transcript };
    },

    "prompts.send": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", "请输入对话内容后再发送");
      }

      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptSubmit) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持发送对话");
      }

      let res: Record<string, unknown>;
      try {
        res = await entry.client.call<Record<string, unknown>>("prompt.submit", {
          profile_id: profileId,
          session_id: sessionId,
          text,
        });
      } catch (err) {
        this.translateRpcFailure(entry, err, "promptSubmit");
      }

      const turnId = asString(res.turn_id ?? res.turnId, `turn-${Date.now()}`);
      const userMsgId = asString(res.user_message_id ?? res.userMessageId, `user-${Date.now()}`);
      const assistantMsgId = asString(
        res.assistant_message_id ?? res.assistantMessageId,
        `assistant-${Date.now()}`,
      );
      const nowIso = new Date().toISOString();

      this.applyPatchToTranscript(entry, profileId, sessionId, {
        type: "message_upsert",
        sessionId,
        message: {
          messageId: userMsgId,
          sessionId,
          role: "user",
          text,
          createdAt: nowIso,
          turnId,
          status: "complete",
        },
      });
      this.applyPatchToTranscript(entry, profileId, sessionId, {
        type: "message_upsert",
        sessionId,
        message: {
          messageId: assistantMsgId,
          sessionId,
          role: "assistant",
          text: "",
          createdAt: nowIso,
          turnId,
          streaming: true,
          status: "streaming",
        },
      });
      this.applyPatchToTranscript(entry, profileId, sessionId, {
        type: "turn_state",
        sessionId,
        activeTurnId: turnId,
        turnStopping: false,
        messageId: assistantMsgId,
        status: "streaming",
      });

      this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
        connectionId,
        profileId,
        sessionId,
        turnId,
        kind: "accepted",
        messageId: assistantMsgId,
      } satisfies PromptEventPayload);

      return {
        accepted: true,
        sessionId,
        turnId,
        userMessageId: userMsgId,
        assistantMessageId: assistantMsgId,
      };
    },

    "prompts.stop": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const existing = sessionId
        ? this.transcripts.get(transcriptKey(connectionId, profileId, sessionId))
        : null;
      const turnId =
        typeof payload.turnId === "string" && payload.turnId.trim()
          ? payload.turnId.trim()
          : existing?.activeTurnId ?? "";

      if (!sessionId || !turnId) {
        throw makeBridgeError("unknown_turn", "当前没有可停止的 Turn");
      }

      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptCancel) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持停止当前 Turn");
      }

      this.applyPatchToTranscript(entry, profileId, sessionId, {
        type: "turn_state",
        sessionId,
        activeTurnId: turnId,
        turnStopping: true,
      });

      let res: Record<string, unknown>;
      try {
        res = await entry.client.call<Record<string, unknown>>("prompt.cancel", {
          profile_id: profileId,
          session_id: sessionId,
          turn_id: turnId,
        });
      } catch (err) {
        this.applyPatchToTranscript(entry, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: false,
        });
        this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
          connectionId,
          profileId,
          sessionId,
          turnId,
          kind: "stop_failed",
        } satisfies PromptEventPayload);
        this.translateRpcFailure(entry, err, "promptCancel");
      }

      if (res?.stopped === false) {
        this.applyPatchToTranscript(entry, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: false,
        });
        this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
          connectionId,
          profileId,
          sessionId,
          turnId,
          kind: "stop_failed",
        } satisfies PromptEventPayload);
        throw makeBridgeError("internal", "Gateway 未确认停止 Turn");
      }

      this.applyPatchToTranscript(entry, profileId, sessionId, {
        type: "turn_state",
        sessionId,
        activeTurnId: null,
        turnStopping: false,
        status: "stopped",
      });
      this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
        connectionId,
        profileId,
        sessionId,
        turnId,
        kind: "stopped",
      } satisfies PromptEventPayload);
      return { stopped: true, sessionId, turnId };
    },

    "prompts.steer": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", "缺少补充指令内容");
      }
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptSteer) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持中途纠偏");
      }
      try {
        return await entry.client.call("session.steer", {
          profile_id: profileId,
          session_id: sessionId,
          ...(turnId ? { turn_id: turnId } : {}),
          text,
        });
      } catch (err) {
        this.translateRpcFailure(entry, err, "promptSteer");
      }
    },
  };

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [key, entry] of this.transports.entries()) {
      this.disposeTransportEntry(key, entry);
    }
    this.transports.clear();
    this.subscribers.clear();
    await this.sshTransport?.disposeAll();
  }
}

export { ConnectionSupervisor as LocalConnectionSupervisor };
