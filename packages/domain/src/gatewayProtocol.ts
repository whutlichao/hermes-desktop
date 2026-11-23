import type {
  BridgeEvent,
  BridgeScope,
  LocalFailureCode,
  ProfileSummary,
  SessionSummary,
  SessionTranscriptSnapshot,
  SupportedChatActions,
  ToolExecutionRow,
  TranscriptMessage,
  TranscriptPatchPayload,
} from "@hermes/contracts";

export const GATEWAY_WS_PROTOCOL = "hermes-gateway-v1" as const;
export const GATEWAY_TICKET_PREFIX = "hermes-gateway-ticket." as const;
export const DEFAULT_TICKET_TTL_SECONDS = 30 as const;

export interface ParsedGatewayEndpoint {
  apiOrigin?: string;
  profileId: string;
  instanceId: string;
  authorityEpoch: number;
  runtimeProtocol?: number;
  capabilities: string[];
  codeSha?: string;
  wsUrl: string;
  wsProtocol: string;
  ticketProtocolPrefix: string;
}

export type EnsureOrAttachParseResult =
  | {
      kind: "ready";
      endpoint: ParsedGatewayEndpoint;
      installCodeSha?: string;
      clientCodeSha?: string;
      ticket?: string;
      expiresInSeconds: number;
      attachable: boolean;
    }
  | {
      kind: "starting";
      reasonCode?: string;
    }
  | {
      kind: "failure";
      code: LocalFailureCode;
      reasonCode?: string;
      profileId?: string;
    };

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}

function mapReasonCodeToFailure(reasonCode: string | undefined, exitCode: number | null): LocalFailureCode {
  switch (reasonCode) {
    case "profile_parked":
    case "profile_mismatch":
    case "profile_not_served":
      return "profile_unavailable";
    case "gateway_other_session":
    case "other_session":
      return "gateway_other_session";
    case "gateway_elevated":
    case "elevated":
      return "gateway_elevated";
    case "authorization":
    case "unauthorized":
      return "authorization";
    case "update_paused":
    case "draining":
      return "update_paused";
    case "service_unhealthy":
      return "service_unhealthy";
    case "protocol_unsupported":
    case "incompatible":
      return "protocol_unsupported";
    case "code_sha_mismatch":
      return "code_sha_mismatch";
    default:
      break;
  }

  switch (exitCode) {
    case 3:
      return "protocol_unsupported";
    case 4:
      return "profile_unavailable";
    case 5:
      return "gateway_starting_timeout";
    case 6:
      return "update_paused";
    case 7:
      return "gateway_start_failed";
    default:
      return "gateway_start_failed";
  }
}

export function validateEndpointProtocol(endpoint: {
  runtimeProtocol?: number;
  capabilities: string[];
  wsUrl?: string;
}): { valid: true } | { valid: false; code: LocalFailureCode } {
  if (endpoint.runtimeProtocol !== 1) {
    return { valid: false, code: "protocol_unsupported" };
  }
  if (!endpoint.capabilities.includes("session-authority-v1")) {
    return { valid: false, code: "protocol_unsupported" };
  }
  if (!endpoint.wsUrl) {
    return { valid: false, code: "invalid_control_state" };
  }
  return { valid: true };
}

