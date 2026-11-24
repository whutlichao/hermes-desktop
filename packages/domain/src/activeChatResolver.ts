import type {
  ActiveChatRef,
  ActiveChatStatus,
  BridgeScope,
  ConnectionActualState,
  ConnectionHealthSummary,
  ProfileSummary,
  RouteBannerState,
  RouteFallbackReason,
  SessionSummary,
} from "@hermes/contracts";

export type ResolverConnection = ConnectionHealthSummary & {
  suspended?: boolean;
};

export interface ActiveChatResolveInput {
  current: ActiveChatRef | null;
  connections: ResolverConnection[];
  profiles: ProfileSummary[];
  sessions: SessionSummary[];
  lastValidProfileByConnection: Record<string, string>;
  lastSessionByScope: Record<string, string>;
  lastValidScopes: Array<{ connectionId: string; profileId: string }>;
  hasDraftForCurrentSession: boolean;
}

export interface ActiveChatResolveResult {
  activeChat: ActiveChatRef | null;
  activeScope: BridgeScope | null;
  activeSessionId: string | null;
  status: ActiveChatStatus;
  lastKnownUnverified: boolean;
  routeBanner: RouteBannerState | null;
  shouldAutoCreateSession: false;
}

export function makeScopeKey(connectionId: string, profileId: string): string {
  return `${connectionId}::${profileId}`;
}

export function makeSessionKey(
  connectionId: string,
  profileId: string,
  sessionId: string,
): string {
  return `${connectionId}::${profileId}::${sessionId}`;
}

function isTransientUnreachable(conn: ResolverConnection): boolean {
  if (conn.suspended) return true;
  const actual: ConnectionActualState = conn.actual;
  return (
    actual === "connecting" ||
    actual === "reconnecting" ||
    actual === "auth_required" ||
    actual === "blocked" ||
    actual === "idle"
  );
}

function pickLatestSessionForScope(
  sessions: SessionSummary[],
  connectionId: string,
  profileId: string,
  preferredSessionId?: string,
  excludedSessionId?: string,
): string | undefined {
  const scoped = sessions.filter(
    (s) =>
      s.connectionId === connectionId &&
      s.profileId === profileId &&
      s.sessionId !== excludedSessionId,
  );
  if (scoped.length === 0) return undefined;
  if (preferredSessionId) {
    const preferred = scoped.find((s) => s.sessionId === preferredSessionId);
    if (preferred) return preferred.sessionId;
  }
  const sorted = [...scoped].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  );
  return sorted[0]?.sessionId;
}

function isProfileAvailable(p: ProfileSummary): boolean {
  return p.unavailableCode !== "profile_unavailable";
}

function resolveProfileForConnection(
  connectionId: string,
  profiles: ProfileSummary[],
  lastValidProfileByConnection: Record<string, string>,
): string | null {
  const connProfiles = profiles.filter(
    (p) => p.connectionId === connectionId && isProfileAvailable(p),
  );
  if (connProfiles.length === 0) return null;

  const preferredId = lastValidProfileByConnection[connectionId];
  if (preferredId && connProfiles.some((p) => p.profileId === preferredId)) {
    return preferredId;
  }
  const defaultProf =
    connProfiles.find((p) => p.isDefault) ??
    connProfiles.find((p) => p.profileId === "default") ??
    connProfiles[0];
  return defaultProf.profileId;
}

