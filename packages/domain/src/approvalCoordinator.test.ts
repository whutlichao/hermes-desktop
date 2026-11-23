import { describe, expect, it, vi } from "vitest";
import type { ApprovalHighRiskSheetRequest } from "@hermes/contracts";
import {
  ApprovalAndRecoveryCoordinator,
  type ApprovalIngestInput,
  type GatewayApprovalRespondOutcome,
  type GatewayApprovalRespondPayload,
} from "./approvalCoordinator";

function makeCoordinator(overrides?: {
  now?: () => number;
  confirmHighRisk?: (req: ApprovalHighRiskSheetRequest) => Promise<boolean>;
  sendRespond?: (
    req: GatewayApprovalRespondPayload,
  ) => Promise<GatewayApprovalRespondOutcome>;
  fetchPending?: (scope: {
    connectionId: string;
    profileId: string;
  }) => Promise<readonly ApprovalIngestInput[]>;
}) {
  let keySeq = 0;
  return new ApprovalAndRecoveryCoordinator({
    now: overrides?.now ?? (() => Date.parse("2026-11-23T10:00:00.000Z")),
    createApprovalKey: () => `apr-key-${++keySeq}`,
    confirmHighRiskApproval: overrides?.confirmHighRisk ?? (async () => true),
    sendApprovalRespond: overrides?.sendRespond ?? (async () => ({ status: "settled" })),
    fetchPendingApprovals: overrides?.fetchPending ?? (async () => []),
  });
}

