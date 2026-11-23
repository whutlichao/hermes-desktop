import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Command,
  PanelRight,
  Plus,
  Settings2,
} from "lucide-react";
import type {
  AppCommand,
  BridgeScope,
  FleetSnapshot,
  LocalInspectResult,
  LocalSafeActionId,
  LocalSelectCliResult,
  RegistrySnapshotView,
  SanitizedDiagnosticsPayload,
  SessionSummary,
  SessionTranscriptSnapshot,
  WorkspaceTab,
} from "@hermes/contracts";
import {
  HERMES_INSTALL_DOCS_URL,
  HERMES_UPDATE_DOCS_URL,
  createInitialShellState,
  createSequenceTracker,
  deriveViewportMode,
  filterProfilesForConnection,
  filterSessionsForScope,
  formatAppInfoDisplay,
  getCopy,
  getTopmostSurface,
  shellReducer,
} from "@hermes/domain";
import { host } from "@hermes/host-adapter";
import { ChatThread } from "./components/ChatThread";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { GatewaysSettings } from "./components/GatewaysSettings";
import { HermesMark } from "./components/HermesMark";
import { FocusDialog } from "./components/Modal";
import { SessionRailList } from "./components/SessionRail";

const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "artifacts", label: "Artifacts" },
  { id: "files", label: "Files" },
  { id: "git", label: "Git" },
  { id: "agents", label: "Agents" },
  { id: "terminal", label: "Terminal" },
];

