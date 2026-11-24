import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAsarArchives, readAsarArchive, readAsarEntryBuffer } from "./asar-reader.mjs";

const ALLOWED_WORKSPACE_HERMES_PACKAGES = new Set([
  "@hermes/contracts",
  "@hermes/domain",
  "@hermes/desktop",
  "@hermes/host-adapter",
]);

const FORBIDDEN_PACKAGE_NAMES = new Set([
  "hermes-desktop",
  "hermes-app",
  "desktop-plugins",
  "electron-updater",
  "update-electron-app",
  "sparkle",
  "electron-sparkle",
  "squirrel",
  "squirrel.windows",
  "electron-squirrel-startup",
]);

const FORBIDDEN_SOURCE_PATTERNS = [
  { label: "hermes-app", regex: /\bhermes-app\b/ },
  { label: "desktop-plugins", regex: /\bdesktop-plugins\b/ },
  { label: "plugin.js", regex: /\bplugin\.js\b/ },
  { label: "Hermes.app", regex: /Hermes\.app/ },
  { label: "app.asar", regex: /app\.asar/ },
  { label: "hermes:// custom scheme", regex: /hermes:\/\// },
  { label: "electron-updater", regex: /\belectron-updater\b/ },
  { label: "update-electron-app", regex: /\bupdate-electron-app\b/ },
  { label: "sparkle", regex: /\bsparkle\b/i },
  {
    label: "squirrel",
    regex: /(?:\bsquirrel\.windows\b|\belectron-squirrel-startup\b|from\s+["']squirrel["']|require\(["']squirrel["']\))/i,
  },
  { label: "plugins.manage", regex: /plugins\.manage/ },
  { label: "plugins.catalog.lookup", regex: /plugins\.catalog\.lookup/ },
];

const HERMES_SCOPED_PKG_RE = /@hermes\/[a-z0-9._-]+/g;

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

const isSource = (file) => /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(file) && !/\.test\./.test(file);

function isForbiddenPackageName(pkgName) {
  if (pkgName.startsWith("@hermes/")) {
    return !ALLOWED_WORKSPACE_HERMES_PACKAGES.has(pkgName);
  }
  return FORBIDDEN_PACKAGE_NAMES.has(pkgName);
}

function scanPackageManifests(repoRoot, errors) {
  const pkgPaths = [
    path.join(repoRoot, "package.json"),
    ...walkFiles(path.join(repoRoot, "packages"), (f) => path.basename(f) === "package.json"),
    ...walkFiles(path.join(repoRoot, "apps"), (f) => path.basename(f) === "package.json"),
  ];

  for (const pkgPath of pkgPaths) {
    if (!fs.existsSync(pkgPath)) continue;
    const rel = path.relative(repoRoot, pkgPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = pkg[section];
      if (!deps || typeof deps !== "object") continue;
      for (const depName of Object.keys(deps)) {
        if (isForbiddenPackageName(depName)) {
          errors.push(`Forbidden dependency "${depName}" in ${rel} (${section})`);
        }
      }
    }
  }
}

function scanLockfile(repoRoot, errors) {
  const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
  if (!fs.existsSync(lockPath)) return;
  const content = fs.readFileSync(lockPath, "utf8");
  const lines = content.split(/\r?\n/);

  let section = "";
  for (const line of lines) {
    if (/^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
      section = line.slice(0, -1).trim();
      continue;
    }

    if (section === "packages") {
      const m = line.match(/^\s{2}['"]?([^'"\s(]+?)@[^'"\s:]+['"]?:/);
      if (m) {
        const pkgName = m[1];
        if (isForbiddenPackageName(pkgName)) {
          errors.push(`Forbidden package "${pkgName}" in pnpm-lock.yaml`);
        }
      }
    } else if (section === "importers") {
      const depMatch = line.match(/^\s{6}['"]?([^'"\s:]+)['"]?:\s*$/);
      if (depMatch) {
        const pkgName = depMatch[1];
        if (isForbiddenPackageName(pkgName)) {
          errors.push(`Forbidden importer dependency "${pkgName}" in pnpm-lock.yaml`);
        }
      }
    }
  }
}

function scanTextForForbiddenRefs(content, locationLabel, errors) {
  // Check @hermes/* scope references outside our 4 workspace packages
  const scopedMatches = content.match(HERMES_SCOPED_PKG_RE);
  if (scopedMatches) {
    for (const pkg of scopedMatches) {
      if (!ALLOWED_WORKSPACE_HERMES_PACKAGES.has(pkg)) {
        errors.push(`Forbidden official desktop package reference (${pkg}) in ${locationLabel}`);
      }
    }
  }

  for (const { label, regex } of FORBIDDEN_SOURCE_PATTERNS) {
    if (regex.test(content)) {
      errors.push(`Forbidden official desktop reference (${label}) in ${locationLabel}`);
    }
  }

  // Check explicit hermes-desktop import/require (allow package name / display strings)
  if (/(?:from|import|require\()\s*["']hermes-desktop["']/.test(content)) {
    errors.push(`Forbidden hermes-desktop module import in ${locationLabel}`);
  }
}

function scanElectronBuilderConfig(repoRoot, errors) {
  const candidates = [
    path.join(repoRoot, "apps/desktop/electron-builder.json"),
    path.join(repoRoot, "apps/desktop/electron-builder.yml"),
    path.join(repoRoot, "apps/desktop/electron-builder.yaml"),
    path.join(repoRoot, "apps/desktop/electron-builder.cjs"),
  ];

  for (const cfgPath of candidates) {
    if (!fs.existsSync(cfgPath)) continue;
    const rel = path.relative(repoRoot, cfgPath);
    const raw = fs.readFileSync(cfgPath, "utf8");
    scanTextForForbiddenRefs(raw, rel, errors);

    if (cfgPath.endsWith(".json")) {
      const parsed = JSON.parse(raw);
      for (const field of ["extraResources", "files", "asarUnpack"]) {
        if (parsed[field] !== undefined) {
          scanTextForForbiddenRefs(JSON.stringify(parsed[field]), `${rel}#${field}`, errors);
        }
      }
    }
  }
}

function scanVendorDirectory(repoRoot, errors) {
  const vendorDir = path.join(repoRoot, "vendor");
  if (!fs.existsSync(vendorDir)) return;

  const upstreamPath = path.join(vendorDir, "UPSTREAM.md");
  if (!fs.existsSync(upstreamPath)) {
    errors.push("vendor/ exists without vendor/UPSTREAM.md attribution file");
    return;
  }
  const upstreamContent = fs.readFileSync(upstreamPath, "utf8");

  const vendorFiles = walkFiles(vendorDir, (f) => path.basename(f) !== "UPSTREAM.md");
  for (const file of vendorFiles) {
    const rel = path.relative(vendorDir, file).split(path.sep).join("/");
    const base = path.basename(file);
    if (!upstreamContent.includes(rel) && !upstreamContent.includes(base)) {
      errors.push(`vendor/${rel} is not listed in vendor/UPSTREAM.md`);
    }
  }
}

function scanAsarArchives(repoRoot, requireAsar, errors) {
  const archives = findAsarArchives(repoRoot);
  if (requireAsar && archives.length === 0) {
    errors.push("No packaged app.asar found under apps/desktop/release; run pnpm package:mac first");
    return;
  }

  for (const asarPath of archives) {
    const relAsar = path.relative(repoRoot, asarPath);
    const { baseOffset, entries } = readAsarArchive(asarPath);
    for (const entry of entries) {
      if (
        /(?:^|\/)plugin\.js$/i.test(entry.relPath) ||
        entry.relPath.includes("desktop-plugins") ||
        entry.relPath.includes("Hermes.app") ||
        entry.relPath.includes("electron-updater") ||
        entry.relPath.includes("update-electron-app")
      ) {
        errors.push(`Forbidden file "${entry.relPath}" inside packaged ${relAsar}`);
        continue;
      }

      if (/\.(js|mjs|cjs|html|json)$/i.test(entry.relPath)) {
        const text = readAsarEntryBuffer(asarPath, baseOffset, entry).toString("utf8");
        scanTextForForbiddenRefs(text, `${relAsar}:${entry.relPath}`, errors);
      }
    }
  }
}

export function verifyNoOfficialDesktop(repoRoot = process.cwd(), options = {}) {
  const errors = [];

  scanPackageManifests(repoRoot, errors);
  scanLockfile(repoRoot, errors);
  scanElectronBuilderConfig(repoRoot, errors);
  scanVendorDirectory(repoRoot, errors);

  const dirs = [path.join(repoRoot, "packages"), path.join(repoRoot, "apps")];
  for (const dir of dirs) {
    for (const file of walkFiles(dir, isSource)) {
      const content = fs.readFileSync(file, "utf8");
      scanTextForForbiddenRefs(content, path.relative(repoRoot, file), errors);
    }
  }

  scanAsarArchives(repoRoot, Boolean(options.requireAsar), errors);

  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const requireAsar = process.argv.includes("--require-asar");
  const result = verifyNoOfficialDesktop(process.cwd(), { requireAsar });
  if (!result.ok) {
    for (const err of result.errors) console.error(`[verify:no-official-desktop] ${err}`);
    process.exit(1);
  }
  console.log("[verify:no-official-desktop] OK");
}
