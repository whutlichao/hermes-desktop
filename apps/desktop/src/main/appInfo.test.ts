import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { createMainAppInfo, resolveGitInfo } from "./appInfo";

describe("Main AppInfo generator & git SHA policy", () => {
  it("resolves clean and dirty git SHA from a real git repository", () => {
    const sandbox = createTestSandbox("hermes-git-");
    let passed = false;
    try {
      execFileSync("git", ["init"], { cwd: sandbox.rootDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sandbox.rootDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: sandbox.rootDir });
      fs.writeFileSync(path.join(sandbox.rootDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: sandbox.rootDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: sandbox.rootDir });

      const clean = resolveGitInfo({ repoRoot: sandbox.rootDir, buildMode: "dev" });
      expect(clean.source).toBe("git");
      expect(clean.gitDirty).toBe(false);
      expect(clean.gitSha).toMatch(/^[0-9a-f]{7,12}$/);

      // Make repo dirty
      fs.writeFileSync(path.join(sandbox.rootDir, "README.md"), "dirty\n");
      const dirty = resolveGitInfo({ repoRoot: sandbox.rootDir, buildMode: "dev" });
      expect(dirty.source).toBe("git");
      expect(dirty.gitDirty).toBe(true);
      expect(dirty.gitSha).toBe(clean.gitSha);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("fails packaged build when git SHA cannot be resolved unless ALLOW_UNKNOWN_SHA=1, while dev allows unknown", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-nogit-"));
    try {
      expect(() =>
        resolveGitInfo({ repoRoot: nonGitDir, buildMode: "packaged", allowUnknownSha: false }),
      ).toThrow(/git SHA/i);

      expect(
        resolveGitInfo({ repoRoot: nonGitDir, buildMode: "packaged", allowUnknownSha: true }),
      ).toEqual({
        gitSha: "unknown",
        gitDirty: false,
        source: "unknown",
      });

      expect(
        resolveGitInfo({ repoRoot: nonGitDir, buildMode: "dev", allowUnknownSha: false }),
      ).toEqual({
        gitSha: "unknown",
        gitDirty: false,
        source: "unknown",
      });
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("produces complete display-safe AppInfo without leaking paths, cwd, username, env, or machine serials", () => {
    const info = createMainAppInfo({
      appVersion: "0.1.0",
      isPackaged: true,
      embeddedMeta: {
        gitSha: "3210e50a",
        gitDirty: false,
        source: "git",
      },
      versions: {
        electron: "45.4.1",
        chrome: "134.0.0.0",
        node: "22.13.0",
      },
      platform: "darwin",
      arch: "arm64",
      macOSVersion: "15.3.1",
    });

    expect(info).toEqual({
      bridgeVersion: 1,
      appName: "Hermes Desktop",
      appVersion: "0.1.0",
      gitSha: "3210e50a",
      gitDirty: false,
      buildMode: "packaged",
      distribution: "local-unsigned",
      electronVersion: "45.4.1",
      chromiumVersion: "134.0.0.0",
      nodeVersion: "22.13.0",
      arch: "arm64",
      macOSVersion: "15.3.1",
      source: "git",
      mode: "electron",
      platform: "darwin",
      capabilitiesReady: false,
    });

    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain(os.homedir());
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain(os.userInfo().username);
  });
});
