import type {
  ErrorCode,
  PromptSteerResult,
  QueueDeliveryUnknownView,
  QueuedAdmissionState,
  QueuedAdmissionView,
  SteerFailureReason,
  SteerFallbackPromptView,
  TurnRecoveryTopicSnapshot,
  TurnSessionRecoveryView,
  TurnStopState,
  UnknownTurnRecord,
} from "@hermes/contracts";
import { getCopy } from "./copy";

export interface RawGatewayQueueItem {
  admissionId?: string;
  admission_id?: string;
  submissionId?: string;
  submission_id?: string;
  text?: string;
  prompt?: string;
  position?: number;
  state?: string;
  status?: string;
  executionGeneration?: number;
  execution_generation?: number;
  turnId?: string;
  turn_id?: string;
  statusReason?: string;
  reason?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

export interface RawGatewayUnknownTurn {
  admissionId?: string;
  admission_id?: string;
  executionGeneration?: number;
  execution_generation?: number;
  turnId?: string;
  turn_id?: string;
  originalInput?: string;
  original_input?: string;
  text?: string;
  lostReason?: string;
  lost_reason?: string;
  reason?: string;
  message?: string;
}

export interface TurnRecoveryPorts {
  now?: () => number;
  createSubmissionId?: () => string;
  onChange?: (snapshot: TurnRecoveryTopicSnapshot) => void;
}

interface InternalSessionRecovery {
  connectionId: string;
  profileId: string;
  sessionId: string;
  activeTurnId: string | null;
  executionGeneration: number;
  ownerGeneration: number;
  stopState: TurnStopState;
  stopRequestedTurnId?: string;
  stopRequestedGeneration?: number;
  stopOutcomeMessage?: string;
  queuePaused: boolean;
  unknownTurns: UnknownTurnRecord[];
  unknownTurnProtocolError?: string;
  queuedAdmissions: QueuedAdmissionView[];
  pendingDeliveryUnknown: QueueDeliveryUnknownView[];
  pendingSteerFallback: SteerFallbackPromptView | null;
  lastKnownUnverified: boolean;
  hasTurnHistory: boolean;
  lastTerminalTurnId?: string;
  updatedAt: string;
}

function makeTurnError(code: ErrorCode, message: string): Error {
  const err = new Error(message);
  (err as { code?: ErrorCode }).code = code;
  return err;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function makeKey(connectionId: string, profileId: string, sessionId: string): string {
  return `${connectionId}::${profileId}::${sessionId}`;
}

function isAckLossError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "timeout" || code === "unreachable") return true;
  const name = (err as { name?: unknown }).name;
  return name === "GatewayTransportError";
}

function normalizeQueuedState(raw: unknown): QueuedAdmissionState {
  switch (raw) {
    case "queued":
    case "cancelling":
    case "cancel_unknown":
    case "cancelled":
    case "stopped":
    case "already_started":
    case "completed":
    case "error":
    case "interrupted":
      return raw;
    case "running":
    case "started":
      return "already_started";
    case "pending":
    case "admitted":
      return "queued";
    default:
      return "queued";
  }
}

function normalizeQueueItem(
  raw: RawGatewayQueueItem,
  connectionId: string,
  profileId: string,
  sessionId: string,
  fallbackPosition: number,
  nowIso: string,
): QueuedAdmissionView | null {
  const admissionId = cleanString(raw.admissionId ?? raw.admission_id);
  if (!admissionId) return null;
  const submissionId = cleanString(raw.submissionId ?? raw.submission_id) || admissionId;
  const text = typeof raw.text === "string" ? raw.text : typeof raw.prompt === "string" ? raw.prompt : "";
  const position =
    typeof raw.position === "number" && Number.isFinite(raw.position) ? raw.position : fallbackPosition;
  const execGen = raw.executionGeneration ?? raw.execution_generation;
  const turnId = cleanString(raw.turnId ?? raw.turn_id) || undefined;
  const statusReason = cleanString(raw.statusReason ?? raw.reason) || undefined;
  return Object.freeze({
    admissionId,
    submissionId,
    sessionId,
    connectionId,
    profileId,
    text,
    position,
    state: normalizeQueuedState(raw.state ?? raw.status),
    ...(typeof execGen === "number" && Number.isFinite(execGen) ? { executionGeneration: execGen } : {}),
    ...(turnId ? { turnId } : {}),
    ...(statusReason ? { statusReason } : {}),
    lastKnownUnverified: false,
    createdAt: cleanString(raw.createdAt ?? raw.created_at) || nowIso,
    updatedAt: cleanString(raw.updatedAt ?? raw.updated_at) || nowIso,
  });
}

export class TurnRecoveryCoordinator {
  private readonly now: () => number;
  private readonly createSubmissionId: () => string;
  private readonly onChange?: (snapshot: TurnRecoveryTopicSnapshot) => void;
  private readonly sessions = new Map<string, InternalSessionRecovery>();
  private submissionSeq = 0;

  constructor(ports: TurnRecoveryPorts = {}) {
    this.now = ports.now ?? (() => Date.now());
    this.createSubmissionId =
      ports.createSubmissionId ??
      (() => {
        this.submissionSeq += 1;
        return `sub-${this.now()}-${this.submissionSeq}`;
      });
    this.onChange = ports.onChange;
  }

  snapshot(): TurnRecoveryTopicSnapshot {
    const list: TurnSessionRecoveryView[] = [];
    for (const rec of this.sessions.values()) {
      list.push(this.toImmutableView(rec));
    }
    return Object.freeze({ sessions: Object.freeze(list) });
  }

  getSessionView(scope: {
    connectionId: string;
    profileId: string;
    sessionId: string;
  }): TurnSessionRecoveryView | null {
    const rec = this.sessions.get(makeKey(scope.connectionId, scope.profileId, scope.sessionId));
    return rec ? this.toImmutableView(rec) : null;
  }

