import type { RefObject } from "react";
import type {
  ConnectionHealthSummary,
  LocalInspectResult,
  LocalSafeActionId,
  SessionTranscriptSnapshot,
  ToolExecutionRow,
} from "@hermes/contracts";
import { getCopy } from "@hermes/domain";
import { LocalRepairCard } from "./LocalRepairCard";
import { MarkdownText } from "./MarkdownText";

interface ChatThreadProps {
  hasReadyConnection: boolean;
  activeConnection?: ConnectionHealthSummary | null;
  transcript: SessionTranscriptSnapshot | null;
  localInspection: LocalInspectResult | null;
  localBusy: boolean;
  chatBusy: boolean;
  composerDraft: string;
  stopError: string | null;
  canCreateSession: boolean;
  composerRef: RefObject<HTMLTextAreaElement>;
  onDraftChange: (value: string) => void;
  onSendPrompt: () => void;
  onStopTurn: () => void;
  onCreateSession: () => void;
  onLocalAction: (action: LocalSafeActionId) => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onOpenRemoteEscape: () => void;
}

function getToolStatusLabel(status: ToolExecutionRow["status"]): string {
  switch (status) {
    case "running":
      return getCopy("chat.toolRunning");
    case "completed":
      return getCopy("chat.toolCompleted");
    case "failed":
      return getCopy("chat.toolFailed");
    case "cancelled":
      return getCopy("chat.toolCancelled");
  }
}

function getRoleLabel(role: "user" | "assistant" | "system"): string {
  switch (role) {
    case "user":
      return getCopy("chat.roleUser");
    case "assistant":
      return getCopy("chat.roleAssistant");
    case "system":
      return getCopy("chat.roleSystem");
  }
}

