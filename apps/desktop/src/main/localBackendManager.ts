import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOST_BRIDGE_VERSION,
  type DiagnosticsPhaseEntry,
  type LocalCliSourceKind,
  type LocalCliSummary,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type SanitizedDiagnosticsPayload,
} from "@hermes/contracts";
import {
  LOGIN_SHELL_TIMEOUT_MS,
  PATH_SENTINEL_BEGIN,
  PATH_SENTINEL_END,
  classifyCliProbeOutput,
  extractPathFromShellOutput,
  formatDisplaySafeCliSummary,
  mapLocalFailure,
  sanitizeDiagnosticsPayload,
} from "@hermes/domain";

export interface ProcessRunRequest {
  command: string;
  args: string[];
  timeoutMs: number;
  stdinClose: true;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
}

export type ControlSocketProbeResult =
  | { status: "not_found" }
  | { status: "permission_denied" }
  | { status: "service_unhealthy" }
  | { status: "invalid_state" }
  | {
      status: "ok";
      runtimeProtocol?: number;
      capabilities?: string[];
      installCodeSha?: string;
      endpointCodeSha?: string;
      clientCodeSha?: string;
    };

export interface LocalBackendPorts {
  runProcess: (req: ProcessRunRequest) => Promise<ProcessRunResult>;
  fileExists: (filePath: string) => Promise<boolean>;
  isExecutable: (filePath: string) => Promise<boolean>;
  pickCliFile: () => Promise<{ cancelled: boolean; filePath?: string }>;
  readOverridePath: () => Promise<string | null>;
  writeOverridePath: (cliPath: string | null) => Promise<void>;
  getShellPath: () => string;
  getHomeDir: () => string;
  getUsername: () => string;
  getAppVersion: () => string;
  getBuildMode: () => "dev" | "packaged";
  getHermesHomeKind: () => "sandbox" | "real" | "temp";
  getCommonDirs: () => string[];
  getControlSocketCandidates: () => string[];
  now: () => number;
  controlSocketProbe?: (socketPath: string) => Promise<ControlSocketProbeResult>;
}

interface LocatedCandidate {
  path: string;
  sourceKind: Exclude<LocalCliSourceKind, "none">;
  hasOverride: boolean;
}

export class LocalBackendManager {
  private lastInspection: LocalInspectResult | null = null;
  private lastStages: DiagnosticsPhaseEntry[] = [];
  private lastNotes: string[] = [];

  constructor(private readonly ports: LocalBackendPorts) {}

  private buildMissingSummary(hasOverride = false): LocalCliSummary {
    return formatDisplaySafeCliSummary({
      status: "missing",
      sourceKind: hasOverride ? "override" : "none",
      hasOverride,
      supportsEnsureJson: false,
      supportsAttachJson: false,
      supportsTicketsProbe: false,
    });
  }

  private async checkCandidateInDirs(
    dirs: string[],
    sourceKind: Exclude<LocalCliSourceKind, "none">,
  ): Promise<{ candidate?: LocatedCandidate; nonExecutable?: LocatedCandidate }> {
    for (const dir of dirs) {
      if (!dir) continue;
      const candidatePath = path.join(dir, "hermes");
      if (await this.ports.fileExists(candidatePath)) {
        if (await this.ports.isExecutable(candidatePath)) {
          return {
            candidate: {
              path: candidatePath,
              sourceKind,
              hasOverride: false,
            },
          };
        }
        return {
          nonExecutable: {
            path: candidatePath,
            sourceKind,
            hasOverride: false,
          },
        };
      }
    }
    return {};
  }

