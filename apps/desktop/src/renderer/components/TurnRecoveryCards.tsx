import { useState } from "react";
import type {
  QueuedAdmissionState,
  SteerFailureReason,
  TurnSessionRecoveryView,
} from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";

interface TurnRecoveryCardsProps {
  recovery: TurnSessionRecoveryView | null;
  busy: boolean;
  canCancelQueue: boolean;
  canSteer: boolean;
  onDiscardUnknown: () => void;
  onCancelQueued: (admissionId: string) => void;
  onCheckQueueReceipt: (submissionId: string) => void;
  onRetryQueue: (submissionId: string) => void;
  onSteer: (text: string) => void;
  onSteerFallbackNewTurn: (text: string) => void;
  onSteerFallbackQueue: (text: string) => void;
  onDismissSteerFallback: () => void;
}

const QUEUE_STATE_COPY: Record<QueuedAdmissionState, CopyKey> = {
  queued: "turn.queue.state.queued",
  cancelling: "turn.queue.state.cancelling",
  cancel_unknown: "turn.queue.state.cancel_unknown",
  cancelled: "turn.queue.state.cancelled",
  stopped: "turn.queue.state.stopped",
  already_started: "turn.queue.state.already_started",
  completed: "turn.queue.state.completed",
  error: "turn.queue.state.error",
  interrupted: "turn.queue.state.interrupted",
};

const STEER_REASON_COPY: Record<SteerFailureReason, CopyKey> = {
  turn_finished: "turn.steer.reason.turn_finished",
  generation_mismatch: "turn.steer.reason.generation_mismatch",
  not_running: "turn.steer.reason.not_running",
  rejected: "turn.steer.reason.rejected",
  unreachable: "turn.steer.reason.unreachable",
  timeout: "turn.steer.reason.timeout",
};

function queueStateClass(state: QueuedAdmissionState): string {
  if (state === "error") return "is-blocked";
  if (state === "cancel_unknown" || state === "cancelling" || state === "already_started") {
    return "is-warn";
  }
  if (state === "cancelled" || state === "stopped" || state === "interrupted") {
    return "is-ready";
  }
  return "";
}

function lostReasonCopy(reason: string): string {
  return reason === "owner_restarted"
    ? getCopy("turn.unknown.reason.owner_restarted")
    : getCopy("turn.unknown.reason.unknown");
}

