import { describe, expect, it } from "vitest";
import type {
  BridgeEvent,
  CapabilitySnapshot,
  ConnectionMutationResponse,
  ConnectionTestResult,
  RegistrySnapshotView,
  SshHostKeyConfirmResult,
} from "@hermes/contracts";
import { createMockHostBridge } from "./mockHostAdapter";

describe("MockHostBridge Local first-run contract (Ticket #25)", () => {
  it("handles local.inspect, local.selectCli cancel, local.diagnose, and safe links.openExternal", async () => {
    const bridge = createMockHostBridge();

    const inspectRes = await bridge.request<{
      connectionId: string;
      actual: string;
      failure: { code: string; actions: string[] } | null;
      cli: { displayName: string; sourceKind: string };
    }>("local.inspect", {});
    expect(inspectRes.ok).toBe(true);
    if (inspectRes.ok) {
      expect(inspectRes.value.connectionId).toBe("local");
      expect(inspectRes.value.actual).toBe("blocked");
      expect(inspectRes.value.failure?.code).toBe("hermes_not_found");
      expect(inspectRes.value.failure?.actions).toEqual([
        "choose_cli",
        "open_install_docs",
        "retry",
      ]);
      expect(inspectRes.value.cli.displayName).not.toContain("/");
    }

    const selectRes = await bridge.request<{ cancelled: boolean }>("local.selectCli", {});
    expect(selectRes.ok).toBe(true);
    if (selectRes.ok) {
      expect(selectRes.value.cancelled).toBe(true);
    }

    const diagRes = await bridge.request<{
      typedFailureCode: string | null;
      hermesHomeKind: string;
      mode: string;
    }>("local.diagnose", {});
    expect(diagRes.ok).toBe(true);
    if (diagRes.ok) {
      expect(diagRes.value.typedFailureCode).toBe("hermes_not_found");
      expect(diagRes.value.hermesHomeKind).toBe("mock");
      expect(diagRes.value.mode).toBe("mock");
      expect(JSON.stringify(diagRes.value)).not.toMatch(/\/Users\/|\/home\/|stderr/i);
    }

    const badLink = await bridge.request("links.openExternal", { url: "file:///etc/passwd" });
    expect(badLink.ok).toBe(false);
    if (!badLink.ok) {
      expect(badLink.error.code).toBe("permission_denied");
    }

    const okLink = await bridge.request("links.openExternal", {
      url: "https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
    });
    expect(okLink.ok).toBe(true);
  });
});

describe("MockHostBridge registry contract parity", () => {
  it("implements connections.* and registry topic contract without fs/network", async () => {
    const mock = createMockHostBridge();
    const events: BridgeEvent[] = [];
    const unsub = mock.subscribe("registry", null, (ev) => events.push(ev));

    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect((events[0].payload as { snapshot: RegistrySnapshotView }).snapshot.connections[0].id).toBe("local");

    const addRes = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Homelab",
      host: "lab.local",
      user: "ubuntu",
    });
    expect(addRes.ok).toBe(true);
    if (addRes.ok) {
      expect(addRes.value.committed).toBe(true);
      expect(addRes.value.snapshot.connections).toHaveLength(2);
    }

    const dupRes = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Homelab 2",
      host: "LAB.LOCAL",
      user: "UBUNTU",
    });
    expect(dupRes.ok).toBe(true);
    if (dupRes.ok) {
      expect(dupRes.value.committed).toBe(false);
      expect(dupRes.value.rejectedIssue?.code).toBe("duplicate_identity");
      expect(dupRes.value.conflict?.existing.label).toBe("Homelab");
    }

    unsub();
  });
});

