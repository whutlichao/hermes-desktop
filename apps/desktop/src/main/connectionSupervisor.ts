import crypto from "node:crypto";
import type {
  ActivityEventPayload,
  ActiveChatRef,
  ApprovalHighRiskSheetRequest,
  ApprovalRespondResult,
  ApprovalTopicSnapshot,
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
  PromptSteerResult,
  QueuedAdmissionState,
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
  TurnRecoveryTopicSnapshot,
  WorkspaceAgentItem,
  WorkspaceCheckpointItem,
} from "@hermes/contracts";
import { ERROR_CODES } from "@hermes/contracts";
import {
  ApprovalAndRecoveryCoordinator,
  aggregateConnectionHealth,
  BackgroundJournalManager,
  type BackgroundJournalEventKind,
  assertApprovalDismissPayloadSafe,
  assertApprovalRespondPayloadSafe,
  buildSafeBackgroundNotification,
  CAPABILITY_DOMAIN_CATALOG,
  computeFullJitterBackoffMs,
  computeResumeStaggerMs,
  computeSessionPinned,
  CORE_CAPABILITY_DOMAINS,
  CapabilityRegistry,
  boundSubagentTailLines,
  classifyRuntimeCapabilities,
  getCopy,
  getLocalFailureCopy,
  isAllowedGatewayConfigKey,
  isJsonRpcMethodNotFound,
  isProfileLinkException,
  isUserVisibleProgressKind,
  makeSessionJournalKey,
  reduceTranscriptEvent,
  resolveExplicitMethodAlias,
  resolveExternalAttribution,
  resolveMethodWithAlias,
  toSupportedChatActions,
  TurnRecoveryCoordinator,
  validateCheckpointRestoreBinding,
  validateRemoteEndpointUrl,
  type ApprovalIngestInput,
  type ClassifiedRuntimeCapabilities,
  type GatewayApprovalPayload,
  type GatewayApprovalRespondOutcome,
  type GatewayApprovalRespondPayload,
  type HostCommandHandler,
  type RawGatewayQueueItem,
  type RawGatewayUnknownTurn,
} from "@hermes/domain";
import type { ChatSessionStateStore } from "./chatSessionStateStore";
import {
  GatewayClient,
  type GatewayClientTlsOptions,
  GatewayRpcError,
  GatewayTransportError,
} from "./gatewayClient";
import type { LocalBackendManager, LocalDialMaterial } from "./localBackendManager";
import {
  LocalProfileIdentityRegistry,
  isPathLikeProfileId,
  parseGatewayProfileDescriptor,
} from "./localProfileIdentity";
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
  confirmHighRiskApproval?: (request: ApprovalHighRiskSheetRequest) => Promise<boolean>;
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

/** Returns the first non-empty trimmed string from candidate fields, or "". */
function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/** Picks the first string field, preferring non-empty text without altering whitespace. */
function pickTextField(...values: unknown[]): string {
  let firstString: string | undefined;
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.length > 0) return value;
    if (firstString === undefined) firstString = value;
  }
  return firstString ?? "";
}

function epochToIsoString(epoch: number): string | null {
  if (!Number.isFinite(epoch)) return null;
  const ms = Math.abs(epoch) >= 1e11 ? epoch : epoch * 1000;
  const parsed = new Date(ms);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Normalizes ISO strings or Unix epoch seconds/milliseconds into an ISO-8601 timestamp. */
function normalizeTimestampIso(raw: Record<string, unknown>): string {
  const candidates = [raw.created_at, raw.createdAt, raw.timestamp];
  for (const candidate of candidates) {
    if (typeof candidate === "number") {
      const iso = epochToIsoString(candidate);
      if (iso) return iso;
      continue;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const trimmed = candidate.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const iso = epochToIsoString(Number(trimmed));
        if (iso) return iso;
        continue;
      }
      return trimmed;
    }
  }
  return new Date().toISOString();
}

function normalizeTerminalOutcome(rawOutcome: unknown): "completed" | "stopped" | "interrupted" | "error" {
  const normalized = typeof rawOutcome === "string" ? rawOutcome.trim().toLowerCase() : "";
  if (normalized === "stopped" || normalized === "cancelled" || normalized === "canceled") {
    return "stopped";
  }
  if (normalized === "interrupted") {
    return "interrupted";
  }
  if (normalized === "error" || normalized === "failed") {
    return "error";
  }
  return "completed";
}

function normalizeTerminalMessageStatus(rawStatus: unknown): TranscriptMessage["status"] {
  const outcome = normalizeTerminalOutcome(rawStatus);
  if (outcome === "stopped" || outcome === "interrupted") return "stopped";
  if (outcome === "error") return "error";
  return "complete";
}

function isEmptyStreamingAssistantPlaceholder(msg: TranscriptMessage): boolean {
  return (
    msg.role === "assistant" &&
    Boolean(msg.streaming) &&
    msg.text.trim() === "" &&
    !(msg.toolRows && msg.toolRows.length > 0)
  );
}

function isTerminalMessageStatus(status: TranscriptMessage["status"]): boolean {
  return status === "complete" || status === "stopped" || status === "error";
}

/** Unwraps Hermes canonical `method === "event"` envelopes while preserving legacy bare notifications. */
function unwrapGatewayNotification(
  method: string,
  params: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } | null {
  if (method !== "event") return { method, params };
  const eventType = firstNonEmptyString(params.type, params.event, params.method);
  if (!eventType) return null;
  const rawPayload = params.payload;
  const inner =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(inner)) {
    if (value !== undefined && (value !== null || merged[key] === undefined)) {
      merged[key] = value;
    }
  }
  return { method: eventType, params: merged };
}

type PromptSubmitReceiptClass =
  | { kind: "accepted"; receipt: "accepted" }
  | { kind: "admitted"; receipt: "admitted" }
  | { kind: "delivery_unknown"; receipt: "delivery_unknown" }
  | { kind: "unconfirmed"; receipt: string };

const PROMPT_SUBMIT_NEGATIVE_RECEIPTS = new Set([
  "error",
  "rejected",
  "failed",
  "denied",
  "cancelled",
  "canceled",
  "invalid",
  "invalid_params",
]);

function classifyPromptSubmitReceipt(res: Record<string, unknown>): PromptSubmitReceiptClass {
  const receiptRaw = asString(res.receipt).trim().toLowerCase();
  const statusRaw = asString(res.status).trim().toLowerCase();
  const admissionId = asString(res.admission_id ?? res.admissionId).trim();
  const hasAdmissionReference =
    Boolean(admissionId) ||
    (res.admission !== undefined && res.admission !== null) ||
    (res.ref !== undefined && res.ref !== null && typeof res.ref === "object");
  if (
    res.delivery_unknown === true ||
    res.deliveryUnknown === true ||
    receiptRaw === "delivery_unknown" ||
    receiptRaw === "unknown" ||
    statusRaw === "unknown"
  ) {
    return { kind: "delivery_unknown", receipt: "delivery_unknown" };
  }
  if (
    PROMPT_SUBMIT_NEGATIVE_RECEIPTS.has(receiptRaw) ||
    PROMPT_SUBMIT_NEGATIVE_RECEIPTS.has(statusRaw)
  ) {
    return { kind: "unconfirmed", receipt: receiptRaw || statusRaw || "unconfirmed" };
  }
  if (res.accepted === false || res.admitted === false) {
    return { kind: "unconfirmed", receipt: receiptRaw || statusRaw || "rejected" };
  }
  if (
    res.admitted === true ||
    receiptRaw === "admitted" ||
    statusRaw === "admitted"
  ) {
    return { kind: "admitted", receipt: "admitted" };
  }
  if (res.accepted === true || receiptRaw === "accepted" || statusRaw === "accepted") {
    return { kind: "accepted", receipt: "accepted" };
  }
  if (
    (statusRaw === "queued" || statusRaw === "started" || statusRaw === "terminal") &&
    hasAdmissionReference
  ) {
    return { kind: "admitted", receipt: "admitted" };
  }
  // Legacy prompt.submit returns a concrete turn id on success and carries no receipt envelope.
  // An empty or malformed response stays unconfirmed so the draft is never cleared speculatively.
  const legacyTurnId = asString(res.turn_id ?? res.turnId).trim();
  if (
    legacyTurnId &&
    res.receipt === undefined &&
    res.status === undefined &&
    res.accepted === undefined &&
    res.admitted === undefined
  ) {
    return { kind: "accepted", receipt: "accepted" };
  }
  return { kind: "unconfirmed", receipt: receiptRaw || statusRaw || "unconfirmed" };
}

function mergeSessionListFeeds(
  stored: Array<Record<string, unknown>>,
  live: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of stored) {
    const id = asString(row.session_id ?? row.sessionId ?? row.id).trim();
    if (id) byId.set(id, row);
  }
  for (const row of live) {
    const id = asString(row.session_id ?? row.sessionId ?? row.id).trim();
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) ?? {}), ...row });
  }
  return [...byId.values()];
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
    pinned: Boolean(raw.pinned || activeTurnId || raw.needs_input || raw.needsInput || raw.queued_admission || raw.queuedAdmission),
    unreadCount: 0,
    needsInput: Boolean(raw.needs_input ?? raw.needsInput),
    queuedAdmission: Boolean(raw.queued_admission ?? raw.queuedAdmission),
    activeTurnId,
    status: activeTurnId ? "running" : "idle",
  };
}

/** Resolves a stable gateway message identifier with canonical uid and row_id fallbacks. */
function resolveRawMessageId(raw: Record<string, unknown>): string {
  const explicitId = firstNonEmptyString(
    raw.message_id,
    raw.messageId,
    raw.id,
    raw.message_uid,
    raw.messageUid,
  );
  if (explicitId) return explicitId;
  if (typeof raw.id === "number" && Number.isFinite(raw.id)) {
    return String(raw.id);
  }
  const rawRowId = raw.row_id ?? raw.rowId;
  if (typeof rawRowId === "number" && Number.isFinite(rawRowId)) {
    return `row-${rawRowId}`;
  }
  if (typeof rawRowId === "string" && rawRowId.trim()) {
    return `row-${rawRowId.trim()}`;
  }
  return "";
}

function mapRawMessage(raw: Record<string, unknown>, sessionId: string): TranscriptMessage | null {
  const messageId = resolveRawMessageId(raw);
  if (!messageId) return null;
  const rawRole = firstNonEmptyString(raw.role) || "assistant";
  const role: TranscriptMessage["role"] =
    rawRole === "user" || rawRole === "system" ? rawRole : "assistant";
  const text = pickTextField(raw.text, raw.content);
  const createdAt = normalizeTimestampIso(raw);
  const turnId = firstNonEmptyString(raw.turn_id, raw.turnId) || undefined;
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
  const streaming = Boolean(raw.streaming);
  const status: TranscriptMessage["status"] = streaming
    ? "streaming"
    : normalizeTerminalMessageStatus(raw.status);
  return {
    messageId,
    sessionId,
    role,
    text,
    createdAt,
    ...(turnId ? { turnId } : {}),
    ...(toolRows ? { toolRows } : {}),
    streaming,
    status,
  };
}

/** Merges gateway-persisted messages with in-flight local messages and removes superseded optimistic placeholders. */
function mergeTranscriptMessages(input: {
  gatewayMessages: TranscriptMessage[];
  localMessages: TranscriptMessage[];
  replace: boolean;
  gatewayProvesIdle: boolean;
  optimisticIds?: ReadonlySet<string>;
}): TranscriptMessage[] {
  if (input.replace) {
    // Clean full replacement on gap/resync: never mix stale or torn local messages
    return input.gatewayMessages;
  }

  const merged = input.gatewayMessages.map((gm) => ({ ...gm }));
  const indexById = new Map<string, number>();
  merged.forEach((gm, idx) => indexById.set(gm.messageId, idx));
  const consumedGatewayIndices = new Set<number>();
  let lastMatchedGatewayIdx = -1;

  for (const localMsg of input.localMessages) {
    const exactIdx = indexById.get(localMsg.messageId);
    if (exactIdx !== undefined) {
      consumedGatewayIndices.add(exactIdx);
      lastMatchedGatewayIdx = Math.max(lastMatchedGatewayIdx, exactIdx);
      const fromGw = merged[exactIdx];
      const gwSettled =
        fromGw.streaming === false ||
        fromGw.status === "stopped" ||
        fromGw.status === "error" ||
        (fromGw.status === "complete" && fromGw.text.length >= localMsg.text.length);
      const streaming =
        input.gatewayProvesIdle || gwSettled ? false : (localMsg.streaming ?? fromGw.streaming);
      const status: TranscriptMessage["status"] =
        gwSettled
          ? (fromGw.status ?? "complete")
          : input.gatewayProvesIdle && (localMsg.status === "streaming" || fromGw.status === "streaming")
            ? "complete"
            : (localMsg.status ?? fromGw.status);
      merged[exactIdx] = {
        ...fromGw,
        text: localMsg.text.length >= fromGw.text.length ? localMsg.text : fromGw.text,
        toolRows: localMsg.toolRows ?? fromGw.toolRows,
        streaming,
        status,
        turnId: localMsg.turnId ?? fromGw.turnId,
      };
      continue;
    }

    if (input.gatewayProvesIdle && isEmptyStreamingAssistantPlaceholder(localMsg)) {
      continue;
    }

    if (input.optimisticIds?.has(localMsg.messageId)) {
      let matchIdx = merged.findIndex(
        (gm, idx) =>
          idx > lastMatchedGatewayIdx &&
          !consumedGatewayIndices.has(idx) &&
          gm.role === localMsg.role &&
          gm.text === localMsg.text,
      );
      if (matchIdx === -1) {
        matchIdx = merged.findIndex(
          (gm, idx) => !consumedGatewayIndices.has(idx) && gm.role === localMsg.role && gm.text === localMsg.text,
        );
      }
      if (matchIdx === -1 && input.gatewayProvesIdle && localMsg.role === "assistant") {
        // Only align a trailing optimistic assistant message with an unconsumed gateway assistant row after the matched turn position.
        const candidateIdx = merged.findIndex(
          (gm, idx) =>
            idx > lastMatchedGatewayIdx &&
            !consumedGatewayIndices.has(idx) &&
            gm.role === "assistant" &&
            gm.text.length > 0,
        );
        if (candidateIdx !== -1) {
          matchIdx = candidateIdx;
        }
      }
      if (matchIdx !== -1) {
        consumedGatewayIndices.add(matchIdx);
        lastMatchedGatewayIdx = Math.max(lastMatchedGatewayIdx, matchIdx);
        const fromGw = merged[matchIdx];
        merged[matchIdx] = {
          ...fromGw,
          text: localMsg.text.length >= fromGw.text.length ? localMsg.text : fromGw.text,
          toolRows: localMsg.toolRows ?? fromGw.toolRows,
          streaming: input.gatewayProvesIdle ? false : fromGw.streaming,
        };
        continue;
      }
    }

    if (input.gatewayProvesIdle && localMsg.streaming) {
      merged.push({
        ...localMsg,
        streaming: false,
        status: localMsg.status === "streaming" ? "complete" : localMsg.status,
      });
      continue;
    }

    merged.push(localMsg);
  }

  return merged;
}

function isRpcAuthError(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return false;
  return err.rpcCode === 401 || err.rpcCode === 403 || err.rpcCode === -32001;
}

function isProfileUnavailableRpcError(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return false;
  if (err.rpcCode === -32004) return true;
  const reason = err.reason?.toLowerCase();
  if (
    reason === "profile_not_served" ||
    reason === "profile_mismatch" ||
    reason === "profile_unavailable" ||
    reason === "profile_parked"
  ) {
    return true;
  }
  const msg = `${err.rpcMessage ?? ""} ${err.message}`.toLowerCase();
  return msg.includes("profile_not_served") || msg.includes("profile_mismatch") || msg.includes("profile_unavailable");
}

function isInvalidParamsRpcError(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return false;
  if (err.reason === "invalid_params") return true;
  return err.rpcMessage?.toLowerCase() === "invalid_params";
}

function normalizeCanonicalInterruptReceipt(
  res: Record<string, unknown>,
): Record<string, unknown> {
  // `session.interrupt` returns a CanonicalSessionHandle, not a legacy stop receipt. The handle
  // proves the interrupt was accepted; the turn is still stopping until prompt.stopped/terminal.
  return {
    ...res,
    accepted: true,
    status: "stopping",
    ...(typeof res.execution_generation === "number"
      ? { execution_generation: res.execution_generation }
      : {}),
  };
}

function normalizeCanonicalQueuedCancelReceipt(
  res: Record<string, unknown>,
): Record<string, unknown> {
  const status = asString(res.status).toLowerCase();
  if (status === "started") {
    return { ...res, status: "already_started" };
  }
  if (status === "unknown") {
    return { ...res, status: "cancel_unknown" };
  }
  if (status !== "terminal") {
    return res;
  }
  const outcome = asString(res.outcome).toLowerCase();
  const mapped =
    outcome === "cancelled" || outcome === "canceled"
      ? "cancelled"
      : outcome === "stopped" || outcome === "interrupted"
        ? outcome
        : outcome === "completed" || outcome === "settled"
          ? "completed"
          : outcome === "failed" || outcome === "error"
            ? "error"
            : "cancel_unknown";
  return { ...res, status: mapped };
}

interface CanonicalPendingAdmission {
  admissionId: string;
  inputId: string;
  text: string;
  status: "queued" | "started" | "unknown";
  executionGeneration?: number;
  position: number;
}

interface CanonicalPendingProjection {
  present: boolean;
  admissions: CanonicalPendingAdmission[];
  unknownTurns: RawGatewayUnknownTurn[];
  queuedAdmissions: RawGatewayQueueItem[];
}

function projectCanonicalPending(
  rawResult: Record<string, unknown> | null | undefined,
): CanonicalPendingProjection {
  if (!Array.isArray(rawResult?.pending)) {
    return { present: false, admissions: [], unknownTurns: [], queuedAdmissions: [] };
  }
  const admissions: CanonicalPendingAdmission[] = [];
  const unknownTurns: RawGatewayUnknownTurn[] = [];
  const queuedAdmissions: RawGatewayQueueItem[] = [];
  rawResult.pending.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const row = raw as Record<string, unknown>;
    const admissionId = asString(row.admission_id ?? row.admissionId).trim();
    const inputId = asString(row.input_id ?? row.inputId).trim();
    const statusRaw = asString(row.status).trim().toLowerCase();
    const status =
      statusRaw === "queued" || statusRaw === "started" || statusRaw === "unknown"
        ? statusRaw
        : null;
    if (!status) return;
    const text = typeof row.text === "string" ? row.text : "";
    const executionGenerationRaw = row.execution_generation ?? row.executionGeneration;
    const executionGeneration =
      typeof executionGenerationRaw === "number" && Number.isFinite(executionGenerationRaw)
        ? executionGenerationRaw
        : undefined;

    if (status === "unknown") {
      // Keep even an incomplete row so reconcileFromResume can surface a protocol error rather
      // than silently dropping an unknown admission.
      unknownTurns.push({
        ...(admissionId ? { admission_id: admissionId } : {}),
        ...(executionGeneration !== undefined
          ? { execution_generation: executionGeneration }
          : {}),
        ...(text ? { text } : {}),
      });
      // The row still carries its request identity, so prompt.receipt can address it even though
      // it must never be projected into the queued-admission list.
      if (admissionId && inputId) {
        admissions.push({
          admissionId,
          inputId,
          text,
          status,
          ...(executionGeneration !== undefined ? { executionGeneration } : {}),
          position: index + 1,
        });
      }
      return;
    }
    if (!admissionId || !inputId) return;

    const admission: CanonicalPendingAdmission = {
      admissionId,
      inputId,
      text,
      status,
      ...(executionGeneration !== undefined ? { executionGeneration } : {}),
      position: index + 1,
    };
    admissions.push(admission);
    queuedAdmissions.push({
      admission_id: admissionId,
      submission_id: inputId,
      text,
      position: index + 1,
      status,
      ...(executionGeneration !== undefined
        ? { execution_generation: executionGeneration }
        : {}),
    });
  });
  return { present: true, admissions, unknownTurns, queuedAdmissions };
}

function canonicalTerminalState(outcome: string): QueuedAdmissionState | null {
  switch (outcome) {
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "stopped":
      return "stopped";
    case "interrupted":
      return "interrupted";
    case "completed":
    case "settled":
      return "completed";
    case "failed":
    case "error":
      return "error";
    default:
      return null;
  }
}

