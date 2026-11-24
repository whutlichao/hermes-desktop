import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type {
  BridgeEvent,
  BridgeScope,
  ErrorCode,
  ExternalAttribution,
  TerminalCloseResult,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalStatus,
} from "@hermes/contracts";
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  appendTerminalChunk,
  createEmptyTerminalSnapshot,
  createTerminalScrollbackState,
  isScopeMatch,
  makeScopeKey,
  projectTerminalScrollbackLines,
  resolveExternalAttribution,
  getCopy,
  type HostCommandHandler,
  type TerminalScrollbackState,
} from "@hermes/domain";

export interface PtyProcess extends EventEmitter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

const PYTHON_PTY_BRIDGE = `
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios

cols = max(20, int(sys.argv[1]))
rows = max(5, int(sys.argv[2]))
shell_path = sys.argv[3]
shell_args = [shell_path, "-f", "-i"] if shell_path.endswith("zsh") else [shell_path, "-i"]

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def preexec():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

env = dict(os.environ)
env["TERM"] = "xterm-256color"
env["PS1"] = "$ "

proc = subprocess.Popen(
    shell_args,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    preexec_fn=preexec,
    close_fds=True,
    env=env,
)
os.close(slave)

def read_fg_state():
    try:
        fg_pgid = os.tcgetpgrp(master)
        shell_pgid = os.getpgid(proc.pid)
        busy = fg_pgid != shell_pgid
        name = None
        if busy:
            try:
                out = subprocess.check_output(
                    ["ps", "-o", "comm=", "-g", str(fg_pgid)],
                    stderr=subprocess.DEVNULL,
                    timeout=0.1,
                ).decode("utf-8", "replace").strip().splitlines()
                if out:
                    name = os.path.basename(out[0].strip()) or None
            except Exception:
                name = None
        return busy, name
    except Exception:
        return False, None

last_busy = None
last_name = None
ctrl_buf = b""
stdin_fd = 0
ctrl_fd = 3
read_fds = [master, stdin_fd, ctrl_fd]

os.set_blocking(master, False)
os.set_blocking(stdin_fd, False)
os.set_blocking(ctrl_fd, False)

while True:
    busy, pname = read_fg_state()
    if busy != last_busy or (busy and pname != last_name):
        last_busy = busy
        last_name = pname
        payload = {"type": "fg", "busy": busy}
        if pname:
            payload["processName"] = pname
        sys.stderr.write(json.dumps(payload) + "\\n")
        sys.stderr.flush()

    if proc.poll() is not None:
        break

    try:
        rlist, _, _ = select.select(read_fds, [], [], 0.08)
    except InterruptedError:
        continue

    if master in rlist:
        try:
            data = os.read(master, 8192)
            if not data:
                break
            os.write(1, data)
        except OSError:
            break

    if stdin_fd in rlist:
        try:
            data = os.read(stdin_fd, 4096)
            if not data:
                if stdin_fd in read_fds:
                    read_fds.remove(stdin_fd)
            else:
                os.write(master, data)
        except OSError:
            if stdin_fd in read_fds:
                read_fds.remove(stdin_fd)

    if ctrl_fd in rlist:
        try:
            cdata = os.read(ctrl_fd, 4096)
        except OSError:
            cdata = b""
        if not cdata:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                proc.terminate()
            break
        ctrl_buf += cdata
        while b"\\n" in ctrl_buf:
            line, ctrl_buf = ctrl_buf.split(b"\\n", 1)
            if not line.strip():
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            mtype = msg.get("type")
            if mtype == "resize":
                try:
                    r_cols = max(20, int(msg.get("cols", cols)))
                    r_rows = max(5, int(msg.get("rows", rows)))
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r_rows, r_cols, 0, 0))
                    os.killpg(os.tcgetpgrp(master), signal.SIGWINCH)
                except Exception:
                    pass
            elif mtype == "terminate":
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except Exception:
                    proc.terminate()

try:
    os.close(master)
except OSError:
    pass

rc = proc.wait()
sys.exit(rc if rc is not None else 0)
`;

