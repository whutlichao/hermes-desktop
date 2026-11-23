import crypto from "node:crypto";
import http from "node:http";
import type net from "node:net";

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
