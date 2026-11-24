import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "dist-web" ||
      entry.name === "out" ||
      entry.name === "release"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

const isTsSource = (file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !/\.test\./.test(file);

const FORBIDDEN_NODE_OR_ELECTRON_IMPORT =
  /(?:from|import\s*\(|require\s*\()\s*["'](?:electron|node:|fs|net|http|https|child_process|os|path|crypto|dgram|tls|dns)/;

const FORBIDDEN_DOMAIN_IMPORT =
  /(?:from|import\s*\(|require\s*\()\s*["'](?:electron|node:|fs|net|http|https|child_process|os|path|crypto|dgram|tls|dns|react|react-dom)/;

export function verifyArchitecture(repoRoot = process.cwd()) {
  const errors = [];

  // 1. packages/contracts must have zero runtime dependencies
  const contractsPkgPath = path.join(repoRoot, "packages/contracts/package.json");
  if (fs.existsSync(contractsPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(contractsPkgPath, "utf8"));
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      errors.push(
        `packages/contracts must have zero runtime dependencies, found: ${Object.keys(pkg.dependencies).join(", ")}`,
      );
    }
  }

  // 2. packages/contracts/src must have no external/node/electron/domain imports or DOM refs
  const contractsFiles = walkFiles(path.join(repoRoot, "packages/contracts/src"), isTsSource);
  for (const file of contractsFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (FORBIDDEN_DOMAIN_IMPORT.test(content) || /from\s+["']@hermes\/domain["']/.test(content)) {
      errors.push(`Forbidden import in contracts: ${path.relative(repoRoot, file)}`);
    }
    if (/\b(?:window|document)\./.test(content)) {
      errors.push(`Forbidden DOM global reference in contracts: ${path.relative(repoRoot, file)}`);
    }
  }

  // 3. packages/domain/src must be pure TS (no electron, no fs/net/child_process/os/path, no DOM)
  const domainFiles = walkFiles(path.join(repoRoot, "packages/domain/src"), isTsSource);
  for (const file of domainFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (FORBIDDEN_DOMAIN_IMPORT.test(content)) {
      errors.push(`Forbidden runtime/platform import in domain: ${path.relative(repoRoot, file)}`);
    }
    if (/\b(?:window|document|localStorage|sessionStorage|navigator)\b/.test(content)) {
      errors.push(`Forbidden DOM/global reference in domain: ${path.relative(repoRoot, file)}`);
    }
  }

  // 4. apps/desktop/src/renderer must not import electron, node:*, read process.versions/env/__dirname, or reference MockHostBridge
  const rendererFiles = walkFiles(path.join(repoRoot, "apps/desktop/src/renderer"), isTsSource);
  for (const file of rendererFiles) {
    const rel = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, "utf8");
    if (FORBIDDEN_NODE_OR_ELECTRON_IMPORT.test(content)) {
      errors.push(`Forbidden Electron/Node import in renderer: ${rel}`);
    }
    if (/\bprocess\.(?:versions|env)\b|\b__dirname\b|\b__filename\b/.test(content)) {
      errors.push(`Forbidden Node/build global in renderer: ${rel}`);
    }
    if (content.includes("MockHostBridge")) {
      errors.push(`Renderer must not directly reference MockHostBridge (use @hermes/host-adapter): ${rel}`);
    }
  }

  // 5. apps/desktop/src/preload must only import electron (contextBridge/ipcRenderer) + @hermes/contracts and only expose hermesHost
  const preloadFiles = walkFiles(path.join(repoRoot, "apps/desktop/src/preload"), isTsSource);
  for (const file of preloadFiles) {
    const rel = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, "utf8");

    const importMatches = [...content.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)];
    for (const match of importMatches) {
      const target = match[1];
      if (target !== "electron" && target !== "@hermes/contracts") {
        errors.push(`Forbidden import "${target}" in preload (only electron and @hermes/contracts allowed): ${rel}`);
      }
    }

    const exposeMatches = [...content.matchAll(/exposeInMainWorld\(\s*["']([^"']+)["']/g)];
    for (const match of exposeMatches) {
      if (match[1] !== "hermesHost") {
        errors.push(`Forbidden preload exposed global "${match[1]}" (only hermesHost allowed): ${rel}`);
      }
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
