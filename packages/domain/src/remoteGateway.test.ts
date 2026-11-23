import { describe, expect, it } from "vitest";
import {
  deriveRemoteWsUrl,
  formatRemoteTestSummary,
  validateRemoteEndpointUrl,
} from "./remoteGateway";

describe("Remote HTTP(S) endpoint validation & redaction (S0)", () => {
  it("accepts https:// URLs and loopback http:// URLs, stripping userinfo/query/hash for display", () => {
    const httpsRes = validateRemoteEndpointUrl("HTTPS://Gateway.Example.COM:8443/base/");
    expect(httpsRes).toEqual({
      valid: true,
      normalizedUrl: "https://gateway.example.com:8443/base",
      originDisplay: "https://gateway.example.com:8443/base",
      wsUrl: "wss://gateway.example.com:8443/base/api/ws",
      isLoopback: false,
    });

    const loopbackIp = validateRemoteEndpointUrl("http://127.0.0.1:9443/");
    expect(loopbackIp).toEqual({
      valid: true,
      normalizedUrl: "http://127.0.0.1:9443",
      originDisplay: "http://127.0.0.1:9443",
      wsUrl: "ws://127.0.0.1:9443/api/ws",
      isLoopback: true,
    });

    const loopbackHost = validateRemoteEndpointUrl("http://localhost:8080/hermes");
    expect(loopbackHost.valid).toBe(true);
    if (loopbackHost.valid) {
      expect(loopbackHost.wsUrl).toBe("ws://localhost:8080/hermes/api/ws");
      expect(loopbackHost.isLoopback).toBe(true);
    }
  });

  it("rejects non-loopback http://, non-http schemes, and URLs containing embedded credentials or query tokens", () => {
    expect(validateRemoteEndpointUrl("http://vps.example.com")).toEqual({
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.httpsRequired",
    });

    expect(validateRemoteEndpointUrl("ws://vps.example.com")).toEqual({
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.invalidUrl",
    });

    expect(validateRemoteEndpointUrl("https://user:secret@vps.example.com")).toEqual({
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.credentialsInUrl",
    });

    expect(validateRemoteEndpointUrl("https://vps.example.com/?token=leak")).toEqual({
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.credentialsInUrl",
    });
  });

  it("derives wss/ws URLs safely and formats two-leg test summaries without leaking secrets", () => {
    expect(deriveRemoteWsUrl("https://vps.example.com", "/custom/ws")).toBe(
      "wss://vps.example.com/custom/ws",
    );
    expect(deriveRemoteWsUrl("http://127.0.0.1:8642/prefix", "/api/ws")).toBe(
      "ws://127.0.0.1:8642/prefix/api/ws",
    );

    const summary = formatRemoteTestSummary({
      ok: false,
      kind: "remote",
      originDisplay: "https://vps.example.com",
      authMode: "token",
      httpLeg: { ok: true, status: "ok", statusCode: 200, latencyMs: 12 },
      wsLeg: {
        ok: false,
        status: "failed",
        statusCode: 401,
        errorCode: "auth_required",
        messageKey: "remote.test.authRequired",
      },
      failedStage: "auth",
      errorCode: "auth_required",
      messageKey: "remote.test.authRequired",
      actions: ["edit_endpoint", "retry_test"],
      checkedAt: "2026-11-23T00:00:00.000Z",
    });

    expect(summary.httpPassed).toBe(true);
    expect(summary.wsPassed).toBe(false);
    expect(summary.failedStage).toBe("auth");
  });
});
