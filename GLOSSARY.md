# Glossary

Canonical domain vocabulary for Hermes Desktop (`whutlichao/hermes-destop`). Use these exact terms in ADRs, specs, issues, types, and tests.

## Core Entities

- **Gateway**: A single reachable Hermes Agent backend instance. Has one of four kinds: `local` (App-managed on this machine, non-removable), `remote` (HTTP(S) over LAN, Tailscale, or internet), `ssh` (reached through a managed SSH tunnel and ticket channel), or `cloud` (Hermes Cloud Portal-managed; deferred past Phase 1). Avoid calling a gateway a "server" or "node" in UI/API names.
- **Profile**: An isolated Hermes Agent configuration/memory/session home served by a Gateway (e.g. `default`, `research`, `ops`). A multiplexing Gateway can serve multiple Profiles over one WebSocket.
- **Scope**: The active `(gatewayId, profileId)` pair that determines which machine and profile receive chat prompts, tool calls, MCP hot-reloads, file/Git/terminal operations, and scoped settings.
- **Primary Gateway**: The designated fallback Gateway in the registry (never removable without falling back to `local`). Controls default startup target unless `launchMode` is `"lastUsed"`.

## Host & Transport Architecture

- **Host Process (Electron Main)**: The privileged Node.js process in Electron that owns all Gateway connections, OS sockets, SSH subprocesses, OAuth loopback servers, and credential files. Never exposes raw tokens or tickets to the Renderer.
- **Renderer**: The sandboxed Vite + React + TypeScript UI process (`contextIsolation: true`, `nodeIntegration: false`). Communicates exclusively through the typed `HostBridge` exposed by Preload.
- **HostBridge**: The typed IPC contract (`window.hermesHost`) separating UI state from transport mechanics. Has two implementations: `ElectronHostBridge` (production desktop) and `MockHostBridge` (browser dev/test mode wrapping prototype simulation).
- **Connection Actor**: The per-Gateway state machine in the Host Process that maintains always-connected liveness, exponential-backoff reconnect, latency measurement, single multiplexed WebSocket, and per-request HTTP authentication.
- **Dual-Leg Probe**: The Gateway `Test` operation that verifies both the HTTP leg (`GET /api/status`) and the WebSocket upgrade leg (`/api/ws`) so proxy/firewall WebSocket blocks are diagnosed accurately.

## Hermes Protocol Contracts

- **Local Control Socket**: The same-OS-user Unix Domain Socket (macOS/Linux) or SID-checked Named Pipe (Windows) exposed by a local Hermes Gateway. Speaks single-request JSON lines (`identify`, `resolve-profile`, `session-ticket`) without spawning Python.
- **Session Ticket**: A short-lived (30s TTL), single-use credential minted by a Gateway's Control Socket or `hermes gateway tickets --serve --json` channel. Scoped by `purpose` (`interactive` for WebSocket, `native-http`, `native-profile-create`, `native-profile-registry` for HTTP) and bound to `instance_id`. Must be sent over loopback with **no `Origin` header**.
- **Native Sign-In (RFC 8252)**: OAuth 2.0 PKCE authentication via the user's real system browser and an ephemeral loopback callback (`127.0.0.1:<port>`), brokered by the Gateway's `/auth/native/*` endpoints whenever `/api/status` advertises `native_pkce`.
- **Shared Registry**: The owner-only (`0600`) files `~/.hermes/gateway-connections.json` (version 2 schema with `revision`) and `~/.hermes/gateway-connection-tokens.json` shared with official Hermes CLI/Webapp/Desktop.