function canonicalReceiptToQueueItem(
  receipt: Record<string, unknown>,
  pending: CanonicalPendingAdmission,
  submissionId: string,
): RawGatewayQueueItem | null {
  const admissionId = asString(receipt.admission_id ?? receipt.admissionId).trim();
  const status = asString(receipt.status).trim().toLowerCase();
  if (!admissionId || admissionId !== pending.admissionId) return null;
  const state =
    status === "queued"
      ? "queued"
      : status === "started"
        ? "started"
        : status === "terminal"
          ? canonicalTerminalState(asString(receipt.outcome).trim().toLowerCase())
          : null;
  if (!state) return null;
  const executionGenerationRaw =
    receipt.execution_generation ?? receipt.executionGeneration ?? pending.executionGeneration;
  const executionGeneration =
    typeof executionGenerationRaw === "number" && Number.isFinite(executionGenerationRaw)
      ? executionGenerationRaw
      : undefined;
  return {
    admission_id: admissionId,
    submission_id: submissionId,
    text: pending.text,
    position: pending.position,
    state,
    ...(executionGeneration !== undefined
      ? { execution_generation: executionGeneration }
      : {}),
  };
}

function normalizeCanonicalResolveUnknownReceipt(
  res: Record<string, unknown>,
): Record<string, unknown> {
  const status = asString(res.status).trim().toLowerCase();
  // Canonical resolve_unknown returns AdmissionStatus. Only a terminal row proves the unknown
  // admission was acknowledged; queued/started/unknown must not remove it locally.
  return { ...res, settled: status === "terminal" };
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
  private readonly confirmHighRiskApproval: (
    request: ApprovalHighRiskSheetRequest,
  ) => Promise<boolean>;
  private readonly approvalCoordinator: ApprovalAndRecoveryCoordinator;
  private readonly turnCoordinator: TurnRecoveryCoordinator;
  private readonly maxConcurrentDials: number;

  private revision = 1;
  private subscriberSeq = 0;
  private ownerGenerationSeq = 0;
  private syntheticIdSeq = 0;
  private inflightCoreProbes: Promise<void> | null = null;
  private disposed = false;
  private shuttingDown = false;
  private suspended = false;
  private approvalExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  private localHealth: ConnectionHealthSummary;
  private readonly remoteHealth = new Map<string, ConnectionHealthSummary>();
  private readonly sshHealthById = new Map<string, ConnectionHealthSummary>();
  private readonly linksByKey = new Map<string, ConnectionLinkState>();
  private readonly localProfileIdentities: LocalProfileIdentityRegistry;
  private readonly profilesByConnection = new Map<string, ProfileSummary[]>();
  private readonly sessionsByScope = new Map<string, SessionSummary[]>();
  private readonly sessionCwdByScope = new Map<string, string>();
  private readonly transcripts = new Map<string, SessionTranscriptSnapshot>();
  private readonly activeStreamingMessageBySession = new Map<string, string>();
  private readonly optimisticMessageIdsBySession = new Map<string, Set<string>>();
  private readonly optimisticTurnIdBySession = new Map<string, string>();
  private readonly backgroundJournal = new BackgroundJournalManager();
  private readonly pendingResyncKeys = new Set<string>();
  private explicitWindowFocused: boolean | null = null;
  private readonly lastKnownSubagentsBySession = new Map<string, WorkspaceAgentItem[]>();
  private readonly transports = new Map<string, GatewayTransportEntry>();
  private readonly connectingByKey = new Map<string, Promise<SupervisorConnectResult>>();
  private readonly subscribers = new Map<number, SubscriberRecord>();
  private readonly staggerTimers = new Set<ReturnType<typeof setTimeout>>();

  private activeScope: BridgeScope | null = null;
  private activeSessionId: string | null = null;

  constructor(localBackend: LocalBackendManager, options?: ConnectionSupervisorOptions) {
    this.localBackend = localBackend;
    this.localProfileIdentities =
      localBackend.profileIdentities ?? new LocalProfileIdentityRegistry();
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
    this.confirmHighRiskApproval = options?.confirmHighRiskApproval ?? (async () => false);
    this.maxConcurrentDials = Math.max(1, options?.maxConcurrentDials ?? 4);
    this.approvalCoordinator = new ApprovalAndRecoveryCoordinator({
      now: this.now,
      confirmHighRiskApproval: (req) => this.confirmHighRiskApproval(req),
      sendApprovalRespond: (payload) => this.sendApprovalRespondOverGateway(payload),
      fetchPendingApprovals: (scope) =>
        this.fetchPendingApprovalsFromGateway(scope.connectionId, scope.profileId),
      onChange: (snap) => {
        this.syncApprovalNeedsInputToSessions(snap);
        this.scheduleApprovalExpiryCheck();
        this.emitTopic("approval", null, "patch", snap);
      },
    });
    this.turnCoordinator = new TurnRecoveryCoordinator({
      now: this.now,
      onChange: (snap) => {
        this.syncTurnRecoveryToSessions(snap);
        this.emitTopic("turn.recovery", null, "patch", snap);
      },
    });
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
    const saved = this.chatSessionStateStore?.load();
    const savedHandles = this.chatSessionStateStore?.getLocalProfileHandles();
    if (savedHandles) {
      for (const [canonical, handle] of Object.entries(savedHandles)) {
        this.localProfileIdentities.registerAlias(canonical, handle);
      }
    }
    this.ensureLinkState("local", this.resolveLocalProfileId("local", "default"), "enabled");
    if (saved?.lastActiveChat) {
      this.activeScope = {
        connectionId: saved.lastActiveChat.connectionId,
        profileId: saved.lastActiveChat.profileId,
        ...(saved.lastActiveChat.sessionId ? { sessionId: saved.lastActiveChat.sessionId } : {}),
      };
      this.activeSessionId = saved.lastActiveChat.sessionId ?? null;
      this.approvalCoordinator.setActiveScope(this.activeScope);
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

  private resolveLocalProfileId(
    connectionId: string,
    profileId: string | undefined | null,
    fallback = "default",
  ): string {
    if (connectionId !== "local") {
      const trimmed = typeof profileId === "string" ? profileId.trim() : "";
      return trimmed || fallback;
    }
    return this.localProfileIdentities.resolveCanonical(profileId, fallback);
  }

  private matchesProfileScope(
    connectionId: string,
    subProfileId: string | undefined | null,
    targetProfileId: string,
  ): boolean {
    return (
      this.resolveLocalProfileId(connectionId, subProfileId, "default") ===
      this.resolveLocalProfileId(connectionId, targetProfileId)
    );
  }

  private retireLocalProfileAlias(
    connectionId: string,
    requestedProfileId: string,
    resolvedProfileId: string,
  ): void {
    if (connectionId !== "local" || requestedProfileId === resolvedProfileId) return;
    if (!isPathLikeProfileId(requestedProfileId)) {
      this.localProfileIdentities.registerAlias(resolvedProfileId, requestedProfileId);
      this.chatSessionStateStore?.recordLocalProfileAlias(resolvedProfileId, requestedProfileId);
    }
    const key = scopeKey(connectionId, requestedProfileId);
    const alias = this.linksByKey.get(key);
    if (alias) {
      const canonical = this.ensureLinkState(connectionId, resolvedProfileId, alias.desired);
      canonical.wasDesiredBeforeSuspend =
        canonical.wasDesiredBeforeSuspend || alias.wasDesiredBeforeSuspend;
      this.clearLinkTimers(alias);
      this.linksByKey.delete(key);
    }
    if (
      this.activeScope &&
      this.activeScope.connectionId === connectionId &&
      this.activeScope.profileId === requestedProfileId
    ) {
      this.activeScope = { ...this.activeScope, profileId: resolvedProfileId };
      this.approvalCoordinator.setActiveScope(this.activeScope);
    }
    this.chatSessionStateStore?.adoptLocalProfileAlias(requestedProfileId, resolvedProfileId);
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
      if (
        s.activeTurnId ||
        s.status === "running" ||
        s.needsInput ||
        s.unreadCount > 0 ||
        s.queuedAdmission ||
        s.pinned
      ) {
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

  setWindowFocused(focused: boolean): void {
    this.explicitWindowFocused = focused;
  }

  private isEffectiveWindowFocused(): boolean {
    return this.explicitWindowFocused !== null ? this.explicitWindowFocused : this.isAppForeground();
  }

  private isSessionCurrentlyActive(
    connectionId: string,
    profileId: string,
    sessionId: string,
  ): boolean {
    return Boolean(
      this.activeScope &&
        this.activeScope.connectionId === connectionId &&
        this.matchesProfileScope(connectionId, this.activeScope.profileId, profileId) &&
        (this.activeSessionId ?? this.activeScope.sessionId ?? null) === sessionId,
    );
  }

  private applyJournalOverlayToSession(session: SessionSummary): SessionSummary {
    const key = makeSessionJournalKey(session.connectionId, session.profileId, session.sessionId);
    const journal = this.backgroundJournal.getState(key);
    const runningTurn = Boolean(
      journal?.pinnedFlags.runningTurn || session.activeTurnId || session.status === "running",
    );
    const pendingInput = Boolean(journal?.pinnedFlags.pendingInput ?? session.needsInput);
    const queuedAdmission = Boolean(journal?.pinnedFlags.queuedAdmission ?? session.queuedAdmission);
    const unreadCount = journal ? journal.unreadCount : 0;
    const pinnedReasons = {
      ...(journal?.pinnedFlags ?? {}),
      runningTurn,
      pendingInput,
      unread: unreadCount > 0,
      queuedAdmission,
    };
    const pinned = computeSessionPinned(pinnedReasons, unreadCount);
    return {
      ...session,
      unreadCount,
      needsInput: pendingInput,
      queuedAdmission,
      pinned,
      pinnedReasons,
      ...(journal ? { progressSeq: journal.progressSeq, lastReadSeq: journal.lastReadSeq } : {}),
    };
  }

  private updateSessionSummary(
    connectionId: string,
    profileId: string,
    sessionId: string,
    updater: (prev: SessionSummary) => SessionSummary,
  ): void {
    const sk = scopeKey(connectionId, profileId);
    const list = this.sessionsByScope.get(sk) ?? [];
    const idx = list.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) return;
    const updated = this.applyJournalOverlayToSession(updater(list[idx]));
    const nextList = [...list];
    nextList[idx] = updated;
    this.sessionsByScope.set(sk, nextList);
    this.syncProfileAndConnectionProjections(connectionId);
    this.emitSessions(connectionId, profileId);
    this.emitFleet(connectionId);
  }

  private async syncActiveSessionOnSwitch(
    entry: GatewayTransportEntry,
    connectionId: string,
    profileId: string,
    sessionId: string,
  ): Promise<{ transcript: SessionTranscriptSnapshot | null; resyncRequired: boolean }> {
    const jKey = makeSessionJournalKey(connectionId, profileId, sessionId);
    const tk = transcriptKey(connectionId, profileId, sessionId);
    if (this.isEffectiveWindowFocused()) {
      this.backgroundJournal.markRead(jKey);
      this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
        ...prev,
        unreadCount: 0,
      }));
    }

    const journal = this.backgroundJournal.getState(jKey);
    if (journal?.resyncRequired || this.pendingResyncKeys.has(jKey)) {
      this.pendingResyncKeys.add(jKey);
      this.transcripts.delete(tk);
      this.emitTopic(
        "session.transcript",
        { connectionId, profileId, sessionId },
        "resync_required",
        { reason: journal?.resyncReason ?? "resync_required" },
        (sub) =>
          Boolean(
            sub.scope &&
              sub.scope.connectionId === connectionId &&
              this.matchesProfileScope(connectionId, sub.scope.profileId, profileId) &&
              sub.scope.sessionId === sessionId,
          ),
      );
      return { transcript: null, resyncRequired: true };
    }

    const preSwitchOptimisticIds = new Set(this.optimisticMessageIdsBySession.get(tk) ?? []);
    let snapshot = await this.loadTranscriptSnapshot(entry, profileId, sessionId);
    if (journal && journal.events.length > 0) {
      const bufferedAssistantText = new Map<string, string>();
      for (const ev of journal.events) {
        if (ev.patch.type === "token_delta") {
          const prevText = bufferedAssistantText.get(ev.patch.messageId) ?? "";
          bufferedAssistantText.set(ev.patch.messageId, `${prevText}${ev.patch.delta}`);
        } else if (ev.patch.type === "message_upsert" && ev.patch.message.role === "assistant") {
          bufferedAssistantText.set(ev.patch.message.messageId, ev.patch.message.text);
        }
      }
      let current = snapshot;
      for (const ev of journal.events) {
        const patch = ev.patch;
        if (patch.type === "token_delta" || patch.type === "message_upsert") {
          const patchMsgId =
            patch.type === "token_delta" ? patch.messageId : patch.message.messageId;
          const existingMsg = current.messages.find((m) => m.messageId === patchMsgId);
          if (existingMsg && isTerminalMessageStatus(existingMsg.status) && existingMsg.text.length > 0) {
            continue;
          }
          if (current.activeTurnId === null) {
            const expectedText = bufferedAssistantText.get(patchMsgId);
            const isSupersededByPersisted =
              expectedText !== undefined &&
              expectedText.length > 0 &&
              current.messages.some(
                (m) =>
                  m.role === "assistant" &&
                  isTerminalMessageStatus(m.status) &&
                  m.text === expectedText,
              );
            if (isSupersededByPersisted && (preSwitchOptimisticIds.has(patchMsgId) || patch.type === "message_upsert" || patch.type === "token_delta")) {
              continue;
            }
          }
        }
        const next = reduceTranscriptEvent(current, {
          topic: "session.transcript",
          scope: { connectionId, profileId, sessionId },
          kind: "patch",
          seq: 1,
          revision: this.revision,
          payload: patch,
        });
        if (next) {
          current = next;
        }
      }
      this.transcripts.set(tk, current);
      this.chatSessionStateStore?.recordTranscriptSnapshot(current);
      this.backgroundJournal.dropBufferOnly(jKey);
      snapshot = current;
      this.emitTopic(
        "session.transcript",
        { connectionId, profileId, sessionId },
        "snapshot",
        snapshot,
        (sub) =>
          Boolean(
            sub.scope &&
              sub.scope.connectionId === connectionId &&
              this.matchesProfileScope(connectionId, sub.scope.profileId, profileId) &&
              sub.scope.sessionId === sessionId,
          ),
      );
    }
    return { transcript: snapshot, resyncRequired: false };
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
        ? this.resolveLocalProfileId("local", "default")
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
        this.clearSessionTrackingMaps(tk);
      }
    }
    if (this.activeScope?.connectionId === connectionId) {
      if (this.localHealth.actual === "ready") {
        const defaultLocalProfile = this.resolveLocalProfileId("local", "default");
        const localSessions = this.sessionsByScope.get(scopeKey("local", defaultLocalProfile)) ?? [];
        const firstLocalSid = localSessions[0]?.sessionId ?? null;
        this.activeScope = {
          connectionId: "local",
          profileId: defaultLocalProfile,
          ...(firstLocalSid ? { sessionId: firstLocalSid } : {}),
        };
        this.activeSessionId = firstLocalSid;
        this.chatSessionStateStore?.recordActiveChat({
          connectionId: "local",
          profileId: defaultLocalProfile,
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
    const canonicalProfileId = this.resolveLocalProfileId(connectionId, profileId);
    const list = this.sessionsByScope.get(scopeKey(connectionId, canonicalProfileId)) ?? [];
    this.emitTopic(
      "sessions",
      { connectionId, profileId: canonicalProfileId },
      "patch",
      { sessions: [...list] },
      (sub) =>
        !sub.scope ||
        (sub.scope.connectionId === connectionId &&
          (!sub.scope.profileId ||
            this.matchesProfileScope(connectionId, sub.scope.profileId, canonicalProfileId))),
    );
  }

  private emitTranscriptPatch(
    connectionId: string,
    profileId: string,
    sessionId: string,
    patch: TranscriptPatchPayload,
  ): void {
    const canonicalProfileId = this.resolveLocalProfileId(connectionId, profileId);
    this.emitTopic(
      "session.transcript",
      { connectionId, profileId: canonicalProfileId, sessionId },
      "patch",
      patch,
      (sub) =>
        Boolean(
          sub.scope &&
            sub.scope.connectionId === connectionId &&
            this.matchesProfileScope(connectionId, sub.scope.profileId, canonicalProfileId) &&
            sub.scope.sessionId === sessionId,
        ),
    );
  }

  private getTransport(connectionId: string, profileId: string): GatewayTransportEntry | null {
    const canonicalProfileId = this.resolveLocalProfileId(connectionId, profileId);
    const shared = this.transports.get(`${connectionId}::shared`);
    if (shared && !shared.disposed && shared.client.isOpen()) {
      return shared;
    }
    const perProfile =
      this.transports.get(`${connectionId}::profile:${canonicalProfileId}`) ??
      this.transports.get(`${connectionId}::profile:${profileId}`);
    if (perProfile && !perProfile.disposed && perProfile.client.isOpen()) {
      return perProfile;
    }
    if (connectionId === "local") {
      const legacyShared = this.transports.get("shared");
      if (legacyShared && !legacyShared.disposed && legacyShared.client.isOpen()) {
        return legacyShared;
      }
      const legacyPerProfile =
        this.transports.get(`profile:${canonicalProfileId}`) ??
        this.transports.get(`profile:${profileId}`);
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
        this.clearSessionTrackingMaps(key);
      }
    }
    for (const key of [...this.sessionCwdByScope.keys()]) {
      if (key.startsWith(`${connectionId}::`)) {
        this.sessionCwdByScope.delete(key);
      }
    }
    this.approvalCoordinator.onScopeRemoved({ connectionId });
    const createdOrphans = this.chatSessionStateStore?.orphanDraftsForRemovedConnection(connectionId) ?? [];
    this.turnCoordinator.onConnectionOffline(connectionId);
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
    this.approvalCoordinator.setActiveScope(this.activeScope);
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
      this.approvalCoordinator.onConnectionOffline(
        connectionId,
        entry.transportMode === "shared-host-scope" ? undefined : entry.defaultProfileId,
      );
      this.turnCoordinator.onConnectionOffline(
        connectionId,
        entry.transportMode === "shared-host-scope" ? undefined : entry.defaultProfileId,
      );
      if (connectionId === "local" || this.activeScope?.connectionId === connectionId) {
        this.capabilityRegistry.invalidate({ reason: "transport_closed" });
        this.emitCapabilities();
      }
    } else if (
      entry.transportMode === "per-profile" &&
      !this.getTransport(connectionId, entry.defaultProfileId)
    ) {
      this.approvalCoordinator.onConnectionOffline(connectionId, entry.defaultProfileId);
      this.turnCoordinator.onConnectionOffline(connectionId, entry.defaultProfileId);
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
    const profileId = this.resolveLocalProfileId("local", previousDial.profileId);
    const link = this.ensureLinkState("local", profileId, "enabled");
    if (link.desired !== "enabled") return;

    const inflightKey = `local-drop::${profileId}`;
    if (
      this.connectingByKey.has(inflightKey) ||
      this.connectingByKey.has(`retry:local::${profileId}`) ||
      this.connectingByKey.has(`local::${profileId}`)
    ) {
      return;
    }

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
        const reattached = await this.localBackend.prepareDial({ profileId });
        if (reattached.ok) {
          if (reattached.dial.profileId && reattached.dial.profileId !== profileId) {
            this.retireLocalProfileAlias("local", profileId, reattached.dial.profileId);
          }
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
        profileId,
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
    requestedProfileId: string,
    options?: { forceReconnect?: boolean; activate?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed || this.shuttingDown) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }
    const profileId = this.resolveLocalProfileId(connectionId, requestedProfileId);
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
      this.approvalCoordinator.setActiveScope(this.activeScope);
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
      this.approvalCoordinator.setActiveScope(this.activeScope);
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
        topics: ["session.transcript", "prompt", "activity", "sessions", "profiles", "approval"],
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
    entry.unsubNotification = client.onNotification((method, params, serverRequestId) => {
      this.handleGatewayNotification(entry, method, params, serverRequestId);
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
    this.approvalCoordinator.onOwnerGenerationChanged(connectionId, entry.ownerGeneration);
    await this.rehydrateApprovalsOnConnect(entry, activeProfileId);

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
      this.approvalCoordinator.setActiveScope(this.activeScope);
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

  private isMatchingLocalTransportKey(key: string, entry: GatewayTransportEntry, profileId: string): boolean {
    if (entry.connectionId !== "local") return false;
    if (entry.transportMode === "shared-host-scope" || !entry.client.isOpen()) {
      return true;
    }
    return (
      key === `profile:${profileId}` ||
      key === `local::profile:${profileId}` ||
      this.resolveLocalProfileId("local", entry.defaultProfileId) === profileId
    );
  }

  private findOpenLocalTransport(profileId: string): GatewayTransportEntry | null {
    for (const [k, entry] of this.transports.entries()) {
      if (
        !entry.disposed &&
        entry.client.isOpen() &&
        this.isMatchingLocalTransportKey(k, entry, profileId)
      ) {
        return entry;
      }
    }
    return null;
  }

  private resetLocalLinkToClean(link: ConnectionLinkState, actual: ConnectionActualState): void {
    link.actual = actual;
    link.degraded = false;
    link.errorCode = undefined;
    link.unavailableCode = undefined;
    link.message = undefined;
    link.nextRetryAt = null;
  }

  private async connectLocalInternal(
    requestedProfileId: string,
    options?: { forceReconnect?: boolean; activate?: boolean; activateScope?: boolean },
  ): Promise<SupervisorConnectResult> {
    if (this.disposed || this.shuttingDown) {
      return { ok: false, fleet: this.getFleetSnapshot() };
    }

    const profileId = this.resolveLocalProfileId("local", requestedProfileId);
    let link = this.ensureLinkState("local", profileId, "enabled");
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
    }

    const existingOpenTransport = this.findOpenLocalTransport(profileId);
    const hadHealthyOpenTransport = Boolean(
      existingOpenTransport &&
        !existingOpenTransport.disposed &&
        existingOpenTransport.client.isOpen() &&
        link.actual === "ready" &&
        !link.degraded,
    );
    if (options?.forceReconnect) {
      for (const [k, entry] of this.transports.entries()) {
        if (entry.connectionId === "local" && !entry.client.isOpen()) {
          this.disposeTransportEntry(k, entry);
        }
      }
    }

    if (!existingOpenTransport) {
      this.resetLocalLinkToClean(link, "connecting");
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
    }

    const startedAt = this.now();
    const dialResult = await this.localBackend.prepareDial({ profileId });
    if (!dialResult.ok) {
      // Preserve a still-open healthy transport during transient ensure retries (e.g. R11 retry),
      // but never mask persistent/incompatible failures or failures on an already degraded link.
      const preserveExistingHealthy =
        hadHealthyOpenTransport &&
        existingOpenTransport &&
        !existingOpenTransport.disposed &&
        existingOpenTransport.client.isOpen() &&
        (!options?.forceReconnect ||
          dialResult.failure.actual !== "blocked" ||
          dialResult.failure.code === "gateway_start_failed");
      if (preserveExistingHealthy) {
        this.resetLocalLinkToClean(link, "ready");
        this.syncProfileAndConnectionProjections("local");
        this.syncChatStateWithSnapshot();
        this.emitFleet("local");
        return {
          ok: false,
          failure: dialResult.failure,
          fleet: this.getFleetSnapshot(),
        };
      }
      if (options?.forceReconnect) {
        for (const [k, entry] of [...this.transports.entries()]) {
          if (this.isMatchingLocalTransportKey(k, entry, profileId)) {
            this.disposeTransportEntry(k, entry);
          }
        }
      }
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
    // Retire CLI handle alias as soon as prepareDial reveals canonical profileId so downstream
    // mint/connect/describe failures never leave split alias + canonical links in linksByKey.
    if (dial.profileId && dial.profileId !== profileId) {
      this.retireLocalProfileAlias("local", profileId, dial.profileId);
    }
    const targetProfileId = dial.profileId || profileId;
    link = this.ensureLinkState("local", targetProfileId, "enabled");

    if (options?.forceReconnect) {
      for (const [k, entry] of [...this.transports.entries()]) {
        if (
          this.isMatchingLocalTransportKey(k, entry, profileId) ||
          this.isMatchingLocalTransportKey(k, entry, targetProfileId)
        ) {
          this.disposeTransportEntry(k, entry);
        }
      }
    }
    const transportKey =
      dial.transportMode === "shared-host-scope"
        ? "local::shared"
        : `local::profile:${targetProfileId}`;

    let ticket = dial.consumeTicket();
    if (!ticket) {
      const minted = await this.localBackend.mintReconnectTicket(dial);
      if (!minted.ok) {
        if (minted.failure.code === "ticket_unavailable") {
          const reattached = await this.localBackend.prepareDial({ profileId: targetProfileId });
          if (reattached.ok) {
            if (reattached.dial.profileId && reattached.dial.profileId !== targetProfileId) {
              this.retireLocalProfileAlias("local", targetProfileId, reattached.dial.profileId);
            }
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
          this.scheduleLinkBackoff("local", targetProfileId, errCode, msg);
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
      this.approvalCoordinator.setActiveScope(this.activeScope);
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
        topics: ["session.transcript", "prompt", "activity", "sessions", "profiles", "approval"],
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

    entry.unsubNotification = client.onNotification((method, notifParams, serverRequestId) => {
      this.handleGatewayNotification(entry, method, notifParams, serverRequestId);
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
    if ("cliProfileId" in dial) {
      this.retireLocalProfileAlias(connectionId, dial.cliProfileId, dial.profileId);
    }

    await this.refreshProfiles(entry, dial.profileId);
    const sessions = await this.refreshSessionsForProfile(entry, dial.profileId);
    const ownerProfileFilter =
      entry.transportMode === "shared-host-scope" ? undefined : dial.profileId;
    this.approvalCoordinator.onOwnerGenerationChanged(
      connectionId,
      entry.ownerGeneration,
      ownerProfileFilter,
    );
    this.turnCoordinator.onOwnerGenerationChanged(
      connectionId,
      entry.ownerGeneration,
      ownerProfileFilter,
    );
    await this.rehydrateApprovalsOnConnect(entry, dial.profileId);

    // Resync ONLY active transcript on reconnect; mark any non-active cached transcript for lazy resync without prefetching background sessions
    for (const [tk, tx] of [...this.transcripts.entries()]) {
      if (tx.connectionId === connectionId && tx.profileId === dial.profileId && tx.sessionId) {
        if (this.isSessionCurrentlyActive(connectionId, dial.profileId, tx.sessionId)) {
          await this.loadTranscriptSnapshot(entry, dial.profileId, tx.sessionId, {
            replace: true,
            resynced: true,
          });
        } else {
          this.transcripts.delete(tk);
          this.clearSessionTrackingMaps(tk);
          this.backgroundJournal.markResyncRequired(tk, "reconnect");
        }
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
          rehydrateApprovals: true,
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
          rehydrateApprovals: true,
        });
      }

      const remoteIsCurrentlyActive =
        this.activeScope &&
        this.activeScope.connectionId !== "local" &&
        this.getConnectionHealth(this.activeScope.connectionId)?.actual === "ready" &&
        !params.activateScope;

      if (!remoteIsCurrentlyActive) {
        if (this.chatSessionStateStore) {
          const resolvedSavedProfileId = savedActive
            ? this.resolveLocalProfileId(savedActive.connectionId, savedActive.profileId)
            : null;
          const hasSessionForDialedScope =
            savedActive &&
            savedActive.connectionId === "local" &&
            resolvedSavedProfileId === dial.profileId &&
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
    this.approvalCoordinator.setActiveScope(this.activeScope);
    this.emitFleet(connectionId);
    return {
      ok: true,
      fleet: this.getFleetSnapshot(),
    };
  }

  private async activateOrRefreshProfileOnSharedTransport(
    entry: GatewayTransportEntry,
    profileId: string,
    options?: { resyncTranscripts?: boolean; rehydrateApprovals?: boolean },
  ): Promise<boolean> {
    const connectionId = entry.connectionId;
    const link = this.ensureLinkState(connectionId, profileId, "enabled");
    const wasReady = link.actual === "ready";
    if (!this.suspended) {
      link.desired = "enabled";
      link.wasDesiredBeforeSuspend = true;
    }

    await this.refreshSessionsForProfile(entry, profileId);
    if (options?.rehydrateApprovals || !wasReady) {
      await this.rehydrateApprovalsOnConnect(entry, profileId);
    }
    const updatedLink = this.ensureLinkState(connectionId, profileId, "enabled");
    if (updatedLink.actual === "blocked" && updatedLink.unavailableCode === "profile_unavailable") {
      return false;
    }

    const baseLatency = this.getConnectionHealth(connectionId)?.latencyMs ?? 1;
    this.markLinkReady(connectionId, profileId, baseLatency);

    if (options?.resyncTranscripts) {
      for (const [tk, tx] of [...this.transcripts.entries()]) {
        if (tx.connectionId === connectionId && tx.profileId === profileId && tx.sessionId) {
          if (this.isSessionCurrentlyActive(connectionId, profileId, tx.sessionId)) {
            await this.loadTranscriptSnapshot(entry, profileId, tx.sessionId, {
              replace: true,
              resynced: true,
            });
          } else {
            this.transcripts.delete(tk);
            this.clearSessionTrackingMaps(tk);
            this.backgroundJournal.markResyncRequired(tk, "reconnect");
          }
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
    requestedActiveProfileId: string,
  ): Promise<ProfileSummary[]> {
    const connectionId = entry.connectionId;
    const activeProfileId = this.resolveLocalProfileId(connectionId, requestedActiveProfileId);
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
        const cliHandle =
          connectionId === "local"
            ? this.localProfileIdentities.resolveCliSelector(activeProfileId)
            : activeProfileId;
        const link = this.ensureLinkState(connectionId, activeProfileId, "enabled");
        this.profilesByConnection.set(connectionId, [
          ...currentProfiles,
          {
            connectionId,
            profileId: activeProfileId,
            displayName: cliHandle === "default" ? "Default" : cliHandle,
            handle: cliHandle,
            isDefault: cliHandle === "default" || activeProfileId === "default",
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
        const parsed =
          connectionId === "local"
            ? this.localProfileIdentities.parseGatewayDescriptor(raw)
            : parseGatewayProfileDescriptor(raw);
        if (!parsed) continue;
        const { profileId: pid, displayName, handle, isDefault } = parsed;
        if (connectionId === "local" && !isPathLikeProfileId(handle) && handle !== pid) {
          this.retireLocalProfileAlias(connectionId, handle, pid);
        }

        if (seenIds.has(pid)) continue;
        seenIds.add(pid);
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
          const cwdPrefix = `${connectionId}::${link.profileId}::`;
          for (const key of [...this.sessionCwdByScope.keys()]) {
            if (key.startsWith(cwdPrefix)) {
              this.sessionCwdByScope.delete(key);
            }
          }
          this.approvalCoordinator.onScopeRemoved({ connectionId, profileId: link.profileId });
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
    requestedProfileId: string,
    err: unknown,
  ): void {
    const profileId = this.resolveLocalProfileId(connectionId, requestedProfileId);
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
    requestedProfileId: string,
  ): Promise<SessionSummary[]> {
    const connectionId = entry.connectionId;
    const profileId = this.resolveLocalProfileId(
      connectionId,
      requestedProfileId,
      entry.defaultProfileId,
    );
    let rawList: Array<Record<string, unknown>> = [];
    const callList = async (
      method: string,
      extraParams: Record<string, unknown> = {},
    ) => {
      const res = await entry.client.call<{ sessions?: Array<Record<string, unknown>> }>(
        method,
        {
          ...this.gatewayProfileParams(entry, profileId),
          ...extraParams,
        },
      );
      return Array.isArray(res?.sessions) ? res.sessions : [];
    };

    if (entry.capabilities.sessionList) {
      try {
        const runtimeCapabilities = Array.isArray(entry.describeResult?.capabilities)
          ? entry.describeResult.capabilities.filter(
              (capability): capability is string => typeof capability === "string",
            )
          : [];
        const supportsScopedLiveFeed =
          runtimeCapabilities.includes("session-list-picker-v1") ||
          runtimeCapabilities.includes("session-list-cursor-v1");

        if (supportsScopedLiveFeed) {
          // picker/cursor are the owner's promise that both scoped feeds exist. A refusal here is
          // a protocol failure, not an older Gateway; returning stored-only would hide it.
          const stored = await callList("session.list", { scope: "stored" });
          const live = await callList("session.list", { scope: "live" });
          rawList = mergeSessionListFeeds(stored, live);
        } else {
          try {
            const stored = await callList("session.list", { scope: "stored" });
            let live: Array<Record<string, unknown>> = [];
            try {
              live = await callList("session.list", { scope: "live" });
            } catch (err) {
              if (!isJsonRpcMethodNotFound(err) && !isInvalidParamsRpcError(err)) {
                throw err;
              }
              // Older owners may not serve the live scope; the stored picker feed still stands.
            }
            rawList = mergeSessionListFeeds(stored, live);
          } catch (err) {
            if (!isInvalidParamsRpcError(err)) {
              throw err;
            }
            // Older owners serve a singular session.list with no scope parameter.
            rawList = await callList("session.list");
          }
        }
      } catch (err) {
        if (isProfileUnavailableRpcError(err)) {
          this.markProfileUnavailable(connectionId, profileId, err);
          return [];
        }
        if (isRpcAuthError(err) && connectionId !== "local") {
          this.markConnectionAuthRequired(connectionId);
        } else if (isJsonRpcMethodNotFound(err)) {
          try {
            rawList = await callList("sessions.list");
          } catch (err2) {
            if (isProfileUnavailableRpcError(err2)) {
              this.markProfileUnavailable(connectionId, profileId, err2);
              return [];
            }
            if (isJsonRpcMethodNotFound(err2)) {
              entry.capabilities.sessionList = false;
            } else {
              throw err2;
            }
          }
        } else {
          throw err;
        }
      }
    }

    const mapped = rawList
      .map((item) => {
        const rawSession = mapRawSession(item, connectionId, profileId);
        if (!rawSession) return null;
        const resolvedSessionProfile = this.resolveLocalProfileId(
          connectionId,
          rawSession.profileId,
          profileId,
        );
        const s =
          resolvedSessionProfile === rawSession.profileId
            ? rawSession
            : { ...rawSession, profileId: resolvedSessionProfile };
        if (s.profileId === profileId) {
          this.extractAndStoreSessionCwd(connectionId, profileId, s.sessionId, item);
          const withJournal = this.applyJournalOverlayToSession(s);
          if (this.approvalCoordinator.hasPendingForSession(connectionId, profileId, s.sessionId)) {
            return { ...withJournal, needsInput: true };
          }
          return withJournal;
        }
        return s;
      })
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
          ...this.gatewayProfileParams(entry, profileId),
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
          ...this.gatewayProfileParams(entry, profileId),
          session_id: sessionId,
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          entry.capabilities.sessionTranscript = false;
        }
      }
    }

    if (rawResult) {
      this.extractAndStoreSessionCwd(connectionId, profileId, sessionId, rawResult);
      if (rawResult.session && typeof rawResult.session === "object") {
        this.extractAndStoreSessionCwd(
          connectionId,
          profileId,
          sessionId,
          rawResult.session as Record<string, unknown>,
        );
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

    const gwTurnId =
      rawResult && typeof (rawResult.active_turn_id ?? rawResult.activeTurnId) === "string"
        ? String(rawResult.active_turn_id ?? rawResult.activeTurnId).trim() || null
        : null;

    const gwExecGen =
      rawResult && typeof (rawResult.execution_generation ?? rawResult.executionGeneration) === "number"
        ? Number(rawResult.execution_generation ?? rawResult.executionGeneration)
        : undefined;
    const canonicalPending = this.usesCanonicalSessionControlWire(entry)
      ? projectCanonicalPending(rawResult)
      : null;
    const rawUnknownTurns = canonicalPending?.present
      ? canonicalPending.unknownTurns
      : rawResult
        ? ((rawResult.unknown_turns ?? rawResult.unknownTurns) as
            | RawGatewayUnknownTurn[]
            | undefined)
        : undefined;
    const rawQueue = canonicalPending?.present
      ? canonicalPending.queuedAdmissions
      : rawResult
        ? ((rawResult.queued_admissions ?? rawResult.queuedAdmissions ?? rawResult.queue) as
            | RawGatewayQueueItem[]
            | undefined)
        : undefined;
    const rawLastOutcome = rawResult
      ? ((rawResult.last_turn_outcome ?? rawResult.lastTurnOutcome) as
          | "completed"
          | "stopped"
          | "interrupted"
          | "error"
          | null
          | undefined)
      : undefined;

    const hasExplicitPending = Array.isArray(rawResult?.pending);
    const hasPendingItems = hasExplicitPending ? (rawResult!.pending as unknown[]).length > 0 : false;
    const hasUnknownTurns = Array.isArray(rawUnknownTurns) && rawUnknownTurns.length > 0;
    const gatewayProvesIdle = Boolean(
      rawResult &&
        rawResult.running === false &&
        hasExplicitPending &&
        !hasPendingItems &&
        !hasUnknownTurns &&
        !gwTurnId,
    );

    const finalMessages = mergeTranscriptMessages({
      gatewayMessages,
      localMessages: base.messages,
      replace: Boolean(options?.replace),
      gatewayProvesIdle,
      optimisticIds: this.optimisticMessageIdsBySession.get(key),
    });

    const resolvedActiveTurnId =
      options?.replace || gatewayProvesIdle ? gwTurnId : (base.activeTurnId ?? gwTurnId);
    const recoveryView = rawResult
      ? this.turnCoordinator.reconcileFromResume({
          connectionId,
          profileId,
          sessionId,
          ownerGeneration: entry.ownerGeneration,
          activeTurnId: resolvedActiveTurnId,
          ...(gwExecGen !== undefined ? { executionGeneration: gwExecGen } : {}),
          ...(Array.isArray(rawUnknownTurns) ? { unknownTurns: rawUnknownTurns } : {}),
          ...(Array.isArray(rawQueue) ? { queuedAdmissions: rawQueue } : {}),
          ...(canonicalPending?.present ? { queueSnapshotProvesAbsence: false } : {}),
          ...(rawLastOutcome !== undefined ? { lastTurnOutcome: rawLastOutcome } : {}),
        })
      : this.turnCoordinator.getSessionView({ connectionId, profileId, sessionId });

    const effectiveActiveTurnId = recoveryView?.unknownTurn
      ? null
      : gatewayProvesIdle
        ? null
        : recoveryView?.activeTurnId ?? resolvedActiveTurnId;

    const merged: SessionTranscriptSnapshot = {
      ...base,
      connectionId,
      profileId,
      sessionId,
      messages: finalMessages,
      activeTurnId: effectiveActiveTurnId,
      turnStopping: recoveryView ? recoveryView.stopState === "stopping" : base.turnStopping,
      ...(recoveryView
        ? {
            executionGeneration: recoveryView.executionGeneration,
            stopState: recoveryView.stopState,
          }
        : {}),
      chatAvailable: entry.supportedActions.promptSubmit,
      ...(entry.supportedActions.promptSubmit
        ? {}
        : { chatUnavailableReason: "capability_missing:prompt.submit" }),
      supportedActions: { ...entry.supportedActions },
      snapshotSeq: 0,
      ...(options?.resynced ? { resynced: true } : {}),
    };

    if (options?.replace || gatewayProvesIdle) {
      this.clearSessionTrackingMaps(key);
    }

    if (recoveryView?.unknownTurn || (gatewayProvesIdle && !effectiveActiveTurnId)) {
      this.backgroundJournal.setPinnedFlags(
        makeSessionJournalKey(connectionId, profileId, sessionId),
        { runningTurn: false },
      );
      this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
        ...prev,
        activeTurnId: null,
        status: "idle",
      }));
    }

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
            this.matchesProfileScope(connectionId, sub.scope.profileId, profileId) &&
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

    if (domain === "memory") {
      await this.probeMemoryDomain(entry, profileId);
      return;
    }

    if (domain === "messaging") {
      await this.probeMessagingDomain(entry, profileId);
      return;
    }

    if (domain === "cron") {
      await this.probeCronDomain(entry, profileId);
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

  private async probeMemoryDomain(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<void> {
    const currentSnap = this.capabilityRegistry.getSnapshot();
    const baseKey = {
      expectedOwnerGeneration: entry.ownerGeneration,
      expectedAuthorityEpoch: entry.authorityEpoch,
      expectedGeneration: currentSnap.generation,
    };
    if (this.capabilityRegistry.isMethodRefused("session.context_breakdown")) {
      this.capabilityRegistry.applyMemoryState({
        ...baseKey,
        outcome: "refused",
      });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "memory",
        method: "session.context_breakdown",
        outcome: "refused",
      });
      return;
    }

    let primaryMissing = false;
    try {
      const raw = await entry.client.call<unknown>(
        "session.context_breakdown",
        { profile_id: profileId },
        { timeoutMs: this.probeTimeoutMs },
      );
      this.capabilityRegistry.applyMemoryState({
        ...baseKey,
        outcome: "ok",
        sourceMethod: "session.context_breakdown",
        rawPayload: raw,
      });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "memory",
        method: "session.context_breakdown",
        outcome: "ok",
      });
      return;
    } catch (err) {
      if (!isJsonRpcMethodNotFound(err)) {
        this.capabilityRegistry.applyMemoryState({
          ...baseKey,
          outcome: err instanceof GatewayTransportError && err.code === "timeout" ? "older" : "error",
          errorCode: err instanceof GatewayTransportError && err.code === "timeout" ? "RPC_TIMEOUT" : "MEMORY_FETCH_FAILED",
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "memory",
          method: "session.context_breakdown",
          outcome: "timeout",
        });
        return;
      }
      primaryMissing = true;
    }

    if (primaryMissing) {
      this.capabilityRegistry.markMethodNotFound({
        method: "session.context_breakdown",
        expectedOwnerGeneration: entry.ownerGeneration,
        expectedAuthorityEpoch: entry.authorityEpoch,
      });
    }

    if (this.capabilityRegistry.isMethodRefused("session.info")) {
      this.capabilityRegistry.applyMemoryState({ ...baseKey, outcome: "refused" });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "memory",
        method: "session.info",
        outcome: "refused",
      });
      return;
    }
    try {
      const raw = await entry.client.call<unknown>(
        "session.info",
        { profile_id: profileId },
        { timeoutMs: this.probeTimeoutMs },
      );
      this.capabilityRegistry.applyMemoryState({
        ...baseKey,
        outcome: "ok",
        sourceMethod: "session.info",
        rawPayload: raw,
      });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "memory",
        method: "session.info",
        outcome: "ok",
      });
    } catch (err) {
      if (isJsonRpcMethodNotFound(err)) {
        this.capabilityRegistry.applyMemoryState({ ...baseKey, outcome: "method_not_found" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "memory",
          method: "session.info",
          outcome: "method_not_found",
        });
      } else {
        this.capabilityRegistry.applyMemoryState({
          ...baseKey,
          outcome: err instanceof GatewayTransportError && err.code === "timeout" ? "older" : "error",
          errorCode: err instanceof GatewayTransportError && err.code === "timeout" ? "RPC_TIMEOUT" : "MEMORY_FETCH_FAILED",
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "memory",
          method: "session.info",
          outcome: "timeout",
        });
      }
    }
  }

  private async probeMessagingDomain(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<void> {
    const currentSnap = this.capabilityRegistry.getSnapshot();
    const baseKey = {
      expectedOwnerGeneration: entry.ownerGeneration,
      expectedAuthorityEpoch: entry.authorityEpoch,
      expectedGeneration: currentSnap.generation,
    };
    if (this.capabilityRegistry.isMethodRefused("messaging.status")) {
      this.capabilityRegistry.applyMessagingState({ ...baseKey, outcome: "refused" });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "messaging",
        method: "messaging.status",
        outcome: "refused",
      });
      return;
    }
    try {
      const raw = await entry.client.call<unknown>(
        "messaging.status",
        { profile_id: profileId },
        { timeoutMs: this.probeTimeoutMs },
      );
      this.capabilityRegistry.applyMessagingState({
        ...baseKey,
        outcome: "ok",
        rawPayload: raw,
      });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "messaging",
        method: "messaging.status",
        outcome: "ok",
      });
    } catch (err) {
      if (isJsonRpcMethodNotFound(err)) {
        this.capabilityRegistry.applyMessagingState({ ...baseKey, outcome: "method_not_found" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "messaging",
          method: "messaging.status",
          outcome: "method_not_found",
        });
      } else {
        this.capabilityRegistry.applyMessagingState({
          ...baseKey,
          outcome: err instanceof GatewayTransportError && err.code === "timeout" ? "older" : "error",
          errorCode: err instanceof GatewayTransportError && err.code === "timeout" ? "RPC_TIMEOUT" : "MESSAGING_FETCH_FAILED",
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "messaging",
          method: "messaging.status",
          outcome: "timeout",
        });
      }
    }
  }

  private async probeCronDomain(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<void> {
    const currentSnap = this.capabilityRegistry.getSnapshot();
    const baseKey = {
      expectedOwnerGeneration: entry.ownerGeneration,
      expectedAuthorityEpoch: entry.authorityEpoch,
      expectedGeneration: currentSnap.generation,
    };
    if (this.capabilityRegistry.isMethodRefused("cron.status")) {
      this.capabilityRegistry.applyCronState({ ...baseKey, outcome: "refused" });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "cron",
        method: "cron.status",
        outcome: "refused",
      });
      return;
    }
    try {
      const raw = await entry.client.call<unknown>(
        "cron.status",
        { profile_id: profileId },
        { timeoutMs: this.probeTimeoutMs },
      );
      this.capabilityRegistry.applyCronState({ ...baseKey, outcome: "ok", rawPayload: raw });
      this.capabilityRegistry.applyProbeOutcome({
        ...baseKey,
        domain: "cron",
        method: "cron.status",
        outcome: "ok",
      });
    } catch (err) {
      if (isJsonRpcMethodNotFound(err)) {
        this.capabilityRegistry.applyCronState({ ...baseKey, outcome: "method_not_found" });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "cron",
          method: "cron.status",
          outcome: "method_not_found",
        });
      } else {
        this.capabilityRegistry.applyCronState({
          ...baseKey,
          outcome: err instanceof GatewayTransportError && err.code === "timeout" ? "older" : "error",
          errorCode: err instanceof GatewayTransportError && err.code === "timeout" ? "RPC_TIMEOUT" : "CRON_FETCH_FAILED",
        });
        this.capabilityRegistry.applyProbeOutcome({
          ...baseKey,
          domain: "cron",
          method: "cron.status",
          outcome: "timeout",
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

  /** Clears per-session optimistic message/turn tracking state when a transcript is reset or dropped. */
  private clearSessionTrackingMaps(txKey: string): void {
    this.activeStreamingMessageBySession.delete(txKey);
    this.optimisticMessageIdsBySession.delete(txKey);
    this.optimisticTurnIdBySession.delete(txKey);
  }

  /** Generates a monotonically increasing synthetic local identifier for optimistic items. */
  private nextSyntheticId(prefix: string): string {
    this.syntheticIdSeq += 1;
    return `${prefix}-${this.now()}-${this.syntheticIdSeq}`;
  }

  /** Records a locally synthesized message ID so session.resume can deduplicate it against DB rows. */
  private trackOptimisticMessageId(txKey: string, messageId: string): void {
    let set = this.optimisticMessageIdsBySession.get(txKey);
    if (!set) {
      set = new Set<string>();
      this.optimisticMessageIdsBySession.set(txKey, set);
    }
    set.add(messageId);
  }

  /** Resolves or creates the active streaming assistant messageId for a session turn. */
  private resolveAssistantMessageId(
    txKey: string,
    params: Record<string, unknown>,
    turnId?: string,
    admId?: string,
  ): string {
    const explicitId = firstNonEmptyString(params.message_id, params.messageId, params.id);
    if (explicitId) {
      this.activeStreamingMessageBySession.set(txKey, explicitId);
      return explicitId;
    }
    const tracked = this.activeStreamingMessageBySession.get(txKey);
    if (tracked) return tracked;
    const existingMessages = this.transcripts.get(txKey)?.messages ?? [];
    for (let i = existingMessages.length - 1; i >= 0; i -= 1) {
      const m = existingMessages[i];
      if (m.role !== "assistant") continue;
      if ((m.streaming || m.status === "streaming") && (!turnId || !m.turnId || m.turnId === turnId)) {
        this.activeStreamingMessageBySession.set(txKey, m.messageId);
        return m.messageId;
      }
    }
    const generated = turnId
      ? `assistant-${turnId}`
      : admId
        ? `assistant-${admId}`
        : this.nextSyntheticId("assistant");
    this.activeStreamingMessageBySession.set(txKey, generated);
    this.trackOptimisticMessageId(txKey, generated);
    return generated;
  }

  /** Replaces an optimistic local turnId with the gateway's canonical turnId without dropping stop state. */
  private syncTurnIdFromGatewayEvent(
    connectionId: string,
    profileId: string,
    sessionId: string,
    txKey: string,
    gwTurnId: string,
    ownerGeneration: number,
    execGen?: number,
  ): void {
    const existing = this.turnCoordinator.getSessionView({ connectionId, profileId, sessionId });
    if (existing?.activeTurnId === gwTurnId) return;
    if (existing?.activeTurnId && this.optimisticTurnIdBySession.get(txKey) !== existing.activeTurnId) {
      return;
    }
    this.optimisticTurnIdBySession.delete(txKey);
    if (existing?.activeTurnId) {
      this.turnCoordinator.adoptGatewayTurnId({
        connectionId,
        profileId,
        sessionId,
        turnId: gwTurnId,
        ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
      });
      return;
    }
    this.turnCoordinator.noteTurnStarted({
      connectionId,
      profileId,
      sessionId,
      turnId: gwTurnId,
      executionGeneration: execGen ?? existing?.executionGeneration ?? 1,
      ownerGeneration,
    });
  }

  /** Advances the background journal sequence watermark for non-patch session notifications. */
  private recordGatewaySeqCheckpoint(input: {
    jKey: string;
    seqRaw?: number;
    isFocused: boolean;
    isActive: boolean;
  }): void {
    if (typeof input.seqRaw !== "number") return;
    this.backgroundJournal.recordEvent(input.jKey, {
      kind: "other",
      countsAsUnread: false,
      gatewaySeq: input.seqRaw,
      isWindowFocused: input.isFocused,
      isViewingSession: input.isActive,
    });
  }

  /** Applies a transcript patch directly to the active session or buffers it in the background journal. */
  private recordTranscriptPatchOrBuffer(input: {
    entry: GatewayTransportEntry;
    connectionId: string;
    profileId: string;
    sessionId: string;
    jKey: string;
    kind: BackgroundJournalEventKind;
    countsAsUnread: boolean;
    seqRaw?: number;
    isFocused: boolean;
    isActive: boolean;
    patch: TranscriptPatchPayload;
  }): void {
    if (input.isActive) {
      this.backgroundJournal.recordEvent(input.jKey, {
        kind: input.kind,
        countsAsUnread: input.countsAsUnread,
        gatewaySeq: input.seqRaw,
        isWindowFocused: input.isFocused,
        isViewingSession: true,
      });
      this.applyPatchToTranscript(
        input.entry,
        input.connectionId,
        input.profileId,
        input.sessionId,
        input.patch,
      );
      return;
    }
    this.backgroundJournal.recordEvent(input.jKey, {
      kind: input.kind,
      countsAsUnread: input.countsAsUnread,
      gatewaySeq: input.seqRaw,
      isWindowFocused: input.isFocused,
      isViewingSession: false,
      patch: input.patch,
    });
  }

  /** Reconciles unknown turns reported inside a canonical `session.info` notification. */
  private handleSessionInfoUnknownTurns(input: {
    entry: GatewayTransportEntry;
    connectionId: string;
    profileId: string;
    sessionId: string;
    jKey: string;
    txKey: string;
    isActive: boolean;
    isFocused: boolean;
    seqRaw?: number;
    execGen?: number;
    hasQueued: boolean;
    canonicalPending: CanonicalPendingProjection;
  }): void {
    const {
      entry,
      connectionId,
      profileId,
      sessionId,
      jKey,
      txKey,
      isActive,
      isFocused,
      seqRaw,
      execGen,
      hasQueued,
      canonicalPending,
    } = input;
    const recovery = this.turnCoordinator.reconcileFromResume({
      connectionId,
      profileId,
      sessionId,
      ownerGeneration: entry.ownerGeneration,
      activeTurnId: null,
      ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
      unknownTurns: canonicalPending.unknownTurns,
      queuedAdmissions: canonicalPending.queuedAdmissions,
      queueSnapshotProvesAbsence: false,
    });
    this.activeStreamingMessageBySession.delete(txKey);
    this.optimisticTurnIdBySession.delete(txKey);
    this.backgroundJournal.setPinnedFlags(jKey, { runningTurn: false, queuedAdmission: hasQueued });
    this.recordTranscriptPatchOrBuffer({
      entry,
      connectionId,
      profileId,
      sessionId,
      jKey,
      kind: "turn_boundary",
      countsAsUnread: false,
      seqRaw,
      isFocused,
      isActive,
      patch: {
        type: "turn_state",
        sessionId,
        activeTurnId: null,
        turnStopping: false,
        executionGeneration: recovery.executionGeneration,
        stopState: recovery.stopState,
      },
    });
    this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
      ...prev,
      activeTurnId: null,
      status: "idle",
      queuedAdmission: hasQueued,
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Settles any lingering optimistic turn and empty streaming placeholder on explicit `running=false, pending=[]`. */
  private handleSessionInfoIdle(input: {
    entry: GatewayTransportEntry;
    connectionId: string;
    profileId: string;
    sessionId: string;
    jKey: string;
    txKey: string;
    isActive: boolean;
    isFocused: boolean;
    seqRaw?: number;
    execGen?: number;
  }): void {
    const { entry, connectionId, profileId, sessionId, jKey, txKey, isActive, isFocused, seqRaw, execGen } = input;
    const existing = this.turnCoordinator.getSessionView({ connectionId, profileId, sessionId });
    const currentTx = this.transcripts.get(txKey);
    const hasStreamingMsg = Boolean(
      currentTx?.messages.some((m) => m.streaming || m.status === "streaming"),
    );
    const wasActive = Boolean(
      existing?.activeTurnId || (currentTx && (currentTx.activeTurnId !== null || hasStreamingMsg)),
    );

    this.activeStreamingMessageBySession.delete(txKey);
    this.optimisticTurnIdBySession.delete(txKey);
    this.backgroundJournal.setPinnedFlags(jKey, { runningTurn: false, queuedAdmission: false });

    if (existing?.activeTurnId) {
      this.turnCoordinator.noteTurnTerminal({
        connectionId,
        profileId,
        sessionId,
        ...(execGen !== undefined && execGen >= existing.executionGeneration
          ? { executionGeneration: execGen }
          : {}),
        outcome: "completed",
      });
    }

    let recordedSeq = false;
    if (wasActive) {
      const latestRecovery = this.turnCoordinator.getSessionView({
        connectionId,
        profileId,
        sessionId,
      });
      const patch: TranscriptPatchPayload = {
        type: "turn_state",
        sessionId,
        activeTurnId: null,
        turnStopping: false,
        ...(latestRecovery ? { executionGeneration: latestRecovery.executionGeneration } : {}),
        stopState: latestRecovery?.stopState ?? "idle",
      };
      if (isActive && currentTx && currentTx.messages.some(isEmptyStreamingAssistantPlaceholder)) {
        const settledMessages = currentTx.messages
          .filter((m) => !isEmptyStreamingAssistantPlaceholder(m))
          .map((m) =>
            m.streaming
              ? {
                  ...m,
                  streaming: false,
                  status: m.status === "streaming" ? ("complete" as const) : m.status,
                }
              : m,
          );
        const nextSnap: SessionTranscriptSnapshot = {
          ...currentTx,
          messages: settledMessages,
          activeTurnId: null,
          turnStopping: false,
          ...(latestRecovery ? { executionGeneration: latestRecovery.executionGeneration } : {}),
          stopState: latestRecovery?.stopState ?? "idle",
          snapshotSeq: 0,
        };
        this.transcripts.set(txKey, nextSnap);
        this.emitTopic(
          "session.transcript",
          { connectionId, profileId, sessionId },
          "snapshot",
          nextSnap,
          (sub) =>
            Boolean(
              sub.scope &&
                sub.scope.connectionId === connectionId &&
                this.matchesProfileScope(connectionId, sub.scope.profileId, profileId) &&
                sub.scope.sessionId === sessionId,
            ),
        );
      } else {
        this.recordTranscriptPatchOrBuffer({
          entry,
          connectionId,
          profileId,
          sessionId,
          jKey,
          kind: "turn_boundary",
          countsAsUnread: false,
          seqRaw,
          isFocused,
          isActive,
          patch,
        });
        recordedSeq = true;
      }
    }

    if (!recordedSeq) {
      this.recordGatewaySeqCheckpoint({ jKey, seqRaw, isFocused, isActive });
    }

    this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
      ...prev,
      activeTurnId: null,
      status: "idle",
      queuedAdmission: false,
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Handles canonical `session.info` snapshots for queued, running, unknown-turn, and idle states. */
  private handleSessionInfoNotification(input: {
    entry: GatewayTransportEntry;
    connectionId: string;
    profileId: string;
    sessionId: string;
    params: Record<string, unknown>;
    jKey: string;
    txKey: string;
    isActive: boolean;
    isFocused: boolean;
    seqRaw?: number;
  }): void {
    const { entry, connectionId, profileId, sessionId, params, jKey, txKey, isActive, isFocused, seqRaw } = input;
    const canonicalPending = Array.isArray(params.pending) ? projectCanonicalPending(params) : null;
    const execGen =
      typeof (params.execution_generation ?? params.executionGeneration) === "number"
        ? Number(params.execution_generation ?? params.executionGeneration)
        : undefined;
    const hasUnknown = Boolean(canonicalPending && canonicalPending.unknownTurns.length > 0);
    const hasRawPendingItems = Array.isArray(params.pending) && params.pending.length > 0;
    const hasQueued = Boolean(canonicalPending?.admissions.some((a) => a.status === "queued"));

    if (hasUnknown && canonicalPending) {
      this.handleSessionInfoUnknownTurns({
        entry,
        connectionId,
        profileId,
        sessionId,
        jKey,
        txKey,
        isActive,
        isFocused,
        seqRaw,
        execGen,
        hasQueued,
        canonicalPending,
      });
      return;
    }

    if (canonicalPending?.present) {
      this.turnCoordinator.applyGatewayQueueSnapshot({
        connectionId,
        profileId,
        sessionId,
        queuedAdmissions: canonicalPending.queuedAdmissions,
      });
      this.backgroundJournal.setPinnedFlags(jKey, { queuedAdmission: hasQueued });
    }

    if (params.running === true) {
      this.recordGatewaySeqCheckpoint({ jKey, seqRaw, isFocused, isActive });
      const existing = this.turnCoordinator.getSessionView({ connectionId, profileId, sessionId });
      const startedAdm = canonicalPending?.admissions.find((a) => a.status === "started");
      const explicitTurnId = firstNonEmptyString(params.turn_id, params.turnId);
      const turnId =
        explicitTurnId ||
        existing?.activeTurnId ||
        (startedAdm ? `turn-${startedAdm.admissionId}` : this.nextSyntheticId("turn"));
      let recovery = existing;
      if (!existing?.activeTurnId) {
        recovery = this.turnCoordinator.noteTurnStarted({
          connectionId,
          profileId,
          sessionId,
          turnId,
          ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
          ownerGeneration: entry.ownerGeneration,
        });
        if (isActive) {
          this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
            type: "turn_state",
            sessionId,
            activeTurnId: turnId,
            turnStopping: false,
            executionGeneration: recovery.executionGeneration,
            stopState: "idle",
          });
        }
      }
      this.backgroundJournal.setPinnedFlags(jKey, {
        runningTurn: true,
        ...(canonicalPending?.present ? { queuedAdmission: hasQueued } : {}),
      });
      this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
        ...prev,
        activeTurnId: turnId,
        status: "running",
        ...(canonicalPending?.present ? { queuedAdmission: hasQueued } : {}),
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const isExplicitIdle =
      params.running === false &&
      Array.isArray(params.pending) &&
      !hasRawPendingItems &&
      !hasUnknown;

    if (!isExplicitIdle) {
      this.recordGatewaySeqCheckpoint({ jKey, seqRaw, isFocused, isActive });
      if (canonicalPending?.present) {
        this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
          ...prev,
          queuedAdmission: hasQueued,
          updatedAt: new Date().toISOString(),
        }));
      }
      return;
    }

    this.handleSessionInfoIdle({
      entry,
      connectionId,
      profileId,
      sessionId,
      jKey,
      txKey,
      isActive,
      isFocused,
      seqRaw,
      execGen,
    });
  }

  private handleGatewayNotification(
    entry: GatewayTransportEntry,
    rawMethod: string,
    rawParams: Record<string, unknown>,
    serverRequestId?: string | number,
  ): void {
    if (this.disposed || this.shuttingDown || entry.disposed) return;
    const currentEntry = this.transports.get(entry.key);
    if (currentEntry && currentEntry.ownerGeneration !== entry.ownerGeneration) {
      return;
    }

    const unwrapped = unwrapGatewayNotification(rawMethod, rawParams);
    if (!unwrapped) return;
    const { method, params } = unwrapped;

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
        entry.transportMode === "shared-host-scope" && this.activeScope?.connectionId === connectionId
          ? (this.activeScope.profileId ?? entry.defaultProfileId)
          : entry.defaultProfileId;
      this.approvalCoordinator.onConnectionOffline(
        connectionId,
        entry.transportMode === "shared-host-scope" ? undefined : entry.defaultProfileId,
      );
      const profilesToResync = new Set<string>([targetProfileId]);
      if (entry.transportMode === "shared-host-scope") {
        for (const link of this.getLinksForConnection(connectionId)) {
          if (link.desired === "enabled") {
            profilesToResync.add(link.profileId);
          }
        }
      }
      for (const pid of profilesToResync) {
        void this.resyncApprovalsForEntry(entry, pid);
      }
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
        entry.transportMode === "shared-host-scope" && this.activeScope?.connectionId === connectionId
          ? (this.activeScope.profileId ?? entry.defaultProfileId)
          : entry.defaultProfileId;
      void this.resyncApprovalsForEntry(entry, targetProfileId);
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
    const rawProfileId =
      asString(params.profile_id ?? params.profileId, entry.defaultProfileId).trim() ||
      entry.defaultProfileId;
    const profileId = this.resolveLocalProfileId(
      connectionId,
      rawProfileId,
      entry.defaultProfileId,
    );
    const resolvedProfileId = this.findProfileIdForSession(connectionId, sessionId) ?? profileId;
    if (
      entry.transportMode === "per-profile" &&
      this.resolveLocalProfileId(connectionId, resolvedProfileId, entry.defaultProfileId) !==
        this.resolveLocalProfileId(connectionId, entry.defaultProfileId)
    ) {
      return;
    }

    if (method === "approval.requested" || method === "approval.pending") {
      this.approvalCoordinator.receive(
        this.toApprovalIngestInput(params, entry, resolvedProfileId, serverRequestId),
      );
      this.notifyBackgroundEventForTest({
        kind: "approval_pending",
        scope: {
          connectionId,
          profileId: resolvedProfileId,
          ...(sessionId ? { sessionId } : {}),
        },
        rawPayload: params,
      });
      if (sessionId) {
        const jKey = makeSessionJournalKey(connectionId, resolvedProfileId, sessionId);
        this.backgroundJournal.setPinnedFlags(jKey, { pendingInput: true });
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          needsInput: true,
          updatedAt: new Date().toISOString(),
        }));
      }
      return;
    }

    if (method === "clarify.requested" || method === "clarify.pending") {
      if (sessionId) {
        const jKey = makeSessionJournalKey(connectionId, resolvedProfileId, sessionId);
        this.backgroundJournal.setPinnedFlags(jKey, { pendingInput: true });
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          needsInput: true,
          updatedAt: new Date().toISOString(),
        }));
      }
      return;
    }

    if (method === "clarify.resolved" || method === "clarify.decided") {
      if (sessionId) {
        const jKey = makeSessionJournalKey(connectionId, resolvedProfileId, sessionId);
        this.backgroundJournal.setPinnedFlags(jKey, {
          pendingInput: this.approvalCoordinator.hasPendingForSession(
            connectionId,
            resolvedProfileId,
            sessionId,
          ),
        });
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          needsInput: this.approvalCoordinator.hasPendingForSession(
            connectionId,
            resolvedProfileId,
            sessionId,
          ),
          updatedAt: new Date().toISOString(),
        }));
      }
      return;
    }

    if (
      method === "admission.queued" ||
      method === "session.queued" ||
      method === "queue.snapshot" ||
      method === "queue.updated" ||
      method === "admission.updated"
    ) {
      if (sessionId) {
        const rawList = params.queued_admissions ?? params.queuedAdmissions ?? params.queue;
        if (Array.isArray(rawList)) {
          this.turnCoordinator.applyGatewayQueueSnapshot({
            connectionId,
            profileId: resolvedProfileId,
            sessionId,
            queuedAdmissions: rawList as RawGatewayQueueItem[],
          });
        } else {
          const admissionId = asString(params.admission_id ?? params.admissionId).trim();
          if (admissionId) {
            const rawState = asString(params.state ?? params.status, "queued");
            const mappedState: QueuedAdmissionState =
              rawState === "cancelling" ||
              rawState === "cancel_unknown" ||
              rawState === "cancelled" ||
              rawState === "stopped" ||
              rawState === "already_started" ||
              rawState === "completed" ||
              rawState === "error" ||
              rawState === "interrupted"
                ? rawState
                : "queued";
            const execGen =
              typeof (params.execution_generation ?? params.executionGeneration) === "number"
                ? Number(params.execution_generation ?? params.executionGeneration)
                : undefined;
            this.turnCoordinator.applyAdmissionEvent({
              connectionId,
              profileId: resolvedProfileId,
              sessionId,
              admissionId,
              submissionId: asString(params.submission_id ?? params.submissionId).trim() || undefined,
              state: mappedState,
              turnId: asString(params.turn_id ?? params.turnId).trim() || undefined,
              executionGeneration: execGen,
              reason: asString(params.reason ?? params.message).trim() || undefined,
            });
          }
        }
        const queued = params.queued !== false;
        const jKey = makeSessionJournalKey(connectionId, resolvedProfileId, sessionId);
        this.backgroundJournal.setPinnedFlags(jKey, { queuedAdmission: queued });
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          queuedAdmission: queued,
          updatedAt: new Date().toISOString(),
        }));
      }
      return;
    }

    if (method === "turn.unknown" || method === "prompt.unknown") {
      if (sessionId) {
        const admissionId = asString(params.admission_id ?? params.admissionId, `adm-${Date.now()}`);
        const execGen =
          typeof (params.execution_generation ?? params.executionGeneration) === "number"
            ? Number(params.execution_generation ?? params.executionGeneration)
            : 1;
        const turnId = asString(params.turn_id ?? params.turnId).trim() || undefined;
        const recovery = this.turnCoordinator.ingestUnknownTurn({
          connectionId,
          profileId: resolvedProfileId,
          sessionId,
          admissionId,
          executionGeneration: execGen,
          ownerGeneration: entry.ownerGeneration,
          turnId,
          originalInput:
            typeof params.original_input === "string"
              ? params.original_input
              : typeof params.originalInput === "string"
                ? params.originalInput
                : typeof params.text === "string"
                  ? params.text
                  : undefined,
          lostReason: asString(params.lost_reason ?? params.lostReason ?? params.reason) || undefined,
          message: asString(params.message) || undefined,
        });
        const jKey = makeSessionJournalKey(connectionId, resolvedProfileId, sessionId);
        this.backgroundJournal.setPinnedFlags(jKey, { runningTurn: false });
        this.applyPatchToTranscript(entry, connectionId, resolvedProfileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: null,
          turnStopping: false,
          executionGeneration: recovery.executionGeneration,
          stopState: recovery.stopState,
        });
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          activeTurnId: null,
          status: "idle",
          updatedAt: new Date().toISOString(),
        }));
        this.emitTopic("prompt", { connectionId, profileId: resolvedProfileId, sessionId }, "patch", {
          connectionId,
          profileId: resolvedProfileId,
          sessionId,
          turnId: turnId ?? "",
          executionGeneration: execGen,
          kind: "unknown_turn",
        } satisfies PromptEventPayload);
      }
      return;
    }

    if (
      method === "approval.resolved" ||
      method === "approval.settled_elsewhere" ||
      method === "approval.settled"
    ) {
      const approvalId = asString(
        params.approval_id ?? params.approvalId ?? params.prompt_id ?? params.promptId,
      ).trim();
      if (approvalId) {
        const turnId = asString(params.turn_id ?? params.turnId).trim() || undefined;
        const execGen =
          typeof params.execution_generation === "number"
            ? params.execution_generation
            : typeof params.executionGeneration === "number"
              ? params.executionGeneration
              : undefined;
        this.approvalCoordinator.markSettledElsewhereByServer({
          connectionId,
          profileId: resolvedProfileId,
          ...(sessionId ? { sessionId } : {}),
          approvalId,
          ...(turnId ? { turnId } : {}),
          ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
          reason: asString(params.reason ?? params.message) || undefined,
        });
      }
      return;
    }

    if (method === "approval.expired") {
      const approvalId = asString(
        params.approval_id ?? params.approvalId ?? params.prompt_id ?? params.promptId,
      ).trim();
      if (approvalId) {
        const turnId = asString(params.turn_id ?? params.turnId).trim() || undefined;
        this.approvalCoordinator.markExpired({
          connectionId,
          profileId: resolvedProfileId,
          approvalId,
          ...(sessionId ? { sessionId } : {}),
          ...(turnId ? { turnId } : {}),
        });
      }
      return;
    }

    if (!sessionId) return;

    const seqRaw =
      typeof params.seq === "number"
        ? params.seq
        : typeof params.sequence === "number"
          ? params.sequence
          : undefined;
    const isActive = this.isSessionCurrentlyActive(connectionId, resolvedProfileId, sessionId);
    const isFocused = this.isEffectiveWindowFocused();
    const jKey = makeSessionJournalKey(connectionId, resolvedProfileId, sessionId);
    const txKey = transcriptKey(connectionId, resolvedProfileId, sessionId);
    const scopeMatchesSession = (sub: SubscriberRecord) =>
      !sub.scope ||
      (sub.scope.connectionId === connectionId &&
        (!sub.scope.profileId ||
          this.matchesProfileScope(connectionId, sub.scope.profileId, resolvedProfileId)) &&
        (!sub.scope.sessionId || sub.scope.sessionId === sessionId));

    if (method === "session.info") {
      this.handleSessionInfoNotification({
        entry,
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        params,
        jKey,
        txKey,
        isActive,
        isFocused,
        seqRaw,
      });
      return;
    }

    if (method === "prompt.started" || method === "turn.started" || method === "message.start") {
      const explicitTurnId = firstNonEmptyString(params.turn_id, params.turnId);
      const admId = firstNonEmptyString(params.admission_id, params.admissionId) || undefined;
      const execGen =
        typeof (params.execution_generation ?? params.executionGeneration) === "number"
          ? Number(params.execution_generation ?? params.executionGeneration)
          : undefined;
      const existing = this.turnCoordinator.getSessionView({
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
      });
      if (method === "message.start" && !explicitTurnId && existing?.activeTurnId) {
        const messageId = this.resolveAssistantMessageId(
          txKey,
          params,
          existing.activeTurnId,
          admId,
        );
        const existingTx = this.transcripts.get(txKey);
        const hasPlaceholder = Boolean(existingTx?.messages.some((m) => m.messageId === messageId));
        if (!hasPlaceholder) {
          this.recordTranscriptPatchOrBuffer({
            entry,
            connectionId,
            profileId: resolvedProfileId,
            sessionId,
            jKey,
            kind: "other",
            countsAsUnread: false,
            seqRaw,
            isFocused,
            isActive,
            patch: {
              type: "message_upsert",
              sessionId,
              message: {
                messageId,
                sessionId,
                role: "assistant",
                text: "",
                createdAt: new Date().toISOString(),
                turnId: existing.activeTurnId,
                streaming: true,
                status: "streaming",
              },
            },
          });
        } else {
          this.recordGatewaySeqCheckpoint({ jKey, seqRaw, isFocused, isActive });
        }
        return;
      }
      this.recordGatewaySeqCheckpoint({ jKey, seqRaw, isFocused, isActive });
      const turnId = explicitTurnId || existing?.activeTurnId || this.nextSyntheticId("turn");
      if (!explicitTurnId) {
        this.optimisticTurnIdBySession.set(txKey, turnId);
      } else {
        this.optimisticTurnIdBySession.delete(txKey);
      }
      const recovery = this.turnCoordinator.noteTurnStarted({
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        turnId,
        ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
        ownerGeneration: entry.ownerGeneration,
      });
      if (method === "message.start") {
        this.resolveAssistantMessageId(txKey, params, turnId, admId);
      }
      if (admId) {
        this.turnCoordinator.applyAdmissionEvent({
          connectionId,
          profileId: resolvedProfileId,
          sessionId,
          admissionId: admId,
          state: "already_started",
          turnId,
          executionGeneration: recovery.executionGeneration,
        });
      }
      this.backgroundJournal.setPinnedFlags(jKey, { runningTurn: true });
      if (isActive) {
        this.applyPatchToTranscript(entry, connectionId, resolvedProfileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: false,
          executionGeneration: recovery.executionGeneration,
          stopState: "idle",
        });
      }
      this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
        ...prev,
        activeTurnId: turnId,
        status: "running",
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    if (method === "prompt.stopping" || method === "turn.stopping") {
      const turnId = asString(params.turn_id ?? params.turnId, "");
      const execGen =
        typeof (params.execution_generation ?? params.executionGeneration) === "number"
          ? Number(params.execution_generation ?? params.executionGeneration)
          : undefined;
      const existing = this.turnCoordinator.getSessionView({
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
      });
      const effectiveTurnId = turnId || existing?.activeTurnId || "";
      if (effectiveTurnId && isActive) {
        this.applyPatchToTranscript(entry, connectionId, resolvedProfileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: effectiveTurnId,
          turnStopping: true,
          ...(execGen !== undefined ? { executionGeneration: execGen } : {}),
          stopState: "stopping",
        });
      }
      return;
    }

    if (method === "prompt.delta" || method === "prompt.token" || method === "message.delta") {
      const explicitTurnId = firstNonEmptyString(params.turn_id, params.turnId) || undefined;
      const admId = firstNonEmptyString(params.admission_id, params.admissionId) || undefined;
      const execGen =
        typeof (params.execution_generation ?? params.executionGeneration) === "number"
          ? Number(params.execution_generation ?? params.executionGeneration)
          : undefined;
      if (explicitTurnId) {
        this.syncTurnIdFromGatewayEvent(
          connectionId,
          resolvedProfileId,
          sessionId,
          txKey,
          explicitTurnId,
          entry.ownerGeneration,
          execGen,
        );
      }
      const turnId =
        explicitTurnId ??
        this.turnCoordinator.getSessionView({
          connectionId,
          profileId: resolvedProfileId,
          sessionId,
        })?.activeTurnId ??
        undefined;
      const messageId = this.resolveAssistantMessageId(txKey, params, turnId, admId);
      const delta = pickTextField(params.delta, params.text, params.content);
      const patch: TranscriptPatchPayload = {
        type: "token_delta",
        sessionId,
        turnId,
        messageId,
        delta,
      };
      this.recordTranscriptPatchOrBuffer({
        entry,
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        jKey,
        kind: "token_delta",
        countsAsUnread: false,
        seqRaw,
        isFocused,
        isActive,
        patch,
      });
      if (isActive) {
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
          scopeMatchesSession,
        );
      }
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
      const messageId =
        firstNonEmptyString(params.message_id, params.messageId) ||
        this.activeStreamingMessageBySession.get(txKey) ||
        undefined;
      const patch: TranscriptPatchPayload = {
        type: "tool_row",
        sessionId,
        turnId,
        messageId,
        toolRow,
      };
      const hasResultSummary =
        toolRow.status === "completed" ||
        toolRow.status === "failed" ||
        toolRow.status === "cancelled" ||
        Boolean(toolRow.summary && toolRow.summary.trim().length > 0);
      const journalKind: BackgroundJournalEventKind = hasResultSummary
        ? "tool_result_summary"
        : "tool_running";
      const countsAsUnread = isUserVisibleProgressKind(journalKind);

      this.recordTranscriptPatchOrBuffer({
        entry,
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        jKey,
        kind: journalKind,
        countsAsUnread,
        seqRaw,
        isFocused,
        isActive,
        patch,
      });
      if (isActive) {
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
          scopeMatchesSession,
        );
      }

      if (countsAsUnread) {
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          preview: toolRow.summary ? `${toolRow.name}: ${toolRow.summary}` : prev.preview,
          updatedAt: new Date().toISOString(),
        }));
      }
      return;
    }

    if (
      method === "message.created" ||
      method === "message.upsert" ||
      method === "assistant.message"
    ) {
      const rawMsg =
        params.message && typeof params.message === "object"
          ? (params.message as Record<string, unknown>)
          : params;
      const mapped = mapRawMessage(rawMsg, sessionId);
      if (!mapped) return;
      const journalKind: BackgroundJournalEventKind =
        mapped.role === "assistant" ? "assistant_message" : "other";
      const countsAsUnread = isUserVisibleProgressKind(journalKind);
      const patch: TranscriptPatchPayload = {
        type: "message_upsert",
        sessionId,
        message: mapped,
      };
      this.recordTranscriptPatchOrBuffer({
        entry,
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        jKey,
        kind: journalKind,
        countsAsUnread,
        seqRaw,
        isFocused,
        isActive,
        patch,
      });
      if (countsAsUnread) {
        this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
          ...prev,
          preview: mapped.text ? mapped.text.slice(0, 140) : prev.preview,
          updatedAt: mapped.createdAt || new Date().toISOString(),
        }));
      }
      return;
    }

    if (
      method === "prompt.completed" ||
      method === "prompt.done" ||
      method === "prompt.stopped" ||
      method === "prompt.error" ||
      method === "message.complete"
    ) {
      const explicitTurnId = firstNonEmptyString(params.turn_id, params.turnId);
      const execGen =
        typeof (params.execution_generation ?? params.executionGeneration) === "number"
          ? Number(params.execution_generation ?? params.executionGeneration)
          : undefined;
      const admId = firstNonEmptyString(params.admission_id, params.admissionId);
      const existingRecovery = this.turnCoordinator.getSessionView({
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
      });
      if (explicitTurnId) {
        this.syncTurnIdFromGatewayEvent(
          connectionId,
          resolvedProfileId,
          sessionId,
          txKey,
          explicitTurnId,
          entry.ownerGeneration,
          execGen,
        );
      }
      const turnId = explicitTurnId || existingRecovery?.activeTurnId || "";
      const rawOutcome = firstNonEmptyString(params.outcome, params.status);
      const terminalOutcome =
        method === "prompt.stopped"
          ? "stopped"
          : method === "prompt.error"
            ? "error"
            : method === "message.complete"
              ? normalizeTerminalOutcome(rawOutcome)
              : "completed";
      const status =
        method === "prompt.stopped"
          ? "stopped"
          : method === "prompt.error"
            ? "error"
            : method === "message.complete"
              ? normalizeTerminalMessageStatus(rawOutcome)
              : "complete";

      const finalText = pickTextField(params.text, params.content);
      const explicitMessageId = firstNonEmptyString(params.message_id, params.messageId, params.id);
      const trackedMessageId = this.activeStreamingMessageBySession.get(txKey);
      const explicitOrTrackedMessageId = explicitMessageId || trackedMessageId;
      const messageId = finalText
        ? (explicitOrTrackedMessageId ??
          this.resolveAssistantMessageId(txKey, params, turnId || undefined, admId || undefined))
        : explicitOrTrackedMessageId || undefined;
      const supersededPlaceholderId =
        explicitMessageId &&
        trackedMessageId &&
        trackedMessageId !== explicitMessageId &&
        this.optimisticMessageIdsBySession.get(txKey)?.has(trackedMessageId)
          ? trackedMessageId
          : undefined;

      this.activeStreamingMessageBySession.delete(txKey);
      this.optimisticTurnIdBySession.delete(txKey);

      const postSyncRecovery = this.turnCoordinator.getSessionView({
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
      });
      const shouldPassTurnId =
        Boolean(explicitTurnId) &&
        (!postSyncRecovery?.activeTurnId || postSyncRecovery.activeTurnId === explicitTurnId);
      const canPassExecGen =
        execGen !== undefined && execGen >= (postSyncRecovery?.executionGeneration ?? 0);
      const recovery = this.turnCoordinator.noteTurnTerminal({
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        ...(shouldPassTurnId ? { turnId: explicitTurnId } : {}),
        ...(canPassExecGen ? { executionGeneration: execGen } : {}),
        outcome: terminalOutcome,
      });
      if (admId) {
        this.turnCoordinator.applyAdmissionEvent({
          connectionId,
          profileId: resolvedProfileId,
          sessionId,
          admissionId: admId,
          state: terminalOutcome,
          ...(turnId ? { turnId } : {}),
          executionGeneration: recovery.executionGeneration,
        });
      }

      if (finalText && messageId) {
        const existingTx = this.transcripts.get(txKey);
        const existingMsg = existingTx?.messages.find((m) => m.messageId === messageId);
        const supersededMsg = supersededPlaceholderId
          ? existingTx?.messages.find((m) => m.messageId === supersededPlaceholderId)
          : undefined;
        const carryText = supersededMsg && supersededMsg.text.length > finalText.length ? supersededMsg.text : finalText;
        const resolvedText =
          existingMsg && existingMsg.text.length > carryText.length ? existingMsg.text : carryText;
        const needsUpsert =
          !isActive || !existingMsg || existingMsg.text !== resolvedText || Boolean(existingMsg.streaming);
        if (needsUpsert) {
          this.recordTranscriptPatchOrBuffer({
            entry,
            connectionId,
            profileId: resolvedProfileId,
            sessionId,
            jKey,
            kind: "assistant_message",
            countsAsUnread: false,
            isFocused,
            isActive,
            patch: {
              type: "message_upsert",
              sessionId,
              message: {
                messageId,
                sessionId,
                role: "assistant",
                text: resolvedText,
                createdAt: existingMsg?.createdAt ?? supersededMsg?.createdAt ?? normalizeTimestampIso(params),
                ...(existingMsg?.turnId ?? supersededMsg?.turnId ?? turnId
                  ? { turnId: existingMsg?.turnId ?? supersededMsg?.turnId ?? turnId }
                  : {}),
                ...(existingMsg?.toolRows ?? supersededMsg?.toolRows
                  ? { toolRows: existingMsg?.toolRows ?? supersededMsg?.toolRows }
                  : {}),
                streaming: false,
                status,
              },
            },
          });
        }
      }

      if (supersededPlaceholderId) {
        this.recordTranscriptPatchOrBuffer({
          entry,
          connectionId,
          profileId: resolvedProfileId,
          sessionId,
          jKey,
          kind: "other",
          countsAsUnread: false,
          isFocused,
          isActive,
          patch: {
            type: "turn_state",
            sessionId,
            activeTurnId: null,
            turnStopping: false,
            executionGeneration: recovery.executionGeneration,
            stopState: recovery.stopState,
            messageId: supersededPlaceholderId,
            status,
          },
        });
      }

      const patch: TranscriptPatchPayload = {
        type: "turn_state",
        sessionId,
        activeTurnId: null,
        turnStopping: false,
        executionGeneration: recovery.executionGeneration,
        stopState: recovery.stopState,
        messageId,
        status,
      };
      this.backgroundJournal.setPinnedFlags(jKey, { runningTurn: false });

      this.recordTranscriptPatchOrBuffer({
        entry,
        connectionId,
        profileId: resolvedProfileId,
        sessionId,
        jKey,
        kind: "turn_boundary",
        countsAsUnread: true,
        seqRaw,
        isFocused,
        isActive,
        patch,
      });
      if (isActive) {
        const kind: PromptEventPayload["kind"] =
          terminalOutcome === "stopped" || terminalOutcome === "interrupted"
            ? "stopped"
            : terminalOutcome === "error"
              ? "error"
              : "completed";
        this.emitTopic(
          "prompt",
          { connectionId, profileId: resolvedProfileId, sessionId },
          "patch",
          {
            connectionId,
            profileId: resolvedProfileId,
            sessionId,
            turnId,
            kind,
            messageId,
          } satisfies PromptEventPayload,
          scopeMatchesSession,
        );
      }

      this.updateSessionSummary(connectionId, resolvedProfileId, sessionId, (prev) => ({
        ...prev,
        activeTurnId: null,
        status: terminalOutcome === "error" ? "error" : "idle",
        ...(finalText ? { preview: finalText.slice(0, 140) } : {}),
        updatedAt: new Date().toISOString(),
      }));

      if (terminalOutcome === "completed") {
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
    const targetConnectionId = connectionId ?? this.resolveTargetConnectionId(payload, scope);
    let rawProfile = "default";
    if (typeof payload.profileId === "string" && payload.profileId.trim()) {
      rawProfile = payload.profileId.trim();
    } else if (scope?.profileId && scope.profileId.trim()) {
      rawProfile = scope.profileId.trim();
    } else if (
      this.activeScope?.profileId &&
      this.activeScope.profileId.trim() &&
      (!connectionId || this.activeScope.connectionId === connectionId)
    ) {
      rawProfile = this.activeScope.profileId.trim();
    } else if (targetConnectionId !== "local") {
      const sshInfo = this.getSshTargetForConnection(targetConnectionId);
      if (sshInfo?.defaultProfile) rawProfile = sshInfo.defaultProfile;
    }
    return this.resolveLocalProfileId(targetConnectionId, rawProfile);
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
      throw makeBridgeError("unreachable", getCopy("connection.gatewayNotReadyError"));
    }
    return entry;
  }

  private assertNotShuttingDown(): void {
    if (this.disposed || this.shuttingDown) {
      throw makeBridgeError("cancelled", getCopy("connection.shuttingDownError"));
    }
  }

  private gatewayProfileParams(
    entry: GatewayTransportEntry,
    profileId: string,
  ): { profile?: string; profile_id?: string } {
    if (entry.transportMode === "per-profile") {
      // Local per-Profile sockets are already bound to their Profile. Remote and legacy SSH
      // transports predate the host-scoped `profile` handle and keep their explicit `profile_id`
      // routing key; the profile-scoped SSH ticket is proven separately by its `--profile` attach.
      if (entry.kind === "local") {
        return {};
      }
      return profileId ? { profile_id: profileId } : {};
    }
    if (profileId && profileId !== entry.defaultProfileId) {
      const handle = this.profilesByConnection
        .get(entry.connectionId)
        ?.find((profile) => profile.profileId === profileId)
        ?.handle.trim();
      return { profile: handle || profileId };
    }
    return {};
  }

  private usesCanonicalSessionControlWire(entry: GatewayTransportEntry): boolean {
    if (entry.kind === "remote") {
      return false;
    }
    if (entry.kind === "ssh" && entry.transportMode === "per-profile") {
      return false;
    }
    const rawCapabilities = entry.describeResult?.capabilities;
    if (!Array.isArray(rawCapabilities)) {
      return false;
    }
    const has = (tag: string) => rawCapabilities.includes(tag);
    return (
      has("local-cli-create-v1") &&
      has("durable-admission-v1") &&
      has("session-transcript-v1") &&
      has("session-list-picker-v1") &&
      has("session-list-cursor-v1")
    );
  }

  private async callPromptSubmit(
    entry: GatewayTransportEntry,
    profileId: string,
    params: Record<string, unknown>,
  ): Promise<{
    res: Record<string, unknown>;
    classification: PromptSubmitReceiptClass;
  }> {
    const res = await entry.client.call<Record<string, unknown>>("prompt.submit", {
      ...this.gatewayProfileParams(entry, profileId),
      ...params,
    });
    return { res, classification: classifyPromptSubmitReceipt(res) };
  }

  private normalizeQueuedPromptSubmit(
    submitted: Awaited<ReturnType<ConnectionSupervisor["callPromptSubmit"]>>,
  ): Record<string, unknown> {
    if (submitted.classification.kind === "delivery_unknown") {
      return {
        ...submitted.res,
        accepted: false,
        delivery_unknown: true,
        receipt: "delivery_unknown",
      };
    }
    if (submitted.classification.kind === "unconfirmed") {
      return {
        ...submitted.res,
        accepted: false,
        admitted: false,
        status: submitted.classification.receipt,
      };
    }
    return submitted.res;
  }

  private translateRpcFailure(
    entry: GatewayTransportEntry,
    err: unknown,
    singleAction?: keyof SupportedChatActions,
    rpcMethod?: string,
    profileId?: string,
  ): never {
    if (!(err instanceof GatewayRpcError) && !(err instanceof GatewayTransportError)) {
      const existingCode = (err as { code?: unknown } | null)?.code;
      if (
        typeof existingCode === "string" &&
        (ERROR_CODES as readonly string[]).includes(existingCode)
      ) {
        throw err;
      }
    }
    if (isProfileUnavailableRpcError(err)) {
      const targetPid = profileId ?? entry.defaultProfileId;
      this.markProfileUnavailable(entry.connectionId, targetPid, err);
      throw makeBridgeError(
        "not_found",
        getLocalFailureCopy("profile_unavailable").whatHappened,
      );
    }
    if (isInvalidParamsRpcError(err)) {
      throw makeBridgeError("invalid_request", getCopy("connection.invalidRequestError"));
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
      throw makeBridgeError(
        "capability_unavailable",
        getCopy("connection.capabilityUnavailableError"),
      );
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
      throw makeBridgeError(err.code, getCopy("connection.disconnectedOrTimeoutError"));
    }
    if (err instanceof GatewayRpcError) {
      throw makeBridgeError("internal", getCopy("connection.requestExecutionFailedError"));
    }
    throw makeBridgeError("internal", getCopy("connection.requestFailedError"));
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
      const pid = this.resolveLocalProfileId(
        cid,
        scope?.profileId ?? this.activeScope?.profileId,
        "default",
      );
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
        const jKey = sid ? makeSessionJournalKey(cid, pid, sid) : "";
        const journal = jKey ? this.backgroundJournal.getState(jKey) : undefined;
        if (sid && (this.pendingResyncKeys.has(jKey) || journal?.resyncRequired)) {
          listener({
            topic,
            scope: { connectionId: cid, profileId: pid, sessionId: sid },
            kind: "resync_required",
            seq: 0,
            revision: rev,
            payload: { reason: journal?.resyncReason ?? "resync_required" },
          });
          return;
        }
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
      } else if (topic === "approval") {
        this.approvalCoordinator.onExpiryTick(this.now());
        listener({
          topic,
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.approvalCoordinator.snapshot(),
        });
      } else if (topic === "turn.recovery") {
        listener({
          topic,
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: rev,
          payload: this.turnCoordinator.snapshot(),
        });
      }
    });

    return () => {
      this.subscribers.delete(id);
    };
  }

  readonly handlers: Record<
    | "capabilities.describe"
    | "cron.status"
    | "cron.submit"
    | "cron.cancel"
    | "cron.recover"
    | "fleet.refresh"
    | "connections.retry"
    | "profiles.list"
    | "scopes.switch"
    | "sessions.list"
    | "sessions.create"
    | "sessions.select"
    | "sessions.resume"
    | "sessions.markRead"
    | "app.setFocused"
    | "prompts.send"
    | "prompts.stop"
    | "prompts.steer"
    | "prompts.resolveUnknown"
    | "prompts.queue"
    | "prompts.checkQueueReceipt"
    | "prompts.retryQueue"
    | "prompts.cancelQueued"
    | "prompts.dismissSteerFallback"
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
    | "config.update"
    | "approvals.list"
    | "approvals.respond"
    | "approvals.dismissOrphaned",
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

    "cron.status": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.requireTransport(connectionId, profileId);
      await this.probeCronDomain(entry, profileId);
      this.emitCapabilities();
      return this.capabilityRegistry.getSnapshot().cron;
    },

    "cron.submit": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.requireTransport(connectionId, profileId);
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const schedule = typeof payload.schedule === "string" ? payload.schedule.trim() : "";
      const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!name || !schedule || !prompt) {
        throw makeBridgeError("invalid_request", getCopy("cron.submitFieldsRequiredError"));
      }
      await this.probeCronDomain(entry, profileId);
      if (!this.capabilityRegistry.getSnapshot().cron.supportedActions.canSubmit) {
        throw makeBridgeError("capability_unavailable", getCopy("cron.submitUnsupportedError"));
      }
      try {
        const res = await entry.client.call<Record<string, unknown>>(
          "cron.submit",
          { profile_id: profileId, name, schedule, prompt },
        );
        await this.probeCronDomain(entry, profileId);
        this.emitCapabilities();
        return {
          ok: true,
          ...(typeof (res.job_id ?? res.jobId) === "string"
            ? { jobId: String(res.job_id ?? res.jobId) }
            : {}),
          cron: this.capabilityRegistry.getSnapshot().cron,
        };
      } catch (err) {
        await this.probeCronDomain(entry, profileId);
        this.translateRpcFailure(entry, err, undefined, "cron.submit", profileId);
      }
    },

    "cron.cancel": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.requireTransport(connectionId, profileId);
      const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
      if (!jobId) {
        throw makeBridgeError("invalid_request", getCopy("cron.jobIdRequiredError"));
      }
      await this.probeCronDomain(entry, profileId);
      if (!this.capabilityRegistry.getSnapshot().cron.supportedActions.canCancel) {
        throw makeBridgeError("capability_unavailable", getCopy("cron.cancelUnsupportedError"));
      }
      try {
        await entry.client.call(
          "cron.cancel",
          { profile_id: profileId, job_id: jobId },
        );
        await this.probeCronDomain(entry, profileId);
        this.emitCapabilities();
        return { ok: true, jobId, cron: this.capabilityRegistry.getSnapshot().cron };
      } catch (err) {
        await this.probeCronDomain(entry, profileId);
        this.translateRpcFailure(entry, err, undefined, "cron.cancel", profileId);
      }
    },

    "cron.recover": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const entry = this.requireTransport(connectionId, profileId);
      const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
      if (!jobId) {
        throw makeBridgeError("invalid_request", getCopy("cron.jobIdRequiredError"));
      }
      await this.probeCronDomain(entry, profileId);
      if (!this.capabilityRegistry.getSnapshot().cron.supportedActions.canRecover) {
        throw makeBridgeError("capability_unavailable", getCopy("cron.recoverUnsupportedError"));
      }
      try {
        await entry.client.call(
          "cron.recover",
          { profile_id: profileId, job_id: jobId },
        );
        await this.probeCronDomain(entry, profileId);
        this.emitCapabilities();
        return { ok: true, jobId, cron: this.capabilityRegistry.getSnapshot().cron };
      } catch (err) {
        await this.probeCronDomain(entry, profileId);
        this.translateRpcFailure(entry, err, undefined, "cron.recover", profileId);
      }
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
          ? this.resolveLocalProfileId("local", "default")
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
      let resyncRequired = false;
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
          const synced = await this.syncActiveSessionOnSwitch(entry, connectionId, profileId, resolvedSessionId);
          transcript = synced.transcript;
          resyncRequired = synced.resyncRequired;
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
      this.approvalCoordinator.setActiveScope(this.activeScope);
      this.emitFleet(connectionId);
      return {
        ok: connectRes.ok && link.actual !== "blocked",
        fleet: this.getFleetSnapshot(),
        transcript,
        ...(resyncRequired ? { resyncRequired: true } : {}),
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
      this.approvalCoordinator.setActiveScope(this.activeScope);
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.recordActiveChat({
          connectionId,
          profileId,
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        });
        this.syncChatStateWithSnapshot();
      }

      let transcript: SessionTranscriptSnapshot | null = null;
      let resyncRequired = false;
      if (resolvedSessionId) {
        const synced = await this.syncActiveSessionOnSwitch(entry, connectionId, profileId, resolvedSessionId);
        transcript = synced.transcript;
        resyncRequired = synced.resyncRequired;
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
        ...(resyncRequired ? { resyncRequired: true } : {}),
      };
    },

    "sessions.markRead": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      if (!sessionId) {
        throw makeBridgeError("invalid_request", getCopy("session.targetRequiredError"));
      }
      const jKey = makeSessionJournalKey(connectionId, profileId, sessionId);
      this.backgroundJournal.markRead(jKey);
      this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
        ...prev,
        unreadCount: 0,
      }));
      return {
        ok: true,
        connectionId,
        profileId,
        sessionId,
        unreadCount: 0,
      };
    },

    "app.setFocused": async (payload) => {
      this.assertNotShuttingDown();
      const focused = Boolean(payload.focused);
      this.setWindowFocused(focused);
      return { ok: true, focused };
    },

    "sessions.create": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      await this.ensureTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.sessionCreate) {
        throw makeBridgeError("capability_unavailable", getCopy("session.createUnsupportedError"));
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
          ...this.gatewayProfileParams(entry, profileId),
          title,
        });
      } catch (err) {
        this.translateRpcFailure(entry, err, "sessionCreate", "session.create", profileId);
      }

      const rawSession =
        res.session && typeof res.session === "object"
          ? (res.session as Record<string, unknown>)
          : res;
      const mappedCreated = mapRawSession(rawSession, connectionId, profileId);
      const created: SessionSummary = mappedCreated
        ? {
            ...mappedCreated,
            profileId: this.resolveLocalProfileId(connectionId, mappedCreated.profileId, profileId),
          }
        : {
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
      this.approvalCoordinator.setActiveScope(this.activeScope);
      this.extractAndStoreSessionCwd(connectionId, profileId, created.sessionId, rawSession);
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
              this.matchesProfileScope(connectionId, sub.scope.profileId, profileId) &&
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
        throw makeBridgeError("invalid_request", getCopy("session.targetRequiredError"));
      }
      const resync = Boolean(payload.resync || payload.replace);
      await this.ensureTransport(connectionId, profileId);
      const entry = this.requireTransport(connectionId, profileId);
      const transcript = await this.loadTranscriptSnapshot(entry, profileId, sessionId, {
        replace: resync,
        resynced: resync,
      });
      const jKey = makeSessionJournalKey(connectionId, profileId, sessionId);
      this.pendingResyncKeys.delete(jKey);
      this.backgroundJournal.clearResyncAndBuffer(jKey);
      return { transcript };
    },

    "prompts.send": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", getCopy("chat.messageRequiredError"));
      }

      const existingRecovery = this.turnCoordinator.getSessionView({
        connectionId,
        profileId,
        sessionId,
      });
      if (existingRecovery?.queuePaused || existingRecovery?.unknownTurn) {
        throw makeBridgeError("conflict", getCopy("turn.queue.pausedNotice"));
      }

      if (payload.queued === true) {
        return this.submitQueuedPromptOverGateway({
          connectionId,
          profileId,
          sessionId,
          text,
          submissionId:
            typeof payload.submissionId === "string" ? payload.submissionId.trim() : undefined,
        });
      }

      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptSubmit) {
        throw makeBridgeError("capability_unavailable", getCopy("chat.promptSubmitUnsupportedError"));
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

      let submitted: Awaited<ReturnType<ConnectionSupervisor["callPromptSubmit"]>>;
      try {
        const submissionId =
          typeof payload.submissionId === "string" && payload.submissionId.trim()
            ? payload.submissionId.trim()
            : typeof payload.draftId === "string" && payload.draftId.trim()
              ? payload.draftId.trim()
              : crypto.randomUUID();
        submitted = await this.callPromptSubmit(entry, profileId, {
          session_id: sessionId,
          text,
          submission_id: submissionId,
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

      const { res, classification } = submitted;
      if (classification.kind === "delivery_unknown") {
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

      if (classification.kind === "unconfirmed") {
        if (this.chatSessionStateStore) {
          this.chatSessionStateStore.markDraftDeliveryStatus(draftRef, "idle");
          this.emitChatState();
        }
        return {
          accepted: false,
          receipt: classification.receipt,
          sessionId,
        };
      }

      const receipt = classification.receipt;
      if (this.chatSessionStateStore) {
        this.chatSessionStateStore.clearDraftOnReceipt(draftRef, receipt);
        this.emitChatState();
      }

      const turnId = asString(res.turn_id ?? res.turnId) || this.nextSyntheticId("turn");
      const gwExecGen =
        typeof (res.execution_generation ?? res.executionGeneration) === "number"
          ? Number(res.execution_generation ?? res.executionGeneration)
          : undefined;
      const recovery = this.turnCoordinator.noteTurnStarted({
        connectionId,
        profileId,
        sessionId,
        turnId,
        ...(gwExecGen !== undefined ? { executionGeneration: gwExecGen } : {}),
        ownerGeneration: entry.ownerGeneration,
      });
      const rawUserMsgId = asString(res.user_message_id ?? res.userMessageId).trim();
      const rawAssistantMsgId = asString(res.assistant_message_id ?? res.assistantMessageId).trim();
      const userMsgId = rawUserMsgId || this.nextSyntheticId("user");
      const assistantMsgId = rawAssistantMsgId || this.nextSyntheticId("assistant");
      const txKey = transcriptKey(connectionId, profileId, sessionId);
      if (!asString(res.turn_id ?? res.turnId).trim()) {
        this.optimisticTurnIdBySession.set(txKey, turnId);
      } else {
        this.optimisticTurnIdBySession.delete(txKey);
      }
      if (!rawUserMsgId) {
        this.trackOptimisticMessageId(txKey, userMsgId);
      }
      if (!rawAssistantMsgId) {
        this.trackOptimisticMessageId(txKey, assistantMsgId);
      }
      this.activeStreamingMessageBySession.set(txKey, assistantMsgId);
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
        executionGeneration: recovery.executionGeneration,
        stopState: "idle",
        messageId: assistantMsgId,
        status: "streaming",
      });
      this.backgroundJournal.setPinnedFlags(
        makeSessionJournalKey(connectionId, profileId, sessionId),
        { runningTurn: true },
      );
      this.updateSessionSummary(connectionId, profileId, sessionId, (prev) => ({
        ...prev,
        activeTurnId: turnId,
        status: "running",
        updatedAt: nowIso,
      }));
      this.syncProfileAndConnectionProjections(connectionId);

      this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
        connectionId,
        profileId,
        sessionId,
        turnId,
        executionGeneration: recovery.executionGeneration,
        kind: "accepted",
        messageId: assistantMsgId,
      } satisfies PromptEventPayload);

      return {
        accepted: true,
        receipt,
        sessionId,
        turnId,
        executionGeneration: recovery.executionGeneration,
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
      const currentRecovery = sessionId
        ? this.turnCoordinator.getSessionView({ connectionId, profileId, sessionId })
        : null;
      const turnId =
        typeof payload.turnId === "string" && payload.turnId.trim()
          ? payload.turnId.trim()
          : existing?.activeTurnId ?? currentRecovery?.activeTurnId ?? "";
      const executionGeneration =
        typeof payload.executionGeneration === "number"
          ? payload.executionGeneration
          : existing?.executionGeneration ?? currentRecovery?.executionGeneration;

      if (!sessionId || !turnId) {
        throw makeBridgeError("unknown_turn", getCopy("turn.stop.noActiveTurnBridgeError"));
      }

      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptCancel) {
        throw makeBridgeError("capability_unavailable", getCopy("turn.stop.unsupportedError"));
      }

      this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
        type: "turn_state",
        sessionId,
        activeTurnId: turnId,
        turnStopping: true,
        ...(executionGeneration !== undefined ? { executionGeneration } : {}),
        stopState: "stopping",
      });

      const servedMethods = Array.isArray(entry.describeResult?.served_methods)
        ? (entry.describeResult?.served_methods as unknown[])
        : [];
      const canonicalWire = this.usesCanonicalSessionControlWire(entry);
      let usedRpcMethod = canonicalWire || servedMethods.includes("session.interrupt")
        ? "session.interrupt"
        : "prompt.cancel";

      try {
        const result = await this.turnCoordinator.requestStop(
          {
            connectionId,
            profileId,
            sessionId,
            turnId,
            executionGeneration,
          },
          async ({ turnId: tId, executionGeneration: execGen }) => {
            const rpcPayload = canonicalWire
              ? {
                  ...this.gatewayProfileParams(entry, profileId),
                  session_id: sessionId,
                  execution_generation: execGen,
                }
              : {
                  ...this.gatewayProfileParams(entry, profileId),
                  session_id: sessionId,
                  turn_id: tId,
                  ...(execGen > 0 ? { execution_generation: execGen } : {}),
                };
            if (usedRpcMethod === "session.interrupt") {
              try {
                const receipt = await entry.client.call<Record<string, unknown>>(
                  "session.interrupt",
                  rpcPayload,
                );
                return canonicalWire ? normalizeCanonicalInterruptReceipt(receipt) : receipt;
              } catch (err) {
                if (!canonicalWire && isJsonRpcMethodNotFound(err)) {
                  usedRpcMethod = "prompt.cancel";
                  return entry.client.call<Record<string, unknown>>("prompt.cancel", rpcPayload);
                }
                throw err;
              }
            }
            return entry.client.call<Record<string, unknown>>("prompt.cancel", rpcPayload);
          },
        );

        if (result.status === "stopped") {
          this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
            type: "turn_state",
            sessionId,
            activeTurnId: null,
            turnStopping: false,
            executionGeneration: result.executionGeneration,
            stopState: "stopped",
            status: "stopped",
          });
          this.syncProfileAndConnectionProjections(connectionId);
          this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
            connectionId,
            profileId,
            sessionId,
            turnId,
            executionGeneration: result.executionGeneration,
            kind: "stopped",
          } satisfies PromptEventPayload);
          return {
            stopped: true,
            status: "stopped",
            sessionId,
            turnId,
            executionGeneration: result.executionGeneration,
          };
        }

        if (result.status === "cancel_outcome_unknown") {
          this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
            type: "turn_state",
            sessionId,
            activeTurnId: turnId,
            turnStopping: false,
            executionGeneration: result.executionGeneration,
            stopState: "cancel_outcome_unknown",
          });
          this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
            connectionId,
            profileId,
            sessionId,
            turnId,
            executionGeneration: result.executionGeneration,
            kind: "cancel_outcome_unknown",
          } satisfies PromptEventPayload);
          return {
            stopped: false,
            status: "cancel_outcome_unknown",
            sessionId,
            turnId,
            executionGeneration: result.executionGeneration,
          };
        }

        this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: true,
          executionGeneration: result.executionGeneration,
          stopState: "stopping",
        });
        this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
          connectionId,
          profileId,
          sessionId,
          turnId,
          executionGeneration: result.executionGeneration,
          kind: "stopping",
        } satisfies PromptEventPayload);
        return {
          stopped: false,
          status: "stopping",
          sessionId,
          turnId,
          executionGeneration: result.executionGeneration,
        };
      } catch (err) {
        const viewAfter = this.turnCoordinator.getSessionView({
          connectionId,
          profileId,
          sessionId,
        });
        if (viewAfter?.stopState === "cancel_outcome_unknown") {
          this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
            type: "turn_state",
            sessionId,
            activeTurnId: turnId,
            turnStopping: false,
            executionGeneration: viewAfter.executionGeneration,
            stopState: "cancel_outcome_unknown",
          });
          this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
            connectionId,
            profileId,
            sessionId,
            turnId,
            executionGeneration: viewAfter.executionGeneration,
            kind: "cancel_outcome_unknown",
          } satisfies PromptEventPayload);
          return {
            stopped: false,
            status: "cancel_outcome_unknown",
            sessionId,
            turnId,
            executionGeneration: viewAfter.executionGeneration,
          };
        }

        this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: turnId,
          turnStopping: false,
          stopState: "idle",
        });
        this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
          connectionId,
          profileId,
          sessionId,
          turnId,
          kind: "stop_failed",
        } satisfies PromptEventPayload);
        this.translateRpcFailure(entry, err, "promptCancel", usedRpcMethod, profileId);
      }
    },

    "prompts.resolveUnknown": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      if (!sessionId) {
        throw makeBridgeError("invalid_request", getCopy("session.targetRequiredError"));
      }
      const entry = this.requireTransport(connectionId, profileId);
      const admissionId =
        typeof payload.admissionId === "string" && payload.admissionId.trim()
          ? payload.admissionId.trim()
          : undefined;
      const executionGeneration =
        typeof payload.executionGeneration === "number" ? payload.executionGeneration : undefined;
      const canonicalWire = this.usesCanonicalSessionControlWire(entry);

      try {
        const result = await this.turnCoordinator.resolveUnknown(
          {
            connectionId,
            profileId,
            sessionId,
            admissionId,
            executionGeneration,
          },
          async ({ admission_id, execution_generation }) => {
            const receipt = await entry.client.call<Record<string, unknown>>(
              "prompt.resolve_unknown",
              {
                ...(canonicalWire ? {} : this.gatewayProfileParams(entry, profileId)),
                session_id: sessionId,
                admission_id,
                execution_generation,
              },
            );
            return canonicalWire
              ? normalizeCanonicalResolveUnknownReceipt(receipt)
              : receipt;
          },
        );
        this.applyPatchToTranscript(entry, connectionId, profileId, sessionId, {
          type: "turn_state",
          sessionId,
          activeTurnId: null,
          turnStopping: false,
          stopState: "stopped",
        });
        this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
          connectionId,
          profileId,
          sessionId,
          turnId: "",
          executionGeneration: result.executionGeneration,
          kind: "unknown_resolved",
        } satisfies PromptEventPayload);
        return result;
      } catch (err) {
        if (err instanceof GatewayRpcError || err instanceof GatewayTransportError) {
          this.translateRpcFailure(entry, err, undefined, "prompt.resolve_unknown", profileId);
        }
        throw err;
      }
    },

    "prompts.queue": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", getCopy("turn.queue.textRequiredError"));
      }
      const existing = this.turnCoordinator.getSessionView({ connectionId, profileId, sessionId });
      if (existing?.queuePaused || existing?.unknownTurn) {
        throw makeBridgeError("conflict", getCopy("turn.queue.pausedNotice"));
      }
      return this.submitQueuedPromptOverGateway({
        connectionId,
        profileId,
        sessionId,
        text,
        submissionId:
          typeof payload.submissionId === "string" ? payload.submissionId.trim() : undefined,
      });
    },

    "prompts.checkQueueReceipt": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const submissionId =
        typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
      if (!sessionId || !submissionId) {
        throw makeBridgeError(
          "invalid_request",
          getCopy("turn.queue.submissionIdRequiredError"),
        );
      }
      const entry = this.requireTransport(connectionId, profileId);
      return this.turnCoordinator.checkQueueReceipt(
        { connectionId, profileId, sessionId, submissionId },
        async (subId) => {
          if (this.usesCanonicalSessionControlWire(entry)) {
            // PromptReceiptParams is extra=forbid and has no submission_id/profile. Resolve the
            // admission from the canonical resume snapshot's pending[].input_id first, then ask
            // for the exact admission receipt.
            const resumeRes = await entry.client.call<Record<string, unknown>>("session.resume", {
              ...this.gatewayProfileParams(entry, profileId),
              session_id: sessionId,
            });
            const pending = projectCanonicalPending(resumeRes);
            if (!pending.present) {
              return { found: false, absenceConfirmed: false };
            }
            const match = pending.admissions.find((item) => item.inputId === subId);
            if (!match) {
              // Terminal admissions are not listed in canonical pending. Absence there cannot
              // prove the submission never entered the FIFO.
              return { found: false, absenceConfirmed: false };
            }
            const receiptRes = await entry.client.call<Record<string, unknown>>("prompt.receipt", {
              session_id: sessionId,
              admission_id: match.admissionId,
            });
            const admission = canonicalReceiptToQueueItem(receiptRes, match, subId);
            return admission
              ? { found: true, admission }
              : { found: false, absenceConfirmed: false };
          }

          try {
            const receiptRes = await entry.client.call<Record<string, unknown>>("prompt.receipt", {
              ...this.gatewayProfileParams(entry, profileId),
              session_id: sessionId,
              submission_id: subId,
            });
            const rawList = Array.isArray(
              receiptRes.queued_admissions ?? receiptRes.queuedAdmissions ?? receiptRes.queue,
            )
              ? ((receiptRes.queued_admissions ??
                  receiptRes.queuedAdmissions ??
                  receiptRes.queue) as RawGatewayQueueItem[])
              : undefined;
            const admission =
              receiptRes.admission && typeof receiptRes.admission === "object"
                ? (receiptRes.admission as RawGatewayQueueItem)
                : typeof (receiptRes.admission_id ?? receiptRes.admissionId) === "string"
                  ? (receiptRes as RawGatewayQueueItem)
                  : undefined;
            return {
              found: Boolean(receiptRes.found ?? admission),
              ...(admission ? { admission } : {}),
              ...(rawList ? { queuedAdmissions: rawList } : {}),
            };
          } catch (err) {
            if (!isJsonRpcMethodNotFound(err)) {
              this.translateRpcFailure(entry, err, undefined, "prompt.receipt", profileId);
            }
            const listRes = await entry.client.call<Record<string, unknown>>("session.resume", {
              ...this.gatewayProfileParams(entry, profileId),
              session_id: sessionId,
            });
            const rawList = Array.isArray(
              listRes.queued_admissions ?? listRes.queuedAdmissions ?? listRes.queue,
            )
              ? ((listRes.queued_admissions ??
                  listRes.queuedAdmissions ??
                  listRes.queue) as RawGatewayQueueItem[])
              : [];
            const match = rawList.find(
              (item) => (item.submission_id ?? item.submissionId) === subId,
            );
            return {
              found: Boolean(match),
              ...(match ? { admission: match } : {}),
              queuedAdmissions: rawList,
            };
          }
        },
      );
    },

    "prompts.retryQueue": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const submissionId =
        typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
      if (!sessionId || !submissionId) {
        throw makeBridgeError(
          "invalid_request",
          getCopy("turn.queue.submissionIdRequiredError"),
        );
      }
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptSubmit) {
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("turn.queue.promptSubmitUnavailableError"),
        );
      }
      try {
        const res = await this.turnCoordinator.retryQueued(
          { connectionId, profileId, sessionId, submissionId, online: true },
          async (rpcPayload) =>
            this.normalizeQueuedPromptSubmit(
              await this.callPromptSubmit(entry, profileId, {
                session_id: sessionId,
                ...rpcPayload,
              }),
            ),
        );
        if (res.status === "admitted" && res.admission) {
          this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
            connectionId,
            profileId,
            sessionId,
            turnId: "",
            kind: "queued",
          } satisfies PromptEventPayload);
        }
        return res;
      } catch (err) {
        if (err instanceof GatewayRpcError) {
          this.translateRpcFailure(entry, err, "promptSubmit", "prompt.submit", profileId);
        }
        throw err;
      }
    },

    "prompts.cancelQueued": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const admissionId =
        typeof payload.admissionId === "string" ? payload.admissionId.trim() : "";
      if (!sessionId || !admissionId) {
        throw makeBridgeError("invalid_request", getCopy("turn.queue.admissionIdRequiredError"));
      }
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptCancel) {
        throw makeBridgeError("capability_unavailable", getCopy("turn.queue.cancelUnsupportedError"));
      }
      try {
        const res = await this.turnCoordinator.cancelQueued(
          { connectionId, profileId, sessionId, admissionId },
          async ({ admission_id }) => {
            const canonicalWire = this.usesCanonicalSessionControlWire(entry);
            const receipt = await entry.client.call<Record<string, unknown>>("prompt.cancel", {
              // Canonical `prompt.cancel` routes by admission_id alone; its params are extra=forbid.
              ...(canonicalWire ? {} : this.gatewayProfileParams(entry, profileId)),
              session_id: sessionId,
              admission_id,
            });
            return canonicalWire
              ? normalizeCanonicalQueuedCancelReceipt(receipt)
              : receipt;
          },
        );
        this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
          connectionId,
          profileId,
          sessionId,
          turnId: res.admission.turnId ?? "",
          kind: "queue_cancelled",
        } satisfies PromptEventPayload);
        return res;
      } catch (err) {
        if (err instanceof GatewayRpcError) {
          this.translateRpcFailure(entry, err, "promptCancel", "prompt.cancel", profileId);
        }
        throw err;
      }
    },

    "prompts.steer": async (payload, scope): Promise<PromptSteerResult> => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      const turnId = typeof payload.turnId === "string" ? payload.turnId.trim() : "";
      const executionGeneration =
        typeof payload.executionGeneration === "number" ? payload.executionGeneration : undefined;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!sessionId || !text) {
        throw makeBridgeError("invalid_request", getCopy("turn.steer.textRequiredError"));
      }
      const entry = this.requireTransport(connectionId, profileId);
      if (!entry.supportedActions.promptSteer) {
        throw makeBridgeError("capability_unavailable", getCopy("turn.steer.unsupportedError"));
      }
      const canonicalWire = this.usesCanonicalSessionControlWire(entry);

      const hasTurnHistory = this.turnCoordinator.hasTurnHistory({
        connectionId,
        profileId,
        sessionId,
      });
      if (hasTurnHistory || executionGeneration !== undefined) {
        const precheck = this.turnCoordinator.evaluateSteerPrecheck({
          connectionId,
          profileId,
          sessionId,
          ...(turnId ? { turnId } : {}),
          ...(executionGeneration !== undefined ? { executionGeneration } : {}),
          text,
          requireRunning: true,
        });
        if (!precheck.allowed) {
          return this.turnCoordinator.recordSteerFailure({
            connectionId,
            profileId,
            sessionId,
            ...(turnId ? { turnId } : {}),
            ...(executionGeneration !== undefined ? { executionGeneration } : {}),
            text,
            reason: precheck.reason,
            message: precheck.message,
          });
        }
      }

      const currentView = this.turnCoordinator.getSessionView({
        connectionId,
        profileId,
        sessionId,
      });
      const effectiveTurnId = turnId || currentView?.activeTurnId || "";
      const effectiveGen =
        executionGeneration ??
        (currentView && currentView.executionGeneration > 0
          ? currentView.executionGeneration
          : undefined);
      if (canonicalWire && (effectiveGen === undefined || effectiveGen <= 0)) {
        return this.turnCoordinator.recordSteerFailure({
          connectionId,
          profileId,
          sessionId,
          ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
          text,
          reason: "not_running",
          message: getCopy("turn.steer.reason.not_running"),
        });
      }

      try {
        const rpcPayload = canonicalWire
          ? {
              ...this.gatewayProfileParams(entry, profileId),
              session_id: sessionId,
              execution_generation: effectiveGen,
              text,
            }
          : {
              profile_id: profileId,
              session_id: sessionId,
              ...(effectiveTurnId ? { turn_id: effectiveTurnId } : {}),
              ...(effectiveGen !== undefined ? { execution_generation: effectiveGen } : {}),
              text,
            };
        const res = await entry.client.call<Record<string, unknown>>("session.steer", rpcPayload);
        const canonicalAccepted =
          canonicalWire &&
          (asString(res.status).toLowerCase() === "queued" ||
            asString(res.status).toLowerCase() === "redirected");
        const canonicalRejected = canonicalWire && !canonicalAccepted;
        if (canonicalRejected || res?.steered === false) {
          const reasonRaw = canonicalRejected ? "rejected" : asString(res.reason, "rejected");
          const reason =
            reasonRaw === "turn_finished" ||
            reasonRaw === "generation_mismatch" ||
            reasonRaw === "not_running" ||
            reasonRaw === "rejected" ||
            reasonRaw === "unreachable" ||
            reasonRaw === "timeout"
              ? reasonRaw
              : "rejected";
          this.emitTopic("prompt", { connectionId, profileId, sessionId }, "patch", {
            connectionId,
            profileId,
            sessionId,
            turnId: effectiveTurnId,
            ...(effectiveGen !== undefined ? { executionGeneration: effectiveGen } : {}),
            kind: "steer_failed",
          } satisfies PromptEventPayload);
          return this.turnCoordinator.recordSteerFailure({
            connectionId,
            profileId,
            sessionId,
            ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
            ...(effectiveGen !== undefined ? { executionGeneration: effectiveGen } : {}),
            text,
            reason,
            message: canonicalRejected
              ? getCopy("turn.steer.fallbackBody")
              : asString(res.message, getCopy("turn.steer.fallbackBody")),
          });
        }
        return this.turnCoordinator.recordSteerSuccess({
          connectionId,
          profileId,
          sessionId,
          ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
          ...(effectiveGen !== undefined ? { executionGeneration: effectiveGen } : {}),
        });
      } catch (err) {
        if (isJsonRpcMethodNotFound(err) || isRpcAuthError(err) || isProfileUnavailableRpcError(err)) {
          this.translateRpcFailure(entry, err, "promptSteer", "session.steer", profileId);
        }
        if (err instanceof GatewayTransportError) {
          return this.turnCoordinator.recordSteerFailure({
            connectionId,
            profileId,
            sessionId,
            ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
            ...(effectiveGen !== undefined ? { executionGeneration: effectiveGen } : {}),
            text,
            reason: err.code === "timeout" ? "timeout" : "unreachable",
            message: getCopy("turn.steer.fallbackBody"),
          });
        }
        if (err instanceof GatewayRpcError) {
          const msgLower = err.message.toLowerCase();
          const reason = msgLower.includes("generation")
            ? "generation_mismatch"
            : msgLower.includes("finish") || msgLower.includes("ended")
              ? "turn_finished"
              : "rejected";
          return this.turnCoordinator.recordSteerFailure({
            connectionId,
            profileId,
            sessionId,
            ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
            ...(effectiveGen !== undefined ? { executionGeneration: effectiveGen } : {}),
            text,
            reason,
            message: getCopy("turn.steer.fallbackBody"),
          });
        }
        this.translateRpcFailure(entry, err, "promptSteer", "session.steer", profileId);
      }
    },

    "prompts.dismissSteerFallback": async (payload, scope) => {
      this.assertNotShuttingDown();
      const connectionId = this.resolveTargetConnectionId(payload, scope);
      const profileId = this.resolveTargetProfile(payload, scope, connectionId);
      const sessionId = this.resolveTargetSessionId(payload, scope, connectionId);
      if (sessionId) {
        this.turnCoordinator.clearSteerFallback({ connectionId, profileId, sessionId });
      }
      return { ok: true };
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
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("workspace.agents.capabilityRejectedError"),
        );
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
        throw makeBridgeError(
          "invalid_request",
          getCopy("workspace.agents.tailSelectionRequiredError"),
        );
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
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("workspace.agents.tailUnsupportedError"),
        );
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
        throw makeBridgeError(
          "invalid_request",
          getCopy("workspace.agents.steerTextRequiredError"),
        );
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
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("workspace.agents.steerUnsupportedError"),
        );
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
        throw makeBridgeError(
          "invalid_request",
          getCopy("workspace.agents.stopSelectionRequiredError"),
        );
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
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("workspace.agents.stopUnsupportedError"),
        );
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
          throw makeBridgeError(
            "conflict",
            getCopy("workspace.agents.stopUnconfirmedError"),
          );
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
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("workspace.checkpoints.listUnsupportedError"),
        );
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
        throw makeBridgeError(
          "invalid_request",
          getCopy("workspace.checkpoints.diffSelectionRequiredError"),
        );
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
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("workspace.checkpoints.diffUnsupportedError"),
        );
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
        throw makeBridgeError(
          "invalid_request",
          getCopy("workspace.checkpoints.restoreConfirmRequiredError"),
        );
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
          getCopy("workspace.checkpoints.readOnlyNotice"),
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
          throw makeBridgeError(
            "conflict",
            getCopy("workspace.checkpoints.restoreUnconfirmedError"),
          );
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
        throw makeBridgeError("invalid_request", getCopy("settings.config.keyUnsupportedError"));
      }
      const entry = this.requireTransport(connectionId, profileId);
      if (this.capabilityRegistry.isMethodRefused("config.update")) {
        throw makeBridgeError(
          "capability_unavailable",
          getCopy("settings.config.updateRefusedError"),
        );
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
          throw makeBridgeError(
            "capability_unavailable",
            getCopy("settings.config.updateUnsupportedError"),
          );
        }
        throw makeBridgeError("internal", getCopy("settings.config.updateFailedError"));
      }
    },

    "approvals.list": async (): Promise<ApprovalTopicSnapshot> => {
      this.assertNotShuttingDown();
      this.approvalCoordinator.onExpiryTick(this.now());
      return this.approvalCoordinator.snapshot();
    },

    "approvals.respond": async (payload): Promise<ApprovalRespondResult> => {
      this.assertNotShuttingDown();
      this.approvalCoordinator.onExpiryTick(this.now());
      const { approvalKey, choice } = assertApprovalRespondPayloadSafe(payload);
      return await this.approvalCoordinator.respond(approvalKey, choice);
    },

    "approvals.dismissOrphaned": async (payload): Promise<ApprovalTopicSnapshot> => {
      this.assertNotShuttingDown();
      const { approvalKey } = assertApprovalDismissPayloadSafe(payload);
      return this.approvalCoordinator.dismissOrphaned(approvalKey);
    },
  };

  private extractAndStoreSessionCwd(
    connectionId: string,
    profileId: string,
    sessionId: string,
    raw: Record<string, unknown>,
  ): void {
    const candidate = asString(
      raw.cwd ?? raw.working_directory ?? raw.workingDirectory ?? raw.workdir,
    ).trim();
    if (candidate) {
      this.sessionCwdByScope.set(transcriptKey(connectionId, profileId, sessionId), candidate);
    }
  }

  private buildMainApprovalContext(
    connectionId: string,
    profileId: string,
    sessionId: string,
    ownerGeneration: number,
    authorityEpoch: number,
    connectionOnline: boolean,
  ): ApprovalIngestInput["main"] {
    const health = this.getConnectionHealth(connectionId);
    const profiles = this.profilesByConnection.get(connectionId) ?? [];
    const profile = profiles.find((p) => p.profileId === profileId);
    const sessions = this.sessionsByScope.get(scopeKey(connectionId, profileId)) ?? [];
    const session = sessions.find((s) => s.sessionId === sessionId);
    const cwd = sessionId
      ? (this.sessionCwdByScope.get(transcriptKey(connectionId, profileId, sessionId)) ?? null)
      : null;

    return {
      connectionLabel: health?.label ?? (connectionId === "local" ? this.getLocalLabel() : connectionId),
      connectionKind: health?.kind ?? (connectionId === "local" ? "local" : "remote"),
      hostDisplay: health?.originDisplay ?? "",
      profileDisplayName: profile?.displayName ?? (profileId || null),
      sessionTitle: session?.title ?? null,
      cwd,
      ownerGeneration,
      authorityEpoch,
      connectionOnline,
    };
  }

  private toGatewayApprovalPayload(
    raw: Record<string, unknown>,
    connectionId: string,
    defaultProfileId: string,
    serverRequestId?: string | number,
  ): GatewayApprovalPayload {
    const profileId = this.resolveLocalProfileId(
      connectionId,
      asString(raw.profile_id ?? raw.profileId, defaultProfileId),
      defaultProfileId,
    );
    const sessionId = asString(raw.session_id ?? raw.sessionId).trim();
    const approvalId = asString(
      raw.approval_id ?? raw.approvalId ?? raw.prompt_id ?? raw.promptId,
    ).trim();
    const turnId = asString(raw.turn_id ?? raw.turnId).trim() || null;
    const executionGeneration =
      typeof raw.execution_generation === "number"
        ? raw.execution_generation
        : typeof raw.executionGeneration === "number"
          ? raw.executionGeneration
          : null;
    const rawCmd = raw.command ?? raw.cmd;
    const command = typeof rawCmd === "string" ? rawCmd : null;
    const description = asString(raw.description ?? raw.summary ?? raw.reason);
    const choices = Array.isArray(raw.choices) ? raw.choices.map((c) => String(c)) : undefined;
    const rawGrant =
      raw.persistent_grant && typeof raw.persistent_grant === "object"
        ? (raw.persistent_grant as Record<string, unknown>)
        : raw.persistentGrant && typeof raw.persistentGrant === "object"
          ? (raw.persistentGrant as Record<string, unknown>)
          : null;
    const persistentGrant = rawGrant
      ? {
          pattern: asString(rawGrant.pattern),
          scope: asString(rawGrant.scope),
          revokeHint: asString(rawGrant.revoke_hint ?? rawGrant.revokeHint),
        }
      : undefined;
    const rawRisks = raw.risk_categories ?? raw.riskCategories;
    const riskCategories = Array.isArray(rawRisks) ? rawRisks.map((r) => String(r)) : undefined;
    const reqId =
      serverRequestId !== undefined
        ? serverRequestId
        : typeof raw.server_request_id === "string" || typeof raw.server_request_id === "number"
          ? raw.server_request_id
          : typeof raw.serverRequestId === "string" || typeof raw.serverRequestId === "number"
            ? raw.serverRequestId
            : undefined;

    return {
      approvalId,
      ...(reqId !== undefined ? { serverRequestId: reqId } : {}),
      connectionId,
      profileId,
      sessionId,
      turnId,
      executionGeneration,
      command,
      description,
      ...(choices ? { choices } : {}),
      smartDenied: Boolean(raw.smart_denied ?? raw.smartDenied),
      smartDeniedReason: asString(raw.smart_denied_reason ?? raw.smartDeniedReason) || undefined,
      expiresAt: asString(raw.expires_at ?? raw.expiresAt) || null,
      ...(persistentGrant ? { persistentGrant } : {}),
      ...(riskCategories ? { riskCategories } : {}),
    };
  }

  private toApprovalIngestInput(
    raw: Record<string, unknown>,
    entry: GatewayTransportEntry,
    defaultProfileId: string,
    serverRequestId?: string | number,
  ): ApprovalIngestInput {
    const gateway = this.toGatewayApprovalPayload(
      raw,
      entry.connectionId,
      defaultProfileId,
      serverRequestId,
    );
    const main = this.buildMainApprovalContext(
      entry.connectionId,
      gateway.profileId,
      gateway.sessionId,
      entry.ownerGeneration,
      entry.authorityEpoch,
      !entry.disposed && entry.client.isOpen(),
    );
    return { gateway, main };
  }

  private async submitQueuedPromptOverGateway(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    text: string;
    submissionId?: string;
  }) {
    const entry = this.requireTransport(input.connectionId, input.profileId);
    if (!entry.supportedActions.promptSubmit) {
      throw makeBridgeError(
        "capability_unavailable",
        getCopy("chat.promptSubmitUnsupportedError"),
      );
    }
    try {
      const res = await this.turnCoordinator.submitQueued(
        {
          connectionId: input.connectionId,
          profileId: input.profileId,
          sessionId: input.sessionId,
          text: input.text,
          online: true,
          ...(input.submissionId ? { submissionId: input.submissionId } : {}),
        },
        async (rpcPayload) => {
          return this.normalizeQueuedPromptSubmit(
            await this.callPromptSubmit(entry, input.profileId, {
              session_id: input.sessionId,
              ...rpcPayload,
            }),
          );
        },
      );
      if (res.status === "admitted" && res.admission) {
        this.emitTopic(
          "prompt",
          {
            connectionId: input.connectionId,
            profileId: input.profileId,
            sessionId: input.sessionId,
          },
          "patch",
          {
            connectionId: input.connectionId,
            profileId: input.profileId,
            sessionId: input.sessionId,
            turnId: "",
            kind: "queued",
          } satisfies PromptEventPayload,
        );
      }
      return res;
    } catch (err) {
      if (err instanceof GatewayRpcError) {
        this.translateRpcFailure(entry, err, "promptSubmit", "prompt.submit", input.profileId);
      }
      throw err;
    }
  }

  private syncTurnRecoveryToSessions(snap: TurnRecoveryTopicSnapshot): void {
    const queuedScopes = new Set<string>();
    for (const view of snap.sessions) {
      if (view.queuedAdmissions.some((q) => q.state === "queued" || q.state === "cancelling" || q.state === "cancel_unknown")) {
        queuedScopes.add(transcriptKey(view.connectionId, view.profileId, view.sessionId));
      }
    }

    const updatedConnections = new Set<string>();
    const updatedProfileScopes = new Set<string>();
    for (const [sKey, list] of this.sessionsByScope.entries()) {
      let scopeChanged = false;
      const nextList = list.map((s) => {
        const tk = transcriptKey(s.connectionId, s.profileId, s.sessionId);
        const nextQueued = queuedScopes.has(tk);
        if (Boolean(s.queuedAdmission) !== nextQueued) {
          scopeChanged = true;
          updatedConnections.add(s.connectionId);
          updatedProfileScopes.add(sKey);
          return { ...s, queuedAdmission: nextQueued };
        }
        return s;
      });
      if (scopeChanged) {
        this.sessionsByScope.set(sKey, nextList);
      }
    }

    for (const sKey of updatedProfileScopes) {
      const [cid, pid] = sKey.split("::");
      if (cid && pid) {
        this.emitSessions(cid, pid);
      }
    }
    for (const cid of updatedConnections) {
      this.emitFleet(cid);
    }
  }

  private syncApprovalNeedsInputToSessions(snap: ApprovalTopicSnapshot): void {
    const pendingScopes = new Set<string>();
    for (const item of snap.approvals) {
      if (
        item.state === "actionable" ||
        item.state === "context_incomplete" ||
        item.state === "unverified" ||
        item.state === "submitting" ||
        item.state === "delivery_unknown"
      ) {
        pendingScopes.add(transcriptKey(item.connectionId, item.profileId, item.sessionId));
      }
    }

    const updatedConnections = new Set<string>();
    const updatedProfileScopes = new Set<string>();
    for (const [sKey, list] of this.sessionsByScope.entries()) {
      let scopeChanged = false;
      const nextList = list.map((s) => {
        const nextNeeds = pendingScopes.has(transcriptKey(s.connectionId, s.profileId, s.sessionId));
        if (s.needsInput !== nextNeeds) {
          scopeChanged = true;
          updatedConnections.add(s.connectionId);
          updatedProfileScopes.add(sKey);
          return { ...s, needsInput: nextNeeds };
        }
        return s;
      });
      if (scopeChanged) {
        this.sessionsByScope.set(sKey, nextList);
      }
    }

    for (const sKey of updatedProfileScopes) {
      const [cid, pid] = sKey.split("::");
      if (cid && pid) {
        this.emitSessions(cid, pid);
      }
    }
    for (const cid of updatedConnections) {
      this.emitFleet(cid);
    }
  }

  private scheduleApprovalExpiryCheck(): void {
    if (this.approvalExpiryTimer) {
      this.clearTimer(this.approvalExpiryTimer);
      this.approvalExpiryTimer = null;
    }
    if (this.disposed || this.shuttingDown) return;

    const nowMs = this.now();
    let soonestMs: number | null = null;
    for (const item of this.approvalCoordinator.snapshot().approvals) {
      if (
        item.state !== "actionable" &&
        item.state !== "context_incomplete" &&
        item.state !== "unverified" &&
        item.state !== "delivery_unknown"
      ) {
        continue;
      }
      if (!item.expiresAt) continue;
      const expMs = Date.parse(item.expiresAt);
      if (!Number.isFinite(expMs)) continue;
      if (expMs <= nowMs) {
        soonestMs = nowMs;
        break;
      }
      if (soonestMs === null || expMs < soonestMs) {
        soonestMs = expMs;
      }
    }
    if (soonestMs === null) return;
    const delayMs = Math.max(5, soonestMs - nowMs);
    this.approvalExpiryTimer = this.setTimer(() => {
      this.approvalExpiryTimer = null;
      if (this.disposed || this.shuttingDown) return;
      this.approvalCoordinator.onExpiryTick(this.now());
      this.scheduleApprovalExpiryCheck();
    }, delayMs);
  }

  private async fetchPendingApprovalsFromGateway(
    connectionId: string,
    profileId: string,
  ): Promise<ApprovalIngestInput[]> {
    const entry = this.getTransport(connectionId, profileId);
    if (!entry || entry.disposed || !entry.client.isOpen()) {
      throw makeBridgeError(
        "unreachable",
        getCopy("approval.connectionUnavailableError"),
      );
    }

    let res: Record<string, unknown> | null = null;
    const methods = ["approval.pending", "approval.list"] as const;
    for (const method of methods) {
      if (this.capabilityRegistry.isMethodRefused(method)) continue;
      try {
        res = await entry.client.call<Record<string, unknown>>(method, {
          profile_id: profileId,
        });
        break;
      } catch (err) {
        if (isJsonRpcMethodNotFound(err)) {
          continue;
        }
        throw err;
      }
    }

    if (!res) return [];
    const rawList = Array.isArray(res.approvals)
      ? (res.approvals as Array<Record<string, unknown>>)
      : Array.isArray(res.pending)
        ? (res.pending as Array<Record<string, unknown>>)
        : [];
    return rawList.map((raw) => this.toApprovalIngestInput(raw, entry, profileId));
  }

  private async rehydrateApprovalsOnConnect(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<void> {
    if (this.disposed || this.shuttingDown || entry.disposed) return;
    try {
      const pending = await this.fetchPendingApprovalsFromGateway(entry.connectionId, profileId);
      if (this.disposed || this.shuttingDown || entry.disposed) return;
      this.approvalCoordinator.reconcile(
        {
          connectionId: entry.connectionId,
          profileId,
          ownerGeneration: entry.ownerGeneration,
        },
        pending,
      );
    } catch {
      // Gateway may not implement approval.pending yet -> leave empty / stale_owner cleanly
    }
  }

  private async resyncApprovalsForEntry(
    entry: GatewayTransportEntry,
    profileId: string,
  ): Promise<void> {
    if (this.disposed || this.shuttingDown || entry.disposed) return;
    const expectedGen = entry.ownerGeneration;
    try {
      const pending = await this.fetchPendingApprovalsFromGateway(entry.connectionId, profileId);
      if (this.disposed || this.shuttingDown || entry.disposed) return;
      if (entry.ownerGeneration !== expectedGen) return;
      this.approvalCoordinator.reconcile(
        {
          connectionId: entry.connectionId,
          profileId,
          ownerGeneration: expectedGen,
        },
        pending,
      );
    } catch {
      // Keep unverified on transient resync failure
    }
  }

  private async sendApprovalRespondOverGateway(
    payload: GatewayApprovalRespondPayload,
  ): Promise<GatewayApprovalRespondOutcome> {
    const entry = this.requireTransport(payload.connectionId, payload.profileId);
    if (entry.ownerGeneration !== payload.ownerGeneration) {
      throw makeBridgeError(
        "approval_stale",
        getCopy("approval.ownerChangedError"),
      );
    }

    try {
      const res = await entry.client.call<Record<string, unknown>>("approval.respond", {
        profile_id: payload.profileId,
        session_id: payload.sessionId,
        turn_id: payload.turnId,
        approval_id: payload.approvalId,
        owner_generation: payload.ownerGeneration,
        execution_generation: payload.executionGeneration,
        choice: payload.choice,
        ...(payload.serverRequestId !== undefined
          ? { server_request_id: payload.serverRequestId }
          : {}),
      });
      const statusStr = asString(res?.status);
      if (
        statusStr === "settled_elsewhere_by_server" ||
        statusStr === "settled_elsewhere" ||
        statusStr === "already_settled" ||
        Boolean(res?.settled_elsewhere ?? res?.already_resolved)
      ) {
        return {
          status: "settled_elsewhere_by_server",
          message: asString(res?.message) || undefined,
        };
      }
      return {
        status: "settled",
        choice: payload.choice,
      };
    } catch (err) {
      if (
        err instanceof GatewayRpcError &&
        (err.rpcCode === 409 || err.rpcCode === -32009 || err.rpcCode === -32008)
      ) {
        return {
          status: "settled_elsewhere_by_server",
        };
      }
      throw err;
    }
  }

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
        profileId: this.resolveLocalProfileId("local", "default"),
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
    if (this.approvalExpiryTimer) {
      this.clearTimer(this.approvalExpiryTimer);
      this.approvalExpiryTimer = null;
    }
    for (const timer of this.staggerTimers) {
      this.clearTimer(timer);
    }
    this.staggerTimers.clear();

    // Ensure local default link exists so it transitions cleanly without resurrecting retired aliases
    const defaultLocalProfile = this.resolveLocalProfileId("local", "default");
    this.ensureLinkState("local", defaultLocalProfile, "enabled");

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
      this.approvalCoordinator.onConnectionOffline(cid);
      this.turnCoordinator.onConnectionOffline(cid);
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

    const defaultLocalProfile = this.resolveLocalProfileId("local", "default");
    const linksToRedial: ConnectionLinkState[] = [];
    for (const link of this.linksByKey.values()) {
      this.clearLinkTimers(link);
      link.attempt = 0;
      link.nextRetryAt = null;
      if (
        link.wasDesiredBeforeSuspend ||
        (link.connectionId === "local" && link.profileId === defaultLocalProfile)
      ) {
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
      const defaultLink =
        links.find(
          (l) =>
            l.profileId === (connectionId === "local" ? defaultLocalProfile : "default"),
        ) ?? links[0];
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

    // 2. Cancel all backoff, stability, approval expiry, and stagger timers
    if (this.approvalExpiryTimer) {
      this.clearTimer(this.approvalExpiryTimer);
      this.approvalExpiryTimer = null;
    }
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

    // 5. Mark links idle/disabled, clear background journal on Quit, and clear subscribers
    this.backgroundJournal.clear();
    this.pendingResyncKeys.clear();
    this.transcripts.clear();
    this.activeStreamingMessageBySession.clear();
    this.optimisticMessageIdsBySession.clear();
    this.optimisticTurnIdBySession.clear();
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
