import { useRef, useState } from "react";
import type {
  ConnectionEntryDisplay,
  ConnectionHealthSummary,
  ConnectionKind,
  ConnectionMutationResponse,
  ConnectionTestResult,
  DuplicateConflictSummary,
  LaunchMode,
  RegistryIssue,
  RegistrySafeSummaryExport,
  RegistrySnapshotView,
  RemoteAuthMode,
  SshHostKeyConfirmResult,
} from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";
import { host } from "@hermes/host-adapter";

interface GatewaysSettingsProps {
  snapshot: RegistrySnapshotView | null;
  fleetConnections?: ConnectionHealthSummary[];
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
  keyPath: string;
  remoteHermesPath: string;
  remoteProfile: string;
  passphrase: string;
  preferLegacyAttach: boolean;
}

interface SshTestState {
  testedSignature: string | null;
  testing: boolean;
  confirmingHostKey: boolean;
  result: ConnectionTestResult | null;
  hostKeyMessage: string | null;
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
  keyPath: "",
  remoteHermesPath: "",
  remoteProfile: "",
  passphrase: "",
  preferLegacyAttach: false,
};

const INITIAL_SSH_TEST: SshTestState = {
  testedSignature: null,
  testing: false,
  confirmingHostKey: false,
  result: null,
  hostKeyMessage: null,
};

function computeSshTargetSignature(d: {
  host: string;
  user: string;
  port: string;
  keyPath: string;
  remoteHermesPath: string;
  remoteProfile: string;
}): string {
  return JSON.stringify({
    host: d.host.trim().toLowerCase(),
    user: d.user.trim(),
    port: d.port.trim(),
    keyPath: d.keyPath.trim(),
    remoteHermesPath: d.remoteHermesPath.trim(),
    remoteProfile: d.remoteProfile.trim(),
  });
}

function safeCopyMessage(key: string): string {
  try {
    return getCopy(key as CopyKey) ?? key;
  } catch {
    return key;
  }
}