function buildCrossScopeFallback(
  from: ActiveChatRef | null,
  toConnectionId: string,
  toProfileId: string,
  reason: RouteFallbackReason,
  input: ActiveChatResolveInput,
  toConn: ResolverConnection,
): ActiveChatResolveResult {
  const scopeKey = makeScopeKey(toConnectionId, toProfileId);
  const nextSessionId = pickLatestSessionForScope(
    input.sessions,
    toConnectionId,
    toProfileId,
    input.lastSessionByScope[scopeKey],
  );
  const nextChat: ActiveChatRef = {
    connectionId: toConnectionId,
    profileId: toProfileId,
    ...(nextSessionId ? { sessionId: nextSessionId } : {}),
  };
  const nextScope: BridgeScope = {
    connectionId: toConnectionId,
    profileId: toProfileId,
    ...(nextSessionId ? { sessionId: nextSessionId } : {}),
  };
  const unverified = isTransientUnreachable(toConn);
  const isCrossScope =
    from !== null &&
    (from.connectionId !== toConnectionId || from.profileId !== toProfileId);

  return {
    activeChat: nextChat,
    activeScope: nextScope,
    activeSessionId: nextSessionId ?? null,
    status: unverified ? "unverified" : "ready",
    lastKnownUnverified: unverified,
    routeBanner: isCrossScope
      ? {
          id: `${from.connectionId}:${from.profileId}->${toConnectionId}:${toProfileId}:${reason}`,
          fromScope: { connectionId: from.connectionId, profileId: from.profileId },
          toScope: nextScope,
          reason,
        }
      : null,
    shouldAutoCreateSession: false,
  };
}

function findFallbackScopeAcrossConnections(
  from: ActiveChatRef | null,
  reason: RouteFallbackReason,
  input: ActiveChatResolveInput,
  excludeConnectionId?: string,
): ActiveChatResolveResult {
  const candidateConns = input.connections.filter(
    (c) =>
      c.connectionId !== excludeConnectionId &&
      (from !== null || !isTransientUnreachable(c)),
  );

  // 1. Prefer lastValidScopes where both connection and profile already exist
  for (const candidate of input.lastValidScopes) {
    if (candidate.connectionId === excludeConnectionId) continue;
    const conn = candidateConns.find((c) => c.connectionId === candidate.connectionId);
    if (!conn) continue;
    const connProfiles = input.profiles.filter((p) => p.connectionId === conn.connectionId);
    const hasProfile =
      connProfiles.some(
        (p) => p.profileId === candidate.profileId && isProfileAvailable(p),
      ) ||
      (connProfiles.length === 0 && isTransientUnreachable(conn));
    if (hasProfile) {
      return buildCrossScopeFallback(
        from,
        conn.connectionId,
        candidate.profileId,
        reason,
        input,
        conn,
      );
    }
  }

  // 2. Fallback to local default's lastSession / empty state
  const localConn = candidateConns.find((c) => c.connectionId === "local");
  if (localConn) {
    const localProfile =
      resolveProfileForConnection("local", input.profiles, input.lastValidProfileByConnection) ??
      (isTransientUnreachable(localConn) ? "default" : null);
    if (localProfile) {
      return buildCrossScopeFallback(from, "local", localProfile, reason, input, localConn);
    }
  }

  // 3. Fallback to any other existing connection with a valid profile
  for (const conn of candidateConns) {
    const prof =
      resolveProfileForConnection(
        conn.connectionId,
        input.profiles,
        input.lastValidProfileByConnection,
      ) ?? (isTransientUnreachable(conn) ? "default" : null);
    if (prof) {
      return buildCrossScopeFallback(from, conn.connectionId, prof, reason, input, conn);
    }
  }

  // 4. No valid connections/scopes remain -> Onboarding Empty
  return {
    activeChat: null,
    activeScope: null,
    activeSessionId: null,
    status: "empty",
    lastKnownUnverified: false,
    routeBanner: null,
    shouldAutoCreateSession: false,
  };
}

/**
 * Pure table-driven ActiveChat resolver called after bridge.hello + initial fleet/sessions
 * snapshot and on registry/profile/session changes. Never invents non-existent targets and
 * never auto-triggers session.create.
 */
