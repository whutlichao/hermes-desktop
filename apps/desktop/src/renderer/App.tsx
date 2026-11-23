import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Command,
  PanelRight,
  Plus,
  Settings2,
} from "lucide-react";
import {
  SETTINGS_SECTION_IDS,
  type AppCommand,
  type ApprovalChoice,
  type ApprovalRespondResult,
  type ApprovalTopicSnapshot,
  type ApprovalView,
  type ArtifactAnnotation,
  type BridgeScope,
  type CapabilityDomainId,
  type CapabilityEntry,
  type CapabilitySnapshot,
  type ChatSessionProjection,
  type FleetSnapshot,
  type GatewayConfigSnapshot,
  type GatewayConfigUpdateResult,
  type GatewayConfigValue,
  type LocalInspectResult,
  type LocalSafeActionId,
  type LocalSelectCliResult,
  type MissingSessionExport,
  type ProfileSummary,
  type RegistrySnapshotView,
  type SanitizedDiagnosticsPayload,
  type SessionSummary,
  type SessionTranscriptSnapshot,
  type WorkspaceAgentItem,
  type WorkspaceArtifactItem,
  type WorkspaceFileEntry,
  type WorkspaceGitDiffItem,
  type WorkspaceTab,
} from "@hermes/contracts";
import {
  FocusReturnController,
  HERMES_INSTALL_DOCS_URL,
  HERMES_UPDATE_DOCS_URL,
  addWorkspaceAnnotation,
  closeWorkspace,
  createInitialShellState,
  createInitialWorkspaceSessionState,
  createSequenceTracker,
  createTranscriptSyncController,
  deriveViewportMode,
  filterProfilesForConnection,
  filterSessionsForScope,
  formatAppInfoDisplay,
  getActiveChatWorkspaceView,
  getCopy,
  getTopmostSurface,
  hideWorkspace,
  markWorkspaceArtifactsExternalStale,
  markWorkspaceFilesExternalStale,
  openWorkspace,
  projectSettingsSectionFields,
  reconcileWorkspaceAgents,
  reconcileWorkspaceArtifacts,
  reconcileWorkspaceFiles,
  reconcileWorkspaceGitDiffs,
  resolveProfileManagementAvailability,
  resolveWorkspaceChatKey,
  selectWorkspaceAgent,
  selectWorkspaceArtifact,
  selectWorkspaceFile,
  selectWorkspaceFileLines,
  selectWorkspaceGitDiff,
  setWorkspaceActiveTab,
  setWorkspaceAgentSteerText,
  setWorkspaceAnnotations,
  setWorkspaceArtifactScroll,
  setWorkspaceArtifactZoom,
  shellReducer,
  switchWorkspaceContext,
  toggleWorkspaceDirectory,
  type CopyKey,
} from "@hermes/domain";
import { host } from "@hermes/host-adapter";
import { ApprovalInspectModal } from "./components/ApprovalInspectModal";
import { CapabilitiesDrawer } from "./components/CapabilitiesDrawer";
import { ChatThread } from "./components/ChatThread";
import { CommandPalette } from "./components/CommandPalette";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { GatewaysSettings } from "./components/GatewaysSettings";
import { HermesMark } from "./components/HermesMark";
import { FocusDialog } from "./components/Modal";
import { SessionRailList } from "./components/SessionRail";
import { WorkspaceDrawer } from "./components/WorkspaceDrawer";
import { createCapabilityHandlers } from "./components/capabilityHandlers";