export function GatewaysSettings({
  snapshot,
  fleetConnections = [],
  onSnapshotChange,
  onAnnounce,
}: GatewaysSettingsProps) {
  const [draft, setDraft] = useState<DraftFormState>(INITIAL_DRAFT);
  const [initialEditSshSig, setInitialEditSshSig] = useState<string | null>(null);
  const [sshTest, setSshTest] = useState<SshTestState>(INITIAL_SSH_TEST);
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
  const currentSshSig = computeSshTargetSignature(draft);
  const sshTestPassed =
    Boolean(sshTest.result?.ok) && sshTest.testedSignature === currentSshSig;
  const sshEditUnchangedTarget =
    draft.mode === "edit" &&
    draft.kind === "ssh" &&
    initialEditSshSig !== null &&
    initialEditSshSig === currentSshSig &&
    draft.passphrase.length === 0;
  const sshSaveAllowed = draft.kind !== "ssh" || sshTestPassed || sshEditUnchangedTarget;

  const openAddForm = () => {
    setConflict(null);
    setFormError(null);
    setInitialEditSshSig(null);
    setSshTest(INITIAL_SSH_TEST);
    setDraft({
      ...INITIAL_DRAFT,
      mode: "add",
      kind: "remote",
    });
  };

  const openEditForm = (entry: ConnectionEntryDisplay) => {
    setConflict(null);
    setFormError(null);
    setSshTest(INITIAL_SSH_TEST);
    const nextDraft: DraftFormState = {
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
      keyPath: "",
      remoteHermesPath: "",
      remoteProfile: entry.remoteProfile ?? "",
      passphrase: "",
      preferLegacyAttach: false,
    };
    setInitialEditSshSig(entry.kind === "ssh" ? computeSshTargetSignature(nextDraft) : null);
    setDraft(nextDraft);
  };

  const closeForm = () => {
    setConflict(null);
    setFormError(null);
    setInitialEditSshSig(null);
    setSshTest(INITIAL_SSH_TEST);
    setDraft(INITIAL_DRAFT);
  };

  const buildSshTargetPayload = (overrideLegacyAttach?: boolean): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      kind: "ssh",
      host: draft.host.trim(),
    };
    if (draft.mode === "edit" && draft.editingId) {
      payload.connectionId = draft.editingId;
    }
    if (draft.user.trim()) payload.user = draft.user.trim();
    const parsedPort = Number.parseInt(draft.port.trim(), 10);
    if (Number.isInteger(parsedPort) && parsedPort > 0) {
      payload.port = parsedPort;
    }
    if (draft.keyPath.trim()) payload.keyPath = draft.keyPath.trim();
    if (draft.remoteHermesPath.trim()) payload.remoteHermesPath = draft.remoteHermesPath.trim();
    if (draft.remoteProfile.trim()) payload.remoteProfile = draft.remoteProfile.trim();
    if (draft.passphrase.length > 0) payload.passphrase = draft.passphrase;
    if (overrideLegacyAttach ?? draft.preferLegacyAttach) {
      payload.preferLegacyAttach = true;
    }
    return payload;
  };

  const runSshTest = async (options?: { preferLegacyAttach?: boolean }) => {
    if (draft.kind !== "ssh" || sshTest.testing) return;
    const targetSig = computeSshTargetSignature(draft);
    const useLegacy = options?.preferLegacyAttach ?? draft.preferLegacyAttach;
    if (options?.preferLegacyAttach !== undefined) {
      setDraft((prev) => ({ ...prev, preferLegacyAttach: Boolean(options.preferLegacyAttach) }));
    }
    setSshTest({
      testedSignature: targetSig,
      testing: true,
      confirmingHostKey: false,
      result: null,
      hostKeyMessage: null,
    });
    try {
      const res = await host.request<ConnectionTestResult>(
        "connections.test",
        buildSshTargetPayload(useLegacy),
      );
      if (!res.ok) {
        const failRes: ConnectionTestResult = {
          ok: false,
          kind: "ssh",
          status: "failed",
          failureCode: "ssh_unreachable",
          message: res.error.message,
          actions: ["edit_target", "retry"],
        };
        setSshTest({
          testedSignature: targetSig,
          testing: false,
          confirmingHostKey: false,
          result: failRes,
          hostKeyMessage: null,
        });
        onAnnounce(failRes.message ?? getCopy("gateways.testAction"));
        return;
      }
      setSshTest({
        testedSignature: targetSig,
        testing: false,
        confirmingHostKey: false,
        result: res.value,
        hostKeyMessage: null,
      });
      if (res.value.message) {
        onAnnounce(res.value.message);
      }
    } catch {
      setSshTest({
        testedSignature: targetSig,
        testing: false,
        confirmingHostKey: false,
        result: {
          ok: false,
          kind: "ssh",
          status: "failed",
          failureCode: "ssh_unreachable",
          actions: ["edit_target", "retry"],
        },
        hostKeyMessage: null,
      });
    }
  };

  const handleConfirmHostKey = async () => {
    if (draft.kind !== "ssh" || sshTest.confirmingHostKey || sshTest.testing) return;
    setSshTest((prev) => ({ ...prev, confirmingHostKey: true, hostKeyMessage: null }));
    try {
      const res = await host.request<SshHostKeyConfirmResult>(
        "connections.confirmHostKey",
        buildSshTargetPayload(),
      );
      if (res.ok && res.value.confirmed) {
        await runSshTest();
        return;
      }
      setSshTest((prev) => ({
        ...prev,
        confirmingHostKey: false,
        hostKeyMessage:
          res.ok ? res.value.message ?? null : res.error.message,
      }));
    } catch {
      setSshTest((prev) => ({
        ...prev,
        confirmingHostKey: false,
      }));
    }
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
        setInitialEditSshSig(null);
        setSshTest(INITIAL_SSH_TEST);
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
    if (draft.kind === "ssh" && !sshSaveAllowed) return;
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
        if (draft.keyPath.trim()) {
          payload.keyPath = draft.keyPath.trim();
        } else if (draft.mode === "add") {
          payload.keyPath = "";
        }
        if (draft.remoteHermesPath.trim()) {
          payload.remoteHermesPath = draft.remoteHermesPath.trim();
        } else if (draft.mode === "add") {
          payload.remoteHermesPath = "";
        }
        if (draft.remoteProfile.trim()) {
          payload.remoteProfile = draft.remoteProfile.trim();
        }
        if (draft.passphrase.length > 0) {
          payload.passphrase = draft.passphrase;
        }
        if (draft.preferLegacyAttach) {
          payload.preferLegacyAttach = true;
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

  const handleRetryConnection = async (connectionId: string) => {
    const res = await host.request<{ ok?: boolean }>("connections.retry", { connectionId });
    if (res.ok) {
      onAnnounce(getCopy("gateways.retryConnectionAction"));
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
        {snapshot.connections.map((conn) => {
          const liveHealth = fleetConnections.find((fc) => fc.connectionId === conn.id);
          return (
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
                  {liveHealth && (
                    <span
                      className={[
                        "status-pill",
                        liveHealth.actual === "ready"
                          ? "is-ready"
                          : liveHealth.actual === "blocked"
                            ? "is-blocked"
                            : "is-warn",
                      ].join(" ")}
                    >
                      {liveHealth.actual === "ready"
                        ? getCopy("route.statusReady")
                        : liveHealth.actual === "connecting"
                          ? getCopy("route.statusConnecting")
                          : liveHealth.actual === "reconnecting"
                            ? getCopy("route.statusReconnecting")
                            : getCopy("route.statusBlocked")}
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
                  {conn.remoteProfile && <span>Profile: {conn.remoteProfile}</span>}
                  {!conn.isLocal && conn.kind !== "ssh" && (
                    <span>
                      {conn.hasToken
                        ? getCopy("gateways.hasTokenLabel")
                        : getCopy("gateways.noTokenLabel")}
                    </span>
                  )}
                  {liveHealth?.message && liveHealth.actual !== "ready" && (
                    <span>{liveHealth.message}</span>
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
                {conn.kind === "ssh" && conn.dialable && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void handleRetryConnection(conn.id)}
                  >
                    {getCopy("gateways.retryConnectionAction")}
                  </button>
                )}
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
          );
        })}
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
                onChange={(e) => {
                  const nextKind = e.target.value as ConnectionKind;
                  setSshTest(INITIAL_SSH_TEST);
                  setDraft((prev) => ({
                    ...prev,
                    kind: nextKind,
                    preferLegacyAttach: false,
                  }));
                }}
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
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      host: e.target.value,
                      preferLegacyAttach: false,
                    }))
                  }
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-user-input">{getCopy("gateways.fieldSshUser")}</label>
                <input
                  id="gw-ssh-user-input"
                  className="form-input"
                  value={draft.user}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      user: e.target.value,
                      preferLegacyAttach: false,
                    }))
                  }
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
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      port: e.target.value,
                      preferLegacyAttach: false,
                    }))
                  }
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-keypath-input">{getCopy("gateways.fieldSshKeyPath")}</label>
                <input
                  id="gw-ssh-keypath-input"
                  className="form-input"
                  value={draft.keyPath}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      keyPath: e.target.value,
                      preferLegacyAttach: false,
                    }))
                  }
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-hermespath-input">
                  {getCopy("gateways.fieldRemoteHermesPath")}
                </label>
                <input
                  id="gw-ssh-hermespath-input"
                  className="form-input"
                  value={draft.remoteHermesPath}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      remoteHermesPath: e.target.value,
                      preferLegacyAttach: false,
                    }))
                  }
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-profile-input">{getCopy("gateways.fieldRemoteProfile")}</label>
                <input
                  id="gw-ssh-profile-input"
                  className="form-input"
                  value={draft.remoteProfile}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      remoteProfile: e.target.value,
                      preferLegacyAttach: false,
                    }))
                  }
                />
              </div>
              <div className="form-field">
                <label htmlFor="gw-ssh-passphrase-input">
                  {getCopy("gateways.fieldSshPassphrase")}
                </label>
                <input
                  id="gw-ssh-passphrase-input"
                  className="form-input"
                  type="password"
                  autoComplete="off"
                  value={draft.passphrase}
                  onChange={(e) => setDraft((prev) => ({ ...prev, passphrase: e.target.value }))}
                />
              </div>

              {!sshSaveAllowed && (
                <p className="gateway-form-hint">{getCopy("gateways.testRequiredHint")}</p>
              )}

              {sshTest.result && sshTest.testedSignature === currentSshSig && (
                <div
                  className={[
                    "ssh-test-box",
                    sshTest.result.ok ? "is-passed" : "is-failed",
                  ].join(" ")}
                  role={sshTest.result.ok ? "status" : "alert"}
                >
                  <div className="ssh-test-summary">
                    <strong>
                      {sshTest.result.ok
                        ? sshTest.result.sshMode === "attach_only"
                          ? getCopy("gateways.testPassedLegacy")
                          : getCopy("gateways.testPassedModern")
                        : sshTest.result.failureCode === "host_key_unknown"
                          ? getCopy("gateways.hostKeyUnknownNotice")
                          : sshTest.result.failureCode === "host_key_changed"
                            ? getCopy("gateways.hostKeyChangedNotice")
                            : sshTest.result.message}
                    </strong>
                    {sshTest.result.sshMode === "attach_only" && (
                      <span className="gateway-badge is-warning">
                        {getCopy("gateways.sshModeLegacyBadge")}
                      </span>
                    )}
                  </div>

                  {sshTest.result.windowsServiceSession && (
                    <p className="ssh-test-note">{getCopy("gateways.windowsSession0Notice")}</p>
                  )}

                  {sshTest.result.hostKeyChallenge && (
                    <div className="host-key-box">
                      <span className="host-key-label">
                        {getCopy("gateways.hostKeyFingerprintLabel")}
                      </span>
                      <code className="host-key-fp">
                        {sshTest.result.hostKeyChallenge.hostDisplay} ·{" "}
                        {sshTest.result.hostKeyChallenge.keyType} ·{" "}
                        {sshTest.result.hostKeyChallenge.fingerprint}
                      </code>
                    </div>
                  )}

                  {sshTest.hostKeyMessage && (
                    <p className="ssh-test-note">{sshTest.hostKeyMessage}</p>
                  )}

                  {!sshTest.result.ok && sshTest.result.actions.length > 0 && (
                    <div className="conflict-actions">
                      {sshTest.result.actions.includes("confirm_host_key") && (
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={sshTest.confirmingHostKey || sshTest.testing}
                          onClick={() => void handleConfirmHostKey()}
                        >
                          {getCopy("gateways.confirmHostKeyAction")}
                        </button>
                      )}
                      {sshTest.result.actions.includes("edit_target") && (
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => targetInputRef.current?.focus()}
                        >
                          {getCopy("gateways.editTargetAction")}
                        </button>
                      )}
                      {sshTest.result.actions.includes("retry") && (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={sshTest.testing}
                          onClick={() => void runSshTest()}
                        >
                          {getCopy("gateways.retryTestAction")}
                        </button>
                      )}
                      {sshTest.result.actions.includes("legacy_attach") && (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={sshTest.testing}
                          onClick={() => void runSshTest({ preferLegacyAttach: true })}
                        >
                          {getCopy("gateways.legacyAttachAction")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div className="gateway-form-actions">
            {draft.kind === "ssh" && (
              <button
                type="button"
                className="button button-secondary"
                disabled={sshTest.testing || sshTest.confirmingHostKey || !draft.host.trim()}
                onClick={() => void runSshTest()}
              >
                {sshTest.testing ? getCopy("gateways.testingAction") : getCopy("gateways.testAction")}
              </button>
            )}
            <button
              type="submit"
              className="button button-primary"
              disabled={submitting || !sshSaveAllowed}
            >
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
