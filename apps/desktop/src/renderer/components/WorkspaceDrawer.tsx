import { useId, useMemo, useState, type FormEvent } from "react";
import type { BridgeScope, CapabilityEntry, CapabilitySnapshot, WorkspaceTab } from "@hermes/contracts";
import {
  getActiveChatWorkspaceView,
  getActiveScopeWorkspaceView,
  getCopy,
  getWorkspaceTabBinding,
  projectArtifactAnnotations,
  type WorkspaceSessionState,
} from "@hermes/domain";

const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "artifacts", label: "Artifacts" },
  { id: "files", label: "Files" },
  { id: "git", label: "Git" },
  { id: "agents", label: "Agents" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "terminal", label: "Terminal" },
];

interface WorkspaceDrawerProps {
  workspaceState: WorkspaceSessionState;
  capabilities?: CapabilitySnapshot;
  activeChatScope?: BridgeScope | null;
  agentInterrupting?: boolean;
  onSelectTab: (tab: WorkspaceTab) => void;
  onHide: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onSelectArtifact: (artifactId: string) => void;
  onArtifactScroll: (scrollTop: number) => void;
  onArtifactZoom: (zoom: number) => void;
  onAddAnnotation: (input: { xPct: number; yPct: number; comment: string }) => void;
  onToggleDir: (relativePath: string) => void;
  onSelectFile: (relativePath: string) => void;
  onSelectFileLine: (line: number) => void;
  onSelectGitDiff: (relativePath: string) => void;
  onSelectAgent: (agentId: string) => void;
  onChangeSteerText: (text: string) => void;
  onSteerAgent?: () => void;
  onInterruptAgent?: () => void;
  onRefreshAgentTail?: () => void;
  onRetryAgentAction?: () => void;
  onSelectCheckpoint?: (checkpointId: string) => void;
  onDiffCheckpoint?: (checkpointId: string) => void;
  onRequestRestoreCheckpoint?: (checkpointId: string) => void;
  onConfirmRestoreCheckpoint?: () => void;
  onCancelRestoreCheckpoint?: () => void;
  onRetryCheckpointAction?: () => void;
}

