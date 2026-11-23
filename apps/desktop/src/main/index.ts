import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, session, shell } from "electron";
import {
  HOST_BRIDGE_VERSION,
  type AppCommand,
  type AppInfo,
  type BridgeEvent,
  type BridgeScope,
  type FleetSnapshot,
  type HostRequestEnvelope,
  type HostTopic,
} from "@hermes/contracts";
import { createBridgeDispatcher, validateHostTopic } from "@hermes/domain";
import {
  buildAppMenuSpec,
  buildCspHeader,
  createHardenedWebPreferences,
  isAllowedExternalUrl,
  resolveSandboxPaths,
} from "./security";

const repoRoot = path.resolve(__dirname, "../../../..");
const sandbox = resolveSandboxPaths({ repoRoot, env: process.env });

fs.mkdirSync(sandbox.userDataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(sandbox.hermesHomeDir, { recursive: true, mode: 0o700 });
app.setPath("userData", sandbox.userDataDir);
process.env.HERMES_HOME = sandbox.hermesHomeDir;

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let rendererReady = false;
const pendingCommands: AppCommand[] = [];

function dispatchAppCommand(command: AppCommand): void {
  if (command.type === "close_window") {
    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow;
    focused?.close();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    pendingCommands.push(command);
    return;
  }
  mainWindow.webContents.send("hermes:command", command);
}

function flushPendingCommands(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return;
  while (pendingCommands.length > 0) {
    const next = pendingCommands.shift();
    if (next) mainWindow.webContents.send("hermes:command", next);
  }
}

function isTrustedSenderFrame(frame: Electron.WebFrameMain | null): boolean {
  if (!frame || !mainWindow || mainWindow.isDestroyed()) return false;
  if (frame !== mainWindow.webContents.mainFrame) return false;
  const url = frame.url;
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  }
  return url.startsWith("file://");
}

const emptyFleetSnapshot: FleetSnapshot = {
  connections: [],
  profiles: [],
  sessions: [],
  activeScope: null,
  activeSessionId: null,
};

const dispatcher = createBridgeDispatcher({
  "bridge.hello": async (): Promise<AppInfo> => {
    rendererReady = true;
    queueMicrotask(flushPendingCommands);
    return {
      bridgeVersion: HOST_BRIDGE_VERSION,
      appName: "Hermes Desktop",
      appVersion: app.getVersion(),
      mode: "electron",
      platform: process.platform,
      arch: process.arch,
      capabilitiesReady: false,
    };
  },
  "connections.list": async () => ({ connections: emptyFleetSnapshot.connections }),
  "profiles.list": async () => ({ profiles: emptyFleetSnapshot.profiles }),
  "sessions.list": async () => ({ sessions: emptyFleetSnapshot.sessions }),
  "diagnostics.export": async () => ({
    appName: "Hermes Desktop",
    appVersion: app.getVersion(),
    bridgeVersion: HOST_BRIDGE_VERSION,
    mode: "electron",
    sandboxed: !sandbox.isRealHomeAllowed,
    connectionsCount: 0,
  }),
  "links.openExternal": async (payload) => {
    const rawUrl = typeof payload.url === "string" ? payload.url : "";
    if (!isAllowedExternalUrl(rawUrl)) {
      const err = new Error("Unsupported URL scheme");
      (err as { code?: string }).code = "permission_denied";
      throw err;
    }
    await shell.openExternal(rawUrl);
    return { opened: true };
  },
});

function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "../preload/index.cjs");
  const webPreferences = {
    ...createHardenedWebPreferences(preloadPath),
    devTools: isDev,
  };

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f7f7f5",
    show: true,
    webPreferences,
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (isDev && process.env.ELECTRON_RENDERER_URL && targetUrl.startsWith(process.env.ELECTRON_RENDERER_URL)) {
      return;
    }
    event.preventDefault();
  });

  win.on("closed", () => {
    rendererReady = false;
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = buildCspHeader(isDev);
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuSpec(dispatchAppCommand) as Electron.MenuItemConstructorOptions[],
    ),
  );

  ipcMain.handle(
    "hermes:request",
    async (event, envelope: Partial<HostRequestEnvelope>) => {
      if (!isTrustedSenderFrame(event.senderFrame)) {
        return {
          ok: false,
          requestId: typeof envelope?.requestId === "string" ? envelope.requestId : "untrusted",
          error: {
            code: "unauthorized",
            message: "已拒绝来自未受信任 Frame 的桥接请求。",
            requestId: typeof envelope?.requestId === "string" ? envelope.requestId : "untrusted",
            retryable: false,
          },
        };
      }
      return dispatcher.dispatch(envelope);
    },
  );

  ipcMain.on(
    "hermes:subscribe",
    (
      event,
      args: { subscriptionId: string; topic: HostTopic; scope: BridgeScope | null },
    ) => {
      if (!isTrustedSenderFrame(event.senderFrame)) return;
      const check = validateHostTopic(args?.topic);
      if (!check.valid) return;

      if (args.topic === "fleet") {
        const snapshotEvent: BridgeEvent<FleetSnapshot> = {
          topic: "fleet",
          scope: null,
          kind: "snapshot",
          seq: 0,
          revision: 1,
          payload: emptyFleetSnapshot,
        };
        event.sender.send("hermes:event", args.subscriptionId, snapshotEvent);
      }
    },
  );

  ipcMain.on("hermes:unsubscribe", () => {
    // Subscription cleanup hook for streaming topics in subsequent tickets
  });

  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
