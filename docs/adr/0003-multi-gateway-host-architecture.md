# ADR-0003: Multi-Gateway Host Architecture & Phase 1 Protocol Scope

- **Status**: Accepted
- **Date**: 2026-11-22

## Context

Hermes Desktop promises an always-connected fleet where switching `(gateway, profile)` is instantaneous and never drops background streaming, tool calls, or pending dangerous-command approvals.

Phase 1 targets **macOS first** and must connect three real Gateway kinds: **Local**, **Remote HTTP(S)**, and **SSH** (**Hermes Cloud** Portal discovery is deferred to Phase 2 while keeping its registry type intact so shared `gateway-connections.json` entries are preserved gracefully).

## Decision

Implement a dedicated **`ConnectionSupervisor` + per-Gateway `ConnectionActor` pool** in Electron Main (`electron/main/gateways/`), speaking real Hermes wire contracts and projecting normalized events to the Renderer over `HostBridge`.

### 1. Per-Gateway `ConnectionActor` Lifecycle

Each registered Gateway runs an independent actor with states:
`disconnected -> probing -> attaching -> connecting -> ready -> degraded | error`

- Dials all registered Gateways concurrently at app startup; retries with capped exponential backoff + jitter on disconnect.
- Maintains **one multiplexed WebSocket** (`/api/ws`, subprotocol `hermes-gateway-v1`) per Gateway whenever the Gateway supports multi-profile `interactive` tickets, so switching Profiles on the same host incurs zero reconnects.
- Keeps background session streams, tool execution rows, and pending approvals (`approval.respond`) active across non-selected Gateways.

### 2. Transport Adapters (Phase 1)

#### A. Local Adapter (`kind: "local"`)
- **Fast path (zero Python spawn)**: Connect to the Gateway's **Local Control Socket** (Unix Domain Socket on macOS) and send 1-request-per-connection JSON lines:
  - `resolve-profile` with normalized absolute `HERMES_HOME` to inspect `state`, `attachable`, `endpoint` (`api_origin`, `profile_id`, `instance_id`, `ws_url`, `code_sha`), and `install_code_sha`.
  - `session-ticket` with `purpose: "interactive"` for WebSocket and `purpose: "native-http" | "native-profile-create" | "native-profile-registry"` for per-request HTTP calls (30s TTL, single-use).
- **Bootstrap / Recovery path**: When `state` is `absent`, crashed, or stale (`code_sha !== install_code_sha`), invoke `hermes gateway attach --start --json` (or bounded `--recover`, 60s timeout), locating `hermes` via login-shell `PATH` + `~/.local/bin/hermes`.
- **Wire rules**: All loopback HTTP requests send `X-Hermes-Gateway-Ticket` with **no `Origin` header**. All loopback WS dials pass subprotocols `["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"]` with **no `Origin` header** and verify the server selects `hermes-gateway-v1`.

#### B. Remote HTTP(S) Adapter (`kind: "remote"`)
- **Discovery**: `GET /api/status` inspects `auth_flows` (`native_pkce`, `cookie`, or static token).
- **Authentication**:
  - **Static Session Token**: Inject `Authorization: Bearer <token>` and configured custom headers in Main.
  - **RFC 8252 Native Sign-In** (default when `native_pkce` is advertised): Bind ephemeral `127.0.0.1:<port>`, open system browser to `/auth/native/authorize` with PKCE `S256` challenge, exchange callback code at `POST /auth/native/token`, persist rotating tokens in `gateway-connection-tokens.json`, and silently refresh via `POST /auth/native/refresh` before expiry.
  - **Legacy Cookie Fallback**: Only when `native_pkce` is absent (or loopback sign-in fails locally), open an isolated Electron `BrowserWindow` login window bound to a per-gateway session partition.
- **Dual-Leg Probe (`Test`)**: Probes both `GET /api/status` (HTTP) and `/api/ws` upgrade (WebSocket), reporting each leg distinctly (e.g., catching reverse proxies that pass HTTP 200 but block WS upgrades).

#### C. SSH Adapter (`kind: "ssh"`)
Follows Hermes's official `Gateway over SSH` client contract using managed system `ssh` child processes (so `~/.ssh/config`, `ProxyJump`, `ssh-agent`, and FIDO keys work natively on macOS):
1. **Binary discovery & Probe**: Run `hermes gateway tickets --probe --json` (probing common remote PATHs like `~/.local/bin/hermes`). Parse `protocol`, `purposes`, and `windows_service_session`.
2. **Attach / Start**:
   - If `windows_service_session === true`: run `hermes gateway attach --json` only (never `--start`); if absent, surface actionable guidance.
   - Otherwise: run `hermes gateway attach --start --json` (allowing up to 60s on first start/update).
