import fs from "node:fs";
import path from "node:path";
import {
  DRAFT_MAX_BYTES,
  DRAFTS_TOTAL_MAX_BYTES,
  type ActiveChatRef,
  type ActiveChatStatus,
  type ArtifactAnnotation,
  type ChatSessionProjection,
  type DraftAttachment,
  type DraftAttachmentKind,
  type DraftComposerState,
  type DraftContextItem,
  type DraftDeliveryStatus,
  type DraftExportBundle,
  type DraftOrigin,
  type DraftRecord,
  type MissingSessionExport,
  type OrphanedDraftReason,
  type OrphanedDraftRecord,
  type ProfileSummary,
  type RouteBannerState,
  type SessionRecoverySummary,
  type SessionSummary,
  type SessionTranscriptSnapshot,
} from "@hermes/contracts";
import {
  buildOrphanedDraftExport,
  checkDraftCapacity,
  getCopy,
  isDraftRecordEmpty,
  makeActiveChatDraftKey,
  makeNewChatDraftKey,
  makeScopeKey,
  makeSessionKey,
  measureTotalDraftsBytes,
  resolveActiveChat,
  resolveDraftKey,
  shouldClearDraftForReceipt,
  type ActiveChatResolveResult,
  type ResolverConnection,
} from "@hermes/domain";
import { assertSafeSandboxRoot } from "./security";

export interface ChatSessionStateStoreOptions {
  userDataDir: string;
  allowRealHome?: boolean;
  now?: () => number;
}

export interface SaveDraftRecordInput {
  connectionId: string;
  profileId: string;
  sessionId?: string;
  draftId?: string;
  text?: string;
  attachments?: DraftAttachment[];
  contexts?: DraftContextItem[];
  composer?: DraftComposerState;
  annotations?: ArtifactAnnotation[];
  originTitle?: string;
  deliveryStatus?: DraftDeliveryStatus;
}

export type SaveDraftRecordResult =
  | { ok: true; draft: DraftRecord | null; projection: ChatSessionProjection }
  | {
      ok: false;
      reason: "over_single_limit" | "over_total_limit";
      bytes: number;
      limitBytes: number;
      projection: ChatSessionProjection;
    };

const MAX_RETAINED_SUMMARIES = 200;
const MAX_RETAINED_MESSAGES = 30;
const VALID_ATTACHMENT_KINDS = new Set<DraftAttachmentKind>(["file", "image", "text", "binary"]);
const VALID_CONTEXT_KINDS = new Set<DraftContextItem["kind"]>([
  "file",
  "line_range",
  "artifact",
  "snippet",
]);
const VALID_DELIVERY_STATUS = new Set<DraftDeliveryStatus>([
  "idle",
  "submitting",
  "delivery_unknown",
]);
const VALID_ORPHAN_REASONS = new Set<OrphanedDraftReason>([
  "session_deleted",
  "profile_removed",
  "connection_removed",
  "session_missing_closed",
  "session_missing_exported",
]);

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

function normalizeAttachments(raw: unknown): DraftAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftAttachment[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const attachmentId = typeof item.attachmentId === "string" ? item.attachmentId.trim() : "";
    const handle = typeof item.handle === "string" ? item.handle.trim() : "";
    const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
    if (!attachmentId || !handle || !displayName) continue;
    const kind: DraftAttachmentKind = VALID_ATTACHMENT_KINDS.has(item.kind as DraftAttachmentKind)
      ? (item.kind as DraftAttachmentKind)
      : "file";
    out.push({
      attachmentId,
      handle,
      displayName,
      kind,
      ...(typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
        ? { sizeBytes: item.sizeBytes }
        : {}),
      ...(item.expired ? { expired: true } : {}),
    });
  }
  return out;
}

function normalizeContexts(raw: unknown): DraftContextItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftContextItem[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const contextId = typeof item.contextId === "string" ? item.contextId.trim() : "";
    const ref = typeof item.ref === "string" ? item.ref.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!contextId || !ref || !label) continue;
    const kind: DraftContextItem["kind"] = VALID_CONTEXT_KINDS.has(item.kind as DraftContextItem["kind"])
      ? (item.kind as DraftContextItem["kind"])
      : "file";
    out.push({
      contextId,
      kind,
      ref,
      label,
      ...(typeof item.version === "string" || typeof item.version === "number"
        ? { version: item.version }
        : {}),
    });
  }
  return out;
}

