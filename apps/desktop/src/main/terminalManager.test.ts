import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BridgeScope } from "@hermes/contracts";
import {
  TerminalManager,
  createNodePtyFactory,
  type PtyProcess,
} from "./terminalManager";

class FakePty extends EventEmitter implements PtyProcess {
  public writes: string[] = [];
  public resizes: Array<{ cols: number; rows: number }> = [];
  public killed = false;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    if (!this.killed) {
      this.killed = true;
      this.emitExit(0);
    }
  }

  emitData(chunk: string): void {
    this.emit("data", chunk);
  }

  emitForeground(busy: boolean, processName?: string): void {
    this.emit("foreground", { busy, processName });
  }

  emitExit(code: number | null = 0): void {
    this.emit("exit", code);
  }
}

const SCOPE_A: BridgeScope = { connectionId: "local", profileId: "default" };
const SCOPE_B: BridgeScope = { connectionId: "local", profileId: "work" };

describe("TerminalManager (Main-owned PTY, grant, bounded scrollback, lifecycle)", () => {
  it("never spawns PTY when first-terminal or root grant confirmation is denied", async () => {
    const ptyFactory = vi.fn(() => new FakePty());
    const confirmFirstTerminal = vi.fn(async () => false);
    const confirmGrantRoot = vi.fn(async () => false);

    const manager = new TerminalManager({
      ptyFactory,
      confirmFirstTerminal,
      confirmGrantRoot,
    });

    const deniedFirst = await manager.open(SCOPE_A, { cols: 80, rows: 24 });
    expect(confirmFirstTerminal).toHaveBeenCalledTimes(1);
    expect(ptyFactory).not.toHaveBeenCalled();
    expect(deniedFirst.ok).toBe(false);
    expect(deniedFirst.granted).toBe(false);
    expect(deniedFirst.deniedReason).toBe("user_denied");
    expect(deniedFirst.snapshot.status).toBe("grant_denied");
    expect(deniedFirst.snapshot.terminalId).toBeNull();

    const deniedRoot = await manager.open(SCOPE_B, { grantRoot: true });
    expect(confirmGrantRoot).toHaveBeenCalledTimes(1);
    expect(ptyFactory).not.toHaveBeenCalled();
    expect(deniedRoot.ok).toBe(false);
    expect(deniedRoot.granted).toBe(false);
    expect(deniedRoot.deniedReason).toBe("root_denied");
    expect(deniedRoot.snapshot.status).toBe("grant_denied");
    expect(deniedRoot.snapshot.rootGranted).toBe(false);
  });

  it("issues one opaque terminalId per Scope and rejects cross-scope or ended writes without auto-spawning", async () => {
    const ptyA = new FakePty();
    const ptyB = new FakePty();
    let idx = 0;
    const ptyFactory = vi.fn(() => (idx++ === 0 ? ptyA : ptyB));

    const manager = new TerminalManager({
      ptyFactory,
      confirmFirstTerminal: async () => true,
      confirmGrantRoot: async () => true,
    });

    const openA = await manager.open(SCOPE_A, { cols: 90, rows: 30 });
    const openB = await manager.open(SCOPE_B, { cols: 80, rows: 24 });

    expect(openA.ok).toBe(true);
    expect(openB.ok).toBe(true);
    expect(openA.snapshot.terminalId).toBeTruthy();
    expect(openB.snapshot.terminalId).toBeTruthy();
    expect(openA.snapshot.terminalId).not.toBe(openB.snapshot.terminalId);

    // Cross-scope terminalId must throw scope_mismatch
    await expect(
      manager.write(SCOPE_B, {
        terminalId: openA.snapshot.terminalId ?? undefined,
        data: "echo hi\n",
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });

    // Natural exit transitions to ended and rejects write/resize without spawning
    ptyA.emitData("bye\r\n");
    ptyA.emitExit(1);
    const snapAfterExit = manager.getSnapshot(SCOPE_A);
    expect(snapAfterExit.status).toBe("ended");
    expect(snapAfterExit.terminalId).toBeNull();
    expect(snapAfterExit.lines).toEqual(["bye"]);

    await expect(manager.write(SCOPE_A, { data: "pwd\n" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(manager.resize(SCOPE_A, { cols: 100, rows: 40 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(ptyFactory).toHaveBeenCalledTimes(2);

    // Ended terminal only reopens explicitly with mode: "new"
    const implicitOpen = await manager.open(SCOPE_A, { mode: "open" });
    expect(implicitOpen.ok).toBe(false);
    expect(ptyFactory).toHaveBeenCalledTimes(2);

    const explicitNew = await manager.open(SCOPE_A, { mode: "new", cols: 100, rows: 40 });
    expect(explicitNew.ok).toBe(true);
    expect(explicitNew.snapshot.status).toBe("running");
    expect(explicitNew.snapshot.terminalId).toBeTruthy();
    expect(explicitNew.snapshot.terminalId).not.toBe(openA.snapshot.terminalId);
    expect(ptyFactory).toHaveBeenCalledTimes(3);

    manager.disposeAll();
  });

  it("handles idle close release, busy inline confirm, detach with ongoing scrollback, terminate, and reload/quit lifecycle", async () => {
    const pty1 = new FakePty();
    const pty2 = new FakePty();
    let idx = 0;
    const manager = new TerminalManager({
      ptyFactory: () => (idx++ === 0 ? pty1 : pty2),
      confirmFirstTerminal: async () => true,
      confirmGrantRoot: async () => true,
    });

    const opened = await manager.open(SCOPE_A);
    const tid1 = opened.snapshot.terminalId!;
    pty1.emitData("line-1\r\n");

    // Busy foreground process prevents silent close
    pty1.emitForeground(true, "sleep");
    const busyConfirm = await manager.close(SCOPE_A, { terminalId: tid1, mode: "auto" });
    expect(busyConfirm.ok).toBe(false);
    expect(busyConfirm.outcome).toBe("confirm_required");
    expect(busyConfirm.snapshot.status).toBe("running");
    expect(pty1.killed).toBe(false);

    // Default choice: detach & keep running, retain + append scrollback
    const detached = await manager.close(SCOPE_A, { terminalId: tid1, mode: "detach" });
    expect(detached.ok).toBe(true);
    expect(detached.outcome).toBe("detached");
    expect(detached.snapshot.status).toBe("detached");
    expect(pty1.killed).toBe(false);

    pty1.emitData("while-detached\r\n");
    // Simulating renderer reload: subscriber receives snapshot with retained scrollback + same terminalId
    const events: Array<{ kind: string; payload: { status: string; lines: string[]; terminalId: string | null } }> = [];
    const unsub = manager.subscribe(SCOPE_A, (ev) => {
      events.push(ev as (typeof events)[number]);
    });
    expect(events[0]?.kind).toBe("snapshot");
    expect(events[0]?.payload.terminalId).toBe(tid1);
    expect(events[0]?.payload.lines).toEqual(["line-1", "while-detached"]);

    // Re-attach retains exact terminalId & bounded scrollback
    const reattached = await manager.open(SCOPE_A);
    expect(reattached.ok).toBe(true);
    expect(reattached.snapshot.status).toBe("running");
    expect(reattached.snapshot.terminalId).toBe(tid1);
    expect(reattached.snapshot.lines).toEqual(["line-1", "while-detached"]);

    // Explicit terminate kills PTY and clears scrollback
    const terminated = await manager.close(SCOPE_A, { terminalId: tid1, mode: "terminate" });
    expect(terminated.ok).toBe(true);
    expect(terminated.outcome).toBe("terminated");
    expect(pty1.killed).toBe(true);
    expect(terminated.snapshot.status).toBe("ended");
    expect(terminated.snapshot.terminalId).toBeNull();
    expect(terminated.snapshot.lines).toEqual([]);

    // New terminal + idle close releases view and scrollback
    const reopened = await manager.open(SCOPE_A, { mode: "new" });
    expect(reopened.ok).toBe(true);
    pty2.emitData("idle-output\r\n");
    const idleClosed = await manager.close(SCOPE_A, { mode: "auto" });
    expect(idleClosed.ok).toBe(true);
    expect(idleClosed.outcome).toBe("closed");
    expect(pty2.killed).toBe(true);
    expect(idleClosed.snapshot.status).toBe("idle");
    expect(idleClosed.snapshot.lines).toEqual([]);

    unsub();
    manager.disposeAll();
  });

  it("caps Main scrollback at 10,000 lines / 2 MiB with trimmedOldest and resets on disposeAll (quit)", async () => {
    const pty = new FakePty();
    const manager = new TerminalManager({
      ptyFactory: () => pty,
      confirmFirstTerminal: async () => true,
      confirmGrantRoot: async () => true,
    });

    await manager.open(SCOPE_A);
    const lines = Array.from({ length: 10_010 }, (_, i) => `row-${i + 1}`);
    pty.emitData(`${lines.join("\n")}\n`);

    const snap = manager.getSnapshot(SCOPE_A);
    expect(snap.trimmedOldest).toBe(true);
    expect(snap.lines).toHaveLength(10_000);
    expect(snap.lines[0]).toBe("row-11");
    expect(snap.lines[9999]).toBe("row-10010");

    manager.disposeAll();
    expect(pty.killed).toBe(true);
    expect(manager.getSnapshot(SCOPE_A).status).toBe("idle");
    expect(manager.getSnapshot(SCOPE_A).lines).toEqual([]);
  });

  it("spawns a real OS PTY on macOS, writes command, resizes, and cleans up cleanly", async () => {
    const manager = new TerminalManager({
      ptyFactory: createNodePtyFactory(),
      confirmFirstTerminal: async () => true,
      confirmGrantRoot: async () => true,
    });

    const opened = await manager.open(SCOPE_A, { cols: 88, rows: 26 });
    expect(opened.ok).toBe(true);
    expect(opened.snapshot.status).toBe("running");

    await manager.resize(SCOPE_A, {
      terminalId: opened.snapshot.terminalId ?? undefined,
      cols: 104,
      rows: 32,
    });
    await manager.write(SCOPE_A, {
      terminalId: opened.snapshot.terminalId ?? undefined,
      data: "tty && stty size && echo \"REAL_MAIN_\"\"PTY_OK\"\n",
    });

    await expect
      .poll(
        () => {
          const output = manager.getSnapshot(SCOPE_A).lines.join("\n");
          return {
            tty: output.includes("/dev/tty"),
            size: output.includes("32 104"),
            marker: /\nREAL_MAIN_PTY_OK(?:\n|$)/.test(output),
          };
        },
        { timeout: 5000 },
      )
      .toEqual({ tty: true, size: true, marker: true });

    const joined = manager.getSnapshot(SCOPE_A).lines.join("\n");
    expect(joined).toContain("/dev/tty");
    expect(joined).toContain("32 104");
    expect(joined).toMatch(/\nREAL_MAIN_PTY_OK(?:\n|$)/);

    manager.disposeAll();
  });
});
