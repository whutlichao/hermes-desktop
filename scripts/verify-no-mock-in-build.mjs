import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAsarArchives, readAsarArchive, readAsarEntryBuffer } from "./asar-reader.mjs";

const MOCK_MARKERS = [
  "MockHostBridge",
  "createMockHostBridge",
  "__HERMES_MOCK_HOST__",
  "__HERMES_MOCK_BUILD_META__",
  "VITE_HOST_MODE",
  "?demo=",
  "demo=1",
  "SIMULATED DATA",
];

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (/\.(js|mjs|cjs|html)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function scanTextForMockMarkers(content, location, errors) {
  for (const marker of MOCK_MARKERS) {
    if (content.includes(marker)) {
      errors.push(`Found forbidden mock marker "${marker}" in ${location}`);
    }
  }
}

export function verifyNoMockInBuild(repoRoot = process.cwd(), options = {}) {
  const outDir = path.join(repoRoot, "apps/desktop/out");
  const archives = findAsarArchives(repoRoot);
  const errors = [];

  if (!fs.existsSync(outDir) && archives.length === 0) {
    return {
      ok: false,
      errors: ["apps/desktop/out does not exist; run pnpm build before verify:no-mock-in-build"],
    };
  }

  if (fs.existsSync(outDir)) {
    for (const file of walkFiles(outDir)) {
      const content = fs.readFileSync(file, "utf8");
      scanTextForMockMarkers(content, `Electron build output: ${path.relative(repoRoot, file)}`, errors);
    }
  }

  if (options.requireAsar && archives.length === 0) {
    errors.push("No packaged app.asar found under apps/desktop/release; run pnpm package:mac first");
  }

  for (const asarPath of archives) {
    const relAsar = path.relative(repoRoot, asarPath);
    const { baseOffset, entries } = readAsarArchive(asarPath);
    for (const entry of entries) {
      if (/\.(js|mjs|cjs|html)$/i.test(entry.relPath)) {
        const content = readAsarEntryBuffer(asarPath, baseOffset, entry).toString("utf8");
        scanTextForMockMarkers(content, `${relAsar}:${entry.relPath}`, errors);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const requireAsar = process.argv.includes("--require-asar");
  const result = verifyNoMockInBuild(process.cwd(), { requireAsar });
  if (!result.ok) {
    for (const err of result.errors) console.error(`[verify:no-mock-in-build] ${err}`);
    process.exit(1);
  }
  console.log("[verify:no-mock-in-build] OK");
}
