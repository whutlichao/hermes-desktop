import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthStateSnapshot } from "@hermes/contracts";
import { startFakeRemoteGatewayServer } from "../../../../tests/helpers/fakeGatewayServer";
import { RegistryStore } from "./registryStore";
import { RemoteAuthManager, testRemoteConnection } from "./remoteGateway";

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-remote-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Remote HTTP(S) two-leg probe & OAuth/PKCE manager (S1)", () => {
  it("runs strictly read-only two-leg HTTP + WS probe (passes when both succeed, zero registry writes)", async () => {
    const home = makeTempHome();
    const store = new RegistryStore({ rootDir: home });
    const gw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["remote-secret-token"]),
      useTicketEndpoint: true,
    });

    try {
      const beforeRevision = store.snapshot().revision;
      const result = await testRemoteConnection({
        input: {
          kind: "remote",
          url: gw.baseUrl,
          authMode: "token",
          token: "remote-secret-token",
        },
        registryStore: store,
      });

      expect(result.ok).toBe(true);
      expect(result.httpLeg.ok).toBe(true);
      expect(result.httpLeg.status).toBe("ok");
      expect(result.httpLeg.statusCode).toBe(200);
      expect(result.wsLeg.ok).toBe(true);
      expect(result.wsLeg.status).toBe("ok");
      expect(result.actions).toContain("save_connection");
      expect(JSON.stringify(result)).not.toContain("remote-secret-token");

      // Probe must close its temporary WS socket and must NEVER write registry or tokens files
      expect(store.snapshot().revision).toBe(beforeRevision);
      expect(fs.existsSync(path.join(home, "gateway-connections.json"))).toBe(false);
      expect(fs.existsSync(path.join(home, "gateway-connection-tokens.json"))).toBe(false);
    } finally {
      store.close();
      await gw.close();
    }
  });

  it("reports HTTP ok + WS failure distinctly and flags 401/403 as auth_required without leaking tokens or raw URLs", async () => {
    const home = makeTempHome();
    const store = new RegistryStore({ rootDir: home });
    const gw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["good-token"]),
      rejectWsStatus: 502,
    });

    try {
      const wsFail = await testRemoteConnection({
        input: {
          kind: "remote",
          url: gw.baseUrl,
          authMode: "token",
          token: "good-token",
        },
        registryStore: store,
      });

      expect(wsFail.ok).toBe(false);
      expect(wsFail.httpLeg.ok).toBe(true);
      expect(wsFail.wsLeg.ok).toBe(false);
      expect(wsFail.wsLeg.status).toBe("failed");
      expect(wsFail.failedStage).toBe("ws");

      gw.setRejectWsStatus(null);
      const authFail = await testRemoteConnection({
        input: {
          kind: "remote",
          url: gw.baseUrl,
          authMode: "token",
          token: "wrong-token-123",
        },
        registryStore: store,
      });

      expect(authFail.ok).toBe(false);
      expect(authFail.httpLeg.ok).toBe(true);
      expect(authFail.wsLeg.ok).toBe(false);
      expect(authFail.wsLeg.statusCode).toBe(401);
      expect(authFail.errorCode).toBe("auth_required");
      expect(authFail.failedStage).toBe("auth");
      expect(JSON.stringify(authFail)).not.toContain("wrong-token-123");
      expect(fs.existsSync(path.join(home, "gateway-connections.json"))).toBe(false);
    } finally {
      store.close();
      await gw.close();
    }
  });

  it("supports HTTPS/WSS TLS probe with CA verification", async () => {
    const home = makeTempHome();
    const store = new RegistryStore({ rootDir: home });
    const gw = await startFakeRemoteGatewayServer({
      protocol: "https",
      validTokens: new Set(["tls-token"]),
    });

    try {
      const result = await testRemoteConnection({
        input: {
          kind: "remote",
          url: gw.baseUrl,
          authMode: "token",
          token: "tls-token",
        },
        registryStore: store,
        tls: { ca: gw.caPem, rejectUnauthorized: true },
      });

      expect(result.ok).toBe(true);
      expect(result.originDisplay).toBe(gw.baseUrl);
      expect(result.httpLeg.ok).toBe(true);
      expect(result.wsLeg.ok).toBe(true);
    } finally {
      store.close();
      await gw.close();
    }
  });

  it("runs PKCE OAuth auth.start / callback / auth.cancel safely without exposing tokens to Renderer or writing on cancel", async () => {
    const home = makeTempHome();
    const store = new RegistryStore({ rootDir: home });
    const gw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(),
    });

    const openedUrls: string[] = [];
    const authStates: AuthStateSnapshot[] = [];

    const authManager = new RemoteAuthManager({
      registryStore: store,
      openExternal: async (url) => {
        openedUrls.push(url);
      },
    });
    const unsub = authManager.subscribe((ev) => {
      authStates.push(ev.payload);
    });

    try {
      // 1) Start OAuth and cancel before callback -> 0 disk writes
      const cancelledStart = await authManager.startAuth({
        kind: "remote",
        url: gw.baseUrl,
      });
      expect(cancelledStart.status).toBe("waiting");
      expect(openedUrls).toHaveLength(1);
      expect(openedUrls[0]).toContain(`${gw.baseUrl}/oauth/authorize`);
      expect(openedUrls[0]).toContain("code_challenge_method=S256");

      const cancelRes = authManager.cancelAuth(cancelledStart.authSessionId);
      expect(cancelRes.cancelled).toBe(true);
      expect(cancelRes.snapshot.status).toBe("cancelled");
      expect(fs.existsSync(path.join(home, "gateway-connections.json"))).toBe(false);
      expect(fs.existsSync(path.join(home, "gateway-connection-tokens.json"))).toBe(false);

      // 2) Start OAuth and simulate user completing browser authorize redirect -> callback exchanges PKCE code
      const startRes = await authManager.startAuth({
        kind: "remote",
        url: gw.baseUrl,
      });
      expect(startRes.status).toBe("waiting");
      const authorizeUrl = openedUrls[1];

      const redirectRes = await fetch(authorizeUrl, { redirect: "manual" });
      expect(redirectRes.status).toBe(302);
      const callbackLocation = redirectRes.headers.get("location");
      expect(callbackLocation).toBeTruthy();

      const cbResponse = await fetch(callbackLocation!);
      expect(cbResponse.status).toBe(200);

      // Wait briefly for auth.state "granted"
      await new Promise((r) => setTimeout(r, 30));

      const grantedEvent = authStates.find(
        (s) => s.authSessionId === startRes.authSessionId && s.status === "granted",
      );
      expect(grantedEvent).toBeTruthy();

      // Bridge events must NEVER contain OAuth access/refresh tokens or PKCE verifier!
      const serializedEvents = JSON.stringify(authStates);
      for (const issuedTok of gw.validTokens) {
        expect(serializedEvents).not.toContain(issuedTok);
      }
      for (const refreshTok of gw.issuedRefreshTokens) {
        expect(serializedEvents).not.toContain(refreshTok);
      }

      // Pending OAuth token can be used for read-only testRemoteConnection before Save (still 0 disk writes!)
      const testRes = await testRemoteConnection({
        input: {
          kind: "remote",
          url: gw.baseUrl,
          authMode: "oauth",
          authSessionId: startRes.authSessionId,
        },
        registryStore: store,
        authManager,
      });
      expect(testRes.ok).toBe(true);
      expect(fs.existsSync(path.join(home, "gateway-connections.json"))).toBe(false);
      expect(fs.existsSync(path.join(home, "gateway-connection-tokens.json"))).toBe(false);
    } finally {
      unsub();
      authManager.dispose();
      store.close();
      await gw.close();
    }
  });
});
