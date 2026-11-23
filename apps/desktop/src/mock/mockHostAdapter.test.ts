import { describe, expect, it } from "vitest";
import type { BridgeEvent, ConnectionMutationResponse, RegistrySnapshotView } from "@hermes/contracts";
import { createMockHostBridge } from "./mockHostAdapter";

describe("MockHostBridge Local first-run contract (Ticket #25)", () => {
  it("handles local.inspect, local.selectCli cancel, local.diagnose, and safe links.openExternal", async () => {
    const bridge = createMockHostBridge();

    const inspectRes = await bridge.request<{
      connectionId: string;
      actual: string;
      failure: { code: string; actions: string[] } | null;
      cli: { displayName: string; sourceKind: string };
    }>("local.inspect", {});
    expect(inspectRes.ok).toBe(true);
    if (inspectRes.ok) {
      expect(inspectRes.value.connectionId).toBe("local");
      expect(inspectRes.value.actual).toBe("blocked");
      expect(inspectRes.value.failure?.code).toBe("hermes_not_found");
      expect(inspectRes.value.failure?.actions).toEqual([
        "choose_cli",
        "open_install_docs",
        "retry",
      ]);
      expect(inspectRes.value.cli.displayName).not.toContain("/");
    }

    const selectRes = await bridge.request<{ cancelled: boolean }>("local.selectCli", {});
    expect(selectRes.ok).toBe(true);
    if (selectRes.ok) {
      expect(selectRes.value.cancelled).toBe(true);
    }

    const diagRes = await bridge.request<{
      typedFailureCode: string | null;
      hermesHomeKind: string;
      mode: string;
    }>("local.diagnose", {});
    expect(diagRes.ok).toBe(true);
    if (diagRes.ok) {
      expect(diagRes.value.typedFailureCode).toBe("hermes_not_found");
      expect(diagRes.value.hermesHomeKind).toBe("mock");
      expect(diagRes.value.mode).toBe("mock");
      expect(JSON.stringify(diagRes.value)).not.toMatch(/\/Users\/|\/home\/|stderr/i);
    }

    const badLink = await bridge.request("links.openExternal", { url: "file:///etc/passwd" });
    expect(badLink.ok).toBe(false);
    if (!badLink.ok) {
      expect(badLink.error.code).toBe("permission_denied");
    }

    const okLink = await bridge.request("links.openExternal", {
      url: "https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
    });
    expect(okLink.ok).toBe(true);
  });
});

describe("MockHostBridge registry contract parity", () => {
  it("implements connections.* and registry topic contract without fs/network", async () => {
    const mock = createMockHostBridge();
    const events: BridgeEvent[] = [];
    const unsub = mock.subscribe("registry", null, (ev) => events.push(ev));

    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect((events[0].payload as { snapshot: RegistrySnapshotView }).snapshot.connections[0].id).toBe("local");

    const addRes = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Homelab",
      host: "lab.local",
      user: "ubuntu",
    });
    expect(addRes.ok).toBe(true);
    if (addRes.ok) {
      expect(addRes.value.committed).toBe(true);
      expect(addRes.value.snapshot.connections).toHaveLength(2);
    }

    const dupRes = await mock.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: "Homelab 2",
      host: "LAB.LOCAL",
      user: "UBUNTU",
    });
    expect(dupRes.ok).toBe(true);
    if (dupRes.ok) {
      expect(dupRes.value.committed).toBe(false);
      expect(dupRes.value.rejectedIssue?.code).toBe("duplicate_identity");
      expect(dupRes.value.conflict?.existing.label).toBe("Homelab");
    }

    unsub();
  });
});
