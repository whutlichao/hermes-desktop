import { describe, expect, it } from "vitest";
import {
  HOST_BRIDGE_VERSION,
  HOST_COMMANDS,
  HOST_TOPICS,
  type BridgeEvent,
  type SessionTranscriptSnapshot,
} from "@hermes/contracts";
import {
  buildGatewayWsSubprotocols,
  classifyRuntimeCapabilities,
  createBridgeDispatcher,
  createInitialShellState,
  evaluateCodeShaMismatch,
  filterSessionsForScope,
  isJsonRpcMethodNotFound,
  parseEnsureOrAttachOutput,
  reduceTranscriptEvent,
  shellReducer,
  validateEndpointProtocol,
  validateHostTopic,
} from "./index";

describe("Gateway protocol v1 parsing, capabilities & redaction (S0)", () => {
  it("parses modern ensure --json output and validates runtime_protocol === 1 + session-authority-v1", () => {
    const raw = JSON.stringify({
      state: "ready",
      attachable: true,
      install_code_sha: "sha_abc123",
      client_code_sha: "sha_abc123",
      endpoint: {
        api_origin: "http://127.0.0.1:8642",
        profile_id: "default",
        instance_id: "inst-01",
        authority_epoch: 4,
        runtime_protocol: 1,
        capabilities: ["session-authority-v1", "host-scope-interactive"],
        code_sha: "sha_abc123",
        ws_url: "ws://127.0.0.1:8642/api/ws",
        ws_protocol: "hermes-gateway-v1",
        ticket_protocol_prefix: "hermes-gateway-ticket.",
      },
    });

    const parsed = parseEnsureOrAttachOutput(raw, 0);
    expect(parsed.kind).toBe("ready");
    if (parsed.kind === "ready") {
      expect(parsed.endpoint.profileId).toBe("default");
      expect(parsed.endpoint.instanceId).toBe("inst-01");
      expect(parsed.endpoint.authorityEpoch).toBe(4);
      expect(parsed.endpoint.wsUrl).toBe("ws://127.0.0.1:8642/api/ws");
      expect(validateEndpointProtocol(parsed.endpoint)).toEqual({ valid: true });
    }
  });

  it("rejects endpoints whose runtime_protocol !== 1 or missing session-authority-v1", () => {
    const wrongProtocol = parseEnsureOrAttachOutput(
      JSON.stringify({
        state: "ready",
        endpoint: {
          profile_id: "default",
          instance_id: "inst-1",
          runtime_protocol: 2,
          capabilities: ["session-authority-v1"],
          ws_url: "ws://127.0.0.1:8642/api/ws",
        },
      }),
      0,
    );
    expect(wrongProtocol.kind).toBe("failure");
    if (wrongProtocol.kind === "failure") {
      expect(wrongProtocol.code).toBe("protocol_unsupported");
    }

    const missingCap = parseEnsureOrAttachOutput(
      JSON.stringify({
        state: "ready",
        endpoint: {
          profile_id: "default",
          instance_id: "inst-1",
          runtime_protocol: 1,
          capabilities: ["basic-ws"],
          ws_url: "ws://127.0.0.1:8642/api/ws",
        },
      }),
      0,
    );
    expect(missingCap.kind).toBe("failure");
    if (missingCap.kind === "failure") {
      expect(missingCap.code).toBe("protocol_unsupported");
    }
  });

  it("classifies starting/deadline without treating it as ready", () => {
    const starting = parseEnsureOrAttachOutput(
      JSON.stringify({
        state: "starting",
        reason_code: "deadline",
        attachable: false,
      }),
      5,
    );
    expect(starting).toEqual({
      kind: "starting",
      reasonCode: "deadline",
    });
  });

  it("evaluates code_sha mismatch only across known non-empty SHAs", () => {
    expect(
      evaluateCodeShaMismatch({
        clientCodeSha: "aaa111",
        endpointCodeSha: "aaa111",
        installCodeSha: undefined,
      }),
    ).toEqual({ mismatch: false, distinctShas: ["aaa111"] });

    expect(
      evaluateCodeShaMismatch({
        clientCodeSha: "aaa111",
        endpointCodeSha: "bbb222",
        installCodeSha: "aaa111",
      }),
    ).toEqual({ mismatch: true, distinctShas: ["aaa111", "bbb222"] });

    expect(
      evaluateCodeShaMismatch({
        clientCodeSha: undefined,
        endpointCodeSha: undefined,
        installCodeSha: undefined,
      }),
    ).toEqual({ mismatch: false, distinctShas: [] });
  });

  it("builds exact hermes-gateway-v1 ticket subprotocols", () => {
    expect(buildGatewayWsSubprotocols("tkt_abc123")).toEqual([
      "hermes-gateway-v1",
      "hermes-gateway-ticket.tkt_abc123",
    ]);
  });

  it("marks Chat unavailable when prompt.submit is absent from runtime.describe served methods", () => {
    const readOnlyCaps = classifyRuntimeCapabilities({
      served_methods: ["runtime.describe", "session.list", "session.transcript", "profiles.list"],
      capabilities: ["session-authority-v1"],
    });
    expect(readOnlyCaps.chatAvailable).toBe(false);
    expect(readOnlyCaps.promptSubmit).toBe(false);
    expect(readOnlyCaps.sessionCreate).toBe(false);

    const fullCaps = classifyRuntimeCapabilities({
      served_methods: [
        "runtime.describe",
        "profiles.list",
        "session.list",
        "session.create",
        "session.resume",
        "session.transcript",
        "prompt.submit",
        "prompt.cancel",
        "session.steer",
      ],
    });
    expect(fullCaps.chatAvailable).toBe(true);
    expect(fullCaps.promptSubmit).toBe(true);
    expect(fullCaps.promptCancel).toBe(true);
    expect(fullCaps.promptSteer).toBe(true);
    expect(fullCaps.sessionCreate).toBe(true);
    expect(fullCaps.sessionResume).toBe(true);

    expect(isJsonRpcMethodNotFound({ code: -32601, message: "Method not found" })).toBe(true);
    expect(isJsonRpcMethodNotFound({ code: -32000, message: "Other" })).toBe(false);
  });

  it("supports S0 HostBridge command/topic contracts and redacts ticket/wsUrl across the bridge", async () => {
    for (const cmd of [
      "profiles.list",
      "sessions.list",
      "sessions.create",
      "sessions.select",
      "sessions.resume",
      "prompts.send",
      "prompts.stop",
      "prompts.steer",
    ] as const) {
      expect(HOST_COMMANDS).toContain(cmd);
    }

    for (const topic of [
      "connection.health",
      "profiles",
      "sessions",
      "session.transcript",
      "prompt",
      "activity",
    ] as const) {
      expect(HOST_TOPICS).toContain(topic);
      expect(validateHostTopic(topic)).toEqual({ valid: true });
    }

    const dispatcher = createBridgeDispatcher(
      {
        "profiles.list": async () => ({
          profiles: [{ connectionId: "local", profileId: "default", displayName: "Default", handle: "default", isDefault: true }],
          ticket: "tkt_must_redact",
          wsUrl: "ws://127.0.0.1:8642/api/ws",
        }),
        "sessions.create": async (payload) => ({
          session: {
            connectionId: "local",
            profileId: "default",
            sessionId: "sess-1",
            title: String(payload.title || "新对话"),
            preview: "",
            updatedAt: "2026-11-23T06:00:00.000Z",
            pinned: false,
            unreadCount: 0,
            needsInput: false,
          },
          ws_url: "ws://127.0.0.1:8642/api/ws?ticket=tkt_secret",
        }),
        "prompts.send": async () => ({ accepted: true, turnId: "turn-1" }),
        "prompts.stop": async () => {
          const err = new Error("Stop ACK missing");
          (err as { code?: string }).code = "timeout";
          throw err;
        },
      },
      { getActiveScope: () => ({ connectionId: "local", profileId: "default" }) },
    );

    const profRes = await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "r-prof",
      command: "profiles.list",
      scope: { connectionId: "local", profileId: "default" },
      payload: {},
    });
    expect(profRes.ok).toBe(true);
    expect(JSON.stringify(profRes)).not.toContain("tkt_must_redact");
    expect(JSON.stringify(profRes)).not.toContain("ws://127.0.0.1");

    const createRes = await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "r-create",
      command: "sessions.create",
      scope: { connectionId: "local", profileId: "default" },
      payload: { title: "Local chat" },
    });
    expect(createRes.ok).toBe(true);
    expect(JSON.stringify(createRes)).not.toContain("tkt_secret");
    expect(JSON.stringify(createRes)).not.toContain("ws://127.0.0.1");

    const stopFail = await dispatcher.dispatch({
      version: HOST_BRIDGE_VERSION,
      requestId: "r-stop",
      command: "prompts.stop",
      scope: { connectionId: "local", profileId: "default", sessionId: "sess-1" },
      payload: { sessionId: "sess-1", turnId: "turn-1" },
    });
    expect(stopFail.ok).toBe(false);
    if (!stopFail.ok) {
      expect(stopFail.error.code).toBe("timeout");
    }
  });

  it("filters sessions strictly by active (connectionId, profileId) and reduces transcript streaming patches", () => {
    let state = createInitialShellState();
    state = shellReducer(state, {
      type: "APPLY_FLEET_SNAPSHOT",
      connections: [
        {
          connectionId: "local",
          label: "This device",
          kind: "local",
          originDisplay: "127.0.0.1",
          actual: "ready",
          degraded: false,
          latencyMs: 4,
          nextRetryAt: null,
        },
      ],
      profiles: [
        { connectionId: "local", profileId: "default", displayName: "Default", handle: "default", isDefault: true },
        { connectionId: "local", profileId: "work", displayName: "Work", handle: "work", isDefault: false },
      ],
      sessions: [
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "s-def-1",
          title: "Default Session",
          preview: "hi",
          updatedAt: "2026-11-23T06:00:00.000Z",
          pinned: false,
          unreadCount: 0,
          needsInput: false,
        },
        {
          connectionId: "local",
          profileId: "work",
          sessionId: "s-work-1",
          title: "Work Session",
          preview: "work",
          updatedAt: "2026-11-23T06:01:00.000Z",
          pinned: false,
          unreadCount: 0,
          needsInput: false,
        },
      ],
      activeScope: { connectionId: "local", profileId: "default" },
      activeSessionId: "s-def-1",
    });

    expect(filterSessionsForScope(state.sessions, state.activeScope).map((s) => s.sessionId)).toEqual([
      "s-def-1",
    ]);

    const initialTranscript: SessionTranscriptSnapshot = {
      connectionId: "local",
      profileId: "default",
      sessionId: "s-def-1",
      messages: [
        {
          messageId: "m-1",
          sessionId: "s-def-1",
          role: "user",
          text: "你好",
          createdAt: "2026-11-23T06:00:00.000Z",
        },
      ],
      activeTurnId: "t-1",
      turnStopping: false,
      chatAvailable: true,
      supportedActions: {
        promptSubmit: true,
        promptCancel: true,
        promptSteer: true,
        sessionCreate: true,
        sessionResume: true,
      },
    };

    const evDelta: BridgeEvent = {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-def-1" },
      kind: "patch",
      seq: 1,
      revision: 2,
      payload: {
        type: "token_delta",
        sessionId: "s-def-1",
        turnId: "t-1",
        messageId: "m-2",
        delta: "你好，",
      },
    };
    const afterDelta = reduceTranscriptEvent(initialTranscript, evDelta);
    expect(afterDelta).not.toBeNull();
    if (!afterDelta) return;
    expect(afterDelta.messages).toHaveLength(2);
    expect(afterDelta.messages[1].text).toBe("你好，");
    expect(afterDelta.messages[1].streaming).toBe(true);

    const afterTool = reduceTranscriptEvent(afterDelta, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-def-1" },
      kind: "patch",
      seq: 2,
      revision: 3,
      payload: {
        type: "tool_row",
        sessionId: "s-def-1",
        turnId: "t-1",
        messageId: "m-2",
        toolRow: {
          toolCallId: "tc-1",
          name: "read_file",
          status: "completed",
          summary: "README.md",
        },
      },
    });
    expect(afterTool).not.toBeNull();
    if (!afterTool) return;
    expect(afterTool.messages[1].toolRows).toHaveLength(1);
    expect(afterTool.messages[1].toolRows?.[0].name).toBe("read_file");
  });
});
