import { HOST_BRIDGE_VERSION, type HermesHost } from "@hermes/contracts";

declare global {
  interface Window {
    hermesHost?: HermesHost;
  }
}

function getElectronHost(): HermesHost {
  const bridge = window.hermesHost;
  if (!bridge) {
    throw new Error("window.hermesHost is unavailable in Electron renderer");
  }
  if (bridge.version !== HOST_BRIDGE_VERSION) {
    throw new Error(`Unsupported HostBridge version: ${String(bridge.version)}`);
  }
  return bridge;
}

export const host: HermesHost = getElectronHost();
