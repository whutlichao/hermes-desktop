import type {
  ConnectionEntryDisplay,
  ConnectionKind,
  ConnectionMutationInput,
  DuplicateConflictSummary,
  LaunchMode,
  LaunchTargetResolution,
  RegistryConnectionChange,
  RegistryDiff,
  RegistryIssue,
  RegistrySnapshotView,
  RemoteAuthMode,
} from "@hermes/contracts";

export const REGISTRY_VERSION = 2 as const;
export const MAX_LABEL_LENGTH = 64;
export const MAX_QUARANTINED = 20;
export const DEFAULT_LOCAL_LABEL = "This device";

export interface SecretEnvelope {
  encoding: "plain" | string;
  value?: string;
  [key: string]: unknown;
}

export interface RegistryConnection {
  id: string;
  kind: ConnectionKind;
  label: string;
  url?: string;
  authMode?: RemoteAuthMode;
  token?: SecretEnvelope;
  headers?: Record<string, SecretEnvelope>;
  org?: string;
  name?: string;
  host?: string;
  user?: string;
  port?: number;
  keyPath?: string;
  remoteHermesPath?: string;
  remoteProfile?: string;
}

export interface RegistryDocument {
  version: typeof REGISTRY_VERSION;
  primary: string;
  launchMode: LaunchMode;
  lastUsed?: string;
  connections: RegistryConnection[];
  quarantined?: unknown[];
  revision: number;
  importedFrom?: Record<string, { at: number }>;
  quarantinedOverflow?: unknown[];
  importNotices?: string[];
}

export interface NormalizedRegistryResult {
  doc: RegistryDocument;
  unsupported: boolean;
  hadFutureVersionOrUnknownFields: boolean;
  droppedFieldCount: number;
  duplicateIds: Set<string>;
  duplicateOfMap: Map<string, string>;
  issues: RegistryIssue[];
}

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "version",
  "primary",
  "launchMode",
  "lastUsed",
  "connections",
  "quarantined",
  "revision",
  "importedFrom",
  "quarantinedOverflow",
  "importNotices",
]);

const KNOWN_CONNECTION_FIELDS = new Set([
  "id",
  "kind",
  "label",
  "url",
  "authMode",
  "token",
  "headers",
  "org",
  "name",
  "host",
  "user",
  "port",
  "keyPath",
  "remoteHermesPath",
  "remoteProfile",
]);

const VALID_KINDS = new Set<ConnectionKind>(["local", "remote", "ssh", "cloud"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSemanticUrl(rawUrl: string | undefined | null): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    // Strip default port when serialized
    const hostLower = parsed.host.toLowerCase();
    const pathClean = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${parsed.protocol.toLowerCase()}//${hostLower}${pathClean}`;
  } catch {
    return null;
  }
}

export function sanitizeOriginDisplay(rawUrl: string | undefined | null): string | undefined {
  return normalizeSemanticUrl(rawUrl) ?? undefined;
}

export function canonicalSshTarget(input: {
  user?: string;
  host?: string;
  port?: number;
  remoteProfile?: string;
}): string | null {
  const host = typeof input.host === "string" ? input.host.trim().toLowerCase() : "";
  if (!host) return null;
  const user = typeof input.user === "string" ? input.user.trim().toLowerCase() : "";
  const port =
    typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 && input.port <= 65535
      ? input.port
      : 22;
  const profile = typeof input.remoteProfile === "string" ? input.remoteProfile.trim() : "";
  return `${user}@${host}:${port}::${profile}`;
}

export function formatSshTargetDisplay(conn: Pick<RegistryConnection, "user" | "host" | "port">): string | undefined {
  const host = conn.host?.trim();
  if (!host) return undefined;
  const user = conn.user?.trim();
  const port = conn.port ?? 22;
  const prefix = user ? `${user}@${host}` : host;
  return port === 22 ? prefix : `${prefix}:${port}`;
}

export function getCanonicalIdentity(conn: Pick<RegistryConnection, "kind" | "url" | "user" | "host" | "port" | "remoteProfile">): string | null {
  if (conn.kind === "local") return "local";
  if (conn.kind === "remote" || conn.kind === "cloud") {
    const url = normalizeSemanticUrl(conn.url);
    return url ? `url:${url}` : null;
  }
  if (conn.kind === "ssh") {
    const ssh = canonicalSshTarget(conn);
    return ssh ? `ssh:${ssh}` : null;
  }
  return null;
}

function normalizeSecretEnvelope(raw: unknown): SecretEnvelope | undefined {
  if (typeof raw === "string") {
    const trimmed = raw;
    if (trimmed.length === 0) return undefined;
    return { encoding: "plain", value: trimmed };
  }
  if (isPlainObject(raw)) {
    const encoding = typeof raw.encoding === "string" ? raw.encoding : "plain";
    return { ...raw, encoding };
  }
  return undefined;
}

