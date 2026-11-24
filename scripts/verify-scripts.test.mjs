import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../tests/helpers/sandbox";
import { verifyArchitecture } from "./verify-architecture.mjs";
import { verifyNoOfficialDesktop } from "./verify-no-official-desktop.mjs";
import { verifyNoMockInBuild } from "./verify-no-mock-in-build.mjs";
import { resetSandbox } from "./sandbox-reset.mjs";
import { writeTestAsarArchive } from "./asar-reader.mjs";

function setupMinimalCleanRepo(rootDir) {
  const contractsDir = path.join(rootDir, "packages/contracts/src");
  const domainDir = path.join(rootDir, "packages/domain/src");
  const rendererDir = path.join(rootDir, "apps/desktop/src/renderer");
  const preloadDir = path.join(rootDir, "apps/desktop/src/preload");
  fs.mkdirSync(contractsDir, { recursive: true });
  fs.mkdirSync(domainDir, { recursive: true });
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.mkdirSync(preloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "hermes-desktop", private: true }),
  );
  fs.writeFileSync(
    path.join(rootDir, "packages/contracts/package.json"),
    JSON.stringify({ name: "@hermes/contracts", devDependencies: { typescript: "5.7.2" } }),
  );
  fs.writeFileSync(
    path.join(rootDir, "apps/desktop/package.json"),
    JSON.stringify({
      name: "@hermes/desktop",
      dependencies: { "@hermes/contracts": "workspace:*", "@hermes/domain": "workspace:*" },
    }),
  );
  fs.writeFileSync(
    path.join(rootDir, "apps/desktop/electron-builder.json"),
    JSON.stringify({
      appId: "com.whutlichao.hermesdesktop",
      productName: "Hermes Desktop",
      files: ["out/**/*", "package.json"],
      asarUnpack: ["**/*.node"],
    }),
  );
  fs.writeFileSync(path.join(contractsDir, "index.ts"), "export const V = 1;\n");
  fs.writeFileSync(
    path.join(domainDir, "index.ts"),
    'import type { V } from "@hermes/contracts";\nexport const x = 1;\n',
  );
  fs.writeFileSync(
    path.join(rendererDir, "App.tsx"),
    'import { getHost } from "@hermes/host-adapter";\nexport const A = () => null;\n',
  );
  fs.writeFileSync(
    path.join(preloadDir, "index.ts"),
    'import { contextBridge, ipcRenderer } from "electron";\nimport { HOST_BRIDGE_VERSION } from "@hermes/contracts";\ncontextBridge.exposeInMainWorld("hermesHost", Object.freeze({ version: HOST_BRIDGE_VERSION, send: () => ipcRenderer.invoke("hermes:request") }));\n',
  );
}

