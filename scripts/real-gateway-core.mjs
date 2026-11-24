import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDesktopPackageMeta, resolveBuildGitMeta } from "./build-meta.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

const GATEWAY_WS_PROTOCOL = "hermes-gateway-v1";
const GATEWAY_TICKET_PREFIX = "hermes-gateway-ticket.";
const LOGIN_SHELL_TIMEOUT_MS = 5000;
const PATH_SENTINEL_BEGIN = "__HERMES_PATH_BEGIN__";
const PATH_SENTINEL_END = "__HERMES_PATH_END__";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const REPORT_ALLOWED_KEYS = [
  "status",
  "generatedAt",
  "appVersion",
  "gitSha",
  "gitDirty",
  "buildMode",
  "electronVersion",
  "chromiumVersion",
  "nodeVersion",
  "macOSVersion",
  "arch",
  "cliCapabilitiesSummary",
  "stages",
  "typedCode",
  "wsCloseCode",
  "exitCode",
  "hermesHomeKind",
  "sanitizedLogs",
];

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultCommonDirs(homeDir) {
  return [
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".hermes", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function buildProfileArgs(profileId, gatewayArgs) {
  if (profileId && profileId !== "default") {
    return ["--profile", profileId, ...gatewayArgs];
  }
  return gatewayArgs;
}

/**
 * Parses and validates CLI flags for the real-gateway harness.
 * Rejects partial real-home opt-in and forbids `--with-turn` in real-home mode.
 */
export function parseRealGatewayArgs(argv = []) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let hermesHome;
  let allowRealHome = false;
  let withTurn = false;
  let ciAllowSkip = false;
  let reportDir;
  let cliOverride;
  let profileId = "default";
  let timeoutSeconds = 60;
  let buildMode = "dev";

  const takeValue = (idx, flagName) => {
    const token = args[idx];
    const eqIdx = token.indexOf("=");
    if (eqIdx >= 0) {
      return { value: token.slice(eqIdx + 1), nextIdx: idx };
    }
    if (idx + 1 >= args.length) {
      return { error: `Missing value for ${flagName}` };
    }
    return { value: args[idx + 1], nextIdx: idx + 1 };
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--allow-real-home") {
      allowRealHome = true;
    } else if (arg === "--with-turn") {
      withTurn = true;
    } else if (arg === "--ci-allow-skip") {
      ciAllowSkip = true;
    } else if (arg === "--hermes-home" || arg.startsWith("--hermes-home=")) {
      const taken = takeValue(i, "--hermes-home");
      if (taken.error) {
        return { ok: false, typedCode: "invalid_arguments", error: taken.error };
      }
      hermesHome = taken.value;
      i = taken.nextIdx;
    } else if (arg === "--report-dir" || arg.startsWith("--report-dir=")) {
      const taken = takeValue(i, "--report-dir");
      if (taken.error) {
        return { ok: false, typedCode: "invalid_arguments", error: taken.error };
      }
      reportDir = taken.value;
      i = taken.nextIdx;
    } else if (arg === "--cli" || arg.startsWith("--cli=")) {
      const taken = takeValue(i, "--cli");
      if (taken.error) {
        return { ok: false, typedCode: "invalid_arguments", error: taken.error };
      }
      cliOverride = taken.value;
      i = taken.nextIdx;
    } else if (arg === "--profile" || arg.startsWith("--profile=")) {
      const taken = takeValue(i, "--profile");
      if (taken.error) {
        return { ok: false, typedCode: "invalid_arguments", error: taken.error };
      }
      profileId = taken.value || "default";
      i = taken.nextIdx;
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const taken = takeValue(i, "--timeout");
      if (taken.error) {
        return { ok: false, typedCode: "invalid_arguments", error: taken.error };
      }
      const parsed = Number(taken.value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, typedCode: "invalid_arguments", error: "Invalid --timeout value" };
      }
      timeoutSeconds = Math.min(120, Math.max(1, Math.ceil(parsed)));
      i = taken.nextIdx;
    } else if (arg === "--build-mode" || arg.startsWith("--build-mode=")) {
      const taken = takeValue(i, "--build-mode");
      if (taken.error) {
        return { ok: false, typedCode: "invalid_arguments", error: taken.error };
      }
      if (taken.value !== "dev" && taken.value !== "packaged") {
        return { ok: false, typedCode: "invalid_arguments", error: "Invalid --build-mode value" };
      }
      buildMode = taken.value;
      i = taken.nextIdx;
    } else if (arg === "--") {
      continue;
    } else {
      return {
        ok: false,
        typedCode: "invalid_arguments",
        error: `Unknown flag: ${arg}`,
      };
    }
  }

  if (hermesHome !== undefined && !hermesHome.trim()) {
    return {
      ok: false,
      typedCode: "invalid_arguments",
      error: "--hermes-home must not be empty",
    };
  }
  if (allowRealHome && !hermesHome) {
    return {
      ok: false,
      typedCode: "invalid_arguments",
      error: "--allow-real-home requires explicit --hermes-home <path>",
    };
  }
  if (hermesHome && !allowRealHome) {
    return {
      ok: false,
      typedCode: "invalid_arguments",
      error: "--hermes-home requires explicit --allow-real-home",
    };
  }

  const mode = allowRealHome && hermesHome ? "real-home" : "isolated";
  if (mode === "real-home" && withTurn) {
    return {
      ok: false,
      typedCode: "invalid_arguments",
      error: "--with-turn is forbidden in real-home attach-only mode",
    };
  }

  return {
    ok: true,
    options: {
      mode,
      hermesHome,
      allowRealHome,
      withTurn,
      ciAllowSkip,
      reportDir,
      cliOverride,
      profileId,
      timeoutSeconds,
      buildMode,
    },
  };
}

/**
 * Redacts secrets, credentials, URL userinfo/query/fragment, raw stderr, usernames, and paths.
 */
