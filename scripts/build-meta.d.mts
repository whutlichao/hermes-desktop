export interface BuildGitMeta {
  gitSha: string;
  gitDirty: boolean;
  source: "git" | "unknown";
  allowUnknownSha: boolean;
  buildMode: "dev" | "packaged";
}

export function resolveBuildGitMeta(options?: {
  repoRoot?: string;
  buildMode?: "dev" | "packaged";
  allowUnknownSha?: boolean;
}): BuildGitMeta;

export function readDesktopPackageMeta(desktopRoot: string): {
  appVersion: string;
  electronVersion: string;
};
