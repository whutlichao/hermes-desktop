import { Command, Layers, PanelRight, Settings2 } from "lucide-react";
import { cn } from "../../lib/ui";
import { useIa } from "./context";
import {
  ApprovalBadge,
  ApprovalSurface,
  CapabilityPaletteSurface,
  Composer,
  EmptyStateB,
  HealthDot,
  Kbd,
  MessageList,
  RouteText,
  ScopePopover,
  SessionsPopover,
  WorkspaceSurface,
} from "./parts";

export function VariantB() {
  const {
    activeSessionId,
    scene,
    scope,
    connectionHealth,
    openSessions,
    openCapability,
    openWorkspace,
    openSettings,
    openScope,
    surface,
  } = useIa();

  return (
    <div className="ia-b-root">
      <header className="ia-b-top">
        <span className="ia-brand">
          HERMES <em>DESKTOP</em>
        </span>
        <span className="ia-b-top-title">QUIET FIELD · B</span>
        <div className="ia-b-top-meta">
          <span>17 可达 / 4 延期</span>
          <span className="ia-titlebar-badge">SIMULATED</span>
        </div>
      </header>

      <main className="ia-b-main">
        <div className="ia-b-scroll">
          <div className="ia-b-column">
            <div className="ia-b-route-line">
              <RouteText compact />
              <span className="ia-b-route-hint">composer 常驻 · 其余从 dock 或 ⌘K 进入</span>
            </div>

            {activeSessionId ? <MessageList showStreaming={scene === "running"} /> : <EmptyStateB />}
            <p className="ia-b-footnote">
              无侧栏是默认。Session、Workspace 与能力都通过一次显式手势披露；切换变体不会丢失终端 scrollback。
            </p>
          </div>
        </div>
        <div className="ia-b-composer-wrap">
          <Composer />
        </div>
      </main>

      <div className="ia-b-dock" aria-label="Quiet Field dock">
        <button type="button" className="ia-b-dock-scope" onClick={openScope}>
          <span className="ia-b-dock-scope-main">
            <b>{scope.gateway}</b>
            <em>{scope.profile}</em>
          </span>
          <span className={cn("ia-b-dock-health", connectionHealth === "degraded" && "is-degraded")}>
            <HealthDot degraded={connectionHealth === "degraded"} />
            {connectionHealth === "degraded" ? "降级" : scope.kind}
          </span>
        </button>

        <span className="ia-dock-divider" />

        <button type="button" className="ia-dock-button" onClick={openSessions}>
          <Layers size={14} />
          <span>Sessions</span>
        </button>
        <button type="button" className="ia-dock-button" onClick={() => openCapability("chat")}>
          <Command size={14} />
          <span>能力</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button type="button" className="ia-dock-button" onClick={() => openWorkspace()}>
          <PanelRight size={14} />
          <span>Workspace</span>
        </button>

        <span className="ia-dock-divider" />
        <ApprovalBadge short />

        <button type="button" className="ia-icon-button" aria-label="Settings" title="Settings" onClick={openSettings}>
          <Settings2 size={15} />
        </button>
      </div>

      {surface === "capability" && <CapabilityPaletteSurface variant="B" />}
      {surface === "workspace" && <WorkspaceSurface kind="sheet" />}
      {surface === "approval" && <ApprovalSurface kind="popover" className="ia-b-approval-popover" />}
      {surface === "sessions" && <SessionsPopover className="ia-b-sessions-popover" />}
      {surface === "scope" && <ScopePopover className="ia-b-scope-popover" />}
    </div>
  );
}