export function redactHarnessText(input, context = {}) {
  let out = String(input ?? "");

  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_KEY]",
  );
  out = out.replace(
    /\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=_-]+(?:\s+[^\s,;]+)?/gi,
    "[REDACTED_KEY]",
  );
  out = out.replace(/\b(?:wss?|https?):\/\/[^\s"'`<>]+/gi, "[REDACTED_URL]");
  out = out.replace(
    /\b[A-Za-z0-9._-]+:[^\s@]+@[A-Za-z0-9.-]+(?:\/[^\s"'`<>]*)?/g,
    "[REDACTED_URL]",
  );
  out = out.replace(
    /\b(Cookie|Set-Cookie|Authorization)\s*:\s*[^\n\r]+/gi,
    "$1: [REDACTED]",
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  out = out.replace(
    /\b(token|access_token|refresh_token|ticket|cookies?|passphrase|password|secret|key)["']?\s*[:=]\s*["']?[^\s,;}"']+/gi,
    "$1=[REDACTED]",
  );
  out = out.replace(/\b(?:raw_?stderr|stderr)\s*:\s*[^\n]+/gi, "[REDACTED_STDERR]");

  const extraPaths = Array.isArray(context.extraPaths) ? [...context.extraPaths] : [];
  extraPaths
    .filter((p) => typeof p === "string" && p.length > 1)
    .sort((a, b) => b.length - a.length)
    .forEach((p) => {
      out = out.replace(new RegExp(escapeRegExp(p), "g"), "[REDACTED_PATH]");
    });

  if (context.homeDir && context.homeDir.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(context.homeDir), "g"), "[REDACTED_HOME]");
  }
  if (context.username && context.username.length > 1) {
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(context.username)}\\b`, "gi"),
      "[REDACTED_USER]",
    );
  }

  out = out.replace(
    /\/(?:Users|home|var|tmp|private|etc|opt|usr|Library|Applications|System|Volumes)\/[^\s"'`:);,]+/g,
    "[REDACTED_PATH]",
  );
  out = out.replace(/~\/[^\s"'`:);,]+/g, "[REDACTED_PATH]");
  out = out.replace(/[A-Za-z]:\\[^\s"'`:);,]+/g, "[REDACTED_PATH]");
  out = out.replace(/\n\s*at\s+.+/g, "");
  return out;
}

function sanitizeValue(value, context) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactHarnessText(value, context);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, context));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sanitizeValue(v, context);
  }
  return out;
}

/**
 * Whitelists and sanitizes a real-gateway report object before writing or returning it.
 */
export function sanitizeRealGatewayReport(report, context = {}) {
  const effectiveContext = {
    homeDir: context.homeDir ?? os.homedir(),
    username: context.username ?? resolveSafeUsername(),
    extraPaths: [
      ...(Array.isArray(context.extraPaths) ? context.extraPaths : []),
      os.tmpdir(),
    ],
  };

  const filtered = {};
  for (const key of REPORT_ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(report, key)) {
      filtered[key] = sanitizeValue(report[key], effectiveContext);
    }
  }
  return filtered;
}

/**
 * Formats a sanitized real-gateway report into a human-readable Markdown summary.
 */
