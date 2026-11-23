export type FocusSurfaceId =
  | "palette"
  | "settings"
  | "capabilities"
  | "shortcuts"
  | "sessionsPopover"
  | "scopePopover"
  | "diagnostics"
  | "remoteEscape"
  | "workspace"
  | (string & {});

export type FocusSurfaceLayer = "modal" | "popover" | "drawer";

export type FocusCloseReason =
  | "escape"
  | "explicit"
  | "cancel"
  | "confirm"
  | "shortcut";

export type FocusAnchorId =
  | "composer"
  | "railNewSession"
  | "paletteTrigger"
  | "workspaceTrigger"
  | "settingsTrigger"
  | "capabilitiesTrigger"
  | "sessionsPopoverTrigger"
  | "scopePopoverTrigger"
  | "activeSessionRow";

export interface FocusableNodeDescriptor {
  connected: boolean;
  visible: boolean;
  focusable: boolean;
  inert: boolean;
  isBody: boolean;
}

export interface FocusSurfaceRegistration<TNode> {
  layer: FocusSurfaceLayer;
  initialFocus?: TNode | (() => TNode | null) | null;
  returnFocus?: TNode | (() => TNode | null) | null;
  confirmSuccessor?: TNode | (() => TNode | null) | null;
}

export interface FocusReturnControllerOptions<TNode> {
  inspectNode: (node: TNode | null | undefined) => FocusableNodeDescriptor | null;
  focusNode: (node: TNode) => void;
  getActiveNode?: () => TNode | null;
  getAnchorNode?: (anchor: FocusAnchorId) => TNode | null;
  hasActiveChat?: () => boolean;
}

export interface FocusCloseResult<TNode> {
  closedSurfaceId: FocusSurfaceId;
  reason: FocusCloseReason;
  returnTarget: TNode | null;
  remainingStack: FocusSurfaceId[];
}

interface InternalSurfaceEntry<TNode> {
  surfaceId: FocusSurfaceId;
  layer: FocusSurfaceLayer;
  initialFocus?: TNode | (() => TNode | null) | null;
  returnFocus?: TNode | (() => TNode | null) | null;
  confirmSuccessor?: TNode | (() => TNode | null) | null;
}

const ALL_FALLBACK_ANCHORS: FocusAnchorId[] = [
  "composer",
  "railNewSession",
  "workspaceTrigger",
  "paletteTrigger",
  "settingsTrigger",
  "capabilitiesTrigger",
  "sessionsPopoverTrigger",
  "scopePopoverTrigger",
  "activeSessionRow",
];

export class FocusReturnController<TNode> {
  private readonly options: FocusReturnControllerOptions<TNode>;
  private stack: Array<InternalSurfaceEntry<TNode>> = [];

  constructor(options: FocusReturnControllerOptions<TNode>) {
    this.options = options;
  }

  isValidTarget(node: TNode | null | undefined): node is TNode {
    if (!node) return false;
    const desc = this.options.inspectNode(node);
    if (!desc) return false;
    return (
      desc.connected &&
      desc.visible &&
      desc.focusable &&
      !desc.inert &&
      !desc.isBody
    );
  }

  private unwrapCandidate(
    candidate: TNode | (() => TNode | null) | null | undefined,
  ): TNode | null {
    if (!candidate) return null;
    if (typeof candidate === "function") {
      return (candidate as () => TNode | null)();
    }
    return candidate;
  }

  getStack(): FocusSurfaceId[] {
    return this.stack.map((entry) => entry.surfaceId);
  }

  getTopmostSurface(): FocusSurfaceId | null {
    if (this.stack.length === 0) return null;
    return this.stack[this.stack.length - 1].surfaceId;
  }

  register(
    surfaceId: FocusSurfaceId,
    config: FocusSurfaceRegistration<TNode>,
  ): TNode | null {
    const activeBefore = this.options.getActiveNode?.() ?? null;
    const explicitReturn = config.returnFocus !== undefined ? config.returnFocus : activeBefore;

    this.stack = this.stack.filter((entry) => entry.surfaceId !== surfaceId);
    this.stack.push({
      surfaceId,
      layer: config.layer,
      initialFocus: config.initialFocus,
      returnFocus: explicitReturn,
      confirmSuccessor: config.confirmSuccessor,
    });

    const initialTarget = this.resolveInitialFocus(surfaceId);
    if (initialTarget) {
      this.options.focusNode(initialTarget);
    }
    return initialTarget;
  }

  resolveInitialFocus(surfaceId: FocusSurfaceId): TNode | null {
    const entry = this.stack.find((item) => item.surfaceId === surfaceId);
    if (!entry) return null;
    const candidate = this.unwrapCandidate(entry.initialFocus);
    if (this.isValidTarget(candidate)) {
      return candidate;
    }
    return null;
  }

