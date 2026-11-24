import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const GUARDED_TEST_FILES = [
  "apps/desktop/src/main/connectionSupervisor.test.ts",
  "apps/desktop/src/main/remoteConnectionSupervisor.test.ts",
  "apps/desktop/src/main/remoteGateway.test.ts",
  "apps/desktop/src/main/terminalManager.test.ts",
];

const POSITIVE_TIMER_LITERAL = /\b(?:setTimeout|setInterval)\([^;\n]*?,\s*(\d[\d_]*)\s*\)/g;

function positiveTimerLiterals(source: string): number[] {
  return [...source.matchAll(POSITIVE_TIMER_LITERAL)]
    .map((match) => Number(match[1]!.replaceAll("_", "")))
    .filter((delayMs) => delayMs > 0);
}

describe("wall-clock waits in main-process tests", () => {
  it("has no positive-duration literal timers", () => {
    const offenders = GUARDED_TEST_FILES.flatMap((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      return positiveTimerLiterals(source).map((delayMs) => `${file}: ${delayMs}ms`);
    });
    expect(offenders).toEqual([]);
  });

  it("does not flag fake-timer scheduling or zero-delay event-loop yields", () => {
    const fakeTimerCode = [
      "const setTimer = (cb, delayMs) => setTimeout(cb, delayMs);",
      "setTimer(cb, 40);",
      "await vi.advanceTimersByTimeAsync(30_000);",
      "await new Promise((resolve) => setTimeout(resolve, 0));",
      "await new Promise<void>((resolve) => setImmediate(resolve));",
      "await new Promise<void>((resolve) => queueMicrotask(resolve));",
    ].join("\n");
    expect(positiveTimerLiterals(fakeTimerCode)).toEqual([]);
  });

  it("flags positive real-time sleeps", () => {
    expect(positiveTimerLiterals("await new Promise((r) => setTimeout(r, 40));")).toEqual([40]);
    expect(positiveTimerLiterals("setInterval(poll, 1_000);")).toEqual([1_000]);
  });
});
