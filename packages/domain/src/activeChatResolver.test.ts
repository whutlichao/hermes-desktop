import { describe, expect, it } from "vitest";
import type {
  ActiveChatRef,
  ConnectionActualState,
  ConnectionHealthSummary,
  ProfileSummary,
  SessionSummary,
} from "@hermes/contracts";
import { resolveActiveChat } from "./activeChatResolver";

function makeConn(
  connectionId: string,
  actual: ConnectionActualState = "ready",
  suspended = false,
): ConnectionHealthSummary & { suspended?: boolean } {
  return {
    connectionId,
    label: connectionId === "local" ? "This device" : connectionId,
    kind: connectionId === "local" ? "local" : "remote",
    originDisplay: connectionId === "local" ? "127.0.0.1" : `https://${connectionId}.example.com`,
    actual,
    degraded: false,
    latencyMs: actual === "ready" ? 12 : null,
    nextRetryAt: null,
    suspended,
  };
}

function makeProfile(
  connectionId: string,
  profileId: string,
  isDefault = profileId === "default",
): ProfileSummary {
  return {
    connectionId,
    profileId,
    displayName: profileId,
    handle: profileId,
    isDefault,
    actual: "ready",
  };
}

function makeSession(
  connectionId: string,
  profileId: string,
  sessionId: string,
  updatedAt = "2026-11-23T06:00:00.000Z",
): SessionSummary {
  return {
    connectionId,
    profileId,
    sessionId,
    title: `Title ${sessionId}`,
    preview: `Preview ${sessionId}`,
    updatedAt,
    pinned: false,
    unreadCount: 0,
    needsInput: false,
    activeTurnId: null,
    status: "idle",
  };
}