  private async runLoginShellPathProbe(
    flag: "-ilc" | "-lc",
    shellPath: string,
    stages: DiagnosticsPhaseEntry[],
  ): Promise<{ dirs: string[] } | { failed: true }> {
    const stageName = flag === "-ilc" ? "login_shell_ilc" : "login_shell_lc";
    const startedAt = this.ports.now();
    const shellCmd = `printf '${PATH_SENTINEL_BEGIN}%s${PATH_SENTINEL_END}\\n' "$PATH"`;

    const result = await this.ports.runProcess({
      command: shellPath,
      args: [flag, shellCmd],
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      stdinClose: true,
    });
    const durationMs = Math.max(0, this.ports.now() - startedAt);

    if (result.timedOut) {
      stages.push({ phase: stageName, outcome: "timeout", durationMs, code: "timeout" });
      return { failed: true };
    }
    if (result.exitCode !== 0) {
      stages.push({ phase: stageName, outcome: "failed", durationMs, code: "exit_nonzero" });
      return { failed: true };
    }

    const extracted = extractPathFromShellOutput(result.stdout);
    if (!extracted) {
      stages.push({ phase: stageName, outcome: "failed", durationMs, code: "sentinel_missing" });
      return { failed: true };
    }

    stages.push({ phase: stageName, outcome: "ok", durationMs });
    return { dirs: extracted.split(path.delimiter).filter(Boolean) };
  }

  private recordResult(
    inspection: LocalInspectResult,
    stages: DiagnosticsPhaseEntry[],
    notes: string[],
  ): LocalInspectResult {
    this.lastInspection = inspection;
    this.lastStages = stages;
    this.lastNotes = notes;
    return inspection;
  }