function resolvePythonBinary(): string {
  const candidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function resolveShellBinary(): string {
  const preferred = process.env.SHELL;
  if (preferred && fs.existsSync(preferred)) {
    return preferred;
  }
  if (fs.existsSync("/bin/zsh")) return "/bin/zsh";
  return "/bin/sh";
}

class NodePythonPty extends EventEmitter implements PtyProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ctrlStream: NodeJS.WritableStream;
  private stderrBuf = "";
  private exited = false;

  constructor(options: PtySpawnOptions) {
    super();
    const pythonBin = resolvePythonBinary();
    const shellBin = resolveShellBinary();
    const spawned = spawn(
      pythonBin,
      ["-u", "-c", PYTHON_PTY_BRIDGE, String(options.cols), String(options.rows), shellBin],
      {
        cwd: options.cwd || process.cwd(),
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    this.child = spawned as unknown as ChildProcessWithoutNullStreams;
    this.ctrlStream = spawned.stdio[3] as NodeJS.WritableStream;

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.emit("data", chunk.toString("utf8"));
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
      while (this.stderrBuf.includes("\n")) {
        const nl = this.stderrBuf.indexOf("\n");
        const line = this.stderrBuf.slice(0, nl).trim();
        this.stderrBuf = this.stderrBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            busy?: boolean;
            processName?: string;
          };
          if (parsed.type === "fg") {
            this.emit("foreground", {
              busy: Boolean(parsed.busy),
              processName: typeof parsed.processName === "string" ? parsed.processName : undefined,
            });
          }
        } catch {
          // Ignore non-JSON stderr chatter
        }
      }
    });

    this.child.on("close", (code) => {
      if (this.exited) return;
      this.exited = true;
      this.emit("exit", code ?? 0);
    });

    this.child.on("error", () => {
      if (this.exited) return;
      this.exited = true;
      this.emit("exit", 1);
    });
  }

  write(data: string): void {
    if (this.exited || this.child.stdin.destroyed) return;
    this.child.stdin.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || !this.ctrlStream.writable) return;
    this.ctrlStream.write(`${JSON.stringify({ type: "resize", cols, rows })}\n`);
  }

  kill(): void {
    if (this.exited) return;
    try {
      if (this.ctrlStream.writable) {
        this.ctrlStream.write(`${JSON.stringify({ type: "terminate" })}\n`);
      }
    } catch {
      // Fallback to signal below
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Ignore already exited
    }
  }
}

export function createNodePtyFactory(): PtyFactory {
  return (options) => new NodePythonPty(options);
}

export interface TerminalManagerOptions {
  ptyFactory?: PtyFactory;
  confirmFirstTerminal: (scope: BridgeScope) => Promise<boolean> | boolean;
  confirmGrantRoot: (scope: BridgeScope) => Promise<boolean> | boolean;
  getActiveScope?: () => BridgeScope | null;
  defaultCwd?: string;
  attribution?: ExternalAttribution;
}

interface ScopeTerminalRecord {
  scopeKey: string;
  scope: BridgeScope;
  terminalId: string | null;
  pty: PtyProcess | null;
  status: TerminalStatus;
  cols: number;
  rows: number;
  granted: boolean;
  rootGranted: boolean;
  hasForegroundProcess: boolean;
  foregroundProcessName?: string;
  scrollback: TerminalScrollbackState;
  exitCode: number | null;
  revision: number;
  updatedAt: string;
}

interface ScopeSubscription {
  scopeKey: string;
  seq: number;
  listener: (event: BridgeEvent<TerminalSnapshot>) => void;
}

