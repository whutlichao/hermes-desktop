import fs from "node:fs";
import path from "node:path";
import type {
  ActiveChatRef,
  BridgeScope,
  PaneState,
  WindowBounds,
  WindowState,
  WorkspaceMode,
  WorkspaceTab,
} from "@hermes/contracts";
import { assertSafeSandboxRoot } from "./security";

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowStateStoreOptions {
  userDataDir: string;
  allowRealHome?: boolean;
  getDisplays?: () => DisplayWorkArea[];
}

const MIN_WINDOW_WIDTH = 1120;
const MIN_WINDOW_HEIGHT = 700;
const DEFAULT_BOUNDS: WindowBounds = { x: 0, y: 0, width: 1440, height: 900 };
const VALID_WORKSPACE_MODES = new Set<WorkspaceMode>(["closed", "hidden", "open"]);
const VALID_WORKSPACE_TABS = new Set<WorkspaceTab>([
  "artifacts",
  "files",
  "git",
  "agents",
  "terminal",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function pickNearestDisplay(
  bounds: WindowBounds,
  displays: DisplayWorkArea[],
): DisplayWorkArea {
  const valid = displays.filter(
    (d) =>
      Number.isFinite(d.x) &&
      Number.isFinite(d.y) &&
      Number.isFinite(d.width) &&
      d.width > 0 &&
      Number.isFinite(d.height) &&
      d.height > 0,
  );
  if (valid.length === 0) {
    return { x: 0, y: 0, width: 1440, height: 900 };
  }

  const bx = bounds.x ?? valid[0].x;
  const by = bounds.y ?? valid[0].y;
  const bw = bounds.width;
  const bh = bounds.height;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;

  let best = valid[0];
  let bestOverlap = -1;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (const d of valid) {
    const overlapW = Math.max(0, Math.min(bx + bw, d.x + d.width) - Math.max(bx, d.x));
    const overlapH = Math.max(0, Math.min(by + bh, d.y + d.height) - Math.max(by, d.y));
    const overlap = overlapW * overlapH;

    const clampedX = Math.max(d.x, Math.min(cx, d.x + d.width));
    const clampedY = Math.max(d.y, Math.min(cy, d.y + d.height));
    const distSq = (cx - clampedX) ** 2 + (cy - clampedY) ** 2;

    if (overlap > bestOverlap || (overlap === bestOverlap && distSq < bestDistSq)) {
      best = d;
      bestOverlap = overlap;
      bestDistSq = distSq;
    }
  }
  return best;
}

export function clampWindowBounds(
  rawBounds: Partial<WindowBounds> | undefined,
  displays: DisplayWorkArea[],
): WindowBounds {
  const baseWidth = finiteOr(rawBounds?.width, DEFAULT_BOUNDS.width);
  const baseHeight = finiteOr(rawBounds?.height, DEFAULT_BOUNDS.height);
  const candidate: WindowBounds = {
    x: typeof rawBounds?.x === "number" && Number.isFinite(rawBounds.x) ? Math.round(rawBounds.x) : undefined,
    y: typeof rawBounds?.y === "number" && Number.isFinite(rawBounds.y) ? Math.round(rawBounds.y) : undefined,
    width: baseWidth,
    height: baseHeight,
  };

  const workArea = pickNearestDisplay(candidate, displays);
  const minW = Math.min(MIN_WINDOW_WIDTH, workArea.width);
  const minH = Math.min(MIN_WINDOW_HEIGHT, workArea.height);
  const width = Math.max(minW, Math.min(workArea.width, candidate.width));
  const height = Math.max(minH, Math.min(workArea.height, candidate.height));

  const defaultX = workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2));
  const defaultY = workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2));
  const rawX = candidate.x ?? defaultX;
  const rawY = candidate.y ?? defaultY;

  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, rawX));
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, rawY));

  return { x, y, width, height };
}

