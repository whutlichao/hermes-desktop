import { useRef, useState } from "react";
import type {
  ConnectionEntryDisplay,
  ConnectionKind,
  ConnectionMutationResponse,
  DuplicateConflictSummary,
  LaunchMode,
  RegistryIssue,
  RegistrySafeSummaryExport,
  RegistrySnapshotView,
  RemoteAuthMode,
} from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";
import { host } from "@hermes/host-adapter";

interface GatewaysSettingsProps {
  snapshot: RegistrySnapshotView | null;
  onSnapshotChange: (snapshot: RegistrySnapshotView) => void;
  onAnnounce: (message: string) => void;
}

interface DraftFormState {
  mode: "closed" | "add" | "edit";
  editingId: string | null;
  kind: ConnectionKind;
  label: string;
  url: string;
  authMode: RemoteAuthMode;
  token: string;
  host: string;
  user: string;
  port: string;
  remoteProfile: string;
}

const INITIAL_DRAFT: DraftFormState = {
  mode: "closed",
  editingId: null,
  kind: "remote",
  label: "",
  url: "",
  authMode: "token",
  token: "",
  host: "",
  user: "",
  port: "",
  remoteProfile: "",
};

function safeCopyMessage(key: string): string {
  try {
    return getCopy(key as CopyKey) ?? key;
  } catch {
    return key;
  }
}

