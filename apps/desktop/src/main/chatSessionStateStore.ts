import fs from "node:fs";
import path from "node:path";
import type {
  ActiveChatRef,
  ActiveChatStatus,
  ArtifactAnnotation,
  ChatSessionProjection,
  MissingSessionExport,
  ProfileSummary,
  RouteBannerState,
  SessionRecoverySummary,
  SessionSummary,
  SessionTranscriptSnapshot,
} from "@hermes/contracts";
import {
  makeScopeKey,
  makeSessionKey,
  resolveActiveChat,
  type ActiveChatResolveResult,
  type ResolverConnection,
} from "@hermes/domain";
import { assertSafeSandboxRoot } from "./security";

export interface ChatSessionStateStoreOptions {
  userDataDir: string;
  allowRealHome?: boolean;
}

const MAX_RETAINED_SUMMARIES = 200;
const MAX_RETAINED_MESSAGES = 30;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeAtomic0600(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

function normalizeActiveChat(raw: unknown): ActiveChatRef | null {
  if (!isPlainObject(raw)) return null;
  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId.trim() : "";
  const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : "";
  if (!connectionId || !profileId) return null;
  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : undefined;
  return {
    connectionId,
    profileId,
    ...(sessionId ? { sessionId } : {}),
  };
}

function normalizeAnnotation(raw: unknown): ArtifactAnnotation | null {
  if (!isPlainObject(raw)) return null;
  const annotationId = typeof raw.annotationId === "string" ? raw.annotationId.trim() : "";
  const artifactId = typeof raw.artifactId === "string" ? raw.artifactId.trim() : "";
  const artifactHash = typeof raw.artifactHash === "string" ? raw.artifactHash.trim() : "";
  const artifactVersion =
    typeof raw.artifactVersion === "number" && Number.isFinite(raw.artifactVersion)
      ? raw.artifactVersion
      : 1;
  const xPct = typeof raw.xPct === "number" && Number.isFinite(raw.xPct) ? raw.xPct : 0;
  const yPct = typeof raw.yPct === "number" && Number.isFinite(raw.yPct) ? raw.yPct : 0;
  const comment = typeof raw.comment === "string" ? raw.comment : "";
  const createdAt =
    typeof raw.createdAt === "string" && raw.createdAt.trim()
      ? raw.createdAt.trim()
      : "2026-11-23T00:00:00.000Z";
  if (!annotationId || !artifactId) return null;
  return {
    annotationId,
    artifactId,
    artifactVersion,
    artifactHash,
    xPct,
    yPct,
    comment,
    createdAt,
  };
}

function normalizeAnnotations(raw: unknown): ArtifactAnnotation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: ArtifactAnnotation[] = [];
  for (const item of raw) {
    const norm = normalizeAnnotation(item);
    if (norm) list.push(norm);
  }
  return list.length > 0 ? list : undefined;
}