function normalizeHeadersMap(raw: unknown): Record<string, SecretEnvelope> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, SecretEnvelope> = {};
  for (const [key, val] of Object.entries(raw)) {
    const k = key.trim();
    if (!k) continue;
    const env = normalizeSecretEnvelope(val);
    if (env) out[k] = env;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function slugifyLabel(label: string, usedIds: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "gateway";
  let candidate = base;
  let n = 2;
  while (usedIds.has(candidate) || candidate === "local") {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function makeUniqueLabel(rawLabel: string, usedLowerLabels: Set<string>, fallback: string): string {
  let base = rawLabel.trim();
  if (!base) base = fallback;
  if (base.length > MAX_LABEL_LENGTH) {
    base = base.slice(0, MAX_LABEL_LENGTH).trim() || fallback;
  }
  if (!usedLowerLabels.has(base.toLowerCase())) {
    usedLowerLabels.add(base.toLowerCase());
    return base;
  }
  let suffixNum = 2;
  while (true) {
    const suffix = ` ${suffixNum}`;
    const maxBaseLen = MAX_LABEL_LENGTH - suffix.length;
    const truncated = base.slice(0, maxBaseLen).trimEnd();
    const candidate = `${truncated}${suffix}`;
    if (!usedLowerLabels.has(candidate.toLowerCase())) {
      usedLowerLabels.add(candidate.toLowerCase());
      return candidate;
    }
    suffixNum += 1;
  }
}

function normalizeSingleConnection(
  raw: Record<string, unknown>,
): { valid: true; conn: RegistryConnection; unknownFieldCount: number } | { valid: false } {
  const kind = raw.kind;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind as ConnectionKind)) {
    return { valid: false };
  }

  let unknownFieldCount = 0;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONNECTION_FIELDS.has(key)) {
      unknownFieldCount += 1;
    }
  }

  const typedKind = kind as ConnectionKind;
  const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";

  if (typedKind === "local") {
    return {
      valid: true,
      conn: {
        id: rawId || "local",
        kind: "local",
        label: rawLabel || DEFAULT_LOCAL_LABEL,
      },
      unknownFieldCount,
    };
  }

  if (typedKind === "remote" || typedKind === "cloud") {
    const normalizedUrl = normalizeSemanticUrl(typeof raw.url === "string" ? raw.url : null);
    if (!normalizedUrl) {
      return { valid: false };
    }
    const authMode: RemoteAuthMode = raw.authMode === "oauth" ? "oauth" : "token";
    const token = normalizeSecretEnvelope(raw.token);
    const headers = normalizeHeadersMap(raw.headers);

    const conn: RegistryConnection = {
      id: rawId,
      kind: typedKind,
      label: rawLabel,
      url: normalizedUrl,
      authMode,
    };
    if (token) conn.token = token;
    if (headers) conn.headers = headers;
    if (typedKind === "cloud") {
      if (typeof raw.org === "string" && raw.org.trim()) conn.org = raw.org.trim();
      if (typeof raw.name === "string" && raw.name.trim()) conn.name = raw.name.trim();
    }
    return { valid: true, conn, unknownFieldCount };
  }

  // SSH
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (!host) {
    return { valid: false };
  }
  const user = typeof raw.user === "string" ? raw.user.trim() : undefined;
  const parsedPort =
    typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535
      ? raw.port
      : undefined;

  const conn: RegistryConnection = {
    id: rawId,
    kind: "ssh",
    label: rawLabel,
    host,
  };
  if (user) conn.user = user;
  if (parsedPort !== undefined && parsedPort !== 22) conn.port = parsedPort;
  if (typeof raw.keyPath === "string" && raw.keyPath.trim()) conn.keyPath = raw.keyPath.trim();
  if (typeof raw.remoteHermesPath === "string" && raw.remoteHermesPath.trim()) {
    conn.remoteHermesPath = raw.remoteHermesPath.trim();
  }
  if (typeof raw.remoteProfile === "string" && raw.remoteProfile.trim()) {
    conn.remoteProfile = raw.remoteProfile.trim();
  }
  const token = normalizeSecretEnvelope(raw.token);
  if (token) conn.token = token;

  return { valid: true, conn, unknownFieldCount };
}

export function createEmptyRegistryDocument(): RegistryDocument {
  return {
    version: REGISTRY_VERSION,
    primary: "local",
    launchMode: "primary",
    connections: [
      {
        id: "local",
        kind: "local",
        label: DEFAULT_LOCAL_LABEL,
      },
    ],
    revision: 0,
  };
}

