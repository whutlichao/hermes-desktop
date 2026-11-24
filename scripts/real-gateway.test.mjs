import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startFakeGatewayServer } from "../tests/helpers/fakeGatewayServer";
import { createTestSandbox } from "../tests/helpers/sandbox";
import {
  formatSummaryMarkdown,
  parseRealGatewayArgs,
  runRealGateway,
  sanitizeRealGatewayReport,
} from "./real-gateway-core.mjs";

describe("real-gateway harness", () => {
  it("validates isolated vs real-home CLI flags strictly", () => {
    expect(parseRealGatewayArgs([])).toMatchObject({
      ok: true,
      options: {
        mode: "isolated",
        withTurn: false,
        ciAllowSkip: false,
        profileId: "default",
        timeoutSeconds: 60,
      },
    });

    const onlyAllowReal = parseRealGatewayArgs(["--allow-real-home"]);
    expect(onlyAllowReal.ok).toBe(false);
    expect(onlyAllowReal.typedCode).toBe("invalid_arguments");

    const onlyHermesHome = parseRealGatewayArgs(["--hermes-home", "/tmp/some-home"]);
    expect(onlyHermesHome.ok).toBe(false);
    expect(onlyHermesHome.typedCode).toBe("invalid_arguments");

    const realWithTurn = parseRealGatewayArgs([
      "--hermes-home",
      "/tmp/some-home",
      "--allow-real-home",
      "--with-turn",
    ]);
    expect(realWithTurn.ok).toBe(false);
    expect(realWithTurn.typedCode).toBe("invalid_arguments");

    const validReal = parseRealGatewayArgs([
      "--",
      "--hermes-home",
      "/tmp/some-home",
      "--allow-real-home",
      "--report-dir",
      "/tmp/reports",
    ]);
    expect(validReal).toMatchObject({
      ok: true,
      options: {
        mode: "real-home",
        hermesHome: "/tmp/some-home",
        allowRealHome: true,
        withTurn: false,
        reportDir: "/tmp/reports",
      },
    });
  });

  it("redacts secrets, URLs, stderr, username, home dir, and absolute paths in report.json and summary.md", () => {
    const rawReport = {
      status: "failed",
      generatedAt: "2026-11-23T06:50:00.000Z",
      appVersion: "0.1.0",
      gitSha: "abc12345",
      gitDirty: false,
      buildMode: "dev",
      electronVersion: "45.4.1",
      chromiumVersion: "136.0.0.0",
      nodeVersion: "26.13.1",
      macOSVersion: "15.4",
      arch: "arm64",
      cliCapabilitiesSummary: {
        status: "ready",
        sourceKind: "override",
        version: "v0.23.3",
        supportsEnsureJson: true,
        supportsAttachJson: true,
        supportsTicketsProbe: true,
        supportsStopYes: true,
      },
      stages: [
        { name: "preflight", status: "ok", durationMs: 12 },
        { name: "ws_handshake", status: "failed", durationMs: 45, code: "ws_handshake_failed" },
      ],
      typedCode: "ws_handshake_failed",
      wsCloseCode: 1008,
      exitCode: 1,
      hermesHomeKind: "temp",
      token: "tok_leaked_value",
      ticket: "tkt_leaked_value",
      wsUrl: "wss://alice:superpass@gw.example.com/api/ws?ticket=tkt_999#frag",
      sanitizedLogs: [
        "stderr: failed connecting to https://alice:pw@gw.example.com/ws?token=tok_abc#sec",
        "Cookie: session=cookie_val_123; passphrase=my-ssh-pass",
        "key=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyData alice@host",
        "home=/Users/alice path=/Users/alice/.hermes/gateway.sock user=alice",
      ],
    };

    const sanitized = sanitizeRealGatewayReport(rawReport, {
      homeDir: "/Users/alice",
      username: "alice",
      extraPaths: ["/Users/alice/.hermes", "/var/folders/xx/hermes-temp"],
    });
    const summaryMd = formatSummaryMarkdown(sanitized);

    for (const serialized of [JSON.stringify(sanitized), summaryMd]) {
      expect(serialized).not.toContain("tok_leaked_value");
      expect(serialized).not.toContain("tkt_leaked_value");
      expect(serialized).not.toContain("superpass");
      expect(serialized).not.toContain("tkt_999");
      expect(serialized).not.toContain("tok_abc");
      expect(serialized).not.toContain("#frag");
      expect(serialized).not.toContain("#sec");
      expect(serialized).not.toContain("cookie_val_123");
      expect(serialized).not.toContain("my-ssh-pass");
      expect(serialized).not.toContain("AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyData");
      expect(serialized).not.toContain("/Users/alice");
      expect(serialized).not.toContain("alice");
      expect(serialized).not.toContain("stderr:");
    }

    expect(sanitized.appVersion).toBe("0.1.0");
    expect(sanitized.gitSha).toBe("abc12345");
    expect(sanitized.buildMode).toBe("dev");
    expect(sanitized.electronVersion).toBe("45.4.1");
    expect(sanitized.chromiumVersion).toBe("136.0.0.0");
    expect(sanitized.nodeVersion).toBe("26.13.1");
    expect(sanitized.macOSVersion).toBe("15.4");
    expect(sanitized.arch).toBe("arm64");
    expect(sanitized.typedCode).toBe("ws_handshake_failed");
    expect(sanitized.wsCloseCode).toBe(1008);
    expect(sanitized.exitCode).toBe(1);
    expect(sanitized.hermesHomeKind).toBe("temp");
    expect(sanitized.stages).toHaveLength(2);
    expect(summaryMd).toContain("ws_handshake_failed");
  });

  it("emits typed preflight failures and explicit skipped status when CLI is missing with --ci-allow-skip", async () => {
    const sandbox = createTestSandbox("hermes-rg-preflight-");
    let passed = false;
    try {
      const reportDir1 = path.join(sandbox.rootDir, "rep-missing");
      const missingRes = await runRealGateway(["--report-dir", reportDir1], {
        env: { PATH: "" },
        commonDirs: [path.join(sandbox.rootDir, "empty-bin")],
        shellPath: "/bin/sh",
        runShellPathProbe: false,
      });
      expect(missingRes.exitCode).toBe(1);
      expect(missingRes.report.status).toBe("failed");
      expect(missingRes.report.typedCode).toBe("hermes_not_found");
      expect(fs.existsSync(path.join(reportDir1, "report.json"))).toBe(true);
      expect(fs.existsSync(path.join(reportDir1, "summary.md"))).toBe(true);

      const reportDir2 = path.join(sandbox.rootDir, "rep-skip");
      const skippedRes = await runRealGateway(["--ci-allow-skip", "--report-dir", reportDir2], {
        env: { PATH: "" },
        commonDirs: [path.join(sandbox.rootDir, "empty-bin")],
        runShellPathProbe: false,
      });
      expect(skippedRes.exitCode).toBe(0);
      expect(skippedRes.report.status).toBe("skipped");
      expect(skippedRes.report.typedCode).toBe("hermes_not_found");
      const skippedMd = fs.readFileSync(path.join(reportDir2, "summary.md"), "utf8");
      expect(skippedMd).toContain("SKIPPED");
      expect(skippedMd).not.toContain("PASSED");

      // Non-executable CLI
      const nonExecCli = path.join(sandbox.rootDir, "hermes-nonexec");
      fs.writeFileSync(nonExecCli, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const reportDir3 = path.join(sandbox.rootDir, "rep-nonexec");
      const nonExecRes = await runRealGateway(["--cli", nonExecCli, "--report-dir", reportDir3]);
      expect(nonExecRes.exitCode).toBe(1);
      expect(nonExecRes.report.status).toBe("failed");
      expect(nonExecRes.report.typedCode).toBe("cli_not_executable");

      // CLI missing stop capability MUST fail preflight BEFORE calling ensure
      const ensureMarker = path.join(sandbox.rootDir, "ensure-called.txt");
      const noStopCli = path.join(sandbox.rootDir, "hermes-nostop");
      fs.writeFileSync(
        noStopCli,
        `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{run,ensure,attach,tickets}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure" && args[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach" && args[2] === "--help") { console.log("--json"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") { console.log(JSON.stringify({ protocol: 1, capabilities: ["session-authority-v1"] })); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure") { fs.writeFileSync(${JSON.stringify(ensureMarker)}, "called"); process.exit(0); }
process.exit(1);
`,
        { mode: 0o755 },
      );
      const noStopRes = await runRealGateway(["--cli", noStopCli, "--report-dir", path.join(sandbox.rootDir, "rep-nostop")]);
      expect(noStopRes.exitCode).toBe(1);
      expect(noStopRes.report.status).toBe("failed");
      expect(noStopRes.report.typedCode).toBe("cli_missing_stop_capability");
      expect(fs.existsSync(ensureMarker)).toBe(false);

      // Incompatible protocol in tickets --probe
      const badProtoCli = path.join(sandbox.rootDir, "hermes-badproto");
      fs.writeFileSync(
        badProtoCli,
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{ensure,attach,tickets,stop}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure" && args[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "stop" && args[2] === "--help") { console.log("--yes"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") { console.log(JSON.stringify({ protocol: 2, capabilities: ["session-authority-v1"] })); process.exit(0); }
process.exit(1);
`,
        { mode: 0o755 },
      );
      const badProtoRes = await runRealGateway(["--cli", badProtoCli, "--report-dir", path.join(sandbox.rootDir, "rep-badproto")]);
      expect(badProtoRes.exitCode).toBe(1);
      expect(badProtoRes.report.typedCode).toBe("protocol_unsupported");

      // Login shell -ilc discovery with noisy banner
      const ilcDir = path.join(sandbox.rootDir, "ilc-bin");
      fs.mkdirSync(ilcDir, { recursive: true });
      const ilcCli = path.join(ilcDir, "hermes");
      fs.writeFileSync(
        ilcCli,
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Hermes Agent v0.24.0"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{run,status}"); process.exit(0); }
process.exit(0);
`,
        { mode: 0o755 },
      );
      const fakeShell = path.join(sandbox.rootDir, "fake-shell.sh");
      fs.writeFileSync(
        fakeShell,
        `#!/bin/sh
echo "Welcome to zsh MOTD"
printf "__HERMES_PATH_BEGIN__%s__HERMES_PATH_END__\\n" ${JSON.stringify(ilcDir)}
`,
        { mode: 0o755 },
      );
      const shellRes = await runRealGateway(["--report-dir", path.join(sandbox.rootDir, "rep-shell")], {
        shellPath: fakeShell,
        env: { PATH: "" },
        commonDirs: [],
      });
      expect(shellRes.exitCode).toBe(1);
      expect(shellRes.report.typedCode).toBe("cli_unsupported");
      expect(shellRes.report.cliCapabilitiesSummary.sourceKind).toBe("login_shell_ilc");
      expect(shellRes.report.cliCapabilitiesSummary.version).toBe("v0.24.0");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("runs isolated ensure + read-only WS smoke + verified stop cleanup + KEEP_TEST_SANDBOX=1 + optional --with-turn", async () => {
    const sandbox = createTestSandbox("hermes-rg-isolated-");
    let passed = false;
    const wsConnectionsFile = path.join(sandbox.rootDir, "ws-conns.jsonl");
    const wsRpcFile = path.join(sandbox.rootDir, "ws-rpcs.jsonl");
    const detachedGwScript = path.join(sandbox.rootDir, "detached-gw.cjs");

    fs.writeFileSync(
      detachedGwScript,
      `const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const home = process.argv[2];
const connsFile = process.argv[3];
const rpcsFile = process.argv[4];
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const validTickets = new Set(["tkt_iso_1", "tkt_iso_2", "tkt_iso_3"]);
const encodeFrame = (opcode, buf) => {
  const len = buf.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x80 | opcode, len]), buf]);
  const hdr = Buffer.alloc(4);
  hdr[0] = 0x80 | opcode;
  hdr[1] = 126;
  hdr.writeUInt16BE(len, 2);
  return Buffer.concat([hdr, buf]);
};
const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
server.on("upgrade", (req, socket) => {
  const rawProto = String(req.headers["sec-websocket-protocol"] || "");
  const protos = rawProto.split(",").map((s) => s.trim()).filter(Boolean);
  const ticketProto = protos.find((p) => p.startsWith("hermes-gateway-ticket."));
  const ticket = ticketProto ? ticketProto.slice("hermes-gateway-ticket.".length) : null;
  fs.appendFileSync(connsFile, JSON.stringify({ origin: req.headers.origin ?? null, protos }) + "\\n");
  if (!protos.includes("hermes-gateway-v1") || !ticket || !validTickets.has(ticket)) {
    socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");
    socket.destroy();
    return;
  }
  validTickets.delete(ticket);
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\nSec-WebSocket-Protocol: hermes-gateway-v1\\r\\n\\r\\n");
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      const mlen = masked ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      let payload = buf.subarray(off + mlen, off + mlen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      buf = buf.subarray(off + mlen + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { socket.write(encodeFrame(0xA, payload)); continue; }
      if (opcode === 0x1) {
        const msg = JSON.parse(payload.toString("utf8"));
        fs.appendFileSync(rpcsFile, JSON.stringify({ method: msg.method }) + "\\n");
        let result = {};
        if (msg.method === "runtime.describe") result = { runtime_protocol: 1, capabilities: ["session-authority-v1"] };
        else if (msg.method === "client.capabilities" || msg.method === "capabilities.describe") result = { capabilities: ["session-authority-v1"] };
        else if (msg.method === "profiles.list") result = { profiles: [{ profile_id: "default", display_name: "Default", is_default: true }] };
        else if (msg.method === "sessions.list") result = { sessions: [{ profile_id: "default", session_id: "s-1", title: "Existing" }] };
        else if (msg.method === "session.create") result = { session: { session_id: "s-new" } };
        else if (msg.method === "prompt.submit") result = { accepted: true, session_id: "s-new", turn_id: "t-1" };
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))));
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(home, "gateway.ws"), "ws://127.0.0.1:" + port + "/api/ws");
});
process.on("SIGTERM", () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 200).unref(); });
`,
      "utf8",
    );

    const cliInvocationsFile = path.join(sandbox.rootDir, "cli-log.jsonl");
    const cliPath = path.join(sandbox.rootDir, "hermes");
    fs.writeFileSync(
      cliPath,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(cliInvocationsFile)}, JSON.stringify({
  args,
  hermesHome: process.env.HERMES_HOME || null,
  e2e: process.env.HERMES_DESKTOP_E2E || null,
}) + "\\n");

if (args[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{run,ensure,attach,tickets,stop}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure" && args[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach" && args[2] === "--help") { console.log("--json --recover"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "stop" && args[2] === "--help") { console.log("--yes"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") {
  console.log(JSON.stringify({ protocol: 1, capabilities: ["session-authority-v1"] }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "ensure") {
  const home = process.env.HERMES_HOME;
  const pidFile = path.join(home, "gateway.pid");
  const wsFile = path.join(home, "gateway.ws");
  const child = spawn(process.execPath, [${JSON.stringify(detachedGwScript)}, home, ${JSON.stringify(wsConnectionsFile)}, ${JSON.stringify(wsRpcFile)}], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  const start = Date.now();
  while (!fs.existsSync(wsFile) && Date.now() - start < 3000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const wsUrl = fs.readFileSync(wsFile, "utf8").trim();
  console.log(JSON.stringify({
    state: "ready",
    pid: child.pid,
    endpoint: {
      profile_id: "default",
      instance_id: "inst-iso",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      ws_url: wsUrl,
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "attach") {
  const home = process.env.HERMES_HOME;
  const wsUrl = fs.readFileSync(path.join(home, "gateway.ws"), "utf8").trim();
  const countFile = path.join(home, "attach-count");
  let n = 0;
  try { n = Number(fs.readFileSync(countFile, "utf8")) || 0; } catch {}
  n += 1;
  fs.writeFileSync(countFile, String(n));
  console.log(JSON.stringify({
    state: "ready",
    ticket: "tkt_iso_" + n,
    expires_in_seconds: 30,
    endpoint: {
      profile_id: "default",
      instance_id: "inst-iso",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      ws_url: wsUrl
    }
  }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "stop") {
  if (!args.includes("--yes")) process.exit(2);
  const pidFile = path.join(process.env.HERMES_HOME, "gateway.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    try { process.kill(pid, "SIGKILL"); } catch {}
    fs.rmSync(pidFile, { force: true });
  }
  console.log(JSON.stringify({ stopped: true }));
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 },
    );

    const leakedPids = [];
    try {
      // 1. Default isolated run (read-only, removes sandbox on pass when KEEP_TEST_SANDBOX unset)
      const reportDir1 = path.join(sandbox.rootDir, "rep-iso-1");
      const res1 = await runRealGateway(["--cli", cliPath, "--report-dir", reportDir1], {
        env: { ...process.env, KEEP_TEST_SANDBOX: "0" },
      });
      expect(res1.exitCode).toBe(0);
      expect(res1.report.status).toBe("passed");
      expect(res1.report.hermesHomeKind).toBe("temp");
      expect(res1.report.wsCloseCode).toBe(1000);
      expect(res1.report.typedCode).toBeNull();
      expect(fs.existsSync(res1.sandboxRoot)).toBe(false);

      // Verify Origin header was omitted and no prompt/session mutation occurred
      const conns1 = fs.readFileSync(wsConnectionsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(conns1.length).toBeGreaterThanOrEqual(1);
      expect(conns1[0].origin).toBeNull();
      const methodsCalled1 = fs.readFileSync(wsRpcFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).method);
      expect(methodsCalled1).toContain("runtime.describe");
      expect(methodsCalled1).toContain("client.capabilities");
      expect(methodsCalled1).toContain("capabilities.describe");
      expect(methodsCalled1).toContain("profiles.list");
      expect(methodsCalled1).toContain("sessions.list");
      expect(methodsCalled1).not.toContain("session.create");
      expect(methodsCalled1).not.toContain("prompt.submit");

      const cliLog1 = fs
        .readFileSync(cliInvocationsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const ensureCall = cliLog1.find(
        (entry) => entry.args.includes("ensure") && !entry.args.includes("--help"),
      );
      expect(ensureCall.args).toEqual(["gateway", "ensure", "--json", "--timeout", "60"]);
      expect(ensureCall.e2e).toBe("1");
      expect(ensureCall.hermesHome).toBe(path.join(res1.sandboxRoot, "hermes-home"));
      const stopCall = cliLog1.find(
        (entry) => entry.args.includes("stop") && !entry.args.includes("--help"),
      );
      expect(stopCall.args).toEqual(["gateway", "stop", "--yes"]);
      expect(stopCall.hermesHome).toBe(ensureCall.hermesHome);

      // Report must NOT leak ticket, wsUrl, or raw paths
      const reportRaw = fs.readFileSync(path.join(reportDir1, "report.json"), "utf8");
      const summaryRaw = fs.readFileSync(path.join(reportDir1, "summary.md"), "utf8");
      for (const content of [reportRaw, summaryRaw]) {
        expect(content).not.toContain("tkt_iso_");
        expect(content).not.toContain("ws://127.0.0.1");
        expect(content).not.toContain(sandbox.rootDir);
      }

      // 2. KEEP_TEST_SANDBOX=1 preserves sandbox on pass AND --with-turn sends sandbox turn
      const reportDir2 = path.join(sandbox.rootDir, "rep-iso-turn");
      const res2 = await runRealGateway(
        ["--cli", cliPath, "--with-turn", "--report-dir", reportDir2],
        { env: { ...process.env, KEEP_TEST_SANDBOX: "1" } },
      );
      expect(res2.exitCode).toBe(0);
      expect(res2.report.status).toBe("passed");
      expect(fs.existsSync(res2.sandboxRoot)).toBe(true);
      fs.rmSync(res2.sandboxRoot, { recursive: true, force: true });
      const methodsCalled2 = fs.readFileSync(wsRpcFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).method);
      expect(methodsCalled2).toContain("session.create");
      expect(methodsCalled2).toContain("prompt.submit");

      // 3. Legacy fallback `attach --recover --json` when `ensure` is not supported
      const legacyCli = path.join(sandbox.rootDir, "hermes-legacy");
      const legacyCallsFile = path.join(sandbox.rootDir, "legacy-calls.jsonl");
      fs.writeFileSync(
        legacyCli,
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(legacyCallsFile)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "--version") { console.log("Hermes Agent v0.22.0"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{attach,tickets,stop}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach" && args[2] === "--help") { console.log("--json --recover"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "stop" && args[2] === "--help") { console.log("--yes"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") { console.log('{"runtime_protocol":1,"capabilities":["session-authority-v1"]}'); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach") {
  const home = process.env.HERMES_HOME;
  const pidFile = path.join(home, "gateway.pid");
  const wsFile = path.join(home, "gateway.ws");
  if (!fs.existsSync(pidFile)) {
    const child = spawn(process.execPath, [${JSON.stringify(detachedGwScript)}, home, ${JSON.stringify(wsConnectionsFile)}, ${JSON.stringify(wsRpcFile)}], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    const start = Date.now();
    while (!fs.existsSync(wsFile) && Date.now() - start < 3000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const wsUrl = fs.readFileSync(wsFile, "utf8").trim();
  console.log(JSON.stringify({
    state: "ready",
    pid: Number(fs.readFileSync(pidFile, "utf8").trim()),
    ticket: "tkt_iso_3",
    endpoint: {
      profile_id: "default",
      instance_id: "inst-legacy",
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      ws_url: wsUrl
    }
  }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "stop") {
  const pidFile = path.join(process.env.HERMES_HOME, "gateway.pid");
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), "SIGKILL"); } catch {}
    fs.rmSync(pidFile, { force: true });
  }
  console.log(JSON.stringify({ stopped: true }));
  process.exit(0);
}
process.exit(1);
`,
        { mode: 0o755 },
      );
      const legacyRes = await runRealGateway(
        ["--cli", legacyCli, "--report-dir", path.join(sandbox.rootDir, "rep-legacy")],
        { env: { ...process.env, KEEP_TEST_SANDBOX: "0" } },
      );
      expect(legacyRes.exitCode).toBe(0);
      expect(legacyRes.report.status).toBe("passed");
      const legacyCalls = fs.readFileSync(legacyCallsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).args);
      expect(legacyCalls).toContainEqual(["gateway", "attach", "--recover", "--json"]);

      // 4. Cleanup failure when owner PID leaks after stop --yes
      const gwLeak = await startFakeGatewayServer({
        validTickets: new Set(["tkt_leak_1"]),
        profiles: [{ profile_id: "default", display_name: "Default", is_default: true }],
        initialSessions: [],
      });
      const leakyCli = path.join(sandbox.rootDir, "hermes-leaky");
      const leakyPidFile = path.join(sandbox.rootDir, "leaked.pid");
      fs.writeFileSync(
        leakyCli,
        `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{ensure,attach,tickets,stop}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure" && args[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach" && args[2] === "--help") { console.log("--json"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "stop" && args[2] === "--help") { console.log("--yes"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") { console.log('{"protocol":1,"capabilities":["session-authority-v1"]}'); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(${JSON.stringify(leakyPidFile)}, String(child.pid));
  console.log(JSON.stringify({
    state: "ready",
    pid: child.pid,
    ticket: "tkt_leak_1",
    endpoint: {
      profile_id: "default",
      instance_id: "inst-leak",
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      ws_url: ${JSON.stringify(gwLeak.wsUrl)}
    }
  }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "stop") {
  // Intentionally fail to stop the PID!
  console.log(JSON.stringify({ stopped: false }));
  process.exit(0);
}
process.exit(1);
`,
        { mode: 0o755 },
      );
      const resLeak = await runRealGateway(
        ["--cli", leakyCli, "--report-dir", path.join(sandbox.rootDir, "rep-leak")],
        { env: { ...process.env, KEEP_TEST_SANDBOX: "0" } },
      );
      await gwLeak.close();
      if (fs.existsSync(leakyPidFile)) {
        leakedPids.push(Number(fs.readFileSync(leakyPidFile, "utf8").trim()));
      }
      expect(resLeak.exitCode).toBe(1);
      expect(resLeak.report.status).toBe("failed");
      expect(resLeak.report.typedCode).toBe("cleanup_failed");
      // Failure automatically preserves sandbox!
      expect(fs.existsSync(resLeak.sandboxRoot)).toBe(true);
      fs.rmSync(resLeak.sandboxRoot, { recursive: true, force: true });

      // 5. Real CLI v0.23.3 format: multi-line stdout before JSON, api_origin in ensure, top-level url in attach, JSON gateway.pid, -32601 sessions.list -> session.list
      const v23Cli = path.join(sandbox.rootDir, "hermes-v23");
      const v23CallsFile = path.join(sandbox.rootDir, "v23-calls.jsonl");
      const v23GwScript = path.join(sandbox.rootDir, "v23-gw.cjs");
      fs.writeFileSync(
        v23GwScript,
        `const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const home = process.argv[2];
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encodeFrame = (opcode, buf) => Buffer.concat([Buffer.from([0x80 | opcode, buf.length]), buf]);
const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\nSec-WebSocket-Protocol: hermes-gateway-v1\\r\\n\\r\\n");
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      const mlen = masked ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      let payload = buf.subarray(off + mlen, off + mlen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      buf = buf.subarray(off + mlen + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { socket.write(encodeFrame(0xA, payload)); continue; }
      if (opcode === 0x1) {
        const msg = JSON.parse(payload.toString("utf8"));
        if (msg.method === "sessions.list") {
          socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } }))));
        } else if (msg.method === "session.list" && msg.params && "profile_id" in msg.params) {
          socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: 4001, message: "invalid_params" } }))));
        } else {
          socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true, sessions: [], profiles: [] } }))));
        }
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(home, "gateway.origin"), "http://127.0.0.1:" + server.address().port);
});
`,
        "utf8",
      );
      fs.writeFileSync(
        v23Cli,
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(v23CallsFile)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{ensure,attach,tickets,stop}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure" && args[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach" && args[2] === "--help") { console.log("--json --recover"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "stop" && args[2] === "--help") { console.log("--yes"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") { console.log('{"protocol":1,"purposes":["interactive"]}'); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure") {
  const home = process.env.HERMES_HOME;
  const child = spawn(process.execPath, [${JSON.stringify(v23GwScript)}, home], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid: child.pid }));
  const start = Date.now();
  while (!fs.existsSync(path.join(home, "gateway.origin")) && Date.now() - start < 3000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const origin = fs.readFileSync(path.join(home, "gateway.origin"), "utf8").trim();
  console.log("Preparing the isolated Hermes runtime...");
  console.log("  Installing Python dependencies...");
  console.log(JSON.stringify({
    state: "ready",
    endpoint: {
      api_origin: origin,
      profile_id: home,
      instance_id: "inst-v23",
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"]
    }
  }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "attach") {
  const home = process.env.HERMES_HOME;
  const origin = fs.readFileSync(path.join(home, "gateway.origin"), "utf8").trim();
  console.log(JSON.stringify({
    state: "ready",
    ticket: "tkt_v23_1",
    url: origin.replace("http://", "ws://") + "/api/ws",
    endpoint: {
      api_origin: origin,
      profile_id: home,
      instance_id: "inst-v23",
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"]
    }
  }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "stop") {
  const pidObj = JSON.parse(fs.readFileSync(path.join(process.env.HERMES_HOME, "gateway.pid"), "utf8"));
  try { process.kill(pidObj.pid, "SIGKILL"); } catch {}
  fs.rmSync(path.join(process.env.HERMES_HOME, "gateway.pid"), { force: true });
  console.log("Stopped gateway for this profile");
  process.exit(0);
}
process.exit(1);
`,
        { mode: 0o755 },
      );
      const v23Res = await runRealGateway(
        ["--cli", v23Cli, "--report-dir", path.join(sandbox.rootDir, "rep-v23")],
        { env: { ...process.env, KEEP_TEST_SANDBOX: "0" } },
      );
      expect(v23Res.exitCode).toBe(0);
      expect(v23Res.report.status).toBe("passed");
      const v23Calls = fs.readFileSync(v23CallsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).args);
      expect(v23Calls).toContainEqual(["gateway", "attach", "--json"]);
      expect(v23Calls.some((a) => a.includes("--profile"))).toBe(false);

      passed = true;
    } finally {
      for (const pid of leakedPids) {
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      sandbox.cleanup(passed);
    }
  }, 25_000);

  it("enforces strict attach-only behavior in real-home mode (no ensure/recover/stop/writes, fails clearly when stopped)", async () => {
    const sandbox = createTestSandbox("hermes-rg-realhome-");
    let passed = false;
    const validTickets = new Set(["tkt_real_1"]);
    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [{ profile_id: "default", display_name: "Default", is_default: true }],
      initialSessions: [{ profile_id: "default", session_id: "s-real", title: "Real Session" }],
    });

    const realHomeSim = path.join(sandbox.rootDir, "simulated-real-home");
    fs.mkdirSync(realHomeSim, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(realHomeSim, "config.yaml"), "model: test\n");
    const stateFile = path.join(sandbox.rootDir, "gw-running.flag");
    const callsLog = path.join(sandbox.rootDir, "real-cli-calls.jsonl");
    const cliPath = path.join(sandbox.rootDir, "hermes");

    fs.writeFileSync(
      cliPath,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({ args, hermesHome: process.env.HERMES_HOME }) + "\\n");

if (args[0] === "--version") { console.log("Hermes Agent v0.23.3"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "--help") { console.log("{ensure,attach,tickets,stop}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "ensure" && args[2] === "--help") { console.log("--json --timeout"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach" && args[2] === "--help") { console.log("--json --recover"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "stop" && args[2] === "--help") { console.log("--yes"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "tickets") { console.log('{"protocol":1,"capabilities":["session-authority-v1"]}'); process.exit(0); }
if (args[0] === "gateway" && args[1] === "attach") {
  if (!fs.existsSync(${JSON.stringify(stateFile)})) {
    console.log(JSON.stringify({ state: "stopped", reason_code: "not_running" }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    state: "ready",
    ticket: "tkt_real_1",
    expires_in_seconds: 30,
    endpoint: {
      profile_id: "default",
      instance_id: "inst-real",
      runtime_protocol: 1,
      capabilities: ["session-authority-v1"],
      ws_url: ${JSON.stringify(gw.wsUrl)}
    }
  }));
  process.exit(0);
}
process.exit(99);
`,
      { mode: 0o755 },
    );

    try {
      // 0. --with-turn is refused in real-home mode before invoking CLI
      const rejectedTurnRes = await runRealGateway([
        "--hermes-home",
        realHomeSim,
        "--allow-real-home",
        "--with-turn",
        "--cli",
        cliPath,
        "--report-dir",
        path.join(sandbox.rootDir, "rep-real-turn-rejected"),
      ]);
      expect(rejectedTurnRes.exitCode).toBe(2);
      expect(rejectedTurnRes.report.typedCode).toBe("invalid_arguments");
      expect(rejectedTurnRes.report.hermesHomeKind).toBe("real");
      expect(fs.existsSync(callsLog)).toBe(false);

      // 1. Not running -> fail clearly, NEVER auto-ensure or stop
      const stoppedRes = await runRealGateway([
        "--hermes-home",
        realHomeSim,
        "--allow-real-home",
        "--cli",
        cliPath,
        "--report-dir",
        path.join(sandbox.rootDir, "rep-real-stopped"),
      ]);
      expect(stoppedRes.exitCode).toBe(1);
      expect(stoppedRes.report.typedCode).toBe("gateway_not_running");
      expect(stoppedRes.report.hermesHomeKind).toBe("real");
      expect(stoppedRes.report.sanitizedLogs.join("\n")).toContain("Start the gateway manually");

      // 2. Running -> attach --json only + read-only WS smoke + NO stop/ensure/writes
      fs.writeFileSync(stateFile, "running");
      const runningRes = await runRealGateway([
        "--hermes-home",
        realHomeSim,
        "--allow-real-home",
        "--cli",
        cliPath,
        "--report-dir",
        path.join(sandbox.rootDir, "rep-real-ok"),
      ]);
      expect(runningRes.exitCode).toBe(0);
      expect(runningRes.report.status).toBe("passed");
      expect(runningRes.report.hermesHomeKind).toBe("real");
      expect(runningRes.report.wsCloseCode).toBe(1000);

      const calls = fs
        .readFileSync(callsLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      for (const call of calls) {
        expect(call.args).not.toContain("ensure");
        expect(call.args).not.toContain("--recover");
        expect(call.args).not.toContain("--start");
        expect(call.args).not.toContain("stop");
      }
      expect(fs.readdirSync(realHomeSim)).toEqual(["config.yaml"]);
      expect(gw.rpcCalls.some((c) => c.method === "session.create" || c.method === "prompt.submit")).toBe(false);

      passed = true;
    } finally {
      await gw.close();
      sandbox.cleanup(passed);
    }
  });
});
