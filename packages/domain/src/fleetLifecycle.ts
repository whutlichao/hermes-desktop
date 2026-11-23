import type {
  BackgroundNotificationKind,
  BridgeScope,
  ConnectionActualState,
  ConnectionDesiredState,
  ConnectionHealthSummary,
  ConnectionKind,
  ErrorCode,
  GatewayAggregateState,
  LocalFailureCode,
  SafeBackgroundNotification,
} from "@hermes/contracts";
import { getCopy } from "./copy";

export const BACKOFF_BASE_MS = 1_000 as const;
export const BACKOFF_MAX_MS = 30_000 as const;
export const BACKOFF_STABLE_RESET_MS = 5_000 as const;
export const RESUME_STAGGER_MAX_MS = 250 as const;
export const HEARTBEAT_INTERVAL_MS = 15_000 as const;
export const HEARTBEAT_DEADLINE_MS = 45_000 as const;
export const MAX_CONCURRENT_STARTUP_DIALS = 4 as const;
export const SHUTDOWN_BOUND_MS = 2_000 as const;

export function computeFullJitterBackoffMs(
  attempt: number,
  randomValue: number = Math.random(),
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** safeAttempt);
  const clampedRandom = Math.max(0, Math.min(1, randomValue));
  return Math.round(clampedRandom * cap);
}

export function computeResumeStaggerMs(randomValue: number = Math.random()): number {
  const clampedRandom = Math.max(0, Math.min(1, randomValue));
  return Math.round(clampedRandom * RESUME_STAGGER_MAX_MS);
}

export interface ConnectionLinkAggregationInput {
  profileId: string;
  desired: ConnectionDesiredState;
  actual: ConnectionActualState;
  degraded: boolean;
  pinned?: boolean;
  latencyMs: number | null;
  nextRetryAt: number | null;
  errorCode?: ErrorCode;
  unavailableCode?: LocalFailureCode;
  message?: string;
}

export interface AggregateConnectionHealthInput {
  base: {
    connectionId: string;
    label: string;
    kind: ConnectionKind;
    originDisplay: string;
  };
  links: ConnectionLinkAggregationInput[];
}

const ACTUAL_SEVERITY_PRIORITY: Record<ConnectionActualState, number> = {
  auth_required: 60,
  blocked: 50,
  reconnecting: 40,
  connecting: 30,
  stopping: 20,
  idle: 10,
  ready: 0,
};

export function isProfileLinkException(
  link: Pick<ConnectionLinkAggregationInput, "desired" | "actual" | "degraded" | "unavailableCode">,
  gatewayAggregate: GatewayAggregateState,
): boolean {
  if (link.unavailableCode) return true;
  if (link.desired === "disabled") return false;
  if (link.desired === "suspended" && gatewayAggregate === "suspended") return false;
  if (link.degraded) return true;
  if (gatewayAggregate === "ready" || gatewayAggregate === "degraded") {
    return link.desired === "enabled" && link.actual !== "ready";
  }
  return link.actual !== gatewayAggregate && !(link.actual === "idle" && link.desired !== "enabled");
}

