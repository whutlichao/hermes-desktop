import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildGitMeta } from "./build-meta.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const desktopDir = path.join(repoRoot, "apps/desktop");
const releaseDir = path.join(desktopDir, "release");

function run(cmd, args, cwd, extraEnv = {}) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function findPackagedApp(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "Hermes Desktop.app") {
        return full;
      }
      const nested = findPackagedApp(full);
      if (nested) return nested;
    }
  }
  return null;
}

function isMachOExecutable(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const magic = Buffer.alloc(4);
      if (fs.readSync(fd, magic, 0, 4, 0) < 4) return false;
      const u32 = magic.readUInt32BE(0);
      // Mach-O 32/64/FAT magic numbers (BE and LE)
      return (
        u32 === 0xfeedface ||
        u32 === 0xcefaedfe ||
        u32 === 0xfeedfacf ||
        u32 === 0xcffaedfe ||
        u32 === 0xcafebabe ||
        u32 === 0xbebafeca
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function collectNestedSignTargets(appPath) {
  const targets = [];
  const contentsDir = path.join(appPath, "Contents");
  const frameworksDir = path.join(contentsDir, "Frameworks");
  if (fs.existsSync(frameworksDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith(".app") || entry.name.endsWith(".framework")) {
            walk(full);
            targets.push(full);
          } else {
            walk(full);
          }
        } else if (entry.isFile()) {
          if (
            entry.name.endsWith(".dylib") ||
            entry.name.endsWith(".node") ||
            entry.name.endsWith(".so") ||
            isMachOExecutable(full)
          ) {
            targets.push(full);
          }
        }
      }
    };
    walk(frameworksDir);
  }
  return targets;
}

export function adHocSignAndVerifyApp(appPath) {
  if (process.platform !== "darwin") {
    throw new Error("adHocSignAndVerifyApp requires macOS");
  }
  const nested = collectNestedSignTargets(appPath);
  for (const target of nested) {
    execFileSync("codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });
  }
  execFileSync("codesign", ["--force", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
}

function assertNoLatestMacYml(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoLatestMacYml(full);
    } else if (entry.name.startsWith("latest-mac")) {
      throw new Error(`Unexpected auto-updater metadata file generated: ${full}`);
    }
  }
}

export function packageMac({ dist = false, arch = process.arch === "x64" ? "x64" : "arm64" } = {}) {
  const allowUnknownSha = process.env.ALLOW_UNKNOWN_SHA === "1";
  const gitMeta = resolveBuildGitMeta({
    repoRoot,
    buildMode: "packaged",
    allowUnknownSha,
  });
  console.log(
    `[package:mac] Resolved packaged git meta: sha=${gitMeta.gitSha} dirty=${gitMeta.gitDirty} source=${gitMeta.source} arch=${arch}`,
  );

  // Build contracts, domain, and electron-vite outputs with packaged metadata
  const buildEnv = {
    HERMES_BUILD_MODE: "packaged",
    ALLOW_UNKNOWN_SHA: allowUnknownSha ? "1" : "0",
  };
  run("pnpm", ["--filter", "@hermes/contracts", "build"], repoRoot, buildEnv);
  run("pnpm", ["--filter", "@hermes/domain", "build"], repoRoot, buildEnv);
  run("pnpm", ["--filter", "@hermes/desktop", "build"], repoRoot, buildEnv);

  fs.rmSync(releaseDir, { recursive: true, force: true });

  const ebBin = path.join(desktopDir, "node_modules/.bin/electron-builder");
  const ebEnv = {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "true",
  };

  run(
    ebBin,
    ["--mac", "dir", `--${arch}`, "--config", "electron-builder.json", "-c.mac.identity=null"],
    desktopDir,
    ebEnv,
  );

  const appPath = findPackagedApp(releaseDir);
  if (!appPath) {
    throw new Error(`Packaged Hermes Desktop.app not found under ${releaseDir}`);
  }

  adHocSignAndVerifyApp(appPath);

  if (dist) {
    run(
      ebBin,
      [
        "--prepackaged",
        appPath,
        "--mac",
        "dmg",
        "zip",
        `--${arch}`,
        "--config",
        "electron-builder.json",
        "-c.mac.identity=null",
      ],
      desktopDir,
      ebEnv,
    );
  }

  assertNoLatestMacYml(releaseDir);
  console.log(`[package:mac] Packaged and ad-hoc signed OK: ${path.relative(repoRoot, appPath)}`);
  return appPath;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const dist = process.argv.includes("--dist");
  const archArg = process.argv.find((a) => a.startsWith("--arch="));
  const arch = archArg ? archArg.split("=")[1] : process.arch === "x64" ? "x64" : "arm64";
  packageMac({ dist, arch });
}
