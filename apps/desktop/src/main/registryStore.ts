import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ConnectionMutationInput,
  DuplicateConflictSummary,
  ErrorCode,
  LaunchMode,
  RegistryDiff,
  RegistryIssue,
  RegistrySafeSummaryExport,
  RegistrySnapshotView,
} from "@hermes/contracts";
import {
  createEmptyRegistryDocument,
  diffRegistries,
  normalizeRegistryDocument,
  normalizeSemanticUrl,
  projectRegistrySnapshot,
  rebaseRegistry,
  validateClientAddConnection,
  validateClientRemoveConnection,
  validateClientUpdateConnection,
  type NormalizedRegistryResult,
  type RegistryConnection,
  type RegistryDocument,
  type SecretEnvelope,
} from "@hermes/domain";
import { assertSafeSandboxRoot } from "./security";

const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 10_000;
const BUSY_BACKOFF_MS = 100;
const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WATCH_INTERVAL_MS = 1500;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_MISSING_GRACE_MS = 3000;

export interface RegistryClock {
  now(): number;
  sleepSync(ms: number): void;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void;
}

export interface RegistryWatcherDriver {
  watchFile(filePath: string, intervalMs: number, onChange: () => void): void;
  unwatchFile(filePath: string): void;
}

export interface TokenDocument {
  version: number;
  revision: number;
  tokens: Record<string, OAuthTokenSet>;
  unbound: Record<string, OAuthTokenSet>;
  undecrypted: Record<string, unknown>;
}

export interface OAuthTokenSet {
  baseUrl?: string;
  [key: string]: unknown;
}

export type WriteSecretInput =
  | {
      kind: "oauth";
      connectionId?: string;
      baseUrl: string;
      tokenSet: Record<string, unknown>;
    }
  | {
      kind: "static";
      connectionId: string;
      token?: string;
      headers?: Record<string, string>;
    };

export interface RegistryStoreEvent {
  snapshot: RegistrySnapshotView;
  diff: RegistryDiff;
  reason: "mutation" | "external_watch" | "refresh" | "reset";
}

export type RegistryMutationResult =
  | {
      ok: true;
      snapshot: RegistrySnapshotView;
      warnings: RegistryIssue[];
      diff: RegistryDiff;
    }
  | {
      ok: false;
      errorCode: ErrorCode;
      issue: RegistryIssue;
      retryable: boolean;
      snapshot: RegistrySnapshotView;
      conflict?: DuplicateConflictSummary;
    };

export interface RegistryStoreOptions {
  rootDir: string;
  allowRealHome?: boolean;
  clock?: RegistryClock;
  watcher?: RegistryWatcherDriver;
  pid?: number;
  randomToken?: () => string;
  watchIntervalMs?: number;
  debounceMs?: number;
  missingGraceMs?: number;
}

