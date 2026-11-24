import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent } from "@hermes/contracts";
import { createSequenceTracker } from "@hermes/domain";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import {
  startFakeGatewayServer,
  startFakeRemoteGatewayServer,
} from "../../../../tests/helpers/fakeGatewayServer";
import { ConnectionSupervisor } from "./connectionSupervisor";
import { LocalBackendManager, createNodeLocalBackendPorts } from "./localBackendManager";
import { RegistryStore } from "./registryStore";

async function writeFakeHermesCli(cliPath: string, wsUrl: string) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const rest = args[0] === "--profile" ? args.slice(2) : args;
if (rest[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (rest[0] === "gateway" && rest[1] === "--help") { console.log("{run,ensure,attach,tickets,restart}"); process.exit(0); }
if (rest[0] === "gateway" && rest[1] === "ensure" && rest[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (rest[0] === "gateway" && rest[1] === "attach" && rest[2] === "--help") { console.log("--json --recover"); process.exit(0); }
if (rest[0] === "gateway" && rest[1] === "tickets") { console.log(JSON.stringify({ protocol: 1, purposes: ["interactive"] })); process.exit(0); }
if (rest[0] === "gateway" && rest[1] === "ensure") {
  console.log(JSON.stringify({
    state: "ready", attachable: true,
    endpoint: { profile_id: "default", instance_id: "inst-1", authority_epoch: 1, runtime_protocol: 1, capabilities: ["session-authority-v1"], ws_url: ${JSON.stringify(wsUrl)}, ws_protocol: "hermes-gateway-v1", ticket_protocol_prefix: "hermes-gateway-ticket." }
  }));
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "attach") {
  console.log(JSON.stringify({
    state: "ready", ticket: "tkt_local_multi_1", expires_in_seconds: 30,
    endpoint: { profile_id: "default", instance_id: "inst-1", authority_epoch: 1, runtime_protocol: 1, capabilities: ["session-authority-v1"], ws_url: ${JSON.stringify(wsUrl)}, ws_protocol: "hermes-gateway-v1", ticket_protocol_prefix: "hermes-gateway-ticket." }
  }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(cliPath, script, { encoding: "utf8", mode: 0o755 });
}

describe("ConnectionSupervisor multi-gateway Local + Remote HTTP(S)/WS (S1)", () => {
  it("manages Remote HTTP(S)+WS alongside Local, re-scopes on activation, preserves existing connections on scope switch, and supports Remote sessions + prompts", async () => {
    const sandbox = createTestSandbox("hermes-s1-remote-sup-");
    let passed = false;
    const binDir = path.join(sandbox.rootDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const localGw = await startFakeGatewayServer({
      validTickets: new Set(["tkt_local_multi_1"]),
      initialSessions: [
        { profile_id: "default", session_id: "local-sess-1", title: "Local Chat" },
      ],
    });
    const remoteGw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["remote-tok-1"]),
      useTicketEndpoint: true,
      profiles: [
        { profile_id: "default", display_name: "Prod Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "remote-sess-1", title: "Remote Ops" },
      ],
    });

    const cliPath = path.join(binDir, "hermes");
    await writeFakeHermesCli(cliPath, localGw.wsUrl);
    fs.writeFileSync(
      path.join(sandbox.userDataDir, "local-preferences.json"),
      JSON.stringify({ cliOverridePath: cliPath }),
    );

    const store = new RegistryStore({ rootDir: sandbox.hermesHomeDir });
    const ports = createNodeLocalBackendPorts({
      userDataDir: sandbox.userDataDir,
      hermesHomeDir: sandbox.hermesHomeDir,
      hermesHomeKind: "temp",
      appVersion: "0.1.0",
      buildMode: "dev",
      pickCliFile: async () => ({ cancelled: true }),
    });
    const localBackend = new LocalBackendManager(ports);
    const supervisor = new ConnectionSupervisor(localBackend, { registryStore: store });

    try {
      const localRes = await supervisor.connectLocal("default");
      expect(localRes.ok).toBe(true);
      expect(localGw.connections).toHaveLength(1);

      const addRes = store.add({
        kind: "remote",
        label: "Prod VPS",
        url: remoteGw.baseUrl,
        authMode: "token",
        token: "remote-tok-1",
      });
      expect(addRes.ok).toBe(true);
      const remoteConn = addRes.snapshot.connections.find((c) => c.kind === "remote")!;
      expect(remoteConn).toBeTruthy();

      const remoteRes = await supervisor.connectRemote(remoteConn.id, { activate: true });
      expect(remoteRes.ok).toBe(true);
      expect(remoteRes.fleet.activeScope?.connectionId).toBe(remoteConn.id);
      expect(remoteRes.fleet.activeSessionId).toBe("remote-sess-1");
      expect(remoteRes.fleet.connections.find((c) => c.connectionId === "local")?.actual).toBe("ready");
      expect(remoteRes.fleet.connections.find((c) => c.connectionId === remoteConn.id)?.actual).toBe("ready");

      // Send prompt on active Remote scope
      const sendRes = await supervisor.handlers["prompts.send"](
        { sessionId: "remote-sess-1", text: "hello remote" },
        { connectionId: remoteConn.id, profileId: "default", sessionId: "remote-sess-1" },
      );
      expect((sendRes as { accepted: boolean }).accepted).toBe(true);
      expect(remoteGw.rpcCalls.some((c) => c.method === "prompt.submit" && c.params.text === "hello remote")).toBe(true);

      // Switching back to Local scope must NOT tear down Remote transport or re-dial Local!
      const localWsCountBefore = localGw.connections.length;
      const remoteWsCountBefore = remoteGw.wsConnections.length;
      await supervisor.handlers["scopes.switch"](
        { connectionId: "local", profileId: "default" },
        null,
      );
      expect(supervisor.getFleetSnapshot().activeScope?.connectionId).toBe("local");
      expect(localGw.connections).toHaveLength(localWsCountBefore);
      expect(remoteGw.wsConnections).toHaveLength(remoteWsCountBefore);

      // Renaming Remote (dialMaterialChanged === false) updates label without reconnecting
      const renameRes = store.update(remoteConn.id, {
        kind: "remote",
        label: "Prod VPS Renamed",
        url: remoteGw.baseUrl,
        authMode: "token",
      });
      expect(renameRes.ok).toBe(true);
      expect(
        supervisor.getFleetSnapshot().connections.find((c) => c.connectionId === remoteConn.id)?.label,
      ).toBe("Prod VPS Renamed");
      expect(remoteGw.wsConnections).toHaveLength(remoteWsCountBefore);
      passed = true;
    } finally {
      await supervisor.dispose();
      store.close();
      await remoteGw.close();
      await localGw.close();
      sandbox.cleanup(passed);
    }
  });

  it("transitions Remote connection to auth_required on 401/403 and recovers cleanly when re-authorized", async () => {
    const sandbox = createTestSandbox("hermes-s1-remote-auth-");
    let passed = false;
    const remoteGw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["fresh-oauth-token"]),
      useTicketEndpoint: true,
    });

    const store = new RegistryStore({ rootDir: sandbox.hermesHomeDir });
    const ports = createNodeLocalBackendPorts({
      userDataDir: sandbox.userDataDir,
      hermesHomeDir: sandbox.hermesHomeDir,
      hermesHomeKind: "temp",
      appVersion: "0.1.0",
      buildMode: "dev",
      pickCliFile: async () => ({ cancelled: true }),
    });
    const localBackend = new LocalBackendManager(ports);
    const supervisor = new ConnectionSupervisor(localBackend, { registryStore: store });
    const fleetEvents: BridgeEvent[] = [];
    const unsub = supervisor.subscribe("fleet", null, (ev) => fleetEvents.push(ev));

    try {
      const addRes = store.add({
        kind: "remote",
        label: "Auth Test VPS",
        url: remoteGw.baseUrl,
        authMode: "token",
        token: "expired-token",
      });
      expect(addRes.ok).toBe(true);
      const remoteId = addRes.snapshot.connections.find((c) => c.kind === "remote")!.id;

      const failedDial = await supervisor.connectRemote(remoteId, { activate: true });
      expect(failedDial.ok).toBe(false);
      const health = failedDial.fleet.connections.find((c) => c.connectionId === remoteId);
      expect(health?.actual).toBe("auth_required");
      expect(health?.errorCode).toBe("auth_required");

      // Single attempt; no blind infinite retry hammering /api/gateway/ticket
      vi.useFakeTimers();
      try {
        const ticketCallsAfterFail = remoteGw.httpRequests.filter((r) =>
          r.url.includes("/ticket"),
        ).length;
        // Advance through the supervisor's full 30s backoff window without real time.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(remoteGw.httpRequests.filter((r) => r.url.includes("/ticket")).length).toBe(
          ticketCallsAfterFail,
        );
      } finally {
        vi.useRealTimers();
      }

      // Re-authorize by writing fresh token via RegistryStore and reconnecting
      const secretRes = store.writeSecret({
        kind: "static",
        connectionId: remoteId,
        token: "fresh-oauth-token",
      });
      expect(secretRes.ok).toBe(true);

      const recovered = await supervisor.connectRemote(remoteId, {
        forceReconnect: true,
        activate: true,
      });
      expect(recovered.ok).toBe(true);
      expect(recovered.fleet.connections.find((c) => c.connectionId === remoteId)?.actual).toBe("ready");

      const tracker = createSequenceTracker();
      expect(fleetEvents.length).toBeGreaterThan(1);
      for (const ev of fleetEvents) {
        expect(tracker.accept(ev).status).toBe("applied");
      }
      passed = true;
    } finally {
      unsub();
      await supervisor.dispose();
      store.close();
      await remoteGw.close();
      sandbox.cleanup(passed);
    }
  });

  it("routes a non-default Remote profile over the legacy profile_id path for list/create/resume and submit/cancel", async () => {
    const sandbox = createTestSandbox("hermes-remote-non-default-profile-");
    let passed = false;
    const remoteGw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["remote-ops-token"]),
      useTicketEndpoint: true,
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "remote-default-sess", title: "Default Chat" },
        { profile_id: "ops", session_id: "remote-ops-sess", title: "Ops Chat" },
      ],
    });
    const store = new RegistryStore({ rootDir: sandbox.hermesHomeDir });
    const ports = createNodeLocalBackendPorts({
      userDataDir: sandbox.userDataDir,
      hermesHomeDir: sandbox.hermesHomeDir,
      hermesHomeKind: "temp",
      appVersion: "0.1.0",
      buildMode: "dev",
      pickCliFile: async () => ({ cancelled: true }),
    });
    const supervisor = new ConnectionSupervisor(
      new LocalBackendManager(ports),
      { registryStore: store },
    );

    try {
      const addRes = store.add({
        kind: "remote",
        label: "Ops Remote",
        url: remoteGw.baseUrl,
        authMode: "token",
        token: "remote-ops-token",
      });
      expect(addRes.ok).toBe(true);
      const remoteId = addRes.snapshot.connections.find((c) => c.kind === "remote")!.id;

      const connected = await supervisor.connectRemote(remoteId, {
        profileId: "ops",
        activate: true,
      });
      expect(connected.ok).toBe(true);
      expect(connected.fleet.activeScope).toMatchObject({
        connectionId: remoteId,
        profileId: "ops",
      });
      expect(connected.fleet.sessions.map((s) => s.sessionId)).toContain("remote-ops-sess");
      expect(connected.fleet.sessions.map((s) => s.sessionId)).not.toContain("remote-default-sess");

      const listCalls = remoteGw.rpcCalls.filter((c) => c.method === "session.list");
      expect(listCalls.length).toBeGreaterThan(0);
      for (const call of listCalls) {
        expect(call.params.profile_id).toBe("ops");
        expect(call.params).not.toHaveProperty("profile");
      }

      await supervisor.handlers["sessions.select"](
        { sessionId: "remote-ops-sess" },
        { connectionId: remoteId, profileId: "ops", sessionId: "remote-ops-sess" },
      );
      const resumeCalls = remoteGw.rpcCalls.filter((c) => c.method === "session.resume");
      expect(resumeCalls.length).toBeGreaterThan(0);
      for (const call of resumeCalls) {
        expect(call.params.profile_id).toBe("ops");
        expect(call.params).not.toHaveProperty("profile");
      }

      const created = (await supervisor.handlers["sessions.create"](
        { title: "Ops New Chat" },
        { connectionId: remoteId, profileId: "ops" },
      )) as { session: { sessionId: string; profileId: string } };
      expect(created.session.profileId).toBe("ops");
      const createCall = remoteGw.rpcCalls.find((c) => c.method === "session.create");
      expect(createCall?.params.profile_id).toBe("ops");
      expect(createCall?.params).not.toHaveProperty("profile");

      const send = (await supervisor.handlers["prompts.send"](
        { sessionId: created.session.sessionId, text: "hello ops" },
        { connectionId: remoteId, profileId: "ops", sessionId: created.session.sessionId },
      )) as { accepted: boolean; turnId: string };
      expect(send.accepted).toBe(true);
      const submitCall = remoteGw.rpcCalls.find((c) => c.method === "prompt.submit");
      expect(submitCall?.params.profile_id).toBe("ops");
      expect(submitCall?.params).not.toHaveProperty("profile");
      expect(typeof submitCall?.params.submission_id).toBe("string");

      await supervisor.handlers["prompts.stop"](
        { sessionId: created.session.sessionId, turnId: send.turnId },
        { connectionId: remoteId, profileId: "ops", sessionId: created.session.sessionId },
      );
      const cancelCall = remoteGw.rpcCalls.find((c) => c.method === "prompt.cancel");
      expect(cancelCall?.params.profile_id).toBe("ops");
      expect(cancelCall?.params).not.toHaveProperty("profile");

      for (const method of [
        "session.list",
        "session.resume",
        "session.create",
        "prompt.submit",
        "prompt.cancel",
      ]) {
        for (const call of remoteGw.rpcCalls.filter((c) => c.method === method)) {
          expect(call.params.profile_id).toBe("ops");
        }
      }
      passed = true;
    } finally {
      await supervisor.dispose();
      store.close();
      await remoteGw.close();
      sandbox.cleanup(passed);
    }
  });
});
