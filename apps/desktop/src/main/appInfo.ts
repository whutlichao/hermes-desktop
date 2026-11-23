import { execFileSync } from "node:child_process";
import os from "node:os";
import type { AppInfo } from "@hermes/contracts";
import { assertAppInfoSafe } from "@hermes/domain";

export interface GitInfo {
  gitSha: string;
  gitDirty: boolean;
  source: "git" | "unknown";
}

export interface EmbeddedBuildMeta {
  gitSha: string;
  gitDirty: boolean;
  source: "git" | "unknown";
  allowUnknownSha?: boolean;
  buildMode?: "dev" | "packaged";
}

export interface ResolveGitInfoOptions {
  repoRoot?: string;
  buildMode: "dev" | "packaged";
  allowUnknownSha?: boolean;
  execGit?: (args: string[], cwd: string) => string;
}

function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function resolveGitInfo(options: ResolveGitInfoOptions): GitInfo {
  const execGit = options.execGit ?? defaultExecGit;
  if (options.repoRoot) {
    try {
      const sha = execGit(["rev-parse", "--short=8", "HEAD"], options.repoRoot).trim();
      if (sha) {
        const porcelain = execGit(["status", "--porcelain"], options.repoRoot).trim();
        return {
          gitSha: sha,
          gitDirty: porcelain.length > 0,
          source: "git",
        };
      }
    } catch {
      // Fall through to buildMode policy below
    }
  }

  if (options.buildMode === "packaged" && !options.allowUnknownSha) {
    throw new Error(
      "Unable to resolve git SHA for packaged build; set ALLOW_UNKNOWN_SHA=1 to override",
    );
  }

  return {
    gitSha: "unknown",
    gitDirty: false,
    source: "unknown",
  };
}

export interface CreateMainAppInfoOptions {
  appVersion: string;
  isPackaged: boolean;
  embeddedMeta?: EmbeddedBuildMeta;
  repoRoot?: string;
  allowUnknownSha?: boolean;
  versions?: {
    electron?: string;
    chrome?: string;
    node?: string;
  };
  platform?: string;
  arch?: string;
  macOSVersion?: string;
  capabilitiesReady?: boolean;
}

export function createMainAppInfo(options: CreateMainAppInfoOptions): AppInfo {
  const buildMode: "dev" | "packaged" = options.isPackaged ? "packaged" : "dev";
  const allowUnknown = Boolean(options.allowUnknownSha || options.embeddedMeta?.allowUnknownSha);

  let gitInfo: GitInfo;
  if (buildMode === "packaged") {
    if (options.embeddedMeta && (options.embeddedMeta.source === "git" || allowUnknown)) {
      gitInfo = {
        gitSha: options.embeddedMeta.gitSha || "unknown",
        gitDirty: Boolean(options.embeddedMeta.gitDirty),
        source: options.embeddedMeta.source === "git" ? "git" : "unknown",
      };
    } else {
      gitInfo = resolveGitInfo({
        repoRoot: options.repoRoot,
        buildMode: "packaged",
        allowUnknownSha: allowUnknown,
      });
    }
  } else {
    const live = resolveGitInfo({
      repoRoot: options.repoRoot,
      buildMode: "dev",
      allowUnknownSha: true,
    });
    if (live.source === "git") {
      gitInfo = live;
    } else if (options.embeddedMeta?.source === "git") {
      gitInfo = {
        gitSha: options.embeddedMeta.gitSha,
        gitDirty: options.embeddedMeta.gitDirty,
        source: "git",
      };
    } else {
      gitInfo = live;
    }
  }

  const versions = options.versions ?? process.versions;
  const platform = options.platform ?? process.platform;
  const rawArch = options.arch ?? process.arch;
  const arch: "arm64" | "x64" = rawArch === "x64" ? "x64" : "arm64";
  const macOSVersion =
    platform === "darwin"
      ? options.macOSVersion ??
        (typeof (process as { getSystemVersion?: () => string }).getSystemVersion === "function"
          ? (process as { getSystemVersion: () => string }).getSystemVersion()
          : os.release())
      : undefined;

  const info: AppInfo = {
    bridgeVersion: 1,
    appName: "Hermes Desktop",
    appVersion: options.appVersion,
    gitSha: gitInfo.gitSha,
    gitDirty: gitInfo.gitDirty,
    buildMode,
    distribution: "local-unsigned",
    electronVersion: versions.electron ?? "0.0.0",
    chromiumVersion: versions.chrome ?? "0.0.0",
    nodeVersion: versions.node ?? process.version.replace(/^v/, ""),
    arch,
    ...(macOSVersion ? { macOSVersion } : {}),
    source: gitInfo.source,
    mode: "electron",
    platform,
    capabilitiesReady: Boolean(options.capabilitiesReady),
  };

  return assertAppInfoSafe(info);
}
