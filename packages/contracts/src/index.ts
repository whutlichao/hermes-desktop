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
  "connections.confirmHostKey",
  "connections.retry",
  "connections.setPrimary",
  "connections.setLaunchMode",
  "connections.setLastUsed",
  "connections.backupAndRepair",
  "connections.exportSafeSummary",
  "registry.refresh",
  "profiles.list",
  "scopes.switch",
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
  "chatState.get",
  "chatState.dismissRouteBanner",
  "chatState.saveDraft",
  "chatState.exportMissingSession",
  "chatState.dismissMissingSession",
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
  "chat.state",
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
  | { type: "open_about" }
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
  gitSha: string;
  gitDirty: boolean;
  buildMode: "dev" | "packaged";
  distribution: "local-unsigned";
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  arch: "arm64" | "x64";
  macOSVersion?: string;
  source: "git" | "unknown";
  mode: "electron" | "mock";
  platform: string;
  capabilitiesReady: boolean;
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
  actual?: ConnectionActualState;
  unavailableCode?: LocalFailureCode;
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
  activeTurnId?: string | null;
  status?: "idle" | "running" | "error";
}

export interface ToolExecutionRow {
  toolCallId: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  durationMs?: number;
}

export interface TranscriptMessage {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  turnId?: string;
  streaming?: boolean;
  toolRows?: ToolExecutionRow[];
  status?: "complete" | "streaming" | "stopped" | "error";
}

export interface SupportedChatActions {
  promptSubmit: boolean;
  promptCancel: boolean;
  promptSteer: boolean;
  sessionCreate: boolean;
  sessionResume: boolean;
}

export interface SessionTranscriptSnapshot {
  connectionId: string;
  profileId: string;
  sessionId: string;
  messages: TranscriptMessage[];
  activeTurnId: string | null;
  turnStopping: boolean;
  chatAvailable: boolean;
  chatUnavailableReason?: string;
  supportedActions: SupportedChatActions;
  snapshotSeq?: number;
  resynced?: boolean;
  lastKnownUnverified?: boolean;
}

export type TranscriptPatchPayload =
  | {
      type: "message_upsert";
      sessionId: string;
      message: TranscriptMessage;
    }
  | {
      type: "token_delta";
      sessionId: string;
      turnId?: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "tool_row";
      sessionId: string;
      turnId?: string;
      messageId?: string;
      toolRow: ToolExecutionRow;
    }
  | {
      type: "turn_state";
      sessionId: string;
      activeTurnId: string | null;
      turnStopping?: boolean;
      messageId?: string;
      status?: TranscriptMessage["status"];
    }
  | {
      type: "capabilities_update";
      sessionId: string;
      chatAvailable: boolean;
      supportedActions: SupportedChatActions;
      chatUnavailableReason?: string;
    };

export interface PromptEventPayload {
  connectionId: string;
  profileId: string;
  sessionId: string;
  turnId: string;
  kind: "accepted" | "delta" | "completed" | "stopped" | "stop_failed" | "error";
  delta?: string;
  messageId?: string;
  reason?: string;
}

export interface ActivityEventPayload {
  connectionId: string;
  profileId: string;
  sessionId: string;
  turnId?: string;
  toolRow: ToolExecutionRow;
}

export interface GatewayCapabilitiesSummary {
  connectionId: string;
  profileId: string;
  ownerGeneration: number;
  authorityEpoch: number;
  chatAvailable: boolean;
  supportedActions: SupportedChatActions;
}

export const CAPABILITY_DOMAIN_IDS = [
  "chat",
  "approval",
  "checkpoint",
  "profile",
  "session",
  "skills",
  "tools",
  "mcp",
  "cron",
  "files_artifacts",
  "terminal",
  "subagents",
  "settings",
  "memory",
  "messaging",
  "plugins",
  "git_worktree",
  "voice",
  "bots",
  "memory_graph",
  "kanban",
] as const;

export type CapabilityDomainId = (typeof CAPABILITY_DOMAIN_IDS)[number];

export type CapabilityClassification = "native" | "read_only" | "deep_link" | "deferred";

export type CapabilityGroup = "core" | "admin" | "exec" | "deferred";

export type CapabilityRuntimeStatus =
  | "available"
  | "read_only"
  | "degraded"
  | "deep_link"
  | "unavailable"
  | "unknown";

export type CapabilityMethodTier =
  | "served"
  | "older"
  | "refused"
  | "session_bound"
  | "plugin_family"
  | "unknown";

export type CapabilitySource =
  | "static_local"
  | "runtime_describe"
  | "client_capabilities"
  | "probe"
  | "alias"
  | "deep_link"
  | "deferred"
  | "fallback";

export interface CapabilityDeepLink {
  kind: "cli" | "docs";
  label: string;
  cliCommand?: string;
  url?: string;
}

