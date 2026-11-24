import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/contracts";
import {
  aggregateAttentionState,
  BACKGROUND_JOURNAL_MAX_BYTES,
  BACKGROUND_JOURNAL_MAX_EVENTS,
  BACKGROUND_JOURNAL_MAX_GLOBAL,
  BACKGROUND_JOURNAL_MAX_PER_SCOPE,
  BackgroundJournalManager,
  makeSessionJournalKey,
} from "./backgroundJournal";

function scopeKey(connectionId = "conn-1", profileId = "default", sessionId = "sess-1") {
  return makeSessionJournalKey(connectionId, profileId, sessionId);
}

describe("BackgroundJournalManager", () => {
  it("exposes exact capacity constants from Ticket #37", () => {
    expect(BACKGROUND_JOURNAL_MAX_EVENTS).toBe(2_000);
    expect(BACKGROUND_JOURNAL_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(BACKGROUND_JOURNAL_MAX_PER_SCOPE).toBe(16);
    expect(BACKGROUND_JOURNAL_MAX_GLOBAL).toBe(64);
  });

  it("caps per-session journal at 2,000 events and flags resync_required on overflow", () => {
    const journal = new BackgroundJournalManager();
    const key = scopeKey("conn-1", "default", "sess-overflow-events");

    for (let i = 1; i <= 2_000; i += 1) {
      const result = journal.recordEvent(key, {
        kind: "token_delta",
        gatewaySeq: i,
        patch: { type: "token_delta", sessionId: "sess-overflow-events", messageId: "m1", delta: "a" },
      });
      expect(result.resyncRequired).toBe(false);
    }

    const before = journal.getState(key);
    expect(before?.eventCount).toBe(2_000);
    expect(before?.resyncRequired).toBe(false);

    const overflow = journal.recordEvent(key, {
      kind: "token_delta",
      gatewaySeq: 2_001,
      patch: { type: "token_delta", sessionId: "sess-overflow-events", messageId: "m1", delta: "b" },
    });
    expect(overflow.resyncRequired).toBe(true);
    expect(overflow.reason).toBe("event_limit");

    const after = journal.getState(key);
    expect(after?.resyncRequired).toBe(true);
    expect(after?.eventCount).toBe(0);
    expect(after?.totalBytes).toBe(0);
  });

  it("caps per-session journal at 4 MiB even when fewer than 2,000 events are buffered", () => {
    const journal = new BackgroundJournalManager();
    const key = scopeKey("conn-1", "default", "sess-overflow-bytes");
    const bigText = "x".repeat(512 * 1024); // ~512 KiB per event -> 9th event exceeds 4 MiB

    for (let i = 1; i <= 7; i += 1) {
      const res = journal.recordEvent(key, {
        kind: "token_delta",
        gatewaySeq: i,
        patch: { type: "token_delta", sessionId: "sess-overflow-bytes", messageId: "m1", delta: bigText },
      });
      expect(res.resyncRequired).toBe(false);
    }

    // 9th event definitely exceeds 4 MiB (9 * 512 KiB > 4 MiB)
    let overflowed = false;
    let lastReason: string | undefined;
    for (let i = 8; i <= 10; i += 1) {
      const res = journal.recordEvent(key, {
        kind: "token_delta",
        gatewaySeq: i,
        patch: { type: "token_delta", sessionId: "sess-overflow-bytes", messageId: "m1", delta: bigText },
      });
      if (res.resyncRequired) {
        overflowed = true;
        lastReason = res.reason;
        break;
      }
    }

    expect(overflowed).toBe(true);
    expect(lastReason).toBe("byte_limit");
    const state = journal.getState(key);
    expect(state?.resyncRequired).toBe(true);
    expect(state?.totalBytes).toBe(0);
  });

  it("triggers resync_required on sequence gap and drops partial buffered events", () => {
    const journal = new BackgroundJournalManager();
    const key = scopeKey("conn-1", "default", "sess-gap");

    journal.recordEvent(key, {
      kind: "assistant_message",
      gatewaySeq: 1,
      countsAsUnread: true,
      patch: {
        type: "message_upsert",
        sessionId: "sess-gap",
        message: {
          messageId: "m1",
          sessionId: "sess-gap",
          role: "assistant",
          text: "step 1",
          createdAt: "2026-11-23T10:00:00Z",
        },
      },
    });

    const gapResult = journal.recordEvent(key, {
      kind: "assistant_message",
      gatewaySeq: 3, // skipped seq 2
      countsAsUnread: true,
      patch: {
        type: "message_upsert",
        sessionId: "sess-gap",
        message: {
          messageId: "m3",
          sessionId: "sess-gap",
          role: "assistant",
          text: "step 3",
          createdAt: "2026-11-23T10:00:02Z",
        },
      },
    });

    expect(gapResult.resyncRequired).toBe(true);
    expect(gapResult.reason).toBe("gap");
    const state = journal.getState(key);
    expect(state?.resyncRequired).toBe(true);
    expect(state?.eventCount).toBe(0);
    // Unread tracking still preserves the progress that arrived while backgrounded
    expect(state?.unreadCount).toBe(2);
  });

  it("evicts LRU unpinned journals beyond 16 per scope and 64 globally, while never evicting pinned entries", () => {
    const journal = new BackgroundJournalManager();

    // Fill 16 unpinned sessions in scope-1
    for (let i = 1; i <= 16; i += 1) {
      journal.recordEvent(scopeKey("conn-1", "default", `s-${i}`), {
        kind: "token_delta",
        gatewaySeq: 1,
        patch: { type: "token_delta", sessionId: `s-${i}`, messageId: "m1", delta: "hi" },
      });
    }
    expect(journal.stats().scopeCounts["conn-1::default"]).toBe(16);

    // 17th unpinned session evicts s-1 (oldest LRU)
    journal.recordEvent(scopeKey("conn-1", "default", "s-17"), {
      kind: "token_delta",
      gatewaySeq: 1,
      patch: { type: "token_delta", sessionId: "s-17", messageId: "m1", delta: "hi" },
    });
    expect(journal.stats().scopeCounts["conn-1::default"]).toBe(16);
    expect(journal.getState(scopeKey("conn-1", "default", "s-1"))?.resyncRequired).toBe(true);
    expect(journal.getState(scopeKey("conn-1", "default", "s-1"))?.eventCount).toBe(0);
    expect(journal.getState(scopeKey("conn-1", "default", "s-17"))?.eventCount).toBe(1);

    // Test pinned protection across all 4 pin reasons in scope-pinned
    const pinReasons: Array<{ runningTurn?: boolean; pendingInput?: boolean; unread?: boolean; queuedAdmission?: boolean }> = [
      { runningTurn: true },
      { pendingInput: true },
      { unread: true },
      { queuedAdmission: true },
    ];
    for (let i = 1; i <= 16; i += 1) {
      const key = scopeKey("conn-2", "ops", `p-${i}`);
      const pin = pinReasons[(i - 1) % pinReasons.length];
      if (pin.unread) {
        journal.recordEvent(key, {
          kind: "assistant_message",
          countsAsUnread: true,
          isWindowFocused: true,
          isViewingSession: false,
          gatewaySeq: 1,
          patch: {
            type: "message_upsert",
            sessionId: `p-${i}`,
            message: {
              messageId: "m1",
              sessionId: `p-${i}`,
              role: "assistant",
              text: "unread!",
              createdAt: "2026-11-23T10:00:00Z",
            },
          },
        });
      } else {
        journal.setPinnedFlags(key, pin);
        journal.recordEvent(key, {
          kind: "token_delta",
          gatewaySeq: 1,
          patch: { type: "token_delta", sessionId: `p-${i}`, messageId: "m1", delta: "hi" },
        });
      }
    }

    // 17th session in scope-pinned must NOT evict any of the 16 pinned entries
    journal.recordEvent(scopeKey("conn-2", "ops", "p-17"), {
      kind: "token_delta",
      gatewaySeq: 1,
      patch: { type: "token_delta", sessionId: "p-17", messageId: "m1", delta: "hi" },
    });

    for (let i = 1; i <= 16; i += 1) {
      const st = journal.getState(scopeKey("conn-2", "ops", `p-${i}`));
      expect(st?.pinned).toBe(true);
      expect(st?.resyncRequired).toBe(false);
      expect(st?.eventCount).toBe(1);
    }
    expect(journal.getState(scopeKey("conn-2", "ops", "p-17"))?.resyncRequired).toBe(true);

    // Test global 64 cap on a fresh manager
    const globalJournal = new BackgroundJournalManager();
    for (let scopeIdx = 1; scopeIdx <= 4; scopeIdx += 1) {
      for (let sessIdx = 1; sessIdx <= 16; sessIdx += 1) {
        globalJournal.recordEvent(scopeKey(`conn-${scopeIdx}`, "default", `g-${scopeIdx}-${sessIdx}`), {
          kind: "token_delta",
          gatewaySeq: 1,
          patch: { type: "token_delta", sessionId: `g-${scopeIdx}-${sessIdx}`, messageId: "m1", delta: "hi" },
        });
      }
    }
    expect(globalJournal.stats().totalBufferedSessions).toBe(64);

    // 65th session in scope 5 evicts oldest global unpinned session (g-1-1)
    globalJournal.recordEvent(scopeKey("conn-5", "default", "g-5-1"), {
      kind: "token_delta",
      gatewaySeq: 1,
      patch: { type: "token_delta", sessionId: "g-5-1", messageId: "m1", delta: "hi" },
    });
    expect(globalJournal.stats().totalBufferedSessions).toBe(64);
    expect(globalJournal.getState(scopeKey("conn-1", "default", "g-1-1"))?.resyncRequired).toBe(true);
  });

  it("counts unread only on user-visible progress (not token_delta), gates lastReadSeq on focused+viewing, and clears on quit/markRead", () => {
    const journal = new BackgroundJournalManager();
    const bgKey = scopeKey("conn-1", "default", "bg-sess");
    const fgKey = scopeKey("conn-1", "default", "fg-sess");

    // 1. Token deltas NEVER increment unreadCount
    for (let i = 1; i <= 10; i += 1) {
      journal.recordEvent(bgKey, {
        kind: "token_delta",
        countsAsUnread: false,
        isWindowFocused: true,
        isViewingSession: false,
      });
    }
    expect(journal.getState(bgKey)?.unreadCount ?? 0).toBe(0);

    // 2. Tool running (not yet finished) does NOT increment unreadCount; tool result summary DOES
    journal.recordEvent(bgKey, {
      kind: "tool_running",
      countsAsUnread: false,
      isWindowFocused: true,
      isViewingSession: false,
    });
    expect(journal.getState(bgKey)?.unreadCount ?? 0).toBe(0);

    journal.recordEvent(bgKey, {
      kind: "tool_result_summary",
      countsAsUnread: true,
      isWindowFocused: true,
      isViewingSession: false,
    });
    journal.recordEvent(bgKey, {
      kind: "assistant_message",
      countsAsUnread: true,
      isWindowFocused: true,
      isViewingSession: false,
    });
    journal.recordEvent(bgKey, {
      kind: "turn_boundary",
      countsAsUnread: true,
      isWindowFocused: true,
      isViewingSession: false,
    });
    expect(journal.getState(bgKey)?.unreadCount).toBe(3);
    expect(journal.getState(bgKey)?.pinned).toBe(true);

    // 3. Viewing fgKey while window IS focused advances lastReadSeq -> unreadCount stays 0
    journal.recordEvent(fgKey, {
      kind: "assistant_message",
      countsAsUnread: true,
      isWindowFocused: true,
      isViewingSession: true,
    });
    expect(journal.getState(fgKey)?.unreadCount).toBe(0);
    expect(journal.getState(fgKey)?.progressSeq).toBe(1);
    expect(journal.getState(fgKey)?.lastReadSeq).toBe(1);

    // 4. Viewing fgKey while window is UNFOCUSED does NOT advance lastReadSeq -> stays unread
    journal.recordEvent(fgKey, {
      kind: "turn_boundary",
      countsAsUnread: true,
      isWindowFocused: false,
      isViewingSession: true,
    });
    expect(journal.getState(fgKey)?.unreadCount).toBe(1);
    expect(journal.getState(fgKey)?.progressSeq).toBe(2);
    expect(journal.getState(fgKey)?.lastReadSeq).toBe(1);

    // 5. Explicit markRead advances lastReadSeq and clears unreadCount + unread pin
    journal.markRead(bgKey);
    expect(journal.getState(bgKey)?.unreadCount).toBe(0);
    expect(journal.getState(bgKey)?.pinned).toBe(false);

    // 6. Quit clears all journal & unread state so restart starts from 0
    journal.clear();
    expect(journal.stats().totalBufferedSessions).toBe(0);
    expect(journal.getState(fgKey)).toBeUndefined();
    expect(journal.getState(bgKey)).toBeUndefined();
  });
});

describe("aggregateAttentionState", () => {
  it("aggregates unread and needsInput counts and exact navigation targets without global approval side effects", () => {
    const sessions: SessionSummary[] = [
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-active",
        title: "当前 Session",
        preview: "ok",
        updatedAt: "2026-11-23T10:00:00Z",
        pinned: false,
        unreadCount: 0,
        needsInput: false,
      },
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-unread",
        title: "后台摘要",
        preview: "done",
        updatedAt: "2026-11-23T10:01:00Z",
        pinned: true,
        unreadCount: 2,
        needsInput: false,
      },
      {
        connectionId: "remote-ops",
        profileId: "ops",
        sessionId: "s-approval",
        title: "生产部署审批",
        preview: "waiting",
        updatedAt: "2026-11-23T10:02:00Z",
        pinned: true,
        unreadCount: 1,
        needsInput: true,
      },
    ];

    const agg = aggregateAttentionState(
      sessions,
      { connectionId: "local", profileId: "default", sessionId: "s-active" },
      "s-active",
    );

    expect(agg.totalUnread).toBe(3);
    expect(agg.totalNeedsInput).toBe(1);
    expect(agg.backgroundUnread).toBe(3);
    expect(agg.backgroundNeedsInput).toBe(1);
    expect(agg.needsInputTargets).toHaveLength(1);
    expect(agg.needsInputTargets[0]).toMatchObject({
      connectionId: "remote-ops",
      profileId: "ops",
      sessionId: "s-approval",
    });
    expect(agg.unreadTargets).toHaveLength(2);
    expect(agg.primaryTarget?.sessionId).toBe("s-approval");
  });
});
