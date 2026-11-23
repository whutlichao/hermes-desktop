import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DOMAIN_IDS,
  REFUSED_GATEWAY_METHODS,
  SESSION_CLI_ACTION_IDS,
  SETTINGS_SECTION_IDS,
  type CapabilityEntry,
} from "@hermes/contracts";
import {
  CAPABILITY_DOMAIN_CATALOG,
  CapabilityRegistry,
  EXPLICIT_METHOD_ALIASES,
  SurfaceFocusReturnStack,
  auditCapabilityIntegrity,
  buildSessionCliDeepLinks,
  filterRenderableSessionCapabilities,
  isRefusedGatewayMethod,
  projectSettingsSectionFields,
  resolveExplicitMethodAlias,
  resolveExternalAttribution,
  resolveMethodWithAlias,
  resolveProfileManagementAvailability,
  projectApprovalView,
} from "./index";

describe("CapabilityRegistry 21-domain matrix, explicit aliases & invariants (S0)", () => {
  it("models all 21 domains as 13 native / 3 read_only / 1 deep_link / 4 deferred (17 reachable / 4 deferred) and Core 5 / Admin 8 / Exec 4", () => {
    expect(CAPABILITY_DOMAIN_IDS).toHaveLength(21);
    expect(CAPABILITY_DOMAIN_CATALOG).toHaveLength(21);

    const byClass = {
      native: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.classification === "native"),
      read_only: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.classification === "read_only"),
      deep_link: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.classification === "deep_link"),
      deferred: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.classification === "deferred"),
    };
    expect(byClass.native).toHaveLength(13);
    expect(byClass.read_only).toHaveLength(3);
    expect(byClass.deep_link).toHaveLength(1);
    expect(byClass.deferred).toHaveLength(4);
    expect(byClass.deferred.map((d) => d.domain)).toEqual(["voice", "bots", "memory_graph", "kanban"]);

    const byGroup = {
      core: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.group === "core"),
      admin: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.group === "admin"),
      exec: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.group === "exec"),
      deferred: CAPABILITY_DOMAIN_CATALOG.filter((d) => d.group === "deferred"),
    };
    expect(byGroup.core.map((d) => d.domain)).toEqual(["chat", "approval", "session", "terminal", "settings"]);
    expect(byGroup.admin).toHaveLength(8);
    expect(byGroup.exec).toHaveLength(4);
    expect(byGroup.deferred).toHaveLength(4);

    const registry = new CapabilityRegistry();
    const snap = registry.getSnapshot();
    expect(snap.counts).toEqual({
      total: 21,
      native: 13,
      readOnly: 3,
      deepLink: 1,
      reachable: 17,
      deferred: 4,
    });
    expect(snap.domains).toHaveLength(21);
    // Deferred domains must NEVER appear as executable entries
    expect(
      snap.entries.some((e) => e.classification === "deferred" || ["voice", "bots", "memory_graph", "kanban"].includes(e.domain)),
    ).toBe(false);
  });

  it("enforces CapabilityEntry completeness, registered handlerId, evidenceTestId, and rejects orphan or deferred actions", () => {
    const registry = new CapabilityRegistry();
    const snap = registry.getSnapshot();
    const registeredHandlers = new Set(snap.entries.map((e) => e.handlerId));

    const auditOk = auditCapabilityIntegrity(snap, registeredHandlers);
    expect(auditOk).toEqual({ ok: true, errors: [] });

    for (const entry of snap.entries) {
      expect(entry.domain).toBeTruthy();
      expect(entry.actionId).toBeTruthy();
      expect(entry.labelKey).toBeTruthy();
      expect(entry.classification).toBeTruthy();
      expect(entry.runtimeStatus).toBeTruthy();
      expect(entry.source).toBeTruthy();
      expect(Array.isArray(entry.requiredMethods)).toBe(true);
      expect(entry.handlerId).toBeTruthy();
      expect(entry.evidenceTestId).toBeTruthy();
      expect(typeof entry.generation).toBe("number");
    }

    // Missing handler -> audit fails!
    const badHandlers = new Set(registeredHandlers);
    badHandlers.delete(snap.entries[0].handlerId);
    const auditOrphan = auditCapabilityIntegrity(snap, badHandlers);
    expect(auditOrphan.ok).toBe(false);
    expect(auditOrphan.errors.some((e) => e.includes("orphan"))).toBe(true);

    // Deferred entry injected -> audit fails!
    const badEntry: CapabilityEntry = {
      ...snap.entries[0],
      domain: "voice",
      actionId: "voice.fake",
      classification: "deferred",
    };
    const auditDeferred = auditCapabilityIntegrity(
      { ...snap, entries: [...snap.entries, badEntry] },
      new Set([...registeredHandlers, badEntry.handlerId]),
    );
    expect(auditDeferred.ok).toBe(false);
    expect(auditDeferred.errors.some((e) => e.includes("deferred"))).toBe(true);
  });

  it("uses an explicit alias table ONLY and forbids heuristic/regex method guessing", () => {
    expect(EXPLICIT_METHOD_ALIASES["session.activate"]).toBe("session.resume");
    expect(EXPLICIT_METHOD_ALIASES["session.close"]).toBe("session.detach");
    expect(EXPLICIT_METHOD_ALIASES["session.status"]).toBe("session.info");

    expect(resolveExplicitMethodAlias("session.activate")).toBe("session.resume");
    expect(resolveExplicitMethodAlias("session.close")).toBe("session.detach");
    expect(resolveExplicitMethodAlias("session.status")).toBe("session.info");

    // Unregistered guesses must return null!
    expect(resolveExplicitMethodAlias("session.begin")).toBeNull();
    expect(resolveExplicitMethodAlias("prompt.send")).toBeNull();
    expect(resolveExplicitMethodAlias("skills.enable")).toBeNull();

    // Runtime resolution uses explicit alias when primary method is absent and alias target is served
    const resolved = resolveMethodWithAlias("session.activate", {
      "session.resume": "served",
    });
    expect(resolved).toEqual({
      method: "session.resume",
      tier: "served",
      aliasUsed: "session.activate -> session.resume",
    });

    // Never resolves a refused method even via alias
    const refused = resolveMethodWithAlias("session.activate", {
      "session.resume": "refused",
    });
    expect(refused).toEqual({
      method: "session.resume",
      tier: "refused",
      aliasUsed: "session.activate -> session.resume",
    });
  });

  it("keys CapabilitySnapshot by (connectionId, profileId, ownerGeneration, authorityEpoch, gatewayVersionOrSha) and blocks stale generation overwrite", () => {
    const registry = new CapabilityRegistry();
    const snap1 = registry.applyConnectHandshake({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 2,
      authorityEpoch: 5,
      gatewayVersionOrSha: "sha_v2",
      serverRequestsSupported: true,
      describeResult: {
        served_methods: ["prompt.submit", "session.list", "session.create", "session.resume"],
        older_methods: ["skills.list"],
        refused_methods: ["session.delete", "tools.configure"],
        session_create: { sources: ["desktop"], parameters: ["title", "profile_id"] },
      },
    });

    expect(snap1.key).toEqual({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 2,
      authorityEpoch: 5,
      gatewayVersionOrSha: "sha_v2",
    });
    expect(snap1.sessionCreateSpec).toEqual({
      sources: ["desktop"],
      parameters: ["title", "profile_id"],
    });
    expect(snap1.methodTiers["session.delete"]).toBe("refused");
    expect(snap1.methodTiers["skills.list"]).toBe("older");

    // Probe outcome from stale ownerGeneration=1 MUST be ignored (never revives old generation)
    const afterStaleProbe = registry.applyProbeOutcome({
      domain: "skills",
      method: "skills.list",
      outcome: "ok",
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 5,
      expectedGeneration: snap1.generation,
    });
    expect(afterStaleProbe.generation).toBe(snap1.generation);
    expect(afterStaleProbe.domains.find((d) => d.domain === "skills")?.probed).toBe(false);

    // Valid probe on older method succeeds -> still tagged degraded with reason "older"
    const afterValidOlderProbe = registry.applyProbeOutcome({
      domain: "skills",
      method: "skills.list",
      outcome: "ok",
      expectedOwnerGeneration: 2,
      expectedAuthorityEpoch: 5,
      expectedGeneration: snap1.generation,
    });
    const skillsDomain = afterValidOlderProbe.domains.find((d) => d.domain === "skills");
    expect(skillsDomain?.probed).toBe(true);
    expect(skillsDomain?.runtimeStatus).toBe("degraded");
    expect(skillsDomain?.degradation?.reason).toBe("older");

    // Invalidation on authority_epoch / resync / profile switch bumps generation and clears stale ready state
    const invalidated = registry.invalidate({
      reason: "resync_required",
      profileId: "work",
      authorityEpoch: 6,
    });
    expect(invalidated.generation).toBeGreaterThan(afterValidOlderProbe.generation);
    expect(invalidated.key.profileId).toBe("work");
    expect(invalidated.key.authorityEpoch).toBe(6);
    expect(invalidated.capabilitiesReady).toBe(false);
    expect(invalidated.invalidatedReason).toBe("resync_required");
  });

  it("marks approval unavailable when server_requests capability is missing (legacy owner) and degrades single -32601 method cleanly", () => {
    const registry = new CapabilityRegistry();
    const legacySnap = registry.applyConnectHandshake({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 1,
      authorityEpoch: 1,
      gatewayVersionOrSha: "legacy-1",
      serverRequestsSupported: false,
      describeResult: {
        served_methods: ["prompt.submit", "prompt.cancel", "session.list", "session.steer"],
      },
    });

    expect(legacySnap.legacyOwner).toBe(true);
    expect(legacySnap.serverRequestsSupported).toBe(false);
    const approvalDomain = legacySnap.domains.find((d) => d.domain === "approval");
    expect(approvalDomain?.runtimeStatus).toBe("unavailable");
    expect(approvalDomain?.degradation?.reason).toBe("missing_server_requests");

    // -32601 on session.steer degrades ONLY chat.steer, leaving chat.submit available
    const afterNotFound = registry.markMethodNotFound({
      method: "session.steer",
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
    });
    const steerEntry = afterNotFound.entries.find((e) => e.actionId === "chat.steer");
    const submitEntry = afterNotFound.entries.find((e) => e.actionId === "chat.submit");
    expect(steerEntry?.runtimeStatus).toBe("unavailable");
    expect(steerEntry?.degradation?.reason).toBe("method_not_found");
    expect(submitEntry?.runtimeStatus).toBe("available");
  });

  it("never renders any of the 16 refused methods and builds exact non-executing CLI deep links for session rename/delete/branch/archive/compress/undo (CAP-SESSION-01, CAP-SESSION-N1, CAP-SESSION-N2)", () => {
    expect(REFUSED_GATEWAY_METHODS).toHaveLength(16);
    for (const method of REFUSED_GATEWAY_METHODS) {
      expect(isRefusedGatewayMethod(method)).toBe(true);
    }
    expect(isRefusedGatewayMethod("prompt.submit")).toBe(false);
    expect(isRefusedGatewayMethod("custom.secret", { "custom.secret": "refused" })).toBe(true);

    const rendered = filterRenderableSessionCapabilities(
      [
        "prompt.submit",
        "prompt.cancel",
        "session.steer",
        "session.delete",
        "session.title",
        "session.branch",
        "session.archive",
        "session.compress",
        "session.undo",
        "agents.list",
        "session.workspace.move",
      ],
      { "prompt.submit": "served", "session.delete": "served" },
    );
    expect(rendered).toEqual(["prompt.submit", "prompt.cancel", "session.steer"]);

    const defaultLinks = buildSessionCliDeepLinks({
      sessionId: "sess_local_1",
      profileId: "default",
      title: "Refactor gateway client",
    });
    expect(defaultLinks.map((item) => item.actionId)).toEqual([...SESSION_CLI_ACTION_IDS]);
    expect(defaultLinks.find((item) => item.actionId === "rename")?.command).toBe(
      'hermes session rename sess_local_1 "Refactor gateway client"',
    );
    expect(defaultLinks.find((item) => item.actionId === "delete")?.command).toBe(
      "hermes session delete sess_local_1",
    );
    expect(defaultLinks.find((item) => item.actionId === "branch")?.command).toBe(
      "hermes session branch sess_local_1",
    );
    expect(defaultLinks.find((item) => item.actionId === "archive")?.command).toBe(
      "hermes session archive sess_local_1",
    );
    expect(defaultLinks.find((item) => item.actionId === "compress")?.command).toBe(
      "hermes session compress sess_local_1",
    );
    expect(defaultLinks.find((item) => item.actionId === "undo")?.command).toBe(
      "hermes session undo sess_local_1",
    );

    const workLinks = buildSessionCliDeepLinks({
      sessionId: "sess_work_2",
      profileId: "work",
    });
    expect(workLinks.find((item) => item.actionId === "delete")?.command).toBe(
      "hermes session delete --profile work sess_work_2",
    );
  });

  it("gates Profile management actions on read-only probe success and falls back to exact CLI/docs deep links (CAP-PROFILE-01, CAP-PROFILE-N1)", () => {
    const registry = new CapabilityRegistry();
    // Before probe passes, native profile management is hidden
    const initialAvail = resolveProfileManagementAvailability(registry.getSnapshot());
    expect(initialAvail.canManageNatively).toBe(false);
    expect(initialAvail.cliCommand).toBe("hermes profile list");
    expect(initialAvail.docsUrl).toMatch(/^https:\/\//);

    const connected = registry.applyConnectHandshake({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 1,
      authorityEpoch: 1,
      gatewayVersionOrSha: "sha_1",
      serverRequestsSupported: true,
      describeResult: {
        served_methods: ["prompt.submit", "session.list", "profiles.list"],
      },
    });
    // Still not probed yet -> must require read-only probe pass
    expect(resolveProfileManagementAvailability(connected).canManageNatively).toBe(false);

    const probedOk = registry.applyProbeOutcome({
      domain: "profile",
      method: "profiles.list",
      outcome: "ok",
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
      expectedGeneration: connected.generation,
    });
    expect(resolveProfileManagementAvailability(probedOk).canManageNatively).toBe(true);

    const probedMissing = registry.applyProbeOutcome({
      domain: "profile",
      method: "profiles.list",
      outcome: "method_not_found",
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
      expectedGeneration: probedOk.generation,
    });
    const afterMissing = resolveProfileManagementAvailability(probedMissing);
    expect(afterMissing.canManageNatively).toBe(false);
    expect(afterMissing.cliCommand).toBe("hermes profile list");
  });

  it("enforces the 9 Settings sections without Voice/Cloud/Billing and feature-detects supported config keys (CAP-SETTINGS-01, CAP-SETTINGS-N1, CAP-VOICE-N1)", () => {
    expect(SETTINGS_SECTION_IDS).toEqual([
      "model",
      "workspace",
      "safety",
      "memory",
      "chat",
      "gateways",
      "updates",
      "about",
      "diagnostics",
    ]);
    expect(SETTINGS_SECTION_IDS).not.toContain("voice");
    expect(SETTINGS_SECTION_IDS).not.toContain("cloud");
    expect(SETTINGS_SECTION_IDS).not.toContain("account");
    expect(SETTINGS_SECTION_IDS).not.toContain("billing");

    // When only model.default is supported, model.reasoning_effort and any cloud/voice keys are hidden
    const snapshot = {
      scope: { connectionId: "local", profileId: "default" },
      supported: true,
      readOnly: false,
      supportedKeys: [
        "model.default",
        "chat.send_on_enter",
        "voice.enabled",
        "cloud.account_tier",
        "billing.plan",
      ],
      values: {
        "model.default": "claude-3-7-sonnet",
        "chat.send_on_enter": true,
        "voice.enabled": true,
        "cloud.account_tier": "pro",
      },
      updatedAt: "2026-11-23T08:00:00.000Z",
    };

    const modelFields = projectSettingsSectionFields("model", snapshot);
    expect(modelFields.map((f) => f.key)).toEqual(["model.default"]);
    expect(modelFields[0]?.value).toBe("claude-3-7-sonnet");

    const workspaceFields = projectSettingsSectionFields("workspace", snapshot);
    expect(workspaceFields).toEqual([]);

    const chatFields = projectSettingsSectionFields("chat", snapshot);
    expect(chatFields.map((f) => f.key)).toEqual(["chat.send_on_enter"]);
  });

  it("manages LIFO FocusReturnController stack with Esc closing topmost, deterministic fallback, and ⌘W window close clearing return stack", () => {
    const controller = new SurfaceFocusReturnStack();
    controller.register("settings", { triggerId: "rail-settings-gear" });
    controller.register("scopePopover", { triggerId: "route-scope-trigger" });

    // Esc closes only topmost (scopePopover) and returns focus to route-scope-trigger
    const firstClose = controller.closeTopmost("escape");
    expect(firstClose).toEqual({
      closedSurface: "scopePopover",
      returnTargetId: "route-scope-trigger",
    });

    // Next Esc closes settings and returns focus to rail-settings-gear
    const secondClose = controller.closeTopmost("escape");
    expect(secondClose).toEqual({
      closedSurface: "settings",
      returnTargetId: "rail-settings-gear",
    });

    // If original trigger is hidden/unfocusable, resolveReturn falls back to composer-input -> rail-new-session
    controller.register("settings", { triggerId: "rail-settings-gear" });
    const fallbackTarget = controller.resolveReturn("settings", (id) => id === "composer-input");
    expect(fallbackTarget).toBe("composer-input");

    // ⌘W window close clears stack without returning focus
    controller.clearOnWindowClose();
    expect(controller.closeTopmost("escape")).toEqual({
      closedSurface: null,
      returnTargetId: null,
    });
  });

  it("enforces positive-evidence ExternalAttribution rules across builtin, external providers, and unknown fallback (EXT-ATTR-01..04, EXT-UNIT-01)", () => {
    // 1. Explicit builtin evidence
    const builtin = resolveExternalAttribution({ source: "bundled" });
    expect(builtin).toEqual({
      origin: "builtin",
      sourceLabel: "内置",
      accessibleLabel: "内置",
    });

    // 2. Missing source NEVER defaults to builtin -> must be unknown ("来源未知")
    expect(resolveExternalAttribution({})).toEqual({
      origin: "unknown",
      sourceLabel: "来源未知",
      accessibleLabel: "来源未知",
    });
    expect(resolveExternalAttribution({ source: undefined })).toEqual({
      origin: "unknown",
      sourceLabel: "来源未知",
      accessibleLabel: "来源未知",
    });
    expect(resolveExternalAttribution({ source: "" })).toEqual({
      origin: "unknown",
      sourceLabel: "来源未知",
      accessibleLabel: "来源未知",
    });

    // 3. External without provider or with unsafe path/URL/secret provider downgrades to unknown
    expect(resolveExternalAttribution({ origin: "external" })).toEqual({
      origin: "unknown",
      sourceLabel: "来源未知",
      accessibleLabel: "来源未知",
    });
    expect(
      resolveExternalAttribution({
        mcpServer: "/Users/alice/.hermes/plugins/secret-plugin",
      }),
    ).toEqual({
      origin: "unknown",
      sourceLabel: "来源未知",
      accessibleLabel: "来源未知",
    });
    expect(
      resolveExternalAttribution({
        pluginName: "https://evil.example.com/plugin.js",
      }),
    ).toEqual({
      origin: "unknown",
      sourceLabel: "来源未知",
      accessibleLabel: "来源未知",
    });

    // 4. Positive external providers: MCP, Plugin, Skill (hub/custom), Tool, Gateway
    const mcpAttr = resolveExternalAttribution({ mcpServer: "filesystem" });
    expect(mcpAttr).toEqual({
      origin: "external",
      provider: { kind: "mcp", id: "filesystem", label: "MCP · filesystem" },
      sourceLabel: "外部提供 · MCP · filesystem",
      accessibleLabel: "外部提供 · MCP · filesystem",
    });

    const pluginAttr = resolveExternalAttribution({ pluginName: "git-helper" });
    expect(pluginAttr).toEqual({
      origin: "external",
      provider: { kind: "plugin", id: "git-helper", label: "Plugin · git-helper" },
      sourceLabel: "外部提供 · Plugin · git-helper",
      accessibleLabel: "外部提供 · Plugin · git-helper",
    });

    const hubSkillAttr = resolveExternalAttribution({
      source: "hub",
      skillName: "deploy-assistant",
    });
    expect(hubSkillAttr).toEqual({
      origin: "external",
      provider: { kind: "skill", id: "deploy-assistant", label: "Skill · deploy-assistant" },
      sourceLabel: "外部提供 · Skill · deploy-assistant",
      accessibleLabel: "外部提供 · Skill · deploy-assistant",
    });

    // Approval card projection shares the exact same ExternalAttribution contract
    const approval = projectApprovalView({
      approvalId: "appr_1",
      sessionId: "sess_1",
      toolName: "filesystem__write_file",
      summary: "写入配置文件",
      mcpServer: "filesystem",
      requestedAt: "2026-11-23T09:00:00.000Z",
    });
    expect(approval.attribution).toEqual(mcpAttr);
  });

  it("projects Plugins 5 states, enforces strict field whitelist & error sanitization, sorts failed first, and gates plugin-rpc-v1 notice on runtime.describe.capabilities (EXT-INV-01..05, EXT-CLI-01, EXT-GUARD-02)", () => {
    const registry = new CapabilityRegistry();
    expect(registry.getSnapshot().extensions.status).toBe("unknown");
    expect(registry.getSnapshot().extensions.pluginRpcAdvertised).toBe(false);
    expect(registry.getSnapshot().extensions.scope.perPluginProfile).toBe(false);

    // Connect with plugin-rpc-v1 declared in capabilities array
    const connected = registry.applyConnectHandshake({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 1,
      authorityEpoch: 1,
      gatewayVersionOrSha: "v1.4.0",
      serverRequestsSupported: true,
      describeResult: {
        served_methods: ["prompt.submit", "plugins.list", "skills.list", "reload.skills", "tools.show", "mcp.list", "reload.mcp"],
        capabilities: ["session-authority-v1", "plugin-rpc-v1"],
      },
    });
    expect(connected.extensions.pluginRpcAdvertised).toBe(true);
    // Must NEVER pre-write or probe plugin.* methods
    expect(Object.keys(connected.methodTiers).some((m) => m.startsWith("plugin."))).toBe(false);

    // Apply plugins.list response containing forbidden fields (install_dir, settings_schema, servers, tools[], raw error with paths/secrets)
    const withPlugins = registry.applyPluginsInventory({
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
      outcome: "ok",
      rawPlugins: [
        {
          name: "zeta-clean",
          key: "zeta-clean",
          version: "2.1.0",
          enabled: true,
          tools: ["t1", "t2"],
          hooks: ["h1"],
          commands: ["c1", "c2", "c3"],
          install_dir: "/Users/alice/.hermes/plugins/zeta-clean",
          source: "local-disk",
          settings_schema: { secretKey: { type: "string" } },
          servers: ["mcp-internal"],
        },
        {
          name: "alpha-broken",
          key: "alpha-broken",
          enabled: false,
          error: "Error: ENOENT open '/Users/alice/.hermes/plugins/alpha/index.js' token=sk-1234567890abcdef",
          install_dir: "/Users/alice/.hermes/plugins/alpha",
          tools: ["hidden_tool_name"],
        },
      ],
    });

    expect(withPlugins.extensions.status).toBe("available");
    expect(withPlugins.extensions.counts).toEqual({
      reported: 2,
      enabled: 1,
      failed: 1,
    });
    // Failed plugins MUST be sorted first, then by name ascending
    expect(withPlugins.extensions.plugins.map((p) => p.name)).toEqual([
      "alpha-broken",
      "zeta-clean",
    ]);

    const broken = withPlugins.extensions.plugins[0]!;
    expect(broken.loadStatus).toBe("failed");
    expect(broken.loadStatusLabel).toBe("加载失败");
    expect(broken.errorCode).toBe("PLUGIN_LOAD_FAILED");
    expect(broken.version).toBe("未报告");
    expect(broken.enabledLabel).toBe("已禁用（Gateway 报告）");
    expect(broken.skillsLabel).toBe("Skills：未报告");
    expect(broken.toolCount).toBe(1);
    expect(broken.attribution.sourceLabel).toBe("外部提供 · Plugin · alpha-broken");
    // Forbidden fields must NOT exist anywhere in serialized row
    const serialized = JSON.stringify(withPlugins.extensions.plugins);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("sk-1234567890abcdef");
    expect(serialized).not.toContain("install_dir");
    expect(serialized).not.toContain("settings_schema");
    expect(serialized).not.toContain("mcp-internal");
    expect(serialized).not.toContain("hidden_tool_name");

    // Per-row CLI commands are exact and tagged "不会在此客户端执行"
    expect(broken.cliActions.map((a) => a.command)).toEqual([
      "hermes plugins enable alpha-broken",
      "hermes plugins remove alpha-broken",
      "hermes plugins update alpha-broken",
    ]);
    expect(broken.cliActions.every((a) => a.note === "不会在此客户端执行")).toBe(true);

    // Empty state: plugins.list returns []
    const emptySnap = registry.applyPluginsInventory({
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
      outcome: "ok",
      rawPlugins: [],
    });
    expect(emptySnap.extensions.status).toBe("empty");
    expect(emptySnap.extensions.plugins).toEqual([]);

    // Error state: transport or RPC failure
    const errorSnap = registry.applyPluginsInventory({
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
      outcome: "error",
      errorCode: "RPC_TIMEOUT",
    });
    expect(errorSnap.extensions.status).toBe("error");
    expect(errorSnap.extensions.errorCode).toBe("RPC_TIMEOUT");

    // Unsupported state: -32601 method_not_found
    const unsupportedSnap = registry.applyPluginsInventory({
      expectedOwnerGeneration: 1,
      expectedAuthorityEpoch: 1,
      outcome: "method_not_found",
    });
    expect(unsupportedSnap.extensions.status).toBe("unsupported");
  });

  it("projects read-only Skills (with reload), Tools (no fabrication or configure), and MCP (with reload) and invalidates on scope/generation change (EXT-INV-02..03, EXT-GUARD-01)", () => {
    const registry = new CapabilityRegistry();
    registry.applyConnectHandshake({
      connectionId: "local",
      profileId: "default",
      ownerGeneration: 3,
      authorityEpoch: 2,
      gatewayVersionOrSha: "v1.4.0",
      serverRequestsSupported: true,
      describeResult: {
        served_methods: ["skills.list", "skills.reload", "tools.show", "mcp.list", "reload.mcp"],
        older_methods: ["skills.install", "skills.enable", "skills.delete", "tools.configure", "mcp.add"],
      },
    });

    // 1. Skills: read-only inventory + reloadSupported=true (via skills.reload alias); older write methods NEVER exposed
    const afterSkills = registry.applySkillsInventory({
      expectedOwnerGeneration: 3,
      expectedAuthorityEpoch: 2,
      outcome: "ok",
      reloaded: true,
      rawSkills: [
        { id: "s1", name: "core-search", source: "bundled", enabled: true },
        { id: "s2", name: "hub-linter", source: "hub", enabled: true },
        { id: "s3", name: "unverified-local", enabled: false },
      ],
    });
    expect(afterSkills.extensions.skills.status).toBe("available");
    expect(afterSkills.extensions.skills.reloadSupported).toBe(true);
    expect(afterSkills.extensions.skills.lastReloadedAt).toBeTruthy();
    expect(afterSkills.extensions.skills.items.map((s) => s.attribution.origin)).toEqual([
      "builtin",
      "external",
      "unknown",
    ]);
    expect(afterSkills.extensions.skills.items[2]?.attribution.sourceLabel).toBe("来源未知");

    // 2. Tools: read-only from tools.show; when unsupported, never fabricates a list
    const afterToolsUnsupported = registry.applyToolsInventory({
      expectedOwnerGeneration: 3,
      expectedAuthorityEpoch: 2,
      outcome: "method_not_found",
    });
    expect(afterToolsUnsupported.extensions.tools.status).toBe("unsupported");
    expect(afterToolsUnsupported.extensions.tools.items).toEqual([]);

    const afterToolsOk = registry.applyToolsInventory({
      expectedOwnerGeneration: 3,
      expectedAuthorityEpoch: 2,
      outcome: "ok",
      rawTools: [
        { name: "bash", source: "bundled", toolset: "core" },
        { name: "fs_read", mcp_server: "filesystem" },
      ],
    });
    expect(afterToolsOk.extensions.tools.status).toBe("available");
    expect(afterToolsOk.extensions.tools.items[0]?.attribution.origin).toBe("builtin");
    expect(afterToolsOk.extensions.tools.items[1]?.attribution.sourceLabel).toBe(
      "外部提供 · MCP · filesystem",
    );

    // 3. MCP: status read-only + native reload.mcp
    const afterMcp = registry.applyMcpInventory({
      expectedOwnerGeneration: 3,
      expectedAuthorityEpoch: 2,
      outcome: "ok",
      reloaded: true,
      rawServers: [
        { name: "filesystem", status: "connected", tools: ["read", "write"] },
        { name: "github", status: "error", error: "Bearer ghp_secret123456 failed at /Users/alice" },
      ],
    });
    expect(afterMcp.extensions.mcp.status).toBe("available");
    expect(afterMcp.extensions.mcp.reloadSupported).toBe(true);
    expect(afterMcp.extensions.mcp.items[0]?.toolCount).toBe(2);
    expect(afterMcp.extensions.mcp.items[0]?.attribution.sourceLabel).toBe(
      "外部提供 · MCP · filesystem",
    );
    expect(afterMcp.extensions.mcp.items[1]?.status).toBe("error");
    expect(JSON.stringify(afterMcp.extensions.mcp.items)).not.toContain("ghp_secret123456");

    // 4. Stale generation response is ignored
    const afterStale = registry.applyPluginsInventory({
      expectedOwnerGeneration: 2,
      expectedAuthorityEpoch: 2,
      outcome: "ok",
      rawPlugins: [{ name: "stale-plugin", enabled: true }],
    });
    expect(afterStale.extensions.plugins).toEqual([]);

    // 5. Scope switch or resync invalidates cached inventories
    const afterInvalidate = registry.invalidate({
      reason: "scope_switched",
      connectionId: "remote-1",
      profileId: "work",
      ownerGeneration: 4,
      authorityEpoch: 1,
    });
    expect(afterInvalidate.extensions.status).toBe("unknown");
    expect(afterInvalidate.extensions.plugins).toEqual([]);
    expect(afterInvalidate.extensions.skills.items).toEqual([]);
    expect(afterInvalidate.extensions.tools.items).toEqual([]);
    expect(afterInvalidate.extensions.mcp.items).toEqual([]);
    expect(afterInvalidate.extensions.scope.connectionId).toBe("remote-1");
  });
});