export function parseEnsureOrAttachOutput(
  stdout: string,
  exitCode: number | null,
): EnsureOrAttachParseResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    if (exitCode === 5) {
      return { kind: "starting", reasonCode: "deadline" };
    }
    return {
      kind: "failure",
      code: mapReasonCodeToFailure(undefined, exitCode),
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {
      kind: "failure",
      code: exitCode === 5 ? "gateway_starting_timeout" : "invalid_control_state",
    };
  }

  const state = asOptionalString(raw.state);
  const reasonCode = asOptionalString(raw.reason_code ?? raw.reasonCode);

  if (state === "starting" || reasonCode === "deadline" || (exitCode === 5 && state !== "ready")) {
    return {
      kind: "starting",
      reasonCode: reasonCode ?? "deadline",
    };
  }

  if (state === "error" || state === "blocked" || state === "stopped") {
    return {
      kind: "failure",
      code: mapReasonCodeToFailure(reasonCode, exitCode),
      reasonCode,
      profileId: asOptionalString(raw.profile_id ?? raw.profileId),
    };
  }

  const ep =
    raw.endpoint && typeof raw.endpoint === "object"
      ? (raw.endpoint as Record<string, unknown>)
      : raw;

  const wsUrl = asOptionalString(ep.ws_url ?? ep.wsUrl ?? ep.url);
  if (!wsUrl) {
    return {
      kind: "failure",
      code: mapReasonCodeToFailure(reasonCode, exitCode),
      reasonCode,
    };
  }

  const endpoint: ParsedGatewayEndpoint = {
    apiOrigin: asOptionalString(ep.api_origin ?? ep.apiOrigin),
    profileId: asOptionalString(ep.profile_id ?? ep.profileId) ?? "default",
    instanceId: asOptionalString(ep.instance_id ?? ep.instanceId) ?? "local-instance",
    authorityEpoch: asOptionalNumber(ep.authority_epoch ?? ep.authorityEpoch) ?? 1,
    runtimeProtocol: asOptionalNumber(ep.runtime_protocol ?? ep.runtimeProtocol),
    capabilities: asStringArray(ep.capabilities),
    codeSha: asOptionalString(ep.code_sha ?? ep.codeSha),
    wsUrl,
    wsProtocol: asOptionalString(ep.ws_protocol ?? ep.wsProtocol) ?? GATEWAY_WS_PROTOCOL,
    ticketProtocolPrefix:
      asOptionalString(ep.ticket_protocol_prefix ?? ep.ticketProtocolPrefix) ??
      GATEWAY_TICKET_PREFIX,
  };

  const protoCheck = validateEndpointProtocol(endpoint);
  if (!protoCheck.valid) {
    return {
      kind: "failure",
      code: protoCheck.code,
      reasonCode,
      profileId: endpoint.profileId,
    };
  }

  const protocols = asStringArray(raw.protocols);
  let ticket = asOptionalString(raw.ticket);
  if (!ticket) {
    const ticketProto = protocols.find((p) => p.startsWith(endpoint.ticketProtocolPrefix));
    if (ticketProto) {
      ticket = ticketProto.slice(endpoint.ticketProtocolPrefix.length);
    }
  }

  return {
    kind: "ready",
    endpoint,
    installCodeSha: asOptionalString(raw.install_code_sha ?? raw.installCodeSha),
    clientCodeSha: asOptionalString(raw.client_code_sha ?? raw.clientCodeSha),
    ticket,
    expiresInSeconds:
      asOptionalNumber(raw.expires_in_seconds ?? raw.expiresInSeconds) ?? DEFAULT_TICKET_TTL_SECONDS,
    attachable: raw.attachable === undefined ? true : Boolean(raw.attachable),
  };
}

export function evaluateCodeShaMismatch(input: {
  clientCodeSha?: string;
  endpointCodeSha?: string;
  installCodeSha?: string;
}): { mismatch: boolean; distinctShas: string[] } {
  const known = [input.clientCodeSha, input.endpointCodeSha, input.installCodeSha].filter(
    (s): s is string => typeof s === "string" && s.trim() !== "" && s !== "unknown",
  );
  const distinctShas = [...new Set(known)];
  return {
    mismatch: distinctShas.length > 1,
    distinctShas,
  };
}

export function buildGatewayWsSubprotocols(
  ticket: string,
  prefix: string = GATEWAY_TICKET_PREFIX,
): [string, string] {
  return [GATEWAY_WS_PROTOCOL, `${prefix}${ticket}`];
}

export interface ClassifiedRuntimeCapabilities {
  chatAvailable: boolean;
  promptSubmit: boolean;
  promptCancel: boolean;
  promptSteer: boolean;
  sessionCreate: boolean;
  sessionResume: boolean;
  sessionList: boolean;
  sessionTranscript: boolean;
  profilesList: boolean;
}