export function WorkspaceDrawer({
  workspaceState,
  capabilities,
  activeChatScope,
  agentInterrupting = false,
  onSelectTab,
  onHide,
  onClose,
  onRefresh,
  onSelectArtifact,
  onArtifactScroll,
  onArtifactZoom,
  onAddAnnotation,
  onToggleDir,
  onSelectFile,
  onSelectFileLine,
  onSelectGitDiff,
  onSelectAgent,
  onChangeSteerText,
  onSteerAgent,
  onInterruptAgent,
  onRefreshAgentTail,
  onRetryAgentAction,
  onSelectCheckpoint,
  onDiffCheckpoint,
  onRequestRestoreCheckpoint,
  onConfirmRestoreCheckpoint,
  onCancelRestoreCheckpoint,
  onRetryCheckpointAction,
}: WorkspaceDrawerProps) {
  const [xInput, setXInput] = useState("25");
  const [yInput, setYInput] = useState("25");
  const [commentInput, setCommentInput] = useState("");
  const [showAgentErrorDetail, setShowAgentErrorDetail] = useState(false);
  const [showCheckpointErrorDetail, setShowCheckpointErrorDetail] = useState(false);
  const xInputId = useId();
  const yInputId = useId();
  const commentInputId = useId();
  const steerInputId = useId();

  const activeTab = workspaceState.frame.activeTab;
  const binding = getWorkspaceTabBinding(activeTab);
  const chatView = getActiveChatWorkspaceView(workspaceState);
  const scopeView = getActiveScopeWorkspaceView(workspaceState);

  const entryById = useMemo(() => {
    const map = new Map<string, CapabilityEntry>();
    for (const entry of capabilities?.entries ?? []) {
      map.set(entry.actionId, entry);
    }
    return map;
  }, [capabilities?.entries]);

  const isActionRenderable = (actionId: string): boolean => {
    if (!capabilities) return true;
    const entry = entryById.get(actionId);
    if (!entry) return false;
    if (entry.degradation?.reason === "refused") return false;
    if (!capabilities.capabilitiesReady) return true;
    return entry.runtimeStatus !== "unavailable";
  };

  const canSteerSubagent = !chatView.agentsReadOnly && isActionRenderable("subagents.steer");
  const canInterruptSubagent =
    !chatView.agentsReadOnly && isActionRenderable("subagents.interrupt");
  const canTailSubagent = isActionRenderable("subagents.tail");
  const canDiffCheckpoint = isActionRenderable("checkpoint.diff");
  const canRestoreCheckpoint =
    chatView.checkpointsCanRestore && isActionRenderable("checkpoint.restore");

  const selectedAgent = useMemo(
    () =>
      chatView.agents.find((a) => a.agentId === chatView.selectedAgentId) ??
      chatView.agents[0] ??
      null,
    [chatView.agents, chatView.selectedAgentId],
  );

  const selectedAgentTail = selectedAgent
    ? chatView.agentTailById[selectedAgent.agentId] ?? null
    : null;
  const selectedAgentTailInvalidated = selectedAgent
    ? Boolean(chatView.tailInvalidatedById[selectedAgent.agentId])
    : false;

  const selectedCheckpoint = useMemo(
    () =>
      chatView.checkpoints.find((c) => c.checkpointId === chatView.selectedCheckpointId) ??
      chatView.checkpoints[0] ??
      null,
    [chatView.checkpoints, chatView.selectedCheckpointId],
  );

  const selectedCheckpointDiff = selectedCheckpoint
    ? chatView.checkpointDiffById[selectedCheckpoint.checkpointId] ?? null
    : null;

  const selectedArtifact = useMemo(
    () =>
      chatView.artifacts.find((item) => item.artifactId === chatView.selectedArtifactId) ??
      chatView.artifacts[0] ??
      null,
    [chatView.artifacts, chatView.selectedArtifactId],
  );

  const projectedAnnotations = useMemo(
    () => projectArtifactAnnotations(chatView.annotations, selectedArtifact),
    [chatView.annotations, selectedArtifact],
  );

  const visibleFileEntries = useMemo(() => {
    const expanded = new Set(scopeView.expandedDirs);
    return scopeView.files.filter((entry) => {
      if (!entry.parentPath) return true;
      const parts = entry.parentPath.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!expanded.has(current)) return false;
      }
      return true;
    });
  }, [scopeView.expandedDirs, scopeView.files]);

  const selectedFile = useMemo(
    () =>
      scopeView.files.find(
        (entry) => entry.kind === "file" && entry.relativePath === scopeView.selectedFilePath,
      ) ?? null,
    [scopeView.files, scopeView.selectedFilePath],
  );

  const selectedFileLines = useMemo(() => {
    if (!selectedFile?.content) return [];
    return selectedFile.content.split(/\r?\n/);
  }, [selectedFile?.content]);

  const isStale =
    binding === "active_chat"
      ? Boolean(chatView.stale || selectedArtifact?.stale)
      : Boolean(scopeView.stale || selectedFile?.stale);

  const handleAnnotationSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = commentInput.trim();
    if (!trimmed || !selectedArtifact) return;
    const parsedX = Number(xInput);
    const parsedY = Number(yInput);
    const xPct = Number.isFinite(parsedX) ? Math.max(0, Math.min(100, parsedX)) : 0;
    const yPct = Number.isFinite(parsedY) ? Math.max(0, Math.min(100, parsedY)) : 0;
    onAddAnnotation({ xPct, yPct, comment: trimmed });
    setCommentInput("");
  };

  if (workspaceState.frame.mode !== "open") {
    return null;
  }

  return (
    <aside className="workspace-drawer" aria-label={getCopy("workspace.title")}>
      <div className="workspace-header">
        <strong>{getCopy("workspace.title")}</strong>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={onRefresh}
          >
            {getCopy("workspace.refresh")}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={onHide}
          >
            {getCopy("workspace.hide")}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
          >
            {getCopy("workspace.close")}
          </button>
        </div>
      </div>

      <div className="workspace-tabs" role="tablist" aria-label="Workspace 面板标签">
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={["workspace-tab", activeTab === tab.id && "is-active"]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="workspace-meta-bar">
        <span className="workspace-binding-tag">
          {binding === "active_chat"
            ? getCopy("workspace.bindingActiveChat")
            : getCopy("workspace.bindingScope")}
        </span>
        {isStale && (
          <span
            className="status-pill is-warn"
            data-testid="workspace-stale-badge"
          >
            {getCopy("workspace.staleBadge")}
          </span>
        )}
      </div>

      <div className="workspace-body">
        {activeTab === "artifacts" && (
          <div className="workspace-panel">
            {chatView.artifacts.length === 0 ? (
              <div className="workspace-empty" data-testid="workspace-artifacts-empty">
                {getCopy("workspace.artifacts.empty")}
              </div>
            ) : (
              <>
                <div className="workspace-item-list" role="group" aria-label="Artifacts">
                  {chatView.artifacts.map((art) => {
                    const isSelected = art.artifactId === selectedArtifact?.artifactId;
                    return (
                      <button
                        key={art.artifactId}
                        type="button"
                        className={[
                          "workspace-item-chip",
                          isSelected && "is-active",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        data-testid={`workspace-artifact-tab-${art.artifactId}`}
                        onClick={() => onSelectArtifact(art.artifactId)}
                      >
                        {art.title} · v{art.version}
                      </button>
                    );
                  })}
                </div>

                {selectedArtifact && (
                  <div className="workspace-preview-card">
                    <div className="workspace-preview-toolbar">
                      <div>
                        <strong>{selectedArtifact.title}</strong>
                        <span
                          style={{
                            marginLeft: 8,
                            fontFamily: "var(--font-mono)",
                            fontSize: 11,
                            color: "var(--muted)",
                          }}
                        >
                          {selectedArtifact.kind} · v{selectedArtifact.version} ·{" "}
                          {selectedArtifact.hash}
                        </span>
                      </div>
                      <div className="workspace-zoom-controls">
                        <button
                          type="button"
                          className="button button-secondary"
                          aria-label={getCopy("workspace.artifacts.zoomOut")}
                          onClick={() => onArtifactZoom(chatView.zoom - 25)}
                        >
                          -
                        </button>
                        <span
                          data-testid="workspace-artifact-zoom"
                          style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}
                        >
                          {chatView.zoom}%
                        </span>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => onArtifactZoom(100)}
                        >
                          {getCopy("workspace.artifacts.zoomReset")}
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          aria-label={getCopy("workspace.artifacts.zoomIn")}
                          onClick={() => onArtifactZoom(chatView.zoom + 25)}
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <pre
                      className="workspace-preview-content"
                      data-testid="workspace-artifact-preview"
                      style={{ fontSize: `${Math.round((12 * chatView.zoom) / 100)}px` }}
                      onScroll={(event) => onArtifactScroll(event.currentTarget.scrollTop)}
                    >
                      {selectedArtifact.content}
                    </pre>
                  </div>
                )}

                {selectedArtifact && (
                  <section
                    className="workspace-annotation-section"
                    aria-label={getCopy("workspace.annotations.title")}
                  >
                    <h3 className="settings-section-title">
                      {getCopy("workspace.annotations.title")}
                    </h3>
                    <form className="gateway-form" onSubmit={handleAnnotationSubmit}>
                      <div className="workspace-annotation-grid">
                        <div className="form-field">
                          <label htmlFor={xInputId}>
                            {getCopy("workspace.annotations.xLabel")}
                          </label>
                          <input
                            id={xInputId}
                            type="number"
                            min={0}
                            max={100}
                            className="form-input"
                            value={xInput}
                            onChange={(e) => setXInput(e.target.value)}
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor={yInputId}>
                            {getCopy("workspace.annotations.yLabel")}
                          </label>
                          <input
                            id={yInputId}
                            type="number"
                            min={0}
                            max={100}
                            className="form-input"
                            value={yInput}
                            onChange={(e) => setYInput(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="form-field">
                        <label htmlFor={commentInputId}>
                          {getCopy("workspace.annotations.commentLabel")}
                        </label>
                        <input
                          id={commentInputId}
                          type="text"
                          className="form-input"
                          value={commentInput}
                          onChange={(e) => setCommentInput(e.target.value)}
                          placeholder={getCopy("workspace.annotations.commentPlaceholder")}
                        />
                      </div>
                      <button type="submit" className="button button-primary">
                        {getCopy("workspace.annotations.addAction")}
                      </button>
                    </form>

                    {projectedAnnotations.length === 0 ? (
                      <p className="cap-empty-note">
                        {getCopy("workspace.annotations.empty")}
                      </p>
                    ) : (
                      <ul className="workspace-annotation-list">
                        {projectedAnnotations.map((ann) => (
                          <li
                            key={ann.annotationId}
                            className="workspace-annotation-card"
                            data-testid="workspace-annotation-item"
                          >
                            <div className="workspace-annotation-header">
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                                ({ann.xPct}%, {ann.yPct}%) · v{ann.artifactVersion}
                              </span>
                              {ann.outdatedVersion && (
                                <span
                                  className="status-pill is-warn"
                                  data-testid="workspace-annotation-outdated"
                                >
                                  {getCopy("workspace.annotations.outdatedBadge")}
                                </span>
                              )}
                            </div>
                            <span>{ann.comment}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "files" && (
          <div className="workspace-panel">
            {scopeView.files.length === 0 ? (
              <div className="workspace-empty" data-testid="workspace-files-empty">
                {getCopy("workspace.files.empty")}
              </div>
            ) : (
              <>
                <ul className="workspace-file-tree" aria-label="Files">
                  {visibleFileEntries.map((entry) => {
                    const depth = entry.parentPath
                      ? entry.parentPath.split("/").length
                      : 0;
                    if (entry.kind === "directory") {
                      const isExpanded = scopeView.expandedDirs.includes(entry.relativePath);
                      return (
                        <li key={entry.relativePath}>
                          <button
                            type="button"
                            className="workspace-tree-btn"
                            style={{ paddingLeft: `${8 + depth * 14}px` }}
                            data-testid={`workspace-dir-${entry.relativePath}`}
                            aria-expanded={isExpanded}
                            onClick={() => onToggleDir(entry.relativePath)}
                          >
                            <span>
                              {isExpanded ? "▾" : "▸"} {entry.name}/
                            </span>
                          </button>
                        </li>
                      );
                    }
                    const isSelected = entry.relativePath === scopeView.selectedFilePath;
                    return (
                      <li key={entry.relativePath}>
                        <button
                          type="button"
                          className={["workspace-tree-btn", isSelected && "is-active"]
                            .filter(Boolean)
                            .join(" ")}
                          style={{ paddingLeft: `${8 + depth * 14}px` }}
                          data-testid={`workspace-file-${entry.relativePath}`}
                          onClick={() => onSelectFile(entry.relativePath)}
                        >
                          <span>{entry.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {scopeView.lineSelectionInvalidated && (
                  <div
                    className="cap-notice is-warn"
                    role="status"
                    data-testid="workspace-line-invalidated-notice"
                  >
                    {getCopy("workspace.files.lineInvalidated")}
                  </div>
                )}

                {selectedFile ? (
                  <div
                    className="workspace-preview-card"
                    data-testid="workspace-file-preview"
                  >
                    <div className="workspace-preview-toolbar">
                      <strong>{selectedFile.relativePath}</strong>
                      {scopeView.selectedLineRange && (
                        <span
                          className="status-pill is-ready"
                          data-testid="workspace-line-selection-badge"
                        >
                          L{scopeView.selectedLineRange.startLine}
                          {scopeView.selectedLineRange.endLine !==
                          scopeView.selectedLineRange.startLine
                            ? `-L${scopeView.selectedLineRange.endLine}`
                            : ""}
                        </span>
                      )}
                    </div>
                    <ol className="workspace-code-lines">
                      {selectedFileLines.map((lineText, index) => {
                        const lineNum = index + 1;
                        const range = scopeView.selectedLineRange;
                        const isLineSelected = Boolean(
                          range && lineNum >= range.startLine && lineNum <= range.endLine,
                        );
                        return (
                          <li key={lineNum}>
                            <button
                              type="button"
                              className={[
                                "workspace-code-line-btn",
                                isLineSelected && "is-selected",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              data-testid={`workspace-file-line-${lineNum}`}
                              onClick={() => onSelectFileLine(lineNum)}
                            >
                              <span className="workspace-line-num">{lineNum}</span>
                              <span>{lineText}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                ) : (
                  <div className="workspace-empty">
                    {getCopy("workspace.files.selectPrompt")}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "git" && (
          <div className="workspace-panel">
            {scopeView.gitDiffs.length === 0 ? (
              <div className="workspace-empty">{getCopy("workspace.git.empty")}</div>
            ) : (
              <div className="workspace-item-list">
                {scopeView.gitDiffs.map((diff) => {
                  const isSelected = diff.relativePath === scopeView.selectedDiffPath;
                  return (
                    <button
                      key={diff.relativePath}
                      type="button"
                      className={["workspace-item-chip", isSelected && "is-active"]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onSelectGitDiff(diff.relativePath)}
                    >
                      {diff.status.toUpperCase()} · {diff.relativePath}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "agents" && (
          <div className="workspace-panel">
            {(chatView.agentsReadOnly || (!canSteerSubagent && !canInterruptSubagent)) && (
              <div
                className="cap-notice is-warn"
                role="status"
                data-testid="workspace-agents-readonly-notice"
              >
                {getCopy("workspace.agents.readOnlyNotice")}
              </div>
            )}

            {chatView.agents.length === 0 ? (
              <div className="workspace-empty" data-testid="workspace-agents-empty">
                {getCopy("workspace.agents.empty")}
              </div>
            ) : (
              <div className="workspace-item-list" role="group" aria-label="Subagents">
                {chatView.agents.map((agent) => {
                  const isSelected = agent.agentId === selectedAgent?.agentId;
                  return (
                    <button
                      key={agent.agentId}
                      type="button"
                      className={["workspace-item-chip", isSelected && "is-active"]
                        .filter(Boolean)
                        .join(" ")}
                      data-testid={`workspace-agent-item-${agent.agentId}`}
                      onClick={() => onSelectAgent(agent.agentId)}
                    >
                      <span>
                        {agent.name} ({agent.status})
                      </span>
                      {agent.lastKnown && (
                        <span
                          className="status-pill is-warn"
                          style={{ marginLeft: 6 }}
                          data-testid={`workspace-agent-lastknown-${agent.agentId}`}
                        >
                          {getCopy("workspace.agents.lastKnownBadge")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {selectedAgent && (canInterruptSubagent || canTailSubagent) && (
              <div
                className="workspace-preview-card"
                style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
              >
                {canTailSubagent && (
                  <button
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-agent-tail-btn"
                    data-action-id="subagents.tail"
                    data-evidence-testid={entryById.get("subagents.tail")?.evidenceTestId}
                    onClick={() => onRefreshAgentTail?.()}
                  >
                    {getCopy("workspace.agents.tailAction")}
                  </button>
                )}
                {canInterruptSubagent && selectedAgent.status === "running" && (
                  <button
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-agent-interrupt-btn"
                    data-action-id="subagents.interrupt"
                    data-evidence-testid={entryById.get("subagents.interrupt")?.evidenceTestId}
                    disabled={agentInterrupting}
                    onClick={() => onInterruptAgent?.()}
                  >
                    {agentInterrupting
                      ? getCopy("workspace.agents.interruptingAction")
                      : getCopy("workspace.agents.interruptAction")}
                  </button>
                )}
              </div>
            )}

            {canSteerSubagent && (
              <form
                className="workspace-preview-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  onSteerAgent?.();
                }}
              >
                <div className="form-field">
                  <label htmlFor={steerInputId}>
                    {getCopy("workspace.agents.steerLabel")}
                  </label>
                  <input
                    id={steerInputId}
                    type="text"
                    className="form-input"
                    value={chatView.steerText}
                    onChange={(e) => onChangeSteerText(e.target.value)}
                    placeholder={getCopy("workspace.agents.steerPlaceholder")}
                  />
                </div>
                {selectedAgent && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="submit"
                      className="button button-primary"
                      data-testid="workspace-agent-steer-btn"
                      data-action-id="subagents.steer"
                      data-evidence-testid={entryById.get("subagents.steer")?.evidenceTestId}
                      disabled={!chatView.steerText.trim()}
                    >
                      {getCopy("workspace.agents.steerAction")}
                    </button>
                  </div>
                )}
              </form>
            )}

            {chatView.agentError && (
              <div
                className="cap-notice is-warn"
                role="alert"
                data-testid="workspace-agent-error"
              >
                <div>
                  <strong data-testid="workspace-agent-error-code">
                    [{chatView.agentError.code}]
                  </strong>{" "}
                  <span>{chatView.agentError.message}</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                  {chatView.agentError.retryable && (
                    <button
                      type="button"
                      className="button button-secondary"
                      data-testid="workspace-agent-error-retry"
                      onClick={() => onRetryAgentAction?.()}
                    >
                      {getCopy("workspace.agents.retryAction")}
                    </button>
                  )}
                  {chatView.agentError.detail && (
                    <button
                      type="button"
                      className="button button-secondary"
                      data-testid="workspace-agent-error-details"
                      onClick={() => setShowAgentErrorDetail((v) => !v)}
                    >
                      {getCopy("workspace.agents.detailsAction")}
                    </button>
                  )}
                </div>
                {showAgentErrorDetail && chatView.agentError.detail && (
                  <pre
                    className="workspace-preview-content"
                    style={{ marginTop: 6 }}
                    data-testid="workspace-agent-error-detail-body"
                  >
                    {chatView.agentError.detail}
                  </pre>
                )}
              </div>
            )}

            {selectedAgent && canTailSubagent && (
              <div className="workspace-preview-card" data-testid="workspace-agent-tail">
                <div className="workspace-preview-toolbar">
                  <strong>{getCopy("workspace.agents.tailTitle")}</strong>
                  {selectedAgentTail?.truncated && (
                    <span
                      className="status-pill is-warn"
                      data-testid="workspace-agent-tail-truncated"
                    >
                      {getCopy("workspace.agents.tailTruncatedBadge")}
                    </span>
                  )}
                </div>
                {selectedAgentTailInvalidated ? (
                  <div
                    className="cap-notice is-warn"
                    role="status"
                    data-testid="workspace-agent-tail-invalidated"
                  >
                    {getCopy("workspace.agents.tailInvalidatedNotice")}
                  </div>
                ) : selectedAgentTail && selectedAgentTail.lines.length > 0 ? (
                  <pre
                    className="workspace-preview-content"
                    data-testid="workspace-agent-tail-content"
                  >
                    {selectedAgentTail.lines.join("\n")}
                  </pre>
                ) : (
                  <div className="workspace-empty" data-testid="workspace-agent-tail-empty">
                    {getCopy("workspace.agents.tailEmpty")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "checkpoints" && (
          <div className="workspace-panel">
            {!canRestoreCheckpoint && (
              <div
                className="cap-notice is-warn"
                role="status"
                data-testid="workspace-checkpoints-readonly-notice"
              >
                {getCopy("workspace.checkpoints.readOnlyNotice")}
              </div>
            )}

            {chatView.checkpoints.length === 0 ? (
              <div className="workspace-empty" data-testid="workspace-checkpoints-empty">
                {getCopy("workspace.checkpoints.empty")}
              </div>
            ) : (
              <>
                <div className="workspace-item-list" role="group" aria-label="Checkpoints">
                  {chatView.checkpoints.map((ckpt) => {
                    const isSelected = ckpt.checkpointId === selectedCheckpoint?.checkpointId;
                    return (
                      <button
                        key={ckpt.checkpointId}
                        type="button"
                        className={["workspace-item-chip", isSelected && "is-active"]
                          .filter(Boolean)
                          .join(" ")}
                        data-testid={`workspace-checkpoint-item-${ckpt.checkpointId}`}
                        onClick={() => onSelectCheckpoint?.(ckpt.checkpointId)}
                      >
                        <span>{ckpt.title}</span>
                        {chatView.restoredCheckpointIds.includes(ckpt.checkpointId) && (
                          <span
                            className="status-pill"
                            style={{ marginLeft: 6 }}
                            data-testid={`workspace-checkpoint-restored-${ckpt.checkpointId}`}
                          >
                            已恢复
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {selectedCheckpoint && (
                  <div className="workspace-preview-card">
                    <div className="workspace-preview-toolbar">
                      <div>
                        <strong>{selectedCheckpoint.title}</strong>
                        {selectedCheckpoint.summary && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 11.5,
                              color: "var(--muted)",
                            }}
                          >
                            {selectedCheckpoint.summary}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {canDiffCheckpoint && (
                          <button
                            type="button"
                            className="button button-secondary"
                            data-testid="workspace-checkpoint-diff-btn"
                            data-action-id="checkpoint.diff"
                            data-evidence-testid={entryById.get("checkpoint.diff")?.evidenceTestId}
                            onClick={() => onDiffCheckpoint?.(selectedCheckpoint.checkpointId)}
                          >
                            {getCopy("workspace.checkpoints.diffAction")}
                          </button>
                        )}
                        {canRestoreCheckpoint && (
                          <button
                            type="button"
                            className="button button-primary"
                            data-testid="workspace-checkpoint-restore-btn"
                            data-action-id="checkpoint.restore"
                            data-evidence-testid={
                              entryById.get("checkpoint.restore")?.evidenceTestId
                            }
                            onClick={() =>
                              onRequestRestoreCheckpoint?.(selectedCheckpoint.checkpointId)
                            }
                          >
                            {getCopy("workspace.checkpoints.restoreAction")}
                          </button>
                        )}
                      </div>
                    </div>

                    {canRestoreCheckpoint &&
                      chatView.checkpointRestorePendingId === selectedCheckpoint.checkpointId && (
                        <div
                          className="cap-notice is-warn"
                          role="region"
                          aria-label={getCopy("workspace.checkpoints.confirmTitle")}
                          data-testid="workspace-checkpoint-confirm-card"
                          style={{ marginTop: 8 }}
                        >
                          <strong>{getCopy("workspace.checkpoints.confirmTitle")}</strong>
                          <p style={{ margin: "4px 0" }}>
                            {getCopy("workspace.checkpoints.confirmBody")}
                          </p>
                          <div
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              marginBottom: 8,
                            }}
                            data-testid="workspace-checkpoint-confirm-binding"
                          >
                            {activeChatScope?.connectionId ?? "local"} /{" "}
                            {activeChatScope?.profileId ?? "default"} /{" "}
                            {activeChatScope?.sessionId ?? "none"} · gen{" "}
                            {capabilities?.generation ?? 1}
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              type="button"
                              className="button button-primary"
                              data-testid="workspace-checkpoint-confirm-btn"
                              onClick={() => onConfirmRestoreCheckpoint?.()}
                            >
                              {getCopy("workspace.checkpoints.confirmRestoreAction")}
                            </button>
                            <button
                              type="button"
                              className="button button-secondary"
                              data-testid="workspace-checkpoint-cancel-btn"
                              onClick={() => onCancelRestoreCheckpoint?.()}
                            >
                              {getCopy("workspace.checkpoints.cancelRestoreAction")}
                            </button>
                          </div>
                        </div>
                      )}

                    {chatView.checkpointError && (
                      <div
                        className="cap-notice is-warn"
                        role="alert"
                        data-testid="workspace-checkpoint-error"
                        style={{ marginTop: 8 }}
                      >
                        <div>
                          <strong data-testid="workspace-checkpoint-error-code">
                            [{chatView.checkpointError.code}]
                          </strong>{" "}
                          <span>{chatView.checkpointError.message}</span>
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                          {chatView.checkpointError.retryable && (
                            <button
                              type="button"
                              className="button button-secondary"
                              data-testid="workspace-checkpoint-error-retry"
                              onClick={() => onRetryCheckpointAction?.()}
                            >
                              {getCopy("workspace.checkpoints.retryAction")}
                            </button>
                          )}
                          {chatView.checkpointError.detail && (
                            <button
                              type="button"
                              className="button button-secondary"
                              data-testid="workspace-checkpoint-error-details"
                              onClick={() => setShowCheckpointErrorDetail((v) => !v)}
                            >
                              {getCopy("workspace.checkpoints.detailsAction")}
                            </button>
                          )}
                        </div>
                        {showCheckpointErrorDetail && chatView.checkpointError.detail && (
                          <pre
                            className="workspace-preview-content"
                            style={{ marginTop: 6 }}
                            data-testid="workspace-checkpoint-error-detail-body"
                          >
                            {chatView.checkpointError.detail}
                          </pre>
                        )}
                      </div>
                    )}

                    <div
                      style={{ marginTop: 8 }}
                      data-testid="workspace-checkpoint-diff-section"
                    >
                      <div className="workspace-preview-toolbar">
                        <strong>{getCopy("workspace.checkpoints.diffTitle")}</strong>
                        {selectedCheckpointDiff && (
                          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                            {selectedCheckpointDiff.summary}
                          </span>
                        )}
                      </div>
                      {selectedCheckpointDiff ? (
                        <pre
                          className="workspace-preview-content"
                          data-testid="workspace-checkpoint-diff-preview"
                        >
                          {selectedCheckpointDiff.patch}
                        </pre>
                      ) : (
                        <div className="workspace-empty">
                          {getCopy("workspace.checkpoints.diffEmpty")}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "terminal" && (
          <div className="workspace-panel">
            {scopeView.terminalScrollback.length === 0 ? (
              <div className="workspace-empty">{getCopy("workspace.terminal.empty")}</div>
            ) : (
              <pre
                className="workspace-preview-content"
                data-testid="workspace-terminal-scrollback"
              >
                {scopeView.terminalScrollback.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
