---
name: Hermes Desktop
description: A paper-and-ink relay surface for one calm conversation across a fleet of Hermes gateways.
colors:
  paper: "#f7f7f5"
  paper-raised: "#fbfbf8"
  paper-deep: "#f1f1ed"
  sidebar: "#f3f3ef"
  surface: "#ffffff"
  ink: "#16181b"
  ink-soft: "#30343a"
  muted: "#555a61"
  faint: "#676c73"
  line: "#e2e2db"
  line-strong: "#c9c9c1"
  postal-vermilion: "#c8442e"
  postal-vermilion-text: "#a73826"
  postal-vermilion-soft: "#faede8"
  danger: "#9e2d1e"
  scrim: "rgb(22 24 27 / 32%)"
  ok: "#376d4a"
  warn: "#8a6215"
typography:
  display:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "34px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "23px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0em"
  control:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0em"
  label:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  status:
    fontFamily: "Schibsted Grotesk, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "9px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  code:
    fontFamily: "Spline Sans Mono, SFMono-Regular, Cascadia Mono, monospace"
    fontSize: "7.5px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0em"
rounded:
  xs: "2px"
  sm: "3px"
  md: "5px"
  lg: "7px"
  xl: "9px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  md-plus: "10px"
  lg: "12px"
  lg-plus: "14px"
  xl: "16px"
  xl-plus: "18px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
    typography: "{typography.control}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
    typography: "{typography.control}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
    typography: "{typography.control}"
  input-composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "8px 9px 7px"
    typography: "{typography.body}"
  chip-route:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
    typography: "{typography.control}"
  chip-status:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
    height: "20px"
    typography: "{typography.status}"
  toggle-switch:
    backgroundColor: "{colors.line-strong}"
    rounded: "{rounded.pill}"
    width: "28px"
    height: "16px"
  gateway-row:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    typography: "{typography.control}"
  palette-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 9px"
    typography: "{typography.control}"
  card-approval:
    backgroundColor: "{colors.postal-vermilion-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "9px 10px"
---

# Design System: Hermes Desktop

## Overview

**Creative North Star: "The Quiet Relay"**

Hermes Desktop is a paper-and-ink operating surface for work that moves between machines. The conversation is the page; everything else waits in the margins. A persistent route string — `YOU → HOMELAB → @research` — carries execution context as a path, not a badge, so the user can read where the next command will land without scanning a dashboard.

The visual world borrows from postal routing slips, dispatch dockets, and technical documentation: thin rules, small measured labels, circled handoff marks, and one postal vermilion accent reserved for the active leg, focus, and the destructive threshold. The interface is dense in capability but quiet in composition. Secondary surfaces slide over the conversation; they do not permanently divide it.

**Key Characteristics:**
- Paper-white field, near-black ink, and a single vermilion routing accent.
- A 720px conversation column that stays visually still while scope changes.
- Hairline structure, small radii, and almost no resting shadow.
- Measurements and machine values set in Spline Sans Mono; navigation, meta, role, and capability labels stay in Schibsted Grotesk.
- Local versus remote context readable in text at every width.

## Colors

The palette is a warm-neutral paper stack with one high-chroma routing ink. Status colors are muted and always paired with a word or glyph.

