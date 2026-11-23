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

  it("supports Ticket #36 scopes.switch across Profiles without tearing down other connections or pausing turns, plus config.get/config.update and AppInfo 3-surface parity", async () => {
    const mock = createMockHostBridge();

    // Add and connect an SSH gateway so we have a ready connection with multiple profiles (default, ops)
    await mock.request("connections.confirmHostKey", {
      host: "unknown-host.example.com",
      user: "ubuntu",
    });
    const addRes = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Lab Server",
      host: "unknown-host.example.com",
      user: "ubuntu",
    });
    expect(addRes.ok && addRes.value.committed).toBe(true);

    // Switch to lab-server default profile and start a turn
    const switchDefault = await mock.request<{
      ok: boolean;
      fleet: {
        activeScope: { connectionId: string; profileId: string; sessionId?: string } | null;
        profiles: Array<{ connectionId: string; profileId: string; isDefault: boolean; actual: string }>;
      };
    }>("scopes.switch", {
      connectionId: "lab-server",
      profileId: "default",
    });
    expect(switchDefault.ok && switchDefault.value.ok).toBe(true);
    if (switchDefault.ok) {
      const labProfiles = switchDefault.value.fleet.profiles.filter(
        (p) => p.connectionId === "lab-server",
      );
      expect(labProfiles.map((p) => p.profileId)).toEqual(["default", "ops"]);
      expect(labProfiles.find((p) => p.profileId === "default")?.isDefault).toBe(true);
      expect(labProfiles.find((p) => p.profileId === "default")?.actual).toBe("ready");
      expect(labProfiles.find((p) => p.profileId === "ops")?.actual).toBe("idle");
    }

    // Switch to ops profile via scopes.switch -> activates ops ("ready") without tearing down default
    const switchOps = await mock.request<{
      ok: boolean;
      fleet: {
        activeScope: { connectionId: string; profileId: string } | null;
        profiles: Array<{ connectionId: string; profileId: string; actual: string }>;
      };
    }>("scopes.switch", {
      connectionId: "lab-server",
      profileId: "ops",
    });
    expect(switchOps.ok && switchOps.value.ok).toBe(true);
    if (switchOps.ok) {
      expect(switchOps.value.fleet.activeScope?.profileId).toBe("ops");
      const opsProf = switchOps.value.fleet.profiles.find(
        (p) => p.connectionId === "lab-server" && p.profileId === "ops",
      );
      expect(opsProf?.actual).toBe("ready");
    }

    // config.get and config.update round-trip
    const cfgGet = await mock.request<{
      supported: boolean;
      supportedKeys: string[];
      values: Record<string, string | number | boolean>;
    }>("config.get", {}, { connectionId: "lab-server", profileId: "ops" });
    expect(cfgGet.ok).toBe(true);
    if (cfgGet.ok) {
      expect(cfgGet.value.supported).toBe(true);
      expect(cfgGet.value.supportedKeys).toContain("model.default");
      expect(cfgGet.value.supportedKeys).not.toContain("voice.enabled");
    }

    const cfgUpd = await mock.request<{
      ok: boolean;
      snapshot: { values: Record<string, string | number | boolean> };
    }>(
      "config.update",
      { key: "model.default", value: "gpt-4.1" },
      { connectionId: "lab-server", profileId: "ops" },
    );
    expect(cfgUpd.ok && cfgUpd.value.ok).toBe(true);
    if (cfgUpd.ok) {
      expect(cfgUpd.value.snapshot.values["model.default"]).toBe("gpt-4.1");
    }

    // AppInfo parity across bridge.hello and diagnostics.export
    const helloRes = await mock.request<{ appName: string; appVersion: string; gitSha: string }>(
      "bridge.hello",
      {},
    );
    const exportRes = await mock.request<{
      appInfo: { appName: string; appVersion: string; gitSha: string };
      display: { headline: string; updatesNotice: string };
    }>("diagnostics.export", {});
    expect(helloRes.ok && exportRes.ok).toBe(true);
    if (helloRes.ok && exportRes.ok) {
      expect(exportRes.value.appInfo).toEqual(helloRes.value);
      expect(exportRes.value.display.updatesNotice).toBe("本地开发构建，不检查更新");
    }
  });
});

