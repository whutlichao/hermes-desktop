import { useEffect, useRef, useState } from "react";
import type {
  AuthStartResult,
  AuthStateSnapshot,
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
  RemoteTestActionId,
  RemoteTestLegResult,
  RemoteTestResult,
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
  authSessionId: string | null;
  originalUrl: string;
  originalAuthMode: RemoteAuthMode;
  editingHasToken: boolean;
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
  authSessionId: null,
  originalUrl: "",
  originalAuthMode: "token",
  editingHasToken: false,
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

function draftTestFingerprint(draft: DraftFormState): string {
  return [
    draft.mode,
    draft.editingId ?? "",
    draft.kind,
    draft.url.trim(),
    draft.authMode,
    draft.token,
    draft.authSessionId ?? "",
  ].join("|");
}

function legStatusText(leg: RemoteTestLegResult): string {
  switch (leg.status) {
    case "ok":
      return getCopy("gateways.testLegOk");
    case "failed":
      return getCopy("gateways.testLegFailed");
    case "skipped":
      return getCopy("gateways.testLegSkipped");
  }
}

function legStatusClass(leg: RemoteTestLegResult): string {
  switch (leg.status) {
    case "ok":
      return "status-pill is-ready";
    case "failed":
      return "status-pill is-blocked";
    case "skipped":
      return "status-pill";
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

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RemoteTestResult | null>(null);
  const [passedFingerprint, setPassedFingerprint] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthStateSnapshot | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  const labelInputRef = useRef<HTMLInputElement>(null);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const authSelectRef = useRef<HTMLSelectElement>(null);
  const onAnnounceRef = useRef(onAnnounce);
  onAnnounceRef.current = onAnnounce;

  useEffect(() => {
    const unsub = host.subscribe("auth.state", null, (event) => {
      const next = event.payload as AuthStateSnapshot | undefined;
      if (!next || !next.authSessionId) return;
      setAuthState(next);
      if (next.status === "granted") {
        if (next.connectionId) {
          setWarnings((prev) =>
            prev.filter(
              (w) => !(w.code === "token_sync_failed" && w.connectionId === next.connectionId),
            ),
          );
        }
        if (next.messageKey) {
          onAnnounceRef.current(safeCopyMessage(next.messageKey));
        }
      } else if (next.status === "cancelled" && next.messageKey) {
        onAnnounceRef.current(safeCopyMessage(next.messageKey));
      } else if (next.status === "failed" && next.messageKey) {
        onAnnounceRef.current(safeCopyMessage(next.messageKey));
      }
    });
    return () => unsub();
  }, []);

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

  const resetTestAndAuthState = () => {
    setTestResult(null);
    setPassedFingerprint(null);
    setAuthState(null);
  };

  const invalidateTestState = () => {
    setTestResult(null);
    setPassedFingerprint(null);
  };

  const openAddForm = () => {
    setConflict(null);
    setFormError(null);
    resetTestAndAuthState();
    setInitialEditSshSig(null);
    setSshTest(INITIAL_SSH_TEST);
    setDraft({
      ...INITIAL_DRAFT,
      mode: "add",
      kind: "remote",
    });
  };

  const openEditForm = (entry: ConnectionEntryDisplay, focusToken = false) => {
    setConflict(null);
    setFormError(null);
    resetTestAndAuthState();
    setSshTest(INITIAL_SSH_TEST);
    const entryUrl = entry.originDisplay ?? "";
    const entryAuthMode = entry.authMode ?? "token";
    const nextDraft: DraftFormState = {
      mode: "edit",
      editingId: entry.id,
      kind: entry.kind,
      label: entry.label,
      url: entryUrl,
      authMode: entryAuthMode,
      token: "",
      authSessionId: null,
      originalUrl: entryUrl,
      originalAuthMode: entryAuthMode,
      editingHasToken: entry.hasToken,
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
    if (focusToken) {
      queueMicrotask(() => {
        tokenInputRef.current?.focus();
      });
    }
  };

  const closeForm = () => {
    setConflict(null);
    setFormError(null);
    resetTestAndAuthState();
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
        resetTestAndAuthState();
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

  const handleStartOAuth = async (targetUrl: string, connectionId?: string) => {
    if (oauthBusy || isReadOnly) return;
    setOauthBusy(true);
    setFormError(null);
    try {
      const res = await host.request<AuthStartResult>("auth.start", {
        kind: "remote",
        url: targetUrl,
        ...(connectionId ? { connectionId } : {}),
      });
      if (!res.ok || !res.value) {
        setAuthState({
          authSessionId: "local-error",
          ...(connectionId ? { connectionId } : {}),
          originDisplay: targetUrl,
          status: "failed",
          errorCode: "invalid_request",
          messageKey: "gateways.oauthFailed",
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      const nextSessionId = res.value.authSessionId;
      if (!connectionId) {
        setDraft((prev) => ({ ...prev, authSessionId: nextSessionId }));
        invalidateTestState();
      }
      setAuthState((prev) =>
        prev && prev.authSessionId === nextSessionId && prev.status !== "waiting"
          ? prev
          : {
              authSessionId: nextSessionId,
              ...(connectionId ? { connectionId } : {}),
              originDisplay: res.value.originDisplay,
              status: res.value.status,
              messageKey: "gateways.oauthWaiting",
              updatedAt: new Date().toISOString(),
            },
      );
    } finally {
      setOauthBusy(false);
    }
  };

  const handleCancelOAuth = async () => {
    const targetSessionId = authState?.authSessionId ?? draft.authSessionId;
    if (!targetSessionId) return;
    const res = await host.request<{ cancelled: boolean }>("auth.cancel", {
      authSessionId: targetSessionId,
    });
    if (res.ok) {
      setDraft((prev) =>
        prev.authSessionId === targetSessionId ? { ...prev, authSessionId: null } : prev,
      );
      setAuthState((prev) =>
        prev && prev.authSessionId === targetSessionId
          ? {
              ...prev,
              status: "cancelled",
              messageKey: "gateways.oauthCancelled",
              updatedAt: new Date().toISOString(),
            }
          : prev,
      );
    }
  };

  const handleTestConnection = async () => {
    if (testing || submitting) return;
    const fingerprint = draftTestFingerprint(draft);
    setTesting(true);
    setConflict(null);
    setFormError(null);
    try {
      const res = await host.request<RemoteTestResult>("connections.test", {
        kind: draft.kind,
        url: draft.url,
        authMode: draft.authMode,
        ...(draft.token.length > 0 ? { token: draft.token } : {}),
        ...(draft.authSessionId ? { authSessionId: draft.authSessionId } : {}),
        ...(draft.mode === "edit" && draft.editingId ? { connectionId: draft.editingId } : {}),
      });
      if (!res.ok || !res.value) {
        setTestResult({
          ok: false,
          kind: "remote",
          originDisplay: draft.url,
          authMode: draft.authMode,
          httpLeg: { ok: false, status: "failed", messageKey: "remote.test.httpFailed" },
          wsLeg: { ok: false, status: "skipped" },
          failedStage: "http",
          errorCode: "unreachable",
          messageKey: "remote.test.httpFailed",
          actions: ["edit_endpoint", "retry_test"],
          checkedAt: new Date().toISOString(),
        });
        setPassedFingerprint(null);
        return;
      }

      setTestResult(res.value);
      setPassedFingerprint(res.value.ok ? fingerprint : null);
      if (res.value.messageKey) {
        onAnnounce(safeCopyMessage(res.value.messageKey));
      }
    } finally {
      setTesting(false);
    }
  };

  const handleTestAction = (action: RemoteTestActionId) => {
    switch (action) {
      case "edit_endpoint":
        targetInputRef.current?.focus();
        break;
      case "edit_auth":
        if (draft.authMode === "token") {
          tokenInputRef.current?.focus();
        } else {
          authSelectRef.current?.focus();
        }
        break;
      case "reauthorize_oauth":
        void handleStartOAuth(draft.url, draft.editingId ?? undefined);
        break;
      case "retry_test":
        void handleTestConnection();
        break;
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
        if (draft.authSessionId) {
          payload.authSessionId = draft.authSessionId;
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

  const handleReauthorizeRow = async (conn: ConnectionEntryDisplay) => {
    if (conn.authMode === "oauth") {
      await handleStartOAuth(conn.originDisplay ?? "", conn.id);
    } else {
      openEditForm(conn, true);
    }
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

  const snapshotIssueKeys = new Set(
    snapshot.issues.map((i) => `${i.code}::${i.connectionId ?? ""}`),
  );
  const allIssues = [
    ...snapshot.issues,
    ...warnings.filter((w) => !snapshotIssueKeys.has(`${w.code}::${w.connectionId ?? ""}`)),
  ];
  const isRemoteWizard = draft.kind === "remote" || draft.kind === "cloud";
  const currentFingerprint = draftTestFingerprint(draft);
  const isPureLabelRename =
    isRemoteWizard &&
    draft.mode === "edit" &&
    draft.url.trim() === draft.originalUrl.trim() &&
    draft.authMode === draft.originalAuthMode &&
    draft.token === "" &&
    !draft.authSessionId &&
    draft.editingHasToken;
  const testPassedForDraft = testResult?.ok === true && passedFingerprint === currentFingerprint;
  const remoteSaveAllowed = !isRemoteWizard || isPureLabelRename || testPassedForDraft;

  const rowReauthBanner =
    authState && authState.connectionId && draft.editingId !== authState.connectionId ? authState : null;

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

      {rowReauthBanner && (
        <div className="oauth-status-card" role="status">
          <span>
            {rowReauthBanner.messageKey
              ? safeCopyMessage(rowReauthBanner.messageKey)
              : rowReauthBanner.status}
          </span>
          {rowReauthBanner.status === "waiting" && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void handleCancelOAuth()}
            >
              {getCopy("gateways.oauthCancelAction")}
            </button>
          )}
        </div>
      )}

      <ul className="gateway-list">
        {snapshot.connections.map((conn) => {
          const hasTokenSyncWarning = allIssues.some(
            (i) => i.code === "token_sync_failed" && i.connectionId === conn.id,
          );
          const liveHealth = fleetConnections.find((fc) => fc.connectionId === conn.id);
          const needsReauth =
            conn.kind === "remote" &&
            (hasTokenSyncWarning || liveHealth?.actual === "auth_required");
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
                          : liveHealth.actual === "blocked" || liveHealth.actual === "auth_required"
                            ? "is-blocked"
                            : "is-warn",
                      ].join(" ")}
                    >
                      {liveHealth.aggregateState === "suspended" ||
                      liveHealth.desired === "suspended"
                        ? getCopy("status.suspended")
                        : liveHealth.actual === "ready"
                          ? getCopy("route.statusReady")
                          : liveHealth.actual === "connecting"
                            ? getCopy("route.statusConnecting")
                            : liveHealth.actual === "reconnecting"
                              ? getCopy("route.statusReconnecting")
                              : liveHealth.actual === "auth_required"
                                ? getCopy("route.statusAuthRequired")
                                : liveHealth.actual === "idle"
                                  ? getCopy("status.idle")
                                  : liveHealth.actual === "stopping"
                                    ? getCopy("status.stopping")
                                    : getCopy("route.statusBlocked")}
                    </span>
                  )}
                  {liveHealth &&
                    (liveHealth.degraded || liveHealth.aggregateState === "degraded") && (
                      <span className="status-pill is-warn">{getCopy("status.degraded")}</span>
                    )}
                  {(liveHealth?.profileExceptionCount ?? 0) > 0 && (
                    <span className="gateway-badge is-warning">
                      {liveHealth?.profileExceptionCount} {getCopy("status.profileExceptions")}
                    </span>
                  )}
                  {!conn.dialable && (
                    <span className="gateway-badge is-warning">
                      {getCopy("gateways.duplicateExternalBadge")}
                    </span>
                  )}
                  {needsReauth && (
                    <span className="gateway-badge is-warning">
                      {getCopy("gateways.authRequiredBadge")}
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
                  {liveHealth && (
                    <span>
                      {typeof liveHealth.latencyMs === "number"
                        ? `${liveHealth.latencyMs}ms`
                        : getCopy("status.latencyUnknown")}
                    </span>
                  )}
                  {typeof liveHealth?.nextRetryAt === "number" && (
                    <span>
                      {getCopy("status.nextRetryIn")}{" "}
                      {Math.max(1, Math.ceil((liveHealth.nextRetryAt - Date.now()) / 1000))}s
                    </span>
                  )}
                  {liveHealth?.message &&
                    (liveHealth.actual !== "ready" || liveHealth.degraded) && (
                      <span>{liveHealth.message}</span>
                    )}
                </div>
                {hasTokenSyncWarning && (
                  <p className="gateway-row-warning">{getCopy("gateways.tokenSyncFailedActionHint")}</p>
                )}
              </div>

              <div className="gateway-row-actions">
                {needsReauth && (
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={isReadOnly || oauthBusy}
                    onClick={() => void handleReauthorizeRow(conn)}
                  >
                    {getCopy("gateways.reauthorizeAction")}
                  </button>
                )}
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={isReadOnly}
                  onClick={() => openEditForm(conn)}
                >
                  {getCopy("gateways.renameAction")}
                </button>
                {conn.dialable &&
                  (conn.kind === "ssh" ||
                    (liveHealth && (liveHealth.actual !== "ready" || liveHealth.degraded))) && (
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
                  invalidateTestState();
                  setSshTest(INITIAL_SSH_TEST);
                  setDraft((prev) => ({
                    ...prev,
                    kind: nextKind,
                    authSessionId: null,
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

          {isRemoteWizard && (
            <div className="remote-wizard-steps">
              <section className="wizard-step-box" aria-label={getCopy("gateways.wizardStepEndpoint")}>
                <div className="wizard-step-label">{getCopy("gateways.wizardStepEndpoint")}</div>
                <div className="form-field">
                  <label htmlFor="gw-url-input">{getCopy("gateways.fieldUrl")}</label>
                  <input
                    ref={targetInputRef}
                    id="gw-url-input"
                    className="form-input"
                    type="text"
                    inputMode="url"
                    required
                    placeholder="https://gateway.example.com"
                    value={draft.url}
                    onChange={(e) => {
                      invalidateTestState();
                      setDraft((prev) => ({
                        ...prev,
                        url: e.target.value,
                        authSessionId: null,
                      }));
                    }}
                  />
                </div>
              </section>

              <section className="wizard-step-box" aria-label={getCopy("gateways.wizardStepAuth")}>
                <div className="wizard-step-label">{getCopy("gateways.wizardStepAuth")}</div>
                <div className="form-field">
                  <label htmlFor="gw-auth-select">{getCopy("gateways.fieldAuthMode")}</label>
                  <select
                    ref={authSelectRef}
                    id="gw-auth-select"
                    className="form-input"
                    value={draft.authMode}
                    onChange={(e) => {
                      invalidateTestState();
                      setAuthState(null);
                      setDraft((prev) => ({
                        ...prev,
                        authMode: e.target.value as RemoteAuthMode,
                        token: "",
                        authSessionId: null,
                      }));
                    }}
                  >
                    <option value="token">{getCopy("gateways.authModeToken")}</option>
                    <option value="oauth">{getCopy("gateways.authModeOAuth")}</option>
                  </select>
                </div>

                {draft.authMode === "token" && (
                  <div className="form-field">
                    <label htmlFor="gw-token-input">{getCopy("gateways.fieldToken")}</label>
                    <input
                      ref={tokenInputRef}
                      id="gw-token-input"
                      className="form-input"
                      type="password"
                      autoComplete="off"
                      value={draft.token}
                      onChange={(e) => {
                        invalidateTestState();
                        setDraft((prev) => ({ ...prev, token: e.target.value }));
                      }}
                    />
                    {draft.mode === "edit" && draft.editingHasToken && (
                      <p className="field-hint">{getCopy("gateways.fieldTokenMainOnly")}</p>
                    )}
                  </div>
                )}

                {draft.authMode === "oauth" && (
                  <div className="oauth-step-controls">
                    <div className="gateway-form-actions">
                      {authState?.status !== "waiting" ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={oauthBusy || !draft.url.trim()}
                          onClick={() =>
                            void handleStartOAuth(draft.url, draft.editingId ?? undefined)
                          }
                        >
                          {getCopy("gateways.oauthStartAction")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => void handleCancelOAuth()}
                        >
                          {getCopy("gateways.oauthCancelAction")}
                        </button>
                      )}
                    </div>
                    {draft.mode === "edit" && draft.editingHasToken && !authState && (
                      <p className="field-hint">{getCopy("gateways.hasTokenLabel")}</p>
                    )}
                    {authState && (
                      <div className="oauth-status-card" role="status">
                        <span>
                          {authState.messageKey
                            ? safeCopyMessage(authState.messageKey)
                            : authState.status}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="wizard-step-box" aria-label={getCopy("gateways.wizardStepTest")}>
                <div className="wizard-step-label">{getCopy("gateways.wizardStepTest")}</div>
                <div className="gateway-form-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={testing || submitting || !draft.url.trim()}
                    onClick={() => void handleTestConnection()}
                  >
                    {getCopy(
                      testing ? "gateways.testingConnectionAction" : "gateways.testConnectionAction",
                    )}
                  </button>
                </div>

                {testResult && (
                  <div
                    className={["remote-test-card", testResult.ok ? "is-pass" : "is-fail"].join(" ")}
                    role={testResult.ok ? "status" : "alert"}
                  >
                    <div className="remote-test-header">
                      <strong>{getCopy("gateways.testResultTitle")}</strong>
                      {testResult.originDisplay && (
                        <span className="issue-meta">{testResult.originDisplay}</span>
                      )}
                    </div>
                    <div className="remote-test-legs">
                      <div className="remote-test-leg-row">
                        <span>{getCopy("gateways.testLegHttpLabel")}</span>
                        <span className={legStatusClass(testResult.httpLeg)}>
                          {legStatusText(testResult.httpLeg)}
                          {testResult.httpLeg.statusCode ? ` (${testResult.httpLeg.statusCode})` : ""}
                          {testResult.httpLeg.latencyMs !== undefined
                            ? ` · ${testResult.httpLeg.latencyMs}ms`
                            : ""}
                        </span>
                      </div>
                      <div className="remote-test-leg-row">
                        <span>{getCopy("gateways.testLegWsLabel")}</span>
                        <span className={legStatusClass(testResult.wsLeg)}>
                          {legStatusText(testResult.wsLeg)}
                          {testResult.wsLeg.latencyMs !== undefined
                            ? ` · ${testResult.wsLeg.latencyMs}ms`
                            : ""}
                        </span>
                      </div>
                    </div>
                    {testResult.messageKey && (
                      <p className="remote-test-message">{safeCopyMessage(testResult.messageKey)}</p>
                    )}
                    {testResult.actions.length > 0 && (
                      <div className="gateway-form-actions">
                        {testResult.actions.map((action) => (
                          <button
                            key={action}
                            type="button"
                            className="button button-secondary"
                            onClick={() => handleTestAction(action)}
                          >
                            {action === "edit_endpoint"
                              ? getCopy("gateways.conflictEditTargetAction")
                              : action === "edit_auth"
                                ? getCopy("gateways.fieldAuthMode")
                                : action === "reauthorize_oauth"
                                  ? getCopy("gateways.reauthorizeAction")
                                  : getCopy("gateways.testConnectionAction")}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
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

          {isRemoteWizard && (
            <div className="wizard-step-label">{getCopy("gateways.wizardStepSave")}</div>
          )}

          {isRemoteWizard && !remoteSaveAllowed && (
            <p className="field-hint">{getCopy("gateways.saveRequiresTestHint")}</p>
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
              disabled={submitting || !remoteSaveAllowed || !sshSaveAllowed}
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
