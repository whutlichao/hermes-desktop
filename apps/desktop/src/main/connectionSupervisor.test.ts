import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BridgeEvent,
  CapabilitySnapshot,
  ChatSessionProjection,
  SessionTranscriptSnapshot,
} from "@hermes/contracts";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { startFakeGatewayServer } from "../../../../tests/helpers/fakeGatewayServer";
import { ChatSessionStateStore } from "./chatSessionStateStore";
import { LocalBackendManager, createNodeLocalBackendPorts } from "./localBackendManager";
import { LocalConnectionSupervisor } from "./connectionSupervisor";

async function writeFakeHermesCli(options: {
  cliPath: string;
  wsUrl: string;
  perProfileTicketPrefix?: string;
}) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profileId = profileIdx >= 0 && args[profileIdx + 1] ? args[profileIdx + 1] : "default";
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
      profile_id: profileId,
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
      profile_id: profileId,
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
          setTimeout(() => {
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
          }, 15);
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

      await new Promise((r) => setTimeout(r, 60));
      const transcriptSnap = (await supervisor.handlers["sessions.resume"](
        { sessionId: "sess-def-1" },
        { connectionId: "local", profileId: "default", sessionId: "sess-def-1" },
      )) as { transcript: SessionTranscriptSnapshot };
      expect(transcriptSnap.transcript.activeTurnId).toBe("turn-stream-1");
      expect(transcriptSnap.transcript.messages.some((m) => m.text.includes("const x = 1;"))).toBe(true);
      expect(
        transcriptSnap.transcript.messages.some((m) =>
          m.toolRows?.some((r) => r.name === "read_file" && r.status === "completed"),
        ),
      ).toBe(true);

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
          // Hang longer than probeTimeoutMs so settings probe times out -> unknown without blocking connect!
          setTimeout(() => {
            ctx.replyResult({ config: {} });
          }, 250);
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
});
