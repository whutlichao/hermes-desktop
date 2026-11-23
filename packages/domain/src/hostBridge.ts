import {
  ERROR_CODES,
  HOST_BRIDGE_VERSION,
  HOST_COMMANDS,
  HOST_TOPICS,
  type BridgeError,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type ErrorCode,
  type HostCommand,
  type HostRequestEnvelope,
} from "@hermes/contracts";

const VALID_COMMANDS = new Set<string>(HOST_COMMANDS);
const VALID_TOPICS = new Set<string>(HOST_TOPICS);
const VALID_ERROR_CODES = new Set<string>(ERROR_CODES);

const SENSITIVE_KEYS = new Set([
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "oauthtokenset",
  "oauth_token_set",
  "codeverifier",
  "code_verifier",
  "codechallenge",
  "code_challenge",
  "authcode",
  "auth_code",
  "clientsecret",
  "client_secret",
  "ticket",
  "cookie",
  "cookies",
  "passphrase",
  "password",
  "secret",
  "privatekey",
  "private_key",
  "authorization",
  "auth",
  "wsurl",
  "ws_url",
  "rawurl",
  "stack",
  "stderr",
  "rawstderr",
  "raw_stderr",
  "clipath",
  "cli_path",
  "path",
  "homedir",
  "home_dir",
  "username",
  "cookiejar",
  "keypath",
  "key_path",
]);

const ERROR_CATALOG: Record<ErrorCode, { message: string; retryable: boolean }> = {
  invalid_request: {
    message: "请求格式或参数无效，请检查后重试。",
    retryable: false,
  },
  unauthorized: {
    message: "当前请求未获授权，请重新验证凭据。",
    retryable: false,
  },
  scope_mismatch: {
    message: "请求作用域与当前活动 Scope 不匹配，已阻止跨作用域操作。",
    retryable: false,
  },
  not_found: {
    message: "目标资源不存在或已被移除。",
    retryable: false,
  },
  conflict: {
    message: "操作存在冲突，请刷新状态后重试。",
    retryable: false,
  },
  auth_required: {
    message: "此连接需要认证后才能继续，请完成登录或凭据配置。",
    retryable: false,
  },
  auth_failed: {
    message: "认证失败，请检查凭据或认证方式后重试。",
    retryable: true,
  },
  unreachable: {
    message: "无法连接到目标 Gateway，请检查网络、服务状态或本地 CLI。",
    retryable: true,
  },
  timeout: {
    message: "请求超时，请检查目标主机响应状态后重试。",
    retryable: true,
  },
  protocol_unsupported: {
    message: "HostBridge 协议版本不兼容，请更新客户端后重试。",
    retryable: false,
  },
  unknown_turn: {
    message: "该 Turn 状态未知，请先查看详情或显式放弃。",
    retryable: false,
  },
  approval_stale: {
    message: "该 Approval 请求已过期，无法再执行。",
    retryable: false,
  },
  approval_scope_mismatch: {
    message: "Approval 与当前 Scope 或代际不匹配，已拒绝。",
    retryable: false,
  },
  capability_unavailable: {
    message: "当前 Gateway 未提供此能力或已被服务端拒绝。",
    retryable: false,
  },
  permission_denied: {
    message: "权限不足，无法访问目标路径或系统资源。",
    retryable: false,
  },
  cancelled: {
    message: "操作已取消。",
    retryable: false,
  },
  internal: {
    message: "宿主内部处理失败，请重试或导出脱敏诊断信息。",
    retryable: true,
  },
};

export type RequestValidationResult =
  | { valid: true }
  | { valid: false; code: ErrorCode; retryable: boolean };

export function validateHostRequest(envelope: Partial<HostRequestEnvelope> | null | undefined): RequestValidationResult {
  if (!envelope || typeof envelope !== "object") {
    return { valid: false, code: "invalid_request", retryable: false };
  }
  if (envelope.version !== HOST_BRIDGE_VERSION) {
    return { valid: false, code: "protocol_unsupported", retryable: false };
  }
  if (typeof envelope.requestId !== "string" || envelope.requestId.trim() === "") {
    return { valid: false, code: "invalid_request", retryable: false };
  }
  if (typeof envelope.command !== "string" || !VALID_COMMANDS.has(envelope.command)) {
    return { valid: false, code: "invalid_request", retryable: false };
  }
  if (envelope.payload !== undefined && (typeof envelope.payload !== "object" || envelope.payload === null || Array.isArray(envelope.payload))) {
    return { valid: false, code: "invalid_request", retryable: false };
  }
  return { valid: true };
}

export function validateHostTopic(topic: unknown): RequestValidationResult {
  if (typeof topic !== "string" || !VALID_TOPICS.has(topic)) {
    return { valid: false, code: "invalid_request", retryable: false };
  }
  return { valid: true };
}

export function mapErrorCode(code: ErrorCode, requestId: string, overrideMessage?: string): BridgeError {
  const safeCode: ErrorCode = VALID_ERROR_CODES.has(code) ? code : "internal";
  const spec = ERROR_CATALOG[safeCode];
  return {
    code: safeCode,
    message: overrideMessage ? redactString(overrideMessage) : spec.message,
    requestId,
    retryable: spec.retryable,
  };
}

export function isScopeMatch(expected: BridgeScope | null | undefined, actual: BridgeScope | null | undefined): boolean {
  if (!expected || !actual) return true;
  if (expected.connectionId !== actual.connectionId) return false;
  if (expected.profileId !== undefined && actual.profileId !== undefined && expected.profileId !== actual.profileId) {
    return false;
  }
  if (expected.sessionId !== undefined && actual.sessionId !== undefined && expected.sessionId !== actual.sessionId) {
    return false;
  }
  return true;
}

