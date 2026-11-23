import type {
  AppInfo,
  BridgeScope,
  ConnectionHealthSummary,
  LocalInspectResult,
  ProfileSummary,
  SanitizedDiagnosticsPayload,
  SessionSummary,
  WorkspaceMode,
  WorkspaceTab,
} from "@hermes/contracts";

export type ViewportMode = "rail" | "popover";

export type OverlaySurface =
  | "palette"
  | "settings"
  | "capabilities"
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
  localInspection: LocalInspectResult | null;
  diagnosticsReport: SanitizedDiagnosticsPayload | null;
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
  | { type: "APPLY_LOCAL_INSPECTION"; inspection: LocalInspectResult }
  | { type: "APPLY_DIAGNOSTICS_REPORT"; report: SanitizedDiagnosticsPayload }
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
    localInspection: null,
    diagnosticsReport: null,
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
