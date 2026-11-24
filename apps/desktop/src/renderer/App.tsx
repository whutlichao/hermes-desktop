import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Command,
  PanelRight,
  Plus,
  Settings2,
} from "lucide-react";
import {
  type AppCommand,
  type ApprovalChoice,
  type ApprovalRespondResult,
  type ApprovalTopicSnapshot,
  type ApprovalView,
  type ArtifactAnnotation,
  type AttentionTarget,
  type BridgeScope,
  type CapabilityDomainId,
  type CapabilityEntry,
  type CapabilitySnapshot,
  type ChatSessionProjection,
  type CheckpointDiffSnapshot,
  type ConnectionKind,
  type ConnectionMutationResponse,
  type CronJobActionRequest,
  type CronMutationResult,
  type CronSubmitRequest,
  type DomainInspectTab,
  type DraftAttachment,
  type DraftAttachmentKind,
  type DraftContextItem,
  type DraftExportBundle,
  type DraftRecord,
  type FleetSnapshot,
  type GatewayConfigSnapshot,
  type GatewayConfigUpdateResult,
  type GatewayConfigValue,
  type LocalInspectResult,
  type LocalSafeActionId,
  type LocalSelectCliResult,
  type MissingSessionExport,
  type OrphanedDraftRecord,
  type ProfileSummary,
  type PromptSteerResult,
  type RegistrySnapshotView,
  type SanitizedDiagnosticsPayload,
  type SessionSummary,
  type SessionTranscriptSnapshot,
  type SubagentTailSnapshot,
  type TerminalCloseResult,
  type TerminalOpenResult,
  type TerminalSnapshot,
  type TurnRecoveryTopicSnapshot,
  type TurnSessionRecoveryView,
  type UnknownTurnRecord,
  type WorkspaceAgentItem,
  type WorkspaceArtifactItem,
  type WorkspaceCheckpointItem,
  type WorkspaceFileEntry,
  type WorkspaceGitDiffItem,
  type WorkspaceTab,
} from "@hermes/contracts";
import {
  FocusReturnController,
  HERMES_INSTALL_DOCS_URL,
  HERMES_UPDATE_DOCS_URL,
  addWorkspaceAnnotation,
  aggregateAttentionState,
  buildActiveDraftExport,
  closeWorkspace,
  createInitialShellState,
  createInitialWorkspaceSessionState,
  createSequenceTracker,
  createTranscriptSyncController,
  deriveViewportMode,
  filterProfilesForConnection,
  filterSessionsForScope,
  findActiveChatDraft,
  formatAppInfoDisplay,
  getActiveChatWorkspaceView,
  getActiveScopeWorkspaceView,
  getCopy,
  getTopmostSurface,
  hideWorkspace,
  invalidateWorkspaceGeneration,
  listScopeNewChatDrafts,
  markWorkspaceArtifactsExternalStale,
  markWorkspaceCheckpointRestored,
  markWorkspaceFilesExternalStale,
  openWorkspace,
  projectSettingsSectionFields,
  reconcileWorkspaceAgents,
  reconcileWorkspaceArtifacts,
  reconcileWorkspaceCheckpoints,
  reconcileWorkspaceFiles,
  reconcileWorkspaceGitDiffs,
  resolveDraftKey,
  resolveProfileManagementAvailability,
  resolveWorkspaceChatKey,
  selectWorkspaceAgent,
  selectWorkspaceArtifact,
  selectWorkspaceCheckpoint,
  selectWorkspaceFile,
  selectWorkspaceFileLines,
  selectWorkspaceGitDiff,
  setWorkspaceActiveTab,
  setWorkspaceAgentError,
  setWorkspaceAgentSteerText,
  setWorkspaceAgentTail,
  setWorkspaceAnnotations,
  setWorkspaceArtifactScroll,
  setWorkspaceArtifactZoom,
  setWorkspaceCheckpointDiff,
  setWorkspaceCheckpointError,
  setWorkspaceCheckpointRestorePending,
  setWorkspaceTerminalSnapshot,
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
import { DomainInspectDrawer } from "./components/DomainInspectDrawer";
import {
  ExtensionInventoryViewPanel,
  type ExtensionDomainTab,
} from "./components/ExtensionInventoryView";
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
  const workspaceStateRef = useRef(workspaceState);
  workspaceStateRef.current = workspaceState;
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [draftContexts, setDraftContexts] = useState<DraftContextItem[]>([]);
  const [draftCapacityError, setDraftCapacityError] = useState<
    "over_single_limit" | "over_total_limit" | null
  >(null);
  const [exportedDraft, setExportedDraft] = useState<DraftExportBundle | null>(null);
  const [exportedOrphanedDraft, setExportedOrphanedDraft] = useState<DraftExportBundle | null>(null);
  const [activeNewDraftIdByScope, setActiveNewDraftIdByScope] = useState<Record<string, string>>({});
  const [exportedMissing, setExportedMissing] = useState<MissingSessionExport | null>(null);
  const [fleetResyncNonce, setFleetResyncNonce] = useState(0);
  const [registrySnapshot, setRegistrySnapshot] = useState<RegistrySnapshotView | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<GatewayConfigSnapshot | null>(null);
  const [agentInterrupting, setAgentInterrupting] = useState(false);
  const [terminalBusyConfirmOpen, setTerminalBusyConfirmOpen] = useState(false);
  const terminalBusyConfirmOpenRef = useRef(terminalBusyConfirmOpen);
  terminalBusyConfirmOpenRef.current = terminalBusyConfirmOpen;
  const terminalCloseBtnRef = useRef<HTMLButtonElement>(null);
  const [extensionDrawerDomain, setExtensionDrawerDomain] =
    useState<ExtensionDomainTab>("plugins");
  const [settingsExtDomain, setSettingsExtDomain] =
    useState<ExtensionDomainTab>("plugins");
  const [extBusyDomain, setExtBusyDomain] = useState<ExtensionDomainTab | null>(null);
  const attemptedExtFetchRef = useRef<Map<ExtensionDomainTab, string>>(new Map());
  const [domainInspectBusy, setDomainInspectBusy] = useState(false);
  const [domainInspectError, setDomainInspectError] = useState<string | null>(null);
  const [settingsAddRequest, setSettingsAddRequest] = useState<{
    kind: ConnectionKind;
    nonce: number;
  } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [cancelledApprovalKey, setCancelledApprovalKey] = useState<string | null>(null);
  const approvalInFlightKeysRef = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const railNewSessionRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const capabilitiesTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceFocusPendingRef = useRef(false);
  const sessionsPopoverTriggerRef = useRef<HTMLButtonElement>(null);
  const scopePopoverTriggerRef = useRef<HTMLButtonElement>(null);
  const trackerRef = useRef(createSequenceTracker());
  const registryTrackerRef = useRef(createSequenceTracker());
  const capabilitiesTrackerRef = useRef(createSequenceTracker());
  const chatStateTrackerRef = useRef(createSequenceTracker());
  const approvalTrackerRef = useRef(createSequenceTracker());
  const turnRecoveryTrackerRef = useRef(createSequenceTracker());
  const transcriptSyncRef = useRef(createTranscriptSyncController());
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftSaveRef = useRef<{
    key: string;
    scope: BridgeScope;
    payload: Record<string, unknown>;
  } | null>(null);
  const dirtyDraftKeyRef = useRef<string | null>(null);
  const prevDraftKeyRef = useRef<string | null>(null);
  const hydratedChatStateKeyRef = useRef<string | null>(null);
  const newDraftSeqRef = useRef(0);

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
  const isMockMode = state.appInfo?.mode === "mock";
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

  const activeSession = useMemo(
    () => scopedSessions.find((session) => session.sessionId === state.activeSessionId) ?? null,
    [scopedSessions, state.activeSessionId],
  );
  const isSampleConversation =
    isMockMode && activeSession?.title === getCopy("chat.sampleBadge");

  const attentionSummary = useMemo(
    () => aggregateAttentionState(state.sessions, effectiveScope, state.activeSessionId),
    [effectiveScope, state.activeSessionId, state.sessions],
  );

  const activeTurnRecovery = useMemo<TurnSessionRecoveryView | null>(() => {
    if (!effectiveScope?.connectionId || !state.activeSessionId) return null;
    const profileId = effectiveScope.profileId ?? "default";
    return (
      state.turnRecovery.sessions.find(
        (item) =>
          item.connectionId === effectiveScope.connectionId &&
          item.profileId === profileId &&
          item.sessionId === state.activeSessionId,
      ) ?? null
    );
  }, [
    effectiveScope?.connectionId,
    effectiveScope?.profileId,
    state.activeSessionId,
    state.turnRecovery.sessions,
  ]);

  const canQueuePrompt =
    hasReadyConnection &&
    Boolean(state.transcript?.supportedActions.promptSubmit) &&
    !activeTurnRecovery?.queuePaused &&
    (activeTurnRecovery?.unknownTurns.length ?? 0) === 0;

  const canSteerPrompt = hasReadyConnection && Boolean(state.transcript?.supportedActions.promptSteer);
  const canCancelQueuePrompt =
    hasReadyConnection && Boolean(state.transcript?.supportedActions.promptCancel);
  const cronHintText = useMemo(() => {
    const recent = state.capabilities.cron.recentRunSummary;
    return recent
      ? `${getCopy("chat.emptyCronRecentPrefix")}${recent}`
      : getCopy("chat.emptyCronDefaultHint");
  }, [state.capabilities.cron.recentRunSummary]);

  useEffect(() => {
    const syncFocus = (focused: boolean) => {
      void host.request("app.setFocused", { focused });
    };
    const onFocus = () => syncFocus(true);
    const onBlur = () => syncFocus(false);
    syncFocus(typeof document !== "undefined" ? document.hasFocus() : true);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

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

  // Hand focus to the Workspace drawer when it opens. The drawer occupies reserved space
  // beside the transcript, so the shell remains interactive and unobscured.
  useLayoutEffect(() => {
    if (state.workspace.mode !== "open" || !workspaceFocusPendingRef.current) return;
    workspaceFocusPendingRef.current = false;
    const drawer = shellRef.current?.querySelector<HTMLElement>(".workspace-drawer");
    const target = drawer?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    target?.focus();
  }, [state.workspace.mode]);

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

      const [filesRes, artifactsRes, subagentsRes, checkpointsRes, terminalRes] = await Promise.all([
        filesPromise,
        artifactsPromise,
        targetChatScope.sessionId
          ? host.request<{
              agents?: WorkspaceAgentItem[];
              readOnly?: boolean;
              lastKnown?: boolean;
            }>(
              "subagents.list",
              {
                sessionId: targetChatScope.sessionId,
                profileId: targetChatScope.profileId ?? "default",
              },
              targetChatScope,
            )
          : Promise.resolve(null),
        targetChatScope.sessionId
          ? host.request<{
              checkpoints?: WorkspaceCheckpointItem[];
              canRestore?: boolean;
            }>(
              "checkpoints.list",
              {
                sessionId: targetChatScope.sessionId,
                profileId: targetChatScope.profileId ?? "default",
              },
              targetChatScope,
            )
          : Promise.resolve(null),
        host.request<{ snapshot?: TerminalSnapshot }>(
          "terminal.get",
          { profileId: scopeOnly.profileId },
          scopeOnly,
        ),
      ]);

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
        if (terminalRes.ok && terminalRes.value.snapshot) {
          next = setWorkspaceTerminalSnapshot(next, terminalRes.value.snapshot, scopeOnly);
        }
        if (artifactsRes && artifactsRes.ok) {
          next = reconcileWorkspaceArtifacts(
            next,
            targetChatScope,
            artifactsRes.value.artifacts ?? [],
          );
          if (artifactsRes.value.agents && (!subagentsRes || !subagentsRes.ok)) {
            next = reconcileWorkspaceAgents(next, targetChatScope, artifactsRes.value.agents);
          }
          if (artifactsRes.value.stale) {
            next = markWorkspaceArtifactsExternalStale(next, targetChatScope);
          }
        }
        if (subagentsRes && subagentsRes.ok) {
          next = reconcileWorkspaceAgents(
            next,
            targetChatScope,
            subagentsRes.value.agents ?? [],
            {
              readOnly: Boolean(subagentsRes.value.readOnly),
              lastKnown: Boolean(subagentsRes.value.lastKnown),
            },
          );
        }
        if (checkpointsRes && checkpointsRes.ok) {
          next = reconcileWorkspaceCheckpoints(
            next,
            targetChatScope,
            checkpointsRes.value.checkpoints ?? [],
            {
              canRestore: checkpointsRes.value.canRestore ?? true,
            },
          );
        }
        return next;
      });
    },
    [],
  );

  // Invalidate old Subagent tails and pending Checkpoint restore confirmation when capability generation changes
  useEffect(() => {
    setWorkspaceState((prev) =>
      invalidateWorkspaceGeneration(prev, state.capabilities.generation),
    );
  }, [state.capabilities.generation]);

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

  // Hydrate persisted Draft annotations from chatState sessionSummaries / draftsByKey
  useEffect(() => {
    if (!activeChatScope?.sessionId || !state.chatState) return;
    const chatKey = resolveWorkspaceChatKey(activeChatScope);
    const persisted = findActiveChatDraft(state.chatState.draftsByKey, activeChatScope);
    const annotations =
      persisted?.annotations ?? state.chatState.sessionSummaries?.[chatKey]?.annotations;
    if (annotations) {
      setWorkspaceState((prev) =>
        setWorkspaceAnnotations(prev, annotations ?? [], activeChatScope),
      );
    }
  }, [
    activeChatScope?.connectionId,
    activeChatScope?.profileId,
    activeChatScope?.sessionId,
    state.chatState,
  ]);

  const effectiveDraftScope: BridgeScope | null = useMemo(() => {
    if (activeChatScope) return activeChatScope;
    if (state.chatState?.lastActiveChat) {
      return {
        connectionId: state.chatState.lastActiveChat.connectionId,
        profileId: state.chatState.lastActiveChat.profileId,
        ...(state.chatState.lastActiveChat.sessionId
          ? { sessionId: state.chatState.lastActiveChat.sessionId }
          : {}),
      };
    }
    return null;
  }, [activeChatScope, state.chatState?.lastActiveChat]);

  const scopeNewDrafts = useMemo(
    () => listScopeNewChatDrafts(state.chatState?.draftsByKey, effectiveDraftScope),
    [effectiveDraftScope, state.chatState?.draftsByKey],
  );

  const draftScopeKey = effectiveDraftScope
    ? `${effectiveDraftScope.connectionId}::${effectiveDraftScope.profileId ?? "default"}`
    : null;

  const activeNewDraftId = useMemo(() => {
    if (!draftScopeKey || effectiveDraftScope?.sessionId) return null;
    return (
      activeNewDraftIdByScope[draftScopeKey] ??
      scopeNewDrafts[0]?.draftId ??
      `draft-new-${draftScopeKey}`
    );
  }, [activeNewDraftIdByScope, draftScopeKey, effectiveDraftScope?.sessionId, scopeNewDrafts]);

  const currentDraftKey = useMemo(() => {
    if (!effectiveDraftScope) return null;
    return resolveDraftKey({
      connectionId: effectiveDraftScope.connectionId,
      profileId: effectiveDraftScope.profileId ?? "default",
      sessionId: effectiveDraftScope.sessionId,
      draftId: effectiveDraftScope.sessionId ? undefined : activeNewDraftId ?? undefined,
    });
  }, [activeNewDraftId, effectiveDraftScope]);

  const currentPersistedDraft = useMemo(() => {
    if (!currentDraftKey || !state.chatState?.draftsByKey) return null;
    return state.chatState.draftsByKey[currentDraftKey] ?? null;
  }, [currentDraftKey, state.chatState?.draftsByKey]);

  const persistDraftPayload = useCallback(
    async (scope: BridgeScope, payload: Record<string, unknown>) => {
      const res = await host.request<ChatSessionProjection>("chatState.saveDraft", payload, scope);
      if (res.ok) {
        setDraftCapacityError(null);
        dispatch({ type: "APPLY_CHAT_STATE", chatState: res.value });
      } else {
        const msg = res.error.message ?? "";
        setDraftCapacityError(msg.includes("50 MiB") ? "over_total_limit" : "over_single_limit");
      }
      return res;
    },
    [],
  );

  const flushPendingDraftSave = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    const pending = pendingDraftSaveRef.current;
    pendingDraftSaveRef.current = null;
    if (pending) {
      void persistDraftPayload(pending.scope, pending.payload);
    }
  }, [persistDraftPayload]);

  // Hydrate persisted ActiveChat or Scope+draftId Draft when key switches or chatState loads
  useEffect(() => {
    const readHydratedFields = () => {
      if (currentPersistedDraft) {
        return {
          text: currentPersistedDraft.text,
          attachments: currentPersistedDraft.attachments,
          contexts: currentPersistedDraft.contexts,
        };
      }
      if (effectiveDraftScope?.sessionId && state.chatState) {
        const sumKey = `${effectiveDraftScope.connectionId}::${effectiveDraftScope.profileId ?? "default"}::${effectiveDraftScope.sessionId}`;
        const summary = state.chatState.sessionSummaries?.[sumKey];
        if (summary?.draftText) {
          return {
            text: summary.draftText,
            attachments: [] as DraftAttachment[],
            contexts: [] as DraftContextItem[],
          };
        }
      }
      return {
        text: "",
        attachments: [] as DraftAttachment[],
        contexts: [] as DraftContextItem[],
      };
    };

    if (prevDraftKeyRef.current !== currentDraftKey) {
      flushPendingDraftSave();
      prevDraftKeyRef.current = currentDraftKey;
      dirtyDraftKeyRef.current = null;
      const fields = readHydratedFields();
      setComposerDraft(fields.text);
      setDraftAttachments(fields.attachments);
      setDraftContexts(fields.contexts);
      setDraftCapacityError(null);
      setExportedDraft(null);
      hydratedChatStateKeyRef.current = state.chatState && currentDraftKey ? currentDraftKey : null;
      return;
    }

    if (!currentDraftKey || !state.chatState) return;

    if (hydratedChatStateKeyRef.current !== currentDraftKey) {
      hydratedChatStateKeyRef.current = currentDraftKey;
      if (dirtyDraftKeyRef.current !== currentDraftKey) {
        const fields = readHydratedFields();
        setComposerDraft(fields.text);
        setDraftAttachments(fields.attachments);
        setDraftContexts(fields.contexts);
      }
      return;
    }

    if (currentPersistedDraft) {
      setDraftAttachments((prev) => {
        if (prev.length !== currentPersistedDraft.attachments.length) {
          return dirtyDraftKeyRef.current === currentDraftKey
            ? prev
            : currentPersistedDraft.attachments;
        }
        const expiredChanged = prev.some(
          (att, idx) => Boolean(att.expired) !== Boolean(currentPersistedDraft.attachments[idx]?.expired),
        );
        return expiredChanged ? currentPersistedDraft.attachments : prev;
      });
    }
  }, [
    currentDraftKey,
    currentPersistedDraft,
    effectiveDraftScope?.connectionId,
    effectiveDraftScope?.profileId,
    effectiveDraftScope?.sessionId,
    flushPendingDraftSave,
    state.chatState,
  ]);

  const handleOpenWorkspace = useCallback(
    (tab?: WorkspaceTab) => {
      workspaceFocusPendingRef.current = true;
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
    workspaceFocusPendingRef.current = false;
    setWorkspaceState((prev) => hideWorkspace(prev));
    dispatch({ type: "SET_WORKSPACE_MODE", mode: "hidden" });
    focusControllerRef.current?.closeSurface("workspace", "shortcut");
  }, []);

  const handleCloseWorkspace = useCallback(() => {
    workspaceFocusPendingRef.current = false;
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

      if (effectiveDraftScope && nextAnnotationsToSave) {
        void persistDraftPayload(effectiveDraftScope, {
          ...(effectiveDraftScope.sessionId
            ? { sessionId: effectiveDraftScope.sessionId }
            : { draftId: activeNewDraftId ?? undefined }),
          profileId: effectiveDraftScope.profileId ?? "default",
          text: composerDraft,
          annotations: nextAnnotationsToSave,
        });
      }
    },
    [activeChatScope, activeNewDraftId, composerDraft, effectiveDraftScope, persistDraftPayload],
  );

  const handleRefreshAgentTail = useCallback(
    async (agentIdOverride?: string) => {
      if (!activeChatScope?.sessionId) return;
      const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
      const agentId =
        agentIdOverride ?? chatView.selectedAgentId ?? chatView.agents[0]?.agentId ?? null;
      if (!agentId) return;

      if (chatView.agentError) {
        setWorkspaceState((prev) => setWorkspaceAgentError(prev, null, activeChatScope));
      }
      const res = await host.request<{ tail?: SubagentTailSnapshot }>(
        "subagents.tail",
        {
          agentId,
          sessionId: activeChatScope.sessionId,
          profileId: activeChatScope.profileId ?? "default",
        },
        activeChatScope,
      );
      if (res.ok && res.value.tail) {
        const tail = res.value.tail;
        setWorkspaceState((prev) => setWorkspaceAgentTail(prev, tail, activeChatScope));
      } else if (!res.ok) {
        setWorkspaceState((prev) =>
          setWorkspaceAgentError(
            prev,
            {
              code: res.error.code,
              message: res.error.message,
              retryable: res.error.retryable,
              actionId: "subagents.tail",
              detail: `code=${res.error.code} requestId=${res.error.requestId}`,
            },
            activeChatScope,
          ),
        );
      }
    },
    [activeChatScope],
  );

  const handleSteerAgent = useCallback(async () => {
    if (!activeChatScope?.sessionId) return;
    const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
    const agentId = chatView.selectedAgentId ?? chatView.agents[0]?.agentId ?? null;
    const text = chatView.steerText.trim();
    if (!agentId || !text) return;

    if (chatView.agentError) {
      setWorkspaceState((prev) => setWorkspaceAgentError(prev, null, activeChatScope));
    }
    const res = await host.request<{ steered?: boolean }>(
      "subagents.steer",
      {
        agentId,
        text,
        sessionId: activeChatScope.sessionId,
        profileId: activeChatScope.profileId ?? "default",
      },
      activeChatScope,
    );
    if (res.ok) {
      setWorkspaceState((prev) => setWorkspaceAgentSteerText(prev, ""));
    } else {
      setWorkspaceState((prev) =>
        setWorkspaceAgentError(
          prev,
          {
            code: res.error.code,
            message: res.error.message,
            retryable: res.error.retryable,
            actionId: "subagents.steer",
            detail: `code=${res.error.code} requestId=${res.error.requestId}`,
          },
          activeChatScope,
        ),
      );
    }
  }, [activeChatScope]);

  const handleInterruptAgent = useCallback(async () => {
    if (!activeChatScope?.sessionId || agentInterrupting) return;
    const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
    const agentId = chatView.selectedAgentId ?? chatView.agents[0]?.agentId ?? null;
    if (!agentId) return;

    setAgentInterrupting(true);
    if (chatView.agentError) {
      setWorkspaceState((prev) => setWorkspaceAgentError(prev, null, activeChatScope));
    }
    try {
      const res = await host.request<{
        interrupted?: boolean;
        agentId?: string;
        status?: WorkspaceAgentItem["status"];
      }>(
        "subagents.interrupt",
        {
          agentId,
          sessionId: activeChatScope.sessionId,
          profileId: activeChatScope.profileId ?? "default",
        },
        activeChatScope,
      );
      if (res.ok && res.value.interrupted) {
        const nextStatus = res.value.status ?? "stopped";
        setWorkspaceState((prev) => {
          const current = getActiveChatWorkspaceView(prev);
          return reconcileWorkspaceAgents(
            prev,
            activeChatScope,
            current.agents.map((a) =>
              a.agentId === agentId ? { ...a, status: nextStatus } : a,
            ),
          );
        });
      } else if (!res.ok) {
        // NEVER pretend stop succeeded when interrupt fails!
        setWorkspaceState((prev) =>
          setWorkspaceAgentError(
            prev,
            {
              code: res.error.code,
              message: res.error.message,
              retryable: res.error.retryable,
              actionId: "subagents.interrupt",
              detail: `code=${res.error.code} requestId=${res.error.requestId}`,
            },
            activeChatScope,
          ),
        );
      }
    } finally {
      setAgentInterrupting(false);
    }
  }, [activeChatScope, agentInterrupting]);

  const handleRetryAgentAction = useCallback(() => {
    const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
    const lastAction = chatView.agentError?.actionId;
    if (lastAction === "subagents.interrupt") {
      void handleInterruptAgent();
    } else if (lastAction === "subagents.steer") {
      void handleSteerAgent();
    } else if (lastAction === "subagents.tail") {
      void handleRefreshAgentTail();
    } else if (activeChatScope) {
      void refreshWorkspaceData(activeChatScope);
    }
  }, [
    activeChatScope,
    handleInterruptAgent,
    handleRefreshAgentTail,
    handleSteerAgent,
    refreshWorkspaceData,
  ]);

  const handleDiffCheckpoint = useCallback(
    async (checkpointId?: string) => {
      if (!activeChatScope?.sessionId) return;
      const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
      const targetId =
        checkpointId ??
        chatView.selectedCheckpointId ??
        chatView.checkpoints[0]?.checkpointId ??
        null;
      if (!targetId) return;

      if (chatView.checkpointError) {
        setWorkspaceState((prev) => setWorkspaceCheckpointError(prev, null, activeChatScope));
      }
      const res = await host.request<{ diff?: CheckpointDiffSnapshot }>(
        "checkpoints.diff",
        {
          checkpointId: targetId,
          sessionId: activeChatScope.sessionId,
          profileId: activeChatScope.profileId ?? "default",
        },
        activeChatScope,
      );
      if (res.ok && res.value.diff) {
        const diff = res.value.diff;
        setWorkspaceState((prev) => setWorkspaceCheckpointDiff(prev, diff, activeChatScope));
      } else if (!res.ok) {
        setWorkspaceState((prev) =>
          setWorkspaceCheckpointError(
            prev,
            {
              code: res.error.code,
              message: res.error.message,
              retryable: res.error.retryable,
              actionId: "checkpoint.diff",
              detail: `code=${res.error.code} requestId=${res.error.requestId}`,
            },
            activeChatScope,
          ),
        );
      }
    },
    [activeChatScope],
  );

  const handleConfirmRestoreCheckpoint = useCallback(async () => {
    if (!activeChatScope?.sessionId) return;
    const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
    const checkpointId =
      chatView.checkpointRestorePendingId ?? chatView.selectedCheckpointId ?? null;
    if (!checkpointId) return;

    if (chatView.checkpointError) {
      setWorkspaceState((prev) => setWorkspaceCheckpointError(prev, null, activeChatScope));
    }
    const res = await host.request<{ restored?: boolean; checkpointId?: string }>(
      "checkpoints.restore",
      {
        checkpointId,
        confirmed: true,
        connectionId: activeChatScope.connectionId,
        profileId: activeChatScope.profileId ?? "default",
        sessionId: activeChatScope.sessionId,
        generation: state.capabilities.generation,
      },
      activeChatScope,
    );
    if (res.ok && res.value.restored) {
      setWorkspaceState((prev) =>
        markWorkspaceCheckpointRestored(prev, checkpointId, activeChatScope),
      );
      dispatch({
        type: "ANNOUNCE",
        message: getCopy("workspace.checkpoints.restoredNotice"),
      });
    } else if (!res.ok) {
      // Failure preserves selectedCheckpointId and shows safe recovery action
      setWorkspaceState((prev) =>
        setWorkspaceCheckpointError(
          prev,
          {
            code: res.error.code,
            message: res.error.message,
            retryable: res.error.retryable,
            actionId: "checkpoint.restore",
            detail: `code=${res.error.code} requestId=${res.error.requestId}`,
          },
          activeChatScope,
        ),
      );
    }
  }, [activeChatScope, state.capabilities.generation]);

  const handleRetryCheckpointAction = useCallback(() => {
    const chatView = getActiveChatWorkspaceView(workspaceStateRef.current);
    if (chatView.checkpointError?.actionId === "checkpoint.restore") {
      void handleConfirmRestoreCheckpoint();
    } else {
      void handleDiffCheckpoint();
    }
  }, [handleConfirmRestoreCheckpoint, handleDiffCheckpoint]);

  const handleOpenTerminal = useCallback(
    async (options?: { mode?: "open" | "new" | "grant_root"; grantRoot?: boolean }) => {
      if (!activeChatScope?.connectionId) return;
      const scopeOnly: BridgeScope = {
        connectionId: activeChatScope.connectionId,
        profileId: activeChatScope.profileId ?? "default",
      };
      const scopeView = getActiveScopeWorkspaceView(workspaceStateRef.current);
      const cols = scopeView.terminalSnapshot?.cols ?? 80;
      const rows = scopeView.terminalSnapshot?.rows ?? 24;
      const res = await host.request<TerminalOpenResult>(
        "terminal.open",
        {
          cols,
          rows,
          mode: options?.mode ?? "open",
          grantRoot: Boolean(options?.grantRoot),
        },
        scopeOnly,
      );
      if (res.ok && res.value.snapshot) {
        setWorkspaceState((prev) =>
          setWorkspaceTerminalSnapshot(prev, res.value.snapshot, scopeOnly),
        );
        setTerminalBusyConfirmOpen(false);
        if (!res.value.granted) {
          dispatch({
            type: "ANNOUNCE",
            message: getCopy("workspace.terminal.grantDeniedNotice"),
          });
        }
      }
    },
    [activeChatScope?.connectionId, activeChatScope?.profileId],
  );

  const handleWriteTerminal = useCallback(
    async (data: string) => {
      if (!activeChatScope?.connectionId) return;
      const scopeOnly: BridgeScope = {
        connectionId: activeChatScope.connectionId,
        profileId: activeChatScope.profileId ?? "default",
      };
      const scopeView = getActiveScopeWorkspaceView(workspaceStateRef.current);
      const terminalId = scopeView.terminalSnapshot?.terminalId ?? undefined;
      await host.request("terminal.write", { terminalId, data }, scopeOnly);
    },
    [activeChatScope?.connectionId, activeChatScope?.profileId],
  );

  const handleResizeTerminal = useCallback(
    async (cols: number, rows: number) => {
      if (!activeChatScope?.connectionId) return;
      const scopeOnly: BridgeScope = {
        connectionId: activeChatScope.connectionId,
        profileId: activeChatScope.profileId ?? "default",
      };
      const scopeView = getActiveScopeWorkspaceView(workspaceStateRef.current);
      const terminalId = scopeView.terminalSnapshot?.terminalId ?? undefined;
      await host.request("terminal.resize", { terminalId, cols, rows }, scopeOnly);
    },
    [activeChatScope?.connectionId, activeChatScope?.profileId],
  );

  const handleCloseTerminal = useCallback(
    async (mode: "auto" | "detach" | "terminate" = "auto") => {
      if (!activeChatScope?.connectionId) return;
      const scopeOnly: BridgeScope = {
        connectionId: activeChatScope.connectionId,
        profileId: activeChatScope.profileId ?? "default",
      };
      const scopeView = getActiveScopeWorkspaceView(workspaceStateRef.current);
      const terminalId = scopeView.terminalSnapshot?.terminalId ?? undefined;
      const res = await host.request<TerminalCloseResult>(
        "terminal.close",
        { terminalId, mode },
        scopeOnly,
      );
      if (!res.ok) return;
      setWorkspaceState((prev) =>
        setWorkspaceTerminalSnapshot(prev, res.value.snapshot, scopeOnly),
      );
      if (res.value.outcome === "confirm_required") {
        setTerminalBusyConfirmOpen(true);
      } else {
        setTerminalBusyConfirmOpen(false);
      }
    },
    [activeChatScope?.connectionId, activeChatScope?.profileId],
  );

  const handleCopyGitCommand = useCallback((command: string) => {
    void navigator.clipboard?.writeText?.(command);
    dispatch({
      type: "ANNOUNCE",
      message: getCopy("workspace.git.copiedNotice"),
    });
  }, []);

  const handleOpenExternalDocUrl = useCallback(async (url: string) => {
    await host.request("links.openExternal", { url }, null);
  }, []);

  const activeChatViewForEffects = getActiveChatWorkspaceView(workspaceState);
  const selectedAgentIdForTail =
    activeChatViewForEffects.selectedAgentId ??
    activeChatViewForEffects.agents[0]?.agentId ??
    null;
  const hasSelectedAgentTail = Boolean(
    selectedAgentIdForTail &&
      (activeChatViewForEffects.agentTailById[selectedAgentIdForTail] ||
        activeChatViewForEffects.tailInvalidatedById[selectedAgentIdForTail]),
  );
  const hasAgentError = Boolean(activeChatViewForEffects.agentError);

  useEffect(() => {
    if (
      workspaceState.frame.mode === "open" &&
      workspaceState.frame.activeTab === "agents" &&
      selectedAgentIdForTail &&
      !hasSelectedAgentTail &&
      !hasAgentError
    ) {
      void handleRefreshAgentTail(selectedAgentIdForTail);
    }
  }, [
    handleRefreshAgentTail,
    hasAgentError,
    hasSelectedAgentTail,
    selectedAgentIdForTail,
    workspaceState.frame.activeTab,
    workspaceState.frame.mode,
  ]);

  const selectedCheckpointIdForDiff =
    activeChatViewForEffects.selectedCheckpointId ??
    activeChatViewForEffects.checkpoints[0]?.checkpointId ??
    null;
  const hasSelectedCheckpointDiff = Boolean(
    selectedCheckpointIdForDiff &&
      activeChatViewForEffects.checkpointDiffById[selectedCheckpointIdForDiff],
  );
  const hasCheckpointError = Boolean(activeChatViewForEffects.checkpointError);

  useEffect(() => {
    if (
      workspaceState.frame.mode === "open" &&
      workspaceState.frame.activeTab === "checkpoints" &&
      selectedCheckpointIdForDiff &&
      !hasSelectedCheckpointDiff &&
      !hasCheckpointError
    ) {
      void handleDiffCheckpoint(selectedCheckpointIdForDiff);
    }
  }, [
    handleDiffCheckpoint,
    hasCheckpointError,
    hasSelectedCheckpointDiff,
    selectedCheckpointIdForDiff,
    workspaceState.frame.activeTab,
    workspaceState.frame.mode,
  ]);

  const handleCreateSession = useCallback(
    async (migrateDraftId?: string) => {
      if (!hasReadyConnection || !effectiveScope || !canCreateSession) {
        dispatch({ type: "ANNOUNCE", message: getCopy("empty.body") });
        dispatch({ type: "SET_STOP_ERROR", message: getCopy("empty.body") });
        return null;
      }
      const draftIdToMigrate =
        migrateDraftId ?? (!state.activeSessionId ? activeNewDraftId ?? undefined : undefined);
      const res = await host.request<{ session?: SessionSummary; transcript?: SessionTranscriptSnapshot }>(
        "sessions.create",
        {
          title: getCopy("chat.newSessionDefaultTitle"),
          profileId: effectiveScope.profileId ?? "default",
          ...(draftIdToMigrate ? { draftId: draftIdToMigrate } : {}),
        },
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
      if (!res.ok) {
        dispatch({
          type: "SET_STOP_ERROR",
          message: res.error.message || getCopy("chat.sendFailed"),
        });
        return null;
      }
      if (!res.value.session) {
        dispatch({ type: "SET_STOP_ERROR", message: getCopy("chat.sendFailed") });
        return null;
      }
      return res.value.session;
    },
    [activeNewDraftId, canCreateSession, effectiveScope, hasReadyConnection, state.activeSessionId],
  );

  const handleSelectSession = useCallback(
    async (session: SessionSummary) => {
      flushPendingDraftSave();
      const targetScope: BridgeScope = {
        connectionId: session.connectionId,
        profileId: session.profileId,
        sessionId: session.sessionId,
      };
      dispatch({ type: "SET_STOP_ERROR", message: null });
      setExportedMissing(null);
      const res = await host.request<{
        fleet?: FleetSnapshot;
        transcript?: SessionTranscriptSnapshot | null;
        resyncRequired?: boolean;
      }>(
        "sessions.select",
        { sessionId: session.sessionId, profileId: session.profileId },
        targetScope,
      );
      if (res.ok) {
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
        } else if (res.value.resyncRequired || res.value.transcript === null) {
          transcriptSyncRef.current.reset();
          dispatch({ type: "CLEAR_TRANSCRIPT" });
        }
      }
      if (state.surfaceStack.includes("sessionsPopover")) {
        dispatch({ type: "CLOSE_SURFACE", surface: "sessionsPopover" });
      }
    },
    [flushPendingDraftSave, state.surfaceStack],
  );

  const openSettingsForAdd = useCallback((kind: ConnectionKind) => {
    setSettingsAddRequest({ kind, nonce: Date.now() });
    dispatch({ type: "OPEN_SURFACE", surface: "settings" });
  }, []);

  const handleContinueRecentSession = useCallback(() => {
    const recent = scopedSessions[0];
    if (recent) {
      void handleSelectSession(recent);
      return;
    }
    void handleCreateSession();
  }, [handleCreateSession, handleSelectSession, scopedSessions]);

  const buildDraftPayload = useCallback(
    (
      nextText: string,
      nextAttachments: DraftAttachment[],
      nextContexts: DraftContextItem[],
    ): Record<string, unknown> | null => {
      if (!effectiveDraftScope) return null;
      return {
        ...(effectiveDraftScope.sessionId
          ? { sessionId: effectiveDraftScope.sessionId }
          : { draftId: activeNewDraftId ?? undefined }),
        profileId: effectiveDraftScope.profileId ?? "default",
        text: nextText,
        attachments: nextAttachments,
        contexts: nextContexts,
      };
    },
    [activeNewDraftId, effectiveDraftScope],
  );

  const handleDraftChange = useCallback(
    (nextDraft: string) => {
      setComposerDraft(nextDraft);
      setExportedDraft(null);
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      if (
        !effectiveDraftScope ||
        !currentDraftKey ||
        state.chatState?.activeStatus === "session_missing" ||
        (!hasReadyConnection && !activeConnection && !state.chatState?.lastActiveChat)
      ) {
        return;
      }
      dirtyDraftKeyRef.current = currentDraftKey;
      const payload = buildDraftPayload(nextDraft, draftAttachments, draftContexts);
      if (!payload) return;
      const targetScope = effectiveDraftScope;
      const keyForSave = currentDraftKey;
      pendingDraftSaveRef.current = { key: keyForSave, scope: targetScope, payload };
      draftSaveTimerRef.current = setTimeout(() => {
        draftSaveTimerRef.current = null;
        pendingDraftSaveRef.current = null;
        void persistDraftPayload(targetScope, payload);
      }, 150);
    },
    [
      activeConnection,
      buildDraftPayload,
      currentDraftKey,
      draftAttachments,
      draftContexts,
      effectiveDraftScope,
      hasReadyConnection,
      persistDraftPayload,
      state.chatState?.activeStatus,
      state.chatState?.lastActiveChat,
    ],
  );

  const handleAttachFiles = useCallback(
    (files: FileList, reattachId?: string | null) => {
      if (!effectiveDraftScope || !currentDraftKey) return;
      const inferKind = (file: File): DraftAttachmentKind => {
        if (file.type.startsWith("image/")) return "image";
        if (file.type.startsWith("text/") || /\.(md|txt|json|ts|tsx|js|css)$/i.test(file.name)) {
          return "text";
        }
        return "file";
      };
      const fileArr = Array.from(files);
      if (fileArr.length === 0) return;

      let nextAttachments = [...draftAttachments];
      if (reattachId) {
        const replacement = fileArr[0];
        newDraftSeqRef.current += 1;
        nextAttachments = nextAttachments.map((att) =>
          att.attachmentId === reattachId
            ? {
                ...att,
                handle: `handle-${Date.now()}-${newDraftSeqRef.current}`,
                displayName: replacement.name,
                kind: inferKind(replacement),
                sizeBytes: replacement.size,
                expired: false,
              }
            : att,
        );
      } else {
        for (const file of fileArr) {
          newDraftSeqRef.current += 1;
          nextAttachments.push({
            attachmentId: `att-${Date.now()}-${newDraftSeqRef.current}`,
            handle: `handle-${Date.now()}-${newDraftSeqRef.current}`,
            displayName: file.name,
            kind: inferKind(file),
            sizeBytes: file.size,
          });
        }
      }

      dirtyDraftKeyRef.current = currentDraftKey;
      setDraftAttachments(nextAttachments);
      const payload = buildDraftPayload(composerDraft, nextAttachments, draftContexts);
      if (payload) {
        void persistDraftPayload(effectiveDraftScope, payload);
      }
    },
    [
      buildDraftPayload,
      composerDraft,
      currentDraftKey,
      draftAttachments,
      draftContexts,
      effectiveDraftScope,
      persistDraftPayload,
    ],
  );

  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      if (!effectiveDraftScope || !currentDraftKey) return;
      const nextAttachments = draftAttachments.filter((a) => a.attachmentId !== attachmentId);
      dirtyDraftKeyRef.current = currentDraftKey;
      setDraftAttachments(nextAttachments);
      const payload = buildDraftPayload(composerDraft, nextAttachments, draftContexts);
      if (payload) {
        void persistDraftPayload(effectiveDraftScope, payload);
      }
    },
    [
      buildDraftPayload,
      composerDraft,
      currentDraftKey,
      draftAttachments,
      draftContexts,
      effectiveDraftScope,
      persistDraftPayload,
    ],
  );

  const handleRemoveContext = useCallback(
    (contextId: string) => {
      if (!effectiveDraftScope || !currentDraftKey) return;
      const nextContexts = draftContexts.filter((c) => c.contextId !== contextId);
      dirtyDraftKeyRef.current = currentDraftKey;
      setDraftContexts(nextContexts);
      const payload = buildDraftPayload(composerDraft, draftAttachments, nextContexts);
      if (payload) {
        void persistDraftPayload(effectiveDraftScope, payload);
      }
    },
    [
      buildDraftPayload,
      composerDraft,
      currentDraftKey,
      draftAttachments,
      draftContexts,
      effectiveDraftScope,
      persistDraftPayload,
    ],
  );

  const handleClearDraft = useCallback(async () => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    pendingDraftSaveRef.current = null;
    dirtyDraftKeyRef.current = null;
    setComposerDraft("");
    setDraftAttachments([]);
    setDraftContexts([]);
    setDraftCapacityError(null);
    setExportedDraft(null);
    if (!effectiveDraftScope) return;
    const res = await host.request<ChatSessionProjection>(
      "chatState.clearDraft",
      {
        ...(effectiveDraftScope.sessionId
          ? { sessionId: effectiveDraftScope.sessionId }
          : { draftId: activeNewDraftId ?? undefined }),
        profileId: effectiveDraftScope.profileId ?? "default",
      },
      effectiveDraftScope,
    );
    if (res.ok) {
      dispatch({ type: "APPLY_CHAT_STATE", chatState: res.value });
    }
  }, [activeNewDraftId, effectiveDraftScope]);

  const handleExportCurrentDraft = useCallback(() => {
    if (!effectiveDraftScope) return;
    const record: DraftRecord = currentPersistedDraft
      ? {
          ...currentPersistedDraft,
          text: composerDraft,
          attachments: draftAttachments,
          contexts: draftContexts,
        }
      : {
          draftId: activeNewDraftId ?? `draft-${effectiveDraftScope.sessionId ?? "local"}`,
          ...(effectiveDraftScope.sessionId ? { sessionId: effectiveDraftScope.sessionId } : {}),
          scope: {
            connectionId: effectiveDraftScope.connectionId,
            profileId: effectiveDraftScope.profileId ?? "default",
          },
          text: composerDraft,
          attachments: draftAttachments,
          contexts: draftContexts,
          composer: {},
          updatedAt: new Date().toISOString(),
          revision: 1,
          origin: {
            connectionId: effectiveDraftScope.connectionId,
            profileId: effectiveDraftScope.profileId ?? "default",
            ...(effectiveDraftScope.sessionId ? { sessionId: effectiveDraftScope.sessionId } : {}),
          },
        };
    setExportedDraft(buildActiveDraftExport(record, new Date().toISOString()));
    dispatch({ type: "ANNOUNCE", message: getCopy("settings.data.exportedNotice") });
  }, [activeNewDraftId, composerDraft, currentPersistedDraft, draftAttachments, draftContexts, effectiveDraftScope]);

  const handleSelectNewDraft = useCallback(
    (draftId: string) => {
      if (!draftScopeKey) return;
      flushPendingDraftSave();
      setActiveNewDraftIdByScope((prev) => ({ ...prev, [draftScopeKey]: draftId }));
    },
    [draftScopeKey, flushPendingDraftSave],
  );

  const handleStartNewDraft = useCallback(() => {
    if (!draftScopeKey) return;
    flushPendingDraftSave();
    newDraftSeqRef.current += 1;
    const freshId = `draft-${Date.now()}-${newDraftSeqRef.current}`;
    setActiveNewDraftIdByScope((prev) => ({ ...prev, [draftScopeKey]: freshId }));
  }, [draftScopeKey, flushPendingDraftSave]);

  const handleCopyOrphanedDraft = useCallback((orphan: OrphanedDraftRecord) => {
    try {
      void navigator.clipboard?.writeText(orphan.text);
    } catch {
      // Ignore clipboard failure in headless mode
    }
    dispatch({ type: "ANNOUNCE", message: getCopy("settings.data.copiedNotice") });
  }, []);

  const handleExportOrphanedDraft = useCallback(async (orphanedId: string) => {
    const res = await host.request<DraftExportBundle>("chatState.exportOrphanedDraft", {
      orphanedId,
    });
    if (res.ok) {
      setExportedOrphanedDraft(res.value);
      dispatch({ type: "ANNOUNCE", message: getCopy("settings.data.exportedNotice") });
    }
  }, []);

  const handleDeleteOrphanedDraft = useCallback(async (orphanedId: string) => {
    const res = await host.request<ChatSessionProjection>("chatState.deleteOrphanedDraft", {
      orphanedId,
    });
    if (res.ok) {
      setExportedOrphanedDraft((prev) => (prev?.draftId && !res.value.orphanedDrafts?.some((o) => o.draftId === prev.draftId) ? null : prev));
      dispatch({ type: "APPLY_CHAT_STATE", chatState: res.value });
      dispatch({ type: "ANNOUNCE", message: getCopy("settings.data.deletedNotice") });
    }
  }, []);

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
        resyncRequired?: boolean;
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
        } else if (res.value.resyncRequired || res.value.transcript === null) {
          transcriptSyncRef.current.reset();
          dispatch({ type: "CLEAR_TRANSCRIPT" });
        }
      }
      dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" });
      dispatch({
        type: "ANNOUNCE",
        message: getCopy("scope.switchNotice"),
        eventId: `scope-switch:${effectiveScope.connectionId}:${profileId}`,
      });
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
      dispatch({
        type: "ANNOUNCE",
        message: getCopy("scope.profileRefreshedNotice"),
        eventId: `profile-refresh:${effectiveScope.connectionId}:${res.value.profiles.length}`,
      });
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
        dispatch({
          type: "ANNOUNCE",
          message: getCopy("settings.configSavedNotice"),
          eventId: `config-saved:${effectiveScope?.connectionId ?? "local"}:${String(key)}:${JSON.stringify(value)}`,
        });
      }
    },
    [effectiveScope],
  );

  const isScopePopoverOpen = state.surfaceStack.includes("scopePopover");
  const isSettingsOpen = state.surfaceStack.includes("settings");
  const isExtensionsOpen = state.surfaceStack.includes("extensions");
  const profileDomainProbed = Boolean(
    state.capabilities.domains.find((d) => d.domain === "profile")?.probed,
  );

  // Lazy-fetch active extension domain ONLY when drawer or Settings is open (zero polling);
  // clears per-domain attempt tracking once probed so invalidation triggers a fresh fetch.
  useEffect(() => {
    const capKey = state.capabilities.key;
    const keySig = `${capKey.connectionId}::${capKey.profileId}::${capKey.ownerGeneration}::${capKey.authorityEpoch}::${capKey.gatewayVersionOrSha}::${state.capabilities.invalidatedReason ?? ""}`;

    for (const dom of ["plugins", "skills", "tools", "mcp"] as const) {
      const domProbed = Boolean(state.capabilities.domains.find((d) => d.domain === dom)?.probed);
      if (domProbed) {
        attemptedExtFetchRef.current.delete(dom);
      }
    }

    if (!state.capabilities.capabilitiesReady || (!isExtensionsOpen && !isSettingsOpen)) {
      return;
    }

    const targets: ExtensionDomainTab[] = [];
    if (isExtensionsOpen) {
      targets.push(extensionDrawerDomain);
    }
    if (isSettingsOpen && !targets.includes(settingsExtDomain)) {
      targets.push(settingsExtDomain);
    }

    let active = true;
    for (const dom of targets) {
      const domProbed = Boolean(state.capabilities.domains.find((d) => d.domain === dom)?.probed);
      if (domProbed || attemptedExtFetchRef.current.get(dom) === keySig) {
        continue;
      }
      attemptedExtFetchRef.current.set(dom, keySig);
      setExtBusyDomain(dom);
      void host
        .request<CapabilitySnapshot>("capabilities.describe", { domain: dom }, effectiveScope)
        .then((res) => {
          if (active && res.ok) {
            dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
          }
        })
        .finally(() => {
          setExtBusyDomain((curr) => (curr === dom ? null : curr));
        });
    }

    return () => {
      active = false;
    };
  }, [
    effectiveScope,
    extensionDrawerDomain,
    isExtensionsOpen,
    isSettingsOpen,
    settingsExtDomain,
    state.capabilities.capabilitiesReady,
    state.capabilities.domains,
    state.capabilities.invalidatedReason,
    state.capabilities.key,
  ]);

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

  const reportSurfaceFailure = useCallback((message: string) => {
    dispatch({ type: "SET_STOP_ERROR", message });
  }, []);

  const handleSendPrompt = useCallback(async () => {
    const text = composerDraft.trim();
    if (
      !text ||
      !hasReadyConnection ||
      !effectiveScope ||
      state.chatBusy ||
      draftAttachments.some((a) => Boolean(a.expired))
    ) {
      return;
    }
    flushPendingDraftSave();
    dispatch({ type: "SET_CHAT_BUSY", busy: true });
    dispatch({ type: "SET_STOP_ERROR", message: null });
    try {
      let targetSessionId = state.activeSessionId;
      if (!targetSessionId) {
        const created = await handleCreateSession(activeNewDraftId ?? undefined);
        targetSessionId = created?.sessionId ?? null;
      }
      if (!targetSessionId) {
        return;
      }
      const targetScope: BridgeScope = {
        connectionId: effectiveScope.connectionId,
        profileId: effectiveScope.profileId ?? "default",
        sessionId: targetSessionId,
      };
      const draftIdToSend = currentPersistedDraft?.draftId ?? activeNewDraftId ?? undefined;
      const res = await host.request<{
        accepted?: boolean;
        admitted?: boolean;
        deliveryUnknown?: boolean;
        receipt?: string;
        receiptStatus?: string;
      }>(
        "prompts.send",
        {
          sessionId: targetSessionId,
          text,
          ...(draftIdToSend ? { draftId: draftIdToSend } : {}),
        },
        targetScope,
      );
      if (res.ok) {
        const receipt = res.value.receipt ?? res.value.receiptStatus;
        const confirmedReceipt =
          !res.value.deliveryUnknown &&
          (res.value.accepted === true ||
            res.value.admitted === true ||
            receipt === "accepted" ||
            receipt === "admitted");
        if (confirmedReceipt) {
          dirtyDraftKeyRef.current = null;
          setComposerDraft("");
          setDraftAttachments([]);
          setDraftContexts([]);
          setDraftCapacityError(null);
          setExportedDraft(null);
          if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
          }
        } else if (res.value.deliveryUnknown || receipt === "delivery_unknown") {
          dispatch({ type: "ANNOUNCE", message: getCopy("draft.deliveryUnknownBadge") });
        }
      } else {
        const message = res.error.message || getCopy("chat.sendFailed");
        reportSurfaceFailure(message);
      }
    } finally {
      dispatch({ type: "SET_CHAT_BUSY", busy: false });
    }
  }, [
    activeNewDraftId,
    composerDraft,
    currentPersistedDraft?.draftId,
    draftAttachments,
    effectiveScope,
    flushPendingDraftSave,
    handleCreateSession,
    hasReadyConnection,
    reportSurfaceFailure,
    state.activeSessionId,
    state.chatBusy,
  ]);

  const clearComposerAfterReceipt = useCallback(() => {
    dirtyDraftKeyRef.current = null;
    setComposerDraft("");
    setDraftAttachments([]);
    setDraftContexts([]);
    setDraftCapacityError(null);
    setExportedDraft(null);
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
  }, []);

  const submitRecoveryPrompt = useCallback(
    async (
      text: string,
      queued: boolean,
    ): Promise<"admitted" | "delivery_unknown" | "failed" | null> => {
      const trimmed = text.trim();
      if (!trimmed || !hasReadyConnection || !effectiveScope) return null;
      let targetSessionId = state.activeSessionId;
      if (!targetSessionId) {
        const created = await handleCreateSession(activeNewDraftId ?? undefined);
        targetSessionId = created?.sessionId ?? null;
      }
      if (!targetSessionId) return "failed";
      const targetScope: BridgeScope = {
        connectionId: effectiveScope.connectionId,
        profileId: effectiveScope.profileId ?? "default",
        sessionId: targetSessionId,
      };
      dispatch({ type: "SET_STOP_ERROR", message: null });
      setRecoveryBusy(true);
      try {
        const res = await host.request<{
          status?: "admitted" | "delivery_unknown";
          accepted?: boolean;
          admitted?: boolean;
          deliveryUnknown?: boolean;
          receipt?: string;
          receiptStatus?: string;
        }>(
          queued ? "prompts.queue" : "prompts.send",
          {
            sessionId: targetSessionId,
            text: trimmed,
            ...(queued ? { queued: true } : {}),
          },
          targetScope,
        );
        if (!res.ok) {
          reportSurfaceFailure(res.error.message);
          return "failed";
        }
        const receipt = res.value.receipt ?? res.value.receiptStatus;
        const unknown = res.value.deliveryUnknown || receipt === "delivery_unknown";
        if (unknown) {
          dispatch({
            type: "ANNOUNCE",
            message: getCopy("turn.queue.deliveryUnknownTitle"),
            priority: "assertive",
          });
          return "delivery_unknown";
        }
        const admitted =
          res.value.status === "admitted" ||
          res.value.admitted === true ||
          receipt === "admitted";
        dispatch({
          type: "ANNOUNCE",
          message: getCopy(queued ? "turn.queue.queuedNotice" : "chat.sendAccepted"),
        });
        return admitted || !queued ? "admitted" : "failed";
      } finally {
        setRecoveryBusy(false);
      }
    },
    [
      activeNewDraftId,
      effectiveScope,
      handleCreateSession,
      hasReadyConnection,
      reportSurfaceFailure,
      state.activeSessionId,
    ],
  );

  const handleQueuePrompt = useCallback(async () => {
    const result = await submitRecoveryPrompt(composerDraft, true);
    if (result === "admitted") {
      clearComposerAfterReceipt();
    }
  }, [clearComposerAfterReceipt, composerDraft, submitRecoveryPrompt]);

  const handleCheckQueueReceipt = useCallback(
    async (submissionId: string) => {
      if (!effectiveScope || !state.activeSessionId) return;
      setRecoveryBusy(true);
      try {
        const res = await host.request<{ found: boolean; canRetrySameSubmission: boolean }>(
          "prompts.checkQueueReceipt",
          { sessionId: state.activeSessionId, submissionId },
          { ...effectiveScope, sessionId: state.activeSessionId },
        );
        if (!res.ok) {
          reportSurfaceFailure(res.error.message);
          return;
        }
        dispatch({
          type: "ANNOUNCE",
          message: getCopy(
            res.value.found
              ? "turn.queue.receiptAdmittedNotice"
              : res.value.canRetrySameSubmission
                ? "turn.queue.receiptMissingNotice"
                : "turn.queue.receiptUnresolvedNotice",
          ),
        });
      } finally {
        setRecoveryBusy(false);
      }
    },
    [effectiveScope, reportSurfaceFailure, state.activeSessionId],
  );

  const handleRetryQueue = useCallback(
    async (submissionId: string) => {
      if (!effectiveScope || !state.activeSessionId) return;
      setRecoveryBusy(true);
      try {
        const res = await host.request<{
          status?: "admitted" | "delivery_unknown";
          deliveryUnknown?: unknown;
        }>(
          "prompts.retryQueue",
          { sessionId: state.activeSessionId, submissionId },
          { ...effectiveScope, sessionId: state.activeSessionId },
        );
        if (!res.ok) {
          reportSurfaceFailure(res.error.message);
          return;
        }
        if (res.value.status !== "admitted") {
          dispatch({
            type: "ANNOUNCE",
            message: getCopy("turn.queue.retryDeliveryUnknownNotice"),
            eventId: `queue-retry:${submissionId}:delivery_unknown`,
            priority: "assertive",
          });
          return;
        }
        dispatch({
          type: "ANNOUNCE",
          message: getCopy("turn.queue.retriedNotice"),
          eventId: `queue-retry:${submissionId}:admitted`,
        });
      } finally {
        setRecoveryBusy(false);
      }
    },
    [effectiveScope, reportSurfaceFailure, state.activeSessionId],
  );

  const handleCancelQueued = useCallback(
    async (admissionId: string) => {
      if (!effectiveScope || !state.activeSessionId) return;
      setRecoveryBusy(true);
      try {
        const res = await host.request<{ outcome?: string }>(
          "prompts.cancelQueued",
          { sessionId: state.activeSessionId, admissionId },
          { ...effectiveScope, sessionId: state.activeSessionId },
        );
        if (!res.ok) {
          reportSurfaceFailure(getCopy("turn.queue.cancelFailed"));
          return;
        }
        const outcome = res.value.outcome ?? "cancel_unknown";
        const key =
          outcome === "cancelled" ||
          outcome === "stopped" ||
          outcome === "already_started" ||
          outcome === "cancel_unknown"
            ? (`turn.queue.cancelOutcome.${outcome}` as CopyKey)
            : "turn.queue.cancelFailed";
        dispatch({
          type: "ANNOUNCE",
          message: getCopy(key),
        });
      } finally {
        setRecoveryBusy(false);
      }
    },
    [effectiveScope, reportSurfaceFailure, state.activeSessionId],
  );

  const handleDiscardUnknownTurn = useCallback(async (unknown: UnknownTurnRecord) => {
    if (!effectiveScope || !state.activeSessionId) return;
    setRecoveryBusy(true);
    try {
      const res = await host.request<{ resolved: boolean }>(
        "prompts.resolveUnknown",
        {
          sessionId: state.activeSessionId,
          admissionId: unknown.admissionId,
          executionGeneration: unknown.executionGeneration,
        },
        { ...effectiveScope, sessionId: state.activeSessionId },
      );
      if (!res.ok) {
        reportSurfaceFailure(getCopy("turn.unknown.discardFailed"));
        return;
      }
        dispatch({
          type: "ANNOUNCE",
          message: getCopy("turn.unknown.discardedNotice"),
          eventId: `unknown-discarded:${unknown.admissionId}:${unknown.executionGeneration}`,
        });
    } finally {
      setRecoveryBusy(false);
    }
  }, [effectiveScope, reportSurfaceFailure, state.activeSessionId]);

  const handleSteerTurn = useCallback(
    async (text: string) => {
      if (
        !text.trim() ||
        !effectiveScope ||
        !state.activeSessionId ||
        !state.transcript?.activeTurnId
      ) {
        return;
      }
      setRecoveryBusy(true);
      try {
        const res = await host.request<PromptSteerResult>(
          "prompts.steer",
          {
            sessionId: state.activeSessionId,
            turnId: state.transcript.activeTurnId,
            ...(typeof state.transcript.executionGeneration === "number"
              ? { executionGeneration: state.transcript.executionGeneration }
              : {}),
            text: text.trim(),
          },
          { ...effectiveScope, sessionId: state.activeSessionId },
        );
        if (!res.ok) {
          reportSurfaceFailure(res.error.message);
          return;
        }
        if (res.value.steered) {
          dispatch({
            type: "ANNOUNCE",
            message: getCopy("turn.steer.successNotice"),
          });
        }
      } finally {
        setRecoveryBusy(false);
      }
    },
    [
      effectiveScope,
      reportSurfaceFailure,
      state.activeSessionId,
      state.transcript?.activeTurnId,
      state.transcript?.executionGeneration,
    ],
  );

  const handleSteerFallbackNewTurn = useCallback(
    async (text: string) => {
      const result = await submitRecoveryPrompt(text, false);
      if (result === "admitted" && effectiveScope && state.activeSessionId) {
        await host.request(
          "prompts.dismissSteerFallback",
          { sessionId: state.activeSessionId },
          { ...effectiveScope, sessionId: state.activeSessionId },
        );
      }
    },
    [effectiveScope, state.activeSessionId, submitRecoveryPrompt],
  );

  const handleSteerFallbackQueue = useCallback(
    (text: string) => {
      void submitRecoveryPrompt(text, true);
    },
    [submitRecoveryPrompt],
  );

  const handleDismissSteerFallback = useCallback(async () => {
    if (!effectiveScope || !state.activeSessionId) return;
    await host.request(
      "prompts.dismissSteerFallback",
      { sessionId: state.activeSessionId },
      { ...effectiveScope, sessionId: state.activeSessionId },
    );
  }, [effectiveScope, state.activeSessionId]);

  const handleStopTurn = useCallback(async () => {
    if (!effectiveScope || !state.activeSessionId || !state.transcript?.activeTurnId) return;
    const targetScope: BridgeScope = {
      connectionId: effectiveScope.connectionId,
      profileId: effectiveScope.profileId ?? "default",
      sessionId: state.activeSessionId,
    };
    dispatch({ type: "SET_STOP_ERROR", message: null });
    const res = await host.request<{ stopped?: boolean; status?: string }>(
      "prompts.stop",
      {
        sessionId: state.activeSessionId,
        turnId: state.transcript.activeTurnId,
        ...(typeof state.transcript.executionGeneration === "number"
          ? { executionGeneration: state.transcript.executionGeneration }
          : {}),
      },
      targetScope,
    );
    if (!res.ok) {
      reportSurfaceFailure(getCopy("chat.stopFailed"));
    } else if (res.value.status === "cancel_outcome_unknown") {
      dispatch({
        type: "ANNOUNCE",
        message: getCopy("turn.stop.cancelOutcomeUnknownBody"),
        priority: "assertive",
      });
    }
  }, [
    effectiveScope,
    reportSurfaceFailure,
    state.activeSessionId,
    state.transcript?.activeTurnId,
    state.transcript?.executionGeneration,
  ]);

  const handleRespondApproval = useCallback(
    async (approval: ApprovalView, choice: ApprovalChoice) => {
      if (approvalInFlightKeysRef.current.has(approval.approvalKey)) return;
      approvalInFlightKeysRef.current.add(approval.approvalKey);
      setCancelledApprovalKey((prev) => (prev === approval.approvalKey ? null : prev));
      try {
        const res = await host.request<ApprovalRespondResult>("approvals.respond", {
          approvalKey: approval.approvalKey,
          choice,
        });
        if (!res.ok) {
          dispatch({
            type: "ANNOUNCE",
            message: getCopy("approval.actionFailedNotice"),
            eventId: `approval-error:${approval.approvalKey}:${choice}`,
            priority: "assertive",
          });
          return;
        }
        if (res.value.status === "cancelled_pending") {
          setCancelledApprovalKey(approval.approvalKey);
          dispatch({
            type: "ANNOUNCE",
            message: getCopy("approval.cancelledPendingNotice"),
            eventId: `approval-cancelled:${approval.approvalKey}`,
          });
        } else if (res.value.approval) {
          dispatch({
            type: "ANNOUNCE",
            message: getCopy(`approval.state.${res.value.approval.state}` as CopyKey),
            eventId: `approval:${approval.approvalKey}:${res.value.approval.state}`,
          });
        }
      } finally {
        approvalInFlightKeysRef.current.delete(approval.approvalKey);
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
              resyncRequired?: boolean;
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
              } else if (res.value.resyncRequired || res.value.transcript === null) {
                transcriptSyncRef.current.reset();
                dispatch({ type: "CLEAR_TRANSCRIPT" });
              }
              dispatch({
                type: "ANNOUNCE",
                message: getCopy("scope.switchNotice"),
                eventId: `scope-focus:${target.connectionId}:${target.profileId ?? "default"}:${target.sessionId ?? ""}`,
              });
            });
          break;
        }
      }
    },
    [handleCreateSession, handleToggleWorkspace],
  );

  const handleAppCommandRef = useRef(handleAppCommand);
  handleAppCommandRef.current = handleAppCommand;

  const handleMarkSessionRead = useCallback(async (session: SessionSummary) => {
    const targetScope: BridgeScope = {
      connectionId: session.connectionId,
      profileId: session.profileId,
      sessionId: session.sessionId,
    };
    const res = await host.request(
      "sessions.markRead",
      {
        connectionId: session.connectionId,
        profileId: session.profileId,
        sessionId: session.sessionId,
      },
      targetScope,
    );
    if (res.ok) {
      dispatch({
        type: "ANNOUNCE",
        message: getCopy("nav.markReadNotice"),
        eventId: `mark-read:${session.connectionId}:${session.profileId}:${session.sessionId}`,
      });
    }
  }, []);

  const handleFocusAttentionTarget = useCallback(
    async (target: AttentionTarget) => {
      const sameScope =
        effectiveScope &&
        effectiveScope.connectionId === target.connectionId &&
        (effectiveScope.profileId ?? "default") === target.profileId;
      if (sameScope) {
        const match = state.sessions.find(
          (s) =>
            s.connectionId === target.connectionId &&
            s.profileId === target.profileId &&
            s.sessionId === target.sessionId,
        );
        if (match) {
          await handleSelectSession(match);
          return;
        }
      }
      handleAppCommand({
        type: "focus_scope",
        scope: {
          connectionId: target.connectionId,
          profileId: target.profileId,
          sessionId: target.sessionId,
        },
      });
    },
    [effectiveScope, handleAppCommand, handleSelectSession, state.sessions],
  );

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

    const unsubTurnRecovery = host.subscribe("turn.recovery", null, (event) => {
      const accepted = turnRecoveryTrackerRef.current.accept(event);
      if (accepted.status === "resync_required") {
        turnRecoveryTrackerRef.current.reset();
        return;
      }
      if (accepted.status === "applied") {
        dispatch({
          type: "APPLY_TURN_RECOVERY_SNAPSHOT",
          snapshot: event.payload as TurnRecoveryTopicSnapshot,
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
      unsubTurnRecovery();
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
            dispatch({
              type: "ANNOUNCE",
              message: getCopy("chat.resyncedNotice"),
              eventId: `transcript-resync:${targetScope.connectionId}:${targetScope.profileId}:${targetScope.sessionId}:${res.value.transcript.snapshotSeq ?? 0}`,
            });
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

  // Subscribe to Main-owned Terminal snapshots for the active Scope (retained across reload)
  useEffect(() => {
    const cid = state.activeScope?.connectionId;
    if (!cid) {
      setTerminalBusyConfirmOpen(false);
      return;
    }
    const scopeTarget: BridgeScope = {
      connectionId: cid,
      profileId: state.activeScope?.profileId ?? "default",
    };
    setTerminalBusyConfirmOpen(false);
    let active = true;
    const unsub = host.subscribe("terminal", scopeTarget, (event) => {
      if (!active) return;
      const snap = event.payload as TerminalSnapshot | undefined;
      if (!snap) return;
      setWorkspaceState((prev) => setWorkspaceTerminalSnapshot(prev, snap, scopeTarget));
      if (snap.status !== "running") {
        setTerminalBusyConfirmOpen(false);
      }
    });
    return () => {
      active = false;
      unsub();
    };
  }, [state.activeScope?.connectionId, state.activeScope?.profileId]);

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
        if (
          terminalBusyConfirmOpenRef.current &&
          state.workspace.mode === "open" &&
          workspaceStateRef.current.frame.activeTab === "terminal"
        ) {
          event.preventDefault();
          setTerminalBusyConfirmOpen(false);
          queueMicrotask(() => {
            terminalCloseBtnRef.current?.focus();
          });
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

  const handleRefreshExtensionDomain = useCallback(
    async (domain: ExtensionDomainTab) => {
      setExtBusyDomain(domain);
      dispatch({ type: "ANNOUNCE", message: getCopy("capabilities.probing") });
      try {
        const res = await host.request<CapabilitySnapshot>(
          "capabilities.describe",
          { domain, refresh: true },
          effectiveScope,
        );
        if (res.ok) {
          dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
        }
      } finally {
        setExtBusyDomain((curr) => (curr === domain ? null : curr));
      }
    },
    [effectiveScope],
  );

  const handleReloadExtensionDomain = useCallback(
    async (domain: "skills" | "mcp") => {
      setExtBusyDomain(domain);
      try {
        const res = await host.request<CapabilitySnapshot>(
          "capabilities.describe",
          { domain, action: "reload" },
          effectiveScope,
        );
        if (res.ok) {
          dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
          dispatch({
            type: "ANNOUNCE",
            message: getCopy(
              domain === "skills"
                ? "extensions.skills.reloadedNotice"
                : "extensions.mcp.reloadedNotice",
            ),
            eventId: `extension-reload:${domain}:${res.value.generation}`,
          });
        }
      } finally {
        setExtBusyDomain((curr) => (curr === domain ? null : curr));
      }
    },
    [effectiveScope],
  );

  const handleCopyExtCli = useCallback((command: string) => {
    try {
      void navigator.clipboard?.writeText(command);
    } catch {
      // Ignore clipboard rejection in headless contexts
    }
    dispatch({
      type: "ANNOUNCE",
      message: `${getCopy("extensions.cli.copiedNotice")}: ${command}`,
    });
  }, []);

  const handleOpenExtDocs = useCallback((url: string) => {
    void host.request("links.openExternal", { url });
  }, []);

  const handleProbeDomain = useCallback(
    async (domain: CapabilityDomainId) => {
      if (domain === "plugins" || domain === "skills" || domain === "tools" || domain === "mcp") {
        setExtensionDrawerDomain(domain);
        dispatch({ type: "OPEN_SURFACE", surface: "extensions" });
        dispatch({ type: "ANNOUNCE", message: getCopy("extensions.title") });
        return;
      }
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

  const openDomainInspect = useCallback((tab: DomainInspectTab) => {
    setDomainInspectError(null);
    dispatch({ type: "OPEN_DOMAIN_INSPECT", tab });
  }, []);

  const handleRefreshDomainInspect = useCallback(
    async (tab: DomainInspectTab) => {
      setDomainInspectBusy(true);
      setDomainInspectError(null);
      try {
        const res = await host.request<CapabilitySnapshot>(
          "capabilities.describe",
          { domain: tab },
          effectiveScope,
        );
        if (!res.ok) {
          setDomainInspectError(res.error.message);
          return;
        }
        dispatch({ type: "APPLY_CAPABILITIES_SNAPSHOT", snapshot: res.value });
      } finally {
        setDomainInspectBusy(false);
      }
    },
    [effectiveScope],
  );

  const runCronMutation = useCallback(
    async (
      command: "cron.submit" | "cron.cancel" | "cron.recover",
      payload: Record<string, unknown>,
      noticeKey: CopyKey,
    ) => {
      setDomainInspectBusy(true);
      setDomainInspectError(null);
      try {
        const res = await host.request<CronMutationResult>(command, payload, effectiveScope);
        if (!res.ok) {
          setDomainInspectError(res.error.message);
          return;
        }
        const refreshed = await host.request<CapabilitySnapshot>(
          "capabilities.describe",
          {},
          effectiveScope,
        );
        dispatch({
          type: "APPLY_CAPABILITIES_SNAPSHOT",
          snapshot: refreshed.ok
            ? refreshed.value
            : { ...state.capabilities, cron: res.value.cron },
        });
        dispatch({ type: "ANNOUNCE", message: getCopy(noticeKey) });
      } finally {
        setDomainInspectBusy(false);
      }
    },
    [effectiveScope, state.capabilities],
  );

  const handleCronSubmit = useCallback(
    (request: CronSubmitRequest) => {
      void runCronMutation("cron.submit", { ...request }, "cron.submittedNotice");
    },
    [runCronMutation],
  );

  const handleCronCancel = useCallback(
    (request: CronJobActionRequest) => {
      void runCronMutation("cron.cancel", { jobId: request.jobId }, "cron.cancelledNotice");
    },
    [runCronMutation],
  );

  const handleCronRecover = useCallback(
    (request: CronJobActionRequest) => {
      void runCronMutation("cron.recover", { jobId: request.jobId }, "cron.recoveredNotice");
    },
    [runCronMutation],
  );

  const handleCopyDomainCli = useCallback(
    (command: string) => {
      void navigator.clipboard?.writeText?.(command);
      dispatch({ type: "ANNOUNCE", message: getCopy("domainInspect.copiedCli") });
    },
    [],
  );

  const handleOpenDomainDocs = useCallback((url: string) => {
    void host.request("links.openExternal", { url });
  }, []);

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
          dispatch({ type: "CLOSE_SURFACE", surface: "capabilities" });
          handleOpenWorkspace(tab);
        },
        toggleWorkspace: () => {
          dispatch({ type: "CLOSE_SURFACE", surface: "capabilities" });
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
        openMemoryInspect: () => openDomainInspect("memory"),
        openCronInspect: () => openDomainInspect("cron"),
        openMessagingInspect: () => openDomainInspect("messaging"),
      }),
    [
      handleAppCommand,
      handleCreateSession,
      handleProbeDomain,
      handleSelectSession,
      handleStopTurn,
      openDomainInspect,
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

  const handleRepairLocalConnection = useCallback(() => {
    const failureActions = state.localInspection?.failure?.actions ?? [];
    const primary =
      failureActions.find(
        (action) =>
          action === "choose_cli" || action === "retry" || action === "restart_gateway",
      ) ?? "retry";
    void handleLocalAction(primary);
  }, [handleLocalAction, state.localInspection?.failure?.actions]);

  const handleViewSampleConversation = useCallback(async () => {
    if (!isMockMode) return;
    const sampleLabel = "Demo Lab";
    const fail = () => dispatch({ type: "ANNOUNCE", message: getCopy("empty.sampleFailed") });
    const addRes = await host.request<ConnectionMutationResponse>("connections.add", {
      kind: "ssh",
      label: sampleLabel,
      host: "lab.local",
      user: "demo",
      seedSample: true,
    });
    if (!addRes.ok) {
      fail();
      return;
    }
    const demoConnection =
      addRes.value.snapshot.connections.find((connection) => connection.label === sampleLabel) ??
      null;
    const connectionId = demoConnection?.id ?? addRes.value.conflict?.existing.id ?? null;
    if (!connectionId) {
      fail();
      return;
    }
    const selectRes = await host.request<{
      fleet?: FleetSnapshot;
      transcript?: SessionTranscriptSnapshot | null;
    }>(
      "sessions.select",
      { connectionId, profileId: "default" },
      { connectionId, profileId: "default" },
    );
    if (!selectRes.ok) {
      fail();
      return;
    }
    if (selectRes.value.fleet) {
      dispatch({
        type: "APPLY_FLEET_SNAPSHOT",
        connections: selectRes.value.fleet.connections,
        profiles: selectRes.value.fleet.profiles,
        sessions: selectRes.value.fleet.sessions,
        activeScope: selectRes.value.fleet.activeScope,
        activeSessionId: selectRes.value.fleet.activeSessionId,
      });
    }
    if (selectRes.value.transcript) {
      const applied = transcriptSyncRef.current.applySnapshot(
        selectRes.value.transcript,
        selectRes.value.transcript.snapshotSeq ?? 0,
        { replace: true },
      );
      dispatch({ type: "REPLACE_TRANSCRIPT_SNAPSHOT", snapshot: applied.snapshot });
    }
  }, [isMockMode]);

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
                onMarkSessionRead={(s) => void handleMarkSessionRead(s)}
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

          <main
            id="main-content"
            className={`main-column${state.workspace.mode === "open" ? " has-workspace-open" : ""}`}
          >
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

              <div className="route-chain" role="group" aria-label="当前路由上下文">
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
                  <span className="gateway-kind-tag">
                    {getCopy(`connection.kind.${activeConnection.kind}` as CopyKey)}
                  </span>
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

              {(() => {
                const needsInputTarget =
                  attentionSummary.needsInputTargets.find((t) => !t.isActive) ??
                  attentionSummary.needsInputTargets[0] ??
                  null;
                const unreadTarget =
                  attentionSummary.unreadTargets.find((t) => !t.isActive) ??
                  attentionSummary.unreadTargets[0] ??
                  null;
                return (
                  <>
                    {attentionSummary.totalNeedsInput > 0 && needsInputTarget && (
                      <button
                        type="button"
                        className="route-chip route-attention-chip is-needs-input"
                        data-testid="route-strip-attention-needs-input"
                        onClick={() => void handleFocusAttentionTarget(needsInputTarget)}
                      >
                        <span>
                          {attentionSummary.totalNeedsInput} {getCopy("route.attentionNeedsInput")}
                        </span>
                      </button>
                    )}
                    {attentionSummary.totalUnread > 0 && unreadTarget && (
                      <button
                        type="button"
                        className="route-chip route-attention-chip is-unread"
                        data-testid="route-strip-attention-unread"
                        onClick={() => void handleFocusAttentionTarget(unreadTarget)}
                      >
                        <span>
                          {attentionSummary.totalUnread} {getCopy("route.attentionUnread")}
                        </span>
                      </button>
                    )}
                  </>
                );
              })()}

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
                isMockMode={isMockMode}
                isSampleConversation={isSampleConversation}
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
                draftAttachments={draftAttachments}
                draftContexts={draftContexts}
                draftDeliveryStatus={currentPersistedDraft?.deliveryStatus ?? "idle"}
                draftCapacityError={draftCapacityError}
                exportedDraft={exportedDraft}
                scopeNewDrafts={scopeNewDrafts}
                activeNewDraftId={activeNewDraftId}
                stopError={state.stopError}
                turnRecovery={activeTurnRecovery}
                recoveryBusy={recoveryBusy}
                cronHintText={cronHintText}
                hasRecentSession={scopedSessions.length > 0}
                canQueue={canQueuePrompt}
                canSteer={canSteerPrompt}
                canCancelQueue={canCancelQueuePrompt}
                canCreateSession={canCreateSession}
                composerRef={composerRef}
                onDraftChange={handleDraftChange}
                onAttachFiles={handleAttachFiles}
                onRemoveAttachment={handleRemoveAttachment}
                onRemoveContext={handleRemoveContext}
                onClearDraft={() => void handleClearDraft()}
                onExportCurrentDraft={handleExportCurrentDraft}
                onSelectNewDraft={handleSelectNewDraft}
                onStartNewDraft={handleStartNewDraft}
                onSendPrompt={() => void handleSendPrompt()}
                onQueuePrompt={() => void handleQueuePrompt()}
                onStopTurn={() => void handleStopTurn()}
                onExportMissingSession={() => void handleExportMissingSession()}
                onDismissMissingSession={() => void handleDismissMissingSession()}
                onRespondApproval={(approval, choice) => void handleRespondApproval(approval, choice)}
                onInspectApproval={handleInspectApproval}
                onDismissOrphanedApproval={(approval) => void handleDismissOrphanedApproval(approval)}
                onOpenCapabilities={() =>
                  dispatch({ type: "OPEN_SURFACE", surface: "capabilities" })
                }
                onToggleWorkspace={() => dispatch({ type: "TOGGLE_WORKSPACE" })}
                onContinueRecent={handleContinueRecentSession}
                onRepairLocal={handleRepairLocalConnection}
                onAddRemote={() => openSettingsForAdd("remote")}
                onAddSsh={() => openSettingsForAdd("ssh")}
                onViewSampleConversation={() => void handleViewSampleConversation()}
                onDiscardUnknown={(unknown) => void handleDiscardUnknownTurn(unknown)}
                onCancelQueued={(admissionId) => void handleCancelQueued(admissionId)}
                onCheckQueueReceipt={(submissionId) => void handleCheckQueueReceipt(submissionId)}
                onRetryQueue={(submissionId) => void handleRetryQueue(submissionId)}
                onSteer={(text) => void handleSteerTurn(text)}
                onSteerFallbackNewTurn={handleSteerFallbackNewTurn}
                onSteerFallbackQueue={handleSteerFallbackQueue}
                onDismissSteerFallback={() => void handleDismissSteerFallback()}
              />
            </div>
          </main>

          <WorkspaceDrawer
            workspaceState={workspaceState}
            capabilities={state.capabilities}
            activeChatScope={activeChatScope}
            agentInterrupting={agentInterrupting}
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
            onSteerAgent={() => void handleSteerAgent()}
            onInterruptAgent={() => void handleInterruptAgent()}
            onRefreshAgentTail={() => void handleRefreshAgentTail()}
            onRetryAgentAction={handleRetryAgentAction}
            onSelectCheckpoint={(checkpointId) =>
              setWorkspaceState((prev) => selectWorkspaceCheckpoint(prev, checkpointId))
            }
            onDiffCheckpoint={(checkpointId) => void handleDiffCheckpoint(checkpointId)}
            onRequestRestoreCheckpoint={(checkpointId) =>
              setWorkspaceState((prev) =>
                setWorkspaceCheckpointRestorePending(prev, checkpointId, activeChatScope),
              )
            }
            onConfirmRestoreCheckpoint={() => void handleConfirmRestoreCheckpoint()}
            onCancelRestoreCheckpoint={() =>
              setWorkspaceState((prev) =>
                setWorkspaceCheckpointRestorePending(prev, null, activeChatScope),
              )
            }
            onRetryCheckpointAction={handleRetryCheckpointAction}
            terminalBusyConfirmOpen={terminalBusyConfirmOpen}
            terminalCloseBtnRef={terminalCloseBtnRef}
            onOpenTerminal={(opts) => void handleOpenTerminal(opts)}
            onWriteTerminal={(data) => void handleWriteTerminal(data)}
            onResizeTerminal={(cols, rows) => void handleResizeTerminal(cols, rows)}
            onCloseTerminal={(mode) => void handleCloseTerminal(mode)}
            onCancelTerminalBusyConfirm={() => setTerminalBusyConfirmOpen(false)}
            onCopyGitCommand={handleCopyGitCommand}
            onOpenExternalUrl={(url) => void handleOpenExternalDocUrl(url)}
          />
        </div>

        <footer className="status-footer">
          <span>{getCopy("status.footer")}</span>
          <span>
            {isMockMode ? getCopy("status.modeMock") : getCopy("status.modeElectron")}
          </span>
          <span>{getCopy("route.capabilitiesBadge")}</span>
        </footer>

      </div>

      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="false"
        role="status"
        data-testid="live-region-polite"
        data-announcement-seq={state.liveAnnouncementSeq}
      >
        {state.liveAnnouncement}
      </div>
      <div
        className="sr-only"
        aria-live="assertive"
        aria-atomic="false"
        data-testid="live-region-assertive"
        data-announcement-seq={state.assertiveAnnouncementSeq}
      >
        {state.assertiveAnnouncement}
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
            addRequest={settingsAddRequest}
            onAddRequestConsumed={() => setSettingsAddRequest(null)}
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

        <section
          className="settings-section"
          data-settings-section="plugins"
          aria-label={getCopy("settings.section.plugins")}
        >
          <h3 className="settings-section-title">{getCopy("settings.section.plugins")}</h3>
          <ExtensionInventoryViewPanel
            extensions={state.capabilities.extensions}
            activeTab={settingsExtDomain}
            busyDomain={extBusyDomain}
            testIdPrefix="ext-settings"
            onSelectTab={setSettingsExtDomain}
            onRefresh={(dom) => void handleRefreshExtensionDomain(dom)}
            onReload={(dom) => void handleReloadExtensionDomain(dom)}
            onCopyCli={handleCopyExtCli}
            onOpenDocs={handleOpenExtDocs}
          />
        </section>

        <section
          className="settings-section"
          data-settings-section="data"
          aria-label={getCopy("settings.section.data")}
        >
          <h3 className="settings-section-title">{getCopy("settings.data.orphanedTitle")}</h3>
          <p className="settings-section-body">{getCopy("settings.data.orphanedDescription")}</p>
          {(state.chatState?.orphanedDrafts ?? []).length === 0 ? (
            <p className="settings-section-body" data-testid="orphaned-drafts-empty">
              {getCopy("settings.data.orphanedEmpty")}
            </p>
          ) : (
            <ul className="orphaned-draft-list" data-testid="orphaned-draft-list">
              {(state.chatState?.orphanedDrafts ?? []).map((orphan) => (
                <li
                  key={orphan.orphanedId}
                  className="orphaned-draft-card"
                  data-testid={`orphaned-draft-${orphan.orphanedId}`}
                >
                  <div className="orphaned-draft-meta">
                    <span className="gateway-badge">
                      {getCopy(`settings.data.reason.${orphan.reason}` as CopyKey)}
                    </span>
                    <span>
                      {orphan.origin.connectionId} / {orphan.origin.profileId}
                      {orphan.origin.sessionId ? ` / ${orphan.origin.sessionId}` : ""}
                      {orphan.origin.title ? ` (${orphan.origin.title})` : ""}
                    </span>
                    <span>{orphan.orphanedAt}</span>
                  </div>
                  {orphan.text && <pre className="orphaned-draft-text">{orphan.text}</pre>}
                  {orphan.attachments.length > 0 && (
                    <div className="draft-attachments-bar">
                      {orphan.attachments.map((att) => (
                        <span
                          key={att.attachmentId}
                          className={["draft-attachment-chip", att.expired && "is-expired"]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          <span>{att.displayName}</span>
                          {att.expired && (
                            <span className="status-pill is-warn">
                              {getCopy("draft.attachmentExpiredBadge")}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="orphaned-draft-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => handleCopyOrphanedDraft(orphan)}
                    >
                      {getCopy("settings.data.copyAction")}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void handleExportOrphanedDraft(orphan.orphanedId)}
                    >
                      {getCopy("settings.data.exportAction")}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void handleDeleteOrphanedDraft(orphan.orphanedId)}
                    >
                      {getCopy("settings.data.deleteAction")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {exportedOrphanedDraft && (
            <div className="resync-notice" role="status" data-testid="orphaned-draft-export-preview">
              <pre className="diagnostics-json">{JSON.stringify(exportedOrphanedDraft, null, 2)}</pre>
            </div>
          )}
        </section>
      </FocusDialog>

      <CapabilitiesDrawer
        open={state.surfaceStack.includes("capabilities")}
        snapshot={state.capabilities}
        handlers={capabilityHandlers}
        onOpenExtensions={() => {
          setExtensionDrawerDomain("plugins");
          dispatch({ type: "OPEN_SURFACE", surface: "extensions" });
        }}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "capabilities" })}
      />

      <DomainInspectDrawer
        open={state.surfaceStack.includes("domainInspect")}
        tab={state.domainInspectTab}
        snapshot={state.capabilities}
        busy={domainInspectBusy}
        error={domainInspectError}
        onTabChange={(tab) => dispatch({ type: "SET_DOMAIN_INSPECT_TAB", tab })}
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "domainInspect" })}
        onRefresh={handleRefreshDomainInspect}
        onSubmitCron={handleCronSubmit}
        onCancelCron={handleCronCancel}
        onRecoverCron={handleCronRecover}
        onCopyText={handleCopyDomainCli}
        onOpenDocs={handleOpenDomainDocs}
      />

      <FocusDialog
        open={isExtensionsOpen}
        title={getCopy("extensions.title")}
        description={getCopy("extensions.description")}
        closeLabel={getCopy("extensions.close")}
        className="capabilities-drawer extensions-drawer"
        scrimClassName="is-drawer"
        onClose={() => dispatch({ type: "CLOSE_SURFACE", surface: "extensions" })}
      >
        <ExtensionInventoryViewPanel
          extensions={state.capabilities.extensions}
          activeTab={extensionDrawerDomain}
          busyDomain={extBusyDomain}
          testIdPrefix="ext-drawer"
          onSelectTab={setExtensionDrawerDomain}
          onRefresh={(dom) => void handleRefreshExtensionDomain(dom)}
          onReload={(dom) => void handleReloadExtensionDomain(dom)}
          onCopyCli={handleCopyExtCli}
          onOpenDocs={handleOpenExtDocs}
        />
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
          onMarkSessionRead={(s) => void handleMarkSessionRead(s)}
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
                        aria-current={isCurrent ? "true" : undefined}
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
                                  eventId: `scope-switch:${conn.connectionId}:${state.activeScope?.profileId ?? "default"}`,
                                });
                              }
                            });
                          dispatch({ type: "CLOSE_SURFACE", surface: "scopePopover" });
                        }}
                      >
                        <span>
                          <strong>{conn.label}</strong>
                          <span style={{ display: "block", fontSize: "0.88462rem", color: "var(--muted)" }}>
                            {conn.kind} · {conn.originDisplay}
                          </span>
                        </span>
                        {isCurrent && (
                          <span className="gateway-badge is-primary">
                            {getCopy("scope.activeBadge")}
                          </span>
                        )}
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
                        aria-current={isCurrent ? "true" : undefined}
                        onClick={() => void handleSelectProfile(profile.profileId)}
                      >
                        <span>
                          <strong>{profile.displayName}</strong>
                          <span style={{ display: "block", fontSize: "0.88462rem", color: "var(--muted)" }}>
                            @{profile.handle}
                          </span>
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {profile.isDefault && (
                            <span className="gateway-badge">
                              {getCopy("scope.profileDefaultBadge")}
                            </span>
                          )}
                          {profile.pinned && (
                            <span className="gateway-badge">{getCopy("nav.pinnedBadge")}</span>
                          )}
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
                          {isCurrent && (
                            <span className="gateway-badge is-primary">
                              {getCopy("scope.activeBadge")}
                            </span>
                          )}
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
