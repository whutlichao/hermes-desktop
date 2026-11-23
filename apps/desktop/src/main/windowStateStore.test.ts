import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { WindowStateStore, type DisplayWorkArea } from "./windowStateStore";

describe("WindowStateStore (S0/S3 bounds clamp, legacy ID normalization, no singletons)", () => {
  it("normalizes legacy missing windowId/paneId to primary/main, strips sidebar booleans, and preserves theme slot", () => {
    const sandbox = createTestSandbox("hermes-winstate-legacy-");
    let passed = false;
    try {
      const statePath = path.join(sandbox.userDataDir, "window-state.json");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          windowId: "legacy-win-99",
          bounds: { x: 40, y: 50, width: 1280, height: 800 },
          sidebarOpen: false,
          railCollapsed: true,
          panes: [
            {
              paneId: "secondary-pane",
              activeScope: { connectionId: "local", profileId: "default" },
              activeChat: { connectionId: "local", profileId: "default", sessionId: "s1" },
            },
          ],
        }),
        { encoding: "utf8", mode: 0o600 },
      );

      const store = new WindowStateStore({
        userDataDir: sandbox.userDataDir,
        getDisplays: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
      });
      const loaded = store.load();

      expect(loaded.windowId).toBe("primary");
      expect(loaded.theme).toBe("quiet-relay-light");
      expect(loaded.panes).toHaveLength(1);
      expect(loaded.panes[0].paneId).toBe("main");
      expect(loaded.bounds).toEqual({ x: 40, y: 50, width: 1280, height: 800 });

      store.saveBounds({ x: 100, y: 80, width: 1440, height: 900 });
      const rawPersisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      expect(rawPersisted.windowId).toBe("primary");
      expect((rawPersisted.panes as Array<Record<string, unknown>>)[0].paneId).toBe("main");
      expect("sidebarOpen" in rawPersisted).toBe(false);
      expect("railCollapsed" in rawPersisted).toBe(false);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("clamps bounds to nearest workArea enforcing min 1120x700 or smaller display workArea max", () => {
    const sandbox = createTestSandbox("hermes-winstate-clamp-");
    let passed = false;
    try {
      const displays: DisplayWorkArea[] = [
        { x: 0, y: 0, width: 1440, height: 900 },
        { x: 1440, y: 0, width: 1024, height: 640 },
      ];
      const store = new WindowStateStore({
        userDataDir: sandbox.userDataDir,
        getDisplays: () => displays,
      });

      // Below minimum on large display -> clamped up to 1120x700 and moved inside workArea
      const clampedLarge = store.saveBounds({ x: -200, y: -50, width: 800, height: 500 });
      expect(clampedLarge.bounds).toEqual({ x: 0, y: 0, width: 1120, height: 700 });

      // Smaller secondary display -> capped at secondary display's workArea (1024x640)
      const clampedSmall = store.saveBounds({ x: 1600, y: 100, width: 1300, height: 850 });
      expect(clampedSmall.bounds).toEqual({ x: 1440, y: 0, width: 1024, height: 640 });

      passed = true;
    } finally {
      sandbox.cleanup(passed);
    }
  });

  it("uses independent instances with zero module-level singletons", () => {
    const sandboxA = createTestSandbox("hermes-winstate-a-");
    const sandboxB = createTestSandbox("hermes-winstate-b-");
    let passed = false;
    try {
      const storeA = new WindowStateStore({
        userDataDir: sandboxA.userDataDir,
        getDisplays: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
      });
      const storeB = new WindowStateStore({
        userDataDir: sandboxB.userDataDir,
        getDisplays: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
      });

      storeA.saveBounds({ x: 10, y: 20, width: 1280, height: 800 });
      storeB.saveBounds({ x: 30, y: 40, width: 1440, height: 900 });

      expect(storeA.load().bounds).toEqual({ x: 10, y: 20, width: 1280, height: 800 });
      expect(storeB.load().bounds).toEqual({ x: 30, y: 40, width: 1440, height: 900 });

      passed = true;
    } finally {
      sandboxA.cleanup(passed);
      sandboxB.cleanup(passed);
    }
  });
});
