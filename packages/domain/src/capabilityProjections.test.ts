import { describe, expect, it } from "vitest";
import {
  projectCronPayload,
  projectMcpRows,
  projectMemoryPayload,
  projectMessagingConnectors,
  projectPluginRows,
  projectSkillRows,
  projectToolRows,
  resolveExternalAttribution,
} from "./index";

describe("capability inventory projections (Ticket #44 / #45 coverage)", () => {
  it("projects plugin rows with fallbacks, load states, counts, sort order, and CLI key guards", () => {
    expect(projectPluginRows(null)).toEqual([]);
    expect(projectPluginRows({})).toEqual([]);

    const rows = projectPluginRows([
      null,
      [],
      "not-a-plugin",
      { name: "bad/name" },
      { key: "only-key" },
      {
        name: "zeta",
        key: "plugin:zeta",
        enabled: false,
        version: 123,
        tools: [1],
        hooks: 2,
        commands: "nope",
        error: "",
      },
      {
        name: "alpha",
        enabled: true,
        version: "1.0.0",
        tools: 3,
        hooks: [1, 2],
        commands: [],
        error: "boom",
        error_code: "LOAD_FAIL",
      },
      { name: "long", version: "x".repeat(40), enabled: "yes" },
    ]);

    expect(rows.map((row) => row.name)).toEqual(["alpha", "long", "only-key", "zeta"]);
    const alpha = rows.find((row) => row.name === "alpha");
    expect(alpha).toMatchObject({
      version: "1.0.0",
      enabled: true,
      loadStatus: "failed",
      errorCode: "LOAD_FAIL",
      toolCount: 3,
      hookCount: 2,
      commandCount: 0,
    });
    expect(alpha?.cliActions).toHaveLength(3);

    const onlyKey = rows.find((row) => row.name === "only-key");
    expect(onlyKey).toMatchObject({
      pluginKey: "only-key",
      key: "only-key",
      version: "未报告",
      enabled: false,
      loadStatus: "unknown",
    });

    const zeta = rows.find((row) => row.name === "zeta");
    expect(zeta).toMatchObject({ pluginKey: "plugin:zeta", toolCount: 1, hookCount: 2 });
    expect(zeta?.cliActions).toEqual([]);
    expect(zeta?.commandCount).toBeUndefined();

    expect(rows.find((row) => row.name === "long")?.version).toBe(`${"x".repeat(32)}…`);
  });

  it("projects skill, tool, and MCP rows across attribution and status fallbacks", () => {
    expect(projectSkillRows(undefined)).toEqual([]);
    const skills = projectSkillRows([
      null,
      [],
      { name: "bad/name" },
      { id: "skill-id" },
      {
        name: "beta",
        id: "beta-id",
        description: "desc",
        category: "cat",
        enabled: true,
        origin: "external",
        source: "hub",
        mcp_server: "mcp-1",
        plugin: "plug",
      },
      { name: "alpha", description: "x".repeat(200), enabled: "yes", source: "bundled" },
    ]);
    expect(skills.map((row) => row.name)).toEqual(["alpha", "beta", "skill-id"]);
    expect(skills.find((row) => row.name === "alpha")?.description).toBe(`${"x".repeat(160)}…`);
    expect(skills.find((row) => row.name === "alpha")?.attribution.origin).toBe("builtin");
    expect(skills.find((row) => row.name === "beta")?.attribution.provider?.kind).toBe("mcp");
    expect(skills.find((row) => row.skillId === "skill-id")?.name).toBe("skill-id");

    expect(projectToolRows("nope")).toEqual([]);
    const tools = projectToolRows([
      null,
      [],
      { name: "bad/name" },
      {
        id: "tool-id",
        server: "srv",
        source: "external",
        toolset: "ts",
        description: "d",
        enabled: false,
        plugin: "p",
      },
      {
        name: "mcptool",
        mcp_server: "mcp",
        external_provider: "ext",
        toolset: "ignored",
      },
      { name: "plain", source: "custom", toolset: "custom-ts" },
      { name: "plain-external", source: "external", toolset: "external-ts" },
    ]);
    expect(tools.map((row) => row.name)).toEqual(
      ["mcptool", "plain", "plain-external", "tool-id"].sort((a, b) => a.localeCompare(b, "en")),
    );
    const mcpTool = tools.find((row) => row.name === "mcptool");
    expect(mcpTool?.attribution.provider).toMatchObject({ kind: "mcp", id: "mcp" });
    const plainTool = tools.find((row) => row.name === "plain");
    expect(plainTool?.attribution.origin).toBe("unknown");
    expect(tools.find((row) => row.name === "plain-external")?.attribution.provider).toMatchObject({
      kind: "tool",
      id: "external-ts",
    });

    expect(projectMcpRows(null)).toEqual([]);
    const servers = projectMcpRows([
      null,
      [],
      { name: "bad/name" },
      { id: "server-id", status: "connected", tool_count: 2 },
      { name: "disc", connected: false },
      { name: "stop", status: "stopped" },
      { name: "err", error: "boom", error_code: { code: "MCP_FAIL" } },
      { name: "unk" },
    ]);
    expect(servers.find((row) => row.name === "server-id")).toMatchObject({
      status: "connected",
      toolCount: 2,
    });
    expect(servers.find((row) => row.name === "disc")?.status).toBe("disconnected");
    expect(servers.find((row) => row.name === "stop")?.status).toBe("disconnected");
    expect(servers.find((row) => row.name === "err")).toMatchObject({
      status: "error",
      errorCode: "MCP_FAIL",
    });
    expect(servers.find((row) => row.name === "unk")?.status).toBe("unknown");
  });

  it("projects memory payloads from sections, breakdown, categories, and summary fallbacks", () => {
    expect(projectMemoryPayload(null)).toEqual({ sections: [], notes: [] });
    expect(projectMemoryPayload("nope")).toEqual({ sections: [], notes: [] });

    const memory = projectMemoryPayload({
      session_id: "sess-1",
      total_tokens: 10,
      max_tokens: 20,
      sections: [
        null,
        [],
        { id: "memory graph", label: "leak" },
        { id: "ok", label: "Memory Graph" },
        { id: "s1", label: "System", tokens: 5, percentage: 150, entry_count: 3, summary: "note" },
        { key: "s2", name: "Named", percentage: -1 },
      ],
      notes: [
        null,
        "",
        "memory graph note",
        "good",
        "n2",
        "n3",
        "n4",
        "n5",
        "n6",
        "n7",
        "n8",
        "n9",
        "n10",
        "n11",
        "n12",
        "n13",
      ],
    });
    expect(memory.sessionId).toBe("sess-1");
    expect(memory.totalTokens).toBe(10);
    expect(memory.maxTokens).toBe(20);
    expect(memory.sections).toHaveLength(3);
    expect(memory.sections.find((section) => section.id === "s1")).toMatchObject({
      id: "s1",
      label: "System",
      tokens: 5,
      percentage: 100,
      entryCount: 3,
      summary: "note",
    });
    expect(memory.sections.find((section) => section.id === "s2")).toMatchObject({
      id: "s2",
      label: "Named",
    });
    expect(memory.sections.some((section) => section.label === "Memory Graph")).toBe(false);
    expect(memory.notes).toHaveLength(12);
    expect(memory.notes[0]).toBe("good");

    expect(projectMemoryPayload({ breakdown: [{ id: "b", label: "B" }] }).sections).toHaveLength(1);
    expect(projectMemoryPayload({ categories: [{ id: "c", label: "C" }] }).sections).toHaveLength(1);
    expect(projectMemoryPayload({ sections: [{ label: "Untitled" }] }).sections[0]).toMatchObject({
      id: "section-1",
    });
    expect(projectMemoryPayload({ summary: "single" }).notes).toEqual(["single"]);
    expect(projectMemoryPayload({ summary: "memory graph" }).notes).toEqual([]);
  });

  it("projects messaging connectors across payload shapes, statuses, and redaction guards", () => {
    expect(projectMessagingConnectors(null)).toEqual([]);
    expect(projectMessagingConnectors(42)).toEqual([]);
    expect(projectMessagingConnectors("nope")).toEqual([]);

    const connectors = [
      null,
      [],
      { platform: "bad/name" },
      {
        platform: "Slack",
        id: "slack-id",
        label: "Slack",
        status: "connected",
        detail: "desc",
        cli_command: "hermes messaging status",
        provider_kind: "gateway",
        provider_id: "gw",
      },
      { platform: "Mail", label: "OAuth account" },
      { name: "Disc", connected: false },
      { id: "conf", status: "configured" },
      { id: "err", status: "error", error_code: { code: "MSG_FAIL" } },
      { id: "unk" },
      {
        id: "detail-leak",
        platform: "Detail",
        detail: "oauth token",
        cli_command: "not-hermes",
      },
    ];
    const direct = projectMessagingConnectors(connectors);
    const wrapped = projectMessagingConnectors({ connectors });
    const channels = projectMessagingConnectors({ channels: connectors });
    expect(wrapped).toEqual(direct);
    expect(channels).toEqual(direct);
    expect(direct.find((row) => row.platform === "Slack")).toMatchObject({
      status: "connected",
      detail: "desc",
      cliCommand: "hermes messaging status",
      attribution: { provider: { kind: "gateway", id: "gw" } },
    });
    expect(direct.some((row) => row.platform === "Mail")).toBe(false);
    expect(direct.find((row) => row.platform === "Disc")?.status).toBe("disconnected");
    expect(direct.find((row) => row.connectorId === "conf")?.status).toBe("configured");
    expect(direct.find((row) => row.connectorId === "err")).toMatchObject({
      status: "error",
      errorCode: "MSG_FAIL",
    });
    expect(direct.find((row) => row.connectorId === "unk")?.status).toBe("unknown");
    const leak = direct.find((row) => row.connectorId === "detail-leak");
    expect(leak?.detail).toBeUndefined();
    expect(leak?.cliCommand).toBeUndefined();
  });

  it("projects cron payloads across list shapes, statuses, and action capabilities", () => {
    const caps = { canCancel: true, canRecover: true };
    expect(projectCronPayload(null, caps)).toEqual({ jobs: [] });
    expect(projectCronPayload(42, caps)).toEqual({ jobs: [] });

    const jobs = [
      null,
      [],
      {},
      { status: "running" },
      { status: "succeeded" },
      { status: "failed", error_code: "CRON_FAIL" },
      { status: "paused" },
      { status: "cancelled" },
      { status: "unknown" },
    ];
    const arrayPayload = projectCronPayload(jobs, caps);
    expect(arrayPayload.jobs).toHaveLength(7);
    expect(arrayPayload.jobs.find((job) => job.status === "running")?.canCancel).toBe(true);
    const failed = arrayPayload.jobs.find((job) => job.status === "failed");
    expect(failed).toMatchObject({ errorCode: "CRON_FAIL", canRecover: true });
    expect(arrayPayload.jobs.find((job) => job.status === "cancelled")?.canRecover).toBe(true);

    expect(projectCronPayload({ routines: jobs }, caps).jobs).toHaveLength(7);
    expect(projectCronPayload({ items: jobs, summary: "summary" }, caps).recentRunSummary).toBe(
      "summary",
    );
    const defaults = projectCronPayload([{}], caps).jobs[0];
    expect(defaults).toMatchObject({
      jobId: "cron-1",
      name: "cron-1",
      schedule: "* * * * *",
      status: "scheduled",
    });
  });

  it("resolves explicit external attribution only from positive evidence", () => {
    expect(resolveExternalAttribution({ providerKind: "mcp" })).toMatchObject({
      origin: "unknown",
    });
    expect(
      resolveExternalAttribution({ providerKind: "plugin", providerId: "plug" }),
    ).toMatchObject({ origin: "external", provider: { kind: "plugin", id: "plug" } });
    expect(resolveExternalAttribution({ source: "hub", providerId: "sk" })).toMatchObject({
      provider: { kind: "skill", id: "sk" },
    });
    expect(resolveExternalAttribution({ source: "custom", skillName: "sk2" })).toMatchObject({
      provider: { kind: "skill", id: "sk2" },
    });
    expect(
      resolveExternalAttribution({ providerKind: "skill", origin: "external", providerId: "sk3" }),
    ).toMatchObject({ provider: { kind: "skill", id: "sk3" } });
    expect(resolveExternalAttribution({ toolset: "ts", source: "external" })).toMatchObject({
      provider: { kind: "tool", id: "ts" },
    });
    expect(resolveExternalAttribution({ toolset: "ts", source: "bundled" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ toolset: "ts", source: "builtin" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ toolset: "ts", source: "core" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ toolset: "ts", origin: "builtin" }).origin).toBe("builtin");
    expect(
      resolveExternalAttribution({ providerKind: "gateway", providerId: "gw" }),
    ).toMatchObject({ provider: { kind: "gateway", id: "gw" } });
    expect(resolveExternalAttribution({ gatewayId: "gw2" })).toMatchObject({
      provider: { kind: "gateway", id: "gw2" },
    });
    expect(resolveExternalAttribution({ origin: "external" }).origin).toBe("unknown");
    expect(
      resolveExternalAttribution({
        origin: "external",
        providerKind: "plugin",
        providerId: "p",
      }),
    ).toMatchObject({ provider: { kind: "plugin", id: "p" } });
    expect(
      resolveExternalAttribution({
        source: "external",
        providerKind: "tool",
        providerId: "t",
      }),
    ).toMatchObject({ provider: { kind: "tool", id: "t" } });
    expect(resolveExternalAttribution({ source: "bundled" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ source: "builtin" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ source: "core" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ origin: "builtin" }).origin).toBe("builtin");
    expect(resolveExternalAttribution({ mcpServer: "https://secret.example" }).origin).toBe(
      "unknown",
    );
    expect(resolveExternalAttribution({ pluginName: "plugin", providerId: "p" })).toMatchObject({
      provider: { kind: "plugin", id: "plugin" },
    });
  });
});