export type CapabilityDegradationReason =
  | "older"
  | "method_not_found"
  | "missing_server_requests"
  | "timeout"
  | "refused"
  | "unconnected"
  | "legacy_owner"
  | "invalidated";

export interface CapabilityDegradation {
  reason: CapabilityDegradationReason;
  missingMethods?: string[];
  detail?: string;
}

export interface CapabilityEntry {
  domain: CapabilityDomainId;
  group: CapabilityGroup;
  actionId: string;
  labelKey: string;
  hintKey?: string;
  shortcut?: string;
  classification: CapabilityClassification;
  runtimeStatus: CapabilityRuntimeStatus;
  source: CapabilitySource;
  requiredMethods: string[];
  handlerId: string;
  evidenceTestId: string;
  generation: number;
  aliasUsed?: string;
  deepLink?: CapabilityDeepLink;
  degradation?: CapabilityDegradation;
}

export interface CapabilityDomainSummary {
  domain: CapabilityDomainId;
  group: CapabilityGroup;
  classification: CapabilityClassification;
  runtimeStatus: CapabilityRuntimeStatus;
  labelKey: string;
  probed: boolean;
  probeMethod?: string;
  degradation?: CapabilityDegradation;
  deepLink?: CapabilityDeepLink;
}

export interface CapabilitySnapshotKey {
  connectionId: string;
  profileId: string;
  ownerGeneration: number;
  authorityEpoch: number;
  gatewayVersionOrSha: string;
}