describe("verification guard scripts", () => {
  it("verifyArchitecture enforces domain, renderer, and preload isolation", () => {
    const sandbox = createTestSandbox("hermes-arch-");
    let passed = false;
    try {
      setupMinimalCleanRepo(sandbox.rootDir);
      expect(verifyArchitecture(sandbox.rootDir)).toEqual({ ok: true, errors: [] });

      // Negative 1: domain importing electron
      fs.writeFileSync(path.join(sandbox.rootDir, "packages/domain/src/bad.ts"), 'import { app } from "electron";\n');
      expect(verifyArchitecture(sandbox.rootDir).ok).toBe(false);
      fs.rmSync(path.join(sandbox.rootDir, "packages/domain/src/bad.ts"));

      // Negative 2: renderer reading process.versions
      fs.writeFileSync(
        path.join(sandbox.rootDir, "apps/desktop/src/renderer/leak.ts"),
        "export const v = process.versions.electron;\n",
      );
      const rendererBad = verifyArchitecture(sandbox.rootDir);
      expect(rendererBad.ok).toBe(false);
      expect(rendererBad.errors.join("\n")).toContain("renderer");
      fs.rmSync(path.join(sandbox.rootDir, "apps/desktop/src/renderer/leak.ts"));

      // Negative 3: preload exposing non-bridge API or importing domain/fs
      fs.writeFileSync(
        path.join(sandbox.rootDir, "apps/desktop/src/preload/bad.ts"),
        'import fs from "node:fs";\nimport { contextBridge } from "electron";\ncontextBridge.exposeInMainWorld("rawFs", fs);\n',
      );
      const preloadBad = verifyArchitecture(sandbox.rootDir);
      expect(preloadBad.ok).toBe(false);
      expect(preloadBad.errors.join("\n")).toContain("preload");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("verifyNoOfficialDesktop enforces manifest, lockfile, source, electron-builder, vendor UPSTREAM.md, and final asar deny-lists", () => {
    const sandbox = createTestSandbox("hermes-official-");
    let passed = false;
    try {
      setupMinimalCleanRepo(sandbox.rootDir);
      // Allowed official docs URL
      fs.writeFileSync(
        path.join(sandbox.rootDir, "apps/desktop/src/docs.ts"),
        'export const DOCS_URL = "https://hermes-agent.nousresearch.com/docs";\n',
      );
      // Allowed transitive electron-builder-squirrel-windows in pnpm-lock.yaml
      fs.writeFileSync(
        path.join(sandbox.rootDir, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\npackages:\n  electron-builder-squirrel-windows@26.18.0:\n    resolution: {integrity: sha512-abc}\n",
      );

      expect(verifyNoOfficialDesktop(sandbox.rootDir)).toEqual({ ok: true, errors: [] });

      // Negative 1: forbidden dependency in manifest & lockfile
      fs.writeFileSync(
        path.join(sandbox.rootDir, "apps/desktop/package.json"),
        JSON.stringify({
          name: "@hermes/desktop",
          dependencies: { "electron-updater": "6.0.0", "@hermes/other": "1.0.0" },
        }),
      );
      const pkgBad = verifyNoOfficialDesktop(sandbox.rootDir);
      expect(pkgBad.ok).toBe(false);
      expect(pkgBad.errors.join("\n")).toContain("electron-updater");
      expect(pkgBad.errors.join("\n")).toContain("@hermes/other");
      setupMinimalCleanRepo(sandbox.rootDir);

      // Negative 2: forbidden lockfile package (squirrel / hermes-app)
      fs.writeFileSync(
        path.join(sandbox.rootDir, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\npackages:\n  hermes-app@1.0.0:\n    resolution: {integrity: sha512-xyz}\n  squirrel@1.0.0:\n    resolution: {integrity: sha512-xyz}\n",
      );
      const lockBad = verifyNoOfficialDesktop(sandbox.rootDir);
      expect(lockBad.ok).toBe(false);
      expect(lockBad.errors.join("\n")).toContain("hermes-app");
      expect(lockBad.errors.join("\n")).toContain("squirrel");
      fs.writeFileSync(path.join(sandbox.rootDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      // Negative 3: forbidden source strings (plugin.js / desktop-plugins / sparkle)
      fs.writeFileSync(
        path.join(sandbox.rootDir, "apps/desktop/src/leak.ts"),
        'export const p = "desktop-plugins/plugin.js";\n',
      );
      const srcBad = verifyNoOfficialDesktop(sandbox.rootDir);
      expect(srcBad.ok).toBe(false);
      expect(srcBad.errors.join("\n")).toContain("desktop-plugins");
      fs.rmSync(path.join(sandbox.rootDir, "apps/desktop/src/leak.ts"));

      // Negative 4: electron-builder extraResources / files / asarUnpack referencing Hermes.app
      fs.writeFileSync(
        path.join(sandbox.rootDir, "apps/desktop/electron-builder.json"),
        JSON.stringify({
          appId: "com.whutlichao.hermesdesktop",
          extraResources: [{ from: "/Applications/Hermes.app" }],
        }),
      );
      const ebBad = verifyNoOfficialDesktop(sandbox.rootDir);
      expect(ebBad.ok).toBe(false);
      expect(ebBad.errors.join("\n")).toContain("Hermes.app");
      setupMinimalCleanRepo(sandbox.rootDir);

      // Negative 5: vendor/ without matching UPSTREAM.md entry
      const vendorDir = path.join(sandbox.rootDir, "vendor");
      fs.mkdirSync(vendorDir, { recursive: true });
      fs.writeFileSync(path.join(vendorDir, "UPSTREAM.md"), "# Upstream\n- allowed-helper.ts\n");
      fs.writeFileSync(path.join(vendorDir, "allowed-helper.ts"), "export const ok = 1;\n");
      expect(verifyNoOfficialDesktop(sandbox.rootDir)).toEqual({ ok: true, errors: [] });

      fs.writeFileSync(path.join(vendorDir, "unlisted.ts"), "export const bad = 1;\n");
      const vendorBad = verifyNoOfficialDesktop(sandbox.rootDir);
      expect(vendorBad.ok).toBe(false);
      expect(vendorBad.errors.join("\n")).toContain("UPSTREAM.md");
      fs.rmSync(vendorDir, { recursive: true, force: true });

      // Negative 6: final .asar scan catches plugin.js / hermes://
      const asarPath = path.join(
        sandbox.rootDir,
        "apps/desktop/release/mac-arm64/Hermes Desktop.app/Contents/Resources/app.asar",
      );
      fs.mkdirSync(path.dirname(asarPath), { recursive: true });
      writeTestAsarArchive(asarPath, {
        "out/main/index.js": Buffer.from("console.log('clean');\n"),
      });
      expect(verifyNoOfficialDesktop(sandbox.rootDir, { requireAsar: true })).toEqual({ ok: true, errors: [] });

      writeTestAsarArchive(asarPath, {
        "out/main/index.js": Buffer.from("const scheme = 'hermes://open';\n"),
        "plugin.js": Buffer.from("module.exports = {};"),
      });
      const asarBad = verifyNoOfficialDesktop(sandbox.rootDir, { requireAsar: true });
      expect(asarBad.ok).toBe(false);
      expect(asarBad.errors.join("\n")).toContain("plugin.js");
      expect(asarBad.errors.join("\n")).toContain("hermes://");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("verifyNoMockInBuild scans both out/ and final app.asar for mock markers and demo switches", () => {
    const sandbox = createTestSandbox("hermes-nomock-");
    let passed = false;
    try {
      const outDir = path.join(sandbox.rootDir, "apps/desktop/out/renderer");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.js"), "console.log('hermes desktop');\n");

      const asarPath = path.join(
        sandbox.rootDir,
        "apps/desktop/release/mac-arm64/Hermes Desktop.app/Contents/Resources/app.asar",
      );
      fs.mkdirSync(path.dirname(asarPath), { recursive: true });
      writeTestAsarArchive(asarPath, {
        "out/renderer/index.js": Buffer.from("console.log('hermes desktop');\n"),
      });

      expect(verifyNoMockInBuild(sandbox.rootDir, { requireAsar: true })).toEqual({ ok: true, errors: [] });

      // Negative 1: ?demo= switch in out/
      fs.writeFileSync(path.join(outDir, "index.js"), "const u = '?demo=1';\n");
      const outBad = verifyNoMockInBuild(sandbox.rootDir);
      expect(outBad.ok).toBe(false);
      expect(outBad.errors[0]).toContain("?demo=");
      fs.writeFileSync(path.join(outDir, "index.js"), "console.log('clean');\n");

      // Negative 2: MockHostBridge leaked inside app.asar
      writeTestAsarArchive(asarPath, {
        "out/renderer/index.js": Buffer.from("const m = 'MockHostBridge';\n"),
      });
      const asarBad = verifyNoMockInBuild(sandbox.rootDir, { requireAsar: true });
      expect(asarBad.ok).toBe(false);
      expect(asarBad.errors[0]).toContain("MockHostBridge");

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("resetSandbox removes .dev/user-data and .dev/hermes-home and refuses symlinks", () => {
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

      // Negative: symlink target must be rejected
      const outsideDir = path.join(sandbox.rootDir, "outside-real-dir");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.mkdirSync(path.join(sandbox.rootDir, ".dev"), { recursive: true });
      fs.symlinkSync(outsideDir, hermesHome);
      expect(() => resetSandbox(sandbox.rootDir)).toThrow(/symlink/i);
      expect(fs.existsSync(outsideDir)).toBe(true);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });
});
