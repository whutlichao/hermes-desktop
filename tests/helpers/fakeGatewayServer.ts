import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import os from "node:os";
import path from "node:path";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FakeGatewayConnectionRecord {
  headers: http.IncomingHttpHeaders;
  protocols: string[];
  ticket: string | null;
}

export interface FakeGatewayServerOptions {
  validTickets: Set<string>;
  servedMethods?: string[];
  profiles?: Array<{ profile_id: string; display_name: string; handle?: string; is_default?: boolean }>;
  initialSessions?: Array<{
    profile_id: string;
    session_id: string;
    title: string;
    preview?: string;
    updated_at?: string;
  }>;
  onRpc?: (
    method: string,
    params: Record<string, unknown>,
    ctx: {
      sendNotification: (method: string, params: Record<string, unknown>) => void;
      replyResult: (result: unknown) => void;
      replyError: (code: number, message: string) => void;
    },
  ) => boolean | void | Promise<boolean | void>;
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
}

function encodeServerPongFrame(payload: Buffer): Buffer {
  const len = payload.length;
  return Buffer.concat([Buffer.from([0x8a, len]), payload]);
}

export interface FakeGatewayServerHandle {
  port: number;
  wsUrl: string;
  connections: FakeGatewayConnectionRecord[];
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>;
  closeAllClients: () => void;
  close: () => Promise<void>;
}

