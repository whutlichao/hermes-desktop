import type {
  ActivityEventPayload,
  ActiveChatRef,
  BridgeEvent,
  BridgeScope,
  CapabilityDomainId,
  CapabilitySnapshot,
  ChatSessionProjection,
  ConnectionHealthSummary,
  ErrorCode,
  FleetSnapshot,
  GatewayConfigSnapshot,
  GatewayConfigUpdateResult,
  GatewayConfigValue,
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
  CAPABILITY_DOMAIN_CATALOG,
  CORE_CAPABILITY_DOMAINS,
  CapabilityRegistry,
  classifyRuntimeCapabilities,
  getCopy,
  getLocalFailureCopy,
  isAllowedGatewayConfigKey,
  isJsonRpcMethodNotFound,
  reduceTranscriptEvent,
  resolveExplicitMethodAlias,
  toSupportedChatActions,
  validateRemoteEndpointUrl,
  type ClassifiedRuntimeCapabilities,
  type HostCommandHandler,
} from "@hermes/domain";
import type { ChatSessionStateStore } from "./chatSessionStateStore";
import {
  GatewayClient,
  type GatewayClientTlsOptions,
  GatewayRpcError,
  GatewayTransportError,
} from "./gatewayClient";
import type { LocalBackendManager, LocalDialMaterial } from "./localBackendManager";
import type { RegistryStore, RegistryStoreEvent } from "./registryStore";
import {
  mintRemoteWsTicketIfSupported,
  resolveRemoteCredentials,
  type RemoteAuthManager,
} from "./remoteGateway";
import type { SshDialMaterial, SshTargetConfig, SshTransportManager } from "./sshTransport";

export interface SupervisorConnectResult {
  ok: boolean;
  failure?: LocalTypedFailure;
  fleet: FleetSnapshot;
}

export interface ConnectionSupervisorOptions {
  getLocalLabel?: () => string;
  probeTimeoutMs?: number;
  chatSessionStateStore?: ChatSessionStateStore;
  registryStore?: RegistryStore;
  authManager?: RemoteAuthManager;
  remoteTls?: GatewayClientTlsOptions;
  sshTransport?: SshTransportManager;
}

type DialMaterial = LocalDialMaterial | SshDialMaterial;

interface GatewayTransportEntry {
  key: string;
  connectionId: string;
  kind: "local" | "remote" | "ssh";
  defaultProfileId: string;
  transportMode: "shared-host-scope" | "per-profile";
  client: GatewayClient;
  dial?: DialMaterial;
  ownerGeneration: number;
  authorityEpoch: number;
  gatewayVersionOrSha: string;
  describeResult?: Record<string, unknown>;
  capabilities: ClassifiedRuntimeCapabilities;
  supportedActions: SupportedChatActions;
  capabilitiesReported: boolean;
  capabilitiesHandshakeSent: boolean;
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
  snapshotSent: boolean;
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
  const turnId = asString(raw.turn_id ?? raw.turnId) || undefined;
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

function isRpcAuthError(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return false;
  return err.rpcCode === 401 || err.rpcCode === 403 || err.rpcCode === -32001;
}

export class ConnectionSupervisor {
  private readonly localBackend: LocalBackendManager;
  private readonly getLocalLabel: () => string;
  private readonly probeTimeoutMs: number;
  private readonly capabilityRegistry = new CapabilityRegistry();
  private readonly chatSessionStateStore: ChatSessionStateStore | null;
  private readonly registryStore?: RegistryStore;
  private readonly authManager?: RemoteAuthManager;
  private readonly remoteTls?: GatewayClientTlsOptions;
  private readonly sshTransport?: SshTransportManager;
  private readonly unsubRegistry?: () => void;

  private revision = 1;
  private subscriberSeq = 0;
  private ownerGenerationSeq = 0;
  private inflightCoreProbes: Promise<void> | null = null;
  private disposed = false;

  private localHealth: ConnectionHealthSummary;
  private readonly remoteHealth = new Map<string, ConnectionHealthSummary>();
  private readonly sshHealthById = new Map<string, ConnectionHealthSummary>();
  private readonly profilesByConnection = new Map<string, ProfileSummary[]>();
  private readonly sessionsByScope = new Map<string, SessionSummary[]>();
  private readonly transcripts = new Map<string, SessionTranscriptSnapshot>();
  private readonly transports = new Map<string, GatewayTransportEntry>();
  private readonly connectingByKey = new Map<string, Promise<SupervisorConnectResult>>();
  private readonly subscribers = new Map<number, SubscriberRecord>();

  private activeScope: BridgeScope | null = null;
  private activeSessionId: string | null = null;

  constructor(localBackend: LocalBackendManager, options?: ConnectionSupervisorOptions) {
    this.localBackend = localBackend;
    this.getLocalLabel = options?.getLocalLabel ?? (() => "This device");
    this.probeTimeoutMs = options?.probeTimeoutMs ?? 1200;
    this.chatSessionStateStore = options?.chatSessionStateStore ?? null;
    this.registryStore = options?.registryStore;
    this.authManager = options?.authManager;
    this.remoteTls = options?.remoteTls;
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

    const saved = this.chatSessionStateStore?.load();
    if (saved?.lastActiveChat) {
      this.activeScope = {
        connectionId: saved.lastActiveChat.connectionId,
        profileId: saved.lastActiveChat.profileId,
        ...(saved.lastActiveChat.sessionId ? { sessionId: saved.lastActiveChat.sessionId } : {}),
      };
      this.activeSessionId = saved.lastActiveChat.sessionId ?? null;
    }

    if (this.registryStore) {
      const initialSnap = this.registryStore.snapshot();
      this.syncRegistryEntries(initialSnap);
      this.syncHealthPlaceholdersFromRegistry(initialSnap);
      this.unsubRegistry = this.registryStore.subscribe((ev) => {
        this.handleRegistryEvent(ev);
      });
    }
  }

  getCapabilitySnapshot(): CapabilitySnapshot {
    return this.capabilityRegistry.getSnapshot();
  }

  invalidateCapabilities(reason: string): CapabilitySnapshot {
    const snap = this.capabilityRegistry.invalidate({ reason });
    this.emitCapabilities();
    return snap;
  }

  getLocalHealth(): ConnectionHealthSummary {
    return { ...this.localHealth, label: this.getLocalLabel() };
  }

  private getAllProfiles(): ProfileSummary[] {
    const out: ProfileSummary[] = [];
    for (const list of this.profilesByConnection.values()) {
      out.push(...list);
    }
    return out;
  }

  private syncRegistryEntries(snapshot: ReturnType<RegistryStore["snapshot"]>): void {
    const dialableRemoteIds = new Set<string>();
    for (const entry of snapshot.connections) {
      if (entry.kind !== "remote" || !entry.dialable) continue;
      dialableRemoteIds.add(entry.id);
      const prev = this.remoteHealth.get(entry.id);
      if (prev) {
        this.remoteHealth.set(entry.id, {
          ...prev,
          label: entry.label,
          originDisplay: entry.originDisplay ?? "",
        });
      } else {
        this.remoteHealth.set(entry.id, {
          connectionId: entry.id,
          label: entry.label,
          kind: "remote",
          originDisplay: entry.originDisplay ?? "",
          actual: "idle",
          degraded: false,
          latencyMs: null,
          nextRetryAt: null,
        });
      }
    }

    for (const existingId of [...this.remoteHealth.keys()]) {
      if (!dialableRemoteIds.has(existingId)) {
        this.teardownRemoteConnection(existingId);
      }
    }
  }

