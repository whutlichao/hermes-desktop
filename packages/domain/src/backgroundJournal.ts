import type {
  AttentionAggregation,
  AttentionTarget,
  BridgeScope,
  SessionPinnedReasons,
  SessionSummary,
  TranscriptPatchPayload,
} from "@hermes/contracts";

export const BACKGROUND_JOURNAL_MAX_EVENTS = 2_000 as const;
export const BACKGROUND_JOURNAL_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
export const BACKGROUND_JOURNAL_MAX_PER_SCOPE = 16 as const;
export const BACKGROUND_JOURNAL_MAX_GLOBAL = 64 as const;

export type BackgroundJournalEventKind =
  | "token_delta"
  | "assistant_message"
  | "turn_boundary"
  | "tool_result_summary"
  | "tool_running"
  | "input_required"
  | "other";

export type BackgroundJournalResyncReason =
  | "event_limit"
  | "byte_limit"
  | "gap"
  | "lru_evicted"
  | "scope_cap"
  | "global_cap"
  | "reconnect";

export interface BackgroundJournalBufferedEvent {
  kind: BackgroundJournalEventKind;
  gatewaySeq?: number;
  byteSize: number;
  patch: TranscriptPatchPayload;
}

export interface BackgroundJournalEntrySnapshot {
  key: string;
  connectionId: string;
  profileId: string;
  sessionId: string;
  scopeKey: string;
  events: BackgroundJournalBufferedEvent[];
  eventCount: number;
  totalBytes: number;
  resyncRequired: boolean;
  resyncReason?: BackgroundJournalResyncReason;
  lastGatewaySeq: number | null;
  progressSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  pinnedFlags: SessionPinnedReasons;
  pinned: boolean;
}

export interface RecordJournalEventInput {
  kind: BackgroundJournalEventKind;
  gatewaySeq?: number;
  countsAsUnread?: boolean;
  isWindowFocused?: boolean;
  isViewingSession?: boolean;
  patch?: TranscriptPatchPayload;
  byteSize?: number;
}

export interface RecordJournalEventResult {
  resyncRequired: boolean;
  reason?: BackgroundJournalResyncReason;
  unreadCount: number;
  pinned: boolean;
}

interface MutableJournalEntry {
  key: string;
  connectionId: string;
  profileId: string;
  sessionId: string;
  scopeKey: string;
  events: BackgroundJournalBufferedEvent[];
  totalBytes: number;
  resyncRequired: boolean;
  resyncReason?: BackgroundJournalResyncReason;
  lastGatewaySeq: number | null;
  progressSeq: number;
  lastReadSeq: number;
  pinnedFlags: SessionPinnedReasons;
}

export function makeScopeJournalKey(connectionId: string, profileId: string): string {
  return `${connectionId}::${profileId}`;
}

export function makeSessionJournalKey(
  connectionId: string,
  profileId: string,
  sessionId: string,
): string {
  return `${connectionId}::${profileId}::${sessionId}`;
}

export function parseSessionJournalKey(key: string): {
  connectionId: string;
  profileId: string;
  sessionId: string;
} {
  const parts = key.split("::");
  return {
    connectionId: parts[0] ?? "",
    profileId: parts[1] ?? "default",
    sessionId: parts.slice(2).join("::"),
  };
}

export function isUserVisibleProgressKind(kind: BackgroundJournalEventKind): boolean {
  return (
    kind === "assistant_message" ||
    kind === "turn_boundary" ||
    kind === "tool_result_summary"
  );
}

/**
 * Pure TypeScript UTF-8 byte counter (no Node Buffer dependency for domain purity).
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function computeSessionPinned(reasons: SessionPinnedReasons, unreadCount: number): boolean {
  return Boolean(
    reasons.runningTurn ||
      reasons.pendingInput ||
      unreadCount > 0 ||
      reasons.unread ||
      reasons.queuedAdmission ||
      reasons.explicit,
  );
}

export interface BackgroundJournalManagerOptions {
  maxEventsPerSession?: number;
  maxBytesPerSession?: number;
  maxSessionsPerScope?: number;
  maxSessionsGlobal?: number;
}

/**
 * Main-owned bounded background session journal, LRU evictor, and unread tracker.
 */