  hasTurnHistory(scope: { connectionId: string; profileId: string; sessionId: string }): boolean {
    const rec = this.sessions.get(makeKey(scope.connectionId, scope.profileId, scope.sessionId));
    return Boolean(rec?.hasTurnHistory);
  }

  noteTurnStarted(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    turnId: string;
    executionGeneration?: number;
    ownerGeneration: number;
  }): TurnSessionRecoveryView {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    rec.activeTurnId = input.turnId;
    rec.ownerGeneration = input.ownerGeneration;
    rec.executionGeneration =
      typeof input.executionGeneration === "number" && Number.isFinite(input.executionGeneration)
        ? input.executionGeneration
        : rec.executionGeneration + 1;
    rec.stopState = "idle";
    rec.stopRequestedTurnId = undefined;
    rec.stopRequestedGeneration = undefined;
    rec.stopOutcomeMessage = undefined;
    rec.pendingSteerFallback = null;
    rec.lastKnownUnverified = false;
    rec.hasTurnHistory = true;
    rec.updatedAt = nowIso;
    this.emitChange();
    return this.toImmutableView(rec);
  }

  noteTurnTerminal(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    turnId?: string;
    executionGeneration?: number;
    outcome: "completed" | "stopped" | "interrupted" | "error";
    message?: string;
  }): TurnSessionRecoveryView {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    if (
      typeof input.executionGeneration === "number" &&
      Number.isFinite(input.executionGeneration) &&
      input.executionGeneration < rec.executionGeneration
    ) {
      return this.toImmutableView(rec);
    }
    const terminalTurnId = input.turnId || rec.activeTurnId || undefined;
    if (terminalTurnId) {
      rec.lastTerminalTurnId = terminalTurnId;
    }
    if (!input.turnId || !rec.activeTurnId || rec.activeTurnId === input.turnId) {
      rec.activeTurnId = null;
    }
    rec.stopState =
      input.outcome === "stopped" || input.outcome === "interrupted" ? "stopped" : "idle";
    rec.stopRequestedTurnId = undefined;
    rec.stopRequestedGeneration = undefined;
    rec.stopOutcomeMessage = undefined;
    rec.hasTurnHistory = true;
    rec.lastKnownUnverified = false;
    rec.updatedAt = nowIso;
    this.emitChange();
    return this.toImmutableView(rec);
  }

  ingestUnknownTurn(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    admissionId: string;
    executionGeneration: number;
    ownerGeneration: number;
    turnId?: string;
    originalInput?: string;
    lostReason?: string;
    message?: string;
  }): TurnSessionRecoveryView {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    rec.ownerGeneration = input.ownerGeneration;
    rec.executionGeneration = Math.max(rec.executionGeneration, input.executionGeneration);
    rec.activeTurnId = null;
    rec.queuePaused = true;
    rec.stopState = rec.stopState === "stopping" ? "cancel_outcome_unknown" : rec.stopState;
    const record = Object.freeze({
      admissionId: input.admissionId,
      executionGeneration: input.executionGeneration,
      ownerGeneration: input.ownerGeneration,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.originalInput !== undefined ? { originalInput: input.originalInput } : {}),
      message: input.message?.trim() || "Turn lost during restart",
      lostReason: input.lostReason?.trim() || "owner_restarted",
      detectedAt: nowIso,
      resolving: false,
      lastKnownUnverified: false,
    });
    rec.unknownTurns = [
      ...rec.unknownTurns.filter((item) => item.admissionId !== input.admissionId),
      record,
    ];
    rec.updatedAt = nowIso;
    this.emitChange();
    return this.toImmutableView(rec);
  }

  async resolveUnknown(
    scope: {
      connectionId: string;
      profileId: string;
      sessionId: string;
      admissionId?: string;
      executionGeneration?: number;
    },
    sendResolve: (payload: {
      admission_id: string;
      execution_generation: number;
    }) => Promise<{
      settled?: boolean;
      status?: string;
      followersReleased?: boolean;
      queuedAdmissions?: RawGatewayQueueItem[];
    }>,
  ): Promise<{
    resolved: boolean;
    status: "interrupted";
    admissionId: string;
    executionGeneration: number;
  }> {
    const rec = this.sessions.get(makeKey(scope.connectionId, scope.profileId, scope.sessionId));
    const target = scope.admissionId
      ? rec?.unknownTurns.find((item) => item.admissionId === scope.admissionId)
      : rec?.unknownTurns[0];
    if (!rec || !target) {
      throw makeTurnError(
        "unknown_turn",
        getCopy("turn.recovery.unknownNotFoundError"),
      );
    }
    if (scope.admissionId && scope.admissionId !== target.admissionId) {
      throw makeTurnError("conflict", getCopy("turn.recovery.admissionMismatchError"));
    }
    if (
      typeof scope.executionGeneration === "number" &&
      scope.executionGeneration !== target.executionGeneration
    ) {
      throw makeTurnError(
        "conflict",
        getCopy("turn.recovery.generationMismatchError"),
      );
    }
    if (target.resolving) {
      throw makeTurnError(
        "conflict",
        getCopy("turn.recovery.discardInProgressError"),
      );
    }

    const nowIso = new Date(this.now()).toISOString();
    rec.unknownTurns = rec.unknownTurns.map((item) =>
      item.admissionId === target.admissionId ? Object.freeze({ ...item, resolving: true }) : item,
    );
    rec.updatedAt = nowIso;
    this.emitChange();

    try {
      const res = await sendResolve({
        admission_id: target.admissionId,
        execution_generation: target.executionGeneration,
      });
      const afterIso = new Date(this.now()).toISOString();
      if (res && res.settled === false) {
        rec.unknownTurns = rec.unknownTurns.map((item) =>
          item.admissionId === target.admissionId
            ? Object.freeze({ ...item, resolving: false })
            : item,
        );
        rec.updatedAt = afterIso;
        this.emitChange();
        throw makeTurnError(
          "conflict",
          getCopy("turn.recovery.discardUnconfirmedError"),
        );
      }

      rec.unknownTurns = rec.unknownTurns.filter(
        (item) => item.admissionId !== target.admissionId,
      );
      rec.queuePaused =
        rec.unknownTurns.length > 0 || Boolean(rec.unknownTurnProtocolError);
      rec.activeTurnId = null;
      rec.stopState = "stopped";
      if (Array.isArray(res?.queuedAdmissions)) {
        this.replaceQueueFromGateway(rec, res.queuedAdmissions, afterIso);
      }
      rec.updatedAt = afterIso;
      this.emitChange();
      return {
        resolved: true,
        status: "interrupted",
        admissionId: target.admissionId,
        executionGeneration: target.executionGeneration,
      };
    } catch (err) {
      if (rec.unknownTurns.some((item) => item.admissionId === target.admissionId)) {
        rec.unknownTurns = rec.unknownTurns.map((item) =>
          item.admissionId === target.admissionId
            ? Object.freeze({ ...item, resolving: false })
            : item,
        );
        rec.updatedAt = new Date(this.now()).toISOString();
        this.emitChange();
      }
      throw err;
    }
  }

  async requestStop(
    scope: {
      connectionId: string;
      profileId: string;
      sessionId: string;
      turnId?: string;
      executionGeneration?: number;
    },
    sendInterrupt: (payload: {
      turnId: string;
      executionGeneration: number;
    }) => Promise<{
      stopped?: boolean;
      accepted?: boolean;
      status?: string;
      terminal?: boolean;
      reason?: string;
    }>,
  ): Promise<{
    status: "stopping" | "stopped" | "cancel_outcome_unknown";
    turnId: string;
    executionGeneration: number;
  }> {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(scope.connectionId, scope.profileId, scope.sessionId, nowIso);
    const turnId = cleanString(scope.turnId) || rec.activeTurnId || "";
    if (!turnId) {
      throw makeTurnError("invalid_request", getCopy("turn.stop.noActiveTurnError"));
    }
    if (
      typeof scope.executionGeneration === "number" &&
      rec.executionGeneration > 0 &&
      scope.executionGeneration !== rec.executionGeneration
    ) {
      throw makeTurnError(
        "conflict",
        getCopy("turn.stop.generationMismatchError"),
      );
    }

    const capturedGen = rec.executionGeneration;
    const capturedOwnerGen = rec.ownerGeneration;
    rec.stopState = "stopping";
    rec.stopRequestedTurnId = turnId;
    rec.stopRequestedGeneration = capturedGen;
    rec.stopOutcomeMessage = undefined;
    rec.updatedAt = nowIso;
    this.emitChange();

    try {
      const res = await sendInterrupt({ turnId, executionGeneration: capturedGen });
      const afterIso = new Date(this.now()).toISOString();

      // If connection dropped or owner changed while awaiting ACK, never pretend stopped!
      if (rec.ownerGeneration !== capturedOwnerGen || rec.lastKnownUnverified) {
        rec.stopState = "cancel_outcome_unknown";
        rec.stopOutcomeMessage = getCopy("turn.stop.cancelOutcomeUnknownBody");
        rec.updatedAt = afterIso;
        this.emitChange();
        return {
          status: "cancel_outcome_unknown",
          turnId,
          executionGeneration: capturedGen,
        };
      }

      if (res?.stopped === false) {
        rec.stopState = "cancel_outcome_unknown";
        rec.stopOutcomeMessage = getCopy("turn.stop.notConfirmedBody");
        rec.updatedAt = afterIso;
        this.emitChange();
        throw makeTurnError("conflict", getCopy("turn.stop.notConfirmedError"));
      }

      const terminalConfirmed =
        res?.stopped === true ||
        res?.terminal === true ||
        res?.status === "stopped" ||
        res?.status === "interrupted";
      if (terminalConfirmed) {
        rec.stopState = "stopped";
        rec.activeTurnId = null;
        rec.lastTerminalTurnId = turnId;
        rec.stopRequestedTurnId = undefined;
        rec.stopRequestedGeneration = undefined;
        rec.stopOutcomeMessage = undefined;
        rec.updatedAt = afterIso;
        this.emitChange();
        return {
          status: "stopped",
          turnId,
          executionGeneration: capturedGen,
        };
      }

      // Interrupt receipt accepted (at most 'stopping' until prompt.stopped / terminal / resume)
      rec.stopState = "stopping";
      rec.updatedAt = afterIso;
      this.emitChange();
      return {
        status: "stopping",
        turnId,
        executionGeneration: capturedGen,
      };
    } catch (err) {
      const afterIso = new Date(this.now()).toISOString();
      if (rec.stopState === "cancel_outcome_unknown") {
        rec.updatedAt = afterIso;
        this.emitChange();
      } else if (isAckLossError(err) || rec.ownerGeneration !== capturedOwnerGen) {
        rec.stopState = "cancel_outcome_unknown";
        rec.stopOutcomeMessage = getCopy("turn.stop.cancelOutcomeUnknownBody");
        rec.updatedAt = afterIso;
        this.emitChange();
      } else {
        rec.stopState = "idle";
        rec.stopRequestedTurnId = undefined;
        rec.stopRequestedGeneration = undefined;
        rec.updatedAt = afterIso;
        this.emitChange();
      }
      throw err;
    }
  }

  onConnectionOffline(connectionId: string, profileId?: string): void {
    const nowIso = new Date(this.now()).toISOString();
    let changed = false;
    for (const rec of this.sessions.values()) {
      if (rec.connectionId !== connectionId) continue;
      if (profileId && rec.profileId !== profileId) continue;
      if (rec.stopState === "stopping") {
        rec.stopState = "cancel_outcome_unknown";
        rec.stopOutcomeMessage = getCopy("turn.stop.cancelOutcomeUnknownBody");
      }
      rec.lastKnownUnverified = true;
      if (rec.unknownTurns.length > 0) {
        rec.unknownTurns = rec.unknownTurns.map((item) =>
          Object.freeze({ ...item, lastKnownUnverified: true }),
        );
      }
      if (rec.queuedAdmissions.length > 0) {
        rec.queuedAdmissions = rec.queuedAdmissions.map((item) =>
          Object.freeze({ ...item, lastKnownUnverified: true }),
        );
      }
      rec.updatedAt = nowIso;
      changed = true;
    }
    if (changed) this.emitChange();
  }

  onOwnerGenerationChanged(
    connectionId: string,
    newOwnerGeneration: number,
    profileId?: string,
  ): void {
    const nowIso = new Date(this.now()).toISOString();
    let changed = false;
    for (const rec of this.sessions.values()) {
      if (rec.connectionId !== connectionId) continue;
      if (profileId && rec.profileId !== profileId) continue;
      if (rec.ownerGeneration !== newOwnerGeneration) {
        if (rec.stopState === "stopping") {
          rec.stopState = "cancel_outcome_unknown";
          rec.stopOutcomeMessage = getCopy("turn.stop.cancelOutcomeUnknownBody");
        }
        rec.ownerGeneration = newOwnerGeneration;
        rec.updatedAt = nowIso;
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  reconcileFromResume(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    ownerGeneration: number;
    activeTurnId: string | null;
    executionGeneration?: number;
    unknownTurns?: readonly RawGatewayUnknownTurn[];
    queuedAdmissions?: readonly RawGatewayQueueItem[];
    lastTurnOutcome?: "completed" | "stopped" | "interrupted" | "error" | null;
    matchedSubmissionIds?: readonly string[];
    queueSnapshotProvesAbsence?: boolean;
  }): TurnSessionRecoveryView {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    rec.ownerGeneration = input.ownerGeneration;
    if (typeof input.executionGeneration === "number" && Number.isFinite(input.executionGeneration)) {
      rec.executionGeneration = Math.max(rec.executionGeneration, input.executionGeneration);
    }
    rec.lastKnownUnverified = false;
    rec.activeTurnId = input.activeTurnId;
    if (input.activeTurnId) {
      rec.hasTurnHistory = true;
    }

    if (rec.stopState === "stopping" || rec.stopState === "cancel_outcome_unknown") {
      if (!input.activeTurnId || input.activeTurnId !== rec.stopRequestedTurnId) {
        rec.stopState =
          input.lastTurnOutcome === "stopped" || input.lastTurnOutcome === "interrupted"
            ? "stopped"
            : "idle";
        rec.stopRequestedTurnId = undefined;
        rec.stopRequestedGeneration = undefined;
        rec.stopOutcomeMessage = undefined;
      } else {
        // Server still shows the turn running after resume; allow user to inspect/manually stop again
        rec.stopState = "idle";
        rec.stopOutcomeMessage = undefined;
      }
    }

    // A later resume may arrive after an automatic reconnect already reconciled the stop as idle.
    // If the authoritative resume now reports a terminal interrupted/stopped turn and no active
    // turn remains, the user-visible outcome is still "stopped" (never inferred as completed).
    if (
      !input.activeTurnId &&
      (input.lastTurnOutcome === "stopped" || input.lastTurnOutcome === "interrupted") &&
      rec.stopState !== "stopped"
    ) {
      rec.stopState = "stopped";
      rec.stopRequestedTurnId = undefined;
      rec.stopRequestedGeneration = undefined;
      rec.stopOutcomeMessage = undefined;
    }

    if (input.unknownTurns !== undefined) {
      const projected = input.unknownTurns.flatMap((raw) => {
        const admId = cleanString(raw.admissionId ?? raw.admission_id);
        if (!admId) return [];
        const execGen =
          typeof (raw.executionGeneration ?? raw.execution_generation) === "number"
            ? Number(raw.executionGeneration ?? raw.execution_generation)
            : rec.executionGeneration;
        const turnId = cleanString(raw.turnId ?? raw.turn_id) || undefined;
        const originalInput =
          typeof raw.originalInput === "string"
            ? raw.originalInput
            : typeof raw.original_input === "string"
              ? raw.original_input
              : typeof raw.text === "string"
                ? raw.text
                : undefined;
        const existing = rec.unknownTurns.find((item) => item.admissionId === admId);
        return [
          Object.freeze({
          admissionId: admId,
          executionGeneration: execGen,
          ownerGeneration: input.ownerGeneration,
          ...(turnId ? { turnId } : {}),
          ...(originalInput !== undefined ? { originalInput } : {}),
          message: cleanString(raw.message) || "Turn lost during restart",
          lostReason:
            cleanString(raw.lostReason ?? raw.lost_reason ?? raw.reason) ||
            "owner_restarted",
          detectedAt: existing?.detectedAt ?? nowIso,
          resolving: false,
          lastKnownUnverified: false,
          }),
        ];
      });
      const malformedCount = input.unknownTurns.length - projected.length;
      rec.unknownTurns = projected;
      rec.queuePaused = projected.length > 0 || malformedCount > 0;
      if (malformedCount > 0) {
        rec.unknownTurnProtocolError = getCopy("turn.unknown.protocolUnsupportedBody");
      } else {
        rec.unknownTurnProtocolError = undefined;
      }
    } else if (rec.unknownTurns.length > 0) {
      rec.unknownTurns = rec.unknownTurns.map((item) =>
        Object.freeze({ ...item, lastKnownUnverified: false }),
      );
    }

    if (input.queuedAdmissions !== undefined) {
      this.replaceQueueFromGateway(rec, input.queuedAdmissions, nowIso, input.matchedSubmissionIds);
      // Canonical session.resume only lists queued/started/unknown admissions. A terminal row is
      // absent from that list, so an empty/missing submission is not proof it never entered the
      // authoritative queue. Legacy snapshots keep their historical retry-ready behavior.
      if (input.queueSnapshotProvesAbsence !== false && rec.pendingDeliveryUnknown.length > 0) {
        rec.pendingDeliveryUnknown = rec.pendingDeliveryUnknown.map((u) =>
          Object.freeze({
            ...u,
            state: "retry_ready" as const,
            canRetrySameSubmission: true,
            statusReason: "已从 Gateway 队列快照确认未入队，可使用原 submission_id 重试",
            updatedAt: nowIso,
          }),
        );
      }
    } else if (rec.queuedAdmissions.length > 0) {
      rec.queuedAdmissions = rec.queuedAdmissions.map((item) =>
        Object.freeze({ ...item, lastKnownUnverified: false }),
      );
    }

    rec.updatedAt = nowIso;
    this.emitChange();
    return this.toImmutableView(rec);
  }

  async submitQueued(
    input: {
      connectionId: string;
      profileId: string;
      sessionId: string;
      text: string;
      online: boolean;
      submissionId?: string;
    },
    sendSubmit: (payload: {
      text: string;
      queued: true;
      submission_id: string;
    }) => Promise<{
      admitted?: boolean;
      admission_id?: string;
      admissionId?: string;
      position?: number;
      execution_generation?: number;
      executionGeneration?: number;
      status?: string;
    }>,
  ): Promise<{
    status: "admitted" | "delivery_unknown";
    admission?: QueuedAdmissionView;
    deliveryUnknown?: QueueDeliveryUnknownView;
  }> {
    if (!input.online) {
      throw makeTurnError("unreachable", getCopy("turn.queue.offlineDraftHint"));
    }
    const text = input.text.trim();
    if (!text) {
      throw makeTurnError("invalid_request", getCopy("turn.queue.textRequiredError"));
    }

    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    const submissionId = cleanString(input.submissionId) || this.createSubmissionId();

    const existingAdmitted = rec.queuedAdmissions.find((q) => q.submissionId === submissionId);
    if (existingAdmitted) {
      return { status: "admitted", admission: existingAdmitted };
    }
    const existingUnknown = rec.pendingDeliveryUnknown.find((u) => u.submissionId === submissionId);
    if (existingUnknown && !existingUnknown.canRetrySameSubmission) {
      throw makeTurnError("conflict", getCopy("turn.queue.deliveryUnknownBody"));
    }

    try {
      const res = await sendSubmit({
        text,
        queued: true,
        submission_id: submissionId,
      });
      const afterIso = new Date(this.now()).toISOString();
      const admissionId = cleanString(res?.admission_id ?? res?.admissionId);
      if (res?.admitted === false) {
        throw makeTurnError("conflict", getCopy("turn.queue.rejectedError"));
      }
      if (!admissionId) {
        const unknownEntry = this.upsertDeliveryUnknown(
          rec,
          submissionId,
          text,
          "delivery_unknown",
          false,
          "未收到服务端 admission_id 回执",
          afterIso,
        );
        return { status: "delivery_unknown", deliveryUnknown: unknownEntry };
      }

      const admitted = this.recordAdmittedItem(
        rec,
        {
          admissionId,
          submissionId,
          text,
          position:
            typeof res.position === "number" && Number.isFinite(res.position)
              ? res.position
              : rec.queuedAdmissions.length + 1,
          state: normalizeQueuedState(res.status ?? "queued"),
          executionGeneration: res.executionGeneration ?? res.execution_generation,
        },
        afterIso,
      );
      rec.pendingSteerFallback = null;
      rec.updatedAt = afterIso;
      this.emitChange();
      return { status: "admitted", admission: admitted };
    } catch (err) {
      if (isAckLossError(err)) {
        const afterIso = new Date(this.now()).toISOString();
        const unknownEntry = this.upsertDeliveryUnknown(
          rec,
          submissionId,
          text,
          "delivery_unknown",
          false,
          "排队提交 ACK 丢失，请先检查回执",
          afterIso,
        );
        return { status: "delivery_unknown", deliveryUnknown: unknownEntry };
      }
      throw err;
    }
  }

  async checkQueueReceipt(
    input: {
      connectionId: string;
      profileId: string;
      sessionId: string;
      submissionId: string;
    },
    fetchReceiptOrSnapshot: (submissionId: string) => Promise<{
      found: boolean;
      admission?: RawGatewayQueueItem;
      queuedAdmissions?: RawGatewayQueueItem[];
      absenceConfirmed?: boolean;
    }>,
  ): Promise<{
    found: boolean;
    canRetrySameSubmission: boolean;
    admission?: QueuedAdmissionView;
    deliveryUnknown?: QueueDeliveryUnknownView;
  }> {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    const pending = rec.pendingDeliveryUnknown.find((u) => u.submissionId === input.submissionId);
    if (pending) {
      this.upsertDeliveryUnknown(
        rec,
        pending.submissionId,
        pending.text,
        "reconciling",
        false,
        "正在向 Gateway 核对排队回执",
        nowIso,
      );
    }

    const res = await fetchReceiptOrSnapshot(input.submissionId);
    const afterIso = new Date(this.now()).toISOString();

    if (Array.isArray(res.queuedAdmissions)) {
      this.replaceQueueFromGateway(rec, res.queuedAdmissions, afterIso);
    }

    const matchedRaw =
      res.admission ??
      res.queuedAdmissions?.find(
        (item) => cleanString(item.submissionId ?? item.submission_id) === input.submissionId,
      );

    if (res.found && matchedRaw) {
      const normalized = normalizeQueueItem(
        matchedRaw,
        rec.connectionId,
        rec.profileId,
        rec.sessionId,
        rec.queuedAdmissions.length + 1,
        afterIso,
      );
      if (normalized) {
        const adopted = this.recordAdmittedItem(
          rec,
          {
            admissionId: normalized.admissionId,
            submissionId: input.submissionId,
            text: normalized.text || pending?.text || "",
            position: normalized.position,
            state: normalized.state,
            executionGeneration: normalized.executionGeneration,
          },
          afterIso,
        );
        rec.updatedAt = afterIso;
        this.emitChange();
        return {
          found: true,
          canRetrySameSubmission: false,
          admission: adopted,
        };
      }
    }

    const alreadyInQueue = rec.queuedAdmissions.find((q) => q.submissionId === input.submissionId);
    if (alreadyInQueue) {
      rec.pendingDeliveryUnknown = rec.pendingDeliveryUnknown.filter(
        (u) => u.submissionId !== input.submissionId,
      );
      rec.updatedAt = afterIso;
      this.emitChange();
      return {
        found: true,
        canRetrySameSubmission: false,
        admission: alreadyInQueue,
      };
    }

    if (res.absenceConfirmed === false) {
      const unresolved = pending
        ? this.upsertDeliveryUnknown(
            rec,
            input.submissionId,
            pending.text,
            "delivery_unknown",
            false,
            "Gateway pending 中未找到该 submission_id，无法确认是否已入队或已进入终态",
            afterIso,
          )
        : undefined;
      return {
        found: false,
        canRetrySameSubmission: false,
        ...(unresolved ? { deliveryUnknown: unresolved } : {}),
      };
    }

    if (!pending && !matchedRaw) {
      return {
        found: false,
        canRetrySameSubmission: false,
      };
    }

    const ready = this.upsertDeliveryUnknown(
      rec,
      input.submissionId,
      pending?.text ?? "",
      "retry_ready",
      true,
      "已确认 Gateway 未入队，可使用原 submission_id 重试",
      afterIso,
    );
    return {
      found: false,
      canRetrySameSubmission: true,
      deliveryUnknown: ready,
    };
  }

  async retryQueued(
    input: {
      connectionId: string;
      profileId: string;
      sessionId: string;
      submissionId: string;
      online: boolean;
    },
    sendSubmit: (payload: {
      text: string;
      queued: true;
      submission_id: string;
    }) => Promise<{
      admitted?: boolean;
      admission_id?: string;
      admissionId?: string;
      position?: number;
      execution_generation?: number;
      executionGeneration?: number;
      status?: string;
    }>,
  ) {
    const rec = this.sessions.get(makeKey(input.connectionId, input.profileId, input.sessionId));
    const pending = rec?.pendingDeliveryUnknown.find((u) => u.submissionId === input.submissionId);
    if (!pending) {
      throw makeTurnError("not_found", getCopy("turn.queue.retryRecordNotFoundError"));
    }
    if (!pending.canRetrySameSubmission) {
      throw makeTurnError("conflict", getCopy("turn.queue.deliveryUnknownBody"));
    }
    return this.submitQueued(
      {
        connectionId: input.connectionId,
        profileId: input.profileId,
        sessionId: input.sessionId,
        text: pending.text,
        online: input.online,
        submissionId: pending.submissionId,
      },
      sendSubmit,
    );
  }

  async cancelQueued(
    input: {
      connectionId: string;
      profileId: string;
      sessionId: string;
      admissionId: string;
    },
    sendCancel: (payload: { admission_id: string }) => Promise<{
      status?: string;
      cancelled?: boolean;
      stopped?: boolean;
      already_started?: boolean;
      terminal?: boolean;
      turn_id?: string;
      reason?: string;
    }>,
  ): Promise<{ outcome: QueuedAdmissionState; admission: QueuedAdmissionView }> {
    const rec = this.sessions.get(makeKey(input.connectionId, input.profileId, input.sessionId));
    const target = rec?.queuedAdmissions.find((q) => q.admissionId === input.admissionId);
    if (!rec || !target) {
      throw makeTurnError("not_found", getCopy("turn.queue.targetNotFoundError"));
    }

    const nowIso = new Date(this.now()).toISOString();
    this.updateQueuedItem(rec, input.admissionId, { state: "cancelling", updatedAt: nowIso });
    this.emitChange();

    try {
      const res = await sendCancel({ admission_id: input.admissionId });
      const afterIso = new Date(this.now()).toISOString();
      let outcome: QueuedAdmissionState;
      if (res?.status === "already_started" || res?.already_started) {
        outcome = "already_started";
      } else if (res?.status === "stopped" || res?.stopped) {
        outcome = "stopped";
      } else if (
        res?.status === "completed" ||
        res?.status === "interrupted" ||
        res?.status === "error"
      ) {
        outcome = res.status;
      } else if (res?.status === "cancelled" || res?.cancelled) {
        outcome = "cancelled";
      } else {
        outcome = normalizeQueuedState(res?.status ?? "cancelled");
      }

      const updated = this.updateQueuedItem(rec, input.admissionId, {
        state: outcome,
        ...(res?.turn_id ? { turnId: res.turn_id } : {}),
        ...(res?.reason ? { statusReason: res.reason } : {}),
        updatedAt: afterIso,
      });
      rec.updatedAt = afterIso;
      this.emitChange();
      return { outcome, admission: updated };
    } catch (err) {
      const afterIso = new Date(this.now()).toISOString();
      if (isAckLossError(err)) {
        const unknown = this.updateQueuedItem(rec, input.admissionId, {
          state: "cancel_unknown",
          statusReason: "取消 ACK 丢失，等待队列快照对账",
          updatedAt: afterIso,
        });
        rec.updatedAt = afterIso;
        this.emitChange();
        return { outcome: "cancel_unknown", admission: unknown };
      }
      this.updateQueuedItem(rec, input.admissionId, { state: target.state, updatedAt: afterIso });
      this.emitChange();
      throw err;
    }
  }

  applyGatewayQueueSnapshot(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    queuedAdmissions: readonly RawGatewayQueueItem[];
  }): TurnSessionRecoveryView {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    this.replaceQueueFromGateway(rec, input.queuedAdmissions, nowIso);
    rec.lastKnownUnverified = false;
    rec.updatedAt = nowIso;
    this.emitChange();
    return this.toImmutableView(rec);
  }

  applyAdmissionEvent(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    admissionId: string;
    submissionId?: string;
    state: QueuedAdmissionState;
    turnId?: string;
    executionGeneration?: number;
    reason?: string;
  }): TurnSessionRecoveryView {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    const existing = rec.queuedAdmissions.find((q) => q.admissionId === input.admissionId);
    if (existing) {
      this.updateQueuedItem(rec, input.admissionId, {
        state: input.state,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(typeof input.executionGeneration === "number"
          ? { executionGeneration: input.executionGeneration }
          : {}),
        ...(input.reason ? { statusReason: input.reason } : {}),
        lastKnownUnverified: false,
        updatedAt: nowIso,
      });
    }
    if (input.submissionId) {
      rec.pendingDeliveryUnknown = rec.pendingDeliveryUnknown.filter(
        (u) => u.submissionId !== input.submissionId,
      );
    }
    rec.updatedAt = nowIso;
    this.emitChange();
    return this.toImmutableView(rec);
  }

  evaluateSteerPrecheck(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    turnId?: string;
    executionGeneration?: number;
    text: string;
    requireRunning?: boolean;
  }):
    | { allowed: true; turnId: string; executionGeneration: number }
    | { allowed: false; reason: SteerFailureReason; message: string } {
    if (!input.text.trim()) {
      return {
        allowed: false,
        reason: "rejected",
        message: "缺少补充纠偏内容",
      };
    }
    const rec = this.sessions.get(makeKey(input.connectionId, input.profileId, input.sessionId));
    if (!rec) {
      return input.requireRunning || input.executionGeneration !== undefined
        ? {
            allowed: false,
            reason: "not_running",
            message: "当前没有正在运行的 Turn，无法中途纠偏",
          }
        : {
            allowed: true,
            turnId: cleanString(input.turnId),
            executionGeneration: input.executionGeneration ?? 0,
          };
    }
    if (rec.queuePaused || rec.unknownTurns.length > 0) {
      return {
        allowed: false,
        reason: "rejected",
        message: "当前 Session 因丢失 Turn 已暂停，无法纠偏",
      };
    }
    if (!rec.activeTurnId) {
      return {
        allowed: false,
        reason: rec.hasTurnHistory ? "turn_finished" : "not_running",
        message: rec.hasTurnHistory
          ? "当前 Turn 已结束，无法中途纠偏"
          : "当前没有正在运行的 Turn，无法中途纠偏",
      };
    }
    if (
      typeof input.executionGeneration === "number" &&
      input.executionGeneration !== rec.executionGeneration
    ) {
      return {
        allowed: false,
        reason: "generation_mismatch",
        message: "Execution 代际已变更，无法向旧 Turn 发送纠偏",
      };
    }
    if (input.turnId && input.turnId !== rec.activeTurnId) {
      return {
        allowed: false,
        reason: "turn_finished",
        message: "目标 Turn 已变更或已结束",
      };
    }
    return {
      allowed: true,
      turnId: rec.activeTurnId,
      executionGeneration: rec.executionGeneration,
    };
  }

  recordSteerSuccess(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    turnId?: string;
    executionGeneration?: number;
  }): PromptSteerResult {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    rec.pendingSteerFallback = null;
    rec.updatedAt = nowIso;
    this.emitChange();
    return {
      ok: true,
      steered: true,
      sessionId: input.sessionId,
      turnId: input.turnId ?? rec.activeTurnId ?? undefined,
      executionGeneration: input.executionGeneration ?? rec.executionGeneration,
      status: "steered",
    };
  }

  recordSteerFailure(input: {
    connectionId: string;
    profileId: string;
    sessionId: string;
    turnId?: string;
    executionGeneration?: number;
    text: string;
    reason: SteerFailureReason;
    message: string;
  }): PromptSteerResult {
    const nowIso = new Date(this.now()).toISOString();
    const rec = this.ensureSession(input.connectionId, input.profileId, input.sessionId, nowIso);
    const allowedFallbacks: readonly ("new_turn" | "queue")[] = Object.freeze(["new_turn", "queue"]);
    rec.pendingSteerFallback = Object.freeze({
      text: input.text,
      reason: input.reason,
      message: input.message,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(typeof input.executionGeneration === "number"
        ? { executionGeneration: input.executionGeneration }
        : {}),
      allowedFallbacks,
      createdAt: nowIso,
    });
    rec.updatedAt = nowIso;
    this.emitChange();
    return {
      ok: true,
      steered: false,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(typeof input.executionGeneration === "number"
        ? { executionGeneration: input.executionGeneration }
        : {}),
      status: "failed",
      requiresExplicitFallback: true,
      reason: input.reason,
      message: input.message,
      text: input.text,
      allowedFallbacks,
    };
  }

  clearSteerFallback(scope: {
    connectionId: string;
    profileId: string;
    sessionId: string;
  }): void {
    const rec = this.sessions.get(makeKey(scope.connectionId, scope.profileId, scope.sessionId));
    if (!rec || !rec.pendingSteerFallback) return;
    rec.pendingSteerFallback = null;
    rec.updatedAt = new Date(this.now()).toISOString();
    this.emitChange();
  }

  private ensureSession(
    connectionId: string,
    profileId: string,
    sessionId: string,
    nowIso: string,
  ): InternalSessionRecovery {
    const key = makeKey(connectionId, profileId, sessionId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created: InternalSessionRecovery = {
      connectionId,
      profileId,
      sessionId,
      activeTurnId: null,
      executionGeneration: 0,
      ownerGeneration: 0,
      stopState: "idle",
      queuePaused: false,
      unknownTurns: [],
      queuedAdmissions: [],
      pendingDeliveryUnknown: [],
      pendingSteerFallback: null,
      lastKnownUnverified: false,
      hasTurnHistory: false,
      updatedAt: nowIso,
    };
    this.sessions.set(key, created);
    return created;
  }

  private upsertDeliveryUnknown(
    rec: InternalSessionRecovery,
    submissionId: string,
    text: string,
    state: QueueDeliveryUnknownView["state"],
    canRetrySameSubmission: boolean,
    statusReason: string,
    nowIso: string,
  ): QueueDeliveryUnknownView {
    const existing = rec.pendingDeliveryUnknown.find((u) => u.submissionId === submissionId);
    const nextItem: QueueDeliveryUnknownView = Object.freeze({
      submissionId,
      sessionId: rec.sessionId,
      connectionId: rec.connectionId,
      profileId: rec.profileId,
      text: text || existing?.text || "",
      state,
      ...(rec.executionGeneration > 0 ? { executionGeneration: rec.executionGeneration } : {}),
      statusReason,
      canRetrySameSubmission,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    rec.pendingDeliveryUnknown = [
      ...rec.pendingDeliveryUnknown.filter((u) => u.submissionId !== submissionId),
      nextItem,
    ];
    rec.updatedAt = nowIso;
    this.emitChange();
    return nextItem;
  }

  private recordAdmittedItem(
    rec: InternalSessionRecovery,
    item: {
      admissionId: string;
      submissionId: string;
      text: string;
      position: number;
      state: QueuedAdmissionState;
      executionGeneration?: number;
    },
    nowIso: string,
  ): QueuedAdmissionView {
    rec.pendingDeliveryUnknown = rec.pendingDeliveryUnknown.filter(
      (u) => u.submissionId !== item.submissionId,
    );
    const existing = rec.queuedAdmissions.find((q) => q.admissionId === item.admissionId);
    const nextView: QueuedAdmissionView = Object.freeze({
      admissionId: item.admissionId,
      submissionId: item.submissionId,
      sessionId: rec.sessionId,
      connectionId: rec.connectionId,
      profileId: rec.profileId,
      text: item.text || existing?.text || "",
      position: item.position,
      state: item.state,
      ...(typeof item.executionGeneration === "number"
        ? { executionGeneration: item.executionGeneration }
        : {}),
      lastKnownUnverified: false,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    const others = rec.queuedAdmissions.filter((q) => q.admissionId !== item.admissionId);
    rec.queuedAdmissions = [...others, nextView].sort((a, b) => a.position - b.position);
    return nextView;
  }

  private updateQueuedItem(
    rec: InternalSessionRecovery,
    admissionId: string,
    patch: Partial<QueuedAdmissionView>,
  ): QueuedAdmissionView {
    let updatedItem: QueuedAdmissionView | null = null;
    rec.queuedAdmissions = rec.queuedAdmissions.map((item) => {
      if (item.admissionId !== admissionId) return item;
      updatedItem = Object.freeze({ ...item, ...patch });
      return updatedItem;
    });
    if (!updatedItem) {
      throw makeTurnError("not_found", getCopy("turn.queue.targetNotFoundError"));
    }
    return updatedItem;
  }

  private replaceQueueFromGateway(
    rec: InternalSessionRecovery,
    rawList: readonly RawGatewayQueueItem[],
    nowIso: string,
    matchedSubmissionIds?: readonly string[],
  ): void {
    const normalized: QueuedAdmissionView[] = [];
    const seenSubIds = new Set<string>(matchedSubmissionIds ?? []);
    rawList.forEach((raw, idx) => {
      const item = normalizeQueueItem(
        raw,
        rec.connectionId,
        rec.profileId,
        rec.sessionId,
        idx + 1,
        nowIso,
      );
      if (item) {
        normalized.push(item);
        seenSubIds.add(item.submissionId);
      }
    });
    // Preserve exact Gateway FIFO order (sorted by server position, ties keep server array order)
    normalized.sort((a, b) => a.position - b.position);
    rec.queuedAdmissions = normalized;
    if (seenSubIds.size > 0) {
      rec.pendingDeliveryUnknown = rec.pendingDeliveryUnknown.filter(
        (u) => !seenSubIds.has(u.submissionId),
      );
    }
  }

  private toImmutableView(rec: InternalSessionRecovery): TurnSessionRecoveryView {
    return Object.freeze({
      connectionId: rec.connectionId,
      profileId: rec.profileId,
      sessionId: rec.sessionId,
      activeTurnId: rec.activeTurnId,
      executionGeneration: rec.executionGeneration,
      ownerGeneration: rec.ownerGeneration,
      stopState: rec.stopState,
      ...(rec.stopRequestedTurnId ? { stopRequestedTurnId: rec.stopRequestedTurnId } : {}),
      ...(rec.stopRequestedGeneration !== undefined
        ? { stopRequestedGeneration: rec.stopRequestedGeneration }
        : {}),
      ...(rec.stopOutcomeMessage ? { stopOutcomeMessage: rec.stopOutcomeMessage } : {}),
      queuePaused: rec.queuePaused,
      unknownTurns: Object.freeze([...rec.unknownTurns]),
      unknownTurn: rec.unknownTurns[0] ?? null,
      ...(rec.unknownTurnProtocolError
        ? { unknownTurnProtocolError: rec.unknownTurnProtocolError }
        : {}),
      queuedAdmissions: Object.freeze([...rec.queuedAdmissions]),
      pendingDeliveryUnknown: Object.freeze([...rec.pendingDeliveryUnknown]),
      pendingSteerFallback: rec.pendingSteerFallback,
      lastKnownUnverified: rec.lastKnownUnverified,
      updatedAt: rec.updatedAt,
    });
  }

  private emitChange(): void {
    this.onChange?.(this.snapshot());
  }
}
