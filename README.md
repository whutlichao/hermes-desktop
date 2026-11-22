# Hermes Desktop — Quiet Relay prototype

An interactive desktop prototype for **Hermes Desktop**: a chat-first client that moves between a local Hermes runtime and remote Gateways without losing the user's place. This repository contains the review build only. It is a **simulation** and does not connect to a Hermes daemon, SSH tunnel, Cloud account, messaging credential, microphone, or live filesystem.

## Stack

- Vite 6 + React 18 + TypeScript
- `pnpm` for install and scripts
- Vitest for the gateway/scope state store
- Self-hosted Schibsted Grotesk and Spline Sans Mono via `@fontsource`
- No UI component library; the visual system is authored in `src/styles.css`

## Run locally

```sh
pnpm install
pnpm dev
```

Open `http://localhost:4173`. Recommended review sizes are **1440×900** and **1280×800**. This is a desktop Operate surface with a 1120px minimum document width; it is not intended as a mobile layout.

If pnpm 12 reports ignored build scripts for esbuild, approve the one dependency for that install:

```sh
pnpm install --allow-build=esbuild
```

## Verify

```sh
pnpm test             # 8 state/scope tests
pnpm exec tsc --noEmit
pnpm build
pnpm preview          # serves dist at http://localhost:4173
```

The production build currently emits one `>500 kB` chunk warning because the prototype ships fonts, Markdown/highlighting, icons, and the full interactive shell in one entry. The build exits 0; the warning is recorded in `docs/prototype-answer.md`.

## Review states

Append `?demo=<name>` to the preview URL. All demo data is synthetic.

| State | URL | What it shows |
| --- | --- | --- |
| Local chat | `/?demo=local` | Resting Local Gateway conversation, route string, tool rows, approval card |
| Remote context | `/?demo=remote` | Homelab SSH context + gateway/profile switcher |
| Gateway registry | `/?demo=registry` | Settings → Gateways, all four connection kinds, Test/Update all |
| Command palette | `/?demo=palette` | `⌘K` palette with grouped commands and keyboard hints |
| Skills | `/?demo=capabilities` | Capabilities drawer → Skills, Curator, Skills Hub |
| MCP | `/?demo=mcp` | MCP list, tool filters, live-session hot reload |
| Memory | `/?demo=memory` | MEMORY/USER/SOUL editors, project context, provider status |
| Cron | `/?demo=cron` | Scheduled jobs, loops, run history, All Profiles aggregation |
| Channels | `/?demo=channels` | Telegram/Discord cards and the restart-after-credential-change banner |
| Artifacts | `/?demo=workspace` | Artifact preview + Annotate pin mode |
| Terminal | `/?demo=terminal` | Simulated host shell with preserved scrollback |
| Git review | `/?demo=git` | Diff viewer + isolated worktree status |
| Subagents | `/?demo=agents` | Live delegated agents, inspect/steer/stop |
| Bot Mode | `/?demo=bots` | Union bot roster + Bot Chat + Routines |
| Checkpoints | `/?demo=checkpoints` | Session-scoped rollback dialog |
| Memory graph | `/?demo=memory-graph` | `/journey` graph of facts, sources, and session references |
| Settings | `/?demo=settings` | Model settings with the Applies-to profile row |
| All Profiles | `/?demo=all-profiles` | Union session view grouped by Gateway & Profile |

## What is implemented

### A. Multi-gateway and profile switching
Five synthetic Gateways cover Local, Remote HTTP(S), SSH, and Hermes Cloud. The registry supports add/edit/remove, duplicate-name rejection, Primary, Test (HTTP + WS simulation), per-row update status, "Update all", and return-to-last-gateway. The switcher and All Profiles union view re-scope sessions, channels, Cron, MCP, memory, artifacts, files, and settings. A persistent route string and scope line make Local versus Remote/SSH/Cloud execution context explicit.

### B. Chat and execution
Streaming is simulated with a local timer. Responses render Markdown and code with copy. Tool-call rows expand to args, output, and images. Dangerous approvals carry the exact command, target Gateway, profile, and working directory. The composer supports `@` references, `/` commands, attachment chips, model/reasoning selection, prompt history (`↑`/`↓`), and send/stop. Sessions support search, pinning, date grouping, and checkpoints/rollback.

### C. Capabilities and operations
Skills (installed toggles, Curator, Skills Hub), Tools & Toolsets, MCP (stdio/HTTP, filters, guarded hot reload), Memory (`MEMORY.md`, `USER.md`, `SOUL.md`, project context, provider, graph), Cron/Heartbeats/Loops, Channels (including Telegram Quick Setup QR), and Settings all live in focused drawers or dialogs scoped to the selected `(gateway, profile)`.

### D. Workspace extensions
The workspace rail contains Artifacts, Files, Git, Agents, Terminal, and Voice. **Hide** keeps the rail body mounted and inert with terminal scrollback, preview, and annotation state intact. **Close** unmounts the body. Bot Mode adds the union roster, Bot Chat, and Routines.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/state/store.ts` | Pure reducer, scope selectors, gateway registry, approval, checkpoint, workspace semantics |
| `src/state/AppContext.tsx` | React context + demo-state bootstrapping |
| `src/data/seed.ts` | Synthetic gateways, profiles, sessions, tools, capabilities, artifacts |
| `src/components/Chat.tsx` | Conversation, route strip, composer, approvals, streaming |
| `src/components/Sidebar.tsx` | Sessions/Bots navigation, search, pins, union view |
| `src/components/GatewaySwitcher.tsx` | Fast gateway/profile switcher |
| `src/components/Capabilities.tsx` | Skills, Tools, MCP, Memory, Cron, Channels |
| `src/components/Settings.tsx` | Eight settings sections and gateway registry |
| `src/components/Workspace.tsx` | Artifacts, files, Git, subagents, terminal, voice |
| `src/components/CommandPalette.tsx` | `⌘K` keyboard surface |
| `src/components/Overlays.tsx` | Checkpoints, memory graph, QR, shortcuts, toast |

## Design and evidence

- `PRODUCT.md` — product truth, constraints, and feature scope.
- `DESIGN.md` — token-bearing Quiet Relay visual system.
- `.impeccable/design.json` — color ramps, shadows, motion, breakpoints, component snippets.
- `.impeccable/surfaces/desktop-app.md` — direction contract for this surface.
- `docs/prototype-answer.md` — verification logs, feature-parity matrix, and two-axis code review.

## Simulation boundary

Every Gateway health value, latency, SSH attach, Cloud status, Telegram QR, webhook, terminal command, Git diff, file tree, subagent, voice transcript, Cron run, and update result is authored data. Nothing in this prototype performs a real network request or writes to a real Hermes configuration. The interface labels this in the title bar, status bar, drawers, previews, and voice surface.
