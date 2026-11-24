import { describe, expect, it } from "vitest";
import type { ConnectionLinkAggregationInput } from "./fleetLifecycle";
import {
  aggregateConnectionHealth,
  buildSafeBackgroundNotification,
  computeFullJitterBackoffMs,
  computeResumeStaggerMs,
  isProfileLinkException,
} from "./fleetLifecycle";

const base = {
  connectionId: "local",
  label: "This device",
  kind: "local" as const,
  originDisplay: "127.0.0.1",
};

function link(
  overrides: Partial<ConnectionLinkAggregationInput> = {},
): ConnectionLinkAggregationInput {
  return {
    profileId: "default",
    desired: "enabled",
    actual: "ready",
    degraded: false,
    latencyMs: null,
    nextRetryAt: null,
    ...overrides,
  };
}

describe("Fleet lifecycle pure aggregation (Ticket #34, coverage closeout)", () => {
  it("clamps backoff and stagger inputs, including negative and out-of-range randomness", () => {
    expect(computeFullJitterBackoffMs(-5, -1)).toBe(0);
    expect(computeFullJitterBackoffMs(0, 2)).toBe(1000);
    expect(computeFullJitterBackoffMs(3.9, 0.25)).toBe(2000);
    expect(computeFullJitterBackoffMs(100, 1)).toBe(30000);
    expect(computeResumeStaggerMs(-1)).toBe(0);
    expect(computeResumeStaggerMs(2)).toBe(250);
    expect(computeResumeStaggerMs(0.25)).toBe(63);
  });

  it("aggregates disabled-only, suspended, stopping, and idle-only connections", () => {
    const disabled = aggregateConnectionHealth({
      base,
      links: [link({ desired: "disabled", actual: "idle" })],
    });
    expect(disabled).toMatchObject({
      desired: "disabled",
      actual: "idle",
      aggregateState: "idle",
      degraded: false,
      latencyMs: null,
      nextRetryAt: null,
      profileExceptionCount: 0,
    });

    const suspendedStopping = aggregateConnectionHealth({
      base,
      links: [
        link({ profileId: "a", desired: "suspended", actual: "stopping" }),
        link({ profileId: "b", desired: "suspended", actual: "idle" }),
      ],
    });
    expect(suspendedStopping).toMatchObject({
      desired: "suspended",
      actual: "stopping",
      aggregateState: "suspended",
      degraded: false,
    });

    const idleOnly = aggregateConnectionHealth({
      base,
      links: [link({ actual: "idle" })],
    });
    expect(idleOnly).toMatchObject({ actual: "idle", aggregateState: "idle", degraded: false });

    const degradedIdle = aggregateConnectionHealth({
      base,
      links: [link({ actual: "idle", degraded: true })],
    });
    expect(degradedIdle).toMatchObject({ actual: "idle", degraded: true });

    const suspendedWithDisabledCompanion = aggregateConnectionHealth({
      base,
      links: [
        link({ profileId: "suspended", desired: "suspended", actual: "idle" }),
        link({ profileId: "disabled", desired: "disabled", actual: "reconnecting" }),
      ],
    });
    expect(suspendedWithDisabledCompanion).toMatchObject({
      desired: "suspended",
      actual: "idle",
      aggregateState: "suspended",
    });

    const stoppingOnly = aggregateConnectionHealth({
      base,
      links: [link({ actual: "stopping" })],
    });
    expect(stoppingOnly).toMatchObject({ actual: "stopping", aggregateState: "idle" });
  });

  it("prefers enabled links, carries the highest-severity issue, latency, retry, and message", () => {
    const withSuspendedCompanion = aggregateConnectionHealth({
      base,
      links: [
        link({ profileId: "enabled", desired: "enabled", actual: "reconnecting", degraded: true }),
        link({ profileId: "suspended", desired: "suspended", actual: "blocked" }),
      ],
    });
    expect(withSuspendedCompanion).toMatchObject({
      desired: "enabled",
      actual: "reconnecting",
      aggregateState: "reconnecting",
      degraded: true,
    });

    const withIssue = aggregateConnectionHealth({
      base,
      links: [
        link({ profileId: "ready", actual: "ready", latencyMs: 9 }),
        link({
          profileId: "blocked",
          actual: "blocked",
          degraded: true,
          unavailableCode: "profile_unavailable",
          nextRetryAt: 5000,
          errorCode: "timeout",
          message: "连接中",
        }),
        link({
          profileId: "connecting",
          actual: "connecting",
          latencyMs: 50,
          nextRetryAt: 8000,
        }),
      ],
    });
    expect(withIssue.actual).toBe("ready");
    expect(withIssue.aggregateState).toBe("degraded");
    expect(withIssue.degraded).toBe(true);
    expect(withIssue.latencyMs).toBe(9);
    expect(withIssue.nextRetryAt).toBe(5000);
    expect(withIssue.errorCode).toBe("timeout");
    expect(withIssue.message).toBe("连接中");
    expect(withIssue.profileExceptionCount).toBeGreaterThanOrEqual(2);

    const disabledCompanion = aggregateConnectionHealth({
      base,
      links: [
        link({ profileId: "s1", desired: "enabled", actual: "idle" }),
        link({ profileId: "s2", desired: "disabled", actual: "reconnecting", degraded: true }),
      ],
    });
    expect(disabledCompanion.actual).toBe("idle");
    expect(disabledCompanion.desired).toBe("enabled");
  });

  it("classifies profile link exceptions across every desired/actual/aggregate combination", () => {
    expect(isProfileLinkException(link({ unavailableCode: "profile_unavailable" }), "ready")).toBe(true);
    expect(isProfileLinkException(link({ desired: "disabled" }), "ready")).toBe(false);
    expect(
      isProfileLinkException(link({ desired: "suspended", actual: "idle" }), "suspended"),
    ).toBe(false);
    expect(isProfileLinkException(link({ degraded: true }), "ready")).toBe(true);
    expect(
      isProfileLinkException(link({ desired: "enabled", actual: "blocked" }), "ready"),
    ).toBe(true);
    expect(
      isProfileLinkException(link({ desired: "suspended", actual: "blocked" }), "ready"),
    ).toBe(false);
    expect(
      isProfileLinkException(link({ desired: "enabled", actual: "ready" }), "reconnecting"),
    ).toBe(true);
    expect(
      isProfileLinkException(link({ desired: "suspended", actual: "idle" }), "ready"),
    ).toBe(false);
  });

  it("builds sanitized approval and turn notifications with or without optional scope fields", () => {
    expect(
      buildSafeBackgroundNotification({
        kind: "approval_pending",
        isAppForeground: true,
        scope: { connectionId: "local" },
      }),
    ).toBeNull();

    const approval = buildSafeBackgroundNotification({
      kind: "approval_pending",
      isAppForeground: false,
      scope: { connectionId: "local", profileId: "", sessionId: "" },
      rawSecretOrCommand: "token=secret",
    });
    expect(approval).not.toBeNull();
    expect(approval?.scope).toEqual({ connectionId: "local" });
    expect(JSON.stringify(approval)).not.toContain("secret");

    const turn = buildSafeBackgroundNotification({
      kind: "turn_completed",
      isAppForeground: false,
      scope: { connectionId: "vps", profileId: "ops" },
    });
    expect(turn).not.toBeNull();
    expect(turn?.scope).toEqual({ connectionId: "vps", profileId: "ops" });
    expect(turn?.kind).toBe("turn_completed");
  });
});
