import type {
  ActivityEventPayload,
  BridgeEvent,
  BridgeScope,
  CapabilityDomainId,
  CapabilitySnapshot,
  ConnectionHealthSummary,
  ErrorCode,
  FleetSnapshot,
  LocalInspectResult,
  LocalTypedFailure,
  ProfileSummary,
  PromptEventPayload,
  SessionSummary,
  SessionTranscriptSnapshot,
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
  getLocalFailureCopy,
  isJsonRpcMethodNotFound,
  reduceTranscriptEvent,
  resolveExplicitMethodAlias,
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

export interface SupervisorConnectResult {
  ok: boolean;
  failure?: LocalTypedFailure;
  fleet: FleetSnapshot;
}

interface GatewayTransportEntry {
  key: string;
  transportMode: "shared-host-scope" | "per-profile";
  client: GatewayClient;
  dial: LocalDialMaterial;
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
  const profileId = asString(raw.profile_id ?? raw.profileId, fallbackProfileId).trim() || fallbackProfileId;
  const title = asString(raw.title ?? raw.name, "新对话") || "新对话";
  const preview = asString(raw.preview ?? raw.last_message ?? raw.lastMessage, "");
  const updatedAt = asString(raw.updated_at ?? raw.updatedAt, new Date().toISOString());
  const activeTurnIdRaw = raw.active_turn_id ?? raw.activeTurnId;
  const activeTurnId = typeof activeTurnIdRaw === "string" && activeTurnIdRaw ? activeTurnIdRaw : null;
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
          toolCallId: asString(row.tool_call_id ?? row.toolCallId ?? row.id, `${messageId}-tool-${idx}`),
          name: asString(row.name ?? row.tool, "tool"),
          status:
            row.status === "running" || row.status === "failed" || row.status === "cancelled"
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

export class LocalConnectionSupervisor {
  private readonly localBackend: LocalBackendManager;
  private readonly getLocalLabel: () => string;
  private readonly probeTimeoutMs: number;
  private readonly capabilityRegistry = new CapabilityRegistry();

  private revision = 1;
  private subscriberSeq = 0;
  private ownerGenerationSeq = 0;
  private inflightCoreProbes: Promise<void> | null = null;
  private disposed = false;

  private localHealth: ConnectionHealthSummary;
  private profiles: ProfileSummary[] = [];
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
      probeTimeoutMs?: number;
    },
  ) {
    this.localBackend = localBackend;
    this.getLocalLabel = options?.getLocalLabel ?? (() => "This device");
    this.probeTimeoutMs = options?.probeTimeoutMs ?? 1200;
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

  getFleetSnapshot(): FleetSnapshot {
    const allSessions: SessionSummary[] = [];
    for (const list of this.sessionsByScope.values()) {
      allSessions.push(...list);
    }
    const connections =
      this.localHealth.actual === "idle" &&
      this.profiles.length === 0 &&
      allSessions.length === 0 &&
      !this.localHealth.errorCode
        ? []
        : [this.getLocalHealth()];
    return {
      connections,
      profiles: [...this.profiles],
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
      sub.seq += 1;
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

  private emitFleet(): void {
    const snapshot = this.getFleetSnapshot();
    this.emitTopic("fleet", null, "snapshot", snapshot);
    this.emitTopic(
      "connection.health",
      { connectionId: "local" },
      "patch",
      this.getLocalHealth(),
      (sub) => !sub.scope || sub.scope.connectionId === "local",
    );
  }

  private emitProfiles(): void {
    this.emitTopic(
      "profiles",
      { connectionId: "local" },
      "snapshot",
      { profiles: [...this.profiles] },
      (sub) => !sub.scope || sub.scope.connectionId === "local",
    );
  }

  private emitCapabilities(): void {
    this.emitTopic("capabilities", null, "snapshot", this.capabilityRegistry.getSnapshot());
  }

  private emitSessions(profileId: string): void {
    const list = this.sessionsByScope.get(scopeKey("local", profileId)) ?? [];
    this.emitTopic(
      "sessions",
      { connectionId: "local", profileId },
      "snapshot",
      { sessions: [...list] },
      (sub) =>
        !sub.scope ||
        (sub.scope.connectionId === "local" && (!sub.scope.profileId || sub.scope.profileId === profileId)),
    );
  }

  private emitTranscriptPatch(profileId: string, sessionId: string, patch: TranscriptPatchPayload): void {
    this.emitTopic(
      "session.transcript",
      { connectionId: "local", profileId, sessionId },
      "patch",
      patch,
      (sub) =>
        Boolean(
          sub.scope &&
            sub.scope.connectionId === "local" &&
            (sub.scope.profileId ?? "default") === profileId &&
            sub.scope.sessionId === sessionId,
        ),
    );
  }

  private getTransportForProfile(profileId: string): GatewayTransportEntry | null {
    const shared = this.transports.get("shared");
    if (shared && !shared.disposed && shared.client.isOpen()) {
      return shared;
    }
    const perProfile = this.transports.get(`profile:${profileId}`);
    if (perProfile && !perProfile.disposed && perProfile.client.isOpen()) {
      return perProfile;
    }
    return null;
  }

  private async ensureProfileTransport(
    profileId: string,
    options?: { forceReconnect?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (!options?.forceReconnect) {
      const existing = this.getTransportForProfile(profileId);
      if (existing) {
        await this.refreshSessionsForProfile(existing, profileId);
        return { ok: true, fleet: this.getFleetSnapshot() };
      }
    }

    const inflightKey = options?.forceReconnect ? `retry:${profileId}` : profileId;
    const inflight = this.connectingByKey.get(inflightKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.connectLocalInternal(profileId, options).finally(() => {
      this.connectingByKey.delete(inflightKey);
    });
    this.connectingByKey.set(inflightKey, promise);
    return promise;
  }

  async connectLocal(
    profileId = "default",
    options?: { forceReconnect?: boolean },
  ): Promise<SupervisorConnectResult> {
    return this.ensureProfileTransport(profileId, options);
  }

  private async connectLocalInternal(
    profileId: string,
    options?: { forceReconnect?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    if (options?.forceReconnect) {
      // Tear down dead or stale transport(s) cleanly before re-minting ticket
      for (const [k, entry] of this.transports.entries()) {
        if (entry.transportMode === "shared-host-scope" || k === `profile:${profileId}` || !entry.client.isOpen()) {
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
    this.emitFleet();

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
      this.emitFleet();
      return {
        ok: false,
        failure: dialResult.failure,
        fleet: this.getFleetSnapshot(),
      };
    }

    const dial = dialResult.dial;
    const transportKey = dial.transportMode === "shared-host-scope" ? "shared" : `profile:${dial.profileId}`;

    // Single-use ticket consumed immediately and never retained outside this dial call
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
        this.emitFleet();
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
      this.emitFleet();
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    let client: GatewayClient;
    try {
      client = await GatewayClient.connect({
        wsUrl: dial.wsUrl,
        ticket,
        ticketProtocolPrefix: dial.ticketProtocolPrefix,
        connectTimeoutMs: 10_000,
      });
    } catch (err) {
      const errCode: ErrorCode =
        err instanceof GatewayTransportError ? err.code : "unreachable";
      this.localHealth = {
        ...this.localHealth,
        label: this.getLocalLabel(),
        actual: errCode === "timeout" ? "reconnecting" : "blocked",
        degraded: true,
        latencyMs: null,
        errorCode: errCode,
      };
      this.emitFleet();
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
        this.localHealth = {
          ...this.localHealth,
          label: this.getLocalLabel(),
          actual: "blocked",
          degraded: true,
          errorCode: "protocol_unsupported",
        };
        this.emitFleet();
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
    } catch (err) {
      if (!isJsonRpcMethodNotFound(err)) {
        // Non-fatal unless transport broke
      }
    }

    let subscribedToGateway = false;
    try {
      await client.call("subscribe", {
        topics: ["session.transcript", "prompt", "activity", "sessions", "profiles"],
      });
      subscribedToGateway = true;
    } catch {
      // Gateway may push notifications automatically or omit subscribe RPC
    }

    const entry: GatewayTransportEntry = {
      key: transportKey,
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

    entry.unsubNotification = client.onNotification((method, params) => {
      this.handleGatewayNotification(entry, method, params);
    });
    entry.unsubClose = client.onClose((reason) => {
      if (this.disposed || entry.disposed || reason === "client_closed") return;
      this.disposeTransportEntry(transportKey, entry);
      if (this.transports.size === 0) {
        this.localHealth = {
          ...this.localHealth,
          label: this.getLocalLabel(),
          actual: "reconnecting",
          degraded: true,
          latencyMs: null,
          errorCode: "unreachable",
        };
        this.capabilityRegistry.invalidate({ reason: "transport_closed" });
        this.emitCapabilities();
        this.emitFleet();
      }
    });

    const previous = this.transports.get(transportKey);
    if (previous) {
      this.disposeTransportEntry(transportKey, previous);
    }
    this.transports.set(transportKey, entry);

    this.capabilityRegistry.applyConnectHandshake({
      connectionId: "local",
      profileId: dial.profileId,
      ownerGeneration,
      authorityEpoch,
      gatewayVersionOrSha,
      describeResult: describeRes,
      serverRequestsSupported: capabilitiesReported,
    });
    this.emitCapabilities();
    this.scheduleCoreProbes(entry, dial.profileId);

    const latencyMs = Math.max(1, Date.now() - startedAt);
    this.localHealth = {
      ...this.localHealth,
      label: this.getLocalLabel(),
      actual: "ready",
      degraded: false,
      latencyMs,
      errorCode: undefined,
      message: undefined,
      nextRetryAt: null,
    };

    await this.refreshProfiles(entry, dial.profileId);
    const sessions = await this.refreshSessionsForProfile(entry, dial.profileId);

    const currentScopeMatchesLocal = this.activeScope?.connectionId === "local";
    if (!this.activeScope || !currentScopeMatchesLocal) {
      const initialSessionId = sessions[0]?.sessionId ?? null;
      this.activeScope = {
        connectionId: "local",
        profileId: dial.profileId,
        ...(initialSessionId ? { sessionId: initialSessionId } : {}),
      };
      this.activeSessionId = initialSessionId;
    }

    if (this.activeSessionId && this.activeScope?.profileId === dial.profileId) {
      await this.loadTranscriptSnapshot(entry, dial.profileId, this.activeSessionId);
    }

    this.emitFleet();
    return {
      ok: true,
      fleet: this.getFleetSnapshot(),
    };
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

    if (rawProfiles.length === 0) {
      const hasExisting = this.profiles.some((p) => p.profileId === activeProfileId);
      if (!hasExisting) {
        this.profiles = [
          ...this.profiles,
          {
            connectionId: "local",
            profileId: activeProfileId,
            displayName: activeProfileId === "default" ? "Default" : activeProfileId,
            handle: activeProfileId,
            isDefault: activeProfileId === "default",
            actual: "ready",
          },
        ];
      }
    } else {
      const existingById = new Map(this.profiles.map((p) => [p.profileId, p]));
      for (const raw of rawProfiles) {
        const pid = asString(raw.profile_id ?? raw.profileId ?? raw.id).trim();
        if (!pid) continue;
        const displayName = asString(raw.display_name ?? raw.displayName, pid) || pid;
        const handle = asString(raw.handle, pid) || pid;
        const isDefault = Boolean(raw.is_default ?? raw.isDefault ?? pid === "default");
        existingById.set(pid, {
          connectionId: "local",
          profileId: pid,
          displayName,
          handle,
          isDefault,
          actual: pid === activeProfileId ? "ready" : existingById.get(pid)?.actual ?? "idle",
        });
      }
      this.profiles = [...existingById.values()];
    }

    this.emitProfiles();
    return [...this.profiles];
  }

  private async refreshSessionsForProfile(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<SessionSummary[]> {
    let rawList: Array<Record<string, unknown>> = [];
    const callList = async (method: string) => {
      const res = await entry.client.call<{ sessions?: Array<Record<string, unknown>> }>(method, {
        profile_id: profileId,
      });
      return Array.isArray(res?.sessions) ? res.sessions : [];
    };

    try {
      rawList = await callList("session.list");
    } catch (err) {
      if (isJsonRpcMethodNotFound(err)) {
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
      .map((item) => mapRawSession(item, "local", profileId))
      .filter((item): item is SessionSummary => item !== null && item.profileId === profileId);

    this.sessionsByScope.set(scopeKey("local", profileId), mapped);
    this.emitSessions(profileId);
    return mapped;
  }

  private buildInitialTranscriptSnapshot(
    entry: GatewayTransportEntry,
    profileId: string,
    sessionId: string,
  ): SessionTranscriptSnapshot {
    const chatAvailable = entry.supportedActions.promptSubmit;
    return {
      connectionId: "local",
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
    const key = transcriptKey("local", profileId, sessionId);
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

    const gwTurnId =
      rawResult && typeof (rawResult.active_turn_id ?? rawResult.activeTurnId) === "string"
        ? String(rawResult.active_turn_id ?? rawResult.activeTurnId)
        : null;

    const merged: SessionTranscriptSnapshot = {
      ...base,
      connectionId: "local",
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
      { connectionId: "local", profileId, sessionId },
      "snapshot",
      merged,
      (sub) =>
        Boolean(
          sub.scope &&
            sub.scope.connectionId === "local" &&
            (sub.scope.profileId ?? "default") === profileId &&
            sub.scope.sessionId === sessionId,
        ),
    );
    return merged;
  }

  private applyPatchToTranscript(
    entry: GatewayTransportEntry | null,
    profileId: string,
    sessionId: string,
    patch: TranscriptPatchPayload,
  ): void {
    const key = transcriptKey("local", profileId, sessionId);
    const current =
      this.transcripts.get(key) ??
      (entry
        ? this.buildInitialTranscriptSnapshot(entry, profileId, sessionId)
        : {
            connectionId: "local",
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
      scope: { connectionId: "local", profileId, sessionId },
      kind: "patch",
      seq: 1,
      revision: this.revision,
      payload: patch,
    });
    if (next) {
      this.transcripts.set(key, next);
    }
    this.emitTranscriptPatch(profileId, sessionId, patch);
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
      const updated: SessionTranscriptSnapshot = {
        ...snap,
        chatAvailable,
        supportedActions: { ...entry.supportedActions },
        ...(chatAvailable
          ? {}
          : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      };
      this.transcripts.set(key, updated);
      this.emitTranscriptPatch(snap.profileId, snap.sessionId, {
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
    if (method === "resync_required" || method === "possible_event_loss") {
      const nextEpoch =
        typeof params.authority_epoch === "number"
          ? params.authority_epoch
          : typeof params.authorityEpoch === "number"
            ? params.authorityEpoch
            : entry.authorityEpoch;
      entry.authorityEpoch = nextEpoch;
      this.capabilityRegistry.invalidate({
        reason: method,
        authorityEpoch: nextEpoch,
      });
      this.capabilityRegistry.applyConnectHandshake({
        connectionId: "local",
        profileId: this.activeScope?.profileId ?? entry.dial.profileId,
        ownerGeneration: entry.ownerGeneration,
        authorityEpoch: nextEpoch,
        gatewayVersionOrSha: entry.gatewayVersionOrSha,
        describeResult: entry.describeResult,
        serverRequestsSupported: entry.capabilitiesReported,
      });
      this.emitCapabilities();
      this.scheduleCoreProbes(entry, this.activeScope?.profileId ?? entry.dial.profileId);
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
      this.capabilityRegistry.invalidate({
        reason: "authority_epoch_changed",
        authorityEpoch: incomingEpoch,
      });
      this.capabilityRegistry.applyConnectHandshake({
        connectionId: "local",
        profileId: this.activeScope?.profileId ?? entry.dial.profileId,
        ownerGeneration: entry.ownerGeneration,
        authorityEpoch: incomingEpoch,
        gatewayVersionOrSha: entry.gatewayVersionOrSha,
        describeResult: entry.describeResult,
        serverRequestsSupported: entry.capabilitiesReported,
      });
      this.emitCapabilities();
      this.scheduleCoreProbes(entry, this.activeScope?.profileId ?? entry.dial.profileId);
    }
    const sessionId = asString(params.session_id ?? params.sessionId).trim();
    const profileId = asString(params.profile_id ?? params.profileId, entry.dial.profileId).trim() || entry.dial.profileId;
    const resolvedProfileId = this.findProfileIdForSession(sessionId) ?? profileId;

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
        connectionId: "local",
        profileId: resolvedProfileId,
        sessionId,
        turnId: turnId ?? "",
        kind: "delta",
        delta,
        messageId,
      };
      this.emitTopic("prompt", { connectionId: "local", profileId: resolvedProfileId, sessionId }, "patch", promptPayload);
      return;
    }

    if (method === "activity" || method === "tool.execution" || method === "tool.call") {
      const rawTool = (params.tool_row && typeof params.tool_row === "object"
        ? params.tool_row
        : params) as Record<string, unknown>;
      const toolRow: ToolExecutionRow = {
        toolCallId: asString(rawTool.tool_call_id ?? rawTool.toolCallId ?? rawTool.id, `tc-${Date.now()}`),
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
        connectionId: "local",
        profileId: resolvedProfileId,
        sessionId,
        turnId,
        toolRow,
      };
      this.emitTopic("activity", { connectionId: "local", profileId: resolvedProfileId, sessionId }, "patch", activityPayload);
      return;
    }

    if (method === "prompt.completed" || method === "prompt.done" || method === "prompt.stopped" || method === "prompt.error") {
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
      this.emitTopic("prompt", { connectionId: "local", profileId: resolvedProfileId, sessionId }, "patch", {
        connectionId: "local",
        profileId: resolvedProfileId,
        sessionId,
        turnId,
        kind,
        messageId,
      } satisfies PromptEventPayload);
    }
  }

  private findProfileIdForSession(sessionId: string): string | null {
    if (!sessionId) return null;
    for (const list of this.sessionsByScope.values()) {
      const hit = list.find((s) => s.sessionId === sessionId);
      if (hit) return hit.profileId;
    }
    return null;
  }

  private resolveTargetProfile(payload: Record<string, unknown>, scope: BridgeScope | null): string {
    if (typeof payload.profileId === "string" && payload.profileId.trim()) {
      return payload.profileId.trim();
    }
    if (scope?.profileId && scope.profileId.trim()) {
      return scope.profileId.trim();
    }
    if (this.activeScope?.profileId && this.activeScope.profileId.trim()) {
      return this.activeScope.profileId.trim();
    }
    return "default";
  }

  private resolveTargetSessionId(payload: Record<string, unknown>, scope: BridgeScope | null): string | null {
    if (typeof payload.sessionId === "string" && payload.sessionId.trim()) {
      return payload.sessionId.trim();
    }
    if (scope?.sessionId && scope.sessionId.trim()) {
      return scope.sessionId.trim();
    }
    return this.activeSessionId;
  }

  private requireTransport(profileId: string): GatewayTransportEntry {
    const entry = this.getTransportForProfile(profileId);
    if (!entry) {
      throw makeBridgeError("unreachable", "Local Gateway 尚未就绪");
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
        listener({ topic, scope: null, kind: "snapshot", seq: 0, revision: rev, payload: this.getFleetSnapshot() });
      } else if (topic === "connection.health") {
        listener({ topic, scope: { connectionId: "local" }, kind: "snapshot", seq: 0, revision: rev, payload: this.getLocalHealth() });
      } else if (topic === "profiles") {
        listener({ topic, scope: { connectionId: "local" }, kind: "snapshot", seq: 0, revision: rev, payload: { profiles: [...this.profiles] } });
      } else if (topic === "sessions") {
        const pid = scope?.profileId ?? this.activeScope?.profileId ?? "default";
        const list = this.sessionsByScope.get(scopeKey("local", pid)) ?? [];
        listener({ topic, scope: { connectionId: "local", profileId: pid }, kind: "snapshot", seq: 0, revision: rev, payload: { sessions: [...list] } });
      } else if (topic === "session.transcript") {
        const pid = scope?.profileId ?? this.activeScope?.profileId ?? "default";
        const sid = scope?.sessionId ?? this.activeSessionId;
        const existing = sid ? this.transcripts.get(transcriptKey("local", pid, sid)) : null;
        const transport = this.getTransportForProfile(pid);
        const snap: SessionTranscriptSnapshot =
          existing ??
          (transport && sid
            ? this.buildInitialTranscriptSnapshot(transport, pid, sid)
            : {
                connectionId: "local",
                profileId: pid,
                sessionId: sid ?? "",
                messages: [],
                activeTurnId: null,
                turnStopping: false,
                chatAvailable: false,
                supportedActions: defaultChatActions(),
              });
        listener({ topic, scope: { connectionId: "local", profileId: pid, ...(sid ? { sessionId: sid } : {}) }, kind: "snapshot", seq: 0, revision: rev, payload: snap });
      } else if (topic === "capabilities") {
        listener({
          topic,
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.capabilityRegistry.getSnapshot(),
        });
      }
    });

    return () => {
      this.subscribers.delete(id);
    };
  }

  readonly handlers: Record<
    | "capabilities.describe"
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
    "capabilities.describe": async (payload, scope) => {
      if (this.inflightCoreProbes) {
        await this.inflightCoreProbes;
      }
      const domain =
        typeof payload.domain === "string" ? (payload.domain as CapabilityDomainId) : undefined;
      if (domain) {
        const profileId = this.resolveTargetProfile(payload, scope);
        const entry = this.getTransportForProfile(profileId);
        if (entry) {
          await this.probeDomain(entry, profileId, domain, {
            force: payload.refresh === true,
          });
          this.emitCapabilities();
        }
      }
      return this.capabilityRegistry.getSnapshot();
    },

    "connections.retry": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
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
      const profileId = this.resolveTargetProfile(payload, scope);
      const entry = this.getTransportForProfile(profileId);
      if (!entry) {
        return { profiles: [...this.profiles] };
      }
      const profiles = await this.refreshProfiles(entry, profileId);
      return { profiles };
    },

    "sessions.list": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      const entry = this.getTransportForProfile(profileId);
      if (!entry) {
        return { sessions: this.sessionsByScope.get(scopeKey("local", profileId)) ?? [] };
      }
      const sessions = await this.refreshSessionsForProfile(entry, profileId);
      this.emitFleet();
      return { sessions };
    },

    "sessions.select": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : scope?.sessionId ?? null;

      await this.ensureProfileTransport(profileId);
      const entry = this.requireTransport(profileId);
      const sessions = await this.refreshSessionsForProfile(entry, profileId);
      const resolvedSessionId = sessionId ?? sessions[0]?.sessionId ?? null;

      this.activeScope = {
        connectionId: "local",
        profileId,
        ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      };
      this.activeSessionId = resolvedSessionId;

      let transcript: SessionTranscriptSnapshot | null = null;
      if (resolvedSessionId) {
        transcript = await this.loadTranscriptSnapshot(entry, profileId, resolvedSessionId);
      }
      if (this.capabilityRegistry.getSnapshot().key.profileId !== profileId) {
        this.capabilityRegistry.applyConnectHandshake({
          connectionId: "local",
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
      this.emitFleet();
      return {
        fleet: this.getFleetSnapshot(),
        transcript,
      };
    },

    "sessions.create": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      await this.ensureProfileTransport(profileId);
      const entry = this.requireTransport(profileId);
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
        mapRawSession(rawSession, "local", profileId) ?? {
          connectionId: "local",
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

      const key = scopeKey("local", profileId);
      const existingList = this.sessionsByScope.get(key) ?? [];
      const nextList = [created, ...existingList.filter((s) => s.sessionId !== created.sessionId)];
      this.sessionsByScope.set(key, nextList);

      this.activeScope = {
        connectionId: "local",
        profileId,
        sessionId: created.sessionId,
      };
      this.activeSessionId = created.sessionId;

      const snapshot = this.buildInitialTranscriptSnapshot(entry, profileId, created.sessionId);
      this.transcripts.set(transcriptKey("local", profileId, created.sessionId), snapshot);

      this.emitSessions(profileId);
      this.emitTopic(
        "session.transcript",
        { connectionId: "local", profileId, sessionId: created.sessionId },
        "snapshot",
        snapshot,
        (sub) =>
          Boolean(
            sub.scope &&
              sub.scope.connectionId === "local" &&
              (sub.scope.profileId ?? "default") === profileId &&
              sub.scope.sessionId === created.sessionId,
          ),
      );
      this.emitFleet();
      return { session: created, transcript: snapshot, fleet: this.getFleetSnapshot() };
    },

    "sessions.resume": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      const sessionId = this.resolveTargetSessionId(payload, scope);
      if (!sessionId) {
        throw makeBridgeError("invalid_request", "缺少目标 Session");
      }
      await this.ensureProfileTransport(profileId);
      const entry = this.requireTransport(profileId);
      const transcript = await this.loadTranscriptSnapshot(entry, profileId, sessionId);
      return { transcript };
    },

    "prompts.send": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      const sessionId = this.resolveTargetSessionId(payload, scope);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", "请输入对话内容后再发送");
      }

      const entry = this.requireTransport(profileId);
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

      this.emitTopic("prompt", { connectionId: "local", profileId, sessionId }, "patch", {
        connectionId: "local",
        profileId,
        sessionId,
        turnId,
        kind: "accepted",
        messageId: assistantMsgId,
      } satisfies PromptEventPayload);

      return { accepted: true, sessionId, turnId, userMessageId: userMsgId, assistantMessageId: assistantMsgId };
    },

    "prompts.stop": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      const sessionId = this.resolveTargetSessionId(payload, scope);
      const existing = sessionId ? this.transcripts.get(transcriptKey("local", profileId, sessionId)) : null;
      const turnId =
        typeof payload.turnId === "string" && payload.turnId.trim()
          ? payload.turnId.trim()
          : existing?.activeTurnId ?? "";

      if (!sessionId || !turnId) {
        throw makeBridgeError("unknown_turn", "当前没有可停止的 Turn");
      }

      const entry = this.requireTransport(profileId);
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
        // Never pretend turn stopped when gateway Stop ACK fails!
        this.applyPatchToTranscript(entry, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: false,
        });
        this.emitTopic("prompt", { connectionId: "local", profileId, sessionId }, "patch", {
          connectionId: "local",
          profileId,
          sessionId,
          turnId,
          kind: "stop_failed",
        } satisfies PromptEventPayload);
        this.translateRpcFailure(entry, err, "promptCancel", "prompt.cancel");
      }

      if (res?.stopped === false) {
        this.applyPatchToTranscript(entry, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: false,
        });
        this.emitTopic("prompt", { connectionId: "local", profileId, sessionId }, "patch", {
          connectionId: "local",
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
      this.emitTopic("prompt", { connectionId: "local", profileId, sessionId }, "patch", {
        connectionId: "local",
        profileId,
        sessionId,
        turnId,
        kind: "stopped",
      } satisfies PromptEventPayload);
      return { stopped: true, sessionId, turnId };
    },

    "prompts.steer": async (payload, scope) => {
      const profileId = this.resolveTargetProfile(payload, scope);
      const sessionId = this.resolveTargetSessionId(payload, scope);
      const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", "缺少补充指令内容");
      }
      const entry = this.requireTransport(profileId);
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
  };

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [key, entry] of this.transports.entries()) {
      this.disposeTransportEntry(key, entry);
    }
    this.transports.clear();
    this.subscribers.clear();
  }
}
