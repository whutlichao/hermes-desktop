import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import type {
  AuthCancelResult,
  AuthStartResult,
  AuthStateSnapshot,
  BridgeEvent,
  ErrorCode,
  RemoteAuthMode,
  RemoteTestActionId,
  RemoteTestResult,
} from "@hermes/contracts";
import {
  isJsonRpcMethodNotFound,
  redactSensitiveData,
  validateRemoteEndpointUrl,
} from "@hermes/domain";
import {
  GatewayClient,
  type GatewayClientTlsOptions,
  GatewayTransportError,
} from "./gatewayClient";
import type { RegistryStore } from "./registryStore";
import { isAllowedExternalUrl } from "./security";

export interface RemoteHttpResponse {
  statusCode: number;
  bodyText: string;
}

class HttpTimeoutError extends Error {
  constructor() {
    super("Remote HTTP request timed out");
    this.name = "HttpTimeoutError";
  }
}

export async function performRemoteHttpRequest(options: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  tls?: GatewayClientTlsOptions;
}): Promise<RemoteHttpResponse> {
  const parsed = new URL(options.url);
  const isSecure = parsed.protocol === "https:";
  const reqModule = isSecure ? https : http;
  const port = parsed.port ? Number(parsed.port) : isSecure ? 443 : 80;
  const timeoutMs = options.timeoutMs ?? 6000;

  return new Promise<RemoteHttpResponse>((resolve, reject) => {
    let settled = false;
    const req = reqModule.request(
      {
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        method: options.method ?? "GET",
        headers: {
          ...(options.headers ?? {}),
          ...(options.body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(options.body, "utf8")) }
            : {}),
        },
        ...(isSecure && options.tls
          ? {
              ...(options.tls.ca !== undefined ? { ca: options.tls.ca } : {}),
              ...(options.tls.rejectUnauthorized !== undefined
                ? { rejectUnauthorized: options.tls.rejectUnauthorized }
                : {}),
            }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            statusCode: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new HttpTimeoutError());
    }, timeoutMs);

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

export interface RemoteDialCredentials {
  bearerToken?: string;
  headers: Record<string, string>;
}

export function resolveRemoteCredentials(options: {
  origin: string;
  explicitToken?: string;
  authSessionId?: string;
  connectionId?: string;
  explicitHeaders?: Record<string, string>;
  registryStore?: RegistryStore;
  authManager?: RemoteAuthManager;
}): RemoteDialCredentials {
  const headers: Record<string, string> = {};
  const stored = options.connectionId
    ? options.registryStore?.getConnectionCredentialsForDial(options.connectionId)
    : null;

  if (stored?.headers) {
    Object.assign(headers, stored.headers);
  }
  if (options.explicitHeaders) {
    for (const [k, v] of Object.entries(options.explicitHeaders)) {
      if (k.trim() && typeof v === "string" && v.length > 0) {
        headers[k.trim()] = v;
      }
    }
  }

  let bearerToken: string | undefined;
  if (typeof options.explicitToken === "string" && options.explicitToken.trim().length > 0) {
    bearerToken = options.explicitToken.trim();
  } else if (options.authSessionId && options.authManager) {
    const pending = options.authManager.peekPendingToken(options.authSessionId, options.origin);
    const pendingAccess =
      pending && typeof pending.access_token === "string" ? pending.access_token : undefined;
    if (pendingAccess) bearerToken = pendingAccess;
  } else if (stored?.oauthTokenSet) {
    const access = stored.oauthTokenSet.access_token ?? stored.oauthTokenSet.accessToken;
    if (typeof access === "string" && access.trim().length > 0) {
      bearerToken = access.trim();
    }
  } else if (stored?.staticToken) {
    bearerToken = stored.staticToken;
  }

  if (bearerToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return { bearerToken, headers };
}

export async function mintRemoteWsTicketIfSupported(options: {
  origin: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  tls?: GatewayClientTlsOptions;
}): Promise<
  | { kind: "ticket"; ticket: string }
  | { kind: "auth_required"; statusCode: number }
  | { kind: "unsupported" }
> {
  try {
    const res = await performRemoteHttpRequest({
      url: `${options.origin}/api/gateway/ticket`,
      method: "POST",
      headers: {
        ...options.headers,
        "Content-Type": "application/json",
      },
      body: "{}",
      timeoutMs: options.timeoutMs ?? 6000,
      tls: options.tls,
    });

    if (res.statusCode === 401 || res.statusCode === 403) {
      return { kind: "auth_required", statusCode: res.statusCode };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const parsed = JSON.parse(res.bodyText) as { ticket?: unknown };
        if (typeof parsed.ticket === "string" && parsed.ticket.trim().length > 0) {
          return { kind: "ticket", ticket: parsed.ticket.trim() };
        }
      } catch {
        // Ignore malformed ticket body and allow direct WS auth
      }
    }
    return { kind: "unsupported" };
  } catch {
    return { kind: "unsupported" };
  }
}

export interface TestRemoteConnectionParams {
  input: {
    kind?: string;
    url?: string;
    authMode?: RemoteAuthMode;
    token?: string;
    authSessionId?: string;
    connectionId?: string;
    headers?: Record<string, string>;
  };
  registryStore?: RegistryStore;
  authManager?: RemoteAuthManager;
  tls?: GatewayClientTlsOptions;
  connectTimeoutMs?: number;
}

export async function testRemoteConnection(
  params: TestRemoteConnectionParams,
): Promise<RemoteTestResult> {
  const checkedAt = new Date().toISOString();
  const authMode: RemoteAuthMode = params.input.authMode === "oauth" ? "oauth" : "token";
  const endpointCheck = validateRemoteEndpointUrl(params.input.url ?? "");

  if (!endpointCheck.valid) {
    return redactSensitiveData<RemoteTestResult>({
      ok: false,
      kind: "remote",
      authMode,
      httpLeg: {
        ok: false,
        status: "skipped",
        errorCode: endpointCheck.code,
        messageKey: endpointCheck.messageKey,
      },
      wsLeg: {
        ok: false,
        status: "skipped",
      },
      failedStage: "validation",
      errorCode: endpointCheck.code,
      messageKey: endpointCheck.messageKey,
      actions: ["edit_endpoint"],
      checkedAt,
    });
  }

  const { normalizedUrl, originDisplay, wsUrl } = endpointCheck;
  const timeoutMs = params.connectTimeoutMs ?? 6000;
  const creds = resolveRemoteCredentials({
    origin: normalizedUrl,
    explicitToken: params.input.token,
    authSessionId: params.input.authSessionId,
    connectionId: params.input.connectionId,
    explicitHeaders: params.input.headers,
    registryStore: params.registryStore,
    authManager: params.authManager,
  });

  // Leg 1: HTTP probe
  const httpStarted = Date.now();
  let httpStatus = 0;
  try {
    let probeRes = await performRemoteHttpRequest({
      url: `${normalizedUrl}/api/gateway/health`,
      method: "GET",
      headers: creds.headers,
      timeoutMs,
      tls: params.tls,
    });
    if (probeRes.statusCode === 404) {
      probeRes = await performRemoteHttpRequest({
        url: `${normalizedUrl}/health`,
        method: "GET",
        headers: creds.headers,
        timeoutMs,
        tls: params.tls,
      });
    }
    httpStatus = probeRes.statusCode;
  } catch (err) {
    const isTimeout = err instanceof HttpTimeoutError;
    const errorCode: ErrorCode = isTimeout ? "timeout" : "unreachable";
    const messageKey = isTimeout ? "remote.test.timeout" : "remote.test.httpFailed";
    return redactSensitiveData<RemoteTestResult>({
      ok: false,
      kind: "remote",
      originDisplay,
      authMode,
      httpLeg: {
        ok: false,
        status: "failed",
        latencyMs: Math.max(1, Date.now() - httpStarted),
        errorCode,
        messageKey,
      },
      wsLeg: {
        ok: false,
        status: "skipped",
      },
      failedStage: "http",
      errorCode,
      messageKey,
      actions: ["edit_endpoint", "retry_test"],
      checkedAt,
    });
  }

  const httpLatency = Math.max(1, Date.now() - httpStarted);
  if (httpStatus === 401 || httpStatus === 403) {
    const authAction: RemoteTestActionId =
      authMode === "oauth" ? "reauthorize_oauth" : "edit_auth";
    return redactSensitiveData<RemoteTestResult>({
      ok: false,
      kind: "remote",
      originDisplay,
      authMode,
      httpLeg: {
        ok: false,
        status: "failed",
        statusCode: httpStatus,
        latencyMs: httpLatency,
        errorCode: "auth_required",
        messageKey: "remote.test.authRequired",
      },
      wsLeg: {
        ok: false,
        status: "skipped",
      },
      failedStage: "auth",
      errorCode: "auth_required",
      messageKey: "remote.test.authRequired",
      actions: [authAction, "retry_test"],
      checkedAt,
    });
  }

  if (httpStatus < 200 || httpStatus >= 400) {
    return redactSensitiveData<RemoteTestResult>({
      ok: false,
      kind: "remote",
      originDisplay,
      authMode,
      httpLeg: {
        ok: false,
        status: "failed",
        statusCode: httpStatus,
        latencyMs: httpLatency,
        errorCode: "unreachable",
        messageKey: "remote.test.httpFailed",
      },
      wsLeg: {
        ok: false,
        status: "skipped",
      },
      failedStage: "http",
      errorCode: "unreachable",
      messageKey: "remote.test.httpFailed",
      actions: ["edit_endpoint", "retry_test"],
      checkedAt,
    });
  }

  // Leg 2: WS handshake + read-only runtime.describe (then close immediately)
  const wsStarted = Date.now();
  const ticketRes = await mintRemoteWsTicketIfSupported({
    origin: normalizedUrl,
    headers: creds.headers,
    timeoutMs,
    tls: params.tls,
  });

  if (ticketRes.kind === "auth_required") {
    const authAction: RemoteTestActionId =
      authMode === "oauth" ? "reauthorize_oauth" : "edit_auth";
    return redactSensitiveData<RemoteTestResult>({
      ok: false,
      kind: "remote",
      originDisplay,
      authMode,
      httpLeg: {
        ok: true,
        status: "ok",
        statusCode: httpStatus,
        latencyMs: httpLatency,
      },
      wsLeg: {
        ok: false,
        status: "failed",
        statusCode: ticketRes.statusCode,
        latencyMs: Math.max(1, Date.now() - wsStarted),
        errorCode: "auth_required",
        messageKey: "remote.test.authRequired",
      },
      failedStage: "auth",
      errorCode: "auth_required",
      messageKey: "remote.test.authRequired",
      actions: [authAction, "retry_test"],
      checkedAt,
    });
  }

  let client: GatewayClient | null = null;
  try {
    client = await GatewayClient.connect({
      wsUrl,
      ...(ticketRes.kind === "ticket" ? { ticket: ticketRes.ticket } : {}),
      headers: creds.headers,
      tls: params.tls,
      connectTimeoutMs: timeoutMs,
    });
    try {
      await client.call("runtime.describe", {}, { timeoutMs });
    } catch (rpcErr) {
      if (!isJsonRpcMethodNotFound(rpcErr)) {
        throw rpcErr;
      }
    }

    return redactSensitiveData<RemoteTestResult>({
      ok: true,
      kind: "remote",
      originDisplay,
      authMode,
      httpLeg: {
        ok: true,
        status: "ok",
        statusCode: httpStatus,
        latencyMs: httpLatency,
      },
      wsLeg: {
        ok: true,
        status: "ok",
        statusCode: 101,
        latencyMs: Math.max(1, Date.now() - wsStarted),
      },
      messageKey: "remote.test.ok",
      actions: ["save_connection"],
      checkedAt,
    });
  } catch (err) {
    const transportErr = err instanceof GatewayTransportError ? err : null;
    const isAuth = transportErr?.code === "auth_failed";
    const isTimeout = transportErr?.code === "timeout";
    const errorCode: ErrorCode = isAuth
      ? "auth_required"
      : isTimeout
        ? "timeout"
        : transportErr?.code === "protocol_unsupported"
          ? "protocol_unsupported"
          : "unreachable";
    const failedStage = isAuth ? "auth" : "ws";
    const messageKey = isAuth
      ? "remote.test.authRequired"
      : isTimeout
        ? "remote.test.timeout"
        : "remote.test.wsFailed";
    const actions: RemoteTestActionId[] = isAuth
      ? [authMode === "oauth" ? "reauthorize_oauth" : "edit_auth", "retry_test"]
      : ["edit_endpoint", "retry_test"];

    return redactSensitiveData<RemoteTestResult>({
      ok: false,
      kind: "remote",
      originDisplay,
      authMode,
      httpLeg: {
        ok: true,
        status: "ok",
        statusCode: httpStatus,
        latencyMs: httpLatency,
      },
      wsLeg: {
        ok: false,
        status: "failed",
        ...(transportErr?.statusCode ? { statusCode: transportErr.statusCode } : {}),
        latencyMs: Math.max(1, Date.now() - wsStarted),
        errorCode,
        messageKey,
      },
      failedStage,
      errorCode,
      messageKey,
      actions,
      checkedAt,
    });
  } finally {
    client?.close();
  }
}

interface ActiveOAuthFlow {
  authSessionId: string;
  origin: string;
  connectionId?: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  server: http.Server;
  timeoutTimer: ReturnType<typeof setTimeout>;
  snapshot: AuthStateSnapshot;
}

interface PendingOAuthToken {
  origin: string;
  tokenSet: Record<string, unknown>;
}

export interface RemoteAuthManagerOptions {
  registryStore: RegistryStore;
  openExternal: (url: string) => Promise<void>;
  tls?: GatewayClientTlsOptions;
  flowTimeoutMs?: number;
  onConnectionAuthorized?: (connectionId: string) => void;
}

function makeAuthBridgeError(code: ErrorCode, safeMessage: string): Error {
  const err = new Error(safeMessage);
  (err as { code?: ErrorCode }).code = code;
  return err;
}

export class RemoteAuthManager {
  private readonly registryStore: RegistryStore;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly tls?: GatewayClientTlsOptions;
  private readonly flowTimeoutMs: number;
  private readonly onConnectionAuthorized?: (connectionId: string) => void;

  private readonly activeFlows = new Map<string, ActiveOAuthFlow>();
  private readonly lastStates = new Map<string, AuthStateSnapshot>();
  private readonly pendingTokens = new Map<string, PendingOAuthToken>();
  private readonly listeners = new Set<(event: BridgeEvent<AuthStateSnapshot>) => void>();
  private revision = 0;
  private seq = 0;
  private disposed = false;

  constructor(options: RemoteAuthManagerOptions) {
    this.registryStore = options.registryStore;
    this.openExternal = options.openExternal;
    this.tls = options.tls;
    this.flowTimeoutMs = options.flowTimeoutMs ?? 120_000;
    this.onConnectionAuthorized = options.onConnectionAuthorized;
  }

  subscribe(listener: (event: BridgeEvent<AuthStateSnapshot>) => void): () => void {
    this.listeners.add(listener);
    const latest = [...this.lastStates.values()].at(-1);
    if (latest) {
      queueMicrotask(() => {
        if (!this.listeners.has(listener)) return;
        listener({
          topic: "auth.state",
          scope: latest.connectionId ? { connectionId: latest.connectionId } : null,
          kind: "snapshot",
          seq: 0,
          revision: this.revision,
          payload: latest,
        });
      });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitState(snapshot: AuthStateSnapshot): void {
    const safe = redactSensitiveData(snapshot);
    this.lastStates.set(safe.authSessionId, safe);
    this.revision += 1;
    this.seq += 1;
    for (const listener of this.listeners) {
      try {
        listener({
          topic: "auth.state",
          scope: safe.connectionId ? { connectionId: safe.connectionId } : null,
          kind: "patch",
          seq: this.seq,
          revision: this.revision,
          payload: safe,
        });
      } catch {
        // isolate broken subscribers
      }
    }
  }

  peekPendingToken(authSessionId: string, expectedOrigin?: string): Record<string, unknown> | null {
    const pending = this.pendingTokens.get(authSessionId);
    if (!pending) return null;
    if (expectedOrigin && pending.origin !== expectedOrigin) return null;
    return pending.tokenSet;
  }

  consumePendingToken(
    authSessionId: string,
    expectedOrigin?: string,
  ): { origin: string; tokenSet: Record<string, unknown> } | null {
    const pending = this.pendingTokens.get(authSessionId);
    if (!pending) return null;
    if (expectedOrigin && pending.origin !== expectedOrigin) return null;
    this.pendingTokens.delete(authSessionId);
    return pending;
  }

  async startAuth(params: {
    kind?: string;
    url?: string;
    connectionId?: string;
  }): Promise<AuthStartResult> {
    if (this.disposed) {
      throw makeAuthBridgeError("cancelled", "认证管理器已关闭");
    }

    const endpointCheck = validateRemoteEndpointUrl(params.url ?? "");
    if (!endpointCheck.valid) {
      throw makeAuthBridgeError("invalid_request", "Remote 地址无效，无法发起 OAuth 授权");
    }

    const origin = endpointCheck.normalizedUrl;
    const authSessionId = crypto.randomUUID();
    const state = crypto.randomBytes(16).toString("hex");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const server = http.createServer((req, res) => {
      void this.handleCallbackRequest(authSessionId, req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const addr = server.address() as net.AddressInfo;
    const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

    const authorizeUrl = new URL(`${origin}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "hermes-desktop");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);

    const authorizeHref = authorizeUrl.toString();
    if (!isAllowedExternalUrl(authorizeHref)) {
      await this.closeServerSafely(server);
      throw makeAuthBridgeError("invalid_request", "授权地址协议不受支持");
    }

    const initialSnapshot: AuthStateSnapshot = {
      authSessionId,
      ...(params.connectionId ? { connectionId: params.connectionId } : {}),
      originDisplay: origin,
      status: "waiting",
      updatedAt: new Date().toISOString(),
    };

    const timeoutTimer = setTimeout(() => {
      void this.failFlow(authSessionId, "timeout", "gateways.oauthFailed");
    }, this.flowTimeoutMs);

    this.activeFlows.set(authSessionId, {
      authSessionId,
      origin,
      connectionId: params.connectionId,
      state,
      codeVerifier,
      redirectUri,
      server,
      timeoutTimer,
      snapshot: initialSnapshot,
    });
    this.emitState(initialSnapshot);

    try {
      await this.openExternal(authorizeHref);
    } catch {
      await this.failFlow(authSessionId, "unreachable", "gateways.oauthFailed");
      throw makeAuthBridgeError("unreachable", "无法打开系统浏览器进行 OAuth 授权");
    }

    return redactSensitiveData(initialSnapshot);
  }

  cancelAuth(authSessionId?: string): AuthCancelResult {
    const targetId =
      authSessionId && authSessionId.trim()
        ? authSessionId.trim()
        : [...this.activeFlows.keys()].at(-1);

    if (!targetId) {
      const fallback: AuthStateSnapshot = {
        authSessionId: authSessionId ?? "none",
        status: "cancelled",
        messageKey: "gateways.oauthCancelled",
        updatedAt: new Date().toISOString(),
      };
      return { cancelled: false, snapshot: fallback };
    }

    this.pendingTokens.delete(targetId);
    const flow = this.activeFlows.get(targetId);
    if (!flow) {
      const prev = this.lastStates.get(targetId);
      const snapshot: AuthStateSnapshot = prev
        ? {
            ...prev,
            status: "cancelled",
            messageKey: "gateways.oauthCancelled",
            updatedAt: new Date().toISOString(),
          }
        : {
            authSessionId: targetId,
            status: "cancelled",
            messageKey: "gateways.oauthCancelled",
            updatedAt: new Date().toISOString(),
          };
      this.emitState(snapshot);
      return { cancelled: true, snapshot };
    }

    this.cleanupFlow(flow);
    const snapshot: AuthStateSnapshot = {
      authSessionId: flow.authSessionId,
      ...(flow.connectionId ? { connectionId: flow.connectionId } : {}),
      originDisplay: flow.origin,
      status: "cancelled",
      messageKey: "gateways.oauthCancelled",
      updatedAt: new Date().toISOString(),
    };
    this.emitState(snapshot);
    return { cancelled: true, snapshot };
  }

  private async handleCallbackRequest(
    authSessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const flow = this.activeFlows.get(authSessionId);
    if (!flow) {
      res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>授权会话已失效或已取消，可关闭此页面。</body></html>");
      return;
    }

    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }

    const errorParam = reqUrl.searchParams.get("error");
    const code = reqUrl.searchParams.get("code");
    const returnedState = reqUrl.searchParams.get("state");

    if (errorParam || !code || returnedState !== flow.state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>OAuth 授权未完成或状态校验失败，请返回 Hermes Desktop 重试。</body></html>");
      await this.failFlow(
        authSessionId,
        errorParam === "access_denied" ? "cancelled" : "auth_failed",
        "gateways.oauthFailed",
      );
      return;
    }

    this.cleanupFlow(flow);

    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: "hermes-desktop",
        code_verifier: flow.codeVerifier,
      });

      const tokenRes = await performRemoteHttpRequest({
        url: `${flow.origin}/oauth/token`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        timeoutMs: 8000,
        tls: this.tls,
      });

      if (tokenRes.statusCode < 200 || tokenRes.statusCode >= 300) {
        throw new Error(`OAuth token exchange rejected (${tokenRes.statusCode})`);
      }

      const tokenSet = JSON.parse(tokenRes.bodyText) as Record<string, unknown>;
      const accessToken = tokenSet.access_token ?? tokenSet.accessToken;
      if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
        throw new Error("Missing access_token in OAuth token response");
      }

      if (flow.connectionId) {
        const writeRes = this.registryStore.writeSecret({
          kind: "oauth",
          connectionId: flow.connectionId,
          baseUrl: flow.origin,
          tokenSet,
        });
        if (!writeRes.ok) {
          this.registryStore.markTokenSyncFailed(flow.connectionId);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body>授权已获取，但本地保存凭据失败，请在 Hermes Desktop 中重试。</body></html>");
          this.emitState({
            authSessionId: flow.authSessionId,
            connectionId: flow.connectionId,
            originDisplay: flow.origin,
            status: "failed",
            errorCode: "internal",
            messageKey: "registry.issue.tokenSyncFailed",
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        this.registryStore.clearTokenSyncFailed(flow.connectionId);
        this.onConnectionAuthorized?.(flow.connectionId);
      } else {
        this.pendingTokens.set(flow.authSessionId, {
          origin: flow.origin,
          tokenSet,
        });
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>授权已完成，可返回 Hermes Desktop。</body></html>");

      this.emitState({
        authSessionId: flow.authSessionId,
        ...(flow.connectionId ? { connectionId: flow.connectionId } : {}),
        originDisplay: flow.origin,
        status: "granted",
        messageKey: "gateways.oauthGranted",
        updatedAt: new Date().toISOString(),
      });
    } catch {
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>换取 OAuth Token 失败，请返回 Hermes Desktop 重试。</body></html>");
      this.emitState({
        authSessionId: flow.authSessionId,
        ...(flow.connectionId ? { connectionId: flow.connectionId } : {}),
        originDisplay: flow.origin,
        status: "failed",
        errorCode: "auth_failed",
        messageKey: "gateways.oauthFailed",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async failFlow(
    authSessionId: string,
    errorCode: ErrorCode,
    messageKey: string,
  ): Promise<void> {
    const flow = this.activeFlows.get(authSessionId);
    if (!flow) return;
    this.cleanupFlow(flow);
    this.emitState({
      authSessionId: flow.authSessionId,
      ...(flow.connectionId ? { connectionId: flow.connectionId } : {}),
      originDisplay: flow.origin,
      status: errorCode === "cancelled" ? "cancelled" : "failed",
      errorCode,
      messageKey,
      updatedAt: new Date().toISOString(),
    });
  }

  private cleanupFlow(flow: ActiveOAuthFlow): void {
    clearTimeout(flow.timeoutTimer);
    this.activeFlows.delete(flow.authSessionId);
    void this.closeServerSafely(flow.server);
  }

  private closeServerSafely(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const flow of this.activeFlows.values()) {
      clearTimeout(flow.timeoutTimer);
      void this.closeServerSafely(flow.server);
    }
    this.activeFlows.clear();
    this.pendingTokens.clear();
    this.listeners.clear();
  }
}
