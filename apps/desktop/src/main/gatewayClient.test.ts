import { afterEach, describe, expect, it } from "vitest";
import {
  encodeServerTextFrame,
  startFakeGatewayServer,
  type FakeGatewayServerHandle,
} from "../../../../tests/helpers/fakeGatewayServer";
import { GatewayClient } from "./gatewayClient";

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

    const call = client.call("prompt.submit", { session_id: "s-1" }).then(() => {
      order.push("continuation");
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
    expect(order).toEqual(["continuation", "notification:prompt.delta"]);
  });
});
