import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  ConnectionTestResult,
  SshFailureCode,
  SshHostKeyChallenge,
  SshHostKeyConfirmResult,
  SshSafeActionId,
  SshTransportMode,
} from "@hermes/contracts";
import {
  DEFAULT_TICKET_TTL_SECONDS,
  GATEWAY_TICKET_PREFIX,
  GATEWAY_WS_PROTOCOL,
  buildRemoteHermesShellCommand,
  buildSshCommandArgs,
  classifySshStderr,
  extractRemotePortFromWsUrl,
  formatSshHostDisplay,
  formatSshTargetDisplay,
  getCopy,
  getSshFailureCopy,
  parseEnsureOrAttachOutput,
  parseKeygenFingerprintOutput,
  parseSshProbeOutput,
  parseSshServeLine,
  rewriteForwardedWsUrl,
  validateEndpointProtocol,
  validateSshTargetInput,
} from "@hermes/domain";
import type { ProcessRunResult } from "./localBackendManager";

const SSH_COMMAND_TIMEOUT_MS = 15_000;
const SSH_SERVE_READY_TIMEOUT_MS = 15_000;
const SSH_TICKET_TIMEOUT_MS = 10_000;
const SSH_TUNNEL_READY_TIMEOUT_MS = 10_000;

export interface SshTargetConfig {
  connectionId: string;
  host: string;
  user?: string;
  port?: number;
  keyPath?: string;
  remoteHermesPath?: string;
  remoteProfile?: string;
  preferLegacyAttach?: boolean;
}

export interface SshDialMaterial {
  connectionId: string;
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

export type SshPrepareDialResult =
  | {
      ok: true;
      dial: SshDialMaterial;
      sshMode: SshTransportMode;
      legacyNotice: boolean;
      windowsServiceSession: boolean;
    }
  | {
      ok: false;
      failureCode: SshFailureCode;
      status: "blocked" | "failed";
      message: string;
      hostKeyChallenge?: SshHostKeyChallenge;
      actions: SshSafeActionId[];
    };

export type SshMintTicketResult =
  | {
      ok: true;
      wsUrl: string;
      expiresAt: number;
      consumeTicket: () => string | null;
    }
  | {
      ok: false;
      failureCode: SshFailureCode;
      message: string;
    };

export interface SshStreamProcess {
  pid?: number;
  writeLine: (line: string) => void;
  onLine: (listener: (line: string) => void) => () => void;
  onStderr: (listener: (chunk: string) => void) => () => void;
  onExit: (listener: (code: number | null) => void) => () => void;
  markAuthSettled: () => void;
  kill: () => void;
  isAlive: () => boolean;
}

export interface SshTransportPorts {
  runSshCommand: (
    args: string[],
    options: { timeoutMs: number; passphrase?: string },
  ) => Promise<ProcessRunResult>;
  spawnSshStream: (
    args: string[],
    options: { passphrase?: string },
  ) => SshStreamProcess;
  scanHostKey: (target: { host: string; port?: number }) => Promise<string | null>;
  computeHostKeyFingerprint: (
    keyLine: string,
    hostDisplay: string,
  ) => Promise<SshHostKeyChallenge | null>;
  appendKnownHost: (keyLine: string) => Promise<void>;
  confirmHostKeyPrompt: (challenge: SshHostKeyChallenge) => Promise<boolean>;
  allocateLocalPort: () => Promise<number>;
  waitForLocalPort: (
    port: number,
    timeoutMs: number,
    isTunnelAlive: () => boolean,
  ) => Promise<boolean>;
  knownHostsPath?: string;
  now: () => number;
}

export interface NodeSshTransportPortsOptions {
  askpassSandboxDir: string;
  knownHostsPath?: string;
  sshBinaryPath?: string;
  sshKeyscanBinaryPath?: string;
  sshKeygenBinaryPath?: string;
  confirmHostKeyPrompt: (challenge: SshHostKeyChallenge) => Promise<boolean>;
}

interface EphemeralAskpassHandle {
  env: Record<string, string | undefined>;
  cleanup: () => void;
}

function createEphemeralAskpass(
  sandboxDir: string,
  passphrase: string | undefined,
): EphemeralAskpassHandle {
  if (!passphrase) {
    return {
      env: { ...process.env },
      cleanup: () => {},
    };
  }

  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(sandboxDir, "askpass-"));
  try {
    fs.chmodSync(tempDir, 0o700);
    const secretPath = path.join(tempDir, "secret");
    const scriptPath = path.join(tempDir, "askpass.sh");
    fs.writeFileSync(secretPath, passphrase, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(scriptPath, '#!/bin/sh\ncat "${0%/*}/secret"\n', {
      encoding: "utf8",
      mode: 0o700,
    });

    const cleanup = () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup race
      }
    };

    return {
      env: {
        ...process.env,
        SSH_ASKPASS: scriptPath,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "hermes-askpass:0",
      },
      cleanup,
    };
  } catch (err) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

function runRawProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string | undefined>; stdinText?: string },
): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    if (options.stdinText !== undefined) {
      child.stdin?.write(options.stdinText);
    }
    child.stdin?.end();

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
}

