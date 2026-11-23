import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_PATTERNS = [
  { label: "@hermes/plugin-sdk", regex: /@hermes\/plugin-sdk/ },
  { label: "Hermes.app", regex: /Hermes\.app/ },
  { label: "hermes:// custom scheme", regex: /hermes:\/\// },
  { label: "plugins.manage", regex: /plugins\.manage/ },
  { label: "plugins.catalog.lookup", regex: /plugins\.catalog\.lookup/ },
  { label: "app.asar official scan", regex: /app\.asar/ },
];

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

const isSource = (file) => /\.(ts|tsx|js|jsx|mjs|json)$/.test(file) && !/\.test\./.test(file);

export function verifyNoOfficialDesktop(repoRoot = process.cwd()) {
  const errors = [];
  const dirs = [path.join(repoRoot, "packages"), path.join(repoRoot, "apps")];
  for (const dir of dirs) {
    for (const file of walkFiles(dir, isSource)) {
      const content = fs.readFileSync(file, "utf8");
      for (const { label, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(content)) {
          errors.push(`Forbidden official desktop reference (${label}) in ${path.relative(repoRoot, file)}`);
        }
      }
    }
  }

  const rootPkg = path.join(repoRoot, "package.json");
  if (fs.existsSync(rootPkg)) {
    const content = fs.readFileSync(rootPkg, "utf8");
    if (/@hermes\/plugin-sdk/.test(content)) {
      errors.push("Forbidden @hermes/plugin-sdk dependency in root package.json");
    }
  }

  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = verifyNoOfficialDesktop(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`[verify:no-official-desktop] ${err}`);
    process.exit(1);
  }
  console.log("[verify:no-official-desktop] OK");
}
