import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { SshTransportManager, createNodeSshTransportPorts } from "./sshTransport";

/**
 * Writes an isolated fake `ssh` + `ssh-keyscan` + `ssh-keygen` binary set inside mkdtemp sandbox.
 * Records every invocation argv/env/stdin in an audit log JSONL file for strict verification.
 */
function writeFakeSshSuite(options: {
  binDir: string;
  auditLogPath: string;
  serveMode: "modern" | "legacy_attach_only" | "windows_session0" | "probe_fail_modern_unavailable";
  hostKeyState: "trusted" | "unknown" | "changed";
  expectedPassphrase?: string;
  remoteWsPort: number;
  failServeAfterMints?: number;
}) {
  const statePath = path.join(options.binDir, "fake-ssh-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ mintCount: 0, attachCount: 0 }), "utf8");

  const sshPath = path.join(options.binDir, "ssh");
  const keyscanPath = path.join(options.binDir, "ssh-keyscan");
  const keygenPath = path.join(options.binDir, "ssh-keygen");

  const sshScript = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const auditEntry = {
  bin: "ssh",
  args,
  hasAskpass: Boolean(process.env.SSH_ASKPASS),
  askpassRequire: process.env.SSH_ASKPASS_REQUIRE || null,
  pid: process.pid,
};

let suppliedPassphrase = null;
if (process.env.SSH_ASKPASS) {
  try {
    suppliedPassphrase = execFileSync(process.env.SSH_ASKPASS, [], { encoding: "utf8" }).replace(/\\r?\\n$/, "");
  } catch (e) {
    suppliedPassphrase = null;
  }
}
fs.appendFileSync(${JSON.stringify(options.auditLogPath)}, JSON.stringify(auditEntry) + "\\n");

// Enforce StrictHostKeyChecking=yes never =no
if (args.includes("StrictHostKeyChecking=no")) {
  process.stderr.write("FATAL: StrictHostKeyChecking=no is forbidden\\n");
  process.exit(255);
}

// Check known_hosts file passed via UserKnownHostsFile=...
const knownHostsArg = args.find((a) => a.startsWith("UserKnownHostsFile="));
const knownHostsPath = knownHostsArg ? knownHostsArg.slice("UserKnownHostsFile=".length) : "";
let knownHostsContent = "";
try {
  knownHostsContent = fs.readFileSync(knownHostsPath, "utf8");
} catch {}

if (${JSON.stringify(options.hostKeyState)} === "changed") {
  process.stderr.write("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\\n");
  process.stderr.write("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\\n");
  process.stderr.write("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\\n");
  process.stderr.write("Host key verification failed.\\n");
  process.exit(255);
}

const destArg = args.find((a) => !a.startsWith("-") && (a.includes("@") || a.includes(".")));
const hostPart = destArg && destArg.includes("@") ? destArg.split("@")[1] : (destArg || "");
const isTrustedInFile = knownHostsContent.includes("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY");
if (${JSON.stringify(options.hostKeyState)} === "unknown" && !isTrustedInFile) {
  process.stderr.write("No ED25519 host key is known for " + hostPart + " and you have requested strict checking.\\n");
  process.stderr.write("Host key verification failed.\\n");
  process.exit(255);
}

const expectedPass = ${JSON.stringify(options.expectedPassphrase ?? null)};
if (expectedPass && suppliedPassphrase !== expectedPass) {
  process.stderr.write("Permission denied (publickey).\\n");
  process.exit(255);
}

// Tunnel mode: ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>
const lIdx = args.indexOf("-L");
if (args.includes("-N") && lIdx >= 0 && args[lIdx + 1]) {
  const parts = args[lIdx + 1].split(":");
  const localPort = Number(parts[1]);
  const remotePort = Number(parts[3]);
  const server = net.createServer((clientSock) => {
    const upstream = net.connect(remotePort, "127.0.0.1");
    clientSock.pipe(upstream);
    upstream.pipe(clientSock);
    clientSock.on("error", () => upstream.destroy());
    upstream.on("error", () => clientSock.destroy());
  });
  server.listen(localPort, "127.0.0.1", () => {
    // Ready
  });
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
  return;
}

const remoteCmd = args[args.length - 1] || "";
const mode = ${JSON.stringify(options.serveMode)};

if (remoteCmd.includes("--start")) {
  process.stderr.write("FATAL: --start is forbidden on SSH attach-only / Windows Session 0\\n");
  process.exit(99);
}

if (remoteCmd.includes("tickets --probe")) {
  if (mode === "legacy_attach_only") {
    process.stderr.write("Error: No such command 'tickets'.\\n");
    process.exit(2);
  }
  if (mode === "probe_fail_modern_unavailable") {
    process.stdout.write(JSON.stringify({ protocol: 99 }));
    process.exit(0);
  }
  const winSession0 = mode === "windows_session0";
  process.stdout.write(JSON.stringify({
    protocol: 1,
    purposes: ["interactive", "native-http"],
    windows_service_session: winSession0,
  }) + "\\n");
  process.exit(0);
}

if (remoteCmd.includes("tickets --serve")) {
  process.stdout.write(JSON.stringify({
    state: "ready",
    remote_port: ${options.remoteWsPort},
  }) + "\\n");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const st = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
    const failAfter = ${JSON.stringify(options.failServeAfterMints ?? null)};
    if (failAfter && !st.failedOnce && st.mintCount >= failAfter) {
      st.failedOnce = true;
      fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(st));
      process.stdout.write(JSON.stringify({ ok: false, error: "ticket_unavailable" }) + "\\n");
      process.exit(1);
      return;
    }
    st.mintCount += 1;
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(st));
    const profileId = req.profile_id || "default";
    const ticket = "tkt_ssh_" + profileId + "_" + st.mintCount;
    process.stdout.write(JSON.stringify({
      state: "ready",
      ticket,
      expires_in_seconds: 30,
      endpoint: {
        profile_id: profileId,
        instance_id: "inst-ssh-1",
        authority_epoch: 1,
        runtime_protocol: 1,
        capabilities: ["session-authority-v1", "host-scope-interactive"],
        code_sha: "sha_ssh_1",
        ws_url: "ws://127.0.0.1:${options.remoteWsPort}/api/ws",
        ws_protocol: "hermes-gateway-v1",
        ticket_protocol_prefix: "hermes-gateway-ticket."
      }
    }) + "\\n");
  });
  return;
}

