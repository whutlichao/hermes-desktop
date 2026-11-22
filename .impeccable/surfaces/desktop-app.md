# Surface: Hermes Desktop — Operate

## Scope and mode

Primary target: the desktop application shell rendered at 1440×900 and 1280×800 in a browser. Mode: Operate. The user is here to run and supervise Hermes work, not to be persuaded or entertained.

## Audience, job, and action

Audience: Hermes users who run agents on a local machine and on remote gateways. Job: keep a calm conversation in focus while making execution context, fleet health, and the full tool surface reachable without ambiguity. Primary action: send a prompt, approve or reject a dangerous command, or switch execution context deliberately.

Proof and content: five synthetic gateways spanning Local, Remote HTTP(S), SSH, and Hermes Cloud; scoped sessions, channels, Cron, MCP, memory, files, and settings; realistic chat and tool-call traces. Every simulated value is labeled. Constraints: no live network, SSH, Cloud, Telegram, microphone, or credential operations; Chinese-first copy with English Hermes terms; PR-only delivery.

## Chosen direction

**Quiet Relay.** A paper-and-ink operating surface for work that travels between machines. The signature is the persistent `YOU → HOMELAB → @research` route string: execution context is read as a relay route, not a colored badge. Postal vermilion marks the active leg and the rare destructive threshold. Secondary capability lives behind `⌘K`, a compact gateway switcher, focused slide-over drawers, and a Hide/Close workspace rail.

Memorable moment: switching gateway changes the route, re-scopes the work, and lands as a quiet toast while the conversation column stays still.

## Direction contract

**THESIS:** One calm conversation over a fleet, with execution context carried as an always-readable relay route. It refuses the permanent admin dashboard and the gateway-pill-plus-status-grid arrangement.

**OWN-WORLD:** Paper white `#f7f7f5`, raised paper `#fbfbf8`, ink `#16181b`, and postal vermilion `#c8442e` on hairline `#e2e2db`. Schibsted Grotesk for Latin display and body; Spline Sans Mono for technical labels, measurements, and code; PingFang SC for Chinese. Small radii, one-pixel rules, circled status marks, and route lines with arrowheads.

**STORY:** The user understands which machine will execute the next action, which profile owns the workspace, and what is running; believes that switching hosts will not destroy work; and opens only the surface needed for the task.

**FIRST VIEWPORT:** A 232px session rail, a centered 720px conversation column, and a quiet 40px execution strip. The message stream is the focal plane; the composer sits at its foot with model, reasoning, attachment, and context controls. The workspace rail is closed at rest. At 1280px the rail narrows to 220px, the workspace rail to 420px when open, and the route latency label hides before any control clips.

**FORM:** Quiet Relay, second of three self-authored grounded directions (Quiet Relay, Meridian, Signal Yellow), chosen by the user after a visual comparison; this was a user-selected direction, not a dealt concept-seed assignment. The concept-seed round is referenced as `seed:656fc4c4345c1029`.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved decisions

- No real Hermes daemon, SSH tunnel, Cloud account, or messaging credential is connected. Review is visual and interactional only.
- A production desktop shell would add native window chrome, keychain storage, and update signing; this prototype stops at the browser shell.
