import type { RefObject } from "react";
import type {
  ApprovalChoice,
  ApprovalTopicSnapshot,
  ApprovalView,
  BridgeScope,
  ChatSessionProjection,
  ConnectionHealthSummary,
  LocalInspectResult,
  LocalSafeActionId,
  MissingSessionExport,
  SessionTranscriptSnapshot,
  ToolExecutionRow,
} from "@hermes/contracts";
import { getCopy } from "@hermes/domain";
import { ApprovalCard } from "./ApprovalCard";
import { LocalRepairCard } from "./LocalRepairCard";
import { MarkdownText } from "./MarkdownText";

interface ChatThreadProps {
  hasReadyConnection: boolean;
  activeConnection?: ConnectionHealthSummary | null;
  activeScope: BridgeScope | null;
  activeSessionId: string | null;
  approvals: ApprovalTopicSnapshot;
  cancelledApprovalKey: string | null;
  transcript: SessionTranscriptSnapshot | null;
  chatState: ChatSessionProjection | null;
  exportedMissing: MissingSessionExport | null;
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
  onExportMissingSession: () => void;
  onDismissMissingSession: () => void;
  onLocalAction: (action: LocalSafeActionId) => void;
  onRespondApproval: (approval: ApprovalView, choice: ApprovalChoice) => void;
  onInspectApproval: (approval: ApprovalView) => void;
  onDismissOrphanedApproval: (approval: ApprovalView) => void;
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
  activeScope,
  activeSessionId,
  approvals,
  cancelledApprovalKey,
  transcript,
  chatState,
  exportedMissing,
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
  onExportMissingSession,
  onDismissMissingSession,
  onLocalAction,
  onRespondApproval,
  onInspectApproval,
  onDismissOrphanedApproval,
  onOpenSettings,
  onOpenPalette,
  onOpenShortcuts,
  onOpenRemoteEscape,
}: ChatThreadProps) {
  const owningScope = activeScope ?? chatState?.lastActiveChat ?? null;
  const owningConnId = owningScope?.connectionId ?? null;
  const owningProfileId = owningScope?.profileId ?? "default";
  const owningSessionId = activeSessionId ?? owningScope?.sessionId ?? null;

  const owningApprovals = approvals.approvals.filter(
    (item) =>
      item.state !== "orphaned" &&
      owningConnId !== null &&
      owningSessionId !== null &&
      item.connectionId === owningConnId &&
      item.profileId === owningProfileId &&
      item.sessionId === owningSessionId,
  );
  const orphanedApprovals = approvals.approvals.filter((item) => item.state === "orphaned");

  const approvalSections = (
    <>
      {owningApprovals.length > 0 && (
        <section className="approval-section" aria-label={getCopy("approval.sectionLabel")}>
          {owningApprovals.map((approval) => (
            <ApprovalCard
              key={approval.approvalKey}
              approval={approval}
              cancelledNotice={cancelledApprovalKey === approval.approvalKey}
              onRespond={onRespondApproval}
              onInspect={onInspectApproval}
              onDismissOrphaned={onDismissOrphanedApproval}
            />
          ))}
        </section>
      )}
      {orphanedApprovals.length > 0 && (
        <section
          className="approval-orphaned-section"
          aria-label={getCopy("approval.orphanedSectionLabel")}
        >
          {orphanedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.approvalKey}
              approval={approval}
              cancelledNotice={false}
              onRespond={onRespondApproval}
              onInspect={onInspectApproval}
              onDismissOrphaned={onDismissOrphanedApproval}
            />
          ))}
        </section>
      )}
    </>
  );

  if (!hasReadyConnection) {
    const unverifiedChat = chatState?.lastKnownUnverified ? chatState.lastActiveChat : null;
    const unverifiedSummary =
      unverifiedChat?.sessionId
        ? chatState?.sessionSummaries[
            `${unverifiedChat.connectionId}::${unverifiedChat.profileId}::${unverifiedChat.sessionId}`
          ]
        : null;
    const isRemoteAuthRequired =
      activeConnection?.kind === "remote" && activeConnection.actual === "auth_required";
    return (
      <div className="thread-column">
        {unverifiedChat && (
          <section className="empty-relay-card unverified-card" role="status">
            <div className="local-repair-header">
              <h2>
                {unverifiedSummary?.title ?? unverifiedChat.sessionId ?? unverifiedChat.profileId}
              </h2>
              <span className="status-pill is-warn">{getCopy("route.unverifiedBadge")}</span>
            </div>
            <p>
              {unverifiedChat.connectionId} / {unverifiedChat.profileId}
              {unverifiedChat.sessionId ? ` / ${unverifiedChat.sessionId}` : ""}
            </p>
          </section>
        )}

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

        {approvalSections}

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

  if (chatState?.activeStatus === "session_missing" && chatState.missingSession) {
    const missing = chatState.missingSession;
    return (
      <div className="thread-column">
        <section
          className="empty-relay-card session-missing-card"
          aria-labelledby="session-missing-heading"
        >
          <h1 id="session-missing-heading">{getCopy("chat.sessionMissingTitle")}</h1>
          <p>{getCopy("chat.sessionMissingBody")}</p>

          <dl className="local-repair-dl">
            <div>
              <dt>{getCopy("nav.sessionDetailsScope")}</dt>
              <dd>
                {missing.connectionId} / {missing.profileId} / {missing.sessionId}
              </dd>
            </div>
            <div>
              <dt>{getCopy("nav.sessionDetailsTitle")}</dt>
              <dd>{missing.title}</dd>
            </div>
            {missing.draftText && (
              <div>
                <dt>{getCopy("chat.sessionMissingDraftLabel")}</dt>
                <dd>
                  <pre className="missing-draft-preview">{missing.draftText}</pre>
                </dd>
              </div>
            )}
          </dl>

          <div className="empty-relay-actions" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="button button-primary"
              onClick={onExportMissingSession}
            >
              {getCopy("chat.sessionMissingExportAction")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={onDismissMissingSession}
            >
              {getCopy("chat.sessionMissingDismissAction")}
            </button>
          </div>

          {exportedMissing && (
            <div className="resync-notice" role="status" style={{ marginTop: 12 }}>
              <span className="status-pill is-ready">
                {getCopy("chat.sessionMissingExportedNotice")}
              </span>
              <pre className="diagnostics-json" style={{ marginTop: 8 }}>
                {JSON.stringify(exportedMissing, null, 2)}
              </pre>
            </div>
          )}
        </section>
        {approvalSections}
      </div>
    );
  }

  return (
    <div className="thread-column">
      {transcript?.resynced && (
        <div className="resync-notice" role="status">
          <span className="status-pill is-ready">{getCopy("chat.resyncedNotice")}</span>
        </div>
      )}

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

      {approvalSections}

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
