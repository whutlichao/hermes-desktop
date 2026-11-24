import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ApprovalHighRiskSheetRequest,
  ApprovalRespondResult,
  ApprovalTopicSnapshot,
  BridgeEvent,
  CapabilitySnapshot,
  ChatSessionProjection,
  SafeBackgroundNotification,
  DraftExportBundle,
  SessionTranscriptSnapshot,
  TurnRecoveryTopicSnapshot,
} from "@hermes/contracts";
import {
  makeActiveChatDraftKey,
  makeNewChatDraftKey,
  makeSessionJournalKey,
} from "@hermes/domain";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { startFakeGatewayServer } from "../../../../tests/helpers/fakeGatewayServer";
import { ChatSessionStateStore } from "./chatSessionStateStore";
import { LocalBackendManager, createNodeLocalBackendPorts } from "./localBackendManager";
import { ConnectionSupervisor, LocalConnectionSupervisor } from "./connectionSupervisor";
import { RegistryStore } from "./registryStore";
import { SshTransportManager, createNodeSshTransportPorts } from "./sshTransport";

async function writeFakeHermesCli(options: {
  cliPath: string;
  wsUrl: string;
  perProfileTicketPrefix?: string;
  profileIdentity?: string;
}) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profileId = profileIdx >= 0 && args[profileIdx + 1] ? args[profileIdx + 1] : "default";
const endpointProfileId = ${options.profileIdentity ? JSON.stringify(options.profileIdentity) : "profileId"};
const rest = profileIdx >= 0 ? args.slice(profileIdx + 2) : args;

