import os from "node:os";
import path from "node:path";
import type { AppCommand } from "@hermes/contracts";

export interface SandboxPathOptions {
  repoRoot: string;
  env: Record<string, string | undefined>;
}

export interface SandboxPaths {
  userDataDir: string;
  hermesHomeDir: string;
  isRealHomeAllowed: boolean;
}

export function assertSafeSandboxRoot(
  targetPath: string,
  options: { allowRealHome: boolean },
): string {
  const resolved = path.resolve(targetPath);
  if (options.allowRealHome) {
    return resolved;
  }

  const homeDir = path.resolve(os.homedir());
  const realHermesDir = path.resolve(homeDir, ".hermes");

  if (
    resolved === homeDir ||
    resolved === realHermesDir ||
    resolved.startsWith(`${realHermesDir}${path.sep}`)
  ) {
    throw new Error(
      `Refusing unsafe sandbox path pointing to real home or ~/.hermes: ${resolved}`,
    );
  }
  return resolved;
}

export function resolveSandboxPaths(options: SandboxPathOptions): SandboxPaths {
  const allowRealHome = options.env.HERMES_ALLOW_REAL_HOME === "1";
  const defaultUserData = path.join(options.repoRoot, ".dev", "user-data");
  const defaultHermesHome = path.join(options.repoRoot, ".dev", "hermes-home");

  const userDataDir = assertSafeSandboxRoot(
    options.env.HERMES_USER_DATA_DIR || defaultUserData,
    { allowRealHome },
  );
  const hermesHomeDir = assertSafeSandboxRoot(
    options.env.HERMES_HOME || defaultHermesHome,
    { allowRealHome },
  );

  return {
    userDataDir,
    hermesHomeDir,
    isRealHomeAllowed: allowRealHome,
  };
}

export function requiresRealHomeConfirmation(sandbox: SandboxPaths): boolean {
  return sandbox.isRealHomeAllowed;
}

export async function confirmRealHomeAccess(options: {
  sandbox: SandboxPaths;
  showConfirmDialog: (prompt: {
    title: string;
    message: string;
    detail: string;
  }) => Promise<boolean> | boolean;
}): Promise<boolean> {
  if (!requiresRealHomeConfirmation(options.sandbox)) {
    return true;
  }
  return options.showConfirmDialog({
    title: "确认连接真实 ~/.hermes",
    message: "即将以开发模式连接真实本机 Hermes 配置目录",
    detail: "此操作可能读取真实 Gateway Connection 与本地状态，仅在明确需要调试本机环境时继续。",
  });
}

export interface HardenedWebPreferences {
  preload: string;
  contextIsolation: true;
  sandbox: true;
  nodeIntegration: false;
  nodeIntegrationInWorker: false;
  nodeIntegrationInSubFrames: false;
  webSecurity: true;
  allowRunningInsecureContent: false;
  webviewTag: false;
  spellcheck: false;
}

export function createHardenedWebPreferences(preloadPath: string): HardenedWebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}

export function buildCspHeader(isDev: boolean): string {
  const connectSrc = isDev ? "'self' ws://localhost:4173 http://localhost:4173" : "'self'";
  const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export interface MenuItemSpec {
  label?: string;
  role?: string;
  type?: "separator";
  accelerator?: string;
  click?: () => void;
  submenu?: MenuItemSpec[];
}

export function buildAppMenuSpec(
  dispatchCommand: (command: AppCommand) => void,
): MenuItemSpec[] {
  return [
    {
      label: "Hermes Desktop",
      submenu: [
        {
          label: "关于 Hermes Desktop",
          click: () => dispatchCommand({ type: "open_about" }),
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchCommand({ type: "open_settings" }),
        },
        { type: "separator" },
        {
          label: "退出 Hermes Desktop",
          accelerator: "CmdOrCtrl+Q",
          role: "quit",
        },
      ],
    },
    {
      label: "Session",
      submenu: [
        {
          label: "新建 Session",
          accelerator: "CmdOrCtrl+N",
          click: () => dispatchCommand({ type: "new_session" }),
        },
        { type: "separator" },
        {
          label: "关闭窗口",
          accelerator: "CmdOrCtrl+W",
          click: () => dispatchCommand({ type: "close_window" }),
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        {
          label: "命令面板",
          accelerator: "CmdOrCtrl+K",
          click: () => dispatchCommand({ type: "open_palette" }),
        },
        {
          label: "切换 Workspace",
          accelerator: "CmdOrCtrl+B",
          click: () => dispatchCommand({ type: "toggle_workspace" }),
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "键盘快捷键",
          accelerator: "CmdOrCtrl+Shift+/",
          click: () => dispatchCommand({ type: "open_shortcuts" }),
        },
      ],
    },
  ];
}
