import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import {
  type AppCommand,
  type AppInfo,
  type BridgeScope,
  type HostRequestEnvelope,
  type HostTopic,
} from "@hermes/contracts";
import { createBridgeDispatcher, formatAppInfoDisplay, validateHostTopic } from "@hermes/domain";
import { createMainAppInfo, type EmbeddedBuildMeta } from "./appInfo";
import { ConnectionSupervisor } from "./connectionSupervisor";
import { LocalBackendManager, createNodeLocalBackendPorts } from "./localBackendManager";
import { RemoteAuthManager } from "./remoteGateway";
import {
  buildAppMenuSpec,
  buildCspHeader,
  confirmRealHomeAccess,
  createHardenedWebPreferences,
  isAllowedExternalUrl,
  resolveSandboxPaths,
} from "./security";
import { createRegistryBridgeHandlers } from "./registryBridge";
import { RegistryStore } from "./registryStore";

declare const __HERMES_BUILD_META__: EmbeddedBuildMeta | undefined;

const devRepoRoot = path.resolve(__dirname, "../../../..");
const sandboxBaseRoot = app.isPackaged ? app.getPath("userData") : devRepoRoot;
const sandbox = resolveSandboxPaths({ repoRoot: sandboxBaseRoot, env: process.env });

fs.mkdirSync(sandbox.userDataDir, { recursive: true, mode: 0o700 });
app.setPath("userData", sandbox.userDataDir);
process.env.HERMES_HOME = sandbox.hermesHomeDir;

const registryStore = new RegistryStore({
  rootDir: sandbox.hermesHomeDir,
  allowRealHome: sandbox.isRealHomeAllowed,
});
registryStore.startWatching();
const activeSubscriptions = new Map<string, () => void>();

const embeddedBuildMeta =
  typeof __HERMES_BUILD_META__ !== "undefined" ? __HERMES_BUILD_META__ : undefined;

const mainAppInfo: AppInfo = createMainAppInfo({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  embeddedMeta: embeddedBuildMeta,
  repoRoot: app.isPackaged ? undefined : devRepoRoot,
  allowUnknownSha: process.env.ALLOW_UNKNOWN_SHA === "1",
});
const appDisplay = formatAppInfoDisplay(mainAppInfo);

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let rendererReady = false;
const pendingCommands: AppCommand[] = [];

function showNativeAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: mainAppInfo.appName,
    applicationVersion: mainAppInfo.appVersion,
    version: appDisplay.shaLabel,
    credits: `${appDisplay.headline}\n${appDisplay.buildLine}\n${appDisplay.runtimeLine}`,
  });
  app.showAboutPanel();
}

