import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNoMockInBuild } from "./verify-no-mock-in-build.mjs";
import { verifyNoOfficialDesktop } from "./verify-no-official-desktop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(repoRoot, "apps/desktop/release");

function findPackagedApp(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "Hermes Desktop.app") return full;
      const nested = findPackagedApp(full);
      if (nested) return nested;
    }
  }
  return null;
}

const appPath = findPackagedApp(releaseDir);
if (!appPath) {
  console.error("[smoke:packaged] Hermes Desktop.app not found; run pnpm package:mac first");
  process.exit(1);
}

// 1. Codesign strict verification
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  stdio: "inherit",
});

// 2. Ensure no latest-mac.yml exists
for (const entry of fs.readdirSync(releaseDir, { recursive: true })) {
  if (String(entry).includes("latest-mac")) {
    console.error(`[smoke:packaged] Forbidden auto-updater manifest found: ${entry}`);
    process.exit(1);
  }
}

// 3. ASAR guard: verify:no-mock-in-build & verify:no-official-desktop with --require-asar
const noMock = verifyNoMockInBuild(repoRoot, { requireAsar: true });
if (!noMock.ok) {
  for (const err of noMock.errors) console.error(`[smoke:packaged] ${err}`);
  process.exit(1);
}

const noOfficial = verifyNoOfficialDesktop(repoRoot, { requireAsar: true });
if (!noOfficial.ok) {
  for (const err of noOfficial.errors) console.error(`[smoke:packaged] ${err}`);
  process.exit(1);
}

// 4. Launch packaged .app binary via Playwright Electron test
execFileSync(
  "pnpm",
  ["exec", "playwright", "test", "--config", "playwright.electron.config.ts"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      HERMES_PACKAGED_APP_PATH: appPath,
    },
  },
);

console.log("[smoke:packaged] OK");
