import { describe, expect, it } from "vitest";
import {
  FocusReturnController,
  type FocusableNodeDescriptor,
} from "./focusReturnController";

interface FakeFocusNode extends FocusableNodeDescriptor {
  id: string;
}

function makeNode(
  id: string,
  overrides: Partial<FocusableNodeDescriptor> = {},
): FakeFocusNode {
  return {
    id,
    connected: true,
    visible: true,
    focusable: true,
    inert: false,
    isBody: false,
    ...overrides,
  };
}

describe("FocusReturnController (S4 surface stack LIFO, Esc single-layer, deterministic return & fallback)", () => {
  it("maintains LIFO surface stack and closes only the topmost surface on Escape", () => {
    const nodes = new Map<string, FakeFocusNode>([
      ["palette-trigger", makeNode("palette-trigger")],
      ["palette-input", makeNode("palette-input")],
      ["shortcuts-close", makeNode("shortcuts-close")],
      ["composer", makeNode("composer")],
    ]);

    let focusedId: string | null = "palette-trigger";
    const controller = new FocusReturnController<FakeFocusNode>({
      inspectNode: (node) => node ?? null,
      focusNode: (node) => {
        focusedId = node.id;
      },
      getActiveNode: () => (focusedId ? nodes.get(focusedId) ?? null : null),
      getAnchorNode: (anchor) => {
        if (anchor === "composer") return nodes.get("composer") ?? null;
        if (anchor === "paletteTrigger") return nodes.get("palette-trigger") ?? null;
        return null;
      },
      hasActiveChat: () => true,
    });

    // Open palette (layer: modal)
    const paletteInit = controller.register("palette", {
      layer: "modal",
      initialFocus: () => nodes.get("palette-input") ?? null,
      returnFocus: nodes.get("palette-trigger") ?? null,
    });
    expect(paletteInit?.id).toBe("palette-input");
    expect(focusedId).toBe("palette-input");
    expect(controller.getStack()).toEqual(["palette"]);

    // Open shortcuts on top of palette
    const shortcutsInit = controller.register("shortcuts", {
      layer: "modal",
      initialFocus: () => nodes.get("shortcuts-close") ?? null,
      returnFocus: nodes.get("palette-input") ?? null,
    });
    expect(shortcutsInit?.id).toBe("shortcuts-close");
    expect(focusedId).toBe("shortcuts-close");
    expect(controller.getStack()).toEqual(["palette", "shortcuts"]);
    expect(controller.getTopmostSurface()).toBe("shortcuts");

    // First Escape closes ONLY shortcuts and returns focus to palette-input
    const firstEsc = controller.closeTopmost("escape");
    expect(firstEsc?.closedSurfaceId).toBe("shortcuts");
    expect(firstEsc?.returnTarget?.id).toBe("palette-input");
    expect(focusedId).toBe("palette-input");
    expect(controller.getStack()).toEqual(["palette"]);

    // Second Escape closes palette and returns focus to palette-trigger
    const secondEsc = controller.closeTopmost("escape");
    expect(secondEsc?.closedSurfaceId).toBe("palette");
    expect(secondEsc?.returnTarget?.id).toBe("palette-trigger");
    expect(focusedId).toBe("palette-trigger");
    expect(controller.getStack()).toEqual([]);
  });

  it("never returns focus to body, hidden, inert, unfocusable, or disconnected nodes", () => {
    const bodyNode = makeNode("document-body", { isBody: true });
    const hiddenNode = makeNode("hidden-trigger", { visible: false });
    const inertNode = makeNode("inert-trigger", { inert: true });
    const disconnectedNode = makeNode("removed-trigger", { connected: false });
    const composerNode = makeNode("composer");

    let focusedId: string | null = null;
    const controller = new FocusReturnController<FakeFocusNode>({
      inspectNode: (node) => node ?? null,
      focusNode: (node) => {
        focusedId = node.id;
      },
      getActiveNode: () => bodyNode,
      getAnchorNode: (anchor) => (anchor === "composer" ? composerNode : null),
      hasActiveChat: () => true,
    });

    for (const invalidTrigger of [bodyNode, hiddenNode, inertNode, disconnectedNode]) {
      controller.register("palette", {
        layer: "modal",
        initialFocus: () => composerNode,
        returnFocus: invalidTrigger,
      });
      const target = controller.resolveReturn("palette");
      expect(target?.id).toBe("composer");
      const closed = controller.closeTopmost("escape");
      expect(closed?.returnTarget?.id).toBe("composer");
      expect(focusedId).toBe("composer");
    }
  });

  it("resolves deterministic fallbacks for ⌘K palette (composer when ActiveChat exists, rail newSession when no ActiveChat), ⌘B workspace, sessionsPopover, and settings", () => {
    const nodes = new Map<string, FakeFocusNode>([
      ["composer", makeNode("composer")],
      ["rail-new-session", makeNode("rail-new-session")],
      ["workspace-trigger", makeNode("workspace-trigger")],
      ["sessions-trigger", makeNode("sessions-trigger")],
      ["active-session-row", makeNode("active-session-row")],
      ["settings-gear", makeNode("settings-gear")],
      ["lost-trigger", makeNode("lost-trigger", { connected: false })],
    ]);

    let hasActiveChat = true;
    let focusedId: string | null = null;
    const controller = new FocusReturnController<FakeFocusNode>({
      inspectNode: (node) => node ?? null,
      focusNode: (node) => {
        focusedId = node.id;
      },
      getActiveNode: () => (focusedId ? nodes.get(focusedId) ?? null : null),
      getAnchorNode: (anchor) => {
        switch (anchor) {
          case "composer":
            return hasActiveChat ? nodes.get("composer") ?? null : null;
          case "railNewSession":
            return nodes.get("rail-new-session") ?? null;
          case "workspaceTrigger":
            return nodes.get("workspace-trigger") ?? null;
          case "sessionsPopoverTrigger":
            return nodes.get("sessions-trigger") ?? null;
          case "activeSessionRow":
            return nodes.get("active-session-row") ?? null;
          case "settingsTrigger":
            return nodes.get("settings-gear") ?? null;
          default:
            return null;
        }
      },
      hasActiveChat: () => hasActiveChat,
    });

    // 1. ⌘K palette with lost trigger + ActiveChat -> composer
    controller.register("palette", {
      layer: "modal",
      returnFocus: nodes.get("lost-trigger") ?? null,
    });
    expect(controller.closeTopmost("escape")?.returnTarget?.id).toBe("composer");

    // 2. ⌘K palette with lost trigger + NO ActiveChat -> railNewSession
    hasActiveChat = false;
    controller.register("palette", {
      layer: "modal",
      returnFocus: nodes.get("lost-trigger") ?? null,
    });
    expect(controller.closeTopmost("escape")?.returnTarget?.id).toBe("rail-new-session");
    hasActiveChat = true;

    // 3. ⌘B workspace with lost pre-⌘B focus -> workspaceTrigger
    controller.register("workspace", {
      layer: "drawer",
      returnFocus: nodes.get("lost-trigger") ?? null,
    });
    expect(controller.closeTopmost("escape")?.returnTarget?.id).toBe("workspace-trigger");

    // 4. sessionsPopover -> sessionsPopoverTrigger, or activeSessionRow if trigger hidden
    controller.register("sessionsPopover", {
      layer: "popover",
      returnFocus: nodes.get("sessions-trigger") ?? null,
    });
    expect(controller.closeTopmost("escape")?.returnTarget?.id).toBe("sessions-trigger");

    nodes.set("sessions-trigger", makeNode("sessions-trigger", { visible: false }));
    controller.register("sessionsPopover", {
      layer: "popover",
      returnFocus: nodes.get("sessions-trigger") ?? null,
    });
    expect(controller.closeTopmost("escape")?.returnTarget?.id).toBe("active-session-row");

    // 5. settings (⌘,) with lost trigger -> settingsTrigger (gear)
    controller.register("settings", {
      layer: "modal",
      returnFocus: nodes.get("lost-trigger") ?? null,
    });
    expect(controller.closeTopmost("escape")?.returnTarget?.id).toBe("settings-gear");
  });

  it("handles confirmation cancel vs confirm successor, preserves focus on route banner dismiss, keeps focus on clicked Session row, and skips return on window close (⌘W)", () => {
    const triggerBtn = makeNode("escape-trigger-btn");
    const settingsInput = makeNode("settings-dialog-input");
    const composer = makeNode("composer");
    const sessionRowB = makeNode("session-row-b");

    let focusedId: string | null = "composer";
    const controller = new FocusReturnController<FakeFocusNode>({
      inspectNode: (node) => node ?? null,
      focusNode: (node) => {
        focusedId = node.id;
      },
      getActiveNode: () => {
        if (focusedId === "composer") return composer;
        if (focusedId === "session-row-b") return sessionRowB;
        return null;
      },
      getAnchorNode: (anchor) => (anchor === "composer" ? composer : null),
      hasActiveChat: () => true,
    });

    // Confirmation cancel -> returns to trigger button
    controller.register("remoteEscape", {
      layer: "modal",
      returnFocus: triggerBtn,
      confirmSuccessor: () => settingsInput,
    });
    expect(controller.closeTopmost("cancel")?.returnTarget?.id).toBe("escape-trigger-btn");
    expect(focusedId).toBe("escape-trigger-btn");

    // Confirmation confirm -> focuses logical successor (settingsInput)
    controller.register("remoteEscape", {
      layer: "modal",
      returnFocus: triggerBtn,
      confirmSuccessor: () => settingsInput,
    });
    expect(controller.closeTopmost("confirm")?.returnTarget?.id).toBe("settings-dialog-input");
    expect(focusedId).toBe("settings-dialog-input");

    // Route banner dismiss -> does NOT change focus away from composer
    focusedId = "composer";
    controller.preserveFocusOnBannerDismiss();
    expect(focusedId).toBe("composer");

    // Mouse click on Session row -> focus stays on clicked Session row
    controller.focusSessionRow(sessionRowB);
    expect(focusedId).toBe("session-row-b");

    // ⌘W closeWindow -> clears stack without triggering return focus
    controller.register("palette", {
      layer: "modal",
      returnFocus: triggerBtn,
    });
    focusedId = "session-row-b";
    controller.handleWindowClose();
    expect(controller.getStack()).toEqual([]);
    expect(focusedId).toBe("session-row-b");
  });
});