function createCodedError(code: ErrorCode, message: string): Error & { code: ErrorCode } {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

function normalizeScope(scope?: BridgeScope | null): BridgeScope {
  if (!scope?.connectionId || !scope.connectionId.trim()) {
    throw createCodedError("invalid_request", getCopy("terminal.scopeRequiredError"));
  }
  return {
    connectionId: scope.connectionId.trim(),
    profileId: scope.profileId?.trim() || "default",
  };
}

function clampDims(cols?: unknown, rows?: unknown): { cols: number; rows: number } {
  const parsedCols =
    typeof cols === "number" && Number.isFinite(cols) ? Math.round(cols) : TERMINAL_DEFAULT_COLS;
  const parsedRows =
    typeof rows === "number" && Number.isFinite(rows) ? Math.round(rows) : TERMINAL_DEFAULT_ROWS;
  return {
    cols: Math.min(300, Math.max(20, parsedCols)),
    rows: Math.min(120, Math.max(5, parsedRows)),
  };
}

export class TerminalManager {
  private readonly ptyFactory: PtyFactory;
  private readonly confirmFirstTerminal: TerminalManagerOptions["confirmFirstTerminal"];
  private readonly confirmGrantRoot: TerminalManagerOptions["confirmGrantRoot"];
  private readonly getActiveScope?: () => BridgeScope | null;
  private readonly defaultCwd?: string;
  private readonly attribution: ExternalAttribution;
  private readonly records = new Map<string, ScopeTerminalRecord>();
  private readonly terminalIdToScopeKey = new Map<string, string>();
  private readonly subscriptions = new Set<ScopeSubscription>();
  private disposed = false;

  constructor(options: TerminalManagerOptions) {
    this.ptyFactory = options.ptyFactory ?? createNodePtyFactory();
    this.confirmFirstTerminal = options.confirmFirstTerminal;
    this.confirmGrantRoot = options.confirmGrantRoot;
    this.getActiveScope = options.getActiveScope;
    this.defaultCwd = options.defaultCwd;
    this.attribution = options.attribution ?? resolveExternalAttribution({ source: "bundled" });
  }

  private assertScopeActive(scope: BridgeScope): BridgeScope {
    const normalized = normalizeScope(scope);
    if (this.getActiveScope) {
      const active = this.getActiveScope();
      if (!active || !isScopeMatch(active, normalized)) {
        throw createCodedError("scope_mismatch", getCopy("terminal.scopeMismatchError"));
      }
    }
    return normalized;
  }

  private getOrCreateRecord(scope: BridgeScope): ScopeTerminalRecord {
    const key = makeScopeKey(scope.connectionId, scope.profileId ?? "default");
    let rec = this.records.get(key);
    if (!rec) {
      rec = {
        scopeKey: key,
        scope: { ...scope },
        terminalId: null,
        pty: null,
        status: "idle",
        cols: TERMINAL_DEFAULT_COLS,
        rows: TERMINAL_DEFAULT_ROWS,
        granted: false,
        rootGranted: false,
        hasForegroundProcess: false,
        scrollback: createTerminalScrollbackState(),
        exitCode: null,
        revision: 0,
        updatedAt: new Date().toISOString(),
      };
      this.records.set(key, rec);
    }
    return rec;
  }

  private toSnapshot(rec: ScopeTerminalRecord): TerminalSnapshot {
    const lines = projectTerminalScrollbackLines(rec.scrollback);
    return {
      terminalId: rec.terminalId,
      scope: { ...rec.scope },
      status: rec.status,
      cols: rec.cols,
      rows: rec.rows,
      granted: rec.granted,
      rootGranted: rec.rootGranted,
      hasForegroundProcess: rec.hasForegroundProcess,
      ...(rec.foregroundProcessName ? { foregroundProcessName: rec.foregroundProcessName } : {}),
      lines,
      trimmedOldest: rec.scrollback.trimmedOldest,
      totalBytes: rec.scrollback.totalBytes,
      lineCount: lines.length,
      exitCode: rec.exitCode,
      attribution: this.attribution,
      updatedAt: rec.updatedAt,
    };
  }

  private emitSnapshot(rec: ScopeTerminalRecord, kind: "snapshot" | "patch" = "patch"): void {
    if (this.disposed) return;
    rec.revision += 1;
    rec.updatedAt = new Date().toISOString();
    const snapshot = this.toSnapshot(rec);
    for (const sub of this.subscriptions) {
      if (sub.scopeKey !== rec.scopeKey) continue;
      sub.seq += 1;
      sub.listener({
        topic: "terminal",
        scope: { ...rec.scope },
        kind,
        seq: sub.seq,
        revision: rec.revision,
        payload: snapshot,
      });
    }
  }

  private assertTerminalBinding(rec: ScopeTerminalRecord, suppliedId?: unknown): void {
    if (typeof suppliedId === "string" && suppliedId.trim() !== "") {
      const targetId = suppliedId.trim();
      const ownerScope = this.terminalIdToScopeKey.get(targetId);
      if (ownerScope && ownerScope !== rec.scopeKey) {
        throw createCodedError("scope_mismatch", getCopy("terminal.foreignBindingError"));
      }
      if (rec.terminalId && rec.terminalId !== targetId) {
        throw createCodedError("not_found", getCopy("terminal.bindingMissingError"));
      }
    }
  }

  getSnapshot(scope: BridgeScope | null | undefined): TerminalSnapshot {
    const normalized = normalizeScope(scope);
    const key = makeScopeKey(normalized.connectionId, normalized.profileId ?? "default");
    const rec = this.records.get(key);
    if (!rec) {
      return createEmptyTerminalSnapshot(normalized, { attribution: this.attribution });
    }
    return this.toSnapshot(rec);
  }

  async open(
    scope: BridgeScope | null | undefined,
    payload: {
      cols?: unknown;
      rows?: unknown;
      mode?: unknown;
      grantRoot?: unknown;
    } = {},
  ): Promise<TerminalOpenResult> {
    const normalized = this.assertScopeActive(normalizeScope(scope));
    const rec = this.getOrCreateRecord(normalized);
    const dims = clampDims(payload.cols, payload.rows);
    const mode =
      payload.mode === "new" || payload.mode === "grant_root" ? payload.mode : "open";
    const wantGrantRoot = Boolean(payload.grantRoot) || mode === "grant_root";

    // If PTY already ended and caller did not explicitly request "new" or "grant_root",
    // stay ended until explicit "新建 Terminal".
    if (rec.status === "ended" && mode === "open" && !wantGrantRoot) {
      return {
        ok: false,
        granted: rec.granted,
        snapshot: this.toSnapshot(rec),
      };
    }

    // Re-attach if PTY is running or detached (unless explicitly requesting root grant)
    if ((rec.status === "running" || rec.status === "detached") && rec.pty) {
      if (wantGrantRoot && !rec.rootGranted) {
        const rootApproved = await this.confirmGrantRoot(normalized);
        if (!rootApproved) {
          return {
            ok: false,
            granted: false,
            deniedReason: "root_denied",
            snapshot: this.toSnapshot(rec),
          };
        }
        rec.rootGranted = true;
      }
      rec.status = "running";
      rec.cols = dims.cols;
      rec.rows = dims.rows;
      rec.pty.resize(dims.cols, dims.rows);
      this.emitSnapshot(rec);
      return {
        ok: true,
        granted: true,
        snapshot: this.toSnapshot(rec),
      };
    }

    // Grant check before any PTY spawn
    if (wantGrantRoot && !rec.rootGranted) {
      const rootApproved = await this.confirmGrantRoot(normalized);
      if (!rootApproved) {
        rec.status = "grant_denied";
        rec.granted = false;
        rec.rootGranted = false;
        this.emitSnapshot(rec);
        return {
          ok: false,
          granted: false,
          deniedReason: "root_denied",
          snapshot: this.toSnapshot(rec),
        };
      }
      rec.granted = true;
      rec.rootGranted = true;
    } else if (!rec.granted) {
      const approved = await this.confirmFirstTerminal(normalized);
      if (!approved) {
        rec.status = "grant_denied";
        rec.granted = false;
        this.emitSnapshot(rec);
        return {
          ok: false,
          granted: false,
          deniedReason: "user_denied",
          snapshot: this.toSnapshot(rec),
        };
      }
      rec.granted = true;
    }

    // Spawn fresh Main-owned PTY bound to this Scope
    const terminalId = `term_${crypto.randomUUID()}`;
    rec.terminalId = terminalId;
    rec.cols = dims.cols;
    rec.rows = dims.rows;
    rec.status = "running";
    rec.hasForegroundProcess = false;
    rec.foregroundProcessName = undefined;
    rec.exitCode = null;
    rec.scrollback = createTerminalScrollbackState();
    this.terminalIdToScopeKey.set(terminalId, rec.scopeKey);

    const pty = this.ptyFactory({
      cols: dims.cols,
      rows: dims.rows,
      cwd: this.defaultCwd,
    });
    rec.pty = pty;

    pty.on("data", (chunk: string) => {
      if (rec.pty !== pty) return;
      rec.scrollback = appendTerminalChunk(rec.scrollback, chunk);
      this.emitSnapshot(rec);
    });

    pty.on("foreground", (ev: { busy?: boolean; processName?: string }) => {
      if (rec.pty !== pty) return;
      rec.hasForegroundProcess = Boolean(ev?.busy);
      rec.foregroundProcessName = ev?.busy ? ev.processName : undefined;
      this.emitSnapshot(rec);
    });

    pty.on("exit", (code: number | null) => {
      if (rec.pty !== pty) return;
      rec.pty = null;
      this.terminalIdToScopeKey.delete(terminalId);
      // If close() already transitioned to idle/ended, preserve cleared view
      if (rec.status === "idle" || rec.status === "ended") {
        return;
      }
      rec.terminalId = null;
      rec.status = "ended";
      rec.hasForegroundProcess = false;
      rec.foregroundProcessName = undefined;
      rec.exitCode = typeof code === "number" ? code : null;
      this.emitSnapshot(rec);
    });

    this.emitSnapshot(rec);
    return {
      ok: true,
      granted: true,
      snapshot: this.toSnapshot(rec),
    };
  }

  async write(
    scope: BridgeScope | null | undefined,
    payload: { terminalId?: unknown; data?: unknown },
  ): Promise<{ ok: true }> {
    const normalized = this.assertScopeActive(normalizeScope(scope));
    const rec = this.getOrCreateRecord(normalized);
    this.assertTerminalBinding(rec, payload.terminalId);

    if (!rec.pty || (rec.status !== "running" && rec.status !== "detached")) {
      throw createCodedError("not_found", getCopy("terminal.notRunningInputError"));
    }
    if (typeof payload.data !== "string") {
      throw createCodedError("invalid_request", getCopy("terminal.inputTypeError"));
    }
    rec.pty.write(payload.data);
    return { ok: true };
  }

  async resize(
    scope: BridgeScope | null | undefined,
    payload: { terminalId?: unknown; cols?: unknown; rows?: unknown },
  ): Promise<{ ok: true; cols: number; rows: number }> {
    const normalized = this.assertScopeActive(normalizeScope(scope));
    const rec = this.getOrCreateRecord(normalized);
    this.assertTerminalBinding(rec, payload.terminalId);

    if (!rec.pty || (rec.status !== "running" && rec.status !== "detached")) {
      throw createCodedError("not_found", getCopy("terminal.notRunningResizeError"));
    }
    const dims = clampDims(payload.cols, payload.rows);
    rec.cols = dims.cols;
    rec.rows = dims.rows;
    rec.pty.resize(dims.cols, dims.rows);
    this.emitSnapshot(rec);
    return { ok: true, cols: dims.cols, rows: dims.rows };
  }

  async close(
    scope: BridgeScope | null | undefined,
    payload: { terminalId?: unknown; mode?: unknown } = {},
  ): Promise<TerminalCloseResult> {
    const normalized = this.assertScopeActive(normalizeScope(scope));
    const rec = this.getOrCreateRecord(normalized);
    this.assertTerminalBinding(rec, payload.terminalId);

    const mode =
      payload.mode === "detach" || payload.mode === "terminate" ? payload.mode : "auto";

    if (!rec.pty || (rec.status !== "running" && rec.status !== "detached")) {
      // Already ended/idle/grant_denied: release view & scrollback cleanly
      if (rec.terminalId) {
        this.terminalIdToScopeKey.delete(rec.terminalId);
      }
      rec.terminalId = null;
      rec.status = "idle";
      rec.hasForegroundProcess = false;
      rec.foregroundProcessName = undefined;
      rec.exitCode = null;
      rec.scrollback = createTerminalScrollbackState();
      this.emitSnapshot(rec);
      return {
        ok: true,
        outcome: "closed",
        snapshot: this.toSnapshot(rec),
      };
    }

    if (mode === "detach") {
      rec.status = "detached";
      this.emitSnapshot(rec);
      return {
        ok: true,
        outcome: "detached",
        snapshot: this.toSnapshot(rec),
      };
    }

    if (mode === "auto" && rec.hasForegroundProcess) {
      return {
        ok: false,
        outcome: "confirm_required",
        snapshot: this.toSnapshot(rec),
      };
    }

    const oldPty = rec.pty;
    const oldId = rec.terminalId;
    rec.pty = null;
    rec.terminalId = null;
    if (oldId) {
      this.terminalIdToScopeKey.delete(oldId);
    }
    rec.hasForegroundProcess = false;
    rec.foregroundProcessName = undefined;
    rec.scrollback = createTerminalScrollbackState();
    rec.status = mode === "terminate" ? "ended" : "idle";
    rec.exitCode = 0;

    oldPty.kill();
    this.emitSnapshot(rec);

    return {
      ok: true,
      outcome: mode === "terminate" ? "terminated" : "closed",
      snapshot: this.toSnapshot(rec),
    };
  }

  subscribe(
    scope: BridgeScope | null | undefined,
    listener: (event: BridgeEvent<TerminalSnapshot>) => void,
  ): () => void {
    const normalized = normalizeScope(scope);
    const scopeKey = makeScopeKey(normalized.connectionId, normalized.profileId ?? "default");
    const sub: ScopeSubscription = {
      scopeKey,
      seq: 0,
      listener,
    };
    this.subscriptions.add(sub);

    const rec = this.getOrCreateRecord(normalized);
    listener({
      topic: "terminal",
      scope: { ...normalized },
      kind: "snapshot",
      seq: 0,
      revision: rec.revision,
      payload: this.toSnapshot(rec),
    });

    return () => {
      this.subscriptions.delete(sub);
    };
  }

  disposeAll(): void {
    this.disposed = true;
    for (const rec of this.records.values()) {
      const pty = rec.pty;
      rec.pty = null;
      rec.status = "idle";
      rec.terminalId = null;
      rec.hasForegroundProcess = false;
      rec.foregroundProcessName = undefined;
      rec.scrollback = createTerminalScrollbackState();
      if (pty) {
        try {
          pty.kill();
        } catch {
          // Ignore shutdown kill errors
        }
      }
    }
    this.records.clear();
    this.terminalIdToScopeKey.clear();
    this.subscriptions.clear();
  }

  get handlers(): Record<
    "terminal.get" | "terminal.open" | "terminal.write" | "terminal.resize" | "terminal.close",
    HostCommandHandler
  > {
    return {
      "terminal.get": async (_payload, scope) => ({
        snapshot: this.getSnapshot(scope),
      }),
      "terminal.open": async (payload, scope) => this.open(scope, payload),
      "terminal.write": async (payload, scope) => this.write(scope, payload),
      "terminal.resize": async (payload, scope) => this.resize(scope, payload),
      "terminal.close": async (payload, scope) => this.close(scope, payload),
    };
  }
}