export default function App() {
  const [state, dispatch] = useReducer(shellReducer, undefined, createInitialShellState);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");
  const [transcriptResyncNonce, setTranscriptResyncNonce] = useState(0);
  const [registrySnapshot, setRegistrySnapshot] = useState<RegistrySnapshotView | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef(createSequenceTracker());
  const registryTrackerRef = useRef(createSequenceTracker());
  const transcriptTrackerRef = useRef(createSequenceTracker());

  const viewportMode = deriveViewportMode(viewportWidth);
  const topmostSurface = getTopmostSurface(state);
  const hasModal = topmostSurface !== null;

  const activeConnection = useMemo(() => {
    if (state.connections.length === 0) return null;
    if (state.activeScope?.connectionId) {
      return state.connections.find((c) => c.connectionId === state.activeScope?.connectionId) ?? state.connections[0];
    }
    return state.connections[0];
  }, [state.activeScope?.connectionId, state.connections]);

  const hasReadyConnection = Boolean(activeConnection && activeConnection.actual === "ready");
  const activeScopeConnId = state.activeScope?.connectionId;
  const activeScopeProfileId = state.activeScope?.profileId;
  const activeScopeSessionId = state.activeScope?.sessionId;
  const fallbackConnId = activeConnection?.connectionId;
  const effectiveScope: BridgeScope | null = useMemo(() => {
    if (activeScopeConnId) {
      return {
        connectionId: activeScopeConnId,
        ...(activeScopeProfileId ? { profileId: activeScopeProfileId } : {}),
        ...(activeScopeSessionId ? { sessionId: activeScopeSessionId } : {}),
      };
    }
    if (fallbackConnId) {
      return { connectionId: fallbackConnId, profileId: "default" };
    }
    return null;
  }, [activeScopeConnId, activeScopeProfileId, activeScopeSessionId, fallbackConnId]);

  const scopedProfiles = useMemo(
    () => filterProfilesForConnection(state.profiles, effectiveScope?.connectionId),
    [effectiveScope?.connectionId, state.profiles],
  );

  const activeProfile = useMemo(() => {
    const pid = effectiveScope?.profileId;
    if (!pid) return scopedProfiles[0] ?? null;
    return scopedProfiles.find((p) => p.profileId === pid) ?? null;
  }, [effectiveScope?.profileId, scopedProfiles]);

  const scopedSessions = useMemo(
    () => (hasReadyConnection ? filterSessionsForScope(state.sessions, effectiveScope) : []),
    [effectiveScope, hasReadyConnection, state.sessions],
  );

  const canCreateSession = hasReadyConnection
    ? state.transcript
      ? state.transcript.supportedActions.sessionCreate
      : true
    : false;

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keep background inert when a modal dialog is open (useLayoutEffect ensures inert is cleared before focus returns)
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    if (hasModal) {
      el.setAttribute("inert", "");
    } else {
      el.removeAttribute("inert");
    }
  }, [hasModal]);

  const handleCreateSession = useCallback(async () => {
    if (!hasReadyConnection || !effectiveScope || !canCreateSession) {
      dispatch({ type: "ANNOUNCE", message: getCopy("empty.body") });
      return null;
    }
    const res = await host.request<{ session?: SessionSummary; transcript?: SessionTranscriptSnapshot }>(
      "sessions.create",
      { title: getCopy("chat.newSessionDefaultTitle"), profileId: effectiveScope.profileId ?? "default" },
      effectiveScope,
    );
    if (res.ok && res.value.transcript) {
      dispatch({
        type: "APPLY_TRANSCRIPT_EVENT",
        event: {
          topic: "session.transcript",
          scope: effectiveScope,
          kind: "snapshot",
          seq: 0,
          revision: 1,
          payload: res.value.transcript,
        },
      });
    }
    return res.ok ? res.value.session ?? null : null;
  }, [canCreateSession, effectiveScope, hasReadyConnection]);

  const handleSelectSession = useCallback(
    async (session: SessionSummary) => {
      const targetScope: BridgeScope = {
        connectionId: session.connectionId,
        profileId: session.profileId,
        sessionId: session.sessionId,
      };
      dispatch({ type: "SET_STOP_ERROR", message: null });
      const res = await host.request<{ transcript?: SessionTranscriptSnapshot }>(
        "sessions.select",
        { sessionId: session.sessionId, profileId: session.profileId },
        targetScope,
      );
      if (res.ok && res.value.transcript) {
        dispatch({
          type: "APPLY_TRANSCRIPT_EVENT",
          event: {
            topic: "session.transcript",
            scope: targetScope,
            kind: "snapshot",
            seq: 0,
            revision: 1,
            payload: res.value.transcript,
          },
        });
      }
      dispatch({ type: "CLOSE_SURFACE", surface: "sessionsPopover" });
    },
    [],
  );

  const handleSelectProfile = useCallback(
    async (profileId: string) => {
      if (!effectiveScope) return;
      const targetScope: BridgeScope = {
        connectionId: effectiveScope.connectionId,
        profileId,
      };
      await host.request("sessions.select", { profileId }, targetScope);
      dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" });
      dispatch({ type: "ANNOUNCE", message: getCopy("scope.switchNotice") });
    },
    [effectiveScope],
  );

  const handleSendPrompt = useCallback(async () => {
    const text = composerDraft.trim();
    if (!text || !hasReadyConnection || !effectiveScope || state.chatBusy) return;
    dispatch({ type: "SET_CHAT_BUSY", busy: true });
    dispatch({ type: "SET_STOP_ERROR", message: null });
    try {
      let targetSessionId = state.activeSessionId;
      if (!targetSessionId) {
        const created = await handleCreateSession();
        targetSessionId = created?.sessionId ?? null;
      }
      if (!targetSessionId) {
        dispatch({ type: "SET_STOP_ERROR", message: getCopy("chat.sendFailed") });
        return;
      }
      const targetScope: BridgeScope = {
        connectionId: effectiveScope.connectionId,
        profileId: effectiveScope.profileId ?? "default",
        sessionId: targetSessionId,
      };
      const res = await host.request("prompts.send", { sessionId: targetSessionId, text }, targetScope);
      if (res.ok) {
        setComposerDraft("");
      } else {
        dispatch({ type: "SET_STOP_ERROR", message: getCopy("chat.sendFailed") });
      }
    } finally {
      dispatch({ type: "SET_CHAT_BUSY", busy: false });
    }
  }, [composerDraft, effectiveScope, handleCreateSession, hasReadyConnection, state.activeSessionId, state.chatBusy]);

  const handleStopTurn = useCallback(async () => {
    if (!effectiveScope || !state.activeSessionId || !state.transcript?.activeTurnId) return;
    const targetScope: BridgeScope = {
      connectionId: effectiveScope.connectionId,
      profileId: effectiveScope.profileId ?? "default",
      sessionId: state.activeSessionId,
    };
    dispatch({ type: "SET_STOP_ERROR", message: null });
    const res = await host.request(
      "prompts.stop",
      {
        sessionId: state.activeSessionId,
        turnId: state.transcript.activeTurnId,
      },
      targetScope,
    );
    if (!res.ok) {
      dispatch({ type: "SET_STOP_ERROR", message: getCopy("chat.stopFailed") });
    }
  }, [effectiveScope, state.activeSessionId, state.transcript?.activeTurnId]);

  const handleAppCommand = useCallback(
    (command: AppCommand) => {
      switch (command.type) {
        case "open_palette":
          dispatch({ type: "OPEN_SURFACE", surface: "palette" });
          dispatch({ type: "ANNOUNCE", message: getCopy("palette.title") });
          break;
        case "open_settings":
          dispatch({ type: "OPEN_SURFACE", surface: "settings" });
          dispatch({ type: "ANNOUNCE", message: getCopy("settings.title") });
          break;
        case "toggle_workspace":
          dispatch({ type: "TOGGLE_WORKSPACE" });
          break;
        case "new_session":
          void handleCreateSession();
          break;
        case "open_shortcuts":
          dispatch({ type: "OPEN_SURFACE", surface: "shortcuts" });
          dispatch({ type: "ANNOUNCE", message: getCopy("shortcuts.title") });
          break;
        case "open_about":
        case "close_window":
        case "focus_scope":
          break;
      }
    },
    [handleCreateSession],
  );

  const handleAppCommandRef = useRef(handleAppCommand);
  handleAppCommandRef.current = handleAppCommand;

  // HostBridge bootstrap: hello + local.inspect + fleet subscription + native command listener
  useEffect(() => {
    let active = true;
    void host.request("bridge.hello", {}).then((res) => {
      if (!active || !res.ok) return;
      dispatch({ type: "HYDRATE_HELLO", appInfo: res.value as NonNullable<typeof state.appInfo> });
    });

    void host.request<LocalInspectResult>("local.inspect", {}).then((res) => {
      if (!active || !res.ok) return;
      dispatch({ type: "APPLY_LOCAL_INSPECTION", inspection: res.value });
    });

    const unsubFleet = host.subscribe("fleet", null, (event) => {
      const accepted = trackerRef.current.accept(event);
      if (accepted.status === "applied") {
        const snapshot = event.payload as FleetSnapshot;
        dispatch({
          type: "APPLY_FLEET_SNAPSHOT",
          connections: snapshot.connections,
          profiles: snapshot.profiles,
          sessions: snapshot.sessions,
          activeScope: snapshot.activeScope,
          activeSessionId: snapshot.activeSessionId,
        });
      }
    });

    const unsubRegistry = host.subscribe("registry", null, (event) => {
      const accepted = registryTrackerRef.current.accept(event);
      if (accepted.status === "applied") {
        const payload = event.payload as { snapshot?: RegistrySnapshotView };
        if (payload?.snapshot) {
          setRegistrySnapshot(payload.snapshot);
        }
      }
    });

    const unsubCmd = host.onCommand((command) => handleAppCommandRef.current(command));
    return () => {
      active = false;
      unsubFleet();
      unsubRegistry();
      unsubCmd();
    };
  }, []);

  // Subscribe to active session transcript stream with sequence verification & resync recovery
  useEffect(() => {
    const scope = state.activeScope;
    const sessionId = state.activeSessionId;
    if (!hasReadyConnection || !scope || !sessionId) {
      dispatch({ type: "CLEAR_TRANSCRIPT" });
      return;
    }
    const targetScope: BridgeScope = {
      connectionId: scope.connectionId,
      profileId: scope.profileId ?? "default",
      sessionId,
    };
    transcriptTrackerRef.current.reset();
    const unsubTranscript = host.subscribe("session.transcript", targetScope, (event) => {
      const accepted = transcriptTrackerRef.current.accept(event);
      if (accepted.status === "resync_required") {
        transcriptTrackerRef.current.reset();
        setTranscriptResyncNonce((n) => n + 1);
        return;
      }
      if (accepted.status === "applied") {
        dispatch({ type: "APPLY_TRANSCRIPT_EVENT", event });
      }
    });
    return () => {
      unsubTranscript();
    };
  }, [
    hasReadyConnection,
    state.activeScope?.connectionId,
    state.activeScope?.profileId,
    state.activeSessionId,
    transcriptResyncNonce,
  ]);

  // Global keyboard handler (Esc single-layer dismissal; web-mode shortcuts)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      if (event.key === "Escape") {
        if (state.surfaceStack.length > 0) {
          event.preventDefault();
          dispatch({ type: "CLOSE_TOPMOST_SURFACE" });
          return;
        }
        if (state.workspace.mode === "open") {
          event.preventDefault();
          dispatch({ type: "SET_WORKSPACE_MODE", mode: "hidden" });
        }
        return;
      }

      // In Electron mode, native menu accelerators dispatch AppCommands via IPC
      if (state.appInfo?.mode === "electron") return;

      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();

      if (key === "k") {
        event.preventDefault();
        handleAppCommand({ type: "open_palette" });
      } else if (event.key === ",") {
        event.preventDefault();
        handleAppCommand({ type: "open_settings" });
      } else if (key === "b") {
        event.preventDefault();
        handleAppCommand({ type: "toggle_workspace" });
      } else if (key === "n") {
        event.preventDefault();
        handleAppCommand({ type: "new_session" });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        handleAppCommand({ type: "open_shortcuts" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleAppCommand, state.appInfo?.mode, state.surfaceStack.length, state.workspace.mode]);

  const paletteCommands = useMemo(
    () => [
      {
        id: "cmd-new-session",
        label: getCopy("palette.cmdNewSession"),
        hint: getCopy("palette.cmdNewSessionHint"),
        shortcut: "⌘N",
        run: () => {
          dispatch({ type: "CLOSE_SURFACE", surface: "palette" });
          handleAppCommand({ type: "new_session" });
        },
      },
      {
        id: "cmd-settings",
        label: getCopy("palette.cmdSettings"),
        hint: getCopy("palette.cmdSettingsHint"),
        shortcut: "⌘,",
        run: () => {
          dispatch({ type: "CLOSE_SURFACE", surface: "palette" });
          handleAppCommand({ type: "open_settings" });
        },
      },
      {
        id: "cmd-workspace",
        label: getCopy("palette.cmdWorkspace"),
        hint: getCopy("palette.cmdWorkspaceHint"),
        shortcut: "⌘B",
        run: () => {
          dispatch({ type: "CLOSE_SURFACE", surface: "palette" });
          handleAppCommand({ type: "toggle_workspace" });
        },
      },
      {
        id: "cmd-capabilities",
        label: getCopy("palette.cmdCapabilities"),
        hint: getCopy("palette.cmdCapabilitiesHint"),
        shortcut: "",
        run: () => {
          dispatch({ type: "CLOSE_SURFACE", surface: "palette" });
          dispatch({ type: "OPEN_SURFACE", surface: "capabilities" });
        },
      },
      {
        id: "cmd-shortcuts",
        label: getCopy("palette.cmdShortcuts"),
        hint: getCopy("palette.cmdShortcutsHint"),
        shortcut: "⌘?",
        run: () => {
          dispatch({ type: "CLOSE_SURFACE", surface: "palette" });
          handleAppCommand({ type: "open_shortcuts" });
        },
      },
    ],
    [handleAppCommand],
  );

  const filteredCommands = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return paletteCommands;
    return paletteCommands.filter(
      (item) =>
        item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q),
    );
  }, [paletteCommands, paletteQuery]);

  const handleLocalAction = useCallback(async (action: LocalSafeActionId) => {
    setLocalBusy(true);
    try {
      switch (action) {
        case "choose_cli": {
          const res = await host.request<LocalSelectCliResult>("local.selectCli", {});
          if (res.ok) {
            dispatch({ type: "APPLY_LOCAL_INSPECTION", inspection: res.value.inspection });
            dispatch({
              type: "ANNOUNCE",
              message: res.value.cancelled
                ? getCopy("local.selectCancelled")
                : res.value.cli.displayName,
            });
          }
          break;
        }
        case "open_install_docs":
          await host.request("links.openExternal", { url: HERMES_INSTALL_DOCS_URL });
          break;
        case "open_update_docs":
          await host.request("links.openExternal", { url: HERMES_UPDATE_DOCS_URL });
          break;
        case "retry":
        case "restart_gateway": {
          const retryRes = await host.request<{
            ok?: boolean;
            fleet?: FleetSnapshot;
            inspection?: LocalInspectResult;
          }>("connections.retry", { connectionId: "local" });
          if (retryRes.ok) {
            if (retryRes.value.inspection) {
              dispatch({ type: "APPLY_LOCAL_INSPECTION", inspection: retryRes.value.inspection });
              dispatch({ type: "ANNOUNCE", message: retryRes.value.inspection.cli.displayName });
            }
            if (retryRes.value.fleet) {
              dispatch({
                type: "APPLY_FLEET_SNAPSHOT",
                connections: retryRes.value.fleet.connections,
                profiles: retryRes.value.fleet.profiles,
                sessions: retryRes.value.fleet.sessions,
                activeScope: retryRes.value.fleet.activeScope,
                activeSessionId: retryRes.value.fleet.activeSessionId,
              });
            }
          } else {
            const res = await host.request<LocalInspectResult>("local.inspect", {});
            if (res.ok) {
              dispatch({ type: "APPLY_LOCAL_INSPECTION", inspection: res.value });
              dispatch({ type: "ANNOUNCE", message: res.value.cli.displayName });
            }
          }
          break;
        }
        case "open_status":
        case "open_diagnostics": {
          const res = await host.request<SanitizedDiagnosticsPayload>("local.diagnose", {});
          if (res.ok) {
            dispatch({ type: "APPLY_DIAGNOSTICS_REPORT", report: res.value });
            dispatch({ type: "OPEN_SURFACE", surface: "diagnostics" });
          }
          break;
        }
        case "switch_profile":
          dispatch({ type: "OPEN_SURFACE", surface: "scopePopover" });
          break;
      }
    } finally {
      setLocalBusy(false);
    }
  }, []);

  const isMockMode = state.appInfo?.mode === "mock";

  return (
    <>
      <div ref={shellRef} className="app-window">
        <a
          href="#composer-input"
          className="skip-link"
          onClick={(event) => {
            event.preventDefault();
            composerRef.current?.focus();
          }}
        >
          {getCopy("skip.toComposer")}
        </a>

        <header className="window-titlebar">
          <div className="window-title">
            <HermesMark size={14} />
            <span>HERMES DESKTOP</span>
            <span className="window-title-sub">{getCopy("app.subtitle")}</span>
          </div>
          <div className="window-meta">
            <button
              type="button"
              className="route-chip"
              onClick={() => dispatch({ type: "OPEN_SURFACE", surface: "palette" })}
            >
              <Command size={12} aria-hidden="true" />
              <span>{getCopy("palette.title")}</span>
              <kbd className="kbd">⌘K</kbd>
            </button>
          </div>
        </header>

        <div className="app-shell">
          {viewportMode === "rail" && (
            <nav className="sidebar" aria-label={getCopy("nav.sessionsLandmark")}>
              <div className="sidebar-head">
                <span className="sidebar-title">{getCopy("nav.sessionsTab")}</span>
                <span className="sidebar-count">{scopedSessions.length}</span>
              </div>

              <button
                type="button"
                className="sidebar-new-btn"
                disabled={hasReadyConnection ? !canCreateSession : false}
                onClick={() => handleAppCommand({ type: "new_session" })}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Plus size={13} aria-hidden="true" />
                  {getCopy("nav.newSession")}
                </span>
                <kbd className="kbd">⌘N</kbd>
              </button>

              <SessionRailList
                hasReadyConnection={hasReadyConnection}
                sessions={scopedSessions}
                activeSessionId={state.activeSessionId}
                onSelectSession={(s) => void handleSelectSession(s)}
              />

              <div className="sidebar-footer">
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ width: "100%", justifyContent: "space-between" }}
                  onClick={() => dispatch({ type: "OPEN_SURFACE", surface: "settings" })}
                >
                  <span>{getCopy("nav.openScopeSettings")}</span>
                  <Settings2 size={13} aria-hidden="true" />
                </button>
              </div>
            </nav>
          )}

          <main id="main-content" className="main-column">
            <div className="route-strip">
              {viewportMode === "popover" && (
                <button
                  type="button"
                  className="route-chip"
                  onClick={() =>
                    dispatch({ type: "OPEN_SURFACE", surface: "sessionsPopover" })
                  }
                >
                  <span>
                    {getCopy("nav.sessionsCount")} {scopedSessions.length}
                  </span>
                </button>
              )}

              <div className="route-chain" aria-label="当前路由上下文">
                <span>{getCopy("route.you")}</span>
                <span className="route-arrow" aria-hidden="true">
                  →
                </span>
                <span>
                  {activeConnection ? activeConnection.label : getCopy("route.unconnectedGateway")}
                </span>
                <span className="route-arrow" aria-hidden="true">
                  →
                </span>
                <span>
                  {activeProfile
                    ? activeProfile.displayName
                    : activeConnection && effectiveScope?.profileId
                      ? effectiveScope.profileId
                      : getCopy("route.noProfile")}
                </span>
                {activeConnection && (
                  <span className="gateway-kind-tag">{activeConnection.kind}</span>
                )}
              </div>

              <button
                type="button"
                className="route-chip"
                onClick={() => dispatch({ type: "OPEN_SURFACE", surface: "scopePopover" })}
              >
                <span
                  className={[
                    "status-dot",
                    activeConnection ? `is-${activeConnection.actual}` : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-hidden="true"
                />
                <span>
                  {activeConnection
                    ? activeConnection.actual === "ready"
                      ? getCopy("route.statusReady")
                      : activeConnection.actual === "connecting"
                        ? getCopy("route.statusConnecting")
                        : activeConnection.actual === "reconnecting"
                          ? getCopy("route.statusReconnecting")
                          : getCopy("route.statusBlocked")
                    : getCopy("route.statusUnconnected")}
                </span>
              </button>

              <div className="route-actions">
                <button
                  type="button"
                  className="route-chip"
                  onClick={() =>
                    dispatch({ type: "OPEN_SURFACE", surface: "capabilities" })
                  }
                >
                  {getCopy("route.openCapabilities")}
                </button>
                <button
                  type="button"
                  className="route-chip"
                  aria-expanded={state.workspace.mode === "open"}
                  onClick={() => dispatch({ type: "TOGGLE_WORKSPACE" })}
                >
                  <PanelRight size={13} aria-hidden="true" />
                  <span>Workspace</span>
                  <kbd className="kbd">⌘B</kbd>
                </button>
              </div>
            </div>

            <div className="thread-viewport">
              <ChatThread
                hasReadyConnection={hasReadyConnection}
                transcript={state.transcript}
                localInspection={state.localInspection}
                localBusy={localBusy}
                chatBusy={state.chatBusy}
                composerDraft={composerDraft}
                stopError={state.stopError}
                canCreateSession={canCreateSession}
                composerRef={composerRef}
                onDraftChange={setComposerDraft}
                onSendPrompt={() => void handleSendPrompt()}
                onStopTurn={() => void handleStopTurn()}
                onCreateSession={() => void handleCreateSession()}
                onLocalAction={(action) => void handleLocalAction(action)}
                onOpenSettings={() =>
                  dispatch({ type: "OPEN_SURFACE", surface: "settings" })
                }
                onOpenPalette={() =>
                  dispatch({ type: "OPEN_SURFACE", surface: "palette" })
                }
                onOpenShortcuts={() =>
                  dispatch({ type: "OPEN_SURFACE", surface: "shortcuts" })
                }
                onOpenRemoteEscape={() =>
                  dispatch({ type: "OPEN_SURFACE", surface: "remoteEscape" })
                }
              />
            </div>
          </main>

          {state.workspace.mode === "open" && (
            <aside className="workspace-drawer" aria-label={getCopy("workspace.title")}>
              <div className="workspace-header">
                <strong>{getCopy("workspace.title")}</strong>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      dispatch({ type: "SET_WORKSPACE_MODE", mode: "hidden" })
                    }
                  >
                    {getCopy("workspace.hide")}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      dispatch({ type: "SET_WORKSPACE_MODE", mode: "closed" })
                    }
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
                    aria-selected={state.workspace.activeTab === tab.id}
                    className={[
                      "workspace-tab",
                      state.workspace.activeTab === tab.id && "is-active",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => dispatch({ type: "SET_WORKSPACE_TAB", tab: tab.id })}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="workspace-empty">{getCopy("workspace.emptyBody")}</div>
            </aside>
          )}
        </div>

        <footer className="status-footer">
          <span>{getCopy("status.footer")}</span>
          <span>
            {isMockMode ? getCopy("status.modeMock") : getCopy("status.modeElectron")}
          </span>
          <span>{getCopy("route.capabilitiesBadge")}</span>
        </footer>

        <div className="sr-only" aria-live="polite" role="status">
          {state.liveAnnouncement}
        </div>
      </div>

      {/* Modal surfaces live outside the inert app shell */}
      <FocusDialog
        open={state.surfaceStack.includes("palette")}
        title={getCopy("palette.title")}
        closeLabel={getCopy("shortcuts.close")}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "palette" })}
      >
        <label htmlFor="palette-search-input" className="sr-only">
          {getCopy("palette.placeholder")}
        </label>
        <input
          id="palette-search-input"
          className="palette-search"
          value={paletteQuery}
          onChange={(event) => setPaletteQuery(event.target.value)}
          placeholder={getCopy("palette.placeholder")}
        />
        {filteredCommands.length === 0 ? (
          <p>{getCopy("palette.empty")}</p>
        ) : (
          filteredCommands.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              className="palette-item"
              onClick={cmd.run}
            >
              <span>
                <strong>{cmd.label}</strong>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>
                  {cmd.hint}
                </span>
              </span>
              {cmd.shortcut && <kbd className="kbd">{cmd.shortcut}</kbd>}
            </button>
          ))
        )}
      </FocusDialog>

      <FocusDialog
        open={state.surfaceStack.includes("settings")}
        title={getCopy("settings.title")}
        description={getCopy("settings.description")}
        closeLabel={getCopy("settings.close")}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "settings" })}
      >
        <GatewaysSettings
          snapshot={registrySnapshot}
          fleetConnections={state.connections}
          onSnapshotChange={setRegistrySnapshot}
          onAnnounce={(message) => dispatch({ type: "ANNOUNCE", message })}
        />

        <section className="settings-section" aria-label={getCopy("settings.aboutTitle")}>
          <h3 className="settings-section-title">{getCopy("settings.aboutTitle")}</h3>
          {state.appInfo && (() => {
            const display = formatAppInfoDisplay(state.appInfo);
            return (
              <div className="settings-about-card">
                <p className="settings-about-headline">{display.headline}</p>
                <p className="settings-about-meta">{display.buildLine}</p>
                <p className="settings-about-meta">{display.runtimeLine}</p>
              </div>
            );
          })()}
        </section>

        <section className="settings-section" aria-label={getCopy("settings.updatesTitle")}>
          <h3 className="settings-section-title">{getCopy("settings.updatesTitle")}</h3>
          <p className="settings-section-body">{getCopy("settings.updatesNotice")}</p>
        </section>
      </FocusDialog>

      <FocusDialog
        open={state.surfaceStack.includes("capabilities")}
        title={getCopy("capabilities.title")}
        description={getCopy("capabilities.summary")}
        closeLabel={getCopy("capabilities.close")}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "capabilities" })}
      >
        <p>{getCopy("empty.body")}</p>
        <div className="deferred-footnote">{getCopy("capabilities.deferredFootnote")}</div>
      </FocusDialog>

      <FocusDialog
        open={state.surfaceStack.includes("shortcuts")}
        title={getCopy("shortcuts.title")}
        description={getCopy("shortcuts.description")}
        closeLabel={getCopy("shortcuts.close")}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "shortcuts" })}
      >
        <div className="shortcut-row">
          <span>{getCopy("palette.title")}</span>
          <kbd className="kbd">⌘K</kbd>
        </div>
        <div className="shortcut-row">
          <span>{getCopy("settings.title")}</span>
          <kbd className="kbd">⌘,</kbd>
        </div>
        <div className="shortcut-row">
          <span>{getCopy("palette.cmdWorkspace")}</span>
          <kbd className="kbd">⌘B</kbd>
        </div>
        <div className="shortcut-row">
          <span>{getCopy("nav.newSession")}</span>
          <kbd className="kbd">⌘N</kbd>
        </div>
        <div className="shortcut-row">
          <span>{getCopy("shortcuts.title")}</span>
          <kbd className="kbd">⌘?</kbd>
        </div>
      </FocusDialog>

      <FocusDialog
        open={state.surfaceStack.includes("sessionsPopover")}
        title={getCopy("popover.sessionsTitle")}
        closeLabel={getCopy("popover.close")}
        className="is-popover"
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "sessionsPopover" })}
      >
        <SessionRailList
          hasReadyConnection={hasReadyConnection}
          sessions={scopedSessions}
          activeSessionId={state.activeSessionId}
          onSelectSession={(s) => void handleSelectSession(s)}
        />
      </FocusDialog>

      <FocusDialog
        open={state.surfaceStack.includes("scopePopover")}
        title={getCopy("scope.popoverTitle")}
        closeLabel={getCopy("scope.close")}
        className="is-popover"
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" })}
      >
        {scopedProfiles.length === 0 && state.connections.length === 0 ? (
          <p>{getCopy("scope.empty")}</p>
        ) : (
          <div className="scope-popover-body">
            {state.connections.length > 0 && (
              <section className="settings-section" aria-label={getCopy("scope.connectionSection")}>
                <h3 className="settings-section-title">{getCopy("scope.connectionSection")}</h3>
                <div className="scope-list">
                  {state.connections.map((conn) => {
                    const isCurrent = conn.connectionId === activeConnection?.connectionId;
                    return (
                      <button
                        key={conn.connectionId}
                        type="button"
                        className={["palette-item", isCurrent && "is-active-scope"]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={async () => {
                          dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" });
                          const res = await host.request<{
                            fleet?: FleetSnapshot;
                          }>("sessions.select", { connectionId: conn.connectionId });
                          if (res.ok && res.value.fleet) {
                            dispatch({
                              type: "APPLY_FLEET_SNAPSHOT",
                              connections: res.value.fleet.connections,
                              profiles: res.value.fleet.profiles,
                              sessions: res.value.fleet.sessions,
                              activeScope: res.value.fleet.activeScope,
                              activeSessionId: res.value.fleet.activeSessionId,
                            });
                          }
                          dispatch({ type: "ANNOUNCE", message: getCopy("scope.switchNotice") });
                        }}
                      >
                        <span>
                          <strong>{conn.label}</strong>
                          <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>
                            {conn.kind} · {conn.originDisplay}
                          </span>
                        </span>
                        {isCurrent && <span className="gateway-badge is-primary">Active</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            {scopedProfiles.length > 0 && (
              <section className="settings-section" aria-label={getCopy("scope.profileSection")}>
                <h3 className="settings-section-title">{getCopy("scope.profileSection")}</h3>
                <div className="scope-list">
                  {scopedProfiles.map((profile) => {
                    const isCurrent = profile.profileId === (effectiveScope?.profileId ?? "default");
                    return (
                      <button
                        key={`${profile.connectionId}:${profile.profileId}`}
                        type="button"
                        className={["palette-item", isCurrent && "is-active-scope"]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => void handleSelectProfile(profile.profileId)}
                      >
                        <span>
                          <strong>{profile.displayName}</strong>
                          <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>
                            @{profile.handle}
                          </span>
                        </span>
                        {isCurrent && <span className="gateway-badge is-primary">Active</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </FocusDialog>

      <DiagnosticsModal
        open={state.surfaceStack.includes("diagnostics")}
        report={state.diagnosticsReport}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "diagnostics" })}
        onCopied={() =>
          dispatch({ type: "ANNOUNCE", message: getCopy("diagnostics.copiedNotice") })
        }
      />

      <FocusDialog
        open={state.surfaceStack.includes("remoteEscape")}
        title={getCopy("local.remoteEscapeTitle")}
        description={getCopy("local.escapeRemoteSshHint")}
        closeLabel={getCopy("local.remoteEscapeClose")}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "remoteEscape" })}
      >
        <p>{getCopy("local.remoteEscapeBody")}</p>
        <div className="empty-relay-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              dispatch({ type: "CLOSE_SURFACE", surface: "remoteEscape" });
              dispatch({ type: "OPEN_SURFACE", surface: "settings" });
            }}
          >
            {getCopy("local.remoteEscapeAction")}
          </button>
        </div>
      </FocusDialog>
    </>
  );
}