if (rest[0] === "--version") {
  console.log("Hermes Agent v0.23.3");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "--help") {
  console.log("{run,ensure,attach,tickets,restart}");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "ensure" && rest[2] === "--help") {
  console.log("--json --timeout");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "attach" && rest[2] === "--help") {
  console.log("--json --recover");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "tickets") {
  console.log(JSON.stringify({ protocol: 1, purposes: ["interactive", "native-http"] }));
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "ensure") {
  console.log(JSON.stringify({
    state: "ready",
    attachable: true,
    install_code_sha: "sha_1",
    client_code_sha: "sha_1",
    endpoint: {
      profile_id: endpointProfileId,
      instance_id: "inst-fake-1",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ["session-authority-v1", "host-scope-interactive"],
      code_sha: "sha_1",
      ws_url: ${JSON.stringify(options.wsUrl)},
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  }));
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "attach") {
  const ticket = "${options.perProfileTicketPrefix ?? "tkt_attach_"}" + profileId + "_" + Date.now();
  console.log(JSON.stringify({
    state: "ready",
    ticket,
    expires_in_seconds: 30,
    endpoint: {
      profile_id: endpointProfileId,
      instance_id: "inst-fake-1",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      code_sha: "sha_1",
      ws_url: ${JSON.stringify(options.wsUrl)},
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(options.cliPath, script, { encoding: "utf8", mode: 0o755 });
}

async function bootFakeLocalSupervisor(input: {
  sandbox: ReturnType<typeof createTestSandbox>;
  wsUrl: string;
  validTickets: Set<string>;
  profileIdentity?: string;
}): Promise<ConnectionSupervisor> {
  const cliPath = path.join(input.sandbox.rootDir, "hermes");
  await writeFakeHermesCli({
    cliPath,
    wsUrl: input.wsUrl,
    profileIdentity: input.profileIdentity,
  });
  const ports = createNodeLocalBackendPorts({
    userDataDir: input.sandbox.userDataDir,
    hermesHomeDir: input.sandbox.hermesHomeDir,
    hermesHomeKind: "temp",
    appVersion: "0.1.0",
    buildMode: "dev",
    pickCliFile: async () => ({ cancelled: true }),
  });
  await ports.writeOverridePath(cliPath);
  const origRun = ports.runProcess;
  ports.runProcess = async (req) => {
    const res = await origRun(req);
    if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
      const parsed = JSON.parse(res.stdout) as { ticket?: string };
      if (parsed.ticket) input.validTickets.add(parsed.ticket);
    }
    return res;
  };
  const backend = new LocalBackendManager(ports);
  const supervisor = new LocalConnectionSupervisor(backend);
  await supervisor.connectLocal("default");
  return supervisor;
}

function readJournal(
  supervisor: ConnectionSupervisor,
  connectionId: string,
  profileId: string,
  sessionId: string,
): {
  eventCount: number;
  lastGatewaySeq: number | null;
  resyncRequired: boolean;
} | null {
  const journal = (
    supervisor as unknown as {
      backgroundJournal: {
        getState(key: string):
          | {
              eventCount: number;
              lastGatewaySeq: number | null;
              resyncRequired: boolean;
            }
          | undefined;
      };
    }
  ).backgroundJournal.getState(makeSessionJournalKey(connectionId, profileId, sessionId));
  return journal ?? null;
}

describe("LocalConnectionSupervisor + GatewayClient (S1 fake gateway WS + CLI)", () => {
  it("dials without Origin header, sends exact ticket subprotocols, runs describe + capabilities + subscribe, streams reply/tools, and waits for Stop ACK", async () => {
    const sandbox = createTestSandbox("hermes-s1-chat-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_uds_1", "tkt_uds_2"]);
    let ticketCounter = 0;

    let stopShouldFail = true;
    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "work", display_name: "Work", handle: "work", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "sess-def-1", title: "Local Intro", preview: "ready" },
        { profile_id: "work", session_id: "sess-work-1", title: "Work Task", preview: "work" },
      ],
      onRpc: async (method, params, ctx) => {
        if (method === "prompt.submit") {
          const sid = String(params.session_id);
          const turnId = "turn-stream-1";
          const assistantMsgId = "msg-a-1";
          ctx.replyResult({
            accepted: true,
            session_id: sid,
            turn_id: turnId,
            user_message_id: "msg-u-1",
            assistant_message_id: assistantMsgId,
          });
          queueMicrotask(() => {
            ctx.sendNotification("prompt.delta", {
              session_id: sid,
              turn_id: turnId,
              message_id: assistantMsgId,
              delta: "你好，这是代码：\n```ts\nconst x = 1;\n```",
            });
            ctx.sendNotification("activity", {
              session_id: sid,
              turn_id: turnId,
              message_id: assistantMsgId,
              tool_call_id: "tc-read-1",
              name: "read_file",
              status: "completed",
              summary: "package.json",
            });
          });
          return true;
        }
        if (method === "prompt.cancel") {
          if (stopShouldFail) {
            ctx.replyError(-32000, "Stop ACK lost");
            return true;
          }
          ctx.replyResult({ stopped: true, session_id: params.session_id, turn_id: params.turn_id });
          ctx.sendNotification("prompt.stopped", {
            session_id: params.session_id,
            turn_id: params.turn_id,
            message_id: "msg-a-1",
          });
          return true;
        }
        return false;
      },
    });

    const sockPath = path.join(sandbox.hermesHomeDir, "gateway.sock");
    const udsServer = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        if (req.op === "resolve-profile") {
          socket.write(
            JSON.stringify({
              status: "ok",
              state: "ready",
              attachable: true,
              purposes: ["interactive"],
              endpoint: {
                profile_id: req.profile_id ?? "default",
                instance_id: "inst-fake-1",
                authority_epoch: 1,
                runtime_protocol: 1,
                capabilities: ["session-authority-v1", "host-scope-interactive"],
                code_sha: "sha_1",
                ws_url: gw.wsUrl,
              },
            }) + "\n",
          );
        } else if (req.op === "session-ticket") {
          ticketCounter += 1;
          const t = `tkt_uds_${ticketCounter}`;
          validTickets.add(t);
          socket.write(JSON.stringify({ status: "ok", ticket: t, expires_in_seconds: 30 }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => udsServer.listen(sockPath, resolve));
    fs.chmodSync(sockPath, 0o600);

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend);

      const fleetEvents: BridgeEvent[] = [];
      const transcriptEvents: BridgeEvent[] = [];
      supervisor.subscribe("fleet", null, (ev) => fleetEvents.push(ev));
      supervisor.subscribe("session.transcript", { connectionId: "local", profileId: "default", sessionId: "sess-def-1" }, (ev) =>
        transcriptEvents.push(ev),
      );

      const connected = await supervisor.connectLocal("default");
      expect(connected.ok).toBe(true);

      // Verify zero Origin header and exact subprotocol handshake
      expect(gw.connections).toHaveLength(1);
      expect(gw.connections[0].headers.origin).toBeUndefined();
      expect(gw.connections[0].protocols).toEqual([
        "hermes-gateway-v1",
        "hermes-gateway-ticket.tkt_uds_1",
      ]);

      // Verify runtime.describe + client.capabilities({ server_requests: true }) + subscribe called once
      expect(gw.rpcCalls.some((c) => c.method === "runtime.describe")).toBe(true);
      const capCalls = gw.rpcCalls.filter((c) => c.method === "client.capabilities");
      expect(capCalls).toHaveLength(1);
      expect(capCalls[0].params).toEqual({ server_requests: true });
      expect(gw.rpcCalls.some((c) => c.method === "subscribe")).toBe(true);

      // Switch profile over shared host-scope WS without opening a second WS!
      await supervisor.handlers["sessions.select"](
        { sessionId: "sess-work-1", profileId: "work" },
        { connectionId: "local", profileId: "work", sessionId: "sess-work-1" },
      );
      expect(gw.connections).toHaveLength(1);
      // Switch back to default session
      await supervisor.handlers["sessions.select"](
        { sessionId: "sess-def-1", profileId: "default" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      );

      // Send prompt & observe streaming token delta + tool row
      const sendRes = (await supervisor.handlers["prompts.send"](
        { sessionId: "sess-def-1", text: "给我写一段 ts" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      )) as { turnId: string };
      expect(sendRes.turnId).toBe("turn-stream-1");

      await expect
        .poll(() =>
          transcriptEvents.some(
            (ev) =>
              ev.kind === "patch" &&
              (ev.payload as { type?: string; delta?: string }).type === "token_delta" &&
              (ev.payload as { delta?: string }).delta?.includes("const x = 1;"),
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          transcriptEvents.some(
            (ev) =>
              ev.kind === "patch" &&
              (ev.payload as { type?: string }).type === "tool_row" &&
              (ev.payload as { toolRow?: { name?: string; status?: string } }).toolRow?.name ===
                "read_file" &&
              (ev.payload as { toolRow?: { status?: string } }).toolRow?.status === "completed",
          ),
        )
        .toBe(true);
      const transcriptSnap = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-def-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      )) as { transcript: SessionTranscriptSnapshot };
      expect(transcriptSnap.transcript.activeTurnId).toBe("turn-stream-1");
      const assistantMessage = transcriptSnap.transcript.messages.find(
        (message) => message.messageId === "msg-a-1",
      );
      expect(assistantMessage?.text).toContain("const x = 1;");
      const roles = transcriptSnap.transcript.messages.map((message) => message.role);
      expect(roles.indexOf("user")).toBeLessThan(roles.indexOf("assistant"));

      // Stop failure must NOT pretend the turn stopped!
      await expect(
        supervisor.handlers["prompts.stop"](
          { sessionId: "sess-def-1", turnId: "turn-stream-1" },
          { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
        ),
      ).rejects.toThrow();

      const afterFailedStop = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-def-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      )) as { transcript: SessionTranscriptSnapshot };
      expect(afterFailedStop.transcript.activeTurnId).toBe("turn-stream-1");

      // Now ACK stop -> transitions cleanly to stopped
      stopShouldFail = false;
      const stopOk = (await supervisor.handlers["prompts.stop"](
        { sessionId: "sess-def-1", turnId: "turn-stream-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      )) as { stopped: boolean };
      expect(stopOk.stopped).toBe(true);

      const afterAckStop = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-def-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      )) as { transcript: SessionTranscriptSnapshot };
      expect(afterAckStop.transcript.activeTurnId).toBeNull();

      // Reconnect mints a brand-new ticket (never reuses tkt_uds_1)
      gw.closeAllClients();
      await supervisor.handlers["connections.retry"]({ connectionId: "local" }, null);
      expect(gw.connections).toHaveLength(2);
      expect(gw.connections[1].ticket).toBe("tkt_uds_2");

      // Ensure tickets & wsUrl never leak in fleet or transcript events
      const serialized = JSON.stringify({ fleetEvents, transcriptEvents });
      expect(serialized).not.toContain("tkt_uds_");
      expect(serialized).not.toContain(gw.wsUrl);

      await supervisor.dispose();
      passed = true;
    } finally {
      udsServer.close();
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("retires the local CLI selector alias when the Gateway reports a path profile identity", async () => {
    const sandbox = createTestSandbox("hermes-s1-local-profile-identity-");
    let passed = false;
    const profileIdentity = path.join(sandbox.hermesHomeDir, "profile-identity");
    const validTickets = new Set<string>();
    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "sessions.list",
        "session.list",
      ],
      profiles: [
        {
          profile_id: profileIdentity,
          display_name: "Default",
          handle: "default",
          is_default: true,
        },
      ],
      initialSessions: [],
    });
    let supervisor: ConnectionSupervisor | null = null;

    try {
      supervisor = await bootFakeLocalSupervisor({
        sandbox,
        wsUrl: gw.wsUrl,
        validTickets,
        profileIdentity,
      });

      expect(supervisor.getConnectionLink("local", "default")).toBeNull();
      expect(supervisor.getConnectionLink("local", profileIdentity)?.actual).toBe("ready");
      const health = supervisor.getLocalHealth();
      expect(health.actual).toBe("ready");
      expect(health.degraded).toBe(false);
      expect(health.profileExceptionCount).toBe(0);

      passed = true;
    } finally {
      await supervisor?.dispose();
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("marks Chat unavailable when prompt.submit is missing and hides single -32601 action without disconnecting", async () => {
    const sandbox = createTestSandbox("hermes-s1-readonly-");
    let passed = false;
    const validTickets = new Set<string>();
    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "session.list",
        "session.transcript",
        // Note: prompt.submit and session.create are intentionally absent!
        // session.steer is advertised initially, then returns -32601 on call!
        "session.steer",
      ],
      initialSessions: [{ profile_id: "default", session_id: "sess-ro-1", title: "Readonly Session" }],
      onRpc: (method, _params, ctx) => {
        if (method === "session.steer") {
          ctx.replyError(-32601, "Method not found in runtime");
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend);
      await supervisor.connectLocal("default");

      const snapRes = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-ro-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-ro-1" },
      )) as { transcript: SessionTranscriptSnapshot };

      // prompt.submit missing -> Chat unavailable
      expect(snapRes.transcript.chatAvailable).toBe(false);
      expect(snapRes.transcript.supportedActions.promptSubmit).toBe(false);

      // Sending prompt returns capability_unavailable without disconnecting
      await expect(
        supervisor.handlers["prompts.send"](
          { sessionId: "sess-ro-1", text: "blocked" },
          { connectionId: "local", profileId: "default", sessionId: "sess-ro-1" },
        ),
      ).rejects.toMatchObject({ code: "capability_unavailable" });

      // Single-action -32601 on prompts.steer hides only promptSteer and keeps connection ready!
      await expect(
        supervisor.handlers["prompts.steer"](
          { sessionId: "sess-ro-1", turnId: "t1", text: "steer" },
          { connectionId: "local", profileId: "default", sessionId: "sess-ro-1" },
        ),
      ).rejects.toMatchObject({ code: "capability_unavailable" });

      const afterSteerSnap = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-ro-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-ro-1" },
      )) as { transcript: SessionTranscriptSnapshot };
      expect(afterSteerSnap.transcript.supportedActions.promptSteer).toBe(false);
      expect(supervisor.getFleetSnapshot().connections[0].actual).toBe("ready");
      expect(gw.connections).toHaveLength(1);

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("falls back to per-Profile attach without tearing down existing profile transports when switching profiles", async () => {
    const sandbox = createTestSandbox("hermes-s1-per-profile-");
    let passed = false;
    const validTickets = new Set<string>();
    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "s-def", title: "Default Chat" },
        { profile_id: "ops", session_id: "s-ops", title: "Ops Chat" },
      ],
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend);
      await supervisor.connectLocal("default");
      expect(gw.connections).toHaveLength(1);

      // Select ops session -> dials ops without closing default transport
      await supervisor.handlers["sessions.select"](
        { profileId: "ops", sessionId: "s-ops" },
        { connectionId: "local", profileId: "ops", sessionId: "s-ops" },
      );
      expect(gw.connections).toHaveLength(2);
      expect(supervisor.getFleetSnapshot().activeScope?.profileId).toBe("ops");

      // Switching back to default reuses already-open default transport (no 3rd WS)!
      await supervisor.handlers["sessions.select"](
        { profileId: "default", sessionId: "s-def" },
        { connectionId: "local", profileId: "default", sessionId: "s-def" },
      );
      expect(gw.connections).toHaveLength(2);
      expect(supervisor.getFleetSnapshot().activeScope?.profileId).toBe("default");

      // Creating a session scopes strictly to active profile
      const created = (await supervisor.handlers["sessions.create"](
        { title: "New Ops Check" },
        { connectionId: "local", profileId: "ops" },
      )) as { session: { profileId: string; title: string } };
      expect(created.session.profileId).toBe("ops");
      expect(created.session.title).toBe("New Ops Check");

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("enforces CapabilityRegistry handshake, legacy missing server_requests, served/older/refused tiers, core-5 eager vs lazy probe, timeout->unknown, and generation invalidation (S1)", async () => {
    const sandbox = createTestSandbox("hermes-s1-cap-");
    let passed = false;
    const validTickets = new Set<string>();
    const gw = await startFakeGatewayServer({
      validTickets,
      onRpc: (method, _params, ctx) => {
        if (method === "runtime.describe") {
          ctx.replyResult({
            runtime_protocol: 1,
            code_sha: "sha_cap_1",
            capabilities: ["session-authority-v1", "host-scope-interactive"],
            served_methods: [
              "runtime.describe",
              "subscribe",
              "profiles.list",
              "session.list",
              "session.create",
              "session.resume",
              "session.transcript",
              "prompt.submit",
              "prompt.cancel",
              "session.steer",
              "approval.list",
            ],
            older_methods: ["skills.list", "config.get"],
            refused_methods: ["tools.show", "session.delete"],
            session_create: { sources: ["desktop"], parameters: ["title", "profile_id"] },
          });
          return true;
        }
        // Legacy owner: client.capabilities returns -32601!
        if (method === "client.capabilities") {
          ctx.replyError(-32601, "Method not found: client.capabilities");
          return true;
        }
        if (method === "config.get") {
          // Never reply so the settings probe times out -> unknown without blocking connect.
          return true;
        }
        if (method === "skills.list") {
          ctx.replyResult({ skills: [{ name: "git" }] });
          return true;
        }
        if (method === "tools.show") {
          ctx.replyResult({ tools: [] });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend, { probeTimeoutMs: 40 });
      const capEvents: BridgeEvent<CapabilitySnapshot>[] = [];
      supervisor.subscribe("capabilities", null, (ev) =>
        capEvents.push(ev as BridgeEvent<CapabilitySnapshot>),
      );

      await supervisor.connectLocal("default");

      // 1. client.capabilities({ server_requests: true }) sent exactly once per ready
      const capCalls = gw.rpcCalls.filter((c) => c.method === "client.capabilities");
      expect(capCalls).toHaveLength(1);
      expect(capCalls[0].params).toEqual({ server_requests: true });

      // 2. Non-core domains (skills, tools, mcp, cron...) must NOT be probed eagerly on connect
      expect(gw.rpcCalls.some((c) => c.method === "skills.list")).toBe(false);
      expect(gw.rpcCalls.some((c) => c.method === "tools.show")).toBe(false);

      const initialSnap = (await supervisor.handlers["capabilities.describe"]({}, null)) as CapabilitySnapshot;
      expect(initialSnap.key.connectionId).toBe("local");
      expect(initialSnap.key.profileId).toBe("default");
      expect(initialSnap.key.gatewayVersionOrSha).toBe("sha_cap_1");
      expect(initialSnap.legacyOwner).toBe(true);
      expect(initialSnap.serverRequestsSupported).toBe(false);
      // Missing server_requests -> approval unavailable
      expect(initialSnap.domains.find((d) => d.domain === "approval")?.runtimeStatus).toBe("unavailable");
      // Settings timed out -> unknown without blocking connect
      expect(initialSnap.domains.find((d) => d.domain === "settings")?.runtimeStatus).toBe("unknown");

      // 3. Lazy probe on non-core "skills" (older) -> calls skills.list once and tags degraded
      const afterSkills = (await supervisor.handlers["capabilities.describe"](
        { domain: "skills" },
        null,
      )) as CapabilitySnapshot;
      expect(gw.rpcCalls.filter((c) => c.method === "skills.list")).toHaveLength(1);
      const skillsDom = afterSkills.domains.find((d) => d.domain === "skills");
      expect(skillsDom?.probed).toBe(true);
      expect(skillsDom?.runtimeStatus).toBe("degraded");
      expect(skillsDom?.degradation?.reason).toBe("older");

      // 4. Refused domain "tools" ("tools.show" in refused_methods) MUST NEVER be invoked on wire!
      const afterTools = (await supervisor.handlers["capabilities.describe"](
        { domain: "tools" },
        null,
      )) as CapabilitySnapshot;
      expect(gw.rpcCalls.some((c) => c.method === "tools.show")).toBe(false);
      expect(afterTools.domains.find((d) => d.domain === "tools")?.runtimeStatus).toBe("unavailable");
      expect(afterTools.entries.some((e) => e.domain === "tools")).toBe(false);

      // 5. Reconnect bumps ownerGeneration and invalidates previous generation
      const prevGen = afterTools.generation;
      const prevOwnerGen = afterTools.key.ownerGeneration;
      await supervisor.handlers["connections.retry"]({ connectionId: "local" }, null);
      const afterRetry = (await supervisor.handlers["capabilities.describe"]({}, null)) as CapabilitySnapshot;
      expect(afterRetry.key.ownerGeneration).toBeGreaterThan(prevOwnerGen);
      expect(afterRetry.generation).toBeGreaterThan(prevGen);
      expect(capEvents.length).toBeGreaterThanOrEqual(2);

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("restores lastActiveChat via ChatSessionStateStore after snapshot, handles session_missing without auto session.create, and replaces torn transcript on resync", async () => {
    const sandbox = createTestSandbox("hermes-s1-recovery-resync-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_rec_1"]);
    let resumeCount = 0;

    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "s-def", title: "Default Chat" },
        { profile_id: "ops", session_id: "s-ops", title: "Ops Chat" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "session.resume") {
          resumeCount += 1;
          const sid = String(params.session_id ?? "");
          ctx.replyResult({
            session_id: sid,
            messages: [
              {
                message_id: `gw-msg-${resumeCount}`,
                role: "assistant",
                text: `Authoritative reply #${resumeCount}`,
                created_at: "2026-11-23T06:00:00Z",
              },
            ],
            active_turn_id: null,
          });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      // Pre-seed persisted ChatSessionStateStore pointing to missing session WITH draft
      const seedStore = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      seedStore.recordActiveChat({
        connectionId: "local",
        profileId: "default",
        sessionId: "s-deleted-with-draft",
      });
      seedStore.saveDraft(
        { connectionId: "local", profileId: "default", sessionId: "s-deleted-with-draft" },
        "unsent recovery draft",
      );

      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend, { chatSessionStateStore: store });

      await supervisor.connectLocal("default");

      const chatState = (await supervisor.handlers["chatState.get"]({}, null)) as ChatSessionProjection;
      expect(chatState.activeStatus).toBe("session_missing");
      expect(chatState.missingSession?.sessionId).toBe("s-deleted-with-draft");
      expect(chatState.missingSession?.draftText).toBe("unsent recovery draft");
      // Must NEVER auto-call session.create
      expect(gw.rpcCalls.filter((c) => c.method === "session.create")).toHaveLength(0);

      // Dismiss missing session -> falls back to s-def cleanly
      const afterDismiss = (await supervisor.handlers["chatState.dismissMissingSession"]({}, null)) as ChatSessionProjection;
      expect(afterDismiss.activeStatus).toBe("ready");
      expect(afterDismiss.lastActiveChat?.sessionId).toBe("s-def");
      expect(supervisor.getFleetSnapshot().activeSessionId).toBe("s-def");

      // Resync replacement replaces entire transcript cleanly with resynced=true
      const resynced = (await supervisor.handlers["sessions.resume"](
        { sessionId: "s-def", resync: true },
        { connectionId: "local", profileId: "default", sessionId: "s-def" },
      )) as { transcript: SessionTranscriptSnapshot };
      expect(resynced.transcript.resynced).toBe(true);
      expect(resynced.transcript.messages).toHaveLength(1);
      expect(resynced.transcript.messages[0].text).toContain("Authoritative reply #");

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("connects SSH via tickets --serve + loopback tunnel alongside Local, preserves Scope connections, re-mints tickets on WS drop, and tears down on removal", async () => {
    const sandbox = createTestSandbox("hermes-s1-s2-ssh-");
    let passed = false;
    const localTickets = new Set<string>(["tkt_local_1"]);
    const sshTickets = new Set<string>();
    let sshMintSeq = 0;

    const localGw = await startFakeGatewayServer({
      validTickets: localTickets,
      profiles: [{ profile_id: "default", display_name: "Default", handle: "default", is_default: true }],
      initialSessions: [{ profile_id: "default", session_id: "sess-local-1", title: "Local Thread" }],
    });

    const sshGw = await startFakeGatewayServer({
      validTickets: sshTickets,
      profiles: [
        { profile_id: "default", display_name: "Remote Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Remote Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "sess-ssh-1", title: "Remote Shell", preview: "online" },
        { profile_id: "ops", session_id: "sess-ssh-ops", title: "Ops Audit", preview: "audit" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "prompt.submit") {
          const sid = String(params.session_id);
          const turnId = "ssh-turn-1";
          const assistantMsgId = "ssh-msg-a-1";
          ctx.replyResult({
            accepted: true,
            session_id: sid,
            turn_id: turnId,
            user_message_id: "ssh-msg-u-1",
            assistant_message_id: assistantMsgId,
          });
          queueMicrotask(() => {
            ctx.sendNotification("prompt.delta", {
              profile_id: params.profile_id,
              session_id: sid,
              turn_id: turnId,
              message_id: assistantMsgId,
              delta: "Remote SSH reply OK",
            });
            ctx.sendNotification("prompt.completed", {
              profile_id: params.profile_id,
              session_id: sid,
              turn_id: turnId,
              message_id: assistantMsgId,
            });
          });
          return true;
        }
        return false;
      },
    });

    try {
      // Local fake CLI + UDS
      const localUds = path.join(sandbox.hermesHomeDir, "gateway.sock");
      const udsServer = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
          buf = buf.slice(nl + 1);
          if (req.op === "resolve-profile") {
            sock.write(
              JSON.stringify({
                status: "ok",
                state: "ready",
                attachable: true,
                purposes: ["interactive"],
                endpoint: {
                  profile_id: req.profile_id ?? "default",
                  instance_id: "inst-local-1",
                  authority_epoch: 1,
                  runtime_protocol: 1,
                  capabilities: ["session-authority-v1", "host-scope-interactive"],
                  code_sha: "sha_local_1",
                  ws_url: localGw.wsUrl,
                },
              }) + "\n",
            );
          } else if (req.op === "session-ticket") {
            sock.write(
              JSON.stringify({
                status: "ok",
                ticket: "tkt_local_1",
                expires_in_seconds: 30,
              }) + "\n",
            );
          }
        });
      });
      await new Promise<void>((r) => udsServer.listen(localUds, r));
      fs.chmodSync(localUds, 0o600);

      const localCliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath: localCliPath, wsUrl: localGw.wsUrl });
      const localPorts = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await localPorts.writeOverridePath(localCliPath);
      const localBackend = new LocalBackendManager(localPorts);

      // Fake SSH binary suite
      const binDir = path.join(sandbox.rootDir, "ssh-bin");
      const knownHostsPath = path.join(sandbox.rootDir, "known_hosts");
      const auditLogPath = path.join(sandbox.rootDir, "ssh-audit.jsonl");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(knownHostsPath, "remote.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY\n", {
        mode: 0o600,
      });

      const sshBin = path.join(binDir, "ssh");
      const keyscanBin = path.join(binDir, "ssh-keyscan");
      const keygenBin = path.join(binDir, "ssh-keygen");
      fs.writeFileSync(
        sshBin,
        `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
let pass = null;
if (process.env.SSH_ASKPASS) {
  pass = execFileSync(process.env.SSH_ASKPASS, [], { encoding: "utf8" }).replace(/\\r?\\n$/, "");
}
if (pass !== "ssh-secret-pass") {
  process.stderr.write("Permission denied (publickey).\\n");
  process.exit(255);
}
fs.appendFileSync(${JSON.stringify(auditLogPath)}, JSON.stringify(args) + "\\n");
const lIdx = args.indexOf("-L");
if (args.includes("-N") && lIdx >= 0) {
  const parts = args[lIdx + 1].split(":");
  const lp = Number(parts[1]);
  const rp = Number(parts[3]);
  const srv = net.createServer((s) => {
    const up = net.connect(rp, "127.0.0.1");
    s.pipe(up);
    up.pipe(s);
    s.on("error", () => up.destroy());
    up.on("error", () => s.destroy());
  });
  srv.listen(lp, "127.0.0.1");
  process.on("SIGTERM", () => srv.close(() => process.exit(0)));
  return;
}
const cmd = args[args.length - 1] || "";
if (cmd.includes("tickets --probe --json")) {
  console.log(JSON.stringify({ protocol: 1, purposes: ["interactive"], remote_port: ${sshGw.port} }));
  process.exit(0);
}
if (cmd.includes("tickets --serve")) {
  console.log(JSON.stringify({ state: "ready", remote_port: ${sshGw.port} }));
  const rl = readline.createInterface({ input: process.stdin });
  let n = 0;
  rl.on("line", (line) => {
    const req = JSON.parse(line || "{}");
    n += 1;
    const tkt = "tkt_ssh_" + (req.profile_id || "default") + "_" + n;
    console.log(JSON.stringify({
      ticket: tkt,
      expires_in_seconds: 30,
      endpoint: {
        profile_id: req.profile_id || "default",
        instance_id: "inst-ssh-1",
        authority_epoch: 1,
        runtime_protocol: 1,
        capabilities: ["session-authority-v1", "host-scope-interactive"],
        ws_url: "ws://127.0.0.1:${sshGw.port}/api/ws",
        ws_protocol: "hermes-gateway-v1",
        ticket_protocol_prefix: "hermes-gateway-ticket."
      }
    }));
  });
  process.on("SIGTERM", () => process.exit(0));
  return;
}
process.exit(1);
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(keyscanBin, "#!/usr/bin/env node\nconsole.log('remote.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY');\n", { mode: 0o755 });
      fs.writeFileSync(keygenBin, "#!/usr/bin/env node\nconsole.log('256 SHA256:FakeFp remote.example.com (ED25519)');\n", { mode: 0o755 });

      const sshPorts = createNodeSshTransportPorts({
        askpassSandboxDir: sandbox.userDataDir,
        knownHostsPath,
        sshBinaryPath: sshBin,
        sshKeyscanBinaryPath: keyscanBin,
        sshKeygenBinaryPath: keygenBin,
        confirmHostKeyPrompt: async () => false,
      });
      // Register dynamic tickets emitted by fake ssh binary into fake gateway WS server
      const origSpawn = sshPorts.spawnSshStream;
      sshPorts.spawnSshStream = (args, spawnOpts) => {
        const proc = origSpawn(args, spawnOpts);
        proc.onLine((line) => {
          try {
            const parsed = JSON.parse(line) as { ticket?: string };
            if (parsed.ticket) {
              sshMintSeq += 1;
              sshTickets.add(parsed.ticket);
            }
          } catch {}
        });
        return proc;
      };

      const sshTransport = new SshTransportManager(sshPorts);
      const registryStore = new RegistryStore({ rootDir: sandbox.hermesHomeDir, allowRealHome: false });
      const supervisor = new LocalConnectionSupervisor(localBackend, {
        registryStore,
        sshTransport,
      });

      await supervisor.connectLocal("default");
      expect(localGw.connections).toHaveLength(1);

      const added = registryStore.add({
        kind: "ssh",
        label: "Prod Cluster",
        host: "remote.example.com",
        user: "ubuntu",
        passphrase: "ssh-secret-pass",
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const sshConnId = added.snapshot.connections.find((c) => c.kind === "ssh")!.id;
      sshTransport.setSessionPassphrase(sshConnId, "ssh-secret-pass");
      await supervisor.handleRegistrySnapshot(added.snapshot, added.diff);

      const fleetAfterAdd = supervisor.getFleetSnapshot();
      const sshHealth = fleetAfterAdd.connections.find((c) => c.connectionId === sshConnId);
      expect(sshHealth?.actual).toBe("ready");
      expect(fleetAfterAdd.profiles.some((p) => p.connectionId === sshConnId && p.profileId === "ops")).toBe(true);
      expect(sshGw.connections).toHaveLength(1);

      // Select SSH Scope -> verify remote chat works, and Local stays connected!
      await supervisor.handlers["sessions.select"](
        { connectionId: sshConnId, profileId: "default", sessionId: "sess-ssh-1" },
        { connectionId: sshConnId, profileId: "default", sessionId: "sess-ssh-1" },
      );

      const transcriptEvents: BridgeEvent[] = [];
      const unsubTx = supervisor.subscribe(
        "session.transcript",
        { connectionId: sshConnId, profileId: "default", sessionId: "sess-ssh-1" },
        (ev) => transcriptEvents.push(ev),
      );

      await supervisor.handlers["prompts.send"](
        { sessionId: "sess-ssh-1", text: "status check" },
        { connectionId: sshConnId, profileId: "default", sessionId: "sess-ssh-1" },
      );
      await expect
        .poll(() =>
          transcriptEvents.some(
            (e) =>
              e.kind === "patch" &&
              (e.payload as { type?: string; delta?: string }).delta === "Remote SSH reply OK",
          ),
        )
        .toBe(true);
      unsubTx();

      // Switch Scope back to Local -> NEVER drops SSH or opens duplicate WS
      await supervisor.handlers["sessions.select"](
        { connectionId: "local", profileId: "default", sessionId: "sess-local-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-local-1" },
      );
      expect(localGw.connections).toHaveLength(1);
      expect(sshGw.connections).toHaveLength(1);

      // Drop SSH WS -> supervisor automatically re-mints a fresh ticket from existing tickets --serve WITHOUT spawning another tunnel!
      sshGw.closeAllClients();
      await expect.poll(() => sshGw.connections.length, { timeout: 5_000 }).toBe(2);
      expect(sshGw.connections).toHaveLength(2);
      expect(sshMintSeq).toBe(2);
      const auditLines = fs
        .readFileSync(auditLogPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[]);
      expect(auditLines.filter((a) => a.includes("-L"))).toHaveLength(1);

      // Label-only update preserves label cleanly without reconnecting
      const updated = registryStore.update(sshConnId, {
        kind: "ssh",
        label: "Prod Cluster Renamed",
        host: "remote.example.com",
        user: "ubuntu",
      });
      expect(updated.ok).toBe(true);
      if (updated.ok) {
        await supervisor.handleRegistrySnapshot(updated.snapshot, updated.diff);
        expect(sshGw.connections).toHaveLength(2);
        expect(
          supervisor.getFleetSnapshot().connections.find((c) => c.connectionId === sshConnId)?.label,
        ).toBe("Prod Cluster Renamed");
      }

      // Disk file must NEVER contain passphrase or ticket
      const diskReg = fs.readFileSync(path.join(sandbox.hermesHomeDir, "gateway-connections.json"), "utf8");
      expect(diskReg).not.toContain("ssh-secret-pass");
      expect(diskReg).not.toContain("tkt_ssh_");

      // Remove SSH -> clears passphrase & closes transport cleanly
      const removed = registryStore.remove(sshConnId);
      expect(removed.ok).toBe(true);
      if (removed.ok) {
        await supervisor.handleRegistrySnapshot(removed.snapshot, removed.diff);
      }
      expect(sshTransport.hasSessionPassphrase(sshConnId)).toBe(false);
      expect(supervisor.getFleetSnapshot().connections.some((c) => c.connectionId === sshConnId)).toBe(false);

      await supervisor.dispose();
      registryStore.close();
      udsServer.close();
      passed = true;
    } finally {
      await localGw.close();
      await sshGw.close();
      sandbox.cleanup(passed);
    }
  });

  it("switches Profile/Scope via scopes.switch without tearing down connections or pausing turns, remembers lastSessionByScope, and supports feature-detected config.get/config.update (Ticket #36 S1)", async () => {
    const sandbox = createTestSandbox("hermes-s1-t36-");
    let passed = false;
    const validTickets = new Set<string>();
    const gatewayConfig: Record<string, string | number | boolean> = {
      "model.default": "claude-3-7-sonnet",
      "chat.send_on_enter": true,
      "voice.enabled": true,
      "cloud.tier": "enterprise",
    };

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "session.list",
        "session.create",
        "session.resume",
        "session.transcript",
        "prompt.submit",
        "prompt.cancel",
        "session.steer",
        "config.get",
        "config.update",
      ],
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "s-def-1", title: "Default Session 1" },
        { profile_id: "default", session_id: "s-def-2", title: "Default Session 2" },
        { profile_id: "ops", session_id: "s-ops-1", title: "Ops Session 1" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "prompt.submit") {
          // Leave turn in-flight (do not immediately send turn_completed)
          ctx.replyResult({
            turn_id: "turn-inflight-def",
            user_message_id: "u-1",
            assistant_message_id: "a-1",
          });
          return true;
        }
        if (method === "config.get") {
          ctx.replyResult({
            supported_keys: Object.keys(gatewayConfig),
            values: { ...gatewayConfig },
          });
          return true;
        }
        if (method === "config.update" || method === "config.set") {
          const k = typeof params.key === "string" ? params.key : "";
          const v = params.value as string | number | boolean;
          if (k) {
            gatewayConfig[k] = v;
          }
          ctx.replyResult({
            ok: true,
            supported_keys: Object.keys(gatewayConfig),
            values: { ...gatewayConfig },
          });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const chatStore = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend, {
        chatSessionStateStore: chatStore,
      });
      await supervisor.connectLocal("default");

      // Select s-def-2 on default profile and start an in-flight turn
      await supervisor.handlers["sessions.select"](
        { profileId: "default", sessionId: "s-def-2" },
        { connectionId: "local", profileId: "default", sessionId: "s-def-2" },
      );
      await supervisor.handlers["prompts.send"](
        { sessionId: "s-def-2", text: "Long running analysis" },
        { connectionId: "local", profileId: "default", sessionId: "s-def-2" },
      );

      // Switch to ops via scopes.switch
      const switchOps = (await supervisor.handlers["scopes.switch"](
        { connectionId: "local", profileId: "ops" },
        { connectionId: "local", profileId: "ops" },
      )) as {
        ok: boolean;
        fleet: {
          activeScope: { connectionId: string; profileId: string; sessionId?: string } | null;
          profiles: Array<{ profileId: string; actual: string; isDefault: boolean }>;
          sessions: Array<{ sessionId: string; activeTurnId: string | null }>;
        };
      };
      expect(switchOps.ok).toBe(true);
      expect(switchOps.fleet.activeScope).toEqual({
        connectionId: "local",
        profileId: "ops",
        sessionId: "s-ops-1",
      });
      // Both default and ops profiles are now ready (neither was torn down)
      expect(switchOps.fleet.profiles.find((p) => p.profileId === "default")?.actual).toBe("ready");
      expect(switchOps.fleet.profiles.find((p) => p.profileId === "ops")?.actual).toBe("ready");
      // In-flight turn on s-def-2 was NOT paused or cancelled!
      expect(
        gw.rpcCalls.some((c) => c.method === "prompt.cancel"),
      ).toBe(false);

      // Switch back to default via scopes.switch without explicit sessionId -> restores s-def-2 from lastSessionByScope!
      const switchBack = (await supervisor.handlers["scopes.switch"](
        { connectionId: "local", profileId: "default" },
        { connectionId: "local", profileId: "default" },
      )) as {
        ok: boolean;
        fleet: {
          activeScope: { connectionId: string; profileId: string; sessionId?: string } | null;
        };
        transcript: { sessionId: string; activeTurnId: string | null } | null;
      };
      expect(switchBack.ok).toBe(true);
      expect(switchBack.fleet.activeScope?.sessionId).toBe("s-def-2");
      expect(switchBack.transcript?.activeTurnId).toBe("turn-inflight-def");

      // Feature-detected config.get and config.update strip voice/cloud keys and round-trip supported keys
      const cfgSnap = (await supervisor.handlers["config.get"](
        {},
        { connectionId: "local", profileId: "default" },
      )) as {
        supported: boolean;
        supportedKeys: string[];
        values: Record<string, string | number | boolean>;
      };
      expect(cfgSnap.supported).toBe(true);
      expect(cfgSnap.supportedKeys).toEqual(["model.default", "chat.send_on_enter"]);
      expect(cfgSnap.values["voice.enabled"]).toBeUndefined();
      expect(cfgSnap.values["cloud.tier"]).toBeUndefined();

      const cfgUpdated = (await supervisor.handlers["config.update"](
        { key: "model.default", value: "gpt-4.1" },
        { connectionId: "local", profileId: "default" },
      )) as {
        ok: boolean;
        snapshot: { values: Record<string, string | number | boolean> };
      };
      expect(cfgUpdated.ok).toBe(true);
      expect(cfgUpdated.snapshot.values["model.default"]).toBe("gpt-4.1");

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("manages always-connected Fleet lifecycle (#34): desired/actual transitions, startup concurrency cap=4 with local+Primary priority, 1s->30s full-jitter backoff + 5s stable reset + manual Retry, 15s/45s heartbeat, shared socket per-Profile resync & profile_not_served isolation, suspend/resume stagger, <=2s bounded shutdown, and background minimal notifications", async () => {
    const sandbox = createTestSandbox("hermes-s1-fleet-34-");
    let passed = false;

    let currentTime = 1_000_000;
    let rngValue = 0.5;
    const scheduledTimers = new Map<
      number,
      { id: number; runAt: number; delayMs: number; cb: () => void }
    >();
    let timerSeq = 0;

      let supervisorRef: InstanceType<typeof LocalConnectionSupervisor> | null = null;
      const flushMicrotasksAndTimers = async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await supervisorRef?.waitForInflightDials();
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      const advanceFakeClock = async (ms: number) => {
        const target = currentTime + ms;
        while (true) {
          const due = [...scheduledTimers.values()]
            .filter((t) => t.runAt <= target)
            .sort((a, b) => a.runAt - b.runAt || a.id - b.id);
          if (due.length === 0) break;
          const next = due[0];
          scheduledTimers.delete(next.id);
          currentTime = next.runAt;
          next.cb();
          await flushMicrotasksAndTimers();
        }
        currentTime = target;
        await flushMicrotasksAndTimers();
      };

    const validTickets = new Set<string>();
    for (let i = 1; i <= 50; i += 1) {
      validTickets.add(`tkt_fleet_${i}`);
    }
    let ticketSeq = 0;
    let blockOpsProfile = false;
    let activeProfilesList = [
      { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
      { profile_id: "work", display_name: "Work", handle: "work", is_default: false },
      { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
    ];

    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: activeProfilesList,
      initialSessions: [
        { profile_id: "default", session_id: "s-def", title: "Default Session" },
        { profile_id: "work", session_id: "s-work", title: "Work Session" },
        { profile_id: "ops", session_id: "s-ops", title: "Ops Session" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "profiles.list") {
          ctx.replyResult({ profiles: activeProfilesList });
          return true;
        }
        if ((method === "session.list" || method === "sessions.list") && params.profile_id === "ops" && blockOpsProfile) {
          ctx.replyError(-32004, "profile_not_served");
          return true;
        }
        if (method === "prompt.submit") {
          const sid = String(params.session_id);
          const pid = String(params.profile_id ?? "default");
          const turnId = `turn-${pid}-1`;
          ctx.replyResult({
            accepted: true,
            session_id: sid,
            turn_id: turnId,
            user_message_id: `u-${pid}`,
            assistant_message_id: `a-${pid}`,
          });
          return true;
        }
        return false;
      },
    });

    try {
      const udsPath = path.join(sandbox.hermesHomeDir, "gateway.sock");
      let failUdsResolveCount = 0;
      let ticketUnavailableOnce = false;
      let udsAttachRecoverCount = 0;

      const udsServer = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
          buf = buf.slice(nl + 1);
          if (req.op === "resolve-profile") {
            if (failUdsResolveCount > 0) {
              failUdsResolveCount -= 1;
              sock.write(
                JSON.stringify({
                  status: "update_paused",
                  reason: "gateway_restarting",
                }) + "\n",
              );
              return;
            }
            sock.write(
              JSON.stringify({
                status: "ok",
                state: "ready",
                attachable: true,
                purposes: ["interactive"],
                endpoint: {
                  profile_id: req.profile_id ?? "default",
                  instance_id: "inst-fleet-1",
                  authority_epoch: 1,
                  runtime_protocol: 1,
                  capabilities: ["session-authority-v1", "host-scope-interactive"],
                  code_sha: "sha_fleet",
                  ws_url: gw.wsUrl,
                },
              }) + "\n",
            );
          } else if (req.op === "session-ticket") {
            if (ticketUnavailableOnce) {
              ticketUnavailableOnce = false;
              udsAttachRecoverCount += 1;
              sock.write(
                JSON.stringify({
                  status: "refused",
                  reason: "ticket_unavailable",
                }) + "\n",
              );
              return;
            }
            ticketSeq += 1;
            const tkt = `tkt_fleet_${ticketSeq}`;
            validTickets.add(tkt);
            sock.write(
              JSON.stringify({
                status: "ok",
                ticket: tkt,
                expires_in_seconds: 30,
              }) + "\n",
            );
          }
        });
      });
      await new Promise<void>((r) => udsServer.listen(udsPath, r));
      fs.chmodSync(udsPath, 0o600);

      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({
        cliPath,
        wsUrl: gw.wsUrl,
        perProfileTicketPrefix: "tkt_cli_fallback_",
      });
      // Pre-seed fallback tickets in case ticket_unavailable falls back to CLI attach
      for (const p of ["default", "work", "ops"]) {
        // Fake CLI uses Date.now(), so let's make validTickets accept tkt_fleet_* and we also test UDS re-attach
        void p;
      }

      const localPorts = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await localPorts.writeOverridePath(cliPath);
      const localBackend = new LocalBackendManager({
        ...localPorts,
        getControlSocketCandidates: () => [udsPath],
      });

      const store = new RegistryStore({ rootDir: sandbox.hermesHomeDir });
      let appIsForeground = true;
      const notifications: Array<{
        kind: string;
        title: string;
        body: string;
        scope: { connectionId: string; profileId?: string; sessionId?: string };
      }> = [];

      const supervisor = new LocalConnectionSupervisor(localBackend, {
        registryStore: store,
        now: () => currentTime,
        random: () => rngValue,
        setTimer: (cb, delayMs) => {
          timerSeq += 1;
          const id = timerSeq;
          scheduledTimers.set(id, { id, runAt: currentTime + delayMs, delayMs, cb });
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (handle) => {
          scheduledTimers.delete(handle as unknown as number);
        },
        isAppForeground: () => appIsForeground,
        onBackgroundNotification: (notif) => {
          notifications.push(notif);
        },
      });
      supervisorRef = supervisor;

      // 1. Default profile is eager; other profiles ('work', 'ops') start desired='disabled'/idle until first activated
      await supervisor.connectLocal("default");
      const linkDefault1 = supervisor.getConnectionLink("local", "default");
      const linkWork1 = supervisor.getConnectionLink("local", "work");
      expect(linkDefault1?.desired).toBe("enabled");
      expect(linkDefault1?.actual).toBe("ready");
      expect(linkWork1?.actual).toBe("idle");
      expect(gw.connections).toHaveLength(1);

      // 2. Activating 'work' profile shares the single interactive WS, marks 'work' enabled + ready, and keeps it connected
      await supervisor.handlers["scopes.switch"](
        { connectionId: "local", profileId: "work" },
        null,
      );
      expect(gw.connections).toHaveLength(1); // Shared interactive socket!
      const linkWork2 = supervisor.getConnectionLink("local", "work");
      expect(linkWork2?.desired).toBe("enabled");
      expect(linkWork2?.actual).toBe("ready");

      // Start a turn on 'work' -> 'work' becomes pinned!
      await supervisor.handlers["prompts.send"](
        { sessionId: "s-work", text: "background build task" },
        { connectionId: "local", profileId: "work", sessionId: "s-work" },
      );
      expect(supervisor.getConnectionLink("local", "work")?.pinned).toBe(true);

      // Switch back to 'default' -> 'work' stays enabled, ready, and pinned (never recycled)
      await supervisor.handlers["scopes.switch"](
        { connectionId: "local", profileId: "default" },
        null,
      );
      expect(supervisor.getConnectionLink("local", "work")?.desired).toBe("enabled");
      expect(supervisor.getConnectionLink("local", "work")?.actual).toBe("ready");
      expect(supervisor.getConnectionLink("local", "work")?.pinned).toBe(true);

      // 3. Background notification: when app is in background, prompt.completed or approval.requested emits minimal notification without command/path/message/token
      appIsForeground = false;
      // Trigger turn completion on background 'work' profile via active socket
      const rpcCountBeforeNotif = gw.rpcCalls.length;
      void rpcCountBeforeNotif;
      supervisor.notifyBackgroundEventForTest?.({
        kind: "approval_pending",
        scope: { connectionId: "local", profileId: "work", sessionId: "s-work" },
        rawPayload: { command: "sudo rm -rf /Users/alice/token_123", path: "/Users/alice/secret" },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].body).toBe("有 Approval 待处理");
      expect(JSON.stringify(notifications[0])).not.toMatch(/sudo|alice|token_123|secret/);

      // When app is foreground, no background notification is emitted
      appIsForeground = true;
      supervisor.notifyBackgroundEventForTest?.({
        kind: "turn_completed",
        scope: { connectionId: "local", profileId: "work", sessionId: "s-work" },
        rawPayload: { text: "secret output" },
      });
      expect(notifications).toHaveLength(1);

      // 4. Single profile failure isolation: 'ops' fails with profile_not_served -> 'ops' is blocked, Gateway aggregates to ready + degraded (profileExceptionCount: 1), while 'default' & 'work' stay ready on shared socket!
      blockOpsProfile = true;
      await supervisor.handlers["scopes.switch"](
        { connectionId: "local", profileId: "ops" },
        null,
      );
      expect(supervisor.getConnectionLink("local", "ops")?.actual).toBe("blocked");
      expect(supervisor.getConnectionLink("local", "default")?.actual).toBe("ready");
      expect(supervisor.getConnectionLink("local", "work")?.actual).toBe("ready");
      const localHealthDegraded = supervisor.getLocalHealth();
      expect(localHealthDegraded.actual).toBe("ready");
      expect(localHealthDegraded.degraded).toBe(true);
      expect(localHealthDegraded.aggregateState).toBe("degraded");
      expect(localHealthDegraded.profileExceptionCount).toBe(1);
      blockOpsProfile = false;

      // 5. Profile disappearance only stops that profile without tearing down the shared socket
      activeProfilesList = activeProfilesList.filter((p) => p.profile_id !== "ops");
      await supervisor.refreshProfilesForConnection("local");
      expect(supervisor.getConnectionLink("local", "ops")?.desired).toBe("disabled");
      expect(supervisor.getConnectionLink("local", "default")?.actual).toBe("ready");
      expect(supervisor.getConnectionLink("local", "work")?.actual).toBe("ready");
      expect(supervisor.getLocalHealth().degraded).toBe(false);

      // 6. Backoff 1s->30s full jitter + 5s stable ready reset + manual Retry
      // Force next 2 dial attempts to fail so we observe exponential backoff
      failUdsResolveCount = 2;
      rngValue = 1.0; // full cap: attempt 0 -> 1000ms, attempt 1 -> 2000ms, attempt 2 -> 4000ms
      gw.closeAllClients();
      await expect.poll(() => supervisor.getLocalHealth().actual).toBe("reconnecting");

      const healthReconn1 = supervisor.getLocalHealth();
      expect(healthReconn1.actual).toBe("reconnecting");
      expect(healthReconn1.nextRetryAt).toBe(currentTime + 1000);

      // Advance 1000ms -> attempt 1 runs and fails -> schedules attempt 2 with 2000ms
      await advanceFakeClock(1000);
      const healthReconn2 = supervisor.getLocalHealth();
      expect(healthReconn2.actual).toBe("reconnecting");
      expect(healthReconn2.nextRetryAt).toBe(currentTime + 2000);

      // Manual Retry immediately dials without waiting for timer, and does NOT reset attempt counter prematurely!
      // Let's make this manual Retry succeed, then drop within 3s (< 5s stable window)
      failUdsResolveCount = 0;
      await supervisor.handlers["connections.retry"]({ connectionId: "local" }, null);
      expect(supervisor.getLocalHealth().actual).toBe("ready");

      // Both 'default' and 'work' were desired='enabled', so shared socket reconnect independently resumed/refreshed sessions for BOTH profiles!
      const sessionListProfilesAfterReconnect = gw.rpcCalls
        .filter((c) => c.method === "session.list" || c.method === "sessions.list")
        .map((c) => c.params.profile_id);
      expect(sessionListProfilesAfterReconnect).toContain("default");
      expect(sessionListProfilesAfterReconnect).toContain("work");

      // Advance only 3000ms (< 5000ms stable threshold) and drop socket again -> attempt counter was NOT reset (was 2, now 2 -> 4000ms backoff!)
      await advanceFakeClock(3000);
      failUdsResolveCount = 1;
      gw.closeAllClients();
      await expect.poll(() => supervisor.getLocalHealth().actual).toBe("reconnecting");
      expect(supervisor.getLocalHealth().actual).toBe("reconnecting");
      expect(supervisor.getLocalHealth().nextRetryAt).toBe(currentTime + 4000);

      // Now let reconnect succeed and stay ready for >= 5000ms -> attempt counter resets to 0!
      failUdsResolveCount = 0;
      await advanceFakeClock(4000);
      expect(supervisor.getLocalHealth().actual).toBe("ready");
      await advanceFakeClock(5000);

      // Drop again after 5s stable -> backoff is back to 1000ms (attempt 0)!
      failUdsResolveCount = 1;
      gw.closeAllClients();
      await expect.poll(() => supervisor.getLocalHealth().actual).toBe("reconnecting");
      expect(supervisor.getLocalHealth().nextRetryAt).toBe(currentTime + 1000);
      failUdsResolveCount = 0;
      await advanceFakeClock(1000);
      expect(supervisor.getLocalHealth().actual).toBe("ready");

      // 7. Heartbeat 15s/45s: 45s without inbound frames marks transport unavailable and triggers reconnect
      await advanceFakeClock(45_000);
      // After 45s silence, heartbeat watchdog closes socket and triggers reconnect
      expect(gw.connections.length).toBeGreaterThanOrEqual(4);

      // 8. Suspend & Resume: suspend closes socket, suppresses timers, sets desired=suspended & actual=idle; resume staggers 0-250ms and resets backoff
      rngValue = 0.5; // 125ms stagger
      supervisor.suspend();
      expect(supervisor.getLocalHealth().desired).toBe("suspended");
      expect(supervisor.getLocalHealth().actual).toBe("idle");
      expect(supervisor.getLocalHealth().aggregateState).toBe("suspended");

      const connCountOnSuspend = gw.connections.length;
      supervisor.resume();
      // At t+0ms before stagger (125ms), not yet connected
      expect(gw.connections.length).toBe(connCountOnSuspend);
      await advanceFakeClock(125);
      expect(supervisor.getLocalHealth().actual).toBe("ready");
      expect(supervisor.getLocalHealth().desired).toBe("enabled");

      // 9. ticket_unavailable re-attaches / re-opens serve first before entering backoff
      ticketUnavailableOnce = true;
      gw.closeAllClients();
      await expect
        .poll(
          () => ({
            attachRecovered: udsAttachRecoverCount,
            actual: supervisor.getLocalHealth().actual,
          }),
          { timeout: 5_000 },
        )
        .toEqual({ attachRecovered: 1, actual: "ready" });
      expect(udsAttachRecoverCount).toBe(1);
      expect(supervisor.getLocalHealth().actual).toBe("ready");

      // 10. Bounded shutdown <= 2s: stops new commands, cancels timers, closes WS/SSH, marks disposed
      const shutdownStart = Date.now();
      await supervisor.shutdown({ timeoutMs: 2000 });
      expect(Date.now() - shutdownStart).toBeLessThan(2000);
      expect(supervisor.isDisposed()).toBe(true);

      await expect(
        supervisor.handlers["sessions.create"]({ title: "After quit" }, { connectionId: "local", profileId: "default" }),
      ).rejects.toThrow();

      store.close();
      udsServer.close();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  }, 15_000);

  it("enforces startFleet() concurrency cap=4 with local + Primary priority", async () => {
    const sandbox = createTestSandbox("hermes-s1-fleet-priority-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_pri_1", "tkt_pri_2"]);
    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [{ profile_id: "default", display_name: "Default", handle: "default", is_default: true }],
      initialSessions: [{ profile_id: "default", session_id: "s-1", title: "Session 1" }],
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };
      const localBackend = new LocalBackendManager(ports);
      const store = new RegistryStore({ rootDir: sandbox.hermesHomeDir });

      // Add 5 SSH connections and mark the 4th one as Primary
      const remoteIds: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        const added = store.add({
          kind: "ssh",
          label: `Remote ${i}`,
          host: `node${i}.example.com`,
          user: "ubuntu",
        });
        expect(added.ok).toBe(true);
        if (added.ok) {
          const id = added.snapshot.connections.find((c) => c.label === `Remote ${i}`)!.id;
          remoteIds.push(id);
        }
      }
      const primaryRemoteId = remoteIds[3]!;
      store.setPrimary(primaryRemoteId);

      let activeDials = 0;
      let maxConcurrentObserved = 0;
      const dialOrder: string[] = [];

      const supervisor = new LocalConnectionSupervisor(localBackend, {
        registryStore: store,
        maxConcurrentDials: 4,
      });

      const origEnsure = (supervisor as unknown as {
        ensureTransport: (
          cid: string,
          pid: string,
          opts?: Record<string, unknown>,
        ) => Promise<unknown>;
      }).ensureTransport.bind(supervisor);

      (supervisor as unknown as {
        ensureTransport: (
          cid: string,
          pid: string,
          opts?: Record<string, unknown>,
        ) => Promise<unknown>;
      }).ensureTransport = async (cid, pid, opts) => {
        dialOrder.push(cid);
        activeDials += 1;
        maxConcurrentObserved = Math.max(maxConcurrentObserved, activeDials);
        // Let every worker admitted by the cap start before any dial completes.
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        try {
          if (cid === "local") {
            return await origEnsure(cid, pid, opts);
          }
          return { ok: true, fleet: supervisor.getFleetSnapshot() };
        } finally {
          activeDials -= 1;
        }
      };

      await supervisor.startFleet();
      expect(dialOrder[0]).toBe("local");
      expect(dialOrder[1]).toBe(primaryRemoteId);
      expect(maxConcurrentObserved).toBeLessThanOrEqual(4);
      expect(dialOrder).toHaveLength(6);

      await supervisor.shutdown({ timeoutMs: 2000 });
      store.close();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("handles Subagents (list/steer/interrupt/tail, -32601 read-only last-known, failed stop never pretending stopped, bounded tail & generation invalidation) and Checkpoint (list/diff/restore, missing rollback.restore read-only, explicit confirm & scope/generation binding) (Ticket #41)", async () => {
    const sandbox = createTestSandbox("hermes-s1-subagents-checkpoints-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_sub_ckpt_1", "tkt_sub_ckpt_2"]);

    let subagentListNotFound = false;
    let subagentSteerNotFound = false;
    let subagentInterruptShouldFail = false;
    let subagentStatus: "running" | "stopped" = "running";
    let checkpointRestoreEnabled = false;
    let checkpointRestoreShouldFail = false;

    const baseServedMethods = [
      "runtime.describe",
      "client.capabilities",
      "subscribe",
      "profiles.list",
      "session.list",
      "session.create",
      "session.resume",
      "session.transcript",
      "prompt.submit",
      "prompt.cancel",
      "session.steer",
      "subagent.list",
      "subagent.steer",
      "subagent.interrupt",
      "subagent.tail",
      "rollback.list",
      "rollback.diff",
    ];

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [...baseServedMethods, "rollback.restore"],
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "sess-1", title: "Main Session" },
        { profile_id: "ops", session_id: "sess-ops", title: "Ops Session" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "runtime.describe") {
          ctx.replyResult({
            runtime_protocol: 1,
            capabilities: ["session-authority-v1", "host-scope-interactive"],
            served_methods: checkpointRestoreEnabled
              ? [...baseServedMethods, "rollback.restore"]
              : baseServedMethods,
            session_create: { sources: ["desktop"], parameters: ["title", "profile_id"] },
          });
          return true;
        }
        if (method === "subagent.list") {
          if (subagentListNotFound) {
            ctx.replyError(-32601, "Method not found: subagent.list");
            return true;
          }
          ctx.replyResult({
            agents: [
              {
                agent_id: "sub-alpha",
                name: "Alpha Researcher",
                role: "Codebase Explorer",
                status: subagentStatus,
                summary: "Scanning packages/domain",
                updated_at: "2026-11-23T09:00:00Z",
              },
            ],
          });
          return true;
        }
        if (method === "subagent.tail") {
          const manyLines = Array.from({ length: 240 }, (_, idx) => `tail-line-${idx + 1}`);
          ctx.replyResult({
            agent_id: params.agent_id,
            lines: manyLines,
          });
          return true;
        }
        if (method === "subagent.steer") {
          if (subagentSteerNotFound) {
            ctx.replyError(-32601, "Method not found: subagent.steer");
            return true;
          }
          ctx.replyResult({
            steered: true,
            agent_id: params.agent_id,
            text: params.text,
          });
          return true;
        }
        if (method === "subagent.interrupt") {
          if (subagentInterruptShouldFail) {
            ctx.replyError(-32000, "Subagent is in an uninterruptible atomic write");
            return true;
          }
          subagentStatus = "stopped";
          ctx.replyResult({
            interrupted: true,
            agent_id: params.agent_id,
            status: "stopped",
          });
          return true;
        }
        if (method === "rollback.list") {
          ctx.replyResult({
            checkpoints: [
              {
                checkpoint_id: "ckpt-101",
                title: "Pre-refactor baseline",
                summary: "Clean worktree",
                created_at: "2026-11-23T08:30:00Z",
                turn_id: "turn-1",
              },
            ],
          });
          return true;
        }
        if (method === "rollback.diff") {
          ctx.replyResult({
            checkpoint_id: params.checkpoint_id,
            summary: "1 file changed (+8 -2)",
            patch: "@@ -1,2 +1,8 @@\n+export const check = true;",
            files_changed: 1,
          });
          return true;
        }
        if (method === "rollback.restore") {
          if (checkpointRestoreShouldFail) {
            ctx.replyError(-32000, "Worktree has locked index");
            return true;
          }
          ctx.replyResult({
            restored: true,
            checkpoint_id: params.checkpoint_id,
            session_id: params.session_id,
          });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend);
      await supervisor.connectLocal("default");

      const scope = { connectionId: "local", profileId: "default", sessionId: "sess-1" };

      // 1. Subagents list returns live roster
      const listRes = (await supervisor.handlers["subagents.list"]({}, scope)) as {
        agents: Array<{ agentId: string; status: string; lastKnown?: boolean }>;
        readOnly: boolean;
        lastKnown: boolean;
        generation: number;
      };
      expect(listRes.readOnly).toBe(false);
      expect(listRes.lastKnown).toBe(false);
      expect(listRes.agents).toHaveLength(1);
      expect(listRes.agents[0]).toMatchObject({
        agentId: "sub-alpha",
        status: "running",
      });

      // 2. Subagents tail is bounded to MAX_SUBAGENT_TAIL_LINES (200) and carries current capability generation
      const tailRes = (await supervisor.handlers["subagents.tail"](
        { agentId: "sub-alpha" },
        scope,
      )) as {
        tail: { agentId: string; lines: string[]; truncated: boolean; generation: number };
      };
      expect(tailRes.tail.agentId).toBe("sub-alpha");
      expect(tailRes.tail.truncated).toBe(true);
      expect(tailRes.tail.lines).toHaveLength(200);
      expect(tailRes.tail.lines[0]).toBe("tail-line-41");
      expect(tailRes.tail.lines[199]).toBe("tail-line-240");
      const genBeforeReconnect = tailRes.tail.generation;

      // 3. Subagents steer succeeds
      const steerRes = (await supervisor.handlers["subagents.steer"](
        { agentId: "sub-alpha", text: "Prioritize edge cases" },
        scope,
      )) as { steered: boolean; agentId: string };
      expect(steerRes).toEqual({ steered: true, agentId: "sub-alpha" });

      // 4. Failed subagents.interrupt NEVER pretends stop succeeded!
      subagentInterruptShouldFail = true;
      await expect(
        supervisor.handlers["subagents.interrupt"]({ agentId: "sub-alpha" }, scope),
      ).rejects.toMatchObject({ code: "internal" });
      const listAfterFailedStop = (await supervisor.handlers["subagents.list"]({}, scope)) as {
        agents: Array<{ agentId: string; status: string }>;
      };
      expect(listAfterFailedStop.agents[0].status).toBe("running");

      // Successful interrupt updates status to "stopped"
      subagentInterruptShouldFail = false;
      const interruptRes = (await supervisor.handlers["subagents.interrupt"](
        { agentId: "sub-alpha" },
        scope,
      )) as { interrupted: boolean; agentId: string; status: string };
      expect(interruptRes).toEqual({
        interrupted: true,
        agentId: "sub-alpha",
        status: "stopped",
      });

      // 5. -32601 on subagent.steer degrades subagents.steer capability; -32601 on subagent.list returns last-known roster in read-only mode
      subagentSteerNotFound = true;
      await expect(
        supervisor.handlers["subagents.steer"]({ agentId: "sub-alpha", text: "retry" }, scope),
      ).rejects.toMatchObject({ code: "capability_unavailable" });
      const capAfterSteer404 = (await supervisor.handlers["capabilities.describe"](
        {},
        null,
      )) as CapabilitySnapshot;
      expect(
        capAfterSteer404.entries.find((e) => e.actionId === "subagents.steer")?.runtimeStatus,
      ).toBe("unavailable");

      subagentListNotFound = true;
      const listFallback = (await supervisor.handlers["subagents.list"]({}, scope)) as {
        agents: Array<{ agentId: string; status: string; lastKnown?: boolean }>;
        readOnly: boolean;
        lastKnown: boolean;
      };
      expect(listFallback.readOnly).toBe(true);
      expect(listFallback.lastKnown).toBe(true);
      expect(listFallback.agents).toHaveLength(1);
      expect(listFallback.agents[0]).toMatchObject({
        agentId: "sub-alpha",
        status: "stopped",
        lastKnown: true,
      });

      // 6. Checkpoints: list & diff work, while missing rollback.restore reports canRestore: false and rejects restore with capability_unavailable
      const ckptList = (await supervisor.handlers["checkpoints.list"]({}, scope)) as {
        checkpoints: Array<{ checkpointId: string; title: string }>;
        canRestore: boolean;
      };
      expect(ckptList.canRestore).toBe(false);
      expect(ckptList.checkpoints).toHaveLength(1);
      expect(ckptList.checkpoints[0].checkpointId).toBe("ckpt-101");

      const ckptDiff = (await supervisor.handlers["checkpoints.diff"](
        { checkpointId: "ckpt-101" },
        scope,
      )) as { diff: { checkpointId: string; filesChanged: number; patch: string } };
      expect(ckptDiff.diff.checkpointId).toBe("ckpt-101");
      expect(ckptDiff.diff.filesChanged).toBe(1);

      const currentCap = (await supervisor.handlers["capabilities.describe"](
        {},
        null,
      )) as CapabilitySnapshot;
      await expect(
        supervisor.handlers["checkpoints.restore"](
          {
            checkpointId: "ckpt-101",
            confirmed: true,
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            generation: currentCap.generation,
          },
          scope,
        ),
      ).rejects.toMatchObject({ code: "capability_unavailable" });

      // 7. Reconnect with rollback.restore enabled -> generation bumps (invalidating old tail generation) and restore enforces confirmation + scope + generation
      checkpointRestoreEnabled = true;
      await supervisor.handlers["connections.retry"]({ connectionId: "local" }, null);
      const capAfterReconnect = (await supervisor.handlers["capabilities.describe"](
        {},
        null,
      )) as CapabilitySnapshot;
      expect(capAfterReconnect.generation).toBeGreaterThan(genBeforeReconnect);
      expect(
        capAfterReconnect.entries.find((e) => e.actionId === "checkpoint.restore")?.runtimeStatus,
      ).toBe("available");

      // Missing confirmed: true -> invalid_request
      await expect(
        supervisor.handlers["checkpoints.restore"](
          {
            checkpointId: "ckpt-101",
            confirmed: false,
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            generation: capAfterReconnect.generation,
          },
          scope,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });

      // Cross-scope binding (profileId: "ops" vs active "default") -> scope_mismatch
      await expect(
        supervisor.handlers["checkpoints.restore"](
          {
            checkpointId: "ckpt-101",
            confirmed: true,
            connectionId: "local",
            profileId: "ops",
            sessionId: "sess-1",
            generation: capAfterReconnect.generation,
          },
          scope,
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" });

      // Stale generation -> conflict
      await expect(
        supervisor.handlers["checkpoints.restore"](
          {
            checkpointId: "ckpt-101",
            confirmed: true,
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            generation: genBeforeReconnect,
          },
          scope,
        ),
      ).rejects.toMatchObject({ code: "conflict" });

      // Gateway RPC failure on restore -> safe error code without crashing
      checkpointRestoreShouldFail = true;
      await expect(
        supervisor.handlers["checkpoints.restore"](
          {
            checkpointId: "ckpt-101",
            confirmed: true,
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            generation: capAfterReconnect.generation,
          },
          scope,
        ),
      ).rejects.toMatchObject({ code: "internal" });

      // Valid confirmed restore with matching scope & generation -> succeeds
      checkpointRestoreShouldFail = false;
      const restoreRes = (await supervisor.handlers["checkpoints.restore"](
        {
          checkpointId: "ckpt-101",
          confirmed: true,
          connectionId: "local",
          profileId: "default",
          sessionId: "sess-1",
          generation: capAfterReconnect.generation,
        },
        scope,
      )) as { restored: boolean; checkpointId: string; sessionId: string };
      expect(restoreRes).toEqual({
        restored: true,
        checkpointId: "ckpt-101",
        sessionId: "sess-1",
      });

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });


  it("lazily fetches read-only Plugins/Skills/Tools/MCP inventories on demand, supports native Skills/MCP reload, enforces field whitelist, attaches ExternalAttribution to tool rows, and invalidates on resync/scope change (EXT-INV-01..05, EXT-ATTR-01..03, EXT-GUARD-01..02)", async () => {
    const sandbox = createTestSandbox("hermes-supervisor-ext-");
    let passed = false;
    const validTickets = new Set<string>();
    let pluginsMode: "available" | "empty" | "not_found" | "error" = "available";
    let skillsReloadCount = 0;
    let mcpReloadCount = 0;
    let latestSendNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;

    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [
        { profile_id: "default", display_name: "Default", is_default: true },
        { profile_id: "work", display_name: "Work", is_default: false },
      ],
      initialSessions: [
        {
          session_id: "sess_ext_1",
          profile_id: "default",
          title: "Extension session",
          updated_at: "2026-11-23T09:00:00.000Z",
        },
      ],
      onRpc: (method, _params, ctx) => {
        latestSendNotification = ctx.sendNotification;
        if (method === "runtime.describe") {
          ctx.replyResult({
            version: "2026.11.1",
            code_sha: "sha_ext_1",
            authority_epoch: 1,
            capabilities: ["session-authority-v1", "chat-v1", "plugin-rpc-v1"],
            served_methods: [
              "prompt.submit",
              "session.list",
              "session.resume",
              "profiles.list",
              "plugins.list",
              "skills.list",
              "reload.skills",
              "tools.show",
              "mcp.list",
              "reload.mcp",
            ],
            older_methods: ["skills.install", "tools.configure"],
          });
          return true;
        }
        if (method === "plugins.list") {
          if (pluginsMode === "empty") {
            ctx.replyResult({ plugins: [] });
            return true;
          }
          if (pluginsMode === "not_found") {
            ctx.replyError(-32601, "Method not found");
            return true;
          }
          if (pluginsMode === "error") {
            ctx.replyError(-32000, "Internal plugin failure");
            return true;
          }
          ctx.replyResult({
            plugins: [
              {
                name: "repo-guardian",
                key: "repo-guardian",
                version: "1.0.4",
                enabled: true,
                tools: ["rg_scan", "rg_report"],
                hooks: ["pre_commit"],
                commands: ["/guardian"],
                install_dir: "/Users/alice/.hermes/plugins/repo-guardian",
                settings_schema: { token: { type: "string" } },
                servers: ["internal-mcp"],
              },
              {
                name: "broken-plugin",
                key: "broken-plugin",
                enabled: false,
                error: "EACCES: /Users/alice/.hermes/plugins/broken token=sk-secret999999",
                install_dir: "/Users/alice/.hermes/plugins/broken",
              },
            ],
          });
          return true;
        }
        if (method === "reload.skills") {
          skillsReloadCount += 1;
          ctx.replyResult({ ok: true });
          return true;
        }
        if (method === "skills.list") {
          ctx.replyResult({
            skills: [
              { id: "sk_1", name: "bundled-summarizer", source: "bundled", enabled: true },
              { id: "sk_2", name: "hub-reviewer", source: "hub", enabled: true },
              { id: "sk_3", name: "mystery-skill", enabled: true },
            ],
          });
          return true;
        }
        if (method === "tools.show") {
          ctx.replyResult({
            tools: [
              { name: "shell_exec", source: "bundled", toolset: "core" },
              { name: "fs_read", mcp_server: "filesystem" },
            ],
          });
          return true;
        }
        if (method === "reload.mcp") {
          mcpReloadCount += 1;
          ctx.replyResult({ ok: true });
          return true;
        }
        if (method === "mcp.list") {
          ctx.replyResult({
            servers: [
              { name: "filesystem", status: "connected", tools: ["fs_read", "fs_write"] },
            ],
          });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend);
      await supervisor.connectLocal("default", { activate: true });

      // Wait for core probes only — extension methods must NOT be polled or called on connect!
      await supervisor.handlers["capabilities.describe"]({}, { connectionId: "local", profileId: "default" });
      const initialMethods = gw.rpcCalls.map((c) => c.method);
      expect(initialMethods).not.toContain("plugins.list");
      expect(initialMethods).not.toContain("skills.list");
      expect(initialMethods).not.toContain("tools.show");
      expect(initialMethods).not.toContain("mcp.list");
      expect(initialMethods.some((m) => m.startsWith("plugin."))).toBe(false);

      // 1. Open Plugins drawer -> calls capabilities.describe({ domain: "plugins" })
      const snapPlugins = (await supervisor.handlers["capabilities.describe"](
        { domain: "plugins" },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;

      expect(snapPlugins.extensions.status).toBe("available");
      expect(snapPlugins.extensions.pluginRpcAdvertised).toBe(true);
      expect(snapPlugins.extensions.plugins.map((p) => p.name)).toEqual([
        "broken-plugin",
        "repo-guardian",
      ]);
      expect(snapPlugins.extensions.plugins[0]?.loadStatus).toBe("failed");
      expect(snapPlugins.extensions.plugins[0]?.errorCode).toBe("PLUGIN_LOAD_FAILED");
      expect(JSON.stringify(snapPlugins.extensions.plugins)).not.toContain("/Users/alice");
      expect(JSON.stringify(snapPlugins.extensions.plugins)).not.toContain("sk-secret999999");
      expect(JSON.stringify(snapPlugins.extensions.plugins)).not.toContain("rg_scan");

      // Empty state on manual refresh
      pluginsMode = "empty";
      const snapEmpty = (await supervisor.handlers["capabilities.describe"](
        { domain: "plugins", refresh: true },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;
      expect(snapEmpty.extensions.status).toBe("empty");

      // Error state on manual refresh
      pluginsMode = "error";
      const snapError = (await supervisor.handlers["capabilities.describe"](
        { domain: "plugins", refresh: true },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;
      expect(snapError.extensions.status).toBe("error");

      // -32601 unsupported state on manual refresh
      pluginsMode = "not_found";
      const snapUnsupported = (await supervisor.handlers["capabilities.describe"](
        { domain: "plugins", refresh: true },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;
      expect(snapUnsupported.extensions.status).toBe("unsupported");

      // 2. Skills inventory + native reload.skills
      const snapSkills = (await supervisor.handlers["capabilities.describe"](
        { domain: "skills", action: "reload", refresh: true },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;
      expect(skillsReloadCount).toBe(1);
      expect(snapSkills.extensions.skills.status).toBe("available");
      expect(snapSkills.extensions.skills.reloadSupported).toBe(true);
      expect(snapSkills.extensions.skills.items.map((s) => s.attribution.origin)).toEqual([
        "builtin",
        "external",
        "unknown",
      ]);

      // 3. Tools inventory (read-only tools.show, never calls tools.configure)
      const snapTools = (await supervisor.handlers["capabilities.describe"](
        { domain: "tools" },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;
      expect(snapTools.extensions.tools.status).toBe("available");
      expect(snapTools.extensions.tools.items).toHaveLength(2);
      expect(gw.rpcCalls.map((c) => c.method)).not.toContain("tools.configure");

      // 4. MCP inventory + native reload.mcp
      const snapMcp = (await supervisor.handlers["capabilities.describe"](
        { domain: "mcp", action: "reload", refresh: true },
        { connectionId: "local", profileId: "default" },
      )) as import("@hermes/contracts").CapabilitySnapshot;
      expect(mcpReloadCount).toBe(1);
      expect(snapMcp.extensions.mcp.status).toBe("available");
      expect(snapMcp.extensions.mcp.items[0]?.attribution.sourceLabel).toBe(
        "外部提供 · MCP · filesystem",
      );

      // 5. Activity notification resolves ExternalAttribution on ToolExecutionRow
      await supervisor.handlers["sessions.select"](
        { sessionId: "sess_ext_1" },
        { connectionId: "local", profileId: "default" },
      );
      let capturedActivityRow: import("@hermes/contracts").ToolExecutionRow | null = null;
      const unsubActivity = supervisor.subscribe(
        "activity",
        { connectionId: "local", profileId: "default", sessionId: "sess_ext_1" },
        (ev) => {
          const payload = ev.payload as import("@hermes/contracts").ActivityEventPayload;
          if (payload?.toolRow) {
            capturedActivityRow = payload.toolRow;
          }
        },
      );
      const notifyGateway = latestSendNotification as
        | ((method: string, params: Record<string, unknown>) => void)
        | null;
      notifyGateway?.("activity", {
        session_id: "sess_ext_1",
        profile_id: "default",
        tool_row: {
          tool_call_id: "tc_mcp_1",
          name: "fs_read",
          status: "completed",
          mcp_server: "filesystem",
        },
      });
      await expect
        .poll(() => capturedActivityRow?.attribution?.sourceLabel)
        .toBe("外部提供 · MCP · filesystem");
      unsubActivity();
      const observedActivityRow =
        capturedActivityRow as import("@hermes/contracts").ToolExecutionRow | null;
      expect(observedActivityRow?.attribution?.sourceLabel).toBe("外部提供 · MCP · filesystem");

      // 6. Resync notification invalidates cached extension inventories
      notifyGateway?.("resync_required", { authority_epoch: 2 });
      await expect
        .poll(() => {
          const extensions = supervisor.getCapabilitySnapshot().extensions;
          return (
            extensions.skills.items.length +
            extensions.tools.items.length +
            extensions.mcp.items.length
          );
        })
        .toBe(0);
      const afterResync = supervisor.getCapabilitySnapshot();
      expect(afterResync.extensions.skills.items).toEqual([]);
      expect(afterResync.extensions.tools.items).toEqual([]);
      expect(afterResync.extensions.mcp.items).toEqual([]);

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });


  it("maintains bounded background session journals, unread rules, lazy active transcript fetch, resync_required replacement, and quit/restart rebuild from 0 (#37 S1/S3)", async () => {
    const sandbox = createTestSandbox("hermes-s1-journal-37-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_j_1", "tkt_j_2", "tkt_j_3"]);
    let ticketIdx = 1;
    let appFocused = true;

    const gw = await startFakeGatewayServer({
      validTickets,
      initialSessions: [
        { profile_id: "default", session_id: "s-fg", title: "Foreground" },
        { profile_id: "default", session_id: "s-bg-progress", title: "Background Progress" },
        { profile_id: "default", session_id: "s-bg-overflow", title: "Background Overflow" },
      ],
    });

    gw.setTranscriptMessages("s-bg-overflow", [
      {
        message_id: "gw-clean-1",
        role: "assistant",
        text: "clean full gateway transcript after overflow",
        created_at: "2026-11-23T10:00:00Z",
      },
    ]);

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
          else validTickets.add(`tkt_dyn_${++ticketIdx}`);
        }
        return res;
      };

      const chatStore = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const backend = new LocalBackendManager(ports);
      const supervisor1 = new LocalConnectionSupervisor(backend, {
        chatSessionStateStore: chatStore,
        isAppForeground: () => appFocused,
      });

      await supervisor1.connectLocal("default");

      // Only s-fg transcript may have been requested — zero background transcript RPCs
      const initialTxCalls = gw.rpcCalls.filter(
        (c) => c.method === "session.resume" || c.method === "session.transcript",
      );
      expect(initialTxCalls.every((c) => c.params.session_id === "s-fg")).toBe(true);

      const fgTranscriptEvents: Array<{ kind: string; payload: unknown }> = [];
      const unsubFg = supervisor1.subscribe(
        "session.transcript",
        { connectionId: "local", profileId: "default", sessionId: "s-fg" },
        (ev) => fgTranscriptEvents.push({ kind: ev.kind, payload: ev.payload }),
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      fgTranscriptEvents.length = 0;

      // Background session receives token deltas (0 unread), tool running (0 unread), tool completed (+1), turn completed (+1), approval (+needsInput)
      for (let i = 1; i <= 5; i += 1) {
        gw.sendNotification("prompt.delta", {
          session_id: "s-bg-progress",
          turn_id: "t-bg-1",
          message_id: "m-bg-1",
          delta: `tok-${i} `,
          seq: i,
        });
      }
      gw.sendNotification("tool.execution", {
        session_id: "s-bg-progress",
        turn_id: "t-bg-1",
        tool_call_id: "tc-bg-1",
        name: "shell",
        status: "running",
        seq: 6,
      });
      await expect
        .poll(
          () =>
            readJournal(supervisor1, "local", "default", "s-bg-progress")?.lastGatewaySeq,
        )
        .toBe(6);

      // Still zero unread from token deltas or running tool, and zero patches leaked to s-fg subscriber
      expect(fgTranscriptEvents).toHaveLength(0);
      let bgSummary = supervisor1
        .getFleetSnapshot()
        .sessions.find((s) => s.sessionId === "s-bg-progress");
      expect(bgSummary?.unreadCount).toBe(0);

      gw.sendNotification("tool.execution", {
        session_id: "s-bg-progress",
        turn_id: "t-bg-1",
        tool_call_id: "tc-bg-1",
        name: "shell",
        status: "completed",
        summary: "10 passed",
        seq: 7,
      });
      gw.sendNotification("prompt.completed", {
        session_id: "s-bg-progress",
        turn_id: "t-bg-1",
        message_id: "m-bg-1",
        seq: 8,
      });
      gw.sendNotification("approval.requested", {
        session_id: "s-bg-progress",
        turn_id: "t-bg-1",
        approval_id: "appr-1",
      });
      await expect
        .poll(() => {
          const summary = supervisor1
            .getFleetSnapshot()
            .sessions.find((s) => s.sessionId === "s-bg-progress");
          return {
            unread: summary?.unreadCount,
            needsInput: summary?.needsInput,
            pinned: summary?.pinned,
          };
        })
        .toEqual({ unread: 2, needsInput: true, pinned: true });

      bgSummary = supervisor1
        .getFleetSnapshot()
        .sessions.find((s) => s.sessionId === "s-bg-progress");
      expect(bgSummary?.unreadCount).toBe(2);
      expect(bgSummary?.needsInput).toBe(true);
      expect(bgSummary?.pinned).toBe(true);

      // Still NEVER fetched full transcript for background sessions
      const bgTxCallsBeforeSwitch = gw.rpcCalls.filter(
        (c) =>
          (c.method === "session.resume" || c.method === "session.transcript") &&
          c.params.session_id !== "s-fg",
      );
      expect(bgTxCallsBeforeSwitch).toHaveLength(0);

      // Explicit markRead clears unread on background session without switching away from s-fg
      await supervisor1.handlers["sessions.markRead"](
        { connectionId: "local", profileId: "default", sessionId: "s-bg-progress" },
        null,
      );
      bgSummary = supervisor1
        .getFleetSnapshot()
        .sessions.find((s) => s.sessionId === "s-bg-progress");
      expect(bgSummary?.unreadCount).toBe(0);
      expect(bgSummary?.needsInput).toBe(true);
      expect(bgSummary?.pinned).toBe(true); // still pinned by pending approval
      expect(supervisor1.getFleetSnapshot().activeSessionId).toBe("s-fg");

      // Focus gating on active session: unfocused window accumulates unread, focused advances lastReadSeq
      appFocused = false;
      gw.sendNotification("prompt.completed", {
        session_id: "s-fg",
        turn_id: "t-fg-unfocused",
        message_id: "m-fg-1",
        seq: 1,
      });
      await expect
        .poll(
          () =>
            supervisor1
              .getFleetSnapshot()
              .sessions.find((s) => s.sessionId === "s-fg")?.unreadCount,
        )
        .toBe(1);
      expect(
        supervisor1.getFleetSnapshot().sessions.find((s) => s.sessionId === "s-fg")?.unreadCount,
      ).toBe(1);

      await supervisor1.handlers["sessions.markRead"](
        { connectionId: "local", profileId: "default", sessionId: "s-fg" },
        null,
      );
      expect(
        supervisor1.getFleetSnapshot().sessions.find((s) => s.sessionId === "s-fg")?.unreadCount,
      ).toBe(0);

      appFocused = true;
      unsubFg();

      // Overflow s-bg-overflow (> 2,000 events) while still in background
      for (let i = 1; i <= 2_005; i += 1) {
        gw.sendNotification("prompt.delta", {
          session_id: "s-bg-overflow",
          turn_id: "t-ovf",
          message_id: "m-ovf",
          delta: "d",
          seq: i,
        });
      }
      await expect
        .poll(() => {
          const journal = readJournal(supervisor1, "local", "default", "s-bg-overflow");
          return {
            lastSeq: journal?.lastGatewaySeq,
            resyncRequired: journal?.resyncRequired,
          };
        })
        .toEqual({ lastSeq: 2_005, resyncRequired: true });

      // Still zero RPC fetches for s-bg-overflow until user switches to it!
      expect(
        gw.rpcCalls.some(
          (c) =>
            (c.method === "session.resume" || c.method === "session.transcript") &&
            c.params.session_id === "s-bg-overflow",
        ),
      ).toBe(false);

      // Select s-bg-overflow and subscribe -> must emit resync_required, then sessions.resume({ resync: true }) whole-replaces cleanly
      const ovfEvents: Array<{ kind: string; payload: unknown }> = [];
      const selectRes = (await supervisor1.handlers["sessions.select"](
        { connectionId: "local", profileId: "default", sessionId: "s-bg-overflow" },
        { connectionId: "local", profileId: "default", sessionId: "s-bg-overflow" },
      )) as { resyncRequired?: boolean; transcript: unknown };

      const unsubOvf = supervisor1.subscribe(
        "session.transcript",
        { connectionId: "local", profileId: "default", sessionId: "s-bg-overflow" },
        (ev) => ovfEvents.push({ kind: ev.kind, payload: ev.payload }),
      );
      await expect.poll(() => ovfEvents.length).toBeGreaterThan(0);

      expect(selectRes.resyncRequired || ovfEvents.some((e) => e.kind === "resync_required")).toBe(
        true,
      );

      const resumed = (await supervisor1.handlers["sessions.resume"](
        { resync: true },
        { connectionId: "local", profileId: "default", sessionId: "s-bg-overflow" },
      )) as {
        transcript: {
          sessionId: string;
          resynced?: boolean;
          messages: Array<{ messageId: string; text: string }>;
        };
      };
      expect(resumed.transcript.resynced).toBe(true);
      expect(resumed.transcript.messages).toHaveLength(1);
      expect(resumed.transcript.messages[0]).toMatchObject({
        messageId: "gw-clean-1",
        text: "clean full gateway transcript after overflow",
      });
      unsubOvf();

      // Re-create unread before Quit to verify Quit clears & Restart rebuilds unread from 0
      gw.sendNotification("prompt.completed", {
        session_id: "s-fg",
        turn_id: "t-fg-before-quit",
        message_id: "m-fg-q",
        seq: 99,
      });
      await expect
        .poll(
          () =>
            supervisor1
              .getFleetSnapshot()
              .sessions.find((s) => s.sessionId === "s-fg")?.unreadCount,
        )
        .toBe(1);
      expect(
        supervisor1.getFleetSnapshot().sessions.find((s) => s.sessionId === "s-fg")?.unreadCount,
      ).toBe(1);

      await supervisor1.shutdown();
      const chatStore2 = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const supervisor2 = new LocalConnectionSupervisor(backend, {
        chatSessionStateStore: chatStore2,
      });
      await supervisor2.connectLocal("default");
      const rebuiltSessions = supervisor2.getFleetSnapshot().sessions;
      expect(rebuiltSessions.every((s) => s.unreadCount === 0)).toBe(true);

      await supervisor2.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("enforces per-scope 16 LRU eviction with pinned immunity (queuedAdmission / pendingInput / unread / runningTurn), 4 MiB byte cap, and seq gap resync (#37 S1)", async () => {
    const sandbox = createTestSandbox("hermes-s1-lru-37-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_lru_1"]);

    const initialSessions: Array<{ profile_id: string; session_id: string; title: string }> = [
      { profile_id: "default", session_id: "s-active", title: "Active" },
      { profile_id: "default", session_id: "s-pin-running", title: "Pin Running" },
      { profile_id: "default", session_id: "s-pin-clarify", title: "Pin Clarify" },
      { profile_id: "default", session_id: "s-pin-unread", title: "Pin Unread" },
      { profile_id: "default", session_id: "s-pin-queued", title: "Pin Queued" },
      { profile_id: "default", session_id: "s-gap", title: "Seq Gap" },
      { profile_id: "default", session_id: "s-bytes", title: "Byte Limit" },
    ];
    for (let i = 1; i <= 14; i += 1) {
      initialSessions.push({ profile_id: "default", session_id: `u-${i}`, title: `Unpinned ${i}` });
    }

    const gw = await startFakeGatewayServer({ validTickets, initialSessions });
    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend);
      await supervisor.connectLocal("default");

      // Set pin states on the 4 pinned sessions + buffer 1 event in each + 12 unpinned = 16 buffered in scope
      gw.sendNotification("prompt.started", { session_id: "s-pin-running", turn_id: "t-run", seq: 1 });
      gw.sendNotification("clarify.requested", { session_id: "s-pin-clarify", clarify_id: "cl-1" });
      gw.sendNotification("prompt.delta", { session_id: "s-pin-clarify", turn_id: "t-cl", message_id: "m-cl", delta: "hi", seq: 1 });
      gw.sendNotification("prompt.completed", { session_id: "s-pin-unread", turn_id: "t-unr", message_id: "m-unr", seq: 1 });
      gw.sendNotification("admission.queued", { session_id: "s-pin-queued", queued: true });
      gw.sendNotification("prompt.delta", { session_id: "s-pin-queued", turn_id: "t-q", message_id: "m-q", delta: "hi", seq: 1 });

      for (let i = 1; i <= 12; i += 1) {
        gw.sendNotification("prompt.delta", {
          session_id: `u-${i}`,
          turn_id: `t-u-${i}`,
          message_id: `m-u-${i}`,
          delta: "ok",
          seq: 1,
        });
      }
      await expect
        .poll(() => readJournal(supervisor, "local", "default", "u-12")?.eventCount)
        .toBe(1);

      // Now add u-13 and u-14 -> must evict oldest unpinned u-1, u-2, NEVER any of the 4 pinned sessions
      gw.sendNotification("prompt.delta", { session_id: "u-13", turn_id: "t-13", message_id: "m-13", delta: "ok", seq: 1 });
      gw.sendNotification("prompt.delta", { session_id: "u-14", turn_id: "t-14", message_id: "m-14", delta: "ok", seq: 1 });
      await expect
        .poll(() => ({
          u13: readJournal(supervisor, "local", "default", "u-13")?.eventCount,
          u14: readJournal(supervisor, "local", "default", "u-14")?.eventCount,
          u1Resync: readJournal(supervisor, "local", "default", "u-1")?.resyncRequired,
        }))
        .toEqual({ u13: 1, u14: 1, u1Resync: true });

      // u-1 was evicted -> switching to u-1 requires resync; s-pin-running / clarify / unread / queued were NOT evicted
      const selPin = (await supervisor.handlers["sessions.select"](
        { connectionId: "local", profileId: "default", sessionId: "s-pin-running" },
        { connectionId: "local", profileId: "default", sessionId: "s-pin-running" },
      )) as { resyncRequired?: boolean };
      expect(selPin.resyncRequired).toBeFalsy();

      const selEvicted = (await supervisor.handlers["sessions.select"](
        { connectionId: "local", profileId: "default", sessionId: "u-1" },
        { connectionId: "local", profileId: "default", sessionId: "u-1" },
      )) as { resyncRequired?: boolean };
      expect(selEvicted.resyncRequired).toBe(true);

      // Sequence gap on s-gap
      gw.sendNotification("prompt.delta", { session_id: "s-gap", turn_id: "t-g", message_id: "m-g", delta: "a", seq: 1 });
      gw.sendNotification("prompt.delta", { session_id: "s-gap", turn_id: "t-g", message_id: "m-g", delta: "c", seq: 3 });
      // > 4 MiB byte cap on s-bytes (5 * 1 MiB payloads)
      const oneMiB = "z".repeat(1024 * 1024);
      for (let i = 1; i <= 5; i += 1) {
        gw.sendNotification("prompt.delta", { session_id: "s-bytes", turn_id: "t-b", message_id: "m-b", delta: oneMiB, seq: i });
      }
      await expect
        .poll(() => {
          const gap = readJournal(supervisor, "local", "default", "s-gap");
          const bytes = readJournal(supervisor, "local", "default", "s-bytes");
          return {
            gapLastSeq: gap?.lastGatewaySeq,
            gapResync: gap?.resyncRequired,
            bytesLastSeq: bytes?.lastGatewaySeq,
            bytesResync: bytes?.resyncRequired,
          };
        })
        .toEqual({
          gapLastSeq: 3,
          gapResync: true,
          bytesLastSeq: 5,
          bytesResync: true,
        });

      const selGap = (await supervisor.handlers["sessions.select"](
        { connectionId: "local", profileId: "default", sessionId: "s-gap" },
        { connectionId: "local", profileId: "default", sessionId: "s-gap" },
      )) as { resyncRequired?: boolean };
      expect(selGap.resyncRequired).toBe(true);

      const selBytes = (await supervisor.handlers["sessions.select"](
        { connectionId: "local", profileId: "default", sessionId: "s-bytes" },
        { connectionId: "local", profileId: "default", sessionId: "s-bytes" },
      )) as { resyncRequired?: boolean };
      expect(selBytes.resyncRequired).toBe(true);

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("reconciles live request & approval.pending, enforces cwd completeness, high-risk sheet, ownerGeneration stale_owner, same-gen resync, ACK-loss check, expired, and orphaned (S1 #39)", async () => {
    const sandbox = createTestSandbox("hermes-s1-approvals-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_apr_1", "tkt_apr_2", "tkt_apr_3"]);
    let pendingFromServer: Array<Record<string, unknown>> = [
      {
        approval_id: "apr-startup-1",
        profile_id: "default",
        session_id: "sess-with-cwd",
        turn_id: "turn-startup",
        execution_generation: 3,
        command: "ls -la",
        description: "List workspace files",
        choices: ["once", "session", "deny"],
      },
      {
        approval_id: "apr-missing-cwd",
        profile_id: "default",
        session_id: "sess-no-cwd",
        turn_id: "turn-nocwd",
        execution_generation: 1,
        command: "cat README.md",
        choices: ["once", "deny"],
      },
    ];
    let respondMode: "settled" | "settled_elsewhere" | "timeout_once" = "settled";
    let respondAttempts = 0;
    let profilesFromServer = [
      { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
      { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
    ];

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "session.list",
        "session.resume",
        "session.transcript",
        "approval.pending",
        "approval.respond",
      ],
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
      ],
      initialSessions: [
        {
          profile_id: "default",
          session_id: "sess-with-cwd",
          title: "Primary Dev Session",
          cwd: "/srv/workspace/project-a",
        },
        {
          profile_id: "default",
          session_id: "sess-no-cwd",
          title: "No CWD Session",
        },
        {
          profile_id: "ops",
          session_id: "sess-ops-bg",
          title: "Background Ops Session",
          cwd: "/srv/ops",
        },
      ],
      onRpc: async (method, _params, { replyResult, replyError }) => {
        if (method === "profiles.list") {
          replyResult({ profiles: profilesFromServer });
          return true;
        }
        if (method === "approval.pending") {
          replyResult({ approvals: pendingFromServer });
          return true;
        }
        if (method === "approval.respond") {
          respondAttempts += 1;
          if (respondMode === "timeout_once" && respondAttempts === 1) {
            replyError(-32000, "simulated ack loss / server busy");
            return true;
          }
          if (respondMode === "settled_elsewhere") {
            replyResult({
              status: "settled_elsewhere_by_server",
              message: "该 Approval 已在另一客户端处理",
            });
            return true;
          }
          replyResult({ status: "settled" });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };
      const localBackend = new LocalBackendManager(ports);
      const store = new RegistryStore({ rootDir: sandbox.hermesHomeDir });
      const sheetRequests: ApprovalHighRiskSheetRequest[] = [];
      let sheetDecision = false;
      let appIsForeground = true;
      const notifications: SafeBackgroundNotification[] = [];

      const supervisor = new LocalConnectionSupervisor(localBackend, {
        registryStore: store,
        isAppForeground: () => appIsForeground,
        onBackgroundNotification: (n) => notifications.push(n),
        confirmHighRiskApproval: async (req) => {
          sheetRequests.push(req);
          return sheetDecision;
        },
      });

      const approvalEvents: BridgeEvent<ApprovalTopicSnapshot>[] = [];
      supervisor.subscribe("approval", null, (ev) => {
        approvalEvents.push(ev as BridgeEvent<ApprovalTopicSnapshot>);
      });

      // 1. Connect -> rehydrates startup pending approvals with Main-provided session snapshot cwd
      await supervisor.connectLocal("default");
      const snap1 = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const startupApr = snap1.approvals.find((a) => a.description === "List workspace files")!;
      const noCwdApr = snap1.approvals.find((a) => a.command === "cat README.md")!;
      expect(startupApr.state).toBe("actionable");
      expect(startupApr.cwd).toBe("/srv/workspace/project-a");
      expect(startupApr.allowedChoices).toEqual(["once", "session", "deny"]);
      // Never guess cwd from previous session or local repo -> context_incomplete
      expect(noCwdApr.state).toBe("context_incomplete");
      expect(noCwdApr.missingContextFields).toContain("cwd");
      expect(noCwdApr.allowedChoices).toEqual(["deny"]);
      await expect(
        supervisor.handlers["approvals.respond"](
          { approvalKey: noCwdApr.approvalKey, choice: "once" },
          null,
        ),
      ).rejects.toThrow();
      // Deny still works even when context_incomplete
      const denyNoCwdRes = (await supervisor.handlers["approvals.respond"](
        { approvalKey: noCwdApr.approvalKey, choice: "deny" },
        null,
      )) as ApprovalRespondResult;
      expect(denyNoCwdRes.status).toBe("settled");

      // 2. Activate 'ops' profile so Main has its session snapshot (title + cwd), then switch back to 'default' so 'ops' is background
      await supervisor.handlers["scopes.switch"]({ connectionId: "local", profileId: "ops" }, null);
      await supervisor.handlers["scopes.switch"]({ connectionId: "local", profileId: "default" }, null);

      // Live server-initiated request carries separate serverRequestId != approvalId, and high-risk sheet cancel stays pending
      appIsForeground = false;
      gw.sendServerRequest(9001, "approval.requested", {
        approval_id: "apr-sudo-live",
        profile_id: "ops",
        session_id: "sess-ops-bg",
        turn_id: "turn-sudo-1",
        execution_generation: 7,
        command: "sudo systemctl restart nginx",
        description: "Restart nginx service",
        choices: ["once", "deny"],
      });
      await expect
        .poll(async () => {
          const snap = (await supervisor.handlers["approvals.list"](
            {},
            null,
          )) as ApprovalTopicSnapshot;
          return snap.approvals.find((a) => a.command === "sudo systemctl restart nginx")?.state;
        })
        .toBe("actionable");

      const snap2 = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const sudoApr = snap2.approvals.find((a) => a.command === "sudo systemctl restart nginx")!;
      expect(sudoApr.state).toBe("actionable");
      expect(sudoApr.requiresHighRiskSheet).toBe(true);
      expect(sudoApr.riskCategories).toContain("sudo");
      expect(sudoApr.isOwningSessionActive).toBe(false);
      // Background approval sets needsInput & emits minimal safe notification without command/cwd/path
      const opsSessions = supervisor
        .getFleetSnapshot()
        .sessions.filter((s) => s.profileId === "ops" && s.sessionId === "sess-ops-bg");
      expect(opsSessions[0]?.needsInput).toBe(true);
      expect(notifications.some((n) => n.kind === "approval_pending")).toBe(true);
      expect(JSON.stringify(notifications)).not.toMatch(/sudo|systemctl|nginx|\/srv\/ops/);

      // Cancel Main native sheet -> remains actionable
      sheetDecision = false;
      const cancelledSheetRes = (await supervisor.handlers["approvals.respond"](
        { approvalKey: sudoApr.approvalKey, choice: "once" },
        null,
      )) as ApprovalRespondResult;
      expect(cancelledSheetRes.status).toBe("cancelled_pending");
      expect(cancelledSheetRes.approval?.state).toBe("actionable");
      expect(sheetRequests[0]?.isOwningSessionBackground).toBe(true);

      // Confirm Main native sheet -> sends both approval_id and server_request_id
      sheetDecision = true;
      const confirmedSheetRes = (await supervisor.handlers["approvals.respond"](
        { approvalKey: sudoApr.approvalKey, choice: "once" },
        null,
      )) as ApprovalRespondResult;
      expect(confirmedSheetRes.status).toBe("settled");
      const respondCall = gw.rpcCalls.find(
        (c) => c.method === "approval.respond" && c.params.approval_id === "apr-sudo-live",
      );
      expect(respondCall?.params.server_request_id).toBe(9001);

      // 3. Same-generation resync via possible_event_loss: marks unverified first, reconciles exact 4-tuple, missing is NOT auto-denied
      const prevOwnerGen = startupApr.ownerGeneration;
      // Inject a second live approval that will be missing during resync
      appIsForeground = true;
      gw.sendNotification("approval.requested", {
        approval_id: "apr-missing-in-resync",
        profile_id: "default",
        session_id: "sess-with-cwd",
        turn_id: "turn-resync-miss",
        execution_generation: 2,
        command: "git status",
        choices: ["once", "deny"],
      });
      await expect
        .poll(async () => {
          const snap = (await supervisor.handlers["approvals.list"](
            {},
            null,
          )) as ApprovalTopicSnapshot;
          return snap.approvals.find((a) => a.command === "git status")?.state;
        })
        .toBe("actionable");

      // Keep startup-1 in pendingFromServer with exact matching tuple, omit apr-missing-in-resync
      pendingFromServer = [
        {
          approval_id: "apr-startup-1",
          profile_id: "default",
          session_id: "sess-with-cwd",
          turn_id: "turn-startup",
          execution_generation: 3,
          command: "ls -la",
          description: "List workspace files",
          choices: ["once", "session", "deny"],
        },
      ];
      gw.sendNotification("possible_event_loss", { authority_epoch: 2 });
      await expect
        .poll(async () => {
          const snap = (await supervisor.handlers["approvals.list"](
            {},
            null,
          )) as ApprovalTopicSnapshot;
          return {
            matched: snap.approvals.find((a) => a.approvalKey === startupApr.approvalKey)?.state,
            missing: snap.approvals.find((a) => a.command === "git status")?.state,
          };
        })
        .toEqual({ matched: "actionable", missing: "unverified" });

      const snapAfterResync = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const resyncMatched = snapAfterResync.approvals.find((a) => a.approvalKey === startupApr.approvalKey)!;
      const resyncMissing = snapAfterResync.approvals.find((a) => a.command === "git status")!;
      expect(resyncMatched.state).toBe("actionable");
      expect(resyncMatched.ownerGeneration).toBe(prevOwnerGen);
      expect(resyncMissing.state).toBe("unverified"); // Missing is NOT auto-denied!

      // 4. Lost ACK on approval.respond checks authoritative pending list
      respondAttempts = 0;
      respondMode = "timeout_once";
      const ackLossPendingRes = (await supervisor.handlers["approvals.respond"](
        { approvalKey: startupApr.approvalKey, choice: "once" },
        null,
      )) as ApprovalRespondResult;
      expect(ackLossPendingRes.status).toBe("pending_reconciled");
      expect(ackLossPendingRes.approval?.state).toBe("actionable");

      // Multi-client: server reports settled_elsewhere_by_server
      respondMode = "settled_elsewhere";
      const elsewhereRes = (await supervisor.handlers["approvals.respond"](
        { approvalKey: startupApr.approvalKey, choice: "once" },
        null,
      )) as ApprovalRespondResult;
      expect(elsewhereRes.status).toBe("settled_elsewhere_by_server");
      expect(elsewhereRes.approval?.state).toBe("settled_elsewhere_by_server");

      // 5. Reconnect changes ownerGeneration -> old approvals immediately stale_owner and never revived in-place
      gw.sendNotification("approval.requested", {
        approval_id: "apr-will-stale",
        profile_id: "default",
        session_id: "sess-with-cwd",
        turn_id: "turn-stale-1",
        execution_generation: 5,
        command: "pwd",
        choices: ["once", "deny"],
      });
      await expect
        .poll(async () => {
          const snap = (await supervisor.handlers["approvals.list"](
            {},
            null,
          )) as ApprovalTopicSnapshot;
          return snap.approvals.find((a) => a.command === "pwd")?.state;
        })
        .toBe("actionable");
      const snapPreReconnect = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const staleCandidate = snapPreReconnect.approvals.find((a) => a.command === "pwd")!;
      expect(staleCandidate.state).toBe("actionable");

      // Gateway still returns apr-will-stale on reconnect, but new ownerGeneration means old key is stale_owner forever
      pendingFromServer = [
        {
          approval_id: "apr-will-stale",
          profile_id: "default",
          session_id: "sess-with-cwd",
          turn_id: "turn-stale-1",
          execution_generation: 5,
          command: "pwd",
          choices: ["once", "deny"],
        },
      ];
      await supervisor.connectLocal("default", { forceReconnect: true });
      const snapPostReconnect = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const oldKeyView = snapPostReconnect.approvals.find(
        (a) => a.approvalKey === staleCandidate.approvalKey,
      )!;
      expect(oldKeyView.state).toBe("stale_owner");
      const newKeyView = snapPostReconnect.approvals.find(
        (a) => a.approvalKey !== staleCandidate.approvalKey && a.command === "pwd",
      )!;
      expect(newKeyView.state).toBe("actionable");
      expect(newKeyView.ownerGeneration).toBeGreaterThan(oldKeyView.ownerGeneration);

      // 6. Expired & Removed Connection -> orphaned (read-only + dismissOrphaned)
      gw.sendNotification("approval.expired", {
        approval_id: "apr-will-stale",
        profile_id: "default",
        session_id: "sess-with-cwd",
        turn_id: "turn-stale-1",
      });
      await expect
        .poll(async () => {
          const snap = (await supervisor.handlers["approvals.list"](
            {},
            null,
          )) as ApprovalTopicSnapshot;
          return snap.approvals.find((a) => a.approvalKey === newKeyView.approvalKey)?.state;
        })
        .toBe("expired");
      const snapAfterExpire = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      expect(
        snapAfterExpire.approvals.find((a) => a.approvalKey === newKeyView.approvalKey)?.state,
      ).toBe("expired");

      // Remote/orphaned test via non-local scope removal
      gw.sendNotification("approval.requested", {
        approval_id: "apr-remote-orphan",
        profile_id: "ops",
        session_id: "sess-ops-bg",
        turn_id: "turn-orphan-1",
        execution_generation: 1,
        command: "whoami",
        choices: ["once", "deny"],
      });
      await expect
        .poll(async () => {
          const snap = (await supervisor.handlers["approvals.list"](
            {},
            null,
          )) as ApprovalTopicSnapshot;
          return snap.approvals.find((a) => a.command === "whoami")?.state;
        })
        .toBe("actionable");
      const preOrphan = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const opsOrphanTarget = preOrphan.approvals.find((a) => a.command === "whoami")!;
      expect(opsOrphanTarget.state).toBe("actionable");

      // Remove 'ops' profile -> approval becomes orphaned (read-only, non-forwardable, dismissible)
      profilesFromServer = [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
      ];
      await supervisor.refreshProfilesForConnection("local");
      const snapOrphaned = (await supervisor.handlers["approvals.list"]({}, null)) as ApprovalTopicSnapshot;
      const orphanedView = snapOrphaned.approvals.find(
        (a) => a.approvalKey === opsOrphanTarget.approvalKey,
      )!;
      expect(orphanedView.state).toBe("orphaned");
      expect(orphanedView.canApprove).toBe(false);
      expect(orphanedView.canDeny).toBe(false);
      expect(orphanedView.canDismiss).toBe(true);
      await expect(
        supervisor.handlers["approvals.respond"](
          { approvalKey: orphanedView.approvalKey, choice: "deny" },
          null,
        ),
      ).rejects.toThrow();
      const afterDismiss = (await supervisor.handlers["approvals.dismissOrphaned"](
        { approvalKey: orphanedView.approvalKey },
        null,
      )) as ApprovalTopicSnapshot;
      expect(
        afterDismiss.approvals.find((a) => a.approvalKey === orphanedView.approvalKey),
      ).toBeUndefined();

      await supervisor.shutdown({ timeoutMs: 2000 });
      store.close();
      expect(approvalEvents.length).toBeGreaterThan(0);
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  }, 15_000);

  it("enforces Ticket #38 Draft receipt clearing, delivery_unknown, no offline queue/flush, atomic session.create migration, and OrphanedDraft lifecycle", async () => {
    const sandbox = createTestSandbox("hermes-s1-s3-drafts-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_d_1", "tkt_d_2"]);
    let failSessionCreate = true;
    let submitMode: "delivery_unknown" | "accepted" | "admitted" = "delivery_unknown";
    let sessionsList = [
      { profile_id: "default", session_id: "sess-active", title: "Active Chat" },
      { profile_id: "default", session_id: "sess-inactive", title: "Inactive Chat" },
      { profile_id: "ops", session_id: "sess-ops", title: "Ops Chat" },
    ];
    let profilesList = [
      { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
      { profile_id: "ops", display_name: "Ops", handle: "ops", is_default: false },
    ];

    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: profilesList,
      initialSessions: sessionsList,
      onRpc: (method, params, ctx) => {
        if (method === "profiles.list") {
          ctx.replyResult({ profiles: profilesList });
          return true;
        }
        if (method === "session.list" || method === "sessions.list") {
          const pid = typeof params.profile_id === "string" ? params.profile_id : "default";
          ctx.replyResult({
            sessions: sessionsList.filter((s) => s.profile_id === pid),
          });
          return true;
        }
        if (method === "session.create") {
          if (failSessionCreate) {
            ctx.replyError(-32000, "create failed temporarily");
            return true;
          }
          ctx.replyResult({
            session: {
              profile_id: params.profile_id,
              session_id: "sess-migrated-1",
              title: params.title ?? "New Migrated",
            },
          });
          return true;
        }
        if (method === "prompt.submit") {
          if (submitMode === "delivery_unknown") {
            ctx.replyResult({ receipt: "delivery_unknown" });
            return true;
          }
          ctx.replyResult({
            receipt: submitMode,
            turn_id: `turn-${submitMode}`,
            user_message_id: `u-${submitMode}`,
            assistant_message_id: `a-${submitMode}`,
          });
          return true;
        }
        return false;
      },
    });

    try {
      const cliPath = path.join(sandbox.rootDir, "hermes");
      await writeFakeHermesCli({ cliPath, wsUrl: gw.wsUrl });
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(cliPath);
      const origRun = ports.runProcess;
      ports.runProcess = async (req) => {
        const res = await origRun(req);
        if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
          const parsed = JSON.parse(res.stdout) as { ticket?: string };
          if (parsed.ticket) validTickets.add(parsed.ticket);
        }
        return res;
      };

      const store = new ChatSessionStateStore({ userDataDir: sandbox.userDataDir });
      const backend = new LocalBackendManager(ports);
      const supervisor = new LocalConnectionSupervisor(backend, { chatSessionStateStore: store });

      // 1) Offline saveDraft works locally, prompts.send rejects without queuing or auto-sending on connect
      await supervisor.handlers["chatState.saveDraft"](
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "sess-active",
          text: "offline draft text",
        },
        { connectionId: "local", profileId: "default", sessionId: "sess-active" },
      );
      await expect(
        supervisor.handlers["prompts.send"](
          { sessionId: "sess-active", text: "offline draft text" },
          { connectionId: "local", profileId: "default", sessionId: "sess-active" },
        ),
      ).rejects.toThrow();

      await supervisor.connectLocal("default");
      // Must NOT auto-send prompt.submit on connect!
      expect(gw.rpcCalls.filter((c) => c.method === "prompt.submit")).toHaveLength(0);
      expect(
        store.getProjection().draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-active")]?.text,
      ).toBe("offline draft text");

      // 2) delivery_unknown keeps draft & marks deliveryStatus="delivery_unknown"; accepted clears draft
      const unknownRes = (await supervisor.handlers["prompts.send"](
        { sessionId: "sess-active", text: "offline draft text" },
        { connectionId: "local", profileId: "default", sessionId: "sess-active" },
      )) as { accepted: boolean; deliveryUnknown?: boolean };
      expect(unknownRes.accepted).toBe(false);
      expect(unknownRes.deliveryUnknown).toBe(true);
      expect(
        store.getProjection().draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-active")]
          ?.deliveryStatus,
      ).toBe("delivery_unknown");

      submitMode = "admitted";
      const admittedRes = (await supervisor.handlers["prompts.send"](
        { sessionId: "sess-active", text: "offline draft text" },
        { connectionId: "local", profileId: "default", sessionId: "sess-active" },
      )) as { accepted: boolean; receipt?: string };
      expect(admittedRes.accepted).toBe(true);
      expect(admittedRes.receipt).toBe("admitted");
      expect(
        store.getProjection().draftsByKey?.[makeActiveChatDraftKey("local", "default", "sess-active")],
      ).toBeUndefined();

      // 3) New-chat draft migration: failure keeps original draftId, success migrates atomically
      await supervisor.handlers["chatState.saveDraft"](
        {
          connectionId: "local",
          profileId: "default",
          draftId: "draft-new-abc",
          text: "new conversation prompt",
        },
        { connectionId: "local", profileId: "default" },
      );

      await expect(
        supervisor.handlers["sessions.create"](
          { title: "Will Fail", draftId: "draft-new-abc" },
          { connectionId: "local", profileId: "default" },
        ),
      ).rejects.toThrow();
      expect(
        store.getProjection().draftsByKey?.[makeNewChatDraftKey("local", "default", "draft-new-abc")]
          ?.draftId,
      ).toBe("draft-new-abc");

      failSessionCreate = false;
      const created = (await supervisor.handlers["sessions.create"](
        { title: "Will Succeed", draftId: "draft-new-abc" },
        { connectionId: "local", profileId: "default" },
      )) as { session: { sessionId: string } };
      expect(created.session.sessionId).toBe("sess-migrated-1");
      expect(
        store.getProjection().draftsByKey?.[makeNewChatDraftKey("local", "default", "draft-new-abc")],
      ).toBeUndefined();
      const migratedDraft =
        store.getProjection().draftsByKey?.[
          makeActiveChatDraftKey("local", "default", "sess-migrated-1")
        ];
      expect(migratedDraft?.draftId).toBe("draft-new-abc");
      expect(migratedDraft?.text).toBe("new conversation prompt");

      // 4) Non-active session deleted + profile removed create OrphanedDrafts; export & delete work
      await supervisor.handlers["chatState.saveDraft"](
        { sessionId: "sess-inactive", text: "inactive unsent" },
        { connectionId: "local", profileId: "default", sessionId: "sess-inactive" },
      );
      await supervisor.handlers["chatState.saveDraft"](
        { profileId: "ops", sessionId: "sess-ops", text: "ops unsent" },
        { connectionId: "local", profileId: "ops", sessionId: "sess-ops" },
      );

      // Remove sess-inactive from gateway session.list and refresh
      sessionsList = sessionsList.filter((s) => s.session_id !== "sess-inactive");
      await supervisor.handlers["sessions.list"](
        { profileId: "default" },
        { connectionId: "local", profileId: "default" },
      );
      expect(
        store.getProjection().orphanedDrafts?.some(
          (o) => o.reason === "session_deleted" && o.text === "inactive unsent",
        ),
      ).toBe(true);

      // Remove ops profile from gateway profiles.list and refresh
      profilesList = profilesList.filter((p) => p.profile_id !== "ops");
      await supervisor.handlers["profiles.list"](
        { connectionId: "local" },
        { connectionId: "local" },
      );
      const opsOrphan = store
        .getProjection()
        .orphanedDrafts?.find((o) => o.reason === "profile_removed" && o.text === "ops unsent");
      expect(opsOrphan).toBeDefined();

      const exportedOrphan = (await supervisor.handlers["chatState.exportOrphanedDraft"](
        { orphanedId: opsOrphan!.orphanedId },
        null,
      )) as DraftExportBundle | null;
      expect(exportedOrphan?.text).toBe("ops unsent");

      const afterDeleteOrphan = (await supervisor.handlers["chatState.deleteOrphanedDraft"](
        { orphanedId: opsOrphan!.orphanedId },
        null,
      )) as ChatSessionProjection;
      expect(
        afterDeleteOrphan.orphanedDrafts?.some((o) => o.orphanedId === opsOrphan!.orphanedId),
      ).toBe(false);

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("recovers Ticket #43 unknown turns, stop ACK loss, and steer outcomes over the S1 fake gateway", async () => {
    const sandbox = createTestSandbox("hermes-s1-turn-recovery-");
    let passed = false;
    const validTickets = new Set<string>();

    let activeTurnId: string | null = null;
    let executionGeneration = 5;
    let lastTurnOutcome: "completed" | "stopped" | "interrupted" | "error" | null = null;
    let unknownTurns: Array<Record<string, unknown>> = [];
    let interruptAckLoss = false;
    let steerFailMode = false;
    let steerCalls = 0;
    let interruptCalls = 0;
    let promptSubmitCalls = 0;
    const promptSubmits: Array<Record<string, unknown>> = [];

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "sessions.list",
        "session.list",
        "session.resume",
        "session.transcript",
        "prompt.submit",
        "prompt.cancel",
        "prompt.resolve_unknown",
        "session.interrupt",
        "session.steer",
      ],
      profiles: [{ profile_id: "default", display_name: "Default", handle: "default", is_default: true }],
      initialSessions: [
        { profile_id: "default", session_id: "sess-43", title: "Recovery Session", preview: "ready" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "session.resume" || method === "session.transcript") {
          ctx.replyResult({
            session_id: params.session_id,
            messages: [
              {
                message_id: "msg-original-input",
                role: "user",
                text: "original input during restart",
                created_at: "2026-11-23T12:00:00.000Z",
              },
            ],
            active_turn_id: activeTurnId,
            execution_generation: executionGeneration,
            last_turn_outcome: lastTurnOutcome,
            unknown_turns: unknownTurns,
            queued_admissions: [],
          });
          return true;
        }
        if (method === "prompt.submit") {
          promptSubmitCalls += 1;
          promptSubmits.push({ ...params });
          if (params.queued === true) {
            ctx.replyError(-32600, "queued path not used in this test");
            return true;
          }
          activeTurnId = "turn-running-1";
          lastTurnOutcome = null;
          ctx.replyResult({
            accepted: true,
            session_id: params.session_id,
            turn_id: activeTurnId,
            execution_generation: executionGeneration,
            user_message_id: "msg-user-1",
            assistant_message_id: "msg-assistant-1",
          });
          return true;
        }
        if (method === "session.interrupt") {
          interruptCalls += 1;
          if (interruptAckLoss) {
            gw.closeAllClients();
            return true;
          }
          activeTurnId = null;
          lastTurnOutcome = "stopped";
          ctx.replyResult({
            stopped: true,
            status: "stopped",
            terminal: true,
            turn_id: params.turn_id,
            execution_generation: params.execution_generation,
          });
          return true;
        }
        if (method === "prompt.cancel") {
          activeTurnId = null;
          lastTurnOutcome = "stopped";
          ctx.replyResult({ stopped: true, status: "stopped", terminal: true, turn_id: params.turn_id });
          return true;
        }
        if (method === "prompt.resolve_unknown") {
          ctx.replyResult({
            settled: true,
            status: "interrupted",
            followers_released: true,
            queued_admissions: [],
          });
          return true;
        }
        if (method === "session.steer") {
          steerCalls += 1;
          if (steerFailMode) {
            ctx.replyResult({
              steered: false,
              reason: "generation_mismatch",
              message: "Execution generation moved; choose how to continue.",
            });
            return true;
          }
          ctx.replyResult({ steered: true });
          return true;
        }
        return false;
      },
    });

    try {
      const supervisor = await bootFakeLocalSupervisor({
        sandbox,
        wsUrl: gw.wsUrl,
        validTickets,
      });
      const scope = { connectionId: "local", profileId: "default", sessionId: "sess-43" };
      const recoveryEvents: TurnRecoveryTopicSnapshot[] = [];
      const unsub = supervisor.subscribe("turn.recovery", null, (event: BridgeEvent) => {
        recoveryEvents.push(event.payload as TurnRecoveryTopicSnapshot);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const latestRecovery = () =>
        recoveryEvents[recoveryEvents.length - 1]?.sessions.find(
          (item) => item.sessionId === "sess-43",
        ) ?? null;

      // 1. Unknown turn after owner death: pause queue, no auto-discard, original input preserved.
      const firstSend = (await supervisor.handlers["prompts.send"](
        { sessionId: "sess-43", text: "original input during restart" },
        scope,
      )) as { accepted: boolean; turnId: string; executionGeneration: number };
      expect(firstSend.accepted).toBe(true);
      expect(firstSend.executionGeneration).toBe(executionGeneration);
      expect(promptSubmitCalls).toBe(1);

      activeTurnId = null;
      lastTurnOutcome = "interrupted";
      unknownTurns = [
        {
          admission_id: "adm-lost-1",
          execution_generation: executionGeneration,
          turn_id: firstSend.turnId,
          original_input: "original input during restart",
          reason: "owner_restarted",
          message: "Turn lost during restart",
        },
      ];
      const resumed = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-43", resync: true },
        scope,
      )) as { transcript: SessionTranscriptSnapshot };
      expect(resumed.transcript.activeTurnId).toBeNull();
      expect(resumed.transcript.messages.some((m) => m.text.includes("original input"))).toBe(true);

      const pausedView = latestRecovery();
      expect(pausedView?.queuePaused).toBe(true);
      expect(pausedView?.unknownTurn).toMatchObject({
        admissionId: "adm-lost-1",
        executionGeneration,
        message: "Turn lost during restart",
      });
      expect(
        gw.rpcCalls.filter((call) => call.method === "prompt.resolve_unknown"),
      ).toHaveLength(0);

      await expect(
        supervisor.handlers["prompts.send"]({ sessionId: "sess-43", text: "must not send" }, scope),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        supervisor.handlers["prompts.queue"]({ sessionId: "sess-43", text: "must not queue" }, scope),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(promptSubmitCalls).toBe(1);

      const discard = (await supervisor.handlers["prompts.resolveUnknown"](
        {
          sessionId: "sess-43",
          admissionId: "adm-lost-1",
          executionGeneration,
        },
        scope,
      )) as { resolved: boolean; status: string };
      expect(discard).toMatchObject({ resolved: true, status: "interrupted" });
      const resolveCall = gw.rpcCalls.find((call) => call.method === "prompt.resolve_unknown");
      expect(resolveCall?.params).toEqual({
        profile_id: "default",
        session_id: "sess-43",
        admission_id: "adm-lost-1",
        execution_generation: executionGeneration,
      });
      expect(latestRecovery()?.unknownTurn).toBeNull();
      expect(latestRecovery()?.queuePaused).toBe(false);

      // 2. Stop: generation mismatch is rejected without a wire call; ACK loss becomes cancel_outcome_unknown.
      const secondSend = (await supervisor.handlers["prompts.send"](
        { sessionId: "sess-43", text: "second turn" },
        scope,
      )) as { turnId: string };
      await expect(
        supervisor.handlers["prompts.stop"](
          { sessionId: "sess-43", turnId: secondSend.turnId, executionGeneration: executionGeneration - 1 },
          scope,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(interruptCalls).toBe(0);

      interruptAckLoss = true;
      const lostStop = (await supervisor.handlers["prompts.stop"](
        { sessionId: "sess-43", turnId: secondSend.turnId, executionGeneration },
        scope,
      )) as { stopped: boolean; status: string; turnId: string; executionGeneration: number };
      expect(lostStop).toMatchObject({
        stopped: false,
        status: "cancel_outcome_unknown",
        turnId: secondSend.turnId,
        executionGeneration,
      });
      expect(interruptCalls).toBe(1);
      const interruptPayload = gw.rpcCalls.find((call) => call.method === "session.interrupt");
      expect(interruptPayload?.params).toEqual({
        profile_id: "default",
        session_id: "sess-43",
        turn_id: secondSend.turnId,
        execution_generation: executionGeneration,
      });
      expect(latestRecovery()?.stopState).toBe("cancel_outcome_unknown");

      // Reconnect and resume: the server says the turn is terminal; never auto-resend the stop.
      await supervisor.handlers["connections.retry"]({ connectionId: "local" }, null);
      await expect.poll(() => supervisor.getLocalHealth().actual).toBe("ready");
      interruptAckLoss = false;
      activeTurnId = null;
      lastTurnOutcome = "interrupted";
      unknownTurns = [];
      await supervisor.handlers["sessions.resume"]({ sessionId: "sess-43", resync: true }, scope);
      expect(interruptCalls).toBe(1);
      expect(latestRecovery()?.stopState).toBe("stopped");

      // 3. Steer: success, explicit failure fallback, and a precheck-only turn_finished refusal.
      const thirdSend = (await supervisor.handlers["prompts.send"](
        { sessionId: "sess-43", text: "third turn" },
        scope,
      )) as { turnId: string; executionGeneration: number };
      const steerOk = (await supervisor.handlers["prompts.steer"](
        {
          sessionId: "sess-43",
          turnId: thirdSend.turnId,
          executionGeneration: thirdSend.executionGeneration,
          text: "focus on the failing test",
        },
        scope,
      )) as { steered: boolean; status: string };
      expect(steerOk).toMatchObject({ steered: true, status: "steered" });
      const steerCall = gw.rpcCalls.filter((call) => call.method === "session.steer").at(-1);
      expect(steerCall?.params).toEqual({
        profile_id: "default",
        session_id: "sess-43",
        turn_id: thirdSend.turnId,
        execution_generation: thirdSend.executionGeneration,
        text: "focus on the failing test",
      });

      const submitCountBeforeFailedSteer = promptSubmitCalls;
      steerFailMode = true;
      const steerFailed = (await supervisor.handlers["prompts.steer"](
        {
          sessionId: "sess-43",
          turnId: thirdSend.turnId,
          executionGeneration: thirdSend.executionGeneration,
          text: "do not silently resend",
        },
        scope,
      )) as {
        status: string;
        steered: boolean;
        requiresExplicitFallback: boolean;
        allowedFallbacks: string[];
        reason: string;
      };
      expect(steerFailed).toMatchObject({
        status: "failed",
        steered: false,
        requiresExplicitFallback: true,
        allowedFallbacks: ["new_turn", "queue"],
        reason: "generation_mismatch",
      });
      expect(promptSubmitCalls).toBe(submitCountBeforeFailedSteer);

      steerFailMode = false;
      const stopped = (await supervisor.handlers["prompts.stop"](
        { sessionId: "sess-43", turnId: thirdSend.turnId, executionGeneration },
        scope,
      )) as { status: string };
      expect(stopped.status).toBe("stopped");
      const steerCallsBeforePrecheck = steerCalls;
      const steerFinished = (await supervisor.handlers["prompts.steer"](
        {
          sessionId: "sess-43",
          turnId: thirdSend.turnId,
          executionGeneration,
          text: "late steer",
        },
        scope,
      )) as {
        status: string;
        steered: boolean;
        requiresExplicitFallback: boolean;
        reason: string;
      };
      expect(steerFinished).toMatchObject({
        status: "failed",
        steered: false,
        requiresExplicitFallback: true,
        reason: "turn_finished",
      });
      expect(steerCalls).toBe(steerCallsBeforePrecheck);

      // No implicit fallback ever calls prompt.submit.
      expect(promptSubmitCalls).toBe(3);
      expect(promptSubmits.every((call) => call.queued !== true)).toBe(true);

      unsub();
      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("requires an admitted Ticket #43 queue receipt before showing the queue card, retries only the same submissionId after reconciliation, and cancels by admissionId", async () => {
    const sandbox = createTestSandbox("hermes-s1-queue-recovery-");
    let passed = false;
    const validTickets = new Set<string>();

    let admissionSeq = 0;
    let deliveryUnknownSubmissionId: string | null = "sub-q-2";
    let alwaysDeliveryUnknownSubmissionId: string | null = "sub-q-3";
    let receiptFound = false;
    const queueAdmissions: Array<Record<string, unknown>> = [];
    const cancelStatuses = new Map<string, string>();
    const promptSubmits: Array<Record<string, unknown>> = [];
    const promptCancels: Array<Record<string, unknown>> = [];
    let holdCancelForAdmission: string | null = null;
    let resolveCancelEntered: (() => void) | null = null;
    let releaseHeldCancel: (() => void) | null = null;

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "sessions.list",
        "session.list",
        "session.resume",
        "session.transcript",
        "prompt.submit",
        "prompt.receipt",
        "prompt.cancel",
      ],
      profiles: [{ profile_id: "default", display_name: "Default", handle: "default", is_default: true }],
      initialSessions: [
        { profile_id: "default", session_id: "sess-queue", title: "Queue Session", preview: "ready" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "session.resume" || method === "session.transcript") {
          ctx.replyResult({
            session_id: params.session_id,
            messages: [],
            active_turn_id: null,
            execution_generation: 5,
            queued_admissions: queueAdmissions,
          });
          return true;
        }
        if (method === "prompt.submit") {
          promptSubmits.push({ ...params });
          const submissionId = String(params.submission_id ?? "");
          if (params.queued === true && deliveryUnknownSubmissionId === submissionId) {
            deliveryUnknownSubmissionId = null;
            ctx.replyResult({
              admitted: true,
              status: "queued",
              submission_id: submissionId,
            });
            return true;
          }
          if (params.queued === true && alwaysDeliveryUnknownSubmissionId === submissionId) {
            ctx.replyResult({
              admitted: true,
              status: "queued",
              submission_id: submissionId,
            });
            return true;
          }
          if (params.queued !== true) {
            ctx.replyError(-32600, "this S1 test only queues prompts");
            return true;
          }
          admissionSeq += 1;
          const admissionId = `adm-q-${admissionSeq}`;
          queueAdmissions.push({
            admission_id: admissionId,
            submission_id: submissionId,
            text: params.text,
            position: admissionSeq,
            status: "queued",
            execution_generation: 5,
          });
          ctx.replyResult({
            admitted: true,
            admission_id: admissionId,
            submission_id: submissionId,
            position: admissionSeq,
            execution_generation: 5,
            status: "queued",
          });
          return true;
        }
        if (method === "prompt.receipt") {
          const match = queueAdmissions.find(
            (item) => item.submission_id === params.submission_id,
          );
          ctx.replyResult({
            found: receiptFound && Boolean(match),
            ...(match ? { admission: match } : {}),
            queued_admissions: queueAdmissions,
          });
          return true;
        }
        if (method === "prompt.cancel") {
          promptCancels.push({ ...params });
          const admissionId = String(params.admission_id ?? "");
          if (!admissionId) {
            ctx.replyResult({ stopped: true, status: "stopped" });
            return true;
          }
          const replyCancel = () => {
            const status = cancelStatuses.get(admissionId) ?? "cancelled";
            const row = queueAdmissions.find((item) => item.admission_id === admissionId);
            if (row) row.status = status;
            ctx.replyResult({
              status,
              admission_id: admissionId,
              ...(status === "cancelled" ? { cancelled: true } : {}),
              ...(status === "stopped" ? { stopped: true } : {}),
              ...(status === "already_started"
                ? { already_started: true, turn_id: "turn-started" }
                : {}),
            });
          };
          if (holdCancelForAdmission === admissionId) {
            holdCancelForAdmission = null;
            releaseHeldCancel = replyCancel;
            resolveCancelEntered?.();
            return true;
          }
          replyCancel();
          return true;
        }
        return false;
      },
    });

    try {
      const supervisor = await bootFakeLocalSupervisor({
        sandbox,
        wsUrl: gw.wsUrl,
        validTickets,
      });
      const scope = { connectionId: "local", profileId: "default", sessionId: "sess-queue" };
      const recoveryEvents: TurnRecoveryTopicSnapshot[] = [];
      const unsub = supervisor.subscribe("turn.recovery", null, (event: BridgeEvent) => {
        recoveryEvents.push(event.payload as TurnRecoveryTopicSnapshot);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const latestRecovery = () =>
        recoveryEvents[recoveryEvents.length - 1]?.sessions.find(
          (item) => item.sessionId === "sess-queue",
        ) ?? null;

      // 1. Only an admitted receipt with a server admission_id creates a queue card.
      const admitted = (await supervisor.handlers["prompts.queue"](
        { sessionId: "sess-queue", text: "queued first", submissionId: "sub-q-1" },
        scope,
      )) as { status: string; admission?: { admissionId: string; submissionId: string } };
      expect(admitted).toMatchObject({
        status: "admitted",
        admission: { admissionId: "adm-q-1", submissionId: "sub-q-1" },
      });
      expect(promptSubmits[0]).toEqual({
        profile_id: "default",
        session_id: "sess-queue",
        text: "queued first",
        queued: true,
        submission_id: "sub-q-1",
      });
      expect(latestRecovery()?.queuedAdmissions).toHaveLength(1);
      expect(latestRecovery()?.queuedAdmissions[0]).toMatchObject({
        admissionId: "adm-q-1",
        state: "queued",
        position: 1,
      });

      // 2. Missing admission_id => delivery_unknown, no queue card, no automatic retry.
      const missingReceipt = (await supervisor.handlers["prompts.queue"](
        { sessionId: "sess-queue", text: "receipt missing", submissionId: "sub-q-2" },
        scope,
      )) as {
        status: string;
        deliveryUnknown: { submissionId: string; canRetrySameSubmission: boolean };
      };
      expect(missingReceipt.status).toBe("delivery_unknown");
      expect(missingReceipt.deliveryUnknown).toMatchObject({
        submissionId: "sub-q-2",
        canRetrySameSubmission: false,
      });
      expect(latestRecovery()?.queuedAdmissions).toHaveLength(1);
      expect(latestRecovery()?.pendingDeliveryUnknown).toHaveLength(1);
      expect(promptSubmits).toHaveLength(2);

      // 3. Receipt/queue snapshot confirms absence -> only then can the same submissionId retry.
      const receipt = (await supervisor.handlers["prompts.checkQueueReceipt"](
        { sessionId: "sess-queue", submissionId: "sub-q-2" },
        scope,
      )) as { found: boolean; canRetrySameSubmission: boolean };
      expect(receipt).toMatchObject({ found: false, canRetrySameSubmission: true });
      expect(latestRecovery()?.pendingDeliveryUnknown[0]).toMatchObject({
        submissionId: "sub-q-2",
        state: "retry_ready",
        canRetrySameSubmission: true,
      });
      expect(latestRecovery()?.queuedAdmissions).toHaveLength(1);

      const retried = (await supervisor.handlers["prompts.retryQueue"](
        { sessionId: "sess-queue", submissionId: "sub-q-2" },
        scope,
      )) as { status: string; admission?: { admissionId: string; submissionId: string } };
      expect(retried).toMatchObject({
        status: "admitted",
        admission: { admissionId: "adm-q-2", submissionId: "sub-q-2" },
      });
      const retriedSubmits = promptSubmits.filter((call) => call.submission_id === "sub-q-2");
      expect(retriedSubmits).toHaveLength(2);
      expect(retriedSubmits[1]).toEqual(retriedSubmits[0]);
      expect(latestRecovery()?.pendingDeliveryUnknown).toHaveLength(0);
      expect(latestRecovery()?.queuedAdmissions.map((item) => item.admissionId)).toEqual([
        "adm-q-1",
        "adm-q-2",
      ]);

      // 3a. Unknown submissionId is not fabricated into an empty retry_ready record.
      const unknownReceipt = (await supervisor.handlers["prompts.checkQueueReceipt"](
        { sessionId: "sess-queue", submissionId: "sub-does-not-exist" },
        scope,
      )) as { found: boolean; canRetrySameSubmission: boolean };
      expect(unknownReceipt).toEqual({ found: false, canRetrySameSubmission: false });
      expect(latestRecovery()?.pendingDeliveryUnknown).toHaveLength(0);

      // 3b. A retry that still has no admission_id stays delivery_unknown and never becomes a queue card.
      const retryUnknown = (await supervisor.handlers["prompts.queue"](
        { sessionId: "sess-queue", text: "retry stays unknown", submissionId: "sub-q-3" },
        scope,
      )) as {
        status: string;
        deliveryUnknown: { submissionId: string; canRetrySameSubmission: boolean };
      };
      expect(retryUnknown.status).toBe("delivery_unknown");
      const firstUnknownRetry = (await supervisor.handlers["prompts.checkQueueReceipt"](
        { sessionId: "sess-queue", submissionId: "sub-q-3" },
        scope,
      )) as { found: boolean; canRetrySameSubmission: boolean };
      expect(firstUnknownRetry).toMatchObject({ found: false, canRetrySameSubmission: true });
      const stillUnknown = (await supervisor.handlers["prompts.retryQueue"](
        { sessionId: "sess-queue", submissionId: "sub-q-3" },
        scope,
      )) as {
        status: string;
        deliveryUnknown: { submissionId: string; state: string; canRetrySameSubmission: boolean };
      };
      expect(stillUnknown.status).toBe("delivery_unknown");
      expect(stillUnknown.deliveryUnknown).toMatchObject({
        submissionId: "sub-q-3",
        state: "delivery_unknown",
        canRetrySameSubmission: false,
      });
      expect(latestRecovery()?.pendingDeliveryUnknown).toHaveLength(1);
      expect(latestRecovery()?.pendingDeliveryUnknown[0]).toMatchObject({
        submissionId: "sub-q-3",
        state: "delivery_unknown",
        canRetrySameSubmission: false,
      });
      expect(latestRecovery()?.queuedAdmissions.map((item) => item.admissionId)).toEqual([
        "adm-q-1",
        "adm-q-2",
      ]);

      // 4. Cancel by admissionId; server terminal states win and are never inferred locally.
      cancelStatuses.set("adm-q-1", "already_started");
      const startedCancel = (await supervisor.handlers["prompts.cancelQueued"](
        { sessionId: "sess-queue", admissionId: "adm-q-1" },
        scope,
      )) as { outcome: string; admission: { state: string; turnId?: string } };
      expect(startedCancel.outcome).toBe("already_started");
      expect(startedCancel.admission).toMatchObject({
        state: "already_started",
        turnId: "turn-started",
      });

      cancelStatuses.set("adm-q-2", "cancelled");
      const cancelled = (await supervisor.handlers["prompts.cancelQueued"](
        { sessionId: "sess-queue", admissionId: "adm-q-2" },
        scope,
      )) as { outcome: string; admission: { state: string } };
      expect(cancelled).toMatchObject({ outcome: "cancelled", admission: { state: "cancelled" } });
      expect(promptCancels).toEqual([
        { profile_id: "default", session_id: "sess-queue", admission_id: "adm-q-1" },
        { profile_id: "default", session_id: "sess-queue", admission_id: "adm-q-2" },
      ]);
      expect(latestRecovery()?.queuedAdmissions.find((q) => q.admissionId === "adm-q-2")?.state).toBe(
        "cancelled",
      );

      // 5. Another client settles first while this client's cancel is still in flight.
      //    The Gateway snapshot and cancel reply win; do not infer a local cancelled state,
      //    duplicate the cancel RPC, or enqueue the prompt again.
      const fourthQueue = (await supervisor.handlers["prompts.queue"](
        { sessionId: "sess-queue", text: "first response wins", submissionId: "sub-q-4" },
        scope,
      )) as { status: string; admission: { admissionId: string } };
      expect(fourthQueue.status).toBe("admitted");
      const fourthAdmissionId = fourthQueue.admission.admissionId;
      const submitsBeforeRace = promptSubmits.length;
      const cancelsBeforeRace = promptCancels.length;
      let markCancelEntered: (() => void) | null = null;
      const cancelEntered = new Promise<void>((resolve) => {
        markCancelEntered = resolve;
      });
      resolveCancelEntered = markCancelEntered;
      holdCancelForAdmission = fourthAdmissionId;

      const inFlightCancel = supervisor.handlers["prompts.cancelQueued"](
        { sessionId: "sess-queue", admissionId: fourthAdmissionId },
        scope,
      );
      await cancelEntered;
      expect(latestRecovery()?.queuedAdmissions.find((q) => q.admissionId === fourthAdmissionId)?.state).toBe(
        "cancelling",
      );

      const settledByOtherClient = queueAdmissions.find(
        (item) => item.admission_id === fourthAdmissionId,
      );
      if (settledByOtherClient) settledByOtherClient.status = "already_started";
      cancelStatuses.set(fourthAdmissionId, "already_started");
      await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-queue", resync: true },
        scope,
      );
      const releaseCancel = releaseHeldCancel as (() => void) | null;
      expect(releaseCancel).not.toBeNull();
      releaseCancel?.();

      const firstResponse = (await inFlightCancel) as {
        outcome: string;
        admission: { state: string; turnId?: string };
      };
      expect(firstResponse).toMatchObject({
        outcome: "already_started",
        admission: { state: "already_started", turnId: "turn-started" },
      });
      expect(promptCancels.slice(cancelsBeforeRace)).toEqual([
        { profile_id: "default", session_id: "sess-queue", admission_id: fourthAdmissionId },
      ]);
      expect(promptSubmits).toHaveLength(submitsBeforeRace);
      expect(latestRecovery()?.queuedAdmissions.find((q) => q.admissionId === fourthAdmissionId)?.state).toBe(
        "already_started",
      );

      unsub();
      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("keeps Memory and Messaging read-only, exposes native Ticket #44 Cron actions, discloses 17 reachable / 4 deferred, and degrades to read-only or unavailable on missing methods", async () => {
    const sandbox = createTestSandbox("hermes-s1-readonly-domains-");
    let passed = false;
    const validTickets = new Set<string>();

    let memoryMode: "breakdown" | "info" | "unsupported" = "breakdown";
    let messagingMode: "ok" | "missing" = "ok";
    let cronStatusMissing = false;
    let cronSubmitMissing = false;
    const cronJobs: Array<Record<string, unknown>> = [
      {
        id: "cron-daily",
        name: "Daily digest",
        schedule: "0 9 * * *",
        prompt: "Summarize the overnight build",
        status: "scheduled",
        next_run_at: "2026-11-24T01:00:00.000Z",
      },
      {
        id: "cron-hourly",
        name: "Hourly cleanup",
        schedule: "0 * * * *",
        prompt: "Clean caches",
        status: "failed",
      },
    ];
    const cronCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

    const memoryBreakdown = {
      total_tokens: 18400,
      max_tokens: 128000,
      sections: [
        { id: "system", label: "系统提示词", tokens: 4000, percentage: 21.7 },
        { id: "tools", label: "工具结果", tokens: 14400, percentage: 78.3 },
      ],
      notes: ["Memory 预算健康"],
    };
    const sessionInfo = {
      context_tokens: 9200,
      context_window: 128000,
      breakdown: [
        { id: "history", label: "历史消息", tokens: 9200, percentage: 100 },
      ],
      notes: ["来自 session.info 的只读上下文"],
    };
    const messagingPayload = {
      connectors: [
        {
          id: "slack",
          platform: "Slack",
          label: "Slack",
          status: "connected",
          gateway_id: "gw-slack",
          detail: "已连接工作区",
        },
        { id: "email", platform: "Email", label: "Email", status: "disconnected" },
      ],
    };

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "sessions.list",
        "session.list",
        "session.resume",
        "session.transcript",
        "prompt.submit",
        "session.info",
        "session.context_breakdown",
        "messaging.status",
        "cron.status",
        "cron.submit",
        "cron.cancel",
        "cron.recover",
      ],
      profiles: [{ profile_id: "default", display_name: "Default", handle: "default", is_default: true }],
      initialSessions: [
        { profile_id: "default", session_id: "sess-domains", title: "Domains Session", preview: "ready" },
      ],
      onRpc: (method, params, ctx) => {
        if (method === "session.resume" || method === "session.transcript") {
          ctx.replyResult({
            session_id: params.session_id,
            messages: [],
            active_turn_id: null,
          });
          return true;
        }
        if (method === "session.info") {
          if (memoryMode === "unsupported") {
            ctx.replyError(-32601, "Method not found: session.info");
          } else {
            ctx.replyResult(sessionInfo);
          }
          return true;
        }
        if (method === "session.context_breakdown") {
          if (memoryMode === "breakdown") {
            ctx.replyResult(memoryBreakdown);
          } else {
            ctx.replyError(-32601, "Method not found: session.context_breakdown");
          }
          return true;
        }
        if (method === "messaging.status") {
          if (messagingMode === "ok") {
            ctx.replyResult(messagingPayload);
          } else {
            ctx.replyError(-32601, "Method not found: messaging.status");
          }
          return true;
        }
        if (method === "cron.status") {
          if (cronStatusMissing) {
            ctx.replyError(-32601, "Method not found: cron.status");
          } else {
            ctx.replyResult({
              jobs: cronJobs,
              recent_run_summary: "今日 09:00 成功",
            });
          }
          return true;
        }
        if (method === "cron.submit" || method === "cron.cancel" || method === "cron.recover") {
          cronCalls.push({ method, params: { ...params } });
          if (method === "cron.submit" && cronSubmitMissing) {
            ctx.replyError(-32601, "Method not found: cron.submit");
            return true;
          }
          if (method === "cron.submit") {
            cronJobs.push({
              id: "cron-new-1",
              name: params.name,
              schedule: params.schedule,
              prompt: params.prompt,
              status: "scheduled",
            });
            ctx.replyResult({ ok: true, job_id: "cron-new-1" });
          } else if (method === "cron.cancel") {
            const row = cronJobs.find((job) => job.id === params.job_id);
            if (row) row.status = "cancelled";
            ctx.replyResult({ ok: true, job_id: params.job_id });
          } else {
            const row = cronJobs.find((job) => job.id === params.job_id);
            if (row) row.status = "scheduled";
            ctx.replyResult({ ok: true, job_id: params.job_id });
          }
          return true;
        }
        return false;
      },
    });

    try {
      const supervisor = await bootFakeLocalSupervisor({
        sandbox,
        wsUrl: gw.wsUrl,
        validTickets,
      });
      const scope = { connectionId: "local", profileId: "default", sessionId: "sess-domains" };

      const memorySnap = (await supervisor.handlers["capabilities.describe"](
        { domain: "memory" },
        scope,
      )) as CapabilitySnapshot;
      expect(memorySnap.memory).toMatchObject({
        status: "available",
        readOnly: true,
        sourceMethod: "session.context_breakdown",
        totalTokens: 18400,
        maxTokens: 128000,
      });
      expect(memorySnap.memory.sections).toHaveLength(2);
      expect(memorySnap.domains.find((domain) => domain.domain === "memory")).toMatchObject({
        classification: "read_only",
        runtimeStatus: "read_only",
      });
      const memoryEntries = memorySnap.entries.filter((entry) => entry.domain === "memory");
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]).toMatchObject({
        actionId: "memory.inspect",
        classification: "read_only",
        handlerId: "surface.openMemoryInspect",
        evidenceTestId: "cap-action-memory-inspect",
      });
      expect(JSON.stringify(memorySnap.memory)).not.toMatch(/memory_graph|delete|edit|toggle/i);

      const messagingSnap = (await supervisor.handlers["capabilities.describe"](
        { domain: "messaging" },
        scope,
      )) as CapabilitySnapshot;
      expect(messagingSnap.messaging).toMatchObject({
        status: "available",
        readOnly: true,
      });
      expect(messagingSnap.messaging.connectors).toHaveLength(2);
      expect(messagingSnap.messaging.connectors[0]?.attribution.origin).toBe("external");
      expect(messagingSnap.messaging.connectors[1]?.attribution.sourceLabel).toBe("来源未知");
      const messagingEntries = messagingSnap.entries.filter((entry) => entry.domain === "messaging");
      expect(messagingEntries).toHaveLength(1);
      expect(messagingEntries[0]).toMatchObject({
        actionId: "messaging.status",
        classification: "read_only",
        handlerId: "surface.openMessagingInspect",
      });
      expect(JSON.stringify(messagingSnap.messaging)).not.toMatch(/连接账号|oauth|client_secret/i);

      // Memory fallback: context_breakdown is missing, session.info still supplies read-only context.
      memoryMode = "info";
      const memoryFallback = (await supervisor.handlers["capabilities.describe"](
        { domain: "memory", refresh: true },
        scope,
      )) as CapabilitySnapshot;
      expect(memoryFallback.memory).toMatchObject({
        status: "available",
        readOnly: true,
        sourceMethod: "session.info",
      });
      expect(memoryFallback.memory.sections.length).toBeGreaterThan(0);
      expect(memoryFallback.domains.find((domain) => domain.domain === "memory")).toMatchObject({
        classification: "read_only",
        runtimeStatus: "read_only",
      });
      expect(
        memoryFallback.entries.find((entry) => entry.actionId === "memory.inspect"),
      ).toMatchObject({
        classification: "read_only",
        runtimeStatus: "read_only",
      });

      // No Memory read methods => unsupported, zero invented Memory Graph rows.
      memoryMode = "unsupported";
      const memoryUnsupported = (await supervisor.handlers["capabilities.describe"](
        { domain: "memory", refresh: true },
        scope,
      )) as CapabilitySnapshot;
      expect(memoryUnsupported.memory.status).toBe("unsupported");
      expect(memoryUnsupported.memory.sections).toEqual([]);
      expect(memoryUnsupported.memory.degradation?.reason).toBe("method_not_found");

      messagingMode = "missing";
      const messagingUnsupported = (await supervisor.handlers["capabilities.describe"](
        { domain: "messaging", refresh: true },
        scope,
      )) as CapabilitySnapshot;
      expect(messagingUnsupported.messaging.status).toBe("unsupported");
      expect(messagingUnsupported.messaging.connectors).toEqual([]);

      // Cron native: status + submit + cancel + recover and Routines folded into Cron.
      const cronSnap = (await supervisor.handlers["capabilities.describe"](
        { domain: "cron", refresh: true },
        scope,
      )) as CapabilitySnapshot;
      expect(cronSnap.cron).toMatchObject({
        status: "available",
        mode: "interactive",
        routinesFoldedIntoCron: true,
        supportedActions: {
          canStatus: true,
          canSubmit: true,
          canCancel: true,
          canRecover: true,
        },
      });
      expect(cronSnap.cron.jobs.map((job) => job.jobId)).toEqual(["cron-daily", "cron-hourly"]);
      expect(cronSnap.cron.recentRunSummary).toContain("09:00");

      const submitted = (await supervisor.handlers["cron.submit"](
        { name: "Nightly backup", schedule: "0 2 * * *", prompt: "Run the nightly backup" },
        scope,
      )) as { ok: boolean; jobId: string; cron: { jobs: Array<{ jobId: string }> } };
      expect(submitted).toMatchObject({ ok: true, jobId: "cron-new-1" });
      expect(submitted.cron.jobs.some((job) => job.jobId === "cron-new-1")).toBe(true);
      expect(cronCalls[0]).toEqual({
        method: "cron.submit",
        params: {
          profile_id: "default",
          name: "Nightly backup",
          schedule: "0 2 * * *",
          prompt: "Run the nightly backup",
        },
      });

      const cancelled = (await supervisor.handlers["cron.cancel"](
        { jobId: "cron-daily" },
        scope,
      )) as { ok: boolean; cron: { jobs: Array<{ jobId: string; status: string }> } };
      expect(cancelled.ok).toBe(true);
      expect(cancelled.cron.jobs.find((job) => job.jobId === "cron-daily")?.status).toBe("cancelled");
      expect(cronCalls[1]).toEqual({
        method: "cron.cancel",
        params: { profile_id: "default", job_id: "cron-daily" },
      });

      const recovered = (await supervisor.handlers["cron.recover"](
        { jobId: "cron-daily" },
        scope,
      )) as { ok: boolean; cron: { jobs: Array<{ jobId: string; status: string }> } };
      expect(recovered.ok).toBe(true);
      expect(recovered.cron.jobs.find((job) => job.jobId === "cron-daily")?.status).toBe("scheduled");
      expect(cronCalls[2]).toEqual({
        method: "cron.recover",
        params: { profile_id: "default", job_id: "cron-daily" },
      });

      // Missing cron.submit -> capability_unavailable, never a fake local task.
      cronSubmitMissing = true;
      await expect(
        supervisor.handlers["cron.submit"](
          { name: "Must not fake", schedule: "0 3 * * *", prompt: "no" },
          scope,
        ),
      ).rejects.toMatchObject({ code: "capability_unavailable" });
      const readOnlyCron = (await supervisor.handlers["capabilities.describe"](
        { domain: "cron", refresh: true },
        scope,
      )) as CapabilitySnapshot;
      expect(readOnlyCron.cron.mode).toBe("read_only");
      expect(readOnlyCron.cron.supportedActions.canSubmit).toBe(false);
      expect(readOnlyCron.cron.supportedActions.canStatus).toBe(true);
      expect(readOnlyCron.cron.jobs.length).toBeGreaterThan(0);

      // Missing cron.status -> unavailable with no status/submit/cancel/recover affordance.
      cronStatusMissing = true;
      const unavailableCron = (await supervisor.handlers["capabilities.describe"](
        { domain: "cron", refresh: true },
        scope,
      )) as CapabilitySnapshot;
      expect(unavailableCron.cron.status).toBe("unsupported");
      expect(unavailableCron.cron.mode).toBe("unavailable");
      expect(unavailableCron.cron.supportedActions).toEqual({
        canStatus: false,
        canSubmit: false,
        canCancel: false,
        canRecover: false,
      });
      const callsBeforeUnavailableSubmit = cronCalls.length;
      await expect(
        supervisor.handlers["cron.submit"](
          { name: "No status", schedule: "0 4 * * *", prompt: "no" },
          scope,
        ),
      ).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(cronCalls).toHaveLength(callsBeforeUnavailableSubmit);

      // 21-domain inventory with fixed counts and zero deferred actions on every surface.
      const finalSnap = (await supervisor.handlers["capabilities.describe"]({}, scope)) as CapabilitySnapshot;
      expect(finalSnap.counts).toEqual({
        total: 21,
        native: 13,
        readOnly: 3,
        deepLink: 1,
        reachable: 17,
        deferred: 4,
      });
      expect(finalSnap.domains).toHaveLength(21);
      expect(finalSnap.domains.filter((domain) => domain.classification === "deferred")).toHaveLength(4);
      expect(
        finalSnap.entries.filter(
          (entry) =>
            entry.classification === "deferred" ||
            ["voice", "bots", "memory_graph", "kanban"].includes(entry.domain),
        ),
      ).toEqual([]);
      expect(finalSnap.entries.every((entry) => Boolean(entry.handlerId && entry.evidenceTestId))).toBe(
        true,
      );

      await supervisor.dispose();
      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });
});
