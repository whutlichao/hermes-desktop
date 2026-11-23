import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeEvent, SessionTranscriptSnapshot } from "@hermes/contracts";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { startFakeGatewayServer } from "../../../../tests/helpers/fakeGatewayServer";
import { LocalBackendManager, createNodeLocalBackendPorts } from "./localBackendManager";
import { LocalConnectionSupervisor } from "./connectionSupervisor";
import { RegistryStore } from "./registryStore";
import { SshTransportManager, createNodeSshTransportPorts } from "./sshTransport";

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
          setTimeout(() => {
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
          }, 15);
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
      await new Promise((r) => setTimeout(r, 60));
      expect(
        transcriptEvents.some(
          (e) =>
            e.kind === "patch" &&
            (e.payload as { type?: string; delta?: string }).delta === "Remote SSH reply OK",
        ),
      ).toBe(true);
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
      for (let attempt = 0; attempt < 40 && sshGw.connections.length < 2; attempt += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
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
});
