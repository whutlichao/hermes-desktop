import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assertNotSymlink(targetPath) {
  if (!fs.existsSync(targetPath)) {
    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to remove symlink path: ${targetPath}`);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
    return;
  }
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove symlink path: ${targetPath}`);
  }
}

export function resetSandbox(repoRoot = process.cwd()) {
  const realHome = fs.realpathSync(os.homedir());
  const rawHermes = path.resolve(realHome, ".hermes");
  const realHermes = fs.existsSync(rawHermes) ? fs.realpathSync(rawHermes) : rawHermes;
  const realRepoRoot = fs.realpathSync(repoRoot);

  if (realRepoRoot === realHome) {
    throw new Error(`Refusing to reset sandbox in user home directory: ${realRepoRoot}`);
  }

  const devDir = path.join(realRepoRoot, ".dev");
  assertNotSymlink(devDir);

  const targets = [
    path.join(devDir, "user-data"),
    path.join(devDir, "hermes-home"),
  ];

  for (const target of targets) {
    assertNotSymlink(target);
    const resolvedTarget = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
    if (
      resolvedTarget === realHome ||
      resolvedTarget === realHermes ||
      resolvedTarget.startsWith(`${realHermes}${path.sep}`) ||
      !resolvedTarget.startsWith(`${devDir}${path.sep}`)
    ) {
      throw new Error(`Refusing to remove unsafe path: ${resolvedTarget}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  return targets;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const removed = resetSandbox(process.cwd());
  console.log(`[sandbox:reset] Cleared: ${removed.join(", ")}`);
}
