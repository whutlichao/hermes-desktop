import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOCK_MARKERS = [
  "MockHostBridge",
  "createMockHostBridge",
  "__HERMES_MOCK_HOST__",
  "VITE_HOST_MODE",
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

export function verifyNoMockInBuild(repoRoot = process.cwd()) {
  const outDir = path.join(repoRoot, "apps/desktop/out");
  if (!fs.existsSync(outDir)) {
    return {
      ok: false,
      errors: ["apps/desktop/out does not exist; run pnpm build before verify:no-mock-in-build"],
    };
  }

  const errors = [];
  for (const file of walkFiles(outDir)) {
    const content = fs.readFileSync(file, "utf8");
    for (const marker of MOCK_MARKERS) {
      if (content.includes(marker)) {
        errors.push(`Found forbidden mock marker "${marker}" in Electron build output: ${path.relative(repoRoot, file)}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = verifyNoMockInBuild(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`[verify:no-mock-in-build] ${err}`);
    process.exit(1);
  }
  console.log("[verify:no-mock-in-build] OK");
}