function dispatchAppCommand(command: AppCommand): void {
  if (command.type === "open_about") {
    showNativeAboutPanel();
    return;
  }
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

const defaultDevHermesHome = path.join(devRepoRoot, ".dev", "hermes-home");
const hermesHomeKind: "sandbox" | "real" | "temp" = sandbox.isRealHomeAllowed
  ? "real"
  : path.resolve(sandbox.hermesHomeDir) === path.resolve(defaultDevHermesHome)
    ? "sandbox"
    : "temp";

const localPorts = createNodeLocalBackendPorts({
  userDataDir: sandbox.userDataDir,
  hermesHomeDir: sandbox.hermesHomeDir,
  hermesHomeKind,
  appVersion: app.getVersion(),
  buildMode: app.isPackaged ? "packaged" : "dev",
  pickCliFile: async () => {
    const targetWin = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const openOptions: Electron.OpenDialogOptions = {
      title: "选择 hermes CLI 可执行文件",
      properties: ["openFile"],
    };
    const result = targetWin
      ? await dialog.showOpenDialog(targetWin, openOptions)
      : await dialog.showOpenDialog(openOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, filePath: result.filePaths[0] };
  },
});

const localBackendManager = new LocalBackendManager(localPorts);
let connectionSupervisor: ConnectionSupervisor;
const remoteAuthManager = new RemoteAuthManager({
  registryStore,
  openExternal: async (targetUrl) => {
    if (!isAllowedExternalUrl(targetUrl)) {
      const err = new Error("Unsupported URL scheme");
      (err as { code?: string }).code = "permission_denied";
      throw err;
    }
    await shell.openExternal(targetUrl);
  },
  onConnectionAuthorized: (connectionId) => {
    void connectionSupervisor?.connectRemote(connectionId, {
      forceReconnect: true,
      activate: true,
    });
  },
});
connectionSupervisor = new ConnectionSupervisor(localBackendManager, {
  getLocalLabel: () =>
    registryStore.snapshot().connections.find((conn) => conn.id === "local")?.label ?? "This device",
  registryStore,
  authManager: remoteAuthManager,
});
const registryBridge = createRegistryBridgeHandlers(registryStore, {
  authManager: remoteAuthManager,
  onConnectionCommitted: ({ action, connectionId, snapshot, activate }) => {
    const conn = snapshot.connections.find((c) => c.id === connectionId);
    if (!conn || conn.kind !== "remote" || !conn.dialable) return;
    if (action === "add" || activate) {
      void connectionSupervisor.connectRemote(connectionId, {
        forceReconnect: true,
        activate: true,
      });
    }
  },
});

function shouldAutoDialLocalOnStartup(): boolean {
  if (process.env.HERMES_LOCAL_AUTO_DIAL === "1") return true;
  if (hermesHomeKind !== "temp") return true;
  if (fs.existsSync(path.join(sandbox.userDataDir, "local-preferences.json"))) return true;
  return localPorts.getControlSocketCandidates().some((sockPath) => fs.existsSync(sockPath));
}

const dispatcher = createBridgeDispatcher({
  "bridge.hello": async (): Promise<AppInfo> => {
    rendererReady = true;
    queueMicrotask(flushPendingCommands);
    return mainAppInfo;
  },
  ...registryBridge.handlers,
  ...connectionSupervisor.handlers,
  "local.inspect": async () => localBackendManager.inspect(),
  "local.selectCli": async () => {
    const res = await localBackendManager.selectCli();
    if (!res.cancelled && res.inspection.actual === "ready") {
      void connectionSupervisor.connectLocal("default", { forceReconnect: true });
    }
    return res;
  },
  "local.diagnose": async () => localBackendManager.diagnose(),
  "diagnostics.export": async () => {
    const base = await localBackendManager.diagnose();
    return {
      ...base,
      appInfo: mainAppInfo,
      display: appDisplay,
      sandboxed: !sandbox.isRealHomeAllowed,
      connectionsCount: registryStore.snapshot().connections.length,
      registry: registryStore.exportSafeSummary(),
    };
  },
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

app.whenReady().then(async () => {
  const realHomeConfirmed = await confirmRealHomeAccess({
    sandbox,
    showConfirmDialog: async (prompt) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        buttons: ["取消启动", "继续连接真实 ~/.hermes"],
        defaultId: 0,
        cancelId: 0,
        title: prompt.title,
        message: prompt.message,
        detail: prompt.detail,
      });
      return result.response === 1;
    },
  });

  if (!realHomeConfirmed) {
    app.quit();
    return;
  }

  fs.mkdirSync(sandbox.hermesHomeDir, { recursive: true, mode: 0o700 });

  app.setAboutPanelOptions({
    applicationName: mainAppInfo.appName,
    applicationVersion: mainAppInfo.appVersion,
    version: appDisplay.shaLabel,
    credits: `${appDisplay.headline}\n${appDisplay.buildLine}\n${appDisplay.runtimeLine}`,
  });

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

      const existing = activeSubscriptions.get(args.subscriptionId);
      existing?.();

      if (args.topic === "registry") {
        const unsub = registryBridge.subscribeRegistry((registryEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("hermes:event", args.subscriptionId, registryEvent);
          }
        });
        activeSubscriptions.set(args.subscriptionId, unsub);
      } else if (args.topic === "auth.state") {
        const unsub = registryBridge.subscribeAuthState((authEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("hermes:event", args.subscriptionId, authEvent);
          }
        });
        activeSubscriptions.set(args.subscriptionId, unsub);
      } else if (
        args.topic === "fleet" ||
        args.topic === "connection.health" ||
        args.topic === "profiles" ||
        args.topic === "sessions" ||
        args.topic === "session.transcript" ||
        args.topic === "prompt" ||
        args.topic === "activity"
      ) {
        const unsub = connectionSupervisor.subscribe(args.topic, args.scope ?? null, (bridgeEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("hermes:event", args.subscriptionId, bridgeEvent);
          }
        });
        activeSubscriptions.set(args.subscriptionId, unsub);
      }
    },
  );

  ipcMain.on("hermes:unsubscribe", (_event, args?: { subscriptionId?: string }) => {
    const subId = args?.subscriptionId;
    if (!subId) return;
    const unsub = activeSubscriptions.get(subId);
    if (unsub) {
      unsub();
      activeSubscriptions.delete(subId);
    }
  });

  mainWindow = createMainWindow();
  if (shouldAutoDialLocalOnStartup()) {
    void connectionSupervisor.connectLocal("default");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  remoteAuthManager.dispose();
  for (const unsub of activeSubscriptions.values()) {
    unsub();
  }
  activeSubscriptions.clear();
  void connectionSupervisor.dispose();
  void registryStore.flush(2000).finally(() => {
    registryStore.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