describe("ActiveChatResolver (S0 table-driven fallback matrix)", () => {
  it.each<{
    name: string;
    actual: ConnectionActualState;
    suspended?: boolean;
  }>([
    { name: "connecting", actual: "connecting" },
    { name: "reconnecting", actual: "reconnecting" },
    { name: "auth_required", actual: "auth_required" },
    { name: "blocked", actual: "blocked" },
    { name: "idle (suspended)", actual: "idle", suspended: true },
  ])("keeps activeChat and marks lastKnownUnverified on transient unreachable: $name", ({ actual, suspended }) => {
    const current: ActiveChatRef = {
      connectionId: "prod",
      profileId: "work",
      sessionId: "sess-prod-1",
    };
    const result = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready"), makeConn("prod", actual, Boolean(suspended))],
      profiles: [makeProfile("local", "default"), makeProfile("prod", "work")],
      sessions: [makeSession("local", "default", "sess-local-1")],
      lastValidProfileByConnection: { prod: "work", local: "default" },
      lastSessionByScope: { "local::default": "sess-local-1", "prod::work": "sess-prod-1" },
      lastValidScopes: [{ connectionId: "local", profileId: "default" }],
      hasDraftForCurrentSession: false,
    });

    expect(result.activeChat).toEqual(current);
    expect(result.activeSessionId).toBe("sess-prod-1");
    expect(result.status).toBe("unverified");
    expect(result.lastKnownUnverified).toBe(true);
    expect(result.routeBanner).toBeNull();
    expect(result.shouldAutoCreateSession).toBe(false);
  });

  it("transitions to read-only session_missing when session is removed, scope exists, and draft exists", () => {
    const current: ActiveChatRef = {
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-deleted",
    };
    const result = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default")],
      sessions: [makeSession("local", "default", "sess-other")],
      lastValidProfileByConnection: { local: "default" },
      lastSessionByScope: { "local::default": "sess-deleted" },
      lastValidScopes: [],
      hasDraftForCurrentSession: true,
    });

    expect(result.status).toBe("session_missing");
    expect(result.activeChat).toEqual(current);
    expect(result.activeSessionId).toBe("sess-deleted");
    expect(result.lastKnownUnverified).toBe(false);
    expect(result.routeBanner).toBeNull();
    expect(result.shouldAutoCreateSession).toBe(false);
  });

  it("falls back to latest valid session in same scope when session removed without draft, else scope empty", () => {
    const current: ActiveChatRef = {
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-deleted",
    };

    const withOtherSession = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default")],
      sessions: [
        makeSession("local", "default", "sess-older", "2026-11-23T01:00:00.000Z"),
        makeSession("local", "default", "sess-latest", "2026-11-23T05:00:00.000Z"),
      ],
      lastValidProfileByConnection: { local: "default" },
      lastSessionByScope: { "local::default": "sess-deleted" },
      lastValidScopes: [],
      hasDraftForCurrentSession: false,
    });

    expect(withOtherSession.status).toBe("ready");
    expect(withOtherSession.activeChat).toEqual({
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-latest",
    });
    expect(withOtherSession.routeBanner).toBeNull();
    expect(withOtherSession.shouldAutoCreateSession).toBe(false);

    const withEmptyScope = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default")],
      sessions: [],
      lastValidProfileByConnection: { local: "default" },
      lastSessionByScope: {},
      lastValidScopes: [],
      hasDraftForCurrentSession: false,
    });

    expect(withEmptyScope.status).toBe("ready");
    expect(withEmptyScope.activeChat).toEqual({
      connectionId: "local",
      profileId: "default",
    });
    expect(withEmptyScope.activeSessionId).toBeNull();
    expect(withEmptyScope.routeBanner).toBeNull();
    expect(withEmptyScope.shouldAutoCreateSession).toBe(false);
  });

  it("falls back on profile removed: lastValidProfile -> defaultProfile -> connection removed", () => {
    const current: ActiveChatRef = {
      connectionId: "local",
      profileId: "removed-prof",
      sessionId: "sess-r1",
    };

    // 1) lastValidProfile on same connection
    const toLastValid = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default", true), makeProfile("local", "work", false)],
      sessions: [makeSession("local", "work", "sess-w1"), makeSession("local", "default", "sess-d1")],
      lastValidProfileByConnection: { local: "work" },
      lastSessionByScope: { "local::work": "sess-w1" },
      lastValidScopes: [],
      hasDraftForCurrentSession: true,
    });

    expect(toLastValid.activeChat).toEqual({
      connectionId: "local",
      profileId: "work",
      sessionId: "sess-w1",
    });
    expect(toLastValid.routeBanner).toMatchObject({
      fromScope: { connectionId: "local", profileId: "removed-prof" },
      toScope: { connectionId: "local", profileId: "work", sessionId: "sess-w1" },
      reason: "profile_removed",
    });
    expect(toLastValid.shouldAutoCreateSession).toBe(false);

    // 2) defaultProfile on same connection when lastValidProfile also missing
    const toDefault = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default", true)],
      sessions: [makeSession("local", "default", "sess-d1")],
      lastValidProfileByConnection: { local: "removed-prof" },
      lastSessionByScope: {},
      lastValidScopes: [],
      hasDraftForCurrentSession: false,
    });

    expect(toDefault.activeChat).toEqual({
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-d1",
    });
    expect(toDefault.routeBanner?.reason).toBe("profile_removed");

    // 3) No profiles on same connection -> connection removed rules
    const toOtherConn = resolveActiveChat({
      current: { connectionId: "vps", profileId: "only-prof", sessionId: "s-vps" },
      connections: [makeConn("vps", "ready"), makeConn("local", "ready")],
      profiles: [makeProfile("local", "default", true)],
      sessions: [makeSession("local", "default", "sess-local-1")],
      lastValidProfileByConnection: {},
      lastSessionByScope: { "local::default": "sess-local-1" },
      lastValidScopes: [],
      hasDraftForCurrentSession: false,
    });

    expect(toOtherConn.activeChat).toEqual({
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-local-1",
    });
    expect(toOtherConn.routeBanner).toMatchObject({
      fromScope: { connectionId: "vps", profileId: "only-prof" },
      toScope: { connectionId: "local", profileId: "default", sessionId: "sess-local-1" },
      reason: "profile_removed",
    });
  });

  it("falls back on connection removed: lastValidScope -> local default lastSession -> onboarding empty", () => {
    const current: ActiveChatRef = {
      connectionId: "prod-vps",
      profileId: "ops",
      sessionId: "sess-ops-1",
    };

    // 1) Other valid (Connection, Profile) from lastValidScopes
    const toLastValidScope = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready"), makeConn("staging", "ready")],
      profiles: [makeProfile("local", "default", true), makeProfile("staging", "qa", false)],
      sessions: [makeSession("staging", "qa", "sess-qa-2")],
      lastValidProfileByConnection: {},
      lastSessionByScope: { "staging::qa": "sess-qa-2" },
      lastValidScopes: [{ connectionId: "staging", profileId: "qa" }],
      hasDraftForCurrentSession: false,
    });

    expect(toLastValidScope.activeChat).toEqual({
      connectionId: "staging",
      profileId: "qa",
      sessionId: "sess-qa-2",
    });
    expect(toLastValidScope.routeBanner).toMatchObject({
      fromScope: { connectionId: "prod-vps", profileId: "ops" },
      toScope: { connectionId: "staging", profileId: "qa", sessionId: "sess-qa-2" },
      reason: "connection_removed",
    });

    // 2) Fallback to local default's lastSession when lastValidScopes has no valid target
    const toLocalDefault = resolveActiveChat({
      current,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default", true)],
      sessions: [makeSession("local", "default", "sess-local-last")],
      lastValidProfileByConnection: {},
      lastSessionByScope: { "local::default": "sess-local-last" },
      lastValidScopes: [{ connectionId: "ghost", profileId: "default" }],
      hasDraftForCurrentSession: false,
    });

    expect(toLocalDefault.activeChat).toEqual({
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-local-last",
    });
    expect(toLocalDefault.routeBanner?.reason).toBe("connection_removed");

    // 3) Onboarding Empty when no connections exist
    const toEmpty = resolveActiveChat({
      current,
      connections: [],
      profiles: [],
      sessions: [],
      lastValidProfileByConnection: {},
      lastSessionByScope: {},
      lastValidScopes: [],
      hasDraftForCurrentSession: false,
    });

    expect(toEmpty.status).toBe("empty");
    expect(toEmpty.activeChat).toBeNull();
    expect(toEmpty.activeScope).toBeNull();
    expect(toEmpty.activeSessionId).toBeNull();
    expect(toEmpty.routeBanner).toBeNull();
    expect(toEmpty.shouldAutoCreateSession).toBe(false);
  });

  it("never invents a non-existent fallback target and resolves clean initial startup without banner", () => {
    const startup = resolveActiveChat({
      current: null,
      connections: [makeConn("local", "ready")],
      profiles: [makeProfile("local", "default", true)],
      sessions: [makeSession("local", "default", "sess-1")],
      lastValidProfileByConnection: {},
      lastSessionByScope: { "local::default": "sess-1" },
      lastValidScopes: [],
      hasDraftForCurrentSession: false,
    });

    expect(startup.status).toBe("ready");
    expect(startup.activeChat).toEqual({
      connectionId: "local",
      profileId: "default",
      sessionId: "sess-1",
    });
    expect(startup.routeBanner).toBeNull();
    expect(startup.shouldAutoCreateSession).toBe(false);
  });
});
