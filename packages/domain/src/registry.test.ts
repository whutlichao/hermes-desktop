import { describe, expect, it } from "vitest";
import {
  canonicalSshTarget,
  diffRegistries,
  normalizeRegistryDocument,
  normalizeSemanticUrl,
  projectRegistrySnapshot,
  rebaseRegistry,
  resolveLaunchTarget,
  validateClientAddConnection,
  validateClientRemoveConnection,
  validateClientUpdateConnection,
} from "./registry";

describe("registry domain model: normalization, dedup, local invariant & launch target", () => {
  it("always ensures Local invariant (id:'local', kind:'local') with default label 'This device' and refuses remove('local')", () => {
    const normalized = normalizeRegistryDocument({ version: 2, connections: [] });
    expect(normalized.doc.version).toBe(2);
    expect(normalized.doc.connections).toHaveLength(1);
    expect(normalized.doc.connections[0]).toEqual({
      id: "local",
      kind: "local",
      label: "This device",
    });
    expect(normalized.doc.primary).toBe("local");
    expect(normalized.doc.launchMode).toBe("primary");

    const removal = validateClientRemoveConnection(normalized.doc, "local");
    expect(removal).toEqual({
      ok: false,
      issue: {
        code: "local_not_removable",
        severity: "warning",
        connectionId: "local",
        messageKey: "registry.issue.localNotRemovable",
      },
    });
  });

  it("normalizes semantic URLs and SSH targets canonically", () => {
    expect(normalizeSemanticUrl("  HTTPS://Gateway.Example.COM:443/api/  ")).toBe(
      "https://gateway.example.com/api",
    );
    expect(normalizeSemanticUrl("http://User:Secret@homelab.local:8080/")).toBe(
      "http://homelab.local:8080",
    );
    expect(normalizeSemanticUrl("javascript:alert(1)")).toBeNull();

    expect(
      canonicalSshTarget({
        host: "  Box.Local ",
        user: " Alice ",
        port: 22,
        remoteProfile: " work ",
      }),
    ).toBe("alice@box.local:22::work");

    expect(
      canonicalSshTarget({
        host: "box.local",
        user: "alice",
      }),
    ).toBe("alice@box.local:22::");
  });

  it("assigns unique case-insensitive labels (max 64, suffix ' 2'/' 3') for external entries and keeps canonical first duplicate only", () => {
    const normalized = normalizeRegistryDocument({
      version: 2,
      connections: [
        { id: "local", kind: "local", label: "This device" },
        {
          id: "r1",
          kind: "remote",
          label: "Prod Gateway",
          url: "https://prod.example.com/",
          authMode: "token",
          token: "sk-secret-1",
        },
        {
          id: "r2",
          kind: "cloud",
          label: "prod gateway",
          url: "HTTPS://PROD.EXAMPLE.COM",
          authMode: "oauth",
        },
        {
          id: "s1",
          kind: "ssh",
          label: "Homelab",
          host: "lab.local",
          user: "ubuntu",
          port: 22,
        },
        {
          id: "s2",
          kind: "ssh",
          label: "A".repeat(64),
          host: "lab.local",
          user: "UBUNTU",
          remoteProfile: "",
        },
        {
          id: "s3",
          kind: "ssh",
          label: "a".repeat(64),
          host: "other.local",
          user: "ubuntu",
          port: 2222,
        },
      ],
    });

    // External duplicates are NOT deleted; first valid is canonical (dialable), duplicates marked registry_invalid
    const r1 = normalized.doc.connections.find((c) => c.id === "r1")!;
    const r2 = normalized.doc.connections.find((c) => c.id === "r2")!;
    const s1 = normalized.doc.connections.find((c) => c.id === "s1")!;
    const s3 = normalized.doc.connections.find((c) => c.id === "s3")!;

    expect(r1.label).toBe("Prod Gateway");
    expect(r2.label).toBe("prod gateway 2");
    expect(s3.label.length).toBeLessThanOrEqual(64);
    expect(s3.label.endsWith(" 2")).toBe(true);

    expect(s1.port).toBeUndefined(); // port 22 omitted on disk

    const view = projectRegistrySnapshot(normalized, { oauthTokenIds: new Set(["r2"]) });
    // Display projection NEVER leaks secret bytes
    expect(JSON.stringify(view)).not.toContain("sk-secret-1");

    const r1View = view.connections.find((c) => c.id === "r1")!;
    const r2View = view.connections.find((c) => c.id === "r2")!;
    const s1View = view.connections.find((c) => c.id === "s1")!;
    const s2View = view.connections.find((c) => c.id === "s2")!;
    const s3View = view.connections.find((c) => c.id === "s3")!;

    expect(r1View.dialable).toBe(true);
    expect(r1View.hasToken).toBe(true);
    expect(r2View.dialable).toBe(false);
    expect(r2View.duplicateOfId).toBe("r1");
    expect(s1View.dialable).toBe(true);
    expect(s2View.dialable).toBe(false);
    expect(s2View.duplicateOfId).toBe("s1");
    expect(s3View.dialable).toBe(true);

    const dupIssues = view.issues.filter((i) => i.code === "registry_invalid");
    expect(dupIssues).toHaveLength(2);
    expect(dupIssues.map((i) => i.connectionId)).toEqual(["r2", "s2"]);
  });

  it("rejects client-initiated duplicate_identity and duplicate_label with display-safe existing summary", () => {
    const normalized = normalizeRegistryDocument({
      version: 2,
      connections: [
        { id: "local", kind: "local", label: "This device" },
        {
          id: "prod",
          kind: "remote",
          label: "Prod",
          url: "https://prod.example.com",
          authMode: "token",
          token: { encoding: "plain", value: "super-secret-xyz" },
        },
        {
          id: "lab",
          kind: "ssh",
          label: "Lab Box",
          host: "lab.internal",
          user: "dev",
        },
      ],
    });

    const dupIdentity = validateClientAddConnection(normalized.doc, {
      kind: "cloud",
      label: "Prod Mirror",
      url: "https://PROD.example.com/",
      authMode: "oauth",
    });
    expect(dupIdentity.ok).toBe(false);
    if (!dupIdentity.ok) {
      expect(dupIdentity.issue.code).toBe("duplicate_identity");
      expect(dupIdentity.conflict).toEqual({
        conflictKind: "duplicate_identity",
        existing: {
          id: "prod",
          label: "Prod",
          kind: "remote",
          hostDisplay: "https://prod.example.com",
          hasToken: true,
        },
      });
      expect(JSON.stringify(dupIdentity)).not.toContain("super-secret-xyz");
    }

    const dupLabel = validateClientUpdateConnection(normalized.doc, "lab", {
      kind: "ssh",
      label: "  prod ",
      host: "lab.internal",
      user: "dev",
    });
    expect(dupLabel.ok).toBe(false);
    if (!dupLabel.ok) {
      expect(dupLabel.issue.code).toBe("duplicate_label");
      expect(dupLabel.conflict?.existing.id).toBe("prod");
    }
  });

  it("quarantines malformed entries (max 20) and detects unknown fields / future version / unsupported top-level", () => {
    const future = normalizeRegistryDocument({
      version: 5,
      extraTop: "future",
      connections: [
        { id: "local", kind: "local", label: "This device", futureField: 123 },
        { id: "bad-remote", kind: "remote", label: "Broken" }, // missing URL -> quarantined
      ],
    });

    expect(future.unsupported).toBe(false);
    expect(future.hadFutureVersionOrUnknownFields).toBe(true);
    expect(future.doc.version).toBe(2);
    expect(future.doc.quarantined).toHaveLength(1);
    expect(future.issues.some((i) => i.code === "registry_future_version")).toBe(true);

    const unsupportedNonArray = normalizeRegistryDocument({
      version: 2,
      connections: { not: "an-array" },
    });
    expect(unsupportedNonArray.unsupported).toBe(true);
    expect(unsupportedNonArray.issues[0]?.code).toBe("registry_unsupported");

    const unsupportedUnknownTop = normalizeRegistryDocument({ foo: "bar" });
    expect(unsupportedUnknownTop.unsupported).toBe(true);
  });

  it("resolves startup launch target strictly: valid last-used -> Primary -> Local -> empty", () => {
    const base = normalizeRegistryDocument({
      version: 2,
      primary: "prod",
      launchMode: "last-used",
      lastUsed: "lab",
      connections: [
        { id: "local", kind: "local", label: "This device" },
        { id: "prod", kind: "remote", label: "Prod", url: "https://prod.example.com" },
        { id: "lab", kind: "ssh", label: "Lab", host: "lab.local", user: "dev" },
      ],
    });

    expect(resolveLaunchTarget(base.doc, base.duplicateIds)).toEqual({
      connectionId: "lab",
      reason: "last_used",
      launchMode: "last-used",
    });

    // When lastUsed is missing/invalid, falls back to primary
    const noLastUsed = { ...base.doc, lastUsed: "missing-id" };
    expect(resolveLaunchTarget(noLastUsed, base.duplicateIds)).toEqual({
      connectionId: "prod",
      reason: "primary",
      launchMode: "last-used",
    });

    // When launchMode is 'primary', ignores lastUsed and uses primary
    const primaryMode = { ...base.doc, launchMode: "primary" as const };
    expect(resolveLaunchTarget(primaryMode, base.duplicateIds)).toEqual({
      connectionId: "prod",
      reason: "primary",
      launchMode: "primary",
    });

    // When primary is also missing, falls back to local
    const fallbackLocal = { ...primaryMode, primary: "missing-primary" };
    expect(resolveLaunchTarget(fallbackLocal, base.duplicateIds)).toEqual({
      connectionId: "local",
      reason: "local",
      launchMode: "primary",
    });

    // When no dialable connections exist, returns empty
    expect(
      resolveLaunchTarget(
        { primary: "missing", launchMode: "primary", connections: [] },
        new Set(),
      ),
    ).toEqual({
      connectionId: null,
      reason: "empty",
      launchMode: "primary",
    });
  });
});

