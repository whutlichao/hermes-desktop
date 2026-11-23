import { useRef, type RefObject } from "react";
import type {
  ApprovalChoice,
  ApprovalTopicSnapshot,
  ApprovalView,
  BridgeScope,
  ChatSessionProjection,
  ConnectionHealthSummary,
  DraftAttachment,
  DraftContextItem,
  DraftDeliveryStatus,
  DraftExportBundle,
  DraftRecord,
  LocalInspectResult,
  MissingSessionExport,
  SessionTranscriptSnapshot,
  ToolExecutionRow,
  TranscriptPendingApprovalView,
  TurnSessionRecoveryView,
} from "@hermes/contracts";
import { getCopy, getLocalFailureCopy } from "@hermes/domain";
import { AttributionBadge } from "./AttributionBadge";
import { ApprovalCard } from "./ApprovalCard";
import { MarkdownText } from "./MarkdownText";
import { TurnRecoveryCards } from "./TurnRecoveryCards";

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
  draftAttachments: DraftAttachment[];
  draftContexts: DraftContextItem[];
  draftDeliveryStatus: DraftDeliveryStatus;
  draftCapacityError: "over_single_limit" | "over_total_limit" | null;
  exportedDraft: DraftExportBundle | null;
  scopeNewDrafts: DraftRecord[];
  activeNewDraftId: string | null;
  stopError: string | null;
  turnRecovery: TurnSessionRecoveryView | null;
  recoveryBusy: boolean;
  cronHintText: string;
  hasRecentSession: boolean;
  canQueue: boolean;
  canSteer: boolean;
  canCancelQueue: boolean;
  canCreateSession: boolean;
  composerRef: RefObject<HTMLTextAreaElement>;
  onDraftChange: (value: string) => void;
  onAttachFiles: (files: FileList, reattachId?: string | null) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onRemoveContext: (contextId: string) => void;
  onClearDraft: () => void;
  onExportCurrentDraft: () => void;
  onSelectNewDraft: (draftId: string) => void;
  onStartNewDraft: () => void;
  onSendPrompt: () => void;
  onQueuePrompt: () => void;
  onStopTurn: () => void;
  onExportMissingSession: () => void;
  onDismissMissingSession: () => void;
  onRespondApproval: (approval: ApprovalView, choice: ApprovalChoice) => void;
  onInspectApproval: (approval: ApprovalView) => void;
  onDismissOrphanedApproval: (approval: ApprovalView) => void;
  onOpenCapabilities: () => void;
  onToggleWorkspace: () => void;
  onContinueRecent: () => void;
  onRepairLocal: () => void;
  onAddRemote: () => void;
  onAddSsh: () => void;
  onDiscardUnknown: () => void;
  onCancelQueued: (admissionId: string) => void;
  onCheckQueueReceipt: (submissionId: string) => void;
  onRetryQueue: (submissionId: string) => void;
  onSteer: (text: string) => void;
  onSteerFallbackNewTurn: (text: string) => void;
  onSteerFallbackQueue: (text: string) => void;
  onDismissSteerFallback: () => void;
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

