import {
  Bot,
  ChevronDown,
  Command,
  MessagesSquare,
  Pin,
  Plus,
  Search,
  Settings2,
  Workflow,
} from "lucide-react";
import { useApp } from "../state/AppContext";
import {
  getActiveGateway,
  getActiveProfile,
  getGateway,
  getProfilesForGateway,
  sessionGroups,
} from "../state/store";
import { cn, gatewayKind, healthLabel, latency } from "../lib/ui";
import { HermesMark } from "./Brand";
import { IconButton, Kbd, StatusDot, Toggle } from "./ui";

export function Sidebar() {
  const { state, dispatch } = useApp();
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const groups = sessionGroups(state);
  const botSections = [...new Set(state.bots.map((bot) => bot.section))];
  const scopedProfiles = getProfilesForGateway(state, state.activeGatewayId);
  const hiddenSessions = state.allProfiles
    ? state.sessions.filter((session) => !session.botId).length
    : state.sessions.filter(
        (session) =>
          session.gatewayId === state.activeGatewayId &&
          session.profileId === state.activeProfileId &&
          !session.botId,
      ).length;

  return (
    <aside className="sidebar" aria-label="会话与机器人导航">
      <div className="brand-lockup">
        <span className="brand-glyph"><HermesMark size={17} /></span>
        <span className="brand-name">HERMES</span>
        <span className="brand-version">0.9.4</span>
      </div>

      <div className="sidebar-tabs" role="tablist" aria-label="内容类型">
        <button
          type="button"
          role="tab"
          aria-selected={state.sidebarMode === "sessions"}
          className={cn(state.sidebarMode === "sessions" && "is-active")}
          onClick={() => dispatch({ type: "SET_SIDEBAR_MODE", mode: "sessions" })}
        >
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.sidebarMode === "bots"}
          className={cn(state.sidebarMode === "bots" && "is-active")}
          onClick={() => dispatch({ type: "SET_SIDEBAR_MODE", mode: "bots" })}
        >
          Bots <span>{state.bots.length}</span>
        </button>
      </div>

      <button type="button" className="new-session" onClick={() => dispatch({ type: "NEW_SESSION" })}>
        <Plus size={14} />
        <span>新对话</span>
        <Kbd>⌘N</Kbd>
      </button>

      {state.sidebarMode === "sessions" ? (
        <>
          <div className="sidebar-search">
            <Search size={13} aria-hidden="true" />
            <input
              value={state.sessionSearch}
              onChange={(event) => dispatch({ type: "SET_SESSION_SEARCH", value: event.target.value })}
              placeholder="搜索 Session"
              aria-label="搜索 Session"
            />
            <span className="search-count">{hiddenSessions}</span>
          </div>
          <div className="sidebar-filter-row">
            <div className="mini-segments" role="group" aria-label="Session 筛选">
              <button
                type="button"
                className={cn(state.sessionFilter === "all" && "is-active")}
                onClick={() => dispatch({ type: "SET_SESSION_FILTER", value: "all" })}
              >
                全部
              </button>
              <button
                type="button"
                className={cn(state.sessionFilter === "pinned" && "is-active")}
                onClick={() => dispatch({ type: "SET_SESSION_FILTER", value: "pinned" })}
              >
                已置顶
              </button>
            </div>
            <button
              type="button"
              className={cn("all-profiles-mini", state.allProfiles && "is-active")}
              onClick={() => dispatch({ type: "TOGGLE_ALL_PROFILES" })}
              aria-pressed={state.allProfiles}
            >
              All Profiles
            </button>
          </div>

          <div className="session-scroll" role="list">
            {groups.length === 0 ? (
              <div className="sidebar-empty">
                <p>没有匹配的 Session。</p>
                <button type="button" onClick={() => dispatch({ type: "SET_SESSION_SEARCH", value: "" })}>
                  清除搜索
                </button>
              </div>
            ) : groups.map((group) => (
              <section className="session-group" key={group.id}>
                <div className="group-heading">
                  <span>{group.label}</span>
                  {group.sublabel && <em>{group.sublabel}</em>}
                  <span className="group-rule" />
                  <span>{group.sessions.length}</span>
                </div>
                {group.sessions.map((session) => (
                  <div
                    className={cn("session-row", session.id === state.activeSessionId && "is-active")}
                    key={session.id}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="session-main"
                      aria-current={session.id === state.activeSessionId ? "page" : undefined}
                      onClick={() => dispatch({ type: "OPEN_SESSION", sessionId: session.id })}
                    >
                      <span className="session-title">{session.title}</span>
                      <span className="session-preview">{session.preview}</span>
                    </button>
                    <IconButton
                      className="session-pin"
                      label={session.pinned ? "取消置顶" : "置顶 Session"}
                      onClick={() => dispatch({ type: "TOGGLE_PIN", sessionId: session.id })}
                    >
                      <Pin size={11} fill={session.pinned ? "currentColor" : "none"} />
                    </IconButton>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="bot-scroll">
          <div className="bot-union-note">
            <Workflow size={13} />
            <span>Union roster · {state.bots.length} bots</span>
          </div>
          {botSections.map((section) => (
            <section className="bot-section" key={section}>
              <div className="group-heading">
                <span>{section}</span>
                <span className="group-rule" />
                <span>{state.bots.filter((bot) => bot.section === section).length}</span>
              </div>
              {state.bots
                .filter((bot) => bot.section === section)
                .map((bot) => {
                  const botGateway = getGateway(state, bot.gatewayId);
                  return (
                    <button
                      type="button"
                      key={bot.id}
                      className={cn("bot-row", bot.id === state.activeBotId && "is-active")}
                      onClick={() => dispatch({ type: "OPEN_BOT", botId: bot.id })}
                    >
                      <span className="bot-avatar" style={{ background: bot.color }}>{bot.avatar}</span>
                      <span className="bot-copy">
                        <span className="bot-title-line">
                          <b>{bot.name}</b>
                          {bot.unread > 0 && <i>{bot.unread}</i>}
                          <em>{botGateway?.name}</em>
                        </span>
                        <span>{bot.latest}</span>
                      </span>
                      <span className={cn("bot-presence", bot.status === "active" && "is-live")} />
                    </button>
                  );
                })}
            </section>
          ))}
        </div>
      )}

      <div className="sidebar-spacer" />

      <div className={cn("scope-card", state.allProfiles && "is-union")}>
        <div className="scope-card-head">
          <span className="micro-label">Execution context</span>
          <Toggle
            checked={state.allProfiles}
            onChange={() => dispatch({ type: "TOGGLE_ALL_PROFILES" })}
            label="All Profiles 联合视图"
          />
        </div>
        <button
          type="button"
          className="scope-primary"
          onClick={() => dispatch({ type: "TOGGLE_GATEWAY_SWITCHER" })}
          aria-expanded={state.gatewaySwitcherOpen}
        >
          <StatusDot tone={gateway.health === "error" ? "error" : gateway.health === "testing" ? "warn" : "ok"} ring />
          <span className="scope-gateway">{gateway.name}</span>
          <span className="scope-kind">{gatewayKind(gateway)}</span>
          <ChevronDown size={13} />
        </button>
        <div className="scope-meta">
          <span>{state.allProfiles ? "全部 profiles" : profile.handle}</span>
          <span>·</span>
          <span>{healthLabel(gateway)} {gateway.latencyMs !== null ? latency(gateway) : ""}</span>
          {state.primaryGatewayId === gateway.id && <em>PRIMARY</em>}
        </div>
        <div className="scope-actions">
          <button
            type="button"
            onClick={() => dispatch({ type: "OPEN_CAPABILITIES", tab: "channels" })}
          >
            <MessagesSquare size={12} /> Channels
          </button>
          <button type="button" onClick={() => dispatch({ type: "OPEN_SETTINGS" })}>
            <Settings2 size={12} /> Settings
          </button>
          <button type="button" onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "palette" })} title="命令面板">
            <Command size={12} />
          </button>
        </div>
        {scopedProfiles.length > 1 && (
          <div className="scope-profiles" aria-label="切换 Profile">
            {scopedProfiles.map((row) => (
              <button
                type="button"
                key={row.id}
                className={cn(row.id === state.activeProfileId && !state.allProfiles && "is-active")}
                onClick={() => dispatch({ type: "SWITCH_PROFILE", profileId: row.id })}
                title={`${row.handle} · ${row.model}`}
              >
                {row.initials}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        <Bot size={11} />
        <span>Prototype simulation</span>
      </div>
    </aside>
  );
}