export function GatewaysSettings({
  snapshot,
  onSnapshotChange,
  onAnnounce,
}: GatewaysSettingsProps) {
  const [draft, setDraft] = useState<DraftFormState>(INITIAL_DRAFT);
  const [conflict, setConflict] = useState<DuplicateConflictSummary | null>(null);
  const [formError, setFormError] = useState<RegistryIssue | null>(null);
  const [warnings, setWarnings] = useState<RegistryIssue[]>([]);
  const [safeExport, setSafeExport] = useState<RegistrySafeSummaryExport | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const labelInputRef = useRef<HTMLInputElement>(null);
  const targetInputRef = useRef<HTMLInputElement>(null);

  if (!snapshot) {
    return <p>{getCopy("settings.emptyGateways")}</p>;
  }

  const isReadOnly = snapshot.readOnly;

  const openAddForm = () => {
    setConflict(null);
    setFormError(null);
    setDraft({
      ...INITIAL_DRAFT,
      mode: "add",
      kind: "remote",
    });
  };

  const openEditForm = (entry: ConnectionEntryDisplay) => {
    setConflict(null);
    setFormError(null);
    setDraft({
      mode: "edit",
      editingId: entry.id,
      kind: entry.kind,
      label: entry.label,
      url: entry.originDisplay ?? "",
      authMode: entry.authMode ?? "token",
      token: "",
      host: entry.sshHost ?? "",
      user: entry.sshUser ?? "",
      port: entry.sshPort && entry.sshPort !== 22 ? String(entry.sshPort) : "",
      remoteProfile: entry.remoteProfile ?? "",
    });
  };

  const closeForm = () => {
    setConflict(null);
    setFormError(null);
    setDraft(INITIAL_DRAFT);
  };

  const handleMutationResponse = (
    res: { ok: boolean; value?: ConnectionMutationResponse; error?: { message: string } },
    clearFormOnCommit: boolean,
  ) => {
    if (!res.ok || !res.value) {
      setFormError({
        code: "registry_invalid",
        severity: "error",
        messageKey: "registry.issue.invalidInput",
      });
      return;
    }

    const body = res.value;
    onSnapshotChange(body.snapshot);
    setWarnings(body.warnings ?? []);

    if (body.committed) {
      setConflict(null);
      setFormError(null);
      if (clearFormOnCommit) {
        setDraft(INITIAL_DRAFT);
      }
      onAnnounce(getCopy("gateways.saveAction"));
    } else {
      setConflict(body.conflict ?? null);
      setFormError(body.rejectedIssue ?? null);
      if (body.rejectedIssue) {
        onAnnounce(safeCopyMessage(body.rejectedIssue.messageKey));
      }
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || isReadOnly) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        kind: draft.kind,
        label: draft.label,
      };
      if (draft.kind === "remote" || draft.kind === "cloud") {
        payload.url = draft.url;
        payload.authMode = draft.authMode;
        if (draft.token.length > 0) {
          payload.token = draft.token;
        }
      } else if (draft.kind === "ssh") {
        payload.host = draft.host;
        if (draft.user.trim()) payload.user = draft.user.trim();
        const parsedPort = Number.parseInt(draft.port.trim(), 10);
        if (Number.isInteger(parsedPort) && parsedPort > 0) {
          payload.port = parsedPort;
        }
        if (draft.remoteProfile.trim()) {
          payload.remoteProfile = draft.remoteProfile.trim();
        }
      }

      if (draft.mode === "add") {
        const res = await host.request<ConnectionMutationResponse>("connections.add", payload);
        handleMutationResponse(res, true);
      } else if (draft.mode === "edit" && draft.editingId) {
        const res = await host.request<ConnectionMutationResponse>("connections.update", {
          ...payload,
          connectionId: draft.editingId,
        });
        handleMutationResponse(res, true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetPrimary = async (connectionId: string) => {
    const res = await host.request<ConnectionMutationResponse>("connections.setPrimary", {
      connectionId,
    });
    handleMutationResponse(res, false);
  };

  const handleSetLastUsed = async (connectionId: string) => {
    const res = await host.request<ConnectionMutationResponse>("connections.setLastUsed", {
      connectionId,
    });
    handleMutationResponse(res, false);
  };

  const handleRemove = async (connectionId: string) => {
    const res = await host.request<ConnectionMutationResponse>("connections.remove", {
      connectionId,
    });
    handleMutationResponse(res, false);
  };

  const handleSetLaunchMode = async (launchMode: LaunchMode) => {
    const res = await host.request<ConnectionMutationResponse>("connections.setLaunchMode", {
      launchMode,
    });
    handleMutationResponse(res, false);
  };

  const handleBackupAndRepair = async () => {
    const res = await host.request<ConnectionMutationResponse>("connections.backupAndRepair", {});
    handleMutationResponse(res, false);
  };

  const handleExportSafeSummary = async () => {
    const res = await host.request<RegistrySafeSummaryExport>("connections.exportSafeSummary", {});
    if (res.ok) {
      setSafeExport(res.value);
    }
  };

  const allIssues = [...snapshot.issues, ...warnings];

  return (
    <div className="gateways-panel">
      <div className="gateways-toolbar">
        <h3 className="gateways-heading">{getCopy("gateways.sectionTitle")}</h3>
        <div className="gateways-toolbar-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void handleExportSafeSummary()}
          >
            {getCopy("gateways.exportSafeSummaryAction")}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={isReadOnly}
            onClick={openAddForm}
          >
            {getCopy("gateways.addAction")}
          </button>
        </div>
      </div>

      <div className="launch-policy-bar" role="group" aria-label={getCopy("gateways.launchPolicyLabel")}>
        <span className="launch-policy-title">{getCopy("gateways.launchPolicyLabel")}</span>
        <div className="launch-policy-options">
          <button
            type="button"
            className={[
              "policy-chip",
              snapshot.launchMode === "primary" && "is-selected",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={snapshot.launchMode === "primary"}
            disabled={isReadOnly}
            onClick={() => void handleSetLaunchMode("primary")}
          >
            {getCopy("gateways.launchModePrimary")}
          </button>
          <button
            type="button"
            className={[
              "policy-chip",
              snapshot.launchMode === "last-used" && "is-selected",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={snapshot.launchMode === "last-used"}
            disabled={isReadOnly}
            onClick={() => void handleSetLaunchMode("last-used")}
          >
            {getCopy("gateways.launchModeLastUsed")}
          </button>
        </div>
      </div>

      {allIssues.length > 0 && (
        <div className="registry-issues-box" role="status">
          {allIssues.map((issue, idx) => (
            <div key={`${issue.code}-${issue.connectionId ?? idx}`} className={`issue-row is-${issue.severity}`}>
              <span className="issue-code">{issue.code}</span>
              <span>{safeCopyMessage(issue.messageKey)}</span>
              {issue.identity && <span className="issue-meta">{issue.identity}</span>}
              {issue.count !== undefined && <span className="issue-meta">({issue.count})</span>}
            </div>
          ))}
          {snapshot.readOnlyReason === "registry_corrupt" && (
            <div className="issue-actions">
              <button
                type="button"
                className="button button-primary"
                onClick={() => void handleBackupAndRepair()}
              >
                {getCopy("gateways.backupRepairAction")}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void handleExportSafeSummary()}
              >
                {getCopy("gateways.exportSafeSummaryAction")}
              </button>
            </div>
          )}
          {snapshot.readOnlyReason === "registry_unsupported" && (
            <div className="issue-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void handleExportSafeSummary()}
              >
                {getCopy("gateways.exportSafeSummaryAction")}
              </button>
            </div>
          )}
        </div>
      )}

      <ul className="gateway-list">
        {snapshot.connections.map((conn) => (
          <li
            key={conn.id}
            data-connection-id={conn.id}
            className={["gateway-row", !conn.dialable && "is-non-dialable"].filter(Boolean).join(" ")}
          >
            <div className="gateway-row-main">
              <div className="gateway-row-title">
                <strong>{conn.label}</strong>
                <span className="gateway-kind-tag">{conn.kind}</span>
                {conn.isLocal && <span className="gateway-badge">{getCopy("gateways.localBadge")}</span>}
                {conn.isPrimary && (
                  <span className="gateway-badge is-primary">{getCopy("gateways.primaryBadge")}</span>
                )}
                {conn.isLastUsed && (
                  <span className="gateway-badge">{getCopy("gateways.lastUsedBadge")}</span>
                )}
                {conn.isNextLaunch && (
                  <span className="gateway-badge is-next-launch">
                    {getCopy("gateways.nextLaunchBadge")}
                  </span>
                )}
                {!conn.dialable && (
                  <span className="gateway-badge is-warning">
                    {getCopy("gateways.duplicateExternalBadge")}
                  </span>
                )}
              </div>
              <div className="gateway-row-meta">
                {conn.originDisplay && <span>{conn.originDisplay}</span>}
                {conn.sshTargetDisplay && <span>{conn.sshTargetDisplay}</span>}
                {!conn.isLocal && (
                  <span>
                    {conn.hasToken
                      ? getCopy("gateways.hasTokenLabel")
                      : getCopy("gateways.noTokenLabel")}
                  </span>
                )}
              </div>
            </div>

            <div className="gateway-row-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={isReadOnly}
                onClick={() => openEditForm(conn)}
              >
                {getCopy("gateways.renameAction")}
              </button>
              {!conn.isPrimary && conn.dialable && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={isReadOnly}
                  onClick={() => void handleSetPrimary(conn.id)}
                >
                  {getCopy("gateways.setPrimaryAction")}
                </button>
              )}
              {!conn.isLastUsed && conn.dialable && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={isReadOnly}
                  onClick={() => void handleSetLastUsed(conn.id)}
                >
                  {getCopy("gateways.setLastUsedAction")}
                </button>
              )}
              {!conn.isLocal && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={isReadOnly}
                  onClick={() => void handleRemove(conn.id)}
                >
                  {getCopy("gateways.removeAction")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {draft.mode !== "closed" && (
        <form className="gateway-form" onSubmit={(e) => void handleSubmit(e)}>
          <h4 className="gateway-form-title">
            {draft.mode === "add"
              ? getCopy("gateways.formTitleAdd")
              : getCopy("gateways.formTitleEdit")}
          </h4>

          {conflict && (
            <div className="conflict-alert" role="alert">
              <strong>{getCopy("gateways.conflictTitle")}</strong>
              <div className="conflict-summary">
                <span>{conflict.existing.label}</span>
                {conflict.existing.hostDisplay && <span>{conflict.existing.hostDisplay}</span>}
                <span>
                  {conflict.existing.hasToken
                    ? getCopy("gateways.hasTokenLabel")
                    : getCopy("gateways.noTokenLabel")}
                </span>
              </div>
              <div className="conflict-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => labelInputRef.current?.focus()}
                >
                  {getCopy("gateways.conflictEditLabelAction")}
                </button>
                {draft.kind !== "local" && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => targetInputRef.current?.focus()}
                  >
                    {getCopy("gateways.conflictEditTargetAction")}
                  </button>
                )}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={closeForm}
                >
                  {getCopy("gateways.conflictKeepCanonicalAction")}
                </button>
              </div>
            </div>
          )}

          {!conflict && formError && (
            <div className="conflict-alert" role="alert">
              <span>{safeCopyMessage(formError.messageKey)}</span>
            </div>
          )}

          {draft.mode === "add" && (
            <div className="form-field">
              <label htmlFor="gw-kind-select">{getCopy("gateways.fieldKind")}</label>
              <select
                id="gw-kind-select"
                className="form-input"
                value={draft.kind}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    kind: e.target.value as ConnectionKind,
                  }))
                }
              >
                <option value="remote">Remote HTTP(S)</option>
                <option value="ssh">SSH</option>
              </select>
            </div>
          )}

          <div className="form-field">
            <label htmlFor="gw-label-input">{getCopy("gateways.fieldLabel")}</label>
            <input
              ref={labelInputRef}
              id="gw-label-input"
              className="form-input"
              maxLength={64}
              required
              value={draft.label}
              onChange={(e) => setDraft((prev) => ({ ...prev, label: e.target.value }))}
            />
          </div>

          {(draft.kind === "remote" || draft.kind === "cloud") && (
            <>
              <div className="form-field">
                <label htmlFor="gw-url-input">{getCopy("gateways.fieldUrl")}</label>
                <input
                  ref={targetInputRef}
                  id="gw-url-input"
                  className="form-input"
                  type="url"
                  required
                  placeholder="https://gateway.example.com"
                  value={draft.url}
                  onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))}
                />
              </div>

              <div className="form-field">
                <label htmlFor="gw-auth-select">{getCopy("gateways.fieldAuthMode")}</label>
                <select
                  id="gw-auth-select"
                  className="form-input"
                  value={draft.authMode}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      authMode: e.target.value as RemoteAuthMode,
                    }))
                  }
                >
                  <option value="token">Token</option>
                  <option value="oauth">OAuth</option>
                </select>
              </div>

              {draft.authMode === "token" && (
                <div className="form-field">
                  <label htmlFor="gw-token-input">{getCopy("gateways.fieldToken")}</label>
                  <input
                    id="gw-token-input"
                    className="form-input"
                    type="password"
                    autoComplete="off"
                    value={draft.token}
                    onChange={(e) => setDraft((prev) => ({ ...prev, token: e.target.value }))}
                  />
                </div>
              )}
            </>
          )}

          {draft.kind === "ssh" && (
            <>
              <div className="form-field">
                <label htmlFor="gw-ssh-host-input">{getCopy("gateways.fieldSshHost")}</label>
                <input
                  ref={targetInputRef}
                  id="gw-ssh-host-input"
                  className="form-input"
                  required
                  value={draft.host}
                  onChange={(e) => setDraft((prev) => ({ ...prev, host: e.target.value }))}
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-user-input">{getCopy("gateways.fieldSshUser")}</label>
                <input
                  id="gw-ssh-user-input"
                  className="form-input"
                  value={draft.user}
                  onChange={(e) => setDraft((prev) => ({ ...prev, user: e.target.value }))}
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-port-input">{getCopy("gateways.fieldSshPort")}</label>
                <input
                  id="gw-ssh-port-input"
                  className="form-input"
                  inputMode="numeric"
                  placeholder="22"
                  value={draft.port}
                  onChange={(e) => setDraft((prev) => ({ ...prev, port: e.target.value }))}
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-profile-input">{getCopy("gateways.fieldRemoteProfile")}</label>
                <input
                  id="gw-ssh-profile-input"
                  className="form-input"
                  value={draft.remoteProfile}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, remoteProfile: e.target.value }))
                  }
                />
              </div>
            </>
          )}

          <div className="gateway-form-actions">
            <button type="submit" className="button button-primary" disabled={submitting}>
              {getCopy("gateways.saveAction")}
            </button>
            <button type="button" className="button button-secondary" onClick={closeForm}>
              {getCopy("gateways.discardEditAction")}
            </button>
          </div>
        </form>
      )}

      {safeExport && (
        <pre className="safe-summary-pre" aria-label={getCopy("gateways.exportSafeSummaryAction")}>
          {JSON.stringify(safeExport, null, 2)}
        </pre>
      )}
    </div>
  );
}