export interface CapabilitySnapshot {
  key: CapabilitySnapshotKey;
  generation: number;
  capabilitiesReady: boolean;
  serverRequestsSupported: boolean;
  legacyOwner: boolean;
  sessionCreateSpec?: {
    sources: string[];
    parameters: string[];
  };
  counts: {
    total: 21;
    native: 13;
    readOnly: 3;
    deepLink: 1;
    reachable: 17;
    deferred: 4;
  };
  domains: CapabilityDomainSummary[];
  entries: CapabilityEntry[];
  methodTiers: Record<string, CapabilityMethodTier>;
  invalidatedReason?: string;
  updatedAt: string;
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

export type WorkspaceTabBinding = "active_chat" | "scope";

export interface WorkspaceFrame {
  mode: WorkspaceMode;
  activeTab: WorkspaceTab;
}

export type ArtifactKind = "markdown" | "code" | "html" | "svg" | "json" | "text";

export interface WorkspaceArtifactItem {
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  version: number;
  hash: string;
  updatedAt: string;
  language?: string;
  stale?: boolean;
}

export interface ArtifactAnnotation {
  annotationId: string;
  artifactId: string;
  artifactVersion: number;
  artifactHash: string;
  xPct: number;
  yPct: number;
  comment: string;
  createdAt: string;
}

export interface ProjectedArtifactAnnotation extends ArtifactAnnotation {
  outdatedVersion: boolean;
}

export interface WorkspaceFileEntry {
  relativePath: string;
  name: string;
  kind: "file" | "directory";
  parentPath?: string | null;
  hash?: string;
  content?: string;
  sizeBytes?: number;
  updatedAt?: string;
  stale?: boolean;
}

export interface WorkspaceLineSelection {
  startLine: number;
  endLine: number;
  fileHash: string;
}

export interface WorkspaceGitDiffItem {
  relativePath: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  summary: string;
  patch?: string;
}

export interface WorkspaceAgentItem {
  agentId: string;
  name: string;
  role: string;
  status: "running" | "idle" | "completed" | "failed";
  summary?: string;
}

export interface PaneState {
  paneId: string;
  activeScope: BridgeScope | null;
  activeChat: ActiveChatRef | null;
  workspace: WorkspaceFrame;
}

export interface WindowState {
  windowId: string;
  bounds: WindowBounds;
  theme: WindowTheme;
  panes: [PaneState];
}

export type ActiveChatStatus = "ready" | "unverified" | "session_missing" | "empty";

export type RouteFallbackReason = "session_removed" | "profile_removed" | "connection_removed";

export interface RouteBannerState {
  id: string;
  fromScope: BridgeScope;
  toScope: BridgeScope;
  reason: RouteFallbackReason;
}

export interface SessionRecoverySummary {
  connectionId: string;
  profileId: string;
  sessionId: string;
  title: string;
  preview?: string;
  updatedAt?: string;
  hasDraft: boolean;
  draftText?: string;
  annotations?: ArtifactAnnotation[];
  lastKnownMessages?: TranscriptMessage[];
}

export interface ChatSessionProjection {
  windowId: "primary";
  paneId: "main";
  lastActiveChat: ActiveChatRef | null;
  lastSessionByScope: Record<string, string>;
  lastValidProfileByConnection: Record<string, string>;
  lastValidScopes: Array<{ connectionId: string; profileId: string }>;
  sessionSummaries: Record<string, SessionRecoverySummary>;
  activeStatus: ActiveChatStatus;
  lastKnownUnverified: boolean;
  missingSession: SessionRecoverySummary | null;
  routeBanner: RouteBannerState | null;
}

export interface MissingSessionExport {
  exportedAt: string;
  windowId: "primary";
  paneId: "main";
  scope: BridgeScope;
  sessionTitle: string;
  draftText: string;
  annotations?: ArtifactAnnotation[];
  messages: TranscriptMessage[];
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

export type LaunchMode = "primary" | "last-used";

export type RemoteAuthMode = "token" | "oauth";

export type RegistryIssueCode =
  | "registry_future_version"
  | "registry_unsupported"
  | "registry_corrupt"
  | "registry_unavailable"
  | "registry_conflict"
  | "registry_invalid"
  | "registry_reset"
  | "registry_busy"
  | "token_sync_failed"
  | "local_not_removable"
  | "duplicate_identity"
  | "duplicate_label";

export type RegistryIssueSeverity = "info" | "warning" | "error";

export interface RegistryIssue {
  code: RegistryIssueCode;
  severity: RegistryIssueSeverity;
  connectionId?: string;
  entryIndex?: number;
  identity?: string;
  count?: number;
  messageKey: string;
}

export interface ConnectionEntryDisplay {
  id: string;
  kind: ConnectionKind;
  label: string;
  isLocal: boolean;
  isPrimary: boolean;
  isLastUsed: boolean;
  isNextLaunch: boolean;
  dialable: boolean;
  hasToken: boolean;
  hasHeaders?: boolean;
  authMode?: RemoteAuthMode;
  originDisplay?: string;
  sshTargetDisplay?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number;
  remoteProfile?: string;
  org?: string;
  name?: string;
  duplicateOfId?: string;
  issueCodes?: RegistryIssueCode[];
}

export interface DuplicateConflictSummary {
  conflictKind: "duplicate_identity" | "duplicate_label";
  existing: {
    id: string;
    label: string;
    kind: ConnectionKind;
    hostDisplay?: string;
    hasToken: boolean;
  };
}

export interface LaunchTargetResolution {
  connectionId: string | null;
  reason: "last_used" | "primary" | "local" | "empty";
  launchMode: LaunchMode;
}

export interface RegistrySnapshotView {
  version: number;
  revision: number;
  primary: string;
  launchMode: LaunchMode;
  lastUsed: string | null;
  nextLaunch: LaunchTargetResolution;
  connections: ConnectionEntryDisplay[];
  issues: RegistryIssue[];
  readOnly: boolean;
  readOnlyReason?: "registry_corrupt" | "registry_unsupported" | "registry_unavailable";
  quarantinedCount: number;
  importNoticeCount: number;
}

export type RegistryConnectionChangeKind =
  | "connection_added"
  | "connection_removed"
  | "connection_updated";

export interface RegistryConnectionChange {
  kind: RegistryConnectionChangeKind;
  connectionId: string;
  dialMaterialChanged: boolean;
}

export interface RegistryDiff {
  changes: RegistryConnectionChange[];
  dialMaterialChanged: boolean;
  primaryChanged: boolean;
  launchModeChanged: boolean;
  issuesChanged: boolean;
  credentialsChanged: boolean;
}

export interface ConnectionMutationInput {
  kind: ConnectionKind;
  label: string;
  url?: string;
  authMode?: RemoteAuthMode;
  token?: string;
  clearToken?: boolean;
  authSessionId?: string;
  headers?: Record<string, string>;
  host?: string;
  user?: string;
  port?: number;
  keyPath?: string;
  remoteHermesPath?: string;
  remoteProfile?: string;
  passphrase?: string;
  preferLegacyAttach?: boolean;
  org?: string;
  name?: string;
}

export type RemoteTestActionId =
  | "edit_endpoint"
  | "edit_auth"
  | "retry_test"
  | "reauthorize_oauth"
  | "save_connection";

export type RemoteTestLegOutcome = "ok" | "failed" | "skipped";

export interface RemoteTestLegResult {
  ok: boolean;
  status: RemoteTestLegOutcome;
  statusCode?: number;
  latencyMs?: number;
  errorCode?: ErrorCode;
  messageKey?: string;
}

export interface RemoteTestResult {
  ok: boolean;
  kind: ConnectionKind;
  originDisplay?: string;
  authMode?: RemoteAuthMode;
  httpLeg: RemoteTestLegResult;
  wsLeg: RemoteTestLegResult;
  failedStage?: "validation" | "http" | "auth" | "ws";
  errorCode?: ErrorCode;
  messageKey?: string;
  actions: RemoteTestActionId[];
  checkedAt: string;
}

export type AuthFlowStatus = "waiting" | "granted" | "cancelled" | "failed";

export interface AuthStateSnapshot {
  authSessionId: string;
  connectionId?: string;
  originDisplay?: string;
  status: AuthFlowStatus;
  errorCode?: ErrorCode;
  messageKey?: string;
  updatedAt: string;
}

export type AuthStartResult = AuthStateSnapshot;

export interface AuthCancelResult {
  cancelled: boolean;
  snapshot: AuthStateSnapshot;
}

export type SshTransportMode = "tickets_serve" | "attach_only";

export type SshFailureCode =
  | "host_key_unknown"
  | "host_key_changed"
  | "ssh_auth_failed"
  | "ssh_unreachable"
  | "ssh_timeout"
  | "remote_hermes_not_found"
  | "protocol_unsupported"
  | "ticket_unavailable"
  | "windows_session0_attach_only"
  | "tunnel_failed";

export type SshSafeActionId =
  | "edit_target"
  | "retry"
  | "legacy_attach"
  | "confirm_host_key";

export interface SshHostKeyChallenge {
  hostDisplay: string;
  keyType: string;
  fingerprint: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  kind: ConnectionKind;
  status: "ready" | "blocked" | "failed";
  sshMode?: SshTransportMode;
  legacyNotice?: boolean;
  windowsServiceSession?: boolean;
  hostKeyChallenge?: SshHostKeyChallenge;
  failureCode?: SshFailureCode | ErrorCode;
  message?: string;
  actions: SshSafeActionId[];
  sshTargetDisplay?: string;
}

export interface SshHostKeyConfirmResult {
  confirmed: boolean;
  cancelled: boolean;
  hardBlocked: boolean;
  sshTargetDisplay?: string;
  message?: string;
}

export interface ConnectionMutationResponse {
  committed: boolean;
  snapshot: RegistrySnapshotView;
  warnings: RegistryIssue[];
  rejectedIssue?: RegistryIssue;
  conflict?: DuplicateConflictSummary;
}

export interface RegistrySafeSummaryExport {
  exportedAt: string;
  version: number;
  revision: number;
  launchMode: LaunchMode;
  primary: string;
  lastUsed: string | null;
  connectionCount: number;
  quarantinedCount: number;
  readOnly: boolean;
  readOnlyReason?: "registry_corrupt" | "registry_unsupported" | "registry_unavailable";
  issues: RegistryIssue[];
  connections: Array<{
    id: string;
    kind: ConnectionKind;
    label: string;
    dialable: boolean;
    hasToken: boolean;
    originDisplay?: string;
    sshTargetDisplay?: string;
  }>;
}

export const REFUSED_GATEWAY_METHODS = [
  "agents.list",
  "session.activate",
  "session.archive",
  "session.branch",
  "session.branch_stored",
  "session.branch_whole",
  "session.close",
  "session.compress",
  "session.cwd.set",
  "session.delete",
  "session.set_hidden",
  "session.status",
  "session.title",
  "session.undo",
  "session.usage",
  "session.workspace.move",
] as const;

export type RefusedGatewayMethod = (typeof REFUSED_GATEWAY_METHODS)[number];

export const SESSION_CLI_ACTION_IDS = [
  "rename",
  "delete",
  "branch",
  "archive",
  "compress",
  "undo",
] as const;

export type SessionCliActionId = (typeof SESSION_CLI_ACTION_IDS)[number];

export interface SessionCliDeepLink {
  actionId: SessionCliActionId;
  labelKey: string;
  command: string;
  executionNoteKey: string;
}

export const SETTINGS_SECTION_IDS = [
  "model",
  "workspace",
  "safety",
  "memory",
  "chat",
  "gateways",
  "updates",
  "about",
  "diagnostics",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const SUPPORTED_GATEWAY_CONFIG_KEYS = [
  "model.default",
  "model.reasoning_effort",
  "workspace.default_tab",
  "workspace.auto_open_artifacts",
  "safety.approval_policy",
  "safety.redact_diagnostics",
  "memory.context_window",
  "memory.auto_summarize",
  "chat.send_on_enter",
  "chat.stream_tokens",
] as const;

export type SupportedGatewayConfigKey = (typeof SUPPORTED_GATEWAY_CONFIG_KEYS)[number];

export type GatewayConfigValue = string | number | boolean;

export interface GatewayConfigSnapshot {
  scope: BridgeScope | null;
  supported: boolean;
  readOnly: boolean;
  supportedKeys: string[];
  values: Record<string, GatewayConfigValue>;
  updatedAt: string;
}

export interface GatewayConfigUpdateInput {
  key: string;
  value: GatewayConfigValue;
}

export interface GatewayConfigUpdateResult {
  ok: boolean;
  snapshot: GatewayConfigSnapshot;
  errorCode?: ErrorCode;
}