  private getSurfaceFallbackAnchors(surfaceId: FocusSurfaceId): FocusAnchorId[] {
    const hasChat = this.options.hasActiveChat ? this.options.hasActiveChat() : true;
    switch (surfaceId) {
      case "palette":
        return hasChat
          ? ["composer", "railNewSession", "paletteTrigger", "workspaceTrigger"]
          : ["railNewSession", "composer", "paletteTrigger", "workspaceTrigger"];
      case "sessionsPopover":
        return ["sessionsPopoverTrigger", "activeSessionRow", "composer", "railNewSession"];
      case "workspace":
        return ["workspaceTrigger", "composer", "railNewSession", "paletteTrigger"];
      case "settings":
        return ["settingsTrigger", "composer", "railNewSession", "paletteTrigger"];
      case "capabilities":
        return ["capabilitiesTrigger", "composer", "railNewSession", "paletteTrigger"];
      case "scopePopover":
        return ["scopePopoverTrigger", "composer", "railNewSession", "paletteTrigger"];
      case "shortcuts":
      case "diagnostics":
      case "remoteEscape":
      default:
        return hasChat
          ? ["composer", "paletteTrigger", "settingsTrigger", "railNewSession"]
          : ["railNewSession", "paletteTrigger", "settingsTrigger", "composer"];
    }
  }

  resolveReturn(
    surfaceId: FocusSurfaceId,
    reason: FocusCloseReason = "explicit",
  ): TNode | null {
    const entry = this.stack.find((item) => item.surfaceId === surfaceId);

    // 1. If confirmed and confirmSuccessor is configured and valid, return it
    if (reason === "confirm" && entry?.confirmSuccessor) {
      const successor = this.unwrapCandidate(entry.confirmSuccessor);
      if (this.isValidTarget(successor)) {
        return successor;
      }
    }

    // 2. Try recorded returnFocus trigger
    if (entry?.returnFocus) {
      const recorded = this.unwrapCandidate(entry.returnFocus);
      if (this.isValidTarget(recorded)) {
        return recorded;
      }
    }

    // 3. If another surface remains beneath this one in the stack, try its initialFocus
    const remaining = this.stack.filter((item) => item.surfaceId !== surfaceId);
    if (remaining.length > 0) {
      const below = remaining[remaining.length - 1];
      const belowInitial = this.unwrapCandidate(below.initialFocus);
      if (this.isValidTarget(belowInitial)) {
        return belowInitial;
      }
    }

    // 4. Deterministic per-surface anchor fallback chain
    const getAnchor = this.options.getAnchorNode;
    if (getAnchor) {
      const orderedAnchors = [
        ...this.getSurfaceFallbackAnchors(surfaceId),
        ...ALL_FALLBACK_ANCHORS,
      ];
      const seen = new Set<FocusAnchorId>();
      for (const anchorId of orderedAnchors) {
        if (seen.has(anchorId)) continue;
        seen.add(anchorId);
        const anchorNode = getAnchor(anchorId);
        if (this.isValidTarget(anchorNode)) {
          return anchorNode;
        }
      }
    }

    return null;
  }

  closeTopmost(reason: FocusCloseReason = "escape"): FocusCloseResult<TNode> | null {
    if (this.stack.length === 0) return null;
    const topEntry = this.stack[this.stack.length - 1];
    return this.closeSurface(topEntry.surfaceId, reason);
  }

  closeSurface(
    surfaceId: FocusSurfaceId,
    reason: FocusCloseReason = "explicit",
  ): FocusCloseResult<TNode> | null {
    const exists = this.stack.some((item) => item.surfaceId === surfaceId);
    if (!exists) return null;

    const returnTarget = this.resolveReturn(surfaceId, reason);
    this.stack = this.stack.filter((item) => item.surfaceId !== surfaceId);

    if (returnTarget) {
      this.options.focusNode(returnTarget);
    }

    return {
      closedSurfaceId: surfaceId,
      reason,
      returnTarget,
      remainingStack: this.getStack(),
    };
  }

  focusSessionRow(rowNode: TNode | null | undefined): TNode | null {
    if (this.isValidTarget(rowNode)) {
      this.options.focusNode(rowNode);
      return rowNode;
    }
    return null;
  }

  preserveFocusOnBannerDismiss(): TNode | null {
    const active = this.options.getActiveNode?.() ?? null;
    if (this.isValidTarget(active)) {
      return active;
    }
    const fallback = this.resolveReturn("palette", "explicit");
    if (fallback) {
      this.options.focusNode(fallback);
    }
    return fallback;
  }

  handleWindowClose(): void {
    this.stack = [];
  }
}
