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
  "sessions.markRead",
  "app.setFocused",
  "prompts.send",
  "prompts.stop",
  "prompts.steer",
  "prompts.resolveUnknown",
  "prompts.queue",
  "prompts.checkQueueReceipt",
  "prompts.retryQueue",
  "prompts.cancelQueued",
  "prompts.dismissSteerFallback",
  "approvals.list",
  "approvals.respond",
  "approvals.dismissOrphaned",
  "clarify.respond",
  "capabilities.describe",
  "config.get",
  "config.update",
  "files.list",
  "files.read",
  "terminal.get",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "artifacts.list",
  "artifacts.read",
  "subagents.list",
  "subagents.steer",
  "subagents.interrupt",
  "subagents.tail",
  "checkpoints.list",
  "checkpoints.diff",
  "checkpoints.restore",
  "diagnostics.export",
  "local.inspect",
  "local.selectCli",
  "local.diagnose",
  "links.openExternal",
  "chatState.get",
  "chatState.dismissRouteBanner",
  "chatState.saveDraft",
  "chatState.clearDraft",
  "chatState.markAttachmentExpired",
  "chatState.deleteOrphanedDraft",
  "chatState.exportOrphanedDraft",
  "chatState.exportMissingSession",
  "chatState.dismissMissingSession",
  "cron.status",
  "cron.submit",
  "cron.cancel",
  "cron.recover",
] as const;

export type HostCommand = (typeof HOST_COMMANDS)[number];

