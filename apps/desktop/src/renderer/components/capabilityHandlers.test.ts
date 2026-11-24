import { describe, expect, it } from "vitest";
import { CapabilityRegistry, auditCapabilityIntegrity } from "@hermes/domain";
import { CAPABILITY_HANDLER_IDS } from "./capabilityHandlers";

describe("Renderer capability handler registry invariant (S0)", () => {
  it("registers a real handler for every CapabilityEntry with zero orphan or deferred actions", () => {
    const registry = new CapabilityRegistry();
    const snap = registry.getSnapshot();
    const handlerSet = new Set<string>(CAPABILITY_HANDLER_IDS);

    const audit = auditCapabilityIntegrity(snap, handlerSet);
    expect(audit).toEqual({ ok: true, errors: [] });

    // Even when all served methods are enabled, every entry must map to a registered handler
    const fullSnap = registry.applyConnectHandshake({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 1,
      authorityEpoch: 1,
      gatewayVersionOrSha: "sha_full",
      serverRequestsSupported: true,
      describeResult: {
        served_methods: [
          "prompt.submit",
          "prompt.cancel",
          "session.steer",
          "approval.list",
          "session.create",
          "session.list",
          "session.resume",
          "shell.exec",
          "profiles.list",
          "skills.list",
          "tools.show",
          "mcp.list",
          "session.context_breakdown",
          "cron.status",
          "messaging.status",
          "plugins.list",
          "checkpoint.list",
          "files.list",
          "subagents.list",
        ],
      },
    });
    expect(auditCapabilityIntegrity(fullSnap, handlerSet)).toEqual({ ok: true, errors: [] });
  });
});