export class BackgroundJournalManager {
  private readonly maxEventsPerSession: number;
  private readonly maxBytesPerSession: number;
  private readonly maxSessionsPerScope: number;
  private readonly maxSessionsGlobal: number;
  private readonly entries = new Map<string, MutableJournalEntry>();
  /**
   * Keys currently holding buffered events, ordered from LRU (head) to MRU (tail).
   */
  private readonly bufferedOrder = new Set<string>();

  constructor(options: BackgroundJournalManagerOptions = {}) {
    this.maxEventsPerSession = options.maxEventsPerSession ?? BACKGROUND_JOURNAL_MAX_EVENTS;
    this.maxBytesPerSession = options.maxBytesPerSession ?? BACKGROUND_JOURNAL_MAX_BYTES;
    this.maxSessionsPerScope = options.maxSessionsPerScope ?? BACKGROUND_JOURNAL_MAX_PER_SCOPE;
    this.maxSessionsGlobal = options.maxSessionsGlobal ?? BACKGROUND_JOURNAL_MAX_GLOBAL;
  }

  private getOrCreateEntry(key: string): MutableJournalEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const { connectionId, profileId, sessionId } = parseSessionJournalKey(key);
    const created: MutableJournalEntry = {
      key,
      connectionId,
      profileId,
      sessionId,
      scopeKey: makeScopeJournalKey(connectionId, profileId),
      events: [],
      totalBytes: 0,
      resyncRequired: false,
      lastGatewaySeq: null,
      progressSeq: 0,
      lastReadSeq: 0,
      pinnedFlags: {},
    };
    this.entries.set(key, created);
    return created;
  }

  private getUnreadCount(entry: MutableJournalEntry): number {
    return Math.max(0, entry.progressSeq - entry.lastReadSeq);
  }

  private isEntryPinned(entry: MutableJournalEntry): boolean {
    return computeSessionPinned(entry.pinnedFlags, this.getUnreadCount(entry));
  }

  private touchBufferedOrder(key: string): void {
    this.bufferedOrder.delete(key);
    this.bufferedOrder.add(key);
  }

  private dropBufferedBuffer(entry: MutableJournalEntry, reason?: BackgroundJournalResyncReason): void {
    entry.events = [];
    entry.totalBytes = 0;
    this.bufferedOrder.delete(entry.key);
    if (reason) {
      entry.resyncRequired = true;
      entry.resyncReason = reason;
    }
  }

  private countBufferedInScope(scopeKey: string): number {
    let count = 0;
    for (const key of this.bufferedOrder) {
      const entry = this.entries.get(key);
      if (entry && entry.scopeKey === scopeKey) {
        count += 1;
      }
    }
    return count;
  }

  private findOldestUnpinnedBuffered(scopeKey?: string): MutableJournalEntry | null {
    for (const key of this.bufferedOrder) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (scopeKey && entry.scopeKey !== scopeKey) continue;
      if (!this.isEntryPinned(entry)) {
        return entry;
      }
    }
    return null;
  }

  recordEvent(key: string, input: RecordJournalEventInput): RecordJournalEventResult {
    const entry = this.getOrCreateEntry(key);
    const countsAsUnread = input.countsAsUnread ?? isUserVisibleProgressKind(input.kind);

    if (countsAsUnread) {
      entry.progressSeq += 1;
      if (input.isWindowFocused && input.isViewingSession) {
        entry.lastReadSeq = entry.progressSeq;
      }
    }

    const unreadCount = this.getUnreadCount(entry);
    entry.pinnedFlags.unread = unreadCount > 0;
    const pinned = this.isEntryPinned(entry);

    if (typeof input.gatewaySeq === "number") {
      if (entry.lastGatewaySeq !== null && input.gatewaySeq > entry.lastGatewaySeq + 1) {
        entry.lastGatewaySeq = input.gatewaySeq;
        this.dropBufferedBuffer(entry, "gap");
        return { resyncRequired: true, reason: "gap", unreadCount, pinned };
      }
      entry.lastGatewaySeq =
        entry.lastGatewaySeq === null ? input.gatewaySeq : Math.max(entry.lastGatewaySeq, input.gatewaySeq);
    }

    if (!input.patch) {
      return {
        resyncRequired: entry.resyncRequired,
        reason: entry.resyncReason,
        unreadCount,
        pinned,
      };
    }

    if (entry.resyncRequired) {
      return {
        resyncRequired: true,
        reason: entry.resyncReason,
        unreadCount,
        pinned,
      };
    }

    if (!this.bufferedOrder.has(key)) {
      if (this.countBufferedInScope(entry.scopeKey) >= this.maxSessionsPerScope) {
        const victim = this.findOldestUnpinnedBuffered(entry.scopeKey);
        if (!victim) {
          this.dropBufferedBuffer(entry, "scope_cap");
          return { resyncRequired: true, reason: "scope_cap", unreadCount, pinned };
        }
        this.dropBufferedBuffer(victim, "lru_evicted");
      }

      if (this.bufferedOrder.size >= this.maxSessionsGlobal) {
        const victim = this.findOldestUnpinnedBuffered();
        if (!victim) {
          this.dropBufferedBuffer(entry, "global_cap");
          return { resyncRequired: true, reason: "global_cap", unreadCount, pinned };
        }
        this.dropBufferedBuffer(victim, "lru_evicted");
      }
    }

    const eventByteSize =
      typeof input.byteSize === "number" ? input.byteSize : utf8ByteLength(JSON.stringify(input.patch));
    const nextEventCount = entry.events.length + 1;
    const nextTotalBytes = entry.totalBytes + eventByteSize;

    if (nextEventCount > this.maxEventsPerSession) {
      this.dropBufferedBuffer(entry, "event_limit");
      return { resyncRequired: true, reason: "event_limit", unreadCount, pinned };
    }
    if (nextTotalBytes > this.maxBytesPerSession) {
      this.dropBufferedBuffer(entry, "byte_limit");
      return { resyncRequired: true, reason: "byte_limit", unreadCount, pinned };
    }

    entry.events.push({
      kind: input.kind,
      ...(typeof input.gatewaySeq === "number" ? { gatewaySeq: input.gatewaySeq } : {}),
      byteSize: eventByteSize,
      patch: input.patch,
    });
    entry.totalBytes = nextTotalBytes;
    this.touchBufferedOrder(key);

    return {
      resyncRequired: false,
      unreadCount,
      pinned,
    };
  }

  setPinnedFlags(key: string, partial: Partial<SessionPinnedReasons>): BackgroundJournalEntrySnapshot {
    const entry = this.getOrCreateEntry(key);
    entry.pinnedFlags = {
      ...entry.pinnedFlags,
      ...partial,
      unread: this.getUnreadCount(entry) > 0,
    };
    return this.toSnapshot(entry);
  }

  markRead(key: string): BackgroundJournalEntrySnapshot {
    const entry = this.getOrCreateEntry(key);
    entry.lastReadSeq = entry.progressSeq;
    entry.pinnedFlags = {
      ...entry.pinnedFlags,
      unread: false,
    };
    return this.toSnapshot(entry);
  }

  seedInitialUnread(key: string, initialUnreadCount: number): BackgroundJournalEntrySnapshot {
    const entry = this.getOrCreateEntry(key);
    const safeCount = Math.max(0, Math.floor(initialUnreadCount));
    if (safeCount > entry.progressSeq - entry.lastReadSeq) {
      entry.progressSeq = entry.lastReadSeq + safeCount;
    }
    entry.pinnedFlags = {
      ...entry.pinnedFlags,
      unread: this.getUnreadCount(entry) > 0,
    };
    return this.toSnapshot(entry);
  }

  markResyncRequired(key: string, reason: BackgroundJournalResyncReason = "reconnect"): void {
    const entry = this.getOrCreateEntry(key);
    this.dropBufferedBuffer(entry, reason);
  }

  clearResyncAndBuffer(key: string, gatewaySeq?: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.resyncRequired = false;
    entry.resyncReason = undefined;
    entry.events = [];
    entry.totalBytes = 0;
    this.bufferedOrder.delete(key);
    if (typeof gatewaySeq === "number") {
      entry.lastGatewaySeq = gatewaySeq;
    }
  }

  dropBufferOnly(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.events = [];
    entry.totalBytes = 0;
    this.bufferedOrder.delete(key);
  }

  getState(key: string): BackgroundJournalEntrySnapshot | undefined {
    const entry = this.entries.get(key);
    return entry ? this.toSnapshot(entry) : undefined;
  }

  clear(): void {
    this.entries.clear();
    this.bufferedOrder.clear();
  }

  stats(): {
    totalBufferedSessions: number;
    totalBufferedBytes: number;
    scopeCounts: Record<string, number>;
  } {
    const scopeCounts: Record<string, number> = {};
    let totalBufferedBytes = 0;
    for (const key of this.bufferedOrder) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      scopeCounts[entry.scopeKey] = (scopeCounts[entry.scopeKey] ?? 0) + 1;
      totalBufferedBytes += entry.totalBytes;
    }
    return {
      totalBufferedSessions: this.bufferedOrder.size,
      totalBufferedBytes,
      scopeCounts,
    };
  }

  private toSnapshot(entry: MutableJournalEntry): BackgroundJournalEntrySnapshot {
    const unreadCount = this.getUnreadCount(entry);
    const pinnedFlags: SessionPinnedReasons = {
      ...entry.pinnedFlags,
      unread: unreadCount > 0,
    };
    return {
      key: entry.key,
      connectionId: entry.connectionId,
      profileId: entry.profileId,
      sessionId: entry.sessionId,
      scopeKey: entry.scopeKey,
      events: [...entry.events],
      eventCount: entry.events.length,
      totalBytes: entry.totalBytes,
      resyncRequired: entry.resyncRequired,
      ...(entry.resyncReason ? { resyncReason: entry.resyncReason } : {}),
      lastGatewaySeq: entry.lastGatewaySeq,
      progressSeq: entry.progressSeq,
      lastReadSeq: entry.lastReadSeq,
      unreadCount,
      pinnedFlags,
      pinned: computeSessionPinned(pinnedFlags, unreadCount),
    };
  }
}