export function normalizeRegistryDocument(raw: unknown): NormalizedRegistryResult {
  if (!isPlainObject(raw)) {
    return {
      doc: createEmptyRegistryDocument(),
      unsupported: true,
      hadFutureVersionOrUnknownFields: false,
      droppedFieldCount: 0,
      duplicateIds: new Set(),
      duplicateOfMap: new Map(),
      issues: [
        {
          code: "registry_unsupported",
          severity: "error",
          messageKey: "registry.issue.unsupported",
        },
      ],
    };
  }

  if (
    raw.version !== undefined &&
    (typeof raw.version !== "number" || !Number.isFinite(raw.version) || raw.version < 1)
  ) {
    return {
      doc: createEmptyRegistryDocument(),
      unsupported: true,
      hadFutureVersionOrUnknownFields: false,
      droppedFieldCount: 0,
      duplicateIds: new Set(),
      duplicateOfMap: new Map(),
      issues: [
        {
          code: "registry_unsupported",
          severity: "error",
          messageKey: "registry.issue.unsupported",
        },
      ],
    };
  }

  if (!Array.isArray(raw.connections)) {
    return {
      doc: createEmptyRegistryDocument(),
      unsupported: true,
      hadFutureVersionOrUnknownFields: false,
      droppedFieldCount: 0,
      duplicateIds: new Set(),
      duplicateOfMap: new Map(),
      issues: [
        {
          code: "registry_unsupported",
          severity: "error",
          messageKey: "registry.issue.unsupported",
        },
      ],
    };
  }

  let droppedFieldCount = 0;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      droppedFieldCount += 1;
    }
  }
  const isFutureVersion = typeof raw.version === "number" && raw.version > REGISTRY_VERSION;

  const existingQuarantined = Array.isArray(raw.quarantined) ? [...raw.quarantined] : [];
  const existingOverflow = Array.isArray(raw.quarantinedOverflow) ? [...raw.quarantinedOverflow] : [];
  const newlyQuarantined: unknown[] = [];

  const parsedEntries: Array<{ conn: RegistryConnection; rawIndex: number }> = [];
  for (let i = 0; i < raw.connections.length; i += 1) {
    const item = raw.connections[i];
    if (!isPlainObject(item)) {
      newlyQuarantined.push(item);
      continue;
    }
    const res = normalizeSingleConnection(item);
    if (!res.valid) {
      newlyQuarantined.push(item);
      continue;
    }
    droppedFieldCount += res.unknownFieldCount;
    parsedEntries.push({ conn: res.conn, rawIndex: i });
  }

  const allQuarantined = [...existingQuarantined, ...newlyQuarantined];
  const quarantined = allQuarantined.slice(0, MAX_QUARANTINED);
  const overflowItems = [...existingOverflow, ...allQuarantined.slice(MAX_QUARANTINED)];

  // Ensure Local invariant (first local entry becomes id:'local', or synthesized)
  const usedIds = new Set<string>();
  const usedLabels = new Set<string>();
  const canonicalByIdentity = new Map<string, string>(); // identity -> canonical connectionId
  const duplicateIds = new Set<string>();
  const duplicateOfMap = new Map<string, string>();
  const issues: RegistryIssue[] = [];

  let localSeen = false;
  const connections: RegistryConnection[] = [];

  for (const entry of parsedEntries) {
    const conn = { ...entry.conn };

    if (conn.kind === "local") {
      if (!localSeen) {
        localSeen = true;
        conn.id = "local";
        usedIds.add("local");
        conn.label = makeUniqueLabel(conn.label || DEFAULT_LOCAL_LABEL, usedLabels, DEFAULT_LOCAL_LABEL);
        canonicalByIdentity.set("local", "local");
        connections.push(conn);
      } else {
        // Extra external local entry -> retain as non-dialable registry_invalid
        const dupId = conn.id && conn.id !== "local" && !usedIds.has(conn.id)
          ? conn.id
          : slugifyLabel(conn.label || "local-dup", usedIds);
        conn.id = dupId;
        usedIds.add(dupId);
        conn.label = makeUniqueLabel(conn.label || DEFAULT_LOCAL_LABEL, usedLabels, DEFAULT_LOCAL_LABEL);
        duplicateIds.add(dupId);
        duplicateOfMap.set(dupId, "local");
        connections.push(conn);
        issues.push({
          code: "registry_invalid",
          severity: "warning",
          connectionId: dupId,
          entryIndex: entry.rawIndex,
          identity: "local",
          messageKey: "registry.issue.externalDuplicate",
        });
      }
      continue;
    }

    const fallbackLabel =
      conn.kind === "ssh"
        ? conn.host || "SSH Gateway"
        : conn.url?.replace(/^https?:\/\//, "") || "Remote Gateway";
    conn.label = makeUniqueLabel(conn.label, usedLabels, fallbackLabel);

    if (!conn.id || conn.id === "local" || usedIds.has(conn.id)) {
      conn.id = slugifyLabel(conn.label, usedIds);
    }
    usedIds.add(conn.id);

    const identity = getCanonicalIdentity(conn);
    if (identity) {
      const existingCanonical = canonicalByIdentity.get(identity);
      if (existingCanonical) {
        duplicateIds.add(conn.id);
        duplicateOfMap.set(conn.id, existingCanonical);
        issues.push({
          code: "registry_invalid",
          severity: "warning",
          connectionId: conn.id,
          entryIndex: entry.rawIndex,
          identity,
          messageKey: "registry.issue.externalDuplicate",
        });
      } else {
        canonicalByIdentity.set(identity, conn.id);
      }
    }

    connections.push(conn);
  }

  if (!localSeen) {
    const localLabel = makeUniqueLabel(DEFAULT_LOCAL_LABEL, usedLabels, DEFAULT_LOCAL_LABEL);
    connections.unshift({
      id: "local",
      kind: "local",
      label: localLabel,
    });
    usedIds.add("local");
    canonicalByIdentity.set("local", "local");
  }

  const hadFutureVersionOrUnknownFields = isFutureVersion || droppedFieldCount > 0;
  if (hadFutureVersionOrUnknownFields) {
    issues.push({
      code: "registry_future_version",
      severity: "warning",
      count: droppedFieldCount + (isFutureVersion ? 1 : 0),
      messageKey: "registry.issue.futureVersion",
    });
  }

  const launchMode: LaunchMode = raw.launchMode === "last-used" ? "last-used" : "primary";
  const rawPrimary = typeof raw.primary === "string" && raw.primary.trim() ? raw.primary.trim() : "local";
  const primary = usedIds.has(rawPrimary) && !duplicateIds.has(rawPrimary) ? rawPrimary : "local";
  const rawLastUsed = typeof raw.lastUsed === "string" && raw.lastUsed.trim() ? raw.lastUsed.trim() : undefined;
  const lastUsed = rawLastUsed && usedIds.has(rawLastUsed) ? rawLastUsed : undefined;
  const revision =
    typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0;

  const doc: RegistryDocument = {
    version: REGISTRY_VERSION,
    primary,
    launchMode,
    connections,
    revision,
  };
  if (lastUsed) doc.lastUsed = lastUsed;
  if (quarantined.length > 0) doc.quarantined = quarantined;
  if (overflowItems.length > 0) doc.quarantinedOverflow = overflowItems;

  if (isPlainObject(raw.importedFrom)) {
    const importedFrom: Record<string, { at: number }> = {};
    for (const [k, v] of Object.entries(raw.importedFrom)) {
      if (isPlainObject(v) && typeof v.at === "number" && Number.isFinite(v.at)) {
        importedFrom[k] = { at: v.at };
      }
    }
    if (Object.keys(importedFrom).length > 0) doc.importedFrom = importedFrom;
  }

  if (Array.isArray(raw.importNotices)) {
    const notices = raw.importNotices.filter((n): n is string => typeof n === "string" && n.trim().length > 0);
    if (notices.length > 0) doc.importNotices = Array.from(new Set(notices));
  }

  return {
    doc,
    unsupported: false,
    hadFutureVersionOrUnknownFields,
    droppedFieldCount,
    duplicateIds,
    duplicateOfMap,
    issues,
  };
}

