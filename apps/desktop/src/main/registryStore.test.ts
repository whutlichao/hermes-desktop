import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSandbox, type TestSandbox } from "../../../../tests/helpers/sandbox";
import {
  RegistryStore,
  type RegistryClock,
  type RegistryWatcherDriver,
} from "./registryStore";

class FakeClock implements RegistryClock {
  currentMs = 1_700_000_000_000;
  sleepCalls: number[] = [];
  private nextTimerId = 1;
  private timers = new Map<number, { fireAt: number; fn: () => void }>();

  now(): number {
    return this.currentMs;
  }

  sleepSync(ms: number): void {
    this.sleepCalls.push(ms);
    this.currentMs += ms;
  }

  setTimeout(fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
    const id = this.nextTimerId++;
    this.timers.set(id, { fireAt: this.currentMs + ms, fn });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  advance(ms: number): void {
    const target = this.currentMs + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestTime = Infinity;
      for (const [id, entry] of this.timers.entries()) {
        if (entry.fireAt <= target && entry.fireAt < earliestTime) {
          earliestTime = entry.fireAt;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const entry = this.timers.get(earliestId)!;
      this.timers.delete(earliestId);
      this.currentMs = Math.max(this.currentMs, entry.fireAt);
      entry.fn();
    }
    this.currentMs = target;
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }
}

class FakeWatcher implements RegistryWatcherDriver {
  handlers = new Map<string, () => void>();
  unwatched: string[] = [];

  watchFile(filePath: string, _intervalMs: number, onChange: () => void): void {
    this.handlers.set(filePath, onChange);
  }

  unwatchFile(filePath: string): void {
    this.handlers.delete(filePath);
    this.unwatched.push(filePath);
  }

  trigger(filePath: string): void {
    this.handlers.get(filePath)?.();
  }
}

describe("RegistryStore S3 (mkdtemp isolated filesystem + fake clock/lock)", () => {
  const sandboxes: TestSandbox[] = [];
  const stores: RegistryStore[] = [];

  function makeSandbox(prefix = "hermes-s3-"): TestSandbox {
    const sb = createTestSandbox(prefix);
    sandboxes.push(sb);
    return sb;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
    for (const sb of sandboxes.splice(0)) {
      sb.cleanup(true);
    }
  });

  it("refuses real ~/.hermes, enforces 0700 dir & 0600 files, treats ENOENT as Local-only, and cleans >24h client .tmp only", () => {
    expect(
      () => new RegistryStore({ rootDir: path.join(os.homedir(), ".hermes") }),
    ).toThrow();

    const sb = makeSandbox();
    const rootDir = path.join(sb.hermesHomeDir, "nested-store");
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });

    const clock = new FakeClock();
    const staleTmp = path.join(rootDir, "gateway-connections.json.hd.999.1000.abc.tmp");
    const freshTmp = path.join(rootDir, "gateway-connections.json.hd.999.2000.def.tmp");
    const corruptSidecar = path.join(rootDir, "gateway-connections.json.corrupt-12345");
    const preDropSidecar = path.join(rootDir, "gateway-connections.json.pre-drop-12345.json");
    fs.writeFileSync(staleTmp, "old", { mode: 0o600 });
    fs.writeFileSync(freshTmp, "new", { mode: 0o600 });
    fs.writeFileSync(corruptSidecar, "corrupt", { mode: 0o600 });
    fs.writeFileSync(preDropSidecar, "predrop", { mode: 0o600 });
    // Set staleTmp mtime > 24h ago
    const oldSec = (clock.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleTmp, oldSec, oldSec);

    const store = new RegistryStore({ rootDir, clock });
    stores.push(store);

    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(fs.existsSync(corruptSidecar)).toBe(true);
    expect(fs.existsSync(preDropSidecar)).toBe(true);

    // ENOENT reads as empty store with Local invariant
    const snap = store.snapshot();
    expect(snap.connections).toHaveLength(1);
    expect(snap.connections[0].id).toBe("local");
    expect(snap.connections[0].label).toBe("This device");

    const addRes = store.add({
      kind: "remote",
      label: "Prod",
      url: "https://prod.example.com",
      authMode: "token",
      token: "secret-123",
    });
    expect(addRes.ok).toBe(true);

    // Verify 0700 dir and 0600 files
    const dirMode = fs.statSync(rootDir).mode & 0o777;
    const connMode = fs.statSync(path.join(rootDir, "gateway-connections.json")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(connMode).toBe(0o600);
  });

  it("handles directory lock timeout (3s -> registry_busy + 1x 100ms backoff) and breaks stale lock >10s with double-check", () => {
    const sb = makeSandbox();
    const clock = new FakeClock();
    const store = new RegistryStore({ rootDir: sb.hermesHomeDir, clock });
    stores.push(store);

    const lockDir = path.join(sb.hermesHomeDir, "gateway-connections.json.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, "owner"), "99999-other", { mode: 0o600 });
    // Fresh lock held by another process -> times out after 3000ms + 1x 100ms backoff retry
    const busyRes = store.add({
      kind: "ssh",
      label: "Box",
      host: "box.local",
      user: "dev",
    });
    expect(busyRes.ok).toBe(false);
    if (!busyRes.ok) {
      expect(busyRes.issue.code).toBe("registry_busy");
      expect(busyRes.retryable).toBe(true);
    }
    expect(clock.sleepCalls).toContain(100);

    // Make lock stale (>10s old)
    const staleSec = (clock.now() - 12_000) / 1000;
    fs.utimesSync(lockDir, staleSec, staleSec);

    const okRes = store.add({
      kind: "ssh",
      label: "Box",
      host: "box.local",
      user: "dev",
    });
    expect(okRes.ok).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("rebases concurrent external writes on revision change and emits registry_conflict on same-entry race", () => {
    const sb = makeSandbox();
    const clock = new FakeClock();
    const storeA = new RegistryStore({ rootDir: sb.hermesHomeDir, clock, pid: 1001 });
    const storeB = new RegistryStore({ rootDir: sb.hermesHomeDir, clock, pid: 1002 });
    stores.push(storeA, storeB);

    const r1 = storeA.add({
      kind: "remote",
      label: "Alpha",
      url: "https://alpha.example.com",
    });
    expect(r1.ok).toBe(true);

    // Sync storeB to revision 1
    storeB.refresh();

    // storeA adds Beta and updates Alpha's label
    storeA.add({ kind: "ssh", label: "Beta", host: "beta.local", user: "ops" });
    storeA.update("alpha", {
      kind: "remote",
      label: "Alpha A",
      url: "https://alpha.example.com",
    });

    // storeB (still on stale revision 1) updates Alpha's label too -> rebase + registry_conflict
    const conflictRes = storeB.update("alpha", {
      kind: "remote",
      label: "Alpha B",
      url: "https://alpha.example.com",
    });
    expect(conflictRes.ok).toBe(true);
    if (conflictRes.ok) {
      expect(conflictRes.warnings.some((w) => w.code === "registry_conflict")).toBe(true);
      // Beta added by storeA must NOT be lost!
      expect(conflictRes.snapshot.connections.some((c) => c.id === "beta")).toBe(true);
      expect(conflictRes.snapshot.connections.find((c) => c.id === "alpha")?.label).toBe("Alpha B");
    }
  });

  it("enforces two-file lock order, drops OAuth token on delete/URL/authMode change, preserves on rename/slash/cloud switch, and handles token_sync_failed without rollback", () => {
    const sb = makeSandbox();
    const clock = new FakeClock();
    const tokensPath = path.join(sb.hermesHomeDir, "gateway-connection-tokens.json");

    // Seed unbound & undecrypted entries
    fs.writeFileSync(
      tokensPath,
      JSON.stringify({
        version: 1,
        revision: 1,
        tokens: {},
        unbound: { "https://unbound.example.com": { accessToken: "ub-tok" } },
        undecrypted: { "https://locked.example.com": { encoding: "keychain", data: "cipher" } },
      }),
      { mode: 0o600 },
    );

    const store = new RegistryStore({ rootDir: sb.hermesHomeDir, clock });
    stores.push(store);

    const added = store.add({
      kind: "remote",
      label: "OAuth GW",
      url: "https://oauth.example.com",
      authMode: "oauth",
    });
    expect(added.ok).toBe(true);

    // Main-only writeSecret stores OAuth token bound to semantic URL
    const secRes = store.writeSecret({
      kind: "oauth",
      connectionId: "oauth-gw",
      baseUrl: "https://oauth.example.com",
      tokenSet: { accessToken: "oa-secret-1", refreshToken: "oa-ref-1" },
    });
    expect(secRes.ok).toBe(true);
    expect(store.snapshot().connections.find((c) => c.id === "oauth-gw")?.hasToken).toBe(true);
    expect(JSON.stringify(store.snapshot())).not.toContain("oa-secret-1");

    // Label rename + trailing slash + remote->cloud switch preserves OAuth token!
    const renamed = store.update("oauth-gw", {
      kind: "cloud",
      label: "OAuth GW Renamed",
      url: "HTTPS://OAUTH.EXAMPLE.COM/",
      authMode: "oauth",
    });
    expect(renamed.ok).toBe(true);
    let tokenDoc = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    expect(tokenDoc.tokens["oauth-gw"]).toBeDefined();
    expect(tokenDoc.unbound["https://unbound.example.com"]).toBeDefined();
    expect(tokenDoc.undecrypted["https://locked.example.com"]).toBeDefined();

    // Switching authMode to 'token' drops OAuth token
    const switched = store.update("oauth-gw", {
      kind: "remote",
      label: "OAuth GW Renamed",
      url: "https://oauth.example.com",
      authMode: "token",
    });
    expect(switched.ok).toBe(true);
    tokenDoc = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    expect(tokenDoc.tokens["oauth-gw"]).toBeUndefined();
    // unbound & undecrypted preserved verbatim
    expect(tokenDoc.unbound["https://unbound.example.com"]).toBeDefined();
    expect(tokenDoc.undecrypted["https://locked.example.com"]).toBeDefined();
    expect(fs.statSync(tokensPath).mode & 0o777).toBe(0o600);

    // Simulate token file write failure on URL change -> connection commits, returns token_sync_failed warning (no rollback)
    store.update("oauth-gw", {
      kind: "remote",
      label: "OAuth GW Renamed",
      url: "https://oauth.example.com",
      authMode: "oauth",
    });
    store.writeSecret({
      kind: "oauth",
      connectionId: "oauth-gw",
      baseUrl: "https://oauth.example.com",
      tokenSet: { accessToken: "oa-secret-2" },
    });

    const tokensLockDir = `${tokensPath}.lock`;
    fs.mkdirSync(tokensLockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(tokensLockDir, "owner"), "88888-blocker", { mode: 0o600 });

    const syncFailRes = store.remove("oauth-gw");
    expect(syncFailRes.ok).toBe(true);
    if (syncFailRes.ok) {
      expect(syncFailRes.warnings.some((w) => w.code === "token_sync_failed")).toBe(true);
      // Connection removal was NOT rolled back
      expect(syncFailRes.snapshot.connections.some((c) => c.id === "oauth-gw")).toBe(false);
    }

    // Release token lock and verify next operation reconciles and drops orphaned token
    fs.rmSync(tokensLockDir, { recursive: true, force: true });
    store.setLaunchMode("last-used");
    tokenDoc = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    expect(tokenDoc.tokens["oauth-gw"]).toBeUndefined();
  });

  it("writes 0600 pre-drop sidecar once for unknown fields/future version, refuses write on corrupt/unsupported, and supports explicit backupAndRepair for corrupt only", () => {
    const sb = makeSandbox();
    const clock = new FakeClock();
    const connPath = path.join(sb.hermesHomeDir, "gateway-connections.json");

    // 1. Future version + unknown field
    fs.writeFileSync(
      connPath,
      JSON.stringify({
        version: 5,
        futureTop: true,
        primary: "local",
        connections: [{ id: "local", kind: "local", label: "This device", extraCol: "abc" }],
      }),
      { mode: 0o600 },
    );

    const store = new RegistryStore({ rootDir: sb.hermesHomeDir, clock });
    stores.push(store);
    expect(store.snapshot().issues.some((i) => i.code === "registry_future_version")).toBe(true);

    // First write creates .pre-drop-<ts>.json (0600)
    store.update("local", { kind: "local", label: "MacBook Pro" });
    const filesAfterWrite1 = fs.readdirSync(sb.hermesHomeDir);
    const sidecars1 = filesAfterWrite1.filter((f) => f.startsWith("gateway-connections.json.pre-drop-"));
    expect(sidecars1).toHaveLength(1);
    expect(fs.statSync(path.join(sb.hermesHomeDir, sidecars1[0])).mode & 0o777).toBe(0o600);

    // 2. Corrupt JSON preserves last-known, refuses normal write, and repairs on explicit backupAndRepair
    fs.writeFileSync(connPath, "{ invalid json !!!", { mode: 0o600 });
    const corruptSnap = store.refresh();
    expect(corruptSnap.readOnly).toBe(true);
    expect(corruptSnap.readOnlyReason).toBe("registry_corrupt");
    expect(corruptSnap.connections[0].label).toBe("MacBook Pro"); // preserved last-known

    const blockedWrite = store.add({ kind: "ssh", label: "Fail", host: "x.local", user: "u" });
    expect(blockedWrite.ok).toBe(false);
    if (!blockedWrite.ok) {
      expect(blockedWrite.issue.code).toBe("registry_corrupt");
    }

    const repaired = store.backupAndRepair();
    expect(repaired.ok).toBe(true);
    const corruptBackups = fs
      .readdirSync(sb.hermesHomeDir)
      .filter((f) => f.startsWith("gateway-connections.json.corrupt-"));
    expect(corruptBackups).toHaveLength(1);
    expect(fs.statSync(path.join(sb.hermesHomeDir, corruptBackups[0])).mode & 0o777).toBe(0o600);

    // 3. Unsupported top-level stays read-only even on backupAndRepair
    fs.writeFileSync(connPath, JSON.stringify({ version: 99, connections: "not-an-array" }), {
      mode: 0o600,
    });
    const unsupSnap = store.refresh();
    expect(unsupSnap.readOnly).toBe(true);
    expect(unsupSnap.readOnlyReason).toBe("registry_unsupported");
    const refuseDowngrade = store.backupAndRepair();
    expect(refuseDowngrade.ok).toBe(false);
  });

  it("watches external changes with self-write suppression, 100ms debounce, 3s missing grace (registry_reset), label-only dialMaterialChanged=false, and flush(2000)", async () => {
    const sb = makeSandbox();
    const clock = new FakeClock();
    const watcher = new FakeWatcher();
    const connPath = path.join(sb.hermesHomeDir, "gateway-connections.json");

    const store = new RegistryStore({ rootDir: sb.hermesHomeDir, clock, watcher });
    stores.push(store);
    store.startWatching();

    const events: Array<{ reason: string; dialMaterialChanged: boolean; issueCodes: string[] }> = [];
    store.subscribe((ev) => {
      events.push({
        reason: ev.reason,
        dialMaterialChanged: ev.diff.dialMaterialChanged,
        issueCodes: ev.snapshot.issues.map((i) => i.code),
      });
    });

    // Self-write triggers mutation event, watcher trigger for same content is suppressed
    store.add({ kind: "remote", label: "Prod", url: "https://prod.example.com" });
    expect(events).toHaveLength(1);
    watcher.trigger(connPath);
    clock.advance(200);
    expect(events).toHaveLength(1); // suppressed!

    // External writer renames label ONLY -> debounce 100ms -> dialMaterialChanged: false
    const diskDoc = JSON.parse(fs.readFileSync(connPath, "utf8"));
    diskDoc.revision += 1;
    diskDoc.connections[1].label = "Prod External Rename";
    fs.writeFileSync(connPath, JSON.stringify(diskDoc), { mode: 0o600 });

    watcher.trigger(connPath);
    clock.advance(50);
    expect(events).toHaveLength(1); // still debouncing
    clock.advance(60);
    expect(events).toHaveLength(2);
    expect(events[1].reason).toBe("external_watch");
    expect(events[1].dialMaterialChanged).toBe(false);

    // External deletion -> 3s missing grace before registry_reset; does NOT auto-recreate file
    fs.unlinkSync(connPath);
    watcher.trigger(connPath);
    clock.advance(2000);
    expect(events).toHaveLength(2); // still within 3s grace
    clock.advance(1100);
    expect(events).toHaveLength(3);
    expect(events[2].reason).toBe("reset");
    expect(events[2].issueCodes).toContain("registry_reset");
    expect(fs.existsSync(connPath)).toBe(false);

    // flush(2000) and close() leave zero timers/writes
    const flushed = await store.flush(2000);
    expect(flushed).toEqual({ flushed: true, pending: 0 });
    store.close();
    expect(clock.pendingTimerCount()).toBe(0);
    expect(watcher.unwatched).toContain(connPath);
  });

  it("refuses writes on non-ENOENT read errors (EACCES) and writes=0 on client duplicate", () => {
    const sb = makeSandbox();
    const clock = new FakeClock();
    const connPath = path.join(sb.hermesHomeDir, "gateway-connections.json");
    const tokensPath = path.join(sb.hermesHomeDir, "gateway-connection-tokens.json");

    const store = new RegistryStore({ rootDir: sb.hermesHomeDir, clock });
    stores.push(store);

    store.add({
      kind: "remote",
      label: "Prod",
      url: "https://prod.example.com",
      authMode: "token",
      token: "tok-secret-1",
    });

    const mtimeBeforeDup = fs.statSync(connPath).mtimeMs;
    const dupRes = store.add({
      kind: "remote",
      label: "Prod 2",
      url: "https://PROD.example.com/",
      authMode: "token",
      token: "tok-secret-2",
    });
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) {
      expect(dupRes.issue.code).toBe("duplicate_identity");
    }
    expect(fs.statSync(connPath).mtimeMs).toBe(mtimeBeforeDup);
    expect(fs.existsSync(tokensPath)).toBe(false);

    // EACCES read error preserves last-known and refuses writes
    fs.chmodSync(connPath, 0o000);
    try {
      const snap = store.refresh();
      expect(snap.readOnly).toBe(true);
      expect(snap.readOnlyReason).toBe("registry_unavailable");
      expect(snap.connections.some((c) => c.id === "prod")).toBe(true);

      const blocked = store.setLaunchMode("last-used");
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.issue.code).toBe("registry_unavailable");
      }
    } finally {
      fs.chmodSync(connPath, 0o600);
    }
  });
});