export function formatSummaryMarkdown(sanitizedReport) {
  const statusLabel = String(sanitizedReport.status ?? "unknown").toUpperCase();
  const lines = [
    "# Hermes Desktop Real-Gateway Smoke Report",
    "",
    `- **Status**: ${statusLabel}`,
    `- **Generated At**: ${sanitizedReport.generatedAt ?? "unknown"}`,
    `- **HERMES_HOME**: ${sanitizedReport.hermesHomeKind ?? "temp"}`,
    `- **Typed Code**: ${sanitizedReport.typedCode ?? "none"}`,
    `- **WS Close Code**: ${sanitizedReport.wsCloseCode ?? "none"}`,
    `- **Exit Code**: ${sanitizedReport.exitCode ?? 1}`,
    `- **App**: ${sanitizedReport.appVersion ?? "unknown"} (${sanitizedReport.gitSha ?? "unknown"}, ${sanitizedReport.buildMode ?? "dev"})`,
    `- **Runtime**: Electron ${sanitizedReport.electronVersion ?? "unknown"} · Chromium ${sanitizedReport.chromiumVersion ?? "unknown"} · Node ${sanitizedReport.nodeVersion ?? process.versions.node} · ${sanitizedReport.arch ?? process.arch}${sanitizedReport.macOSVersion ? ` · macOS ${sanitizedReport.macOSVersion}` : ""}`,
    "",
    "## CLI Capabilities Summary",
    "",
    "```json",
    JSON.stringify(sanitizedReport.cliCapabilitiesSummary ?? null, null, 2),
    "```",
    "",
    "## Stages",
    "",
    "| Stage | Status | Duration (ms) | Code |",
    "| --- | --- | ---: | --- |",
  ];

  const stages = Array.isArray(sanitizedReport.stages) ? sanitizedReport.stages : [];
  for (const stage of stages) {
    lines.push(
      `| ${stage.name} | ${stage.status} | ${stage.durationMs ?? 0} | ${stage.code ?? "-"} |`,
    );
  }

  lines.push("", "## Sanitized Logs", "");
  const logs = Array.isArray(sanitizedReport.sanitizedLogs) ? sanitizedReport.sanitizedLogs : [];
  if (logs.length === 0) {
    lines.push("- (none)");
  } else {
    for (const entry of logs) {
      lines.push(`- ${entry}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function resolveSafeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || "";
  }
}

async function runProcess({ command, args, timeoutMs = 15_000, env = process.env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        errorCode: err && typeof err === "object" ? err.code : "SPAWN_ERROR",
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 500);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        errorCode: err && typeof err === "object" ? err.code : undefined,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut: false,
      });
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    await fs.promises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function extractPathFromShellOutput(stdout) {
  const clean = stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const beginIndex = clean.lastIndexOf(PATH_SENTINEL_BEGIN);
  if (beginIndex === -1) return null;
  const afterBegin = clean.slice(beginIndex + PATH_SENTINEL_BEGIN.length);
  const endIndex = afterBegin.indexOf(PATH_SENTINEL_END);
  if (endIndex === -1) return null;
  const extracted = afterBegin.slice(0, endIndex).trim();
  return extracted || null;
}

async function checkCandidateInDirs(dirs, sourceKind) {
  for (const dir of dirs) {
    if (!dir) continue;
    const candidatePath = path.join(dir, "hermes");
    if (await fileExists(candidatePath)) {
      if (await isExecutable(candidatePath)) {
        return { candidate: { path: candidatePath, sourceKind, hasOverride: false } };
      }
      return { nonExecutable: { path: candidatePath, sourceKind, hasOverride: false } };
    }
  }
  return {};
}

async function runLoginShellPathProbe(flag, shellPath, env) {
  const shellCmd = `printf '${PATH_SENTINEL_BEGIN}%s${PATH_SENTINEL_END}\\n' "$PATH"`;
  const res = await runProcess({
    command: shellPath,
    args: [flag, shellCmd],
    timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    env,
  });
  if (res.timedOut || res.exitCode !== 0) return null;
  const extracted = extractPathFromShellOutput(res.stdout);
  if (!extracted) return null;
  return extracted.split(path.delimiter).filter(Boolean);
}

function extractSanitizedVersion(versionOutput) {
  const match = String(versionOutput || "").match(
    /\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/,
  );
  return match ? match[0] : undefined;
}

async function locateHermesCli(options, runtime) {
  const overridePath = options.cliOverride || runtime.env.HERMES_CLI_PATH || null;
  if (overridePath) {
    if (!(await fileExists(overridePath))) {
      return { ok: false, typedCode: "hermes_not_found", sourceKind: "override", hasOverride: true };
    }
    if (!(await isExecutable(overridePath))) {
      return {
        ok: false,
        typedCode: "cli_not_executable",
        sourceKind: "override",
        hasOverride: true,
        path: overridePath,
      };
    }
    return {
      ok: true,
      candidate: { path: overridePath, sourceKind: "override", hasOverride: true },
    };
  }

  let nonExecutable = null;
  if (runtime.runShellPathProbe !== false) {
    for (const flag of ["-ilc", "-lc"]) {
      const dirs = await runLoginShellPathProbe(flag, runtime.shellPath, runtime.env);
      if (dirs) {
        const hit = await checkCandidateInDirs(
          dirs,
          flag === "-ilc" ? "login_shell_ilc" : "login_shell_lc",
        );
        if (hit.candidate) return { ok: true, candidate: hit.candidate };
        if (hit.nonExecutable && !nonExecutable) nonExecutable = hit.nonExecutable;
      }
    }
  }

  const envPathDirs = String(runtime.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const fallbackDirs = [...new Set([...envPathDirs, ...runtime.commonDirs])];
  const fallbackHit = await checkCandidateInDirs(fallbackDirs, "common_dir");
  if (fallbackHit.candidate) {
    return { ok: true, candidate: fallbackHit.candidate };
  }
  if (!nonExecutable && fallbackHit.nonExecutable) {
    nonExecutable = fallbackHit.nonExecutable;
  }

  if (nonExecutable) {
    return {
      ok: false,
      typedCode: "cli_not_executable",
      sourceKind: nonExecutable.sourceKind,
      hasOverride: false,
      path: nonExecutable.path,
    };
  }

  return { ok: false, typedCode: "hermes_not_found", sourceKind: "none", hasOverride: false };
}

async function probeCliCapabilities(cliCandidate, mode, env) {
  const versionRes = await runProcess({
    command: cliCandidate.path,
    args: ["--version"],
    timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    env,
  });
  if (versionRes.errorCode === "EACCES") {
    return {
      ok: false,
      typedCode: "cli_not_executable",
      summary: {
        status: "not_executable",
        sourceKind: cliCandidate.sourceKind,
        hasOverride: cliCandidate.hasOverride,
        supportsEnsureJson: false,
        supportsAttachJson: false,
        supportsTicketsProbe: false,
        supportsStopYes: false,
      },
    };
  }

  const version = extractSanitizedVersion(versionRes.stdout);
  const gatewayHelpRes = await runProcess({
    command: cliCandidate.path,
    args: ["gateway", "--help"],
    timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    env,
  });
  const gatewayHelp = gatewayHelpRes.stdout || "";

  const hasEnsure = /\bensure\b/.test(gatewayHelp);
  const hasAttach = /\battach\b/.test(gatewayHelp);
  const hasTickets = /\btickets\b/.test(gatewayHelp);
  const hasStop = /\bstop\b/.test(gatewayHelp);

  const ensureHelpRes =
    mode === "isolated" && hasEnsure
      ? await runProcess({
          command: cliCandidate.path,
          args: ["gateway", "ensure", "--help"],
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          env,
        })
      : { exitCode: 1, stdout: "" };
  const attachHelpRes = hasAttach
    ? await runProcess({
        command: cliCandidate.path,
        args: ["gateway", "attach", "--help"],
        timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
        env,
      })
    : { exitCode: 1, stdout: "" };
  const stopHelpRes =
    mode === "isolated" && hasStop
      ? await runProcess({
          command: cliCandidate.path,
          args: ["gateway", "stop", "--help"],
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          env,
        })
      : { exitCode: 1, stdout: "" };
  const ticketsProbeRes = hasTickets
    ? await runProcess({
        command: cliCandidate.path,
        args: ["gateway", "tickets", "--json", "--probe"],
        timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
        env,
      })
    : null;

  const supportsEnsureJson =
    mode === "isolated" && hasEnsure && (ensureHelpRes.stdout || "").includes("--json");
  const supportsAttachJson = hasAttach && (attachHelpRes.stdout || "").includes("--json");
  const supportsLegacyRecover =
    hasAttach &&
    (attachHelpRes.stdout || "").includes("--recover") &&
    (attachHelpRes.stdout || "").includes("--json");
  const supportsStopYes =
    mode === "isolated" && hasStop && stopHelpRes.exitCode === 0 && (stopHelpRes.stdout || "").includes("--yes");

  const summary = {
    status: "ready",
    sourceKind: cliCandidate.sourceKind,
    ...(version ? { version } : {}),
    hasOverride: cliCandidate.hasOverride,
    supportsEnsureJson,
    supportsAttachJson,
    supportsLegacyRecover,
    supportsTicketsProbe: hasTickets,
    supportsStopYes,
  };

  if (mode === "isolated") {
    if (!supportsEnsureJson && !supportsAttachJson && !supportsLegacyRecover) {
      return {
        ok: false,
        typedCode: "cli_unsupported",
        summary: { ...summary, status: "unsupported" },
      };
    }
    if (!supportsStopYes) {
      return {
        ok: false,
        typedCode: "cli_missing_stop_capability",
        summary: { ...summary, status: "unsupported" },
      };
    }
  } else if (!supportsAttachJson) {
    return {
      ok: false,
      typedCode: "cli_unsupported",
      summary: { ...summary, status: "unsupported" },
    };
  }

  if (ticketsProbeRes && ticketsProbeRes.exitCode === 0 && ticketsProbeRes.stdout.trim() !== "") {
    try {
      const parsed = JSON.parse(ticketsProbeRes.stdout.trim());
      const proto = parsed.runtime_protocol ?? parsed.protocol;
      if (proto !== 1) {
        return {
          ok: false,
          typedCode: "protocol_unsupported",
          summary: { ...summary, status: "unsupported" },
        };
      }
      if (
        Array.isArray(parsed.capabilities) &&
        !parsed.capabilities.includes("session-authority-v1")
      ) {
        return {
          ok: false,
          typedCode: "protocol_unsupported",
          summary: { ...summary, status: "unsupported" },
        };
      }
    } catch {
      return {
        ok: false,
        typedCode: "protocol_unsupported",
        summary: { ...summary, status: "unsupported" },
      };
    }
  }

  return { ok: true, summary };
}

function parseLastJsonObject(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct;
    }
  } catch {
    // Scan lines backwards for trailing JSON payload after CLI progress/banner lines
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // continue scanning
    }
  }
  return undefined;
}

function deriveWsUrl(ep, raw) {
  const direct = ep.ws_url ?? ep.wsUrl ?? ep.url ?? raw.ws_url ?? raw.wsUrl ?? raw.url;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const origin = ep.api_origin ?? ep.apiOrigin ?? raw.api_origin ?? raw.apiOrigin;
  if (typeof origin === "string" && origin.trim()) {
    try {
      const u = new URL(origin.trim());
      if (u.protocol === "http:") u.protocol = "ws:";
      else if (u.protocol === "https:") u.protocol = "wss:";
      if (u.protocol === "ws:" || u.protocol === "wss:") {
        u.pathname = "/api/ws";
        u.search = "";
        u.hash = "";
        return u.toString();
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseEnsureOrAttachJson(stdout, exitCode) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    if (exitCode === 5) return { kind: "starting", reasonCode: "deadline" };
    return {
      kind: "failure",
      typedCode: exitCode === 3 ? "protocol_unsupported" : "gateway_start_failed",
    };
  }
  const raw = parseLastJsonObject(trimmed);
  if (!raw) {
    return {
      kind: "failure",
      typedCode: exitCode === 5 ? "gateway_starting_timeout" : "invalid_control_state",
    };
  }

  const state = typeof raw.state === "string" ? raw.state.trim() : undefined;
  const reasonCode =
    typeof (raw.reason_code ?? raw.reasonCode) === "string"
      ? String(raw.reason_code ?? raw.reasonCode).trim()
      : undefined;

  if (state === "starting" || reasonCode === "deadline" || (exitCode === 5 && state !== "ready")) {
    return { kind: "starting", reasonCode: reasonCode ?? "deadline" };
  }

  if (
    state === "stopped" ||
    reasonCode === "not_running" ||
    reasonCode === "gateway_not_running" ||
    reasonCode === "no_gateway"
  ) {
    return { kind: "not_running", reasonCode };
  }

  if (state === "error" || state === "blocked") {
    return {
      kind: "failure",
      typedCode: reasonCode === "protocol_unsupported" ? "protocol_unsupported" : "gateway_start_failed",
      reasonCode,
    };
  }

  const ep = raw.endpoint && typeof raw.endpoint === "object" ? raw.endpoint : raw;
  const wsUrl = deriveWsUrl(ep, raw);
  const runtimeProtocol = ep.runtime_protocol ?? ep.runtimeProtocol;
  const capabilities = Array.isArray(ep.capabilities)
    ? ep.capabilities.filter((c) => typeof c === "string")
    : [];

  if (runtimeProtocol !== 1 || !capabilities.includes("session-authority-v1")) {
    return { kind: "failure", typedCode: "protocol_unsupported" };
  }
  if (typeof wsUrl !== "string" || !wsUrl.trim()) {
    return { kind: "failure", typedCode: "invalid_control_state" };
  }

  const ticketPrefix =
    typeof (ep.ticket_protocol_prefix ?? ep.ticketProtocolPrefix) === "string"
      ? String(ep.ticket_protocol_prefix ?? ep.ticketProtocolPrefix)
      : GATEWAY_TICKET_PREFIX;
  let ticket = typeof raw.ticket === "string" ? raw.ticket.trim() : undefined;
  if (!ticket && Array.isArray(raw.protocols)) {
    const found = raw.protocols.find((p) => typeof p === "string" && p.startsWith(ticketPrefix));
    if (found) ticket = found.slice(ticketPrefix.length);
  }

  const pidCandidate = raw.pid ?? ep.pid;
  const pid = typeof pidCandidate === "number" && Number.isInteger(pidCandidate) ? pidCandidate : null;

  return {
    kind: "ready",
    pid,
    ticket,
    endpoint: {
      profileId: String(ep.profile_id ?? ep.profileId ?? "default"),
      instanceId: String(ep.instance_id ?? ep.instanceId ?? "local-instance"),
      wsUrl: wsUrl.trim(),
      wsProtocol: String(ep.ws_protocol ?? ep.wsProtocol ?? GATEWAY_WS_PROTOCOL),
      ticketProtocolPrefix: ticketPrefix,
      runtimeProtocol,
      capabilities,
    },
  };
}

async function tryControlSocketTicket(hermesHomeDir, profileId, instanceId) {
  const socketPath = path.join(hermesHomeDir, "gateway.sock");
  if (!(await fileExists(socketPath))) return null;

  const sendReq = (payload) =>
    new Promise((resolve) => {
      let settled = false;
      let buf = "";
      const sock = net.createConnection({ path: socketPath });
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), 3000);
      sock.on("connect", () => sock.write(`${JSON.stringify(payload)}\n`, "utf8"));
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        try {
          finish(JSON.parse(buf.slice(0, nl)));
        } catch {
          finish(null);
        }
      });
      sock.on("error", () => finish(null));
    });

  const resolved = await sendReq({ op: "resolve-profile", profile_id: profileId });
  if (!resolved || resolved.status !== "ok") return null;
  if (Array.isArray(resolved.purposes) && !resolved.purposes.includes("interactive")) {
    return null;
  }
  const ticketRes = await sendReq({
    op: "session-ticket",
    profile_id: profileId,
    instance_id: resolved.endpoint?.instance_id ?? instanceId,
    purpose: "interactive",
  });
  if (ticketRes?.status === "ok" && typeof ticketRes.ticket === "string" && ticketRes.ticket) {
    return {
      ticket: ticketRes.ticket,
      wsUrl: resolved.endpoint?.ws_url,
    };
  }
  return null;
}

function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, masked]);
}

class HarnessWsClient {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.closeCode = null;
    this.seq = 0;
    this.rxBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.pongWaiters = [];

    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#onDisconnect());
    socket.on("error", () => this.#onDisconnect());
  }

  static connect({ wsUrl, ticket, ticketProtocolPrefix = GATEWAY_TICKET_PREFIX, timeoutMs = 10_000 }) {
    let parsedUrl;
    try {
      parsedUrl = new URL(wsUrl);
    } catch {
      throw Object.assign(new Error("Invalid gateway WebSocket URL"), { typedCode: "ws_handshake_failed" });
    }

    const isSecure = parsedUrl.protocol === "wss:";
    if (parsedUrl.protocol !== "ws:" && !isSecure) {
      throw Object.assign(new Error("Unsupported gateway WebSocket scheme"), {
        typedCode: "protocol_unsupported",
      });
    }

    const protocols = [GATEWAY_WS_PROTOCOL, `${ticketProtocolPrefix}${ticket}`];
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    const reqModule = isSecure ? https : http;
    const port = parsedUrl.port ? Number(parsedUrl.port) : isSecure ? 443 : 80;
    const reqPath = `${parsedUrl.pathname || "/"}${parsedUrl.search || ""}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      // Omit Origin header intentionally for gateway Origin guard
      const req = reqModule.request({
        hostname: parsedUrl.hostname,
        port,
        path: reqPath,
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": protocols.join(", "),
        },
      });

      const timer = setTimeout(() => {
        req.destroy();
        fail(Object.assign(new Error("WebSocket handshake timed out"), { typedCode: "ws_handshake_failed" }));
      }, timeoutMs);

      req.on("upgrade", (res, socket, head) => {
        if (settled) {
          socket.destroy();
          return;
        }
        if (res.headers["sec-websocket-accept"] !== expectedAccept) {
          socket.destroy();
          fail(Object.assign(new Error("Invalid WebSocket accept header"), { typedCode: "ws_handshake_failed" }));
          return;
        }
        settled = true;
        clearTimeout(timer);
        const client = new HarnessWsClient(socket);
        if (head && head.length > 0) client.#onData(head);
        resolve(client);
      });

      req.on("response", (res) => {
        res.resume();
        fail(
          Object.assign(new Error(`WebSocket upgrade rejected (${res.statusCode ?? 0})`), {
            typedCode: "ws_handshake_failed",
          }),
        );
      });

      req.on("error", () => {
        fail(Object.assign(new Error("WebSocket connection unreachable"), { typedCode: "ws_handshake_failed" }));
      });

      req.end();
    });
  }

  #onDisconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Gateway WebSocket closed"));
      this.pending.delete(id);
    }
    for (const waiter of this.pongWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Gateway WebSocket closed"));
    }
  }

  #onData(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (this.rxBuffer.length >= 2) {
      const b0 = this.rxBuffer[0];
      const b1 = this.rxBuffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.rxBuffer.length < 4) return;
        len = this.rxBuffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.rxBuffer.length < 10) return;
        len = Number(this.rxBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.rxBuffer.length < offset + maskLen + len) return;

      let payload = this.rxBuffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.rxBuffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      this.rxBuffer = this.rxBuffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        if (payload.length >= 2) {
          this.closeCode = payload.readUInt16BE(0);
        }
        this.close(this.closeCode ?? 1000);
        return;
      }
      if (opcode === 0x9) {
        if (!this.closed && !this.socket.destroyed) {
          this.socket.write(encodeClientFrame(0xA, payload));
        }
        continue;
      }
      if (opcode === 0xA) {
        for (const waiter of this.pongWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        continue;
      }
      if (opcode === 0x1) {
        this.#handleText(payload.toString("utf8"));
      }
    }
  }

  #handleText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const id = String(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.error && typeof msg.error === "object") {
        const rpcCode = typeof msg.error.code === "number" ? msg.error.code : -32000;
        entry.reject(Object.assign(new Error(`RPC error ${rpcCode}`), { rpcCode }));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 10_000) {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error("Gateway WebSocket is not open"));
    }
    this.seq += 1;
    const id = `rg-${this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      this.socket.write(encodeClientFrame(0x1, buf));
    });
  }

  ping(timeoutMs = 5_000) {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error("Gateway WebSocket is not open"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("WebSocket ping timed out"));
      }, timeoutMs);
      this.pongWaiters.push({ resolve, reject, timer });
      this.socket.write(encodeClientFrame(0x9, Buffer.from("hermes-health")));
    });
  }

  close(code = 1000) {
    if (this.closed) return this.closeCode ?? code;
    this.closeCode = this.closeCode ?? code;
    try {
      if (!this.socket.destroyed) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        this.socket.write(encodeClientFrame(0x8, payload));
        this.socket.end();
      }
    } catch {
      // ignore
    }
    this.#onDisconnect();
    return this.closeCode;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && typeof err === "object" && err.code === "EPERM";
  }
}

async function isTcpEndpointReachable(wsUrl) {
  try {
    const parsed = new URL(wsUrl);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80;
    const host = parsed.hostname || "127.0.0.1";
    return await new Promise((resolve) => {
      const sock = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 400);
      sock.on("connect", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

async function resolveMacOSVersion() {
  if (process.platform !== "darwin") return undefined;
  const res = await runProcess({
    command: "/usr/bin/sw_vers",
    args: ["-productVersion"],
    timeoutMs: 3000,
  });
  if (res.exitCode === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return os.release();
}

function readKnownPidFromHome(hermesHomeDir) {
  for (const name of ["gateway.pid", "hermes-gateway.pid"]) {
    const pidFile = path.join(hermesHomeDir, name);
    try {
      const raw = fs.readFileSync(pidFile, "utf8").trim();
      const num = Number(raw);
      if (Number.isInteger(num) && num > 0) return num;
      const parsed = JSON.parse(raw);
      const pidVal = Number(parsed?.pid);
      if (Number.isInteger(pidVal) && pidVal > 0) return pidVal;
    } catch {
      // ignore
    }
  }
  return null;
}

async function verifyIsolatedCleanup({
  cliPath,
  profileId,
  hermesHomeDir,
  childEnv,
  knownPid,
  wsUrl,
  logs,
}) {
  const stopRes = await runProcess({
    command: cliPath,
    args: buildProfileArgs(profileId, ["gateway", "stop", "--yes"]),
    timeoutMs: 15_000,
    env: childEnv,
  });

  if (stopRes.timedOut || stopRes.exitCode !== 0) {
    logs.push(`Cleanup stop --yes failed (exitCode=${String(stopRes.exitCode)})`);
    return false;
  }

  const pidToVerify = knownPid ?? readKnownPidFromHome(hermesHomeDir);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pidStillAlive = pidToVerify ? isPidAlive(pidToVerify) : false;
    const sockExists = fs.existsSync(path.join(hermesHomeDir, "gateway.sock"));
    const endpointAlive = wsUrl ? await isTcpEndpointReachable(wsUrl) : false;
    if (!pidStillAlive && !endpointAlive && !sockExists) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (pidToVerify && isPidAlive(pidToVerify)) {
    logs.push("Cleanup verification failed: isolated gateway PID still alive after stop --yes");
    return false;
  }
  if (wsUrl && (await isTcpEndpointReachable(wsUrl))) {
    logs.push("Cleanup verification failed: isolated gateway WS endpoint still reachable after stop --yes");
    return false;
  }
  return true;
}

/**
 * Runs the real-gateway smoke harness end-to-end and writes sanitized `report.json` & `summary.md`.
 */
export async function runRealGateway(argv = [], runtimeOverrides = {}) {
  const repoRoot = runtimeOverrides.repoRoot ?? DEFAULT_REPO_ROOT;
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const env = runtimeOverrides.env ?? process.env;
  const homeDir = runtimeOverrides.homeDir ?? os.homedir();
  const username = runtimeOverrides.username ?? resolveSafeUsername();
  const commonDirs = runtimeOverrides.commonDirs ?? defaultCommonDirs(homeDir);
  const shellPath = runtimeOverrides.shellPath ?? env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const runShellPathProbe = runtimeOverrides.runShellPathProbe ?? true;

  const parsedArgs = parseRealGatewayArgs(argv);
  const pkgMeta = readDesktopPackageMeta(desktopRoot);
  const buildMode = parsedArgs.ok ? parsedArgs.options.buildMode : "dev";
  const gitMeta = resolveBuildGitMeta({ repoRoot, buildMode, allowUnknownSha: true });
  const macOSVersion = await resolveMacOSVersion();

  const stages = [];
  const logs = [];
  const extraPaths = [repoRoot, os.tmpdir()];
  try {
    extraPaths.push(fs.realpathSync(os.tmpdir()));
  } catch {
    // ignore
  }

  const writeArtifacts = (rawReport, reportDirTarget) => {
    const targetDir =
      reportDirTarget ||
      fs.mkdtempSync(path.join(os.tmpdir(), "hermes-real-gateway-report-"));
    extraPaths.push(targetDir);
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const sanitized = sanitizeRealGatewayReport(rawReport, {
      homeDir,
      username,
      extraPaths,
    });
    const summaryMd = formatSummaryMarkdown(sanitized);
    fs.writeFileSync(path.join(targetDir, "report.json"), `${JSON.stringify(sanitized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(path.join(targetDir, "summary.md"), summaryMd, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { reportDir: targetDir, report: sanitized, summaryMd };
  };

  const makeBaseReport = ({
    status,
    hermesHomeKind,
    cliCapabilitiesSummary = null,
    typedCode = null,
    wsCloseCode = null,
    exitCode,
  }) => ({
    status,
    generatedAt: new Date().toISOString(),
    appVersion: pkgMeta.appVersion,
    gitSha: gitMeta.gitSha,
    gitDirty: gitMeta.gitDirty,
    buildMode,
    electronVersion: pkgMeta.electronVersion,
    chromiumVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node,
    ...(macOSVersion ? { macOSVersion } : {}),
    arch: process.arch === "x64" ? "x64" : "arm64",
    cliCapabilitiesSummary,
    stages,
    typedCode,
    wsCloseCode,
    exitCode,
    hermesHomeKind,
    sanitizedLogs: logs,
  });

  if (!parsedArgs.ok) {
    logs.push(parsedArgs.error);
    stages.push({ name: "parse_args", status: "failed", durationMs: 0, code: parsedArgs.typedCode });
    const reportDirArgIdx = argv.findIndex((a) => a === "--report-dir");
    const rawReportDir = reportDirArgIdx >= 0 ? argv[reportDirArgIdx + 1] : undefined;
    const written = writeArtifacts(
      makeBaseReport({
        status: "failed",
        hermesHomeKind: argv.includes("--allow-real-home") ? "real" : "temp",
        typedCode: parsedArgs.typedCode,
        exitCode: 2,
      }),
      rawReportDir,
    );
    return { exitCode: 2, ...written };
  }

  const options = parsedArgs.options;
  const hermesHomeKind = options.mode === "real-home" ? "real" : "temp";
  let sandboxRoot = null;
  let hermesHomeDir = null;
  let userDataDir = null;
  let sandboxPassed = false;
  let cliPath = null;
  let cliSummary = null;
  let ownerStartAttempted = false;
  let knownPid = null;
  let endpointWsUrl = null;
  let wsCloseCode = null;
  let finalStatus = "failed";
  let typedCode = null;
  let exitCode = 1;

  const runStage = async (name, fn) => {
    const started = Date.now();
    try {
      const value = await fn();
      stages.push({ name, status: "ok", durationMs: Math.max(0, Date.now() - started) });
      return { ok: true, value };
    } catch (err) {
      const code = err && typeof err === "object" && err.typedCode ? String(err.typedCode) : "stage_failed";
      stages.push({ name, status: "failed", durationMs: Math.max(0, Date.now() - started), code });
      logs.push(err instanceof Error ? err.message : String(err));
      return { ok: false, typedCode: code };
    }
  };

  try {
    // 1. Preflight: locate CLI + probe version & capabilities
    const preflightStarted = Date.now();
    const located = await locateHermesCli(options, { env, commonDirs, shellPath, runShellPathProbe });
    if (!located.ok) {
      cliSummary = {
        status: located.typedCode === "cli_not_executable" ? "not_executable" : "missing",
        sourceKind: located.sourceKind,
        hasOverride: located.hasOverride,
        supportsEnsureJson: false,
        supportsAttachJson: false,
        supportsTicketsProbe: false,
        supportsStopYes: false,
      };
      if (located.path) extraPaths.push(located.path);
      const durationMs = Math.max(0, Date.now() - preflightStarted);
      if (located.typedCode === "hermes_not_found" && options.ciAllowSkip) {
        stages.push({ name: "preflight", status: "skipped", durationMs, code: "hermes_not_found" });
        logs.push("Skipped real-gateway smoke: hermes CLI not installed (--ci-allow-skip)");
        finalStatus = "skipped";
        typedCode = "hermes_not_found";
        exitCode = 0;
        sandboxPassed = true;
      } else {
        stages.push({ name: "preflight", status: "failed", durationMs, code: located.typedCode });
        logs.push(`Preflight failed with ${located.typedCode}`);
        finalStatus = "failed";
        typedCode = located.typedCode;
        exitCode = 1;
      }
      const written = writeArtifacts(
        makeBaseReport({
          status: finalStatus,
          hermesHomeKind,
          cliCapabilitiesSummary: cliSummary,
          typedCode,
          exitCode,
        }),
        options.reportDir,
      );
      return { exitCode, ...written };
    }

    cliPath = located.candidate.path;
    extraPaths.push(cliPath);
    const probed = await probeCliCapabilities(located.candidate, options.mode, env);
    cliSummary = probed.summary;
    const preflightDuration = Math.max(0, Date.now() - preflightStarted);
    if (!probed.ok) {
      stages.push({
        name: "preflight",
        status: "failed",
        durationMs: preflightDuration,
        code: probed.typedCode,
      });
      logs.push(`Preflight rejected CLI: ${probed.typedCode}`);
      finalStatus = "failed";
      typedCode = probed.typedCode;
      exitCode = 1;
      const written = writeArtifacts(
        makeBaseReport({
          status: finalStatus,
          hermesHomeKind,
          cliCapabilitiesSummary: cliSummary,
          typedCode,
          exitCode,
        }),
        options.reportDir,
      );
      return { exitCode, ...written };
    }
    stages.push({ name: "preflight", status: "ok", durationMs: preflightDuration });

    // 2. Setup HERMES_HOME & env
    if (options.mode === "isolated") {
      sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-real-gw-"));
      hermesHomeDir = path.join(sandboxRoot, "hermes-home");
      userDataDir = path.join(sandboxRoot, "user-data");
      fs.mkdirSync(hermesHomeDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      extraPaths.push(sandboxRoot, hermesHomeDir, userDataDir);
      const realHermes = path.resolve(homeDir, ".hermes");
      if (path.resolve(hermesHomeDir) === realHermes || path.resolve(userDataDir) === path.resolve(homeDir)) {
        throw new Error("Isolated sandbox must never point to real ~/.hermes or ~");
      }
    } else {
      const rawHome = options.hermesHome.trim();
      const expandedHome = rawHome === "~"
        ? homeDir
        : rawHome.startsWith("~/")
          ? path.join(homeDir, rawHome.slice(2))
          : rawHome;
      hermesHomeDir = path.resolve(expandedHome);
      extraPaths.push(rawHome, hermesHomeDir);
    }

    const childEnv =
      options.mode === "isolated"
        ? {
            ...env,
            HERMES_HOME: hermesHomeDir,
            HERMES_USER_DATA_DIR: userDataDir,
            HERMES_DESKTOP_E2E: "1",
          }
        : {
            ...env,
            HERMES_HOME: hermesHomeDir,
          };

    // 3. Ensure (isolated) or Attach-only (real-home)
    let readyDial = null;
    const ensureStageName = options.mode === "real-home" ? "attach_only" : "ensure_gateway";
    const ensureStage = await runStage(ensureStageName, async () => {
      if (options.mode === "real-home") {
        const attachRes = await runProcess({
          command: cliPath,
          args: buildProfileArgs(options.profileId, ["gateway", "attach", "--json"]),
          timeoutMs: 15_000,
          env: childEnv,
        });
        const parsed = parseEnsureOrAttachJson(attachRes.stdout, attachRes.exitCode);
        if (parsed.kind === "not_running" || (attachRes.exitCode !== 0 && parsed.kind !== "ready")) {
          const code = parsed.kind === "failure" && parsed.typedCode === "protocol_unsupported"
            ? "protocol_unsupported"
            : "gateway_not_running";
          throw Object.assign(
            new Error(
              code === "gateway_not_running"
                ? "No running gateway found in the specified HERMES_HOME. Start the gateway manually before running real-home attach smoke."
                : "Gateway protocol unsupported",
            ),
            { typedCode: code },
          );
        }
        if (parsed.kind !== "ready") {
          throw Object.assign(new Error("Failed to attach to real-home gateway"), {
            typedCode: parsed.typedCode ?? "gateway_not_running",
          });
        }
        readyDial = parsed;
        return;
      }

      // Isolated mode: mark owner start attempted before invoking ensure/recover so cleanup always runs
      ownerStartAttempted = true;
      const deadline = Date.now() + options.timeoutSeconds * 1000;
      const runOnce = async () => {
        if (cliSummary.supportsEnsureJson) {
          const remSec = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
          const res = await runProcess({
            command: cliPath,
            args: buildProfileArgs(options.profileId, ["gateway", "ensure", "--json", "--timeout", String(remSec)]),
            timeoutMs: remSec * 1000 + 2000,
            env: childEnv,
          });
          return parseEnsureOrAttachJson(res.stdout, res.exitCode);
        }
        const legacyArgs = cliSummary.supportsLegacyRecover
          ? ["gateway", "attach", "--recover", "--json"]
          : ["gateway", "attach", "--json"];
        const res = await runProcess({
          command: cliPath,
          args: buildProfileArgs(options.profileId, legacyArgs),
          timeoutMs: 15_000,
          env: childEnv,
        });
        return parseEnsureOrAttachJson(res.stdout, res.exitCode);
      };

      let parsed = await runOnce();
      while (parsed.kind === "starting") {
        if (Date.now() >= deadline) {
          throw Object.assign(new Error("Isolated gateway timed out while starting"), {
            typedCode: "gateway_starting_timeout",
          });
        }
        await new Promise((r) => setTimeout(r, 500));
        parsed = await runOnce();
      }

      if (parsed.kind !== "ready") {
        throw Object.assign(new Error(`Isolated gateway ensure failed (${parsed.typedCode ?? "unknown"})`), {
          typedCode: parsed.typedCode ?? "gateway_start_failed",
        });
      }
      readyDial = parsed;
      knownPid = parsed.pid;
      endpointWsUrl = parsed.endpoint.wsUrl;
    });

    if (!ensureStage.ok || !readyDial) {
      typedCode = ensureStage.typedCode;
      throw new Error("Ensure/attach stage failed");
    }

    // 4. Obtain single-use ticket (in-memory only)
    let ticket = readyDial.ticket;
    let wsUrl = readyDial.endpoint.wsUrl;
    if (!ticket) {
      const sockTicket = await tryControlSocketTicket(
        hermesHomeDir,
        readyDial.endpoint.profileId,
        readyDial.endpoint.instanceId,
      );
      if (sockTicket?.ticket) {
        ticket = sockTicket.ticket;
        if (sockTicket.wsUrl) wsUrl = sockTicket.wsUrl;
      } else {
        const attachRes = await runProcess({
          command: cliPath,
          args: buildProfileArgs(options.profileId, ["gateway", "attach", "--json"]),
          timeoutMs: 15_000,
          env: childEnv,
        });
        const attached = parseEnsureOrAttachJson(attachRes.stdout, attachRes.exitCode);
        if (attached.kind !== "ready" || !attached.ticket) {
          typedCode = attached.typedCode ?? "ticket_unavailable";
          stages.push({ name: "mint_ticket", status: "failed", durationMs: 0, code: typedCode });
          logs.push("Failed to mint single-use WS ticket");
          throw new Error("Ticket mint failed");
        }
        ticket = attached.ticket;
        wsUrl = attached.endpoint.wsUrl;
      }
    }
    endpointWsUrl = wsUrl;

    // 5. WebSocket handshake & read-only RPC smoke
    let wsClient = null;
    const handshakeStage = await runStage("ws_handshake", async () => {
      const consumedTicket = ticket;
      ticket = null;
      wsClient = await HarnessWsClient.connect({
        wsUrl,
        ticket: consumedTicket,
        ticketProtocolPrefix: readyDial.endpoint.ticketProtocolPrefix,
      });
    });
    if (!handshakeStage.ok || !wsClient) {
      typedCode = handshakeStage.typedCode;
      throw new Error("WebSocket handshake failed");
    }

    try {
      const describeStage = await runStage("runtime.describe", async () => {
        const res = await wsClient.call("runtime.describe", {});
        if (!res || typeof res !== "object") {
          throw Object.assign(new Error("Invalid runtime.describe response"), { typedCode: "rpc_failed" });
        }
      });
      if (!describeStage.ok) {
        typedCode = describeStage.typedCode;
        throw new Error("runtime.describe failed");
      }

      const capStage = await runStage("capabilities.describe", async () => {
        let succeeded = false;
        try {
          await wsClient.call("client.capabilities", { server_requests: true });
          succeeded = true;
        } catch (err) {
          if (err?.rpcCode !== -32601) {
            throw Object.assign(new Error("client.capabilities failed"), { typedCode: "rpc_failed" });
          }
        }
        try {
          await wsClient.call("capabilities.describe", {});
          succeeded = true;
        } catch (err) {
          if (err?.rpcCode !== -32601) {
            throw Object.assign(new Error("capabilities.describe failed"), { typedCode: "rpc_failed" });
          }
        }
        if (!succeeded) {
          throw Object.assign(new Error("Neither client.capabilities nor capabilities.describe supported"), {
            typedCode: "capability_unavailable",
          });
        }
      });
      if (!capStage.ok) {
        typedCode = capStage.typedCode;
        throw new Error("capabilities negotiation failed");
      }

      const profilesStage = await runStage("profiles.list", async () => {
        const res = await wsClient.call("profiles.list", {});
        if (!res || typeof res !== "object") {
          throw Object.assign(new Error("Invalid profiles.list response"), { typedCode: "rpc_failed" });
        }
      });
      if (!profilesStage.ok) {
        typedCode = profilesStage.typedCode;
        throw new Error("profiles.list failed");
      }

      const sessionsStage = await runStage("sessions.list", async () => {
        const listParams =
          options.profileId && options.profileId !== "default"
            ? { profile_id: options.profileId }
            : {};
        try {
          await wsClient.call("sessions.list", listParams);
        } catch (err) {
          if (err?.rpcCode === -32601) {
            try {
              await wsClient.call("session.list", listParams);
            } catch (err2) {
              throw Object.assign(new Error(err2 instanceof Error ? err2.message : "session.list failed"), {
                typedCode: "rpc_failed",
              });
            }
          } else {
            throw Object.assign(new Error("sessions.list failed"), { typedCode: "rpc_failed" });
          }
        }
      });
      if (!sessionsStage.ok) {
        typedCode = sessionsStage.typedCode;
        throw new Error("sessions.list failed");
      }

      const healthStage = await runStage("ws_health", async () => {
        await wsClient.ping(5000);
      });
      if (!healthStage.ok) {
        typedCode = healthStage.typedCode;
        throw new Error("WS health ping failed");
      }

      if (options.mode === "isolated" && options.withTurn) {
        const turnStage = await runStage("turn_smoke", async () => {
          const created = await wsClient.call("session.create", {
            profile_id: readyDial.endpoint.profileId,
            title: "Harness Smoke Turn",
          });
          const sessionId =
            created?.session?.session_id ??
            created?.session?.sessionId ??
            created?.session_id ??
            created?.sessionId;
          if (typeof sessionId !== "string" || !sessionId) {
            throw Object.assign(new Error("session.create did not return session_id"), {
              typedCode: "rpc_failed",
            });
          }
          await wsClient.call("prompt.submit", {
            profile_id: readyDial.endpoint.profileId,
            session_id: sessionId,
            text: "Reply with OK",
          });
        });
        if (!turnStage.ok) {
          typedCode = turnStage.typedCode;
          throw new Error("Optional turn smoke failed");
        }
      }
    } finally {
      wsCloseCode = wsClient.close(1000);
    }

    finalStatus = "passed";
    typedCode = null;
    exitCode = 0;
    sandboxPassed = true;
  } catch {
    if (finalStatus !== "skipped") {
      finalStatus = "failed";
      exitCode = 1;
      sandboxPassed = false;
    }
  } finally {
    if (options.mode === "isolated" && ownerStartAttempted && cliPath && hermesHomeDir) {
      const cleanupStarted = Date.now();
      const cleanupEnv = {
        ...env,
        HERMES_HOME: hermesHomeDir,
        HERMES_USER_DATA_DIR: userDataDir,
        HERMES_DESKTOP_E2E: "1",
      };
      const cleaned = await verifyIsolatedCleanup({
        cliPath,
        profileId: options.profileId,
        hermesHomeDir,
        childEnv: cleanupEnv,
        knownPid,
        wsUrl: endpointWsUrl,
        logs,
      });
      const cleanupDuration = Math.max(0, Date.now() - cleanupStarted);
      if (cleaned) {
        stages.push({ name: "cleanup", status: "ok", durationMs: cleanupDuration });
      } else {
        stages.push({
          name: "cleanup",
          status: "failed",
          durationMs: cleanupDuration,
          code: "cleanup_failed",
        });
        finalStatus = "failed";
        typedCode = typedCode ?? "cleanup_failed";
        exitCode = 1;
        sandboxPassed = false;
      }
    }

    if (sandboxRoot) {
      const keep = (env.KEEP_TEST_SANDBOX ?? process.env.KEEP_TEST_SANDBOX) === "1";
      if (sandboxPassed && !keep) {
        try {
          fs.rmSync(sandboxRoot, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  const written = writeArtifacts(
    makeBaseReport({
      status: finalStatus,
      hermesHomeKind,
      cliCapabilitiesSummary: cliSummary,
      typedCode,
      wsCloseCode,
      exitCode,
    }),
    options.reportDir,
  );

  return {
    exitCode,
    sandboxRoot,
    ...written,
  };
}
