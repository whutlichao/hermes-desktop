import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const isTsSource = (file) => /\.(ts|tsx|js|jsx|mjs)$/.test(file) && !/\.test\./.test(file);

export function verifyArchitecture(repoRoot = process.cwd()) {
  const errors = [];

  // 1. packages/contracts must have zero runtime dependencies
  const contractsPkgPath = path.join(repoRoot, "packages/contracts/package.json");
  if (fs.existsSync(contractsPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(contractsPkgPath, "utf8"));
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      errors.push(`packages/contracts must have zero runtime dependencies, found: ${Object.keys(pkg.dependencies).join(", ")}`);
    }
  }

  // 2. packages/contracts/src must have no external/node/electron/domain imports
  const contractsFiles = walkFiles(path.join(repoRoot, "packages/contracts/src"), isTsSource);
  for (const file of contractsFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (/from\s+["'](?:electron|node:|fs|net|react|@hermes\/domain)/.test(content)) {
      errors.push(`Forbidden import in contracts: ${path.relative(repoRoot, file)}`);
    }
    if (/\b(?:window|document)\./.test(content)) {
      errors.push(`Forbidden DOM global reference in contracts: ${path.relative(repoRoot, file)}`);
    }
  }

  // 3. packages/domain/src must be pure TS (no electron, no fs/net/child_process, no DOM)
  const domainFiles = walkFiles(path.join(repoRoot, "packages/domain/src"), isTsSource);
  for (const file of domainFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (/from\s+["'](?:electron|node:|fs|net|http|https|child_process|react)/.test(content)) {
      errors.push(`Forbidden runtime/platform import in domain: ${path.relative(repoRoot, file)}`);
    }
    if (/\b(?:window|document|localStorage|sessionStorage)\b/.test(content)) {
      errors.push(`Forbidden DOM/global reference in domain: ${path.relative(repoRoot, file)}`);
    }
  }

  // 4. apps/desktop/src/renderer must not import electron, node:*, or MockHostBridge directly
  const rendererFiles = walkFiles(path.join(repoRoot, "apps/desktop/src/renderer"), isTsSource);
  for (const file of rendererFiles) {
    const rel = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, "utf8");
    if (/from\s+["'](?:electron|node:|fs|net|child_process)/.test(content)) {
      errors.push(`Forbidden Electron/Node import in renderer: ${rel}`);
    }
    if (content.includes("MockHostBridge")) {
      errors.push(`Renderer must not directly reference MockHostBridge (use @hermes/host-adapter): ${rel}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = verifyArchitecture(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`[verify:architecture] ${err}`);
    process.exit(1);
  }
  console.log("[verify:architecture] OK");
}