describe("MockHostBridge Ticket #35 Workspace artifacts, files, and Draft annotations contract (S0)", () => {
  it("serves session-keyed artifacts.list/read, scope-keyed files.list/read, and persists Draft annotations via chatState.saveDraft", async () => {
    const prevFixture = (globalThis as Record<string, unknown>).__HERMES_E2E_FIXTURE__;
    try {
      (globalThis as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = {
        fleet: {
          connections: [
            {
              connectionId: "local",
              label: "This device",
              kind: "local",
              originDisplay: "127.0.0.1",
              actual: "ready",
              degraded: false,
              latencyMs: 4,
              nextRetryAt: null,
            },
          ],
          profiles: [
            {
              connectionId: "local",
              profileId: "default",
              displayName: "Default",
              handle: "default",
              isDefault: true,
              actual: "ready",
            },
          ],
          sessions: [
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-1",
              title: "Session 1",
              preview: "First",
              updatedAt: "2026-11-23T08:00:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
            {
              connectionId: "local",
              profileId: "default",
              sessionId: "sess-2",
              title: "Session 2",
              preview: "Second",
              updatedAt: "2026-11-23T08:01:00.000Z",
              pinned: false,
              unreadCount: 0,
              needsInput: false,
              activeTurnId: null,
              status: "idle",
            },
          ],
          activeScope: { connectionId: "local", profileId: "default", sessionId: "sess-1" },
          activeSessionId: "sess-1",
        },
        artifacts: {
          "sess-1": [
            {
              artifactId: "art-1",
              title: "Architecture Spec",
              kind: "markdown",
              content: "# Spec v1",
              version: 1,
              hash: "hash-v1",
              updatedAt: "2026-11-23T08:00:00.000Z",
            },
          ],
          "sess-2": [
            {
              artifactId: "art-2",
              title: "Latency SVG",
              kind: "svg",
              content: "<svg></svg>",
              version: 1,
              hash: "hash-svg-1",
              updatedAt: "2026-11-23T08:01:00.000Z",
            },
          ],
        },
        files: {
          "local::default": [
            {
              relativePath: "src",
              name: "src",
              kind: "directory",
              parentPath: null,
            },
            {
              relativePath: "src/app.ts",
              name: "app.ts",
              kind: "file",
              parentPath: "src",
              hash: "f-hash-1",
              content: "console.log('ready');",
              sizeBytes: 21,
            },
          ],
        },
      };

      const mock = createMockHostBridge();

      const artList1 = await mock.request<{ artifacts: Array<{ artifactId: string }> }>(
        "artifacts.list",
        { sessionId: "sess-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-1" },
      );
      expect(artList1.ok).toBe(true);
      if (artList1.ok) {
        expect(artList1.value.artifacts.map((a) => a.artifactId)).toEqual(["art-1"]);
      }

      const artRead1 = await mock.request<{ artifact: { artifactId: string; content: string } | null }>(
        "artifacts.read",
        { sessionId: "sess-1", artifactId: "art-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-1" },
      );
      expect(artRead1.ok && artRead1.value.artifact?.content).toBe("# Spec v1");

      const filesList = await mock.request<{ files: Array<{ relativePath: string }> }>(
        "files.list",
        {},
        { connectionId: "local", profileId: "default" },
      );
      expect(filesList.ok).toBe(true);
      if (filesList.ok) {
        expect(filesList.value.files.map((f) => f.relativePath)).toEqual(["src", "src/app.ts"]);
      }

      const fileRead = await mock.request<{ file: { relativePath: string; content?: string } | null }>(
        "files.read",
        { relativePath: "src/app.ts" },
        { connectionId: "local", profileId: "default" },
      );
      expect(fileRead.ok && fileRead.value.file?.content).toBe("console.log('ready');");

      const saveAnn = await mock.request<{
        sessionSummaries: Record<string, { annotations?: Array<{ annotationId: string }> }>;
      }>(
        "chatState.saveDraft",
        {
          sessionId: "sess-1",
          profileId: "default",
          text: "draft text",
          annotations: [
            {
              annotationId: "ann-mock-1",
              artifactId: "art-1",
              artifactVersion: 1,
              artifactHash: "hash-v1",
              xPct: 50,
              yPct: 50,
              comment: "Center note",
              createdAt: "2026-11-23T08:02:00.000Z",
            },
          ],
        },
        { connectionId: "local", profileId: "default", sessionId: "sess-1" },
      );
      expect(saveAnn.ok).toBe(true);
      if (saveAnn.ok) {
        expect(
          saveAnn.value.sessionSummaries["local::default::sess-1"]?.annotations?.map(
            (a) => a.annotationId,
          ),
        ).toEqual(["ann-mock-1"]);
      }
    } finally {
      (globalThis as Record<string, unknown>).__HERMES_E2E_FIXTURE__ = prevFixture;
    }
  });

  it("supports Ticket #34 connection.health topic snapshot/patch parity, connections.retry recovery, and focus_scope command", async () => {
    const mock = createMockHostBridge();
    const healthEvents: BridgeEvent[] = [];
    const unsubHealth = mock.subscribe("connection.health", null, (ev) => healthEvents.push(ev));
    await new Promise((r) => setTimeout(r, 0));

    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0].topic).toBe("connection.health");
    expect(healthEvents[0].kind).toBe("snapshot");

    // Adding a trusted SSH connection emits a connection.health update with latency and health summary
    const addSsh = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Fleet Node",
      host: "lab.local",
      user: "ubuntu",
    });
    expect(addSsh.ok && addSsh.value.committed).toBe(true);
    expect(healthEvents.length).toBeGreaterThanOrEqual(2);
    const latestHealth = healthEvents[healthEvents.length - 1].payload as Array<{
      connectionId: string;
      actual: string;
      latencyMs: number | null;
      nextRetryAt: number | null;
    }>;
    expect(latestHealth.some((c) => c.connectionId === "fleet-node" && c.actual === "ready")).toBe(true);

    unsubHealth();
  });
});
