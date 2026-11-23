import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resetSandbox(repoRoot = process.cwd()) {
  const realHome = path.resolve(os.homedir());
  const realHermes = path.resolve(realHome, ".hermes");

  const targets = [
    path.resolve(repoRoot, ".dev", "user-data"),
    path.resolve(repoRoot, ".dev", "hermes-home"),
  ];

  for (const target of targets) {
    if (target === realHome || target === realHermes || target.startsWith(`${realHermes}${path.sep}`)) {
      throw new Error(`Refusing to remove unsafe path: ${target}`);
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