export function ChatThread({
  hasReadyConnection,
  activeConnection,
  transcript,
  localInspection,
  localBusy,
  chatBusy,
  composerDraft,
  stopError,
  canCreateSession,
  composerRef,
  onDraftChange,
  onSendPrompt,
  onStopTurn,
  onCreateSession,
  onLocalAction,
  onOpenSettings,
  onOpenPalette,
  onOpenShortcuts,
  onOpenRemoteEscape,
}: ChatThreadProps) {
  if (!hasReadyConnection) {
    const isRemoteAuthRequired =
      activeConnection?.kind === "remote" && activeConnection.actual === "auth_required";
    return (
      <div className="thread-column">
        {isRemoteAuthRequired ? (
          <section className="empty-relay-card" role="status" aria-labelledby="remote-auth-heading">
            <h1 id="remote-auth-heading">{getCopy("remote.authRequiredTitle")}</h1>
            <p>{getCopy("remote.authRequiredBody")}</p>
            <div className="empty-relay-actions">
              <button type="button" className="button button-primary" onClick={onOpenSettings}>
                {getCopy("remote.authRequiredAction")}
              </button>
              <button type="button" className="button button-secondary" onClick={onOpenPalette}>
                {getCopy("empty.actionPalette")}
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="empty-relay-card" aria-labelledby="empty-relay-heading">
              <h1 id="empty-relay-heading">{getCopy("empty.title")}</h1>
              <p>{getCopy("empty.body")}</p>
              <div className="empty-relay-actions">
                <button type="button" className="button button-primary" onClick={onOpenSettings}>
                  {getCopy("empty.actionSettings")}
                </button>
                <button type="button" className="button button-secondary" onClick={onOpenPalette}>
                  {getCopy("empty.actionPalette")}
                </button>
                <button type="button" className="button button-secondary" onClick={onOpenShortcuts}>
                  {getCopy("empty.actionShortcuts")}
                </button>
              </div>
            </section>

            <LocalRepairCard
              inspection={localInspection}
              busy={localBusy}
              onAction={onLocalAction}
              onOpenRemoteEscape={onOpenRemoteEscape}
            />
          </>
        )}

        <form
          className="composer-shell"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label htmlFor="composer-input" className="sr-only">
            {getCopy("composer.label")}
          </label>
          <textarea
            id="composer-input"
            ref={composerRef}
            className="composer-textarea"
            rows={2}
            readOnly
            aria-disabled="true"
            placeholder={getCopy("composer.placeholder")}
          />
          <div className="composer-bar">
            <span className="composer-hint">{getCopy("composer.unconnectedHint")}</span>
            <button type="submit" className="button button-primary" disabled>
              {getCopy("composer.send")}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="thread-column">
      {!transcript || transcript.messages.length === 0 ? (
        <section className="empty-relay-card" aria-label={getCopy("chat.emptyTitle")}>
          <h1>{getCopy("chat.emptyTitle")}</h1>
          <p>{getCopy("chat.emptyBody")}</p>
          {canCreateSession && !transcript && (
            <div className="empty-relay-actions">
              <button type="button" className="button button-primary" onClick={onCreateSession}>
                {getCopy("nav.newSession")}
              </button>
            </div>
          )}
        </section>
      ) : (
        <ol className="transcript-list" aria-label={getCopy("nav.sessionsTab")}>
          {transcript.messages.map((msg) => (
            <li
              key={msg.messageId}
              className={["transcript-message", `is-${msg.role}`].join(" ")}
            >
              <div className="transcript-meta">
                <span className="transcript-role">{getRoleLabel(msg.role)}</span>
                {msg.streaming && (
                  <span className="status-pill is-warn">{getCopy("chat.streamingBadge")}</span>
                )}
                {!msg.streaming && msg.status === "stopped" && (
                  <span className="status-pill">{getCopy("chat.stoppedBadge")}</span>
                )}
              </div>

              <MarkdownText text={msg.text} />

              {msg.toolRows && msg.toolRows.length > 0 && (
                <ul className="tool-row-list" aria-label={getCopy("chat.toolsLabel")}>
                  {msg.toolRows.map((row) => (
                    <li key={row.toolCallId} className="tool-execution-row">
                      <span className="tool-execution-name">{row.name}</span>
                      <span
                        className={[
                          "status-pill",
                          row.status === "failed" ? "is-blocked" : row.status === "running" ? "is-warn" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {getToolStatusLabel(row.status)}
                      </span>
                      {row.summary && <span className="tool-execution-summary">{row.summary}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      {stopError && (
        <div className="chat-alert" role="alert">
          {stopError}
        </div>
      )}

      {transcript && !transcript.chatAvailable ? (
        <section className="empty-relay-card chat-unavailable-card" role="status">
          <h2>{getCopy("chat.unavailableTitle")}</h2>
          <p>{getCopy("chat.unavailableBody")}</p>
        </section>
      ) : (
        <form
          className="composer-shell"
          onSubmit={(event) => {
            event.preventDefault();
            onSendPrompt();
          }}
        >
          <label htmlFor="composer-input" className="sr-only">
            {getCopy("composer.label")}
          </label>
          <textarea
            id="composer-input"
            ref={composerRef}
            className="composer-textarea"
            rows={2}
            value={composerDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!chatBusy && composerDraft.trim()) {
                  onSendPrompt();
                }
              }
            }}
            placeholder={getCopy("chat.composerPlaceholder")}
          />
          <div className="composer-bar">
            <span className="composer-hint">
              {transcript?.activeTurnId ? getCopy("chat.streamingBadge") : getCopy("route.statusReady")}
            </span>
            <div style={{ display: "inline-flex", gap: 8 }}>
              {transcript?.activeTurnId && transcript.supportedActions.promptCancel && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={transcript.turnStopping}
                  onClick={onStopTurn}
                >
                  {getCopy(transcript.turnStopping ? "chat.stoppingAction" : "chat.stopAction")}
                </button>
              )}
              <button
                type="submit"
                className="button button-primary"
                disabled={chatBusy || !composerDraft.trim()}
              >
                {getCopy("chat.sendAction")}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