function wrapStreamProcess(
  child: ChildProcess,
  cleanupAskpass: () => void,
): SshStreamProcess {
  let alive = true;
  let lineBuffer = "";
  const lineListeners = new Set<(line: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();

  child.stdout?.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString("utf8");
    let idx = lineBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = lineBuffer.slice(0, idx).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(idx + 1);
      for (const listener of lineListeners) {
        listener(line);
      }
      idx = lineBuffer.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const listener of stderrListeners) {
      listener(text);
    }
  });

  const handleExit = (code: number | null) => {
    if (!alive) return;
    alive = false;
    cleanupAskpass();
    if (lineBuffer.trim()) {
      const tail = lineBuffer.trim();
      lineBuffer = "";
      for (const listener of lineListeners) {
        listener(tail);
      }
    }
    for (const listener of exitListeners) {
      listener(code);
    }
  };

  child.on("close", (code) => handleExit(code));
  child.on("error", () => handleExit(null));

  return {
    pid: child.pid,
    writeLine(line: string) {
      if (!alive || !child.stdin || child.stdin.destroyed) return;
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onStderr(listener) {
      stderrListeners.add(listener);
      return () => stderrListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    markAuthSettled() {
      cleanupAskpass();
    },
    kill() {
      cleanupAskpass();
      if (!alive) return;
      alive = false;
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
    isAlive() {
      return alive;
    },
  };
}

export function createNodeSshTransportPorts(
  options: NodeSshTransportPortsOptions,
): SshTransportPorts {
  const sshBin = options.sshBinaryPath ?? "ssh";
  const keyscanBin = options.sshKeyscanBinaryPath ?? "ssh-keyscan";
  const keygenBin = options.sshKeygenBinaryPath ?? "ssh-keygen";
  const knownHostsPath =
    options.knownHostsPath ?? path.join(os.homedir(), ".ssh", "known_hosts");

  return {
    knownHostsPath,

    async runSshCommand(args, reqOpts) {
      const askpass = createEphemeralAskpass(options.askpassSandboxDir, reqOpts.passphrase);
      try {
        return await runRawProcess(sshBin, args, {
          timeoutMs: reqOpts.timeoutMs,
          env: askpass.env,
        });
      } finally {
        askpass.cleanup();
      }
    },

    spawnSshStream(args, reqOpts) {
      const askpass = createEphemeralAskpass(options.askpassSandboxDir, reqOpts.passphrase);
      try {
        const child = spawn(sshBin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: askpass.env,
        });
        return wrapStreamProcess(child, askpass.cleanup);
      } catch (err) {
        askpass.cleanup();
        throw err;
      }
    },

    async scanHostKey(target) {
      const args: string[] = [];
      if (target.port && target.port !== 22) {
        args.push("-p", String(target.port));
      }
      args.push("-T", "5", target.host.trim());
      const res = await runRawProcess(keyscanBin, args, { timeoutMs: 7_000 });
      if (res.exitCode !== 0 && !res.stdout.trim()) return null;
      const lines = res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      return lines[0] ?? null;
    },

    async computeHostKeyFingerprint(keyLine, hostDisplay) {
      const res = await runRawProcess(keygenBin, ["-lf", "-"], {
        timeoutMs: 5_000,
        stdinText: `${keyLine.trim()}\n`,
      });
      if (res.exitCode !== 0 && !res.stdout.trim()) return null;
      return parseKeygenFingerprintOutput(res.stdout, hostDisplay);
    },

    async appendKnownHost(keyLine) {
      const dir = path.dirname(knownHostsPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const cleanLine = keyLine.trim();
      if (!cleanLine) return;
      const existing = fs.existsSync(knownHostsPath)
        ? fs.readFileSync(knownHostsPath, "utf8")
        : "";
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(knownHostsPath, `${existing}${prefix}${cleanLine}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },

    confirmHostKeyPrompt: options.confirmHostKeyPrompt,

    async allocateLocalPort() {
      return new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          server.close((closeErr) => {
            if (closeErr) reject(closeErr);
            else resolve(port);
          });
        });
      });
    },

    async waitForLocalPort(port, timeoutMs, isTunnelAlive) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isTunnelAlive()) return false;
        const connected = await new Promise<boolean>((resolve) => {
          const sock = net.connect({ host: "127.0.0.1", port });
          const done = (ok: boolean) => {
            sock.removeAllListeners();
            sock.destroy();
            resolve(ok);
          };
          sock.once("connect", () => done(true));
          sock.once("error", () => done(false));
          sock.setTimeout(200, () => done(false));
        });
        if (connected) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      return false;
    },

    now: () => Date.now(),
  };
}

interface ActiveModernSession {
  mode: "tickets_serve";
  targetSignature: string;
  serveProc: SshStreamProcess;
  tunnelProc: SshStreamProcess;
  localPort: number;
  remotePort: number;
  windowsServiceSession: boolean;
  mintChain: Promise<unknown>;
}

interface ActiveLegacyTunnel {
  tunnelProc: SshStreamProcess;
  localPort: number;
  remotePort: number;
}

function buildTargetSignature(target: SshTargetConfig): string {
  return JSON.stringify({
    host: target.host.trim().toLowerCase(),
    user: target.user?.trim() ?? "",
    port: target.port ?? 22,
    keyPath: target.keyPath?.trim() ?? "",
    remoteHermesPath: target.remoteHermesPath?.trim() ?? "",
    remoteProfile: target.remoteProfile?.trim() ?? "",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SshTransportManager {
  private readonly ports: SshTransportPorts;
  private readonly sessionPassphrases = new Map<string, string>();
  private readonly pendingTargetPassphrases = new Map<string, string>();
  private readonly modernConfirmedTargets = new Set<string>();
  private readonly legacyOptInTargets = new Set<string>();
  private readonly hardBlockedTargets = new Set<string>();
  private readonly modernSessions = new Map<string, ActiveModernSession>();
  private readonly legacyTunnels = new Map<string, ActiveLegacyTunnel>();
  private disposed = false;

  constructor(ports: SshTransportPorts) {
    this.ports = ports;
  }

  setSessionPassphrase(connectionId: string, passphrase: string | null | undefined): void {
    if (!passphrase) {
      this.sessionPassphrases.delete(connectionId);
      return;
    }
    this.sessionPassphrases.set(connectionId, passphrase);
  }

  setPendingTargetPassphrase(
    target: Omit<SshTargetConfig, "connectionId"> & { connectionId?: string },
    passphrase: string | null | undefined,
  ): void {
    const sig = buildTargetSignature({ ...target, connectionId: target.connectionId ?? "pending" });
    if (!passphrase) {
      this.pendingTargetPassphrases.delete(sig);
      return;
    }
    this.pendingTargetPassphrases.set(sig, passphrase);
  }

  promotePendingTargetPassphrase(
    target: Omit<SshTargetConfig, "connectionId"> & { connectionId?: string },
    connectionId: string,
  ): void {
    const sig = buildTargetSignature({ ...target, connectionId: target.connectionId ?? "pending" });
    const pending = this.pendingTargetPassphrases.get(sig);
    if (pending) {
      this.sessionPassphrases.set(connectionId, pending);
      this.pendingTargetPassphrases.delete(sig);
    }
  }

  clearPendingTargetPassphrase(
    target: Omit<SshTargetConfig, "connectionId"> & { connectionId?: string },
  ): void {
    const sig = buildTargetSignature({ ...target, connectionId: target.connectionId ?? "pending" });
    this.pendingTargetPassphrases.delete(sig);
  }

  clearSessionPassphrase(connectionId: string): void {
    this.sessionPassphrases.delete(connectionId);
  }

  hasSessionPassphrase(connectionId: string): boolean {
    return this.sessionPassphrases.has(connectionId);
  }

  private getEffectivePassphrase(
    target: SshTargetConfig,
    overridePassphrase?: string,
  ): string | undefined {
    if (overridePassphrase) return overridePassphrase;
    const byId = this.sessionPassphrases.get(target.connectionId);
    if (byId) return byId;
    return this.pendingTargetPassphrases.get(buildTargetSignature(target));
  }

  private createSingleUseTicketHandle(
    rawTicket: string,
    expiresInSeconds: number,
  ): { expiresAt: number; consumeTicket: () => string | null } {
    const ttl =
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Math.min(expiresInSeconds, DEFAULT_TICKET_TTL_SECONDS)
        : DEFAULT_TICKET_TTL_SECONDS;
    const expiresAt = this.ports.now() + ttl * 1000;
    let ticket: string | null = rawTicket;
    return {
      expiresAt,
      consumeTicket: () => {
        if (!ticket) return null;
        if (this.ports.now() >= expiresAt) {
          ticket = null;
          return null;
        }
        const value = ticket;
        ticket = null;
        return value;
      },
    };
  }

  private async buildHostKeyFailure(
    target: SshTargetConfig,
    failureCode: "host_key_unknown" | "host_key_changed",
  ): Promise<Extract<SshPrepareDialResult, { ok: false }>> {
    const targetSig = buildTargetSignature(target);
    if (failureCode === "host_key_changed") {
      this.hardBlockedTargets.add(targetSig);
      return {
        ok: false,
        failureCode: "host_key_changed",
        status: "blocked",
        message: getSshFailureCopy("host_key_changed"),
        actions: ["edit_target"],
      };
    }

    const hostDisplay = formatSshHostDisplay(target.host, target.port);
    const scanned = await this.ports.scanHostKey({ host: target.host, port: target.port });
    const challenge = scanned
      ? await this.ports.computeHostKeyFingerprint(scanned, hostDisplay)
      : null;

    return {
      ok: false,
      failureCode: "host_key_unknown",
      status: "blocked",
      message: getSshFailureCopy("host_key_unknown"),
      ...(challenge ? { hostKeyChallenge: challenge } : {}),
      actions: ["confirm_host_key", "edit_target", "retry"],
    };
  }

  private async probeRemote(
    target: SshTargetConfig,
    passphrase?: string,
  ): Promise<
    | {
        ok: true;
        mode: SshTransportMode;
        legacyNotice: boolean;
        windowsServiceSession: boolean;
        remotePort?: number;
      }
    | Extract<SshPrepareDialResult, { ok: false }>
  > {
    const remoteCommand = buildRemoteHermesShellCommand({
      remoteHermesPath: target.remoteHermesPath,
      remoteProfile: target.remoteProfile,
      args: ["gateway", "tickets", "--probe", "--json"],
    });
    const args = buildSshCommandArgs({
      host: target.host,
      user: target.user,
      port: target.port,
      keyPath: target.keyPath,
      knownHostsPath: this.ports.knownHostsPath,
      useAskpass: Boolean(passphrase),
      remoteCommand,
    });

    const res = await this.ports.runSshCommand(args, {
      timeoutMs: SSH_COMMAND_TIMEOUT_MS,
      passphrase,
    });

    const targetSig = buildTargetSignature(target);
    if (res.stderr.trim()) {
      const stderrCode = classifySshStderr(res.stderr);
      if (stderrCode === "host_key_changed" || stderrCode === "host_key_unknown") {
        return this.buildHostKeyFailure(target, stderrCode);
      }
      if (stderrCode === "ssh_auth_failed") {
        return {
          ok: false,
          failureCode: "ssh_auth_failed",
          status: "failed",
          message: getSshFailureCopy("ssh_auth_failed"),
          actions: ["edit_target", "retry"],
        };
      }
      if (res.timedOut || stderrCode === "ssh_timeout") {
        return {
          ok: false,
          failureCode: "ssh_timeout",
          status: "failed",
          message: getSshFailureCopy("ssh_timeout"),
          actions: ["edit_target", "retry"],
        };
      }
    }

    if (res.timedOut) {
      return {
        ok: false,
        failureCode: "ssh_timeout",
        status: "failed",
        message: getSshFailureCopy("ssh_timeout"),
        actions: ["edit_target", "retry"],
      };
    }

    const parsed = parseSshProbeOutput(res.stdout, res.exitCode, res.stderr);
    if (parsed.kind === "remote_hermes_not_found") {
      return {
        ok: false,
        failureCode: "remote_hermes_not_found",
        status: "failed",
        message: getSshFailureCopy("remote_hermes_not_found"),
        actions: ["edit_target", "retry"],
      };
    }

    if (parsed.kind === "legacy_attach_only") {
      if (this.modernConfirmedTargets.has(targetSig)) {
        return {
          ok: false,
          failureCode: "protocol_unsupported",
          status: "failed",
          message: getSshFailureCopy("protocol_unsupported"),
          actions: ["edit_target", "retry"],
        };
      }
      return {
        ok: true,
        mode: "attach_only",
        legacyNotice: true,
        windowsServiceSession: false,
      };
    }

    if (parsed.kind === "failure") {
      const canOfferLegacy =
        !this.modernConfirmedTargets.has(targetSig) && parsed.code === "protocol_unsupported";
      if ((target.preferLegacyAttach || this.legacyOptInTargets.has(targetSig)) && canOfferLegacy) {
        this.legacyOptInTargets.add(targetSig);
        return {
          ok: true,
          mode: "attach_only",
          legacyNotice: true,
          windowsServiceSession: false,
        };
      }
      return {
        ok: false,
        failureCode: parsed.code,
        status: "failed",
        message: getSshFailureCopy(parsed.code),
        actions: canOfferLegacy
          ? ["edit_target", "retry", "legacy_attach"]
          : ["edit_target", "retry"],
      };
    }

    // Modern tickets --probe succeeded!
    this.hardBlockedTargets.delete(targetSig);
    if (parsed.supportsInteractive) {
      this.legacyOptInTargets.delete(targetSig);
      this.modernConfirmedTargets.add(targetSig);
      return {
        ok: true,
        mode: "tickets_serve",
        legacyNotice: false,
        windowsServiceSession: parsed.windowsServiceSession,
        ...(parsed.remotePort ? { remotePort: parsed.remotePort } : {}),
      };
    }

    // Modern probe without interactive purpose -> attach-only unless modern interactive was previously confirmed
    if (this.modernConfirmedTargets.has(targetSig)) {
      return {
        ok: false,
        failureCode: "protocol_unsupported",
        status: "failed",
        message: getSshFailureCopy("protocol_unsupported"),
        actions: ["edit_target", "retry"],
      };
    }

    return {
      ok: true,
      mode: "attach_only",
      legacyNotice: true,
      windowsServiceSession: parsed.windowsServiceSession,
      ...(parsed.remotePort ? { remotePort: parsed.remotePort } : {}),
    };
  }

  async testConnection(
    target: SshTargetConfig,
    options?: { passphrase?: string },
  ): Promise<ConnectionTestResult> {
    const sshTargetDisplay = formatSshTargetDisplay(target);
    const validation = validateSshTargetInput(target);
    if (!validation.valid) {
      return {
        ok: false,
        kind: "ssh",
        status: "failed",
        failureCode: "ssh_unreachable",
        message: validation.reason,
        actions: ["edit_target", "retry"],
        sshTargetDisplay,
      };
    }

    const passphrase = this.getEffectivePassphrase(target, options?.passphrase);
    const probe = await this.probeRemote(target, passphrase);
    if (!probe.ok) {
      return {
        ok: false,
        kind: "ssh",
        status: probe.status,
        failureCode: probe.failureCode,
        message: probe.message,
        ...(probe.hostKeyChallenge ? { hostKeyChallenge: probe.hostKeyChallenge } : {}),
        actions: probe.actions,
        sshTargetDisplay,
      };
    }

    return {
      ok: true,
      kind: "ssh",
      status: "ready",
      sshMode: probe.mode,
      legacyNotice: probe.legacyNotice,
      windowsServiceSession: probe.windowsServiceSession,
      message:
        probe.mode === "tickets_serve"
          ? getCopy("gateways.testPassedModern")
          : getCopy("gateways.testPassedLegacy"),
      actions: [],
      sshTargetDisplay,
    };
  }

  async confirmHostKey(
    target: SshTargetConfig,
    options?: { passphrase?: string },
  ): Promise<SshHostKeyConfirmResult> {
    const sshTargetDisplay = formatSshTargetDisplay(target);
    const targetSig = buildTargetSignature(target);

    // Hard block changed host keys (never allow in-app bypass)
    if (this.hardBlockedTargets.has(targetSig)) {
      return {
        confirmed: false,
        cancelled: false,
        hardBlocked: true,
        sshTargetDisplay,
        message: getSshFailureCopy("host_key_changed"),
      };
    }

    // Also probe SSH once to ensure a fresh manager instance still detects changed host keys
    const passphrase = this.getEffectivePassphrase(target, options?.passphrase);
    const verifyRes = await this.ports.runSshCommand(
      buildSshCommandArgs({
        host: target.host,
        user: target.user,
        port: target.port,
        keyPath: target.keyPath,
        knownHostsPath: this.ports.knownHostsPath,
        useAskpass: Boolean(passphrase),
        remoteCommand: "true",
      }),
      { timeoutMs: 8_000, passphrase },
    );
    if (verifyRes.stderr && classifySshStderr(verifyRes.stderr) === "host_key_changed") {
      this.hardBlockedTargets.add(targetSig);
      return {
        confirmed: false,
        cancelled: false,
        hardBlocked: true,
        sshTargetDisplay,
        message: getSshFailureCopy("host_key_changed"),
      };
    }

    const hostDisplay = formatSshHostDisplay(target.host, target.port);
    const scanned = await this.ports.scanHostKey({ host: target.host, port: target.port });
    if (!scanned) {
      return {
        confirmed: false,
        cancelled: false,
        hardBlocked: false,
        sshTargetDisplay,
        message: getSshFailureCopy("ssh_unreachable"),
      };
    }

    const challenge = (await this.ports.computeHostKeyFingerprint(scanned, hostDisplay)) ?? {
      hostDisplay,
      keyType: "SSH",
      fingerprint: scanned,
    };

    const accepted = await this.ports.confirmHostKeyPrompt(challenge);
    if (!accepted) {
      return {
        confirmed: false,
        cancelled: true,
        hardBlocked: false,
        sshTargetDisplay,
      };
    }

    await this.ports.appendKnownHost(scanned);
    return {
      confirmed: true,
      cancelled: false,
      hardBlocked: false,
      sshTargetDisplay,
    };
  }

  private async startLoopbackTunnel(
    target: SshTargetConfig,
    remotePort: number,
    passphrase?: string,
  ): Promise<
    | { ok: true; tunnelProc: SshStreamProcess; localPort: number }
    | { ok: false; failureCode: SshFailureCode; message: string }
  > {
    const localPort = await this.ports.allocateLocalPort();
    const tunnelArgs = buildSshCommandArgs({
      host: target.host,
      user: target.user,
      port: target.port,
      keyPath: target.keyPath,
      knownHostsPath: this.ports.knownHostsPath,
      useAskpass: Boolean(passphrase),
      forward: { localPort, remotePort },
    });

    const tunnelProc = this.ports.spawnSshStream(tunnelArgs, { passphrase });
    let stderrText = "";
    const unsubErr = tunnelProc.onStderr((chunk) => {
      stderrText += chunk;
    });

    const ready = await this.ports.waitForLocalPort(
      localPort,
      SSH_TUNNEL_READY_TIMEOUT_MS,
      () => tunnelProc.isAlive(),
    );
    unsubErr();

    if (!ready) {
      tunnelProc.kill();
      const stderrCode = stderrText.trim() ? classifySshStderr(stderrText) : "tunnel_failed";
      const failureCode: SshFailureCode =
        stderrCode === "host_key_changed" ||
        stderrCode === "host_key_unknown" ||
        stderrCode === "ssh_auth_failed"
          ? stderrCode
          : "tunnel_failed";
      return {
        ok: false,
        failureCode,
        message: getSshFailureCopy(failureCode),
      };
    }

    tunnelProc.markAuthSettled();
    return { ok: true, tunnelProc, localPort };
  }

  private async startModernSession(
    target: SshTargetConfig,
    passphrase: string | undefined,
    windowsServiceSession: boolean,
    initialRemotePort?: number,
  ): Promise<
    | { ok: true; session: ActiveModernSession }
    | Extract<SshPrepareDialResult, { ok: false }>
  > {
    const serveRemoteCommand = buildRemoteHermesShellCommand({
      remoteHermesPath: target.remoteHermesPath,
      remoteProfile: target.remoteProfile,
      args: ["gateway", "tickets", "--serve"],
    });
    const serveArgs = buildSshCommandArgs({
      host: target.host,
      user: target.user,
      port: target.port,
      keyPath: target.keyPath,
      knownHostsPath: this.ports.knownHostsPath,
      useAskpass: Boolean(passphrase),
      remoteCommand: serveRemoteCommand,
    });

    const serveProc = this.ports.spawnSshStream(serveArgs, { passphrase });

    let readyPort = initialRemotePort;
    let stderrBuf = "";
    const readyResult = await new Promise<
      | { ok: true; remotePort?: number }
      | { ok: false; code: SshFailureCode }
    >((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubLine();
        unsubErr();
        unsubExit();
        resolve({ ok: false, code: "ssh_timeout" });
      }, SSH_SERVE_READY_TIMEOUT_MS);

      const finish = (
        val: { ok: true; remotePort?: number } | { ok: false; code: SshFailureCode },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubLine();
        unsubErr();
        unsubExit();
        resolve(val);
      };

      const unsubErr = serveProc.onStderr((chunk) => {
        stderrBuf += chunk;
      });

      const unsubLine = serveProc.onLine((line) => {
        const parsed = parseSshServeLine(line);
        if (parsed.kind === "ready") {
          finish({ ok: true, remotePort: parsed.remotePort });
        } else if (parsed.kind === "error") {
          finish({
            ok: false,
            code: parsed.code === "protocol_unsupported" ? "protocol_unsupported" : "ticket_unavailable",
          });
        }
      });

      const unsubExit = serveProc.onExit(() => {
        const stderrCode = stderrBuf.trim() ? classifySshStderr(stderrBuf) : "ticket_unavailable";
        finish({ ok: false, code: stderrCode });
      });
    });

    if (!readyResult.ok) {
      serveProc.kill();
      if (readyResult.code === "host_key_changed" || readyResult.code === "host_key_unknown") {
        return this.buildHostKeyFailure(target, readyResult.code);
      }
      return {
        ok: false,
        failureCode: readyResult.code,
        status: "failed",
        message: getSshFailureCopy(readyResult.code),
        actions: ["edit_target", "retry"],
      };
    }

    serveProc.markAuthSettled();
    readyPort = readyResult.remotePort ?? initialRemotePort;
    if (!readyPort) {
      serveProc.kill();
      return {
        ok: false,
        failureCode: "protocol_unsupported",
        status: "failed",
        message: getSshFailureCopy("protocol_unsupported"),
        actions: ["edit_target", "retry"],
      };
    }

    const tunnel = await this.startLoopbackTunnel(target, readyPort, passphrase);
    if (!tunnel.ok) {
      serveProc.kill();
      if (tunnel.failureCode === "host_key_changed" || tunnel.failureCode === "host_key_unknown") {
        return this.buildHostKeyFailure(target, tunnel.failureCode);
      }
      return {
        ok: false,
        failureCode: tunnel.failureCode,
        status: "failed",
        message: tunnel.message,
        actions: ["edit_target", "retry"],
      };
    }

    const session: ActiveModernSession = {
      mode: "tickets_serve",
      targetSignature: buildTargetSignature(target),
      serveProc,
      tunnelProc: tunnel.tunnelProc,
      localPort: tunnel.localPort,
      remotePort: readyPort,
      windowsServiceSession,
      mintChain: Promise.resolve(),
    };
    this.modernSessions.set(target.connectionId, session);
    return { ok: true, session };
  }

  private async requestTicketFromServe(
    session: ActiveModernSession,
    profileId: string,
  ): Promise<
    | {
        ok: true;
        ticket: string;
        expiresInSeconds: number;
        endpoint: Extract<ReturnType<typeof parseEnsureOrAttachOutput>, { kind: "ready" }>["endpoint"];
      }
    | { ok: false; code: "ticket_unavailable" | "protocol_unsupported" | "profile_unavailable" }
  > {
    if (!session.serveProc.isAlive() || !session.tunnelProc.isAlive()) {
      return { ok: false, code: "ticket_unavailable" };
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubLine();
        unsubExit();
        resolve({ ok: false, code: "ticket_unavailable" });
      }, SSH_TICKET_TIMEOUT_MS);

      const finish = (
        val:
          | {
              ok: true;
              ticket: string;
              expiresInSeconds: number;
              endpoint: Extract<ReturnType<typeof parseEnsureOrAttachOutput>, { kind: "ready" }>["endpoint"];
            }
          | { ok: false; code: "ticket_unavailable" | "protocol_unsupported" | "profile_unavailable" },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubLine();
        unsubExit();
        resolve(val);
      };

      const unsubLine = session.serveProc.onLine((line) => {
        const parsed = parseSshServeLine(line);
        if (parsed.kind === "ticket") {
          finish({
            ok: true,
            ticket: parsed.ticket,
            expiresInSeconds: parsed.expiresInSeconds,
            endpoint: parsed.endpoint,
          });
        } else if (parsed.kind === "error") {
          finish({ ok: false, code: parsed.code });
        }
      });

      const unsubExit = session.serveProc.onExit(() => {
        finish({ ok: false, code: "ticket_unavailable" });
      });

      session.serveProc.writeLine(JSON.stringify({ profile_id: profileId }));
    });
  }

  private enqueueServeMint(
    session: ActiveModernSession,
    profileId: string,
  ): Promise<
    | {
        ok: true;
        ticket: string;
        expiresInSeconds: number;
        endpoint: Extract<ReturnType<typeof parseEnsureOrAttachOutput>, { kind: "ready" }>["endpoint"];
      }
    | { ok: false; code: "ticket_unavailable" | "protocol_unsupported" | "profile_unavailable" }
  > {
    const run = session.mintChain.then(() => this.requestTicketFromServe(session, profileId));
    session.mintChain = run.catch(() => undefined);
    return run;
  }

  private disposeModernSession(connectionId: string): void {
    const existing = this.modernSessions.get(connectionId);
    if (!existing) return;
    this.modernSessions.delete(connectionId);
    existing.serveProc.kill();
    existing.tunnelProc.kill();
  }

  private async prepareLegacyAttachDial(
    target: SshTargetConfig,
    profileId: string,
    passphrase: string | undefined,
    windowsServiceSession: boolean,
  ): Promise<SshPrepareDialResult> {
    const effectiveProfile =
      profileId !== "default" ? profileId : target.remoteProfile?.trim() || "default";
    // NEVER emit --start on attach-only or Windows Session 0
    const remoteCommand = buildRemoteHermesShellCommand({
      remoteHermesPath: target.remoteHermesPath,
      remoteProfile: effectiveProfile,
      args: ["gateway", "attach", "--json"],
    });
    const attachArgs = buildSshCommandArgs({
      host: target.host,
      user: target.user,
      port: target.port,
      keyPath: target.keyPath,
      knownHostsPath: this.ports.knownHostsPath,
      useAskpass: Boolean(passphrase),
      remoteCommand,
    });

    const attachRes = await this.ports.runSshCommand(attachArgs, {
      timeoutMs: SSH_COMMAND_TIMEOUT_MS,
      passphrase,
    });

    if (attachRes.stderr.trim()) {
      const stderrCode = classifySshStderr(attachRes.stderr);
      if (stderrCode === "host_key_changed" || stderrCode === "host_key_unknown") {
        return this.buildHostKeyFailure(target, stderrCode);
      }
      if (stderrCode === "ssh_auth_failed") {
        return {
          ok: false,
          failureCode: "ssh_auth_failed",
          status: "failed",
          message: getSshFailureCopy("ssh_auth_failed"),
          actions: ["edit_target", "retry"],
        };
      }
    }

    const parsed = parseEnsureOrAttachOutput(attachRes.stdout, attachRes.exitCode);
    if (parsed.kind !== "ready" || !parsed.ticket) {
      const failureCode: SshFailureCode =
        parsed.kind === "failure" && parsed.code === "protocol_unsupported"
          ? "protocol_unsupported"
          : "ticket_unavailable";
      return {
        ok: false,
        failureCode,
        status: "failed",
        message: getSshFailureCopy(failureCode),
        actions: ["edit_target", "retry"],
      };
    }

    const protoCheck = validateEndpointProtocol({
      runtimeProtocol: parsed.endpoint.runtimeProtocol,
      capabilities: parsed.endpoint.capabilities,
      wsUrl: parsed.endpoint.wsUrl,
    });
    if (!protoCheck.valid) {
      return {
        ok: false,
        failureCode: "protocol_unsupported",
        status: "failed",
        message: getSshFailureCopy("protocol_unsupported"),
        actions: ["edit_target", "retry"],
      };
    }

    const remotePort = extractRemotePortFromWsUrl(parsed.endpoint.wsUrl);
    if (!remotePort) {
      return {
        ok: false,
        failureCode: "tunnel_failed",
        status: "failed",
        message: getSshFailureCopy("tunnel_failed"),
        actions: ["edit_target", "retry"],
      };
    }

    const tunnelKey = `${target.connectionId}::${profileId}`;
    const existingTunnel = this.legacyTunnels.get(tunnelKey);
    let localPort: number;
    if (
      existingTunnel &&
      existingTunnel.tunnelProc.isAlive() &&
      existingTunnel.remotePort === remotePort
    ) {
      localPort = existingTunnel.localPort;
    } else {
      if (existingTunnel) {
        existingTunnel.tunnelProc.kill();
        this.legacyTunnels.delete(tunnelKey);
      }
      const tunnel = await this.startLoopbackTunnel(target, remotePort, passphrase);
      if (!tunnel.ok) {
        return {
          ok: false,
          failureCode: tunnel.failureCode,
          status: "failed",
          message: tunnel.message,
          actions: ["edit_target", "retry"],
        };
      }
      this.legacyTunnels.set(tunnelKey, {
        tunnelProc: tunnel.tunnelProc,
        localPort: tunnel.localPort,
        remotePort,
      });
      localPort = tunnel.localPort;
    }

    const handle = this.createSingleUseTicketHandle(
      parsed.ticket,
      parsed.expiresInSeconds ?? DEFAULT_TICKET_TTL_SECONDS,
    );

    return {
      ok: true,
      sshMode: "attach_only",
      legacyNotice: true,
      windowsServiceSession,
      dial: {
        connectionId: target.connectionId,
        profileId,
        instanceId: parsed.endpoint.instanceId,
        authorityEpoch: parsed.endpoint.authorityEpoch,
        wsUrl: rewriteForwardedWsUrl(parsed.endpoint.wsUrl, localPort),
        wsProtocol: parsed.endpoint.wsProtocol || GATEWAY_WS_PROTOCOL,
        ticketProtocolPrefix: parsed.endpoint.ticketProtocolPrefix || GATEWAY_TICKET_PREFIX,
        transportMode: "per-profile",
        endpointCapabilities: parsed.endpoint.capabilities,
        codeSha: parsed.endpoint.codeSha,
        expiresAt: handle.expiresAt,
        consumeTicket: handle.consumeTicket,
      },
    };
  }

  async prepareDial(
    target: SshTargetConfig,
    profileId = "default",
    options?: { passphrase?: string },
  ): Promise<SshPrepareDialResult> {
    if (this.disposed) {
      return {
        ok: false,
        failureCode: "ssh_unreachable",
        status: "failed",
        message: getSshFailureCopy("ssh_unreachable"),
        actions: ["retry"],
      };
    }

    const validation = validateSshTargetInput(target);
    if (!validation.valid) {
      return {
        ok: false,
        failureCode: "ssh_unreachable",
        status: "failed",
        message: validation.reason ?? getSshFailureCopy("ssh_unreachable"),
        actions: ["edit_target"],
      };
    }

    const passphrase = this.getEffectivePassphrase(target, options?.passphrase);
    const targetSig = buildTargetSignature(target);

    // Reuse healthy modern serve + tunnel if already active for same target
    const existingModern = this.modernSessions.get(target.connectionId);
    if (
      existingModern &&
      existingModern.targetSignature === targetSig &&
      existingModern.serveProc.isAlive() &&
      existingModern.tunnelProc.isAlive()
    ) {
      const minted = await this.enqueueServeMint(existingModern, profileId);
      if (minted.ok) {
        const handle = this.createSingleUseTicketHandle(minted.ticket, minted.expiresInSeconds);
        return {
          ok: true,
          sshMode: "tickets_serve",
          legacyNotice: false,
          windowsServiceSession: existingModern.windowsServiceSession,
          dial: {
            connectionId: target.connectionId,
            profileId: minted.endpoint.profileId || profileId,
            instanceId: minted.endpoint.instanceId,
            authorityEpoch: minted.endpoint.authorityEpoch,
            wsUrl: rewriteForwardedWsUrl(minted.endpoint.wsUrl, existingModern.localPort),
            wsProtocol: minted.endpoint.wsProtocol || GATEWAY_WS_PROTOCOL,
            ticketProtocolPrefix:
              minted.endpoint.ticketProtocolPrefix || GATEWAY_TICKET_PREFIX,
            transportMode: "shared-host-scope",
            endpointCapabilities: minted.endpoint.capabilities,
            codeSha: minted.endpoint.codeSha,
            expiresAt: handle.expiresAt,
            consumeTicket: handle.consumeTicket,
          },
        };
      }
      this.disposeModernSession(target.connectionId);
    } else if (existingModern) {
      this.disposeModernSession(target.connectionId);
    }

    // Run tickets --probe once on activation
    const probe = await this.probeRemote(target, passphrase);
    if (!probe.ok) {
      return probe;
    }

    if (probe.mode === "attach_only") {
      if (this.modernConfirmedTargets.has(targetSig)) {
        return {
          ok: false,
          failureCode: "protocol_unsupported",
          status: "failed",
          message: getSshFailureCopy("protocol_unsupported"),
          actions: ["edit_target", "retry"],
        };
      }
      return this.prepareLegacyAttachDial(
        target,
        profileId,
        passphrase,
        probe.windowsServiceSession,
      );
    }

    // Modern tickets --serve + loopback tunnel
    const started = await this.startModernSession(
      target,
      passphrase,
      probe.windowsServiceSession,
      probe.remotePort,
    );
    if (!started.ok) {
      return started;
    }

    const minted = await this.enqueueServeMint(started.session, profileId);
    if (!minted.ok) {
      this.disposeModernSession(target.connectionId);
      const failureCode: SshFailureCode =
        minted.code === "protocol_unsupported" ? "protocol_unsupported" : "ticket_unavailable";
      return {
        ok: false,
        failureCode,
        status: "failed",
        message: getSshFailureCopy(failureCode),
        actions: ["edit_target", "retry"],
      };
    }

    const protoCheck = validateEndpointProtocol({
      runtimeProtocol: minted.endpoint.runtimeProtocol,
      capabilities: minted.endpoint.capabilities,
      wsUrl: minted.endpoint.wsUrl,
    });
    if (!protoCheck.valid) {
      this.disposeModernSession(target.connectionId);
      return {
        ok: false,
        failureCode: "protocol_unsupported",
        status: "failed",
        message: getSshFailureCopy("protocol_unsupported"),
        actions: ["edit_target", "retry"],
      };
    }

    const handle = this.createSingleUseTicketHandle(minted.ticket, minted.expiresInSeconds);
    return {
      ok: true,
      sshMode: "tickets_serve",
      legacyNotice: false,
      windowsServiceSession: probe.windowsServiceSession,
      dial: {
        connectionId: target.connectionId,
        profileId: minted.endpoint.profileId || profileId,
        instanceId: minted.endpoint.instanceId,
        authorityEpoch: minted.endpoint.authorityEpoch,
        wsUrl: rewriteForwardedWsUrl(minted.endpoint.wsUrl, started.session.localPort),
        wsProtocol: minted.endpoint.wsProtocol || GATEWAY_WS_PROTOCOL,
        ticketProtocolPrefix:
          minted.endpoint.ticketProtocolPrefix || GATEWAY_TICKET_PREFIX,
        transportMode: "shared-host-scope",
        endpointCapabilities: minted.endpoint.capabilities,
        codeSha: minted.endpoint.codeSha,
        expiresAt: handle.expiresAt,
        consumeTicket: handle.consumeTicket,
      },
    };
  }

  async mintReconnectTicket(
    connectionId: string,
    target: SshTargetConfig,
    profileId = "default",
    _expectedInstanceId?: string,
  ): Promise<SshMintTicketResult> {
    if (this.disposed) {
      return {
        ok: false,
        failureCode: "ssh_unreachable",
        message: getSshFailureCopy("ssh_unreachable"),
      };
    }

    const passphrase = this.getEffectivePassphrase(target);
    const targetSig = buildTargetSignature(target);
    const existingModern = this.modernSessions.get(connectionId);

    // 1. If serve + tunnel are healthy, mint from existing serve without restarting tunnel/serve
    if (
      existingModern &&
      existingModern.targetSignature === targetSig &&
      existingModern.serveProc.isAlive() &&
      existingModern.tunnelProc.isAlive()
    ) {
      const minted = await this.enqueueServeMint(existingModern, profileId);
      if (minted.ok) {
        const handle = this.createSingleUseTicketHandle(minted.ticket, minted.expiresInSeconds);
        return {
          ok: true,
          wsUrl: rewriteForwardedWsUrl(minted.endpoint.wsUrl, existingModern.localPort),
          expiresAt: handle.expiresAt,
          consumeTicket: handle.consumeTicket,
        };
      }
      // Serve failed (ticket_unavailable / EOF) -> tear down and restart serve + tunnel ONLY (never attach-only!)
      this.disposeModernSession(connectionId);
      // Small yield to let exit handlers settle
      await sleep(10);
      const restarted = await this.startModernSession(
        target,
        passphrase,
        existingModern.windowsServiceSession,
        existingModern.remotePort,
      );
      if (!restarted.ok) {
        return {
          ok: false,
          failureCode: restarted.failureCode,
          message: restarted.message,
        };
      }
      const retriedMint = await this.enqueueServeMint(restarted.session, profileId);
      if (!retriedMint.ok) {
        this.disposeModernSession(connectionId);
        return {
          ok: false,
          failureCode:
            retriedMint.code === "protocol_unsupported"
              ? "protocol_unsupported"
              : "ticket_unavailable",
          message: getSshFailureCopy("ticket_unavailable"),
        };
      }
      const handle = this.createSingleUseTicketHandle(
        retriedMint.ticket,
        retriedMint.expiresInSeconds,
      );
      return {
        ok: true,
        wsUrl: rewriteForwardedWsUrl(retriedMint.endpoint.wsUrl, restarted.session.localPort),
        expiresAt: handle.expiresAt,
        consumeTicket: handle.consumeTicket,
      };
    }

    // 2. If modern was previously confirmed (e.g. tunnel exited), restart modern serve + tunnel ONLY (never fall back!)
    if (this.modernConfirmedTargets.has(targetSig)) {
      this.disposeModernSession(connectionId);
      const probe = await this.probeRemote(target, passphrase);
      if (!probe.ok || probe.mode !== "tickets_serve") {
        return {
          ok: false,
          failureCode: !probe.ok ? probe.failureCode : "protocol_unsupported",
          message: !probe.ok ? probe.message : getSshFailureCopy("protocol_unsupported"),
        };
      }
      const restarted = await this.startModernSession(
        target,
        passphrase,
        probe.windowsServiceSession,
        probe.remotePort,
      );
      if (!restarted.ok) {
        return {
          ok: false,
          failureCode: restarted.failureCode,
          message: restarted.message,
        };
      }
      const retriedMint = await this.enqueueServeMint(restarted.session, profileId);
      if (!retriedMint.ok) {
        this.disposeModernSession(connectionId);
        return {
          ok: false,
          failureCode: "ticket_unavailable",
          message: getSshFailureCopy("ticket_unavailable"),
        };
      }
      const handle = this.createSingleUseTicketHandle(
        retriedMint.ticket,
        retriedMint.expiresInSeconds,
      );
      return {
        ok: true,
        wsUrl: rewriteForwardedWsUrl(retriedMint.endpoint.wsUrl, restarted.session.localPort),
        expiresAt: handle.expiresAt,
        consumeTicket: handle.consumeTicket,
      };
    }

    // 3. Legacy attach-only re-mint
    const legacyDial = await this.prepareLegacyAttachDial(target, profileId, passphrase, false);
    if (!legacyDial.ok) {
      return {
        ok: false,
        failureCode: legacyDial.failureCode,
        message: legacyDial.message,
      };
    }
    return {
      ok: true,
      wsUrl: legacyDial.dial.wsUrl,
      expiresAt: legacyDial.dial.expiresAt,
      consumeTicket: legacyDial.dial.consumeTicket,
    };
  }

  async disposeConnection(connectionId: string): Promise<void> {
    this.disposeModernSession(connectionId);
    for (const [key, tunnel] of this.legacyTunnels.entries()) {
      if (key.startsWith(`${connectionId}::`)) {
        tunnel.tunnelProc.kill();
        this.legacyTunnels.delete(key);
      }
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    for (const connectionId of [...this.modernSessions.keys()]) {
      this.disposeModernSession(connectionId);
    }
    for (const [key, tunnel] of this.legacyTunnels.entries()) {
      tunnel.tunnelProc.kill();
      this.legacyTunnels.delete(key);
    }
    this.sessionPassphrases.clear();
    this.pendingTargetPassphrases.clear();
    this.legacyOptInTargets.clear();
  }
}
