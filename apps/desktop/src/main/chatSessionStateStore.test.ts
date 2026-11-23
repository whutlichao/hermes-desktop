import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConnectionHealthSummary, ProfileSummary, SessionSummary } from "@hermes/contracts";
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
});