export function resolveLaunchTarget(
  doc: Pick<RegistryDocument, "primary" | "launchMode" | "lastUsed" | "connections">,
  duplicateIds: Set<string> = new Set(),
): LaunchTargetResolution {
  const isValidDialable = (id: string | undefined | null): id is string => {
    if (!id) return false;
    if (duplicateIds.has(id)) return false;
    const entry = doc.connections.find((c) => c.id === id);
    if (!entry) return false;
    if (entry.kind === "cloud") return false;
    return true;
  };

  if (doc.launchMode === "last-used" && isValidDialable(doc.lastUsed)) {
    return {
      connectionId: doc.lastUsed,
      reason: "last_used",
      launchMode: doc.launchMode,
    };
  }

  if (isValidDialable(doc.primary)) {
    return {
      connectionId: doc.primary,
      reason: "primary",
      launchMode: doc.launchMode,
    };
  }

  if (isValidDialable("local")) {
    return {
      connectionId: "local",
      reason: "local",
      launchMode: doc.launchMode,
    };
  }

  return {
    connectionId: null,
    reason: "empty",
    launchMode: doc.launchMode,
  };
}

function buildSafeConflictSummary(
  conflictKind: "duplicate_identity" | "duplicate_label",
  existing: RegistryConnection,
  oauthTokenIds: Set<string>,
): DuplicateConflictSummary {
  const hostDisplay =
    existing.kind === "ssh"
      ? formatSshTargetDisplay(existing)
      : existing.kind === "local"
        ? "local"
        : sanitizeOriginDisplay(existing.url);

  const hasToken =
    Boolean(existing.token?.value) ||
    Boolean(existing.headers && Object.keys(existing.headers).length > 0) ||
    oauthTokenIds.has(existing.id);

  return {
    conflictKind,
    existing: {
      id: existing.id,
      label: existing.label,
      kind: existing.kind,
      hostDisplay,
      hasToken,
    },
  };
}

export type ClientValidationResult =
  | { ok: true; connection: RegistryConnection }
  | { ok: false; issue: RegistryIssue; conflict?: DuplicateConflictSummary };