describe("registry domain model: rebaseRegistry & diffRegistries", () => {
  it("rebases concurrent writes: upsert, delete wins, scalar only if changed locally, importedFrom union, overflow append, and registry_conflict", () => {
    const base = normalizeRegistryDocument({
      version: 2,
      revision: 3,
      primary: "local",
      launchMode: "primary",
      lastUsed: "a",
      importedFrom: { "/userData/a": { at: 100 } },
      importNotices: ["notice-1"],
      quarantined: Array.from({ length: 19 }, (_, i) => ({ bad: i })),
      connections: [
        { id: "local", kind: "local", label: "This device" },
        { id: "a", kind: "remote", label: "Alpha", url: "https://a.example.com" },
        { id: "b", kind: "remote", label: "Beta", url: "https://b.example.com" },
      ],
    }).doc;

    // Local process: deletes 'b', updates 'a' label, adds 'c', changes launchMode to 'last-used', adds importedFrom '/userData/b'
    const next = {
      ...base,
      launchMode: "last-used" as const,
      importedFrom: { "/userData/a": { at: 100 }, "/userData/b": { at: 200 } },
      importNotices: ["notice-1", "notice-2"],
      connections: [
        base.connections[0],
        { ...base.connections[1], label: "Alpha Local" },
        { id: "c", kind: "remote" as const, label: "Gamma", url: "https://c.example.com" },
      ],
    };

    // Disk concurrently: updated 'a' url (conflict with our label change!), updated 'b' (we deleted it -> delete wins),
    // added 'd', changed primary to 'd', added 3 quarantined items (exceeding 20 -> overflow)
    const disk = normalizeRegistryDocument({
      version: 2,
      revision: 4,
      primary: "d",
      launchMode: "primary",
      lastUsed: "a",
      importedFrom: { "/userData/a": { at: 100 }, "/userData/disk": { at: 150 } },
      importNotices: ["notice-disk"],
      quarantined: Array.from({ length: 20 }, (_, i) => ({ bad: i })),
      quarantinedOverflow: [{ bad: 99 }],
      connections: [
        { id: "local", kind: "local", label: "This device" },
        { id: "a", kind: "remote", label: "Alpha Disk", url: "https://a-disk.example.com" },
        { id: "b", kind: "remote", label: "Beta Disk", url: "https://b-disk.example.com" },
        { id: "d", kind: "ssh", label: "Delta", host: "delta.local", user: "ops" },
      ],
    }).doc;

    const rebased = rebaseRegistry(base, { ...next, quarantined: [...(base.quarantined ?? []), { bad: 101 }, { bad: 102 }] }, disk);

    expect(rebased.doc.revision).toBe(5);
    // 'b' was deleted by us -> delete wins, not resurrected
    expect(rebased.doc.connections.some((c) => c.id === "b")).toBe(false);
    // 'c' added by us & 'd' added by disk both exist
    expect(rebased.doc.connections.some((c) => c.id === "c")).toBe(true);
    expect(rebased.doc.connections.some((c) => c.id === "d")).toBe(true);
    // 'a' modified by both -> last-writer-wins (next wins) + registry_conflict
    expect(rebased.doc.connections.find((c) => c.id === "a")?.label).toBe("Alpha Local");
    expect(rebased.conflicts.some((c) => c.code === "registry_conflict" && c.connectionId === "a")).toBe(true);
    // Scalar: primary was NOT changed by us, so disk's 'd' is preserved; launchMode WAS changed by us, so 'last-used' wins
    expect(rebased.doc.primary).toBe("d");
    expect(rebased.doc.launchMode).toBe("last-used");
    // importedFrom union
    expect(Object.keys(rebased.doc.importedFrom ?? {}).sort()).toEqual([
      "/userData/a",
      "/userData/b",
      "/userData/disk",
    ]);
    // quarantined capped at 20 and overflow appended
    expect(rebased.doc.quarantined).toHaveLength(20);
    expect((rebased.doc.quarantinedOverflow ?? []).length).toBeGreaterThan(1);
    // importNotices recomputed
    expect(rebased.doc.importNotices).toEqual(expect.arrayContaining(["notice-1", "notice-2", "notice-disk"]));
  });

  it("computes typed RegistryDiff: label-only sets dialMaterialChanged=false while endpoint/secret/removal sets dialMaterialChanged=true", () => {
    const prev = normalizeRegistryDocument({
      version: 2,
      primary: "local",
      launchMode: "primary",
      connections: [
        { id: "local", kind: "local", label: "This device" },
        { id: "prod", kind: "remote", label: "Prod", url: "https://prod.example.com", authMode: "token", token: "tok-1" },
      ],
    });

    const labelOnly = normalizeRegistryDocument({
      version: 2,
      primary: "local",
      launchMode: "primary",
      connections: [
        { id: "local", kind: "local", label: "This device" },
        { id: "prod", kind: "remote", label: "Prod Renamed", url: "https://prod.example.com", authMode: "token", token: "tok-1" },
      ],
    });

    const labelDiff = diffRegistries(prev, labelOnly);
    expect(labelDiff.dialMaterialChanged).toBe(false);
    expect(labelDiff.changes).toEqual([
      { kind: "connection_updated", connectionId: "prod", dialMaterialChanged: false },
    ]);

    const secretChanged = normalizeRegistryDocument({
      version: 2,
      primary: "prod",
      launchMode: "primary",
      connections: [
        { id: "local", kind: "local", label: "This device" },
        { id: "prod", kind: "remote", label: "Prod Renamed", url: "https://prod.example.com", authMode: "token", token: "tok-2" },
        { id: "ssh-1", kind: "ssh", label: "Lab", host: "lab.local", user: "dev" },
      ],
    });

    const materialDiff = diffRegistries(labelOnly, secretChanged, { credentialsChanged: true });
    expect(materialDiff.dialMaterialChanged).toBe(true);
    expect(materialDiff.primaryChanged).toBe(true);
    expect(materialDiff.credentialsChanged).toBe(true);
    expect(materialDiff.changes).toEqual([
      { kind: "connection_updated", connectionId: "prod", dialMaterialChanged: true },
      { kind: "connection_added", connectionId: "ssh-1", dialMaterialChanged: true },
    ]);
    // Zero secret bytes in diff
    expect(JSON.stringify(materialDiff)).not.toContain("tok-1");
    expect(JSON.stringify(materialDiff)).not.toContain("tok-2");
  });
});