### Primary
- **Postal Vermilion** (#c8442e): The active route leg, focus rings, annotation pins, and one selected-state marker. It is a routing signal, not a general-purpose brand wash.
- **Vermilion Ink** (#a73826): Text-adjacent accent for links, active latency, and small labels on paper.
- **Vermilion Wash** (#faede8): Approval-card ground and selected annotation surfaces.

### Neutral
- **Paper** (#f7f7f5): The main application field.
- **Raised Paper** (#fbfbf8): Drawer headers, popovers, and rows that need one step of separation.
- **Deep Paper** (#f1f1ed): Sidebar and inset metadata wells.
- **Pure Surface** (#ffffff): Composer, focused inputs, and preview canvas.
- **Ink** (#16181b): Primary text and the primary action ground.
- **Soft Ink** (#30343a): Dense body copy and command names.
- **Muted Ink** (#555a61): Secondary copy and inactive controls.
- **Faint Ink** (#676c73): Metadata that must still clear 4.5:1 on paper.
- **Hairline** (#e2e2db): Structural rules and card borders.
- **Strong Hairline** (#c9c9c1): Control borders and the composer edge.
- **Scrim** (rgb(22 24 27 / 32%)): Modal and drawer overlay; the only translucent neutral.

### Status
- **Route Green** (#376d4a, `--status-ready`): Reachable, ready, and completed states.
- **Custody Amber** (#8a6215, `--status-connecting`): Degraded, pending, or update-ready states.
- **Seal Red** (#9e2d1e, `--status-blocked`, `--danger`): Errors and destructive confirmation.

### Named Rules
**The Postal Red Rule.** Vermilion occupies less than ten percent of any screen. If it starts filling surfaces, the route has stopped being a signal.

**The One Ground Rule.** Paper is the ground; white is a raised working surface. Do not invert the two or introduce a third background family.

## Typography

**Display Font:** Schibsted Grotesk (with PingFang SC for Chinese)
**Body Font:** Schibsted Grotesk (with PingFang SC, Hiragino Sans GB, Microsoft YaHei)
**Label Font:** Schibsted Grotesk (with PingFang SC for Chinese)
**Mono Font:** Spline Sans Mono (with SFMono-Regular, Cascadia Mono)

**Character:** Schibsted Grotesk gives the interface a compact, unsentimental Nordic calm; Spline Sans Mono reads as measurement and machine address, not as a costume. Chinese copy falls back to the platform's clean sans while technical English terms keep their Latin letterforms.

### Hierarchy
- **Display** (500, 34px, 1.15, -0.035em): New-session welcome only.
- **Headline** (500, 23px, 1.25, -0.03em): Session titles; drops to 21px below 820px height.
- **Title** (600, 17px, 1.3, -0.025em): Modal and drawer titles, section leads.
- **Body** (400, 13px, 1.45): Conversation copy; measures roughly 65–75 Latin characters inside the 720px column.
- **Control** (500, 11px, 1): Buttons, menu rows, and gateway names.
- **Label** (500, 10px, 1.4, 0.01em): Navigation, meta, role, capability, and command-palette group labels; sentence case or Chinese as-is, never uppercase.
- **Status** (500, 9px, 1.4, 0.01em): Status-pill words beside a 4px dot; no uppercase transform.
- **Code** (400, 7.5px, 1.55): Diffs, tool args, terminal output, and file paths.

### Named Rules
**The Heading Stands Alone Rule.** No kicker or eyebrow above a heading. Context belongs in a neighbouring control, a status line, or the heading's own words.

**The Measurement Rule.** Monospace is for code, paths, model names, counts, latency, and IDs. It never carries navigation, meta, role, or capability labels, and it never carries a marketing sentence.

## Layout

The resting desktop is a three-zone composition: a 232px session rail, a centered conversation column capped at 720px, and a closed 448px workspace rail. A 40px execution strip sits above the conversation and repeats the full route in one line. The composer is anchored to the foot of the conversation; the workspace rail only takes width when explicitly opened.

At 1380px the sidebar narrows to 220px, the workspace rail to 420px, and route connectors shorten before labels do. At 1220px the sidebar is 208px and the workspace rail 390px; the workspace trigger keeps its icon and drops its word. Below 820px height, chat rhythm tightens and the session title steps down. The document has a 1120px minimum width because this is a desktop surface, not a responsive marketing page.

Spacing follows a 2px grid. The documented scale includes the 10px, 14px, and 18px steps between the base rhythm for dense control rows and dialog padding; they are not a second spacing system.

Hide is not Close. Hide collapses the workspace rail to zero width while keeping its DOM, terminal scrollback, preview, and annotation state mounted and inert. Close unmounts the body and releases that state. Drawers and modals overlay the same conversation rather than reflowing it.

## Elevation & Depth

The system is flat by default. Depth is carried by tonal paper steps and one-pixel rules; a resting card does not cast a shadow. Shadows appear only when a surface physically leaves the page plane.

### Shadow Vocabulary
- **Hairline Lift** (`0 1px 2px rgb(22 24 27 / 5%)`): Composer and low tonal cards.
- **Popover Lift** (`0 12px 40px rgb(22 24 27 / 14%), 0 2px 8px rgb(22 24 27 / 7%)`): Gateway switcher and model menus.
- **Modal Lift** (`0 24px 72px rgb(22 24 27 / 18%), 0 3px 10px rgb(22 24 27 / 7%)`): Settings and checkpoint dialogs.
- **Drawer Edge** (`-18px 0 60px rgb(22 24 27 / 15%)`): Capabilities drawer separating itself from the conversation.

### Named Rules
**The Flat-At-Rest Rule.** If a surface stays in the document flow, it uses a border or a tonal step, never a shadow. Shadows are reserved for overlays.

## Shapes

The form language is drafting-office functional: 2–5px radii on rows and controls, 7–9px on cards and the composer, and circles only for status marks, avatars, and numbered annotation pins. Borders are one pixel and cool-neutral. Route lines are one pixel with a small arrowhead; the vertical conversation spine uses open circles at handoff points.

Avoid pill-shaped cards, oversized corner radii, and one-sided color bars. A status is a small dot plus a word; a route is a line plus endpoints; a destructive action is a full bordered card, not a red stripe.

## Components

### Buttons
- **Shape:** 5px radius, 28px minimum height, 10px horizontal padding.
- **Primary:** Ink ground with paper text; hover softens to `#30343a`.
- **Secondary:** White ground with a strong hairline; hover raises to paper.
- **Quiet / Ghost:** Transparent until hover, then deep paper.
- **Focus:** Two-pixel vermilion outline with a two-pixel offset. Never remove it.

### Chips
- **Route chip:** Paper ground, 10px Grotesk label, 5px radius; the host name may use ink weight while the profile stays muted.
- **Status chip:** Deep paper ground, 3px radius, 9px Grotesk text; one 4px dot plus word, never color alone.
- **Context chips:** White or vermilion-wash ground with a removable `×`; the label states the object kind.

Status uses one grammar everywhere it appears — route strip, capability catalog, and connection test results: 3px radius, deep-paper ground, one 4px dot, then the word. Do not add outline or filled variants.

### Cards / Containers
- **Corner style:** 5px for rows, 7px for dialogs and approval cards, 9px for the composer.
- **Background:** White or raised paper; approval is the only vermilion-wash card.
- **Border:** One-pixel hairline; no border plus wide shadow on the same resting card.
- **Padding:** 7–12px for dense rows, 16–18px for dialog bodies.

### Inputs / Fields
- **Style:** White ground, strong hairline, 5–9px radius; labels sit outside the field with a hint line.
- **Focus:** Border darkens first, then a low-opacity vermilion ring; the caret is vermilion.
- **Error:** Seal red border and an inline message that names the problem and recovery.

### Navigation
- Session rows are full-width text blocks; the active row uses deep paper and an ink title. Icons stay 11–14px and never become the only label.
- The left rail exposes Sessions | Bots as a two-item tab set. The right workspace rail uses six icon-plus-word tabs, collapsing gracefully before clipping.
- `⌘K` opens a focused command palette with grouped rows, arrow-key selection, and `Escape` dismissal.

### Route String (signature)
The persistent execution strip reads `YOU → <GATEWAY> → <PROFILE>` with a small transport chip (`Local`, `SSH`, `Remote`, `Cloud`) and latency. The active gateway uses ink weight and a running status dot; the active profile is muted. On scope change the route re-arrives with a 420ms ease-out and the screen reader receives a polite context announcement.

### Approval Card (signature)
The dangerous-command card is a vermilion-wash block with a 7px radius, one-pixel accent border, and explicit target host, profile, and working directory. Approve is primary ink; Deny is secondary; Inspect reveals the exact command and arguments without moving the target. The command is copyable and never truncated silently.

### Command Palette
A 620px white panel over a translucent paper scrim. The search field owns the first focus, groups use 10px Grotesk labels, and the selected row uses raised paper with an ink title. The footer teaches arrows, Enter, and Escape without adding another panel.

## Do's and Don'ts

### Do:
- **Do** keep the conversation column at 720px and let secondary capability overlay or hide.
- **Do** repeat execution context in the route string, composer scope line, and status bar.
- **Do** use postal vermilion for routing, focus, and destructive thresholds only.
- **Do** pair every status color with a word, icon, or measured value.
- **Do** preserve terminal scrollback and preview state when the workspace is hidden.
- **Do** write Chinese UI copy with English Hermes terms kept intact.

### Don't:
- **Don't** place a kicker or eyebrow above a heading.
- **Don't** turn the gateway list into a permanent fleet dashboard on the resting screen.
- **Don't** use a one-sided colored bar as a status device.
- **Don't** use gradient text, glass decoration, or a zero-offset colored halo as depth.
- **Don't** use monospace for prose or pack technical labels into every row.
- **Don't** imply that simulated latency, SSH, Cloud, Telegram, or voice input is live.