export function aggregateAttentionState(
  sessions: readonly SessionSummary[],
  activeScope: BridgeScope | null,
  activeSessionId: string | null,
): AttentionAggregation {
  let totalUnread = 0;
  let totalNeedsInput = 0;
  let backgroundUnread = 0;
  let backgroundNeedsInput = 0;
  const needsInputTargets: AttentionTarget[] = [];
  const unreadTargets: AttentionTarget[] = [];

  for (const session of sessions) {
    const isActive = Boolean(
      activeScope &&
        session.connectionId === activeScope.connectionId &&
        session.profileId === (activeScope.profileId ?? "default") &&
        session.sessionId === (activeSessionId ?? activeScope.sessionId ?? null),
    );
    const unreadCount = Math.max(0, session.unreadCount || 0);
    const needsInput = Boolean(session.needsInput);
    totalUnread += unreadCount;
    if (needsInput) {
      totalNeedsInput += 1;
    }
    if (!isActive) {
      backgroundUnread += unreadCount;
      if (needsInput) {
        backgroundNeedsInput += 1;
      }
    }

    const target: AttentionTarget = {
      connectionId: session.connectionId,
      profileId: session.profileId,
      sessionId: session.sessionId,
      title: session.title,
      unreadCount,
      needsInput,
      isActive,
    };
    if (needsInput) {
      needsInputTargets.push(target);
    }
    if (unreadCount > 0) {
      unreadTargets.push(target);
    }
  }

  const pickFirstBackgroundOrAny = (list: AttentionTarget[]): AttentionTarget | null =>
    list.find((t) => !t.isActive) ?? list[0] ?? null;

  const primaryTarget =
    pickFirstBackgroundOrAny(needsInputTargets) ?? pickFirstBackgroundOrAny(unreadTargets);

  return {
    totalUnread,
    totalNeedsInput,
    backgroundUnread,
    backgroundNeedsInput,
    needsInputTargets,
    unreadTargets,
    primaryTarget,
  };
}
