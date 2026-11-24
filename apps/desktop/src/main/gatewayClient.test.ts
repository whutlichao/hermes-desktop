import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeServerTextFrame,
  startFakeGatewayServer,
  type FakeGatewayServerHandle,
} from "../../../../tests/helpers/fakeGatewayServer";
import { GatewayClient, GatewayTransportError } from "./gatewayClient";

describe("GatewayClient frame dispatch ordering", () => {
  let gw: FakeGatewayServerHandle | null = null;
  let client: GatewayClient | null = null;

  afterEach(async () => {
    client?.close();
    await gw?.close();
  });

  it("completes an RPC continuation before dispatching a following notification from the same socket read", async () => {
    gw = await startFakeGatewayServer({
      validTickets: new Set(["tkt-order-1"]),
      onRpc: () => true,
    });
    client = await GatewayClient.connect({ wsUrl: gw.wsUrl, ticket: "tkt-order-1" });

    const order: string[] = [];
    client.onNotification((method) => {
      order.push(`notification:${method}`);
    });

    const call = client.call("prompt.submit", { session_id: "s-1" }).then(async () => {
      order.push("continuation:start");
      await Promise.resolve();
      order.push("continuation:admission");
      await Promise.resolve();
      order.push("continuation:end");
    });

    const frames = Buffer.concat([
      encodeServerTextFrame(
        JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result: { accepted: true } }),
      ),
      encodeServerTextFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "prompt.delta",
          params: { session_id: "s-1", delta: "early" },
        }),
      ),
    ]);
    (client as unknown as { onData(chunk: Buffer): void }).onData(frames);

    await call;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([
      "continuation:start",
      "continuation:admission",
      "continuation:end",
      "notification:prompt.delta",
    ]);
  });

  it("delivers parsed notifications in FIFO order before close cleanup rejects outstanding RPCs", async () => {
    gw = await startFakeGatewayServer({
      validTickets: new Set(["tkt-close-drain"]),
      onRpc: () => true,
    });
    client = await GatewayClient.connect({ wsUrl: gw.wsUrl, ticket: "tkt-close-drain" });

    const events: string[] = [];
    let resolveClosed!: (reason: string) => void;
    const closed = new Promise<string>((resolve) => {
      resolveClosed = resolve;
    });
    client.onNotification((method) => {
      events.push(`notification:${method}`);
    });
    client.onClose((reason) => {
      events.push("close");
      resolveClosed(reason);
    });

    const firstCall = client.call("prompt.submit", { session_id: "s-1" });
    const outstandingCall = expect(
      client.call("prompt.hold", { session_id: "s-1" }),
    ).rejects.toBeInstanceOf(GatewayTransportError);

    const frames = Buffer.concat([
      encodeServerTextFrame(
        JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result: { accepted: true } }),
      ),
      encodeServerTextFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "prompt.delta",
          params: { session_id: "s-1", delta: "early" },
        }),
      ),
      encodeServerTextFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "prompt.completed",
          params: { session_id: "s-1", status: "completed" },
        }),
      ),
      Buffer.from([0x88, 0x00]),
    ]);
    (client as unknown as { onData(chunk: Buffer): void }).onData(frames);

    await expect(firstCall).resolves.toEqual({ accepted: true });
    await expect(closed).resolves.toBe("client_closed");
    await outstandingCall;

    expect(events).toEqual([
      "notification:prompt.delta",
      "notification:prompt.completed",
      "close",
    ]);
    expect(client.isOpen()).toBe(false);
    await expect(client.call("prompt.after-close")).rejects.toBeInstanceOf(GatewayTransportError);
  });

  it("closes immediately when no parsed notification is queued", async () => {
    gw = await startFakeGatewayServer({
      validTickets: new Set(["tkt-close-empty"]),
      onRpc: () => true,
    });
    client = await GatewayClient.connect({ wsUrl: gw.wsUrl, ticket: "tkt-close-empty" });

    const events: string[] = [];
    let resolveClosed!: (reason: string) => void;
    const closed = new Promise<string>((resolve) => {
      resolveClosed = resolve;
    });
    client.onClose((reason) => {
      events.push("close");
      resolveClosed(reason);
    });
    const outstandingCall = expect(
      client.call("prompt.hold", { session_id: "s-1" }),
    ).rejects.toBeInstanceOf(GatewayTransportError);

    (client as unknown as { onData(chunk: Buffer): void }).onData(Buffer.from([0x88, 0x00]));

    await expect(closed).resolves.toBe("client_closed");
    await outstandingCall;
    expect(events).toEqual(["close"]);
    expect(client.isOpen()).toBe(false);
  });

  it("resets a stale dispatch flag at disconnect entry so parsed frames still drain before close", async () => {
    gw = await startFakeGatewayServer({
      validTickets: new Set(["tkt-close-stale"]),
      onRpc: () => true,
    });
    client = await GatewayClient.connect({ wsUrl: gw.wsUrl, ticket: "tkt-close-stale" });

    const events: string[] = [];
    client.onNotification((method) => {
      events.push(`notification:${method}`);
    });
    client.onClose((reason) => {
      events.push(`close:${reason}`);
    });

    const scheduled: Array<() => void> = [];
    const setImmediateSpy = vi
      .spyOn(globalThis, "setImmediate")
      .mockImplementation(((callback: () => void) => {
        scheduled.push(callback);
        return 0 as unknown as NodeJS.Immediate;
      }) as typeof setImmediate);

    try {
      const internals = client as unknown as {
        pendingTextFrames: string[];
        textFrameDispatchScheduled: boolean;
        handleDisconnect(reason: string): void;
      };
      internals.pendingTextFrames.push(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "prompt.delta",
          params: { session_id: "s-1", delta: "stale" },
        }),
      );
      internals.textFrameDispatchScheduled = true;
      internals.handleDisconnect("socket_closed");

      expect(scheduled).toHaveLength(1);
      while (scheduled.length > 0) {
        scheduled.shift()!();
      }
    } finally {
      setImmediateSpy.mockRestore();
    }

    expect(events).toEqual(["notification:prompt.delta", "close:socket_closed"]);
    expect(client.isOpen()).toBe(false);
  });
});
