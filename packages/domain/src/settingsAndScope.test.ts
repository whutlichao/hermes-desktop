import { describe, expect, it } from "vitest";
import type { GatewayConfigSnapshot, SettingsSectionId } from "@hermes/contracts";
import {
  CapabilityRegistry,
  SurfaceFocusReturnStack,
  buildSessionCliDeepLinks,
  filterRenderableSessionCapabilities,
  projectSettingsSectionFields,
  resolveProfileManagementAvailability,
} from "./index";

describe("settings, scope, and focus-return domain helpers (Ticket #45 coverage)", () => {
  it("filters empty, duplicate, and refused session capabilities while preserving trimmed order", () => {
    expect(
      filterRenderableSessionCapabilities(
        ["", "   ", "prompt.submit", " prompt.submit ", "session.steer", "session.delete"],
        { "prompt.submit": "served" },
      ),
    ).toEqual(["prompt.submit", "session.steer"]);
  });

  it("sanitizes CLI deep-link tokens and titles with explicit fallbacks", () => {
    const fallbackLinks = buildSessionCliDeepLinks({
      sessionId: "!!!",
      profileId: "!!!",
      title: "   ",
    });
    expect(fallbackLinks[0].command).toBe('hermes session rename session_id "New Title"');
    expect(fallbackLinks[1].command).toBe("hermes session delete session_id");
    expect(fallbackLinks[0].executionNoteKey).toBe("session.cli.neverExecutedNotice");

    const emptyProfile = buildSessionCliDeepLinks({ sessionId: "sess-1", profileId: "" });
    expect(emptyProfile[1].command).toBe("hermes session delete sess-1");

    const escapedTitle = buildSessionCliDeepLinks({
      sessionId: "sess-1",
      profileId: "work",
      title: ' Refactor "gateway" $HOME `cmd` \\ path ',
    });
    expect(escapedTitle[0].command).toBe(
      'hermes session rename --profile work sess-1 "Refactor gateway HOME cmd  path"',
    );
  });

  it("derives profile management availability from the profile domain and its degradation", () => {
    const registry = new CapabilityRegistry();
    const base = registry.getSnapshot();
    const withoutProfile = {
      ...base,
      capabilitiesReady: true,
      domains: base.domains.filter((domain) => domain.domain !== "profile"),
    };
    expect(resolveProfileManagementAvailability(withoutProfile)).toMatchObject({
      canManageNatively: false,
      runtimeStatus: "unknown",
    });

    const profileDomain = base.domains.find((domain) => domain.domain === "profile");
    if (!profileDomain) throw new Error("profile domain missing");

    const available = {
      ...base,
      capabilitiesReady: true,
      domains: [
        ...base.domains.filter((domain) => domain.domain !== "profile"),
        { ...profileDomain, probed: true, runtimeStatus: "available" as const },
      ],
    };
    expect(resolveProfileManagementAvailability(available).canManageNatively).toBe(true);

    for (const reason of ["refused", "method_not_found"] as const) {
      const degraded = {
        ...base,
        capabilitiesReady: true,
        domains: [
          ...base.domains.filter((domain) => domain.domain !== "profile"),
          {
            ...profileDomain,
            probed: true,
            runtimeStatus: "degraded" as const,
            degradation: { reason },
          },
        ],
      };
      expect(resolveProfileManagementAvailability(degraded).canManageNatively).toBe(false);
    }

    const notReady = {
      ...base,
      capabilitiesReady: false,
      domains: [{ ...profileDomain, probed: true, runtimeStatus: "available" as const }],
    };
    expect(resolveProfileManagementAvailability(notReady).canManageNatively).toBe(false);
  });

  it("projects supported settings fields with defaults, drops unsupported sections, and respects readOnly", () => {
    expect(projectSettingsSectionFields("model", null)).toEqual([]);
    expect(projectSettingsSectionFields("model", undefined)).toEqual([]);

    const snapshot: GatewayConfigSnapshot = {
      scope: { connectionId: "local", profileId: "default" },
      supported: true,
      readOnly: true,
      supportedKeys: ["model.default", "chat.send_on_enter", "voice.enabled"],
      values: { "chat.send_on_enter": false, "voice.enabled": true },
      updatedAt: "2026-11-23T08:00:00.000Z",
    };
    const modelFields = projectSettingsSectionFields("model", snapshot);
    expect(modelFields).toHaveLength(1);
    expect(modelFields[0]).toMatchObject({
      key: "model.default",
      value: "claude-3-7-sonnet",
      readOnly: true,
    });
    expect(projectSettingsSectionFields("chat", snapshot)[0].value).toBe(false);
    expect(
      projectSettingsSectionFields("voice" as SettingsSectionId, snapshot),
    ).toEqual([]);
    expect(projectSettingsSectionFields("model", { ...snapshot, supported: false })).toEqual([]);
  });

  it("resolves focus-return fallbacks, missing surfaces, and all-unfocusable stacks", () => {
    const stack = new SurfaceFocusReturnStack();
    expect(stack.closeTopmost()).toEqual({ closedSurface: null, returnTargetId: null });
    expect(stack.resolveReturn("settings")).toBeNull();
    expect(stack.closeSurface("settings")).toEqual({
      closedSurface: null,
      returnTargetId: null,
    });

    stack.register("settings");
    expect(stack.resolveReturn("settings")).toBe("composer-input");
    expect(stack.resolveReturn("settings", () => false)).toBeNull();
    expect(stack.resolveReturn("palette", () => false)).toBeNull();
    expect(stack.closeSurface("settings")).toEqual({
      closedSurface: "settings",
      returnTargetId: "composer-input",
    });
    expect(stack.getStack()).toEqual([]);

    stack.register("settings", { triggerId: null, fallbackOrder: ["only-target"] });
    expect(stack.resolveReturn("settings", (id) => id === "only-target")).toBe("only-target");
    expect(stack.resolveReturn("settings", () => false)).toBeNull();
    expect(stack.closeTopmost("programmatic", () => false)).toEqual({
      closedSurface: "settings",
      returnTargetId: null,
    });
  });
});