export function classifyRuntimeCapabilities(
  describeResult: Record<string, unknown> | null | undefined,
): ClassifiedRuntimeCapabilities {
  if (!describeResult || typeof describeResult !== "object") {
    return {
      chatAvailable: false,
      promptSubmit: false,
      promptCancel: false,
      promptSteer: false,
      sessionCreate: false,
      sessionResume: false,
      sessionList: false,
      sessionTranscript: false,
      profilesList: false,
    };
  }

  const servedRaw =
    describeResult.served_methods ??
    describeResult.servedMethods ??
    describeResult.methods;
  const refusedRaw =
    describeResult.refused_methods ??
    describeResult.refusedMethods;
  const refused = new Set(asStringArray(refusedRaw));

  if (Array.isArray(servedRaw)) {
    const served = new Set(asStringArray(servedRaw));
    const has = (method: string) => served.has(method) && !refused.has(method);
    const promptSubmit = has("prompt.submit");
    return {
      chatAvailable: promptSubmit,
      promptSubmit,
      promptCancel: has("prompt.cancel"),
      promptSteer: has("session.steer") || has("prompt.steer"),
      sessionCreate: has("session.create"),
      sessionResume: has("session.resume"),
      sessionList: has("session.list"),
      sessionTranscript: has("session.transcript"),
      profilesList: has("profiles.list"),
    };
  }

  // Fallback if runtime.describe provides a capability map instead of served_methods list
  const caps = describeResult.capabilities;
  if (caps && typeof caps === "object" && !Array.isArray(caps)) {
    const capMap = caps as Record<string, unknown>;
    const hasCap = (key: string, defaultVal: boolean) =>
      capMap[key] === undefined ? defaultVal : Boolean(capMap[key]);
    const promptSubmit = hasCap("prompt.submit", hasCap("chat", true)) && !refused.has("prompt.submit");
    return {
      chatAvailable: promptSubmit,
      promptSubmit,
      promptCancel: hasCap("prompt.cancel", true) && !refused.has("prompt.cancel"),
      promptSteer: hasCap("session.steer", true) && !refused.has("session.steer"),
      sessionCreate: hasCap("session.create", true) && !refused.has("session.create"),
      sessionResume: hasCap("session.resume", true) && !refused.has("session.resume"),
      sessionList: hasCap("session.list", true) && !refused.has("session.list"),
      sessionTranscript: hasCap("session.transcript", true) && !refused.has("session.transcript"),
      profilesList: hasCap("profiles.list", true) && !refused.has("profiles.list"),
    };
  }

  const capList = asStringArray(caps);
  const promptSubmit = capList.includes("prompt.submit") || capList.includes("chat-v1");
  return {
    chatAvailable: promptSubmit,
    promptSubmit,
    promptCancel: capList.includes("prompt.cancel") || promptSubmit,
    promptSteer: capList.includes("session.steer") || promptSubmit,
    sessionCreate: capList.includes("session.create") || capList.includes("session-authority-v1"),
    sessionResume: capList.includes("session.resume") || capList.includes("session-authority-v1"),
    sessionList: capList.includes("session.list") || capList.includes("session-authority-v1"),
    sessionTranscript: capList.includes("session.transcript") || capList.includes("session-authority-v1"),
    profilesList: capList.includes("profiles.list") || capList.includes("session-authority-v1"),
  };
}

export function isJsonRpcMethodNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { code?: unknown; rpcCode?: unknown };
  return record.code === -32601 || record.rpcCode === -32601;
}

export function toSupportedChatActions(caps: ClassifiedRuntimeCapabilities): SupportedChatActions {
  return {
    promptSubmit: caps.promptSubmit,
    promptCancel: caps.promptCancel,
    promptSteer: caps.promptSteer,
    sessionCreate: caps.sessionCreate,
    sessionResume: caps.sessionResume,
  };
}

export function filterSessionsForScope(
  sessions: SessionSummary[],
  scope: BridgeScope | null,
): SessionSummary[] {
  if (!scope) return [];
  const profileId = scope.profileId ?? "default";
  return sessions.filter(
    (s) => s.connectionId === scope.connectionId && s.profileId === profileId,
  );
}

