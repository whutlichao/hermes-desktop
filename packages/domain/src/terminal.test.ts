import { describe, expect, it } from "vitest";
import {
  TERMINAL_MAX_SCROLLBACK_BYTES,
  TERMINAL_MAX_SCROLLBACK_LINES,
  appendTerminalChunk,
  buildGitWorktreeDeepLinks,
  createEmptyTerminalSnapshot,
  createTerminalScrollbackState,
  projectTerminalScrollbackLines,
  validateTerminology,
} from "./index";

describe("Terminal bounded scrollback & Git/Worktree deep links (Ticket #40)", () => {
  it("caps scrollback at 10,000 lines, trims only oldest complete lines, and marks trimmedOldest", () => {
    expect(TERMINAL_MAX_SCROLLBACK_LINES).toBe(10_000);
    expect(TERMINAL_MAX_SCROLLBACK_BYTES).toBe(2 * 1024 * 1024);

    let buf = createTerminalScrollbackState();
    const lines = Array.from({ length: 10_050 }, (_, idx) => `line-${idx + 1}`);
    buf = appendTerminalChunk(buf, `${lines.join("\n")}\n`);

    const projected = projectTerminalScrollbackLines(buf);
    expect(projected).toHaveLength(10_000);
    expect(projected[0]).toBe("line-51");
    expect(projected[projected.length - 1]).toBe("line-10050");
    expect(buf.trimmedOldest).toBe(true);
  });

  it("caps scrollback at 2 MiB before 10,000 lines and never leaves a half-cut older line", () => {
    let buf = createTerminalScrollbackState();
    // 20 lines * ~150 KiB = ~3 MiB (> 2 MiB, << 10,000 lines)
    const payload150k = "x".repeat(150 * 1024);
    for (let i = 1; i <= 20; i += 1) {
      buf = appendTerminalChunk(buf, `ROW_${String(i).padStart(2, "0")}_${payload150k}\n`);
    }

    const projected = projectTerminalScrollbackLines(buf);
    expect(buf.trimmedOldest).toBe(true);
    expect(buf.totalBytes).toBeLessThanOrEqual(TERMINAL_MAX_SCROLLBACK_BYTES);
    expect(projected.length).toBeLessThan(20);
    expect(projected.length).toBeGreaterThan(10);
    // Oldest surviving line must be a complete intact line (starts with ROW_ and has full payload)
    expect(projected[0]).toMatch(/^ROW_\d{2}_x+$/);
    expect(projected[0]?.length).toBe(`ROW_01_${payload150k}`.length);
    expect(projected[projected.length - 1]?.startsWith("ROW_20_")).toBe(true);
  });

  it("normalizes ANSI CSI/OSC sequences, CR overwrites, and backspaces into clean scrollback lines", () => {
    let buf = createTerminalScrollbackState();
    buf = appendTerminalChunk(buf, "\u001b[?2004h$ t\u0008tty\r\n/dev/ttys004\r\n");
    buf = appendTerminalChunk(buf, "progress 10%\rprogress 100%\r\n");
    buf = appendTerminalChunk(buf, "\u001b]0;zsh\u0007prompt> ");

    const projected = projectTerminalScrollbackLines(buf);
    expect(projected).toEqual(["$ tty", "/dev/ttys004", "progress 100%", "prompt> "]);
    expect(buf.trimmedOldest).toBe(false);
  });

  it("handles empty chunks, custom caps, printable controls, OSC ST, split CRLF, and half-cut edge cases", () => {
    const initial = createTerminalScrollbackState();
    expect(appendTerminalChunk(initial, "")).toBe(initial);

    let buf = createTerminalScrollbackState();
    buf = appendTerminalChunk(buf, "seed\nline\n", { maxLines: 1 });
    expect(buf.lines).toEqual(["line"]);
    expect(buf.trimmedOldest).toBe(true);
    buf = appendTerminalChunk(createTerminalScrollbackState(), "a\r\nb\rc\n", { maxLines: 2 });
    expect(projectTerminalScrollbackLines(buf)).toEqual(["a", "c"]);
    expect(buf.trimmedOldest).toBe(false);

    let customBytes = createTerminalScrollbackState();
    customBytes = appendTerminalChunk(customBytes, "12345\n67890\nabc", { maxBytes: 8 });
    expect(customBytes.totalBytes).toBeLessThanOrEqual(8);
    expect(customBytes.trimmedOldest).toBe(true);
    expect(projectTerminalScrollbackLines(customBytes)).toEqual(["abc"]);

    let controls = createTerminalScrollbackState();
    controls = appendTerminalChunk(controls, "x\u0001\u0007\u001b]0;title\u001b\\yz\b\b\u0000\t!\n");
    expect(projectTerminalScrollbackLines(controls)).toEqual(["x\t!"]);

    let backspaceEmpty = createTerminalScrollbackState();
    backspaceEmpty = appendTerminalChunk(backspaceEmpty, "\b\b");
    expect(projectTerminalScrollbackLines(backspaceEmpty)).toEqual([]);

    let crlf = createTerminalScrollbackState();
    crlf = appendTerminalChunk(crlf, "\r\n");
    expect(projectTerminalScrollbackLines(crlf)).toEqual([""]);

    let lineCapWithCurrentLine = createTerminalScrollbackState();
    lineCapWithCurrentLine = appendTerminalChunk(lineCapWithCurrentLine, "one\ntwo\nthree", {
      maxLines: 2,
    });
    expect(projectTerminalScrollbackLines(lineCapWithCurrentLine)).toEqual(["two", "three"]);

    let byteCapAllComplete = createTerminalScrollbackState();
    byteCapAllComplete = appendTerminalChunk(byteCapAllComplete, "12345678\n12345678\n", {
      maxBytes: 4,
    });
    expect(projectTerminalScrollbackLines(byteCapAllComplete)).toEqual([]);
    expect(byteCapAllComplete.trimmedOldest).toBe(true);

    const inconsistentByteAccounting = {
      lines: ["one", "two"],
      lineBytes: [],
      currentLine: "tail",
      currentLineBytes: 4,
      trimmedOldest: false,
      totalBytes: 0,
    };
    const repaired = appendTerminalChunk(inconsistentByteAccounting, "!", {
      maxLines: 1,
      maxBytes: 0,
    });
    expect(repaired.lines).toEqual([]);
    expect(repaired.currentLine).toBe("tail!");
    expect(repaired.trimmedOldest).toBe(true);

    const byteOnlyTrim = appendTerminalChunk(
      {
        lines: ["one", "two"],
        lineBytes: [],
        currentLine: "tail",
        currentLineBytes: 4,
        trimmedOldest: false,
        totalBytes: 0,
      },
      "!",
      { maxLines: 10, maxBytes: 0 },
    );
    expect(byteOnlyTrim.lines).toEqual([]);
    expect(byteOnlyTrim.currentLine).toBe("tail!");
    expect(byteOnlyTrim.trimmedOldest).toBe(true);
  });

  it("creates idle empty snapshot with scope binding and null opaque terminalId", () => {
    const snap = createEmptyTerminalSnapshot({ connectionId: "local", profileId: "default" });
    expect(snap.scope).toEqual({ connectionId: "local", profileId: "default" });
    expect(snap.terminalId).toBeNull();
    expect(snap.status).toBe("idle");
    expect(snap.hasForegroundProcess).toBe(false);
    expect(snap.lines).toEqual([]);
    expect(snap.trimmedOldest).toBe(false);
    expect(snap.attribution.origin).toBe("builtin");

    const defaults = createEmptyTerminalSnapshot();
    expect(defaults.scope).toEqual({ connectionId: "local", profileId: "default" });
    const overridden = createEmptyTerminalSnapshot(
      { connectionId: "remote-1", profileId: "ops" },
      { status: "running", cols: 120, rows: 40, terminalId: "term-1" },
    );
    expect(overridden.scope).toEqual({ connectionId: "remote-1", profileId: "ops" });
    expect(overridden.status).toBe("running");
    expect(overridden.cols).toBe(120);
    expect(overridden.rows).toBe(40);
    expect(overridden.terminalId).toBe("term-1");
  });

  it("provides exact Git/Worktree CLI deep links and https docs without git.* RPC or hermes:// scheme", () => {
    const catalog = buildGitWorktreeDeepLinks();
    expect(catalog.boundaryNote).toContain("不会在此客户端执行");
    expect(catalog.cliItems.length).toBeGreaterThanOrEqual(3);
    for (const item of catalog.cliItems) {
      expect(item.command).toMatch(/^(git|gh)\s+/);
      expect(item.executionNote).toContain("不会在此客户端执行");
      expect(item.command).not.toContain("hermes://");
      expect(item.attribution?.origin).toBe("external");
    }
    expect(catalog.docLinks.length).toBeGreaterThanOrEqual(2);
    for (const doc of catalog.docLinks) {
      expect(doc.url).toMatch(/^https:\/\//);
      expect(doc.url).not.toContain("hermes://");
    }
    expect(validateTerminology(catalog.boundaryNote)).toEqual([]);
  });
});
