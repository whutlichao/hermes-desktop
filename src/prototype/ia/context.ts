import { createContext, useContext } from "react";
import type { CapTier, DomainId, Scene, Scope, Variant } from "./data";

export type Surface =
  | "none"
  | "palette"
  | "settings"
  | "capability"
  | "workspace"
  | "approval"
  | "sessions"
  | "scope";

export type WorkspaceTab = "artifacts" | "files" | "git" | "agents" | "terminal";
export type ApprovalStatus = "pending" | "approved" | "denied" | "inspected";
export type DomainStatus = "available" | "read_only" | "unavailable";

export interface Notice {
  id: number;
  message: string;
  tone: "default" | "accent";
}

export interface IaApi {
  variant: Variant;
  scene: Scene;
  capTier: CapTier;
  surface: Surface;
  domainId: DomainId;
  activeSessionId: string;
  scope: Scope;
  connectionHealth: "reachable" | "degraded";
  approvalStatus: ApprovalStatus;
  approvalPending: number;
  workspaceTab: WorkspaceTab;
  terminalLines: string[];
  notice: Notice | null;
  setVariant: (variant: Variant) => void;
  setScene: (scene: Scene) => void;
  setCapTier: (tier: CapTier) => void;
  openPalette: () => void;
  openSettings: () => void;
  openCapability: (domain?: DomainId) => void;
  openWorkspace: (tab?: WorkspaceTab) => void;
  openApproval: () => void;
  openSessions: () => void;
  openScope: () => void;
  closeSurface: () => void;
  setSurface: (surface: Surface) => void;
  setDomain: (domain: DomainId) => void;
  setActiveSession: (sessionId: string) => void;
  setScope: (scopeId: string) => void;
  setApprovalStatus: (status: ApprovalStatus) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  closeWorkspace: (resetTerminal?: boolean) => void;
  appendTerminal: (line: string) => void;
  resetTerminal: () => void;
  retryConnection: () => void;
  notify: (message: string, tone?: "default" | "accent") => void;
  copy: (value: string, label?: string) => Promise<void>;
  domainStatus: (domain: DomainId) => DomainStatus;
}

export const IaContext = createContext<IaApi | null>(null);

export function useIa(): IaApi {
  const value = useContext(IaContext);
  if (!value) throw new Error("useIa must be used inside IaPrototype");
  return value;
}