3. **Tunnel + Long-Lived Ticket Channel**:
   - Start a single managed SSH forward (`-L 127.0.0.1:<local_port>:127.0.0.1:<remote_port>`) and keep **one long-lived SSH exec channel** running `hermes gateway tickets --serve --json`.
   - Verify the `hello` line's `endpoint.instance_id` matches `attach`; re-attach if replaced.
4. **Per-Request & Multi-Profile Tickets**:
   - Request a fresh HTTP ticket over the open `--serve` channel for every HTTP request (`purpose` + optional `profile`), avoiding per-request SSH exec latency.
   - If `purposes` includes `interactive`, mint an `interactive` WS ticket via `--serve` (serving all remote profiles on one socket); otherwise fall back to the single-profile ticket from `attach`.
   - All forwarded HTTP/WS requests omit `Origin` and obey single-use 30s ticket semantics.

#### D. Cloud Entries (`kind: "cloud"`)
- Phase 1 preserves existing `cloud` entries read from `~/.hermes/gateway-connections.json` (displayed with a "Phase 2 / Cloud Portal pending" badge or reachable via existing saved tokens if present), without implementing Nous Portal discovery yet.

### 3. Core JSON-RPC Protocol (`hermes-gateway-v1`)

Phase 1 binds the core Quiet Relay conversation & scope experience to real `hermes-gateway-v1` JSON-RPC + REST APIs:
- `runtime.describe` (feature/capability negotiation, including `session-client-v1` and `session-list-cursor-v1`)
- `GET /api/profiles` & `GET /api/profiles/active` (profile discovery & scope rebinding)
- `session.list` (`live` + `stored` with cursor), `session.transcript`, `session.create` (with idempotent `request_id` & optional `client: { name: "hermes-desktop-quiet-relay", version }`), `session.resume`
- `prompt.submit` (with `submission_id` & attachments), streaming token/activity/tool-call events, and `approval.respond` (`session_id`, `execution_generation`, `prompt_id`, `choice`)

### 4. Proposed Directory Layout

```text
electron/
  main/
    index.ts                  # App lifecycle, BrowserWindow, macOS menu/titlebar
    ipc.ts                    # Typed ipcMain handlers + event broadcaster
    registry/
      store.ts                # ~/.hermes/gateway-connections.json (v2, atomic 0600, revision, watch)
      tokens.ts               # ~/.hermes/gateway-connection-tokens.json
    gateways/
      supervisor.ts           # Fleet ConnectionSupervisor + always-connected actors
      jsonrpc-client.ts       # hermes-gateway-v1 WS framing, request correlation, reconnect
      adapters/
        local.ts              # Local Control Socket (UDS) + hermes gateway attach --start/--recover
        remote.ts             # HTTP(S) REST/WS + RFC 8252 loopback PKCE + legacy cookie fallback
        ssh.ts                # System ssh -L forward + tickets --probe / attach / tickets --serve
  preload/
    index.ts                  # contextBridge -> window.hermesHost (HostBridge)
src/
  bridge/
    contracts.ts              # Shared HostBridge types & event union
    electron.ts               # Renderer wrapper over window.hermesHost
    mock.ts                   # Prototype MockHostBridge (wraps existing simulation.ts)
```

## Consequences

### Positive
- Eliminates all browser `Origin`/CORS failures and keeps secrets completely out of the Renderer.
- Matches official Hermes Gateway semantics (same control socket, same SSH ticket contract, same RFC 8252 flow, same `hermes-gateway-v1` shared operator sessions so CLI/TUI/Desktop can attach to the same live session).
- Cleanly separates Phase 1 (Electron shell + Local/Remote/SSH real gateways + Core Chat/Approval/Profiles) from Phase 2 (Cloud discovery, full Capabilities/Workspace/Terminal/Git/Subagents/Bot Mode real wiring, packaging/auto-update).

### Negative / Mitigations
- SSH process lifecycle on macOS requires careful cleanup on app quit/crash (track child PIDs, send `SIGTERM` then `SIGKILL` on teardown, use `ServerAliveInterval`/`ExitOnForwardFailure=yes`).
- Exact event names for minor capabilities (Skills/MCP/Cron/Channels/Git/Terminal) vary across Hermes versions; Phase 1 negotiates capabilities via `runtime.describe` and keeps un-wired secondary tabs clearly labeled as fallback/Phase 2 until their real endpoints are bound.
