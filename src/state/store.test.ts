import { describe, expect, it } from "vitest";
import {
  appReducer,
  canHotReloadMcp,
  createInitialState,
  scopedChannels,
  scopedCronJobs,
  scopedMcpServers,
  scopedSessions,
  workspaceBodyMounted,
} from "./store";

describe("gateway and profile scope", () => {
  it("re-scopes sessions, channels, cron and MCP when Local switches to Homelab", () => {
    let state = createInitialState();

    expect(state.activeGatewayId).toBe("local");
    expect(state.activeProfileId).toBe("default");
    expect(scopedSessions(state).length).toBeGreaterThan(0);
    expect(scopedSessions(state).every((session) => session.gatewayId === "local" && session.profileId === "default")).toBe(true);

    state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });

    expect(state.activeGatewayId).toBe("homelab");
    expect(state.activeProfileId).toBe("research");
    expect(scopedSessions(state).length).toBeGreaterThan(0);
    expect(scopedSessions(state).every((session) => session.gatewayId === "homelab" && session.profileId === "research")).toBe(true);
    expect(scopedChannels(state).length).toBeGreaterThan(0);
    expect(scopedChannels(state).every((channel) => channel.gatewayId === "homelab" && channel.profileId === "research")).toBe(true);
    expect(scopedCronJobs(state).length).toBeGreaterThan(0);
    expect(scopedCronJobs(state).every((job) => job.gatewayId === "homelab" && job.profileId === "research")).toBe(true);
    expect(scopedMcpServers(state).length).toBeGreaterThan(0);
    expect(scopedMcpServers(state).every((server) => server.gatewayId === "homelab" && server.profileId === "research")).toBe(true);

    expect(canHotReloadMcp(state)).toBe(true);
    state = appReducer(state, { type: "SET_CAPABILITY_SCOPE", gatewayId: "local", profileId: "default" });
    expect(canHotReloadMcp(state)).toBe(false);

    expect(state.sessions.some((session) => session.gatewayId === "local")).toBe(true);
  });

  it("All profiles shows the union while the active scope stays explicit", () => {
    let state = createInitialState();
    const localCount = scopedSessions(state).length;

    state = appReducer(state, { type: "TOGGLE_ALL_PROFILES" });

    expect(state.allProfiles).toBe(true);
    expect(scopedSessions(state).length).toBeGreaterThan(localCount);
    expect(state.activeGatewayId).toBe("local");
    expect(state.activeProfileId).toBe("default");
  });
});

describe("workspace rail state", () => {
  it("Hide keeps the terminal mounted; Close releases it", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "OPEN_WORKSPACE", tab: "terminal" });
    state = appReducer(state, { type: "TERMINAL_RUN", command: "hermes gateway status" });

    const linesBeforeHide = state.workspace.terminal.lines.length;
    expect(linesBeforeHide).toBeGreaterThan(2);

    state = appReducer(state, { type: "WORKSPACE_MODE", mode: "hidden" });
    expect(workspaceBodyMounted(state)).toBe(true);
    expect(state.workspace.terminal.lines.length).toBe(linesBeforeHide);

    state = appReducer(state, { type: "OPEN_WORKSPACE", tab: "terminal" });
    expect(state.workspace.terminal.lines.length).toBe(linesBeforeHide);

    state = appReducer(state, { type: "WORKSPACE_MODE", mode: "closed" });
    expect(workspaceBodyMounted(state)).toBe(false);

    state = appReducer(state, { type: "OPEN_WORKSPACE", tab: "terminal" });
    expect(state.workspace.terminal.lines.length).toBeLessThan(linesBeforeHide);
  });
});

describe("operational state", () => {
  it("adds a default profile for a new gateway and rejects duplicate device names", () => {
    let state = createInitialState();
    state = appReducer(state, {
      type: "ADD_GATEWAY",
      gateway: {
        id: "edge",
        name: "Edge box",
        kind: "remote",
        health: "degraded",
        latencyMs: null,
        primary: false,
        appManaged: false,
        auth: "session-token",
        host: "https://edge.hermes.run",
        detail: "hermes serve",
        lastTest: "Not tested yet",
        lastTestTone: "warn",
        update: "idle",
        color: "#C8442E",
      },
    });

    expect(state.profiles.some((profile) => profile.gatewayId === "edge")).toBe(true);

    const gatewaysBefore = state.gateways.length;
    state = appReducer(state, {
      type: "ADD_GATEWAY",
      gateway: {
        ...state.gateways[state.gateways.length - 1],
        id: "edge-duplicate",
        name: "edge box",
      },
    });
    expect(state.gateways.length).toBe(gatewaysBefore);
    expect(state.toast?.title).toBe("Device name already in use");
  });

  it("keeps a restart banner after a channel change until the gateway restarts", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "TOGGLE_CHANNEL", channelId: "discord-homelab" });
    expect(state.restartRequired).toBe(true);

    state = appReducer(state, { type: "RESTART_GATEWAY" });
    expect(state.restartRequired).toBe(false);
  });

  it("resolves a dangerous approval without moving it to another host", () => {
    let state = createInitialState();
    const approval = state.sessions
      .flatMap((session) => session.messages)
      .map((message) => message.approval)
      .find((item) => item !== undefined);

    expect(approval).toBeDefined();
    const approvalId = approval!.id;
    const target = approval!.targetGateway;

    state = appReducer(state, { type: "RESOLVE_APPROVAL", approvalId, decision: "approved" });
    const updated = state.sessions
      .flatMap((session) => session.messages)
      .map((message) => message.approval)
      .find((item) => item?.id === approvalId);

    expect(updated?.status).toBe("approved");
    expect(updated?.targetGateway).toBe(target);
  });

  it("allows approval after inspecting the exact command", () => {
    let state = createInitialState();
    const approval = state.sessions
      .flatMap((session) => session.messages)
      .map((message) => message.approval)
      .find((item) => item !== undefined);

    expect(approval).toBeDefined();
    state = appReducer(state, {
      type: "RESOLVE_APPROVAL",
      approvalId: approval!.id,
      decision: "inspected",
    });
    state = appReducer(state, {
      type: "RESOLVE_APPROVAL",
      approvalId: approval!.id,
      decision: "approved",
    });

    const updated = state.sessions
      .flatMap((session) => session.messages)
      .map((message) => message.approval)
      .find((item) => item?.id === approval!.id);
    expect(updated?.status).toBe("approved");
  });

  it("returns to local sessions when the gateway hosting the active bot is removed", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "OPEN_BOT", botId: "bot-research-homelab" });
    expect(state.activeBotId).toBe("bot-research-homelab");

    state = appReducer(state, { type: "REMOVE_GATEWAY", gatewayId: "homelab" });

    expect(state.activeGatewayId).toBe("local");
    expect(state.activeBotId).toBeUndefined();
    expect(state.sidebarMode).toBe("sessions");
    expect(state.capabilities.scopeGatewayId).toBe("local");
    expect(state.settings.scopeGatewayId).toBe("local");
  });
});
