import { useEffect } from "react";
import { useApp } from "./state/AppContext";
import { Sidebar } from "./components/Sidebar";
import { ChatSurface } from "./components/Chat";
import { GatewaySwitcher } from "./components/GatewaySwitcher";
import { CapabilitiesDrawer } from "./components/Capabilities";
import { SettingsOverlay } from "./components/Settings";
import { WorkspaceRail } from "./components/Workspace";
import { CommandPalette } from "./components/CommandPalette";
import { GlobalOverlays, ToastView, WindowTitlebar } from "./components/Overlays";

export default function App() {
  const { state, dispatch } = useApp();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dispatch({ type: "SET_OVERLAY", overlay: "palette" });
        return;
      }
      if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        dispatch({ type: "NEW_SESSION" });
        return;
      }
      if (modifier && event.key === ",") {
        event.preventDefault();
        dispatch({ type: "OPEN_SETTINGS" });
        return;
      }
      if (event.key === "Escape") {
        if (state.overlay !== "none") {
          dispatch({ type: "CLOSE_OVERLAY" });
        } else if (state.gatewaySwitcherOpen) {
          dispatch({ type: "TOGGLE_GATEWAY_SWITCHER", open: false });
        } else if (state.capabilitiesOpen) {
          dispatch({ type: "CLOSE_CAPABILITIES" });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, state.overlay, state.gatewaySwitcherOpen, state.capabilitiesOpen]);

  useEffect(() => {
    if (!state.toast) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "DISMISS_TOAST", id: state.toast!.id });
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [dispatch, state.toast]);

  return (
    <div className="app-window">
      <WindowTitlebar />
      <div className="app-shell">
        <Sidebar />
        <ChatSurface />
        <WorkspaceRail />
      </div>
      <GatewaySwitcher />
      <CapabilitiesDrawer />
      <SettingsOverlay />
      <CommandPalette />
      <GlobalOverlays />
      <ToastView />
    </div>
  );
}