export const HOST_TOPICS = [
  "fleet",
  "connection.health",
  "profiles",
  "sessions",
  "session.transcript",
  "prompt",
  "turn.recovery",
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

export type ConnectionDesiredState = "enabled" | "disabled" | "suspended";

export type ConnectionActualState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "auth_required"
  | "blocked"
  | "stopping";

export type GatewayAggregateState =
  | "ready"
  | "degraded"
  | "auth_required"
  | "blocked"
  | "reconnecting"
  | "connecting"
  | "idle"
  | "suspended";

export interface ConnectionLinkSummary {
  connectionId: string;
  profileId: string;
  desired: ConnectionDesiredState;
  actual: ConnectionActualState;
  degraded: boolean;
  pinned: boolean;
  latencyMs: number | null;
  nextRetryAt: number | null;
  attempt?: number;
  errorCode?: ErrorCode;
  unavailableCode?: LocalFailureCode;
  message?: string;
}

export interface ConnectionHealthSummary {
  connectionId: string;
  label: string;
  kind: ConnectionKind;
  originDisplay: string;
  desired?: ConnectionDesiredState;
  actual: ConnectionActualState;
  aggregateState?: GatewayAggregateState;
  degraded: boolean;
  latencyMs: number | null;
  nextRetryAt: number | null;
  errorCode?: ErrorCode;
  message?: string;
  profileExceptionCount?: number;
}

export interface ProfileSummary {
  connectionId: string;
  profileId: string;
  displayName: string;
  handle: string;
  isDefault: boolean;
  desired?: ConnectionDesiredState;
  actual?: ConnectionActualState;
  degraded?: boolean;
  pinned?: boolean;
  isException?: boolean;
  unavailableCode?: LocalFailureCode;
  errorCode?: ErrorCode;
  message?: string;
}

export type BackgroundNotificationKind = "approval_pending" | "turn_completed";

export interface SafeBackgroundNotification {
  kind: BackgroundNotificationKind;
  title: string;
  body: string;
  scope: BridgeScope;
  focusCommand: { type: "focus_scope"; scope: BridgeScope };
}

export interface SessionPinnedReasons {
  runningTurn?: boolean;
  pendingInput?: boolean;
  unread?: boolean;
  queuedAdmission?: boolean;
  explicit?: boolean;
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
  queuedAdmission?: boolean;
  pinnedReasons?: SessionPinnedReasons;
  progressSeq?: number;
  lastReadSeq?: number;
}

export interface AttentionTarget {
  connectionId: string;
  profileId: string;
  sessionId: string;
  title: string;
  unreadCount: number;
  needsInput: boolean;
  isActive: boolean;
}

export interface AttentionAggregation {
  totalUnread: number;
  totalNeedsInput: number;
  backgroundUnread: number;
  backgroundNeedsInput: number;
  needsInputTargets: AttentionTarget[];
  unreadTargets: AttentionTarget[];
  primaryTarget: AttentionTarget | null;
}

export type CapabilityOrigin = "builtin" | "external" | "unknown";

export type CapabilityProviderKind = "mcp" | "skill" | "tool" | "plugin" | "gateway";

export interface CapabilityProviderRef {
  kind: CapabilityProviderKind;
  id: string;
  label: string;
}

export interface ExternalAttribution {
  origin: CapabilityOrigin;
  provider?: CapabilityProviderRef;
  sourceLabel: string;
  accessibleLabel: string;
}

export interface TranscriptPendingApprovalView {
  approvalId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  attribution: ExternalAttribution;
}

export interface ToolExecutionRow {
  toolCallId: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  durationMs?: number;
  attribution?: ExternalAttribution;
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
  executionGeneration?: number;
  stopState?: TurnStopState;
  chatAvailable: boolean;
  chatUnavailableReason?: string;
  supportedActions: SupportedChatActions;
  pendingApprovals?: TranscriptPendingApprovalView[];
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
      executionGeneration?: number;
      stopState?: TurnStopState;
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
  executionGeneration?: number;
  kind:
    | "accepted"
    | "delta"
    | "completed"
    | "stopping"
    | "stopped"
    | "stop_failed"
    | "cancel_outcome_unknown"
    | "unknown_turn"
    | "unknown_resolved"
    | "queued"
    | "queue_cancelled"
    | "steer_failed"
    | "error";
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
  attribution?: ExternalAttribution;
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
  attribution?: ExternalAttribution;
}

export type ExtensionInventoryStatus =
  | "available"
  | "empty"
  | "unsupported"
  | "unknown"
  | "error";

export interface ExtensionCliAction {
  id: string;
  label: string;
  command: string;
  note: string;
}

export interface ExtensionPluginRow {
  pluginKey: string;
  name: string;
  version: string;
  enabled: boolean;
  enabledLabel: string;
  loadStatus: "ok" | "failed" | "unknown";
  loadStatusLabel: string;
  errorCode?: string;
  key?: string;
  toolCount?: number;
  hookCount?: number;
  commandCount?: number;
  skillsLabel: string;
  cliActions: ExtensionCliAction[];
  attribution: ExternalAttribution;
}

export interface SkillInventoryRow {
  skillId: string;
  name: string;
  description?: string;
  category?: string;
  enabled?: boolean;
  attribution: ExternalAttribution;
}

export interface SkillsInventoryView {
  status: ExtensionInventoryStatus;
  items: SkillInventoryRow[];
  reloadSupported: boolean;
  lastReloadedAt?: string;
  errorCode?: string;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
}

export interface ToolInventoryRow {
  toolId: string;
  name: string;
  description?: string;
  toolset?: string;
  enabled?: boolean;
  attribution: ExternalAttribution;
}

export interface ToolsInventoryView {
  status: ExtensionInventoryStatus;
  items: ToolInventoryRow[];
  errorCode?: string;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
}

export interface McpInventoryRow {
  serverId: string;
  name: string;
  status: "connected" | "disconnected" | "error" | "unknown";
  statusLabel: string;
  toolCount?: number;
  errorCode?: string;
  attribution: ExternalAttribution;
}

export interface McpInventoryView {
  status: ExtensionInventoryStatus;
  items: McpInventoryRow[];
  reloadSupported: boolean;
  lastReloadedAt?: string;
  errorCode?: string;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
}

export interface ExtensionInventoryView {
  status: ExtensionInventoryStatus;
  scope: {
    connectionId: string;
    profileId: string;
    gatewayVersion?: string;
    perPluginProfile: false;
  };
  sourceKind: "gateway_reported";
  sourceLabel: "Gateway 报告";
  plugins: ExtensionPluginRow[];
  counts: {
    reported: number;
    enabled: number;
    failed: number;
  };
  pluginRpcAdvertised: boolean;
  gatewayToolsets?: string[];
  portableMcpServers?: string[];
  fetchedAt: string | null;
  generation: number;
  errorCode?: string;
  degradation?: CapabilityDegradation;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
  skills: SkillsInventoryView;
  tools: ToolsInventoryView;
  mcp: McpInventoryView;
}

export type DomainInspectTab = "memory" | "messaging" | "cron";

export type DomainInspectStatus = ExtensionInventoryStatus;

export interface MemoryContextSection {
  id: string;
  label: string;
  tokens?: number;
  percentage?: number;
  entryCount?: number;
  summary?: string;
}

export interface MemoryContextView {
  status: DomainInspectStatus;
  readOnly: true;
  sourceMethod?: "session.context_breakdown" | "session.info";
  sessionId?: string;
  totalTokens?: number;
  maxTokens?: number;
  sections: MemoryContextSection[];
  notes: string[];
  errorCode?: string;
  degradation?: CapabilityDegradation;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
  fetchedAt: string | null;
}

export interface MessagingConnectorRow {
  connectorId: string;
  platform: string;
  label: string;
  status: "connected" | "disconnected" | "configured" | "error" | "unknown";
  statusLabel: string;
  detail?: string;
  errorCode?: string;
  attribution: ExternalAttribution;
  cliCommand?: string;
}

export interface MessagingStatusView {
  status: DomainInspectStatus;
  readOnly: true;
  connectors: MessagingConnectorRow[];
  errorCode?: string;
  degradation?: CapabilityDegradation;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
  fetchedAt: string | null;
}

export type CronJobStatus = "scheduled" | "running" | "succeeded" | "failed" | "paused" | "cancelled";

export interface CronJobRow {
  jobId: string;
  name: string;
  schedule: string;
  promptSummary?: string;
  status: CronJobStatus;
  statusLabel: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastOutcome?: string;
  errorCode?: string;
  canCancel: boolean;
  canRecover: boolean;
  attribution: ExternalAttribution;
}

export interface CronSupportedActions {
  canStatus: boolean;
  canSubmit: boolean;
  canCancel: boolean;
  canRecover: boolean;
}

export interface CronStateView {
  status: DomainInspectStatus;
  mode: "interactive" | "read_only" | "unavailable";
  routinesFoldedIntoCron: true;
  supportedActions: CronSupportedActions;
  jobs: CronJobRow[];
  recentRunSummary?: string;
  errorCode?: string;
  degradation?: CapabilityDegradation;
  cliActions: ExtensionCliAction[];
  docsUrl: string;
  fetchedAt: string | null;
}

export interface CronSubmitRequest {
  name: string;
  schedule: string;
  prompt: string;
}

export interface CronJobActionRequest {
  jobId: string;
}

export interface CronMutationResult {
  ok: true;
  jobId?: string;
  cron: CronStateView;
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
  extensions: ExtensionInventoryView;
  memory: MemoryContextView;
  messaging: MessagingStatusView;
  cron: CronStateView;
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

export type WorkspaceTab = "artifacts" | "files" | "git" | "agents" | "checkpoints" | "terminal";

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
  status: "running" | "idle" | "completed" | "failed" | "stopped";
  summary?: string;
  updatedAt?: string;
  lastKnown?: boolean;
}

export interface SubagentTailSnapshot {
  agentId: string;
  lines: string[];
  truncated: boolean;
  generation: number;
  updatedAt: string;
}

export interface WorkspaceCheckpointItem {
  checkpointId: string;
  title: string;
  summary?: string;
  createdAt: string;
  turnId?: string;
}

export interface CheckpointDiffSnapshot {
  checkpointId: string;
  summary: string;
  patch: string;
  filesChanged?: number;
}

export interface CheckpointRestoreBinding {
  connectionId: string;
  profileId: string;
  sessionId: string;
  checkpointId: string;
  generation: number;
}

export interface WorkspaceDomainError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  actionId?: string;
  detail?: string;
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

export const DRAFT_MAX_BYTES = 1024 * 1024;
export const DRAFTS_TOTAL_MAX_BYTES = 50 * 1024 * 1024;

export type DraftAttachmentKind = "file" | "image" | "text" | "binary";

export interface DraftAttachment {
  attachmentId: string;
  handle: string;
  displayName: string;
  kind: DraftAttachmentKind;
  sizeBytes?: number;
  expired?: boolean;
}

export interface DraftContextItem {
  contextId: string;
  kind: "file" | "line_range" | "artifact" | "snippet";
  ref: string;
  label: string;
  version?: string | number;
}

export interface DraftComposerState {
  selectionStart?: number;
  selectionEnd?: number;
  sendOnEnter?: boolean;
}

export type DraftDeliveryStatus = "idle" | "submitting" | "delivery_unknown";

export interface DraftOrigin {
  connectionId: string;
  profileId: string;
  sessionId?: string;
  title?: string;
}

export interface DraftRecord {
  draftId: string;
  sessionId?: string;
  scope: {
    connectionId: string;
    profileId: string;
  };
  text: string;
  attachments: DraftAttachment[];
  contexts: DraftContextItem[];
  composer: DraftComposerState;
  annotations?: ArtifactAnnotation[];
  updatedAt: string;
  revision: number;
  origin: DraftOrigin;
  deliveryStatus?: DraftDeliveryStatus;
}

export type OrphanedDraftReason =
  | "session_deleted"
  | "profile_removed"
  | "connection_removed"
  | "session_missing_closed"
  | "session_missing_exported";

export interface OrphanedDraftRecord {
  orphanedId: string;
  draftId: string;
  text: string;
  attachments: DraftAttachment[];
  contexts: DraftContextItem[];
  annotations?: ArtifactAnnotation[];
  origin: DraftOrigin;
  reason: OrphanedDraftReason;
  orphanedAt: string;
}

export interface DraftStorageUsage {
  totalBytes: number;
  maxDraftBytes: number;
  maxTotalBytes: number;
  overTotalLimit: boolean;
  draftCount: number;
  orphanedCount: number;
}

export interface DraftExportBundle {
  exportedAt: string;
  kind: "active_draft" | "orphaned_draft";
  draftId: string;
  origin: DraftOrigin;
  text: string;
  attachments: DraftAttachment[];
  contexts: DraftContextItem[];
  annotations?: ArtifactAnnotation[];
  reason?: OrphanedDraftReason;
  orphanedAt?: string;
}

export interface ChatSessionProjection {
  windowId: "primary";
  paneId: "main";
  lastActiveChat: ActiveChatRef | null;
  lastSessionByScope: Record<string, string>;
  lastValidProfileByConnection: Record<string, string>;
  lastValidScopes: Array<{ connectionId: string; profileId: string }>;
  sessionSummaries: Record<string, SessionRecoverySummary>;
  scopeDrafts?: Record<string, string>;
  activeStatus: ActiveChatStatus;
  lastKnownUnverified: boolean;
  missingSession: SessionRecoverySummary | null;
  routeBanner: RouteBannerState | null;
  draftsByKey?: Record<string, DraftRecord>;
  orphanedDrafts?: OrphanedDraftRecord[];
  draftStorageUsage?: DraftStorageUsage;
}

export interface MissingSessionExport {
  exportedAt: string;
  windowId: "primary";
  paneId: "main";
  scope: BridgeScope;
  sessionTitle: string;
  draftText: string;
  annotations?: ArtifactAnnotation[];
  attachments?: DraftAttachment[];
  contexts?: DraftContextItem[];
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

export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

export const APPROVAL_RISK_CATEGORIES = [
  "sudo",
  "secret",
  "vault",
  "destructive",
  "always",
] as const;
export type ApprovalRiskCategory = (typeof APPROVAL_RISK_CATEGORIES)[number];

export const APPROVAL_STATES = [
  "received",
  "unverified",
  "context_incomplete",
  "actionable",
  "submitting",
  "settled",
  "settled_elsewhere_by_server",
  "delivery_unknown",
  "stale_owner",
  "expired",
  "orphaned",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export interface ApprovalPersistentGrantInfo {
  readonly pattern: string;
  readonly scope: string;
  readonly revokeHint: string;
}

export interface ApprovalView {
  readonly approvalKey: string;
  readonly state: ApprovalState;
  readonly connectionId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly connectionLabel: string;
  readonly connectionKind: ConnectionKind;
  readonly hostDisplay: string;
  readonly profileDisplayName: string;
  readonly sessionTitle: string;
  readonly turnId: string | null;
  readonly cwd: string | null;
  readonly ownerGeneration: number;
  readonly authorityEpoch: number;
  readonly executionGeneration: number;
  readonly riskCategories: readonly ApprovalRiskCategory[];
  readonly requiresHighRiskSheet: boolean;
  readonly command: string | null;
  readonly description: string;
  readonly allowedChoices: readonly ApprovalChoice[];
  readonly smartDenied: boolean;
  readonly smartDeniedReason?: string;
  readonly expiresAt: string | null;
  readonly missingContextFields: readonly string[];
  readonly persistentGrant?: ApprovalPersistentGrantInfo;
  readonly isOwningSessionActive: boolean;
  readonly inFlight: boolean;
  readonly settledChoice?: ApprovalChoice;
  readonly statusReason?: string;
  readonly canApprove: boolean;
  readonly canDeny: boolean;
  readonly canInspect: boolean;
  readonly canDismiss: boolean;
  readonly attribution?: ExternalAttribution;
  readonly updatedAt: string;
}

export interface ApprovalTopicSnapshot {
  readonly approvals: readonly ApprovalView[];
  readonly pendingCount: number;
  readonly orphanedCount: number;
}

export interface ApprovalRespondRequest {
  approvalKey: string;
  choice: ApprovalChoice;
}

export interface ApprovalRespondResult {
  status:
    | "settled"
    | "settled_elsewhere_by_server"
    | "cancelled_pending"
    | "delivery_unknown"
    | "pending_reconciled";
  approval: ApprovalView | null;
  message?: string;
}

export interface ApprovalHighRiskSheetRequest {
  readonly approvalKey: string;
  readonly choice: ApprovalChoice;
  readonly connectionLabel: string;
  readonly connectionKind: ConnectionKind;
  readonly hostDisplay: string;
  readonly profileDisplayName: string;
  readonly sessionTitle: string;
  readonly isOwningSessionBackground: boolean;
  readonly command: string;
  readonly cwd: string;
  readonly riskCategories: readonly ApprovalRiskCategory[];
  readonly persistentGrant?: ApprovalPersistentGrantInfo;
}

export type TerminalStatus = "idle" | "grant_denied" | "running" | "detached" | "ended";

export interface TerminalSnapshot {
  terminalId: string | null;
  scope: BridgeScope;
  status: TerminalStatus;
  cols: number;
  rows: number;
  granted: boolean;
  rootGranted: boolean;
  hasForegroundProcess: boolean;
  foregroundProcessName?: string;
  lines: string[];
  trimmedOldest: boolean;
  totalBytes: number;
  lineCount: number;
  exitCode?: number | null;
  attribution: ExternalAttribution;
  updatedAt: string;
}

export interface TerminalOpenResult {
  ok: boolean;
  granted: boolean;
  deniedReason?: "user_denied" | "root_denied" | "scope_mismatch";
  snapshot: TerminalSnapshot;
}

export interface TerminalCloseResult {
  ok: boolean;
  outcome: "closed" | "detached" | "terminated" | "confirm_required";
  snapshot: TerminalSnapshot;
}

export interface GitWorktreeCliItem {
  id: string;
  labelKey: string;
  command: string;
  executionNote: string;
  attribution?: ExternalAttribution;
}

export interface GitWorktreeDocLink {
  id: string;
  labelKey: string;
  url: string;
  attribution?: ExternalAttribution;
}

export interface GitWorktreeDeepLinkCatalog {
  boundaryNote: string;
  cliItems: GitWorktreeCliItem[];
  docLinks: GitWorktreeDocLink[];
}

export type TurnStopState =
  | "idle"
  | "stopping"
  | "cancel_outcome_unknown"
  | "stopped";

export interface UnknownTurnRecord {
  readonly admissionId: string;
  readonly executionGeneration: number;
  readonly ownerGeneration: number;
  readonly turnId?: string;
  readonly originalInput?: string;
  readonly message: string;
  readonly lostReason: string;
  readonly detectedAt: string;
  readonly resolving?: boolean;
  readonly lastKnownUnverified?: boolean;
}

export type QueuedAdmissionState =
  | "queued"
  | "cancelling"
  | "cancel_unknown"
  | "cancelled"
  | "stopped"
  | "already_started"
  | "completed"
  | "error"
  | "interrupted";

export interface QueuedAdmissionView {
  readonly admissionId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly text: string;
  readonly position: number;
  readonly state: QueuedAdmissionState;
  readonly executionGeneration?: number;
  readonly turnId?: string;
  readonly statusReason?: string;
  readonly lastKnownUnverified?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type QueueDeliveryUnknownState =
  | "delivery_unknown"
  | "reconciling"
  | "retry_ready";

export interface QueueDeliveryUnknownView {
  readonly submissionId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly text: string;
  readonly state: QueueDeliveryUnknownState;
  readonly executionGeneration?: number;
  readonly statusReason?: string;
  readonly canRetrySameSubmission: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SteerFailureReason =
  | "turn_finished"
  | "generation_mismatch"
  | "not_running"
  | "rejected"
  | "unreachable"
  | "timeout";

export type SteerFallbackChoice = "new_turn" | "queue";

export interface SteerFallbackPromptView {
  readonly text: string;
  readonly reason: SteerFailureReason;
  readonly message: string;
  readonly turnId?: string;
  readonly executionGeneration?: number;
  readonly allowedFallbacks: readonly SteerFallbackChoice[];
  readonly createdAt: string;
}

export interface PromptSteerResult {
  readonly ok: boolean;
  readonly steered: boolean;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly executionGeneration?: number;
  readonly status: "steered" | "failed";
  readonly requiresExplicitFallback?: boolean;
  readonly reason?: SteerFailureReason;
  readonly message?: string;
  readonly text?: string;
  readonly allowedFallbacks?: readonly SteerFallbackChoice[];
}

export interface TurnSessionRecoveryView {
  readonly connectionId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly activeTurnId: string | null;
  readonly executionGeneration: number;
  readonly ownerGeneration: number;
  readonly stopState: TurnStopState;
  readonly stopRequestedTurnId?: string;
  readonly stopRequestedGeneration?: number;
  readonly stopOutcomeMessage?: string;
  readonly queuePaused: boolean;
  readonly unknownTurn: UnknownTurnRecord | null;
  readonly queuedAdmissions: readonly QueuedAdmissionView[];
  readonly pendingDeliveryUnknown: readonly QueueDeliveryUnknownView[];
  readonly pendingSteerFallback: SteerFallbackPromptView | null;
  readonly lastKnownUnverified: boolean;
  readonly updatedAt: string;
}

export interface TurnRecoveryTopicSnapshot {
  readonly sessions: readonly TurnSessionRecoveryView[];
}