  async inspect(): Promise<LocalInspectResult> {
    const stages: DiagnosticsPhaseEntry[] = [];
    const notes: string[] = [];
    const checkedAt = new Date(this.ports.now()).toISOString();

    // 1. Explicit App override
    const overridePath = await this.ports.readOverridePath();
    let located: LocatedCandidate | null = null;
    let nonExecutableCandidate: LocatedCandidate | null = null;

    if (overridePath) {
      const exists = await this.ports.fileExists(overridePath);
      if (!exists) {
        stages.push({ phase: "override", outcome: "failed", code: "hermes_not_found" });
        notes.push("Saved CLI override is no longer present on disk.");
        const cli = this.buildMissingSummary(true);
        return this.recordResult(
          {
            connectionId: "local",
            label: "This device",
            actual: "blocked",
            cli,
            failure: mapLocalFailure("hermes_not_found", "locate_cli"),
            checkedAt,
          },
          stages,
          notes,
        );
      }

      const executable = await this.ports.isExecutable(overridePath);
      if (!executable) {
        stages.push({ phase: "override", outcome: "failed", code: "cli_not_executable" });
        const cli = formatDisplaySafeCliSummary({
          status: "not_executable",
          sourceKind: "override",
          binaryName: path.basename(overridePath),
          hasOverride: true,
          supportsEnsureJson: false,
          supportsAttachJson: false,
          supportsTicketsProbe: false,
        });
        return this.recordResult(
          {
            connectionId: "local",
            label: "This device",
            actual: "blocked",
            cli,
            failure: mapLocalFailure("cli_not_executable", "locate_cli"),
            checkedAt,
          },
          stages,
          notes,
        );
      }

      stages.push({ phase: "override", outcome: "ok" });
      located = { path: overridePath, sourceKind: "override", hasOverride: true };
    } else {
      stages.push({ phase: "override", outcome: "skipped" });
    }

    // 2. Login shell -ilc then -lc (5s each)
    const shellPath = this.ports.getShellPath();
    if (!located && !nonExecutableCandidate) {
      const ilcProbe = await this.runLoginShellPathProbe("-ilc", shellPath, stages);
      if ("dirs" in ilcProbe) {
        const hit = await this.checkCandidateInDirs(ilcProbe.dirs, "login_shell_ilc");
        if (hit.candidate) located = hit.candidate;
        else if (hit.nonExecutable) nonExecutableCandidate = hit.nonExecutable;
      }
    }

    if (!located && !nonExecutableCandidate) {
      const lcProbe = await this.runLoginShellPathProbe("-lc", shellPath, stages);
      if ("dirs" in lcProbe) {
        const hit = await this.checkCandidateInDirs(lcProbe.dirs, "login_shell_lc");
        if (hit.candidate) located = hit.candidate;
        else if (hit.nonExecutable) nonExecutableCandidate = hit.nonExecutable;
      }
    }

    // 3. Common install directories
    if (!located && !nonExecutableCandidate) {
      const commonHit = await this.checkCandidateInDirs(this.ports.getCommonDirs(), "common_dir");
      if (commonHit.candidate) {
        stages.push({ phase: "common_dirs", outcome: "ok" });
        located = commonHit.candidate;
      } else if (commonHit.nonExecutable) {
        stages.push({ phase: "common_dirs", outcome: "failed", code: "cli_not_executable" });
        nonExecutableCandidate = commonHit.nonExecutable;
      } else {
        stages.push({ phase: "common_dirs", outcome: "failed", code: "hermes_not_found" });
      }
    }

    if (nonExecutableCandidate) {
      const cli = formatDisplaySafeCliSummary({
        status: "not_executable",
        sourceKind: nonExecutableCandidate.sourceKind,
        binaryName: path.basename(nonExecutableCandidate.path),
        hasOverride: nonExecutableCandidate.hasOverride,
        supportsEnsureJson: false,
        supportsAttachJson: false,
        supportsTicketsProbe: false,
      });
      return this.recordResult(
        {
          connectionId: "local",
          label: "This device",
          actual: "blocked",
          cli,
          failure: mapLocalFailure("cli_not_executable", "locate_cli"),
          checkedAt,
        },
        stages,
        notes,
      );
    }

    if (!located) {
      const cli = this.buildMissingSummary(false);
      return this.recordResult(
        {
          connectionId: "local",
          label: "This device",
          actual: "blocked",
          cli,
          failure: mapLocalFailure("hermes_not_found", "locate_cli"),
          checkedAt,
        },
        stages,
        notes,
      );
    }

    // 4. Probe CLI capabilities (read-only --version, gateway --help, ensure/attach --help, tickets --probe)
    const probeStarted = this.ports.now();
    const versionRes = await this.ports.runProcess({
      command: located.path,
      args: ["--version"],
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      stdinClose: true,
    });
    if (versionRes.errorCode === "EACCES") {
      stages.push({
        phase: "probe_cli",
        outcome: "failed",
        durationMs: Math.max(0, this.ports.now() - probeStarted),
        code: "cli_not_executable",
      });
      const cli = formatDisplaySafeCliSummary({
        status: "not_executable",
        sourceKind: located.sourceKind,
        binaryName: path.basename(located.path),
        hasOverride: located.hasOverride,
        supportsEnsureJson: false,
        supportsAttachJson: false,
        supportsTicketsProbe: false,
      });
      return this.recordResult(
        {
          connectionId: "local",
          label: "This device",
          actual: "blocked",
          cli,
          failure: mapLocalFailure("cli_not_executable", "probe_cli"),
          checkedAt,
        },
        stages,
        notes,
      );
    }

    const gatewayHelpRes = await this.ports.runProcess({
      command: located.path,
      args: ["gateway", "--help"],
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      stdinClose: true,
    });

    const hasEnsure = /\bensure\b/.test(gatewayHelpRes.stdout);
    const hasAttach = /\battach\b/.test(gatewayHelpRes.stdout);
    const hasTickets = /\btickets\b/.test(gatewayHelpRes.stdout);

    const ensureHelpRes = hasEnsure
      ? await this.ports.runProcess({
          command: located.path,
          args: ["gateway", "ensure", "--help"],
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          stdinClose: true,
        })
      : { stdout: "", stderr: "", exitCode: 1, timedOut: false };

    const attachHelpRes = hasAttach
      ? await this.ports.runProcess({
          command: located.path,
          args: ["gateway", "attach", "--help"],
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          stdinClose: true,
        })
      : { stdout: "", stderr: "", exitCode: 1, timedOut: false };

    const ticketsProbeRes = hasTickets
      ? await this.ports.runProcess({
          command: located.path,
          args: ["gateway", "tickets", "--json", "--probe"],
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          stdinClose: true,
        })
      : undefined;

    const classification = classifyCliProbeOutput({
      versionOutput: versionRes.stdout,
      gatewayHelpOutput: gatewayHelpRes.stdout,
      ensureHelpOutput: ensureHelpRes.stdout,
      attachHelpOutput: attachHelpRes.stdout,
      ticketsProbeJson: ticketsProbeRes?.exitCode === 0 ? ticketsProbeRes.stdout : undefined,
    });

    const probeDuration = Math.max(0, this.ports.now() - probeStarted);

    if (classification.kind === "failure") {
      stages.push({
        phase: classification.phase,
        outcome: "failed",
        durationMs: probeDuration,
        code: classification.code,
      });
      const cli = formatDisplaySafeCliSummary({
        status: "unsupported",
        sourceKind: located.sourceKind,
        binaryName: path.basename(located.path),
        version: classification.version,
        hasOverride: located.hasOverride,
        supportsEnsureJson: false,
        supportsAttachJson: false,
        supportsTicketsProbe: hasTickets,
      });
      return this.recordResult(
        {
          connectionId: "local",
          label: "This device",
          actual: "blocked",
          cli,
          failure: mapLocalFailure(classification.code, classification.phase),
          checkedAt,
        },
        stages,
        notes,
      );
    }

    stages.push({ phase: "probe_capabilities", outcome: "ok", durationMs: probeDuration });

    const cliSummary = formatDisplaySafeCliSummary({
      status: "ready",
      sourceKind: located.sourceKind,
      binaryName: path.basename(located.path),
      version: classification.version,
      hasOverride: located.hasOverride,
      supportsEnsureJson: classification.supportsEnsureJson,
      supportsAttachJson: classification.supportsAttachJson,
      supportsTicketsProbe: classification.supportsTicketsProbe,
    });

    // 5. Optional read-only control socket probe when socket file exists
    if (this.ports.controlSocketProbe) {
      for (const socketPath of this.ports.getControlSocketCandidates()) {
        if (!(await this.ports.fileExists(socketPath))) continue;
        const sockRes = await this.ports.controlSocketProbe(socketPath);
        if (sockRes.status === "permission_denied") {
          stages.push({ phase: "resolve_control_socket", outcome: "failed", code: "socket_permission_denied" });
          return this.recordResult(
            {
              connectionId: "local",
              label: "This device",
              actual: "blocked",
              cli: cliSummary,
              failure: mapLocalFailure("socket_permission_denied", "resolve_control_socket"),
              checkedAt,
            },
            stages,
            notes,
          );
        }
        if (sockRes.status === "service_unhealthy") {
          stages.push({ phase: "resolve_control_socket", outcome: "failed", code: "service_unhealthy" });
          return this.recordResult(
            {
              connectionId: "local",
              label: "This device",
              actual: "blocked",
              cli: cliSummary,
              failure: mapLocalFailure("service_unhealthy", "resolve_control_socket"),
              checkedAt,
            },
            stages,
            notes,
          );
        }
        if (sockRes.status === "invalid_state") {
          stages.push({ phase: "resolve_control_socket", outcome: "failed", code: "invalid_control_state" });
          return this.recordResult(
            {
              connectionId: "local",
              label: "This device",
              actual: "blocked",
              cli: cliSummary,
              failure: mapLocalFailure("invalid_control_state", "resolve_control_socket"),
              checkedAt,
            },
            stages,
            notes,
          );
        }
        if (sockRes.status === "ok") {
          if (
            (sockRes.runtimeProtocol !== undefined && sockRes.runtimeProtocol !== 1) ||
            (Array.isArray(sockRes.capabilities) && !sockRes.capabilities.includes("session-authority-v1"))
          ) {
            stages.push({ phase: "resolve_control_socket", outcome: "failed", code: "protocol_unsupported" });
            return this.recordResult(
              {
                connectionId: "local",
                label: "This device",
                actual: "blocked",
                cli: cliSummary,
                failure: mapLocalFailure("protocol_unsupported", "resolve_control_socket"),
                checkedAt,
              },
              stages,
              notes,
            );
          }

          const knownShas = [
            sockRes.installCodeSha,
            sockRes.endpointCodeSha,
            sockRes.clientCodeSha,
          ].filter((s): s is string => typeof s === "string" && s.length > 0);
          if (new Set(knownShas).size > 1) {
            stages.push({ phase: "resolve_control_socket", outcome: "failed", code: "code_sha_mismatch" });
            return this.recordResult(
              {
                connectionId: "local",
                label: "This device",
                actual: "blocked",
                cli: cliSummary,
                failure: mapLocalFailure("code_sha_mismatch", "resolve_control_socket", {
                  restartAttempts: { current: 1, max: 1 },
                }),
                checkedAt,
              },
              stages,
              notes,
            );
          }

          stages.push({ phase: "resolve_control_socket", outcome: "ok" });
        }
        break;
      }
    }

    return this.recordResult(
      {
        connectionId: "local",
        label: "This device",
        actual: "ready",
        cli: cliSummary,
        failure: null,
        checkedAt,
      },
      stages,
      notes,
    );
  }

