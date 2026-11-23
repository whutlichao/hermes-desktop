import type {
  ActivityEventPayload,
  ActiveChatRef,
  ArtifactAnnotation,
  BackgroundNotificationKind,
  BridgeEvent,
  BridgeScope,
  CapabilityDomainId,
  CapabilitySnapshot,
  ChatSessionProjection,
  CheckpointDiffSnapshot,
  ConnectionActualState,
  ConnectionDesiredState,
  ConnectionHealthSummary,
  ConnectionLinkSummary,
  DraftAttachment,
  DraftComposerState,
  DraftContextItem,
  DraftDeliveryStatus,
  ErrorCode,
  FleetSnapshot,
  GatewayConfigSnapshot,
  GatewayConfigUpdateResult,
  GatewayConfigValue,
  LocalFailureCode,
  LocalInspectResult,
  LocalTypedFailure,
  ProfileSummary,
  PromptEventPayload,
  RegistryDiff,
  RegistrySnapshotView,
  SafeBackgroundNotification,
  SessionSummary,
  SessionTranscriptSnapshot,
  SshFailureCode,
  SubagentTailSnapshot,
  SupportedChatActions,
  ToolExecutionRow,
  TranscriptMessage,
  TranscriptPatchPayload,
  WorkspaceAgentItem,
  WorkspaceCheckpointItem,
} from "@hermes/contracts";
import {
  aggregateConnectionHealth,
  buildSafeBackgroundNotification,
  CAPABILITY_DOMAIN_CATALOG,
  computeFullJitterBackoffMs,
  computeResumeStaggerMs,
  CORE_CAPABILITY_DOMAINS,
  CapabilityRegistry,
  boundSubagentTailLines,
  classifyRuntimeCapabilities,
  getCopy,
  getLocalFailureCopy,
  isAllowedGatewayConfigKey,
  isJsonRpcMethodNotFound,
  isProfileLinkException,
  reduceTranscriptEvent,
  resolveExplicitMethodAlias,
  resolveExternalAttribution,
  resolveMethodWithAlias,
  toSupportedChatActions,
  validateCheckpointRestoreBinding,
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
import type { RegistryStore } from "./registryStore";
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
  now?: () => number;
  random?: () => number;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  isAppForeground?: () => boolean;
  onBackgroundNotification?: (notification: SafeBackgroundNotification) => void;
  maxConcurrentDials?: number;
}

type DialMaterial = LocalDialMaterial | SshDialMaterial;

interface ConnectionLinkState {
  connectionId: string;
  profileId: string;
  desired: ConnectionDesiredState;
  actual: ConnectionActualState;
  degraded: boolean;
  pinned: boolean;
  latencyMs: number | null;
  nextRetryAt: number | null;
  attempt: number;
  errorCode?: ErrorCode;
  unavailableCode?: LocalFailureCode;
  message?: string;
  wasDesiredBeforeSuspend: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
}

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
  lastInboundAt: number;
  lastPingSentAt: number | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  unsubNotification: () => void;
  unsubClose: () => void;
  unsubInbound: () => void;
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
          attribution: resolveExternalAttribution({
            origin: typeof row.origin === "string" ? row.origin : undefined,
            source: typeof row.source === "string" ? row.source : undefined,
            mcpServer:
              typeof (row.mcp_server ?? row.mcpServer ?? row.server) === "string"
                ? String(row.mcp_server ?? row.mcpServer ?? row.server)
                : undefined,
            pluginName:
              typeof (row.plugin ?? row.pluginName) === "string"
                ? String(row.plugin ?? row.pluginName)
                : undefined,
            skillName:
              typeof (row.skill ?? row.skillName) === "string"
                ? String(row.skill ?? row.skillName)
                : undefined,
            toolset:
              typeof (row.external_provider ?? row.toolset) === "string"
                ? String(row.external_provider ?? row.toolset)
                : undefined,
          }),
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

