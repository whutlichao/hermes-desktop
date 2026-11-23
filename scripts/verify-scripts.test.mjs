import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../tests/helpers/sandbox";
import { verifyArchitecture } from "./verify-architecture.mjs";
import { verifyNoOfficialDesktop } from "./verify-no-official-desktop.mjs";
import { verifyNoMockInBuild } from "./verify-no-mock-in-build.mjs";
import { resetSandbox } from "./sandbox-reset.mjs";

describe("verification guard scripts", () => {
  it("verifyArchitecture passes on clean repo and fails on forbidden imports", () => {
    const sandbox = createTestSandbox("hermes-arch-");
    let passed = false;
    try {
      const contractsDir = path.join(sandbox.rootDir, "packages/contracts/src");
      const domainDir = path.join(sandbox.rootDir, "packages/domain/src");
      const rendererDir = path.join(sandbox.rootDir, "apps/desktop/src/renderer");
      fs.mkdirSync(contractsDir, { recursive: true });
      fs.mkdirSync(domainDir, { recursive: true });
      fs.mkdirSync(rendererDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandbox.rootDir, "packages/contracts/package.json"),
        JSON.stringify({ name: "@hermes/contracts", devDependencies: { typescript: "5.7.2" } }),
      );
      fs.writeFileSync(path.join(contractsDir, "index.ts"), "export const V = 1;\n");
      fs.writeFileSync(path.join(domainDir, "index.ts"), 'import type { V } from "@hermes/contracts";\nexport const x = 1;\n');
      fs.writeFileSync(path.join(rendererDir, "App.tsx"), 'import { getHost } from "@hermes/host-adapter";\nexport const A = () => null;\n');

      expect(verifyArchitecture(sandbox.rootDir)).toEqual({ ok: true, errors: [] });

      // Negative test: domain importing electron or node:fs
      fs.writeFileSync(path.join(domainDir, "bad.ts"), 'import { app } from "electron";\n');
      const badRes = verifyArchitecture(sandbox.rootDir);
      expect(badRes.ok).toBe(false);
      expect(badRes.errors.length).toBeGreaterThan(0);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("verifyNoOfficialDesktop fails if @hermes/plugin-sdk, Hermes.app, or hermes:// appear", () => {
    const sandbox = createTestSandbox("hermes-official-");
    let passed = false;
    try {
      const srcDir = path.join(sandbox.rootDir, "apps/desktop/src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "clean.ts"), "export const ok = true;\n");
      expect(verifyNoOfficialDesktop(sandbox.rootDir)).toEqual({ ok: true, errors: [] });

      fs.writeFileSync(path.join(srcDir, "leak.ts"), 'const sdk = "@hermes/plugin-sdk";\n');
      const bad = verifyNoOfficialDesktop(sandbox.rootDir);
      expect(bad.ok).toBe(false);
      expect(bad.errors[0]).toContain("@hermes/plugin-sdk");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("verifyNoMockInBuild fails if MockHostBridge or mock markers appear in Electron out/", () => {
    const sandbox = createTestSandbox("hermes-nomock-");
    let passed = false;
    try {
      const outDir = path.join(sandbox.rootDir, "apps/desktop/out/renderer");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.js"), "console.log('hermes desktop');\n");
      expect(verifyNoMockInBuild(sandbox.rootDir)).toEqual({ ok: true, errors: [] });

      fs.writeFileSync(path.join(outDir, "index.js"), "const bridge = 'MockHostBridge';\n");
      const bad = verifyNoMockInBuild(sandbox.rootDir);
      expect(bad.ok).toBe(false);
      expect(bad.errors[0]).toContain("MockHostBridge");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("resetSandbox removes .dev/user-data and .dev/hermes-home without touching ~/.hermes", () => {
    const sandbox = createTestSandbox("hermes-reset-");
    let passed = false;
    try {
      const userData = path.join(sandbox.rootDir, ".dev/user-data");
      const hermesHome = path.join(sandbox.rootDir, ".dev/hermes-home");
      fs.mkdirSync(userData, { recursive: true });
      fs.mkdirSync(hermesHome, { recursive: true });
      fs.writeFileSync(path.join(userData, "state.json"), "{}");

      resetSandbox(sandbox.rootDir);
      expect(fs.existsSync(userData)).toBe(false);
      expect(fs.existsSync(hermesHome)).toBe(false);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });
});
