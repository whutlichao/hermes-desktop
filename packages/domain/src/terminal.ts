import type {
  BridgeScope,
  GitWorktreeDeepLinkCatalog,
  TerminalSnapshot,
} from "@hermes/contracts";
import { resolveExternalAttribution } from "./capabilityRegistry";
import { getCopy } from "./copy";

export const TERMINAL_MAX_SCROLLBACK_LINES = 10_000;
export const TERMINAL_MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;

export interface TerminalScrollbackLimits {
  maxLines?: number;
  maxBytes?: number;
}

export interface TerminalScrollbackState {
  lines: string[];
  lineBytes: number[];
  currentLine: string;
  currentLineBytes: number;
  trimmedOldest: boolean;
  totalBytes: number;
}

const textEncoder = new TextEncoder();

function measureUtf8Bytes(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * Strips ANSI CSI/OSC/single-character escape sequences while preserving \r, \n, \b, \t.
 */
function stripAnsiSequences(raw: string): string {
  // OSC: ESC ] ... (BEL or ST)
  let out = raw.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  // CSI: ESC [ ... final byte
  out = out.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  // 2-byte ESC sequences and standalone BEL
  out = out.replace(/\u001b[@-Z\\-_]/g, "").replace(/\u0007/g, "");
  return out;
}

export function createTerminalScrollbackState(): TerminalScrollbackState {
  return {
    lines: [],
    lineBytes: [],
    currentLine: "",
    currentLineBytes: 0,
    trimmedOldest: false,
    totalBytes: 0,
  };
}

export function appendTerminalChunk(
  prev: TerminalScrollbackState,
  rawChunk: string,
  limits?: TerminalScrollbackLimits,
): TerminalScrollbackState {
  if (!rawChunk) return prev;

  const maxLines = limits?.maxLines ?? TERMINAL_MAX_SCROLLBACK_LINES;
  const maxBytes = limits?.maxBytes ?? TERMINAL_MAX_SCROLLBACK_BYTES;

  const lines = [...prev.lines];
  const lineBytes = [...prev.lineBytes];
  let currentLine = prev.currentLine;
  let totalCommittedBytes = lines.reduce((acc, _l, idx) => acc + (lineBytes[idx] ?? 0), 0);
  let trimmedOldest = prev.trimmedOldest;

  const cleaned = stripAnsiSequences(rawChunk);

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === "\r") {
      if (cleaned[i + 1] === "\n") {
        const bytes = measureUtf8Bytes(currentLine) + 1;
        lines.push(currentLine);
        lineBytes.push(bytes);
        totalCommittedBytes += bytes;
        currentLine = "";
        i += 1;
      } else {
        // Carriage return rewinds cursor to column 0 of current line
        currentLine = "";
      }
      continue;
    }
    if (ch === "\n") {
      const bytes = measureUtf8Bytes(currentLine) + 1;
      lines.push(currentLine);
      lineBytes.push(bytes);
      totalCommittedBytes += bytes;
      currentLine = "";
      continue;
    }
    if (ch === "\b") {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 && ch !== "\t") {
      continue;
    }
    currentLine += ch;
  }

  const currentLineBytes = measureUtf8Bytes(currentLine);

  // Drop only oldest complete lines when exceeding line cap or byte cap
  let startIndex = 0;
  const effectiveLinesCount = () => lines.length - startIndex + (currentLine.length > 0 ? 1 : 0);

  while (effectiveLinesCount() > maxLines && startIndex < lines.length) {
    totalCommittedBytes -= lineBytes[startIndex] ?? 0;
    startIndex += 1;
    trimmedOldest = true;
  }

  while (totalCommittedBytes + currentLineBytes > maxBytes && startIndex < lines.length) {
    totalCommittedBytes -= lineBytes[startIndex] ?? 0;
    startIndex += 1;
    trimmedOldest = true;
  }

  const nextLines = startIndex > 0 ? lines.slice(startIndex) : lines;
  const nextLineBytes = startIndex > 0 ? lineBytes.slice(startIndex) : lineBytes;

  return {
    lines: nextLines,
    lineBytes: nextLineBytes,
    currentLine,
    currentLineBytes,
    trimmedOldest,
    totalBytes: totalCommittedBytes + currentLineBytes,
  };
}

export function projectTerminalScrollbackLines(state: TerminalScrollbackState): string[] {
  if (state.currentLine.length > 0) {
    return [...state.lines, state.currentLine];
  }
  return [...state.lines];
}

export function createEmptyTerminalSnapshot(
  scope?: BridgeScope | null,
  overrides?: Partial<TerminalSnapshot>,
): TerminalSnapshot {
  const normalizedScope: BridgeScope = {
    connectionId: scope?.connectionId ?? "local",
    profileId: scope?.profileId ?? "default",
  };
  return {
    terminalId: null,
    scope: normalizedScope,
    status: "idle",
    cols: TERMINAL_DEFAULT_COLS,
    rows: TERMINAL_DEFAULT_ROWS,
    granted: false,
    rootGranted: false,
    hasForegroundProcess: false,
    lines: [],
    trimmedOldest: false,
    totalBytes: 0,
    lineCount: 0,
    exitCode: null,
    attribution: resolveExternalAttribution({ source: "bundled" }),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildGitWorktreeDeepLinks(): GitWorktreeDeepLinkCatalog {
  const neverExecuted = getCopy("extensions.cli.neverExecuted");
  const gitAttr = resolveExternalAttribution({ providerKind: "tool", toolset: "git" });
  const ghAttr = resolveExternalAttribution({ providerKind: "tool", toolset: "gh" });

  return {
    boundaryNote: getCopy("workspace.git.deepLinkBoundary"),
    cliItems: [
      {
        id: "git-status",
        labelKey: "workspace.git.cliStatusLabel",
        command: "git status --short --branch",
        executionNote: neverExecuted,
        attribution: gitAttr,
      },
      {
        id: "git-worktree-list",
        labelKey: "workspace.git.cliWorktreeListLabel",
        command: "git worktree list",
        executionNote: neverExecuted,
        attribution: gitAttr,
      },
      {
        id: "git-diff-stat",
        labelKey: "workspace.git.cliDiffStatLabel",
        command: "git diff --stat",
        executionNote: neverExecuted,
        attribution: gitAttr,
      },
      {
        id: "gh-pr-status",
        labelKey: "workspace.git.cliGhPrStatusLabel",
        command: "gh pr status",
        executionNote: neverExecuted,
        attribution: ghAttr,
      },
    ],
    docLinks: [
      {
        id: "git-worktree-docs",
        labelKey: "workspace.git.docWorktreeLabel",
        url: "https://git-scm.com/docs/git-worktree",
        attribution: gitAttr,
      },
      {
        id: "git-status-docs",
        labelKey: "workspace.git.docStatusLabel",
        url: "https://git-scm.com/docs/git-status",
        attribution: gitAttr,
      },
      {
        id: "gh-cli-docs",
        labelKey: "workspace.git.docGhCliLabel",
        url: "https://cli.github.com/manual/",
        attribution: ghAttr,
      },
    ],
  };
}
