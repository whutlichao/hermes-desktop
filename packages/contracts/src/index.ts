export const HOST_BRIDGE_VERSION = 1 as const;

export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "scope_mismatch",
  "not_found",
  "conflict",
  "auth_required",
  "auth_failed",
  "unreachable",
  "timeout",
  "protocol_unsupported",
  "unknown_turn",
  "approval_stale",
  "approval_scope_mismatch",
  "capability_unavailable",
  "permission_denied",
  "cancelled",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HOST_COMMANDS = [
  "bridge.hello",
  "connections.list",
  "connections.add",
  "connections.update",
  "connections.remove",
  "connections.test",
  "connections.retry",
  "connections.setPrimary",
  "profiles.list",
  "auth.start",
  "auth.cancel",
  "sessions.list",
  "sessions.create",
  "sessions.select",
  "sessions.resume",
  "prompts.send",
  "prompts.stop",
  "prompts.steer",
  "approvals.respond",
  "clarify.respond",
  "capabilities.describe",
  "config.get",
  "config.update",
  "files.list",
  "files.read",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "artifacts.list",
  "artifacts.read",
  "diagnostics.export",
  "local.inspect",
  "local.selectCli",
  "local.diagnose",
  "links.openExternal",
] as const;

export type HostCommand = (typeof HOST_COMMANDS)[number];

export const HOST_TOPICS = [
  "fleet",
  "connection.health",
  "profiles",
  "sessions",
  "session.transcript",
  "prompt",
  "activity",
  "approval",
  "clarify",
  "capabilities",
  "terminal",
  "registry",
  "auth.state",
] as const;

export type HostTopic = (typeof HOST_TOPICS)[number];

export interface BridgeScope {
  connectionId: string;
  profileId?: string;
  sessionId?: string;
}

export interface BridgeError {
  code: ErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
}

export type BridgeResult<T = unknown> =
  | { ok: true; requestId: string; value: T }
  | { ok: false; requestId: string; error: BridgeError };

export interface BridgeEvent<T = unknown> {
  topic: HostTopic;
  scope: BridgeScope | null;
  kind: "snapshot" | "patch" | "resync_required";
  seq: number;
  revision: number;
  payload: T;
}

export type AppCommand =
  | { type: "open_palette" }
  | { type: "open_settings" }
  | { type: "toggle_workspace" }
  | { type: "new_session" }
  | { type: "close_window" }
  | { type: "open_shortcuts" }
  | { type: "focus_scope"; scope: BridgeScope };

export interface AppInfo {
  bridgeVersion: typeof HOST_BRIDGE_VERSION;
  appName: "Hermes Desktop";
  appVersion: string;
  mode: "electron" | "mock";
  platform: string;
  arch: string;
  capabilitiesReady: boolean;
  codeSha?: string;
}

export interface HostRequestEnvelope {
  version: number;
  requestId: string;
  command: HostCommand;
  scope?: BridgeScope | null;
  payload?: Record<string, unknown>;
}

export interface HermesHost {
  readonly version: typeof HOST_BRIDGE_VERSION;
  request<T = unknown>(
    command: HostCommand,
    payload?: Record<string, unknown>,
    scope?: BridgeScope | null,
  ): Promise<BridgeResult<T>>;
  subscribe(
    topic: HostTopic,
    scope: BridgeScope | null,
    listener: (event: BridgeEvent) => void,
  ): () => void;
  onCommand(listener: (command: AppCommand) => void): () => void;
}

export type ConnectionKind = "local" | "remote" | "ssh" | "cloud";

export type ConnectionActualState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "auth_required"
  | "blocked"
  | "stopping";

export interface ConnectionHealthSummary {
  connectionId: string;
  label: string;
  kind: ConnectionKind;
  originDisplay: string;
  actual: ConnectionActualState;
  degraded: boolean;
  latencyMs: number | null;
  nextRetryAt: number | null;
  errorCode?: ErrorCode;
  message?: string;
}

export interface ProfileSummary {
  connectionId: string;
  profileId: string;
  displayName: string;
  handle: string;
  isDefault: boolean;
}

export interface SessionSummary {
  connectionId: string;
  profileId: string;
  sessionId: string;
  title: string;
  preview: string;
  updatedAt: string;
  pinned: boolean;
  unreadCount: number;
  needsInput: boolean;
}