function getApprovalStatusLabel(status: TranscriptPendingApprovalView["status"]): string {
  switch (status) {
    case "pending":
      return getCopy("chat.approvalStatus.pending");
    case "approved":
      return getCopy("chat.approvalStatus.approved");
    case "denied":
      return getCopy("chat.approvalStatus.denied");
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
  draftAttachments,
  draftContexts,
  draftDeliveryStatus,
  draftCapacityError,
  exportedDraft,
  scopeNewDrafts,
  activeNewDraftId,
  stopError,
  turnRecovery,
  recoveryBusy,
  cronHintText,
  hasRecentSession,
  canQueue,
  canSteer,
  canCancelQueue,
  canCreateSession,
  composerRef,
  onDraftChange,
  onAttachFiles,
  onRemoveAttachment,
  onRemoveContext,
  onClearDraft,
  onExportCurrentDraft,
  onSelectNewDraft,
  onStartNewDraft,
  onSendPrompt,
  onQueuePrompt,
  onStopTurn,
  onExportMissingSession,
  onDismissMissingSession,
  onRespondApproval,
  onInspectApproval,
  onDismissOrphanedApproval,
  onOpenCapabilities,
  onToggleWorkspace,
  onContinueRecent,
  onRepairLocal,
  onAddRemote,
  onAddSsh,
  onDiscardUnknown,
  onCancelQueued,
  onCheckQueueReceipt,
  onRetryQueue,
  onSteer,
  onSteerFallbackNewTurn,
  onSteerFallbackQueue,
  onDismissSteerFallback,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reattachTargetIdRef = useRef<string | null>(null);
  const hasExpiredAttachment = draftAttachments.some((att) => Boolean(att.expired));
  const hasEstablishedScope = Boolean(activeConnection || chatState?.lastActiveChat);
  const isTrulyUnconnected = !hasReadyConnection && !hasEstablishedScope;
  const queuePaused = Boolean(turnRecovery?.queuePaused || turnRecovery?.unknownTurn);

  const renderDraftAlertsAndComposer = () => {
    if (isTrulyUnconnected) {
      return (
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
      );
    }

    const canSubmit =
      hasReadyConnection &&
      !chatBusy &&
      !queuePaused &&
      !hasExpiredAttachment &&
      Boolean(composerDraft.trim());
    const canQueueNow =
      canQueue &&
      hasReadyConnection &&
      !chatBusy &&
      !queuePaused &&
      Boolean(transcript?.activeTurnId) &&
      Boolean(composerDraft.trim());

    return (
      <>
        {draftDeliveryStatus === "delivery_unknown" && (
          <div
            className="draft-alert-card"
            role="status"
            data-testid="draft-delivery-unknown-alert"
          >
            <div className="draft-alert-header">
              <span className="status-pill is-warn">{getCopy("draft.deliveryUnknownBadge")}</span>
            </div>
            <span>{getCopy("draft.deliveryUnknownBody")}</span>
          </div>
        )}

        {draftCapacityError && (
          <div
            className="draft-alert-card"
            role="alert"
            data-testid="draft-capacity-alert"
          >
            <span>
              {getCopy(
                draftCapacityError === "over_total_limit"
                  ? "draft.capacityExceededTotal"
                  : "draft.capacityExceededSingle",
              )}
            </span>
            <div className="draft-alert-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={onExportCurrentDraft}
              >
                {getCopy("draft.capacityExportAction")}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={onClearDraft}
              >
                {getCopy("draft.capacityCleanupAction")}
              </button>
            </div>
          </div>
        )}

        {exportedDraft && (
          <div className="resync-notice" role="status" data-testid="draft-export-preview">
            <pre className="diagnostics-json">{JSON.stringify(exportedDraft, null, 2)}</pre>
          </div>
        )}

        {hasExpiredAttachment && (
          <div
            className="draft-alert-card"
            role="alert"
            data-testid="draft-attachment-expired-alert"
          >
            <span>{getCopy("draft.reattachHint")}</span>
          </div>
        )}

        <form
          className="composer-shell"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              onSendPrompt();
            }
          }}
        >
          {!activeSessionId && scopeNewDrafts.length > 0 && (
            <div className="draft-new-list" data-testid="scope-new-drafts-bar">
              {scopeNewDrafts.map((d) => (
                <button
                  key={d.draftId}
                  type="button"
                  className={[
                    "draft-attachment-btn",
                    d.draftId === activeNewDraftId && "is-active",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={d.draftId === activeNewDraftId}
                  onClick={() => onSelectNewDraft(d.draftId)}
                >
                  {d.text.trim() ? d.text.trim().slice(0, 18) : d.draftId}
                </button>
              ))}
              <button
                type="button"
                className="draft-attachment-btn"
                onClick={onStartNewDraft}
              >
                {getCopy("draft.newDraftAction")}
              </button>
            </div>
          )}

          {(draftAttachments.length > 0 || draftContexts.length > 0) && (
            <div className="draft-attachments-bar" data-testid="draft-attachments-bar">
              {draftAttachments.map((att) => (
                <span
                  key={att.attachmentId}
                  className={["draft-attachment-chip", att.expired && "is-expired"]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid={`draft-attachment-${att.attachmentId}`}
                >
                  <span>{att.displayName}</span>
                  {att.expired && (
                    <>
                      <span className="status-pill is-warn">
                        {getCopy("draft.attachmentExpiredBadge")}
                      </span>
                      <button
                        type="button"
                        className="draft-attachment-btn"
                        onClick={() => {
                          reattachTargetIdRef.current = att.attachmentId;
                          fileInputRef.current?.click();
                        }}
                      >
                        {getCopy("draft.reattachAction")}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="draft-attachment-btn"
                    aria-label={`${getCopy("draft.removeAttachmentAction")} ${att.displayName}`}
                    onClick={() => onRemoveAttachment(att.attachmentId)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {draftContexts.map((ctx) => (
                <span
                  key={ctx.contextId}
                  className="draft-attachment-chip"
                  data-testid={`draft-context-${ctx.contextId}`}
                >
                  <span>{ctx.label}</span>
                  <button
                    type="button"
                    className="draft-attachment-btn"
                    aria-label={`${getCopy("draft.removeAttachmentAction")} ${ctx.label}`}
                    onClick={() => onRemoveContext(ctx.contextId)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            data-testid="draft-file-input"
            onChange={(event) => {
              const files = event.target.files;
              if (files && files.length > 0) {
                onAttachFiles(files, reattachTargetIdRef.current);
              }
              reattachTargetIdRef.current = null;
              event.target.value = "";
            }}
          />

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
                if (canSubmit) {
                  onSendPrompt();
                }
              }
            }}
            placeholder={getCopy("chat.composerPlaceholder")}
          />
          <div className="composer-bar">
            <span className="composer-hint">
              {!hasReadyConnection
                ? getCopy("draft.offlineLocalBadge")
                : transcript?.activeTurnId
                  ? getCopy("chat.streamingBadge")
                  : getCopy("route.statusReady")}
            </span>
            <div style={{ display: "inline-flex", gap: 8 }}>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  reattachTargetIdRef.current = null;
                  fileInputRef.current?.click();
                }}
              >
                {getCopy("draft.attachAction")}
              </button>
              {transcript?.activeTurnId && canQueue && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!canQueueNow}
                  onClick={onQueuePrompt}
                >
                  {getCopy("turn.queue.queueAction")}
                </button>
              )}
              {transcript?.activeTurnId && transcript.supportedActions.promptCancel && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={transcript.turnStopping || turnRecovery?.stopState === "stopping"}
                  onClick={onStopTurn}
                >
                  {getCopy(
                    transcript.turnStopping || turnRecovery?.stopState === "stopping"
                      ? "chat.stoppingAction"
                      : "chat.stopAction",
                  )}
                </button>
              )}
              <button
                type="submit"
                className="button button-primary"
                disabled={!canSubmit}
              >
                {getCopy("chat.sendAction")}
              </button>
            </div>
          </div>
        </form>
      </>
    );
  };

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
    const failureCopy = localInspection?.failure
      ? getLocalFailureCopy(localInspection.failure.code)
      : null;
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

        <section
          className="empty-relay-card onboarding-empty-card"
          aria-labelledby="empty-relay-heading"
        >
          <h1 id="empty-relay-heading">
            {isRemoteAuthRequired ? getCopy("remote.authRequiredTitle") : getCopy("empty.title")}
          </h1>
          <p>{isRemoteAuthRequired ? getCopy("remote.authRequiredBody") : getCopy("empty.body")}</p>
          {localInspection && (
            <div
              className="local-repair-header onboarding-local-repair"
              data-testid="onboarding-local-repair"
            >
              <p className="local-repair-meta">
                {localInspection.label} · {localInspection.cli.displayName}
              </p>
              <span className={`status-pill ${localInspection.failure ? "is-blocked" : "is-ready"}`}>
                {localInspection.failure
                  ? getCopy("local.statusBlocked")
                  : getCopy("local.statusReady")}
              </span>
            </div>
          )}
          {failureCopy && (
            <dl className="local-repair-dl onboarding-details">
              <div>
                <dt>{getCopy("local.whatHappenedLabel")}</dt>
                <dd>{failureCopy.whatHappened}</dd>
              </div>
              <div>
                <dt>{getCopy("local.possibleCausesLabel")}</dt>
                <dd>{failureCopy.possibleCauses}</dd>
              </div>
              <div>
                <dt>{getCopy("local.nextStepLabel")}</dt>
                <dd>{failureCopy.nextStep}</dd>
              </div>
            </dl>
          )}
          <div className="empty-relay-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={localBusy}
              onClick={onRepairLocal}
            >
              {getCopy("empty.actionRepairLocal")}
            </button>
            <button type="button" className="button button-secondary" onClick={onAddRemote}>
              {getCopy("empty.actionAddRemote")}
            </button>
            <button type="button" className="button button-secondary" onClick={onAddSsh}>
              {getCopy("empty.actionAddSsh")}
            </button>
          </div>
          <p className="empty-cron-hint">{cronHintText}</p>
        </section>

        {approvalSections}

        {renderDraftAlertsAndComposer()}
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

      {(!transcript || transcript.messages.length === 0) && scopeNewDrafts.length === 0 ? (
        <section
          className="empty-relay-card chat-empty-card"
          aria-labelledby="chat-empty-heading"
          data-testid="chat-empty-state"
        >
          <h1 id="chat-empty-heading">{getCopy("chat.emptyTitle")}</h1>
          <p>{getCopy("chat.emptyBody")}</p>
          <div className="empty-relay-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!hasRecentSession || !canCreateSession}
              onClick={onContinueRecent}
            >
              {getCopy("chat.emptyContinueRecent")}
            </button>
            <button type="button" className="button button-secondary" onClick={onOpenCapabilities}>
              {getCopy("chat.emptyCapabilities")}
            </button>
            <button type="button" className="button button-secondary" onClick={onToggleWorkspace}>
              {getCopy("chat.emptyOpenWorkspace")}
            </button>
          </div>
          <p className="empty-cron-hint">{cronHintText}</p>
        </section>
      ) : (
        transcript &&
        transcript.messages.length > 0 && (
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
                      <AttributionBadge
                        attribution={row.attribution}
                        testId={`tool-attribution-${row.toolCallId}`}
                      />
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
        )
      )}

      <TurnRecoveryCards
        recovery={turnRecovery}
        busy={recoveryBusy}
        canCancelQueue={canCancelQueue}
        canSteer={canSteer}
        onDiscardUnknown={onDiscardUnknown}
        onCancelQueued={onCancelQueued}
        onCheckQueueReceipt={onCheckQueueReceipt}
        onRetryQueue={onRetryQueue}
        onSteer={onSteer}
        onSteerFallbackNewTurn={onSteerFallbackNewTurn}
        onSteerFallbackQueue={onSteerFallbackQueue}
        onDismissSteerFallback={onDismissSteerFallback}
      />

      {transcript?.pendingApprovals && transcript.pendingApprovals.length > 0 && (
        <section
          className="approval-cards-section"
          aria-label={getCopy("chat.approvalsTitle")}
          data-testid="pending-approvals-section"
        >
          <h2 className="approval-cards-heading">{getCopy("chat.approvalsTitle")}</h2>
          <ul className="approval-cards-list">
            {transcript.pendingApprovals.map((approval) => (
              <li
                key={approval.approvalId}
                className="approval-card"
                data-testid={`approval-card-${approval.approvalId}`}
              >
                <div className="approval-card-header">
                  <strong className="tool-execution-name">{approval.toolName}</strong>
                  <AttributionBadge
                    attribution={approval.attribution}
                    testId={`approval-attribution-${approval.approvalId}`}
                  />
                  <span className="status-pill is-warn">
                    {getApprovalStatusLabel(approval.status)}
                  </span>
                </div>
                <p className="approval-card-summary">{approval.summary}</p>
              </li>
            ))}
          </ul>
        </section>
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
        renderDraftAlertsAndComposer()
      )}
    </div>
  );
}
