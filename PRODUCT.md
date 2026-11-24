# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + React + TypeScript, built and served with `pnpm`. The deliverable is a desktop-sized interactive web prototype with realistic simulated local and remote gateway data, made for hands-on review in a browser.

## Users

Hermes Agent users who run agents on more than one machine: a laptop's local runtime, a homelab box, a VPS over SSH, and Hermes Cloud. They are comfortable with terminals, profiles, MCP servers, Cron, Git, and model routing, but they want a calm desktop surface rather than an admin dashboard. They frequently switch between execution contexts during a working day and cannot afford to confuse a local command with one running on a remote host.

## Product Purpose

Hermes Desktop is a chat-first desktop client for Hermes Agent. It keeps every registered gateway connected, lets the user move between gateways and profiles without losing running work, and exposes every Hermes capability the desktop app supports without letting secondary surfaces crowd the conversation. Success is a screen that feels quiet at rest, makes execution context unmistakable, and still reaches the full fleet and the full toolset in one or two deliberate actions.

## Positioning

One calm conversation surface over a fleet of Hermes gateways. The interface keeps the active `(gateway, profile)` visible as ambient context, while the rest of Hermes — sessions, skills, tools, MCP, memory, Cron, messaging, files, Git, terminals, subagents, voice, and Bot Mode — is disclosed in place instead of being duplicated into permanent panels.

## Operating Context

- Primary review size is a desktop browser at 1440×900 and 1280×800, with keyboard-first operation.
- Chinese is the primary interface language. Technical Hermes terms stay in English: Gateway, Profile, MCP, Skills, Cron, Worktree, Checkpoint, Session.
- The prototype is stateful and realistic, but it is a simulation. It must never imply that a live Hermes daemon, SSH tunnel, or Cloud account is connected.
- The real product's source of truth is the Hermes Agent documentation at `hermes-agent.nousresearch.com/docs`, especially the Desktop, multi-connection desktop, features overview, checkpoints, Skills, Memory, delegation, and Bot Mode pages.

## Capabilities and Constraints

### A. Multi-gateway and profile switching

- Gateway registry with all four kinds: Local (App-managed, non-removable), Remote HTTP(S) (LAN/Tailscale/VPS with session token or OAuth), SSH (managed tunnel plus `hermes gateway attach` / one-use tickets), and Hermes Cloud (Portal-managed).
- Always-connected health and latency indicators, Primary badge, unique device names, duplicate rejection, and a "return to last-used gateway at startup" toggle.
- Live Test with separate HTTP and WebSocket legs and realistic Reachable/Error feedback.
- Add/Edit/Remove connection flow; "Update all instances" fan-out with per-row status, Cloud skipped as platform-managed.
- Fast gateway and profile switcher; All Profiles union view grouped by Gateway & Profile; scoped active `(gateway, profile)`.
- Sessions, channels, Cron, memory, files, MCP and settings re-scope to the active machine.
- Unmistakable ambient execution-context indicator for Local versus Remote, SSH, or Cloud.

### B. Core chat and execution

- Streaming response simulation, Markdown and syntax-highlighted code with copy.
- Collapsible live tool-call rows with inspectable arguments, output, and images.
- Dangerous Command Approval card with exact command and target host, Approve / Deny / Inspect.
- `@` context picker (files, folders, git diff, URLs), `/` slash commands, attachment chips.
- Model and reasoning-effort picker with provider routing, fallback and subagent model summaries.
- Composer prompt history with ↑/↓, session search, pin, and grouping.
- Checkpoints and Rollback snapshot restore.

### C. Capabilities and operations

- Skills: installed toggles, built-in optional catalog, Skills Hub one-click install, Curator status.
- Tools & Toolsets: toolset toggles and approval/safety rules.
- MCP: stdio/HTTP server list, per-server tool filters, live-session hot-reload only on the active gateway.
- Memory & Context: `MEMORY.md`, `USER.md`, `SOUL.md` / personality presets, project context files, external provider status, `/journey` Memory Graph.
- Cron / Heartbeats / Loops: All-profiles aggregation, pause/resume/run-now/history, heartbeat and loop indicators.
- Messaging Channels: Telegram Quick-Setup QR, Discord, Slack, WhatsApp, Signal, Webhooks, plus persistent "Restart gateway now" banner after credential or toggle changes.
- Settings: Model, Workspace, Safety, Memory & Context, Voice, Chat, Gateways, Updates; "Applies to" chip row when two or more profiles exist.

### D. Workspace extensions

- Collapsible side/bottom rail honoring Hide versus Close: Hide keeps terminal scrollback, preview state, and body mounted but inert; Close releases.
- Artifacts and host file browser/preview scoped to the active gateway, with Annotate pin-comment mode that attaches pins to the composer.
- Git review and worktrees: diff viewer, isolated worktree status, commit/PR affordances.
- Live subagents: running delegated workers, inspect, steer, stop.
- Embedded terminal simulated on the active local or remote host; state preserved on Hide.
- Voice Mode / Wake Word with push-to-talk, "Hey Hermes" status, and TTS toggle.
- Bot Mode with a clean Sessions | Bots toggle, union bot roster, Bot Chat, and Routines.

### Constraints

- Default canvas must be genuinely minimalist: generous whitespace, quiet chrome, crisp typography, and clear focus. Never a cluttered admin dashboard.
- Secondary capabilities live behind `⌘K`, compact switchers, focused slide-over drawers, and hideable rails.
- No real network calls, daemon connectivity, SSH tunneling, or credential storage. All sample gateways, sessions, jobs, bots, tools, and files are explicitly labeled prototype simulation.
- PR-only delivery against `whutlichao/hermes-desktop` `main`. Do not merge. Do not add unrelated repository governance files.

## Brand Commitments

- Product name: Hermes Desktop.
- The user's binding direction: ultra-minimalist ("极简") Operate mode, calm and restrained, chat-first, with zero missing Hermes functionality ("但功能不能缺失").
- Local versus remote execution context must always be unmistakable and tastefully ambient.

## Evidence on Hand

- Official Hermes Agent documentation, read from the live site on 2026-11-22: Desktop guide, Connecting Desktop to Many Hermes Instances, Features Overview, Checkpoints & Rollback, Skills, Memory, Subagent Delegation, Bot Mode, and the developer guides for SSH clients and programmatic integration.
- No real Hermes screenshots, customer data, telemetry, credentials, or live gateway endpoints were supplied.
- All demo content must be authored at production fidelity and labeled as synthetic where a reviewer could mistake it for live data.

## Product Principles

1. **Conversation first, everything reachable.** The resting surface is one calm chat; full capability lives one deliberate gesture away.
2. **Context is a safety feature.** Gateway, profile, host, and scope are always readable without stealing attention from the work.
3. **Hide is not close.** Stateful surfaces keep their shells, scrollback, drafts, and preview state mounted until explicitly closed.
4. **The fleet is one workspace.** Switching gateways is instant and never destroys running work; scope changes are explicit, not accidental.
5. **Nothing important is only a color.** Status, scope, and destructive actions carry text and structure, not color alone.

## Accessibility & Inclusion

- Keyboard-first: `⌘K` command palette, `Escape` dismissal, visible focus, arrow-key navigation, and focus return to the invoking control.
- Minimum body text contrast of 4.5:1; status text always paired with a label or glyph.
- No motion essential to comprehension; respect `prefers-reduced-motion`.
- Chinese-first copy with English technical terms, readable at 1280×800 without clipped controls.
