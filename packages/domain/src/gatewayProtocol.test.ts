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
  createTranscriptSyncController,
  evaluateCodeShaMismatch,
  filterProfilesForConnection,
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

  it("parses the installed Hermes 0.23.3 wire shape from ensure and attach", () => {
    const verdict = {
      client_code_sha: "sha_live_1",
      detail: null,
      endpoint: {
        api_origin: "http://127.0.0.1:63942",
        authority_epoch: 26,
        capabilities: [
          "durable-admission-v1",
          "event-replay-v1",
          "session-authority-v1",
        ],
        code_sha: "sha_live_1",
        control_home: null,
        instance_id: "inst-live-1",
        profile_id: "/Users/example/.hermes",
        runtime_protocol: 1,
        supervisor: "launchd",
      },
      reason_code: null,
      state: "ready",
    };

    const ensured = parseEnsureOrAttachOutput(JSON.stringify(verdict), 0);
    expect(ensured.kind).toBe("ready");
    if (ensured.kind === "ready") {
      expect(ensured.endpoint.wsUrl).toBe("ws://127.0.0.1:63942/api/ws");
      expect(ensured.endpoint.profileId).toBe("/Users/example/.hermes");
      expect(ensured.ticket).toBeUndefined();
    }

    const attached = parseEnsureOrAttachOutput(
      JSON.stringify({
        ...verdict,
        protocol: "hermes-gateway-v1",
        protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.tkt_capture_1"],
        ticket: "tkt_capture_1",
        url: "ws://127.0.0.1:63942/api/ws",
      }),
      0,
    );
    expect(attached.kind).toBe("ready");
    if (attached.kind === "ready") {
      expect(attached.endpoint.wsUrl).toBe("ws://127.0.0.1:63942/api/ws");
      expect(attached.endpoint.wsProtocol).toBe("hermes-gateway-v1");
      expect(attached.ticket).toBe("tkt_capture_1");
    }
  });

  it("derives a ws url from api_origin only for a bare http(s) origin", () => {
    const makeOutput = (apiOrigin: string) =>
      JSON.stringify({
        state: "ready",
        endpoint: {
          api_origin: apiOrigin,
          profile_id: "default",
          instance_id: "inst-origin",
          authority_epoch: 1,
          runtime_protocol: 1,
          capabilities: ["session-authority-v1"],
        },
      });

    const loopback = parseEnsureOrAttachOutput(makeOutput("http://127.0.0.1:8642"), 0);
    expect(loopback.kind).toBe("ready");
    if (loopback.kind === "ready") {
      expect(loopback.endpoint.wsUrl).toBe("ws://127.0.0.1:8642/api/ws");
    }

    const secure = parseEnsureOrAttachOutput(makeOutput("https://127.0.0.1:8642"), 0);
    expect(secure.kind).toBe("ready");
    if (secure.kind === "ready") {
      expect(secure.endpoint.wsUrl).toBe("wss://127.0.0.1:8642/api/ws");
    }

    for (const unsafe of [
      "http://user:pass@127.0.0.1:8642",
      "http://127.0.0.1:8642/other",
      "http://127.0.0.1:8642?token=x",
      "file:///tmp/gateway.sock",
      "not a url",
    ]) {
      expect(parseEnsureOrAttachOutput(makeOutput(unsafe), 0).kind).toBe("failure");
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

  it("discards duplicate pre-snapshot patches, applies seq > snapshot.seq patches, and cleanly replaces transcript on gap/resync", () => {
    const sync = createTranscriptSyncController();

    const makeSnap = (messages: SessionTranscriptSnapshot["messages"], seq: number): SessionTranscriptSnapshot => ({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-1",
      messages,
      activeTurnId: "t-1",
      turnStopping: false,
      chatAvailable: true,
      snapshotSeq: seq,
      supportedActions: {
        promptSubmit: true,
        promptCancel: true,
        promptSteer: true,
        sessionCreate: true,
        sessionResume: true,
      },
    });

    // Apply authoritative snapshot at seq=5
    const snapRes = sync.applySnapshot(
      makeSnap(
        [{ messageId: "m-1", sessionId: "s-1", role: "assistant", text: "Hello", createdAt: "2026-11-23T06:00:00Z" }],
        5,
      ),
      5,
    );
    expect(snapRes.status).toBe("applied");

    // Pre-snapshot duplicate patch (seq=4 and seq=5) must be discarded
    expect(
      sync.applyPatch(4, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "DUP" }).status,
    ).toBe("discarded_duplicate");
    expect(
      sync.applyPatch(5, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "DUP" }).status,
    ).toBe("discarded_duplicate");
    expect(sync.getSnapshot()?.messages[0].text).toBe("Hello");

    // Sequential patch seq=6 applies cleanly
    const seq6 = sync.applyPatch(6, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: " world" });
    expect(seq6.status).toBe("applied");
    expect(sync.getSnapshot()?.messages[0].text).toBe("Hello world");

    // Gap patch seq=8 (missed seq=7) triggers resync_required
    const seq8 = sync.applyPatch(8, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "TORN" });
    expect(seq8.status).toBe("resync_required");
    expect(sync.getSnapshot()?.messages[0].text).toBe("Hello world");

    // Replacement snapshot at seq=9 replaces entire transcript cleanly with resynced=true (no torn text)
    const replaced = sync.applySnapshot(
      makeSnap(
        [{ messageId: "m-1", sessionId: "s-1", role: "assistant", text: "Clean authoritative reply", createdAt: "2026-11-23T06:00:00Z" }],
        9,
      ),
      9,
      { replace: true, resynced: true },
    );
    expect(replaced.status).toBe("applied");
    expect(sync.getSnapshot()?.messages).toHaveLength(1);
    expect(sync.getSnapshot()?.messages[0].text).toBe("Clean authoritative reply");
    expect(sync.getSnapshot()?.resynced).toBe(true);
  });

  it("covers protocol failure mapping, capability fallbacks, filters, and transcript reducer edges", () => {
    expect(parseEnsureOrAttachOutput("", 5)).toEqual({
      kind: "starting",
      reasonCode: "deadline",
    });
    expect(parseEnsureOrAttachOutput("", 3)).toEqual({
      kind: "failure",
      code: "protocol_unsupported",
    });
    expect(parseEnsureOrAttachOutput("", 4)).toEqual({
      kind: "failure",
      code: "profile_unavailable",
    });
    expect(parseEnsureOrAttachOutput("", 5)).toEqual({
      kind: "starting",
      reasonCode: "deadline",
    });
    expect(parseEnsureOrAttachOutput("", 6)).toEqual({
      kind: "failure",
      code: "update_paused",
    });
    expect(parseEnsureOrAttachOutput("", 7)).toEqual({
      kind: "failure",
      code: "gateway_start_failed",
    });
    expect(parseEnsureOrAttachOutput("", 99)).toEqual({
      kind: "failure",
      code: "gateway_start_failed",
    });
    expect(parseEnsureOrAttachOutput("{not json", 5)).toEqual({
      kind: "failure",
      code: "gateway_starting_timeout",
    });
    expect(parseEnsureOrAttachOutput("{not json", 0)).toEqual({
      kind: "failure",
      code: "invalid_control_state",
    });
    const startingByExit = parseEnsureOrAttachOutput(JSON.stringify({ state: "stopped" }), 5);
    expect(startingByExit).toEqual({ kind: "starting", reasonCode: "deadline" });
    const startingByReason = parseEnsureOrAttachOutput(
      JSON.stringify({ state: "ready", reason_code: "deadline" }),
      0,
    );
    expect(startingByReason).toEqual({ kind: "starting", reasonCode: "deadline" });
    const withReasonCode = parseEnsureOrAttachOutput(
      JSON.stringify({ state: "starting" }),
      0,
    );
    expect(withReasonCode).toEqual({ kind: "starting", reasonCode: "deadline" });

    const failureStates = ["error", "blocked", "stopped"];
    for (const state of failureStates) {
      const parsed = parseEnsureOrAttachOutput(
        JSON.stringify({
          state,
          reason_code: "gateway_other_session",
          profile_id: "work",
        }),
        0,
      );
      expect(parsed).toEqual({
        kind: "failure",
        code: "gateway_other_session",
        reasonCode: "gateway_other_session",
        profileId: "work",
      });
    }
    expect(
      parseEnsureOrAttachOutput(
        JSON.stringify({ state: "blocked", reason_code: "profile_not_served" }),
        0,
      ),
    ).toMatchObject({ kind: "failure", code: "profile_unavailable" });
    expect(
      parseEnsureOrAttachOutput(JSON.stringify({ state: "blocked", reason_code: "elevated" }), 0),
    ).toMatchObject({ kind: "failure", code: "gateway_elevated" });
    expect(
      parseEnsureOrAttachOutput(JSON.stringify({ state: "blocked", reason_code: "unauthorized" }), 0),
    ).toMatchObject({ kind: "failure", code: "authorization" });
    expect(
      parseEnsureOrAttachOutput(JSON.stringify({ state: "blocked", reason_code: "draining" }), 0),
    ).toMatchObject({ kind: "failure", code: "update_paused" });
    expect(
      parseEnsureOrAttachOutput(JSON.stringify({ state: "blocked", reason_code: "service_unhealthy" }), 0),
    ).toMatchObject({ kind: "failure", code: "service_unhealthy" });
    expect(
      parseEnsureOrAttachOutput(JSON.stringify({ state: "blocked", reason_code: "incompatible" }), 0),
    ).toMatchObject({ kind: "failure", code: "protocol_unsupported" });
    expect(
      parseEnsureOrAttachOutput(JSON.stringify({ state: "blocked", reason_code: "code_sha_mismatch" }), 0),
    ).toMatchObject({ kind: "failure", code: "code_sha_mismatch" });
    expect(
      parseEnsureOrAttachOutput(
        JSON.stringify({
          state: "ready",
          reason_code: "unknown_reason",
          endpoint: { profile_id: "default" },
        }),
        0,
      ),
    ).toEqual({
      kind: "failure",
      code: "gateway_start_failed",
      reasonCode: "unknown_reason",
    });

    // Invalid types are ignored for optional fields; defaults are applied.
    const defaults = parseEnsureOrAttachOutput(
      JSON.stringify({
        endpoint: {
          ws_url: "ws://127.0.0.1:1/api/ws",
          runtime_protocol: 1,
          capabilities: ["session-authority-v1", 42],
          profile_id: "   ",
          instance_id: 3,
          authority_epoch: Number.NaN,
          ws_protocol: "",
          ticket_protocol_prefix: "",
          code_sha: "  ",
        },
        protocols: ["hermes-gateway-ticket.tkt_from_protocol"],
        attachable: false,
        expires_in_seconds: Number.POSITIVE_INFINITY,
      }),
      0,
    );
    expect(defaults.kind).toBe("ready");
    if (defaults.kind === "ready") {
      expect(defaults.endpoint.profileId).toBe("default");
      expect(defaults.endpoint.instanceId).toBe("local-instance");
      expect(defaults.endpoint.authorityEpoch).toBe(1);
      expect(defaults.endpoint.wsProtocol).toBe("hermes-gateway-v1");
      expect(defaults.endpoint.ticketProtocolPrefix).toBe("hermes-gateway-ticket.");
      expect(defaults.endpoint.codeSha).toBeUndefined();
      expect(defaults.ticket).toBe("tkt_from_protocol");
      expect(defaults.expiresInSeconds).toBe(30);
      expect(defaults.attachable).toBe(false);
    }
    const defaultAttachable = parseEnsureOrAttachOutput(
      JSON.stringify({
        endpoint: {
          ws_url: "ws://127.0.0.1:1/api/ws",
          runtime_protocol: 1,
          capabilities: ["session-authority-v1"],
        },
      }),
      0,
    );
    expect(defaultAttachable.kind).toBe("ready");
    if (defaultAttachable.kind === "ready") {
      expect(defaultAttachable.attachable).toBe(true);
    }
    expect(validateEndpointProtocol({ capabilities: [], wsUrl: "ws://x" })).toEqual({
      valid: false,
      code: "protocol_unsupported",
    });
    expect(
      validateEndpointProtocol({ runtimeProtocol: 1, capabilities: ["session-authority-v1"] }),
    ).toEqual({ valid: false, code: "invalid_control_state" });
  });

  it("classifies capability-map and capability-list fallbacks including refusals", () => {
    const empty = classifyRuntimeCapabilities(undefined);
    expect(empty.chatAvailable).toBe(false);
    expect(empty.profilesList).toBe(false);

    const capMap = classifyRuntimeCapabilities({
      capabilities: {
        chat: false,
        "prompt.cancel": false,
        "session.steer": false,
        "session.create": false,
        "session.resume": false,
        "session.list": false,
        "session.transcript": false,
        "profiles.list": false,
      },
    });
    expect(capMap).toMatchObject({
      chatAvailable: false,
      promptSubmit: false,
      promptCancel: false,
      promptSteer: false,
      sessionCreate: false,
      sessionResume: false,
      sessionList: false,
      sessionTranscript: false,
      profilesList: false,
    });

    const defaultCapMap = classifyRuntimeCapabilities({ capabilities: {} });
    expect(defaultCapMap.chatAvailable).toBe(true);
    expect(defaultCapMap.profilesList).toBe(true);
    const refusedMap = classifyRuntimeCapabilities({
      capabilities: {},
      refused_methods: ["prompt.submit", "session.create", "profiles.list"],
    });
    expect(refusedMap.promptSubmit).toBe(false);
    expect(refusedMap.sessionCreate).toBe(false);
    expect(refusedMap.profilesList).toBe(false);
    expect(refusedMap.promptCancel).toBe(true);

    const capList = classifyRuntimeCapabilities({ capabilities: ["chat-v1"] });
    expect(capList).toMatchObject({
      chatAvailable: true,
      promptSubmit: true,
      promptCancel: true,
      promptSteer: true,
      sessionCreate: false,
      sessionResume: false,
      sessionList: false,
      sessionTranscript: false,
      profilesList: false,
    });
    const authorityList = classifyRuntimeCapabilities({
      capabilities: ["session-authority-v1"],
      refused_methods: ["profile.list"],
    });
    expect(authorityList).toMatchObject({
      chatAvailable: false,
      sessionCreate: true,
      sessionResume: true,
      sessionList: true,
      sessionTranscript: true,
      profilesList: true,
    });
    expect(
      classifyRuntimeCapabilities({ served_methods: ["prompt.submit", "session.steer"] }),
    ).toMatchObject({ promptSubmit: true, promptSteer: true, promptCancel: false });
    expect(isJsonRpcMethodNotFound(null)).toBe(false);
    expect(isJsonRpcMethodNotFound("nope")).toBe(false);
    expect(isJsonRpcMethodNotFound({ rpcCode: -32601 })).toBe(true);

    expect(filterSessionsForScope([], null)).toEqual([]);
    expect(filterProfilesForConnection([], null)).toEqual([]);
    expect(filterProfilesForConnection([], "")).toEqual([]);
  });

  it("classifies the Hermes 0.23.3 runtime capability tags without a served_methods catalog", () => {
    const caps = classifyRuntimeCapabilities({
      runtime_protocol: 1,
      capabilities: [
        "durable-admission-v1",
        "event-replay-v1",
        "local-cli-create-v1",
        "acp-editor-policy-v1",
        "acp-session-mcp-v1",
        "clarify-batch-v1",
        "plugin-rpc-v1",
        "session-client-v1",
        "session-transcript-v1",
        "session-list-picker-v1",
        "session-list-cursor-v1",
      ],
      session_create: {
        sources: ["acp", "cli", "gui", "oneshot", "tool", "tui"],
        parameters: ["title", "source"],
      },
    });

    expect(caps).toEqual({
      chatAvailable: true,
      promptSubmit: true,
      promptCancel: true,
      promptSteer: true,
      sessionCreate: true,
      sessionResume: true,
      sessionList: true,
      sessionTranscript: true,
      profilesList: true,
    });
  });

  it("reduces transcript snapshots, unknown scopes, upserts, turn state, and sync-controller resets", () => {
    const makeSnap = (): SessionTranscriptSnapshot => ({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-1",
      messages: [
        {
          messageId: "m-1",
          sessionId: "s-1",
          role: "assistant",
          text: "hi",
          createdAt: "2026-11-23T06:00:00Z",
          streaming: true,
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
    });
    expect(reduceTranscriptEvent(null, { topic: "fleet" } as never)).toBeNull();
    expect(
      reduceTranscriptEvent(makeSnap(), {
        topic: "session.transcript",
        scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
        kind: "resync_required",
        seq: 1,
        revision: 1,
        payload: {},
      }),
    ).not.toBeNull();
    expect(
      reduceTranscriptEvent(makeSnap(), {
        topic: "session.transcript",
        scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
        kind: "patch",
        seq: 1,
        revision: 1,
        payload: { type: "token_delta", sessionId: "other", messageId: "m-1", delta: "x" },
      })?.messages[0].text,
    ).toBe("hi");
    const upserted = reduceTranscriptEvent(makeSnap(), {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 2,
      revision: 2,
      payload: {
        type: "message_upsert",
        sessionId: "s-1",
        message: {
          messageId: "m-1",
          sessionId: "s-1",
          role: "assistant",
          text: "updated",
          createdAt: "2026-11-23T06:00:00Z",
        },
      },
    });
    expect(upserted?.messages[0].text).toBe("updated");
    const appended = reduceTranscriptEvent(upserted, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 3,
      revision: 3,
      payload: {
        type: "message_upsert",
        sessionId: "s-1",
        message: {
          messageId: "m-2",
          sessionId: "s-1",
          role: "user",
          text: "new",
          createdAt: "2026-11-23T06:01:00Z",
        },
      },
    });
    expect(appended?.messages).toHaveLength(2);
    const toolByTurn = reduceTranscriptEvent(appended, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 4,
      revision: 4,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        turnId: "t-1",
        toolRow: { toolCallId: "tc-1", name: "read", status: "running" },
      },
    });
    expect(
      toolByTurn?.messages.some((m) => m.toolRows?.some((r) => r.name === "read")),
    ).toBe(true);
    const toolNoTarget = reduceTranscriptEvent(toolByTurn, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 5,
      revision: 5,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        turnId: "t-unknown",
        toolRow: { toolCallId: "tc-2", name: "write", status: "completed" },
      },
    });
    expect(toolNoTarget?.messages.at(-1)?.toolRows?.[0].toolCallId).toBe("tc-2");
    const toolReplaced = reduceTranscriptEvent(toolByTurn, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 6,
      revision: 6,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        messageId: "m-1",
        toolRow: { toolCallId: "tc-1", name: "read", status: "completed" },
      },
    });
    expect(toolReplaced?.messages[0].toolRows?.[0].status).toBe("completed");
    const turnTargeted = reduceTranscriptEvent(toolReplaced, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 7,
      revision: 7,
      payload: {
        type: "turn_state",
        sessionId: "s-1",
        messageId: "m-1",
        activeTurnId: null,
        status: "complete",
      },
    });
    expect(turnTargeted?.messages[0].streaming).toBe(false);
    const turnAll = reduceTranscriptEvent(turnTargeted, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 8,
      revision: 8,
      payload: {
        type: "turn_state",
        sessionId: "s-1",
        activeTurnId: null,
        turnStopping: true,
        executionGeneration: 3,
        stopState: "stopping",
      },
    });
    expect(turnAll).toMatchObject({
      activeTurnId: null,
      turnStopping: true,
      executionGeneration: 3,
      stopState: "stopping",
    });
    const capsUpdate = reduceTranscriptEvent(turnAll, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 9,
      revision: 9,
      payload: {
        type: "capabilities_update",
        sessionId: "s-1",
        chatAvailable: false,
        supportedActions: {
          promptSubmit: false,
          promptCancel: false,
          promptSteer: false,
          sessionCreate: false,
          sessionResume: false,
        },
        chatUnavailableReason: "missing",
      },
    });
    expect(capsUpdate?.chatAvailable).toBe(false);
    expect(capsUpdate?.chatUnavailableReason).toBe("missing");

    const sync = createTranscriptSyncController();
    expect(sync.applyPatch(1, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "x" })).toEqual({
      status: "resync_required",
      expectedSeq: 0,
      receivedSeq: 1,
    });
    expect(sync.acceptEvent({ topic: "fleet" } as never)).toEqual({ status: "ignored" });
    sync.applySnapshot(makeSnap(), 0);
    expect(sync.applyPatch(0, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "x" }).status).toBe(
      "discarded_duplicate",
    );
    const loss = sync.acceptEvent({
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 1,
      revision: 1,
      payload: { possible_event_loss: true },
    });
    expect(loss.status).toBe("resync_required");
    expect(sync.isResyncRequired()).toBe(true);
    expect(sync.acceptEvent({
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "resync_required",
      seq: 2,
      revision: 2,
      payload: {},
    }).status).toBe("resync_required");
    sync.reset();
    expect(sync.getSnapshot()).toBeNull();
    expect(sync.isResyncRequired()).toBe(false);
    expect(sync.acceptEvent({
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "snapshot",
      seq: 4,
      revision: 4,
      payload: makeSnap(),
    })).toEqual({ status: "applied", snapshot: expect.objectContaining({ snapshotSeq: 4 }) });
    expect(sync.applyPatch(5, { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "y" }).status).toBe(
      "applied",
    );
  });

  it("covers every failure reason, camelCase endpoints, and remaining transcript reducer arms", () => {
    const failureReasonCases = [
      ["profile_parked", "profile_unavailable"],
      ["profile_mismatch", "profile_unavailable"],
      ["gateway_elevated", "gateway_elevated"],
      ["authorization", "authorization"],
      ["update_paused", "update_paused"],
      ["protocol_unsupported", "protocol_unsupported"],
    ] as const;
    for (const [reasonCode, expectedCode] of failureReasonCases) {
      expect(
        parseEnsureOrAttachOutput(
          JSON.stringify({ state: "blocked", reason_code: reasonCode }),
          0,
        ),
      ).toMatchObject({ kind: "failure", code: expectedCode, reasonCode });
    }

    const camelEndpoint = parseEnsureOrAttachOutput(
      JSON.stringify({
        endpoint: {
          wsUrl: "ws://127.0.0.1:9000/api/ws",
          runtimeProtocol: 1,
          capabilities: ["session-authority-v1"],
        },
      }),
      0,
    );
    expect(camelEndpoint.kind).toBe("ready");
    if (camelEndpoint.kind === "ready") {
      expect(camelEndpoint.endpoint.runtimeProtocol).toBe(1);
    }

    expect(parseEnsureOrAttachOutput(JSON.stringify({ state: "ready" }), 5)).toEqual({
      kind: "failure",
      code: "gateway_starting_timeout",
      reasonCode: undefined,
    });

    const sessions = [
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-1",
        title: "One",
        preview: "",
        updatedAt: "2026-11-23T06:00:00.000Z",
        pinned: false,
        unreadCount: 0,
        needsInput: false,
      },
      {
        connectionId: "local",
        profileId: "work",
        sessionId: "s-2",
        title: "Two",
        preview: "",
        updatedAt: "2026-11-23T06:00:00.000Z",
        pinned: false,
        unreadCount: 0,
        needsInput: false,
      },
    ];
    expect(filterSessionsForScope(sessions, { connectionId: "local" }).map((s) => s.sessionId)).toEqual([
      "s-1",
    ]);
    expect(
      filterProfilesForConnection(
        [
          { connectionId: "local", profileId: "default", displayName: "Default", handle: "default", isDefault: true },
          { connectionId: "vps", profileId: "ops", displayName: "Ops", handle: "ops", isDefault: true },
        ],
        "local",
      ).map((p) => p.profileId),
    ).toEqual(["default"]);

    const snapshot: SessionTranscriptSnapshot = {
      connectionId: "local",
      profileId: "default",
      sessionId: "s-1",
      messages: [
        {
          messageId: "m-1",
          sessionId: "s-1",
          role: "assistant",
          text: "one",
          createdAt: "2026-11-23T06:00:00Z",
          streaming: true,
          status: "streaming",
          turnId: "t-1",
        },
        {
          messageId: "m-2",
          sessionId: "s-1",
          role: "assistant",
          text: "two",
          createdAt: "2026-11-23T06:00:00Z",
          streaming: true,
          status: "streaming",
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

    const snapshotEvent = (payload: SessionTranscriptSnapshot): BridgeEvent => ({
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "snapshot",
      seq: 1,
      revision: 1,
      payload,
    });
    expect(reduceTranscriptEvent(snapshot, snapshotEvent(snapshot))).toBe(snapshot);

    const upsertSecond = reduceTranscriptEvent(snapshot, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 2,
      revision: 2,
      payload: {
        type: "message_upsert",
        sessionId: "s-1",
        message: {
          messageId: "m-2",
          sessionId: "s-1",
          role: "assistant",
          text: "two updated",
          createdAt: "2026-11-23T06:00:00Z",
        },
      },
    });
    expect(upsertSecond?.messages.map((m) => m.text)).toEqual(["one", "two updated"]);

    const toolThenReplace = reduceTranscriptEvent(snapshot, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 3,
      revision: 3,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        messageId: "m-1",
        toolRow: { toolCallId: "tc-1", name: "read", status: "running" },
      },
    });
    const toolUpdated = reduceTranscriptEvent(toolThenReplace!, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 4,
      revision: 4,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        messageId: "m-1",
        toolRow: { toolCallId: "tc-1", name: "read", status: "completed" },
      },
    });
    expect(toolUpdated?.messages[0].toolRows).toEqual([
      { toolCallId: "tc-1", name: "read", status: "completed" },
    ]);
    const toolSecond = reduceTranscriptEvent(toolUpdated!, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 5,
      revision: 5,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        messageId: "m-1",
        toolRow: { toolCallId: "tc-2", name: "write", status: "running" },
      },
    });
    const toolSecondUpdated = reduceTranscriptEvent(toolSecond!, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 6,
      revision: 6,
      payload: {
        type: "tool_row",
        sessionId: "s-1",
        messageId: "m-1",
        toolRow: { toolCallId: "tc-2", name: "write", status: "completed" },
      },
    });
    expect(toolSecondUpdated?.messages[0].toolRows?.map((row) => row.status)).toEqual([
      "completed",
      "completed",
    ]);

    const tokenWithoutTurn = reduceTranscriptEvent(snapshot, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 8,
      revision: 8,
      payload: {
        type: "token_delta",
        sessionId: "s-1",
        messageId: "m-no-turn",
        delta: "orphan delta",
      },
    });
    expect(tokenWithoutTurn?.messages.at(-1)).toMatchObject({
      messageId: "m-no-turn",
      text: "orphan delta",
    });
    expect(tokenWithoutTurn?.messages.at(-1)?.turnId).toBeUndefined();

    const tokenExistingWithTurn = reduceTranscriptEvent(snapshot, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 11,
      revision: 11,
      payload: {
        type: "token_delta",
        sessionId: "s-1",
        messageId: "m-1",
        turnId: "t-2",
        delta: "!",
      },
    });
    expect(tokenExistingWithTurn?.messages[0].turnId).toBe("t-2");

    const turnWithoutStatus = reduceTranscriptEvent(snapshot, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 9,
      revision: 9,
      payload: {
        type: "turn_state",
        sessionId: "s-1",
        messageId: "m-2",
        activeTurnId: "t-1",
      },
    });
    expect(turnWithoutStatus?.messages[1].status).toBe("streaming");

    const turnWithoutStatusEnded = reduceTranscriptEvent(snapshot, {
      topic: "session.transcript",
      scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
      kind: "patch",
      seq: 10,
      revision: 10,
      payload: {
        type: "turn_state",
        sessionId: "s-1",
        messageId: "m-2",
        activeTurnId: null,
      },
    });
    expect(turnWithoutStatusEnded?.messages[1].status).toBe("complete");

    const sync = createTranscriptSyncController();
    sync.applySnapshot(snapshot);
    expect(sync.getSnapshot()?.snapshotSeq).toBe(0);
    expect(
      sync.acceptEvent({
        topic: "session.transcript",
        scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
        kind: "patch",
        seq: 1,
        revision: 1,
        payload: { type: "token_delta", sessionId: "s-1", messageId: "m-1", delta: "!" },
      }),
    ).toEqual({ status: "applied", snapshot: expect.objectContaining({ snapshotSeq: 0 }) });
    expect(
      sync.acceptEvent({
        topic: "session.transcript",
        scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
        kind: "unknown" as never,
        seq: 1,
        revision: 1,
        payload: {},
      }),
    ).toEqual({ status: "ignored" });
  });
});
