import type { LocalInspectResult, LocalSafeActionId } from "@hermes/contracts";
import { getCopy, getLocalFailureCopy } from "@hermes/domain";

interface LocalRepairCardProps {
  inspection: LocalInspectResult | null;
  busy: boolean;
  onAction: (action: LocalSafeActionId) => void;
  onOpenRemoteEscape: () => void;
}

const ACTION_COPY_KEYS: Record<LocalSafeActionId, Parameters<typeof getCopy>[0]> = {
  choose_cli: "local.action.choose_cli",
  open_install_docs: "local.action.open_install_docs",
  open_update_docs: "local.action.open_update_docs",
  retry: "local.action.retry",
  restart_gateway: "local.action.restart_gateway",
  open_status: "local.action.open_status",
  open_diagnostics: "local.action.open_diagnostics",
  switch_profile: "local.action.switch_profile",
};

const PRIMARY_ACTIONS = new Set<LocalSafeActionId>([
  "choose_cli",
  "retry",
  "restart_gateway",
]);

export function LocalRepairCard({
  inspection,
  busy,
  onAction,
  onOpenRemoteEscape,
}: LocalRepairCardProps) {
  if (!inspection) {
    return (
      <section className="local-repair-card" aria-label={getCopy("local.title")}>
        <div className="local-repair-header">
          <h2>{getCopy("local.title")}</h2>
          <span className="status-pill">{getCopy("local.statusPending")}</span>
        </div>
      </section>
    );
  }

  const failure = inspection.failure;
  const failureCopy = failure ? getLocalFailureCopy(failure.code) : null;
  const statusLabel = failure
    ? inspection.actual === "reconnecting"
      ? getCopy("local.statusReconnecting")
      : getCopy("local.statusBlocked")
    : getCopy("local.statusReady");

  const statusTone = failure
    ? inspection.actual === "reconnecting"
      ? "is-warn"
      : "is-blocked"
    : "is-ready";

  return (
    <section className="local-repair-card" aria-labelledby="local-repair-heading">
      <div className="local-repair-header">
        <div>
          <h2 id="local-repair-heading">{getCopy("local.title")}</h2>
          <p className="local-repair-meta">
            {getCopy("local.cliSummaryLabel")}：{inspection.cli.displayName}
            {inspection.cli.version ? ` · ${inspection.cli.version}` : ""}
          </p>
        </div>
        <span className={`status-pill ${statusTone}`}>{statusLabel}</span>
      </div>

      {failure && failureCopy ? (
        <>
          <dl className="local-repair-dl">
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
            {failure.restartAttempts && (
              <div>
                <dt>{getCopy("local.restartAttemptLabel")}</dt>
                <dd>
                  {failure.restartAttempts.current}/{failure.restartAttempts.max}
                </dd>
              </div>
            )}
          </dl>

          <div className="empty-relay-actions">
            {failure.actions.map((actionId, index) => (
              <button
                key={actionId}
                type="button"
                disabled={busy}
                className={
                  index === 0 && PRIMARY_ACTIONS.has(actionId)
                    ? "button button-primary"
                    : "button button-secondary"
                }
                onClick={() => onAction(actionId)}
              >
                {getCopy(ACTION_COPY_KEYS[actionId])}
              </button>
            ))}
            <button
              type="button"
              disabled={busy}
              className="button button-secondary"
              onClick={onOpenRemoteEscape}
            >
              {getCopy("local.escapeRemoteSsh")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="local-repair-ready-copy">{getCopy("local.inspectReadyBody")}</p>
          <div className="empty-relay-actions">
            <button
              type="button"
              disabled={busy}
              className="button button-secondary"
              onClick={() => onAction("retry")}
            >
              {getCopy("local.action.retry")}
            </button>
            <button
              type="button"
              disabled={busy}
              className="button button-secondary"
              onClick={() => onAction("open_diagnostics")}
            >
              {getCopy("local.action.open_diagnostics")}
            </button>
            <button
              type="button"
              disabled={busy}
              className="button button-secondary"
              onClick={onOpenRemoteEscape}
            >
              {getCopy("local.escapeRemoteSsh")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
