import { contextBridge, ipcRenderer } from "electron";
import {
  HOST_BRIDGE_VERSION,
  HOST_TOPICS,
  type AppCommand,
  type BridgeEvent,
  type BridgeResult,
  type BridgeScope,
  type HermesHost,
  type HostCommand,
  type HostTopic,
} from "@hermes/contracts";

const VALID_TOPICS = new Set<string>(HOST_TOPICS);

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `ipc-${Date.now()}-${requestCounter}`;
}

let subCounter = 0;

const hermesHost: HermesHost = {
  version: HOST_BRIDGE_VERSION,

  async request<T = unknown>(
    command: HostCommand,
    payload: Record<string, unknown> = {},
    scope: BridgeScope | null = null,
  ): Promise<BridgeResult<T>> {
    const requestId = nextRequestId();
    return ipcRenderer.invoke("hermes:request", {
      version: HOST_BRIDGE_VERSION,
      requestId,
      command,
      scope,
      payload,
    });
  },

  subscribe(
    topic: HostTopic,
    scope: BridgeScope | null,
    listener: (event: BridgeEvent) => void,
  ): () => void {
    if (!VALID_TOPICS.has(topic)) {
      throw new Error(`Invalid host topic: ${String(topic)}`);
    }
    subCounter += 1;
    const subscriptionId = `sub-${subCounter}`;

    const onEvent = (
      _ipcEvent: Electron.IpcRendererEvent,
      incomingSubId: string,
      bridgeEvent: BridgeEvent,
    ) => {
      if (incomingSubId === subscriptionId) {
        listener(bridgeEvent);
      }
    };

    ipcRenderer.on("hermes:event", onEvent);
    ipcRenderer.send("hermes:subscribe", { subscriptionId, topic, scope });

    return () => {
      ipcRenderer.removeListener("hermes:event", onEvent);
      ipcRenderer.send("hermes:unsubscribe", { subscriptionId });
    };
  },

  onCommand(listener: (command: AppCommand) => void): () => void {
    const onCmd = (_ipcEvent: Electron.IpcRendererEvent, command: AppCommand) => {
      listener(command);
    };
    ipcRenderer.on("hermes:command", onCmd);
    return () => {
      ipcRenderer.removeListener("hermes:command", onCmd);
    };
  },
};

contextBridge.exposeInMainWorld("hermesHost", Object.freeze(hermesHost));
