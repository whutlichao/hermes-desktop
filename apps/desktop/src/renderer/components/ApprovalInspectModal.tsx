import type { ApprovalView } from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";
import { FocusDialog } from "./Modal";

interface ApprovalInspectModalProps {
  approval: ApprovalView | null;
  onClose: () => void;
}

export function ApprovalInspectModal({ approval, onClose }: ApprovalInspectModalProps) {
  return (
    <FocusDialog
      open={Boolean(approval)}
      title={getCopy("approval.inspectTitle")}
      description={getCopy("approval.inspectDescription")}
      closeLabel={getCopy("approval.inspectClose")}
      onClose={onClose}
    >
      {approval && (
        <div className="approval-inspect-body" data-testid="approval-inspect-modal">
          <dl className="local-repair-dl">
            <div>
              <dt>{getCopy("approval.field.connection")}</dt>
              <dd>
                {approval.connectionLabel} ({approval.connectionKind})
              </dd>
            </div>
            <div>
              <dt>{getCopy("approval.field.host")}</dt>
              <dd>{approval.hostDisplay || "—"}</dd>
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
              <dd>{approval.turnId ?? "—"}</dd>
            </div>
            <div>
              <dt>{getCopy("approval.field.cwd")}</dt>
              <dd>
                <code>{approval.cwd ?? "—"}</code>
              </dd>
            </div>
            <div>
              <dt>{getCopy("approval.field.generation")}</dt>
              <dd>
                <code>
                  owner={approval.ownerGeneration} · execution={approval.executionGeneration} · epoch=
                  {approval.authorityEpoch}
                </code>
              </dd>
            </div>
            <div>
              <dt>{getCopy("approval.field.risk")}</dt>
              <dd>
                {approval.riskCategories.length > 0
                  ? approval.riskCategories
                      .map((r) => getCopy(`approval.risk.${r}` as CopyKey))
                      .join(" · ")
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{getCopy("approval.field.command")}</dt>
              <dd>
                {approval.command ? (
                  <code className="approval-command-code">{approval.command}</code>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>{getCopy("approval.field.description")}</dt>
              <dd>{approval.description || "—"}</dd>
            </div>
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
            <div>
              <dt>{getCopy("approval.field.expiresAt")}</dt>
              <dd>{approval.expiresAt ?? "—"}</dd>
            </div>
          </dl>

          <div className="empty-relay-actions">
            <button
              type="button"
              className="button button-secondary"
              data-testid="approval-inspect-close-btn"
              onClick={onClose}
            >
              {getCopy("approval.inspectClose")}
            </button>
          </div>
        </div>
      )}
    </FocusDialog>
  );
}
