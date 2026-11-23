import type {
  AppInfo,
  BridgeEvent,
  BridgeScope,
  CapabilitySnapshot,
  ChatSessionProjection,
  ConnectionHealthSummary,
  LocalInspectResult,
  ProfileSummary,
  SanitizedDiagnosticsPayload,
  SessionSummary,
  SessionTranscriptSnapshot,
  WorkspaceMode,
  WorkspaceTab,
} from "@hermes/contracts";
import { CapabilityRegistry } from "./capabilityRegistry";
import { reduceTranscriptEvent } from "./gatewayProtocol";

export type ViewportMode = "rail" | "popover";

export type OverlaySurface =
  | "palette"
  | "settings"
  | "capabilities"
  | "extensions"
  | "shortcuts"
  | "sessionsPopover"
  | "scopePopover"
  | "diagnostics"
  | "remoteEscape";

export interface ShellState {
  appInfo: AppInfo | null;
  connections: ConnectionHealthSummary[];
  profiles: ProfileSummary[];
  sessions: SessionSummary[];
  activeScope: BridgeScope | null;
  activeSessionId: string | null;
  transcript: SessionTranscriptSnapshot | null;
  chatState: ChatSessionProjection | null;
  stopError: string | null;
  chatBusy: boolean;
  localInspection: LocalInspectResult | null;
  diagnosticsReport: SanitizedDiagnosticsPayload | null;
  capabilities: CapabilitySnapshot;
  workspace: {
    mode: WorkspaceMode;
    activeTab: WorkspaceTab;
  };
  surfaceStack: OverlaySurface[];
  liveAnnouncement: string;
}

export type ShellAction =
  | { type: "HYDRATE_HELLO"; appInfo: AppInfo }
  | {
      type: "APPLY_FLEET_SNAPSHOT";
      connections: ConnectionHealthSummary[];
      profiles: ProfileSummary[];
      sessions: SessionSummary[];
      activeScope: BridgeScope | null;
      activeSessionId: string | null;
    }
  | { type: "APPLY_TRANSCRIPT_EVENT"; event: BridgeEvent }
  | { type: "REPLACE_TRANSCRIPT_SNAPSHOT"; snapshot: SessionTranscriptSnapshot }
  | { type: "CLEAR_TRANSCRIPT" }
  | { type: "APPLY_CHAT_STATE"; chatState: ChatSessionProjection }
  | { type: "SET_STOP_ERROR"; message: string | null }
  | { type: "SET_CHAT_BUSY"; busy: boolean }
  | { type: "APPLY_LOCAL_INSPECTION"; inspection: LocalInspectResult }
  | { type: "APPLY_DIAGNOSTICS_REPORT"; report: SanitizedDiagnosticsPayload }
  | { type: "APPLY_CAPABILITIES_SNAPSHOT"; snapshot: CapabilitySnapshot }
  | { type: "OPEN_SURFACE"; surface: OverlaySurface }
  | { type: "CLOSE_TOPMOST_SURFACE" }
  | { type: "CLOSE_SURFACE"; surface: OverlaySurface }
  | { type: "TOGGLE_WORKSPACE" }
  | { type: "SET_WORKSPACE_MODE"; mode: WorkspaceMode }
  | { type: "SET_WORKSPACE_TAB"; tab: WorkspaceTab }
  | { type: "ANNOUNCE"; message: string };

export function deriveViewportMode(width: number): ViewportMode {
  return width <= 1340 ? "popover" : "rail";
}

export function createInitialShellState(): ShellState {
  return {
    appInfo: null,
    connections: [],
    profiles: [],
    sessions: [],
    activeScope: null,
    activeSessionId: null,
    transcript: null,
    chatState: null,
    stopError: null,
    chatBusy: false,
    localInspection: null,
    diagnosticsReport: null,
    capabilities: new CapabilityRegistry().getSnapshot(),
    workspace: {
      mode: "closed",
      activeTab: "artifacts",
    },
    surfaceStack: [],
    liveAnnouncement: "",
  };
}

export function getTopmostSurface(state: ShellState): OverlaySurface | null {
  if (state.surfaceStack.length === 0) return null;
  return state.surfaceStack[state.surfaceStack.length - 1];
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "HYDRATE_HELLO":
      return {
        ...state,
        appInfo: action.appInfo,
      };
    case "APPLY_FLEET_SNAPSHOT":
      return {
        ...state,
        connections: action.connections,
        profiles: action.profiles,
        sessions: action.sessions,
        activeScope: action.activeScope,
        activeSessionId: action.activeSessionId,
      };
    case "APPLY_TRANSCRIPT_EVENT":
      return {
        ...state,
        transcript: reduceTranscriptEvent(state.transcript, action.event),
      };
    case "REPLACE_TRANSCRIPT_SNAPSHOT":
      return {
        ...state,
        transcript: {
          ...action.snapshot,
          messages: [...action.snapshot.messages],
        },
      };
    case "CLEAR_TRANSCRIPT":
      return {
        ...state,
        transcript: null,
        stopError: null,
      };
    case "APPLY_CHAT_STATE":
      return {
        ...state,
        chatState: action.chatState,
      };
    case "SET_STOP_ERROR":
      return {
        ...state,
        stopError: action.message,
      };
    case "SET_CHAT_BUSY":
      return {
        ...state,
        chatBusy: action.busy,
      };
    case "APPLY_LOCAL_INSPECTION":
      return {
        ...state,
        localInspection: action.inspection,
      };
    case "APPLY_DIAGNOSTICS_REPORT":
      return {
        ...state,
        diagnosticsReport: action.report,
      };
    case "APPLY_CAPABILITIES_SNAPSHOT":
      if (action.snapshot.generation < state.capabilities.generation) {
        return state;
      }
      return {
        ...state,
        capabilities: action.snapshot,
      };
    case "OPEN_SURFACE": {
      const filtered = state.surfaceStack.filter((item) => item !== action.surface);
      return {
        ...state,
        surfaceStack: [...filtered, action.surface],
      };
    }
    case "CLOSE_TOPMOST_SURFACE": {
      if (state.surfaceStack.length === 0) return state;
      return {
        ...state,
        surfaceStack: state.surfaceStack.slice(0, -1),
      };
    }
    case "CLOSE_SURFACE":
      return {
        ...state,
        surfaceStack: state.surfaceStack.filter((item) => item !== action.surface),
      };
    case "TOGGLE_WORKSPACE":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          mode: state.workspace.mode === "open" ? "hidden" : "open",
        },
      };
    case "SET_WORKSPACE_MODE":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          mode: action.mode,
        },
      };
    case "SET_WORKSPACE_TAB":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          activeTab: action.tab,
        },
      };
    case "ANNOUNCE":
      return {
        ...state,
        liveAnnouncement: action.message,
      };
  }
}
