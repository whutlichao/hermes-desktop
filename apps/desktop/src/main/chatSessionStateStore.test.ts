import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_MAX_BYTES,
  DRAFTS_TOTAL_MAX_BYTES,
  type ConnectionHealthSummary,
  type ProfileSummary,
  type SessionSummary,
} from "@hermes/contracts";
import { makeActiveChatDraftKey, makeNewChatDraftKey } from "@hermes/domain";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { ChatSessionStateStore } from "./chatSessionStateStore";

function conn(connectionId: string, actual: ConnectionHealthSummary["actual"] = "ready"): ConnectionHealthSummary {
  return {
    connectionId,
    label: connectionId === "local" ? "This device" : connectionId,
    kind: connectionId === "local" ? "local" : "remote",
    originDisplay: connectionId === "local" ? "127.0.0.1" : `https://${connectionId}.example.com`,
    actual,
    degraded: false,
    latencyMs: actual === "ready" ? 10 : null,
    nextRetryAt: null,
  };
}

function profile(connectionId: string, profileId: string, isDefault = profileId === "default"): ProfileSummary {
  return {
    connectionId,
    profileId,
    displayName: profileId,
    handle: profileId,
    isDefault,
    actual: "ready",
  };
}

function session(
  connectionId: string,
  profileId: string,
  sessionId: string,
  title = `Session ${sessionId}`,
  updatedAt = "2026-11-23T06:00:00.000Z",
): SessionSummary {
  return {
    connectionId,
    profileId,
    sessionId,
    title,
    preview: `preview ${sessionId}`,
    updatedAt,
    pinned: false,
    unreadCount: 0,
    needsInput: false,
    activeTurnId: null,
    status: "idle",
  };
}

