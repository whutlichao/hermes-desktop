import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  HOST_BRIDGE_VERSION,
  type DiagnosticsPhaseEntry,
  type LocalCliSourceKind,
  type LocalCliSummary,
  type LocalInspectResult,
  type LocalSelectCliResult,
  type LocalTypedFailure,
  type SanitizedDiagnosticsPayload,
} from "@hermes/contracts";
import {
  DEFAULT_TICKET_TTL_SECONDS,
  GATEWAY_TICKET_PREFIX,
  GATEWAY_WS_PROTOCOL,
  LOGIN_SHELL_TIMEOUT_MS,
  PATH_SENTINEL_BEGIN,
  PATH_SENTINEL_END,
  classifyCliProbeOutput,
  evaluateCodeShaMismatch,
  extractPathFromShellOutput,
  formatDisplaySafeCliSummary,
  mapLocalFailure,
  parseEnsureOrAttachOutput,
  sanitizeDiagnosticsPayload,
  validateEndpointProtocol,
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

export type ControlSocketProtocol1Response =
  | { status: "not_found" }
  | { status: "permission_denied" }
  | { status: "service_unhealthy" }
  | { status: "invalid_state"; reason?: string }
  | { status: "unsupported" | "refused"; reason?: string }
  | {
      status: "ok";
      state?: string;
      attachable?: boolean;
      purposes?: string[];
      runtimeProtocol?: number;
      capabilities?: string[];
      installCodeSha?: string;
      endpointCodeSha?: string;
      clientCodeSha?: string;
      profileId?: string;
      instanceId?: string;
      authorityEpoch?: number;
      wsUrl?: string;
      ticket?: string;
      expiresInSeconds?: number;
    };

export interface LocalDialMaterial {
  connectionId: "local";
  profileId: string;
  instanceId: string;
  authorityEpoch: number;
  wsUrl: string;
  wsProtocol: string;
  ticketProtocolPrefix: string;
  transportMode: "shared-host-scope" | "per-profile";
  endpointCapabilities: string[];
  codeSha?: string;
  expiresAt: number;
  consumeTicket: () => string | null;
}

export type LocalPrepareDialResult =
  | {
      ok: true;
      dial: LocalDialMaterial;
      inspection: LocalInspectResult;
    }
  | {
      ok: false;
      failure: LocalTypedFailure;
      inspection: LocalInspectResult;
    };

export type LocalMintTicketResult =
  | {
      ok: true;
      expiresAt: number;
      consumeTicket: () => string | null;
    }
  | {
      ok: false;
      failure: LocalTypedFailure;
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
  sleep?: (ms: number) => Promise<void>;
  controlSocketProbe?: (socketPath: string) => Promise<ControlSocketProbeResult>;
  controlSocketRequest?: (
    socketPath: string,
    request: Record<string, unknown>,
  ) => Promise<ControlSocketProtocol1Response>;
}

interface LocatedCandidate {
  path: string;
  sourceKind: Exclude<LocalCliSourceKind, "none">;
  hasOverride: boolean;
}

export class LocalBackendManager {
  private lastInspection: LocalInspectResult | null = null;
  private inspectInFlight: Promise<LocalInspectResult> | null = null;
  private lastStages: DiagnosticsPhaseEntry[] = [];
  private lastNotes: string[] = [];
  private lastCliPath: string | null = null;
  private readonly recoveryInFlight = new Map<string, Promise<{ ok: boolean; failure?: LocalTypedFailure }>>();
  private readonly attemptedRecoveries = new Set<string>();

  constructor(private readonly ports: LocalBackendPorts) {}

  private createSingleUseTicketHandle(ticket: string, expiresInSeconds: number) {
    const ttlMs = Math.max(1, expiresInSeconds) * 1000;
    const expiresAt = this.ports.now() + ttlMs;
    let consumed = false;
    const getNow = () => this.ports.now();
    return {
      expiresAt,
      consumeTicket(): string | null {
        if (consumed) return null;
        if (getNow() > expiresAt) {
          consumed = true;
          return null;
        }
        consumed = true;
        return ticket;
      },
    };
  }

  private async sleepMs(ms: number): Promise<void> {
    if (this.ports.sleep) {
      await this.ports.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private buildProfileArgs(profileId: string | undefined, gatewayArgs: string[]): string[] {
    if (profileId && profileId !== "default") {
      return ["--profile", profileId, ...gatewayArgs];
    }
    return gatewayArgs;
  }

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
    if (this.inspectInFlight) {
      return this.inspectInFlight;
    }
    const run = this.inspectUncached().finally(() => {
      if (this.inspectInFlight === run) {
        this.inspectInFlight = null;
      }
    });
    this.inspectInFlight = run;
    return run;
  }

  private async inspectUncached(): Promise<LocalInspectResult> {
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
    this.lastCliPath = located.path;

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

  async recover(options: {
    ownerProfile: string;
    staleInstanceId: string;
    clientCodeSha?: string;
    cliPath?: string;
  }): Promise<{ ok: boolean; failure?: LocalTypedFailure }> {
    const key = `${options.ownerProfile}:${options.staleInstanceId}:${options.clientCodeSha ?? ""}`;
    const existing = this.recoveryInFlight.get(key);
    if (existing) {
      return existing;
    }

    if (this.attemptedRecoveries.has(key)) {
      return {
        ok: false,
        failure: mapLocalFailure("code_sha_mismatch", "ensure_gateway", {
          profileId: options.ownerProfile,
          restartAttempts: { current: 1, max: 1 },
        }),
      };
    }

    const cliPath = options.cliPath ?? this.lastCliPath;
    if (!cliPath) {
      return {
        ok: false,
        failure: mapLocalFailure("hermes_not_found", "locate_cli"),
      };
    }

    const promise = (async () => {
      this.attemptedRecoveries.add(key);
      const res = await this.ports.runProcess({
        command: cliPath,
        args: this.buildProfileArgs(options.ownerProfile, ["gateway", "restart", "--detach"]),
        timeoutMs: 15_000,
        stdinClose: true,
      });
      if (res.timedOut) {
        return {
          ok: false,
          failure: mapLocalFailure("control_timeout", "ensure_gateway", {
            profileId: options.ownerProfile,
            restartAttempts: { current: 1, max: 1 },
          }),
        };
      }
      if (res.exitCode !== 0) {
        return {
          ok: false,
          failure: mapLocalFailure("code_sha_mismatch", "ensure_gateway", {
            profileId: options.ownerProfile,
            restartAttempts: { current: 1, max: 1 },
          }),
        };
      }
      return { ok: true };
    })().finally(() => {
      this.recoveryInFlight.delete(key);
    });

    this.recoveryInFlight.set(key, promise);
    return promise;
  }

  private async runEnsureOrAttachOnce(
    cliPath: string,
    cli: LocalCliSummary,
    profileId: string,
    remainingSeconds: number,
  ) {
    if (cli.supportsEnsureJson) {
      const timeoutArg = String(Math.max(1, Math.min(60, Math.ceil(remainingSeconds))));
      const res = await this.ports.runProcess({
        command: cliPath,
        args: this.buildProfileArgs(profileId, ["gateway", "ensure", "--json", "--timeout", timeoutArg]),
        timeoutMs: Math.max(LOGIN_SHELL_TIMEOUT_MS, Math.min(65_000, remainingSeconds * 1000 + 2000)),
        stdinClose: true,
      });
      return parseEnsureOrAttachOutput(res.stdout, res.exitCode);
    }

    const attachArgs = cli.supportsAttachJson
      ? ["gateway", "attach", "--json"]
      : ["gateway", "attach", "--recover", "--json"];
    const res = await this.ports.runProcess({
      command: cliPath,
      args: this.buildProfileArgs(profileId, attachArgs),
      timeoutMs: Math.max(LOGIN_SHELL_TIMEOUT_MS, 15_000),
      stdinClose: true,
    });
    return parseEnsureOrAttachOutput(res.stdout, res.exitCode);
  }

  private async runPerProfileAttach(
    cliPath: string,
    profileId: string,
  ): Promise<ReturnType<typeof parseEnsureOrAttachOutput>> {
    const res = await this.ports.runProcess({
      command: cliPath,
      args: this.buildProfileArgs(profileId, ["gateway", "attach", "--json"]),
      timeoutMs: 15_000,
      stdinClose: true,
    });
    return parseEnsureOrAttachOutput(res.stdout, res.exitCode);
  }

  private async tryControlSocketTicket(
    profileId: string,
    instanceId: string,
  ): Promise<
    | { kind: "ok"; ticket: string; expiresInSeconds: number; wsUrl?: string; capabilities?: string[] }
    | { kind: "fallback" }
    | { kind: "failure"; failure: LocalTypedFailure }
  > {
    if (!this.ports.controlSocketRequest) {
      return { kind: "fallback" };
    }
    const candidates = this.ports.getControlSocketCandidates();
    for (const socketPath of candidates) {
      if (!(await this.ports.fileExists(socketPath))) {
        continue;
      }
      const resolved = await this.ports.controlSocketRequest(socketPath, {
        op: "resolve-profile",
        profile_id: profileId,
      });
      if (resolved.status === "permission_denied") {
        return {
          kind: "failure",
          failure: mapLocalFailure("socket_permission_denied", "resolve_control_socket", { profileId }),
        };
      }
      if (resolved.status === "invalid_state") {
        return {
          kind: "failure",
          failure: mapLocalFailure("invalid_control_state", "resolve_control_socket", { profileId }),
        };
      }
      if (resolved.status === "service_unhealthy") {
        return {
          kind: "failure",
          failure: mapLocalFailure("service_unhealthy", "resolve_control_socket", { profileId }),
        };
      }
      if (resolved.status === "not_found" || resolved.status === "unsupported" || resolved.status === "refused") {
        return { kind: "fallback" };
      }
      if (resolved.status === "ok") {
        const protoCheck = validateEndpointProtocol({
          runtimeProtocol: resolved.runtimeProtocol ?? 1,
          capabilities: resolved.capabilities ?? ["session-authority-v1"],
          wsUrl: resolved.wsUrl ?? "ws://127.0.0.1",
        });
        if (!protoCheck.valid) {
          return {
            kind: "failure",
            failure: mapLocalFailure(protoCheck.code, "resolve_control_socket", { profileId }),
          };
        }
        if (Array.isArray(resolved.purposes) && !resolved.purposes.includes("interactive")) {
          return { kind: "fallback" };
        }
        const ticketRes = await this.ports.controlSocketRequest(socketPath, {
          op: "session-ticket",
          profile_id: profileId,
          instance_id: resolved.instanceId ?? instanceId,
          purpose: "interactive",
        });
        if (ticketRes.status === "permission_denied") {
          return {
            kind: "failure",
            failure: mapLocalFailure("socket_permission_denied", "resolve_control_socket", { profileId }),
          };
        }
        if (ticketRes.status === "invalid_state") {
          return {
            kind: "failure",
            failure: mapLocalFailure("invalid_control_state", "resolve_control_socket", { profileId }),
          };
        }
        if (ticketRes.status === "unsupported" || ticketRes.status === "refused" || ticketRes.status === "not_found") {
          return { kind: "fallback" };
        }
        if (ticketRes.status === "ok" && ticketRes.ticket) {
          return {
            kind: "ok",
            ticket: ticketRes.ticket,
            expiresInSeconds: ticketRes.expiresInSeconds ?? DEFAULT_TICKET_TTL_SECONDS,
            wsUrl: resolved.wsUrl,
            capabilities: resolved.capabilities,
          };
        }
        return {
          kind: "failure",
          failure: mapLocalFailure("ticket_unavailable", "resolve_control_socket", { profileId }),
        };
      }
    }
    return { kind: "fallback" };
  }

  async prepareDial(options?: {
    profileId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<LocalPrepareDialResult> {
    const profileId = options?.profileId ?? "default";
    const inspection = await this.inspect();
    if (inspection.actual === "blocked" || inspection.failure || !this.lastCliPath) {
      const failure = inspection.failure ?? mapLocalFailure("hermes_not_found", "locate_cli");
      return { ok: false, failure, inspection };
    }

    const cliPath = this.lastCliPath;
    const deadlineMs = options?.timeoutMs ?? 60_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
    const startedAt = this.ports.now();

    let parsed = await this.runEnsureOrAttachOnce(cliPath, inspection.cli, profileId, deadlineMs / 1000);
    while (parsed.kind === "starting") {
      const elapsed = this.ports.now() - startedAt;
      const remainingMs = deadlineMs - elapsed;
      if (remainingMs <= 0) {
        const failure = mapLocalFailure("gateway_starting_timeout", "ensure_gateway", {
          profileId,
          reasonCode: parsed.reasonCode,
        });
        const nextInspection = this.recordResult(
          { ...inspection, actual: failure.actual, failure },
          this.lastStages,
          this.lastNotes,
        );
        return { ok: false, failure, inspection: nextInspection };
      }
      await this.sleepMs(Math.min(pollIntervalMs, remainingMs));
      const elapsedAfterSleep = this.ports.now() - startedAt;
      if (deadlineMs - elapsedAfterSleep <= 0) {
        const failure = mapLocalFailure("gateway_starting_timeout", "ensure_gateway", {
          profileId,
          reasonCode: parsed.reasonCode,
        });
        const nextInspection = this.recordResult(
          { ...inspection, actual: failure.actual, failure },
          this.lastStages,
          this.lastNotes,
        );
        return { ok: false, failure, inspection: nextInspection };
      }
      parsed = await this.runEnsureOrAttachOnce(
        cliPath,
        inspection.cli,
        profileId,
        (deadlineMs - elapsedAfterSleep) / 1000,
      );
    }

    if (parsed.kind === "failure") {
      const failure = mapLocalFailure(parsed.code, "ensure_gateway", {
        profileId: parsed.profileId ?? profileId,
        reasonCode: parsed.reasonCode,
      });
      const nextInspection = this.recordResult(
        { ...inspection, actual: failure.actual, failure },
        this.lastStages,
        this.lastNotes,
      );
      return { ok: false, failure, inspection: nextInspection };
    }

    // Check code_sha consistency across client / endpoint / install SHAs
    const shaCheck = evaluateCodeShaMismatch({
      clientCodeSha: parsed.clientCodeSha,
      endpointCodeSha: parsed.endpoint.codeSha,
      installCodeSha: parsed.installCodeSha,
    });
    if (shaCheck.mismatch) {
      const recovery = await this.recover({
        ownerProfile: parsed.endpoint.profileId,
        staleInstanceId: parsed.endpoint.instanceId,
        clientCodeSha: parsed.clientCodeSha,
        cliPath,
      });
      if (!recovery.ok) {
        const failure =
          recovery.failure ??
          mapLocalFailure("code_sha_mismatch", "ensure_gateway", {
            profileId,
            restartAttempts: { current: 1, max: 1 },
          });
        const nextInspection = this.recordResult(
          { ...inspection, actual: failure.actual, failure },
          this.lastStages,
          this.lastNotes,
        );
        return { ok: false, failure, inspection: nextInspection };
      }
      parsed = await this.runEnsureOrAttachOnce(cliPath, inspection.cli, profileId, 30);
      if (parsed.kind !== "ready") {
        const code = parsed.kind === "starting" ? "gateway_starting_timeout" : parsed.code;
        const failure = mapLocalFailure(code, "ensure_gateway", {
          profileId,
          restartAttempts: { current: 1, max: 1 },
        });
        return { ok: false, failure, inspection };
      }
      const recheck = evaluateCodeShaMismatch({
        clientCodeSha: parsed.clientCodeSha,
        endpointCodeSha: parsed.endpoint.codeSha,
        installCodeSha: parsed.installCodeSha,
      });
      if (recheck.mismatch) {
        const failure = mapLocalFailure("code_sha_mismatch", "ensure_gateway", {
          profileId,
          restartAttempts: { current: 1, max: 1 },
        });
        const nextInspection = this.recordResult(
          { ...inspection, actual: failure.actual, failure },
          this.lastStages,
          this.lastNotes,
        );
        return { ok: false, failure, inspection: nextInspection };
      }
    }

    // Mint 30s single-use ticket: prefer host-scope control socket interactive, else fallback per-Profile attach
    const sockRes = await this.tryControlSocketTicket(
      parsed.endpoint.profileId,
      parsed.endpoint.instanceId,
    );
    if (sockRes.kind === "failure") {
      const nextInspection = this.recordResult(
        { ...inspection, actual: sockRes.failure.actual, failure: sockRes.failure },
        this.lastStages,
        this.lastNotes,
      );
      return { ok: false, failure: sockRes.failure, inspection: nextInspection };
    }

    let ticket = "";
    let expiresInSeconds: number = DEFAULT_TICKET_TTL_SECONDS;
    let transportMode: LocalDialMaterial["transportMode"] = "per-profile";
    let finalEndpoint = parsed.endpoint;

    if (sockRes.kind === "ok") {
      ticket = sockRes.ticket;
      expiresInSeconds = sockRes.expiresInSeconds;
      transportMode = "shared-host-scope";
      if (sockRes.wsUrl) {
        finalEndpoint = { ...finalEndpoint, wsUrl: sockRes.wsUrl };
      }
    } else if (parsed.ticket) {
      ticket = parsed.ticket;
      expiresInSeconds = parsed.expiresInSeconds;
      transportMode = "per-profile";
    } else if (inspection.cli.supportsAttachJson) {
      const attached = await this.runPerProfileAttach(cliPath, parsed.endpoint.profileId);
      if (attached.kind === "failure") {
        const failure = mapLocalFailure(attached.code, "ensure_gateway", { profileId });
        return { ok: false, failure, inspection };
      }
      if (attached.kind === "starting") {
        const failure = mapLocalFailure("gateway_starting_timeout", "ensure_gateway", { profileId });
        return { ok: false, failure, inspection };
      }
      if (!attached.ticket) {
        const failure = mapLocalFailure("ticket_unavailable", "ensure_gateway", { profileId });
        return { ok: false, failure, inspection };
      }
      ticket = attached.ticket;
      expiresInSeconds = attached.expiresInSeconds;
      finalEndpoint = attached.endpoint;
      transportMode = "per-profile";
    } else {
      const failure = mapLocalFailure("ticket_unavailable", "ensure_gateway", { profileId });
      return { ok: false, failure, inspection };
    }

    const ticketHandle = this.createSingleUseTicketHandle(ticket, expiresInSeconds);
    const dial: LocalDialMaterial = {
      connectionId: "local",
      profileId: finalEndpoint.profileId,
      instanceId: finalEndpoint.instanceId,
      authorityEpoch: finalEndpoint.authorityEpoch,
      wsUrl: finalEndpoint.wsUrl,
      wsProtocol: finalEndpoint.wsProtocol || GATEWAY_WS_PROTOCOL,
      ticketProtocolPrefix: finalEndpoint.ticketProtocolPrefix || GATEWAY_TICKET_PREFIX,
      transportMode,
      endpointCapabilities: finalEndpoint.capabilities,
      codeSha: finalEndpoint.codeSha,
      expiresAt: ticketHandle.expiresAt,
      consumeTicket: ticketHandle.consumeTicket,
    };

    const readyInspection = this.recordResult(
      { ...inspection, actual: "ready", failure: null },
      this.lastStages,
      this.lastNotes,
    );

    return { ok: true, dial, inspection: readyInspection };
  }

  async mintReconnectTicket(dial: Pick<LocalDialMaterial, "profileId" | "instanceId" | "transportMode">): Promise<LocalMintTicketResult> {
    if (dial.transportMode === "shared-host-scope") {
      const sockRes = await this.tryControlSocketTicket(dial.profileId, dial.instanceId);
      if (sockRes.kind === "ok") {
        const handle = this.createSingleUseTicketHandle(sockRes.ticket, sockRes.expiresInSeconds);
        return { ok: true, ...handle };
      }
      if (sockRes.kind === "failure") {
        return { ok: false, failure: sockRes.failure };
      }
    }

    const cliPath = this.lastCliPath;
    if (!cliPath) {
      return { ok: false, failure: mapLocalFailure("hermes_not_found", "locate_cli") };
    }
    const attached = await this.runPerProfileAttach(cliPath, dial.profileId);
    if (attached.kind === "ready" && attached.ticket) {
      const handle = this.createSingleUseTicketHandle(attached.ticket, attached.expiresInSeconds);
      return { ok: true, ...handle };
    }
    if (attached.kind === "failure") {
      return {
        ok: false,
        failure: mapLocalFailure(attached.code, "ensure_gateway", { profileId: dial.profileId }),
      };
    }
    return {
      ok: false,
      failure: mapLocalFailure("ticket_unavailable", "ensure_gateway", { profileId: dial.profileId }),
    };
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
    async controlSocketRequest(
      socketPath: string,
      request: Record<string, unknown>,
    ): Promise<ControlSocketProtocol1Response> {
      try {
        const lstat = await fs.promises.lstat(socketPath);
        if (lstat.isSymbolicLink()) {
          return { status: "permission_denied" };
        }
        const stat = await fs.promises.stat(socketPath);
        if (!stat.isSocket()) {
          return { status: "invalid_state" };
        }
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
          return { status: "permission_denied" };
        }
        if ((stat.mode & 0o077) !== 0) {
          return { status: "permission_denied" };
        }
        const dirStat = await fs.promises.stat(path.dirname(socketPath));
        if ((dirStat.mode & 0o022) !== 0) {
          return { status: "permission_denied" };
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EACCES" || code === "EPERM") {
          return { status: "permission_denied" };
        }
        return { status: "not_found" };
      }

      return new Promise<ControlSocketProtocol1Response>((resolve) => {
        let settled = false;
        let buffer = "";
        const socket = net.createConnection({ path: socketPath });
        const finish = (res: ControlSocketProtocol1Response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(res);
        };

        const timer = setTimeout(() => {
          finish({ status: "invalid_state", reason: "timeout" });
        }, 3000);

        socket.on("connect", () => {
          socket.write(`${JSON.stringify(request)}\n`, "utf8");
        });

        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const nl = buffer.indexOf("\n");
          if (nl === -1) return;
          const line = buffer.slice(0, nl).trim();
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const rawStatus = typeof parsed.status === "string" ? parsed.status : undefined;
            const errStr = typeof parsed.error === "string" ? parsed.error : "";
            if (
              rawStatus === "permission_denied" ||
              errStr.includes("permission") ||
              errStr.includes("bootstrap binding rejected")
            ) {
              finish({ status: "permission_denied" });
              return;
            }
            if (
              rawStatus === "invalid_state" ||
              errStr.includes("invalid bootstrap") ||
              errStr.includes("stale runtime instance")
            ) {
              finish({ status: "invalid_state" });
              return;
            }
            if (rawStatus === "unsupported" || rawStatus === "refused") {
              finish({ status: rawStatus });
              return;
            }
            const ep =
              parsed.endpoint && typeof parsed.endpoint === "object"
                ? (parsed.endpoint as Record<string, unknown>)
                : parsed;
            finish({
              status: "ok",
              state: typeof parsed.state === "string" ? parsed.state : undefined,
              attachable: typeof parsed.attachable === "boolean" ? parsed.attachable : undefined,
              purposes: Array.isArray(parsed.purposes)
                ? parsed.purposes.filter((p): p is string => typeof p === "string")
                : undefined,
              runtimeProtocol:
                typeof ep.runtime_protocol === "number"
                  ? ep.runtime_protocol
                  : typeof parsed.runtimeProtocol === "number"
                    ? parsed.runtimeProtocol
                    : undefined,
              capabilities: Array.isArray(ep.capabilities)
                ? ep.capabilities.filter((c): c is string => typeof c === "string")
                : undefined,
              installCodeSha:
                typeof parsed.install_code_sha === "string" ? parsed.install_code_sha : undefined,
              endpointCodeSha: typeof ep.code_sha === "string" ? ep.code_sha : undefined,
              clientCodeSha:
                typeof parsed.client_code_sha === "string" ? parsed.client_code_sha : undefined,
              profileId: typeof ep.profile_id === "string" ? ep.profile_id : undefined,
              instanceId: typeof ep.instance_id === "string" ? ep.instance_id : undefined,
              authorityEpoch:
                typeof ep.authority_epoch === "number" ? ep.authority_epoch : undefined,
              wsUrl: typeof ep.ws_url === "string" ? ep.ws_url : undefined,
              ticket: typeof parsed.ticket === "string" ? parsed.ticket : undefined,
              expiresInSeconds:
                typeof parsed.expires_in_seconds === "number"
                  ? parsed.expires_in_seconds
                  : undefined,
            });
          } catch {
            finish({ status: "invalid_state" });
          }
        });

        socket.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EACCES" || err.code === "EPERM") {
            finish({ status: "permission_denied" });
          } else if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
            finish({ status: "not_found" });
          } else {
            finish({ status: "invalid_state" });
          }
        });
      });
    },
  };
}
