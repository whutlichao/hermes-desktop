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
      sshTargetDisplay: "ubuntu@lab.example.com:2222",
      remoteHermesPath: "/home/ubuntu/.local/bin/hermes",
      knownHostsPath: "/Users/alice/.ssh/known_hosts",
      hostKeyChallenge: {
        hostDisplay: "lab.example.com:2222",
        keyType: "ED25519",
        fingerprint: "SHA256:abcdef123456",
      },
    });
    expect(originCheck.originDisplay).toBe("https://vps.example.com/v1");
    expect(originCheck.hostDisplay).toBe("[REDACTED_URL]");
    expect(originCheck.sshTargetDisplay).toBe("ubuntu@lab.example.com:2222");
    expect(originCheck.remoteHermesPath).toBe("[REDACTED]");
    expect(originCheck.knownHostsPath).toBe("[REDACTED]");
    expect(originCheck.hostKeyChallenge).toEqual({
      hostDisplay: "lab.example.com:2222",
      keyType: "ED25519",
      fingerprint: "SHA256:abcdef123456",
    });

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

  it("aggregates fleet Gateway state by priority (ready/degraded/auth_required>blocked>reconnecting>connecting>idle/suspended), exposes Profile exceptions, and computes full-jitter backoff + safe background notifications", async () => {
    const domain = (await import("@hermes/domain")) as Record<string, unknown>;
    const aggregateConnectionHealth = domain.aggregateConnectionHealth as (input: unknown) => Record<string, unknown>;
    const computeFullJitterBackoffMs = domain.computeFullJitterBackoffMs as (
      attempt: number,
      randomValue: number,
    ) => number;
    const computeResumeStaggerMs = domain.computeResumeStaggerMs as (randomValue: number) => number;
    const buildSafeBackgroundNotification = domain.buildSafeBackgroundNotification as (input: unknown) => Record<
      string,
      unknown
    > | null;

    expect(typeof aggregateConnectionHealth).toBe("function");
    expect(typeof computeFullJitterBackoffMs).toBe("function");
    expect(typeof computeResumeStaggerMs).toBe("function");
    expect(typeof buildSafeBackgroundNotification).toBe("function");

    // 1. Backoff: 1s base, exponential double, 30s cap, full jitter
    expect(computeFullJitterBackoffMs(0, 1)).toBe(1000);
    expect(computeFullJitterBackoffMs(0, 0.5)).toBe(500);
    expect(computeFullJitterBackoffMs(1, 1)).toBe(2000);
    expect(computeFullJitterBackoffMs(4, 1)).toBe(16000);
    expect(computeFullJitterBackoffMs(5, 1)).toBe(30000);
    expect(computeFullJitterBackoffMs(9, 0.5)).toBe(15000);
    expect(computeResumeStaggerMs(0)).toBe(0);
    expect(computeResumeStaggerMs(1)).toBe(250);
    expect(computeResumeStaggerMs(0.5)).toBe(125);

    // 2. Gateway health aggregation rules
    // - All active links ready and not degraded -> ready, degraded=false
    const allReady = aggregateConnectionHealth({
      base: {
        connectionId: "local",
        label: "This device",
        kind: "local",
        originDisplay: "127.0.0.1",
      },
      links: [
        { profileId: "default", desired: "enabled", actual: "ready", degraded: false, latencyMs: 12, nextRetryAt: null },
        { profileId: "work", desired: "enabled", actual: "ready", degraded: false, latencyMs: 18, nextRetryAt: null },
      ],
    });
    expect(allReady.actual).toBe("ready");
    expect(allReady.degraded).toBe(false);
    expect(allReady.aggregateState).toBe("ready");
    expect(allReady.profileExceptionCount).toBe(0);

    // - At least one ready, another link blocked/reconnecting/degraded -> ready + degraded=true, profile exception exposed
    const partialDegraded = aggregateConnectionHealth({
      base: {
        connectionId: "local",
        label: "This device",
        kind: "local",
        originDisplay: "127.0.0.1",
      },
      links: [
        { profileId: "default", desired: "enabled", actual: "ready", degraded: false, latencyMs: 10, nextRetryAt: null },
        {
          profileId: "ops",
          desired: "enabled",
          actual: "blocked",
          degraded: true,
          latencyMs: null,
          nextRetryAt: null,
          errorCode: "not_found",
          unavailableCode: "profile_unavailable",
        },
      ],
    });
    expect(partialDegraded.actual).toBe("ready");
    expect(partialDegraded.degraded).toBe(true);
    expect(partialDegraded.aggregateState).toBe("degraded");
    expect(partialDegraded.profileExceptionCount).toBe(1);

    // - No ready links: auth_required > blocked > reconnecting > connecting > idle
    const severityOrder = aggregateConnectionHealth({
      base: {
        connectionId: "vps",
        label: "Prod VPS",
        kind: "remote",
        originDisplay: "https://vps.example.com",
      },
      links: [
        { profileId: "default", desired: "enabled", actual: "reconnecting", degraded: true, latencyMs: null, nextRetryAt: 5000 },
        { profileId: "ops", desired: "enabled", actual: "blocked", degraded: true, latencyMs: null, nextRetryAt: null, errorCode: "protocol_unsupported" },
        { profileId: "sec", desired: "enabled", actual: "auth_required", degraded: true, latencyMs: null, nextRetryAt: null, errorCode: "auth_required" },
      ],
    });
    expect(severityOrder.actual).toBe("auth_required");
    expect(severityOrder.aggregateState).toBe("auth_required");

    // - Suspended links -> actual: idle, desired: suspended, aggregateState: suspended
    const suspendedAgg = aggregateConnectionHealth({
      base: {
        connectionId: "local",
        label: "This device",
        kind: "local",
        originDisplay: "127.0.0.1",
      },
      links: [
        { profileId: "default", desired: "suspended", actual: "idle", degraded: false, latencyMs: null, nextRetryAt: null },
      ],
    });
    expect(suspendedAgg.actual).toBe("idle");
    expect(suspendedAgg.desired).toBe("suspended");
    expect(suspendedAgg.aggregateState).toBe("suspended");

    // 3. Minimal background notifications: ONLY when app is not in foreground, zero sensitive payload
    expect(
      buildSafeBackgroundNotification({
        kind: "approval_pending",
        isAppForeground: true,
        scope: { connectionId: "local", profileId: "default", sessionId: "s-1" },
        rawSecretOrCommand: "sudo rm -rf /Users/alice/secret token=abc",
      }),
    ).toBeNull();

    const bgApproval = buildSafeBackgroundNotification({
      kind: "approval_pending",
      isAppForeground: false,
      scope: { connectionId: "local", profileId: "work", sessionId: "s-1" },
      rawSecretOrCommand: "sudo rm -rf /Users/alice/secret token=abc",
    }) as { title: string; body: string; focusCommand: { type: string; scope: unknown } };
    expect(bgApproval).not.toBeNull();
    expect(bgApproval.body).not.toMatch(/sudo|rm|\/Users|secret|token/i);
    expect(bgApproval.focusCommand).toEqual({
      type: "focus_scope",
      scope: { connectionId: "local", profileId: "work", sessionId: "s-1" },
    });

    const bgTurn = buildSafeBackgroundNotification({
      kind: "turn_completed",
      isAppForeground: false,
      scope: { connectionId: "vps", profileId: "ops", sessionId: "s-2" },
      rawSecretOrCommand: "assistant reply with secret token=xyz",
    }) as { title: string; body: string; focusCommand: { type: string; scope: unknown } };
    expect(bgTurn).not.toBeNull();
    expect(bgTurn.body).not.toMatch(/assistant|secret|token|xyz/i);
    expect(bgTurn.focusCommand).toEqual({
      type: "focus_scope",
      scope: { connectionId: "vps", profileId: "ops", sessionId: "s-2" },
    });
  });

  it("preserves command and cwd filesystem paths in ApprovalView while redacting secrets and URLs", () => {
    const redacted = redactSensitiveData({
      approvalKey: "apr-1",
      command: "cat /Users/alice/repo/config.json token=super-secret",
      cwd: "/Users/alice/repo",
      stderrLine: "stderr: /Users/alice/repo leaked",
      nestedToken: "Bearer my-secret-jwt",
    });

    expect(redacted.command).toBe("cat /Users/alice/repo/config.json token=[REDACTED]");
    expect(redacted.cwd).toBe("/Users/alice/repo");
    expect(redacted.stderrLine).toBe("[REDACTED_STDERR]");
    expect(redacted.nestedToken).toBe("Bearer [REDACTED]");
  });
});
