import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  HOST_BRIDGE_VERSION,
  HOST_COMMANDS,
  HOST_TOPICS,
  type BridgeEvent,
  type ErrorCode,
} from "@hermes/contracts";
import {
  createBridgeDispatcher,
  createSequenceTracker,
  mapErrorCode,
  redactSensitiveData,
  validateHostRequest,
  validateHostTopic,
} from "@hermes/domain";

describe("HostBridge v1 contracts & invariants", () => {
  it("pins HOST_BRIDGE_VERSION to 1 and exposes the exact 17 ErrorCodes", () => {
    expect(HOST_BRIDGE_VERSION).toBe(1);
    const expectedCodes: ErrorCode[] = [
      "invalid_request",
      "unauthorized",
      "scope_mismatch",
      "not_found",
      "conflict",
      "auth_required",
      "auth_failed",
      "unreachable",
      "timeout",
      "protocol_unsupported",
      "unknown_turn",
      "approval_stale",
      "approval_scope_mismatch",
      "capability_unavailable",
      "permission_denied",
      "cancelled",
      "internal",
    ];
    expect(ERROR_CODES).toEqual(expectedCodes);
    expect(ERROR_CODES).toHaveLength(17);
  });

  it("fails closed on bridge version mismatch", async () => {
    const dispatcher = createBridgeDispatcher({
      "bridge.hello": async () => ({
        bridgeVersion: HOST_BRIDGE_VERSION,
        appName: "Hermes Desktop",
        appVersion: "0.1.0",
        gitSha: "3210e50a",
        gitDirty: false,
        buildMode: "dev",
        distribution: "local-unsigned",
        electronVersion: "45.4.1",
        chromiumVersion: "134.0.0.0",
        nodeVersion: "22.13.0",
        arch: "arm64",
        source: "git",
        mode: "mock",
        platform: "darwin",
        capabilitiesReady: false,
      }),
    });

    const badVersion = await dispatcher.dispatch({
      version: 2 as unknown as 1,
      requestId: "req-1",
      command: "bridge.hello",
      payload: {},
    });

    expect(badVersion).toEqual({
      ok: false,
      requestId: "req-1",
      error: {
        code: "protocol_unsupported",
        message: "HostBridge 协议版本不兼容，请更新客户端后重试。",
        requestId: "req-1",
        retryable: false,
      },
    });
  });

  it("rejects unknown commands and unknown topics", async () => {
    expect(validateHostRequest({ version: 1, requestId: "r1", command: "evil.exec" as never, payload: {} })).toEqual({
      valid: false,
      code: "invalid_request",
      retryable: false,
    });
    expect(validateHostTopic("unknown.topic" as never)).toEqual({
      valid: false,
      code: "invalid_request",
      retryable: false,
    });
    expect(HOST_COMMANDS).toContain("bridge.hello");
    expect(HOST_TOPICS).toContain("fleet");

    const dispatcher = createBridgeDispatcher({});
    const res = await dispatcher.dispatch({
      version: 1,
      requestId: "r2",
      command: "shell.arbitrary" as never,
      payload: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("invalid_request");
    }
  });

  it("enforces scope match on scoped requests", async () => {
    const dispatcher = createBridgeDispatcher(
      {
        "sessions.list": async () => ({ sessions: [] }),
      },
      {
        getActiveScope: () => ({ connectionId: "conn-1", profileId: "default" }),
      },
    );

    const mismatch = await dispatcher.dispatch({
      version: 1,
      requestId: "req-scope-1",
      command: "sessions.list",
      scope: { connectionId: "conn-other", profileId: "default" },
      payload: {},
    });

    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe("scope_mismatch");
      expect(mismatch.error.retryable).toBe(false);
    }

    const valid = await dispatcher.dispatch({
      version: 1,
      requestId: "req-scope-2",
      command: "sessions.list",
      scope: { connectionId: "conn-1", profileId: "default" },
      payload: {},
    });
    expect(valid.ok).toBe(true);
  });

  it("maps internal errors safely without leaking raw stacks, URLs, or secrets", async () => {
    const dispatcher = createBridgeDispatcher({
      "connections.list": async () => {
        const err = new Error(
          "connect failed ws://user:supersecret@10.0.0.5:8080/ws?token=abc123 at /Users/alice/.hermes/token.json",
        );
        err.stack = "Error: boom\n    at Object.<anonymous> (/Users/alice/secret/app.ts:10:5)";
        throw err;
      },
    });

    const res = await dispatcher.dispatch({
      version: 1,
      requestId: "req-err-1",
      command: "connections.list",
      payload: {},
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal");
      expect(res.error.message).not.toContain("supersecret");
      expect(res.error.message).not.toContain("abc123");
      expect(res.error.message).not.toContain("/Users/alice");
      expect(res.error.message).not.toContain("ws://");
      expect(res.error.message).not.toContain("at Object");
    }
  });

  it("redacts tokens, tickets, cookies, SSH keys, URLs with credentials, and local paths", () => {
    const input = {
      token: "hermes_secret_tok_123",
      ticket: "tkt_abc999",
      cookie: "session=xyz",
      passphrase: "my-ssh-passphrase",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      wsUrl: "wss://admin:pass123@relay.example.com:8443/gateway?ticket=tkt_abc",
      httpUrl: "https://user:pw@api.example.com/v1/test?token=123#frag",
      localPath: "/Users/alice/.hermes/gateway-connections.json",
      nested: {
        authorization: "Bearer sk-live-secret-999",
        safeLabel: "This device",
      },
    };

    const redacted = redactSensitiveData(input);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("hermes_secret_tok_123");
    expect(serialized).not.toContain("tkt_abc999");
    expect(serialized).not.toContain("session=xyz");
    expect(serialized).not.toContain("my-ssh-passphrase");
    expect(serialized).not.toContain("OPENSSH PRIVATE KEY");
    expect(serialized).not.toContain("pass123");
    expect(serialized).not.toContain("tkt_abc");
    expect(serialized).not.toContain("pw@");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("sk-live-secret-999");
    expect(redacted.nested.safeLabel).toBe("This device");

    const originCheck = redactSensitiveData({
      originDisplay: "https://user:pw@vps.example.com/v1?token=secret#frag",
      hostDisplay: "wss://secret@raw-ws.example.com",
    });
    expect(originCheck.originDisplay).toBe("https://vps.example.com/v1");
    expect(originCheck.hostDisplay).toBe("[REDACTED_URL]");

    const oauthCheck = redactSensitiveData({
      authSessionId: "auth-1",
      status: "granted",
      accessToken: "oauth-access-secret",
      refreshToken: "oauth-refresh-secret",
      codeVerifier: "pkce-verifier-secret",
      authCode: "auth-code-secret",
      clientSecret: "client-secret-xyz",
      oauthTokenSet: { accessToken: "nested-oauth", tokenType: "Bearer" },
      idToken: "jwt-id-secret",
    });
    const oauthSerialized = JSON.stringify(oauthCheck);
    expect(oauthSerialized).not.toContain("oauth-access-secret");
    expect(oauthSerialized).not.toContain("oauth-refresh-secret");
    expect(oauthSerialized).not.toContain("pkce-verifier-secret");
    expect(oauthSerialized).not.toContain("auth-code-secret");
    expect(oauthSerialized).not.toContain("client-secret-xyz");
    expect(oauthSerialized).not.toContain("nested-oauth");
    expect(oauthSerialized).not.toContain("jwt-id-secret");
    expect(oauthCheck.status).toBe("granted");
    expect(oauthCheck.authSessionId).toBe("auth-1");
  });

  it("enforces snapshot (seq:0) -> monotonic seq patch -> gap resync_required", () => {
    const tracker = createSequenceTracker();

    const snap: BridgeEvent<{ items: string[] }> = {
      topic: "fleet",
      scope: null,
      kind: "snapshot",
      seq: 0,
      revision: 1,
      payload: { items: [] },
    };
    expect(tracker.accept(snap)).toEqual({ status: "applied", kind: "snapshot", seq: 0, revision: 1 });

    // Duplicate or stale seq <= current is ignored
    expect(
      tracker.accept({
        topic: "fleet",
        scope: null,
        kind: "patch",
        seq: 0,
        revision: 1,
        payload: { items: ["dup"] },
      }),
    ).toEqual({ status: "ignored_stale", seq: 0 });

    // Monotonic seq=1 applies cleanly
    expect(
      tracker.accept({
        topic: "fleet",
        scope: null,
        kind: "patch",
        seq: 1,
        revision: 2,
        payload: { items: ["conn-1"] },
      }),
    ).toEqual({ status: "applied", kind: "patch", seq: 1, revision: 2 });

    // Gap seq=3 (skipped seq=2) triggers resync_required
    expect(
      tracker.accept({
        topic: "fleet",
        scope: null,
        kind: "patch",
        seq: 3,
        revision: 3,
        payload: { items: ["conn-2"] },
      }),
    ).toEqual({ status: "resync_required", expectedSeq: 2, receivedSeq: 3 });

    // Resync via fresh snapshot (seq=0) restores sync
    expect(
      tracker.accept({
        topic: "fleet",
        scope: null,
        kind: "snapshot",
        seq: 0,
        revision: 4,
        payload: { items: ["conn-1", "conn-2"] },
      }),
    ).toEqual({ status: "applied", kind: "snapshot", seq: 0, revision: 4 });

    // Explicit resync_required event while in sync resets tracker until next snapshot
    expect(
      tracker.accept({
        topic: "fleet",
        scope: null,
        kind: "resync_required",
        seq: 1,
        revision: 5,
        payload: { reason: "server_gap" },
      }),
    ).toEqual({ status: "resync_required", expectedSeq: 1, receivedSeq: 1 });
  });

  it("maps every single one of the 17 ErrorCodes to safe zh-CN messages", () => {
    for (const code of ERROR_CODES) {
      const mapped = mapErrorCode(code, `req-${code}`);
      expect(mapped.code).toBe(code);
      expect(mapped.requestId).toBe(`req-${code}`);
      expect(mapped.message.length).toBeGreaterThan(0);
      expect(typeof mapped.retryable).toBe("boolean");
    }
  });
});