class RegistryBusyError extends Error {
  constructor(message = "Registry store lock is busy") {
    super(message);
    this.name = "RegistryBusyError";
  }
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const defaultClock: RegistryClock = {
  now: () => Date.now(),
  sleepSync: (ms: number) => {
    if (ms <= 0) return;
    try {
      Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
    } catch {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        // fallback spin
      }
    }
  },
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const defaultWatcher: RegistryWatcherDriver = {
  watchFile(filePath, intervalMs, onChange) {
    fs.watchFile(filePath, { interval: intervalMs, persistent: false }, () => {
      onChange();
    });
  },
  unwatchFile(filePath) {
    fs.unwatchFile(filePath);
  },
};

function emptyTokenDoc(): TokenDocument {
  return {
    version: 1,
    revision: 0,
    tokens: {},
    unbound: {},
    undecrypted: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTokenDoc(raw: unknown): TokenDocument {
  if (!isPlainObject(raw)) return emptyTokenDoc();
  const revision =
    typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0;
  const tokens: Record<string, OAuthTokenSet> = {};
  if (isPlainObject(raw.tokens)) {
    for (const [k, v] of Object.entries(raw.tokens)) {
      if (isPlainObject(v)) tokens[k] = { ...v } as OAuthTokenSet;
    }
  }
  const unbound: Record<string, OAuthTokenSet> = {};
  if (isPlainObject(raw.unbound)) {
    for (const [k, v] of Object.entries(raw.unbound)) {
      if (isPlainObject(v)) unbound[k] = { ...v } as OAuthTokenSet;
    }
  }
  const undecrypted: Record<string, unknown> = {};
  if (isPlainObject(raw.undecrypted)) {
    for (const [k, v] of Object.entries(raw.undecrypted)) {
      undecrypted[k] = v;
    }
  }
  return {
    version: 1,
    revision,
    tokens,
    unbound,
    undecrypted,
  };
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isOAuthTokenBoundToConnection(
  conn: RegistryConnection | undefined,
  tokenEntry: OAuthTokenSet | undefined,
  duplicateIds: Set<string>,
): boolean {
  if (!conn || !tokenEntry) return false;
  if (duplicateIds.has(conn.id)) return false;
  if (conn.kind !== "remote" && conn.kind !== "cloud") return false;
  if (conn.authMode !== "oauth") return false;
  const connUrl = normalizeSemanticUrl(conn.url);
  const tokenUrl = normalizeSemanticUrl(tokenEntry.baseUrl);
  if (!connUrl || !tokenUrl) return false;
  return connUrl === tokenUrl;
}

export class RegistryStore {
  readonly rootDir: string;
  readonly connectionsPath: string;
  readonly tokensPath: string;

  private readonly clock: RegistryClock;
  private readonly watcher: RegistryWatcherDriver;
  private readonly pid: number;
  private readonly randomToken: () => string;
  private readonly watchIntervalMs: number;
  private readonly debounceMs: number;
  private readonly missingGraceMs: number;

  private lastNormalized: NormalizedRegistryResult;
  private lastOAuthIds = new Set<string>();
  private readOnlyReason: "registry_corrupt" | "registry_unsupported" | "registry_unavailable" | undefined;
  private stickyIssues: RegistryIssue[] = [];
  private tokenSyncFailedIds = new Set<string>();
  private hadFileOnDisk = false;
  private pendingPreDropRaw: string | null = null;
  private preDropWrittenForHash: string | null = null;
  private futureWarningEmittedForHash: string | null = null;
  private pendingTokenReconcile = false;

  private lastConnectionsHash: string | null = null;
  private lastTokensHash: string | null = null;

  private watching = false;
  private disposed = false;
  private flushing = false;
  private activeWrites = 0;
  private flushWaiters: Array<() => void> = [];
  private connDebounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private tokenDebounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private missingGraceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private listeners = new Set<(event: RegistryStoreEvent) => void>();

  constructor(options: RegistryStoreOptions) {
    this.rootDir = assertSafeSandboxRoot(options.rootDir, {
      allowRealHome: Boolean(options.allowRealHome),
    });
    this.connectionsPath = path.join(this.rootDir, "gateway-connections.json");
    this.tokensPath = path.join(this.rootDir, "gateway-connection-tokens.json");
    this.clock = options.clock ?? defaultClock;
    this.watcher = options.watcher ?? defaultWatcher;
    this.pid = options.pid ?? process.pid;
    this.randomToken = options.randomToken ?? (() => crypto.randomBytes(6).toString("hex"));
    this.watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.missingGraceMs = options.missingGraceMs ?? DEFAULT_MISSING_GRACE_MS;

    this.ensureRootDir0700();
    this.cleanupStaleTempFiles();

    this.lastNormalized = normalizeRegistryDocument(createEmptyRegistryDocument());
    this.loadInitialState();
  }

  private ensureRootDir0700(): void {
    const existed = fs.existsSync(this.rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    if (!existed) {
      fs.chmodSync(this.rootDir, 0o700);
    } else {
      try {
        fs.chmodSync(this.rootDir, 0o700);
      } catch {
        // best-effort if owned by another user
      }
    }
  }

  private cleanupStaleTempFiles(): void {
    try {
      const entries = fs.readdirSync(this.rootDir);
      const cutoff = this.clock.now() - STALE_TMP_AGE_MS;
      for (const name of entries) {
        if (!/\.hd\.\d+\.\d+\.[a-f0-9]+\.tmp$/.test(name)) continue;
        const full = path.join(this.rootDir, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  private loadInitialState(): void {
    const read = this.readConnectionsDiskState();
    this.applyDiskReadState(read, /* isInitial */ true);
    this.refreshOAuthIdsBestEffort();
  }

  private refreshOAuthIdsBestEffort(): boolean {
    const prevHash = this.lastTokensHash;
    try {
      const raw = fs.readFileSync(this.tokensPath, "utf8");
      const hash = hashContent(raw);
      const doc = normalizeTokenDoc(JSON.parse(raw));
      this.lastTokensHash = hash;
      this.lastOAuthIds = this.computeValidOAuthIds(this.lastNormalized, doc);
      return prevHash !== null && prevHash !== hash;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        this.lastTokensHash = null;
        this.lastOAuthIds = new Set();
        return prevHash !== null;
      }
      return false;
    }
  }

  private computeValidOAuthIds(
    normalized: NormalizedRegistryResult,
    tokenDoc: TokenDocument,
  ): Set<string> {
    const ids = new Set<string>();
    for (const [connId, tokenEntry] of Object.entries(tokenDoc.tokens)) {
      const conn = normalized.doc.connections.find((c) => c.id === connId);
      if (isOAuthTokenBoundToConnection(conn, tokenEntry, normalized.duplicateIds)) {
        ids.add(connId);
      }
    }
    return ids;
  }

  private readConnectionsDiskState():
    | { status: "missing" }
    | { status: "unavailable" }
    | { status: "corrupt"; rawText: string }
    | { status: "unsupported"; rawText: string }
    | { status: "ok"; rawText: string; hash: string; normalized: NormalizedRegistryResult } {
    let rawText: string;
    try {
      rawText = fs.readFileSync(this.connectionsPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return { status: "missing" };
      }
      return { status: "unavailable" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { status: "corrupt", rawText };
    }

    const normalized = normalizeRegistryDocument(parsed);
    if (normalized.unsupported) {
      return { status: "unsupported", rawText };
    }

    return {
      status: "ok",
      rawText,
      hash: hashContent(rawText),
      normalized,
    };
  }

  private applyDiskReadState(
    read: ReturnType<RegistryStore["readConnectionsDiskState"]>,
    isInitial = false,
  ): void {
    if (read.status === "missing") {
      this.readOnlyReason = undefined;
      if (!this.hadFileOnDisk || isInitial) {
        this.lastNormalized = normalizeRegistryDocument(createEmptyRegistryDocument());
        this.stickyIssues = [];
      } else {
        this.lastNormalized = normalizeRegistryDocument(createEmptyRegistryDocument());
        this.hadFileOnDisk = false;
        this.stickyIssues = [
          {
            code: "registry_reset",
            severity: "warning",
            messageKey: "registry.issue.reset",
          },
        ];
      }
      this.lastConnectionsHash = null;
      this.pendingPreDropRaw = null;
      return;
    }

    if (read.status === "unavailable") {
      this.readOnlyReason = "registry_unavailable";
      this.stickyIssues = [
        {
          code: "registry_unavailable",
          severity: "error",
          messageKey: "registry.issue.unavailable",
        },
      ];
      return;
    }

    if (read.status === "corrupt") {
      this.hadFileOnDisk = true;
      this.readOnlyReason = "registry_corrupt";
      this.stickyIssues = [
        {
          code: "registry_corrupt",
          severity: "error",
          messageKey: "registry.issue.corrupt",
        },
      ];
      return;
    }

    if (read.status === "unsupported") {
      this.hadFileOnDisk = true;
      this.readOnlyReason = "registry_unsupported";
      this.stickyIssues = [
        {
          code: "registry_unsupported",
          severity: "error",
          messageKey: "registry.issue.unsupported",
        },
      ];
      return;
    }

    this.hadFileOnDisk = true;
    this.readOnlyReason = undefined;
    this.stickyIssues = [];
    this.lastConnectionsHash = read.hash;
    this.lastNormalized = read.normalized;

    if (read.normalized.hadFutureVersionOrUnknownFields) {
      if (this.preDropWrittenForHash !== read.hash) {
        this.pendingPreDropRaw = read.rawText;
      }
      if (this.futureWarningEmittedForHash === read.hash) {
        // Suppress duplicate future-version warning within same detection cycle
        this.lastNormalized = {
          ...read.normalized,
          issues: read.normalized.issues.filter((i) => i.code !== "registry_future_version"),
        };
      } else {
        this.futureWarningEmittedForHash = read.hash;
      }
    } else {
      this.pendingPreDropRaw = null;
      this.preDropWrittenForHash = null;
      this.futureWarningEmittedForHash = null;
    }
  }

  private getCombinedExtraIssues(): RegistryIssue[] {
    const syncIssues: RegistryIssue[] = [...this.tokenSyncFailedIds].map((connectionId) => ({
      code: "token_sync_failed",
      severity: "warning",
      connectionId,
      messageKey: "registry.issue.tokenSyncFailed",
    }));
    return [...this.stickyIssues, ...syncIssues];
  }

  markTokenSyncFailed(connectionId: string): void {
    if (!connectionId || this.disposed) return;
    if (this.tokenSyncFailedIds.has(connectionId)) return;
    const prevIssues = this.getCombinedExtraIssues();
    this.tokenSyncFailedIds.add(connectionId);
    const nextIssues = this.getCombinedExtraIssues();
    const diff = diffRegistries(this.lastNormalized, this.lastNormalized, {
      extraPrevIssues: prevIssues,
      extraNextIssues: nextIssues,
    });
    this.emit({ snapshot: this.snapshot(), diff, reason: "mutation" });
  }

  clearTokenSyncFailed(connectionId: string): void {
    if (!connectionId || !this.tokenSyncFailedIds.has(connectionId)) return;
    const prevIssues = this.getCombinedExtraIssues();
    this.tokenSyncFailedIds.delete(connectionId);
    if (this.disposed) return;
    const nextIssues = this.getCombinedExtraIssues();
    const diff = diffRegistries(this.lastNormalized, this.lastNormalized, {
      extraPrevIssues: prevIssues,
      extraNextIssues: nextIssues,
    });
    this.emit({ snapshot: this.snapshot(), diff, reason: "mutation" });
  }

  snapshot(): RegistrySnapshotView {
    return projectRegistrySnapshot(this.lastNormalized, {
      oauthTokenIds: this.lastOAuthIds,
      extraIssues: this.getCombinedExtraIssues(),
      readOnly: Boolean(this.readOnlyReason),
      readOnlyReason: this.readOnlyReason,
    });
  }

  refresh(): RegistrySnapshotView {
    if (this.disposed) return this.snapshot();
    const prevNorm = this.lastNormalized;
    const prevIssues = [...this.stickyIssues];
    const read = this.readConnectionsDiskState();
    this.applyDiskReadState(read);
    const credsChanged = this.refreshOAuthIdsBestEffort();
    const diff = diffRegistries(prevNorm, this.lastNormalized, {
      credentialsChanged: credsChanged,
      extraPrevIssues: prevIssues,
      extraNextIssues: this.stickyIssues,
    });
    if (
      diff.changes.length > 0 ||
      diff.primaryChanged ||
      diff.launchModeChanged ||
      diff.issuesChanged ||
      diff.credentialsChanged
    ) {
      this.emit({
        snapshot: this.snapshot(),
        diff,
        reason: read.status === "missing" && prevIssues.length === 0 ? "reset" : "refresh",
      });
    }
    return this.snapshot();
  }

  add(input: ConnectionMutationInput): RegistryMutationResult {
    return this.runConnectionMutation((currentDoc, oauthIds) => {
      const check = validateClientAddConnection(currentDoc, input, oauthIds);
      if (!check.ok) {
        return { ok: false, errorCode: "conflict", issue: check.issue, conflict: check.conflict };
      }
      return {
        ok: true,
        nextDoc: {
          ...currentDoc,
          connections: [...currentDoc.connections, check.connection],
        },
      };
    });
  }

  update(connectionId: string, input: ConnectionMutationInput): RegistryMutationResult {
    return this.runConnectionMutation((currentDoc, oauthIds) => {
      const check = validateClientUpdateConnection(currentDoc, connectionId, input, oauthIds);
      if (!check.ok) {
        return {
          ok: false,
          errorCode: check.issue.code === "duplicate_identity" || check.issue.code === "duplicate_label"
            ? "conflict"
            : "invalid_request",
          issue: check.issue,
          conflict: check.conflict,
        };
      }
      return {
        ok: true,
        nextDoc: {
          ...currentDoc,
          connections: currentDoc.connections.map((c) =>
            c.id === connectionId ? check.connection : c,
          ),
        },
      };
    });
  }

  remove(connectionId: string): RegistryMutationResult {
    return this.runConnectionMutation((currentDoc) => {
      const check = validateClientRemoveConnection(currentDoc, connectionId);
      if (!check.ok) {
        return {
          ok: false,
          errorCode: check.issue.code === "local_not_removable" ? "permission_denied" : "not_found",
          issue: check.issue,
        };
      }
      const nextConnections = currentDoc.connections.filter((c) => c.id !== connectionId);
      this.tokenSyncFailedIds.delete(connectionId);
      return {
        ok: true,
        nextDoc: {
          ...currentDoc,
          primary: currentDoc.primary === connectionId ? "local" : currentDoc.primary,
          lastUsed: currentDoc.lastUsed === connectionId ? undefined : currentDoc.lastUsed,
          connections: nextConnections,
        },
      };
    });
  }

  setPrimary(connectionId: string): RegistryMutationResult {
    return this.runConnectionMutation((currentDoc, _oauthIds, normalized) => {
      const exists = currentDoc.connections.some((c) => c.id === connectionId);
      if (!exists || normalized.duplicateIds.has(connectionId)) {
        return {
          ok: false,
          errorCode: exists ? "conflict" : "not_found",
          issue: {
            code: "registry_invalid",
            severity: "error",
            connectionId,
            messageKey: "registry.issue.invalidPrimary",
          },
        };
      }
      return {
        ok: true,
        nextDoc: {
          ...currentDoc,
          primary: connectionId,
        },
      };
    });
  }

  setLaunchMode(launchMode: LaunchMode): RegistryMutationResult {
    if (launchMode !== "primary" && launchMode !== "last-used") {
      return {
        ok: false,
        errorCode: "invalid_request",
        issue: {
          code: "registry_invalid",
          severity: "error",
          messageKey: "registry.issue.invalidInput",
        },
        retryable: false,
        snapshot: this.snapshot(),
      };
    }
    return this.runConnectionMutation((currentDoc) => ({
      ok: true,
      nextDoc: {
        ...currentDoc,
        launchMode,
      },
    }));
  }

  setLastUsed(connectionId: string): RegistryMutationResult {
    return this.runConnectionMutation((currentDoc, _oauthIds, normalized) => {
      const exists = currentDoc.connections.some((c) => c.id === connectionId);
      if (!exists || normalized.duplicateIds.has(connectionId)) {
        return {
          ok: false,
          errorCode: exists ? "conflict" : "not_found",
          issue: {
            code: "registry_invalid",
            severity: "error",
            connectionId,
            messageKey: "registry.issue.notFound",
          },
        };
      }
      return {
        ok: true,
        nextDoc: {
          ...currentDoc,
          lastUsed: connectionId,
        },
      };
    });
  }

  backupAndRepair(): RegistryMutationResult {
    if (this.disposed || this.flushing) {
      return this.disposedFailure();
    }
    if (this.readOnlyReason === "registry_unsupported" || this.readOnlyReason === "registry_unavailable") {
      return {
        ok: false,
        errorCode: "permission_denied",
        issue: {
          code: this.readOnlyReason,
          severity: "error",
          messageKey:
            this.readOnlyReason === "registry_unsupported"
              ? "registry.issue.unsupported"
              : "registry.issue.unavailable",
        },
        retryable: false,
        snapshot: this.snapshot(),
      };
    }

    return this.withWriteGuard(() => {
      try {
        return this.withStoreLock(this.connectionsPath, (verifyConnOwner) => {
          const read = this.readConnectionsDiskState();
          if (read.status === "unsupported" || read.status === "unavailable") {
            this.applyDiskReadState(read);
            return {
              ok: false as const,
              errorCode: "permission_denied" as const,
              issue: this.stickyIssues[0],
              retryable: false,
              snapshot: this.snapshot(),
            };
          }

          if (read.status === "corrupt") {
            const backupPath = `${this.connectionsPath}.corrupt-${this.clock.now()}`;
            this.atomicWriteFile0600(backupPath, read.rawText, verifyConnOwner);
          }

          const fresh = createEmptyRegistryDocument();
          fresh.revision = this.lastNormalized.doc.revision + 1;
          const serialized = JSON.stringify(fresh, null, 2);
          this.atomicWriteFile0600(this.connectionsPath, serialized, verifyConnOwner);

          const prevNorm = this.lastNormalized;
          const prevIssues = [...this.stickyIssues];
          this.readOnlyReason = undefined;
          this.stickyIssues = [];
          this.hadFileOnDisk = true;
          this.lastConnectionsHash = hashContent(serialized);
          this.lastNormalized = normalizeRegistryDocument(fresh);

          const tokenSync = this.reconcileTokensUnderConnectionLock(this.lastNormalized);
          const warnings: RegistryIssue[] = [];
          if (!tokenSync.ok) {
            warnings.push(tokenSync.warning);
          }

          const diff = diffRegistries(prevNorm, this.lastNormalized, {
            credentialsChanged: tokenSync.ok ? tokenSync.changed : false,
            extraPrevIssues: prevIssues,
            extraNextIssues: [],
          });
          const snapshot = this.snapshot();
          this.emit({ snapshot, diff, reason: "mutation" });
          return { ok: true as const, snapshot, warnings, diff };
        });
      } catch (err) {
        if (err instanceof RegistryBusyError) {
          return this.busyFailure();
        }
        return this.ioFailure();
      }
    });
  }

  writeSecret(input: WriteSecretInput): RegistryMutationResult {
    if (this.disposed || this.flushing) {
      return this.disposedFailure();
    }

    if (input.kind === "static") {
      return this.runConnectionMutation((currentDoc) => {
        const existing = currentDoc.connections.find((c) => c.id === input.connectionId);
        if (!existing || existing.kind === "local") {
          return {
            ok: false,
            errorCode: "not_found",
            issue: {
              code: "registry_invalid",
              severity: "error",
              connectionId: input.connectionId,
              messageKey: "registry.issue.notFound",
            },
          };
        }
        const updated: RegistryConnection = { ...existing };
        if (input.token !== undefined) {
          if (input.token.length > 0) {
            updated.token = { encoding: "plain", value: input.token };
          } else {
            delete updated.token;
          }
        }
        if (input.headers !== undefined) {
          const nextHeaders: Record<string, SecretEnvelope> = {};
          for (const [k, v] of Object.entries(input.headers)) {
            if (k.trim() && v) nextHeaders[k.trim()] = { encoding: "plain", value: v };
          }
          if (Object.keys(nextHeaders).length > 0) {
            updated.headers = nextHeaders;
          } else {
            delete updated.headers;
          }
        }
        return {
          ok: true,
          nextDoc: {
            ...currentDoc,
            connections: currentDoc.connections.map((c) =>
              c.id === input.connectionId ? updated : c,
            ),
          },
        };
      });
    }

    // OAuth token write: strictly connections lock -> tokens lock
    const normalizedUrl = normalizeSemanticUrl(input.baseUrl);
    if (!normalizedUrl) {
      return {
        ok: false,
        errorCode: "invalid_request",
        issue: {
          code: "registry_invalid",
          severity: "error",
          messageKey: "registry.issue.invalidInput",
        },
        retryable: false,
        snapshot: this.snapshot(),
      };
    }

    return this.withWriteGuard(() => {
      try {
        return this.withStoreLock(this.connectionsPath, () => {
          const read = this.readConnectionsDiskState();
          if (read.status === "corrupt" || read.status === "unsupported" || read.status === "unavailable") {
            this.applyDiskReadState(read);
            return {
              ok: false as const,
              errorCode: "permission_denied" as const,
              issue: this.stickyIssues[0],
              retryable: false,
              snapshot: this.snapshot(),
            };
          }

          const currentNorm =
            read.status === "ok"
              ? read.normalized
              : normalizeRegistryDocument(createEmptyRegistryDocument());

          const conn = input.connectionId
            ? currentNorm.doc.connections.find((c) => c.id === input.connectionId)
            : undefined;

          const tokenResult = this.withStoreLock(this.tokensPath, (verifyTokOwner) => {
            const diskTokens = this.readTokenDocForWrite();
            const nextTokens = { ...diskTokens.tokens };
            const nextUnbound = { ...diskTokens.unbound };
            const entry: OAuthTokenSet = {
              ...input.tokenSet,
              baseUrl: normalizedUrl,
            };

            if (conn && isOAuthTokenBoundToConnection(conn, entry, currentNorm.duplicateIds)) {
              nextTokens[conn.id] = entry;
            } else {
              nextUnbound[normalizedUrl] = entry;
            }

            const outDoc: TokenDocument = {
              version: 1,
              revision: diskTokens.revision + 1,
              tokens: nextTokens,
              unbound: nextUnbound,
              undecrypted: { ...diskTokens.undecrypted },
            };
            const serialized = JSON.stringify(outDoc, null, 2);
            this.atomicWriteFile0600(this.tokensPath, serialized, verifyTokOwner);
            this.lastTokensHash = hashContent(serialized);
            this.lastOAuthIds = this.computeValidOAuthIds(currentNorm, outDoc);
            return true;
          });

          const prevNorm = this.lastNormalized;
          this.lastNormalized = currentNorm;
          if (conn) {
            this.tokenSyncFailedIds.delete(conn.id);
          }
          const diff = diffRegistries(prevNorm, this.lastNormalized, {
            credentialsChanged: tokenResult,
          });
          const snapshot = this.snapshot();
          this.emit({ snapshot, diff, reason: "mutation" });
          return { ok: true as const, snapshot, warnings: [], diff };
        });
      } catch (err) {
        if (err instanceof RegistryBusyError) {
          return this.busyFailure();
        }
        return this.ioFailure();
      }
    });
  }

  exportSafeSummary(): RegistrySafeSummaryExport {
    const snap = this.snapshot();
    return {
      exportedAt: new Date(this.clock.now()).toISOString(),
      version: snap.version,
      revision: snap.revision,
      launchMode: snap.launchMode,
      primary: snap.primary,
      lastUsed: snap.lastUsed,
      connectionCount: snap.connections.length,
      quarantinedCount: snap.quarantinedCount,
      readOnly: snap.readOnly,
      readOnlyReason: snap.readOnlyReason,
      issues: snap.issues,
      connections: snap.connections.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        dialable: c.dialable,
        hasToken: c.hasToken,
        originDisplay: c.originDisplay,
        sshTargetDisplay: c.sshTargetDisplay,
      })),
    };
  }

  getConnectionCredentialsForDial(connectionId: string): {
    staticToken?: string;
    headers?: Record<string, string>;
    oauthTokenSet?: OAuthTokenSet;
  } | null {
    const conn = this.lastNormalized.doc.connections.find((c) => c.id === connectionId);
    if (!conn || this.lastNormalized.duplicateIds.has(connectionId)) return null;

    const staticToken =
      conn.token?.encoding === "plain" && typeof conn.token.value === "string"
        ? conn.token.value
        : undefined;

    let headers: Record<string, string> | undefined;
    if (conn.headers) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(conn.headers)) {
        if (v.encoding === "plain" && typeof v.value === "string") {
          out[k] = v.value;
        }
      }
      if (Object.keys(out).length > 0) headers = out;
    }

    let oauthTokenSet: OAuthTokenSet | undefined;
    try {
      const raw = fs.readFileSync(this.tokensPath, "utf8");
      const tokenDoc = normalizeTokenDoc(JSON.parse(raw));
      const candidate = tokenDoc.tokens[connectionId];
      if (isOAuthTokenBoundToConnection(conn, candidate, this.lastNormalized.duplicateIds)) {
        oauthTokenSet = candidate;
      }
    } catch {
      // ignore missing/unreadable tokens
    }

    return { staticToken, headers, oauthTokenSet };
  }

  startWatching(): void {
    if (this.watching || this.disposed) return;
    this.watching = true;
    this.watcher.watchFile(this.connectionsPath, this.watchIntervalMs, () => {
      this.onConnectionsWatcherFired();
    });
    this.watcher.watchFile(this.tokensPath, this.watchIntervalMs, () => {
      this.onTokensWatcherFired();
    });
  }

  subscribe(listener: (event: RegistryStoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async flush(timeoutMs = 2000): Promise<{ flushed: boolean; pending: number }> {
    this.flushing = true;
    this.clearTimers();

    if (this.activeWrites === 0) {
      return { flushed: true, pending: 0 };
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ flushed: this.activeWrites === 0, pending: this.activeWrites });
      }, timeoutMs);

      this.flushWaiters.push(() => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        resolve({ flushed: true, pending: 0 });
      });
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flushing = true;
    this.clearTimers();
    if (this.watching) {
      this.watching = false;
      this.watcher.unwatchFile(this.connectionsPath);
      this.watcher.unwatchFile(this.tokensPath);
    }
    this.listeners.clear();
  }

  private clearTimers(): void {
    if (this.connDebounceTimer !== null) {
      this.clock.clearTimeout(this.connDebounceTimer);
      this.connDebounceTimer = null;
    }
    if (this.tokenDebounceTimer !== null) {
      this.clock.clearTimeout(this.tokenDebounceTimer);
      this.tokenDebounceTimer = null;
    }
    if (this.missingGraceTimer !== null) {
      this.clock.clearTimeout(this.missingGraceTimer);
      this.missingGraceTimer = null;
    }
  }

  private onConnectionsWatcherFired(): void {
    if (this.disposed || this.flushing) return;
    const exists = fs.existsSync(this.connectionsPath);
    if (!exists) {
      if (this.hadFileOnDisk && this.missingGraceTimer === null) {
        this.missingGraceTimer = this.clock.setTimeout(() => {
          this.missingGraceTimer = null;
          if (this.disposed || this.flushing) return;
          if (!fs.existsSync(this.connectionsPath)) {
            this.processExternalConnectionsChange();
          }
        }, this.missingGraceMs);
      }
      return;
    }

    if (this.missingGraceTimer !== null) {
      this.clock.clearTimeout(this.missingGraceTimer);
      this.missingGraceTimer = null;
    }

    // Self-write suppression
    try {
      const raw = fs.readFileSync(this.connectionsPath, "utf8");
      if (hashContent(raw) === this.lastConnectionsHash) {
        return;
      }
    } catch {
      // proceed to debounced handler
    }

    if (this.connDebounceTimer !== null) {
      this.clock.clearTimeout(this.connDebounceTimer);
    }
    this.connDebounceTimer = this.clock.setTimeout(() => {
      this.connDebounceTimer = null;
      if (this.disposed || this.flushing) return;
      this.processExternalConnectionsChange();
    }, this.debounceMs);
  }

  private onTokensWatcherFired(): void {
    if (this.disposed || this.flushing) return;
    try {
      const raw = fs.readFileSync(this.tokensPath, "utf8");
      if (hashContent(raw) === this.lastTokensHash) {
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT" && this.lastTokensHash === null) {
        return;
      }
    }

    if (this.tokenDebounceTimer !== null) {
      this.clock.clearTimeout(this.tokenDebounceTimer);
    }
    this.tokenDebounceTimer = this.clock.setTimeout(() => {
      this.tokenDebounceTimer = null;
      if (this.disposed || this.flushing) return;
      const changed = this.refreshOAuthIdsBestEffort();
      if (changed) {
        const diff = diffRegistries(this.lastNormalized, this.lastNormalized, {
          credentialsChanged: true,
        });
        this.emit({ snapshot: this.snapshot(), diff, reason: "external_watch" });
      }
    }, this.debounceMs);
  }

  private processExternalConnectionsChange(): void {
    const prevNorm = this.lastNormalized;
    const prevIssues = [...this.stickyIssues];
    const read = this.readConnectionsDiskState();

    // Suppress if disk content matches our last self-write
    if (read.status === "ok" && read.hash === this.lastConnectionsHash) {
      return;
    }

    this.applyDiskReadState(read);
    const credsChanged = this.refreshOAuthIdsBestEffort();
    const diff = diffRegistries(prevNorm, this.lastNormalized, {
      credentialsChanged: credsChanged,
      extraPrevIssues: prevIssues,
      extraNextIssues: this.stickyIssues,
    });
    const reason: RegistryStoreEvent["reason"] =
      read.status === "missing" && this.stickyIssues.some((i) => i.code === "registry_reset")
        ? "reset"
        : "external_watch";

    if (
      diff.changes.length > 0 ||
      diff.primaryChanged ||
      diff.launchModeChanged ||
      diff.issuesChanged ||
      diff.credentialsChanged ||
      reason === "reset"
    ) {
      this.emit({ snapshot: this.snapshot(), diff, reason });
    }
  }

  private emit(event: RegistryStoreEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private withWriteGuard<T>(fn: () => T): T {
    this.activeWrites += 1;
    try {
      return fn();
    } finally {
      this.activeWrites -= 1;
      if (this.activeWrites === 0 && this.flushWaiters.length > 0) {
        for (const waiter of this.flushWaiters.splice(0)) {
          waiter();
        }
      }
    }
  }

  private runConnectionMutation(
    buildNext: (
      currentDoc: RegistryDocument,
      oauthIds: Set<string>,
      normalized: NormalizedRegistryResult,
    ) =>
      | { ok: true; nextDoc: RegistryDocument }
      | {
          ok: false;
          errorCode: ErrorCode;
          issue: RegistryIssue;
          conflict?: DuplicateConflictSummary;
        },
  ): RegistryMutationResult {
    if (this.disposed || this.flushing) {
      return this.disposedFailure();
    }

    if (this.readOnlyReason) {
      return {
        ok: false,
        errorCode: "permission_denied",
        issue: {
          code: this.readOnlyReason,
          severity: "error",
          messageKey:
            this.readOnlyReason === "registry_corrupt"
              ? "registry.issue.corrupt"
              : this.readOnlyReason === "registry_unsupported"
                ? "registry.issue.unsupported"
                : "registry.issue.unavailable",
        },
        retryable: false,
        snapshot: this.snapshot(),
      };
    }

    // Fast pre-check against last-known snapshot before taking disk lock (writes=0 on client duplicate)
    const preCheck = buildNext(this.lastNormalized.doc, this.lastOAuthIds, this.lastNormalized);
    if (!preCheck.ok) {
      return {
        ok: false,
        errorCode: preCheck.errorCode,
        issue: preCheck.issue,
        retryable: false,
        snapshot: this.snapshot(),
        conflict: preCheck.conflict,
      };
    }

    return this.withWriteGuard(() => {
      try {
        return this.withStoreLock(this.connectionsPath, (verifyConnOwner) => {
          const read = this.readConnectionsDiskState();
          if (read.status === "corrupt" || read.status === "unsupported" || read.status === "unavailable") {
            this.applyDiskReadState(read);
            return {
              ok: false as const,
              errorCode: "permission_denied" as const,
              issue: this.stickyIssues[0],
              retryable: false,
              snapshot: this.snapshot(),
            };
          }

          const baseDoc = this.lastNormalized.doc;
          const prevNorm = this.lastNormalized;
          const prevIssues = [...this.stickyIssues];
          const diskNorm =
            read.status === "ok"
              ? read.normalized
              : normalizeRegistryDocument(createEmptyRegistryDocument());

          const warnings: RegistryIssue[] = [];
          let targetDoc: RegistryDocument;

          if (
            read.status === "ok" &&
            (diskNorm.doc.revision !== baseDoc.revision || read.hash !== this.lastConnectionsHash)
          ) {
            // Re-validate client mutation against disk state or rebase onto disk
            const localAttempt = buildNext(baseDoc, this.lastOAuthIds, this.lastNormalized);
            if (!localAttempt.ok) {
              return {
                ok: false as const,
                errorCode: localAttempt.errorCode,
                issue: localAttempt.issue,
                retryable: false,
                snapshot: this.snapshot(),
                conflict: localAttempt.conflict,
              };
            }
            const rebased = rebaseRegistry(baseDoc, localAttempt.nextDoc, diskNorm.doc);
            targetDoc = rebased.doc;
            warnings.push(...rebased.conflicts);
          } else {
            const checked = buildNext(diskNorm.doc, this.lastOAuthIds, diskNorm);
            if (!checked.ok) {
              return {
                ok: false as const,
                errorCode: checked.errorCode,
                issue: checked.issue,
                retryable: false,
                snapshot: this.snapshot(),
                conflict: checked.conflict,
              };
            }
            targetDoc = {
              ...checked.nextDoc,
              revision: diskNorm.doc.revision + 1,
            };
          }

          const finalNormalized = normalizeRegistryDocument(targetDoc);

          // Write pre-drop sidecar (0600) once per detection cycle before dropping unknown fields / downgrading future version
          if (
            read.status === "ok" &&
            read.normalized.hadFutureVersionOrUnknownFields &&
            this.preDropWrittenForHash !== read.hash
          ) {
            const sidecarPath = `${this.connectionsPath}.pre-drop-${this.clock.now()}.json`;
            this.atomicWriteFile0600(sidecarPath, read.rawText, verifyConnOwner);
            this.preDropWrittenForHash = read.hash;
            this.pendingPreDropRaw = null;
          } else if (this.pendingPreDropRaw !== null && read.status === "ok") {
            const sidecarPath = `${this.connectionsPath}.pre-drop-${this.clock.now()}.json`;
            this.atomicWriteFile0600(sidecarPath, this.pendingPreDropRaw, verifyConnOwner);
            this.preDropWrittenForHash = read.hash;
            this.pendingPreDropRaw = null;
          }

          const serialized = JSON.stringify(finalNormalized.doc, null, 2);
          this.atomicWriteFile0600(this.connectionsPath, serialized, verifyConnOwner);

          this.hadFileOnDisk = true;
          this.readOnlyReason = undefined;
          this.stickyIssues = [];
          this.lastConnectionsHash = hashContent(serialized);
          this.lastNormalized = finalNormalized;

          // Strictly AFTER connection write succeeded, reconcile OAuth tokens under token lock (still inside connection lock!)
          const tokenSync = this.reconcileTokensUnderConnectionLock(finalNormalized);
          if (!tokenSync.ok) {
            warnings.push(tokenSync.warning);
          }

          const diff = diffRegistries(prevNorm, finalNormalized, {
            credentialsChanged: tokenSync.ok ? tokenSync.changed : false,
            extraPrevIssues: prevIssues,
            extraNextIssues: [],
          });
          const snapshot = this.snapshot();
          this.emit({ snapshot, diff, reason: "mutation" });
          return {
            ok: true as const,
            snapshot,
            warnings,
            diff,
          };
        });
      } catch (err) {
        if (err instanceof RegistryBusyError) {
          return this.busyFailure();
        }
        return this.ioFailure();
      }
    });
  }

  private reconcileTokensUnderConnectionLock(
    normalized: NormalizedRegistryResult,
  ): { ok: true; changed: boolean } | { ok: false; warning: RegistryIssue } {
    try {
      const tokenFileExists = fs.existsSync(this.tokensPath);
      if (!tokenFileExists && !this.pendingTokenReconcile) {
        this.lastOAuthIds = new Set();
        return { ok: true, changed: false };
      }

      return this.withStoreLock(this.tokensPath, (verifyTokenOwner) => {
        const tokenDoc = this.readTokenDocForWrite();
        const nextTokens: Record<string, OAuthTokenSet> = {};
        let dropped = false;

        for (const [connId, entry] of Object.entries(tokenDoc.tokens)) {
          const conn = normalized.doc.connections.find((c) => c.id === connId);
          if (isOAuthTokenBoundToConnection(conn, entry, normalized.duplicateIds)) {
            nextTokens[connId] = entry;
          } else {
            dropped = true;
          }
        }

        if (!dropped && !this.pendingTokenReconcile) {
          this.lastOAuthIds = this.computeValidOAuthIds(normalized, tokenDoc);
          return { ok: true as const, changed: false };
        }

        if (dropped) {
          const nextDoc: TokenDocument = {
            version: 1,
            revision: tokenDoc.revision + 1,
            tokens: nextTokens,
            unbound: { ...tokenDoc.unbound },
            undecrypted: { ...tokenDoc.undecrypted },
          };
          const serialized = JSON.stringify(nextDoc, null, 2);
          this.atomicWriteFile0600(this.tokensPath, serialized, verifyTokenOwner);
          this.lastTokensHash = hashContent(serialized);
          this.lastOAuthIds = this.computeValidOAuthIds(normalized, nextDoc);
        }

        this.pendingTokenReconcile = false;
        return { ok: true as const, changed: dropped };
      });
    } catch {
      // Do NOT rollback connection write! Mark pending reconcile & emit token_sync_failed
      this.pendingTokenReconcile = true;
      return {
        ok: false,
        warning: {
          code: "token_sync_failed",
          severity: "warning",
          messageKey: "registry.issue.tokenSyncFailed",
        },
      };
    }
  }

  private readTokenDocForWrite(): TokenDocument {
    try {
      const raw = fs.readFileSync(this.tokensPath, "utf8");
      return normalizeTokenDoc(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return emptyTokenDoc();
      }
      throw err;
    }
  }

  private withStoreLock<T>(targetPath: string, fn: (verifyOwner: () => void) => T): T {
    let attempt = 0;
    while (true) {
      try {
        return this.acquireAndRunLock(targetPath, fn);
      } catch (err) {
        if (err instanceof RegistryBusyError && attempt === 0) {
          attempt += 1;
          this.clock.sleepSync(BUSY_BACKOFF_MS);
          continue;
        }
        throw err;
      }
    }
  }

  private acquireAndRunLock<T>(targetPath: string, fn: (verifyOwner: () => void) => T): T {
    const lockDir = `${targetPath}.lock`;
    const ownerFile = path.join(lockDir, "owner");
    const ownerToken = `${this.pid}-${this.randomToken()}`;
    const deadline = this.clock.now() + LOCK_TIMEOUT_MS;

    let acquired = false;
    while (!acquired) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        fs.writeFileSync(ownerFile, ownerToken, { mode: 0o600 });
        acquired = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") {
          throw err;
        }

        // Check stale lock (>10s) with double-check before replace
        let broken = false;
        try {
          const stat1 = fs.statSync(lockDir);
          if (this.clock.now() - stat1.mtimeMs > LOCK_STALE_MS) {
            let owner1: string | null = null;
            try {
              owner1 = fs.readFileSync(ownerFile, "utf8");
            } catch {
              owner1 = null;
            }
            const stat2 = fs.statSync(lockDir);
            let owner2: string | null = null;
            try {
              owner2 = fs.readFileSync(ownerFile, "utf8");
            } catch {
              owner2 = null;
            }
            if (
              this.clock.now() - stat2.mtimeMs > LOCK_STALE_MS &&
              stat1.mtimeMs === stat2.mtimeMs &&
              owner1 === owner2
            ) {
              fs.rmSync(lockDir, { recursive: true, force: true });
              broken = true;
            }
          }
        } catch {
          // Lock vanished while inspecting; retry immediately
          broken = true;
        }

        if (broken) {
          continue;
        }

        if (this.clock.now() >= deadline) {
          throw new RegistryBusyError();
        }
        this.clock.sleepSync(LOCK_POLL_MS);
      }
    }

    const ownsLock = (): boolean => {
      try {
        return fs.readFileSync(ownerFile, "utf8") === ownerToken;
      } catch {
        return false;
      }
    };

    const verifyOwner = (): void => {
      if (!ownsLock()) {
        throw new RegistryBusyError("Lock ownership lost before commit");
      }
    };

    try {
      return fn(verifyOwner);
    } finally {
      if (ownsLock()) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // best-effort release
        }
      }
    }
  }

  private atomicWriteFile0600(
    targetPath: string,
    content: string,
    verifyOwner: () => void,
  ): void {
    const tmpPath = `${targetPath}.hd.${this.pid}.${this.clock.now()}.${this.randomToken()}.tmp`;
    const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, content, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.chmodSync(tmpPath, 0o600);
      verifyOwner();
      fs.renameSync(tmpPath, targetPath);
      fs.chmodSync(targetPath, 0o600);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      throw err;
    }

    // Best-effort directory fsync
    try {
      const dirFd = fs.openSync(this.rootDir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // ignore on platforms/filesystems that reject dir fsync
    }
  }

  private disposedFailure(): RegistryMutationResult {
    return {
      ok: false,
      errorCode: "cancelled",
      issue: {
        code: "registry_unavailable",
        severity: "error",
        messageKey: "registry.issue.unavailable",
      },
      retryable: false,
      snapshot: this.snapshot(),
    };
  }

  private busyFailure(): RegistryMutationResult {
    return {
      ok: false,
      errorCode: "conflict",
      issue: {
        code: "registry_busy",
        severity: "warning",
        messageKey: "registry.issue.busy",
      },
      retryable: true,
      snapshot: this.snapshot(),
    };
  }

  private ioFailure(): RegistryMutationResult {
    return {
      ok: false,
      errorCode: "internal",
      issue: {
        code: "registry_unavailable",
        severity: "error",
        messageKey: "registry.issue.unavailable",
      },
      retryable: false,
      snapshot: this.snapshot(),
    };
  }
}
