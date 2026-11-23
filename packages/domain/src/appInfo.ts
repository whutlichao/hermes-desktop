import type { AppInfo } from "@hermes/contracts";

export interface AppInfoDisplay {
  shaLabel: string;
  headline: string;
  buildLine: string;
  runtimeLine: string;
  updatesNotice: string;
}

const APP_INFO_ALLOWED_KEYS = new Set<string>([
  "bridgeVersion",
  "appName",
  "appVersion",
  "gitSha",
  "gitDirty",
  "buildMode",
  "distribution",
  "electronVersion",
  "chromiumVersion",
  "nodeVersion",
  "arch",
  "macOSVersion",
  "source",
  "mode",
  "platform",
  "capabilitiesReady",
]);

const FORBIDDEN_VALUE_PATTERNS = [
  /\/(?:Users|home|var|tmp|private|etc)\//i,
  /[A-Za-z]:\\/,
  /\b(?:wss?|https?):\/\//i,
  /\bBearer\s+/i,
  /__dirname/i,
  /\n\s*at\s+/,
];

/**
 * Formats the SHA badge identically for dev and packaged builds.
 */
export function formatAppShaLabel(
  info: Pick<AppInfo, "gitSha" | "gitDirty" | "buildMode" | "source">,
): string {
  const isUnknown = info.source === "unknown" || !info.gitSha || info.gitSha === "unknown";
  if (info.buildMode === "dev") {
    if (isUnknown) return "dev+unknown";
    return `dev+${info.gitSha}${info.gitDirty ? ".dirty" : ""}`;
  }
  if (isUnknown) return "unknown";
  return `${info.gitSha}${info.gitDirty ? ".dirty" : ""}`;
}

/**
 * Projects an AppInfo object into canonical display lines shared by
 * native About, Settings -> About, and Diagnostics.
 */
export function formatAppInfoDisplay(info: AppInfo): AppInfoDisplay {
  const shaLabel = formatAppShaLabel(info);
  return {
    shaLabel,
    headline: `${info.appName} ${info.appVersion} (${shaLabel})`,
    buildLine: `本地开发构建 · ${info.arch}`,
    runtimeLine: `Electron ${info.electronVersion} · Chromium ${info.chromiumVersion} · Node ${info.nodeVersion}`,
    updatesNotice: "本地开发构建，不检查更新",
  };
}

/**
 * Enforces the display-safe whitelist and rejects leaked paths, env, commands, URLs, or serials.
 */
export function assertAppInfoSafe(info: AppInfo): AppInfo {
  const record = info as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!APP_INFO_ALLOWED_KEYS.has(key)) {
      throw new Error(`Unexpected AppInfo field rejected: ${key}`);
    }
    const val = record[key];
    if (typeof val === "string") {
      for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(val)) {
          throw new Error(`Unsafe content rejected in AppInfo.${key}`);
        }
      }
    }
  }
  if (info.distribution !== "local-unsigned") {
    throw new Error(`Unsupported AppInfo distribution: ${String(info.distribution)}`);
  }
  if (info.arch !== "arm64" && info.arch !== "x64") {
    throw new Error(`Unsupported AppInfo arch: ${String(info.arch)}`);
  }
  return info;
}