  private teardownRemoteConnection(connectionId: string): void {
    const key = `remote:${connectionId}`;
    const transport = this.transports.get(key);
    if (transport) {
      this.disposeTransportEntry(key, transport);
    }
    this.remoteHealth.delete(connectionId);
    this.profilesByConnection.delete(connectionId);
    for (const sk of [...this.sessionsByScope.keys()]) {
      if (sk.startsWith(`${connectionId}::`)) {
        this.sessionsByScope.delete(sk);
      }
    }
    for (const tk of [...this.transcripts.keys()]) {
      if (tk.startsWith(`${connectionId}::`)) {
        this.transcripts.delete(tk);
      }
    }
    if (this.activeScope?.connectionId === connectionId) {
      if (this.localHealth.actual === "ready") {
        const localSessions = this.sessionsByScope.get(scopeKey("local", "default")) ?? [];
        const firstLocalSid = localSessions[0]?.sessionId ?? null;
        this.activeScope = {
          connectionId: "local",
          profileId: "default",
          ...(firstLocalSid ? { sessionId: firstLocalSid } : {}),
        };
        this.activeSessionId = firstLocalSid;
        this.chatSessionStateStore?.recordActiveChat({
          connectionId: "local",
          profileId: "default",
          ...(firstLocalSid ? { sessionId: firstLocalSid } : {}),
        });
      } else {
        this.activeScope = null;
        this.activeSessionId = null;
        this.chatSessionStateStore?.recordActiveChat(null);
      }
      this.syncChatStateWithSnapshot();
    }
  }

  private handleRegistryEvent(ev: RegistryStoreEvent): void {
    if (this.disposed) return;
    for (const change of ev.diff.changes) {
      if (change.kind === "connection_removed") {
        this.teardownRemoteConnection(change.connectionId);
      } else if (change.kind === "connection_updated" && change.dialMaterialChanged) {
        const key = `remote:${change.connectionId}`;
        const existing = this.transports.get(key);
        if (existing) {
          this.disposeTransportEntry(key, existing);
        }
      }
    }

    this.syncRegistryEntries(ev.snapshot);
    this.syncHealthPlaceholdersFromRegistry(ev.snapshot);
    this.emitFleet();
  }