export function redactString(input: string): string {
  let out = input;
  // Remove PEM private keys
  out = out.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_KEY]");
  // Redact SSH public/private key material
  out = out.replace(/\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+)\s*[A-Za-z0-9+/=_-]+/gi, "[REDACTED_KEY]");
  // Redact ws(s):// and http(s):// URLs (userinfo, query, fragment)
  out = out.replace(/\b(?:wss?|https?):\/\/[^\s"'`<>]+/gi, "[REDACTED_URL]");
  // Redact bearer/token strings
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  // Redact key=value secret assignments (token, ticket, cookie, passphrase, password, secret, key)
  out = out.replace(
    /\b(token|access_token|refresh_token|ticket|cookies?|passphrase|password|secret|key)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
  // Redact raw stderr prefixes/lines
  out = out.replace(/\b(?:raw_?stderr|stderr)\s*:\s*[^\n]+/gi, "[REDACTED_STDERR]");
  // Redact Unix/macOS home, tilde, or absolute paths
  out = out.replace(/\/(?:Users|home|var|tmp|private|etc|opt|usr|Library|Applications)\/[^\s"'`:)]+/g, "[REDACTED_PATH]");
  out = out.replace(/~\/[^\s"'`:)]+/g, "[REDACTED_PATH]");
  // Redact stack trace lines
  out = out.replace(/\n\s*at\s+.+/g, "");
  return out;
}

function sanitizeDisplayOriginValue(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return redactString(value);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "[REDACTED_URL]";
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${cleanPath}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

export function redactSensitiveData<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
    } else if ((key === "originDisplay" || key === "hostDisplay") && typeof entry === "string") {
      out[key] = sanitizeDisplayOriginValue(entry);
    } else {
      out[key] = redactSensitiveData(entry);
    }
  }
  return out as T;
}

export type HostCommandHandler = (
  payload: Record<string, unknown>,
  scope: BridgeScope | null,
) => Promise<unknown> | unknown;

export interface BridgeDispatcherOptions {
  getActiveScope?: () => BridgeScope | null;
}

export function createBridgeDispatcher(
  handlers: Partial<Record<HostCommand, HostCommandHandler>>,
  options: BridgeDispatcherOptions = {},
) {
  return {
    async dispatch(envelope: Partial<HostRequestEnvelope>): Promise<BridgeResult> {
      const requestId =
        envelope && typeof envelope.requestId === "string" && envelope.requestId.trim() !== ""
          ? envelope.requestId
          : "invalid";

      const validation = validateHostRequest(envelope);
      if (!validation.valid) {
        return {
          ok: false,
          requestId,
          error: mapErrorCode(validation.code, requestId),
        };
      }

      const validEnvelope = envelope as HostRequestEnvelope;
      const scope = validEnvelope.scope ?? null;

      if (scope && options.getActiveScope) {
        const activeScope = options.getActiveScope();
        if (activeScope && !isScopeMatch(activeScope, scope)) {
          return {
            ok: false,
            requestId: validEnvelope.requestId,
            error: mapErrorCode("scope_mismatch", validEnvelope.requestId),
          };
        }
      }

      const handler = handlers[validEnvelope.command];
      if (!handler) {
        return {
          ok: false,
          requestId: validEnvelope.requestId,
          error: mapErrorCode("capability_unavailable", validEnvelope.requestId),
        };
      }

      try {
        const result = await handler(validEnvelope.payload ?? {}, scope);
        return {
          ok: true,
          requestId: validEnvelope.requestId,
          value: redactSensitiveData(result),
        };
      } catch (err) {
        const maybeCode =
          err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
            ? ((err as { code: string }).code as ErrorCode)
            : "internal";
        const code = VALID_ERROR_CODES.has(maybeCode) ? maybeCode : "internal";
        return {
          ok: false,
          requestId: validEnvelope.requestId,
          error: mapErrorCode(code, validEnvelope.requestId),
        };
      }
    },
  };
}

export type SequenceAcceptResult =
  | { status: "applied"; kind: "snapshot" | "patch"; seq: number; revision: number }
  | { status: "ignored_stale"; seq: number }
  | { status: "resync_required"; expectedSeq: number; receivedSeq: number };

export function createSequenceTracker() {
  let hasSnapshot = false;
  let lastSeq = -1;

  return {
    accept(event: BridgeEvent): SequenceAcceptResult {
      if (event.kind === "resync_required") {
        const expected = lastSeq + 1;
        hasSnapshot = false;
        lastSeq = -1;
        return { status: "resync_required", expectedSeq: expected, receivedSeq: event.seq };
      }

      if (event.kind === "snapshot") {
        if (event.seq !== 0) {
          hasSnapshot = false;
          lastSeq = -1;
          return { status: "resync_required", expectedSeq: 0, receivedSeq: event.seq };
        }
        hasSnapshot = true;
        lastSeq = 0;
        return { status: "applied", kind: "snapshot", seq: 0, revision: event.revision };
      }

      if (!hasSnapshot) {
        return { status: "resync_required", expectedSeq: 0, receivedSeq: event.seq };
      }

      if (event.seq <= lastSeq) {
        return { status: "ignored_stale", seq: event.seq };
      }

      if (event.seq !== lastSeq + 1) {
        const expected = lastSeq + 1;
        hasSnapshot = false;
        lastSeq = -1;
        return { status: "resync_required", expectedSeq: expected, receivedSeq: event.seq };
      }

      lastSeq = event.seq;
      return { status: "applied", kind: "patch", seq: event.seq, revision: event.revision };
    },
    reset() {
      hasSnapshot = false;
      lastSeq = -1;
    },
  };
}
