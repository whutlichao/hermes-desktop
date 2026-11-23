import {
  DRAFT_MAX_BYTES,
  DRAFTS_TOTAL_MAX_BYTES,
  type DraftExportBundle,
  type DraftRecord,
  type OrphanedDraftRecord,
} from "@hermes/contracts";

const utf8Encoder = new TextEncoder();

export function makeActiveChatDraftKey(
  connectionId: string,
  profileId: string,
  sessionId: string,
): string {
  return `chat::${connectionId}::${profileId}::${sessionId}`;
}

export function makeNewChatDraftKey(
  connectionId: string,
  profileId: string,
  draftId: string,
): string {
  return `new::${connectionId}::${profileId}::${draftId}`;
}

export function resolveDraftKey(ref: {
  connectionId: string;
  profileId: string;
  sessionId?: string;
  draftId?: string;
}): string | null {
  const connectionId = ref.connectionId.trim();
  const profileId = ref.profileId.trim();
  if (!connectionId || !profileId) return null;
  const sessionId = ref.sessionId?.trim();
  if (sessionId) {
    return makeActiveChatDraftKey(connectionId, profileId, sessionId);
  }
  const draftId = ref.draftId?.trim();
  if (draftId) {
    return makeNewChatDraftKey(connectionId, profileId, draftId);
  }
  return null;
}

export function shouldClearDraftForReceipt(receipt: string | null | undefined): boolean {
  return receipt === "accepted" || receipt === "admitted";
}

export function isDraftRecordEmpty(
  draft: Pick<DraftRecord, "text" | "attachments" | "contexts" | "annotations" | "deliveryStatus">,
): boolean {
  if (draft.deliveryStatus === "delivery_unknown") return false;
  if (draft.text.trim().length > 0) return false;
  if (draft.attachments.length > 0) return false;
  if (draft.contexts.length > 0) return false;
  if (draft.annotations && draft.annotations.length > 0) return false;
  return true;
}

export function measureDraftBytes(draft: DraftRecord | OrphanedDraftRecord): number {
  return utf8Encoder.encode(JSON.stringify(draft)).byteLength;
}

export function measureTotalDraftsBytes(
  draftsByKey: Record<string, DraftRecord>,
  orphanedDrafts: readonly OrphanedDraftRecord[] = [],
): number {
  let total = 0;
  for (const draft of Object.values(draftsByKey)) {
    total += measureDraftBytes(draft);
  }
  for (const orphan of orphanedDrafts) {
    total += measureDraftBytes(orphan);
  }
  return total;
}

export type DraftCapacityCheckResult =
  | { ok: true; draftBytes: number; totalBytes: number }
  | {
      ok: false;
      reason: "over_single_limit" | "over_total_limit";
      bytes: number;
      limitBytes: number;
    };

export function checkDraftCapacity(
  candidate: DraftRecord,
  existingDraftsByKey: Record<string, DraftRecord>,
  candidateKey: string,
  orphanedDrafts: readonly OrphanedDraftRecord[] = [],
): DraftCapacityCheckResult {
  const draftBytes = measureDraftBytes(candidate);
  if (draftBytes > DRAFT_MAX_BYTES) {
    return {
      ok: false,
      reason: "over_single_limit",
      bytes: draftBytes,
      limitBytes: DRAFT_MAX_BYTES,
    };
  }
  const nextMap: Record<string, DraftRecord> = {
    ...existingDraftsByKey,
    [candidateKey]: candidate,
  };
  const totalBytes = measureTotalDraftsBytes(nextMap, orphanedDrafts);
  if (totalBytes > DRAFTS_TOTAL_MAX_BYTES) {
    return {
      ok: false,
      reason: "over_total_limit",
      bytes: totalBytes,
      limitBytes: DRAFTS_TOTAL_MAX_BYTES,
    };
  }
  return {
    ok: true,
    draftBytes,
    totalBytes,
  };
}

export function findActiveChatDraft(
  draftsByKey: Record<string, DraftRecord> | undefined,
  scope: { connectionId: string; profileId?: string; sessionId?: string } | null | undefined,
  newChatDraftId?: string | null,
): DraftRecord | null {
  if (!draftsByKey || !scope?.connectionId) return null;
  const profileId = scope.profileId?.trim() || "default";
  if (scope.sessionId?.trim()) {
    return draftsByKey[makeActiveChatDraftKey(scope.connectionId, profileId, scope.sessionId.trim())] ?? null;
  }
  if (newChatDraftId?.trim()) {
    return draftsByKey[makeNewChatDraftKey(scope.connectionId, profileId, newChatDraftId.trim())] ?? null;
  }
  return null;
}

export function listScopeNewChatDrafts(
  draftsByKey: Record<string, DraftRecord> | undefined,
  scope: { connectionId: string; profileId?: string } | null | undefined,
): DraftRecord[] {
  if (!draftsByKey || !scope?.connectionId) return [];
  const profileId = scope.profileId?.trim() || "default";
  const prefix = `new::${scope.connectionId}::${profileId}::`;
  return Object.entries(draftsByKey)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, draft]) => draft)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function hasExpiredAttachments(
  draft: Pick<DraftRecord, "attachments"> | null | undefined,
): boolean {
  if (!draft?.attachments) return false;
  return draft.attachments.some((att) => Boolean(att.expired));
}

export function buildActiveDraftExport(draft: DraftRecord, exportedAt: string): DraftExportBundle {
  return {
    exportedAt,
    kind: "active_draft",
    draftId: draft.draftId,
    origin: { ...draft.origin },
    text: draft.text,
    attachments: draft.attachments.map((att) => ({ ...att })),
    contexts: draft.contexts.map((ctx) => ({ ...ctx })),
    ...(draft.annotations ? { annotations: draft.annotations.map((ann) => ({ ...ann })) } : {}),
  };
}

export function buildOrphanedDraftExport(
  record: OrphanedDraftRecord,
  exportedAt: string,
): DraftExportBundle {
  return {
    exportedAt,
    kind: "orphaned_draft",
    draftId: record.draftId,
    origin: { ...record.origin },
    text: record.text,
    attachments: record.attachments.map((att) => ({ ...att })),
    contexts: record.contexts.map((ctx) => ({ ...ctx })),
    ...(record.annotations ? { annotations: record.annotations.map((ann) => ({ ...ann })) } : {}),
    reason: record.reason,
    orphanedAt: record.orphanedAt,
  };
}