export function validateClientAddConnection(
  doc: RegistryDocument,
  input: ConnectionMutationInput,
  oauthTokenIds: Set<string> = new Set(),
): ClientValidationResult {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      issue: {
        code: "registry_invalid",
        severity: "error",
        messageKey: "registry.issue.invalidInput",
      },
    };
  }

  if (input.kind === "local") {
    const localConn = doc.connections.find((c) => c.id === "local");
    return {
      ok: false,
      issue: {
        code: "duplicate_identity",
        severity: "warning",
        connectionId: "local",
        identity: "local",
        messageKey: "registry.issue.duplicateIdentity",
      },
      conflict: localConn
        ? buildSafeConflictSummary("duplicate_identity", localConn, oauthTokenIds)
        : undefined,
    };
  }

  const labelClash = doc.connections.find((c) => c.label.toLowerCase() === label.toLowerCase());
  if (labelClash) {
    return {
      ok: false,
      issue: {
        code: "duplicate_label",
        severity: "warning",
        connectionId: labelClash.id,
        identity: labelClash.label,
        messageKey: "registry.issue.duplicateLabel",
      },
      conflict: buildSafeConflictSummary("duplicate_label", labelClash, oauthTokenIds),
    };
  }

  const candidate = buildConnectionFromInput(
    slugifyLabel(label, new Set(doc.connections.map((c) => c.id))),
    input,
    label,
  );
  if (!candidate) {
    return {
      ok: false,
      issue: {
        code: "registry_invalid",
        severity: "error",
        messageKey: "registry.issue.invalidInput",
      },
    };
  }

  const candidateIdentity = getCanonicalIdentity(candidate);
  if (candidateIdentity) {
    const identityClash = doc.connections.find((c) => getCanonicalIdentity(c) === candidateIdentity);
    if (identityClash) {
      return {
        ok: false,
        issue: {
          code: "duplicate_identity",
          severity: "warning",
          connectionId: identityClash.id,
          identity: candidateIdentity,
          messageKey: "registry.issue.duplicateIdentity",
        },
        conflict: buildSafeConflictSummary("duplicate_identity", identityClash, oauthTokenIds),
      };
    }
  }

  return { ok: true, connection: candidate };
}

export function validateClientUpdateConnection(
  doc: RegistryDocument,
  connectionId: string,
  input: ConnectionMutationInput,
  oauthTokenIds: Set<string> = new Set(),
): ClientValidationResult {
  const existing = doc.connections.find((c) => c.id === connectionId);
  if (!existing) {
    return {
      ok: false,
      issue: {
        code: "registry_invalid",
        severity: "error",
        connectionId,
        messageKey: "registry.issue.notFound",
      },
    };
  }

  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      issue: {
        code: "registry_invalid",
        severity: "error",
        connectionId,
        messageKey: "registry.issue.invalidInput",
      },
    };
  }

  const labelClash = doc.connections.find(
    (c) => c.id !== connectionId && c.label.toLowerCase() === label.toLowerCase(),
  );
  if (labelClash) {
    return {
      ok: false,
      issue: {
        code: "duplicate_label",
        severity: "warning",
        connectionId: labelClash.id,
        identity: labelClash.label,
        messageKey: "registry.issue.duplicateLabel",
      },
      conflict: buildSafeConflictSummary("duplicate_label", labelClash, oauthTokenIds),
    };
  }

  if (existing.kind === "local") {
    if (input.kind !== "local") {
      return {
        ok: false,
        issue: {
          code: "registry_invalid",
          severity: "error",
          connectionId,
          messageKey: "registry.issue.invalidInput",
        },
      };
    }
    return {
      ok: true,
      connection: {
        id: "local",
        kind: "local",
        label,
      },
    };
  }

  const candidate = buildConnectionFromInput(connectionId, input, label, existing);
  if (!candidate) {
    return {
      ok: false,
      issue: {
        code: "registry_invalid",
        severity: "error",
        connectionId,
        messageKey: "registry.issue.invalidInput",
      },
    };
  }

  const candidateIdentity = getCanonicalIdentity(candidate);
  if (candidateIdentity) {
    const identityClash = doc.connections.find(
      (c) => c.id !== connectionId && getCanonicalIdentity(c) === candidateIdentity,
    );
    if (identityClash) {
      return {
        ok: false,
        issue: {
          code: "duplicate_identity",
          severity: "warning",
          connectionId: identityClash.id,
          identity: candidateIdentity,
          messageKey: "registry.issue.duplicateIdentity",
        },
        conflict: buildSafeConflictSummary("duplicate_identity", identityClash, oauthTokenIds),
      };
    }
  }

  return { ok: true, connection: candidate };
}