function normalizeScope(raw: unknown): BridgeScope | null {
  if (!isPlainObject(raw)) return null;
  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId.trim() : "";
  if (!connectionId) return null;
  const profileId =
    typeof raw.profileId === "string" && raw.profileId.trim() ? raw.profileId.trim() : undefined;
  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : undefined;
  return {
    connectionId,
    ...(profileId ? { profileId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function normalizeActiveChat(raw: unknown): ActiveChatRef | null {
  if (!isPlainObject(raw)) return null;
  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId.trim() : "";
  const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : "";
  if (!connectionId || !profileId) return null;
  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : undefined;
  return {
    connectionId,
    profileId,
    ...(sessionId ? { sessionId } : {}),
  };
}

function normalizePane(raw: unknown): PaneState {
  const rec = isPlainObject(raw) ? raw : {};
  const ws = isPlainObject(rec.workspace) ? rec.workspace : {};
  const mode = VALID_WORKSPACE_MODES.has(ws.mode as WorkspaceMode)
    ? (ws.mode as WorkspaceMode)
    : "closed";
  const activeTab = VALID_WORKSPACE_TABS.has(ws.activeTab as WorkspaceTab)
    ? (ws.activeTab as WorkspaceTab)
    : "artifacts";

  return {
    paneId: "main",
    activeScope: normalizeScope(rec.activeScope),
    activeChat: normalizeActiveChat(rec.activeChat),
    workspace: {
      mode,
      activeTab,
    },
  };
}

function writeAtomic0600(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Persists single-window ("primary") and single-pane ("main") geometry + theme slot
 * inside userDataDir using 0600 atomic writes. Never derives or persists sidebar booleans.
 */
export class WindowStateStore {
  readonly filePath: string;
  private readonly getDisplays: () => DisplayWorkArea[];
  private cached: WindowState | null = null;

  constructor(options: WindowStateStoreOptions) {
    const safeUserDataDir = assertSafeSandboxRoot(options.userDataDir, {
      allowRealHome: Boolean(options.allowRealHome),
    });
    this.filePath = path.join(safeUserDataDir, "window-state.json");
    this.getDisplays =
      options.getDisplays ?? (() => [{ x: 0, y: 0, width: 1440, height: 900 }]);
  }

  private normalizeState(raw: unknown): WindowState {
    const rec = isPlainObject(raw) ? raw : {};
    const rawBounds = isPlainObject(rec.bounds) ? (rec.bounds as Partial<WindowBounds>) : undefined;
    const rawPanes = Array.isArray(rec.panes) ? rec.panes : [];
    const primaryPane = normalizePane(rawPanes[0]);

    return {
      windowId: "primary",
      bounds: clampWindowBounds(rawBounds, this.getDisplays()),
      theme: "quiet-relay-light",
      panes: [primaryPane],
    };
  }

  load(): WindowState {
    if (!fs.existsSync(this.filePath)) {
      const initial = this.normalizeState(undefined);
      this.cached = initial;
      return structuredClone(initial);
    }
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const normalized = this.normalizeState(parsed);
      this.cached = normalized;
      return structuredClone(normalized);
    } catch {
      const fallback = this.normalizeState(undefined);
      this.cached = fallback;
      return structuredClone(fallback);
    }
  }

  save(nextState: Partial<WindowState>): WindowState {
    const current = this.cached ?? this.load();
    const merged = this.normalizeState({
      ...current,
      ...nextState,
      windowId: "primary",
      theme: "quiet-relay-light",
      panes: nextState.panes ?? current.panes,
    });
    this.cached = merged;
    writeAtomic0600(this.filePath, `${JSON.stringify(merged, null, 2)}\n`);
    return structuredClone(merged);
  }

  saveBounds(bounds: Partial<WindowBounds>): WindowState {
    const current = this.cached ?? this.load();
    return this.save({
      ...current,
      bounds: clampWindowBounds(bounds, this.getDisplays()),
    });
  }

  savePane(panePatch: Partial<Omit<PaneState, "paneId">>): WindowState {
    const current = this.cached ?? this.load();
    const currentPane = current.panes[0];
    return this.save({
      ...current,
      panes: [
        {
          paneId: "main",
          activeScope:
            panePatch.activeScope !== undefined ? panePatch.activeScope : currentPane.activeScope,
          activeChat:
            panePatch.activeChat !== undefined ? panePatch.activeChat : currentPane.activeChat,
          workspace: panePatch.workspace ?? currentPane.workspace,
        },
      ],
    });
  }
}
