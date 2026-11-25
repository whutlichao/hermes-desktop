import { describe, expect, it } from "vitest";
import {
  LocalProfileIdentityRegistry,
  isPathLikeProfileId,
  normalizeProfilePathAliasKey,
} from "./localProfileIdentity";

describe("localProfileIdentity (Option B canonical <-> CLI handle seam)", () => {
  it("detects POSIX, Windows, tilde, and relative path-like profile IDs", () => {
    expect(isPathLikeProfileId("/Users/apple/.hermes")).toBe(true);
    expect(isPathLikeProfileId("~/.hermes")).toBe(true);
    expect(isPathLikeProfileId("C:\\Users\\apple\\.hermes")).toBe(true);
    expect(isPathLikeProfileId("profiles/ops")).toBe(true);
    expect(isPathLikeProfileId("default")).toBe(false);
    expect(isPathLikeProfileId("ops")).toBe(false);
    expect(isPathLikeProfileId("")).toBe(false);
  });

  it("normalizes path lookup keys without stripping root slash", () => {
    expect(normalizeProfilePathAliasKey("/Users/apple/.hermes/")).toBe("/Users/apple/.hermes");
    expect(normalizeProfilePathAliasKey("/")).toBe("/");
    expect(normalizeProfilePathAliasKey("C:\\")).toBe("C:\\");
  });

  it("preserves canonical profileId as primary key while never emitting a path CLI selector", () => {
    const registry = new LocalProfileIdentityRegistry();
    const homePath = "/Users/apple/.hermes";
    const opsPath = "/Users/apple/.hermes/profiles/ops";

    // Cold start before handshake: unknown path must never be passed as a CLI selector
    expect(registry.resolveCliSelector(homePath)).toBe("default");
    expect(registry.resolveCliSelector("default")).toBe("default");
    expect(registry.resolveCliSelector("ops")).toBe("ops");
    expect(registry.resolveCanonical("default")).toBe("default");

    // Register aliases discovered from endpoint.profile_id / profiles.list
    registry.registerAlias(homePath, "default");
    registry.registerAlias(opsPath, "ops");

    // Canonical direction: logical handle <-> canonical path
    expect(registry.resolveCanonical("default")).toBe(homePath);
    expect(registry.resolveCanonical(`${homePath}/`)).toBe(homePath);
    expect(registry.resolveCanonical("ops")).toBe(opsPath);

    // CLI selector direction: canonical path -> logical handle
    expect(registry.resolveCliSelector(homePath)).toBe("default");
    expect(registry.resolveCliSelector(`${homePath}/`)).toBe("default");
    expect(registry.resolveCliSelector(opsPath)).toBe("ops");
  });

  it("parses Hermes 0.23.4 profiles.list descriptors keeping canonical path while mapping handle", () => {
    const registry = new LocalProfileIdentityRegistry();
    const homePath = "/var/folders/sandbox/.hermes";
    const parsed = registry.parseGatewayDescriptor({
      name: "default",
      path: homePath,
      is_default: true,
    });

    expect(parsed).toEqual({
      profileId: homePath,
      handle: "default",
      displayName: "default",
      isDefault: true,
    });
    expect(registry.resolveCanonical("default")).toBe(homePath);
    expect(registry.resolveCliSelector(homePath)).toBe("default");
  });
});