if (remoteCmd.includes("gateway attach")) {
  const st = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
  st.attachCount += 1;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(st));
  const profileMatch = remoteCmd.match(/--profile\\s+([^\\s]+)/);
  const profileId = profileMatch ? profileMatch[1].replace(/['"]/g, "") : "default";
  process.stdout.write(JSON.stringify({
    state: "ready",
    ticket: "tkt_legacy_" + profileId + "_" + st.attachCount,
    expires_in_seconds: 30,
    endpoint: {
      profile_id: profileId,
      instance_id: "inst-legacy-1",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      ws_url: "ws://127.0.0.1:${options.remoteWsPort}/api/ws",
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  }) + "\\n");
  process.exit(0);
}

process.exit(1);
`;

  const keyscanScript = `#!/usr/bin/env node
const host = process.argv[process.argv.length - 1] || "lab.example.com";
console.log(host + " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY");
`;

  const keygenScript = `#!/usr/bin/env node
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8").trim();
const host = input.split(" ")[0] || "lab.example.com";
console.log("256 SHA256:FakeHostKeyFingerprint1234 " + host + " (ED25519)");
`;

  fs.writeFileSync(sshPath, sshScript, { mode: 0o755 });
  fs.writeFileSync(keyscanPath, keyscanScript, { mode: 0o755 });
  fs.writeFileSync(keygenPath, keygenScript, { mode: 0o755 });

  return { sshPath, keyscanPath, keygenPath };
}

function readAuditEntries(auditLogPath: string): Array<{ bin: string; args: string[]; hasAskpass: boolean }> {
  if (!fs.existsSync(auditLogPath)) return [];
  return fs
    .readFileSync(auditLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { bin: string; args: string[]; hasAskpass: boolean });
}

describe("SshTransportManager (S2 fake SSH binary + known_hosts + askpass)", () => {
  it("runs modern tickets --probe -> tickets --serve + ssh -L, re-mints tickets without restarting serve/tunnel, and restarts on ticket_unavailable", async () => {
    const sandbox = createTestSandbox("hermes-s2-ssh-modern-");
    let passed = false;
    try {
      const binDir = path.join(sandbox.rootDir, "bin");
      const knownHostsPath = path.join(sandbox.rootDir, "known_hosts");
      const auditLogPath = path.join(sandbox.rootDir, "ssh-audit.jsonl");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(knownHostsPath, "lab.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY\n", {
        mode: 0o600,
      });

      const bins = writeFakeSshSuite({
        binDir,
        auditLogPath,
        serveMode: "modern",
        hostKeyState: "trusted",
        remoteWsPort: 19876,
        failServeAfterMints: 2,
      });

      const ports = createNodeSshTransportPorts({
        askpassSandboxDir: sandbox.userDataDir,
        knownHostsPath,
        sshBinaryPath: bins.sshPath,
        sshKeyscanBinaryPath: bins.keyscanPath,
        sshKeygenBinaryPath: bins.keygenPath,
        confirmHostKeyPrompt: async () => false,
      });
      const manager = new SshTransportManager(ports);

      const target = {
        connectionId: "ssh-lab",
        host: "lab.example.com",
        user: "ubuntu",
        port: 2222,
      };

      const testRes = await manager.testConnection(target);
      expect(testRes.ok).toBe(true);
      expect(testRes.sshMode).toBe("tickets_serve");

      // Prepare dial -> runs probe once, starts serve + tunnel, returns forwarded loopback wsUrl + single-use 30s ticket
      const dial1 = await manager.prepareDial(target, "default");
      expect(dial1.ok).toBe(true);
      if (!dial1.ok) return;
      expect(dial1.dial.transportMode).toBe("shared-host-scope");
      expect(dial1.dial.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/ws$/);
      expect(dial1.dial.wsUrl).not.toContain(":19876");
      const tkt1 = dial1.dial.consumeTicket();
      expect(tkt1).toBe("tkt_ssh_default_1");
      expect(dial1.dial.consumeTicket()).toBeNull(); // single-use enforced!

      const entriesAfterDial1 = readAuditEntries(auditLogPath);
      const tunnels1 = entriesAfterDial1.filter((e) => e.args.includes("-N") && e.args.includes("-L"));
      const serves1 = entriesAfterDial1.filter((e) => e.args.at(-1)?.includes("tickets --serve"));
      expect(tunnels1).toHaveLength(1);
      expect(serves1).toHaveLength(1);

      // Reconnect while serve + tunnel are healthy -> re-mints ticket from existing serve (NO new serve or tunnel!)
      const remint = await manager.mintReconnectTicket("ssh-lab", target, "default", dial1.dial.instanceId);
      expect(remint.ok).toBe(true);
      if (!remint.ok) return;
      expect(remint.consumeTicket()).toBe("tkt_ssh_default_2");

      const entriesAfterRemint = readAuditEntries(auditLogPath);
      expect(entriesAfterRemint.filter((e) => e.args.includes("-N") && e.args.includes("-L"))).toHaveLength(1);
      expect(entriesAfterRemint.filter((e) => e.args.at(-1)?.includes("tickets --serve"))).toHaveLength(1);

      // 3rd mint triggers ticket_unavailable / serve exit -> tears down and restarts serve + tunnel (never falls back to attach-only!)
      const remintAfterFail = await manager.mintReconnectTicket("ssh-lab", target, "default", dial1.dial.instanceId);
      expect(remintAfterFail.ok).toBe(true);
      if (!remintAfterFail.ok) return;
      expect(remintAfterFail.consumeTicket()).toBe("tkt_ssh_default_3");

      const entriesAfterRestart = readAuditEntries(auditLogPath);
      expect(entriesAfterRestart.filter((e) => e.args.includes("-N") && e.args.includes("-L"))).toHaveLength(2);
      expect(entriesAfterRestart.filter((e) => e.args.at(-1)?.includes("tickets --serve"))).toHaveLength(2);
      expect(entriesAfterRestart.some((e) => e.args.at(-1)?.includes("gateway attach"))).toBe(false);

      await manager.disposeAll();
      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("enforces unknown host key confirmation (never auto-trust on Test) and hard-blocks changed host keys", async () => {
    const sandbox = createTestSandbox("hermes-s2-ssh-hostkey-");
    let passed = false;
    try {
      const binDir = path.join(sandbox.rootDir, "bin");
      const knownHostsPath = path.join(sandbox.rootDir, "known_hosts");
      const auditLogPath = path.join(sandbox.rootDir, "ssh-audit.jsonl");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(knownHostsPath, "", { mode: 0o600 });

      const bins = writeFakeSshSuite({
        binDir,
        auditLogPath,
        serveMode: "modern",
        hostKeyState: "unknown",
        remoteWsPort: 19877,
      });

      let promptCalls = 0;
      let shouldConfirm = false;
      const ports = createNodeSshTransportPorts({
        askpassSandboxDir: sandbox.userDataDir,
        knownHostsPath,
        sshBinaryPath: bins.sshPath,
        sshKeyscanBinaryPath: bins.keyscanPath,
        sshKeygenBinaryPath: bins.keygenPath,
        confirmHostKeyPrompt: async (challenge) => {
          promptCalls += 1;
          expect(challenge.fingerprint).toBe("SHA256:FakeHostKeyFingerprint1234");
          return shouldConfirm;
        },
      });
      const manager = new SshTransportManager(ports);
      const target = { connectionId: "ssh-hk", host: "lab.example.com", user: "ubuntu" };

      // 1. Test on unknown host key -> blocked, NEVER calls confirmHostKeyPrompt, NEVER modifies known_hosts
      const blockedRes = await manager.testConnection(target);
      expect(blockedRes.ok).toBe(false);
      expect(blockedRes.status).toBe("blocked");
      expect(blockedRes.failureCode).toBe("host_key_unknown");
      expect(blockedRes.hostKeyChallenge?.fingerprint).toBe("SHA256:FakeHostKeyFingerprint1234");
      expect(blockedRes.actions).toContain("confirm_host_key");
      expect(promptCalls).toBe(0);
      expect(fs.readFileSync(knownHostsPath, "utf8")).toBe("");

      // 2. User cancels native confirmation -> known_hosts stays empty
      const cancelRes = await manager.confirmHostKey(target);
      expect(cancelRes.confirmed).toBe(false);
      expect(cancelRes.cancelled).toBe(true);
      expect(promptCalls).toBe(1);
      expect(fs.readFileSync(knownHostsPath, "utf8")).toBe("");

      // 3. User confirms in native prompt -> known_hosts updated, Test now passes!
      shouldConfirm = true;
      const confirmRes = await manager.confirmHostKey(target);
      expect(confirmRes.confirmed).toBe(true);
      expect(fs.readFileSync(knownHostsPath, "utf8")).toContain("AAAAC3NzaC1lZDI1NTE5FAKEKEY");

      const okRes = await manager.testConnection(target);
      expect(okRes.ok).toBe(true);

      // 4. Changed host key -> HARD BLOCK (no confirm_host_key action, confirmHostKey refuses)
      const changedBinsDir = path.join(sandbox.rootDir, "bin-changed");
      fs.mkdirSync(changedBinsDir, { recursive: true });
      const changedBins = writeFakeSshSuite({
        binDir: changedBinsDir,
        auditLogPath,
        serveMode: "modern",
        hostKeyState: "changed",
        remoteWsPort: 19877,
      });
      const changedMgr = new SshTransportManager(
        createNodeSshTransportPorts({
          askpassSandboxDir: sandbox.userDataDir,
          knownHostsPath,
          sshBinaryPath: changedBins.sshPath,
          sshKeyscanBinaryPath: changedBins.keyscanPath,
          sshKeygenBinaryPath: changedBins.keygenPath,
          confirmHostKeyPrompt: async () => true,
        }),
      );
      const changedTest = await changedMgr.testConnection(target);
      expect(changedTest.ok).toBe(false);
      expect(changedTest.status).toBe("blocked");
      expect(changedTest.failureCode).toBe("host_key_changed");
      expect(changedTest.actions).not.toContain("confirm_host_key");

      const bypassAttempt = await changedMgr.confirmHostKey(target);
      expect(bypassAttempt.confirmed).toBe(false);
      expect(bypassAttempt.hardBlocked).toBe(true);

      await manager.disposeAll();
      await changedMgr.disposeAll();
      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("supports legacy attach-only mode (per-Profile socket, never --start), Windows Session 0 attach-only, and memory-only passphrase askpass", async () => {
    const sandbox = createTestSandbox("hermes-s2-ssh-legacy-pass-");
    let passed = false;
    try {
      const binDir = path.join(sandbox.rootDir, "bin");
      const knownHostsPath = path.join(sandbox.rootDir, "known_hosts");
      const auditLogPath = path.join(sandbox.rootDir, "ssh-audit.jsonl");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(knownHostsPath, "lab.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY\n", {
        mode: 0o600,
      });

      const bins = writeFakeSshSuite({
        binDir,
        auditLogPath,
        serveMode: "legacy_attach_only",
        hostKeyState: "trusted",
        expectedPassphrase: "s3cr3t-passphrase-!@#",
        remoteWsPort: 19878,
      });

      const manager = new SshTransportManager(
        createNodeSshTransportPorts({
          askpassSandboxDir: sandbox.userDataDir,
          knownHostsPath,
          sshBinaryPath: bins.sshPath,
          sshKeyscanBinaryPath: bins.keyscanPath,
          sshKeygenBinaryPath: bins.keygenPath,
          confirmHostKeyPrompt: async () => false,
        }),
      );

      const target = {
        connectionId: "ssh-legacy",
        host: "lab.example.com",
        user: "ubuntu",
        keyPath: "/tmp/fake-key",
      };

      // Without passphrase -> ssh_auth_failed
      const noPassTest = await manager.testConnection(target);
      expect(noPassTest.ok).toBe(false);
      expect(noPassTest.failureCode).toBe("ssh_auth_failed");

      // With session passphrase -> legacy attach-only detected, NEVER --start, temp askpass files cleaned up
      const withPassTest = await manager.testConnection(target, {
        passphrase: "s3cr3t-passphrase-!@#",
      });
      expect(withPassTest.ok).toBe(true);
      expect(withPassTest.sshMode).toBe("attach_only");
      expect(withPassTest.legacyNotice).toBe(true);

      // Verify ephemeral askpass dir was cleaned up right after testConnection
      const leftoverAskpass = fs
        .readdirSync(sandbox.userDataDir)
        .filter((name) => name.startsWith("askpass-"));
      expect(leftoverAskpass).toEqual([]);

      // Set session passphrase in Main memory for activation
      manager.setSessionPassphrase("ssh-legacy", "s3cr3t-passphrase-!@#");
      const dialDefault = await manager.prepareDial(target, "default");
      const dialOps = await manager.prepareDial(target, "ops");
      expect(dialDefault.ok).toBe(true);
      expect(dialOps.ok).toBe(true);
      if (dialDefault.ok && dialOps.ok) {
        expect(dialDefault.dial.transportMode).toBe("per-profile");
        expect(dialOps.dial.transportMode).toBe("per-profile");
        expect(dialDefault.dial.consumeTicket()).toContain("tkt_legacy_default");
        expect(dialOps.dial.consumeTicket()).toContain("tkt_legacy_ops");
      }

      const entries = readAuditEntries(auditLogPath);
      expect(entries.some((e) => e.args.at(-1)?.includes("--start"))).toBe(false);
      expect(entries.some((e) => e.args.join(" ").includes("s3cr3t-passphrase"))).toBe(false);
      const attachCommands = entries
        .map((e) => e.args.at(-1) ?? "")
        .filter((command) => command.includes("gateway attach"));
      expect(attachCommands.some((command) => command.includes("--profile ops"))).toBe(true);

      await manager.disposeAll();
      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("reports Windows Session 0 attach-only without --start and guards legacy_attach fallback vs confirmed modern", async () => {
    const sandbox = createTestSandbox("hermes-s2-ssh-win0-legacy-");
    let passed = false;
    try {
      const binDir = path.join(sandbox.rootDir, "bin");
      const knownHostsPath = path.join(sandbox.rootDir, "known_hosts");
      const auditLogPath = path.join(sandbox.rootDir, "ssh-audit.jsonl");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(knownHostsPath, "lab.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEKEY\n", {
        mode: 0o600,
      });

      const win0Bins = writeFakeSshSuite({
        binDir,
        auditLogPath,
        serveMode: "windows_session0",
        hostKeyState: "trusted",
        remoteWsPort: 19879,
      });

      const win0Mgr = new SshTransportManager(
        createNodeSshTransportPorts({
          askpassSandboxDir: sandbox.userDataDir,
          knownHostsPath,
          sshBinaryPath: win0Bins.sshPath,
          sshKeyscanBinaryPath: win0Bins.keyscanPath,
          sshKeygenBinaryPath: win0Bins.keygenPath,
          confirmHostKeyPrompt: async () => false,
        }),
      );
      const target = { connectionId: "ssh-win0", host: "lab.example.com", user: "ops" };

      const win0Test = await win0Mgr.testConnection(target);
      expect(win0Test.ok).toBe(true);
      expect(win0Test.windowsServiceSession).toBe(true);

      const win0Dial = await win0Mgr.prepareDial(target, "default");
      expect(win0Dial.ok).toBe(true);
      if (win0Dial.ok) {
        expect(win0Dial.windowsServiceSession).toBe(true);
      }

      // Probe fail modern unavailable offers legacy_attach action, and opting in remembers attach_only cleanly
      const protoDir = path.join(sandbox.rootDir, "bin-proto");
      fs.mkdirSync(protoDir, { recursive: true });
      const protoBins = writeFakeSshSuite({
        binDir: protoDir,
        auditLogPath,
        serveMode: "probe_fail_modern_unavailable",
        hostKeyState: "trusted",
        remoteWsPort: 19880,
      });
      const protoMgr = new SshTransportManager(
        createNodeSshTransportPorts({
          askpassSandboxDir: sandbox.userDataDir,
          knownHostsPath,
          sshBinaryPath: protoBins.sshPath,
          sshKeyscanBinaryPath: protoBins.keyscanPath,
          sshKeygenBinaryPath: protoBins.keygenPath,
          confirmHostKeyPrompt: async () => false,
        }),
      );

      const failRes = await protoMgr.testConnection(target);
      expect(failRes.ok).toBe(false);
      expect(failRes.failureCode).toBe("protocol_unsupported");
      expect(failRes.actions).toContain("legacy_attach");

      const optedRes = await protoMgr.testConnection({ ...target, preferLegacyAttach: true });
      expect(optedRes.ok).toBe(true);
      expect(optedRes.sshMode).toBe("attach_only");

      // prepareDial remembers legacy opt-in from successful test without needing persisted preferLegacyAttach
      const optedDial = await protoMgr.prepareDial(target, "default");
      expect(optedDial.ok).toBe(true);
      if (optedDial.ok) {
        expect(optedDial.sshMode).toBe("attach_only");
        expect(optedDial.dial.transportMode).toBe("per-profile");
      }

      // Pending passphrase by target signature promotes cleanly on save without leaking
      protoMgr.setPendingTargetPassphrase(target, "pending-secret-123");
      protoMgr.promotePendingTargetPassphrase(target, "ssh-win0");
      expect(protoMgr.hasSessionPassphrase("ssh-win0")).toBe(true);
      expect(JSON.stringify(optedRes)).not.toContain("pending-secret-123");

      const entries = readAuditEntries(auditLogPath);
      expect(entries.some((e) => e.args.at(-1)?.includes("--start"))).toBe(false);

      await win0Mgr.disposeAll();
      await protoMgr.disposeAll();
      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });
});