describe("ApprovalAndRecoveryCoordinator — Slice 1: 7-tuple binding, opaque key, 2-source synthesis & completeness gate", () => {
  it("binds 7-tuple in Main, returns opaque ApprovalKey without serverRequestId/approvalId, and synthesizes immutable two-source ApprovalView", () => {
    const coord = makeCoordinator();
    coord.setActiveScope({ connectionId: "ssh-1", profileId: "ops", sessionId: "sess-1" });

    const view = coord.receive({
      gateway: {
        approvalId: "gw-prompt-101",
        serverRequestId: 9001,
        connectionId: "ssh-1",
        profileId: "ops",
        sessionId: "sess-1",
        turnId: "turn-42",
        executionGeneration: 3,
        command: "ls -la /srv/app",
        description: "List deployment directory",
        choices: ["once", "deny"],
        smartDenied: false,
        expiresAt: "2026-11-23T10:05:00.000Z",
      },
      main: {
        connectionLabel: "Prod SSH",
        connectionKind: "ssh",
        hostDisplay: "ops@prod.example.com:22",
        profileDisplayName: "Ops",
        sessionTitle: "Deploy Check",
        cwd: "/srv/app",
        ownerGeneration: 2,
        authorityEpoch: 7,
        connectionOnline: true,
      },
    });

    expect(view.approvalKey).toBe("apr-key-1");
    expect(view.state).toBe("actionable");
    expect(view.allowedChoices).toEqual(["once", "deny"]);
    expect(view.canApprove).toBe(true);
    expect(view.canDeny).toBe(true);
    expect(view.canInspect).toBe(true);
    expect(view.connectionLabel).toBe("Prod SSH");
    expect(view.connectionKind).toBe("ssh");
    expect(view.hostDisplay).toBe("ops@prod.example.com:22");
    expect(view.profileDisplayName).toBe("Ops");
    expect(view.sessionTitle).toBe("Deploy Check");
    expect(view.turnId).toBe("turn-42");
    expect(view.cwd).toBe("/srv/app");
    expect(view.ownerGeneration).toBe(2);
    expect(view.authorityEpoch).toBe(7);
    expect(view.executionGeneration).toBe(3);

    // Renderer-facing ApprovalView MUST NOT expose serverRequestId, approvalId, or writable target
    const rawKeys = Object.keys(view as unknown as Record<string, unknown>);
    expect(rawKeys).not.toContain("serverRequestId");
    expect(rawKeys).not.toContain("approvalId");
    expect(rawKeys).not.toContain("target");
    expect(Object.isFrozen(view)).toBe(true);

    // Main retains authoritative 7-tuple binding; serverRequestId never replaces approvalId
    const binding = coord.getBinding(view.approvalKey);
    expect(binding).toEqual({
      connectionId: "ssh-1",
      profileId: "ops",
      sessionId: "sess-1",
      turnId: "turn-42",
      approvalId: "gw-prompt-101",
      ownerGeneration: 2,
      executionGeneration: 3,
      serverRequestId: 9001,
    });
  });

  it("forces context_incomplete (only Deny/Inspect) when any required context field is missing, and never guesses cwd", async () => {
    const sendRespond = vi.fn(async () => ({ status: "settled" as const }));
    const coord = makeCoordinator({ sendRespond });

    // Missing cwd (even though command mentions /srv/app!)
    const missingCwd = coord.receive({
      gateway: {
        approvalId: "gw-prompt-102",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-a",
        turnId: "turn-1",
        executionGeneration: 1,
        command: "cat /srv/app/README.md",
        description: "Read file",
        choices: ["once", "session", "always", "deny"],
        persistentGrant: {
          pattern: "cat *",
          scope: "workspace",
          revokeHint: "hermes approvals revoke gw-prompt-102",
        },
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Session A",
        cwd: null,
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    expect(missingCwd.state).toBe("context_incomplete");
    expect(missingCwd.missingContextFields).toContain("cwd");
    expect(missingCwd.canApprove).toBe(false);
    expect(missingCwd.canDeny).toBe(true);
    expect(missingCwd.canInspect).toBe(true);
    expect(missingCwd.allowedChoices).toEqual(["deny"]);

    // Approve must be rejected when context_incomplete
    await expect(coord.respond(missingCwd.approvalKey, "once")).rejects.toThrow();
    expect(sendRespond).not.toHaveBeenCalled();

    // Missing command still allows Deny (Deny does NOT depend on command executability)
    const missingCommand = coord.receive({
      gateway: {
        approvalId: "gw-prompt-103",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-a",
        turnId: "turn-2",
        executionGeneration: 1,
        command: "",
        description: "Unknown command",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Session A",
        cwd: "/tmp/work",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    expect(missingCommand.state).toBe("context_incomplete");
    expect(missingCommand.missingContextFields).toContain("command");
    expect(missingCommand.canDeny).toBe(true);

    const denyRes = await coord.respond(missingCommand.approvalKey, "deny");
    expect(denyRes.status).toBe("settled");
    expect(denyRes.approval?.state).toBe("settled");
    expect(denyRes.approval?.settledChoice).toBe("deny");
    expect(sendRespond).toHaveBeenCalledTimes(1);
    expect(sendRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "gw-prompt-103",
        choice: "deny",
      }),
    );
  });

  it("hides session/always unless Gateway explicitly offers them AND always includes persistent pattern/scope/revokeHint", () => {
    const coord = makeCoordinator();

    // Gateway offers always WITHOUT persistent pattern/scope/revokeHint -> always MUST be hidden
    const incompleteAlways = coord.receive({
      gateway: {
        approvalId: "gw-prompt-104",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-1",
        executionGeneration: 1,
        command: "npm test",
        description: "Run tests",
        choices: ["once", "session", "always", "deny"],
        persistentGrant: {
          pattern: "npm test",
          scope: "",
          revokeHint: "",
        },
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Tests",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    expect(incompleteAlways.allowedChoices).toEqual(["once", "session", "deny"]);

    // Gateway offers always WITH pattern + scope + revokeHint -> always is shown
    const completeAlways = coord.receive({
      gateway: {
        approvalId: "gw-prompt-105",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-2",
        executionGeneration: 1,
        command: "npm test",
        description: "Run tests",
        choices: ["once", "session", "always", "deny"],
        persistentGrant: {
          pattern: "npm test",
          scope: "profile:default",
          revokeHint: "hermes approvals revoke apr-test",
        },
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Tests",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    expect(completeAlways.allowedChoices).toEqual(["once", "session", "always", "deny"]);
    expect(completeAlways.persistentGrant).toEqual({
      pattern: "npm test",
      scope: "profile:default",
      revokeHint: "hermes approvals revoke apr-test",
    });
  });
});

describe("ApprovalAndRecoveryCoordinator — Slice 2: High-risk Main native sheet & background context", () => {
  it("routes sudo, secret, vault, destructive, and always through Main sheet with full background context, and keeps pending on cancel", async () => {
    const sheetCalls: ApprovalHighRiskSheetRequest[] = [];
    let sheetShouldConfirm = false;
    const sendRespond = vi.fn(async () => ({ status: "settled" as const }));

    const coord = makeCoordinator({
      confirmHighRisk: async (req) => {
        sheetCalls.push(req);
        return sheetShouldConfirm;
      },
      sendRespond,
    });

    // Active scope is local/default/sess-fg, while approval arrives for background ssh-1/ops/sess-bg
    coord.setActiveScope({ connectionId: "local", profileId: "default", sessionId: "sess-fg" });

    const sudoView = coord.receive({
      gateway: {
        approvalId: "gw-sudo-1",
        connectionId: "ssh-1",
        profileId: "ops",
        sessionId: "sess-bg",
        turnId: "turn-9",
        executionGeneration: 1,
        command: "sudo systemctl restart nginx",
        description: "Restart web server",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "Homelab Node",
        connectionKind: "ssh",
        hostDisplay: "ops@homelab.local:22",
        profileDisplayName: "Ops Profile",
        sessionTitle: "Nginx Ops",
        cwd: "/etc/nginx",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    expect(sudoView.riskCategories).toContain("sudo");
    expect(sudoView.requiresHighRiskSheet).toBe(true);
    expect(sudoView.isOwningSessionActive).toBe(false);

    // 1. Cancel high-risk sheet -> remains actionable (pending), NEVER sends deny!
    const cancelRes = await coord.respond(sudoView.approvalKey, "once");
    expect(cancelRes.status).toBe("cancelled_pending");
    expect(cancelRes.approval?.state).toBe("actionable");
    expect(sendRespond).not.toHaveBeenCalled();
    expect(sheetCalls).toHaveLength(1);
    expect(sheetCalls[0]).toMatchObject({
      connectionLabel: "Homelab Node",
      connectionKind: "ssh",
      hostDisplay: "ops@homelab.local:22",
      profileDisplayName: "Ops Profile",
      sessionTitle: "Nginx Ops",
      isOwningSessionBackground: true,
      command: "sudo systemctl restart nginx",
    });

    // 2. Deny skips high-risk sheet completely
    const secretView = coord.receive({
      gateway: {
        approvalId: "gw-secret-1",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-fg",
        turnId: "turn-10",
        executionGeneration: 1,
        command: "cat ~/.ssh/id_ed25519",
        description: "Inspect SSH private key",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Foreground",
        cwd: "/Users/alice/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });
    expect(secretView.riskCategories).toContain("secret");
    await coord.respond(secretView.approvalKey, "deny");
    expect(sheetCalls).toHaveLength(1);
    expect(sendRespond).toHaveBeenCalledTimes(1);

    // 3. Ordinary command with "always" choice still triggers high-risk sheet
    const alwaysView = coord.receive({
      gateway: {
        approvalId: "gw-always-1",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-fg",
        turnId: "turn-11",
        executionGeneration: 1,
        command: "pnpm test",
        description: "Run tests",
        choices: ["once", "always", "deny"],
        persistentGrant: {
          pattern: "pnpm test",
          scope: "profile:default",
          revokeHint: "hermes approvals revoke gw-always-1",
        },
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Foreground",
        cwd: "/Users/alice/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });
    expect(alwaysView.riskCategories).toEqual([]);
    sheetShouldConfirm = true;
    const alwaysRes = await coord.respond(alwaysView.approvalKey, "always");
    expect(alwaysRes.status).toBe("settled");
    expect(sheetCalls).toHaveLength(2);

    // 4. Vault & destructive risk classifications
    const vaultView = coord.receive({
      gateway: {
        approvalId: "gw-vault-1",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-fg",
        turnId: "turn-12",
        executionGeneration: 1,
        command: "vault kv get secret/prod",
        description: "Read vault secret",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Foreground",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });
    expect(vaultView.riskCategories).toContain("vault");

    const destructiveView = coord.receive({
      gateway: {
        approvalId: "gw-destr-1",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-fg",
        turnId: "turn-13",
        executionGeneration: 1,
        command: "rm -rf ./dist",
        description: "Delete build folder",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Foreground",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });
    expect(destructiveView.riskCategories).toContain("destructive");
  });

  it("rejects duplicate concurrent respond while high-risk sheet is open and blocks stale_owner after sheet confirm", async () => {
    let resolveSheet!: (ok: boolean) => void;
    const sendRespond = vi.fn(async () => ({ status: "settled" as const }));
    const coord = makeCoordinator({
      confirmHighRisk: () =>
        new Promise<boolean>((resolve) => {
          resolveSheet = resolve;
        }),
      sendRespond,
    });

    const view = coord.receive({
      gateway: {
        approvalId: "gw-race-1",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-1",
        executionGeneration: 1,
        command: "sudo id",
        description: "Check root",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "Main",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    const firstPromise = coord.respond(view.approvalKey, "once");
    // Second concurrent respond on same ApprovalKey while sheet is open must fail with conflict
    await expect(coord.respond(view.approvalKey, "once")).rejects.toThrow();

    // Owner changes while sheet is open
    coord.onOwnerGenerationChanged("local", 2);
    resolveSheet(true);

    await expect(firstPromise).rejects.toThrow();
    expect(sendRespond).not.toHaveBeenCalled();
    expect(coord.snapshot().approvals.find((a) => a.approvalKey === view.approvalKey)?.state).toBe(
      "stale_owner",
    );
  });
});

describe("ApprovalAndRecoveryCoordinator — Slice 3: generation, resync, expiry, orphaned", () => {
  it("marks old owner generation stale_owner immediately, reconciles same-generation via unverified -> exact 4-tuple without auto-deny or reviving old cards", () => {
    const sendRespond = vi.fn(async () => ({ status: "settled" as const }));
    const coord = makeCoordinator({ sendRespond });

    const a1 = coord.receive({
      gateway: {
        approvalId: "apr-1",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-1",
        executionGeneration: 1,
        command: "echo hi",
        description: "Echo",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "S1",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    const a2 = coord.receive({
      gateway: {
        approvalId: "apr-2",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-2",
        executionGeneration: 1,
        command: "echo bye",
        description: "Echo 2",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "S1",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    // Offline transitions active approvals to unverified without denying
    coord.onConnectionOffline("local");
    expect(coord.snapshot().approvals.every((a) => a.state === "unverified")).toBe(true);
    expect(sendRespond).not.toHaveBeenCalled();

    // Same-generation resync: apr-1 matches exact 4-tuple; apr-2 is missing (remains unverified, NOT denied)
    coord.reconcile(
      { connectionId: "local", profileId: "default", ownerGeneration: 1 },
      [
        {
          gateway: {
            approvalId: "apr-1",
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            turnId: "turn-1",
            executionGeneration: 1,
            command: "echo hi",
            description: "Echo",
            choices: ["once", "deny"],
          },
          main: {
            connectionLabel: "This device",
            connectionKind: "local",
            hostDisplay: "127.0.0.1",
            profileDisplayName: "Default",
            sessionTitle: "S1",
            cwd: "/repo",
            ownerGeneration: 1,
            authorityEpoch: 1,
            connectionOnline: true,
          },
        },
      ],
    );

    const afterSameGen = coord.snapshot().approvals;
    expect(afterSameGen.find((a) => a.approvalKey === a1.approvalKey)?.state).toBe("actionable");
    expect(afterSameGen.find((a) => a.approvalKey === a2.approvalKey)?.state).toBe("unverified");
    expect(sendRespond).not.toHaveBeenCalled();

    // Owner generation change -> immediately stale_owner, never revived by snapshot even with same approvalId!
    coord.onOwnerGenerationChanged("local", 2);
    expect(
      coord.snapshot().approvals.find((a) => a.approvalKey === a1.approvalKey)?.state,
    ).toBe("stale_owner");

    coord.reconcile(
      { connectionId: "local", profileId: "default", ownerGeneration: 2 },
      [
        {
          gateway: {
            approvalId: "apr-1",
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            turnId: "turn-1",
            executionGeneration: 1,
            command: "echo hi",
            description: "Echo",
            choices: ["once", "deny"],
          },
          main: {
            connectionLabel: "This device",
            connectionKind: "local",
            hostDisplay: "127.0.0.1",
            profileDisplayName: "Default",
            sessionTitle: "S1",
            cwd: "/repo",
            ownerGeneration: 2,
            authorityEpoch: 2,
            connectionOnline: true,
          },
        },
      ],
    );

    const afterBump = coord.snapshot().approvals;
    const oldCard = afterBump.find((a) => a.approvalKey === a1.approvalKey);
    const newCards = afterBump.filter(
      (a) => a.approvalKey !== a1.approvalKey && a.ownerGeneration === 2,
    );
    expect(oldCard?.state).toBe("stale_owner");
    expect(newCards).toHaveLength(1);
    expect(newCards[0].state).toBe("actionable");
  });

  it("marks expired on deadline and marks orphaned read-only when scope removed with dismissOrphaned", async () => {
    let clock = Date.parse("2026-11-23T10:00:00.000Z");
    const sendRespond = vi.fn(async () => ({ status: "settled" as const }));
    const coord = makeCoordinator({ now: () => clock, sendRespond });

    const expCard = coord.receive({
      gateway: {
        approvalId: "apr-exp",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-1",
        executionGeneration: 1,
        command: "ls",
        description: "List",
        choices: ["once", "deny"],
        expiresAt: "2026-11-23T10:01:00.000Z",
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "S1",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    const remoteCard = coord.receive({
      gateway: {
        approvalId: "apr-rem",
        connectionId: "vps-1",
        profileId: "prod",
        sessionId: "sess-r1",
        turnId: "turn-9",
        executionGeneration: 1,
        command: "ls",
        description: "List remote",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "Prod VPS",
        connectionKind: "remote",
        hostDisplay: "https://vps.example.com",
        profileDisplayName: "Prod",
        sessionTitle: "Remote",
        cwd: "/srv",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    clock = Date.parse("2026-11-23T10:02:00.000Z");
    coord.onExpiryTick();
    expect(coord.snapshot().approvals.find((a) => a.approvalKey === expCard.approvalKey)?.state).toBe(
      "expired",
    );
    await expect(coord.respond(expCard.approvalKey, "once")).rejects.toThrow();

    // Remove remote connection -> orphaned, read-only, never forwarded, only dismissOrphaned works
    coord.onScopeRemoved({ connectionId: "vps-1" });
    const orphanView = coord
      .snapshot()
      .approvals.find((a) => a.approvalKey === remoteCard.approvalKey);
    expect(orphanView?.state).toBe("orphaned");
    expect(orphanView?.canApprove).toBe(false);
    expect(orphanView?.canDeny).toBe(false);
    expect(orphanView?.canInspect).toBe(true);
    expect(orphanView?.canDismiss).toBe(true);

    await expect(coord.respond(remoteCard.approvalKey, "deny")).rejects.toThrow();
    expect(sendRespond).not.toHaveBeenCalled();

    coord.dismissOrphaned(remoteCard.approvalKey);
    expect(coord.snapshot().approvals.some((a) => a.approvalKey === remoteCard.approvalKey)).toBe(
      false,
    );
  });
});

describe("ApprovalAndRecoveryCoordinator — Slice 4: multi-client first-wins, single in-flight, ACK loss recovery", () => {
  it("handles settled_elsewhere_by_server, enforces single in-flight per ApprovalKey, and checks authoritative pending on ACK loss", async () => {
    let mode: "in_flight_hang" | "ack_loss_still_pending" | "ack_loss_gone" | "elsewhere" =
      "elsewhere";
    let releaseRespond!: () => void;

    const coord = makeCoordinator({
      sendRespond: async () => {
        if (mode === "in_flight_hang") {
          await new Promise<void>((r) => {
            releaseRespond = r;
          });
          return { status: "settled" as const };
        }
        if (mode === "ack_loss_still_pending" || mode === "ack_loss_gone") {
          throw new Error("timeout");
        }
        return {
          status: "settled_elsewhere_by_server" as const,
          message: "已在别处处理，该 Approval 已不再等待",
        };
      },
      fetchPending: async () => {
        if (mode === "ack_loss_still_pending") {
          return [
            {
              gateway: {
                approvalId: "apr-ack",
                connectionId: "local",
                profileId: "default",
                sessionId: "sess-1",
                turnId: "turn-2",
                executionGeneration: 1,
                command: "echo ok",
                description: "Test ACK",
                choices: ["once", "deny"],
              },
              main: {
                connectionLabel: "This device",
                connectionKind: "local",
                hostDisplay: "127.0.0.1",
                profileDisplayName: "Default",
                sessionTitle: "S1",
                cwd: "/repo",
                ownerGeneration: 1,
                authorityEpoch: 1,
                connectionOnline: true,
              },
            },
          ];
        }
        return [];
      },
    });

    const v1 = coord.receive({
      gateway: {
        approvalId: "apr-multi",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-1",
        executionGeneration: 1,
        command: "echo 1",
        description: "Multi client",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "S1",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    const resElsewhere = await coord.respond(v1.approvalKey, "once");
    expect(resElsewhere.status).toBe("settled_elsewhere_by_server");
    expect(resElsewhere.approval?.state).toBe("settled_elsewhere_by_server");
    expect(resElsewhere.approval?.statusReason).toContain("已在别处处理");

    // Single in-flight guard + ACK loss checks authoritative pending
    const v2 = coord.receive({
      gateway: {
        approvalId: "apr-ack",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-2",
        executionGeneration: 1,
        command: "echo ok",
        description: "Test ACK",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "S1",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    mode = "ack_loss_still_pending";
    const ackStillPending = await coord.respond(v2.approvalKey, "once");
    expect(ackStillPending.status).toBe("pending_reconciled");
    expect(ackStillPending.approval?.state).toBe("actionable");

    mode = "ack_loss_gone";
    const ackGone = await coord.respond(v2.approvalKey, "once");
    expect(ackGone.status).toBe("settled_elsewhere_by_server");
    expect(ackGone.approval?.state).toBe("settled_elsewhere_by_server");

    // In-flight single-flight check
    const v3 = coord.receive({
      gateway: {
        approvalId: "apr-hang",
        connectionId: "local",
        profileId: "default",
        sessionId: "sess-1",
        turnId: "turn-3",
        executionGeneration: 1,
        command: "echo 3",
        description: "Hang",
        choices: ["once", "deny"],
      },
      main: {
        connectionLabel: "This device",
        connectionKind: "local",
        hostDisplay: "127.0.0.1",
        profileDisplayName: "Default",
        sessionTitle: "S1",
        cwd: "/repo",
        ownerGeneration: 1,
        authorityEpoch: 1,
        connectionOnline: true,
      },
    });

    mode = "in_flight_hang";
    const p3 = coord.respond(v3.approvalKey, "once");
    await expect(coord.respond(v3.approvalKey, "deny")).rejects.toThrow();
    releaseRespond();
    const settled3 = await p3;
    expect(settled3.status).toBe("settled");
  });
});
