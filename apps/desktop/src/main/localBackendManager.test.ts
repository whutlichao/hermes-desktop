import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import {
  LocalBackendManager,
  createNodeLocalBackendPorts,
  type ControlSocketProbeResult,
  type LocalBackendPorts,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "./localBackendManager";

function createFakePorts(options: {
  sandboxRoot: string;
  userDataDir: string;
  overridePath?: string | null;
  files?: Record<string, { executable: boolean }>;
  processes?: (req: ProcessRunRequest) => ProcessRunResult;
  pickResult?: { cancelled: boolean; filePath?: string };
  controlSocketProbe?: () => Promise<ControlSocketProbeResult>;
}) {
  const invokedCommands: ProcessRunRequest[] = [];
  const files = options.files ?? {};
  let currentTime = 1_000_000;
  let storedOverride: string | null = options.overridePath ?? null;
  let writeCount = 0;

  const ports: LocalBackendPorts = {
    async runProcess(req) {
      invokedCommands.push(req);
      currentTime += req.timeoutMs === 5000 && options.processes ? 10 : 5;
      if (options.processes) {
        const res = options.processes(req);
        if (res.timedOut) {
          currentTime += req.timeoutMs;
        }
        return res;
      }
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
    },
    async fileExists(filePath) {
      return Object.prototype.hasOwnProperty.call(files, filePath);
    },
    async isExecutable(filePath) {
      return Boolean(files[filePath]?.executable);
    },
    async pickCliFile() {
      return options.pickResult ?? { cancelled: true };
    },
    async readOverridePath() {
      return storedOverride;
    },
    async writeOverridePath(cliPath) {
      writeCount += 1;
      storedOverride = cliPath;
    },
    getShellPath() {
      return "/bin/zsh";
    },
    getHomeDir() {
      return options.sandboxRoot;
    },
    getUsername() {
      return "test-alice";
    },
    getAppVersion() {
      return "0.1.0";
    },
    getBuildMode() {
      return "dev";
    },
    getHermesHomeKind() {
      return "temp";
    },
    getCommonDirs() {
      return [
        path.join(options.sandboxRoot, ".local", "bin"),
        path.join(options.sandboxRoot, "homebrew", "bin"),
      ];
    },
    getControlSocketCandidates() {
      return [path.join(options.sandboxRoot, "hermes-home", "gateway.sock")];
    },
    now() {
      return currentTime;
    },
    controlSocketProbe: options.controlSocketProbe,
  };

  return {
    ports,
    invokedCommands,
    getStoredOverride: () => storedOverride,
    getWriteCount: () => writeCount,
  };
}

describe("LocalBackendManager (S2 fake CLI/process/control-socket/fs/clock)", () => {
  it("resolves CLI in strict order: override -> login shell -ilc -> login shell -lc -> common dirs", async () => {
    const sandbox = createTestSandbox("hermes-s2-order-");
    let passed = false;
    try {
      const overrideBin = path.join(sandbox.rootDir, "custom", "hermes");
      const ilcBin = path.join(sandbox.rootDir, "ilc-bin", "hermes");
      const lcBin = path.join(sandbox.rootDir, "lc-bin", "hermes");
      const commonBin = path.join(sandbox.rootDir, ".local", "bin", "hermes");

      const makeCliOutput = (req: ProcessRunRequest): ProcessRunResult => {
        if (req.args.includes("--version")) {
          return { exitCode: 0, stdout: "Hermes Agent v0.23.3", stderr: "", timedOut: false };
        }
        if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
          return { exitCode: 0, stdout: "{run,ensure,attach,tickets,status}", stderr: "", timedOut: false };
        }
        if (req.args.includes("ensure") && req.args.includes("--help")) {
          return { exitCode: 0, stdout: "--json --timeout", stderr: "", timedOut: false };
        }
        if (req.args.includes("attach") && req.args.includes("--help")) {
          return { exitCode: 0, stdout: "--json --recover", stderr: "", timedOut: false };
        }
        if (req.args.includes("tickets") && req.args.includes("--probe")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ protocol: 1, purposes: ["interactive"], windows_service_session: false }),
            stderr: "",
            timedOut: false,
          };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      };

      // 1. Override wins without calling login shell
      const overrideEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        overridePath: overrideBin,
        files: {
          [overrideBin]: { executable: true },
          [ilcBin]: { executable: true },
        },
        processes: makeCliOutput,
      });
      const mgrOverride = new LocalBackendManager(overrideEnv.ports);
      const resOverride = await mgrOverride.inspect();
      expect(resOverride.actual).toBe("ready");
      expect(resOverride.cli.sourceKind).toBe("override");
      expect(resOverride.cli.hasOverride).toBe(true);
      expect(JSON.stringify(resOverride)).not.toContain(overrideBin);
      expect(overrideEnv.invokedCommands.some((c) => c.args.includes("-ilc"))).toBe(false);

      // 2. Login shell -ilc with noisy banner wins when no override
      const ilcEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: { [ilcBin]: { executable: true } },
        processes: (req) => {
          if (req.args[0] === "-ilc") {
            return {
              exitCode: 0,
              stdout: `MOTD banner\n__HERMES_PATH_BEGIN__${path.dirname(ilcBin)}:/usr/bin__HERMES_PATH_END__\ntrailing noise`,
              stderr: "",
              timedOut: false,
            };
          }
          return makeCliOutput(req);
        },
      });
      const mgrIlc = new LocalBackendManager(ilcEnv.ports);
      const resIlc = await mgrIlc.inspect();
      expect(resIlc.actual).toBe("ready");
      expect(resIlc.cli.sourceKind).toBe("login_shell_ilc");
      expect(JSON.stringify(resIlc)).not.toContain(ilcBin);
      const ilcCall = ilcEnv.invokedCommands.find((c) => c.args[0] === "-ilc");
      expect(ilcCall?.timeoutMs).toBe(5000);
      expect(ilcCall?.stdinClose).toBe(true);

      // 3. Login shell -ilc times out (5s bound) -> falls back to -lc
      const lcEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: { [lcBin]: { executable: true } },
        processes: (req) => {
          if (req.args[0] === "-ilc") {
            return { exitCode: null, stdout: "", stderr: "timed out", timedOut: true };
          }
          if (req.args[0] === "-lc") {
            return {
              exitCode: 0,
              stdout: `__HERMES_PATH_BEGIN__${path.dirname(lcBin)}__HERMES_PATH_END__`,
              stderr: "",
              timedOut: false,
            };
          }
          return makeCliOutput(req);
        },
      });
      const mgrLc = new LocalBackendManager(lcEnv.ports);
      const resLc = await mgrLc.inspect();
      expect(resLc.actual).toBe("ready");
      expect(resLc.cli.sourceKind).toBe("login_shell_lc");
      expect(lcEnv.invokedCommands.find((c) => c.args[0] === "-lc")?.timeoutMs).toBe(5000);

      // 4. Both -ilc and -lc fail -> falls back to common dirs
      const commonEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: { [commonBin]: { executable: true } },
        processes: (req) => {
          if (req.args[0] === "-ilc" || req.args[0] === "-lc") {
            return { exitCode: 1, stdout: "no path", stderr: "err", timedOut: false };
          }
          return makeCliOutput(req);
        },
      });
      const mgrCommon = new LocalBackendManager(commonEnv.ports);
      const resCommon = await mgrCommon.inspect();
      expect(resCommon.actual).toBe("ready");
      expect(resCommon.cli.sourceKind).toBe("common_dir");
      expect(JSON.stringify(resCommon)).not.toContain(commonBin);

      // Never auto-installs python runtime
      const allInvokedText = JSON.stringify([
        ...overrideEnv.invokedCommands,
        ...ilcEnv.invokedCommands,
        ...lcEnv.invokedCommands,
        ...commonEnv.invokedCommands,
      ]);
      expect(allInvokedText).not.toMatch(/pip\s+install|uv\s+tool|brew\s+install|curl\s+/);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("produces typed failures for missing, non-executable, unsupported CLI, unsupported protocol, and control socket issues", async () => {
    const sandbox = createTestSandbox("hermes-s2-failures-");
    let passed = false;
    try {
      const binPath = path.join(sandbox.rootDir, ".local", "bin", "hermes");

      // 1. hermes_not_found
      const notFoundEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
      });
      const notFoundRes = await new LocalBackendManager(notFoundEnv.ports).inspect();
      expect(notFoundRes.actual).toBe("blocked");
      expect(notFoundRes.failure?.code).toBe("hermes_not_found");
      expect(notFoundRes.failure?.retryable).toBe(true);
      expect(notFoundRes.failure?.autoRetry).toBe(false);
      expect(notFoundRes.failure?.actions).toEqual(["choose_cli", "open_install_docs", "retry"]);

      // 2. cli_not_executable
      const notExecEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: { [binPath]: { executable: false } },
      });
      const notExecRes = await new LocalBackendManager(notExecEnv.ports).inspect();
      expect(notExecRes.actual).toBe("blocked");
      expect(notExecRes.failure?.code).toBe("cli_not_executable");
      expect(notExecRes.failure?.actions).toContain("choose_cli");
      expect(notExecRes.failure?.actions).toContain("open_diagnostics");

      // 3. cli_unsupported
      const unsupportedCliEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: { [binPath]: { executable: true } },
        processes: (req) => {
          if (req.args.includes("--version")) {
            return { exitCode: 0, stdout: "Hermes Agent v0.1.0", stderr: "", timedOut: false };
          }
          if (req.args.includes("gateway")) {
            return { exitCode: 0, stdout: "usage: hermes gateway {run,status}", stderr: "", timedOut: false };
          }
          return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
        },
      });
      const unsupportedCliRes = await new LocalBackendManager(unsupportedCliEnv.ports).inspect();
      expect(unsupportedCliRes.actual).toBe("blocked");
      expect(unsupportedCliRes.failure?.code).toBe("cli_unsupported");
      expect(unsupportedCliRes.failure?.actions).toEqual(["choose_cli", "open_update_docs", "retry"]);

      // 4. protocol_unsupported
      const unsupportedProtoEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: { [binPath]: { executable: true } },
        processes: (req) => {
          if (req.args.includes("--version")) {
            return { exitCode: 0, stdout: "Hermes Agent v0.23.3", stderr: "", timedOut: false };
          }
          if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
            return { exitCode: 0, stdout: "{ensure,attach,tickets}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") || req.args.includes("attach")) {
            return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          }
          if (req.args.includes("tickets") && req.args.includes("--probe")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ protocol: 99, purposes: [] }),
              stderr: "",
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      const unsupportedProtoRes = await new LocalBackendManager(unsupportedProtoEnv.ports).inspect();
      expect(unsupportedProtoRes.actual).toBe("blocked");
      expect(unsupportedProtoRes.failure?.code).toBe("protocol_unsupported");
      expect(unsupportedProtoRes.failure?.retryable).toBe(false);
      expect(unsupportedProtoRes.failure?.actions).toEqual([
        "choose_cli",
        "open_update_docs",
        "open_diagnostics",
      ]);

      // 5. control socket permission denied & code_sha_mismatch
      const sockDeniedEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: {
          [binPath]: { executable: true },
          [path.join(sandbox.rootDir, "hermes-home", "gateway.sock")]: { executable: false },
        },
        processes: (req) => {
          if (req.args.includes("--version")) return { exitCode: 0, stdout: "v0.23.3", stderr: "", timedOut: false };
          if (req.args.includes("ensure") || req.args.includes("attach")) return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          if (req.args.includes("tickets")) return { exitCode: 0, stdout: '{"protocol":1}', stderr: "", timedOut: false };
          return { exitCode: 0, stdout: "{ensure,attach,tickets}", stderr: "", timedOut: false };
        },
        controlSocketProbe: async () => ({ status: "permission_denied" }),
      });
      const sockDeniedRes = await new LocalBackendManager(sockDeniedEnv.ports).inspect();
      expect(sockDeniedRes.actual).toBe("blocked");
      expect(sockDeniedRes.failure?.code).toBe("socket_permission_denied");

      const shaMismatchEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        files: {
          [binPath]: { executable: true },
          [path.join(sandbox.rootDir, "hermes-home", "gateway.sock")]: { executable: false },
        },
        processes: (req) => {
          if (req.args.includes("--version")) return { exitCode: 0, stdout: "v0.23.3", stderr: "", timedOut: false };
          if (req.args.includes("ensure") || req.args.includes("attach")) return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          if (req.args.includes("tickets")) return { exitCode: 0, stdout: '{"protocol":1}', stderr: "", timedOut: false };
          return { exitCode: 0, stdout: "{ensure,attach,tickets}", stderr: "", timedOut: false };
        },
        controlSocketProbe: async () => ({
          status: "ok",
          runtimeProtocol: 1,
          capabilities: ["session-authority-v1"],
          installCodeSha: "aaa111",
          endpointCodeSha: "bbb222",
        }),
      });
      const shaMismatchRes = await new LocalBackendManager(shaMismatchEnv.ports).inspect();
      expect(shaMismatchRes.actual).toBe("blocked");
      expect(shaMismatchRes.failure?.code).toBe("code_sha_mismatch");
      expect(shaMismatchRes.failure?.restartAttempts).toEqual({ current: 1, max: 1 });

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("selectCli preserves state on cancel, persists override in Main only, and exports sanitized diagnostics", async () => {
    const sandbox = createTestSandbox("hermes-s2-select-");
    let passed = false;
    try {
      const pickedBin = path.join(sandbox.rootDir, "secret-user-dir", "hermes");

      // Cancel preserves existing state
      const cancelEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        pickResult: { cancelled: true },
      });
      const cancelMgr = new LocalBackendManager(cancelEnv.ports);
      const beforeCancel = await cancelMgr.inspect();
      const cancelSelect = await cancelMgr.selectCli();
      expect(cancelSelect.cancelled).toBe(true);
      expect(cancelSelect.inspection.failure?.code).toBe(beforeCancel.failure?.code);
      expect(cancelEnv.getWriteCount()).toBe(0);

      // Select updates Main preference and never leaks picked path to Renderer
      const selectEnv = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        pickResult: { cancelled: false, filePath: pickedBin },
        files: { [pickedBin]: { executable: true } },
        processes: (req) => {
          if (req.args[0] === "-ilc") {
            return { exitCode: null, stdout: "", stderr: "token=tok_secret_123", timedOut: true };
          }
          if (req.args.includes("--version")) {
            return {
              exitCode: 0,
              stdout: `Hermes Agent v0.23.3\nInstall directory: ${sandbox.rootDir}/install`,
              stderr: "stderr: https://alice:pw@host.local:8443/ws?ticket=tkt_999#frag",
              timedOut: false,
            };
          }
          if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
            return { exitCode: 0, stdout: "{ensure,attach,tickets}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") || req.args.includes("attach")) {
            return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          }
          if (req.args.includes("tickets")) {
            return { exitCode: 0, stdout: '{"protocol":1}', stderr: "", timedOut: false };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      const selectMgr = new LocalBackendManager(selectEnv.ports);
      await selectMgr.inspect();
      const selected = await selectMgr.selectCli();
      expect(selected.cancelled).toBe(false);
      expect(selected.inspection.actual).toBe("ready");
      expect(selected.cli.sourceKind).toBe("override");
      expect(selected.cli.hasOverride).toBe(true);
      expect(selectEnv.getStoredOverride()).toBe(pickedBin);
      expect(JSON.stringify(selected)).not.toContain(pickedBin);
      expect(JSON.stringify(selected)).not.toContain("secret-user-dir");

      const diag = await selectMgr.diagnose();
      const serializedDiag = JSON.stringify(diag);
      expect(diag.hermesHomeKind).toBe("temp");
      expect(diag.appName).toBe("Hermes Desktop");
      expect(serializedDiag).not.toContain(pickedBin);
      expect(serializedDiag).not.toContain(sandbox.rootDir);
      expect(serializedDiag).not.toContain("test-alice");
      expect(serializedDiag).not.toContain("tok_secret_123");
      expect(serializedDiag).not.toContain("tkt_999");
      expect(serializedDiag).not.toContain("pw@");
      expect(serializedDiag).not.toContain("stderr:");
      expect(fs.existsSync(path.join(sandbox.rootDir, "nonexistent"))).toBe(false);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("createNodeLocalBackendPorts persists 0600 override in sandbox userDataDir and bounds real process execution", async () => {
    const sandbox = createTestSandbox("hermes-s2-nodeports-");
    let passed = false;
    try {
      const fakeCli = path.join(sandbox.rootDir, "fake-hermes");
      fs.writeFileSync(
        fakeCli,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "Hermes Agent v0.23.3"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "--help" ]; then echo "{ensure,attach,tickets}"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "ensure" ]; then echo "--json"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "attach" ]; then echo "--json"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "tickets" ]; then echo \'{"protocol":1,"purposes":["interactive"]}\'; exit 0; fi',
          "exit 0",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );

      const nonExecCli = path.join(sandbox.rootDir, "non-exec-hermes");
      fs.writeFileSync(nonExecCli, "#!/bin/sh\necho hi\n", { encoding: "utf8", mode: 0o644 });

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: false, filePath: fakeCli }),
      });

      expect(await ports.isExecutable(fakeCli)).toBe(true);
      expect(await ports.isExecutable(nonExecCli)).toBe(false);

      await ports.writeOverridePath(fakeCli);
      const prefsPath = path.join(sandbox.userDataDir, "local-preferences.json");
      const mode = fs.statSync(prefsPath).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(await ports.readOverridePath()).toBe(fakeCli);

      const mgr = new LocalBackendManager(ports);
      const inspected = await mgr.inspect();
      expect(inspected.actual).toBe("ready");
      expect(inspected.cli.sourceKind).toBe("override");
      expect(inspected.cli.version).toBe("v0.23.3");
      expect(JSON.stringify(inspected)).not.toContain(sandbox.rootDir);

      const timedOut = await ports.runProcess({
        command: "/bin/sh",
        args: ["-c", "sleep 2"],
        timeoutMs: 50,
        stdinClose: true,
      });
      expect(timedOut.timedOut).toBe(true);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("createNodeLocalBackendPorts classifies Hermes 0.23.3 unknown-verb control replies as unsupported", async () => {
    const sandbox = createTestSandbox("hermes-s2-control-verb-");
    let passed = false;
    const sockPath = path.join(sandbox.hermesHomeDir, "gateway.sock");
    const requestsSeen: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        requestsSeen.push(JSON.parse(buffer.slice(0, newline)));
        socket.write(
          JSON.stringify({
            ok: false,
            error: "unknown verb: None",
            protocol: 1,
            supported_verbs: [
              "status",
              "serve-profile",
              "unserve-profile",
              "rescan-profiles",
            ],
          }) + "\n",
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    fs.chmodSync(sockPath, 0o600);

    try {
      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });

      const result = await ports.controlSocketRequest?.(sockPath, {
        op: "resolve-profile",
        profile_id: "default",
      });
      expect(result).toEqual({ status: "unsupported" });
      expect(requestsSeen).toEqual([{ op: "resolve-profile", profile_id: "default" }]);

      passed = true;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sandbox.cleanup(passed);
    }
  });

  it("prepareDial runs modern ensure --json, enforces protocol-1 + session-authority-v1, and mints single-use 30s interactive ticket over real UDS", async () => {
    const sandbox = createTestSandbox("hermes-s2-uds-dial-");
    let passed = false;
    const sockPath = path.join(sandbox.hermesHomeDir, "gateway.sock");
    let ticketSeq = 0;
    const requestsSeen: Array<Record<string, unknown>> = [];

    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const req = JSON.parse(line) as Record<string, unknown>;
        requestsSeen.push(req);
        if (req.op === "resolve-profile") {
          socket.write(
            JSON.stringify({
              status: "ok",
              state: "ready",
              attachable: true,
              purposes: ["interactive", "native-http"],
              install_code_sha: "sha_match_1",
              endpoint: {
                profile_id: "default",
                instance_id: "inst-uds-1",
                authority_epoch: 2,
                runtime_protocol: 1,
                capabilities: ["session-authority-v1", "host-scope-interactive"],
                code_sha: "sha_match_1",
                ws_url: "ws://127.0.0.1:18642/api/ws",
              },
            }) + "\n",
          );
        } else if (req.op === "session-ticket") {
          ticketSeq += 1;
          socket.write(
            JSON.stringify({
              status: "ok",
              ticket: `tkt_uds_${ticketSeq}`,
              expires_in_seconds: 30,
              profile_id: req.profile_id,
              instance_id: req.instance_id,
            }) + "\n",
          );
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    fs.chmodSync(sockPath, 0o600);

    try {
      const fakeCli = path.join(sandbox.rootDir, "hermes");
      fs.writeFileSync(
        fakeCli,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "Hermes Agent v0.23.3"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "--help" ]; then echo "{ensure,attach,tickets,restart}"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "ensure" ] && [ "$3" = "--help" ]; then echo "--json --timeout"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "attach" ] && [ "$3" = "--help" ]; then echo "--json --recover"; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "tickets" ] && [ "$3" = "--json" ]; then echo \'{"protocol":1,"purposes":["interactive"]}\'; exit 0; fi',
          'if [ "$1" = "gateway" ] && [ "$2" = "ensure" ] && [ "$3" = "--json" ]; then',
          '  echo \'{"state":"ready","attachable":true,"install_code_sha":"sha_match_1","client_code_sha":"sha_match_1","endpoint":{"profile_id":"default","instance_id":"inst-uds-1","authority_epoch":2,"runtime_protocol":1,"capabilities":["session-authority-v1","host-scope-interactive"],"code_sha":"sha_match_1","ws_url":"ws://127.0.0.1:18642/api/ws","ws_protocol":"hermes-gateway-v1","ticket_protocol_prefix":"hermes-gateway-ticket."}}\'',
          "  exit 0",
          "fi",
          "exit 1",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );

      const ports = createNodeLocalBackendPorts({
        userDataDir: sandbox.userDataDir,
        hermesHomeDir: sandbox.hermesHomeDir,
        hermesHomeKind: "temp",
        appVersion: "0.1.0",
        buildMode: "dev",
        pickCliFile: async () => ({ cancelled: true }),
      });
      await ports.writeOverridePath(fakeCli);

      const mgr = new LocalBackendManager(ports);
      const res = await mgr.prepareDial({ profileId: "default" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.dial.transportMode).toBe("shared-host-scope");
      expect(res.dial.instanceId).toBe("inst-uds-1");
      expect(res.dial.consumeTicket()).toBe("tkt_uds_1");
      // Single-use: second consume returns null
      expect(res.dial.consumeTicket()).toBeNull();
      expect(requestsSeen.some((r) => r.op === "session-ticket" && r.purpose === "interactive")).toBe(true);

      // Reconnect mints a brand-new ticket
      const freshTicket = await mgr.mintReconnectTicket(res.dial);
      expect(freshTicket.ok).toBe(true);
      if (freshTicket.ok) {
        expect(freshTicket.consumeTicket()).toBe("tkt_uds_2");
        expect(freshTicket.consumeTicket()).toBeNull();
      }

      // Diagnostics and inspection must NEVER contain ticket or wsUrl
      const diag = await mgr.diagnose();
      const diagStr = JSON.stringify(diag);
      expect(diagStr).not.toContain("tkt_uds_");
      expect(diagStr).not.toContain("18642");
      expect(JSON.stringify(res.inspection)).not.toContain("tkt_uds_");
      expect(JSON.stringify(res.inspection)).not.toContain("18642");

      passed = true;
    } finally {
      server.close();
      sandbox.cleanup(passed);
    }
  });

  it("prepareDial accepts Hermes 0.23.3 attach output and keeps profile identity separate from the CLI selector", async () => {
    const sandbox = createTestSandbox("hermes-s2-real-cli-shape-");
    let passed = false;
    try {
      const cliBin = path.join(sandbox.rootDir, "hermes");
      const sockPath = path.join(sandbox.hermesHomeDir, "gateway.sock");
      const profileIdentity = sandbox.hermesHomeDir;
      let attachCount = 0;
      const endpoint = {
        api_origin: "http://127.0.0.1:63942",
        authority_epoch: 26,
        capabilities: ["durable-admission-v1", "event-replay-v1", "session-authority-v1"],
        code_sha: "sha_live_1",
        control_home: null,
        instance_id: "inst-live-1",
        profile_id: profileIdentity,
        runtime_protocol: 1,
        supervisor: "launchd",
      };

      const ports = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        overridePath: cliBin,
        files: {
          [cliBin]: { executable: true },
          [sockPath]: { executable: false },
        },
        processes: (req) => {
          if (req.args.includes("--version")) {
            return { exitCode: 0, stdout: "Hermes Agent v0.23.3", stderr: "", timedOut: false };
          }
          if (
            req.args.includes("gateway") &&
            req.args.includes("--help") &&
            !req.args.includes("ensure") &&
            !req.args.includes("attach")
          ) {
            return { exitCode: 0, stdout: "{run,ensure,attach,tickets,restart}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") && req.args.includes("--help")) {
            return { exitCode: 0, stdout: "--json --timeout", stderr: "", timedOut: false };
          }
          if (req.args.includes("attach") && req.args.includes("--help")) {
            return { exitCode: 0, stdout: "--json --recover", stderr: "", timedOut: false };
          }
          if (req.args.includes("tickets") && req.args.includes("--probe")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                protocol: 1,
                purposes: ["interactive", "native-http"],
                windows_service_session: false,
              }),
              stderr: "",
              timedOut: false,
            };
          }
          if (req.args.includes("ensure") && req.args.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                client_code_sha: "sha_live_1",
                detail: null,
                endpoint,
                reason_code: null,
                state: "ready",
              }),
              stderr: "",
              timedOut: false,
            };
          }
          if (req.args.includes("attach") && req.args.includes("--json")) {
            attachCount += 1;
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                client_code_sha: "sha_live_1",
                detail: null,
                endpoint,
                protocol: "hermes-gateway-v1",
                protocols: [
                  "hermes-gateway-v1",
                  `hermes-gateway-ticket.tkt_real_shape_${attachCount}`,
                ],
                reason_code: null,
                state: "ready",
                ticket: `tkt_real_shape_${attachCount}`,
                url: "ws://127.0.0.1:63942/api/ws",
              }),
              stderr: "",
              timedOut: false,
            };
          }
          return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
        },
      });
      ports.ports.getControlSocketCandidates = () => [sockPath];
      ports.ports.controlSocketRequest = async () => ({ status: "unsupported" });

      const mgr = new LocalBackendManager(ports.ports);
      const res = await mgr.prepareDial({ profileId: "default" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.dial.wsUrl).toBe("ws://127.0.0.1:63942/api/ws");
      expect(res.dial.profileId).toBe(profileIdentity);
      expect(res.dial.cliProfileId).toBe("default");
      expect(res.dial.consumeTicket()).toBe("tkt_real_shape_1");
      expect(res.dial.consumeTicket()).toBeNull();

      const attachCalls = ports.invokedCommands.filter(
        (call) => call.args.includes("attach") && call.args.includes("--json"),
      );
      expect(attachCalls.length).toBe(1);
      expect(attachCalls[0]?.args).toEqual(["gateway", "attach", "--json"]);

      const fresh = await mgr.mintReconnectTicket(res.dial);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) {
        expect(fresh.consumeTicket()).toBe("tkt_real_shape_2");
      }
      const reconnectAttach = ports.invokedCommands
        .filter((call) => call.args.includes("attach") && call.args.includes("--json"))
        .at(-1);
      expect(reconnectAttach?.args).toEqual(["gateway", "attach", "--json"]);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("enforces socket permissions without fallback, handles starting/deadline timeout, falls back to attach when host-scope unavailable, and bounds code_sha restart to 1 single-flight attempt", async () => {
    const sandbox = createTestSandbox("hermes-s2-dial-edges-");
    let passed = false;
    try {
      const cliBin = path.join(sandbox.rootDir, "hermes");
      const sockPath = path.join(sandbox.hermesHomeDir, "gateway.sock");

      // 1. Socket permission denied MUST NOT fall back to attach --json
      let attachCalled = false;
      const permPorts = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        overridePath: cliBin,
        files: {
          [cliBin]: { executable: true },
          [sockPath]: { executable: false },
        },
        processes: (req) => {
          if (req.args.includes("--version")) return { exitCode: 0, stdout: "v0.23.3", stderr: "", timedOut: false };
          if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
            return { exitCode: 0, stdout: "{ensure,attach,tickets,restart}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json --timeout", stderr: "", timedOut: false };
          if (req.args.includes("attach") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          if (req.args.includes("tickets")) return { exitCode: 0, stdout: '{"protocol":1,"purposes":["interactive"]}', stderr: "", timedOut: false };
          if (req.args.includes("ensure") && req.args.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                state: "ready",
                endpoint: {
                  profile_id: "default",
                  instance_id: "inst-perm",
                  runtime_protocol: 1,
                  capabilities: ["session-authority-v1"],
                  ws_url: "ws://127.0.0.1:8642/api/ws",
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          if (req.args.includes("attach")) {
            attachCalled = true;
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
        controlSocketProbe: async () => ({ status: "permission_denied" }),
      });
      permPorts.ports.getControlSocketCandidates = () => [sockPath];
      permPorts.ports.controlSocketRequest = async () => ({ status: "permission_denied" });
      const permRes = await new LocalBackendManager(permPorts.ports).prepareDial();
      expect(permRes.ok).toBe(false);
      if (!permRes.ok) {
        expect(permRes.failure.code).toBe("socket_permission_denied");
      }
      expect(attachCalled).toBe(false);

      // 2. Host-scope explicitly unsupported falls back to per-Profile attach --json
      const fallbackPorts = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        overridePath: cliBin,
        files: {
          [cliBin]: { executable: true },
          [sockPath]: { executable: false },
        },
        processes: (req) => {
          if (req.args.includes("--version")) return { exitCode: 0, stdout: "v0.23.3", stderr: "", timedOut: false };
          if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
            return { exitCode: 0, stdout: "{ensure,attach,tickets}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json --timeout", stderr: "", timedOut: false };
          if (req.args.includes("attach") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          if (req.args.includes("tickets")) return { exitCode: 0, stdout: '{"protocol":1,"purposes":["native-http"]}', stderr: "", timedOut: false };
          if (req.args.includes("ensure") && req.args.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                state: "ready",
                endpoint: {
                  profile_id: "work",
                  instance_id: "inst-fb",
                  runtime_protocol: 1,
                  capabilities: ["session-authority-v1"],
                  ws_url: "ws://127.0.0.1:8642/api/ws",
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          if (req.args.includes("attach") && req.args.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                state: "ready",
                ticket: "tkt_per_profile_1",
                expires_in_seconds: 30,
                endpoint: {
                  profile_id: "work",
                  instance_id: "inst-fb",
                  runtime_protocol: 1,
                  capabilities: ["session-authority-v1"],
                  ws_url: "ws://127.0.0.1:8642/api/ws",
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      fallbackPorts.ports.getControlSocketCandidates = () => [sockPath];
      fallbackPorts.ports.controlSocketRequest = async () => ({ status: "unsupported" });
      const fbRes = await new LocalBackendManager(fallbackPorts.ports).prepareDial({ profileId: "work" });
      expect(fbRes.ok).toBe(true);
      if (fbRes.ok) {
        expect(fbRes.dial.transportMode).toBe("per-profile");
        expect(fbRes.dial.consumeTicket()).toBe("tkt_per_profile_1");
      }

      // 3. state=starting / reason_code=deadline -> does not spawn second owner; 60s -> gateway_starting_timeout
      let virtualNow = 1_000_000;
      const startingPorts = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        overridePath: cliBin,
        files: { [cliBin]: { executable: true } },
        processes: (req) => {
          if (req.args.includes("--version")) return { exitCode: 0, stdout: "v0.23.3", stderr: "", timedOut: false };
          if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
            return { exitCode: 0, stdout: "{ensure,attach}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json --timeout", stderr: "", timedOut: false };
          if (req.args.includes("attach") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          if (req.args.includes("ensure") && req.args.includes("--json")) {
            return {
              exitCode: 5,
              stdout: JSON.stringify({ state: "starting", reason_code: "deadline" }),
              stderr: "",
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      startingPorts.ports.now = () => virtualNow;
      startingPorts.ports.sleep = async (ms) => {
        virtualNow += ms;
      };
      const startRes = await new LocalBackendManager(startingPorts.ports).prepareDial({
        timeoutMs: 60_000,
        pollIntervalMs: 20_000,
      });
      expect(startRes.ok).toBe(false);
      if (!startRes.ok) {
        expect(startRes.failure.code).toBe("gateway_starting_timeout");
        expect(startRes.failure.actual).toBe("reconnecting");
      }
      expect(startingPorts.invokedCommands.some((c) => c.args.includes("restart") || c.args.includes("run"))).toBe(false);

      // 4. code_sha mismatch performs at most 1 single-flight restart --detach per stale owner
      let restartCount = 0;
      const shaPorts = createFakePorts({
        sandboxRoot: sandbox.rootDir,
        userDataDir: sandbox.userDataDir,
        overridePath: cliBin,
        files: { [cliBin]: { executable: true } },
        processes: (req) => {
          if (req.args.includes("--version")) return { exitCode: 0, stdout: "v0.23.3", stderr: "", timedOut: false };
          if (req.args.includes("gateway") && req.args.includes("--help") && !req.args.includes("ensure") && !req.args.includes("attach")) {
            return { exitCode: 0, stdout: "{ensure,attach,restart}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json --timeout", stderr: "", timedOut: false };
          if (req.args.includes("attach") && req.args.includes("--help")) return { exitCode: 0, stdout: "--json", stderr: "", timedOut: false };
          if (req.args.includes("restart") && req.args.includes("--detach")) {
            restartCount += 1;
            return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
          }
          if (req.args.includes("ensure") && req.args.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                state: "ready",
                client_code_sha: "cli_new_sha",
                install_code_sha: "cli_new_sha",
                endpoint: {
                  profile_id: "default",
                  instance_id: "inst-stale-1",
                  runtime_protocol: 1,
                  capabilities: ["session-authority-v1"],
                  code_sha: "gw_old_sha",
                  ws_url: "ws://127.0.0.1:8642/api/ws",
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      const shaMgr = new LocalBackendManager(shaPorts.ports);
      const [dialA, dialB] = await Promise.all([shaMgr.prepareDial(), shaMgr.prepareDial()]);
      expect(restartCount).toBe(1);
      expect(dialA.ok).toBe(false);
      expect(dialB.ok).toBe(false);
      if (!dialA.ok) {
        expect(dialA.failure.code).toBe("code_sha_mismatch");
        expect(dialA.failure.restartAttempts).toEqual({ current: 1, max: 1 });
      }

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });
});