  async selectCli(): Promise<LocalSelectCliResult> {
    const previous = this.lastInspection ?? (await this.inspect());
    const picked = await this.ports.pickCliFile();
    if (picked.cancelled || !picked.filePath) {
      return {
        cancelled: true,
        cli: previous.cli,
        inspection: previous,
      };
    }

    await this.ports.writeOverridePath(picked.filePath);
    const next = await this.inspect();
    return {
      cancelled: false,
      cli: next.cli,
      inspection: next,
    };
  }

  async diagnose(): Promise<SanitizedDiagnosticsPayload> {
    const inspection = this.lastInspection ?? (await this.inspect());
    const rawPayload: SanitizedDiagnosticsPayload = {
      generatedAt: new Date(this.ports.now()).toISOString(),
      appName: "Hermes Desktop",
      appVersion: this.ports.getAppVersion(),
      bridgeVersion: HOST_BRIDGE_VERSION,
      buildMode: this.ports.getBuildMode(),
      mode: "electron",
      platform: process.platform,
      arch: process.arch,
      hermesHomeKind: this.ports.getHermesHomeKind(),
      connectionsCount: 0,
      cliSummary: inspection.cli,
      typedFailureCode: inspection.failure?.code ?? null,
      failurePhase: inspection.failure?.phase ?? null,
      stages: this.lastStages,
      notes: this.lastNotes,
    };

    return sanitizeDiagnosticsPayload(rawPayload, {
      homeDir: this.ports.getHomeDir(),
      username: this.ports.getUsername(),
    });
  }
}