function normalizeComposerState(raw: unknown): DraftComposerState {
  if (!isPlainObject(raw)) return {};
  return {
    ...(typeof raw.selectionStart === "number" && Number.isFinite(raw.selectionStart)
      ? { selectionStart: raw.selectionStart }
      : {}),
    ...(typeof raw.selectionEnd === "number" && Number.isFinite(raw.selectionEnd)
      ? { selectionEnd: raw.selectionEnd }
      : {}),
    ...(typeof raw.sendOnEnter === "boolean" ? { sendOnEnter: raw.sendOnEnter } : {}),
  };
}

function normalizeOrigin(raw: unknown, fallbackScope?: { connectionId: string; profileId: string; sessionId?: string }): DraftOrigin | null {
  if (!isPlainObject(raw)) {
    return fallbackScope ? { ...fallbackScope } : null;
  }
  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId.trim() : fallbackScope?.connectionId ?? "";
  const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : fallbackScope?.profileId ?? "";
  if (!connectionId || !profileId) return null;
  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.trim()
      ? raw.sessionId.trim()
      : fallbackScope?.sessionId;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined;
  return {
    connectionId,
    profileId,
    ...(sessionId ? { sessionId } : {}),
    ...(title ? { title } : {}),
  };
}

function normalizeDraftRecord(raw: unknown): DraftRecord | null {
  if (!isPlainObject(raw)) return null;
  const draftId = typeof raw.draftId === "string" ? raw.draftId.trim() : "";
  const scopeRaw = isPlainObject(raw.scope) ? raw.scope : null;
  const connectionId = scopeRaw && typeof scopeRaw.connectionId === "string" ? scopeRaw.connectionId.trim() : "";
  const profileId = scopeRaw && typeof scopeRaw.profileId === "string" ? scopeRaw.profileId.trim() : "";
  if (!draftId || !connectionId || !profileId) return null;
  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : undefined;
  const origin = normalizeOrigin(raw.origin, { connectionId, profileId, sessionId }) ?? {
    connectionId,
    profileId,
    ...(sessionId ? { sessionId } : {}),
  };
  const annotations = normalizeAnnotations(raw.annotations);
  const deliveryStatus: DraftDeliveryStatus | undefined = VALID_DELIVERY_STATUS.has(
    raw.deliveryStatus as DraftDeliveryStatus,
  )
    ? (raw.deliveryStatus as DraftDeliveryStatus)
    : undefined;
  return {
    draftId,
    ...(sessionId ? { sessionId } : {}),
    scope: { connectionId, profileId },
    text: typeof raw.text === "string" ? raw.text : "",
    attachments: normalizeAttachments(raw.attachments),
    contexts: normalizeContexts(raw.contexts),
    composer: normalizeComposerState(raw.composer),
    ...(annotations ? { annotations } : {}),
    updatedAt:
      typeof raw.updatedAt === "string" && raw.updatedAt.trim()
        ? raw.updatedAt.trim()
        : "2026-11-23T00:00:00.000Z",
    revision:
      typeof raw.revision === "number" && Number.isFinite(raw.revision) && raw.revision >= 1
        ? raw.revision
        : 1,
    origin,
    ...(deliveryStatus ? { deliveryStatus } : {}),
  };
}

function normalizeOrphanedDraft(raw: unknown): OrphanedDraftRecord | null {
  if (!isPlainObject(raw)) return null;
  const orphanedId = typeof raw.orphanedId === "string" ? raw.orphanedId.trim() : "";
  const draftId = typeof raw.draftId === "string" ? raw.draftId.trim() : "";
  const origin = normalizeOrigin(raw.origin);
  if (!orphanedId || !draftId || !origin) return null;
  const reason: OrphanedDraftReason = VALID_ORPHAN_REASONS.has(raw.reason as OrphanedDraftReason)
    ? (raw.reason as OrphanedDraftReason)
    : "session_deleted";
  const annotations = normalizeAnnotations(raw.annotations);
  return {
    orphanedId,
    draftId,
    text: typeof raw.text === "string" ? raw.text : "",
    attachments: normalizeAttachments(raw.attachments),
    contexts: normalizeContexts(raw.contexts),
    ...(annotations ? { annotations } : {}),
    origin,
    reason,
    orphanedAt:
      typeof raw.orphanedAt === "string" && raw.orphanedAt.trim()
        ? raw.orphanedAt.trim()
        : "2026-11-23T00:00:00.000Z",
  };
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
    draftsByKey: {},
    orphanedDrafts: [],
    draftStorageUsage: {
      totalBytes: 0,
      maxDraftBytes: DRAFT_MAX_BYTES,
      maxTotalBytes: DRAFTS_TOTAL_MAX_BYTES,
      overTotalLimit: false,
      draftCount: 0,
      orphanedCount: 0,
    },
  };
}

/**
 * Instantiable store for lastActiveChat, per-scope lastSessionId, persisted Drafts,
 * OrphanedDrafts, and minimal recovery summaries. Uses 0600 atomic writes.
 */