export function validateClientRemoveConnection(
  doc: RegistryDocument,
  connectionId: string,
): { ok: true } | { ok: false; issue: RegistryIssue } {
  if (connectionId === "local") {
    return {
      ok: false,
      issue: {
        code: "local_not_removable",
        severity: "warning",
        connectionId: "local",
        messageKey: "registry.issue.localNotRemovable",
      },
    };
  }
  const exists = doc.connections.some((c) => c.id === connectionId);
  if (!exists) {
    return {
      ok: false,
      issue: {
        code: "registry_invalid",
        severity: "error",
        connectionId,
        messageKey: "registry.issue.notFound",
      },
    };
  }
  return { ok: true };
}

function buildConnectionFromInput(
  id: string,
  input: ConnectionMutationInput,
  label: string,
  existing?: RegistryConnection,
): RegistryConnection | null {
  if (input.kind === "remote" || input.kind === "cloud") {
    const normalizedUrl = normalizeSemanticUrl(input.url);
    if (!normalizedUrl) return null;
    const authMode: RemoteAuthMode = input.authMode === "oauth" ? "oauth" : "token";
    const conn: RegistryConnection = {
      id,
      kind: input.kind,
      label,
      url: normalizedUrl,
      authMode,
    };

    if (input.token !== undefined && input.token.length > 0) {
      conn.token = { encoding: "plain", value: input.token };
    } else if (!input.clearToken && existing?.token) {
      conn.token = existing.token;
    }

    if (input.headers && Object.keys(input.headers).length > 0) {
      const headers: Record<string, SecretEnvelope> = {};
      for (const [k, v] of Object.entries(input.headers)) {
        if (k.trim() && v) {
          headers[k.trim()] = { encoding: "plain", value: v };
        }
      }
      if (Object.keys(headers).length > 0) conn.headers = headers;
    } else if (!input.clearToken && existing?.headers) {
      conn.headers = existing.headers;
    }

    if (input.kind === "cloud") {
      if (input.org?.trim()) conn.org = input.org.trim();
      if (input.name?.trim()) conn.name = input.name.trim();
    }
    return conn;
  }

  if (input.kind === "ssh") {
    const host = input.host?.trim();
    if (!host) return null;
    const conn: RegistryConnection = {
      id,
      kind: "ssh",
      label,
      host,
    };
    if (input.user?.trim()) conn.user = input.user.trim();
    if (
      typeof input.port === "number" &&
      Number.isInteger(input.port) &&
      input.port > 0 &&
      input.port <= 65535 &&
      input.port !== 22
    ) {
      conn.port = input.port;
    }
    if (input.keyPath !== undefined) {
      if (input.keyPath.trim()) conn.keyPath = input.keyPath.trim();
    } else if (existing?.keyPath) {
      conn.keyPath = existing.keyPath;
    }
    if (input.remoteHermesPath !== undefined) {
      if (input.remoteHermesPath.trim()) conn.remoteHermesPath = input.remoteHermesPath.trim();
    } else if (existing?.remoteHermesPath) {
      conn.remoteHermesPath = existing.remoteHermesPath;
    }
    if (input.remoteProfile?.trim()) conn.remoteProfile = input.remoteProfile.trim();
    if (input.token !== undefined && input.token.length > 0) {
      conn.token = { encoding: "plain", value: input.token };
    } else if (!input.clearToken && existing?.token) {
      conn.token = existing.token;
    }
    return conn;
  }

  return null;
}

export interface ProjectionOptions {
  oauthTokenIds?: Set<string>;
  extraIssues?: RegistryIssue[];
  readOnly?: boolean;
  readOnlyReason?: "registry_corrupt" | "registry_unsupported" | "registry_unavailable";
}