export interface FleetSnapshot {
  connections: ConnectionHealthSummary[];
  profiles: ProfileSummary[];
  sessions: SessionSummary[];
  activeScope: BridgeScope | null;
  activeSessionId: string | null;
}

export type WindowTheme = "quiet-relay-light";

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface ActiveChatRef {
  connectionId: string;
  profileId: string;
  sessionId?: string;
}

export type WorkspaceMode = "closed" | "hidden" | "open";

export type WorkspaceTab = "artifacts" | "files" | "git" | "agents" | "terminal";

export interface PaneState {
  paneId: string;
  activeScope: BridgeScope | null;
  activeChat: ActiveChatRef | null;
  workspace: {
    mode: WorkspaceMode;
    activeTab: WorkspaceTab;
  };
}

export interface WindowState {
  windowId: string;
  bounds: WindowBounds;
  theme: WindowTheme;
  panes: [PaneState];
}

export const LOCAL_FAILURE_CODES = [
  "hermes_not_found",
  "cli_not_executable",
  "cli_unsupported",
  "protocol_unsupported",
  "code_sha_mismatch",
  "gateway_start_failed",
  "gateway_starting_timeout",
  "runtime_exited",
  "owner_lost",
  "ticket_unavailable",
  "control_timeout",
  "socket_permission_denied",
  "service_unhealthy",
  "profile_unavailable",
  "gateway_other_session",
  "gateway_elevated",
  "authorization",
  "update_paused",
  "invalid_control_state",
] as const;

export type LocalFailureCode = (typeof LOCAL_FAILURE_CODES)[number];

export const LOCAL_SAFE_ACTION_IDS = [
  "choose_cli",
  "open_install_docs",
  "open_update_docs",
  "retry",
  "restart_gateway",
  "open_status",
  "open_diagnostics",
  "switch_profile",
] as const;

export type LocalSafeActionId = (typeof LOCAL_SAFE_ACTION_IDS)[number];

export type LocalCliSourceKind =
  | "override"
  | "login_shell_ilc"
  | "login_shell_lc"
  | "common_dir"
  | "none";

export interface LocalCliSummary {
  status: "ready" | "missing" | "not_executable" | "unsupported";
  displayName: string;
  sourceKind: LocalCliSourceKind;
  version?: string;
  hasOverride: boolean;
  supportsEnsureJson: boolean;
  supportsAttachJson: boolean;
  supportsTicketsProbe: boolean;
}

export type LocalInspectionPhase =
  | "locate_cli"
  | "probe_cli"
  | "probe_capabilities"
  | "resolve_control_socket"
  | "ensure_gateway"
  | "ready"
  | "blocked";

export interface LocalTypedFailure {
  code: LocalFailureCode;
  phase: LocalInspectionPhase;
  retryable: boolean;
  autoRetry: boolean;
  actual: ConnectionActualState;
  actions: LocalSafeActionId[];
  profileId?: string;
  restartAttempts?: { current: number; max: number };
  reasonCode?: string;
}

export interface LocalInspectResult {
  connectionId: "local";
  label: "This device";
  actual: ConnectionActualState;
  cli: LocalCliSummary;
  failure: LocalTypedFailure | null;
  checkedAt: string;
}

export interface LocalSelectCliResult {
  cancelled: boolean;
  cli: LocalCliSummary;
  inspection: LocalInspectResult;
}

export interface DiagnosticsPhaseEntry {
  phase: string;
  outcome: "ok" | "failed" | "timeout" | "skipped";
  durationMs?: number;
  code?: string;
}

export interface SanitizedDiagnosticsPayload {
  generatedAt: string;
  appName: "Hermes Desktop";
  appVersion: string;
  bridgeVersion: typeof HOST_BRIDGE_VERSION;
  buildMode: "dev" | "packaged" | "mock";
  mode: "electron" | "mock";
  platform: string;
  arch: string;
  hermesHomeKind: "sandbox" | "real" | "temp" | "mock";
  connectionsCount: number;
  cliSummary: LocalCliSummary | null;
  typedFailureCode: LocalFailureCode | null;
  failurePhase: LocalInspectionPhase | null;
  stages: DiagnosticsPhaseEntry[];
  notes: string[];
}