export function TurnRecoveryCards({
  recovery,
  busy,
  canCancelQueue,
  canSteer,
  onDiscardUnknown,
  onCancelQueued,
  onCheckQueueReceipt,
  onRetryQueue,
  onSteer,
  onSteerFallbackNewTurn,
  onSteerFallbackQueue,
  onDismissSteerFallback,
}: TurnRecoveryCardsProps) {
  const [steerText, setSteerText] = useState("");
  if (!recovery) return null;

  const unknown = recovery.unknownTurn;
  const fallback = recovery.pendingSteerFallback;
  const activeQueue = recovery.queuedAdmissions.filter(
    (item) =>
      item.state === "queued" ||
      item.state === "cancelling" ||
      item.state === "cancel_unknown" ||
      item.state === "already_started" ||
      item.state === "stopped",
  );
  const canSteerNow =
    canSteer && Boolean(recovery.activeTurnId) && recovery.stopState !== "cancel_outcome_unknown";

  return (
    <div className="turn-recovery-stack">
      {unknown && (
        <section
          className="turn-recovery-card is-blocking"
          aria-labelledby="unknown-turn-heading"
          data-testid="unknown-turn-card"
        >
          <div className="turn-recovery-head">
            <h2 id="unknown-turn-heading">{getCopy("turn.unknown.title")}</h2>
            <span className="status-pill is-blocked">{getCopy("turn.unknown.pausedBadge")}</span>
          </div>
          <p>{getCopy("turn.unknown.body")}</p>
          <details className="turn-recovery-details">
            <summary>{getCopy("turn.unknown.detailsAction")}</summary>
            <dl className="turn-recovery-dl">
              <div>
                <dt>{getCopy("turn.unknown.admissionLabel")}</dt>
                <dd>
                  <code>{unknown.admissionId}</code>
                </dd>
              </div>
              <div>
                <dt>{getCopy("turn.unknown.generationLabel")}</dt>
                <dd>{unknown.executionGeneration}</dd>
              </div>
              <div>
                <dt>{getCopy("turn.unknown.ownerGenerationLabel")}</dt>
                <dd>{unknown.ownerGeneration}</dd>
              </div>
              {unknown.turnId && (
                <div>
                  <dt>{getCopy("turn.unknown.turnIdLabel")}</dt>
                  <dd>
                    <code>{unknown.turnId}</code>
                  </dd>
                </div>
              )}
              <div>
                <dt>{getCopy("turn.unknown.reasonLabel")}</dt>
                <dd>{lostReasonCopy(unknown.lostReason)}</dd>
              </div>
              {unknown.originalInput && (
                <div>
                  <dt>{getCopy("turn.unknown.originalInputLabel")}</dt>
                  <dd>
                    <pre className="turn-recovery-input">{unknown.originalInput}</pre>
                  </dd>
                </div>
              )}
            </dl>
          </details>
          <p className="turn-recovery-note">{getCopy("turn.queue.pausedNotice")}</p>
          <div className="turn-recovery-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || Boolean(unknown.resolving)}
              onClick={onDiscardUnknown}
            >
              {getCopy(unknown.resolving ? "turn.unknown.discardBusy" : "turn.unknown.discardAction")}
            </button>
          </div>
        </section>
      )}

      {recovery.stopState === "cancel_outcome_unknown" && (
        <section
          className="turn-recovery-card is-warn"
          role="status"
          aria-labelledby="stop-unknown-heading"
          data-testid="stop-outcome-unknown-card"
        >
          <div className="turn-recovery-head">
            <h2 id="stop-unknown-heading">{getCopy("turn.stop.cancelOutcomeUnknownTitle")}</h2>
            <span className="status-pill is-warn">{getCopy("turn.queue.state.cancel_unknown")}</span>
          </div>
          <p>{getCopy("turn.stop.cancelOutcomeUnknownBody")}</p>
        </section>
      )}

      {recovery.queuePaused && !unknown && (
        <div className="turn-recovery-notice" role="status">
          {getCopy("turn.queue.pausedNotice")}
        </div>
      )}

      {recovery.pendingDeliveryUnknown.length > 0 && (
        <section
          className="turn-recovery-card is-warn"
          aria-labelledby="queue-unknown-heading"
          data-testid="queue-delivery-unknown"
        >
          <div className="turn-recovery-head">
            <h2 id="queue-unknown-heading">{getCopy("turn.queue.deliveryUnknownTitle")}</h2>
            <span className="status-pill is-warn">{getCopy("draft.deliveryUnknownBadge")}</span>
          </div>
          <p>{getCopy("turn.queue.deliveryUnknownBody")}</p>
          <ul className="turn-recovery-list">
            {recovery.pendingDeliveryUnknown.map((pending) => (
              <li key={pending.submissionId} className="turn-recovery-row">
                <span className="turn-recovery-row-text">{pending.text}</span>
                <code>{pending.submissionId}</code>
                <div className="turn-recovery-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => onCheckQueueReceipt(pending.submissionId)}
                  >
                    {getCopy("turn.queue.checkReceiptAction")}
                  </button>
                  {pending.canRetrySameSubmission && (
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy}
                      onClick={() => onRetryQueue(pending.submissionId)}
                    >
                      {getCopy("turn.queue.retrySameAction")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {activeQueue.length > 0 && (
        <section
          className="turn-recovery-card"
          aria-labelledby="queue-section-heading"
          data-testid="queue-card"
        >
          <div className="turn-recovery-head">
            <h2 id="queue-section-heading">{getCopy("turn.queue.sectionTitle")}</h2>
            <span className="gateway-badge">{activeQueue.length}</span>
          </div>
          <ol className="turn-recovery-list">
            {activeQueue.map((item) => (
              <li
                key={item.admissionId}
                className="turn-recovery-row"
                data-testid={`queue-item-${item.admissionId}`}
              >
                <div className="turn-recovery-row-head">
                  <span className="turn-recovery-position">{item.position}</span>
                  <span className="turn-recovery-row-text">{item.text}</span>
                  <span className={`status-pill ${queueStateClass(item.state)}`}>
                    {getCopy(QUEUE_STATE_COPY[item.state])}
                  </span>
                  {item.lastKnownUnverified && (
                    <span className="status-pill is-warn">
                      {getCopy("turn.queue.unverifiedBadge")}
                    </span>
                  )}
                </div>
                <code>{item.admissionId}</code>
                {item.statusReason && <p className="turn-recovery-note">{item.statusReason}</p>}
                {(item.state === "queued" || item.state === "cancel_unknown") && canCancelQueue && (
                  <div className="turn-recovery-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => onCancelQueued(item.admissionId)}
                    >
                      {getCopy("turn.queue.cancelAction")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {canSteerNow && (
        <section className="turn-recovery-card" aria-labelledby="steer-heading">
          <div className="turn-recovery-head">
            <h2 id="steer-heading">{getCopy("turn.steer.label")}</h2>
          </div>
          <label htmlFor="turn-steer-input" className="sr-only">
            {getCopy("turn.steer.label")}
          </label>
          <textarea
            id="turn-steer-input"
            className="composer-textarea turn-steer-input"
            rows={2}
            value={steerText}
            placeholder={getCopy("turn.steer.placeholder")}
            onChange={(event) => setSteerText(event.target.value)}
          />
          <div className="turn-recovery-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !steerText.trim()}
              onClick={() => {
                onSteer(steerText.trim());
                setSteerText("");
              }}
            >
              {getCopy("turn.steer.sendAction")}
            </button>
          </div>
        </section>
      )}

      {fallback && (
        <section
          className="turn-recovery-card is-warn"
          aria-labelledby="steer-fallback-heading"
          data-testid="steer-fallback-card"
        >
          <div className="turn-recovery-head">
            <h2 id="steer-fallback-heading">{getCopy("turn.steer.fallbackTitle")}</h2>
            <span className="status-pill is-warn">{getCopy(STEER_REASON_COPY[fallback.reason])}</span>
          </div>
          <p>{fallback.message || getCopy("turn.steer.fallbackBody")}</p>
          <p className="turn-recovery-row-text">{fallback.text}</p>
          <div className="turn-recovery-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => onSteerFallbackNewTurn(fallback.text)}
            >
              {getCopy("turn.steer.fallbackNewTurn")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => onSteerFallbackQueue(fallback.text)}
            >
              {getCopy("turn.steer.fallbackQueue")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={onDismissSteerFallback}
            >
              {getCopy("turn.steer.dismissFallback")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
