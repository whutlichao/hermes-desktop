import fs from "node:fs";
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
});
