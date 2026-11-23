import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  BridgeScope,
  CapabilityEntry,
  CapabilitySnapshot,
  TerminalSnapshot,
  WorkspaceTab,
} from "@hermes/contracts";
import {
  buildGitWorktreeDeepLinks,
  createEmptyTerminalSnapshot,
  getActiveChatWorkspaceView,
  getActiveScopeWorkspaceView,
  getCopy,
  getWorkspaceTabBinding,
  projectArtifactAnnotations,
  type CopyKey,
  type WorkspaceSessionState,
} from "@hermes/domain";
import { AttributionBadge } from "./AttributionBadge";

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
  onSelectGitDiff?: (relativePath: string) => void;
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
  terminalBusyConfirmOpen?: boolean;
  onOpenTerminal?: (options?: { mode?: "open" | "new" | "grant_root"; grantRoot?: boolean }) => void;
  onWriteTerminal?: (data: string) => void;
  onResizeTerminal?: (cols: number, rows: number) => void;
  onCloseTerminal?: (mode?: "auto" | "detach" | "terminate") => void;
  onCancelTerminalBusyConfirm?: () => void;
  onCopyGitCommand?: (command: string) => void;
  onOpenExternalUrl?: (url: string) => void;
  terminalCloseBtnRef?: React.RefObject<HTMLButtonElement>;
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
  terminalBusyConfirmOpen = false,
  onOpenTerminal,
  onWriteTerminal,
  onResizeTerminal,
  onCloseTerminal,
  onCancelTerminalBusyConfirm,
  onCopyGitCommand,
  onOpenExternalUrl,
  terminalCloseBtnRef,
}: WorkspaceDrawerProps) {
  const [xInput, setXInput] = useState("25");
  const [yInput, setYInput] = useState("25");
  const [commentInput, setCommentInput] = useState("");
  const [showAgentErrorDetail, setShowAgentErrorDetail] = useState(false);
  const [showCheckpointErrorDetail, setShowCheckpointErrorDetail] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [colsInput, setColsInput] = useState("80");
  const [rowsInput, setRowsInput] = useState("24");
  const [copiedGitId, setCopiedGitId] = useState<string | null>(null);
  const detachBtnRef = useRef<HTMLButtonElement>(null);
  const fallbackCloseBtnRef = useRef<HTMLButtonElement>(null);
  const effectiveCloseBtnRef = terminalCloseBtnRef ?? fallbackCloseBtnRef;
  const xInputId = useId();
  const yInputId = useId();
  const commentInputId = useId();
  const steerInputId = useId();
  const terminalInputId = useId();
  const colsInputId = useId();
  const rowsInputId = useId();

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

  const gitDeepLinks = useMemo(() => buildGitWorktreeDeepLinks(), []);
  const terminalSnapshot: TerminalSnapshot = useMemo(() => {
    if (scopeView.terminalSnapshot) {
      return scopeView.terminalSnapshot;
    }
    return createEmptyTerminalSnapshot(activeChatScope, {
      lines: scopeView.terminalScrollback,
      lineCount: scopeView.terminalScrollback.length,
    });
  }, [activeChatScope, scopeView.terminalScrollback, scopeView.terminalSnapshot]);

  useEffect(() => {
    setColsInput(String(terminalSnapshot.cols));
    setRowsInput(String(terminalSnapshot.rows));
  }, [terminalSnapshot.cols, terminalSnapshot.rows]);

  useEffect(() => {
    if (terminalBusyConfirmOpen && activeTab === "terminal") {
      detachBtnRef.current?.focus();
    }
  }, [activeTab, terminalBusyConfirmOpen]);

  const getTerminalStatusLabel = (status: TerminalSnapshot["status"]): string => {
    switch (status) {
      case "grant_denied":
        return getCopy("workspace.terminal.statusGrantDenied");
      case "running":
        return getCopy("workspace.terminal.statusRunning");
      case "detached":
        return getCopy("workspace.terminal.statusDetached");
      case "ended":
        return getCopy("workspace.terminal.statusEnded");
      case "idle":
      default:
        return getCopy("workspace.terminal.statusIdle");
    }
  };

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
          <div className="workspace-panel" data-testid="workspace-git-panel">
            <div className="cap-notice" role="status" data-testid="workspace-git-boundary">
              <strong>{getCopy("workspace.git.title")}</strong>
              <p style={{ margin: "4px 0 0" }}>{gitDeepLinks.boundaryNote}</p>
            </div>

            <div className="workspace-preview-card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="button button-secondary"
                data-testid="workspace-git-open-terminal-btn"
                onClick={() => onSelectTab("terminal")}
              >
                {getCopy("workspace.git.openTerminalAction")}
              </button>
              {copiedGitId && (
                <span className="status-pill is-ok" role="status" data-testid="workspace-git-copied-notice">
                  {getCopy("workspace.git.copiedNotice")}
                </span>
              )}
            </div>

            <div className="workspace-preview-card">
              <strong style={{ display: "block", marginBottom: 8 }}>
                {getCopy("workspace.git.cliSectionTitle")}
              </strong>
              <div className="git-deeplink-list">
                {gitDeepLinks.cliItems.map((item) => (
                  <div key={item.id} className="git-deeplink-row" data-testid={`workspace-git-cli-item-${item.id}`}>
                    <div className="git-deeplink-row-head">
                      <span>{getCopy(item.labelKey as CopyKey)}</span>
                      <AttributionBadge
                        attribution={item.attribution}
                        testId={`workspace-git-attribution-${item.id}`}
                      />
                    </div>
                    <code className="git-deeplink-command">{item.command}</code>
                    <div className="git-deeplink-row-actions">
                      <span className="git-never-executed" data-testid={`workspace-git-never-executed-${item.id}`}>
                        {item.executionNote}
                      </span>
                      <button
                        type="button"
                        className="button button-secondary"
                        data-testid={`workspace-git-copy-${item.id}`}
                        onClick={() => {
                          onCopyGitCommand?.(item.command);
                          setCopiedGitId(item.id);
                        }}
                      >
                        {getCopy("workspace.git.copyAction")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="workspace-preview-card">
              <strong style={{ display: "block", marginBottom: 8 }}>
                {getCopy("workspace.git.docsSectionTitle")}
              </strong>
              <div className="git-deeplink-list">
                {gitDeepLinks.docLinks.map((doc) => (
                  <div key={doc.id} className="git-deeplink-row" data-testid={`workspace-git-doc-item-${doc.id}`}>
                    <div className="git-deeplink-row-head">
                      <span>{getCopy(doc.labelKey as CopyKey)}</span>
                      <AttributionBadge
                        attribution={doc.attribution}
                        testId={`workspace-git-doc-attribution-${doc.id}`}
                      />
                    </div>
                    <div className="git-deeplink-row-actions">
                      <span className="git-never-executed">{doc.url}</span>
                      <button
                        type="button"
                        className="button button-secondary"
                        data-testid={`workspace-git-doc-${doc.id}`}
                        onClick={() => onOpenExternalUrl?.(doc.url)}
                      >
                        {getCopy("workspace.git.openDocsAction")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
          <div className="workspace-panel" data-testid="workspace-terminal-panel">
            <div className="workspace-preview-card">
              <div className="terminal-status-header">
                <strong>{getCopy("workspace.terminal.title")}</strong>
                <div className="terminal-badges">
                  <span
                    className={[
                      "status-pill",
                      terminalSnapshot.status === "running" && "is-ok",
                      (terminalSnapshot.status === "grant_denied" || terminalSnapshot.status === "ended") && "is-warn",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-testid="workspace-terminal-status"
                  >
                    {getTerminalStatusLabel(terminalSnapshot.status)}
                  </span>
                  <AttributionBadge
                    attribution={terminalSnapshot.attribution}
                    testId="workspace-terminal-attribution"
                  />
                </div>
              </div>

              <div className="terminal-meta-row">
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {getCopy("workspace.terminal.scopeHint")}
                </span>
                {terminalSnapshot.terminalId && (
                  <code className="terminal-id-chip" data-testid="workspace-terminal-id">
                    {terminalSnapshot.terminalId}
                  </code>
                )}
                {(terminalSnapshot.status === "running" || terminalSnapshot.status === "detached") && (
                  <span
                    className={["status-pill", terminalSnapshot.hasForegroundProcess && "is-warn"]
                      .filter(Boolean)
                      .join(" ")}
                    data-testid="workspace-terminal-fg-badge"
                  >
                    {terminalSnapshot.hasForegroundProcess
                      ? `${getCopy("workspace.terminal.fgBusyBadge")}${terminalSnapshot.foregroundProcessName ? ` (${terminalSnapshot.foregroundProcessName})` : ""}`
                      : getCopy("workspace.terminal.fgIdleBadge")}
                  </span>
                )}
                {terminalSnapshot.rootGranted && (
                  <span className="status-pill is-ok" data-testid="workspace-terminal-root-badge">
                    {getCopy("workspace.terminal.rootGrantedBadge")}
                  </span>
                )}
              </div>

              <div className="terminal-action-bar">
                {(terminalSnapshot.status === "idle" || terminalSnapshot.status === "grant_denied") && (
                  <button
                    type="button"
                    className="button button-primary"
                    data-testid="workspace-terminal-open-btn"
                    onClick={() => onOpenTerminal?.({ mode: "open" })}
                  >
                    {getCopy("workspace.terminal.openAction")}
                  </button>
                )}
                {terminalSnapshot.status === "detached" && (
                  <button
                    type="button"
                    className="button button-primary"
                    data-testid="workspace-terminal-reattach-btn"
                    onClick={() => onOpenTerminal?.({ mode: "open" })}
                  >
                    {getCopy("workspace.terminal.reattachAction")}
                  </button>
                )}
                {terminalSnapshot.status === "ended" && (
                  <button
                    type="button"
                    className="button button-primary"
                    data-testid="workspace-terminal-new-btn"
                    onClick={() => onOpenTerminal?.({ mode: "new" })}
                  >
                    {getCopy("workspace.terminal.newAction")}
                  </button>
                )}
                {!terminalSnapshot.rootGranted && (
                  <button
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-terminal-grant-root-btn"
                    onClick={() => onOpenTerminal?.({ mode: "grant_root", grantRoot: true })}
                  >
                    {getCopy("workspace.terminal.grantRootAction")}
                  </button>
                )}
                {(terminalSnapshot.status === "running" ||
                  terminalSnapshot.status === "detached" ||
                  terminalSnapshot.status === "ended" ||
                  terminalSnapshot.lines.length > 0) && (
                  <button
                    ref={effectiveCloseBtnRef}
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-terminal-close-btn"
                    onClick={() => onCloseTerminal?.("auto")}
                  >
                    {getCopy("workspace.terminal.closeAction")}
                  </button>
                )}
              </div>
            </div>

            {terminalSnapshot.status === "grant_denied" && (
              <div className="cap-notice is-warn" role="alert" data-testid="workspace-terminal-grant-denied-notice">
                {getCopy("workspace.terminal.grantDeniedNotice")}
              </div>
            )}

            {terminalSnapshot.status === "ended" && (
              <div className="cap-notice is-warn" role="status" data-testid="workspace-terminal-ended-notice">
                {getCopy("workspace.terminal.endedNotice")}
              </div>
            )}

            {terminalSnapshot.trimmedOldest && (
              <div className="cap-notice is-warn" role="status" data-testid="workspace-terminal-trimmed-notice">
                {getCopy("workspace.terminal.trimmedNotice")}
              </div>
            )}

            {terminalBusyConfirmOpen && terminalSnapshot.status === "running" && (
              <div
                className="cap-notice is-warn"
                role="region"
                aria-label={getCopy("workspace.terminal.busyConfirmTitle")}
                data-testid="workspace-terminal-busy-confirm"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancelTerminalBusyConfirm?.();
                    effectiveCloseBtnRef.current?.focus();
                  }
                }}
              >
                <strong>{getCopy("workspace.terminal.busyConfirmTitle")}</strong>
                <p style={{ margin: "4px 0 8px" }}>{getCopy("workspace.terminal.busyConfirmBody")}</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    ref={detachBtnRef}
                    type="button"
                    className="button button-primary"
                    data-testid="workspace-terminal-detach-btn"
                    onClick={() => onCloseTerminal?.("detach")}
                  >
                    {getCopy("workspace.terminal.detachKeepAction")}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-terminal-terminate-btn"
                    onClick={() => onCloseTerminal?.("terminate")}
                  >
                    {getCopy("workspace.terminal.terminateAction")}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-terminal-cancel-close-btn"
                    onClick={() => {
                      onCancelTerminalBusyConfirm?.();
                      effectiveCloseBtnRef.current?.focus();
                    }}
                  >
                    {getCopy("workspace.terminal.cancelConfirmAction")}
                  </button>
                </div>
              </div>
            )}

            {terminalSnapshot.lines.length === 0 ? (
              <div className="workspace-empty" data-testid="workspace-terminal-empty">
                {getCopy("workspace.terminal.empty")}
              </div>
            ) : (
              <pre
                className="workspace-preview-content workspace-terminal-screen"
                data-testid="workspace-terminal-scrollback"
              >
                {terminalSnapshot.lines.join("\n")}
              </pre>
            )}

            {terminalSnapshot.status === "running" && (
              <div className="workspace-preview-card terminal-controls-card">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!terminalInput) return;
                    const payload = terminalInput.endsWith("\n")
                      ? terminalInput
                      : `${terminalInput}\n`;
                    onWriteTerminal?.(payload);
                    setTerminalInput("");
                  }}
                >
                  <div className="form-field">
                    <label htmlFor={terminalInputId}>
                      {getCopy("workspace.terminal.inputLabel")}
                    </label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        id={terminalInputId}
                        type="text"
                        className="form-input"
                        data-testid="workspace-terminal-input"
                        value={terminalInput}
                        onChange={(e) => setTerminalInput(e.target.value)}
                        placeholder={getCopy("workspace.terminal.inputPlaceholder")}
                      />
                      <button
                        type="submit"
                        className="button button-primary"
                        data-testid="workspace-terminal-send-btn"
                        disabled={!terminalInput}
                      >
                        {getCopy("workspace.terminal.sendAction")}
                      </button>
                    </div>
                  </div>
                </form>

                <div className="terminal-resize-row">
                  <label htmlFor={colsInputId} className="terminal-dim-label">
                    {getCopy("workspace.terminal.colsLabel")}
                    <input
                      id={colsInputId}
                      type="number"
                      min={20}
                      max={300}
                      className="form-input terminal-dim-input"
                      data-testid="workspace-terminal-cols-input"
                      value={colsInput}
                      onChange={(e) => setColsInput(e.target.value)}
                    />
                  </label>
                  <label htmlFor={rowsInputId} className="terminal-dim-label">
                    {getCopy("workspace.terminal.rowsLabel")}
                    <input
                      id={rowsInputId}
                      type="number"
                      min={5}
                      max={120}
                      className="form-input terminal-dim-input"
                      data-testid="workspace-terminal-rows-input"
                      value={rowsInput}
                      onChange={(e) => setRowsInput(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="button button-secondary"
                    data-testid="workspace-terminal-resize-btn"
                    onClick={() => {
                      const cols = Number(colsInput) || 80;
                      const rows = Number(rowsInput) || 24;
                      onResizeTerminal?.(cols, rows);
                    }}
                  >
                    {getCopy("workspace.terminal.resizeAction")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