describe("MockHostBridge Ticket #28 chat/session parity", () => {
  it("keeps empty default fleet and rejects session/prompt commands honestly when unconnected", async () => {
    const mock = createMockHostBridge();

    const fleetEvents: BridgeEvent[] = [];
    const unsub = mock.subscribe("fleet", null, (ev) => fleetEvents.push(ev));
    await new Promise((r) => setTimeout(r, 0));
    expect(fleetEvents).toHaveLength(1);
    expect((fleetEvents[0].payload as { sessions: unknown[] }).sessions).toEqual([]);

    for (const cmd of ["sessions.create", "sessions.select", "sessions.resume", "prompts.send", "prompts.stop"] as const) {
      const res = await mock.request(cmd, { sessionId: "s1", text: "hi" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("unreachable");
      }
    }

    const retryRes = await mock.request<{ ok: boolean }>("connections.retry", { connectionId: "local" });
    expect(retryRes.ok).toBe(true);
    if (retryRes.ok) {
      expect(retryRes.value.ok).toBe(false);
    }

    unsub();
  });

  it("supports capabilities.describe envelope and capabilities topic snapshot (S0)", async () => {
    const mock = createMockHostBridge();
    const capEvents: BridgeEvent<CapabilitySnapshot>[] = [];
    const unsub = mock.subscribe("capabilities", null, (ev) =>
      capEvents.push(ev as BridgeEvent<CapabilitySnapshot>),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(capEvents).toHaveLength(1);
    expect(capEvents[0].topic).toBe("capabilities");
    expect(capEvents[0].kind).toBe("snapshot");
    expect(capEvents[0].seq).toBe(0);
    expect(capEvents[0].payload.counts).toEqual({
      total: 21,
      native: 13,
      readOnly: 3,
      deepLink: 1,
      reachable: 17,
      deferred: 4,
    });

    const descRes = await mock.request<CapabilitySnapshot>("capabilities.describe", {});
    expect(descRes.ok).toBe(true);
    if (descRes.ok) {
      expect(descRes.value.domains).toHaveLength(21);
      expect(descRes.value.entries.some((e) => e.classification === "deferred")).toBe(false);
    }

    unsub();
  });

  it("supports read-only connections.test, OAuth start/cancel/grant, and token_sync_failed parity", async () => {
    const mock = createMockHostBridge();
    const authEvents: BridgeEvent[] = [];
    const unsubAuth = mock.subscribe("auth.state", null, (ev) => authEvents.push(ev));

    // Read-only test leaves registry untouched
    const wsFail = await mock.request<{ ok: boolean; failedStage?: string }>("connections.test", {
      kind: "remote",
      url: "https://ws-fail.example.com",
      authMode: "token",
      token: "tok",
    });
    expect(wsFail.ok).toBe(true);
    if (wsFail.ok) {
      expect(wsFail.value.ok).toBe(false);
      expect(wsFail.value.failedStage).toBe("ws");
    }

    // Cancel OAuth emits cancelled and writes zero connections
    const startedWait = await mock.request<{ authSessionId: string }>("auth.start", {
      kind: "remote",
      url: "https://oauth-wait.example.com",
    });
    expect(startedWait.ok).toBe(true);
    if (startedWait.ok) {
      const cancelRes = await mock.request<{ cancelled: boolean }>("auth.cancel", {
        authSessionId: startedWait.value.authSessionId,
      });
      expect(cancelRes.ok && cancelRes.value.cancelled).toBe(true);
    }
    const listAfterCancel = await mock.request<{ connections: unknown[] }>("connections.list", {});
    expect(listAfterCancel.ok && listAfterCancel.value.connections).toHaveLength(1);
    expect(authEvents.some((ev) => (ev.payload as { status?: string }).status === "cancelled")).toBe(true);

    unsubAuth();
  });

  it("supports Ticket #30 SSH wizard test, host key trust/hard-block, and remote Scope chat without leaking passphrase", async () => {
    const mock = createMockHostBridge();
    const fleetEvents: BridgeEvent[] = [];
    const unsub = mock.subscribe("fleet", null, (ev) => fleetEvents.push(ev));
    await new Promise((r) => setTimeout(r, 0));

    // Unknown host key -> blocked, does NOT trust or write registry
    const unknownRes = await mock.request<ConnectionTestResult>("connections.test", {
      kind: "ssh",
      host: "unknown-host.example.com",
      user: "ubuntu",
      passphrase: "top-secret-passphrase",
    });
    expect(unknownRes.ok).toBe(true);
    if (unknownRes.ok) {
      expect(unknownRes.value.ok).toBe(false);
      expect(unknownRes.value.failureCode).toBe("host_key_unknown");
      expect(unknownRes.value.hostKeyChallenge?.fingerprint).toMatch(/^SHA256:/);
      expect(unknownRes.value.actions).toContain("confirm_host_key");
      expect(JSON.stringify(unknownRes.value)).not.toContain("top-secret-passphrase");
    }

    // Registry untouched by Test
    const regList = await mock.request<{ connections: unknown[] }>("connections.list", {});
    expect(regList.ok && regList.value.connections).toHaveLength(1);

    // Confirm unknown host key -> re-test passes
    const confirmRes = await mock.request<SshHostKeyConfirmResult>("connections.confirmHostKey", {
      host: "unknown-host.example.com",
      user: "ubuntu",
    });
    expect(confirmRes.ok && confirmRes.value.confirmed).toBe(true);

    const passedRes = await mock.request<ConnectionTestResult>("connections.test", {
      kind: "ssh",
      host: "unknown-host.example.com",
      user: "ubuntu",
    });
    expect(passedRes.ok && passedRes.value.ok).toBe(true);

    // Changed host key -> hard-blocked even if confirmHostKey is called
    const changedRes = await mock.request<ConnectionTestResult>("connections.test", {
      kind: "ssh",
      host: "changed-host.example.com",
    });
    expect(changedRes.ok).toBe(true);
    if (changedRes.ok) {
      expect(changedRes.value.ok).toBe(false);
      expect(changedRes.value.failureCode).toBe("host_key_changed");
      expect(changedRes.value.actions).not.toContain("confirm_host_key");
    }
    const bypass = await mock.request<SshHostKeyConfirmResult>("connections.confirmHostKey", {
      host: "changed-host.example.com",
    });
    expect(bypass.ok && bypass.value.hardBlocked).toBe(true);
    expect(bypass.ok && bypass.value.confirmed).toBe(false);

    // Legacy attach-only & Windows Session 0 notices
    const legacyRes = await mock.request<ConnectionTestResult>("connections.test", {
      kind: "ssh",
      host: "legacy-host.example.com",
    });
    expect(legacyRes.ok && legacyRes.value.sshMode).toBe("attach_only");
    expect(legacyRes.ok && legacyRes.value.legacyNotice).toBe(true);

    const win0Res = await mock.request<ConnectionTestResult>("connections.test", {
      kind: "ssh",
      host: "win0-host.example.com",
    });
    expect(win0Res.ok && win0Res.value.windowsServiceSession).toBe(true);
    expect(win0Res.ok && win0Res.value.sshMode).toBe("attach_only");

    // Save SSH gateway -> activates SSH connection in fleet, supports Scope select + prompts.send
    const addSsh = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Lab Server",
      host: "unknown-host.example.com",
      user: "ubuntu",
      passphrase: "top-secret-passphrase",
    });
    expect(addSsh.ok && addSsh.value.committed).toBe(true);

    const selRes = await mock.request("sessions.select", {
      connectionId: "lab-server",
      profileId: "default",
    });
    expect(selRes.ok).toBe(true);
    const allFleetJson = JSON.stringify(fleetEvents);
    expect(allFleetJson).not.toContain("top-secret-passphrase");

    const sendRes = await mock.request("prompts.send", {
      text: "hello remote ssh",
    });
    expect(sendRes.ok).toBe(true);

    unsub();
  });
});
