# ADR-0001: Electron Desktop Shell (macOS-First)

- **Status**: Accepted
- **Date**: 2026-11-22

## Context

Hermes Desktop is a minimalist, chat-first desktop client ("Quiet Relay") over a fleet of always-connected Hermes Gateways. We already have a verified interactive Vite + React 18 + TypeScript prototype in `src/`.

Real Hermes Gateway protocols require a privileged native host layer because:
1. Local and SSH-forwarded Gateways reject any HTTP request or WebSocket upgrade that carries an `Origin` header (`401`).
2. Credentials (session tokens, OAuth refresh tokens, single-use 30s tickets) must never enter the Renderer process.
3. The app must speak Unix Domain Sockets (Local Control Socket), supervise OpenSSH child processes (`-L` tunnels + long-lived `tickets --serve` channels), and bind ephemeral loopback listeners for RFC 8252 OAuth callbacks.

We evaluated Tauri 2 (Rust host + system WebView), Electron (Node.js Main + Chromium), and pure native rewrites (SwiftUI/GPUI).

## Decision

Adopt **Electron** as the desktop shell, targeting **macOS first** while keeping platform abstractions clean for future Windows/Linux packaging.

### Key Architectural Rules

1. **Full-Stack TypeScript Monorepo**:
   - Renderer stays in `src/` (existing Vite + React + TS codebase).
   - Main process lives in `electron/main/`, Preload in `electron/preload/`, and shared IPC/domain contracts in `src/shared/` (or `src/bridge/contracts.ts`).
2. **Strict Process Security Boundary**:
   - `BrowserWindow` MUST run with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
   - Preload exposes only a minimal, strongly typed `window.hermesHost` (`HostBridge`) via `contextBridge.exposeInMainWorld`.
   - Renderer NEVER receives token bytes, ticket strings, cookie jars, or arbitrary shell/filesystem access.
3. **Transport-Agnostic UI (`HostBridge`)**:
   - All UI components and reducers talk to `HostBridge`, never to `electron` directly.
   - `MockHostBridge` remains available so browser dev (`pnpm dev`) and Vitest unit tests keep working without launching Electron.
4. **macOS-First Native Ergonomics**:
   - Frameless/integrated titlebar (`titleBarStyle: 'hiddenInset'`) aligned with Quiet Relay's 40px top route bar and traffic-light safe inset.
   - Native macOS menu, `⌘K` / `⌘,` shortcuts, system notifications for background dangerous-command approvals, and proper quit/hide lifecycle.
   - Legacy Cookie-only remote gateways can fall back to an isolated Electron `BrowserWindow` + `session.cookies` when `native_pkce` is absent.

## Consequences

### Positive
- 100% reuse of the Quiet Relay Vite + React + TS prototype and shared TypeScript types across Main and Renderer.
- Fastest iteration velocity and 1:1 runtime parity with official Hermes Desktop (Chromium rendering, `BrowserWindow` legacy OAuth fallback, Web Media/Voice APIs, HTML artifact rendering).
- Native Node.js `net` (Unix Domain Socket), `child_process` (system OpenSSH), `http`/`undici` (no-`Origin` requests), and `ws` (no-`Origin` WebSockets with custom subprotocols).

### Negative / Mitigations
- Larger binary and higher baseline RAM (~200 MB) than Tauri. Mitigate by keeping a single renderer window, lazy-loading heavy secondary drawers (code splitting the current 545 kB bundle), and running zero unnecessary background Chromium processes.
- macOS code-signing/notarization will be required before public distribution (deferred past Phase 1 local/dev builds).
