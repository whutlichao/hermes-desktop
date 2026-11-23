import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import {
  assertSafeSandboxRoot,
  buildAppMenuSpec,
  buildCspHeader,
  createHardenedWebPreferences,
  isAllowedExternalUrl,
  resolveSandboxPaths,
} from "./security";

describe("Electron Main sandbox & hardening", () => {
  it("defaults to .dev/user-data and .dev/hermes-home and refuses ~/.hermes or ~", () => {
    const sandbox = createTestSandbox("hermes-sec-");
    let passed = false;
    try {
      const devPaths = resolveSandboxPaths({
        repoRoot: sandbox.rootDir,
        env: {},
      });
      expect(devPaths.userDataDir).toBe(path.join(sandbox.rootDir, ".dev", "user-data"));
      expect(devPaths.hermesHomeDir).toBe(path.join(sandbox.rootDir, ".dev", "hermes-home"));
      expect(devPaths.hermesHomeDir).not.toBe(path.join(os.homedir(), ".hermes"));

      expect(() =>
        assertSafeSandboxRoot(path.join(os.homedir(), ".hermes"), { allowRealHome: false }),
      ).toThrow();
      expect(() => assertSafeSandboxRoot(os.homedir(), { allowRealHome: false })).toThrow();
      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("enforces hardened BrowserWindow webPreferences and strict CSP", () => {
    const prefs = createHardenedWebPreferences("/abs/preload/index.js");
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.webviewTag).toBe(false);

    const devCsp = buildCspHeader(true);
    expect(devCsp).toContain("ws://localhost:4173");
    expect(devCsp).toContain("default-src 'self'");

    const prodCsp = buildCspHeader(false);
    expect(prodCsp).toContain("default-src 'self'");
    expect(prodCsp).not.toContain("ws://localhost:4173");
    expect(prodCsp).not.toContain("'unsafe-eval'");
  });

  it("allows only http(s) external links and rejects file/javascript/hermes schemes", () => {
    expect(isAllowedExternalUrl("https://hermes-agent.nousresearch.com/docs")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:8000")).toBe(true);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("hermes://open")).toBe(false);
  });

  it("defines native menu accelerators for Cmd+K, Cmd+,, Cmd+B, Cmd+N, Cmd+W, Cmd+Q, Cmd+?", () => {
    const commands: string[] = [];
    const spec = buildAppMenuSpec((cmd) => commands.push(cmd.type));
    const accelerators = spec
      .flatMap((top) => top.submenu ?? [])
      .map((item) => item.accelerator)
      .filter(Boolean);

    expect(accelerators).toContain("CmdOrCtrl+K");
    expect(accelerators).toContain("CmdOrCtrl+,");
    expect(accelerators).toContain("CmdOrCtrl+B");
    expect(accelerators).toContain("CmdOrCtrl+N");
    expect(accelerators).toContain("CmdOrCtrl+W");
    expect(accelerators).toContain("CmdOrCtrl+Q");
    expect(accelerators).toContain("CmdOrCtrl+Shift+/");
  });
});