export function filterProfilesForConnection(
  profiles: ProfileSummary[],
  connectionId: string | null | undefined,
): ProfileSummary[] {
  if (!connectionId) return [];
  return profiles.filter((p) => p.connectionId === connectionId);
}

export function reduceTranscriptEvent(
  current: SessionTranscriptSnapshot | null,
  event: BridgeEvent,
): SessionTranscriptSnapshot | null {
  if (event.topic !== "session.transcript") return current;

  if (event.kind === "snapshot") {
    return event.payload as SessionTranscriptSnapshot;
  }

  if (!current || event.kind !== "patch") {
    return current;
  }

  const patch = event.payload as TranscriptPatchPayload;
  if (patch.sessionId !== current.sessionId) {
    return current;
  }

  switch (patch.type) {
    case "message_upsert": {
      const idx = current.messages.findIndex((m) => m.messageId === patch.message.messageId);
      const messages =
        idx >= 0
          ? current.messages.map((m, i) => (i === idx ? patch.message : m))
          : [...current.messages, patch.message];
      return { ...current, messages };
    }
    case "token_delta": {
      const idx = current.messages.findIndex((m) => m.messageId === patch.messageId);
      let messages: TranscriptMessage[];
      if (idx >= 0) {
        messages = current.messages.map((m, i) =>
          i === idx
            ? {
                ...m,
                text: `${m.text}${patch.delta}`,
                streaming: true,
                status: "streaming",
                ...(patch.turnId ? { turnId: patch.turnId } : {}),
              }
            : m,
        );
      } else {
        messages = [
          ...current.messages,
          {
            messageId: patch.messageId,
            sessionId: patch.sessionId,
            role: "assistant",
            text: patch.delta,
            createdAt: new Date().toISOString(),
            turnId: patch.turnId,
            streaming: true,
            status: "streaming",
          },
        ];
      }
      return {
        ...current,
        messages,
        ...(patch.turnId ? { activeTurnId: patch.turnId } : {}),
      };
    }
    case "tool_row": {
      const targetMsgId = patch.messageId;
      let idx = targetMsgId
        ? current.messages.findIndex((m) => m.messageId === targetMsgId)
        : -1;
      if (idx < 0 && patch.turnId) {
        idx = current.messages.findIndex(
          (m) => m.role === "assistant" && m.turnId === patch.turnId,
        );
      }
      if (idx < 0) {
        const msgId = targetMsgId ?? `assistant-${patch.turnId ?? Date.now()}`;
        const created: TranscriptMessage = {
          messageId: msgId,
          sessionId: patch.sessionId,
          role: "assistant",
          text: "",
          createdAt: new Date().toISOString(),
          turnId: patch.turnId,
          streaming: true,
          status: "streaming",
          toolRows: [patch.toolRow],
        };
        return { ...current, messages: [...current.messages, created] };
      }
      const existing = current.messages[idx];
      const existingRows: ToolExecutionRow[] = existing.toolRows ?? [];
      const rowIdx = existingRows.findIndex((r) => r.toolCallId === patch.toolRow.toolCallId);
      const nextRows =
        rowIdx >= 0
          ? existingRows.map((r, i) => (i === rowIdx ? patch.toolRow : r))
          : [...existingRows, patch.toolRow];
      const messages = current.messages.map((m, i) =>
        i === idx ? { ...m, toolRows: nextRows } : m,
      );
      return { ...current, messages };
    }
    case "turn_state": {
      const messages = current.messages.map((m) => {
        if (patch.messageId && m.messageId === patch.messageId) {
          return {
            ...m,
            streaming: patch.activeTurnId !== null && patch.status === "streaming",
            status: patch.status ?? (patch.activeTurnId === null ? "complete" : m.status),
          };
        }
        if (!patch.messageId && patch.activeTurnId === null && m.streaming) {
          return {
            ...m,
            streaming: false,
            status: patch.status ?? "complete",
          };
        }
        return m;
      });
      return {
        ...current,
        messages,
        activeTurnId: patch.activeTurnId,
        turnStopping: patch.turnStopping ?? false,
      };
    }
    case "capabilities_update":
      return {
        ...current,
        chatAvailable: patch.chatAvailable,
        supportedActions: patch.supportedActions,
        chatUnavailableReason: patch.chatUnavailableReason,
      };
  }
}

