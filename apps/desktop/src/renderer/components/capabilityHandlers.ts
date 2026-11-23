import type { CapabilityDomainId, CapabilityEntry, CapabilityRuntimeStatus } from "@hermes/contracts";
import type { CopyKey } from "@hermes/domain";

export const CAPABILITY_HANDLER_IDS = [
  "chat.focusComposer",
  "chat.stopTurn",
  "chat.focusSteer",
  "capabilities.inspectApproval",
  "session.create",
  "surface.openSessions",
  "session.resumeActive",
  "capabilities.copyCli",
  "workspace.openTerminal",
  "surface.openSettings",
  "surface.openCapabilities",
  "surface.openShortcuts",
  "surface.openScopePopover",
  "capabilities.probeDomain",
  "workspace.toggle",
  "workspace.openFiles",
  "workspace.openGit",
  "workspace.openAgents",
  "workspace.openCheckpoints",
] as const;

export type CapabilityHandlerId = (typeof CAPABILITY_HANDLER_IDS)[number];

export type CapabilityActionHandler = (entry: CapabilityEntry) => void | Promise<void>;

export interface CapabilityHandlerDependencies {
  focusComposer: () => void;
  stopTurn: () => void | Promise<void>;
  inspectApproval: (entry: CapabilityEntry) => void | Promise<void>;
  createSession: () => void | Promise<unknown>;
  openSessions: () => void;
  resumeActiveSession: () => void | Promise<void>;
  copyCli: (entry: CapabilityEntry) => void | Promise<void>;
  openWorkspaceTab: (tab: "artifacts" | "files" | "git" | "agents" | "checkpoints" | "terminal") => void;
  toggleWorkspace: () => void;
  openSettings: () => void;
  openCapabilities: () => void;
  openShortcuts: () => void;
  openScopePopover: () => void;
  probeDomain: (domain: CapabilityDomainId) => void | Promise<void>;
}

export function createCapabilityHandlers(
  deps: CapabilityHandlerDependencies,
): Record<CapabilityHandlerId, CapabilityActionHandler> {
  return {
    "chat.focusComposer": () => {
      deps.focusComposer();
    },
    "chat.stopTurn": () => deps.stopTurn(),
    "chat.focusSteer": () => {
      deps.focusComposer();
    },
    "capabilities.inspectApproval": (entry) => deps.inspectApproval(entry),
    "session.create": () => {
      void deps.createSession();
    },
    "surface.openSessions": () => {
      deps.openSessions();
    },
    "session.resumeActive": () => deps.resumeActiveSession(),
    "capabilities.copyCli": (entry) => deps.copyCli(entry),
    "workspace.openTerminal": () => {
      deps.openWorkspaceTab("terminal");
    },
    "surface.openSettings": () => {
      deps.openSettings();
    },
    "surface.openCapabilities": () => {
      deps.openCapabilities();
    },
    "surface.openShortcuts": () => {
      deps.openShortcuts();
    },
    "surface.openScopePopover": () => {
      deps.openScopePopover();
    },
    "capabilities.probeDomain": (entry) => deps.probeDomain(entry.domain),
    "workspace.toggle": () => {
      deps.toggleWorkspace();
    },
    "workspace.openFiles": () => {
      deps.openWorkspaceTab("files");
    },
    "workspace.openGit": () => {
      deps.openWorkspaceTab("git");
    },
    "workspace.openAgents": () => {
      deps.openWorkspaceTab("agents");
    },
    "workspace.openCheckpoints": () => {
      deps.openWorkspaceTab("checkpoints");
    },
  };
}

export function getCapabilityStatusCopyKey(status: CapabilityRuntimeStatus): CopyKey {
  switch (status) {
    case "available":
      return "capabilities.status.available";
    case "read_only":
      return "capabilities.status.read_only";
    case "degraded":
      return "capabilities.status.degraded";
    case "deep_link":
      return "capabilities.status.deep_link";
    case "unavailable":
      return "capabilities.status.unavailable";
    case "unknown":
      return "capabilities.status.unknown";
  }
}
