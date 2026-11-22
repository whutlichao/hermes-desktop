# ADR-0002: Reuse Shared Hermes Connection Registry (`~/.hermes/gateway-connections.json`)

- **Status**: Accepted
- **Date**: 2026-11-22

## Context

Official Hermes Desktop, Hermes Webapp, and Hermes CLI store multi-gateway connections in owner-only (`0600`) files inside `HERMES_HOME` (default `~/.hermes`):
- `~/.hermes/gateway-connections.json` (version 2 registry: `version`, `primary`, `launchMode`, `lastUsed`, `connections[]`, `revision`, `importedFrom`, `importNotices`)
- `~/.hermes/gateway-connection-tokens.json` (OAuth access/refresh tokens keyed by connection ID)

Users who already configure local, LAN/Tailscale, or SSH gateways in Hermes CLI/Webapp should not have to maintain a duplicate connection list.

## Decision

Directly reuse `~/.hermes/gateway-connections.json` and `~/.hermes/gateway-connection-tokens.json` (honoring `HERMES_HOME` when set) as the single source of truth for the Gateway registry and credentials.

### Coexistence & Safety Contract

1. **Main-Process-Only Access**:
   - Only Electron Main reads or writes these files. Renderer receives sanitized `GatewaySummary` DTOs (`id`, `kind`, `label`, `hostDisplay`, `authMode`, `primary`, `appManaged`, `health`, `latencyMs`) — **never** session tokens, custom secret headers, or OAuth tokens.
2. **Schema Compatibility & Unknown-Field Preservation**:
   - Read and preserve all unknown top-level and per-connection fields (`importedFrom`, `importNotices`, future Hermes keys) on round-trip writes.
   - Maintain uniqueness rules matching Hermes docs: case-insensitive unique `label`; single non-removable `local` entry; deduplicate `remote`/`cloud` on normalized URL; deduplicate `ssh` on normalized `user@host:port` + remote profile.
3. **Atomic Writes, Permissions, and Optimistic `revision`**:
   - Every write uses temp-file-in-same-directory (`0600`) + `fsync` + atomic `rename`, ensuring owner-only `0600` permissions are never weakened.
   - Read current `revision` before mutating, increment `revision` on write, and re-read/merge cleanly if another Hermes process (CLI/Webapp) bumped `revision` concurrently.
4. **Live External Sync**:
   - Watch `gateway-connections.json` (debounced) so connections added/removed via Hermes CLI or Webapp automatically reconcile with the Host Process's `ConnectionSupervisor` pool without restarting the app.
5. **Clean Removal**:
   - Removing a non-local connection tears down its live WebSocket/SSH tunnel, deletes its entry from `gateway-connections.json`, removes its OAuth credentials from `gateway-connection-tokens.json`, and clears any legacy Electron cookie partition for that gateway.

## Consequences

### Positive
- Zero-config migration for existing Hermes users; connections stay synchronized across Hermes Desktop, CLI, and Webapp.
- No custom credential schema to invent or migrate.

### Negative / Mitigations
- Secrets inside `gateway-connection-tokens.json` and `gateway-connections.json` are plaintext protected by OS `0600` file permissions (matching official Hermes Webapp compatibility). We must strictly enforce `0600` mode on create/write, never log file contents or tokens, and never forward raw secrets over IPC.
- Any upstream schema bump (`version > 2`) must fail safely to read-only mode with a clear user-facing notice rather than corrupting the user's shared file.
