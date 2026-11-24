import type { ApprovalChoice, ApprovalRiskCategory, ApprovalView } from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";

interface ApprovalCardProps {
  approval: ApprovalView;
  cancelledNotice?: boolean;
  onRespond: (approval: ApprovalView, choice: ApprovalChoice) => void;
  onInspect: (approval: ApprovalView) => void;
  onDismissOrphaned: (approval: ApprovalView) => void;
}

const CHOICE_ORDER: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];

function getStatePillClass(state: ApprovalView["state"]): string {
  switch (state) {
    case "actionable":
      return "status-pill is-warn";
    case "settled":
      return "status-pill is-ready";
    case "context_incomplete":
    case "stale_owner":
    case "expired":
    case "orphaned":
      return "status-pill is-blocked";
    default:
      return "status-pill";
  }
}

function getRiskLabel(category: ApprovalRiskCategory): string {
  return getCopy(`approval.risk.${category}` as CopyKey);
}

function getStateNotice(approval: ApprovalView, cancelledNotice?: boolean): string | null {
  switch (approval.state) {
    case "context_incomplete":
      return getCopy("approval.contextIncompleteBody");
    case "unverified":
      return getCopy("approval.unverifiedBody");
    case "stale_owner":
      return getCopy("approval.staleOwnerBody");
    case "expired":
      return getCopy("approval.expiredBody");
    case "orphaned":
      return getCopy("approval.orphanedBody");
    case "delivery_unknown":
      return getCopy("approval.deliveryUnknownBody");
    case "settled_elsewhere_by_server":
      return approval.statusReason ?? getCopy("approval.settledElsewhereBody");
    case "actionable":
      return cancelledNotice ? getCopy("approval.cancelledPendingNotice") : null;
    default:
      return null;
  }
}

export function ApprovalCard({
  approval,
  cancelledNotice = false,
  onRespond,
  onInspect,
  onDismissOrphaned,
}: ApprovalCardProps) {
  const notice = getStateNotice(approval, cancelledNotice);
  const visibleChoices = CHOICE_ORDER.filter((choice) => {
    if (!approval.allowedChoices.includes(choice)) return false;
    if (choice === "always" && !approval.persistentGrant) return false;
    return true;
  });

  return (
    <article
      className={`approval-card is-${approval.state}`}
      data-testid="approval-card"
      data-approval-key={approval.approvalKey}
      data-approval-state={approval.state}
    >
      <div className="approval-header">
        <div className="approval-title-group">
          <h3 className="approval-title">{getCopy("approval.cardTitle")}</h3>
          {approval.riskCategories.map((category) => (
            <span key={category} className="approval-risk-tag" data-testid={`approval-risk-${category}`}>
              {getRiskLabel(category)}
            </span>
          ))}
          {approval.smartDenied && (
            <span className="status-pill is-warn" data-testid="approval-smart-denied-badge">
              {getCopy("approval.smartDeniedBadge")}
            </span>
          )}
        </div>
        <span className={getStatePillClass(approval.state)} data-testid="approval-state-badge">
          {getCopy(`approval.state.${approval.state}` as CopyKey)}
        </span>
      </div>

      <dl className="approval-context-dl">
        <div>
          <dt>{getCopy("approval.field.connection")}</dt>
          <dd>
            {approval.connectionLabel} ({approval.connectionKind})
          </dd>
        </div>
        <div>
          <dt>{getCopy("approval.field.host")}</dt>
          <dd>{approval.hostDisplay || getCopy("common.notProvided")}</dd>
        </div>
        <div>
          <dt>{getCopy("approval.field.profile")}</dt>
          <dd>{approval.profileDisplayName || approval.profileId}</dd>
        </div>
        <div>
          <dt>{getCopy("approval.field.session")}</dt>
          <dd>{approval.sessionTitle || approval.sessionId}</dd>
        </div>
        <div>
          <dt>{getCopy("approval.field.turn")}</dt>
          <dd>{approval.turnId ?? getCopy("common.notProvided")}</dd>
        </div>
        <div>
          <dt>{getCopy("approval.field.cwd")}</dt>
          <dd>
            {approval.cwd ? <code>{approval.cwd}</code> : getCopy("common.notProvided")}
          </dd>
        </div>
        <div>
          <dt>{getCopy("approval.field.command")}</dt>
          <dd>
            {approval.command ? (
              <code className="approval-command-code">{approval.command}</code>
            ) : (
              getCopy("common.notProvided")
            )}
          </dd>
        </div>
        {approval.description && (
          <div>
            <dt>{getCopy("approval.field.description")}</dt>
            <dd>{approval.description}</dd>
          </div>
        )}
        {approval.persistentGrant && (
          <div>
            <dt>{getCopy("approval.field.persistentGrant")}</dt>
            <dd>
              <code>{approval.persistentGrant.pattern}</code> · {approval.persistentGrant.scope} ·{" "}
              {approval.persistentGrant.revokeHint}
            </dd>
          </div>
        )}
        {approval.missingContextFields.length > 0 && (
          <div>
            <dt>{getCopy("approval.field.missingContext")}</dt>
            <dd>{approval.missingContextFields.join(", ")}</dd>
          </div>
        )}
      </dl>

      {approval.smartDenied && approval.smartDeniedReason && (
        <p className="approval-notice" role="status">
          {approval.smartDeniedReason}
        </p>
      )}

      {notice && (
        <p
          className="approval-notice"
          role="status"
          data-testid={
            cancelledNotice && approval.state === "actionable"
              ? "approval-cancelled-notice"
              : "approval-state-notice"
          }
        >
          {notice}
        </p>
      )}

      <div
        className="approval-actions"
        onKeyDown={(event) => {
          if (event.repeat) event.preventDefault();
        }}
      >
        {visibleChoices.map((choice) => {
          const isDisabled =
            approval.inFlight || (choice === "deny" ? !approval.canDeny : !approval.canApprove);
          return (
            <button
              key={choice}
              type="button"
              className={choice === "once" ? "button button-primary" : "button button-secondary"}
              data-testid={`approval-choice-${choice}`}
              disabled={isDisabled}
              onClick={() => onRespond(approval, choice)}
            >
              {getCopy(`approval.choice.${choice}` as CopyKey)}
            </button>
          );
        })}

        {approval.canInspect && (
          <button
            type="button"
            className="button button-secondary"
            data-testid="approval-inspect-btn"
            onClick={() => onInspect(approval)}
          >
            {getCopy("approval.action.inspect")}
          </button>
        )}

        {approval.canDismiss && (
          <button
            type="button"
            className="button button-secondary"
            data-testid="approval-dismiss-orphaned-btn"
            onClick={() => onDismissOrphaned(approval)}
          >
            {getCopy("approval.action.dismissOrphaned")}
          </button>
        )}
      </div>
    </article>
  );
}
