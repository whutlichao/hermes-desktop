import { useState } from "react";
import {
  ChevronRight,
  Command,
  Layers,
  PanelRight,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { cn } from "../../lib/ui";
import { useIa } from "./context";
import { demoSessions } from "./data";
import {
  ApprovalBadge,
  ApprovalSurface,
  CapabilitySurface,
  Composer,
  EmptyStateA,
  HealthDot,
  Kbd,
  MessageList,
  RouteText,
  ScopePopover,
  SessionsPopover,
  WorkspaceSurface,
} from "./parts";

export function VariantA() {
  const {
    activeSessionId,
    setActiveSession,
    setScene,
    scene,
    openPalette,
    openSettings,
    openWorkspace,
    openScope,
    openCapability,
    openSessions,
    surface,
    scope,
    connectionHealth,
    approvalPending,
  } = useIa();
  const [query, setQuery] = useState("");

  const sessions = demoSessions.filter((session) => {
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      session.title.toLowerCase().includes(needle) ||
      session.preview.toLowerCase().includes(needle)
    );
  });
  const groups = (["今天", "昨天"] as const)
    .map((group) => ({ group, items: sessions.filter((session) => session.group === group) }))
    .filter((entry) => entry.items.length);

  return (
    <div className="ia-a-root">
      <header className="ia-titlebar">
        <span className="ia-traffic" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ia-brand">
          HERMES <em>DESKTOP</em>
        </span>
        <span className="ia-titlebar-badge">IA PROTOTYPE · A · BASELINE</span>
        <div className="ia-titlebar-right">
          <span>SIMULATED</span>
          <Kbd>⌘K</Kbd>
        </div>
      </header>

      <div className="ia-a-shell">
        <aside className="ia-a-rail" aria-label="Session rail">
          <div className="ia-a-rail-head">
            <span className="ia-micro">SESSION RELAY</span>
            <span className="ia-a-count">{demoSessions.length}</span>
          </div>

          <button
            type="button"
            className="ia-new-session"
            onClick={() => {
              setActiveSession("");
              setScene("empty");
            }}
          >
            <Plus size={14} />
            <span>新对话</span>
            <Kbd>⌘N</Kbd>
          </button>

          <div className="ia-rail-search">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Session"
              aria-label="搜索 Session"
            />
          </div>

          <div className="ia-a-sessions">
            {groups.map(({ group, items }) => (
              <section className="ia-a-session-group" key={group}>
                <div className="ia-group-heading">
                  <span>{group}</span>
                  <span>{items.length}</span>
                </div>
                {items.map((session) => (
                  <button
                    type="button"
                    className={cn("ia-a-session", session.id === activeSessionId && "is-active")}
                    key={session.id}
                    onClick={() => {
                      setActiveSession(session.id);
                      if (scene === "empty") setScene("running");
                    }}
                  >
                    <span className="ia-a-session-title">
                      {session.title}
                      {session.status === "approval" && approvalPending > 0 && (
                        <span className="ia-a-session-approval" aria-label="后台待审批">
                          <ShieldCheck size={11} /> 1
                        </span>
                      )}
                    </span>
                    <span className="ia-a-session-preview">{session.preview}</span>
                    <span className="ia-a-session-meta">
                      {session.time}
                      {session.status === "running" && <em>运行中</em>}
                    </span>
                  </button>
                ))}
              </section>
            ))}
            {groups.length === 0 && (
              <div className="ia-a-empty">
                <p>没有匹配的 Session。</p>
                <button type="button" onClick={() => setQuery("")}>清除搜索</button>
              </div>
            )}
          </div>

          <div className="ia-a-rail-foot">
            <button type="button" className="ia-a-cap-hint" onClick={() => openCapability("chat")}>
              <span>能力</span>
              <b>17 可达</b>
              <em>4 延期</em>
            </button>
            <button type="button" className="ia-a-scope" onClick={openScope}>
              <span>
                <b>{scope.gateway}</b>
                <em>{scope.profile}</em>
              </span>
              <span className={cn("ia-a-scope-health", connectionHealth === "degraded" && "is-degraded")}>
                <HealthDot degraded={connectionHealth === "degraded"} />
                {connectionHealth === "degraded" ? "降级" : scope.kind}
              </span>
            </button>
            <div className="ia-a-rail-actions">
              <button type="button" className="ia-icon-button" aria-label="能力目录" title="能力目录" onClick={openPalette}>
                <Command size={15} />
              </button>
              <button type="button" className="ia-icon-button" aria-label="Settings" title="Settings" onClick={openSettings}>
                <Settings2 size={15} />
              </button>
            </div>
          </div>
        </aside>

        <main className="ia-a-main">
          <div className="ia-a-route">
            <div className="ia-a-route-left">
              <button type="button" className="ia-a-sessions-trigger" onClick={openSessions}>
                <Layers size={13} />
                <span>Sessions</span>
                <b>{demoSessions.length}</b>
              </button>
              <RouteText />
            </div>
            <div className="ia-a-route-actions">
              <ApprovalBadge short />
              <button type="button" className="ia-workspace-trigger" onClick={() => openWorkspace()}>
                <PanelRight size={14} />
                <span>Workspace</span>
              </button>
            </div>
          </div>

          <div className="ia-a-scroll">
            <div className="ia-a-column">
              {activeSessionId ? <MessageList showStreaming={scene === "running"} /> : <EmptyStateA />}
            </div>
          </div>

          <div className="ia-a-composer-wrap">
            <Composer />
          </div>

          <footer className="ia-a-status">
            <span>{scope.kind} · {scope.host}</span>
            <button type="button" className="ia-a-cap-count" onClick={() => openCapability("chat")}>
              17 可达 · 4 延期无入口
            </button>
            <span className="ia-a-status-sim">SIM · 无真实网络</span>
            <span className="ia-a-status-keys">
              <Kbd>⌘K</Kbd> 能力 <ChevronRight size={10} /> <Kbd>⌘,</Kbd> Settings
            </span>
          </footer>
        </main>
      </div>

      {surface === "capability" && <CapabilitySurface kind="drawer" />}
      {surface === "workspace" && <WorkspaceSurface kind="drawer" side="right" />}
      {surface === "approval" && <ApprovalSurface kind="drawer" side="right" />}
      {surface === "sessions" && <SessionsPopover className="ia-a-sessions-popover" />}
      {surface === "scope" && <ScopePopover className="ia-a-scope-popover" />}
    </div>
  );
}
