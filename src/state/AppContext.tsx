import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
  useState,
} from "react";
import { appReducer, createInitialState, type AppAction } from "./store";
import type { AppState, CapabilityTab, Overlay, SettingsSection, WorkspaceTab } from "../types";

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  demo: string;
  setDemo: (demo: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function applyDemo(seed: AppState, demo: string): AppState {
  let state = seed;
  const openSettings = (section: SettingsSection) => {
    state = appReducer(state, { type: "OPEN_SETTINGS", section });
  };
  const openCapability = (tab: CapabilityTab) => {
    state = appReducer(state, { type: "OPEN_CAPABILITIES", tab });
  };
  const openWorkspace = (tab: WorkspaceTab) => {
    state = appReducer(state, { type: "OPEN_WORKSPACE", tab });
  };
  const setOverlay = (overlay: Overlay) => {
    state = appReducer(state, { type: "SET_OVERLAY", overlay });
  };

  switch (demo) {
    case "remote":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      state = appReducer(state, { type: "TOGGLE_GATEWAY_SWITCHER", open: true });
      break;
    case "registry":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openSettings("gateways");
      break;
    case "palette":
      setOverlay("palette");
      break;
    case "capabilities":
      openCapability("skills");
      break;
    case "mcp":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openCapability("mcp");
      break;
    case "memory":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openCapability("memory");
      break;
    case "channels":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openCapability("channels");
      break;
    case "cron":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openCapability("cron");
      break;
    case "workspace":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openWorkspace("artifacts");
      state = appReducer(state, { type: "SET_PREVIEW_ARTIFACT", artifactId: "art-latency" });
      break;
    case "terminal":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openWorkspace("terminal");
      state = appReducer(state, { type: "TERMINAL_RUN", command: "hermes gateway status" });
      break;
    case "git":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openWorkspace("git");
      break;
    case "agents":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      openWorkspace("agents");
      state = appReducer(state, { type: "SET_SUBAGENT_SELECTED", id: "sub-research" });
      break;
    case "bots":
      state = appReducer(state, { type: "OPEN_BOT", botId: "bot-research-homelab" });
      break;
    case "checkpoints":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      setOverlay("checkpoints");
      break;
    case "memory-graph":
      state = appReducer(state, { type: "SWITCH_GATEWAY", gatewayId: "homelab" });
      setOverlay("memoryGraph");
      break;
    case "settings":
      openSettings("model");
      break;
    case "all-profiles":
      state = appReducer(state, { type: "TOGGLE_ALL_PROFILES" });
      state = appReducer(state, { type: "SET_SIDEBAR_MODE", mode: "sessions" });
      break;
    default:
      break;
  }
  return demo === "local" ? state : { ...state, toast: undefined };
}

function readDemo(): string {
  if (typeof window === "undefined") return "local";
  return new URLSearchParams(window.location.search).get("demo") ?? "local";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState(readDemo);
  const [state, dispatch] = useReducer(appReducer, demo, (mode) =>
    applyDemo(createInitialState(), mode),
  );
  const value = useMemo(() => ({ state, dispatch, demo, setDemo }), [state, demo]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