export type TranscriptSyncApplyResult =
  | { status: "applied"; snapshot: SessionTranscriptSnapshot }
  | { status: "discarded_duplicate"; seq: number }
  | { status: "resync_required"; expectedSeq: number; receivedSeq: number }
  | { status: "ignored" };

/**
 * Enforces snapshot-before-patch transcript resync discipline:
 * discards duplicate pre-snapshot patches (seq <= snapshotSeq),
 * applies contiguous seq-ordered patches (seq > snapshotSeq),
 * and requires full snapshot replacement on gap or resync_required / possible_event_loss.
 */
export function createTranscriptSyncController() {
  let current: SessionTranscriptSnapshot | null = null;
  let snapshotSeq = -1;
  let lastSeq = -1;
  let needsResync = false;

  const applySnapshot = (
    snapshot: SessionTranscriptSnapshot,
    seq: number = snapshot.snapshotSeq ?? 0,
    options?: { replace?: boolean; resynced?: boolean },
  ): { status: "applied"; snapshot: SessionTranscriptSnapshot } => {
    const next: SessionTranscriptSnapshot = {
      ...snapshot,
      messages: [...snapshot.messages],
      snapshotSeq: seq,
      ...(options?.resynced !== undefined ? { resynced: options.resynced } : {}),
    };
    current = next;
    snapshotSeq = seq;
    lastSeq = seq;
    needsResync = false;
    return { status: "applied", snapshot: current };
  };

  const applyPatch = (seq: number, patch: TranscriptPatchPayload): TranscriptSyncApplyResult => {
    if (!current || needsResync) {
      return { status: "resync_required", expectedSeq: Math.max(0, lastSeq + 1), receivedSeq: seq };
    }
    if (seq <= snapshotSeq || seq <= lastSeq) {
      return { status: "discarded_duplicate", seq };
    }
    if (seq !== lastSeq + 1) {
      needsResync = true;
      return { status: "resync_required", expectedSeq: lastSeq + 1, receivedSeq: seq };
    }
    const next = reduceTranscriptEvent(current, {
      topic: "session.transcript",
      scope: {
        connectionId: current.connectionId,
        profileId: current.profileId,
        sessionId: current.sessionId,
      },
      kind: "patch",
      seq,
      revision: 0,
      payload: patch,
    });
    if (!next) {
      return { status: "ignored" };
    }
    current = next;
    lastSeq = seq;
    return { status: "applied", snapshot: current };
  };

  const acceptEvent = (event: BridgeEvent): TranscriptSyncApplyResult => {
    if (event.topic !== "session.transcript") {
      return { status: "ignored" };
    }
    const rawPayload = event.payload as Record<string, unknown> | null | undefined;
    const possibleLoss = Boolean(
      rawPayload &&
        typeof rawPayload === "object" &&
        (rawPayload.possible_event_loss === true || rawPayload.possibleEventLoss === true),
    );
    if (event.kind === "resync_required" || possibleLoss) {
      needsResync = true;
      return {
        status: "resync_required",
        expectedSeq: Math.max(0, lastSeq + 1),
        receivedSeq: event.seq,
      };
    }
    if (event.kind === "snapshot") {
      const snap = event.payload as SessionTranscriptSnapshot;
      return applySnapshot(snap, event.seq, {
        replace: true,
        resynced: snap.resynced,
      });
    }
    if (event.kind === "patch") {
      return applyPatch(event.seq, event.payload as TranscriptPatchPayload);
    }
    return { status: "ignored" };
  };

  return {
    applySnapshot,
    applyPatch,
    acceptEvent,
    getSnapshot(): SessionTranscriptSnapshot | null {
      return current;
    },
    isResyncRequired(): boolean {
      return needsResync;
    },
    reset() {
      current = null;
      snapshotSeq = -1;
      lastSeq = -1;
      needsResync = false;
    },
  };
}