function normalizeSummary(raw: unknown): SessionRecoverySummary | null {
  if (!isPlainObject(raw)) return null;
  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId.trim() : "";
  const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : "";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  if (!connectionId || !profileId || !sessionId) return null;
  const annotations = normalizeAnnotations(raw.annotations);
  const draftText = typeof raw.draftText === "string" ? raw.draftText : undefined;
  const hasDraft =
    Boolean(raw.hasDraft) ||
    Boolean(draftText && draftText.trim().length > 0) ||
    Boolean(annotations && annotations.length > 0);
  return {
    connectionId,
    profileId,
    sessionId,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "新对话",
    ...(typeof raw.preview === "string" ? { preview: raw.preview } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    hasDraft,
    ...(draftText !== undefined ? { draftText } : {}),
    ...(annotations ? { annotations } : {}),
    ...(Array.isArray(raw.lastKnownMessages)
      ? { lastKnownMessages: raw.lastKnownMessages.slice(-MAX_RETAINED_MESSAGES) }
      : {}),
  };
}

function emptyProjection(): ChatSessionProjection {
  return {
    windowId: "primary",
    paneId: "main",
    lastActiveChat: null,
    lastSessionByScope: {},
    lastValidProfileByConnection: {},
    lastValidScopes: [],
    sessionSummaries: {},
    activeStatus: "empty",
    lastKnownUnverified: false,
    missingSession: null,
    routeBanner: null,
  };
}

/**
 * Instantiable store for lastActiveChat, per-scope lastSessionId, and minimal recovery
 * summaries (draft presence + last-known session summary). Uses 0600 atomic writes.
 */
export class ChatSessionStateStore {
  readonly filePath: string;
  private state: ChatSessionProjection;
  private loaded = false;

  constructor(options: ChatSessionStateStoreOptions) {
    const safeUserDataDir = assertSafeSandboxRoot(options.userDataDir, {
      allowRealHome: Boolean(options.allowRealHome),
    });
    this.filePath = path.join(safeUserDataDir, "chat-session-state.json");
    this.state = emptyProjection();
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }

  private persist(): void {
    // Prune unbounded session summaries keeping ones with drafts or most recent updatedAt
    const entries = Object.entries(this.state.sessionSummaries);
    if (entries.length > MAX_RETAINED_SUMMARIES) {
      entries.sort(([, a], [, b]) => {
        if (a.hasDraft !== b.hasDraft) return a.hasDraft ? -1 : 1;
        return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
      });
      this.state.sessionSummaries = Object.fromEntries(entries.slice(0, MAX_RETAINED_SUMMARIES));
    }
    const persisted = {
      ...this.state,
      windowId: "primary" as const,
      paneId: "main" as const,
    };
    writeAtomic0600(this.filePath, `${JSON.stringify(persisted, null, 2)}\n`);
  }

  load(): ChatSessionProjection {
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) {
      this.state = emptyProjection();
      return structuredClone(this.state);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isPlainObject(parsed)) {
        this.state = emptyProjection();
        return structuredClone(this.state);
      }

      const lastSessionByScope: Record<string, string> = {};
      if (isPlainObject(parsed.lastSessionByScope)) {
        for (const [k, v] of Object.entries(parsed.lastSessionByScope)) {
          if (typeof v === "string" && v.trim()) lastSessionByScope[k] = v.trim();
        }
      }

      const lastValidProfileByConnection: Record<string, string> = {};
      if (isPlainObject(parsed.lastValidProfileByConnection)) {
        for (const [k, v] of Object.entries(parsed.lastValidProfileByConnection)) {
          if (typeof v === "string" && v.trim()) lastValidProfileByConnection[k] = v.trim();
        }
      }

      const lastValidScopes: Array<{ connectionId: string; profileId: string }> = [];
      if (Array.isArray(parsed.lastValidScopes)) {
        for (const item of parsed.lastValidScopes) {
          if (
            isPlainObject(item) &&
            typeof item.connectionId === "string" &&
            item.connectionId.trim() &&
            typeof item.profileId === "string" &&
            item.profileId.trim()
          ) {
            lastValidScopes.push({
              connectionId: item.connectionId.trim(),
              profileId: item.profileId.trim(),
            });
          }
        }
      }

      const sessionSummaries: Record<string, SessionRecoverySummary> = {};
      if (isPlainObject(parsed.sessionSummaries)) {
        for (const [k, v] of Object.entries(parsed.sessionSummaries)) {
          const norm = normalizeSummary(v);
          if (norm) sessionSummaries[k] = norm;
        }
      }

      const lastActiveChat = normalizeActiveChat(parsed.lastActiveChat);
      const validStatuses = new Set<ActiveChatStatus>([
        "ready",
        "unverified",
        "session_missing",
        "empty",
      ]);
      const activeStatus: ActiveChatStatus = validStatuses.has(parsed.activeStatus as ActiveChatStatus)
        ? (parsed.activeStatus as ActiveChatStatus)
        : lastActiveChat
          ? "unverified"
          : "empty";

      this.state = {
        windowId: "primary",
        paneId: "main",
        lastActiveChat,
        lastSessionByScope,
        lastValidProfileByConnection,
        lastValidScopes,
        sessionSummaries,
        activeStatus,
        lastKnownUnverified: Boolean(parsed.lastKnownUnverified ?? lastActiveChat !== null),
        missingSession: normalizeSummary(parsed.missingSession),
        routeBanner: isPlainObject(parsed.routeBanner)
          ? (parsed.routeBanner as unknown as RouteBannerState)
          : null,
      };
      return structuredClone(this.state);
    } catch {
      this.state = emptyProjection();
      return structuredClone(this.state);
    }
  }

  getProjection(): ChatSessionProjection {
    this.ensureLoaded();
    return structuredClone(this.state);
  }

  private recordScopeVisit(connectionId: string, profileId: string, sessionId?: string): void {
    const scopeKey = makeScopeKey(connectionId, profileId);
    this.state.lastValidProfileByConnection[connectionId] = profileId;
    if (sessionId) {
      this.state.lastSessionByScope[scopeKey] = sessionId;
    }
    const filtered = this.state.lastValidScopes.filter(
      (s) => !(s.connectionId === connectionId && s.profileId === profileId),
    );
    this.state.lastValidScopes = [{ connectionId, profileId }, ...filtered].slice(0, 20);
  }

  recordActiveChat(ref: ActiveChatRef | null): ChatSessionProjection {
    this.ensureLoaded();
    this.state.lastActiveChat = ref ? { ...ref } : null;
    if (ref) {
      this.recordScopeVisit(ref.connectionId, ref.profileId, ref.sessionId);
      this.state.activeStatus = "ready";
      this.state.lastKnownUnverified = false;
      this.state.missingSession = null;
    } else {
      this.state.activeStatus = "empty";
      this.state.lastKnownUnverified = false;
      this.state.missingSession = null;
    }
    this.persist();
    return this.getProjection();
  }

  syncSessionSummaries(sessions: SessionSummary[]): ChatSessionProjection {
    this.ensureLoaded();
    let changed = false;
    for (const s of sessions) {
      const key = makeSessionKey(s.connectionId, s.profileId, s.sessionId);
      const prev = this.state.sessionSummaries[key];
      if (
        !prev ||
        prev.title !== s.title ||
        prev.preview !== s.preview ||
        prev.updatedAt !== s.updatedAt
      ) {
        this.state.sessionSummaries[key] = {
          connectionId: s.connectionId,
          profileId: s.profileId,
          sessionId: s.sessionId,
          title: s.title,
          preview: s.preview,
          updatedAt: s.updatedAt,
          hasDraft: prev?.hasDraft ?? false,
          ...(prev?.draftText !== undefined ? { draftText: prev.draftText } : {}),
          ...(prev?.annotations ? { annotations: prev.annotations } : {}),
          ...(prev?.lastKnownMessages ? { lastKnownMessages: prev.lastKnownMessages } : {}),
        };
        if (
          this.state.missingSession &&
          this.state.missingSession.connectionId === s.connectionId &&
          this.state.missingSession.profileId === s.profileId &&
          this.state.missingSession.sessionId === s.sessionId
        ) {
          this.state.missingSession = { ...this.state.sessionSummaries[key] };
        }
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return this.getProjection();
  }

  recordTranscriptSnapshot(snapshot: SessionTranscriptSnapshot): void {
    this.ensureLoaded();
    if (!snapshot.sessionId) return;
    const key = makeSessionKey(snapshot.connectionId, snapshot.profileId, snapshot.sessionId);
    const prev = this.state.sessionSummaries[key];
    this.state.sessionSummaries[key] = {
      connectionId: snapshot.connectionId,
      profileId: snapshot.profileId,
      sessionId: snapshot.sessionId,
      title: prev?.title ?? "新对话",
      ...(prev?.preview !== undefined ? { preview: prev.preview } : {}),
      ...(prev?.updatedAt !== undefined ? { updatedAt: prev.updatedAt } : {}),
      hasDraft: prev?.hasDraft ?? false,
      ...(prev?.draftText !== undefined ? { draftText: prev.draftText } : {}),
      ...(prev?.annotations ? { annotations: prev.annotations } : {}),
      lastKnownMessages: snapshot.messages.slice(-MAX_RETAINED_MESSAGES),
    };
    this.persist();
  }

  saveDraft(
    ref: ActiveChatRef,
    text: string,
    options?: { annotations?: ArtifactAnnotation[] },
  ): ChatSessionProjection {
    this.ensureLoaded();
    const sessionId = ref.sessionId?.trim();
    if (!sessionId) {
      return this.getProjection();
    }
    const key = makeSessionKey(ref.connectionId, ref.profileId, sessionId);
    const prev = this.state.sessionSummaries[key];
    const nextAnnotations =
      options?.annotations !== undefined
        ? normalizeAnnotations(options.annotations)
        : prev?.annotations;
    const hasText = text.trim().length > 0;
    const hasAnnotations = Boolean(nextAnnotations && nextAnnotations.length > 0);
    const hasDraft = hasText || hasAnnotations;
    this.state.sessionSummaries[key] = {
      connectionId: ref.connectionId,
      profileId: ref.profileId,
      sessionId,
      title: prev?.title ?? "新对话",
      ...(prev?.preview !== undefined ? { preview: prev.preview } : {}),
      ...(prev?.updatedAt !== undefined ? { updatedAt: prev.updatedAt } : {}),
      hasDraft,
      ...(hasText ? { draftText: text } : {}),
      ...(hasAnnotations && nextAnnotations ? { annotations: nextAnnotations } : {}),
      ...(prev?.lastKnownMessages ? { lastKnownMessages: prev.lastKnownMessages } : {}),
    };
    if (
      this.state.missingSession &&
      this.state.missingSession.connectionId === ref.connectionId &&
      this.state.missingSession.profileId === ref.profileId &&
      this.state.missingSession.sessionId === sessionId
    ) {
      this.state.missingSession = { ...this.state.sessionSummaries[key] };
    }
    this.persist();
    return this.getProjection();
  }

  resolveWithSnapshot(input: {
    connections: ResolverConnection[];
    profiles: ProfileSummary[];
    sessions: SessionSummary[];
  }): ActiveChatResolveResult & { projection: ChatSessionProjection } {
    this.ensureLoaded();
    this.syncSessionSummaries(input.sessions);

    const current = this.state.lastActiveChat;
    const currentKey =
      current?.sessionId
        ? makeSessionKey(current.connectionId, current.profileId, current.sessionId)
        : null;
    const hasDraft = currentKey ? Boolean(this.state.sessionSummaries[currentKey]?.hasDraft) : false;

    const result = resolveActiveChat({
      current,
      connections: input.connections,
      profiles: input.profiles,
      sessions: input.sessions,
      lastValidProfileByConnection: this.state.lastValidProfileByConnection,
      lastSessionByScope: this.state.lastSessionByScope,
      lastValidScopes: this.state.lastValidScopes,
      hasDraftForCurrentSession: hasDraft,
    });

    this.state.lastActiveChat = result.activeChat ? { ...result.activeChat } : null;
    this.state.activeStatus = result.status;
    this.state.lastKnownUnverified = result.lastKnownUnverified;

    if (result.status === "session_missing" && result.activeChat?.sessionId) {
      const missKey = makeSessionKey(
        result.activeChat.connectionId,
        result.activeChat.profileId,
        result.activeChat.sessionId,
      );
      this.state.missingSession = this.state.sessionSummaries[missKey] ?? {
        connectionId: result.activeChat.connectionId,
        profileId: result.activeChat.profileId,
        sessionId: result.activeChat.sessionId,
        title: "已移除的 Session",
        hasDraft,
      };
    } else {
      this.state.missingSession = null;
      if (result.activeChat && result.status === "ready") {
        this.recordScopeVisit(
          result.activeChat.connectionId,
          result.activeChat.profileId,
          result.activeChat.sessionId,
        );
      }
    }

    if (result.routeBanner) {
      this.state.routeBanner = { ...result.routeBanner };
    }

    this.persist();
    return {
      ...result,
      projection: this.getProjection(),
    };
  }

  dismissRouteBanner(): ChatSessionProjection {
    this.ensureLoaded();
    this.state.routeBanner = null;
    this.persist();
    return this.getProjection();
  }

  exportMissingSession(sessionRef?: ActiveChatRef): MissingSessionExport | null {
    this.ensureLoaded();
    const target = sessionRef ?? this.state.missingSession ?? this.state.lastActiveChat;
    if (!target || !target.sessionId) return null;
    const key = makeSessionKey(target.connectionId, target.profileId, target.sessionId);
    const summary = this.state.sessionSummaries[key] ?? this.state.missingSession;
    return {
      exportedAt: new Date().toISOString(),
      windowId: "primary",
      paneId: "main",
      scope: {
        connectionId: target.connectionId,
        profileId: target.profileId,
        sessionId: target.sessionId,
      },
      sessionTitle: summary?.title ?? "已移除的 Session",
      draftText: summary?.draftText ?? "",
      ...(summary?.annotations ? { annotations: summary.annotations } : {}),
      messages: summary?.lastKnownMessages ?? [],
    };
  }

  dismissMissingSession(sessions: SessionSummary[]): ChatSessionProjection {
    this.ensureLoaded();
    const missing = this.state.missingSession ?? this.state.lastActiveChat;
    if (missing?.sessionId) {
      const key = makeSessionKey(missing.connectionId, missing.profileId, missing.sessionId);
      const prev = this.state.sessionSummaries[key];
      if (prev) {
        this.state.sessionSummaries[key] = {
          ...prev,
          hasDraft: false,
          draftText: undefined,
        };
      }
      const scopeKey = makeScopeKey(missing.connectionId, missing.profileId);
      if (this.state.lastSessionByScope[scopeKey] === missing.sessionId) {
        delete this.state.lastSessionByScope[scopeKey];
      }
    }

    if (missing) {
      const scoped = sessions
        .filter(
          (s) =>
            s.connectionId === missing.connectionId &&
            s.profileId === missing.profileId &&
            s.sessionId !== missing.sessionId,
        )
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      const fallbackSession = scoped[0]?.sessionId;
      this.state.lastActiveChat = {
        connectionId: missing.connectionId,
        profileId: missing.profileId,
        ...(fallbackSession ? { sessionId: fallbackSession } : {}),
      };
      this.state.activeStatus = "ready";
      this.state.missingSession = null;
      this.recordScopeVisit(missing.connectionId, missing.profileId, fallbackSession);
    } else {
      this.state.activeStatus = "empty";
      this.state.missingSession = null;
    }

    this.persist();
    return this.getProjection();
  }
}
