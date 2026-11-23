import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function resolveBuildGitMeta({
  repoRoot,
  buildMode = "dev",
  allowUnknownSha = false,
} = {}) {
  try {
    const gitSha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!gitSha) {
      throw new Error("Empty git SHA");
    }
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      gitSha,
      gitDirty: status.length > 0,
      source: "git",
      allowUnknownSha,
      buildMode,
    };
  } catch (err) {
    if (buildMode === "packaged" && !allowUnknownSha) {
      throw new Error(
        `[build-meta] Failed to resolve git SHA for packaged build (set ALLOW_UNKNOWN_SHA=1 to override): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {
      gitSha: "unknown",
      gitDirty: false,
      source: "unknown",
      allowUnknownSha,
      buildMode,
    };
  }
}

export function readDesktopPackageMeta(desktopRoot) {
  const pkgPath = path.join(desktopRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const electronVersion = String(pkg.devDependencies?.electron ?? "45.4.1").replace(/^[^0-9]*/, "");
  return {
    appVersion: String(pkg.version ?? "0.1.0"),
    electronVersion,
  };
}
