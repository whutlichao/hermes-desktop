import type { SessionSummary } from "@hermes/contracts";
import { getCopy } from "@hermes/domain";

interface SessionRailListProps {
  hasReadyConnection: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (session: SessionSummary) => void;
}

export function SessionRailList({
  hasReadyConnection,
  sessions,
  activeSessionId,
  onSelectSession,
}: SessionRailListProps) {
  if (!hasReadyConnection) {
    return (
      <div className="sidebar-empty">
        <strong>{getCopy("nav.sessionsEmptyTitle")}</strong>
        <p>{getCopy("nav.sessionsEmptyBody")}</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="sidebar-empty">
        <strong>{getCopy("nav.sessionsEmptyTitle")}</strong>
        <p>{getCopy("chat.emptyBody")}</p>
      </div>
    );
  }

  return (
    <ul className="session-list" aria-label={getCopy("nav.sessionsLandmark")}>
      {sessions.map((session) => {
        const isActive = session.sessionId === activeSessionId;
        return (
          <li key={`${session.connectionId}:${session.profileId}:${session.sessionId}`}>
            <button
              type="button"
              className={["session-item", isActive && "is-active"].filter(Boolean).join(" ")}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onSelectSession(session)}
            >
              <span className="session-item-title">{session.title}</span>
              {session.preview && <span className="session-item-preview">{session.preview}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