function isProfileUnavailableRpcError(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return false;
  if (err.rpcCode === -32004) return true;
  const msg = err.message.toLowerCase();
  return msg.includes("profile_not_served") || msg.includes("profile_mismatch") || msg.includes("profile_unavailable");
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
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly isAppForeground: () => boolean;
  private readonly onBackgroundNotification?: (notification: SafeBackgroundNotification) => void;
  private readonly maxConcurrentDials: number;

  private revision = 1;
  private subscriberSeq = 0;
  private ownerGenerationSeq = 0;
  private inflightCoreProbes: Promise<void> | null = null;
  private disposed = false;
  private shuttingDown = false;
  private suspended = false;

  private localHealth: ConnectionHealthSummary;
  private readonly remoteHealth = new Map<string, ConnectionHealthSummary>();
  private readonly sshHealthById = new Map<string, ConnectionHealthSummary>();
  private readonly linksByKey = new Map<string, ConnectionLinkState>();
  private readonly profilesByConnection = new Map<string, ProfileSummary[]>();
  private readonly sessionsByScope = new Map<string, SessionSummary[]>();
  private readonly transcripts = new Map<string, SessionTranscriptSnapshot>();
  private readonly lastKnownSubagentsBySession = new Map<string, WorkspaceAgentItem[]>();
  private readonly transports = new Map<string, GatewayTransportEntry>();
  private readonly connectingByKey = new Map<string, Promise<SupervisorConnectResult>>();
  private readonly subscribers = new Map<number, SubscriberRecord>();
  private readonly staggerTimers = new Set<ReturnType<typeof setTimeout>>();

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
    this.now = options?.now ?? (() => Date.now());
    this.random = options?.random ?? (() => Math.random());
    this.setTimer = options?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options?.clearTimer ?? ((handle) => clearTimeout(handle));
    this.isAppForeground = options?.isAppForeground ?? (() => true);
    this.onBackgroundNotification = options?.onBackgroundNotification;
    this.maxConcurrentDials = Math.max(1, options?.maxConcurrentDials ?? 4);
    this.localHealth = {
      connectionId: "local",
      label: this.getLocalLabel(),
      kind: "local",
      originDisplay: "127.0.0.1",
      desired: "enabled",
      actual: "idle",
      aggregateState: "idle",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
      profileExceptionCount: 0,
    };
    this.ensureLinkState("local", "default", "enabled");

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
        this.invalidateCapabilitiesOnRegistryDiff(ev.diff);
        this.syncRegistryEntries(ev.snapshot);
        this.syncHealthPlaceholdersFromRegistry(ev.snapshot);
      });
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  hasInflightDials(): boolean {
    return this.connectingByKey.size > 0;
  }

  async waitForInflightDials(): Promise<void> {
    if (this.connectingByKey.size === 0) return;
    await Promise.allSettled([...this.connectingByKey.values()]);
  }

  private ensureLinkState(
    connectionId: string,
    profileId: string,
    defaultDesired: ConnectionDesiredState = "disabled",
  ): ConnectionLinkState {
    const key = scopeKey(connectionId, profileId);
    const existing = this.linksByKey.get(key);
    if (existing) {
      return existing;
    }
    const created: ConnectionLinkState = {
      connectionId,
      profileId,
      desired: this.suspended ? "suspended" : defaultDesired,
      actual: "idle",
      degraded: false,
      pinned: false,
      latencyMs: null,
      nextRetryAt: null,
      attempt: 0,
      wasDesiredBeforeSuspend: defaultDesired === "enabled",
      retryTimer: null,
      stableTimer: null,
    };
    this.linksByKey.set(key, created);
    return created;
  }

  private clearLinkTimers(link: ConnectionLinkState): void {
    if (link.retryTimer !== null) {
      this.clearTimer(link.retryTimer);
      link.retryTimer = null;
    }
    if (link.stableTimer !== null) {
      this.clearTimer(link.stableTimer);
      link.stableTimer = null;
    }
  }

  private getLinksForConnection(connectionId: string): ConnectionLinkState[] {
    const out: ConnectionLinkState[] = [];
    for (const link of this.linksByKey.values()) {
      if (link.connectionId === connectionId) {
        out.push(link);
      }
    }
    return out;
  }

  private computeProfilePinned(connectionId: string, profileId: string): boolean {
    const sk = scopeKey(connectionId, profileId);
    const sessions = this.sessionsByScope.get(sk) ?? [];
    for (const s of sessions) {
      if (s.activeTurnId || s.status === "running" || s.needsInput) {
        return true;
      }
    }
    const prefix = `${connectionId}::${profileId}::`;
    for (const [tk, tx] of this.transcripts.entries()) {
      if (!tk.startsWith(prefix)) continue;
      if (tx.activeTurnId || tx.turnStopping || tx.messages.some((m) => m.streaming || m.status === "streaming")) {
        return true;
      }
    }
    return false;
  }

  private syncProfileAndConnectionProjections(connectionId: string): void {
    const links: ConnectionLinkSummary[] = [];
    for (const link of this.linksByKey.values()) {
      if (link.connectionId !== connectionId) continue;
      link.pinned = this.computeProfilePinned(connectionId, link.profileId);
      links.push({
        connectionId: link.connectionId,
        profileId: link.profileId,
        desired: link.desired,
        actual: link.actual,
        degraded: link.degraded,
        pinned: link.pinned,
        latencyMs: link.latencyMs,
        nextRetryAt: link.nextRetryAt,
        attempt: link.attempt,
        ...(link.errorCode ? { errorCode: link.errorCode } : {}),
        ...(link.unavailableCode ? { unavailableCode: link.unavailableCode } : {}),
        ...(link.message ? { message: link.message } : {}),
      });
    }

    const base =
      connectionId === "local"
        ? { ...this.localHealth, label: this.getLocalLabel() }
        : this.remoteHealth.get(connectionId) ?? this.sshHealthById.get(connectionId) ?? null;
    const aggregated = base ? aggregateConnectionHealth({ base, links }) : null;
    const gatewayAggregate = aggregated?.aggregateState ?? "idle";

    const profiles = this.profilesByConnection.get(connectionId);
    if (profiles && profiles.length > 0) {
      const nextProfiles = profiles.map((p) => {
        const link = this.linksByKey.get(scopeKey(connectionId, p.profileId));
        if (!link) return p;
        const summary: ConnectionLinkSummary = {
          connectionId,
          profileId: p.profileId,
          desired: link.desired,
          actual: link.actual,
          degraded: link.degraded,
          pinned: link.pinned,
          latencyMs: link.latencyMs,
          nextRetryAt: link.nextRetryAt,
          attempt: link.attempt,
          ...(link.errorCode ? { errorCode: link.errorCode } : {}),
          ...(link.unavailableCode ? { unavailableCode: link.unavailableCode } : {}),
          ...(link.message ? { message: link.message } : {}),
        };
        return {
          ...p,
          desired: link.desired,
          actual: link.actual,
          degraded: link.degraded,
          pinned: link.pinned,
          isException: isProfileLinkException(summary, gatewayAggregate),
          ...(link.unavailableCode ? { unavailableCode: link.unavailableCode } : { unavailableCode: undefined }),
          ...(link.errorCode ? { errorCode: link.errorCode } : { errorCode: undefined }),
          ...(link.message ? { message: link.message } : { message: undefined }),
        };
      });
      this.profilesByConnection.set(connectionId, nextProfiles);
    }

    if (!aggregated) return;

    if (connectionId === "local") {
      this.localHealth = aggregated;
    } else if (this.remoteHealth.has(connectionId)) {
      this.remoteHealth.set(connectionId, aggregated);
    } else if (this.sshHealthById.has(connectionId)) {
      this.sshHealthById.set(connectionId, aggregated);
    }
  }

  getConnectionLink(connectionId: string, profileId: string): ConnectionLinkSummary | null {
    this.syncProfileAndConnectionProjections(connectionId);
    const link = this.linksByKey.get(scopeKey(connectionId, profileId));
    if (!link) return null;
    return {
      connectionId: link.connectionId,
      profileId: link.profileId,
      desired: link.desired,
      actual: link.actual,
      degraded: link.degraded,
      pinned: link.pinned,
      latencyMs: link.latencyMs,
      nextRetryAt: link.nextRetryAt,
      attempt: link.attempt,
      ...(link.errorCode ? { errorCode: link.errorCode } : {}),
      ...(link.unavailableCode ? { unavailableCode: link.unavailableCode } : {}),
      ...(link.message ? { message: link.message } : {}),
    };
  }

  async refreshProfilesForConnection(connectionId: string): Promise<ProfileSummary[]> {
    const defaultProfile =
      connectionId === "local"
        ? "default"
        : this.getSshTargetForConnection(connectionId)?.defaultProfile ?? "default";
    const entry = this.getTransport(connectionId, defaultProfile);
    if (!entry) {
      return [...(this.profilesByConnection.get(connectionId) ?? [])];
    }
    return this.refreshProfiles(entry, defaultProfile);
  }

  notifyBackgroundEventForTest(params: {
    kind: BackgroundNotificationKind;
    scope: BridgeScope;
    rawPayload?: Record<string, unknown>;
  }): SafeBackgroundNotification | null {
    const notif = buildSafeBackgroundNotification({
      kind: params.kind,
      isAppForeground: this.isAppForeground(),
      scope: params.scope,
      rawSecretOrCommand: params.rawPayload,
    });
    if (notif) {
      this.onBackgroundNotification?.(notif);
    }
    return notif;
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
    this.syncProfileAndConnectionProjections("local");
    return { ...this.localHealth, label: this.getLocalLabel() };
  }

  private getAllProfiles(): ProfileSummary[] {
    const connectionIds = new Set<string>(["local", ...this.remoteHealth.keys(), ...this.sshHealthById.keys()]);
    for (const cid of connectionIds) {
      this.syncProfileAndConnectionProjections(cid);
    }
    const out: ProfileSummary[] = [];
    for (const list of this.profilesByConnection.values()) {
      out.push(...list);
    }
    return out;
  }

  private syncRegistryEntries(snapshot: ReturnType<RegistryStore["snapshot"]>): void {
    const dialableRemoteIds = new Set<string>();
    for (const entry of snapshot.connections) {
      if (entry.kind !== "remote") continue;
      if (!entry.dialable) {
        const defaultPid = entry.remoteProfile?.trim() || "default";
        const link = this.ensureLinkState(entry.id, defaultPid, "enabled");
        link.actual = "blocked";
        link.degraded = true;
        link.errorCode = "invalid_request";
        link.message = "远端 Gateway 配置无效";
        this.remoteHealth.set(entry.id, {
          connectionId: entry.id,
          label: entry.label,
          kind: "remote",
          originDisplay: entry.originDisplay ?? "",
          desired: link.desired,
          actual: "blocked",
          aggregateState: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: "invalid_request",
          message: link.message,
        });
        dialableRemoteIds.add(entry.id);
        continue;
      }
      dialableRemoteIds.add(entry.id);
      const defaultPid = entry.remoteProfile?.trim() || "default";
      this.ensureLinkState(entry.id, defaultPid, "enabled");
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
          desired: this.suspended ? "suspended" : "enabled",
          actual: "idle",
          aggregateState: this.suspended ? "suspended" : "idle",
          degraded: false,
          latencyMs: null,
          nextRetryAt: null,
        });
      }
      this.syncProfileAndConnectionProjections(entry.id);
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
    for (const [lk, link] of [...this.linksByKey.entries()]) {
      if (link.connectionId === connectionId) {
        this.clearLinkTimers(link);
        link.desired = "disabled";
        link.actual = "idle";
        this.linksByKey.delete(lk);
      }
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

  private invalidateCapabilitiesOnRegistryDiff(diff?: RegistryDiff): void {
    if (this.disposed || !diff) return;
    let shouldInvalidateCapabilities = false;
    const activeCapConnectionId = this.capabilityRegistry.getSnapshot().key.connectionId;
    for (const change of diff.changes) {
      if (change.kind === "connection_removed") {
        if (change.connectionId === activeCapConnectionId) {
          shouldInvalidateCapabilities = true;
        }
      } else if (change.kind === "connection_updated" && change.dialMaterialChanged) {
        if (change.connectionId === activeCapConnectionId) {
          shouldInvalidateCapabilities = true;
        }
      }
    }
    if (shouldInvalidateCapabilities || diff.credentialsChanged) {
      this.capabilityRegistry.invalidate({ reason: "registry_changed" });
      this.emitCapabilities();
    }
  }
  getFleetSnapshot(): FleetSnapshot {
    const allSessions: SessionSummary[] = [];
    for (const list of this.sessionsByScope.values()) {
      allSessions.push(...list);
    }
    const profiles = this.getAllProfiles();
    const localProfiles = this.profilesByConnection.get("local") ?? [];
    const includeLocal =
      this.localHealth.actual !== "idle" ||
      this.localHealth.desired === "suspended" ||
      localProfiles.length > 0 ||
      allSessions.some((s) => s.connectionId === "local") ||
      Boolean(this.localHealth.errorCode);

    const connections: ConnectionHealthSummary[] = [];
    if (includeLocal) {
      connections.push(this.getLocalHealth());
    }
    for (const remoteId of this.remoteHealth.keys()) {
      this.syncProfileAndConnectionProjections(remoteId);
      const remote = this.remoteHealth.get(remoteId);
      if (remote) connections.push({ ...remote });
    }
    for (const sshId of this.sshHealthById.keys()) {
      this.syncProfileAndConnectionProjections(sshId);
      const sshHealth = this.sshHealthById.get(sshId);
      if (sshHealth) connections.push({ ...sshHealth });
    }

    return {
      connections,
      profiles,
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
      if (conn.kind !== "ssh") continue;
      const defaultProfile = conn.remoteProfile?.trim() || "default";
      if (!conn.dialable) {
        validSshIds.add(conn.id);
        const link = this.ensureLinkState(conn.id, defaultProfile, "enabled");
        link.actual = "blocked";
        link.degraded = true;
        link.errorCode = "invalid_request";
        link.message = "SSH Gateway 配置无效";
        this.sshHealthById.set(conn.id, {
          connectionId: conn.id,
          label: conn.label,
          kind: "ssh",
          originDisplay: conn.sshTargetDisplay ?? conn.sshHost ?? conn.id,
          desired: link.desired,
          actual: "blocked",
          aggregateState: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: "invalid_request",
          message: link.message,
        });
        continue;
      }
      validSshIds.add(conn.id);
      this.ensureLinkState(conn.id, defaultProfile, "enabled");
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
          desired: this.suspended ? "suspended" : "enabled",
          actual: "idle",
          aggregateState: this.suspended ? "suspended" : "idle",
          degraded: false,
          latencyMs: null,
          nextRetryAt: null,
        });
      }
      this.syncProfileAndConnectionProjections(conn.id);
    }
    for (const id of [...this.sshHealthById.keys()]) {
      if (!validSshIds.has(id)) {
        this.sshHealthById.delete(id);
      }
    }
  }

  async handleRegistrySnapshot(snapshot: RegistrySnapshotView, diff?: RegistryDiff): Promise<void> {
    this.invalidateCapabilitiesOnRegistryDiff(diff);
    this.syncRegistryEntries(snapshot);
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
            } else if (updated.dialable && !this.suspended && !this.disposed) {
              await this.connectSsh(change.connectionId, { forceReconnect: true });
            }
          } else if (updated?.kind === "remote") {
            if (!change.dialMaterialChanged) {
              this.emitFleet(change.connectionId);
            } else if (updated.dialable && !this.suspended && !this.disposed) {
              await this.connectRemote(change.connectionId, { forceReconnect: true, activate: false });
            }
          }
          continue;
        }
        if (change.kind === "connection_added") {
          const added = snapshot.connections.find((c) => c.id === change.connectionId);
          if (added?.kind === "ssh" && added.dialable && !this.suspended && !this.disposed) {
            await this.connectSsh(change.connectionId, { activateScope: false });
          } else if (added?.kind === "remote" && added.dialable && !this.suspended && !this.disposed) {
            await this.connectRemote(change.connectionId, { activate: false });
          }
        }
      }
    }
    this.emitFleet();
  }

  async removeConnection(connectionId: string): Promise<void> {
    if (connectionId === "local") return;
    for (const [lk, link] of [...this.linksByKey.entries()]) {
      if (link.connectionId === connectionId) {
        this.clearLinkTimers(link);
        link.desired = "disabled";
        link.actual = "idle";
        link.nextRetryAt = null;
        this.linksByKey.delete(lk);
      }
    }
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
    const createdOrphans = this.chatSessionStateStore?.orphanDraftsForRemovedConnection(connectionId) ?? [];
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
    } else if (createdOrphans.length > 0) {
      this.emitChatState();
    }
    this.emitFleet();
  }

  private markLinkReady(
    connectionId: string,
    profileId: string,
    latencyMs: number | null,
  ): void {
    const link = this.ensureLinkState(connectionId, profileId, "enabled");
    link.desired = "enabled";
    link.wasDesiredBeforeSuspend = true;
    link.actual = "ready";
    link.degraded = false;
    link.latencyMs = latencyMs;
    link.nextRetryAt = null;
    link.errorCode = undefined;
    link.unavailableCode = undefined;
    link.message = undefined;
    if (link.retryTimer !== null) {
      this.clearTimer(link.retryTimer);
      link.retryTimer = null;
    }
    if (link.stableTimer !== null) {
      this.clearTimer(link.stableTimer);
      link.stableTimer = null;
    }
    link.stableTimer = this.setTimer(() => {
      link.stableTimer = null;
      if (!this.disposed && !this.suspended && link.actual === "ready") {
        link.attempt = 0;
      }
    }, 5_000);
    this.syncProfileAndConnectionProjections(connectionId);
  }

  private scheduleLinkBackoff(
    connectionId: string,
    profileId: string,
    errorCode: ErrorCode,
    message?: string,
    unavailableCode?: LocalFailureCode,
  ): void {
    if (this.disposed || this.shuttingDown || this.suspended) return;
    const primaryLink = this.ensureLinkState(connectionId, profileId, "enabled");
    if (primaryLink.desired !== "enabled") return;

    const existingTransport = this.transports.get(`${connectionId}::shared`);
    const isSharedMode =
      !existingTransport || existingTransport.transportMode === "shared-host-scope";

    const targetLinks = isSharedMode
      ? this.getLinksForConnection(connectionId).filter(
          (l) => l.desired === "enabled" && l.unavailableCode !== "profile_unavailable",
        )
      : [primaryLink];
    if (!targetLinks.includes(primaryLink)) {
      targetLinks.push(primaryLink);
    }

    const baseAttempt = primaryLink.attempt;
    const delayMs = computeFullJitterBackoffMs(baseAttempt, this.random());
    const nextRetryAt = this.now() + delayMs;

    for (const link of targetLinks) {
      if (link.stableTimer !== null) {
        this.clearTimer(link.stableTimer);
        link.stableTimer = null;
      }
      if (link.retryTimer !== null) {
        this.clearTimer(link.retryTimer);
        link.retryTimer = null;
      }
      link.attempt = baseAttempt + 1;
      link.actual = "reconnecting";
      link.degraded = true;
      link.latencyMs = null;
      link.nextRetryAt = nextRetryAt;
      link.errorCode = errorCode;
      link.unavailableCode = unavailableCode;
      link.message = message;
    }

    this.syncProfileAndConnectionProjections(connectionId);
    this.emitFleet(connectionId);

    primaryLink.retryTimer = this.setTimer(() => {
      primaryLink.retryTimer = null;
      if (this.disposed || this.shuttingDown || this.suspended || primaryLink.desired !== "enabled") {
        return;
      }
      if (connectionId === "local") {
        void this.connectLocal(profileId, { forceReconnect: true });
      } else if (this.isSshConnection(connectionId)) {
        void this.connectSsh(connectionId, { profileId, forceReconnect: true });
      } else {
        void this.connectRemote(connectionId, { profileId, forceReconnect: true });
      }
    }, delayMs);
  }

  private scheduleTransportHeartbeat(entry: GatewayTransportEntry): void {
    if (entry.heartbeatTimer !== null) {
      this.clearTimer(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
    if (this.disposed || this.shuttingDown || this.suspended || entry.disposed) {
      return;
    }
    entry.heartbeatTimer = this.setTimer(() => {
      entry.heartbeatTimer = null;
      if (this.disposed || this.shuttingDown || this.suspended || entry.disposed || !entry.client.isOpen()) {
        return;
      }
      const elapsed = this.now() - entry.lastInboundAt;
      if (elapsed >= 45_000) {
        this.handleTransportHeartbeatTimeout(entry);
        return;
      }
      const servedMethods = Array.isArray(entry.describeResult?.served_methods)
        ? (entry.describeResult?.served_methods as unknown[])
        : [];
      if (servedMethods.includes("gateway.ping")) {
        const sentAt = this.now();
        entry.lastPingSentAt = sentAt;
        void entry.client
          .call("gateway.ping", {}, { timeoutMs: 10_000 })
          .then(() => {
            if (this.disposed || entry.disposed) return;
            const rtt = Math.max(1, this.now() - sentAt);
            entry.lastInboundAt = this.now();
            this.updateReadyLinksLatency(entry.connectionId, rtt);
          })
          .catch(() => {
            // Tracked by 45s inbound deadline
          });
      }
      this.scheduleTransportHeartbeat(entry);
    }, 15_000);
  }

  private updateReadyLinksLatency(connectionId: string, latencyMs: number): void {
    for (const link of this.linksByKey.values()) {
      if (link.connectionId === connectionId && link.actual === "ready") {
        link.latencyMs = latencyMs;
      }
    }
    this.syncProfileAndConnectionProjections(connectionId);
    this.emitFleet(connectionId);
  }

  private handleTransportHeartbeatTimeout(entry: GatewayTransportEntry): void {
    if (this.disposed || entry.disposed) return;
    this.disposeTransportEntry(entry.key, entry);
    this.handleUnexpectedTransportClose(entry);
  }

  private handleUnexpectedTransportClose(entry: GatewayTransportEntry): void {
    if (this.disposed || this.shuttingDown || this.suspended) return;
    const connectionId = entry.connectionId;
    const hasRemaining = [...this.transports.values()].some(
      (t) => t.connectionId === connectionId && !t.disposed && t.client.isOpen(),
    );
    if (!hasRemaining) {
      if (connectionId === "local" || this.activeScope?.connectionId === connectionId) {
        this.capabilityRegistry.invalidate({ reason: "transport_closed" });
        this.emitCapabilities();
      }
    }

    if (entry.kind === "local" && entry.dial) {
      void this.reconnectLocalAfterDrop(entry.dial as LocalDialMaterial);
      return;
    }
    if (entry.kind === "ssh" && this.sshTransport && entry.dial) {
      void this.reconnectSshAfterDrop(connectionId, entry.dial.profileId, entry.dial.instanceId);
      return;
    }
    this.scheduleLinkBackoff(connectionId, entry.defaultProfileId, "unreachable");
  }

  private async reconnectLocalAfterDrop(previousDial: LocalDialMaterial): Promise<void> {
    if (this.disposed || this.shuttingDown || this.suspended) return;
    const link = this.ensureLinkState("local", previousDial.profileId, "enabled");
    if (link.desired !== "enabled") return;

    const inflightKey = `local-drop::${previousDial.profileId}`;
    if (this.connectingByKey.has(inflightKey)) return;

    const runner = (async (): Promise<SupervisorConnectResult> => {
      const startedAt = this.now();
      const minted = await this.localBackend.mintReconnectTicket(previousDial);
      if (minted.ok) {
        const ticket = minted.consumeTicket();
        if (ticket) {
          const transportKey =
            previousDial.transportMode === "shared-host-scope"
              ? "local::shared"
              : `local::profile:${previousDial.profileId}`;
          return this.finishGatewayHandshake({
            connectionId: "local",
            kind: "local",
            label: this.getLocalLabel(),
            originDisplay: "127.0.0.1",
            transportKey,
            dial: previousDial,
            ticket,
            startedAt,
          });
        }
      }

      // If ticket_unavailable, re-attach / re-open serve once before entering exponential backoff
      if (!minted.ok && minted.failure.code === "ticket_unavailable") {
        const reattached = await this.localBackend.prepareDial({ profileId: previousDial.profileId });
        if (reattached.ok) {
          let ticket = reattached.dial.consumeTicket();
          if (!ticket) {
            const reminted = await this.localBackend.mintReconnectTicket(reattached.dial);
            if (reminted.ok) {
              ticket = reminted.consumeTicket();
            }
          }
          if (ticket) {
            const transportKey =
              reattached.dial.transportMode === "shared-host-scope"
                ? "local::shared"
                : `local::profile:${reattached.dial.profileId}`;
            return this.finishGatewayHandshake({
              connectionId: "local",
              kind: "local",
              label: this.getLocalLabel(),
              originDisplay: "127.0.0.1",
              transportKey,
              dial: reattached.dial,
              ticket,
              startedAt,
            });
          }
        }
      }

      const failure = !minted.ok ? minted.failure : undefined;
      this.scheduleLinkBackoff(
        "local",
        previousDial.profileId,
        mapLocalFailureToErrorCode(failure),
        failure ? getLocalFailureCopy(failure.code).whatHappened : undefined,
        failure?.code,
      );
      return { ok: false, failure, fleet: this.getFleetSnapshot() };
    })().finally(() => {
      this.connectingByKey.delete(inflightKey);
    });

    this.connectingByKey.set(inflightKey, runner);
    await runner;
  }

  private async ensureScopeTransport(
    connectionId: string,
    profileId: string,
    options?: { forceReconnect?: boolean; activate?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed || this.shuttingDown) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }
    const link = this.ensureLinkState(connectionId, profileId, "enabled");
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
    }
    if (options?.forceReconnect) {
      for (const link of this.getLinksForConnection(connectionId)) {
        if (link.retryTimer !== null) {
          this.clearTimer(link.retryTimer);
          link.retryTimer = null;
          link.nextRetryAt = null;
        }
      }
    }

    if (!options?.forceReconnect) {
      const existing = this.getTransport(connectionId, profileId);
      if (existing) {
        const ok = await this.activateOrRefreshProfileOnSharedTransport(existing, profileId);
        return { ok, fleet: this.getFleetSnapshot() };
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
    if (this.disposed || this.shuttingDown || !this.registryStore) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const snap = this.registryStore.snapshot();
    const conn = snap.connections.find((c) => c.id === connectionId);
    const defaultPid = options?.profileId ?? conn?.remoteProfile ?? "default";
    const link = this.ensureLinkState(connectionId, defaultPid, "enabled");
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
    }
    if (options?.forceReconnect) {
      for (const link of this.getLinksForConnection(connectionId)) {
        if (link.retryTimer !== null) {
          this.clearTimer(link.retryTimer);
          link.retryTimer = null;
          link.nextRetryAt = null;
        }
      }
    }

    if (!options?.forceReconnect) {
      const existing = this.getTransport(connectionId, defaultPid);
      if (existing) {
        const pid = options?.profileId ?? existing.defaultProfileId;
        const ok = await this.activateOrRefreshProfileOnSharedTransport(existing, pid);
        const sessions = this.sessionsByScope.get(scopeKey(connectionId, pid)) ?? [];
        if (options?.activate && ok) {
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
        return { ok, fleet: this.getFleetSnapshot() };
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
    if (this.disposed || this.shuttingDown || !this.registryStore) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const snapshot = this.registryStore.snapshot();
    const conn = snapshot.connections.find((c) => c.id === connectionId);
    if (!conn || conn.kind !== "remote" || !conn.dialable || !conn.originDisplay) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }
    const targetProfileId = options?.profileId ?? conn.remoteProfile ?? "default";
    const link = this.ensureLinkState(connectionId, targetProfileId, "enabled");

    const endpointCheck = validateRemoteEndpointUrl(conn.originDisplay);
    if (!endpointCheck.valid) {
      link.actual = "blocked";
      link.degraded = true;
      link.latencyMs = null;
      link.nextRetryAt = null;
      link.errorCode = "invalid_request";
      link.message = getCopy(endpointCheck.messageKey);
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
      this.syncProfileAndConnectionProjections(connectionId);
      this.emitFleet(connectionId);
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const transportKey = `remote:${connectionId}`;
    if (options?.forceReconnect) {
      const stale = this.transports.get(transportKey);
      if (stale) this.disposeTransportEntry(transportKey, stale);
    }

    link.actual = "connecting";
    link.degraded = false;
    link.latencyMs = null;
    link.nextRetryAt = null;
    link.errorCode = undefined;
    link.message = undefined;
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
    this.syncProfileAndConnectionProjections(connectionId);
    this.emitFleet(connectionId);

    const startedAt = this.now();
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
      link.actual = "auth_required";
      link.degraded = true;
      link.latencyMs = null;
      link.nextRetryAt = null;
      link.errorCode = "auth_required";
      link.message = getCopy("remote.authRequiredBody");
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
      this.syncProfileAndConnectionProjections(connectionId);
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
      if (isAuth) {
        link.actual = "auth_required";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = "auth_required";
        link.message = getCopy("remote.authRequiredBody");
        this.remoteHealth.set(connectionId, {
          connectionId,
          label: conn.label,
          kind: "remote",
          originDisplay: endpointCheck.originDisplay,
          actual: "auth_required",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: errCode,
          message: getCopy("remote.authRequiredBody"),
        });
        this.syncProfileAndConnectionProjections(connectionId);
        this.emitFleet(connectionId);
      } else if (errCode === "timeout" || errCode === "unreachable") {
        this.remoteHealth.set(connectionId, {
          connectionId,
          label: conn.label,
          kind: "remote",
          originDisplay: endpointCheck.originDisplay,
          actual: "reconnecting",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: errCode,
        });
        this.scheduleLinkBackoff(connectionId, targetProfileId, errCode);
      } else {
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = errCode;
        this.remoteHealth.set(connectionId, {
          connectionId,
          label: conn.label,
          kind: "remote",
          originDisplay: endpointCheck.originDisplay,
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: errCode,
        });
        this.syncProfileAndConnectionProjections(connectionId);
        this.emitFleet(connectionId);
      }
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    let describeRes: Record<string, unknown> | undefined;
    try {
      describeRes = await client.call<Record<string, unknown>>("runtime.describe", {});
    } catch (err) {
      if (!isJsonRpcMethodNotFound(err)) {
        client.close();
        const isAuth = isRpcAuthError(err);
        link.actual = isAuth ? "auth_required" : "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = isAuth ? "auth_required" : "protocol_unsupported";
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
        this.syncProfileAndConnectionProjections(connectionId);
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
      lastInboundAt: this.now(),
      lastPingSentAt: null,
      heartbeatTimer: null,
      unsubNotification: () => {},
      unsubClose: () => {},
      unsubInbound: () => {},
    };

    entry.unsubInbound = client.onInboundFrame((opcode) => {
      entry.lastInboundAt = this.now();
      if (opcode === 0xA && entry.lastPingSentAt !== null) {
        const rtt = Math.max(1, this.now() - entry.lastPingSentAt);
        entry.lastPingSentAt = null;
        this.updateReadyLinksLatency(connectionId, rtt);
      }
    });
    entry.unsubNotification = client.onNotification((method, params) => {
      this.handleGatewayNotification(entry, method, params);
    });
    entry.unsubClose = client.onClose((reason) => {
      if (this.disposed || entry.disposed || reason === "client_closed") return;
      this.disposeTransportEntry(transportKey, entry);
      const current = this.remoteHealth.get(connectionId);
      if (current && current.actual !== "auth_required") {
        this.handleUnexpectedTransportClose(entry);
      }
    });

    const previous = this.transports.get(transportKey);
    if (previous) {
      this.disposeTransportEntry(transportKey, previous);
    }
    this.transports.set(transportKey, entry);
    this.scheduleTransportHeartbeat(entry);

    const latencyMs = Math.max(1, this.now() - startedAt);
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
    this.markLinkReady(connectionId, targetProfileId, latencyMs);

    const profiles = await this.refreshProfiles(entry, targetProfileId);
    const activeProfileId =
      profiles.find((p) => p.profileId === targetProfileId)?.profileId ??
      profiles[0]?.profileId ??
      targetProfileId;
    entry.defaultProfileId = activeProfileId;
    if (activeProfileId !== targetProfileId) {
      this.markLinkReady(connectionId, activeProfileId, latencyMs);
    }
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
    if (this.disposed || this.shuttingDown) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const link = this.ensureLinkState("local", profileId, "enabled");
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
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

    link.actual = "connecting";
    link.degraded = false;
    link.errorCode = undefined;
    link.unavailableCode = undefined;
    link.message = undefined;
    link.nextRetryAt = null;
    this.localHealth = {
      ...this.localHealth,
      label: this.getLocalLabel(),
      actual: "connecting",
      degraded: false,
      errorCode: undefined,
      message: undefined,
      nextRetryAt: null,
    };
    this.syncProfileAndConnectionProjections("local");
    this.syncChatStateWithSnapshot();
    this.emitFleet("local");

    const startedAt = this.now();
    const dialResult = await this.localBackend.prepareDial({ profileId });
    if (!dialResult.ok) {
      const errCode = mapLocalFailureToErrorCode(dialResult.failure);
      const msg = getLocalFailureCopy(dialResult.failure.code).whatHappened;
      const isRetryable =
        dialResult.failure.autoRetry || dialResult.inspection.actual === "reconnecting";
      this.localHealth = {
        ...this.localHealth,
        label: this.getLocalLabel(),
        actual: isRetryable ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        errorCode: errCode,
        message: msg,
      };
      if (isRetryable) {
        this.scheduleLinkBackoff("local", profileId, errCode, msg, dialResult.failure.code);
      } else {
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.errorCode = errCode;
        link.unavailableCode = dialResult.failure.code;
        link.message = msg;
        this.syncProfileAndConnectionProjections("local");
        this.syncChatStateWithSnapshot();
        this.emitFleet("local");
      }
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
        if (minted.failure.code === "ticket_unavailable") {
          const reattached = await this.localBackend.prepareDial({ profileId });
          if (reattached.ok) {
            const retriedTicket = reattached.dial.consumeTicket();
            if (retriedTicket) {
              return this.finishGatewayHandshake({
                connectionId: "local",
                kind: "local",
                label: this.getLocalLabel(),
                originDisplay: "127.0.0.1",
                transportKey,
                dial: reattached.dial,
                ticket: retriedTicket,
                startedAt,
                activateScope: options?.activateScope ?? options?.activate,
              });
            }
          }
          const errCode = mapLocalFailureToErrorCode(minted.failure);
          const msg = getLocalFailureCopy(minted.failure.code).whatHappened;
          this.scheduleLinkBackoff("local", profileId, errCode, msg);
          return {
            ok: false,
            failure: minted.failure,
            fleet: this.getFleetSnapshot(),
          };
        }
        const errCode = mapLocalFailureToErrorCode(minted.failure);
        const msg = getLocalFailureCopy(minted.failure.code).whatHappened;
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.errorCode = errCode;
        link.unavailableCode = minted.failure.code;
        link.message = msg;
        this.localHealth = {
          ...this.localHealth,
          label: this.getLocalLabel(),
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          errorCode: errCode,
          message: msg,
        };
        this.syncProfileAndConnectionProjections("local");
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
      link.actual = "blocked";
      link.degraded = true;
      link.errorCode = "auth_failed";
      this.localHealth = {
        ...this.localHealth,
        label: this.getLocalLabel(),
        actual: "blocked",
        degraded: true,
        errorCode: "auth_failed",
      };
      this.syncProfileAndConnectionProjections("local");
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
    if (this.disposed || this.shuttingDown || !this.sshTransport) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const info = this.getSshTargetForConnection(connectionId);
    if (!info) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const link = this.ensureLinkState(connectionId, profileId, "enabled");
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
    }

    if (options?.forceReconnect) {
      for (const [k, entry] of [...this.transports.entries()]) {
        if (entry.connectionId === connectionId) {
          this.disposeTransportEntry(k, entry);
        }
      }
      await this.sshTransport.disposeConnection(connectionId);
    }

    link.actual = "connecting";
    link.degraded = false;
    link.errorCode = undefined;
    link.unavailableCode = undefined;
    link.message = undefined;
    link.nextRetryAt = null;
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
    this.syncProfileAndConnectionProjections(connectionId);
    this.emitFleet(connectionId);

    const startedAt = this.now();
    const dialResult = await this.sshTransport.prepareDial(info.target, profileId);
    if (!dialResult.ok) {
      const errCode = mapSshFailureToErrorCode(dialResult.failureCode);
      const isRetryable = dialResult.status !== "blocked";
      this.setHealth(connectionId, {
        connectionId,
        label: info.label,
        kind: "ssh",
        originDisplay: info.sshTargetDisplay,
        actual: isRetryable ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: errCode,
        message: dialResult.message,
      });
      if (isRetryable) {
        this.scheduleLinkBackoff(connectionId, profileId, errCode, dialResult.message);
      } else {
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = errCode;
        link.message = dialResult.message;
        this.syncProfileAndConnectionProjections(connectionId);
        this.emitFleet(connectionId);
      }
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
        const errCode = mapSshFailureToErrorCode(minted.failureCode);
        if (minted.failureCode === "ticket_unavailable") {
          const redial = await this.sshTransport.prepareDial(info.target, profileId);
          if (redial.ok) {
            const retriedTicket = redial.dial.consumeTicket();
            if (retriedTicket) {
              return this.finishGatewayHandshake({
                connectionId,
                kind: "ssh",
                label: info.label,
                originDisplay: info.sshTargetDisplay,
                transportKey,
                dial: redial.dial,
                ticket: retriedTicket,
                startedAt,
                activateScope: options?.activateScope,
              });
            }
          }
          this.scheduleLinkBackoff(connectionId, profileId, errCode, minted.message);
          return { ok: false, fleet: this.getFleetSnapshot() };
        }
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.errorCode = errCode;
        link.message = minted.message;
        this.setHealth(connectionId, {
          connectionId,
          label: info.label,
          kind: "ssh",
          originDisplay: info.sshTargetDisplay,
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: errCode,
          message: minted.message,
        });
        this.syncProfileAndConnectionProjections(connectionId);
        this.emitFleet(connectionId);
        return { ok: false, fleet: this.getFleetSnapshot() };
      }
      dial.wsUrl = minted.wsUrl;
      ticket = minted.consumeTicket();
    }

    if (!ticket) {
      link.actual = "blocked";
      link.degraded = true;
      link.errorCode = "auth_failed";
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
      this.syncProfileAndConnectionProjections(connectionId);
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
    const link = this.ensureLinkState(connectionId, dial.profileId, "enabled");
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
      const isRetryable = errCode === "timeout" || errCode === "unreachable";
      this.setHealth(connectionId, {
        connectionId,
        label: connectionId === "local" ? this.getLocalLabel() : label,
        kind,
        originDisplay,
        actual: isRetryable ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        nextRetryAt: null,
        errorCode: errCode,
      });
      if (isRetryable) {
        this.scheduleLinkBackoff(connectionId, dial.profileId, errCode);
      } else {
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = errCode;
        this.syncProfileAndConnectionProjections(connectionId);
        this.emitFleet(connectionId);
      }
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
        link.actual = "blocked";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = "protocol_unsupported";
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
        this.syncProfileAndConnectionProjections(connectionId);
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
      lastInboundAt: this.now(),
      lastPingSentAt: null,
      heartbeatTimer: null,
      unsubNotification: () => {},
      unsubClose: () => {},
      unsubInbound: () => {},
    };

    entry.unsubInbound = client.onInboundFrame((opcode) => {
      entry.lastInboundAt = this.now();
      if (opcode === 0xA && entry.lastPingSentAt !== null) {
        const rtt = Math.max(1, this.now() - entry.lastPingSentAt);
        entry.lastPingSentAt = null;
        this.updateReadyLinksLatency(connectionId, rtt);
      }
    });

    entry.unsubNotification = client.onNotification((method, notifParams) => {
      this.handleGatewayNotification(entry, method, notifParams);
    });

    entry.unsubClose = client.onClose((reason) => {
      if (this.disposed || entry.disposed || reason === "client_closed") return;
      this.disposeTransportEntry(transportKey, entry);
      this.handleUnexpectedTransportClose(entry);
    });

    const previous = this.transports.get(transportKey);
    if (previous) {
      this.disposeTransportEntry(transportKey, previous);
    }
    this.transports.set(transportKey, entry);
    this.scheduleTransportHeartbeat(entry);

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

    const latencyMs = Math.max(1, this.now() - startedAt);
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
    this.markLinkReady(connectionId, dial.profileId, latencyMs);

    await this.refreshProfiles(entry, dial.profileId);
    const sessions = await this.refreshSessionsForProfile(entry, dial.profileId);

    // Resync existing transcripts for dialed profile on reconnect
    for (const tx of this.transcripts.values()) {
      if (tx.connectionId === connectionId && tx.profileId === dial.profileId && tx.sessionId) {
        await this.loadTranscriptSnapshot(entry, dial.profileId, tx.sessionId, {
          replace: true,
          resynced: true,
        });
      }
    }

    // If shared-host-scope transport, independently resume all other enabled profiles
    if (entry.transportMode === "shared-host-scope") {
      const enabledOtherProfiles = this.getLinksForConnection(connectionId).filter(
        (l) => l.desired === "enabled" && l.profileId !== dial.profileId,
      );
      for (const otherLink of enabledOtherProfiles) {
        await this.activateOrRefreshProfileOnSharedTransport(entry, otherLink.profileId, {
          resyncTranscripts: true,
        });
      }
    }

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
        await this.activateOrRefreshProfileOnSharedTransport(entry, savedActive.profileId, {
          resyncTranscripts: true,
        });
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

    this.syncProfileAndConnectionProjections(connectionId);
    this.emitFleet(connectionId);
    return {
      ok: true,
      fleet: this.getFleetSnapshot(),
    };
  }

  private async activateOrRefreshProfileOnSharedTransport(
    entry: GatewayTransportEntry,
    profileId: string,
    options?: { resyncTranscripts?: boolean },
  ): Promise<boolean> {
    const connectionId = entry.connectionId;
    const link = this.ensureLinkState(connectionId, profileId, "enabled");
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
    }

    await this.refreshSessionsForProfile(entry, profileId);
    const updatedLink = this.ensureLinkState(connectionId, profileId, "enabled");
    if (updatedLink.actual === "blocked" && updatedLink.unavailableCode === "profile_unavailable") {
      return false;
    }

    const baseLatency = this.getConnectionHealth(connectionId)?.latencyMs ?? 1;
    this.markLinkReady(connectionId, profileId, baseLatency);

    if (options?.resyncTranscripts) {
      for (const tx of this.transcripts.values()) {
        if (tx.connectionId === connectionId && tx.profileId === profileId && tx.sessionId) {
          await this.loadTranscriptSnapshot(entry, profileId, tx.sessionId, {
            replace: true,
            resynced: true,
          });
        }
      }
    }

    this.emitProfiles(connectionId);
    this.emitFleet(connectionId);
    return true;
  }

  private async reconnectSshAfterDrop(
    connectionId: string,
    profileId: string,
    instanceId: string,
  ): Promise<void> {
    if (this.disposed || this.shuttingDown || this.suspended || !this.sshTransport) return;
    const info = this.getSshTargetForConnection(connectionId);
    if (!info) return;

    const inflightKey = `ssh-drop:${connectionId}::${profileId}`;
    if (this.connectingByKey.has(inflightKey)) return;

    const runner = (async (): Promise<SupervisorConnectResult> => {
      const startedAt = this.now();
      const minted = await this.sshTransport!.mintReconnectTicket(
        connectionId,
        info.target,
        profileId,
        instanceId,
      );
      if (!minted.ok) {
        const errCode = mapSshFailureToErrorCode(minted.failureCode);
        if (minted.failureCode === "ticket_unavailable") {
          const redial = await this.connectSshInternal(connectionId, profileId, {
            forceReconnect: true,
          });
          return redial;
        }
        this.scheduleLinkBackoff(connectionId, profileId, errCode, minted.message);
        return { ok: false, fleet: this.getFleetSnapshot() };
      }

      const ticket = minted.consumeTicket();
      if (!ticket) {
        this.scheduleLinkBackoff(connectionId, profileId, "auth_failed");
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
    if (entry.heartbeatTimer !== null) {
      this.clearTimer(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
    entry.unsubInbound();
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
        const link = this.ensureLinkState(connectionId, activeProfileId, "enabled");
        this.profilesByConnection.set(connectionId, [
          ...currentProfiles,
          {
            connectionId,
            profileId: activeProfileId,
            displayName: activeProfileId === "default" ? "Default" : activeProfileId,
            handle: activeProfileId,
            isDefault: activeProfileId === "default",
            desired: link.desired,
            actual: link.actual,
            degraded: link.degraded,
            pinned: this.computeProfilePinned(connectionId, activeProfileId),
          },
        ]);
      }
    } else {
      const seenIds = new Set<string>();
      const nextList: ProfileSummary[] = [];
      const existingById = new Map(currentProfiles.map((p) => [p.profileId, p]));

      for (const raw of rawProfiles) {
        const pid = asString(raw.profile_id ?? raw.profileId ?? raw.id).trim();
        if (!pid) continue;
        seenIds.add(pid);
        const displayName = asString(raw.display_name ?? raw.displayName, pid) || pid;
        const handle = asString(raw.handle, pid) || pid;
        const isDefault = Boolean(raw.is_default ?? raw.isDefault ?? pid === "default");
        const initialDesired: ConnectionDesiredState =
          isDefault || pid === activeProfileId ? "enabled" : "disabled";
        const link = this.ensureLinkState(connectionId, pid, initialDesired);
        if (pid === activeProfileId && link.actual === "idle" && !this.suspended) {
          link.desired = "enabled";
          link.actual = "ready";
        }
        const prev = existingById.get(pid);
        nextList.push({
          ...prev,
          connectionId,
          profileId: pid,
          displayName,
          handle,
          isDefault,
          desired: link.desired,
          actual: link.actual,
          degraded: link.degraded,
          pinned: this.computeProfilePinned(connectionId, pid),
          ...(link.unavailableCode ? { unavailableCode: link.unavailableCode } : {}),
          ...(link.errorCode ? { errorCode: link.errorCode } : {}),
          ...(link.message ? { message: link.message } : {}),
        });
      }

      // Any profile that disappeared from profiles.list: tear down only its link!
      let profileOrphansCreated = 0;
      for (const link of this.getLinksForConnection(connectionId)) {
        if (!seenIds.has(link.profileId)) {
          this.clearLinkTimers(link);
          link.desired = "disabled";
          link.wasDesiredBeforeSuspend = false;
          link.actual = "idle";
          link.degraded = false;
          link.latencyMs = null;
          link.nextRetryAt = null;
          link.errorCode = undefined;
          link.unavailableCode = undefined;
          link.message = undefined;
          this.sessionsByScope.delete(scopeKey(connectionId, link.profileId));
          const perProfileKey = `${connectionId}::profile:${link.profileId}`;
          const perProfileEntry = this.transports.get(perProfileKey);
          if (perProfileEntry) {
            this.disposeTransportEntry(perProfileKey, perProfileEntry);
          }
          const created =
            this.chatSessionStateStore?.orphanDraftsForRemovedProfile(connectionId, link.profileId) ?? [];
          profileOrphansCreated += created.length;
        }
      }

      this.profilesByConnection.set(connectionId, nextList);
      if (profileOrphansCreated > 0) {
        this.emitChatState();
      }
    }

    this.syncProfileAndConnectionProjections(connectionId);
    this.emitProfiles(connectionId);
    this.emitFleet(connectionId);
    return [...(this.profilesByConnection.get(connectionId) ?? [])];
  }

  private markProfileUnavailable(
    connectionId: string,
    profileId: string,
    err: unknown,
  ): void {
    const link = this.ensureLinkState(connectionId, profileId, "enabled");
    this.clearLinkTimers(link);
    link.actual = "blocked";
    link.degraded = true;
    link.latencyMs = null;
    link.nextRetryAt = null;
    link.unavailableCode = "profile_unavailable";
    link.errorCode = "not_found";
    link.message =
      err instanceof Error && err.message
        ? getLocalFailureCopy("profile_unavailable").whatHappened
        : getLocalFailureCopy("profile_unavailable").whatHappened;
    this.syncProfileAndConnectionProjections(connectionId);
    this.emitProfiles(connectionId);
    this.emitFleet(connectionId);
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
        if (isProfileUnavailableRpcError(err)) {
          this.markProfileUnavailable(connectionId, profileId, err);
          return [];
        }
        if (isRpcAuthError(err) && connectionId !== "local") {
          this.markConnectionAuthRequired(connectionId);
        } else {
          try {
            rawList = await callList("sessions.list");
          } catch (err2) {
            if (isProfileUnavailableRpcError(err2)) {
              this.markProfileUnavailable(connectionId, profileId, err2);
              return [];
            }
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

    const key = scopeKey(connectionId, profileId);
    const prevList = this.sessionsByScope.get(key) ?? [];
    if (prevList.length > 0 && this.chatSessionStateStore) {
      const nextIds = new Set(mapped.map((s) => s.sessionId));
      const activeId =
        this.activeScope?.connectionId === connectionId &&
        (this.activeScope?.profileId ?? "default") === profileId
          ? (this.activeSessionId ?? this.activeScope?.sessionId ?? null)
          : null;
      const nonActiveRemoved = prevList.filter(
        (s) => !nextIds.has(s.sessionId) && s.sessionId !== activeId,
      );
      if (nonActiveRemoved.length > 0) {
        const created = this.chatSessionStateStore.orphanDraftsForRemovedSessions(
          { connectionId, profileId },
          nonActiveRemoved,
        );
        if (created.length > 0) {
          this.emitChatState();
        }
      }
    }

    this.sessionsByScope.set(key, mapped);
    this.syncProfileAndConnectionProjections(connectionId);
    this.emitSessions(connectionId, profileId);
    return mapped;
  }

  private markConnectionAuthRequired(connectionId: string): void {
    for (const link of this.getLinksForConnection(connectionId)) {
      if (link.desired === "enabled") {
        this.clearLinkTimers(link);
        link.actual = "auth_required";
        link.degraded = true;
        link.latencyMs = null;
        link.nextRetryAt = null;
        link.errorCode = "auth_required";
        link.message = getCopy("remote.authRequiredBody");
      }
    }
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
    this.syncProfileAndConnectionProjections(connectionId);
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
    options?: { force?: boolean; action?: "reload" },
  ): Promise<void> {
    if (this.disposed || entry.disposed) return;
    const meta = CAPABILITY_DOMAIN_CATALOG.find((m) => m.domain === domain);
    if (!meta || !meta.probeMethod || meta.classification === "deferred" || meta.classification === "deep_link") {
      return;
    }

    const currentSnap = this.capabilityRegistry.getSnapshot();
    const existingDom = currentSnap.domains.find((d) => d.domain === domain);
    if (existingDom?.probed && !options?.force && !options?.action) {
      return;
    }

    if (domain === "plugins" || domain === "skills" || domain === "tools" || domain === "mcp") {
      await this.probeExtensionDomain(entry, profileId, domain, options);
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

  private async probeExtensionDomain(
    entry: GatewayTransportEntry,
    profileId: string,
    domain: "plugins" | "skills" | "tools" | "mcp",
    options?: { force?: boolean; action?: "reload" },
  ): Promise<void> {
    const currentSnap = this.capabilityRegistry.getSnapshot();
    const startGeneration = currentSnap.generation;
    const baseKey = {
      expectedOwnerGeneration: entry.ownerGeneration,
      expectedAuthorityEpoch: entry.authorityEpoch,
      expectedGeneration: startGeneration,
    };

    if (domain === "plugins") {
      if (this.capabilityRegistry.isMethodRefused("plugins.list")) {
        this.capabilityRegistry.applyPluginsInventory({ ...baseKey, outcome: "refused" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "plugins",
          method: "plugins.list",
          outcome: "refused",
        });
        return;
      }
      if (this.capabilityRegistry.getMethodTier("plugins.list") === "older") {
        this.capabilityRegistry.applyPluginsInventory({ ...baseKey, outcome: "older" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "plugins",
          method: "plugins.list",
          outcome: "ok",
        });
        return;
      }

      try {
        const res = await entry.client.call<unknown>(
          "plugins.list",
          { profile_id: profileId },
          { timeoutMs: this.probeTimeoutMs },
        );
        const rawPlugins = Array.isArray(res)
          ? res
          : res && typeof res === "object" && Array.isArray((res as Record<string, unknown>).plugins)
            ? (res as Record<string, unknown>).plugins
            : null;
        if (rawPlugins === null) {
          this.capabilityRegistry.applyPluginsInventory({
            ...baseKey,
            outcome: "error",
            errorCode: "INVALID_PAYLOAD",
          });
          return;
        }
        this.capabilityRegistry.applyPluginsInventory({
          ...baseKey,
          outcome: "ok",
          rawPlugins,
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "plugins",
          method: "plugins.list",
          outcome: "ok",
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.applyPluginsInventory({
            ...baseKey,
            outcome: "method_not_found",
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "plugins",
            method: "plugins.list",
            outcome: "method_not_found",
          });
        } else {
          const code =
            err instanceof GatewayTransportError && err.code === "timeout"
              ? "RPC_TIMEOUT"
              : "PLUGINS_FETCH_FAILED";
          this.capabilityRegistry.applyPluginsInventory({
            ...baseKey,
            outcome: "error",
            errorCode: code,
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "plugins",
            method: "plugins.list",
            outcome: "timeout",
          });
        }
      }
      return;
    }

    if (domain === "skills") {
      if (this.capabilityRegistry.isMethodRefused("skills.list")) {
        this.capabilityRegistry.applySkillsInventory({ ...baseKey, outcome: "refused" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "skills",
          method: "skills.list",
          outcome: "refused",
        });
        return;
      }

      let reloaded = false;
      if (options?.action === "reload") {
        const reloadRes = resolveMethodWithAlias("reload.skills", currentSnap.methodTiers);
        if (reloadRes.tier === "served") {
          try {
            await entry.client.call(
              reloadRes.method,
              { profile_id: profileId },
              { timeoutMs: this.probeTimeoutMs },
            );
            reloaded = true;
          } catch (err) {
            if (isJsonRpcMethodNotFound(err)) {
              this.capabilityRegistry.markMethodNotFound({
                method: reloadRes.method,
                expectedOwnerGeneration: entry.ownerGeneration,
                expectedAuthorityEpoch: entry.authorityEpoch,
              });
            }
          }
        }
      }

      try {
        const res = await entry.client.call<unknown>(
          "skills.list",
          { profile_id: profileId },
          { timeoutMs: this.probeTimeoutMs },
        );
        const rawSkills = Array.isArray(res)
          ? res
          : res && typeof res === "object" && Array.isArray((res as Record<string, unknown>).skills)
            ? (res as Record<string, unknown>).skills
            : [];
        this.capabilityRegistry.applySkillsInventory({
          ...baseKey,
          outcome: "ok",
          rawSkills,
          reloaded,
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "skills",
          method: "skills.list",
          outcome: "ok",
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.applySkillsInventory({
            ...baseKey,
            outcome: "method_not_found",
            reloaded,
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "skills",
            method: "skills.list",
            outcome: "method_not_found",
          });
        } else {
          this.capabilityRegistry.applySkillsInventory({
            ...baseKey,
            outcome: "error",
            errorCode: "SKILLS_FETCH_FAILED",
            reloaded,
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "skills",
            method: "skills.list",
            outcome: "timeout",
          });
        }
      }
      return;
    }

    if (domain === "tools") {
      if (this.capabilityRegistry.isMethodRefused("tools.show")) {
        this.capabilityRegistry.applyToolsInventory({ ...baseKey, outcome: "refused" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "tools",
          method: "tools.show",
          outcome: "refused",
        });
        return;
      }

      try {
        const res = await entry.client.call<unknown>(
          "tools.show",
          { profile_id: profileId },
          { timeoutMs: this.probeTimeoutMs },
        );
        const rawTools = Array.isArray(res)
          ? res
          : res && typeof res === "object" && Array.isArray((res as Record<string, unknown>).tools)
            ? (res as Record<string, unknown>).tools
            : [];
        this.capabilityRegistry.applyToolsInventory({
          ...baseKey,
          outcome: "ok",
          rawTools,
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "tools",
          method: "tools.show",
          outcome: "ok",
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.applyToolsInventory({
            ...baseKey,
            outcome: "method_not_found",
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "tools",
            method: "tools.show",
            outcome: "method_not_found",
          });
        } else {
          this.capabilityRegistry.applyToolsInventory({
            ...baseKey,
            outcome: "error",
            errorCode: "TOOLS_FETCH_FAILED",
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "tools",
            method: "tools.show",
            outcome: "timeout",
          });
        }
      }
      return;
    }

    if (domain === "mcp") {
      if (this.capabilityRegistry.isMethodRefused("mcp.list")) {
        this.capabilityRegistry.applyMcpInventory({ ...baseKey, outcome: "refused" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "mcp",
          method: "mcp.list",
          outcome: "refused",
        });
        return;
      }

      let reloaded = false;
      if (options?.action === "reload") {
        const reloadRes = resolveMethodWithAlias("reload.mcp", currentSnap.methodTiers);
        if (reloadRes.tier === "served") {
          try {
            await entry.client.call(
              reloadRes.method,
              { profile_id: profileId },
              { timeoutMs: this.probeTimeoutMs },
            );
            reloaded = true;
          } catch (err) {
            if (isJsonRpcMethodNotFound(err)) {
              this.capabilityRegistry.markMethodNotFound({
                method: reloadRes.method,
                expectedOwnerGeneration: entry.ownerGeneration,
                expectedAuthorityEpoch: entry.authorityEpoch,
              });
            }
          }
        }
      }

      try {
        const res = await entry.client.call<unknown>(
          "mcp.list",
          { profile_id: profileId },
          { timeoutMs: this.probeTimeoutMs },
        );
        const rawServers = Array.isArray(res)
          ? res
          : res && typeof res === "object" && Array.isArray((res as Record<string, unknown>).servers)
            ? (res as Record<string, unknown>).servers
            : [];
        this.capabilityRegistry.applyMcpInventory({
          ...baseKey,
          outcome: "ok",
          rawServers,
          reloaded,
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "mcp",
          method: "mcp.list",
          outcome: "ok",
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.applyMcpInventory({
            ...baseKey,
            outcome: "method_not_found",
            reloaded,
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "mcp",
            method: "mcp.list",
            outcome: "method_not_found",
          });
        } else {
          this.capabilityRegistry.applyMcpInventory({
            ...baseKey,
            outcome: "error",
            errorCode: "MCP_FETCH_FAILED",
            reloaded,
          });
          this.capabilityRegistry.applyProbeOutcome({
            ...baseKey,
            domain: "mcp",
            method: "mcp.list",
            outcome: "timeout",
          });
        }
      }
    }
  }

  private handleGatewayNotification(
    entry: GatewayTransportEntry,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (this.disposed || this.shuttingDown || entry.disposed) return;
    const currentEntry = this.transports.get(entry.key);
    if (currentEntry && currentEntry.ownerGeneration !== entry.ownerGeneration) {
      return;
    }

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

    if (method === "approval.requested" || method === "approval.pending") {
      this.notifyBackgroundEventForTest({
        kind: "approval_pending",
        scope: {
          connectionId,
          profileId: resolvedProfileId,
          ...(sessionId ? { sessionId } : {}),
        },
        rawPayload: params,
      });
      return;
    }

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
      const toolName = asString(rawTool.name ?? rawTool.tool, "tool");
      const knownTool = this.capabilityRegistry
        .getSnapshot()
        .extensions.tools.items.find((item) => item.name === toolName);
      const hasExplicitAttributionField =
        rawTool.origin !== undefined ||
        rawTool.source !== undefined ||
        rawTool.mcp_server !== undefined ||
        rawTool.mcpServer !== undefined ||
        rawTool.server !== undefined ||
        rawTool.plugin !== undefined ||
        rawTool.pluginName !== undefined ||
        rawTool.skill !== undefined ||
        rawTool.skillName !== undefined ||
        rawTool.external_provider !== undefined;
      const toolRow: ToolExecutionRow = {
        toolCallId: asString(
          rawTool.tool_call_id ?? rawTool.toolCallId ?? rawTool.id,
          `tc-${Date.now()}`,
        ),
        name: toolName,
        status:
          rawTool.status === "completed" ||
          rawTool.status === "failed" ||
          rawTool.status === "cancelled"
            ? rawTool.status
            : "running",
        summary: typeof rawTool.summary === "string" ? rawTool.summary : undefined,
        durationMs: typeof rawTool.duration_ms === "number" ? rawTool.duration_ms : undefined,
        attribution: hasExplicitAttributionField
          ? resolveExternalAttribution({
              origin: typeof rawTool.origin === "string" ? rawTool.origin : undefined,
              source: typeof rawTool.source === "string" ? rawTool.source : undefined,
              mcpServer:
                typeof (rawTool.mcp_server ?? rawTool.mcpServer ?? rawTool.server) === "string"
                  ? String(rawTool.mcp_server ?? rawTool.mcpServer ?? rawTool.server)
                  : undefined,
              pluginName:
                typeof (rawTool.plugin ?? rawTool.pluginName) === "string"
                  ? String(rawTool.plugin ?? rawTool.pluginName)
                  : undefined,
              skillName:
                typeof (rawTool.skill ?? rawTool.skillName) === "string"
                  ? String(rawTool.skill ?? rawTool.skillName)
                  : undefined,
              toolset:
                typeof (rawTool.external_provider ?? rawTool.toolset) === "string"
                  ? String(rawTool.external_provider ?? rawTool.toolset)
                  : undefined,
            })
          : knownTool?.attribution ?? resolveExternalAttribution({}),
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
      if (method === "prompt.completed" || method === "prompt.done") {
        this.notifyBackgroundEventForTest({
          kind: "turn_completed",
          scope: {
            connectionId,
            profileId: resolvedProfileId,
            sessionId,
          },
          rawPayload: params,
        });
      }
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

  private assertNotShuttingDown(): void {
    if (this.disposed || this.shuttingDown) {
      throw makeBridgeError("cancelled", "应用正在退出");
    }
  }

  private translateRpcFailure(
    entry: GatewayTransportEntry,
    err: unknown,
    singleAction?: keyof SupportedChatActions,
    rpcMethod?: string,
    profileId?: string,
  ): never {
    if (isProfileUnavailableRpcError(err)) {
      const targetPid = profileId ?? entry.defaultProfileId;
      this.markProfileUnavailable(entry.connectionId, targetPid, err);
      throw makeBridgeError(
        "not_found",
        getLocalFailureCopy("profile_unavailable").whatHappened,
      );
    }
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
    | "chatState.clearDraft"
    | "chatState.markAttachmentExpired"
    | "chatState.deleteOrphanedDraft"
    | "chatState.exportOrphanedDraft"
    | "artifacts.list"
    | "artifacts.read"
    | "files.list"
    | "files.read"
    | "subagents.list"
    | "subagents.tail"
    | "subagents.steer"
    | "subagents.interrupt"
    | "checkpoints.list"
    | "checkpoints.diff"
    | "checkpoints.restore"
    | "chatState.exportMissingSession"
    | "chatState.dismissMissingSession"
    | "config.get"
    | "config.update",
    HostCommandHandler
  > = {
    "capabilities.describe": async (payload, scope) => {
      this.assertNotShuttingDown();
      if (this.inflightCoreProbes) {
        await this.inflightCoreProbes;
      }
      const domain =
        typeof payload.domain === "string" ? (payload.domain as CapabilityDomainId) : undefined;
      const action = payload.action === "reload" ? "reload" : undefined;
      if (domain) {
        const connectionId = this.resolveTargetConnectionId(payload, scope);
        const profileId = this.resolveTargetProfile(payload, scope, connectionId);
        const entry = this.getTransport(connectionId, profileId);
        if (entry) {
          await this.probeDomain(entry, profileId, domain, {
            force: payload.refresh === true,
            action,
          });
          this.emitCapabilities();
        }
      }
      return this.capabilityRegistry.getSnapshot();
    },

    "fleet.refresh": async () => {
      this.assertNotShuttingDown();
      return { fleet: this.getFleetSnapshot() };
    },

    "connections.retry": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const hasExplicitProfile =
        (typeof payload.profileId === "string" && payload.profileId.trim()) ||
        (scope?.profileId && scope.profileId.trim());
      const defaultProfile =
        connectionId === "local"
          ? "default"
          : this.getSshTargetForConnection(connectionId)?.defaultProfile ?? "default";
      const profileId = hasExplicitProfile
        ? this.resolveTargetProfile(payload, scope, connectionId)
        : defaultProfile;
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
      this.assertNotShuttingDown();
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
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const connectRes = await this.ensureTransport(connectionId, profileId, { activate: false });
      const entry = this.getTransport(connectionId, profileId);
      const link = this.ensureLinkState(connectionId, profileId, "enabled");
      let transcript: SessionTranscriptSnapshot | null = null;
      if (entry && link.actual !== "blocked") {
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
      this.syncProfileAndConnectionProjections(connectionId);
      this.emitFleet(connectionId);
      return {
        ok: connectRes.ok && link.actual !== "blocked",
        fleet: this.getFleetSnapshot(),
        transcript,
      };
    },

    "sessions.list": async (payload, scope) => {
      this.assertNotShuttingDown();
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
      this.assertNotShuttingDown();
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
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      await this.ensureTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.sessionCreate) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持新建 Session");
      }

      const title =
        typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "新对话";
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;

      let res: Record<string, unknown>;
      try {
        res = await entry.client.call<Record<string, unknown>>("session.create", {
          profile_id: profileId,
          title,
        });
      } catch (err) {
        this.translateRpcFailure(entry, err, "sessionCreate", "session.create", profileId);
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
        if (draftId) {
          this.chatSessionStateStore.migrateNewChatDraftToSession({
            connectionId,
            profileId,
            draftId,
            sessionId: created.sessionId,
            title: created.title,
          });
        }
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
      this.assertNotShuttingDown();
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
      this.assertNotShuttingDown();
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

      const draftRef = {
        connectionId,
        profileId,
        sessionId,
        ...(typeof payload.draftId === "string" && payload.draftId.trim()
          ? { draftId: payload.draftId.trim() }
          : {}),
      };
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.markDraftDeliveryStatus(draftRef, "submitting");
        this.emitChatState();
      }

      let res: Record<string, unknown>;
      try {
        res = await entry.client.call<Record<string, unknown>>("prompt.submit", {
          profile_id: profileId,
          session_id: sessionId,
          text,
        });
      } catch (err) {
        if (this.chatSessionStateStore && !isJsonRpcMethodNotFound(err)) {
          const msg = err instanceof Error ? err.message.toLowerCase() : "";
          const isAmbiguous =
            msg.includes("timeout") ||
            msg.includes("closed") ||
            msg.includes("disconnect") ||
            msg.includes("unreachable") ||
            msg.includes("econnreset");
          this.chatSessionStateStore.markDraftDeliveryStatus(
            draftRef,
            isAmbiguous ? "delivery_unknown" : "idle",
          );
          this.emitChatState();
        }
        this.translateRpcFailure(entry, err, "promptSubmit", "prompt.submit", profileId);
      }

      const rawReceipt = asString(res.receipt ?? res.status).toLowerCase();
      if (rawReceipt === "delivery_unknown" || res.delivery_unknown === true) {
        if (this.chatSessionStateStore) {
          this.chatSessionStateStore.markDraftDeliveryStatus(draftRef, "delivery_unknown");
          this.emitChatState();
        }
        return {
          accepted: false,
          deliveryUnknown: true,
          receipt: "delivery_unknown",
          sessionId,
        };
      }

      const receipt =
        rawReceipt === "admitted" || res.admitted === true ? "admitted" : "accepted";
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.clearDraftOnReceipt(draftRef, receipt);
        this.emitChatState();
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
      this.syncProfileAndConnectionProjections(connectionId);

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
        receipt,
        sessionId,
        turnId,
        userMessageId: userMsgId,
        assistantMessageId: assistantMsgId,
      };
    },

    "prompts.stop": async (payload, scope) => {
      this.assertNotShuttingDown();
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
        this.translateRpcFailure(entry, err, "promptCancel", "prompt.cancel", profileId);
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
      this.syncProfileAndConnectionProjections(connectionId);
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
      this.assertNotShuttingDown();
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
        this.translateRpcFailure(entry, err, "promptSteer", "session.steer", profileId);
      }
    },

    "chatState.get": async () => {
      this.assertNotShuttingDown();
      return this.getChatStateProjection();
    },

    "chatState.dismissRouteBanner": async () => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const projection = this.chatSessionStateStore.dismissRouteBanner();
      this.emitChatState();
      return projection;
    },

    "chatState.saveDraft": async (payload, scope) => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const connectionId =
        typeof payload.connectionId === "string" && payload.connectionId.trim()
          ? payload.connectionId.trim()
          : scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId?.trim() || undefined;
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      if (!sessionId && !draftId) return this.getChatStateProjection();
      const res = this.chatSessionStateStore.saveDraftRecord({
        connectionId,
        profileId,
        ...(sessionId ? { sessionId } : {}),
        ...(draftId ? { draftId } : {}),
        ...(typeof payload.text === "string" ? { text: payload.text } : {}),
        ...(Array.isArray(payload.attachments)
          ? { attachments: payload.attachments as DraftAttachment[] }
          : {}),
        ...(Array.isArray(payload.contexts)
          ? { contexts: payload.contexts as DraftContextItem[] }
          : {}),
        ...(payload.composer && typeof payload.composer === "object"
          ? { composer: payload.composer as DraftComposerState }
          : {}),
        ...(Array.isArray(payload.annotations)
          ? { annotations: payload.annotations as ArtifactAnnotation[] }
          : {}),
        ...(typeof payload.originTitle === "string"
          ? { originTitle: payload.originTitle }
          : {}),
        ...(typeof payload.deliveryStatus === "string"
          ? { deliveryStatus: payload.deliveryStatus as DraftDeliveryStatus }
          : {}),
      });
      if (!res.ok) {
        throw makeBridgeError(
          res.reason === "over_single_limit" ? "invalid_request" : "conflict",
          res.reason === "over_single_limit"
            ? getCopy("draft.capacityExceededSingle")
            : getCopy("draft.capacityExceededTotal"),
        );
      }
      this.emitChatState();
      return res.projection;
    },

    "chatState.clearDraft": async (payload, scope) => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const connectionId =
        typeof payload.connectionId === "string" && payload.connectionId.trim()
          ? payload.connectionId.trim()
          : scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId?.trim() || undefined;
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      const projection = this.chatSessionStateStore.clearDraftExplicit({
        connectionId,
        profileId,
        ...(sessionId ? { sessionId } : {}),
        ...(draftId ? { draftId } : {}),
      });
      this.emitChatState();
      return projection;
    },

    "chatState.markAttachmentExpired": async (payload, scope) => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const connectionId =
        typeof payload.connectionId === "string" && payload.connectionId.trim()
          ? payload.connectionId.trim()
          : scope?.connectionId ?? this.activeScope?.connectionId ?? "local";
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : scope?.sessionId?.trim() || undefined;
      const draftId =
        typeof payload.draftId === "string" && payload.draftId.trim()
          ? payload.draftId.trim()
          : undefined;
      const attachmentRef =
        typeof payload.attachmentId === "string" && payload.attachmentId.trim()
          ? payload.attachmentId.trim()
          : typeof payload.handle === "string"
            ? payload.handle.trim()
            : "";
      if (!attachmentRef) return this.getChatStateProjection();
      const projection = this.chatSessionStateStore.markAttachmentExpired(
        {
          connectionId,
          profileId,
          ...(sessionId ? { sessionId } : {}),
          ...(draftId ? { draftId } : {}),
        },
        attachmentRef,
      );
      this.emitChatState();
      return projection;
    },

    "chatState.deleteOrphanedDraft": async (payload) => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return this.getChatStateProjection();
      const orphanedId = typeof payload.orphanedId === "string" ? payload.orphanedId.trim() : "";
      if (!orphanedId) return this.getChatStateProjection();
      const projection = this.chatSessionStateStore.deleteOrphanedDraft(orphanedId);
      this.emitChatState();
      return projection;
    },

    "chatState.exportOrphanedDraft": async (payload) => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return null;
      const orphanedId = typeof payload.orphanedId === "string" ? payload.orphanedId.trim() : "";
      if (!orphanedId) return null;
      return this.chatSessionStateStore.exportOrphanedDraft(orphanedId);
    },

    "artifacts.list": async () => ({ artifacts: [], stale: false, agents: [] }),
    "artifacts.read": async () => ({ artifact: null }),
    "files.list": async () => ({ files: [], stale: false, gitDiffs: [] }),
    "files.read": async () => ({ file: null }),

    "subagents.list": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const generation = this.capabilityRegistry.getSnapshot().generation;
      if (!sessionId) {
        return {
          agents: [],
          readOnly: false,
          lastKnown: false,
          generation,
        };
      }

      const sessionKey = transcriptKey(connectionId, profileId, sessionId);
      const entry = this.requireTransport(connectionId, profileId);
      const snap = this.capabilityRegistry.getSnapshot();
      const resolved = resolveMethodWithAlias("subagents.list", snap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "subagent.list";

      if (
        this.capabilityRegistry.isMethodRefused("subagents.list") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod)
      ) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 已拒绝 Subagents 能力");
      }

      const steerAvailable =
        snap.entries.find((e) => e.actionId === "subagents.steer")?.runtimeStatus === "available";
      const interruptAvailable =
        snap.entries.find((e) => e.actionId === "subagents.interrupt")?.runtimeStatus ===
        "available";

      if (this.capabilityRegistry.getMethodTier("subagents.list") === "unknown") {
        const fallback = (this.lastKnownSubagentsBySession.get(sessionKey) ?? []).map((item) => ({
          ...item,
          lastKnown: true,
        }));
        return {
          agents: fallback,
          readOnly: true,
          lastKnown: true,
          generation,
        };
      }

      try {
        const res = await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: profileId,
          session_id: sessionId,
        });
        const rawList = Array.isArray(res.agents ?? res.subagents)
          ? ((res.agents ?? res.subagents) as Array<Record<string, unknown>>)
          : [];
        const agents: WorkspaceAgentItem[] = rawList.map((raw, idx) => {
          const rawStatus = asString(raw.status, "running");
          const status: WorkspaceAgentItem["status"] =
            rawStatus === "idle" ||
            rawStatus === "completed" ||
            rawStatus === "failed" ||
            rawStatus === "stopped"
              ? rawStatus
              : "running";
          return {
            agentId: asString(raw.agent_id ?? raw.agentId ?? raw.id, `subagent-${idx + 1}`),
            name: asString(raw.name ?? raw.title, `Subagent ${idx + 1}`),
            role: asString(raw.role, "Subagent"),
            status,
            ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
            ...(typeof (raw.updated_at ?? raw.updatedAt) === "string"
              ? { updatedAt: String(raw.updated_at ?? raw.updatedAt) }
              : {}),
          };
        });
        this.lastKnownSubagentsBySession.set(
          sessionKey,
          agents.map((a) => ({ ...a })),
        );
        return {
          agents,
          readOnly: !steerAvailable && !interruptAvailable,
          lastKnown: false,
          generation: this.capabilityRegistry.getSnapshot().generation,
        };
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          this.capabilityRegistry.markMethodNotFound({
            method: rpcMethod,
            expectedOwnerGeneration: entry.ownerGeneration,
            expectedAuthorityEpoch: entry.authorityEpoch,
          });
          this.capabilityRegistry.markMethodNotFound({
            method: "subagent.steer",
            expectedOwnerGeneration: entry.ownerGeneration,
            expectedAuthorityEpoch: entry.authorityEpoch,
          });
          this.capabilityRegistry.markMethodNotFound({
            method: "subagent.interrupt",
            expectedOwnerGeneration: entry.ownerGeneration,
            expectedAuthorityEpoch: entry.authorityEpoch,
          });
          this.emitCapabilities();
          const fallback = (this.lastKnownSubagentsBySession.get(sessionKey) ?? []).map((item) => ({
            ...item,
            lastKnown: true,
          }));
          return {
            agents: fallback,
            readOnly: true,
            lastKnown: true,
            generation: this.capabilityRegistry.getSnapshot().generation,
          };
        }
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "subagents.tail": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      if (!sessionId || !agentId) {
        throw makeBridgeError("invalid_request", "未选择要查看 Tail 的 Subagent");
      }

      const entry = this.requireTransport(connectionId, profileId);
      const snap = this.capabilityRegistry.getSnapshot();
      const resolved = resolveMethodWithAlias("subagents.tail", snap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "subagent.tail";

      if (
        this.capabilityRegistry.isMethodRefused("subagents.tail") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod) ||
        this.capabilityRegistry.getMethodTier("subagents.tail") === "unknown"
      ) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 未提供 Subagent Tail 能力");
      }

      try {
        const res = await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: profileId,
          session_id: sessionId,
          agent_id: agentId,
        });
        const rawLines = Array.isArray(res.lines)
          ? res.lines.map((l) => String(l))
          : typeof res.output === "string"
            ? res.output.split("\n")
            : [];
        const bounded = boundSubagentTailLines(rawLines);
        const tail: SubagentTailSnapshot = {
          agentId,
          lines: bounded.lines,
          truncated: Boolean(res.truncated || bounded.truncated),
          generation: this.capabilityRegistry.getSnapshot().generation,
          updatedAt: new Date().toISOString(),
        };
        return { tail };
      } catch (err) {
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "subagents.steer": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !agentId || !text) {
        throw makeBridgeError("invalid_request", "请输入针对该 Subagent 的补充指令");
      }

      const entry = this.requireTransport(connectionId, profileId);
      const snap = this.capabilityRegistry.getSnapshot();
      const resolved = resolveMethodWithAlias("subagents.steer", snap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "subagent.steer";

      if (
        this.capabilityRegistry.isMethodRefused("subagents.steer") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod) ||
        this.capabilityRegistry.getMethodTier("subagents.steer") === "unknown"
      ) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持 Subagent 补充指令");
      }

      try {
        await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: profileId,
          session_id: sessionId,
          agent_id: agentId,
          text,
        });
        return {
          steered: true,
          agentId,
        };
      } catch (err) {
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "subagents.interrupt": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      if (!sessionId || !agentId) {
        throw makeBridgeError("invalid_request", "未选择要停止的 Subagent");
      }

      const entry = this.requireTransport(connectionId, profileId);
      const snap = this.capabilityRegistry.getSnapshot();
      const resolved = resolveMethodWithAlias("subagents.interrupt", snap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "subagent.interrupt";

      if (
        this.capabilityRegistry.isMethodRefused("subagents.interrupt") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod) ||
        this.capabilityRegistry.getMethodTier("subagents.interrupt") === "unknown"
      ) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 不支持停止 Subagent");
      }

      try {
        const res = await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: profileId,
          session_id: sessionId,
          agent_id: agentId,
        });
        const confirmed =
          res.interrupted !== false &&
          res.stopped !== false &&
          res.ok !== false;
        if (!confirmed) {
          throw makeBridgeError("conflict", "Gateway 未确认停止该 Subagent，当前运行状态保持不变");
        }
        const rawStatus = asString(res.status, "stopped");
        const nextStatus: WorkspaceAgentItem["status"] =
          rawStatus === "completed" || rawStatus === "idle" || rawStatus === "failed"
            ? rawStatus
            : "stopped";
        const sessionKey = transcriptKey(connectionId, profileId, sessionId);
        const cached = this.lastKnownSubagentsBySession.get(sessionKey);
        if (cached) {
          this.lastKnownSubagentsBySession.set(
            sessionKey,
            cached.map((a) => (a.agentId === agentId ? { ...a, status: nextStatus } : a)),
          );
        }
        return {
          interrupted: true,
          agentId,
          status: nextStatus,
        };
      } catch (err) {
        if ((err as { code?: ErrorCode })?.code === "conflict") {
          throw err;
        }
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "checkpoints.list": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const generation = this.capabilityRegistry.getSnapshot().generation;
      if (!sessionId) {
        return {
          checkpoints: [],
          canRestore: false,
          generation,
        };
      }

      const entry = this.requireTransport(connectionId, profileId);
      const snap = this.capabilityRegistry.getSnapshot();
      const resolved = resolveMethodWithAlias("checkpoint.list", snap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "rollback.list";

      if (
        this.capabilityRegistry.isMethodRefused("checkpoint.list") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod) ||
        this.capabilityRegistry.getMethodTier("checkpoint.list") === "unknown"
      ) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 未提供 Checkpoint 列表能力");
      }

      try {
        const res = await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: profileId,
          session_id: sessionId,
        });
        const rawList = Array.isArray(res.checkpoints)
          ? (res.checkpoints as Array<Record<string, unknown>>)
          : [];
        const checkpoints: WorkspaceCheckpointItem[] = rawList.map((raw, idx) => ({
          checkpointId: asString(
            raw.checkpoint_id ?? raw.checkpointId ?? raw.id,
            `ckpt-${idx + 1}`,
          ),
          title: asString(raw.title ?? raw.label, `Checkpoint #${idx + 1}`),
          ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
          createdAt: asString(
            raw.created_at ?? raw.createdAt,
            new Date().toISOString(),
          ),
          ...(typeof (raw.turn_id ?? raw.turnId) === "string"
            ? { turnId: String(raw.turn_id ?? raw.turnId) }
            : {}),
        }));
        const currentSnap = this.capabilityRegistry.getSnapshot();
        const restoreEntry = currentSnap.entries.find((e) => e.actionId === "checkpoint.restore");
        const canRestore = Boolean(restoreEntry && restoreEntry.runtimeStatus !== "unavailable");
        return {
          checkpoints,
          canRestore,
          generation: currentSnap.generation,
        };
      } catch (err) {
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "checkpoints.diff": async (payload, scope) => {
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const checkpointId =
        typeof payload.checkpointId === "string" ? payload.checkpointId.trim() : "";
      if (!sessionId || !checkpointId) {
        throw makeBridgeError("invalid_request", "未选择要对比的 Checkpoint");
      }

      const entry = this.requireTransport(connectionId, profileId);
      const snap = this.capabilityRegistry.getSnapshot();
      const resolved = resolveMethodWithAlias("checkpoint.diff", snap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "rollback.diff";

      if (
        this.capabilityRegistry.isMethodRefused("checkpoint.diff") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod) ||
        this.capabilityRegistry.getMethodTier("checkpoint.diff") === "unknown"
      ) {
        throw makeBridgeError("capability_unavailable", "当前 Gateway 未提供 Checkpoint Diff 能力");
      }

      try {
        const res = await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: profileId,
          session_id: sessionId,
          checkpoint_id: checkpointId,
        });
        const diff: CheckpointDiffSnapshot = {
          checkpointId,
          summary: asString(res.summary, "Checkpoint 差异摘要"),
          patch: asString(res.patch ?? res.diff, ""),
          ...(typeof (res.files_changed ?? res.filesChanged) === "number"
            ? { filesChanged: Number(res.files_changed ?? res.filesChanged) }
            : {}),
        };
        return { diff };
      } catch (err) {
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "checkpoints.restore": async (payload, scope) => {
      if (payload.confirmed !== true) {
        throw makeBridgeError("invalid_request", "恢复 Checkpoint 需要显式确认");
      }

      const checkpointId =
        typeof payload.checkpointId === "string" ? payload.checkpointId.trim() : "";
      const boundConnectionId =
        typeof payload.connectionId === "string"
          ? payload.connectionId.trim()
          : (scope?.connectionId ?? "");
      const boundProfileId =
        typeof payload.profileId === "string"
          ? payload.profileId.trim()
          : (scope?.profileId ?? "default");
      const boundSessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId.trim()
          : (scope?.sessionId ?? "");
      const boundGeneration =
        typeof payload.generation === "number" ? payload.generation : -1;

      const activeConnectionId = this.activeScope?.connectionId ?? scope?.connectionId ?? "local";
      const activeProfileId = this.activeScope?.profileId ?? scope?.profileId ?? "default";
      const activeSessionId =
        this.activeSessionId ?? this.activeScope?.sessionId ?? scope?.sessionId ?? "";
      const currentSnap = this.capabilityRegistry.getSnapshot();

      const restoreEntry = currentSnap.entries.find((e) => e.actionId === "checkpoint.restore");
      const resolved = resolveMethodWithAlias("checkpoint.restore", currentSnap.methodTiers);
      const rpcMethod = resolved.tier !== "unknown" ? resolved.method : "rollback.restore";

      if (
        !restoreEntry ||
        restoreEntry.runtimeStatus === "unavailable" ||
        this.capabilityRegistry.isMethodRefused("checkpoint.restore") ||
        this.capabilityRegistry.isMethodRefused(rpcMethod) ||
        this.capabilityRegistry.getMethodTier("checkpoint.restore") === "unknown"
      ) {
        throw makeBridgeError(
          "capability_unavailable",
          "当前 Gateway 未提供 rollback.restore 能力，仅支持只读浏览与 Diff 对比",
        );
      }

      const validation = validateCheckpointRestoreBinding(
        {
          connectionId: boundConnectionId,
          profileId: boundProfileId,
          sessionId: boundSessionId,
          checkpointId,
          generation: boundGeneration,
        },
        {
          connectionId: activeConnectionId,
          profileId: activeProfileId,
          sessionId: activeSessionId,
        },
        currentSnap.generation,
      );
      if (!validation.valid) {
        throw makeBridgeError(validation.code, validation.message);
      }

      const entry = this.requireTransport(activeConnectionId, activeProfileId);
      try {
        const res = await entry.client.call<Record<string, unknown>>(rpcMethod, {
          profile_id: activeProfileId,
          session_id: activeSessionId,
          checkpoint_id: checkpointId,
        });
        if (res.restored === false || res.ok === false) {
          throw makeBridgeError("conflict", "Gateway 未能恢复到所选 Checkpoint");
        }
        return {
          restored: true,
          checkpointId,
          sessionId: activeSessionId,
        };
      } catch (err) {
        if ((err as { code?: ErrorCode })?.code === "conflict") {
          throw err;
        }
        this.translateRpcFailure(entry, err, undefined, rpcMethod);
      }
    },

    "chatState.exportMissingSession": async (_payload, scope) => {
      this.assertNotShuttingDown();
      if (!this.chatSessionStateStore) return null;
      const ref: ActiveChatRef | undefined =
        scope?.connectionId && scope?.profileId
          ? {
              connectionId: scope.connectionId,
              profileId: scope.profileId,
              ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
            }
          : undefined;
      const exported = this.chatSessionStateStore.exportMissingSession(ref);
      this.emitChatState();
      return exported;
    },

    "chatState.dismissMissingSession": async () => {
      this.assertNotShuttingDown();
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

  async startFleet(): Promise<void> {
    if (this.disposed || this.shuttingDown || this.suspended) return;

    const snap = this.registryStore?.snapshot();
    const primaryId = snap?.primary ?? "local";
    const candidates: Array<{
      connectionId: string;
      profileId: string;
      isLocal: boolean;
      isPrimary: boolean;
    }> = [
      {
        connectionId: "local",
        profileId: "default",
        isLocal: true,
        isPrimary: primaryId === "local",
      },
    ];

    if (snap) {
      for (const conn of snap.connections) {
        if (conn.id === "local" || !conn.dialable) continue;
        const pid = conn.remoteProfile?.trim() || "default";
        candidates.push({
          connectionId: conn.id,
          profileId: pid,
          isLocal: false,
          isPrimary: primaryId === conn.id,
        });
      }
    }

    const ordered = [...candidates].sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return 0;
    });
    const maxConcurrency = Math.max(1, this.maxConcurrentDials);
    let cursor = 0;

    const worker = async () => {
      while (cursor < ordered.length && !this.disposed && !this.shuttingDown && !this.suspended) {
        const index = cursor;
        cursor += 1;
        const target = ordered[index];
        if (!target) break;
        await this.ensureTransport(target.connectionId, target.profileId);
      }
    };

    const workers = Array.from({ length: Math.min(maxConcurrency, ordered.length) }, () =>
      worker(),
    );
    await Promise.allSettled(workers);
  }

  async suspend(): Promise<void> {
    if (this.disposed || this.shuttingDown) return;
    this.suspended = true;
    for (const timer of this.staggerTimers) {
      this.clearTimer(timer);
    }
    this.staggerTimers.clear();

    // Ensure local default link exists so it transitions cleanly
    this.ensureLinkState("local", "default", "enabled");

    // Step 1: mark desired="suspended", actual="stopping", clear timers
    for (const link of this.linksByKey.values()) {
      link.wasDesiredBeforeSuspend = link.desired === "enabled";
      this.clearLinkTimers(link);
      if (link.desired !== "disabled") {
        link.desired = "suspended";
        link.actual = "stopping";
      }
      link.nextRetryAt = null;
      link.latencyMs = null;
    }

    // Step 2: close active WS transports
    for (const [key, entry] of [...this.transports.entries()]) {
      this.disposeTransportEntry(key, entry);
    }

    // Step 3: transition stopping -> idle and sync projections
    const connectionIds = new Set<string>(["local"]);
    for (const link of this.linksByKey.values()) {
      connectionIds.add(link.connectionId);
      if (link.desired === "suspended") {
        link.actual = "idle";
      }
    }

    this.localHealth = {
      ...this.localHealth,
      desired: "suspended",
      actual: "idle",
      aggregateState: "suspended",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
    };
    for (const [cid, h] of this.remoteHealth.entries()) {
      this.remoteHealth.set(cid, {
        ...h,
        desired: "suspended",
        actual: "idle",
        aggregateState: "suspended",
        degraded: false,
        latencyMs: null,
        nextRetryAt: null,
      });
    }
    for (const [cid, h] of this.sshHealthById.entries()) {
      this.sshHealthById.set(cid, {
        ...h,
        desired: "suspended",
        actual: "idle",
        aggregateState: "suspended",
        degraded: false,
        latencyMs: null,
        nextRetryAt: null,
      });
    }

    for (const cid of connectionIds) {
      this.syncProfileAndConnectionProjections(cid);
      this.emitProfiles(cid);
    }
    this.emitFleet();
  }

  async resume(): Promise<void> {
    if (this.disposed || this.shuttingDown) return;
    this.suspended = false;
    for (const timer of this.staggerTimers) {
      this.clearTimer(timer);
    }
    this.staggerTimers.clear();

    const linksToRedial: ConnectionLinkState[] = [];
    for (const link of this.linksByKey.values()) {
      this.clearLinkTimers(link);
      link.attempt = 0;
      link.nextRetryAt = null;
      if (link.wasDesiredBeforeSuspend || (link.connectionId === "local" && link.profileId === "default")) {
        link.desired = "enabled";
        link.wasDesiredBeforeSuspend = true;
        linksToRedial.push(link);
      }
    }

    // Group by connectionId so shared-transport connections dial once and activate enabled profiles
    const byConnection = new Map<string, ConnectionLinkState[]>();
    for (const link of linksToRedial) {
      const list = byConnection.get(link.connectionId) ?? [];
      list.push(link);
      byConnection.set(link.connectionId, list);
    }

    for (const [connectionId, links] of byConnection.entries()) {
      this.syncProfileAndConnectionProjections(connectionId);
      const staggerMs = computeResumeStaggerMs(this.random());
      const defaultLink = links.find((l) => l.profileId === "default") ?? links[0];
      if (!defaultLink) continue;

      const timer = this.setTimer(() => {
        this.staggerTimers.delete(timer);
        if (this.disposed || this.shuttingDown || this.suspended) return;
        void this.ensureTransport(connectionId, defaultLink.profileId, {
          forceReconnect: true,
        });
      }, staggerMs);
      this.staggerTimers.add(timer);
    }
    this.emitFleet();
  }

  async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.disposed = true;
    const timeoutMs = Math.min(2000, Math.max(50, options?.timeoutMs ?? 2000));

    // 1. Stop new commands & unsubscribe registry
    this.unsubRegistry?.();

    // 2. Cancel all backoff, stability, and stagger timers
    for (const timer of this.staggerTimers) {
      this.clearTimer(timer);
    }
    this.staggerTimers.clear();
    for (const link of this.linksByKey.values()) {
      this.clearLinkTimers(link);
      link.desired = "disabled";
      link.wasDesiredBeforeSuspend = false;
      link.actual = "stopping";
      link.nextRetryAt = null;
      link.latencyMs = null;
    }

    // 3. Close all WebSocket transports
    for (const [key, entry] of [...this.transports.entries()]) {
      this.disposeTransportEntry(key, entry);
    }
    this.transports.clear();

    // 4. Close SSH tunnels & flush registry within bounded timeout (<= 2s)
    const boundedCleanup = Promise.allSettled([
      this.sshTransport?.disposeAll() ?? Promise.resolve(),
      this.registryStore?.flush(timeoutMs) ?? Promise.resolve(),
    ]);
    await Promise.race([
      boundedCleanup,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);

    // 5. Mark links idle/disabled and clear subscribers
    for (const link of this.linksByKey.values()) {
      link.actual = "idle";
    }
    this.subscribers.clear();
  }

  async dispose(): Promise<void> {
    await this.shutdown({ timeoutMs: 2000 });
  }
}

export const LocalConnectionSupervisor = ConnectionSupervisor;