export function aggregateConnectionHealth(
  input: AggregateConnectionHealthInput,
): ConnectionHealthSummary {
  const { base, links } = input;
  const activeLinks = links.filter((l) => l.desired !== "disabled");

  if (activeLinks.length === 0) {
    return {
      connectionId: base.connectionId,
      label: base.label,
      kind: base.kind,
      originDisplay: base.originDisplay,
      desired: "disabled",
      actual: "idle",
      aggregateState: "idle",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
      profileExceptionCount: 0,
    };
  }

  const allSuspended = activeLinks.every((l) => l.desired === "suspended");
  if (allSuspended) {
    const anyStopping = activeLinks.some((l) => l.actual === "stopping");
    return {
      connectionId: base.connectionId,
      label: base.label,
      kind: base.kind,
      originDisplay: base.originDisplay,
      desired: "suspended",
      actual: anyStopping ? "stopping" : "idle",
      aggregateState: "suspended",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
      profileExceptionCount: 0,
    };
  }

  const enabledLinks = activeLinks.filter((l) => l.desired === "enabled");
  const candidateLinks = enabledLinks.length > 0 ? enabledLinks : activeLinks;
  const readyLinks = candidateLinks.filter((l) => l.actual === "ready");

  let actual: ConnectionActualState = "idle";
  let aggregateState: GatewayAggregateState = "idle";
  let degraded = false;
  let primaryIssueLink: ConnectionLinkAggregationInput | undefined;

  if (readyLinks.length > 0) {
    actual = "ready";
    const exceptionLinks = candidateLinks.filter(
      (l) => l.actual !== "ready" || l.degraded || Boolean(l.unavailableCode),
    );
    degraded = exceptionLinks.length > 0;
    aggregateState = degraded ? "degraded" : "ready";
    if (exceptionLinks.length > 0) {
      primaryIssueLink = [...exceptionLinks].sort(
        (a, b) => ACTUAL_SEVERITY_PRIORITY[b.actual] - ACTUAL_SEVERITY_PRIORITY[a.actual],
      )[0];
    }
  } else {
    const sorted = [...candidateLinks].sort(
      (a, b) => ACTUAL_SEVERITY_PRIORITY[b.actual] - ACTUAL_SEVERITY_PRIORITY[a.actual],
    );
    const highest = sorted[0];
    actual = highest ? highest.actual : "idle";
    if (actual === "stopping") {
      aggregateState = "idle";
    } else {
      aggregateState = actual;
    }
    degraded =
      actual === "auth_required" ||
      actual === "blocked" ||
      actual === "reconnecting" ||
      candidateLinks.some((l) => l.degraded);
    primaryIssueLink = highest;
  }

  const latencies = readyLinks
    .map((l) => l.latencyMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const latencyMs = latencies.length > 0 ? Math.min(...latencies) : null;

  const retryTimes = candidateLinks
    .map((l) => l.nextRetryAt)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const nextRetryAt = retryTimes.length > 0 ? Math.min(...retryTimes) : null;

  const profileExceptionCount = candidateLinks.filter((l) =>
    isProfileLinkException(l, aggregateState),
  ).length;

  return {
    connectionId: base.connectionId,
    label: base.label,
    kind: base.kind,
    originDisplay: base.originDisplay,
    desired: "enabled",
    actual,
    aggregateState,
    degraded,
    latencyMs,
    nextRetryAt,
    ...(primaryIssueLink?.errorCode ? { errorCode: primaryIssueLink.errorCode } : {}),
    ...(primaryIssueLink?.message ? { message: primaryIssueLink.message } : {}),
    profileExceptionCount,
  };
}

export function buildSafeBackgroundNotification(input: {
  kind: BackgroundNotificationKind;
  isAppForeground: boolean;
  scope: BridgeScope;
  rawSecretOrCommand?: unknown;
}): SafeBackgroundNotification | null {
  if (input.isAppForeground) {
    return null;
  }
  const cleanScope: BridgeScope = {
    connectionId: input.scope.connectionId,
    ...(input.scope.profileId ? { profileId: input.scope.profileId } : {}),
    ...(input.scope.sessionId ? { sessionId: input.scope.sessionId } : {}),
  };
  if (input.kind === "approval_pending") {
    return {
      kind: "approval_pending",
      title: getCopy("notification.approvalPendingTitle"),
      body: getCopy("notification.approvalPendingBody"),
      scope: cleanScope,
      focusCommand: {
        type: "focus_scope",
        scope: cleanScope,
      },
    };
  }
  return {
    kind: "turn_completed",
    title: getCopy("notification.turnCompletedTitle"),
    body: getCopy("notification.turnCompletedBody"),
    scope: cleanScope,
    focusCommand: {
      type: "focus_scope",
      scope: cleanScope,
    },
  };
}