  getFleetSnapshot(): FleetSnapshot {
    const allSessions: SessionSummary[] = [];
    for (const list of this.sessionsByScope.values()) {
      allSessions.push(...list);
    }
    const localProfiles = this.profilesByConnection.get("local") ?? [];
    const includeLocal =
      this.localHealth.actual !== "idle" ||
      localProfiles.length > 0 ||
      allSessions.some((s) => s.connectionId === "local") ||
      Boolean(this.localHealth.errorCode);

    const connections: ConnectionHealthSummary[] = [];
    if (includeLocal) {
      connections.push(this.getLocalHealth());
    }
    for (const remote of this.remoteHealth.values()) {
      connections.push({ ...remote });
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
      if (!sub.snapshotSent) continue;
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

  private getAllSessions(): SessionSummary[] {
    const allSessions: SessionSummary[] = [];
    for (const list of this.sessionsByScope.values()) {
      allSessions.push(...list);
    }
    return allSessions;
  }

  getChatStateProjection(): ChatSessionProjection {
    if (this.chatSessionStateStore) {
      return this.chatSessionStateStore.getProjection();
    }
    const activeConnectionId = this.activeScope?.connectionId ?? "local";
    const activeHealth = this.getConnectionHealth(activeConnectionId);
    const ready = activeHealth?.actual === "ready";
    return {
      windowId: "primary",
      paneId: "main",
      lastActiveChat: this.activeScope
        ? {
            connectionId: this.activeScope.connectionId,
            profileId: this.activeScope.profileId ?? "default",
            ...(this.activeSessionId ? { sessionId: this.activeSessionId } : {}),
          }
        : null,
      lastSessionByScope: {},
      lastValidProfileByConnection: {},
      lastValidScopes: [],
      sessionSummaries: {},
      activeStatus: ready ? "ready" : "empty",
      lastKnownUnverified: !ready && Boolean(this.activeScope),
      missingSession: null,
      routeBanner: null,
    };
  }

  private emitChatState(): void {
    this.emitTopic(
      "chat.state",
      null,
      "patch",
      this.getChatStateProjection(),
    );
  }

  private syncChatStateWithSnapshot(): void {
    if (!this.chatSessionStateStore) return;
    const fleet = this.getFleetSnapshot();
    this.chatSessionStateStore.syncSessionSummaries(fleet.sessions);
    const resolved = this.chatSessionStateStore.resolveWithSnapshot({
      connections: fleet.connections,
      profiles: fleet.profiles,
      sessions: fleet.sessions,
    });
    if (resolved.activeScope) {
      this.activeScope = { ...resolved.activeScope };
      this.activeSessionId = resolved.activeSessionId;
    } else if (resolved.status === "empty") {
      this.activeScope = null;
      this.activeSessionId = null;
    }
    this.emitChatState();
  }

  private getConnectionHealth(connectionId: string): ConnectionHealthSummary | null {
    if (connectionId === "local") return this.getLocalHealth();
    const remote = this.remoteHealth.get(connectionId);
    if (remote) return { ...remote };
    const ssh = this.sshHealthById.get(connectionId);
    return ssh ? { ...ssh } : null;
  }

  private emitFleet(connectionId?: string): void {
    const snapshot = this.getFleetSnapshot();
    this.emitTopic("fleet", null, "patch", snapshot);
    const ids = connectionId
      ? [connectionId]
      : ["local", ...this.remoteHealth.keys(), ...this.sshHealthById.keys()];
    for (const id of ids) {
      const health = this.getConnectionHealth(id);
      if (!health) continue;
      this.emitTopic(
        "connection.health",
        { connectionId: id },
        "patch",
        health,
        (sub) => !sub.scope || sub.scope.connectionId === id,
      );
    }
  }

  private emitProfiles(connectionId = "local"): void {
    const list = this.profilesByConnection.get(connectionId) ?? [];
    this.emitTopic(
      "profiles",
      { connectionId },
      "patch",
      { profiles: [...list] },
      (sub) => !sub.scope || sub.scope.connectionId === connectionId,
    );
  }

  private emitCapabilities(): void {
    this.emitTopic("capabilities", null, "snapshot", this.capabilityRegistry.getSnapshot());
  }

  private emitSessions(connectionId: string, profileId: string): void {
    const list = this.sessionsByScope.get(scopeKey(connectionId, profileId)) ?? [];
    this.emitTopic(
      "sessions",
      { connectionId, profileId },
      "patch",
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

  private getTransport(connectionId: string, profileId: string): GatewayTransportEntry | null {
    const shared = this.transports.get(`${connectionId}::shared`);
    if (shared && !shared.disposed && shared.client.isOpen()) {
      return shared;
    }
    const perProfile = this.transports.get(`${connectionId}::profile:${profileId}`);
    if (perProfile && !perProfile.disposed && perProfile.client.isOpen()) {
      return perProfile;
    }
    if (connectionId === "local") {
      const legacyShared = this.transports.get("shared");
      if (legacyShared && !legacyShared.disposed && legacyShared.client.isOpen()) {
        return legacyShared;
      }
      const legacyPerProfile = this.transports.get(`profile:${profileId}`);
      if (legacyPerProfile && !legacyPerProfile.disposed && legacyPerProfile.client.isOpen()) {
        return legacyPerProfile;
      }
      return null;
    }
    const remoteEntry = this.transports.get(`remote:${connectionId}`);
    if (remoteEntry && !remoteEntry.disposed && remoteEntry.client.isOpen()) {
      return remoteEntry;
    }
    return null;
  }

  private isSshConnection(connectionId: string): boolean {
    if (this.sshHealthById.has(connectionId)) return true;
    if (this.getSshTargetForConnection(connectionId)) return true;
    const snap = this.registryStore?.snapshot();
    return Boolean(snap?.connections.some((c) => c.id === connectionId && c.kind === "ssh"));
  }

  private async ensureTransport(
    connectionId: string,
    profileId: string,
    options?: { forceReconnect?: boolean; activate?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (connectionId === "local" || this.isSshConnection(connectionId)) {
      return this.ensureScopeTransport(connectionId, profileId, {
        forceReconnect: options?.forceReconnect,
        activate: options?.activate ?? options?.activateScope,
        activateScope: options?.activateScope ?? options?.activate,
      });
    }
    return this.connectRemote(connectionId, {
      profileId,
      forceReconnect: options?.forceReconnect,
      activate: options?.activate ?? options?.activateScope,
    });
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
          const updated = snapshot.connections.find((c) => c.id === change.connectionId);
          if (updated?.kind === "ssh") {
            if (!change.dialMaterialChanged) {
              this.emitFleet(change.connectionId);
            } else {
              await this.connectSsh(change.connectionId, { forceReconnect: true });
            }
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
    this.remoteHealth.delete(connectionId);
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
        this.chatSessionStateStore?.recordActiveChat({
          connectionId: "local",
          profileId: pid,
          ...(sid ? { sessionId: sid } : {}),
        });
      } else {
        this.activeScope = null;
        this.activeSessionId = null;
        this.chatSessionStateStore?.recordActiveChat(null);
      }
      this.syncChatStateWithSnapshot();
    }
    this.emitFleet();
  }

  private async ensureScopeTransport(
    connectionId: string,
    profileId: string,
    options?: { forceReconnect?: boolean; activate?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (!options?.forceReconnect) {
      const existing = this.getTransport(connectionId, profileId);
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
    options?: { forceReconnect?: boolean; activate?: boolean },
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

  async connectRemote(
    connectionId: string,
    options?: { profileId?: string; forceReconnect?: boolean; activate?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (!this.registryStore) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    if (!options?.forceReconnect) {
      const existing = this.getTransport(connectionId, options?.profileId ?? "default");
      if (existing) {
        const pid = options?.profileId ?? existing.defaultProfileId;
        const sessions = await this.refreshSessionsForProfile(existing, pid);
        if (options?.activate) {
          const sid = sessions[0]?.sessionId ?? null;
          this.activeScope = {
            connectionId,
            profileId: pid,
            ...(sid ? { sessionId: sid } : {}),
          };
          this.activeSessionId = sid;
          if (this.chatSessionStateStore) {
            this.chatSessionStateStore.recordActiveChat({
              connectionId,
              profileId: pid,
              ...(sid ? { sessionId: sid } : {}),
            });
            this.syncChatStateWithSnapshot();
          }
          if (sid) {
            await this.loadTranscriptSnapshot(existing, pid, sid);
          }
          this.emitFleet(connectionId);
        }
        return { ok: true, fleet: this.getFleetSnapshot() };
      }
    }

    const inflightKey = options?.forceReconnect
      ? `remote:retry:${connectionId}`
      : `remote:${connectionId}`;
    const inflight = this.connectingByKey.get(inflightKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.connectRemoteInternal(connectionId, options).finally(() => {
      this.connectingByKey.delete(inflightKey);
    });
    this.connectingByKey.set(inflightKey, promise);
    return promise;
  }

  private async connectRemoteInternal(
    connectionId: string,
    options?: { profileId?: string; forceReconnect?: boolean; activate?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed || !this.registryStore) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const snapshot = this.registryStore.snapshot();
    const conn = snapshot.connections.find((c) => c.id === connectionId);
    if (!conn || conn.kind !== "remote" || !conn.dialable || !conn.originDisplay) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const endpointCheck = validateRemoteEndpointUrl(conn.originDisplay);
    if (!endpointCheck.valid) {
      this.remoteHealth.set(connectionId, {
        connectionId,
        label: conn.label,
        kind: "remote",
        originDisplay: conn.originDisplay,
        actual: "blocked",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: "invalid_request",
        message: getCopy(endpointCheck.messageKey),
      });
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const transportKey = `remote:${connectionId}`;
    if (options?.forceReconnect) {
      const stale = this.transports.get(transportKey);
      if (stale) this.disposeTransportEntry(transportKey, stale);
    }

    this.remoteHealth.set(connectionId, {
      connectionId,
      label: conn.label,
      kind: "remote",
      originDisplay: endpointCheck.originDisplay,
      actual: "connecting",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
    });
    this.emitFleet(connectionId);

    const startedAt = Date.now();
    const creds = resolveRemoteCredentials({
      origin: endpointCheck.normalizedUrl,
      connectionId,
      registryStore: this.registryStore,
      authManager: this.authManager,
    });

    const ticketRes = await mintRemoteWsTicketIfSupported({
      origin: endpointCheck.normalizedUrl,
      headers: creds.headers,
      timeoutMs: 8_000,
      tls: this.remoteTls,
    });

    if (ticketRes.kind === "auth_required") {
      this.remoteHealth.set(connectionId, {
        connectionId,
        label: conn.label,
        kind: "remote",
        originDisplay: endpointCheck.originDisplay,
        actual: "auth_required",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: "auth_required",
        message: getCopy("remote.authRequiredBody"),
      });
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    let client: GatewayClient;
    try {
      client = await GatewayClient.connect({
        wsUrl: endpointCheck.wsUrl,
        ...(ticketRes.kind === "ticket" ? { ticket: ticketRes.ticket } : {}),
        headers: creds.headers,
        tls: this.remoteTls,
        connectTimeoutMs: 10_000,
      });
    } catch (err) {
      const transportErr = err instanceof GatewayTransportError ? err : null;
      const isAuth = transportErr?.code === "auth_failed";
      const errCode: ErrorCode = isAuth
        ? "auth_required"
        : transportErr?.code ?? "unreachable";
      this.remoteHealth.set(connectionId, {
        connectionId,
        label: conn.label,
        kind: "remote",
        originDisplay: endpointCheck.originDisplay,
        actual: isAuth ? "auth_required" : errCode === "timeout" ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: errCode,
        ...(isAuth ? { message: getCopy("remote.authRequiredBody") } : {}),
      });
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    let describeRes: Record<string, unknown> | undefined;
    try {
      describeRes = await client.call<Record<string, unknown>>("runtime.describe", {});
    } catch (err) {
      if (!isJsonRpcMethodNotFound(err)) {
        client.close();
        const isAuth = isRpcAuthError(err);
        this.remoteHealth.set(connectionId, {
          connectionId,
          label: conn.label,
          kind: "remote",
          originDisplay: endpointCheck.originDisplay,
          actual: isAuth ? "auth_required" : "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: isAuth ? "auth_required" : "protocol_unsupported",
        });
        this.emitFleet(connectionId);
        return { ok: false, fleet: this.getFleetSnapshot() };
      }
    }

    const capabilities = classifyRuntimeCapabilities(describeRes);
    const supportedActions = toSupportedChatActions(capabilities);
    const ownerGeneration = ++this.ownerGenerationSeq;
    const authorityEpoch =
      describeRes && typeof describeRes.authority_epoch === "number"
        ? describeRes.authority_epoch
        : describeRes && typeof describeRes.authorityEpoch === "number"
          ? describeRes.authorityEpoch
          : 1;
    const gatewayVersionOrSha =
      describeRes && typeof describeRes.code_sha === "string"
        ? describeRes.code_sha
        : describeRes && typeof describeRes.gateway_version === "string"
          ? describeRes.gateway_version
          : describeRes && typeof describeRes.version === "string"
            ? describeRes.version
            : "unknown";

    let capabilitiesReported = false;
    let capabilitiesHandshakeSent = false;
    try {
      capabilitiesHandshakeSent = true;
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
      // Non-fatal
    }

    const targetProfileId = options?.profileId ?? conn.remoteProfile ?? "default";
    const entry: GatewayTransportEntry = {
      key: transportKey,
      connectionId,
      kind: "remote",
      defaultProfileId: targetProfileId,
      transportMode: "per-profile",
      client,
      ownerGeneration,
      authorityEpoch,
      gatewayVersionOrSha,
      describeResult: describeRes,
      capabilities,
      supportedActions,
      capabilitiesReported,
      capabilitiesHandshakeSent,
      subscribedToGateway,
      disposed: false,
      unsubNotification: () => {},
      unsubClose: () => {},
    };

    entry.unsubNotification = client.onNotification((method, params) => {
      this.handleGatewayNotification(entry, method, params);
    });
    entry.unsubClose = client.onClose((reason) => {
      if (this.disposed || entry.disposed || reason === "client_closed") return;
      this.disposeTransportEntry(transportKey, entry);
      const current = this.remoteHealth.get(connectionId);
      if (current && current.actual !== "auth_required") {
        this.remoteHealth.set(connectionId, {
          ...current,
          actual: "reconnecting",
          degraded: true,
          latencyMs: null,
          errorCode: "unreachable",
        });
        this.emitFleet(connectionId);
      }
    });

    const previous = this.transports.get(transportKey);
    if (previous) {
      this.disposeTransportEntry(transportKey, previous);
    }
    this.transports.set(transportKey, entry);

    const latencyMs = Math.max(1, Date.now() - startedAt);
    this.remoteHealth.set(connectionId, {
      connectionId,
      label: conn.label,
      kind: "remote",
      originDisplay: endpointCheck.originDisplay,
      actual: "ready",
      degraded: false,
      latencyMs,
      errorCode: undefined,
      message: undefined,
      nextRetryAt: null,
    });

    const profiles = await this.refreshProfiles(entry, targetProfileId);
    const activeProfileId =
      profiles.find((p) => p.profileId === targetProfileId)?.profileId ??
      profiles[0]?.profileId ??
      targetProfileId;
    entry.defaultProfileId = activeProfileId;
    const sessions = await this.refreshSessionsForProfile(entry, activeProfileId);

    if (
      options?.activate ||
      !this.activeScope ||
      this.activeScope.connectionId === connectionId
    ) {
      const initialSessionId = sessions[0]?.sessionId ?? null;
      this.activeScope = {
        connectionId,
        profileId: activeProfileId,
        ...(initialSessionId ? { sessionId: initialSessionId } : {}),
      };
      this.activeSessionId = initialSessionId;
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.recordActiveChat({
          connectionId,
          profileId: activeProfileId,
          ...(initialSessionId ? { sessionId: initialSessionId } : {}),
        });
        this.syncChatStateWithSnapshot();
      }
      this.capabilityRegistry.applyConnectHandshake({
        connectionId,
        profileId: activeProfileId,
        ownerGeneration: entry.ownerGeneration,
        authorityEpoch: entry.authorityEpoch,
        gatewayVersionOrSha: entry.gatewayVersionOrSha,
        describeResult: entry.describeResult,
        serverRequestsSupported: entry.capabilitiesReported,
      });
      this.emitCapabilities();
      this.scheduleCoreProbes(entry, activeProfileId);
      if (this.activeSessionId) {
        await this.loadTranscriptSnapshot(entry, activeProfileId, this.activeSessionId);
      }
    }

    this.emitFleet(connectionId);
    return {
      ok: true,
      fleet: this.getFleetSnapshot(),
    };
  }

  private async connectLocalInternal(
    profileId: string,
    options?: { forceReconnect?: boolean; activate?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    if (options?.forceReconnect) {
      for (const [k, entry] of this.transports.entries()) {
        if (
          entry.connectionId === "local" &&
          (entry.transportMode === "shared-host-scope" ||
            k === `profile:${profileId}` ||
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
    this.syncChatStateWithSnapshot();
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
      this.syncChatStateWithSnapshot();
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
      activateScope: options?.activateScope ?? options?.activate,
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
        label: connectionId === "local" ? this.getLocalLabel() : label,
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
      ticket = null;
    }

    let describeRes: Record<string, unknown> | undefined;
    try {
      describeRes = await client.call<Record<string, unknown>>("runtime.describe", {});
    } catch (err) {
      if (!isJsonRpcMethodNotFound(err)) {
        client.close();
        this.setHealth(connectionId, {
          connectionId,
          label: connectionId === "local" ? this.getLocalLabel() : label,
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
    const ownerGeneration = ++this.ownerGenerationSeq;
    const authorityEpoch =
      describeRes && typeof describeRes.authority_epoch === "number"
        ? describeRes.authority_epoch
        : describeRes && typeof describeRes.authorityEpoch === "number"
          ? describeRes.authorityEpoch
          : 1;
    const gatewayVersionOrSha =
      describeRes && typeof describeRes.code_sha === "string"
        ? describeRes.code_sha
        : describeRes && typeof describeRes.gateway_version === "string"
          ? describeRes.gateway_version
          : describeRes && typeof describeRes.version === "string"
            ? describeRes.version
            : "unknown";

    let capabilitiesReported = false;
    let capabilitiesHandshakeSent = false;
    try {
      capabilitiesHandshakeSent = true;
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
      // Non-fatal
    }

    const entry: GatewayTransportEntry = {
      key: transportKey,
      connectionId,
      kind,
      defaultProfileId: dial.profileId,
      transportMode: dial.transportMode,
      client,
      dial,
      ownerGeneration,
      authorityEpoch,
      gatewayVersionOrSha,
      describeResult: describeRes,
      capabilities,
      supportedActions,
      capabilitiesReported,
      capabilitiesHandshakeSent,
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
        if (connectionId === "local" || this.activeScope?.connectionId === connectionId) {
          this.capabilityRegistry.invalidate({ reason: "transport_closed" });
          this.emitCapabilities();
        }
        this.emitFleet(connectionId);
      }

      if (kind === "ssh" && this.sshTransport && entry.dial) {
        void this.reconnectSshAfterDrop(connectionId, entry.dial.profileId, entry.dial.instanceId);
      }
    });

    const previous = this.transports.get(transportKey);
    if (previous) {
      this.disposeTransportEntry(transportKey, previous);
    }
    this.transports.set(transportKey, entry);

    if (
      connectionId === "local" ||
      params.activateScope ||
      !this.activeScope ||
      this.activeScope.connectionId === connectionId
    ) {
      this.capabilityRegistry.applyConnectHandshake({
        connectionId,
        profileId: dial.profileId,
        ownerGeneration,
        authorityEpoch,
        gatewayVersionOrSha,
        describeResult: describeRes,
        serverRequestsSupported: capabilitiesReported,
      });
      this.emitCapabilities();
      this.scheduleCoreProbes(entry, dial.profileId);
    }

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

    if (connectionId === "local") {
      const savedState = this.chatSessionStateStore?.load();
      const savedActive = savedState?.lastActiveChat ?? null;
      const localProfiles = this.profilesByConnection.get("local") ?? [];
      if (
        savedActive &&
        savedActive.connectionId === "local" &&
        savedActive.profileId !== dial.profileId &&
        localProfiles.some((p) => p.profileId === savedActive.profileId) &&
        entry.transportMode === "shared-host-scope"
      ) {
        await this.refreshSessionsForProfile(entry, savedActive.profileId);
      }

      const remoteIsCurrentlyActive =
        this.activeScope &&
        this.activeScope.connectionId !== "local" &&
        this.getConnectionHealth(this.activeScope.connectionId)?.actual === "ready" &&
        !params.activateScope;

      if (!remoteIsCurrentlyActive) {
        if (this.chatSessionStateStore) {
          const hasSessionForDialedScope =
            savedActive &&
            savedActive.connectionId === "local" &&
            savedActive.profileId === dial.profileId &&
            Boolean(savedActive.sessionId);
          if (!savedActive || (!hasSessionForDialedScope && !savedActive.sessionId && sessions.length > 0)) {
            const initialSessionId = sessions[0]?.sessionId ?? null;
            this.chatSessionStateStore.recordActiveChat({
              connectionId: "local",
              profileId: dial.profileId,
              ...(initialSessionId ? { sessionId: initialSessionId } : {}),
            });
          }
          this.syncChatStateWithSnapshot();
        } else {
          const shouldActivate =
            !this.activeScope ||
            Boolean(params.activateScope) ||
            (this.activeScope.connectionId === "local" && !this.activeSessionId);
          if (shouldActivate) {
            const initialSessionId = sessions[0]?.sessionId ?? null;
            this.activeScope = {
              connectionId: "local",
              profileId: dial.profileId,
              ...(initialSessionId ? { sessionId: initialSessionId } : {}),
            };
            this.activeSessionId = initialSessionId;
          }
        }

        const projection = this.getChatStateProjection();
        if (
          (!this.chatSessionStateStore || projection.activeStatus === "ready") &&
          this.activeSessionId &&
          this.activeScope?.connectionId === "local" &&
          this.activeScope?.profileId
        ) {
          const targetEntry = this.getTransport("local", this.activeScope.profileId) ?? entry;
          await this.loadTranscriptSnapshot(targetEntry, this.activeScope.profileId, this.activeSessionId);
        }
      }
    } else {
      const shouldActivate = Boolean(params.activateScope) || !this.activeScope;
      if (shouldActivate) {
        const initialSessionId = sessions[0]?.sessionId ?? null;
        this.activeScope = {
          connectionId,
          profileId: dial.profileId,
          ...(initialSessionId ? { sessionId: initialSessionId } : {}),
        };
        this.activeSessionId = initialSessionId;
        if (this.chatSessionStateStore) {
          this.chatSessionStateStore.recordActiveChat({
            connectionId,
            profileId: dial.profileId,
            ...(initialSessionId ? { sessionId: initialSessionId } : {}),
          });
          this.syncChatStateWithSnapshot();
        }
      }
      if (
        this.activeSessionId &&
        this.activeScope?.connectionId === connectionId &&
        this.activeScope?.profileId === dial.profileId
      ) {
        await this.loadTranscriptSnapshot(entry, dial.profileId, this.activeSessionId);
      }
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

    const currentProfiles = this.profilesByConnection.get(connectionId) ?? [];
    if (rawProfiles.length === 0) {
      const hasExisting = currentProfiles.some((p) => p.profileId === activeProfileId);
      if (!hasExisting) {
        this.profilesByConnection.set(connectionId, [
          ...currentProfiles,
          {
            connectionId,
            profileId: activeProfileId,
            displayName: activeProfileId === "default" ? "Default" : activeProfileId,
            handle: activeProfileId,
            isDefault: activeProfileId === "default",
            actual: "ready",
          },
        ]);
      }
    } else {
      const existingById = new Map(currentProfiles.map((p) => [p.profileId, p]));
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
      this.profilesByConnection.set(connectionId, [...existingById.values()]);
    }

    this.emitProfiles(connectionId);
    return [...(this.profilesByConnection.get(connectionId) ?? [])];
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
        if (isRpcAuthError(err) && connectionId !== "local") {
          this.markConnectionAuthRequired(connectionId);
        } else {
          try {
            rawList = await callList("sessions.list");
          } catch (err2) {
            if (isJsonRpcMethodNotFound(err2)) {
              entry.capabilities.sessionList = false;
            }
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

  private markConnectionAuthRequired(connectionId: string): void {
    if (connectionId === "local") {
      this.localHealth = {
        ...this.localHealth,
        actual: "auth_required",
        degraded: true,
        errorCode: "auth_required",
      };
    } else {
      const cur = this.remoteHealth.get(connectionId);
      if (cur) {
        this.remoteHealth.set(connectionId, {
          ...cur,
          actual: "auth_required",
          degraded: true,
          latencyMs: null,
          errorCode: "auth_required",
          message: getCopy("remote.authRequiredBody"),
        });
      }
    }
    const remoteEntry = this.transports.get(`remote:${connectionId}`);
    if (remoteEntry) {
      this.disposeTransportEntry(`remote:${connectionId}`, remoteEntry);
    }
    this.emitFleet(connectionId);
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
    options?: { replace?: boolean; resynced?: boolean },
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

    const base =
      options?.replace || !existing
        ? this.buildInitialTranscriptSnapshot(entry, profileId, sessionId)
        : existing;
    const gatewayMessagesRaw = Array.isArray(rawResult?.messages)
      ? (rawResult.messages as Array<Record<string, unknown>>)
      : [];
    const gatewayMessages = gatewayMessagesRaw
      .map((m) => mapRawMessage(m, sessionId))
      .filter((m): m is TranscriptMessage => m !== null);

    let finalMessages: TranscriptMessage[];
    if (options?.replace) {
      // Clean full replacement on gap/resync: never mix stale or torn local messages
      finalMessages = gatewayMessages;
    } else {
      // Preserve live in-flight messages / tokens / tool rows while incorporating persisted gateway messages
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
      finalMessages = [...mergedById.values()];
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
      messages: finalMessages,
      activeTurnId: options?.replace ? gwTurnId : base.activeTurnId ?? gwTurnId,
      chatAvailable: entry.supportedActions.promptSubmit,
      ...(entry.supportedActions.promptSubmit
        ? {}
        : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      supportedActions: { ...entry.supportedActions },
      snapshotSeq: 0,
      ...(options?.resynced ? { resynced: true } : {}),
    };

    this.transcripts.set(key, merged);
    this.chatSessionStateStore?.recordTranscriptSnapshot(merged);
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
    entry: GatewayTransportEntry | null,
    connectionId: string,
    profileId: string,
    sessionId: string,
    patch: TranscriptPatchPayload,
  ): void {
    const key = transcriptKey(connectionId, profileId, sessionId);
    const current =
      this.transcripts.get(key) ??
      (entry
        ? this.buildInitialTranscriptSnapshot(entry, profileId, sessionId)
        : {
            connectionId,
            profileId,
            sessionId,
            messages: [],
            activeTurnId: null,
            turnStopping: false,
            chatAvailable: false,
            supportedActions: defaultChatActions(),
          });

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

  private scheduleCoreProbes(entry: GatewayTransportEntry, profileId: string): void {
    const promise = Promise.all(
      CORE_CAPABILITY_DOMAINS.map((domain) => this.probeDomain(entry, profileId, domain)),
    ).then(() => {
      if (!this.disposed && !entry.disposed) {
        this.emitCapabilities();
      }
    });
    this.inflightCoreProbes = promise.finally(() => {
      if (this.inflightCoreProbes === promise) {
        this.inflightCoreProbes = null;
      }
    });
  }

  private async probeDomain(
    entry: GatewayTransportEntry,
    profileId: string,
    domain: CapabilityDomainId,
    options?: { force?: boolean },
  ): Promise<void> {
    if (this.disposed || entry.disposed) return;
    const meta = CAPABILITY_DOMAIN_CATALOG.find((m) => m.domain === domain);
    if (!meta || !meta.probeMethod || meta.classification === "deferred" || meta.classification === "deep_link") {
      return;
    }

    const currentSnap = this.capabilityRegistry.getSnapshot();
    const existingDom = currentSnap.domains.find((d) => d.domain === domain);
    if (existingDom?.probed && !options?.force) {
      return;
    }

    const probeMethod = resolveExplicitMethodAlias(meta.probeMethod) ?? meta.probeMethod;
    const methodToCheck = this.capabilityRegistry.getMethodTier(meta.probeMethod) !== "unknown"
      ? meta.probeMethod
      : probeMethod;

    // Never invoke refused methods on wire
    if (
      this.capabilityRegistry.isMethodRefused(meta.probeMethod) ||
      this.capabilityRegistry.isMethodRefused(methodToCheck) ||
      meta.requiredMethods.some((req) => this.capabilityRegistry.isMethodRefused(req))
    ) {
      this.capabilityRegistry.applyProbeOutcome({
        domain,
        method: meta.probeMethod,
        outcome: "refused",
        expectedOwnerGeneration: entry.ownerGeneration,
        expectedAuthorityEpoch: entry.authorityEpoch,
      });
      return;
    }

    // Legacy owner without server_requests: don't pretend approval is available
    if (domain === "approval" && !entry.capabilitiesReported) {
      this.capabilityRegistry.applyProbeOutcome({
        domain,
        method: meta.probeMethod,
        outcome: "method_not_found",
        expectedOwnerGeneration: entry.ownerGeneration,
        expectedAuthorityEpoch: entry.authorityEpoch,
      });
      return;
    }

    const startGeneration = currentSnap.generation;
    try {
      await entry.client.call(
        meta.probeMethod,
        { profile_id: profileId },
        { timeoutMs: this.probeTimeoutMs },
      );
      this.capabilityRegistry.applyProbeOutcome({
        domain,
        method: meta.probeMethod,
        outcome: "ok",
        expectedOwnerGeneration: entry.ownerGeneration,
        expectedAuthorityEpoch: entry.authorityEpoch,
        expectedGeneration: startGeneration,
      });
    } catch (err) {
      if (isJsonRpcMethodNotFound(err)) {
        this.capabilityRegistry.applyProbeOutcome({
          domain,
          method: meta.probeMethod,
          outcome: "method_not_found",
          expectedOwnerGeneration: entry.ownerGeneration,
          expectedAuthorityEpoch: entry.authorityEpoch,
          expectedGeneration: startGeneration,
        });
      } else if (err instanceof GatewayTransportError && err.code === "timeout") {
        this.capabilityRegistry.applyProbeOutcome({
          domain,
          method: meta.probeMethod,
          outcome: "timeout",
          expectedOwnerGeneration: entry.ownerGeneration,
          expectedAuthorityEpoch: entry.authorityEpoch,
          expectedGeneration: startGeneration,
        });
      } else {
        // Non-fatal probe error: do not disconnect or retry
        this.capabilityRegistry.applyProbeOutcome({
          domain,
          method: meta.probeMethod,
          outcome: "timeout",
          expectedOwnerGeneration: entry.ownerGeneration,
          expectedAuthorityEpoch: entry.authorityEpoch,
          expectedGeneration: startGeneration,
        });
      }
    }
  }

  private handleGatewayNotification(
    entry: GatewayTransportEntry,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const connectionId = entry.connectionId;
    if (method === "auth.required" || method === "auth_required") {
      this.markConnectionAuthRequired(connectionId);
      return;
    }

    if (method === "resync_required" || method === "possible_event_loss") {
      const nextEpoch =
        typeof params.authority_epoch === "number"
          ? params.authority_epoch
          : typeof params.authorityEpoch === "number"
            ? params.authorityEpoch
            : entry.authorityEpoch;
      entry.authorityEpoch = nextEpoch;
      const targetProfileId =
        this.activeScope?.connectionId === connectionId
          ? (this.activeScope.profileId ?? entry.defaultProfileId)
          : entry.defaultProfileId;
      this.capabilityRegistry.invalidate({
        reason: method,
        authorityEpoch: nextEpoch,
      });
      this.capabilityRegistry.applyConnectHandshake({
        connectionId,
        profileId: targetProfileId,
        ownerGeneration: entry.ownerGeneration,
        authorityEpoch: nextEpoch,
        gatewayVersionOrSha: entry.gatewayVersionOrSha,
        describeResult: entry.describeResult,
        serverRequestsSupported: entry.capabilitiesReported,
      });
      this.emitCapabilities();
      this.scheduleCoreProbes(entry, targetProfileId);
      return;
    }

    const incomingEpoch =
      typeof params.authority_epoch === "number"
        ? params.authority_epoch
        : typeof params.authorityEpoch === "number"
          ? params.authorityEpoch
          : undefined;
    if (incomingEpoch !== undefined && incomingEpoch !== entry.authorityEpoch) {
      entry.authorityEpoch = incomingEpoch;
      const targetProfileId =
        this.activeScope?.connectionId === connectionId
          ? (this.activeScope.profileId ?? entry.defaultProfileId)
          : entry.defaultProfileId;
      this.capabilityRegistry.invalidate({
        reason: "authority_epoch_changed",
        authorityEpoch: incomingEpoch,
      });
      this.capabilityRegistry.applyConnectHandshake({
        connectionId,
        profileId: targetProfileId,
        ownerGeneration: entry.ownerGeneration,
        authorityEpoch: incomingEpoch,
        gatewayVersionOrSha: entry.gatewayVersionOrSha,
        describeResult: entry.describeResult,
        serverRequestsSupported: entry.capabilitiesReported,
      });
      this.emitCapabilities();
      this.scheduleCoreProbes(entry, targetProfileId);
    }

    const sessionId = asString(params.session_id ?? params.sessionId).trim();
    const profileId =
      asString(params.profile_id ?? params.profileId, entry.defaultProfileId).trim() ||
      entry.defaultProfileId;
    const resolvedProfileId = this.findProfileIdForSession(connectionId, sessionId) ?? profileId;
    if (!sessionId) return;

    if (method === "prompt.delta" || method === "prompt.token") {
      const messageId = asString(params.message_id ?? params.messageId, `assistant-${Date.now()}`);
      const turnId = asString(params.turn_id ?? params.turnId) || undefined;
      const delta = asString(params.delta ?? params.text, "");
      this.applyPatchToTranscript(entry, connectionId, resolvedProfileId, sessionId, {
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
      this.applyPatchToTranscript(entry, connectionId, resolvedProfileId, sessionId, {
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
      this.applyPatchToTranscript(entry, connectionId, resolvedProfileId, sessionId, {
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
    connectionId?: string,
  ): string {
    if (typeof payload.profileId === "string" && payload.profileId.trim()) {
      return payload.profileId.trim();
    }
    if (scope?.profileId && scope.profileId.trim()) {
      return scope.profileId.trim();
    }
    if (
      this.activeScope?.profileId &&
      this.activeScope.profileId.trim() &&
      (!connectionId || this.activeScope.connectionId === connectionId)
    ) {
      return this.activeScope.profileId.trim();
    }
    if (connectionId && connectionId !== "local") {
      const sshInfo = this.getSshTargetForConnection(connectionId);
      if (sshInfo?.defaultProfile) return sshInfo.defaultProfile;
    }
    return "default";
  }

  private resolveTargetSessionId(
    payload: Record<string, unknown>,
    scope: BridgeScope | null,
    connectionId?: string,
  ): string | null {
    if (typeof payload.sessionId === "string" && payload.sessionId.trim()) {
      return payload.sessionId.trim();
    }
    if (scope?.sessionId && scope.sessionId.trim()) {
      return scope.sessionId.trim();
    }
    if (!connectionId || this.activeScope?.connectionId === connectionId) {
      return this.activeSessionId;
    }
    return null;
  }

  private requireTransport(connectionId: string, profileId: string): GatewayTransportEntry {
    const entry = this.getTransport(connectionId, profileId);
    if (!entry) {
      const health = this.getConnectionHealth(connectionId);
      if (health?.actual === "auth_required") {
        throw makeBridgeError("auth_required", getCopy("remote.authRequiredBody"));
      }
      throw makeBridgeError("unreachable", "Gateway 尚未就绪");
    }
    return entry;
  }

  private translateRpcFailure(
    entry: GatewayTransportEntry,
    err: unknown,
    singleAction?: keyof SupportedChatActions,
    rpcMethod?: string,
  ): never {
    if (isJsonRpcMethodNotFound(err)) {
      if (singleAction) {
        this.downgradeSingleAction(entry, singleAction);
      }
      if (rpcMethod) {
        this.capabilityRegistry.markMethodNotFound({
          method: rpcMethod,
          expectedOwnerGeneration: entry.ownerGeneration,
          expectedAuthorityEpoch: entry.authorityEpoch,
        });
        this.emitCapabilities();
      }
      throw makeBridgeError("capability_unavailable", "当前 Gateway 未提供此能力");
    }
    if (isRpcAuthError(err)) {
      this.markConnectionAuthRequired(entry.connectionId);
      throw makeBridgeError("auth_required", getCopy("remote.authRequiredBody"));
    }
    if (err instanceof GatewayTransportError) {
      if (err.code === "auth_failed") {
        this.markConnectionAuthRequired(entry.connectionId);
        throw makeBridgeError("auth_required", getCopy("remote.authRequiredBody"));
      }
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
      snapshotSent: false,
      listener,
    };
    this.subscribers.set(id, record);

    queueMicrotask(() => {
      if (!this.subscribers.has(id)) return;
      record.snapshotSent = true;
      const rev = this.revision;
      const cid = scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
      const pid = scope?.profileId ?? this.activeScope?.profileId ?? "default";
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
        const health = this.getConnectionHealth(cid) ?? this.getLocalHealth();
        listener({
          topic,
          scope: { connectionId: cid },
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: health,
        });
      } else if (topic === "profiles") {
        const list = scope?.connectionId
          ? (this.profilesByConnection.get(cid) ?? [])
          : this.getAllProfiles();
        listener({
          topic,
          scope: { connectionId: cid },
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: { profiles: list },
        });
      } else if (topic === "sessions") {
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
        const sid = scope?.sessionId ?? this.activeSessionId;
        const existing = sid ? this.transcripts.get(transcriptKey(cid, pid, sid)) : null;
        const transport = this.getTransport(cid, pid);
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
      } else if (topic === "capabilities") {
        listener({
          topic,
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.capabilityRegistry.getSnapshot(),
        });
      } else if (topic === "chat.state") {
        listener({
          topic,
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.getChatStateProjection(),
        });
      }
    });

    return () => {
      this.subscribers.delete(id);
    };
  }

  readonly handlers: Record<
    | "capabilities.describe"
    | "fleet.refresh"
    | "connections.retry"
    | "profiles.list"
    | "scopes.switch"
    | "sessions.list"
    | "sessions.create"
    | "sessions.select"
    | "sessions.resume"
    | "prompts.send"
    | "prompts.stop"
    | "prompts.steer"
    | "chatState.get"
    | "chatState.dismissRouteBanner"
    | "chatState.saveDraft"
    | "artifacts.list"
    | "artifacts.read"
    | "files.list"
    | "files.read"
    | "chatState.exportMissingSession"
    | "chatState.dismissMissingSession"
    | "config.get"
    | "config.update",
    HostCommandHandler
  > = {
    "capabilities.describe": async (payload, scope) => {
      if (this.inflightCoreProbes) {
        await this.inflightCoreProbes;
      }
      const domain =
        typeof payload.domain === "string" ? (payload.domain as CapabilityDomainId) : undefined;
      if (domain) {
        const connectionId = this.resolveTargetConnectionId(payload, scope);
        const profileId = this.resolveTargetProfile(payload, scope, connectionId);
        const entry = this.getTransport(connectionId, profileId);
        if (entry) {
          await this.probeDomain(entry, profileId, domain, {
            force: payload.refresh === true,
          });
          this.emitCapabilities();
        }
      }
      return this.capabilityRegistry.getSnapshot();
    },

    "fleet.refresh": async () => {
      return { fleet: this.getFleetSnapshot() };
    },

    "connections.retry": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      if (connectionId !== "local") {
        const res = this.isSshConnection(connectionId)
          ? await this.connectSsh(connectionId, {
              profileId,
              forceReconnect: true,
              activateScope: true,
            })
          : await this.connectRemote(connectionId, {
              profileId,
              forceReconnect: true,
              activate: true,
            });
        return {
          ok: res.ok,
          fleet: res.fleet,
          failure: res.failure ?? null,
        };
      }
      const res = await this.connectLocal(profileId, { forceReconnect: true, activate: true });
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
      const entry = this.getTransport(connectionId, profileId);
      if (!entry) {
        return {
          profiles: scope?.connectionId || typeof payload.connectionId === "string"
            ? [...(this.profilesByConnection.get(connectionId) ?? [])]
            : this.getAllProfiles(),
        };
      }
      const profiles = await this.refreshProfiles(entry, profileId);
      return { profiles };
    },

    "scopes.switch": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const connectRes = await this.ensureTransport(connectionId, profileId, { activate: false });
      const entry = this.getTransport(connectionId, profileId);
      let transcript: SessionTranscriptSnapshot | null = null;
      if (entry) {
        await this.refreshProfiles(entry, profileId);
        const sessions = await this.refreshSessionsForProfile(entry, profileId);
        const requestedSession =
          typeof payload.sessionId === "string" && payload.sessionId.trim()
            ? payload.sessionId.trim()
            : null;
        const rememberedSession =
          this.chatSessionStateStore?.getProjection().lastSessionByScope[
            scopeKey(connectionId, profileId)
          ] ?? null;
        const validRemembered =
          rememberedSession && sessions.some((s) => s.sessionId === rememberedSession)
            ? rememberedSession
            : null;
        const resolvedSessionId =
          requestedSession ?? validRemembered ?? sessions[0]?.sessionId ?? null;
        this.activeScope = {
          connectionId,
          profileId,
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        };
        this.activeSessionId = resolvedSessionId;
        if (this.chatSessionStateStore) {
          this.chatSessionStateStore.recordActiveChat({
            connectionId,
            profileId,
            ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
          });
          this.syncChatStateWithSnapshot();
        }
        const capKey = this.capabilityRegistry.getSnapshot().key;
        if (capKey.connectionId !== connectionId || capKey.profileId !== profileId) {
          this.capabilityRegistry.applyConnectHandshake({
            connectionId,
            profileId,
            ownerGeneration: entry.ownerGeneration,
            authorityEpoch: entry.authorityEpoch,
            gatewayVersionOrSha: entry.gatewayVersionOrSha,
            describeResult: entry.describeResult,
            serverRequestsSupported: entry.capabilitiesReported,
          });
          this.emitCapabilities();
          this.scheduleCoreProbes(entry, profileId);
        }
        if (resolvedSessionId) {
          transcript = await this.loadTranscriptSnapshot(entry, profileId, resolvedSessionId);
        }
      } else {
        this.activeScope = { connectionId, profileId };
        this.activeSessionId = null;
        if (this.chatSessionStateStore) {
          this.chatSessionStateStore.recordActiveChat({ connectionId, profileId });
          this.syncChatStateWithSnapshot();
        }
      }
      this.emitFleet(connectionId);
      return {
        ok: connectRes.ok,
        fleet: this.getFleetSnapshot(),
        transcript,
      };
    },

    "sessions.list": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.getTransport(connectionId, profileId);
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

      await this.ensureTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      const sessions = await this.refreshSessionsForProfile(entry, profileId);
      const resolvedSessionId = sessionId ?? sessions[0]?.sessionId ?? null;

      this.activeScope = {
        connectionId,
        profileId,
        ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      };
      this.activeSessionId = resolvedSessionId;
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.recordActiveChat({
          connectionId,
          profileId,
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        });
        this.syncChatStateWithSnapshot();
      }

      let transcript: SessionTranscriptSnapshot | null = null;
      if (resolvedSessionId) {
        transcript = await this.loadTranscriptSnapshot(entry, profileId, resolvedSessionId);
      }
      const capKey = this.capabilityRegistry.getSnapshot().key;
      if (capKey.connectionId !== connectionId || capKey.profileId !== profileId) {
        this.capabilityRegistry.applyConnectHandshake({
          connectionId,
          profileId,
          ownerGeneration: entry.ownerGeneration,
          authorityEpoch: entry.authorityEpoch,
          gatewayVersionOrSha: entry.gatewayVersionOrSha,
          describeResult: entry.describeResult,
          serverRequestsSupported: entry.capabilitiesReported,
        });
        this.emitCapabilities();
        this.scheduleCoreProbes(entry, profileId);
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
      await this.ensureTransport(connectionId, profileId);
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
        this.translateRpcFailure(entry, err, "sessionCreate", "session.create");
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
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.recordActiveChat({
          connectionId,
          profileId,
          sessionId: created.sessionId,
        });
        this.syncChatStateWithSnapshot();
      }

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
      const resync = Boolean(payload.resync || payload.replace);
      await this.ensureTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      const transcript = await this.loadTranscriptSnapshot(entry, profileId, sessionId, {
        replace: resync,
        resynced: resync,
      });
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
        this.translateRpcFailure(entry, err, "promptSubmit", "prompt.submit");
      }

      const turnId = asString(res.turn_id ?? res.turnId, `turn-${Date.now()}`);
      const userMsgId = asString(res.user_message_id ?? res.userMessageId, `user-${Date.now()}`);
      const assistantMsgId = asString(
        res.assistant_message_id ?? res.assistantMessageId,
        `assistant-${Date.now()}`,
      );
      const nowIso = new Date().toISOString();

      this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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
      this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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
      this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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

      this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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
        this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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
        this.translateRpcFailure(entry, err, "promptCancel", "prompt.cancel");
      }

      if (res?.stopped === false) {
        this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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

      this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
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
        this.translateRpcFailure(entry, err, "promptSteer", "session.steer");
      }
    },

    "chatState.get": async () => this.getChatStateProjection(),

    "chatState.dismissRouteBanner": async () => {
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const projection = this.chatSessionStateStore.dismissRouteBanner();
      this.emitChatState();
      return projection;
    },

    "chatState.saveDraft": async (payload, scope) => {
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const profileId = this.resolveTargetProfile(payload, scope);
      const sessionId = this.resolveTargetSessionId(payload, scope);
      if (!sessionId) return this.getChatStateProjection();
      const connectionId = scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
      const ref: ActiveChatRef = {
        connectionId,
        profileId,
        sessionId,
      };
      const currentProjection = this.chatSessionStateStore.getProjection();
      const existingSummary =
        currentProjection.sessionSummaries[`${connectionId}::${profileId}::${sessionId}`];
      const text =
        typeof payload.text === "string" ? payload.text : existingSummary?.draftText ?? "";
      const annotations = Array.isArray(payload.annotations)
        ? (payload.annotations as import("@hermes/contracts").ArtifactAnnotation[])
        : undefined;
      const projection = this.chatSessionStateStore.saveDraft(
        ref,
        text,
        annotations !== undefined ? { annotations } : undefined,
      );
      this.emitChatState();
      return projection;
    },

    "artifacts.list": async () => ({ artifacts: [], stale: false, agents: [] }),
    "artifacts.read": async () => ({ artifact: null }),
    "files.list": async () => ({ files: [], stale: false, gitDiffs: [] }),
    "files.read": async () => ({ file: null }),

    "chatState.exportMissingSession": async (_payload, scope) => {
      if (!this.chatSessionStateStore) return null;
      const ref: ActiveChatRef | undefined =
        scope?.connectionId && scope?.profileId
          ? {
              connectionId: scope.connectionId,
              profileId: scope.profileId,
              ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
            }
          : undefined;
      return this.chatSessionStateStore.exportMissingSession(ref);
    },

    "chatState.dismissMissingSession": async () => {
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const allSessions = this.getAllSessions();
      const projection = this.chatSessionStateStore.dismissMissingSession(allSessions);
      if (projection.lastActiveChat) {
        this.activeScope = {
          connectionId: projection.lastActiveChat.connectionId,
          profileId: projection.lastActiveChat.profileId,
          ...(projection.lastActiveChat.sessionId
            ? { sessionId: projection.lastActiveChat.sessionId }
            : {}),
        };
        this.activeSessionId = projection.lastActiveChat.sessionId ?? null;
        if (this.activeSessionId && this.activeScope.profileId) {
          const entry = this.getTransport(
            this.activeScope.connectionId,
            this.activeScope.profileId,
          );
          if (entry) {
            await this.loadTranscriptSnapshot(entry, this.activeScope.profileId, this.activeSessionId);
          }
        }
      }
      this.emitChatState();
      this.emitFleet();
      return projection;
    },

    "config.get": async (payload, scope): Promise<GatewayConfigSnapshot> => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.getTransport(connectionId, profileId);
      const nowIso = new Date().toISOString();
      if (!entry || this.capabilityRegistry.isMethodRefused("config.get")) {
        return {
          scope: { connectionId, profileId },
          supported: false,
          readOnly: true,
          supportedKeys: [],
          values: {},
          updatedAt: nowIso,
        };
      }
      try {
        const res = await entry.client.call<Record<string, unknown>>("config.get", {
          profile_id: profileId,
        });
        return this.parseGatewayConfigSnapshot(connectionId, profileId, res);
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.markMethodNotFound({
            method: "config.get",
            expectedOwnerGeneration: entry.ownerGeneration,
            expectedAuthorityEpoch: entry.authorityEpoch,
          });
          this.emitCapabilities();
        }
        return {
          scope: { connectionId, profileId },
          supported: false,
          readOnly: true,
          supportedKeys: [],
          values: {},
          updatedAt: nowIso,
        };
      }
    },

    "config.update": async (payload, scope): Promise<GatewayConfigUpdateResult> => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const key = typeof payload.key === "string" ? payload.key.trim() : "";
      const value = payload.value as GatewayConfigValue;
      if (!key || !isAllowedGatewayConfigKey(key)) {
        throw makeBridgeError("invalid_request", "不支持更新该配置项");
      }
      const entry = this.requireTransport(connectionId, profileId);
      if (this.capabilityRegistry.isMethodRefused("config.update")) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 拒绝更新配置");
      }
      try {
        const res = await entry.client.call<Record<string, unknown>>("config.update", {
          profile_id: profileId,
          key,
          value,
        });
        return {
          ok: true,
          snapshot: this.parseGatewayConfigSnapshot(connectionId, profileId, res),
        };
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.markMethodNotFound({
            method: "config.update",
            expectedOwnerGeneration: entry.ownerGeneration,
            expectedAuthorityEpoch: entry.authorityEpoch,
          });
          this.emitCapabilities();
          throw makeBridgeError("capability_unavailable", "当前 Gateway 未提供 config.update 能力");
        }
        throw makeBridgeError("internal", "更新配置失败");
      }
    },
  };

  private parseGatewayConfigSnapshot(
    connectionId: string,
    profileId: string,
    raw: Record<string, unknown> | null | undefined,
  ): GatewayConfigSnapshot {
    const nowIso = new Date().toISOString();
    if (!raw || typeof raw !== "object") {
      return {
        scope: { connectionId, profileId },
        supported: false,
        readOnly: true,
        supportedKeys: [],
        values: {},
        updatedAt: nowIso,
      };
    }
    const rawValuesObj =
      raw.values && typeof raw.values === "object" && !Array.isArray(raw.values)
        ? (raw.values as Record<string, unknown>)
        : raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
          ? (raw.config as Record<string, unknown>)
          : raw;
    const rawKeys = Array.isArray(raw.supported_keys)
      ? raw.supported_keys
      : Array.isArray(raw.supportedKeys)
        ? raw.supportedKeys
        : Object.keys(rawValuesObj);
    const supportedKeys: string[] = [];
    const values: Record<string, GatewayConfigValue> = {};
    for (const k of rawKeys) {
      if (typeof k !== "string" || !isAllowedGatewayConfigKey(k)) continue;
      if (!supportedKeys.includes(k)) {
        supportedKeys.push(k);
      }
      const val = rawValuesObj[k];
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        values[k] = val;
      }
    }
    return {
      scope: { connectionId, profileId },
      supported: supportedKeys.length > 0,
      readOnly: Boolean(raw.read_only ?? raw.readOnly ?? false),
      supportedKeys,
      values,
      updatedAt: nowIso,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubRegistry?.();
    for (const [key, entry] of this.transports.entries()) {
      this.disposeTransportEntry(key, entry);
    }
    this.transports.clear();
    this.subscribers.clear();
    await this.sshTransport?.disposeAll();
  }
}

export const LocalConnectionSupervisor = ConnectionSupervisor;