export class ChatSessionStateStore {
  readonly filePath: string;
  private readonly now: () => number;
  private state: ChatSessionProjection;
  private loaded = false;
  private idSeq = 0;

  constructor(options: ChatSessionStateStoreOptions) {
    const safeUserDataDir = assertSafeSandboxRoot(options.userDataDir, {
      allowRealHome: Boolean(options.allowRealHome),
    });
    this.filePath = path.join(safeUserDataDir, "chat-session-state.json");
    this.now = options.now ?? (() => Date.now());
    this.state = emptyProjection();
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}-${this.now()}-${this.idSeq}`;
  }

  private recomputeStorageUsage(): void {
    const draftsByKey = this.state.draftsByKey ?? {};
    const orphanedDrafts = this.state.orphanedDrafts ?? [];
    const totalBytes = measureTotalDraftsBytes(draftsByKey, orphanedDrafts);
    this.state.draftStorageUsage = {
      totalBytes,
      maxDraftBytes: DRAFT_MAX_BYTES,
      maxTotalBytes: DRAFTS_TOTAL_MAX_BYTES,
      overTotalLimit: totalBytes > DRAFTS_TOTAL_MAX_BYTES,
      draftCount: Object.keys(draftsByKey).length,
      orphanedCount: orphanedDrafts.length,
    };
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
    this.recomputeStorageUsage();
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

      const draftsByKey: Record<string, DraftRecord> = {};
      if (isPlainObject(parsed.draftsByKey)) {
        for (const [k, v] of Object.entries(parsed.draftsByKey)) {
          const norm = normalizeDraftRecord(v);
          if (norm) draftsByKey[k] = norm;
        }
      }

      const orphanedDrafts: OrphanedDraftRecord[] = [];
      if (Array.isArray(parsed.orphanedDrafts)) {
        for (const item of parsed.orphanedDrafts) {
          const norm = normalizeOrphanedDraft(item);
          if (norm) orphanedDrafts.push(norm);
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
        draftsByKey,
        orphanedDrafts,
      };
      this.recomputeStorageUsage();
      return structuredClone(this.state);
    } catch {
      this.state = emptyProjection();
      return structuredClone(this.state);
    }
  }

  getProjection(): ChatSessionProjection {
    this.ensureLoaded();
    this.recomputeStorageUsage();
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

  private syncSummaryFromDraft(
    connectionId: string,
    profileId: string,
    sessionId: string,
    draft: DraftRecord | null,
    originTitle?: string,
  ): void {
    const sumKey = makeSessionKey(connectionId, profileId, sessionId);
    const prev = this.state.sessionSummaries[sumKey];
    if (!draft) {
      if (prev) {
        this.state.sessionSummaries[sumKey] = {
          ...prev,
          hasDraft: false,
          draftText: undefined,
          annotations: undefined,
        };
      }
    } else {
      const hasText = draft.text.trim().length > 0;
      const hasAnnotations = Boolean(draft.annotations && draft.annotations.length > 0);
      const hasDraft = !isDraftRecordEmpty(draft);
      this.state.sessionSummaries[sumKey] = {
        connectionId,
        profileId,
        sessionId,
        title: originTitle ?? prev?.title ?? "新对话",
        ...(prev?.preview !== undefined ? { preview: prev.preview } : {}),
        ...(prev?.updatedAt !== undefined ? { updatedAt: prev.updatedAt } : {}),
        hasDraft,
        ...(hasText ? { draftText: draft.text } : {}),
        ...(hasAnnotations && draft.annotations ? { annotations: draft.annotations } : {}),
        ...(prev?.lastKnownMessages ? { lastKnownMessages: prev.lastKnownMessages } : {}),
      };
    }

    if (
      this.state.missingSession &&
      this.state.missingSession.connectionId === connectionId &&
      this.state.missingSession.profileId === profileId &&
      this.state.missingSession.sessionId === sessionId &&
      this.state.sessionSummaries[sumKey]
    ) {
      this.state.missingSession = { ...this.state.sessionSummaries[sumKey] };
    }
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
      const draftKey = makeActiveChatDraftKey(s.connectionId, s.profileId, s.sessionId);
      const existingDraft = this.state.draftsByKey?.[draftKey];
      if (existingDraft && existingDraft.origin.title !== s.title) {
        existingDraft.origin = { ...existingDraft.origin, title: s.title };
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

  saveDraftRecord(input: SaveDraftRecordInput): SaveDraftRecordResult {
    this.ensureLoaded();
    const connectionId = input.connectionId.trim();
    const profileId = input.profileId.trim() || "default";
    const sessionId = input.sessionId?.trim() || undefined;
    if (!connectionId || !profileId) {
      return { ok: true, draft: null, projection: this.getProjection() };
    }

    const draftsByKey = this.state.draftsByKey ?? {};
    this.state.draftsByKey = draftsByKey;

    const existingForSession = sessionId
      ? draftsByKey[makeActiveChatDraftKey(connectionId, profileId, sessionId)]
      : undefined;

    const draftId =
      existingForSession?.draftId ??
      (input.draftId?.trim() || this.nextId("draft"));

    const key = resolveDraftKey({
      connectionId,
      profileId,
      sessionId,
      draftId,
    });
    if (!key) {
      return { ok: true, draft: null, projection: this.getProjection() };
    }

    const existing = draftsByKey[key];
    const nextText = input.text !== undefined ? input.text : existing?.text ?? "";
    const nextAttachments =
      input.attachments !== undefined
        ? normalizeAttachments(input.attachments)
        : existing?.attachments ?? [];
    const nextContexts =
      input.contexts !== undefined
        ? normalizeContexts(input.contexts)
        : existing?.contexts ?? [];
    const nextComposer =
      input.composer !== undefined
        ? normalizeComposerState(input.composer)
        : existing?.composer ?? {};
    const nextAnnotations =
      input.annotations !== undefined
        ? normalizeAnnotations(input.annotations)
        : existing?.annotations;
    const nextDeliveryStatus =
      input.deliveryStatus !== undefined ? input.deliveryStatus : existing?.deliveryStatus;
    const summaryTitle = sessionId
      ? this.state.sessionSummaries[makeSessionKey(connectionId, profileId, sessionId)]?.title
      : undefined;
    const originTitle = input.originTitle ?? existing?.origin.title ?? summaryTitle;

    const candidate: DraftRecord = {
      draftId,
      ...(sessionId ? { sessionId } : {}),
      scope: { connectionId, profileId },
      text: nextText,
      attachments: nextAttachments,
      contexts: nextContexts,
      composer: nextComposer,
      ...(nextAnnotations ? { annotations: nextAnnotations } : {}),
      updatedAt: new Date(this.now()).toISOString(),
      revision: (existing?.revision ?? 0) + 1,
      origin: {
        connectionId,
        profileId,
        ...(sessionId ? { sessionId } : {}),
        ...(originTitle ? { title: originTitle } : {}),
      },
      ...(nextDeliveryStatus ? { deliveryStatus: nextDeliveryStatus } : {}),
    };

    if (isDraftRecordEmpty(candidate)) {
      if (existing) {
        delete draftsByKey[key];
      }
      if (sessionId) {
        this.syncSummaryFromDraft(connectionId, profileId, sessionId, null);
      }
      this.persist();
      return { ok: true, draft: null, projection: this.getProjection() };
    }

    const cap = checkDraftCapacity(
      candidate,
      draftsByKey,
      key,
      this.state.orphanedDrafts ?? [],
    );
    if (!cap.ok) {
      return {
        ok: false,
        reason: cap.reason,
        bytes: cap.bytes,
        limitBytes: cap.limitBytes,
        projection: this.getProjection(),
      };
    }

    draftsByKey[key] = candidate;
    if (sessionId) {
      this.syncSummaryFromDraft(connectionId, profileId, sessionId, candidate, originTitle);
    }
    this.persist();
    return {
      ok: true,
      draft: structuredClone(candidate),
      projection: this.getProjection(),
    };
  }

  saveDraft(
    ref: ActiveChatRef,
    text: string,
    options?: {
      annotations?: ArtifactAnnotation[];
      draftId?: string;
      attachments?: DraftAttachment[];
      contexts?: DraftContextItem[];
      composer?: DraftComposerState;
      deliveryStatus?: DraftDeliveryStatus;
    },
  ): ChatSessionProjection {
    const res = this.saveDraftRecord({
      connectionId: ref.connectionId,
      profileId: ref.profileId,
      sessionId: ref.sessionId,
      draftId: options?.draftId,
      text,
      ...(options?.annotations !== undefined ? { annotations: options.annotations } : {}),
      ...(options?.attachments !== undefined ? { attachments: options.attachments } : {}),
      ...(options?.contexts !== undefined ? { contexts: options.contexts } : {}),
      ...(options?.composer !== undefined ? { composer: options.composer } : {}),
      ...(options?.deliveryStatus !== undefined ? { deliveryStatus: options.deliveryStatus } : {}),
    });
    if (!res.ok) {
      const err = new Error(
        res.reason === "over_single_limit"
          ? getCopy("draft.capacityExceededSingle")
          : getCopy("draft.capacityExceededTotal"),
      );
      (err as { code?: string; reason?: string }).code =
        res.reason === "over_single_limit" ? "invalid_request" : "conflict";
      (err as { reason?: string }).reason = res.reason;
      throw err;
    }
    return res.projection;
  }

  migrateNewChatDraftToSession(input: {
    connectionId: string;
    profileId: string;
    draftId: string;
    sessionId: string;
    title?: string;
  }): { migrated: boolean; draft: DraftRecord | null; projection: ChatSessionProjection } {
    this.ensureLoaded();
    const connectionId = input.connectionId.trim();
    const profileId = input.profileId.trim() || "default";
    const draftId = input.draftId.trim();
    const sessionId = input.sessionId.trim();
    if (!connectionId || !profileId || !draftId || !sessionId) {
      return { migrated: false, draft: null, projection: this.getProjection() };
    }
    const draftsByKey = this.state.draftsByKey ?? {};
    this.state.draftsByKey = draftsByKey;

    const newKey = makeNewChatDraftKey(connectionId, profileId, draftId);
    const source = draftsByKey[newKey];
    if (!source) {
      return { migrated: false, draft: null, projection: this.getProjection() };
    }

    const chatKey = makeActiveChatDraftKey(connectionId, profileId, sessionId);
    const title = input.title?.trim() || source.origin.title;
    const migratedDraft: DraftRecord = {
      ...source,
      draftId: source.draftId, // preserve exact draftId
      sessionId,
      revision: source.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      origin: {
        connectionId,
        profileId,
        sessionId,
        ...(title ? { title } : {}),
      },
    };
    delete draftsByKey[newKey];
    draftsByKey[chatKey] = migratedDraft;
    this.syncSummaryFromDraft(connectionId, profileId, sessionId, migratedDraft, title);
    this.persist();
    return {
      migrated: true,
      draft: structuredClone(migratedDraft),
      projection: this.getProjection(),
    };
  }

  markDraftDeliveryStatus(
    ref: { connectionId: string; profileId: string; sessionId?: string; draftId?: string },
    deliveryStatus: DraftDeliveryStatus,
  ): ChatSessionProjection {
    this.ensureLoaded();
    const key = resolveDraftKey(ref);
    if (!key) return this.getProjection();
    const draftsByKey = this.state.draftsByKey ?? {};
    const existing = draftsByKey[key];
    if (!existing) return this.getProjection();
    draftsByKey[key] = {
      ...existing,
      deliveryStatus,
      revision: existing.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.persist();
    return this.getProjection();
  }

  clearDraftOnReceipt(
    ref: { connectionId: string; profileId: string; sessionId?: string; draftId?: string },
    receipt: string | null | undefined,
  ): { cleared: boolean; projection: ChatSessionProjection } {
    this.ensureLoaded();
    if (!shouldClearDraftForReceipt(receipt)) {
      return { cleared: false, projection: this.getProjection() };
    }
    const projection = this.clearDraftExplicit(ref);
    return { cleared: true, projection };
  }

  clearDraftExplicit(ref: {
    connectionId: string;
    profileId: string;
    sessionId?: string;
    draftId?: string;
  }): ChatSessionProjection {
    this.ensureLoaded();
    const key = resolveDraftKey(ref);
    const draftsByKey = this.state.draftsByKey ?? {};
    let changed = false;
    if (key && draftsByKey[key]) {
      delete draftsByKey[key];
      changed = true;
    }
    if (ref.sessionId?.trim()) {
      const sumKey = makeSessionKey(ref.connectionId, ref.profileId, ref.sessionId.trim());
      if (this.state.sessionSummaries[sumKey]?.hasDraft) {
        this.syncSummaryFromDraft(ref.connectionId, ref.profileId, ref.sessionId.trim(), null);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return this.getProjection();
  }

  markAttachmentExpired(
    ref: { connectionId: string; profileId: string; sessionId?: string; draftId?: string },
    attachmentIdOrHandle: string,
  ): ChatSessionProjection {
    this.ensureLoaded();
    const key = resolveDraftKey(ref);
    if (!key) return this.getProjection();
    const draftsByKey = this.state.draftsByKey ?? {};
    const existing = draftsByKey[key];
    if (!existing) return this.getProjection();
    let changed = false;
    const nextAttachments = existing.attachments.map((att) => {
      if (att.attachmentId === attachmentIdOrHandle || att.handle === attachmentIdOrHandle) {
        changed = true;
        return { ...att, expired: true };
      }
      return att;
    });
    if (!changed) return this.getProjection();
    draftsByKey[key] = {
      ...existing,
      attachments: nextAttachments,
      revision: existing.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.persist();
    return this.getProjection();
  }

  private createOrphanFromDraft(
    draft: DraftRecord,
    reason: OrphanedDraftReason,
    titleOverride?: string,
  ): OrphanedDraftRecord {
    return {
      orphanedId: this.nextId("orphan"),
      draftId: draft.draftId,
      text: draft.text,
      attachments: draft.attachments.map((att) => ({ ...att })),
      contexts: draft.contexts.map((ctx) => ({ ...ctx })),
      ...(draft.annotations ? { annotations: draft.annotations.map((ann) => ({ ...ann })) } : {}),
      origin: {
        ...draft.origin,
        ...(titleOverride ? { title: titleOverride } : {}),
      },
      reason,
      orphanedAt: new Date(this.now()).toISOString(),
    };
  }

  private pushOrphan(record: OrphanedDraftRecord): void {
    const list = this.state.orphanedDrafts ?? [];
    this.state.orphanedDrafts = [record, ...list];
  }

  orphanDraftsForRemovedSessions(
    scope: { connectionId: string; profileId: string },
    removedSessions: Array<{ sessionId: string; title?: string }>,
  ): OrphanedDraftRecord[] {
    this.ensureLoaded();
    const draftsByKey = this.state.draftsByKey ?? {};
    const created: OrphanedDraftRecord[] = [];
    for (const removed of removedSessions) {
      const sid = removed.sessionId.trim();
      if (!sid) continue;
      const draftKey = makeActiveChatDraftKey(scope.connectionId, scope.profileId, sid);
      const draft = draftsByKey[draftKey];
      const sumKey = makeSessionKey(scope.connectionId, scope.profileId, sid);
      const summary = this.state.sessionSummaries[sumKey];
      const title = removed.title ?? draft?.origin.title ?? summary?.title;
      if (draft && !isDraftRecordEmpty(draft)) {
        const orphan = this.createOrphanFromDraft(draft, "session_deleted", title);
        this.pushOrphan(orphan);
        created.push(orphan);
        delete draftsByKey[draftKey];
        this.syncSummaryFromDraft(scope.connectionId, scope.profileId, sid, null);
      } else if (summary?.hasDraft) {
        const fallbackDraft: DraftRecord = {
          draftId: this.nextId("draft"),
          sessionId: sid,
          scope: { connectionId: scope.connectionId, profileId: scope.profileId },
          text: summary.draftText ?? "",
          attachments: [],
          contexts: [],
          composer: {},
          ...(summary.annotations ? { annotations: summary.annotations } : {}),
          updatedAt: new Date(this.now()).toISOString(),
          revision: 1,
          origin: {
            connectionId: scope.connectionId,
            profileId: scope.profileId,
            sessionId: sid,
            ...(title ? { title } : {}),
          },
        };
        const orphan = this.createOrphanFromDraft(fallbackDraft, "session_deleted", title);
        this.pushOrphan(orphan);
        created.push(orphan);
        this.syncSummaryFromDraft(scope.connectionId, scope.profileId, sid, null);
      }
    }
    if (created.length > 0) {
      this.persist();
    }
    return created.map((item) => structuredClone(item));
  }

  orphanDraftsForRemovedProfile(connectionId: string, profileId: string): OrphanedDraftRecord[] {
    this.ensureLoaded();
    const draftsByKey = this.state.draftsByKey ?? {};
    const created: OrphanedDraftRecord[] = [];
    for (const [key, draft] of Object.entries({ ...draftsByKey })) {
      if (draft.scope.connectionId === connectionId && draft.scope.profileId === profileId) {
        if (!isDraftRecordEmpty(draft)) {
          const orphan = this.createOrphanFromDraft(draft, "profile_removed");
          this.pushOrphan(orphan);
          created.push(orphan);
        }
        delete draftsByKey[key];
        if (draft.sessionId) {
          this.syncSummaryFromDraft(connectionId, profileId, draft.sessionId, null);
        }
      }
    }
    if (created.length > 0) {
      this.persist();
    }
    return created.map((item) => structuredClone(item));
  }

  orphanDraftsForRemovedConnection(connectionId: string): OrphanedDraftRecord[] {
    this.ensureLoaded();
    const draftsByKey = this.state.draftsByKey ?? {};
    const created: OrphanedDraftRecord[] = [];
    for (const [key, draft] of Object.entries({ ...draftsByKey })) {
      if (draft.scope.connectionId === connectionId) {
        if (!isDraftRecordEmpty(draft)) {
          const orphan = this.createOrphanFromDraft(draft, "connection_removed");
          this.pushOrphan(orphan);
          created.push(orphan);
        }
        delete draftsByKey[key];
        if (draft.sessionId) {
          this.syncSummaryFromDraft(connectionId, draft.scope.profileId, draft.sessionId, null);
        }
      }
    }
    if (created.length > 0) {
      this.persist();
    }
    return created.map((item) => structuredClone(item));
  }

  deleteOrphanedDraft(orphanedId: string): ChatSessionProjection {
    this.ensureLoaded();
    const prev = this.state.orphanedDrafts ?? [];
    const next = prev.filter((item) => item.orphanedId !== orphanedId);
    if (next.length !== prev.length) {
      this.state.orphanedDrafts = next;
      this.persist();
    }
    return this.getProjection();
  }

  exportOrphanedDraft(orphanedId: string): DraftExportBundle | null {
    this.ensureLoaded();
    const target = (this.state.orphanedDrafts ?? []).find((item) => item.orphanedId === orphanedId);
    if (!target) return null;
    return buildOrphanedDraftExport(target, new Date(this.now()).toISOString());
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
    const currentDraftKey =
      current?.sessionId
        ? makeActiveChatDraftKey(current.connectionId, current.profileId, current.sessionId)
        : null;
    const hasDraft = Boolean(
      (currentKey && this.state.sessionSummaries[currentKey]?.hasDraft) ||
        (currentDraftKey &&
          this.state.draftsByKey?.[currentDraftKey] &&
          !isDraftRecordEmpty(this.state.draftsByKey[currentDraftKey])),
    );

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

  private hasMissingSessionOrphan(connectionId: string, profileId: string, sessionId: string): boolean {
    return (this.state.orphanedDrafts ?? []).some(
      (o) =>
        o.origin.connectionId === connectionId &&
        o.origin.profileId === profileId &&
        o.origin.sessionId === sessionId &&
        (o.reason === "session_missing_exported" || o.reason === "session_missing_closed"),
    );
  }

  exportMissingSession(sessionRef?: ActiveChatRef): MissingSessionExport | null {
    this.ensureLoaded();
    const target = sessionRef ?? this.state.missingSession ?? this.state.lastActiveChat;
    if (!target || !target.sessionId) return null;
    const key = makeSessionKey(target.connectionId, target.profileId, target.sessionId);
    const summary = this.state.sessionSummaries[key] ?? this.state.missingSession;
    const draftKey = makeActiveChatDraftKey(target.connectionId, target.profileId, target.sessionId);
    const draft = this.state.draftsByKey?.[draftKey];

    const draftText = draft?.text ?? summary?.draftText ?? "";
    const annotations = draft?.annotations ?? summary?.annotations;
    const attachments = draft?.attachments;
    const contexts = draft?.contexts;

    // Preserve into OrphanedDrafts on missing-session export without duplicating
    const hasAnyDraft =
      (draft && !isDraftRecordEmpty(draft)) ||
      Boolean(draftText.trim()) ||
      Boolean(annotations && annotations.length > 0);
    if (
      hasAnyDraft &&
      !this.hasMissingSessionOrphan(target.connectionId, target.profileId, target.sessionId)
    ) {
      const sourceDraft: DraftRecord = draft ?? {
        draftId: this.nextId("draft"),
        sessionId: target.sessionId,
        scope: { connectionId: target.connectionId, profileId: target.profileId },
        text: draftText,
        attachments: [],
        contexts: [],
        composer: {},
        ...(annotations ? { annotations } : {}),
        updatedAt: new Date(this.now()).toISOString(),
        revision: 1,
        origin: {
          connectionId: target.connectionId,
          profileId: target.profileId,
          sessionId: target.sessionId,
          title: summary?.title ?? "已移除的 Session",
        },
      };
      this.pushOrphan(
        this.createOrphanFromDraft(sourceDraft, "session_missing_exported", summary?.title),
      );
      if (draft && this.state.draftsByKey) {
        delete this.state.draftsByKey[draftKey];
      }
      this.persist();
    }

    return {
      exportedAt: new Date(this.now()).toISOString(),
      windowId: "primary",
      paneId: "main",
      scope: {
        connectionId: target.connectionId,
        profileId: target.profileId,
        sessionId: target.sessionId,
      },
      sessionTitle: summary?.title ?? "已移除的 Session",
      draftText,
      ...(annotations ? { annotations } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(contexts && contexts.length > 0 ? { contexts } : {}),
      messages: summary?.lastKnownMessages ?? [],
    };
  }

  dismissMissingSession(sessions: SessionSummary[]): ChatSessionProjection {
    this.ensureLoaded();
    const missing = this.state.missingSession ?? this.state.lastActiveChat;
    if (missing?.sessionId) {
      const key = makeSessionKey(missing.connectionId, missing.profileId, missing.sessionId);
      const draftKey = makeActiveChatDraftKey(
        missing.connectionId,
        missing.profileId,
        missing.sessionId,
      );
      const prev = this.state.sessionSummaries[key] ?? this.state.missingSession;
      const draft = this.state.draftsByKey?.[draftKey];
      const hasAnyDraft =
        (draft && !isDraftRecordEmpty(draft)) ||
        Boolean(prev?.hasDraft);

      if (
        hasAnyDraft &&
        !this.hasMissingSessionOrphan(missing.connectionId, missing.profileId, missing.sessionId)
      ) {
        const sourceDraft: DraftRecord = draft ?? {
          draftId: this.nextId("draft"),
          sessionId: missing.sessionId,
          scope: { connectionId: missing.connectionId, profileId: missing.profileId },
          text: prev?.draftText ?? "",
          attachments: [],
          contexts: [],
          composer: {},
          ...(prev?.annotations ? { annotations: prev.annotations } : {}),
          updatedAt: new Date(this.now()).toISOString(),
          revision: 1,
          origin: {
            connectionId: missing.connectionId,
            profileId: missing.profileId,
            sessionId: missing.sessionId,
            title: prev?.title ?? "已移除的 Session",
          },
        };
        this.pushOrphan(
          this.createOrphanFromDraft(sourceDraft, "session_missing_closed", prev?.title),
        );
      }
      if (this.state.draftsByKey?.[draftKey]) {
        delete this.state.draftsByKey[draftKey];
      }
      if (this.state.sessionSummaries[key]) {
        this.syncSummaryFromDraft(missing.connectionId, missing.profileId, missing.sessionId, null);
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

  /**
   * Non-destructively migrates a persisted local handle alias (e.g. `"default"`) to its
   * canonical Gateway `profileId` when the alias is retired after connect. Never overwrites
   * existing entries for `canonicalProfileId`.
   */
  adoptLocalProfileAlias(fromHandle: string, canonicalProfileId: string): boolean {
    this.ensureLoaded();
    const from = fromHandle.trim();
    const to = canonicalProfileId.trim();
    if (!from || !to || from === to) return false;

    let changed = false;
    if (
      this.state.lastActiveChat &&
      this.state.lastActiveChat.connectionId === "local" &&
      this.state.lastActiveChat.profileId === from
    ) {
      this.state.lastActiveChat = { ...this.state.lastActiveChat, profileId: to };
      changed = true;
    }

    if (this.state.lastValidProfileByConnection.local === from) {
      this.state.lastValidProfileByConnection.local = to;
      changed = true;
    }

    const fromScopeKey = makeScopeKey("local", from);
    const toScopeKey = makeScopeKey("local", to);
    if (this.state.lastSessionByScope[fromScopeKey]) {
      if (!this.state.lastSessionByScope[toScopeKey]) {
        this.state.lastSessionByScope[toScopeKey] = this.state.lastSessionByScope[fromScopeKey];
      }
      delete this.state.lastSessionByScope[fromScopeKey];
      changed = true;
    }

    const hadFromScope = this.state.lastValidScopes.some(
      (s) => s.connectionId === "local" && s.profileId === from,
    );
    if (hadFromScope) {
      const hasToScope = this.state.lastValidScopes.some(
        (s) => s.connectionId === "local" && s.profileId === to,
      );
      this.state.lastValidScopes = this.state.lastValidScopes.flatMap((s) => {
        if (s.connectionId === "local" && s.profileId === from) {
          return hasToScope ? [] : [{ connectionId: "local", profileId: to }];
        }
        return [s];
      });
      changed = true;
    }

    const prefix = `local::${from}::`;
    for (const [k, summary] of Object.entries(this.state.sessionSummaries)) {
      if (!k.startsWith(prefix)) continue;
      const nextKey = makeSessionKey("local", to, summary.sessionId);
      if (!this.state.sessionSummaries[nextKey]) {
        this.state.sessionSummaries[nextKey] = { ...summary, profileId: to };
      }
      delete this.state.sessionSummaries[k];
      changed = true;
    }

    if (this.state.draftsByKey) {
      for (const [k, draft] of Object.entries(this.state.draftsByKey)) {
        if (draft.scope.connectionId !== "local" || draft.scope.profileId !== from) continue;
        const nextKey = draft.sessionId
          ? makeActiveChatDraftKey("local", to, draft.sessionId)
          : makeNewChatDraftKey("local", to, draft.draftId);
        if (!this.state.draftsByKey[nextKey]) {
          this.state.draftsByKey[nextKey] = {
            ...draft,
            scope: { connectionId: "local", profileId: to },
            origin:
              draft.origin.connectionId === "local" && draft.origin.profileId === from
                ? { ...draft.origin, profileId: to }
                : draft.origin,
          };
        }
        delete this.state.draftsByKey[k];
        changed = true;
      }
    }

    if (changed) {
      this.persist();
    }
    return changed;
  }
}
