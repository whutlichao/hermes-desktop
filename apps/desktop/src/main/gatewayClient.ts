import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { buildGatewayWsSubprotocols } from "@hermes/domain";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class GatewayRpcError extends Error {
  readonly rpcCode: number;
  readonly isMethodNotFound: boolean;

  constructor(rpcCode: number, safeMessage: string) {
    super(safeMessage);
    this.name = "GatewayRpcError";
    this.rpcCode = rpcCode;
    this.isMethodNotFound = rpcCode === -32601;
  }
}

export class GatewayTransportError extends Error {
  readonly code: "unreachable" | "timeout" | "auth_failed" | "protocol_unsupported";

  constructor(
    code: "unreachable" | "timeout" | "auth_failed" | "protocol_unsupported",
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "GatewayTransportError";
    this.code = code;
  }
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }

  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, masked]);
}

export interface GatewayClientConnectOptions {
  wsUrl: string;
  ticket: string;
  ticketProtocolPrefix?: string;
  connectTimeoutMs?: number;
}

export type GatewayNotificationListener = (method: string, params: Record<string, unknown>) => void;
export type GatewayCloseListener = (reason: string) => void;

export class GatewayClient {
  private socket: net.Socket;
  private closed = false;
  private rpcSeq = 0;
  private rxBuffer = Buffer.alloc(0);
  private fragmentedOpcode: number | null = null;
  private fragmentedChunks: Buffer[] = [];
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly notificationListeners = new Set<GatewayNotificationListener>();
  private readonly closeListeners = new Set<GatewayCloseListener>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.attachSocketListeners();
  }

  static async connect(options: GatewayClientConnectOptions): Promise<GatewayClient> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.wsUrl);
    } catch {
      throw new GatewayTransportError("unreachable", "Invalid gateway WebSocket URL");
    }

    const isSecure = parsedUrl.protocol === "wss:";
    if (parsedUrl.protocol !== "ws:" && !isSecure) {
      throw new GatewayTransportError("protocol_unsupported", "Unsupported gateway WebSocket scheme");
    }

    const protocols = buildGatewayWsSubprotocols(options.ticket, options.ticketProtocolPrefix);
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(`${key}${WS_GUID}`)
      .digest("base64");

    const timeoutMs = options.connectTimeoutMs ?? 10_000;
    const reqModule = isSecure ? https : http;
    const port = parsedUrl.port ? Number(parsedUrl.port) : isSecure ? 443 : 80;
    const reqPath = `${parsedUrl.pathname || "/"}${parsedUrl.search || ""}`;

    return new Promise<GatewayClient>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      // Explicitly omit Origin header so gateway Origin guard accepts loopback/desktop connections
      const req = reqModule.request({
        hostname: parsedUrl.hostname,
        port,
        path: reqPath,
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": protocols.join(", "),
        },
      });

      const timer = setTimeout(() => {
        req.destroy();
        fail(new GatewayTransportError("timeout", "Gateway WebSocket handshake timed out"));
      }, timeoutMs);

      req.on("upgrade", (res, socket, head) => {
        if (settled) {
          socket.destroy();
          return;
        }
        const acceptHeader = res.headers["sec-websocket-accept"];
        if (acceptHeader !== expectedAccept) {
          socket.destroy();
          fail(new GatewayTransportError("protocol_unsupported", "Invalid WebSocket accept header"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        const client = new GatewayClient(socket);
        if (head && head.length > 0) {
          client.onData(head);
        }
        resolve(client);
      });

      req.on("response", (res) => {
        res.resume();
        if (res.statusCode === 401 || res.statusCode === 403) {
          fail(new GatewayTransportError("auth_failed", "Gateway rejected WebSocket ticket"));
        } else {
          fail(new GatewayTransportError("unreachable", `Gateway upgrade failed (${res.statusCode ?? 0})`));
        }
      });

      req.on("error", () => {
        fail(new GatewayTransportError("unreachable", "Unable to reach local gateway WebSocket"));
      });

      req.end();
    });
  }

  private attachSocketListeners(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    this.socket.on("close", () => {
      this.handleDisconnect("socket_closed");
    });
    this.socket.on("error", () => {
      this.handleDisconnect("socket_error");
    });
  }

  private handleDisconnect(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new GatewayTransportError("unreachable", "Gateway connection closed"));
      this.pending.delete(id);
    }
    for (const listener of this.closeListeners) {
      listener(reason);
    }
  }

  private onData(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (this.rxBuffer.length >= 2) {
      const b0 = this.rxBuffer[0];
      const b1 = this.rxBuffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.rxBuffer.length < 4) return;
        len = this.rxBuffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.rxBuffer.length < 10) return;
        len = Number(this.rxBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.rxBuffer.length < offset + maskLen + len) return;

      let payload = this.rxBuffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.rxBuffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }
      this.rxBuffer = this.rxBuffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        if (!this.closed && !this.socket.destroyed) {
          this.socket.write(encodeClientFrame(0xA, payload));
        }
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }

      if (opcode === 0x0) {
        if (this.fragmentedOpcode !== null) {
          this.fragmentedChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(this.fragmentedChunks);
            const origOpcode = this.fragmentedOpcode;
            this.fragmentedOpcode = null;
            this.fragmentedChunks = [];
            if (origOpcode === 0x1) {
              this.handleTextFrame(full.toString("utf8"));
            }
          }
        }
        continue;
      }

      if (!fin) {
        this.fragmentedOpcode = opcode;
        this.fragmentedChunks = [payload];
        continue;
      }

      if (opcode === 0x1) {
        this.handleTextFrame(payload.toString("utf8"));
      }
    }
  }

  private handleTextFrame(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const id = String(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { code?: unknown; message?: unknown };
        const rpcCode = typeof errObj.code === "number" ? errObj.code : -32000;
        entry.reject(
          new GatewayRpcError(
            rpcCode,
            rpcCode === -32601 ? "Method not supported by gateway" : "Gateway RPC failed",
          ),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      const params =
        msg.params && typeof msg.params === "object"
          ? (msg.params as Record<string, unknown>)
          : {};
      if (msg.id !== undefined && msg.id !== null) {
        // Server-to-client request: acknowledge ping/heartbeat or return method not found cleanly
        if (msg.method === "ping" || msg.method === "heartbeat") {
          this.sendRaw({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        }
      }
      for (const listener of this.notificationListeners) {
        listener(msg.method, params);
      }
    }
  }

  private sendRaw(obj: unknown): void {
    if (this.closed || this.socket.destroyed) return;
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    this.socket.write(encodeClientFrame(0x1, buf));
  }

  isOpen(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.closed || this.socket.destroyed) {
      throw new GatewayTransportError("unreachable", "Gateway connection is not open");
    }

    this.rpcSeq += 1;
    const id = `rpc-${this.rpcSeq}`;
    const timeoutMs = options?.timeoutMs ?? 15_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayTransportError("timeout", "Gateway RPC request timed out"));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.sendRaw({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  onNotification(listener: GatewayNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onClose(listener: GatewayCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    try {
      if (!this.socket.destroyed) {
        const closePayload = Buffer.alloc(2);
        closePayload.writeUInt16BE(1000, 0);
        this.socket.write(encodeClientFrame(0x8, closePayload));
        this.socket.end();
      }
    } catch {
      // ignore
    }
    this.handleDisconnect("client_closed");
  }
}
