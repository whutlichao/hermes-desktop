import { describe, expect, it } from "vitest";
import { HOST_BRIDGE_VERSION, type AppInfo } from "@hermes/contracts";
import {
  COPY_CATALOG,
  assertAppInfoSafe,
  formatAppInfoDisplay,
  formatAppShaLabel,
  lintCopyCatalog,
} from "@hermes/domain";

function makeAppInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    bridgeVersion: HOST_BRIDGE_VERSION,
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
    ...overrides,
  };
}

describe("AppInfo formatting and safety invariants", () => {
  it("formats packaged clean, packaged unknown, dev dirty, dev clean, and dev unknown identically from one source", () => {
    expect(formatAppShaLabel(makeAppInfo({ buildMode: "packaged", gitDirty: false, source: "git" }))).toBe(
      "3210e50a",
    );
    expect(formatAppShaLabel(makeAppInfo({ buildMode: "packaged", gitSha: "unknown", source: "unknown" }))).toBe(
      "unknown",
    );
    expect(formatAppShaLabel(makeAppInfo({ buildMode: "packaged", gitSha: "", source: "git" }))).toBe(
      "unknown",
    );
    expect(
      formatAppShaLabel(makeAppInfo({ buildMode: "packaged", gitDirty: true, source: "git" })),
    ).toBe("3210e50a.dirty");
    expect(formatAppShaLabel(makeAppInfo({ buildMode: "dev", gitDirty: true, source: "git" }))).toBe(
      "dev+3210e50a.dirty",
    );
    expect(formatAppShaLabel(makeAppInfo({ buildMode: "dev", gitDirty: false, source: "git" }))).toBe(
      "dev+3210e50a",
    );
    expect(formatAppShaLabel(makeAppInfo({ buildMode: "dev", gitSha: "unknown", source: "unknown" }))).toBe(
      "dev+unknown",
    );

    const display = formatAppInfoDisplay(makeAppInfo());
    expect(display).toEqual({
      shaLabel: "3210e50a",
      headline: "Hermes Desktop 0.1.0 (3210e50a)",
      buildLine: "本地开发构建 · arm64",
      runtimeLine: "Electron 45.4.1 · Chromium 134.0.0.0 · Node 22.13.0",
      updatesNotice: "本地开发构建，不检查更新",
    });

    const devDirtyDisplay = formatAppInfoDisplay(makeAppInfo({ buildMode: "dev", gitDirty: true }));
    expect(devDirtyDisplay.headline).toBe("Hermes Desktop 0.1.0 (dev+3210e50a.dirty)");
  });

  it("rejects AppInfo containing paths, cwd, __dirname, home, env, URLs, tokens, stacks, or serials", () => {
    expect(() => assertAppInfoSafe(makeAppInfo())).not.toThrow();

    expect(() =>
      assertAppInfoSafe(makeAppInfo({ gitSha: "/Users/alice/repo" })),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe({
        ...makeAppInfo(),
        cwd: "/Users/alice/hermes",
      } as unknown as AppInfo),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe({
        ...makeAppInfo(),
        __dirname: "/app",
      } as unknown as AppInfo),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe({
        ...makeAppInfo(),
        machineSerial: "C02XYZ",
      } as unknown as AppInfo),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe(makeAppInfo({ gitSha: "C:\\Users\\alice\\repo" })),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe(makeAppInfo({ gitSha: "https://gateway.example.com/path" })),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe(makeAppInfo({ gitSha: "Bearer token_123" })),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe(
        makeAppInfo({ gitSha: "fatal error\n    at handler (/app/index.js:1:1)" }),
      ),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe(makeAppInfo({ distribution: "developer-id" as AppInfo["distribution"] })),
    ).toThrow();
    expect(() =>
      assertAppInfoSafe(makeAppInfo({ arch: "ia32" as AppInfo["arch"] })),
    ).toThrow();
    expect(assertAppInfoSafe(makeAppInfo({ arch: "x64" })).arch).toBe("x64");
  });

  it("keeps copy catalog valid with Updates notice copy", () => {
    expect(COPY_CATALOG["settings.updatesNotice"]).toBe("本地开发构建，不检查更新");
    expect(lintCopyCatalog(COPY_CATALOG)).toEqual([]);
  });
});
