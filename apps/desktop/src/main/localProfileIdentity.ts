/**
 * Canonical identity and CLI-selector alias seam for local Hermes profiles.
 *
 * Hermes 0.23.3/0.23.4 gateways report filesystem paths (e.g. `~/.hermes` or a sandbox home)
 * as `endpoint.profile_id` and in `profiles.list` (`{ name, path, is_default }`), whereas the
 * Hermes CLI `--profile` flag only accepts logical profile handles such as `"default"` or `"ops"`.
 * Internally the supervisor preserves the Gateway's canonical `profileId` as its primary key while
 * resolving logical CLI handles <-> canonical paths across dialing, health aggregation, and topic
 * routing.
 */

export interface GatewayProfileDescriptor {
  profileId: string;
  handle: string;
  displayName: string;
  isDefault: boolean;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeCliFallback(fallback: string): string {
  return !fallback || isPathLikeProfileId(fallback) ? "default" : fallback.trim();
}

/**
 * Returns true if the given local profile identifier looks like a filesystem path rather than
 * a logical Hermes profile handle.
 */
export function isPathLikeProfileId(profileId: string | undefined | null): boolean {
  const trimmed = asTrimmedString(profileId);
  if (!trimmed) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  );
}

/**
 * Normalizes a filesystem path string used as an alias lookup key (trims whitespace and strips
 * trailing separators while preserving root paths).
 */
export function normalizeProfilePathAliasKey(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length <= 1) return trimmed;
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "") || "/";
}

function normalizeCanonicalLookupKey(profileId: string): string {
  const trimmed = profileId.trim();
  return isPathLikeProfileId(trimmed) ? normalizeProfilePathAliasKey(trimmed) : trimmed;
}

/**
 * Parses a raw Gateway `profiles.list` entry into canonical fields (supporting both
 * `{ profile_id, handle }` and Hermes 0.23.4 `{ name, path, is_default }`).
 */
export function parseGatewayProfileDescriptor(
  raw: Record<string, unknown>,
  fallbackCliHandle = "default",
): GatewayProfileDescriptor | null {
  const name = asTrimmedString(raw.name);
  const rawPid = asTrimmedString(raw.profile_id ?? raw.profileId ?? raw.id ?? raw.path);
  const explicitHandle = asTrimmedString(raw.handle);
  const explicitDisplayName = asTrimmedString(raw.display_name ?? raw.displayName);

  if (!rawPid && !name && !explicitHandle) {
    return null;
  }

  const defaultFlag = raw.is_default ?? raw.isDefault;
  const isDefault =
    typeof defaultFlag === "boolean"
      ? defaultFlag
      : name === "default" || explicitHandle === "default" || rawPid === "default";

  const safeFallbackCli = sanitizeCliFallback(fallbackCliHandle);
  const handle =
    (explicitHandle && !isPathLikeProfileId(explicitHandle) ? explicitHandle : "") ||
    (name && !isPathLikeProfileId(name) ? name : "") ||
    (rawPid && !isPathLikeProfileId(rawPid) ? rawPid : "") ||
    (isDefault ? "default" : safeFallbackCli);

  const profileId = rawPid || handle;
  const displayName = explicitDisplayName || name || handle || profileId;

  return { profileId, handle, displayName, isDefault };
}

/**
 * Maintains the bidirectional mapping between a local profile's canonical Gateway identity
 * (which may be a filesystem path in Hermes 0.23.3/0.23.4) and its CLI `--profile` handle
 * (`"default"`, `"ops"`, etc.).
 */
export class LocalProfileIdentityRegistry {
  private readonly canonicalToCli = new Map<string, string>();
  private readonly cliToCanonical = new Map<string, string>();
  private readonly canonicalByLookupKey = new Map<string, string>();

  registerAlias(
    canonicalProfileId: string | undefined | null,
    cliSelector: string | undefined | null,
  ): void {
    const canonical = asTrimmedString(canonicalProfileId);
    if (!canonical) return;
    const lookupKey = normalizeCanonicalLookupKey(canonical);
    this.canonicalByLookupKey.set(lookupKey, canonical);

    const cli = asTrimmedString(cliSelector);
    if (!cli || isPathLikeProfileId(cli)) {
      return;
    }
    this.canonicalToCli.set(lookupKey, cli);
    this.cliToCanonical.set(cli, canonical);
  }

  /**
   * Resolves any local profile identifier (canonical path or logical handle) into a safe
   * logical CLI `--profile` selector. Never returns a filesystem path.
   */
  resolveCliSelector(
    profileIdOrHandle: string | undefined | null,
    fallback = "default",
  ): string {
    const safeFallback = sanitizeCliFallback(fallback);
    const trimmed = asTrimmedString(profileIdOrHandle);
    if (!trimmed) {
      return safeFallback;
    }
    if (!isPathLikeProfileId(trimmed)) {
      return trimmed;
    }
    return this.canonicalToCli.get(normalizeProfilePathAliasKey(trimmed)) ?? safeFallback;
  }

  /**
   * Resolves a local profile identifier or retired CLI handle alias (e.g. `"default"`) into its
   * registered canonical Gateway `profileId` when known, or preserves the input if not aliased.
   */
  resolveCanonical(
    profileIdOrAlias: string | undefined | null,
    fallback = "default",
  ): string {
    const trimmed = asTrimmedString(profileIdOrAlias);
    if (!trimmed) {
      const fb = asTrimmedString(fallback) || "default";
      if (!isPathLikeProfileId(fb)) {
        return this.cliToCanonical.get(fb) ?? fb;
      }
      return this.canonicalByLookupKey.get(normalizeProfilePathAliasKey(fb)) ?? fb;
    }
    if (!isPathLikeProfileId(trimmed)) {
      return this.cliToCanonical.get(trimmed) ?? trimmed;
    }
    return this.canonicalByLookupKey.get(normalizeProfilePathAliasKey(trimmed)) ?? trimmed;
  }

  /**
   * Parses a raw local Gateway `profiles.list` descriptor and registers its canonical<->handle alias.
   */
  parseGatewayDescriptor(
    raw: Record<string, unknown>,
    fallbackCliHandle = "default",
  ): GatewayProfileDescriptor | null {
    const descriptor = parseGatewayProfileDescriptor(raw, fallbackCliHandle);
    if (!descriptor) return null;

    this.registerAlias(descriptor.profileId, descriptor.handle);
    const rawPath = asTrimmedString(raw.path);
    if (
      rawPath &&
      rawPath !== descriptor.profileId &&
      isPathLikeProfileId(rawPath) &&
      !isPathLikeProfileId(descriptor.handle)
    ) {
      this.canonicalToCli.set(normalizeProfilePathAliasKey(rawPath), descriptor.handle);
    }

    return descriptor;
  }
}
