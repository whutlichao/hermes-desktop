import { describe, expect, it } from "vitest";
import {
  DRAFT_MAX_BYTES,
  DRAFTS_TOTAL_MAX_BYTES,
  type DraftRecord,
  type OrphanedDraftRecord,
} from "@hermes/contracts";
import {
  buildActiveDraftExport,
  buildOrphanedDraftExport,
  checkDraftCapacity,
  findActiveChatDraft,
  hasExpiredAttachments,
  isDraftRecordEmpty,
  listScopeNewChatDrafts,
  makeActiveChatDraftKey,
  makeNewChatDraftKey,
  measureDraftBytes,
  measureTotalDraftsBytes,
  resolveDraftKey,
  shouldClearDraftForReceipt,
} from "./drafts";

function makeDraft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: "draft-1",
    sessionId: "sess-1",
    scope: { connectionId: "local", profileId: "default" },
    text: "hello world",
    attachments: [],
    contexts: [],
    composer: {},
    updatedAt: "2026-11-23T10:00:00.000Z",
    revision: 1,
    origin: { connectionId: "local", profileId: "default", sessionId: "sess-1" },
    ...overrides,
  };
}

describe("Drafts & OrphanedDrafts domain helpers (Ticket #38)", () => {
  it("keys ActiveChat drafts uniquely per session and new-chat drafts uniquely per Scope+draftId", () => {
    expect(makeActiveChatDraftKey("local", "default", "sess-1")).toBe("chat::local::default::sess-1");
    expect(makeNewChatDraftKey("local", "default", "draft-a")).toBe("new::local::default::draft-a");
    expect(
      resolveDraftKey({ connectionId: "local", profileId: "default", sessionId: "sess-1", draftId: "draft-a" }),
    ).toBe("chat::local::default::sess-1");
    expect(resolveDraftKey({ connectionId: "local", profileId: "default", draftId: "draft-a" })).toBe(
      "new::local::default::draft-a",
    );
    expect(resolveDraftKey({ connectionId: "local", profileId: "default" })).toBeNull();
    expect(resolveDraftKey({ connectionId: "  ", profileId: "default", draftId: "draft-a" })).toBeNull();
    expect(resolveDraftKey({ connectionId: "local", profileId: "  ", sessionId: "sess-1" })).toBeNull();
    expect(
      resolveDraftKey({ connectionId: " local ", profileId: " default ", sessionId: " sess-1 " }),
    ).toBe("chat::local::default::sess-1");
    expect(
      resolveDraftKey({ connectionId: "local", profileId: "default", sessionId: "   ", draftId: " draft-a " }),
    ).toBe("new::local::default::draft-a");
    expect(resolveDraftKey({ connectionId: "local", profileId: "default", draftId: "   " })).toBeNull();
  });

  it("clears draft ONLY on accepted or admitted receipt, never on optimistic or delivery_unknown", () => {
    expect(shouldClearDraftForReceipt("accepted")).toBe(true);
    expect(shouldClearDraftForReceipt("admitted")).toBe(true);
    expect(shouldClearDraftForReceipt("optimistic")).toBe(false);
    expect(shouldClearDraftForReceipt("delivery_unknown")).toBe(false);
    expect(shouldClearDraftForReceipt(null)).toBe(false);
    expect(shouldClearDraftForReceipt(undefined)).toBe(false);
  });

  it("treats drafts with text, attachments, contexts, annotations, or delivery_unknown as non-empty", () => {
    expect(
      isDraftRecordEmpty(makeDraft({ text: "   ", attachments: [], contexts: [], annotations: undefined })),
    ).toBe(true);
    expect(
      isDraftRecordEmpty(
        makeDraft({ text: "", attachments: [], contexts: [], annotations: [], deliveryStatus: undefined }),
      ),
    ).toBe(true);
    expect(isDraftRecordEmpty(makeDraft({ text: "  " }))).toBe(true);
    expect(isDraftRecordEmpty(makeDraft({ text: "有内容" }))).toBe(false);
    expect(
      isDraftRecordEmpty(
        makeDraft({
          text: "",
          attachments: [
            { attachmentId: "att-1", handle: "opaque://1", displayName: "spec.md", kind: "file" },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isDraftRecordEmpty(
        makeDraft({
          text: "",
          contexts: [{ contextId: "ctx-1", kind: "file", ref: "src/app.ts", label: "src/app.ts" }],
        }),
      ),
    ).toBe(false);
    expect(
      isDraftRecordEmpty(makeDraft({ text: "", deliveryStatus: "delivery_unknown" })),
    ).toBe(false);
    expect(
      isDraftRecordEmpty(
        makeDraft({
          text: "",
          annotations: [
            {
              annotationId: "ann-1",
              artifactId: "draft-artifact-1",
              artifactVersion: 1,
              artifactHash: "hash-1",
              xPct: 10,
              yPct: 20,
              comment: "检查边界",
              createdAt: "2026-11-23T10:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("enforces 1 MiB single draft limit and 50 MiB total drafts limit via UTF-8 byte measurement", () => {
    expect(DRAFT_MAX_BYTES).toBe(1024 * 1024);
    expect(DRAFTS_TOTAL_MAX_BYTES).toBe(50 * 1024 * 1024);

    const small = makeDraft({ text: "small" });
    const smallCheck = checkDraftCapacity(small, {}, "chat::local::default::sess-1");
    expect(smallCheck.ok).toBe(true);

    const orphan: OrphanedDraftRecord = {
      orphanedId: "orp-cap-1",
      draftId: "draft-orphan",
      text: "orphan capacity",
      attachments: [],
      contexts: [],
      origin: { connectionId: "local", profileId: "default" },
      reason: "session_deleted",
      orphanedAt: "2026-11-23T10:00:00.000Z",
    };
    expect(measureTotalDraftsBytes({}, [orphan])).toBe(measureDraftBytes(orphan));
    expect(checkDraftCapacity(small, {}, "chat::local::default::sess-1", [orphan]).ok).toBe(true);

    const oversized = makeDraft({ text: "x".repeat(DRAFT_MAX_BYTES + 1) });
    expect(measureDraftBytes(oversized)).toBeGreaterThan(DRAFT_MAX_BYTES);
    const overSingle = checkDraftCapacity(oversized, {}, "chat::local::default::sess-1");
    expect(overSingle).toMatchObject({
      ok: false,
      reason: "over_single_limit",
      limitBytes: DRAFT_MAX_BYTES,
    });

    // Simulate existing drafts consuming nearly 50 MiB and adding another valid draft that pushes total > 50 MiB
    const existing: Record<string, DraftRecord> = {};
    const bigValidText = "a".repeat(900 * 1024);
    for (let i = 0; i < 56; i += 1) {
      const k = `chat::local::default::s-${i}`;
      existing[k] = makeDraft({ draftId: `d-${i}`, sessionId: `s-${i}`, text: bigValidText });
    }
    const existingBytes = measureTotalDraftsBytes(existing);
    expect(existingBytes).toBeGreaterThan(49 * 1024 * 1024);

    const extra = makeDraft({ draftId: "d-new", sessionId: "s-new", text: "b".repeat(800 * 1024) });
    const overTotal = checkDraftCapacity(extra, existing, "chat::local::default::s-new");
    expect(overTotal).toMatchObject({
      ok: false,
      reason: "over_total_limit",
      limitBytes: DRAFTS_TOTAL_MAX_BYTES,
    });
  });

  it("finds ActiveChat vs Scope+draftId drafts and detects expired attachments & builds exports", () => {
    const d1 = makeDraft({
      draftId: "draft-chat",
      sessionId: "sess-1",
      attachments: [
        {
          attachmentId: "att-1",
          handle: "handle://expired-1",
          displayName: "diagram.png",
          kind: "image",
          expired: true,
        },
      ],
    });
    const d2 = makeDraft({
      draftId: "draft-new-1",
      sessionId: undefined,
      scope: { connectionId: "local", profileId: "ops" },
      origin: { connectionId: "local", profileId: "ops" },
      text: "new chat draft",
    });
    const map: Record<string, DraftRecord> = {
      [makeActiveChatDraftKey("local", "default", "sess-1")]: d1,
      [makeNewChatDraftKey("local", "ops", "draft-new-1")]: d2,
    };

    expect(findActiveChatDraft(map, { connectionId: "local", profileId: "default", sessionId: "sess-1" })).toEqual(d1);
    expect(
      findActiveChatDraft(map, { connectionId: "local", profileId: "ops" }, "draft-new-1"),
    ).toEqual(d2);
    expect(listScopeNewChatDrafts(map, { connectionId: "local", profileId: "ops" })).toEqual([d2]);
    expect(findActiveChatDraft(undefined, { connectionId: "local", profileId: "default" })).toBeNull();
    expect(findActiveChatDraft(map, null)).toBeNull();
    expect(findActiveChatDraft(map, { connectionId: "  " })).toBeNull();
    expect(
      findActiveChatDraft(map, { connectionId: "local", profileId: "ops" }, "missing-draft"),
    ).toBeNull();
    expect(
      findActiveChatDraft(map, { connectionId: "local", profileId: "ops", sessionId: "missing-session" }),
    ).toBeNull();
    expect(listScopeNewChatDrafts(undefined, { connectionId: "local" })).toEqual([]);
    expect(listScopeNewChatDrafts(map, null)).toEqual([]);
    expect(listScopeNewChatDrafts(map, { connectionId: "  " })).toEqual([]);
    expect(
      listScopeNewChatDrafts(
        {
          ...map,
          [makeNewChatDraftKey("local", "ops", "older")]: makeDraft({
            draftId: "older",
            sessionId: undefined,
            updatedAt: "2026-11-22T10:00:00.000Z",
          }),
        },
        { connectionId: "local", profileId: "ops" },
      ).map((d) => d.draftId),
    ).toEqual(["draft-new-1", "older"]);
    expect(hasExpiredAttachments(d1)).toBe(true);
    expect(hasExpiredAttachments(d2)).toBe(false);
    expect(hasExpiredAttachments(null)).toBe(false);
    expect(hasExpiredAttachments(undefined)).toBe(false);

    const activeExport = buildActiveDraftExport(d1, "2026-11-23T11:00:00.000Z");
    expect(activeExport.kind).toBe("active_draft");
    expect(activeExport.attachments[0]?.displayName).toBe("diagram.png");
    const annotatedActiveExport = buildActiveDraftExport(
      makeDraft({
        annotations: [
          {
            annotationId: "ann-1",
            artifactId: "draft-artifact-1",
            artifactVersion: 1,
            artifactHash: "hash-1",
            xPct: 10,
            yPct: 20,
            comment: "检查",
            createdAt: "2026-11-23T10:00:00.000Z",
          },
        ],
      }),
      "2026-11-23T11:00:00.000Z",
    );
    expect(annotatedActiveExport.annotations).toHaveLength(1);
    expect(
      buildActiveDraftExport(makeDraft({ annotations: undefined }), "2026-11-23T11:00:00.000Z"),
    ).not.toHaveProperty("annotations");

    const orphan: OrphanedDraftRecord = {
      orphanedId: "orp-1",
      draftId: "draft-chat",
      text: "orphan text",
      attachments: d1.attachments,
      contexts: [],
      origin: { connectionId: "remote-1", profileId: "prod", sessionId: "sess-9", title: "Prod Bug" },
      reason: "connection_removed",
      orphanedAt: "2026-11-23T11:05:00.000Z",
    };
    const orphanExport = buildOrphanedDraftExport(orphan, "2026-11-23T11:06:00.000Z");
    expect(orphanExport.kind).toBe("orphaned_draft");
    expect(orphanExport.reason).toBe("connection_removed");
    expect(orphanExport.origin.title).toBe("Prod Bug");
    const annotatedOrphanExport = buildOrphanedDraftExport(
      {
        ...orphan,
        annotations: [
          {
            annotationId: "ann-2",
            artifactId: "draft-artifact-1",
            artifactVersion: 1,
            artifactHash: "hash-1",
            xPct: 10,
            yPct: 20,
            comment: "恢复前检查",
            createdAt: "2026-11-23T11:00:00.000Z",
          },
        ],
      },
      "2026-11-23T11:06:00.000Z",
    );
    expect(annotatedOrphanExport.annotations).toHaveLength(1);
    expect(
      buildOrphanedDraftExport({ ...orphan, annotations: undefined }, "2026-11-23T11:06:00.000Z"),
    ).not.toHaveProperty("annotations");
  });
});