describe("ChatSessionStateStore (S1/S3 startup recovery, 0600 persistence, session_missing)", () => {
  it("persists lastActiveChat and recovery summaries with 0600 atomic writes and primary/main projection", () => {
    const sandbox = createTestSandbox("hermes-chatstate-persist-");
    let passed = false;
    try {
      const store1 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      store1.recordActiveChat({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
      });
      store1.syncSessionSummaries([session("local", "default", "sess-1", "Original Title")]);
      store1.saveDraft({ connectionId: "local", profileId: "default", sessionId: "sess-1" }, "unsent draft text");

      const filePath = path.join(sandbox.userDataDir, "chat-session-state.json");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

      // Reload in a fresh instance (simulating app restart)
      const store2 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const loaded = store2.load();
      expect(loaded.windowId).toBe("primary");
      expect(loaded.paneId).toBe("main");
      expect(loaded.lastActiveChat).toEqual({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
      });
      expect(loaded.lastSessionByScope["local::default"]).toBe("sess-1");
      expect(loaded.sessionSummaries["local::default::sess-1"]?.hasDraft).toBe(true);
      expect(loaded.sessionSummaries["local::default::sess-1"]?.draftText).toBe("unsent draft text");

      // Title/content updates mirror into recovery summary
      store2.syncSessionSummaries([session("local", "default", "sess-1", "Renamed Title")]);
      expect(store2.getProjection().sessionSummaries["local::default::sess-1"]?.title).toBe("Renamed Title");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("recovers lastActiveChat on startup, preserves unverified when reconnecting, and handles session_missing read-only export/dismiss", () => {
    const sandbox = createTestSandbox("hermes-chatstate-recover-");
    let passed = false;
    try {
      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      store.recordActiveChat({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-alpha",
      });
      store.syncSessionSummaries([session("local", "default", "sess-alpha", "Alpha Work")]);
      store.saveDraft(
        { connectionId: "local", profileId: "default", sessionId: "sess-alpha" },
        "important unsent prompt",
      );

      // 1) Startup while connection is still connecting -> keep lastActiveChat & mark unverified
      const whileConnecting = store.resolveWithSnapshot({
        connections: [conn("local", "connecting")],
        profiles: [],
        sessions: [],
      });
      expect(whileConnecting.status).toBe("unverified");
      expect(whileConnecting.lastKnownUnverified).toBe(true);
      expect(whileConnecting.activeSessionId).toBe("sess-alpha");

      // 2) Snapshot arrives with sess-alpha removed + draft present -> session_missing read-only!
      const missingRes = store.resolveWithSnapshot({
        connections: [conn("local", "ready")],
        profiles: [profile("local", "default")],
        sessions: [session("local", "default", "sess-beta", "Beta Session")],
      });
      expect(missingRes.status).toBe("session_missing");
      expect(missingRes.projection.missingSession?.title).toBe("Alpha Work");
      expect(missingRes.projection.missingSession?.draftText).toBe("important unsent prompt");

      const exported = store.exportMissingSession();
      expect(exported).not.toBeNull();
      expect(exported?.windowId).toBe("primary");
      expect(exported?.paneId).toBe("main");
      expect(exported?.draftText).toBe("important unsent prompt");

      // Dismissing session_missing falls back to latest valid session without creating a new one
      const afterDismiss = store.dismissMissingSession([
        session("local", "default", "sess-beta", "Beta Session"),
      ]);
      expect(afterDismiss.activeStatus).toBe("ready");
      expect(afterDismiss.lastActiveChat?.sessionId).toBe("sess-beta");
      expect(afterDismiss.missingSession).toBeNull();

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("emits and dismisses cross-scope routeBanner when active connection is removed", () => {
    const sandbox = createTestSandbox("hermes-chatstate-banner-");
    let passed = false;
    try {
      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      store.recordActiveChat({ connectionId: "local", profileId: "default", sessionId: "s-local" });
      store.recordActiveChat({ connectionId: "vps", profileId: "prod", sessionId: "s-vps" });

      const resolved = store.resolveWithSnapshot({
        connections: [conn("local", "ready")],
        profiles: [profile("local", "default")],
        sessions: [session("local", "default", "s-local")],
      });

      expect(resolved.activeChat).toEqual({
        connectionId: "local",
        profileId: "default",
        sessionId: "s-local",
      });
      expect(resolved.projection.routeBanner).toMatchObject({
        fromScope: { connectionId: "vps", profileId: "prod" },
        toScope: { connectionId: "local", profileId: "default", sessionId: "s-local" },
        reason: "connection_removed",
      });

      const dismissed = store.dismissRouteBanner();
      expect(dismissed.routeBanner).toBeNull();

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("persists Draft artifact annotations with 0600 atomic writes, preserves them across draft text edits and restarts, and includes them in session_missing export", () => {
    const sandbox = createTestSandbox("hermes-chatstate-annotations-");
    let passed = false;
    try {
      const store1 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const ref = { connectionId: "local", profileId: "default", sessionId: "sess-art" };
      store1.recordActiveChat(ref);
      store1.syncSessionSummaries([session("local", "default", "sess-art", "Artifact Thread")]);

      const ann = {
        annotationId: "ann-101",
        artifactId: "art-1",
        artifactVersion: 1,
        artifactHash: "h-v1",
        xPct: 28.4,
        yPct: 71.9,
        comment: "Keep this pin on v1",
        createdAt: "2026-11-23T08:10:00.000Z",
      };

      store1.saveDraft(ref, "Draft with annotation", { annotations: [ann] });

      // Updating draft text alone preserves existing annotations in Draft
      store1.saveDraft(ref, "Updated draft text");

      const store2 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const loaded = store2.load();
      const summary = loaded.sessionSummaries["local::default::sess-art"];
      expect(summary?.hasDraft).toBe(true);
      expect(summary?.draftText).toBe("Updated draft text");
      expect(summary?.annotations).toEqual([ann]);

      // Even if draft text is cleared, remaining annotations keep hasDraft=true so Draft annotations are not lost
      store2.saveDraft(ref, "");
      const summaryAfterClearText = store2.getProjection().sessionSummaries["local::default::sess-art"];
      expect(summaryAfterClearText?.hasDraft).toBe(true);
      expect(summaryAfterClearText?.annotations).toEqual([ann]);

      const exported = store2.exportMissingSession(ref);
      expect(exported?.annotations).toEqual([ann]);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("persists full DraftRecords at 0600 with fake clock, monotonic revision, Scope+draftId uniqueness, and atomic migration", () => {
    const sandbox = createTestSandbox("hermes-drafts-s3-");
    let passed = false;
    let fakeNow = Date.parse("2026-11-23T09:00:00.000Z");
    const clock = () => fakeNow;

    try {
      const store1 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir, now: clock });

      // ActiveChat draft
      const res1 = store1.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        text: "first draft",
        attachments: [
          {
            attachmentId: "att-1",
            handle: "opaque://blob-1",
            displayName: "notes.txt",
            kind: "text",
            sizeBytes: 120,
          },
        ],
        contexts: [
          {
            contextId: "ctx-1",
            kind: "file",
            ref: "src/index.ts",
            label: "src/index.ts",
          },
        ],
        composer: { selectionStart: 5, selectionEnd: 5, sendOnEnter: true },
      });
      expect(res1.ok).toBe(true);
      if (!res1.ok || !res1.draft) throw new Error("expected draft");
      expect(res1.draft.revision).toBe(1);
      expect(res1.draft.updatedAt).toBe("2026-11-23T09:00:00.000Z");
      const firstDraftId = res1.draft.draftId;

      fakeNow += 5000;
      const res2 = store1.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        text: "second draft edit",
      });
      expect(res2.ok).toBe(true);
      if (!res2.ok || !res2.draft) throw new Error("expected draft");
      expect(res2.draft.draftId).toBe(firstDraftId); // ActiveChat keeps single draftId
      expect(res2.draft.revision).toBe(2);
      expect(res2.draft.updatedAt).toBe("2026-11-23T09:00:05.000Z");
      expect(res2.draft.attachments).toHaveLength(1);
      expect(res2.draft.contexts).toHaveLength(1);

      // New-chat drafts keyed uniquely by Scope + draftId
      fakeNow += 1000;
      store1.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        draftId: "draft-new-1",
        text: "new chat alpha",
      });
      store1.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        draftId: "draft-new-2",
        text: "new chat beta",
      });
      store1.saveDraftRecord({
        connectionId: "local",
        profileId: "ops",
        draftId: "draft-new-1",
        text: "ops scope draft",
      });

      expect(fs.statSync(store1.filePath).mode & 0o777).toBe(0o600);

      // Reload fresh instance
      const store2 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir, now: clock });
      const loaded = store2.load();
      expect(loaded.draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-1")]?.revision).toBe(2);
      expect(loaded.draftsByKey?.[makeNewChatDraftKey("local", "default", "draft-new-1")]?.text).toBe(
        "new chat alpha",
      );
      expect(loaded.draftsByKey?.[makeNewChatDraftKey("local", "default", "draft-new-2")]?.text).toBe(
        "new chat beta",
      );
      expect(loaded.draftsByKey?.[makeNewChatDraftKey("local", "ops", "draft-new-1")]?.text).toBe(
        "ops scope draft",
      );

      // Atomic session.create migration preserves exact draftId with zero duplicate
      fakeNow += 2000;
      const migrated = store2.migrateNewChatDraftToSession({
        connectionId: "local",
        profileId: "default",
        draftId: "draft-new-1",
        sessionId: "sess-created-99",
        title: "Created Chat",
      });
      expect(migrated.migrated).toBe(true);
      expect(migrated.draft?.draftId).toBe("draft-new-1");
      expect(migrated.draft?.sessionId).toBe("sess-created-99");
      expect(migrated.draft?.revision).toBe(2);
      expect(
        migrated.projection.draftsByKey?.[makeNewChatDraftKey("local", "default", "draft-new-1")],
      ).toBeUndefined();
      expect(
        migrated.projection.draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-created-99")]?.text,
      ).toBe("new chat alpha");
      expect(migrated.projection.sessionSummaries["local::default::sess-created-99"]?.hasDraft).toBe(true);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("enforces receipt-based draft clearing, delivery_unknown preservation, capacity limits (1 MiB / 50 MiB), and expired attachments", () => {
    const sandbox = createTestSandbox("hermes-drafts-limits-");
    let passed = false;
    let fakeNow = Date.parse("2026-11-23T10:00:00.000Z");
    const clock = () => fakeNow;

    try {
      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir, now: clock });
      const ref = { connectionId: "local", profileId: "default", sessionId: "sess-rec" };

      store.saveDraftRecord({
        ...ref,
        text: "important message",
        attachments: [
          {
            attachmentId: "att-exp-1",
            handle: "opaque://exp-1",
            displayName: "report.pdf",
            kind: "binary",
          },
        ],
      });

      // Optimistic / unknown receipts NEVER clear draft
      store.markDraftDeliveryStatus(ref, "submitting");
      expect(store.clearDraftOnReceipt(ref, "optimistic").cleared).toBe(false);
      expect(store.clearDraftOnReceipt(ref, "delivery_unknown").cleared).toBe(false);

      fakeNow += 1000;
      const unknownProj = store.markDraftDeliveryStatus(ref, "delivery_unknown");
      expect(
        unknownProj.draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-rec")]?.deliveryStatus,
      ).toBe("delivery_unknown");

      // Expired attachment preserves handle & displayName while marking expired=true
      fakeNow += 1000;
      const expProj = store.markAttachmentExpired(ref, "att-exp-1");
      const att =
        expProj.draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-rec")]?.attachments[0];
      expect(att).toMatchObject({
        attachmentId: "att-exp-1",
        handle: "opaque://exp-1",
        displayName: "report.pdf",
        expired: true,
      });

      // Single draft > 1 MiB fails safely WITHOUT overwriting existing draft
      const overSingle = store.saveDraftRecord({
        ...ref,
        text: "Z".repeat(DRAFT_MAX_BYTES + 50),
      });
      expect(overSingle.ok).toBe(false);
      if (overSingle.ok) throw new Error("expected over_single_limit");
      expect(overSingle.reason).toBe("over_single_limit");
      expect(
        store.getProjection().draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-rec")]?.text,
      ).toBe("important message");

      // Receipt accepted clears draft
      const cleared = store.clearDraftOnReceipt(ref, "accepted");
      expect(cleared.cleared).toBe(true);
      expect(
        cleared.projection.draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-rec")],
      ).toBeUndefined();

      // Also verify admitted receipt clears
      store.saveDraftRecord({ ...ref, text: "second message" });
      expect(store.clearDraftOnReceipt(ref, "admitted").cleared).toBe(true);

      // Total > 50 MiB limit check
      const chunk = "k".repeat(950 * 1024);
      for (let i = 0; i < 53; i += 1) {
        const okRes = store.saveDraftRecord({
          connectionId: "local",
          profileId: "default",
          sessionId: `bulk-${i}`,
          text: chunk,
        });
        expect(okRes.ok).toBe(true);
      }
      const overTotal = store.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        sessionId: "bulk-overflow",
        text: chunk,
      });
      expect(overTotal.ok).toBe(false);
      if (overTotal.ok) throw new Error("expected over_total_limit");
      expect(overTotal.reason).toBe("over_total_limit");
      expect(overTotal.limitBytes).toBe(DRAFTS_TOTAL_MAX_BYTES);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("creates OrphanedDrafts on non-active session deletion, profile/connection removal, and session_missing close/export without auto-reattaching", () => {
    const sandbox = createTestSandbox("hermes-orphans-s3-");
    let passed = false;
    let fakeNow = Date.parse("2026-11-23T11:00:00.000Z");
    const clock = () => fakeNow;

    try {
      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir, now: clock });
      store.syncSessionSummaries([
        session("local", "default", "sess-inactive", "Inactive Session"),
        session("local", "ops", "sess-ops", "Ops Session"),
        session("remote-1", "prod", "sess-rem", "Prod Session"),
        session("local", "default", "sess-miss", "Missing Session"),
      ]);
      store.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-inactive",
        text: "deleted session draft",
      });
      store.saveDraftRecord({
        connectionId: "local",
        profileId: "ops",
        sessionId: "sess-ops",
        text: "removed profile active draft",
      });
      store.saveDraftRecord({
        connectionId: "local",
        profileId: "ops",
        draftId: "new-ops-1",
        text: "removed profile new draft",
      });
      store.saveDraftRecord({
        connectionId: "remote-1",
        profileId: "prod",
        sessionId: "sess-rem",
        text: "removed connection draft",
        attachments: [
          { attachmentId: "att-r", handle: "opaque://r", displayName: "trace.log", kind: "file" },
        ],
      });

      // 1) Non-active session deleted
      fakeNow += 1000;
      const delOrphans = store.orphanDraftsForRemovedSessions(
        { connectionId: "local", profileId: "default" },
        [{ sessionId: "sess-inactive", title: "Inactive Session" }],
      );
      expect(delOrphans).toHaveLength(1);
      expect(delOrphans[0]).toMatchObject({
        reason: "session_deleted",
        text: "deleted session draft",
        origin: {
          connectionId: "local",
          profileId: "default",
          sessionId: "sess-inactive",
          title: "Inactive Session",
        },
        orphanedAt: "2026-11-23T11:00:01.000Z",
      });

      // 2) Profile removed
      fakeNow += 1000;
      const profOrphans = store.orphanDraftsForRemovedProfile("local", "ops");
      expect(profOrphans).toHaveLength(2);
      expect(profOrphans.every((o) => o.reason === "profile_removed")).toBe(true);

      // 3) Connection removed
      fakeNow += 1000;
      const connOrphans = store.orphanDraftsForRemovedConnection("remote-1");
      expect(connOrphans).toHaveLength(1);
      expect(connOrphans[0]).toMatchObject({
        reason: "connection_removed",
        text: "removed connection draft",
        origin: {
          connectionId: "remote-1",
          profileId: "prod",
          sessionId: "sess-rem",
          title: "Prod Session",
        },
      });
      expect(connOrphans[0].attachments[0]?.displayName).toBe("trace.log");

      // Re-adding remote-1 with same connection/profile/session must NEVER auto-reattach!
      const afterReadd = store.resolveWithSnapshot({
        connections: [conn("remote-1", "ready")],
        profiles: [profile("remote-1", "prod")],
        sessions: [session("remote-1", "prod", "sess-rem", "Prod Session")],
      });
      expect(
        afterReadd.projection.draftsByKey?.[makeActiveChatDraftKey("remote-1", "prod", "sess-rem")],
      ).toBeUndefined();
      expect(afterReadd.projection.orphanedDrafts).toHaveLength(4);

      // 4) session_missing export + dismiss generates OrphanedDraft without duplication
      store.recordActiveChat({ connectionId: "local", profileId: "default", sessionId: "sess-miss" });
      store.saveDraftRecord({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-miss",
        text: "missing draft text",
      });
      store.resolveWithSnapshot({
        connections: [conn("local", "ready")],
        profiles: [profile("local", "default")],
        sessions: [session("local", "default", "sess-keep", "Keep")],
      });
      const exportedMissing = store.exportMissingSession();
      expect(exportedMissing?.draftText).toBe("missing draft text");
      expect(store.getProjection().orphanedDrafts).toHaveLength(5);

      const dismissed = store.dismissMissingSession([session("local", "default", "sess-keep", "Keep")]);
      // Must NOT duplicate the already-exported orphan
      expect(dismissed.orphanedDrafts).toHaveLength(5);

      // Export & Delete orphaned draft
      const targetOrphan = dismissed.orphanedDrafts![0];
      const bundle = store.exportOrphanedDraft(targetOrphan.orphanedId);
      expect(bundle?.kind).toBe("orphaned_draft");
      expect(bundle?.text).toBe(targetOrphan.text);

      const afterDelete = store.deleteOrphanedDraft(targetOrphan.orphanedId);
      expect(afterDelete.orphanedDrafts).toHaveLength(4);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("preserves persisted canonical path profileIds and non-destructively adopts legacy handle aliases", () => {
    const sandbox = createTestSandbox("hermes-chatstate-optionb-alias-");
    let passed = false;
    try {
      const canonicalPath = sandbox.hermesHomeDir;
      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      store.recordActiveChat({
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-legacy",
      });
      store.syncSessionSummaries([session("local", "default", "sess-legacy", "Legacy Chat")]);
      store.saveDraft(
        { connectionId: "local", profileId: "default", sessionId: "sess-legacy" },
        "legacy unsent draft",
      );
      store.saveDraft(
        { connectionId: "remote-1", profileId: "/srv/remote-profile", sessionId: "sess-rem" },
        "remote unsent draft",
      );

      expect(store.adoptLocalProfileAlias("default", canonicalPath)).toBe(true);

      const reloaded = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir }).load();
      expect(reloaded.lastActiveChat).toEqual({
        connectionId: "local",
        profileId: canonicalPath,
        sessionId: "sess-legacy",
      });
      expect(reloaded.lastValidProfileByConnection.local).toBe(canonicalPath);
      expect(reloaded.lastSessionByScope[`local::${canonicalPath}`]).toBe("sess-legacy");
      expect(reloaded.lastSessionByScope["local::default"]).toBeUndefined();
      expect(reloaded.sessionSummaries[`local::${canonicalPath}::sess-legacy`]).toMatchObject({
        profileId: canonicalPath,
        hasDraft: true,
        draftText: "legacy unsent draft",
      });
      expect(
        reloaded.draftsByKey?.[makeActiveChatDraftKey("local", canonicalPath, "sess-legacy")],
      ).toMatchObject({
        scope: { connectionId: "local", profileId: canonicalPath },
        text: "legacy unsent draft",
      });
      expect(
        reloaded.draftsByKey?.[makeActiveChatDraftKey("remote-1", "/srv/remote-profile", "sess-rem")],
      ).toMatchObject({
        scope: { connectionId: "remote-1", profileId: "/srv/remote-profile" },
        text: "remote unsent draft",
      });

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("persists optional localProfileHandlesByCanonical across restarts while loading legacy files without it", () => {
    const sandbox = createTestSandbox("hermes-chatstate-profile-handles-");
    let passed = false;
    try {
      const store1 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      // Legacy file without localProfileHandlesByCanonical must load cleanly with empty handles
      expect(store1.load().activeStatus).toBe("empty");
      expect(store1.getLocalProfileHandles()).toEqual({});

      const opsPath = path.join(sandbox.hermesHomeDir, "profiles", "ops");
      expect(store1.recordLocalProfileAlias(`${opsPath}/`, "ops")).toBe(true);
      expect(store1.recordLocalProfileAlias(opsPath, "ops")).toBe(false);
      // Reject path-like handle
      expect(store1.recordLocalProfileAlias(opsPath, "/bad/handle")).toBe(false);

      const store2 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      store2.load();
      expect(store2.getLocalProfileHandles()).toEqual({ [opsPath]: "ops" });

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });
});
