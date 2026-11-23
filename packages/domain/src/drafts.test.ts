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
  });

  it("enforces 1 MiB single draft limit and 50 MiB total drafts limit via UTF-8 byte measurement", () => {
    expect(DRAFT_MAX_BYTES).toBe(1024 * 1024);
    expect(DRAFTS_TOTAL_MAX_BYTES).toBe(50 * 1024 * 1024);

    const small = makeDraft({ text: "small" });
    const smallCheck = checkDraftCapacity(small, {}, "chat::local::default::sess-1");
    expect(smallCheck.ok).toBe(true);

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
    expect(hasExpiredAttachments(d1)).toBe(true);
    expect(hasExpiredAttachments(d2)).toBe(false);

    const activeExport = buildActiveDraftExport(d1, "2026-11-23T11:00:00.000Z");
    expect(activeExport.kind).toBe("active_draft");
    expect(activeExport.attachments[0]?.displayName).toBe("diagram.png");

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
  });
});