export function resolveActiveChat(input: ActiveChatResolveInput): ActiveChatResolveResult {
  const { current, connections, profiles, sessions } = input;

  if (!current) {
    return findFallbackScopeAcrossConnections(null, "connection_removed", input);
  }

  const currentConn = connections.find((c) => c.connectionId === current.connectionId);
  if (!currentConn) {
    return findFallbackScopeAcrossConnections(
      current,
      "connection_removed",
      input,
      current.connectionId,
    );
  }

  // Transient unreachable states keep activeChat and mark lastKnownUnverified
  if (isTransientUnreachable(currentConn)) {
    return {
      activeChat: { ...current },
      activeScope: {
        connectionId: current.connectionId,
        profileId: current.profileId,
        ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      },
      activeSessionId: current.sessionId ?? null,
      status: "unverified",
      lastKnownUnverified: true,
      routeBanner: null,
      shouldAutoCreateSession: false,
    };
  }

  // Connection is ready: verify profile exists
  const currentProfileExists = profiles.some(
    (p) =>
      p.connectionId === current.connectionId &&
      p.profileId === current.profileId &&
      isProfileAvailable(p),
  );

  if (!currentProfileExists) {
    const fallbackProfile = resolveProfileForConnection(
      current.connectionId,
      profiles,
      input.lastValidProfileByConnection,
    );
    if (fallbackProfile) {
      return buildCrossScopeFallback(
        current,
        current.connectionId,
        fallbackProfile,
        "profile_removed",
        input,
        currentConn,
      );
    }
    return findFallbackScopeAcrossConnections(
      current,
      "profile_removed",
      input,
      current.connectionId,
    );
  }

  // Profile exists; if no sessionId (new chat in scope), keep scope active
  if (!current.sessionId) {
    return {
      activeChat: { connectionId: current.connectionId, profileId: current.profileId },
      activeScope: { connectionId: current.connectionId, profileId: current.profileId },
      activeSessionId: null,
      status: "ready",
      lastKnownUnverified: false,
      routeBanner: null,
      shouldAutoCreateSession: false,
    };
  }

  // Verify sessionId exists in authoritative sessions snapshot
  const sessionExists = sessions.some(
    (s) =>
      s.connectionId === current.connectionId &&
      s.profileId === current.profileId &&
      s.sessionId === current.sessionId,
  );

  if (sessionExists) {
    return {
      activeChat: { ...current },
      activeScope: {
        connectionId: current.connectionId,
        profileId: current.profileId,
        sessionId: current.sessionId,
      },
      activeSessionId: current.sessionId,
      status: "ready",
      lastKnownUnverified: false,
      routeBanner: null,
      shouldAutoCreateSession: false,
    };
  }

  // Session removed + Scope still exists + has Draft -> read-only session_missing
  if (input.hasDraftForCurrentSession) {
    return {
      activeChat: { ...current },
      activeScope: {
        connectionId: current.connectionId,
        profileId: current.profileId,
        sessionId: current.sessionId,
      },
      activeSessionId: current.sessionId,
      status: "session_missing",
      lastKnownUnverified: false,
      routeBanner: null,
      shouldAutoCreateSession: false,
    };
  }

  // Session removed + Scope still exists + NO Draft -> latest valid Session in same Scope or empty
  const scopeKey = makeScopeKey(current.connectionId, current.profileId);
  const nextSessionId = pickLatestSessionForScope(
    sessions,
    current.connectionId,
    current.profileId,
    input.lastSessionByScope[scopeKey],
    current.sessionId,
  );

  return {
    activeChat: {
      connectionId: current.connectionId,
      profileId: current.profileId,
      ...(nextSessionId ? { sessionId: nextSessionId } : {}),
    },
    activeScope: {
      connectionId: current.connectionId,
      profileId: current.profileId,
      ...(nextSessionId ? { sessionId: nextSessionId } : {}),
    },
    activeSessionId: nextSessionId ?? null,
    status: "ready",
    lastKnownUnverified: false,
    routeBanner: null,
    shouldAutoCreateSession: false,
  };
}