export default function App() {
  const [state, dispatch] = useReducer(shellReducer, undefined, createInitialShellState);
  const [workspaceState, setWorkspaceState] = useState(() =>
    createInitialWorkspaceSessionState(null),
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");
  const [exportedMissing, setExportedMissing] = useState<MissingSessionExport | null>(null);
  const [fleetResyncNonce, setFleetResyncNonce] = useState(0);
  const [registrySnapshot, setRegistrySnapshot] = useState<RegistrySnapshotView | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<GatewayConfigSnapshot | null>(null);
  const [cancelledApprovalKey, setCancelledApprovalKey] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const railNewSessionRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const capabilitiesTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const sessionsPopoverTriggerRef = useRef<HTMLButtonElement>(null);
  const scopePopoverTriggerRef = useRef<HTMLButtonElement>(null);
  const trackerRef = useRef(createSequenceTracker());
  const registryTrackerRef = useRef(createSequenceTracker());
  const capabilitiesTrackerRef = useRef(createSequenceTracker());
  const chatStateTrackerRef = useRef(createSequenceTracker());
  const approvalTrackerRef = useRef(createSequenceTracker());
  const transcriptSyncRef = useRef(createTranscriptSyncController());
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const syncViewportWidth = () => {
      const next = window.innerWidth;
      setViewportWidth((prev) => (prev === next ? prev : next));
    };
    syncViewportWidth();
    window.addEventListener("resize", syncViewportWidth);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && document.documentElement) {
      observer = new ResizeObserver(syncViewportWidth);
      observer.observe(document.documentElement);
    }
    return () => {
      window.removeEventListener("resize", syncViewportWidth);
      observer?.disconnect();
    };
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

  const activeChatScope: BridgeScope | null = useMemo(() => {
    if (!effectiveScope) return null;
    return {
      connectionId: effectiveScope.connectionId,
      profileId: effectiveScope.profileId ?? "default",
      ...(state.activeSessionId ? { sessionId: state.activeSessionId } : {}),
    };
  }, [effectiveScope, state.activeSessionId]);

  const activeChatScopeRef = useRef<BridgeScope | null>(null);
  activeChatScopeRef.current = activeChatScope;

  const focusControllerRef = useRef<FocusReturnController<HTMLElement> | null>(null);
  if (!focusControllerRef.current) {
    focusControllerRef.current = new FocusReturnController<HTMLElement>({
      inspectNode: (node) => {
        if (!node) return null;
        const connected = document.contains(node);
        const isBody = node === document.body || node.tagName === "BODY";
        const disabled = (node as HTMLButtonElement | HTMLInputElement).disabled === true;
        const hidden =
          node.hidden ||
          node.getAttribute("aria-hidden") === "true" ||
          (connected && node.getClientRects().length === 0);
        const inert = Boolean(node.closest("[inert]"));
        return {
          connected,
          visible: !hidden,
          focusable: !disabled,
          inert,
          isBody,
        };
      },
      focusNode: (node) => {
        node.focus();
      },
      getActiveNode: () => (document.activeElement as HTMLElement | null) ?? null,
      getAnchorNode: (anchor) => {
        switch (anchor) {
          case "composer":
            return composerRef.current;
          case "railNewSession":
            return railNewSessionRef.current;
          case "paletteTrigger":
            return paletteTriggerRef.current;
          case "workspaceTrigger":
            return workspaceTriggerRef.current;
          case "settingsTrigger":
            return settingsTriggerRef.current;
          case "capabilitiesTrigger":
            return capabilitiesTriggerRef.current;
          case "sessionsPopoverTrigger":
            return sessionsPopoverTriggerRef.current;
          case "scopePopoverTrigger":
            return scopePopoverTriggerRef.current;
          default:
            return null;
        }
      },
      hasActiveChat: () => Boolean(activeChatScopeRef.current?.sessionId),
    });
  }

  const refreshWorkspaceData = useCallback(
    async (targetChatScope: BridgeScope | null) => {
      if (!targetChatScope?.connectionId) return;
      const scopeOnly: BridgeScope = {
        connectionId: targetChatScope.connectionId,
        profileId: targetChatScope.profileId ?? "default",
      };

      const filesPromise = host.request<{
        files?: WorkspaceFileEntry[];
        stale?: boolean;
        gitDiffs?: WorkspaceGitDiffItem[];
      }>("files.list", { profileId: scopeOnly.profileId }, scopeOnly);

      const artifactsPromise = targetChatScope.sessionId
        ? host.request<{
            artifacts?: WorkspaceArtifactItem[];
            stale?: boolean;
            agents?: WorkspaceAgentItem[];
          }>(
            "artifacts.list",
            {
              sessionId: targetChatScope.sessionId,
              profileId: targetChatScope.profileId ?? "default",
            },
            targetChatScope,
          )
        : Promise.resolve(null);

      const [filesRes, artifactsRes] = await Promise.all([filesPromise, artifactsPromise]);

      setWorkspaceState((prev) => {
        let next = switchWorkspaceContext(prev, targetChatScope);
        if (filesRes.ok) {
          next = reconcileWorkspaceFiles(next, scopeOnly, filesRes.value.files ?? []);
          if (filesRes.value.gitDiffs) {
            next = reconcileWorkspaceGitDiffs(next, scopeOnly, filesRes.value.gitDiffs);
          }
          if (filesRes.value.stale) {
            next = markWorkspaceFilesExternalStale(next, scopeOnly);
          }
        }
        if (artifactsRes && artifactsRes.ok) {
          next = reconcileWorkspaceArtifacts(
            next,
            targetChatScope,
            artifactsRes.value.artifacts ?? [],
          );
          if (artifactsRes.value.agents) {
            next = reconcileWorkspaceAgents(next, targetChatScope, artifactsRes.value.agents);
          }
          if (artifactsRes.value.stale) {
            next = markWorkspaceArtifactsExternalStale(next, targetChatScope);
          }
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    setWorkspaceState((prev) => switchWorkspaceContext(prev, activeChatScope));
    if (hasReadyConnection && activeChatScope) {
      void refreshWorkspaceData(activeChatScope);
    }
  }, [
    activeChatScope?.connectionId,
    activeChatScope?.profileId,
    activeChatScope?.sessionId,
    hasReadyConnection,
    refreshWorkspaceData,
  ]);

  // Hydrate persisted Draft annotations from chatState sessionSummaries
  useEffect(() => {
    if (!activeChatScope?.sessionId || !state.chatState) return;
    const chatKey = resolveWorkspaceChatKey(activeChatScope);
    const summary = state.chatState.sessionSummaries[chatKey];
    if (summary?.annotations) {
      setWorkspaceState((prev) =>
        setWorkspaceAnnotations(prev, summary.annotations ?? [], activeChatScope),
      );
    }
  }, [
    activeChatScope?.connectionId,
    activeChatScope?.profileId,
    activeChatScope?.sessionId,
    state.chatState,
  ]);

  const handleOpenWorkspace = useCallback(
    (tab?: WorkspaceTab) => {
      focusControllerRef.current?.register("workspace", {
        layer: "drawer",
        returnFocus:
          (document.activeElement as HTMLElement | null) ?? workspaceTriggerRef.current,
      });
      setWorkspaceState((prev) => openWorkspace(prev, tab));
      dispatch({ type: "SET_WORKSPACE_MODE", mode: "open" });
      if (tab) {
        dispatch({ type: "SET_WORKSPACE_TAB", tab });
      }
      if (activeChatScope) {
        void refreshWorkspaceData(activeChatScope);
      }
    },
    [activeChatScope, refreshWorkspaceData],
  );

  const handleHideWorkspace = useCallback(() => {
    setWorkspaceState((prev) => hideWorkspace(prev));
    dispatch({ type: "SET_WORKSPACE_MODE", mode: "hidden" });
    focusControllerRef.current?.closeSurface("workspace", "shortcut");
  }, []);

  const handleCloseWorkspace = useCallback(() => {
    setWorkspaceState((prev) => closeWorkspace(prev));
    dispatch({ type: "SET_WORKSPACE_MODE", mode: "closed" });
    focusControllerRef.current?.closeSurface("workspace", "explicit");
  }, []);

  const handleToggleWorkspace = useCallback(() => {
    if (state.workspace.mode === "open") {
      handleHideWorkspace();
    } else {
      handleOpenWorkspace();
    }
  }, [handleHideWorkspace, handleOpenWorkspace, state.workspace.mode]);

  const handleSelectWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setWorkspaceState((prev) => setWorkspaceActiveTab(prev, tab));
    dispatch({ type: "SET_WORKSPACE_TAB", tab });
  }, []);

  const handleAddWorkspaceAnnotation = useCallback(
    (input: { xPct: number; yPct: number; comment: string }) => {
      let nextAnnotationsToSave: ArtifactAnnotation[] | null = null;
      setWorkspaceState((prev) => {
        const chatView = getActiveChatWorkspaceView(prev);
        const selected =
          chatView.artifacts.find((a) => a.artifactId === chatView.selectedArtifactId) ??
          chatView.artifacts[0] ??
          null;
        if (!selected) return prev;
        const annotation: ArtifactAnnotation = {
          annotationId: `ann-${Date.now()}-${chatView.annotations.length + 1}`,
          artifactId: selected.artifactId,
          artifactVersion: selected.version,
          artifactHash: selected.hash,
          xPct: input.xPct,
          yPct: input.yPct,
          comment: input.comment,
          createdAt: new Date().toISOString(),
        };
        const updated = addWorkspaceAnnotation(prev, annotation, activeChatScope);
        nextAnnotationsToSave = getActiveChatWorkspaceView(updated).annotations;
        return updated;
      });

      if (activeChatScope?.sessionId && nextAnnotationsToSave) {
        void host.request(
          "chatState.saveDraft",
          {
            sessionId: activeChatScope.sessionId,
            profileId: activeChatScope.profileId ?? "default",
            text: composerDraft,
            annotations: nextAnnotationsToSave,
          },
          activeChatScope,
        );
      }
    },
    [activeChatScope, composerDraft],
  );

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
      const applied = transcriptSyncRef.current.applySnapshot(
        res.value.transcript,
        res.value.transcript.snapshotSeq ?? 0,
        { replace: true, resynced: res.value.transcript.resynced },
      );
      dispatch({ type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: applied.snapshot });
    }
    setExportedMissing(null);
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
      setExportedMissing(null);
      const res = await host.request<{ transcript?: SessionTranscriptSnapshot }>(
        "sessions.select",
        { sessionId: session.sessionId, profileId: session.profileId },
        targetScope,
      );
      if (res.ok && res.value.transcript) {
        const applied = transcriptSyncRef.current.applySnapshot(
          res.value.transcript,
          res.value.transcript.snapshotSeq ?? 0,
          { replace: true, resynced: res.value.transcript.resynced },
        );
        dispatch({ type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: applied.snapshot });
      }
      if (state.surfaceStack.includes("sessionsPopover")) {
        dispatch({ type: "CLOSE_SURFACE", surface: "sessionsPopover" });
      }
    },
    [state.surfaceStack],
  );

  const handleDraftChange = useCallback(
    (nextDraft: string) => {
      setComposerDraft(nextDraft);
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
      }
      if (
        !hasReadyConnection ||
        !effectiveScope ||
        !state.activeSessionId ||
        state.chatState?.activeStatus === "session_missing"
      ) {
        return;
      }
      const targetScope: BridgeScope = {
        connectionId: effectiveScope.connectionId,
        profileId: effectiveScope.profileId ?? "default",
        sessionId: state.activeSessionId,
      };
      draftSaveTimerRef.current = setTimeout(() => {
        void host.request(
          "chatState.saveDraft",
          {
            sessionId: targetScope.sessionId,
            profileId: targetScope.profileId,
            text: nextDraft,
          },
          targetScope,
        );
      }, 150);
    },
    [effectiveScope, hasReadyConnection, state.activeSessionId, state.chatState?.activeStatus],
  );

  const handleDismissRouteBanner = useCallback(async () => {
    const res = await host.request<ChatSessionProjection>("chatState.dismissRouteBanner", {});
    if (res.ok) {
      dispatch({ type: "APPLY_CHAT_STATE", chatState: res.value });
    }
  }, []);

  const handleExportMissingSession = useCallback(async () => {
    const missing = state.chatState?.missingSession;
    const scope: BridgeScope | null = missing
      ? {
          connectionId: missing.connectionId,
          profileId: missing.profileId,
          sessionId: missing.sessionId,
        }
      : effectiveScope;
    const res = await host.request<MissingSessionExport | null>(
      "chatState.exportMissingSession",
      {},
      scope,
    );
    if (res.ok && res.value) {
      setExportedMissing(res.value);
      dispatch({ type: "ANNOUNCE", message: getCopy("chat.sessionMissingExportedNotice") });
    }
  }, [effectiveScope, state.chatState?.missingSession]);

  const handleDismissMissingSession = useCallback(async () => {
    const res = await host.request<ChatSessionProjection>("chatState.dismissMissingSession", {});
    if (res.ok) {
      setExportedMissing(null);
      dispatch({ type: "APPLY_CHAT_STATE", chatState: res.value });
    }
  }, []);

  const handleSelectProfile = useCallback(
    async (profileId: string) => {
      if (!effectiveScope) return;
      const targetScope: BridgeScope = {
        connectionId: effectiveScope.connectionId,
        profileId,
      };
      const res = await host.request<{
        ok?: boolean;
        fleet?: FleetSnapshot;
        transcript?: SessionTranscriptSnapshot | null;
      }>("scopes.switch", { connectionId: effectiveScope.connectionId, profileId }, targetScope);
      if (res.ok && res.value.fleet) {
        const fleet = res.value.fleet;
        dispatch({
          type: "APPLY_FLEET_SNAPSHOT",
          connections: fleet.connections,
          profiles: fleet.profiles,
          sessions: fleet.sessions,
          activeScope: fleet.activeScope,
          activeSessionId: fleet.activeSessionId,
        });
        if (res.value.transcript) {
          const applied = transcriptSyncRef.current.applySnapshot(
            res.value.transcript,
            res.value.transcript.snapshotSeq ?? 0,
            { replace: true, resynced: res.value.transcript.resynced },
          );
          dispatch({
            type: "REPLACE_TRANSCRIPT_SNAPSHOT",
            snapshot: applied.snapshot,
          });
        }
      }
      dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" });
      dispatch({ type: "ANNOUNCE", message: getCopy("scope.switchNotice") });
    },
    [effectiveScope],
  );

  const handleRefreshProfiles = useCallback(async () => {
    if (!effectiveScope) return;
    const res = await host.request<{ profiles?: ProfileSummary[] }>(
      "profiles.list",
      { connectionId: effectiveScope.connectionId },
      effectiveScope,
    );
    if (res.ok && Array.isArray(res.value.profiles)) {
      const otherProfiles = state.profiles.filter(
        (p) => p.connectionId !== effectiveScope.connectionId,
      );
      dispatch({
        type: "APPLY_FLEET_SNAPSHOT",
        connections: state.connections,
        profiles: [...otherProfiles, ...res.value.profiles],
        sessions: state.sessions,
        activeScope: state.activeScope,
        activeSessionId: state.activeSessionId,
      });
      dispatch({ type: "ANNOUNCE", message: getCopy("scope.profileRefreshedNotice") });
    }
  }, [effectiveScope, state.activeScope, state.activeSessionId, state.connections, state.profiles, state.sessions]);

  const handleUpdateConfigKey = useCallback(
    async (key: string, value: GatewayConfigValue) => {
      const res = await host.request<GatewayConfigUpdateResult>(
        "config.update",
        { key, value },
        effectiveScope,
      );
      if (res.ok && res.value.snapshot) {
        setConfigSnapshot(res.value.snapshot);
        dispatch({ type: "ANNOUNCE", message: getCopy("settings.configSavedNotice") });
      }
    },
    [effectiveScope],
  );

  const isScopePopoverOpen = state.surfaceStack.includes("scopePopover");
  const isSettingsOpen = state.surfaceStack.includes("settings");
  const profileDomainProbed = Boolean(
    state.capabilities.domains.find((d) => d.domain === "profile")?.probed,
  );

  useEffect(() => {
    if (!isScopePopoverOpen || !hasReadyConnection || profileDomainProbed) return;
    let active = true;
    void host
      .request<CapabilitySnapshot>("capabilities.describe", { domain: "profile" }, effectiveScope)
      .then((res) => {
        if (active && res.ok) {
          dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
        }
      });
    return () => {
      active = false;
    };
  }, [effectiveScope, hasReadyConnection, isScopePopoverOpen, profileDomainProbed]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    let active = true;
    void host
      .request<GatewayConfigSnapshot>("config.get", {}, effectiveScope)
      .then((res) => {
        if (active && res.ok) {
          setConfigSnapshot(res.value);
        }
      });
    return () => {
      active = false;
    };
  }, [effectiveScope, isSettingsOpen]);

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
        if (draftSaveTimerRef.current) {
          clearTimeout(draftSaveTimerRef.current);
          draftSaveTimerRef.current = null;
        }
        void host.request(
          "chatState.saveDraft",
          { sessionId: targetSessionId, profileId: targetScope.profileId, text: "" },
          targetScope,
        );
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

  const handleRespondApproval = useCallback(
    async (approval: ApprovalView, choice: ApprovalChoice) => {
      setCancelledApprovalKey((prev) => (prev === approval.approvalKey ? null : prev));
      const res = await host.request<ApprovalRespondResult>("approvals.respond", {
        approvalKey: approval.approvalKey,
        choice,
      });
      if (!res.ok) {
        dispatch({ type: "ANNOUNCE", message: res.error.message });
        return;
      }
      if (res.value.status === "cancelled_pending") {
        setCancelledApprovalKey(approval.approvalKey);
        dispatch({ type: "ANNOUNCE", message: getCopy("approval.cancelledPendingNotice") });
      } else if (res.value.approval) {
        dispatch({
          type: "ANNOUNCE",
          message: getCopy(`approval.state.${res.value.approval.state}` as CopyKey),
        });
      }
    },
    [],
  );

  const handleDismissOrphanedApproval = useCallback(async (approval: ApprovalView) => {
    const res = await host.request<ApprovalTopicSnapshot>("approvals.dismissOrphaned", {
      approvalKey: approval.approvalKey,
    });
    if (res.ok) {
      dispatch({ type: "APPLY_APPROVAL_SNAPSHOT", snapshot: res.value });
    }
  }, []);

  const handleInspectApproval = useCallback((approval: ApprovalView) => {
    dispatch({ type: "OPEN_APPROVAL_INSPECT", approvalKey: approval.approvalKey });
  }, []);

  const inspectedApproval = useMemo(
    () =>
      state.surfaceStack.includes("approvalInspect") && state.inspectedApprovalKey
        ? state.approvals.approvals.find((a) => a.approvalKey === state.inspectedApprovalKey) ?? null
        : null,
    [state.approvals.approvals, state.inspectedApprovalKey, state.surfaceStack],
  );

  useEffect(() => {
    if (state.surfaceStack.includes("approvalInspect") && !inspectedApproval) {
      dispatch({ type: "CLOSE_APPROVAL_INSPECT" });
    }
  }, [inspectedApproval, state.surfaceStack]);

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
          handleToggleWorkspace();
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
          break;
        case "focus_scope": {
          const target = command.scope;
          void host
            .request<{
              ok?: boolean;
              fleet?: FleetSnapshot;
              transcript?: SessionTranscriptSnapshot | null;
            }>(
              "scopes.switch",
              {
                connectionId: target.connectionId,
                ...(target.profileId ? { profileId: target.profileId } : {}),
                ...(target.sessionId ? { sessionId: target.sessionId } : {}),
              },
              target,
            )
            .then((res) => {
              if (!res.ok) return;
              if (res.value.fleet) {
                dispatch({
                  type: "APPLY_FLEET_SNAPSHOT",
                  connections: res.value.fleet.connections,
                  profiles: res.value.fleet.profiles,
                  sessions: res.value.fleet.sessions,
                  activeScope: res.value.fleet.activeScope,
                  activeSessionId: res.value.fleet.activeSessionId,
                });
              }
              if (res.value.transcript) {
                const applied = transcriptSyncRef.current.applySnapshot(
                  res.value.transcript,
                  res.value.transcript.snapshotSeq ?? 0,
                  { replace: true, resynced: res.value.transcript.resynced },
                );
                dispatch({ type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: applied.snapshot });
              }
              dispatch({ type: "ANNOUNCE", message: getCopy("scope.switchNotice") });
            });
          break;
        }
      }
    },
    [handleCreateSession, handleToggleWorkspace],
  );

  const handleAppCommandRef = useRef(handleAppCommand);
  handleAppCommandRef.current = handleAppCommand;

  // HostBridge bootstrap: hello -> chatState.get + local.inspect + fleet/chat.state/registry/capabilities subscriptions + commands
  useEffect(() => {
    let active = true;
    void host.request("bridge.hello", {}).then((res) => {
      if (!active || !res.ok) return;
      dispatch({ type: "HYDRATE_HELLO", appInfo: res.value as NonNullable<typeof state.appInfo> });
      void host.request<ChatSessionProjection>("chatState.get", {}).then((chatRes) => {
        if (!active || !chatRes.ok) return;
        dispatch({ type: "APPLY_CHAT_STATE", chatState: chatRes.value });
      });
    });

    void host.request<LocalInspectResult>("local.inspect", {}).then((res) => {
      if (!active || !res.ok) return;
      dispatch({ type: "APPLY_LOCAL_INSPECTION", inspection: res.value });
    });

    void host.request<CapabilitySnapshot>("capabilities.describe", {}).then((res) => {
      if (!active || !res.ok) return;
      dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
    });

    void host.request<ApprovalTopicSnapshot>("approvals.list", {}).then((res) => {
      if (!active || !res.ok) return;
      dispatch({ type: "APPLY_APPROVAL_SNAPSHOT", snapshot: res.value });
    });

    const unsubApproval = host.subscribe("approval", null, (event) => {
      const accepted = approvalTrackerRef.current.accept(event);
      if (accepted.status === "resync_required") {
        approvalTrackerRef.current.reset();
        void host.request<ApprovalTopicSnapshot>("approvals.list", {}).then((res) => {
          if (active && res.ok) {
            dispatch({ type: "APPLY_APPROVAL_SNAPSHOT", snapshot: res.value });
          }
        });
        return;
      }
      if (accepted.status === "applied") {
        dispatch({
          type: "APPLY_APPROVAL_SNAPSHOT",
          snapshot: event.payload as ApprovalTopicSnapshot,
        });
      }
    });

    const unsubChatState = host.subscribe("chat.state", null, (event) => {
      const accepted = chatStateTrackerRef.current.accept(event);
      if (accepted.status === "resync_required") {
        chatStateTrackerRef.current.reset();
      }
      if (accepted.status === "applied" || accepted.status === "resync_required") {
        dispatch({ type: "APPLY_CHAT_STATE", chatState: event.payload as ChatSessionProjection });
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

    const unsubCapabilities = host.subscribe("capabilities", null, (event) => {
      const accepted = capabilitiesTrackerRef.current.accept(event);
      if (accepted.status === "resync_required") {
        capabilitiesTrackerRef.current.reset();
        void host.request<CapabilitySnapshot>("capabilities.describe", {}).then((res) => {
          if (active && res.ok) {
            dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
          }
        });
        return;
      }
      if (accepted.status === "applied") {
        dispatch({
          type: "APPLY_CAPABILITIES_SNAPSHOT",
          snapshot: event.payload as CapabilitySnapshot,
        });
      }
    });

    const unsubCmd = host.onCommand((cmd) => handleAppCommandRef.current(cmd));
    return () => {
      active = false;
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
      }
      unsubChatState();
      unsubRegistry();
      unsubCapabilities();
      unsubApproval();
      unsubCmd();
    };
  }, []);

  // Subscribe to fleet snapshots/patches with sequence verification & resync recovery
  useEffect(() => {
    trackerRef.current.reset();
    const unsubFleet = host.subscribe("fleet", null, (event) => {
      const accepted = trackerRef.current.accept(event);
      if (accepted.status === "resync_required") {
        trackerRef.current.reset();
        setFleetResyncNonce((n) => n + 1);
        return;
      }
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
    return () => {
      unsubFleet();
    };
  }, [fleetResyncNonce]);

  // Subscribe to active session transcript stream with snapshot-before-patch discipline & gap/resync replacement
  useEffect(() => {
    const scope = state.activeScope;
    const sessionId = state.activeSessionId;
    if (!hasReadyConnection || !scope || !sessionId || state.chatState?.activeStatus === "session_missing") {
      transcriptSyncRef.current.reset();
      dispatch({ type: "CLEAR_TRANSCRIPT" });
      return;
    }
    const targetScope: BridgeScope = {
      connectionId: scope.connectionId,
      profileId: scope.profileId ?? "default",
      sessionId,
    };
    const currentSync = transcriptSyncRef.current.getSnapshot();
    if (
      !currentSync ||
      currentSync.connectionId !== targetScope.connectionId ||
      currentSync.profileId !== targetScope.profileId ||
      currentSync.sessionId !== targetScope.sessionId
    ) {
      transcriptSyncRef.current.reset();
    }

    let active = true;
    let resyncInFlight = false;
    const unsubTranscript = host.subscribe("session.transcript", targetScope, (event) => {
      if (!active) return;
      const accepted = transcriptSyncRef.current.acceptEvent(event);
      if (accepted.status === "applied") {
        dispatch({ type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: accepted.snapshot });
        return;
      }
      if (accepted.status === "resync_required" && !resyncInFlight) {
        resyncInFlight = true;
        void host
          .request<{ transcript?: SessionTranscriptSnapshot }>(
            "sessions.resume",
            { sessionId, profileId: targetScope.profileId, resync: true },
            targetScope,
          )
          .then((res) => {
            resyncInFlight = false;
            if (!active || !res.ok || !res.value.transcript) return;
            const applied = transcriptSyncRef.current.applySnapshot(
              res.value.transcript,
              res.value.transcript.snapshotSeq ?? 0,
              { replace: true, resynced: true },
            );
            dispatch({ type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: applied.snapshot });
            dispatch({ type: "ANNOUNCE", message: getCopy("chat.resyncedNotice") });
          });
      }
    });
    return () => {
      active = false;
      unsubTranscript();
    };
  }, [
    hasReadyConnection,
    state.activeScope?.connectionId,
    state.activeScope?.profileId,
    state.activeSessionId,
    state.chatState?.activeStatus,
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
          handleHideWorkspace();
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

  const handleProbeDomain = useCallback(
    async (domain: CapabilityDomainId) => {
      dispatch({ type: "ANNOUNCE", message: getCopy("capabilities.probing") });
      const res = await host.request<CapabilitySnapshot>(
        "capabilities.describe",
        { domain },
        effectiveScope,
      );
      if (res.ok) {
        dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
      }
    },
    [effectiveScope],
  );

  const capabilityHandlers = useMemo(
    () =>
      createCapabilityHandlers({
        focusComposer: () => {
          composerRef.current?.focus();
        },
        stopTurn: handleStopTurn,
        inspectApproval: async (_entry: CapabilityEntry) => {
          await handleProbeDomain("approval");
          dispatch({ type: "OPEN_SURFACE", surface: "capabilities" });
        },
        createSession: handleCreateSession,
        openSessions: () => {
          if (viewportMode === "popover") {
            dispatch({ type: "OPEN_SURFACE", surface: "sessionsPopover" });
          } else {
            dispatch({ type: "ANNOUNCE", message: getCopy("nav.sessionsTab") });
          }
        },
        resumeActiveSession: async () => {
          const firstSession = scopedSessions[0];
          if (firstSession) {
            await handleSelectSession(firstSession);
          } else {
            dispatch({ type: "ANNOUNCE", message: getCopy("nav.sessionsEmptyTitle") });
          }
        },
        copyCli: async (entry: CapabilityEntry) => {
          const cmd = entry.deepLink?.cliCommand;
          if (cmd && navigator.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(cmd);
            } catch {
              // Ignore clipboard rejection in restricted contexts
            }
          }
          dispatch({
            type: "ANNOUNCE",
            message: cmd ? `${getCopy("capabilities.copiedCliNotice")}: ${cmd}` : getCopy("capabilities.copiedCliNotice"),
          });
        },
        openWorkspaceTab: (tab) => {
          handleOpenWorkspace(tab);
        },
        toggleWorkspace: () => {
          handleToggleWorkspace();
        },
        openSettings: () => {
          handleAppCommand({ type: "open_settings" });
        },
        openCapabilities: () => {
          dispatch({ type: "OPEN_SURFACE", surface: "capabilities" });
          dispatch({ type: "ANNOUNCE", message: getCopy("capabilities.title") });
        },
        openShortcuts: () => {
          handleAppCommand({ type: "open_shortcuts" });
        },
        openScopePopover: () => {
          dispatch({ type: "OPEN_SURFACE", surface: "scopePopover" });
        },
        probeDomain: handleProbeDomain,
      }),
    [
      handleAppCommand,
      handleCreateSession,
      handleProbeDomain,
      handleSelectSession,
      handleStopTurn,
      scopedSessions,
      viewportMode,
    ],
  );

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

  const handleAnnounce = useCallback((message: string) => {
    dispatch({ type: "ANNOUNCE", message });
  }, []);

  const handleRetryActiveConnection = useCallback(async () => {
    const cid = activeConnection?.connectionId ?? effectiveScope?.connectionId ?? "local";
    const retryRes = await host.request<{
      ok?: boolean;
      fleet?: FleetSnapshot;
      inspection?: LocalInspectResult;
    }>("connections.retry", {
      connectionId: cid,
      ...(effectiveScope?.profileId ? { profileId: effectiveScope.profileId } : {}),
    });
    if (retryRes.ok) {
      if (retryRes.value.inspection) {
        dispatch({ type: "APPLY_LOCAL_INSPECTION", inspection: retryRes.value.inspection });
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
      dispatch({ type: "ANNOUNCE", message: getCopy("gateways.retryConnectionAction") });
    }
  }, [activeConnection?.connectionId, effectiveScope?.connectionId, effectiveScope?.profileId]);

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
              ref={paletteTriggerRef}
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
                ref={railNewSessionRef}
                id="rail-new-session"
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
                activeScope={effectiveScope}
                supportedActions={state.transcript?.supportedActions ?? null}
                methodTiers={state.capabilities.methodTiers}
                onSelectSession={(s) => void handleSelectSession(s)}
                onCopyCliCommand={() =>
                  dispatch({ type: "ANNOUNCE", message: getCopy("session.cli.copiedNotice") })
                }
              />

              <div className="sidebar-footer">
                <button
                  ref={settingsTriggerRef}
                  id="rail-settings-gear"
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
                  ref={sessionsPopoverTriggerRef}
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
                  {activeConnection
                    ? activeConnection.label
                    : state.chatState?.lastKnownUnverified && state.chatState.lastActiveChat
                      ? state.chatState.lastActiveChat.connectionId
                      : getCopy("route.unconnectedGateway")}
                </span>
                <span className="route-arrow" aria-hidden="true">
                  →
                </span>
                <span>
                  {activeProfile
                    ? activeProfile.displayName
                    : activeConnection && effectiveScope?.profileId
                      ? effectiveScope.profileId
                      : state.chatState?.lastKnownUnverified && state.chatState.lastActiveChat
                        ? state.chatState.lastActiveChat.profileId
                        : getCopy("route.noProfile")}
                </span>
                {activeConnection && (
                  <span className="gateway-kind-tag">{activeConnection.kind}</span>
                )}
                {!hasReadyConnection && state.chatState?.lastKnownUnverified && (
                  <span className="status-pill is-warn">{getCopy("route.unverifiedBadge")}</span>
                )}
              </div>

              <button
                ref={scopePopoverTriggerRef}
                type="button"
                className="route-chip"
                onClick={() => dispatch({ type: "OPEN_SURFACE", surface: "scopePopover" })}
              >
                <span
                  className={[
                    "status-dot",
                    activeConnection
                      ? activeConnection.actual === "auth_required"
                        ? "is-blocked"
                        : `is-${activeConnection.actual}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-hidden="true"
                />
                <span>
                  {activeConnection
                    ? activeConnection.aggregateState === "suspended" ||
                      activeConnection.desired === "suspended"
                      ? getCopy("status.suspended")
                      : activeConnection.actual === "ready"
                        ? getCopy("route.statusReady")
                        : activeConnection.actual === "connecting"
                          ? getCopy("route.statusConnecting")
                          : activeConnection.actual === "reconnecting"
                            ? getCopy("route.statusReconnecting")
                            : activeConnection.actual === "auth_required"
                              ? getCopy("route.statusAuthRequired")
                              : activeConnection.actual === "idle"
                                ? getCopy("status.idle")
                                : activeConnection.actual === "stopping"
                                  ? getCopy("status.stopping")
                                  : getCopy("route.statusBlocked")
                    : getCopy("route.statusUnconnected")}
                </span>
              </button>

              {activeConnection && (
                <>
                  {(activeConnection.degraded ||
                    activeConnection.aggregateState === "degraded") && (
                    <span className="status-pill is-warn" data-testid="route-strip-degraded">
                      {getCopy("status.degraded")}
                    </span>
                  )}
                  <span className="route-health-meta" data-testid="route-strip-latency">
                    {typeof activeConnection.latencyMs === "number"
                      ? `${activeConnection.latencyMs}ms`
                      : getCopy("status.latencyUnknown")}
                  </span>
                  {typeof activeConnection.nextRetryAt === "number" && (
                    <span className="route-health-meta" data-testid="route-strip-next-retry">
                      {getCopy("status.nextRetryIn")}{" "}
                      {Math.max(1, Math.ceil((activeConnection.nextRetryAt - Date.now()) / 1000))}s
                    </span>
                  )}
                  {(activeConnection.profileExceptionCount ?? 0) > 0 && (
                    <span
                      className="status-pill is-warn"
                      data-testid="route-strip-profile-exceptions"
                    >
                      {activeConnection.profileExceptionCount} {getCopy("status.profileExceptions")}
                    </span>
                  )}
                  {activeConnection.message &&
                    (activeConnection.actual !== "ready" || activeConnection.degraded) && (
                      <span className="route-health-meta" data-testid="route-strip-error">
                        {activeConnection.message}
                      </span>
                    )}
                  {(activeConnection.actual === "reconnecting" ||
                    activeConnection.actual === "blocked" ||
                    activeConnection.degraded ||
                    typeof activeConnection.nextRetryAt === "number") && (
                    <button
                      type="button"
                      className="route-chip"
                      data-testid="route-strip-retry"
                      onClick={() => void handleRetryActiveConnection()}
                    >
                      {getCopy("gateways.retryConnectionAction")}
                    </button>
                  )}
                </>
              )}

              <div className="route-actions">
                <button
                  ref={capabilitiesTriggerRef}
                  type="button"
                  className="route-chip"
                  onClick={() =>
                    dispatch({ type: "OPEN_SURFACE", surface: "capabilities" })
                  }
                >
                  {getCopy("route.openCapabilities")}
                </button>
                <button
                  ref={workspaceTriggerRef}
                  type="button"
                  className="route-chip"
                  aria-expanded={state.workspace.mode === "open"}
                  onClick={() => handleToggleWorkspace()}
                >
                  <PanelRight size={13} aria-hidden="true" />
                  <span>Workspace</span>
                  <kbd className="kbd">⌘B</kbd>
                </button>
              </div>
            </div>

            {state.chatState?.routeBanner && (
              <div
                className="route-fallback-banner"
                role="region"
                aria-label={getCopy("route.bannerFallbackPrefix")}
              >
                <span className="route-fallback-text">
                  <strong>{getCopy("route.bannerFallbackPrefix")}：</strong>
                  <span>
                    {state.chatState.routeBanner.fromScope.connectionId} /{" "}
                    {state.chatState.routeBanner.fromScope.profileId} →{" "}
                    {state.chatState.routeBanner.toScope.connectionId} /{" "}
                    {state.chatState.routeBanner.toScope.profileId} ·{" "}
                    {getCopy(`route.bannerReason.${state.chatState.routeBanner.reason}`)}
                  </span>
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void handleDismissRouteBanner()}
                >
                  {getCopy("route.bannerDismiss")}
                </button>
              </div>
            )}

            <div className="thread-viewport">
              <ChatThread
                hasReadyConnection={hasReadyConnection}
                activeConnection={activeConnection}
                activeScope={state.activeScope}
                activeSessionId={state.activeSessionId}
                approvals={state.approvals}
                cancelledApprovalKey={cancelledApprovalKey}
                transcript={state.transcript}
                chatState={state.chatState}
                exportedMissing={exportedMissing}
                localInspection={state.localInspection}
                localBusy={localBusy}
                chatBusy={state.chatBusy}
                composerDraft={composerDraft}
                stopError={state.stopError}
                canCreateSession={canCreateSession}
                composerRef={composerRef}
                onDraftChange={handleDraftChange}
                onSendPrompt={() => void handleSendPrompt()}
                onStopTurn={() => void handleStopTurn()}
                onCreateSession={() => void handleCreateSession()}
                onExportMissingSession={() => void handleExportMissingSession()}
                onDismissMissingSession={() => void handleDismissMissingSession()}
                onLocalAction={(action) => void handleLocalAction(action)}
                onRespondApproval={(approval, choice) => void handleRespondApproval(approval, choice)}
                onInspectApproval={handleInspectApproval}
                onDismissOrphanedApproval={(approval) => void handleDismissOrphanedApproval(approval)}
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

          <WorkspaceDrawer
            workspaceState={workspaceState}
            onSelectTab={handleSelectWorkspaceTab}
            onHide={handleHideWorkspace}
            onClose={handleCloseWorkspace}
            onRefresh={() => void refreshWorkspaceData(activeChatScope)}
            onSelectArtifact={(artifactId) =>
              setWorkspaceState((prev) => selectWorkspaceArtifact(prev, artifactId))
            }
            onArtifactScroll={(scrollTop) =>
              setWorkspaceState((prev) => setWorkspaceArtifactScroll(prev, scrollTop))
            }
            onArtifactZoom={(zoom) =>
              setWorkspaceState((prev) => setWorkspaceArtifactZoom(prev, zoom))
            }
            onAddAnnotation={handleAddWorkspaceAnnotation}
            onToggleDir={(dirPath) =>
              setWorkspaceState((prev) => toggleWorkspaceDirectory(prev, dirPath))
            }
            onSelectFile={(filePath) =>
              setWorkspaceState((prev) => selectWorkspaceFile(prev, filePath))
            }
            onSelectFileLine={(line) =>
              setWorkspaceState((prev) =>
                selectWorkspaceFileLines(prev, { startLine: line, endLine: line }),
              )
            }
            onSelectGitDiff={(diffPath) =>
              setWorkspaceState((prev) => selectWorkspaceGitDiff(prev, diffPath))
            }
            onSelectAgent={(agentId) =>
              setWorkspaceState((prev) => selectWorkspaceAgent(prev, agentId))
            }
            onChangeSteerText={(text) =>
              setWorkspaceState((prev) => setWorkspaceAgentSteerText(prev, text))
            }
          />
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
      <CommandPalette
        open={state.surfaceStack.includes("palette")}
        query={paletteQuery}
        entries={state.capabilities.entries}
        countsSummary={getCopy("capabilities.countsLine")}
        handlers={capabilityHandlers}
        onQueryChange={setPaletteQuery}
        onClose={() => {
          setPaletteQuery("");
          dispatch({ type: "CLOSE_SURFACE", surface: "palette" });
        }}
        onAnnounce={(message) => dispatch({ type: "ANNOUNCE", message })}
      />

      <FocusDialog
        open={state.surfaceStack.includes("settings")}
        title={getCopy("settings.title")}
        description={getCopy("settings.description")}
        closeLabel={getCopy("settings.close")}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "settings" })}
      >
        <nav
          aria-label={getCopy("settings.navLabel")}
          className="settings-section-nav"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}
        >
          {SETTINGS_SECTION_IDS.map((secId) => (
            <span
              key={secId}
              className="gateway-badge"
              data-settings-nav={secId}
            >
              {getCopy(`settings.section.${secId}` as CopyKey)}
            </span>
          ))}
        </nav>

        <section
          className="settings-section"
          data-settings-section="gateways"
          aria-label={getCopy("settings.section.gateways")}
        >
          <GatewaysSettings
            snapshot={registrySnapshot}
            fleetConnections={state.connections}
            onSnapshotChange={setRegistrySnapshot}
            onAnnounce={handleAnnounce}
          />
        </section>

        {(["model", "workspace", "safety", "memory", "chat"] as const).map((secId) => {
          const sectionTitle = getCopy(`settings.section.${secId}` as CopyKey);
          const fields = projectSettingsSectionFields(secId, configSnapshot);
          return (
            <section
              key={secId}
              className="settings-section"
              data-settings-section={secId}
              aria-label={sectionTitle}
            >
              <h3 className="settings-section-title">{sectionTitle}</h3>
              {fields.length === 0 ? (
                <p className="settings-section-body">
                  {getCopy("settings.configUnsupportedNotice")}
                </p>
              ) : (
                <div className="gateway-form-grid" style={{ display: "grid", gap: 8 }}>
                  {fields.map((field) => {
                    const inputId = `settings-field-${field.key.replace(/\./g, "-")}`;
                    const labelText = getCopy(field.labelKey);
                    return (
                      <div key={field.key} className="form-field">
                        <label htmlFor={inputId} className="form-label">
                          {labelText}
                        </label>
                        {field.kind === "select" ? (
                          <select
                            id={inputId}
                            className="form-select"
                            value={String(field.value)}
                            disabled={field.readOnly}
                            onChange={(event) =>
                              void handleUpdateConfigKey(field.key, event.target.value)
                            }
                          >
                            {(field.options ?? []).map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={inputId}
                            type="checkbox"
                            checked={Boolean(field.value)}
                            disabled={field.readOnly}
                            onChange={(event) =>
                              void handleUpdateConfigKey(field.key, event.target.checked)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        <section
          className="settings-section"
          data-settings-section="updates"
          aria-label={getCopy("settings.updatesTitle")}
        >
          <h3 className="settings-section-title">{getCopy("settings.updatesTitle")}</h3>
          <p className="settings-section-body">{getCopy("settings.updatesNotice")}</p>
        </section>

        <section
          className="settings-section"
          data-settings-section="about"
          aria-label={getCopy("settings.aboutTitle")}
        >
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

        <section
          className="settings-section"
          data-settings-section="diagnostics"
          aria-label={getCopy("settings.section.diagnostics")}
        >
          <h3 className="settings-section-title">{getCopy("settings.section.diagnostics")}</h3>
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
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void handleLocalAction("open_diagnostics")}
            >
              {getCopy("settings.diagnosticsOpenModalAction")}
            </button>
          </div>
        </section>
      </FocusDialog>

      <CapabilitiesDrawer
        open={state.surfaceStack.includes("capabilities")}
        snapshot={state.capabilities}
        handlers={capabilityHandlers}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "capabilities" })}
      />

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
        className="is-popover sessions-popover"
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "sessionsPopover" })}
      >
        <SessionRailList
          hasReadyConnection={hasReadyConnection}
          sessions={scopedSessions}
          activeSessionId={state.activeSessionId}
          activeScope={effectiveScope}
          supportedActions={state.transcript?.supportedActions ?? null}
          methodTiers={state.capabilities.methodTiers}
          showNewChatButton
          canCreateSession={canCreateSession}
          onCreateSession={() => {
            dispatch({ type: "CLOSE_SURFACE", surface: "sessionsPopover" });
            void handleCreateSession();
          }}
          onSelectSession={(s) => void handleSelectSession(s)}
          onCopyCliCommand={() =>
            dispatch({ type: "ANNOUNCE", message: getCopy("session.cli.copiedNotice") })
          }
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
                    const isCurrent = conn.connectionId === effectiveScope?.connectionId;
                    return (
                      <button
                        key={conn.connectionId}
                        type="button"
                        className={["palette-item", isCurrent && "is-active-scope"]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => {
                          void host
                            .request<{ fleet?: FleetSnapshot } & Partial<FleetSnapshot>>(
                              "scopes.switch",
                              {
                                connectionId: conn.connectionId,
                              },
                            )
                            .then((res) => {
                              if (res.ok) {
                                const fleet = res.value.fleet ?? (res.value as FleetSnapshot);
                                if (fleet?.connections) {
                                  dispatch({
                                    type: "APPLY_FLEET_SNAPSHOT",
                                    connections: fleet.connections,
                                    profiles: fleet.profiles,
                                    sessions: fleet.sessions,
                                    activeScope: fleet.activeScope,
                                    activeSessionId: fleet.activeSessionId,
                                  });
                                }
                                dispatch({
                                  type: "ANNOUNCE",
                                  message: getCopy("scope.switchNotice"),
                                });
                              }
                            });
                          dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" });
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
                    const profileHealth =
                      profile.actual ?? (isCurrent && hasReadyConnection ? "ready" : "idle");
                    const healthCopyKey = (
                      profileHealth === "ready" ||
                      profileHealth === "connecting" ||
                      profileHealth === "reconnecting" ||
                      profileHealth === "blocked"
                        ? `scope.profileHealth.${profileHealth}`
                        : "scope.profileHealth.idle"
                    ) as CopyKey;
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
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {profile.isDefault && (
                            <span className="gateway-badge">
                              {getCopy("scope.profileDefaultBadge")}
                            </span>
                          )}
                          {profile.pinned && <span className="gateway-badge">Pinned</span>}
                          {(profile.isException ||
                            profile.actual === "blocked" ||
                            profile.degraded) && (
                            <span className="gateway-badge is-warning">
                              {profile.message ??
                                profile.unavailableCode ??
                                getCopy("status.degraded")}
                            </span>
                          )}
                          <span className="gateway-badge">{getCopy(healthCopyKey)}</span>
                          {isCurrent && <span className="gateway-badge is-primary">Active</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            {(() => {
              const profileAvail = resolveProfileManagementAvailability(state.capabilities);
              return (
                <section
                  className="settings-section"
                  aria-label={getCopy("scope.profileManageTitle")}
                >
                  <h3 className="settings-section-title">
                    {getCopy("scope.profileManageTitle")}
                  </h3>
                  {profileAvail.canManageNatively ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void handleRefreshProfiles()}
                      >
                        {getCopy("scope.profileRefreshAction")}
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p className="settings-section-body" style={{ marginBottom: 8 }}>
                        {getCopy(profileAvail.noteKey)}
                      </p>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <code>{profileAvail.cliCommand}</code>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => {
                            try {
                              void navigator.clipboard?.writeText(profileAvail.cliCommand);
                            } catch {
                              // Ignore clipboard errors in headless mode
                            }
                            dispatch({
                              type: "ANNOUNCE",
                              message: getCopy("capabilities.copiedCliNotice"),
                            });
                          }}
                        >
                          {getCopy("scope.profileCopyCliAction")}
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() =>
                            void host.request("links.openExternal", { url: profileAvail.docsUrl })
                          }
                        >
                          {getCopy("scope.profileOpenDocsAction")}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })()}
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

      <ApprovalInspectModal
        approval={inspectedApproval}
        onClose={() => dispatch({ type: "CLOSE_APPROVAL_INSPECT" })}
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
