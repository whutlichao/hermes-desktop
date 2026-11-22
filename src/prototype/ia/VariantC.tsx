import { ChevronDown, PanelLeft, Settings2 } from "lucide-react";
import { cn } from "../../lib/ui";
import { useIa } from "./context";
import { demoSessions } from "./data";
import {
  ApprovalBadge,
  ApprovalSurface,
  CapabilityPaletteSurface,
  Composer,
  EmptyStateC,
  HealthDot,
  MessageList,
  RouteText,
  ScopePopover,
  SessionsPopover,
  WorkspaceSurface,
} from "./parts";

export function VariantC() {
  const {
    activeSessionId,
    setActiveSession,
    setScene,
    scene,
    scope,
    connectionHealth,
    openScope,
    openSessions,
    openCapability,
    openWorkspace,
    openSettings,
    surface,
  } = useIa();

  return (
    <div className="ia-c-root">
      <header className="ia-titlebar ia-c-titlebar">
        <span className="ia-traffic" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ia-brand">
          HERMES <em>DESKTOP</em>
        </span>
        <span className="ia-titlebar-badge">DISPATCH BOARD · C</span>
        <div className="ia-titlebar-right">
          <span>SIMULATED · 17 可达</span>
        </div>
      </header>

      <div className="ia-c-strip">
        <button type="button" className="ia-c-scope" onClick={openScope}>
          <span className={cn("ia-c-scope-kind", scope.kind !== "LOCAL" && "is-remote")}>{scope.kind}</span>
          <span className="ia-c-scope-main">
            <b>{scope.gateway}</b>
            <em>{scope.profile}</em>
          </span>
          <span className={cn("ia-c-scope-health", connectionHealth === "degraded" && "is-degraded")}>
            <HealthDot degraded={connectionHealth === "degraded"} />
            {connectionHealth === "degraded" ? "降级" : "在线"}
          </span>
          <ChevronDown size={12} />
        </button>

        <div className="ia-c-sessions" role="tablist" aria-label="Session chips">
          {demoSessions.slice(0, 3).map((session) => (
            <button
              type="button"
              role="tab"
              aria-selected={session.id === activeSessionId}
              className={cn("ia-c-session-chip", session.id === activeSessionId && "is-active")}
              key={session.id}
              onClick={() => {
                setActiveSession(session.id);
                if (scene === "empty") setScene("running");
              }}
            >
              <span>{session.title}</span>
              {session.status === "running" && <em>运行中</em>}
              {session.status === "approval" && <i>审批</i>}
            </button>
          ))}
          <button type="button" className="ia-c-session-all" onClick={openSessions}>
            全部 <span>{demoSessions.length}</span>
          </button>
        </div>

        <div className="ia-c-actions">
          <ApprovalBadge short />
          <button type="button" className="ia-workspace-trigger" onClick={() => openWorkspace()}>
            <PanelLeft size={14} />
            <span>Workspace</span>
          </button>
          <button type="button" className="ia-icon-button" aria-label="Settings" title="Settings" onClick={openSettings}>
            <Settings2 size={15} />
          </button>
        </div>
      </div>

      <main className="ia-c-main">
        <div className="ia-c-scroll">
          <div className="ia-c-column">
            <div className="ia-c-route-line">
              <RouteText compact />
              <span>顶部常驻路由 / 会话条；底部能力托盘常驻</span>
            </div>
            {activeSessionId ? <MessageList showStreaming={scene === "running"} /> : <EmptyStateC />}
          </div>
        </div>
        <div className="ia-c-composer-wrap">
          <Composer />
        </div>
      </main>

      <footer className="ia-c-shelf" aria-label="能力货架">
        <div className="ia-c-shelf-left">
          <button type="button" onClick={() => openCapability("chat")}>
            <span>核心</span><b>5</b>
          </button>
          <button type="button" onClick={() => openCapability("skills")}>
            <span>管理</span><b>8</b>
          </button>
          <button type="button" onClick={() => openCapability("files")}>
            <span>执行</span><b>4</b>
          </button>
        </div>
        <span className="ia-c-shelf-spacer" aria-hidden="true" />
        <button type="button" className="ia-c-shelf-count" onClick={() => openCapability("chat")}>
          17 可达 · 13 / 3 / 1 · 4 延期无入口
        </button>
      </footer>

      {surface === "capability" && <CapabilityPaletteSurface variant="C" className="ia-capability-tray" />}
      {surface === "workspace" && <WorkspaceSurface kind="drawer" side="left" />}
      {surface === "approval" && <ApprovalSurface kind="popover" className="ia-c-approval-popover" />}
      {surface === "sessions" && <SessionsPopover className="ia-c-sessions-popover" />}
      {surface === "scope" && <ScopePopover className="ia-c-scope-popover" />}
    </div>
  );
}
