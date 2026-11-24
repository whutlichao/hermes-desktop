import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import type {
  BridgeScope,
  CapabilityMethodTier,
  SessionSummary,
  SupportedChatActions,
} from "@hermes/contracts";
import {
  buildSessionCliDeepLinks,
  filterRenderableSessionCapabilities,
  getCopy,
  type CopyKey,
} from "@hermes/domain";

interface SessionRailListProps {
  hasReadyConnection: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  activeScope?: BridgeScope | null;
  supportedActions?: SupportedChatActions | null;
  methodTiers?: Record<string, CapabilityMethodTier>;
  extraCapabilities?: readonly string[];
  canCreateSession?: boolean;
  showNewChatButton?: boolean;
  onCreateSession?: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onMarkSessionRead?: (session: SessionSummary) => void;
  onCopyCliCommand?: (command: string) => void;
}

const CAPABILITY_ENTRIES: Array<{ key: keyof SupportedChatActions; label: string }> = [
  { key: "promptSubmit", label: "prompt.submit" },
  { key: "promptCancel", label: "prompt.cancel" },
  { key: "promptSteer", label: "session.steer" },
  { key: "sessionCreate", label: "session.create" },
  { key: "sessionResume", label: "session.resume" },
];

export function SessionRailList({
  hasReadyConnection,
  sessions,
  activeSessionId,
  activeScope,
  supportedActions,
  methodTiers,
  extraCapabilities = [],
  canCreateSession = false,
  showNewChatButton = false,
  onCreateSession,
  onSelectSession,
  onMarkSessionRead,
  onCopyCliCommand,
}: SessionRailListProps) {
  const [query, setQuery] = useState("");
  const searchInputId = useId();
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.preview && s.preview.toLowerCase().includes(q)),
    );
  }, [query, sessions]);

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.nativeEvent.isComposing || filteredSessions.length === 0) return;
    const currentIndex = rowRefs.current.findIndex((el) => el === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIdx = currentIndex < 0 ? 0 : (currentIndex + 1) % filteredSessions.length;
      rowRefs.current[nextIdx]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIdx =
        currentIndex < 0
          ? filteredSessions.length - 1
          : (currentIndex - 1 + filteredSessions.length) % filteredSessions.length;
      rowRefs.current[prevIdx]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      rowRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      rowRefs.current[filteredSessions.length - 1]?.focus();
    }
  };

  if (!hasReadyConnection) {
    return (
      <div className="sidebar-empty">
        <strong>{getCopy("nav.sessionsEmptyTitle")}</strong>
        <p>{getCopy("nav.sessionsEmptyBody")}</p>
      </div>
    );
  }

  const rawCapLabels = [
    ...(supportedActions
      ? CAPABILITY_ENTRIES.filter((entry) => supportedActions[entry.key]).map((entry) => entry.label)
      : []),
    ...extraCapabilities,
  ];
  const servedCapLabels = filterRenderableSessionCapabilities(rawCapLabels, methodTiers);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) ?? null;
  const cliDeepLinks = activeSessionId
    ? buildSessionCliDeepLinks({
        sessionId: activeSessionId,
        profileId: activeScope?.profileId ?? "default",
        title: activeSession?.title,
      })
    : [];

  const handleCopyCli = (command: string) => {
    try {
      void navigator.clipboard?.writeText(command);
    } catch {
      // Clipboard API may be unavailable in headless test environments
    }
    onCopyCliCommand?.(command);
  };

  return (
    <div className="session-rail-body">
      {showNewChatButton && onCreateSession && (
        <button
          type="button"
          className="sidebar-new-btn"
          disabled={!canCreateSession}
          onClick={onCreateSession}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={13} aria-hidden="true" />
            {getCopy("nav.newSession")}
          </span>
          <kbd className="kbd">⌘N</kbd>
        </button>
      )}

      {sessions.length > 0 && (
        <div className="session-search-wrap">
          <label htmlFor={searchInputId} className="sr-only">
            {getCopy("nav.searchLabel")}
          </label>
          <input
            id={searchInputId}
            type="search"
            className="session-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={getCopy("nav.searchPlaceholder")}
          />
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="sidebar-empty">
          <strong>{getCopy("nav.sessionsEmptyTitle")}</strong>
          <p>{getCopy("chat.emptyBody")}</p>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="sidebar-empty">
          <p>{getCopy("nav.searchNoResults")}</p>
        </div>
      ) : (
        <ul
          className="session-list"
          aria-label={getCopy("nav.sessionsLandmark")}
          onKeyDown={handleListKeyDown}
        >
          {filteredSessions.map((session, idx) => {
            const isActive = session.sessionId === activeSessionId;
            const hasBadges = session.needsInput || session.unreadCount > 0 || session.pinned;
            return (
              <li
                key={`${session.connectionId}:${session.profileId}:${session.sessionId}`}
                className="session-item-row"
              >
                <button
                  ref={(el) => {
                    rowRefs.current[idx] = el;
                  }}
                  type="button"
                  className={["session-item", isActive && "is-active"].filter(Boolean).join(" ")}
                  aria-current={isActive ? "page" : undefined}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    onSelectSession(session);
                  }}
                >
                  <span className="session-item-title-row">
                    <span className="session-item-title">{session.title}</span>
                    {session.needsInput && (
                      <span
                        className="session-needs-input-badge"
                        data-testid="session-needs-input-badge"
                      >
                        {getCopy("approval.needsInputBadge")}
                      </span>
                    )}
                  </span>
                  {session.preview && <span className="session-item-preview">{session.preview}</span>}
                  {hasBadges && (
                    <span className="session-item-badges">
                      {session.needsInput && (
                        <span className="status-pill is-blocked session-badge-needs-input">
                          {getCopy("nav.needsInputBadge")}
                        </span>
                      )}
                      {session.unreadCount > 0 && (
                        <span className="status-pill is-warn session-badge-unread">
                          {session.unreadCount} {getCopy("nav.unreadBadge")}
                        </span>
                      )}
                      {session.pinned && (
                        <span className="status-pill session-badge-pinned">
                          {getCopy("nav.pinnedBadge")}
                        </span>
                      )}
                    </span>
                  )}
                </button>
                {session.unreadCount > 0 && onMarkSessionRead && (
                  <button
                    type="button"
                    className="session-mark-read-btn"
                    data-testid={`session-mark-read-${session.sessionId}`}
                    aria-label={`${getCopy("nav.markReadAction")}：${session.title}`}
                    onClick={() => onMarkSessionRead(session)}
                  >
                    {getCopy("nav.markReadAction")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="session-details-card" aria-label={getCopy("nav.sessionDetailsTitle")}>
        <h3 className="session-details-heading">{getCopy("nav.sessionDetailsTitle")}</h3>
        {activeScope ? (
          <dl className="session-details-dl">
            <div>
              <dt>{getCopy("nav.sessionDetailsScope")}</dt>
              <dd>
                {activeScope.connectionId} / {activeScope.profileId ?? "default"}
                {activeSessionId ? ` / ${activeSessionId}` : ` (${getCopy("nav.sessionDetailsNoSession")})`}
              </dd>
            </div>
            <div>
              <dt>{getCopy("nav.sessionDetailsSecurity")}</dt>
              <dd>{getCopy("nav.sessionDetailsSecurityValue")}</dd>
            </div>
            <div>
              <dt>{getCopy("nav.sessionDetailsCapabilities")}</dt>
              <dd>
                {servedCapLabels.length > 0 ? (
                  <span className="session-cap-list">
                    {servedCapLabels.map((cap) => (
                      <span key={cap} className="session-cap-tag">
                        {cap}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span>{getCopy("common.notProvided")}</span>
                )}
              </dd>
            </div>
            {cliDeepLinks.length > 0 && (
              <div>
                <dt>{getCopy("nav.sessionDetailsCliActions")}</dt>
                <dd>
                  <p className="session-cli-note" style={{ fontSize: "0.88462rem", color: "var(--muted)", margin: "2px 0 6px" }}>
                    {getCopy("session.cli.neverExecutedNotice")}
                  </p>
                  <div className="session-cli-actions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {cliDeepLinks.map((link) => (
                      <div
                        key={link.actionId}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}
                      >
                        <code style={{ fontSize: "0.80769rem", opacity: 0.85, wordBreak: "break-all" }}>{link.command}</code>
                        <button
                          type="button"
                          className="button button-secondary session-cli-btn"
                          data-cli-action={link.actionId}
                          data-cli-command={link.command}
                          style={{ fontSize: "0.84615rem", padding: "3px 8px", flexShrink: 0 }}
                          onClick={() => handleCopyCli(link.command)}
                        >
                          {getCopy(link.labelKey as CopyKey)}
                        </button>
                      </div>
                    ))}
                  </div>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="session-details-empty">{getCopy("nav.sessionDetailsEmpty")}</p>
        )}
      </section>
    </div>
  );
}