export async function startFakeGatewayServer(
  options: FakeGatewayServerOptions,
): Promise<FakeGatewayServerHandle> {
  const connections: FakeGatewayConnectionRecord[] = [];
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const activeSockets = new Set<net.Socket>();

  const servedMethods = options.servedMethods ?? [
    "runtime.describe",
    "client.capabilities",
    "subscribe",
    "profiles.list",
    "sessions.list",
    "session.list",
    "session.create",
    "session.resume",
    "session.transcript",
    "prompt.submit",
    "prompt.cancel",
    "session.steer",
  ];

  const profiles = options.profiles ?? [
    { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
  ];

  const sessions = [...(options.initialSessions ?? [])];
  const transcripts = new Map<
    string,
    Array<{ message_id: string; role: "user" | "assistant" | "system"; text: string; created_at: string }>
  >();

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket: net.Socket) => {
    const rawProto = req.headers["sec-websocket-protocol"] ?? "";
    const protocols = String(rawProto)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ticketProto = protocols.find((p) => p.startsWith("hermes-gateway-ticket."));
    const ticket = ticketProto ? ticketProto.slice("hermes-gateway-ticket.".length) : null;

    connections.push({
      headers: { ...req.headers },
      protocols,
      ticket,
    });

    if (!protocols.includes("hermes-gateway-v1") || !ticket || !options.validTickets.has(ticket)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Enforce single-use ticket on the fake gateway side too!
    options.validTickets.delete(ticket);

    const key = req.headers["sec-websocket-key"];
    if (!key || Array.isArray(key)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}${WS_GUID}`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "Sec-WebSocket-Protocol: hermes-gateway-v1",
        "",
        "",
      ].join("\r\n"),
    );

    activeSockets.add(socket);
    let buffer = Buffer.alloc(0);

    const sendJson = (obj: unknown) => {
      if (!socket.destroyed) {
        socket.write(encodeServerTextFrame(JSON.stringify(obj)));
      }
    };

    const sendNotification = (method: string, params: Record<string, unknown>) => {
      sendJson({ jsonrpc: "2.0", method, params });
    };

    const handleMessage = async (text: string) => {
      const reqMsg = JSON.parse(text) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (!reqMsg.method) return;
      const params = reqMsg.params ?? {};
      rpcCalls.push({ method: reqMsg.method, params });

      let replied = false;
      const replyResult = (result: unknown) => {
        if (replied || reqMsg.id === undefined) return;
        replied = true;
        sendJson({ jsonrpc: "2.0", id: reqMsg.id, result });
      };
      const replyError = (code: number, message: string) => {
        if (replied || reqMsg.id === undefined) return;
        replied = true;
        sendJson({ jsonrpc: "2.0", id: reqMsg.id, error: { code, message } });
      };

      if (options.onRpc) {
        const handled = await options.onRpc(reqMsg.method, params, {
          sendNotification,
          replyResult,
          replyError,
        });
        if (handled || replied) return;
      }

      if (!servedMethods.includes(reqMsg.method)) {
        replyError(-32601, `Method not found: ${reqMsg.method}`);
        return;
      }

      switch (reqMsg.method) {
        case "runtime.describe":
          replyResult({
            runtime_protocol: 1,
            capabilities: ["session-authority-v1", "host-scope-interactive"],
            served_methods: servedMethods,
            session_create: { sources: ["desktop"], parameters: ["title", "profile_id"] },
          });
          return;
        case "client.capabilities":
          replyResult({ accepted: true, server_requests: Boolean(params.server_requests) });
          return;
        case "subscribe":
          replyResult({ subscribed: true });
          return;
        case "profiles.list":
          replyResult({ profiles });
          return;
        case "session.list":
        case "sessions.list": {
          const pid = typeof params.profile_id === "string" ? params.profile_id : undefined;
          const list = pid ? sessions.filter((s) => s.profile_id === pid) : sessions;
          replyResult({ sessions: list });
          return;
        }
        case "session.create": {
          const profileId = typeof params.profile_id === "string" ? params.profile_id : "default";
          const sessionId = `sess-${sessions.length + 1}`;
          const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "新对话";
          const entry = {
            profile_id: profileId,
            session_id: sessionId,
            title,
            preview: "",
            updated_at: new Date().toISOString(),
          };
          sessions.unshift(entry);
          transcripts.set(sessionId, []);
          replyResult({ session: entry });
          return;
        }
        case "session.resume":
        case "session.transcript": {
          const sid = typeof params.session_id === "string" ? params.session_id : "";
          replyResult({
            session_id: sid,
            messages: transcripts.get(sid) ?? [],
            active_turn_id: null,
          });
          return;
        }
        case "prompt.submit": {
          const sid = typeof params.session_id === "string" ? params.session_id : "";
          const promptText = typeof params.text === "string" ? params.text : "";
          const turnId = `turn-${Date.now()}`;
          const userMsgId = `msg-u-${Date.now()}`;
          const assistantMsgId = `msg-a-${Date.now()}`;
          const list = transcripts.get(sid) ?? [];
          list.push({
            message_id: userMsgId,
            role: "user",
            text: promptText,
            created_at: new Date().toISOString(),
          });
          transcripts.set(sid, list);
          replyResult({
            accepted: true,
            session_id: sid,
            turn_id: turnId,
            user_message_id: userMsgId,
            assistant_message_id: assistantMsgId,
          });
          return;
        }
        case "prompt.cancel": {
          const sid = typeof params.session_id === "string" ? params.session_id : "";
          const turnId = typeof params.turn_id === "string" ? params.turn_id : "";
          replyResult({ stopped: true, session_id: sid, turn_id: turnId });
          sendNotification("prompt.stopped", {
            session_id: sid,
            turn_id: turnId,
          });
          return;
        }
        case "session.steer":
          replyResult({ steered: true });
          return;
        default:
          replyError(-32601, "Method not found");
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + len) return;

        let payload = buffer.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i += 1) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + maskLen + len);

        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeServerPongFrame(payload));
          continue;
        }
        if (opcode === 0x1) {
          void handleMessage(payload.toString("utf8"));
        }
      }
    });

    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as net.AddressInfo;

  return {
    port: addr.port,
    wsUrl: `ws://127.0.0.1:${addr.port}/api/ws`,
    connections,
    rpcCalls,
    closeAllClients() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
    },
    async close() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface FakeRemoteGatewayServerOptions {
  protocol?: "http" | "https";
  validTokens?: Set<string>;
  requiredHeaders?: Record<string, string>;
  httpHealthStatus?: number;
  httpDelayMs?: number;
  useTicketEndpoint?: boolean;
  rejectWsStatus?: number | null;
  servedMethods?: string[];
  profiles?: Array<{ profile_id: string; display_name: string; handle?: string; is_default?: boolean }>;
  initialSessions?: Array<{
    profile_id: string;
    session_id: string;
    title: string;
    preview?: string;
    updated_at?: string;
  }>;
  onRpc?: FakeGatewayServerOptions["onRpc"];
}

export interface FakeRemoteGatewayServerHandle {
  port: number;
  protocol: "http" | "https";
  baseUrl: string;
  wsUrl: string;
  caPem?: string;
  validTokens: Set<string>;
  issuedRefreshTokens: Set<string>;
  httpRequests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  wsConnections: FakeGatewayConnectionRecord[];
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>;
  setRejectWsStatus: (status: number | null) => void;
  setHttpHealthStatus: (status: number) => void;
  invalidateToken: (token: string) => void;
  closeAllClients: () => void;
  close: () => Promise<void>;
}

function generateLocalhostTlsPair(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tls-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function startFakeRemoteGatewayServer(
  options: FakeRemoteGatewayServerOptions = {},
): Promise<FakeRemoteGatewayServerHandle> {
  const protocol = options.protocol ?? "http";
  const validTokens = options.validTokens ?? new Set(["remote-valid-token"]);
  const validTickets = new Set<string>();
  const issuedRefreshTokens = new Set<string>();
  const pendingAuthCodes = new Map<
    string,
    { codeChallenge: string; redirectUri: string; state: string }
  >();
  const httpRequests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  const wsConnections: FakeGatewayConnectionRecord[] = [];
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const activeSockets = new Set<net.Socket>();

  let currentHttpHealthStatus = options.httpHealthStatus ?? 200;
  let currentRejectWsStatus: number | null = options.rejectWsStatus ?? null;

  const servedMethods = options.servedMethods ?? [
    "runtime.describe",
    "client.capabilities",
    "subscribe",
    "profiles.list",
    "sessions.list",
    "session.list",
    "session.create",
    "session.resume",
    "session.transcript",
    "prompt.submit",
    "prompt.cancel",
    "session.steer",
  ];
  const profiles = options.profiles ?? [
    { profile_id: "default", display_name: "Remote Default", handle: "default", is_default: true },
  ];
  const sessions = [...(options.initialSessions ?? [])];
  const transcripts = new Map<
    string,
    Array<{ message_id: string; role: "user" | "assistant" | "system"; text: string; created_at: string }>
  >();

  const hasValidRequiredHeaders = (headers: http.IncomingHttpHeaders): boolean => {
    if (!options.requiredHeaders) return true;
    for (const [k, expected] of Object.entries(options.requiredHeaders)) {
      const actual = headers[k.toLowerCase()];
      if (actual !== expected) return false;
    }
    return true;
  };

  const extractBearerToken = (headers: http.IncomingHttpHeaders): string | null => {
    const raw = headers.authorization;
    if (typeof raw !== "string") return null;
    const match = raw.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  };

  const requestListener: http.RequestListener = async (req, res) => {
    httpRequests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: { ...req.headers },
    });

    if (options.httpDelayMs && options.httpDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.httpDelayMs));
    }

    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");

    if (parsed.pathname === "/api/gateway/health" || parsed.pathname === "/health") {
      if (currentHttpHealthStatus !== 200) {
        res.writeHead(currentHttpHealthStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (!hasValidRequiredHeaders(req.headers)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing_required_header" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "hermes-gateway", protocol_version: 1 }));
      return;
    }

    if (parsed.pathname === "/api/gateway/ticket" && req.method === "POST") {
      if (!options.useTicketEndpoint) {
        res.writeHead(404);
        res.end();
        return;
      }
      const bearer = extractBearerToken(req.headers);
      if (!bearer || !validTokens.has(bearer) || !hasValidRequiredHeaders(req.headers)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "auth_required" }));
        return;
      }
      const ticket = `rticket-${crypto.randomBytes(8).toString("hex")}`;
      validTickets.add(ticket);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ticket }));
      return;
    }

    if (parsed.pathname === "/oauth/authorize" && req.method === "GET") {
      const responseType = parsed.searchParams.get("response_type");
      const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
      const codeChallenge = parsed.searchParams.get("code_challenge") ?? "";
      const challengeMethod = parsed.searchParams.get("code_challenge_method");
      const state = parsed.searchParams.get("state") ?? "";

      if (
        responseType !== "code" ||
        challengeMethod !== "S256" ||
        !codeChallenge ||
        !redirectUri ||
        !state
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }

      const code = `acode-${crypto.randomBytes(8).toString("hex")}`;
      pendingAuthCodes.set(code, { codeChallenge, redirectUri, state });
      const cb = new URL(redirectUri);
      cb.searchParams.set("code", code);
      cb.searchParams.set("state", state);
      res.writeHead(302, { Location: cb.toString() });
      res.end();
      return;
    }

    if (parsed.pathname === "/oauth/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const form = new URLSearchParams(bodyText);
      const grantType = form.get("grant_type");
      const code = form.get("code") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const codeVerifier = form.get("code_verifier") ?? "";

      const record = pendingAuthCodes.get(code);
      if (!record || grantType !== "authorization_code" || record.redirectUri !== redirectUri) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      pendingAuthCodes.delete(code);

      const expectedChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      if (expectedChallenge !== record.codeChallenge) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_pkce_verifier" }));
        return;
      }

      const accessToken = `oauth-access-${crypto.randomBytes(8).toString("hex")}`;
      const refreshToken = `oauth-refresh-${crypto.randomBytes(8).toString("hex")}`;
      validTokens.add(accessToken);
      issuedRefreshTokens.add(refreshToken);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  };

  let tlsPair: { key: string; cert: string } | undefined;
  const server =
    protocol === "https"
      ? (() => {
          tlsPair = generateLocalhostTlsPair();
          return https.createServer({ key: tlsPair.key, cert: tlsPair.cert }, requestListener);
        })()
      : http.createServer(requestListener);

  server.on("upgrade", (req, socket: net.Socket) => {
    const rawProto = req.headers["sec-websocket-protocol"] ?? "";
    const protocols = String(rawProto)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ticketProto = protocols.find((p) => p.startsWith("hermes-gateway-ticket."));
    const ticket = ticketProto ? ticketProto.slice("hermes-gateway-ticket.".length) : null;
    const bearer = extractBearerToken(req.headers);

    wsConnections.push({
      headers: { ...req.headers },
      protocols,
      ticket,
    });

    if (currentRejectWsStatus !== null) {
      socket.write(`HTTP/1.1 ${currentRejectWsStatus} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    const ticketAuthorized = Boolean(ticket && validTickets.has(ticket));
    const bearerAuthorized = Boolean(bearer && validTokens.has(bearer));

    if (
      !protocols.includes("hermes-gateway-v1") ||
      !hasValidRequiredHeaders(req.headers) ||
      (!ticketAuthorized && !bearerAuthorized)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (ticket) {
      validTickets.delete(ticket);
    }

    const key = req.headers["sec-websocket-key"];
    if (!key || Array.isArray(key)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}${WS_GUID}`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "Sec-WebSocket-Protocol: hermes-gateway-v1",
        "",
        "",
      ].join("\r\n"),
    );

    activeSockets.add(socket);
    let buffer = Buffer.alloc(0);

    const sendJson = (obj: unknown) => {
      if (!socket.destroyed) {
        socket.write(encodeServerTextFrame(JSON.stringify(obj)));
      }
    };

    const sendNotification = (method: string, params: Record<string, unknown>) => {
      sendJson({ jsonrpc: "2.0", method, params });
    };

    const handleMessage = async (text: string) => {
      const reqMsg = JSON.parse(text) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (!reqMsg.method) return;
      const params = reqMsg.params ?? {};
      rpcCalls.push({ method: reqMsg.method, params });

      let replied = false;
      const replyResult = (result: unknown) => {
        if (replied || reqMsg.id === undefined) return;
        replied = true;
        sendJson({ jsonrpc: "2.0", id: reqMsg.id, result });
      };
      const replyError = (code: number, message: string) => {
        if (replied || reqMsg.id === undefined) return;
        replied = true;
        sendJson({ jsonrpc: "2.0", id: reqMsg.id, error: { code, message } });
      };

      if (options.onRpc) {
        const handled = await options.onRpc(reqMsg.method, params, {
          sendNotification,
          replyResult,
          replyError,
        });
        if (handled || replied) return;
      }

      if (!servedMethods.includes(reqMsg.method)) {
        replyError(-32601, `Method not found: ${reqMsg.method}`);
        return;
      }

      switch (reqMsg.method) {
        case "runtime.describe":
          replyResult({
            runtime_protocol: 1,
            capabilities: ["session-authority-v1", "host-scope-interactive"],
            served_methods: servedMethods,
            session_create: { sources: ["desktop"], parameters: ["title", "profile_id"] },
          });
          return;
        case "client.capabilities":
          replyResult({ accepted: true, server_requests: Boolean(params.server_requests) });
          return;
        case "subscribe":
          replyResult({ subscribed: true });
          return;
        case "profiles.list":
          replyResult({ profiles });
          return;
        case "session.list":
        case "sessions.list": {
          const pid = typeof params.profile_id === "string" ? params.profile_id : undefined;
          const list = pid ? sessions.filter((s) => s.profile_id === pid) : sessions;
          replyResult({ sessions: list });
          return;
        }
        case "session.create": {
          const profileId = typeof params.profile_id === "string" ? params.profile_id : "default";
          const sessionId = `remote-sess-${sessions.length + 1}`;
          const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "新对话";
          const entry = {
            profile_id: profileId,
            session_id: sessionId,
            title,
            preview: "",
            updated_at: new Date().toISOString(),
          };
          sessions.unshift(entry);
          transcripts.set(sessionId, []);
          replyResult({ session: entry });
          return;
        }
        case "session.resume":
        case "session.transcript": {
          const sid = typeof params.session_id === "string" ? params.session_id : "";
          replyResult({
            session_id: sid,
            messages: transcripts.get(sid) ?? [],
            active_turn_id: null,
          });
          return;
        }
        case "prompt.submit": {
          const sid = typeof params.session_id === "string" ? params.session_id : "";
          const promptText = typeof params.text === "string" ? params.text : "";
          const turnId = `rturn-${Date.now()}`;
          const userMsgId = `rmsg-u-${Date.now()}`;
          const assistantMsgId = `rmsg-a-${Date.now()}`;
          const list = transcripts.get(sid) ?? [];
          list.push({
            message_id: userMsgId,
            role: "user",
            text: promptText,
            created_at: new Date().toISOString(),
          });
          transcripts.set(sid, list);
          replyResult({
            accepted: true,
            session_id: sid,
            turn_id: turnId,
            user_message_id: userMsgId,
            assistant_message_id: assistantMsgId,
          });
          return;
        }
        case "prompt.cancel": {
          const sid = typeof params.session_id === "string" ? params.session_id : "";
          const turnId = typeof params.turn_id === "string" ? params.turn_id : "";
          replyResult({ stopped: true, session_id: sid, turn_id: turnId });
          sendNotification("prompt.stopped", {
            session_id: sid,
            turn_id: turnId,
          });
          return;
        }
        case "session.steer":
          replyResult({ steered: true });
          return;
        default:
          replyError(-32601, "Method not found");
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + len) return;

        let payload = buffer.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i += 1) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + maskLen + len);

        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeServerPongFrame(payload));
          continue;
        }
        if (opcode === 0x1) {
          void handleMessage(payload.toString("utf8"));
        }
      }
    });

    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as net.AddressInfo;
  const baseUrl = `${protocol}://127.0.0.1:${addr.port}`;
  const wsScheme = protocol === "https" ? "wss" : "ws";

  return {
    port: addr.port,
    protocol,
    baseUrl,
    wsUrl: `${wsScheme}://127.0.0.1:${addr.port}/api/ws`,
    caPem: tlsPair?.cert,
    validTokens,
    issuedRefreshTokens,
    httpRequests,
    wsConnections,
    rpcCalls,
    setRejectWsStatus(status) {
      currentRejectWsStatus = status;
    },
    setHttpHealthStatus(status) {
      currentHttpHealthStatus = status;
    },
    invalidateToken(token) {
      validTokens.delete(token);
    },
    closeAllClients() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
    },
    async close() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
