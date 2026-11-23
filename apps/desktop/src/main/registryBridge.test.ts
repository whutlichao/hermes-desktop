import { afterEach, describe, expect, it } from "vitest";
import { HOST_BRIDGE_VERSION, type BridgeEvent, type ConnectionMutationResponse } from "@hermes/contracts";
import { createBridgeDispatcher } from "@hermes/domain";
import { createTestSandbox, type TestSandbox } from "../../../../tests/helpers/sandbox";
import { createRegistryBridgeHandlers } from "./registryBridge";
import { RegistryStore } from "./registryStore";

describe("Registry HostBridge seam (Main RegistryStore + MockHostBridge parity)", () => {
  const sandboxes: TestSandbox[] = [];
  const stores: RegistryStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
    for (const sb of sandboxes.splice(0)) {
      sb.cleanup(true);
    }
  });

  it("exposes display-safe registry commands & monotonic registry topic events with zero secret bytes", async () => {
    const sb = createTestSandbox("hermes-bridge-");
    sandboxes.push(sb);
    const store = new RegistryStore({ rootDir: sb.hermesHomeDir });
    stores.push(store);

    const bridge = createRegistryBridgeHandlers(store);
    const dispatcher = createBridgeDispatcher(bridge.handlers);

    const events: BridgeEvent[] = [];
    const unsub = bridge.subscribeRegistry((ev) => events.push(ev));

    // Initial snapshot seq: 0
    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe("registry");
    expect(events[0].kind).toBe("snapshot");
    expect(events[0].seq).toBe(0);

    // Add remote connection with secret token -> zero secret bytes cross bridge
    const addRes = await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "req-add-1",
      command: "connections.add",
      payload: {
        kind: "remote",
        label: "VPS Gateway",
        url: "https://vps.example.com",
        authMode: "token",
        token: "super-secret-bearer-token-999",
      },
    });
    expect(addRes.ok).toBe(true);
    if (addRes.ok) {
      const val = addRes.value as ConnectionMutationResponse;
      expect(val.committed).toBe(true);
      expect(val.snapshot.connections.find((c) => c.id === "vps-gateway")?.hasToken).toBe(true);
      expect(JSON.stringify(val)).not.toContain("super-secret-bearer-token-999");
    }

    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe("patch");
    expect(events[1].seq).toBe(1);
    expect(JSON.stringify(events[1])).not.toContain("super-secret-bearer-token-999");

    // Remove local is rejected safely with local_not_removable
    const rmLocal = await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "req-rm-local",
      command: "connections.remove",
      payload: { connectionId: "local" },
    });
    expect(rmLocal.ok).toBe(true);
    if (rmLocal.ok) {
      const val = rmLocal.value as ConnectionMutationResponse;
      expect(val.committed).toBe(false);
      expect(val.rejectedIssue?.code).toBe("local_not_removable");
    }

    // setPrimary + setLaunchMode update NEXT LAUNCH
    await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "req-primary",
      command: "connections.setPrimary",
      payload: { connectionId: "vps-gateway" },
    });
    const modeRes = await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "req-mode",
      command: "connections.setLaunchMode",
      payload: { launchMode: "primary" },
    });
    expect(modeRes.ok).toBe(true);
    if (modeRes.ok) {
      const val = modeRes.value as ConnectionMutationResponse;
      expect(val.snapshot.nextLaunch.connectionId).toBe("vps-gateway");
      expect(val.snapshot.nextLaunch.reason).toBe("primary");
    }

    unsub();
  });
});
