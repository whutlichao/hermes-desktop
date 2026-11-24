import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "quiet-relay.css");
const css = fs.readFileSync(cssPath, "utf8");

function readToken(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`Missing token ${name}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = (hex.replace("#", "").match(/[0-9a-fA-F]{2}/g) ?? []).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("Quiet Relay contrast & accessibility tokens", () => {
  it("uses the required control-line and focus-ring tokens", () => {
    expect(readToken("--control-line").toLowerCase()).toBe("#8a8a80");
    expect(readToken("--focus-ring-color").toLowerCase()).toBe("#c8442e");
    expect(css).toContain("outline: 2px solid var(--focus-ring-color)");
    expect(css).toContain("outline-offset: 2px");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("outline: 2px solid Highlight");
  });

  it("keeps body, large text, control boundaries, and focus rings above WCAG AA thresholds", () => {
    const ink = readToken("--ink");
    const muted = readToken("--muted");
    const controlLine = readToken("--control-line");
    const focusRing = readToken("--focus-ring-color");
    const accentText = readToken("--accent-text");
    const statusColors = [
      readToken("--status-ready"),
      readToken("--status-connecting"),
      readToken("--status-blocked"),
    ];
    const surfaces = ["--paper", "--paper-raised", "--paper-deep", "--surface"].map(readToken);

    for (const surface of surfaces) {
      expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(controlLine, surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(focusRing, surface)).toBeGreaterThanOrEqual(3);
      for (const statusColor of statusColors) {
        expect(contrast(statusColor, surface)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrast(accentText, readToken("--accent-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps all text sizes relative so a 200% root font scales the whole app", () => {
    expect(css).toContain("html {\n  font-size: 81.25%;\n}");
    expect(css.match(/font-size:\s*[0-9.]+px/g) ?? []).toEqual([]);
  });
});