export interface NodeLocalPortsOptions {
  userDataDir: string;
  hermesHomeDir: string;
  hermesHomeKind: "sandbox" | "real" | "temp";
  appVersion: string;
  buildMode: "dev" | "packaged";
  pickCliFile: () => Promise<{ cancelled: boolean; filePath?: string }>;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function createNodeLocalBackendPorts(options: NodeLocalPortsOptions): LocalBackendPorts {
  const prefsPath = path.join(options.userDataDir, "local-preferences.json");

  return {
    async runProcess(req: ProcessRunRequest): Promise<ProcessRunResult> {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;

        const child = spawn(req.command, req.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          resolve({
            exitCode: null,
            stdout,
            stderr,
            timedOut: true,
          });
        }, req.timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode: null,
            stdout,
            stderr,
            timedOut: false,
            errorCode: err.code,
          });
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode: code,
            stdout,
            stderr,
            timedOut: false,
          });
        });
      });
    },
    async fileExists(filePath: string) {
      try {
        await fs.promises.stat(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async isExecutable(filePath: string) {
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return false;
        await fs.promises.access(filePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    pickCliFile: options.pickCliFile,
    async readOverridePath() {
      try {
        const raw = await fs.promises.readFile(prefsPath, "utf8");
        const parsed = JSON.parse(raw) as { cliOverridePath?: unknown };
        return typeof parsed.cliOverridePath === "string" && parsed.cliOverridePath.trim() !== ""
          ? parsed.cliOverridePath
          : null;
      } catch {
        return null;
      }
    },
    async writeOverridePath(cliPath: string | null) {
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await fs.promises.readFile(prefsPath, "utf8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
      if (cliPath) {
        existing.cliOverridePath = cliPath;
      } else {
        delete existing.cliOverridePath;
      }
      atomicWriteJson(prefsPath, existing);
    },
    getShellPath() {
      return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    },
    getHomeDir() {
      return os.homedir();
    },
    getUsername() {
      try {
        return os.userInfo().username;
      } catch {
        return process.env.USER || "";
      }
    },
    getAppVersion: () => options.appVersion,
    getBuildMode: () => options.buildMode,
    getHermesHomeKind: () => options.hermesHomeKind,
    getCommonDirs() {
      const home = os.homedir();
      return [
        path.join(home, ".local", "bin"),
        path.join(home, ".hermes", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
      ];
    },
    getControlSocketCandidates() {
      return [path.join(options.hermesHomeDir, "gateway.sock")];
    },
    now: () => Date.now(),
  };
}