export function projectRegistrySnapshot(
  normalized: NormalizedRegistryResult,
  options: ProjectionOptions = {},
): RegistrySnapshotView {
  const { doc, duplicateIds, duplicateOfMap } = normalized;
  const oauthTokenIds = options.oauthTokenIds ?? new Set<string>();
  const nextLaunch = resolveLaunchTarget(doc, duplicateIds);

  const issueMap = new Map<string, RegistryIssue[]>();
  const allIssues = [...normalized.issues, ...(options.extraIssues ?? [])];
  for (const issue of allIssues) {
    if (issue.connectionId) {
      const list = issueMap.get(issue.connectionId) ?? [];
      list.push(issue);
      issueMap.set(issue.connectionId, list);
    }
  }

  const connections: ConnectionEntryDisplay[] = doc.connections.map((conn) => {
    const isDuplicate = duplicateIds.has(conn.id);
    const dialable = !isDuplicate && conn.kind !== "cloud";
    const hasStaticToken = Boolean(conn.token?.value);
    const hasOAuthToken = conn.authMode === "oauth" && oauthTokenIds.has(conn.id);
    const connIssues = issueMap.get(conn.id);

    const display: ConnectionEntryDisplay = {
      id: conn.id,
      kind: conn.kind,
      label: conn.label,
      isLocal: conn.kind === "local",
      isPrimary: doc.primary === conn.id,
      isLastUsed: doc.lastUsed === conn.id,
      isNextLaunch: nextLaunch.connectionId === conn.id,
      dialable,
      hasToken: hasStaticToken || hasOAuthToken,
    };

    if (conn.headers && Object.keys(conn.headers).length > 0) {
      display.hasHeaders = true;
    }
    if (conn.authMode) {
      display.authMode = conn.authMode;
    }
    if (conn.kind === "remote" || conn.kind === "cloud") {
      display.originDisplay = sanitizeOriginDisplay(conn.url);
    }
    if (conn.kind === "ssh") {
      display.sshTargetDisplay = formatSshTargetDisplay(conn);
      display.sshHost = conn.host;
      if (conn.user) display.sshUser = conn.user;
      display.sshPort = conn.port ?? 22;
      if (conn.remoteProfile) display.remoteProfile = conn.remoteProfile;
    }
    if (conn.kind === "cloud") {
      if (conn.org) display.org = conn.org;
      if (conn.name) display.name = conn.name;
    }
    if (isDuplicate) {
      display.duplicateOfId = duplicateOfMap.get(conn.id);
    }
    if (connIssues && connIssues.length > 0) {
      display.issueCodes = connIssues.map((i) => i.code);
    }
    return display;
  });

  return {
    version: doc.version,
    revision: doc.revision,
    primary: doc.primary,
    launchMode: doc.launchMode,
    lastUsed: doc.lastUsed ?? null,
    nextLaunch,
    connections,
    issues: allIssues,
    readOnly: Boolean(options.readOnly),
    readOnlyReason: options.readOnlyReason,
    quarantinedCount: doc.quarantined?.length ?? 0,
    importNoticeCount: doc.importNotices?.length ?? 0,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function isConnectionEqual(a: RegistryConnection, b: RegistryConnection): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function hasDialMaterialChanged(
  prev: RegistryConnection,
  next: RegistryConnection,
  prevDialable = true,
  nextDialable = true,
): boolean {
  if (prevDialable !== nextDialable) return true;
  const stripLabel = (c: RegistryConnection) => ({
    ...c,
    label: "",
  });
  return stableStringify(stripLabel(prev)) !== stableStringify(stripLabel(next));
}

export interface RebaseResult {
  doc: RegistryDocument;
  conflicts: RegistryIssue[];
}

export function rebaseRegistry(
  base: RegistryDocument,
  next: RegistryDocument,
  disk: RegistryDocument,
): RebaseResult {
  const conflicts: RegistryIssue[] = [];

  const baseById = new Map(base.connections.map((c) => [c.id, c]));
  const nextById = new Map(next.connections.map((c) => [c.id, c]));
  const diskById = new Map(disk.connections.map((c) => [c.id, c]));

  const deletedLocally = new Set<string>();
  for (const b of base.connections) {
    if (!nextById.has(b.id) && b.id !== "local") {
      deletedLocally.add(b.id);
      const diskConn = diskById.get(b.id);
      if (diskConn && !isConnectionEqual(b, diskConn)) {
        conflicts.push({
          code: "registry_conflict",
          severity: "warning",
          connectionId: b.id,
          messageKey: "registry.issue.conflict",
        });
      }
    }
  }

  const touchedLocally = new Map<string, RegistryConnection>();
  for (const n of next.connections) {
    const b = baseById.get(n.id);
    if (!b || !isConnectionEqual(b, n)) {
      touchedLocally.set(n.id, n);
      const d = diskById.get(n.id);
      if (b && (!d || !isConnectionEqual(b, d))) {
        conflicts.push({
          code: "registry_conflict",
          severity: "warning",
          connectionId: n.id,
          messageKey: "registry.issue.conflict",
        });
      } else if (!b && d && !isConnectionEqual(d, n)) {
        conflicts.push({
          code: "registry_conflict",
          severity: "warning",
          connectionId: n.id,
          messageKey: "registry.issue.conflict",
        });
      }
    }
  }

  const mergedConnections: RegistryConnection[] = [];
  const seenIds = new Set<string>();

  for (const d of disk.connections) {
    if (deletedLocally.has(d.id)) {
      continue;
    }
    const localOverride = touchedLocally.get(d.id);
    mergedConnections.push(localOverride ?? d);
    seenIds.add(d.id);
  }

  for (const n of next.connections) {
    if (!seenIds.has(n.id) && touchedLocally.has(n.id)) {
      mergedConnections.push(n);
      seenIds.add(n.id);
    }
  }

  // Scalar fields: only overwrite disk if this process changed them
  let primary = disk.primary;
  if (next.primary !== base.primary) {
    if (disk.primary !== base.primary && disk.primary !== next.primary) {
      conflicts.push({
        code: "registry_conflict",
        severity: "warning",
        connectionId: next.primary,
        messageKey: "registry.issue.conflict",
      });
    }
    primary = next.primary;
  }

  let launchMode = disk.launchMode;
  if (next.launchMode !== base.launchMode) {
    if (disk.launchMode !== base.launchMode && disk.launchMode !== next.launchMode) {
      conflicts.push({
        code: "registry_conflict",
        severity: "warning",
        messageKey: "registry.issue.conflict",
      });
    }
    launchMode = next.launchMode;
  }

  let lastUsed = disk.lastUsed;
  if (next.lastUsed !== base.lastUsed) {
    if (disk.lastUsed !== base.lastUsed && disk.lastUsed !== next.lastUsed) {
      conflicts.push({
        code: "registry_conflict",
        severity: "warning",
        messageKey: "registry.issue.conflict",
      });
    }
    lastUsed = next.lastUsed;
  }

  // importedFrom union
  const importedFrom: Record<string, { at: number }> = {
    ...(disk.importedFrom ?? {}),
    ...(next.importedFrom ?? {}),
  };

  // quarantined + overflow append
  const baseQuarantinedLen = base.quarantined?.length ?? 0;
  const nextQuarantinedChanged =
    stableStringify(base.quarantined ?? []) !== stableStringify(next.quarantined ?? []);
  const combinedQuarantined: unknown[] = [...(disk.quarantined ?? [])];
  if (nextQuarantinedChanged && next.quarantined) {
    const addedByNext = next.quarantined.slice(baseQuarantinedLen);
    for (const item of addedByNext) {
      combinedQuarantined.push(item);
    }
  }
  const quarantined = combinedQuarantined.slice(0, MAX_QUARANTINED);
  const newOverflow = combinedQuarantined.slice(MAX_QUARANTINED);
  const quarantinedOverflow = [
    ...(disk.quarantinedOverflow ?? []),
    ...(next.quarantinedOverflow ?? []).filter(
      (item) => !(disk.quarantinedOverflow ?? []).some((d) => stableStringify(d) === stableStringify(item)),
    ),
    ...newOverflow,
  ];

  // importNotices recomputed
  const importNotices = Array.from(
    new Set([...(disk.importNotices ?? []), ...(next.importNotices ?? [])]),
  );

  const normalized = normalizeRegistryDocument({
    version: REGISTRY_VERSION,
    primary,
    launchMode,
    lastUsed,
    connections: mergedConnections,
    quarantined: quarantined.length > 0 ? quarantined : undefined,
    quarantinedOverflow: quarantinedOverflow.length > 0 ? quarantinedOverflow : undefined,
    importedFrom: Object.keys(importedFrom).length > 0 ? importedFrom : undefined,
    importNotices: importNotices.length > 0 ? importNotices : undefined,
    revision: disk.revision + 1,
  });

  return {
    doc: normalized.doc,
    conflicts,
  };
}

export interface DiffOptions {
  credentialsChanged?: boolean;
  extraPrevIssues?: RegistryIssue[];
  extraNextIssues?: RegistryIssue[];
}

export function diffRegistries(
  prev: NormalizedRegistryResult,
  next: NormalizedRegistryResult,
  options: DiffOptions = {},
): RegistryDiff {
  const prevById = new Map(prev.doc.connections.map((c) => [c.id, c]));
  const nextById = new Map(next.doc.connections.map((c) => [c.id, c]));
  const changes: RegistryConnectionChange[] = [];

  for (const prevConn of prev.doc.connections) {
    const nextConn = nextById.get(prevConn.id);
    if (!nextConn) {
      changes.push({
        kind: "connection_removed",
        connectionId: prevConn.id,
        dialMaterialChanged: true,
      });
    } else if (
      !isConnectionEqual(prevConn, nextConn) ||
      prev.duplicateIds.has(prevConn.id) !== next.duplicateIds.has(nextConn.id)
    ) {
      const materialChanged = hasDialMaterialChanged(
        prevConn,
        nextConn,
        !prev.duplicateIds.has(prevConn.id) && prevConn.kind !== "cloud",
        !next.duplicateIds.has(nextConn.id) && nextConn.kind !== "cloud",
      );
      changes.push({
        kind: "connection_updated",
        connectionId: nextConn.id,
        dialMaterialChanged: materialChanged,
      });
    }
  }

  for (const nextConn of next.doc.connections) {
    if (!prevById.has(nextConn.id)) {
      changes.push({
        kind: "connection_added",
        connectionId: nextConn.id,
        dialMaterialChanged: true,
      });
    }
  }

  const prevIssues = [...prev.issues, ...(options.extraPrevIssues ?? [])];
  const nextIssues = [...next.issues, ...(options.extraNextIssues ?? [])];

  return {
    changes,
    dialMaterialChanged: changes.some((c) => c.dialMaterialChanged),
    primaryChanged: prev.doc.primary !== next.doc.primary,
    launchModeChanged: prev.doc.launchMode !== next.doc.launchMode,
    issuesChanged: stableStringify(prevIssues) !== stableStringify(nextIssues),
    credentialsChanged: Boolean(options.credentialsChanged),
  };
}
