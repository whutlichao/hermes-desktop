export type GatewayKind = "local" | "remote" | "ssh" | "cloud";
export type GatewayHealth = "reachable" | "degraded" | "error" | "testing";
export type GatewayAuth = "automatic" | "session-token" | "oauth" | "ssh-key" | "portal";
export type UpdateState = "idle" | "updating" | "done" | "skipped" | "error";

export type ToastTone = "default" | "success" | "danger";
export type Overlay =
  | "none"
  | "palette"
  | "settings"
  | "checkpoints"
  | "memoryGraph"
  | "addGateway"
  | "editGateway"
  | "qr"
  | "shortcuts"
  | "confirmRemove";

export type SettingsSection =
  | "model"
  | "workspace"
  | "safety"
  | "memory"
  | "voice"
  | "chat"
  | "gateways"
  | "updates";

export type CapabilityTab = "skills" | "tools" | "mcp" | "memory" | "cron" | "channels";
export type WorkspaceTab = "artifacts" | "files" | "git" | "agents" | "terminal" | "voice";
export type WorkspaceMode = "closed" | "hidden" | "open";
export type SidebarMode = "sessions" | "bots";
export type SessionFilter = "all" | "pinned";
export type Reasoning = "Off" | "Low" | "Medium" | "High" | "Max";

export interface Gateway {
  id: string;
  name: string;
  kind: GatewayKind;
  health: GatewayHealth;
  latencyMs: number | null;
  primary: boolean;
  appManaged: boolean;
  auth: GatewayAuth;
  host: string;
  detail: string;
  lastTest: string;
  lastTestTone: "ok" | "warn" | "error";
  update: UpdateState;
  color: string;
}

export interface Profile {
  id: string;
  gatewayId: string;
  name: string;
  handle: string;
  color: string;
  model: string;
  effort: Reasoning;
  initials: string;
}

export interface Attachment {
  id: string;
  name: string;
  kind: "file" | "folder" | "diff" | "url" | "artifact";
  detail?: string;
}

export interface ContextChip {
  id: string;
  label: string;
  kind: "file" | "folder" | "diff" | "url" | "artifact";
  detail?: string;
}

export interface Activity {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary: string;
  args?: string;
  output?: string;
  image?: string;
  expanded?: boolean;
}

export interface Approval {
  id: string;
  command: string;
  cwd: string;
  targetGateway: string;
  targetProfile: string;
  status: "pending" | "approved" | "denied" | "inspected";
  reason?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  time: string;
  host: string;
  author?: string;
  activities?: Activity[];
  approval?: Approval;
  attachments?: Attachment[];
}

export interface Checkpoint {
  id: string;
  label: string;
  time: string;
  files: number;
  kind: "auto" | "manual";
  status: "available" | "restored";
}

export interface Session {
  id: string;
  gatewayId: string;
  profileId: string;
  title: string;
  preview: string;
  updatedAt: string;
  group: "today" | "yesterday" | "earlier";
  pinned: boolean;
  botId?: string;
  messages: Message[];
  checkpoints: Checkpoint[];
}

export interface Channel {
  id: string;
  gatewayId: string;
  profileId: string;
  name: string;
  kind: "Telegram" | "Discord" | "Slack" | "WhatsApp" | "Signal" | "Webhook";
  handle: string;
  connected: boolean;
  status: "ready" | "paused" | "error";
}

export interface CronRun {
  id: string;
  at: string;
  result: "success" | "error" | "running";
  duration: string;
}

export interface CronJob {
  id: string;
  gatewayId: string;
  profileId: string;
  name: string;
  schedule: string;
  nextRun: string;
  lastRun: string;
  status: "active" | "paused" | "running" | "success" | "error";
  history: CronRun[];
  heartbeat?: boolean;
  loop?: boolean;
  botId?: string;
}

export interface McpServer {
  id: string;
  gatewayId: string;
  profileId: string;
  name: string;
  transport: "stdio" | "http";
  status: "ready" | "stale" | "error";
  tools: string[];
  enabled: boolean;
  filters: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  installed: boolean;
  enabled: boolean;
  source: "bundled" | "hub" | "custom";
  curator?: string;
}

export interface Toolset {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  examples: string;
}

export interface MemoryFile {
  id: string;
  gatewayId: string;
  profileId: string;
  name: "MEMORY.md" | "USER.md" | "SOUL.md";
  content: string;
}

export interface Artifact {
  id: string;
  gatewayId: string;
  profileId: string;
  sessionId: string;
  name: string;
  kind: "html" | "image" | "markdown";
  updatedAt: string;
  size: string;
  summary: string;
  html?: string;
  image?: string;
  markdown?: string;
}

export interface FileNode {
  id: string;
  name: string;
  kind: "file" | "folder";
  path: string;
  children?: FileNode[];
  ext?: string;
  content?: string;
}

export interface Subagent {
  id: string;
  gatewayId: string;
  profileId: string;
  name: string;
  task: string;
  status: "running" | "done" | "stopped";
  elapsed: string;
  model: string;
  activity: string;
  transcript: string[];
}

export interface Bot {
  id: string;
  name: string;
  handle: string;
  gatewayId: string;
  profileId: string;
  title: string;
  avatar: string;
  color: string;
  latest: string;
  unread: number;
  status: "active" | "idle";
  section: string;
  sessionId: string;
}

export interface Routine {
  id: string;
  botId: string;
  gatewayId: string;
  profileId: string;
  name: string;
  schedule: string;
  nextRun: string;
  status: "active" | "paused";
}

export interface Annotation {
  id: string;
  x: number;
  y: number;
  comment: string;
  createdAt: string;
}

export interface TerminalState {
  gatewayId: string;
  lines: string[];
  command: string;
  running: boolean;
  startedAt: number;
}

export interface PreviewState {
  artifactId?: string;
  annotate: boolean;
  annotations: Annotation[];
  pinDraft?: string;
  scrollTop?: number;
}

export interface WorkspaceState {
  mode: WorkspaceMode;
  tab: WorkspaceTab;
  terminal: TerminalState;
  preview: PreviewState;
  git: { scope: "uncommitted" | "branch" | "last-turn"; fileId?: string };
  agents: { selectedId?: string; steer: string };
  hiddenAt?: number;
}

export interface ChatState {
  draft: string;
  attachments: Attachment[];
  contexts: ContextChip[];
  history: string[];
  historyIndex: number;
  streaming: boolean;
  streamingMessageId?: string;
  model: string;
  reasoning: Reasoning;
  modelPickerOpen: boolean;
  slashOpen: boolean;
  contextOpen: boolean;
}

export interface CapabilityState {
  tab: CapabilityTab;
  scopeGatewayId: string;
  scopeProfileId: string;
  skillQuery: string;
  skillCategory: string;
}

export interface SettingsState {
  section: SettingsSection;
  scopeGatewayId: string;
  scopeProfileId: string;
}

export interface Toast {
  id: string;
  title: string;
  message?: string;
  tone: ToastTone;
}

export interface AppState {
  gateways: Gateway[];
  profiles: Profile[];
  sessions: Session[];
  channels: Channel[];
  cronJobs: CronJob[];
  mcpServers: McpServer[];
  skills: Skill[];
  toolsets: Toolset[];
  memoryFiles: MemoryFile[];
  artifacts: Artifact[];
  filesByGateway: Record<string, FileNode[]>;
  subagents: Subagent[];
  bots: Bot[];
  routines: Routine[];
  activeGatewayId: string;
  activeProfileId: string;
  activeSessionId: string;
  activeBotId?: string;
  lastProfileByGateway: Record<string, string>;
  allProfiles: boolean;
  sidebarMode: SidebarMode;
  sessionSearch: string;
  sessionFilter: SessionFilter;
  chat: ChatState;
  workspace: WorkspaceState;
  capabilities: CapabilityState;
  capabilitiesOpen: boolean;
  settings: SettingsState;
  overlay: Overlay;
  gatewaySwitcherOpen: boolean;
  restartRequired: boolean;
  primaryGatewayId: string;
  lastUsedGatewayId: string;
  returnToLastGateway: boolean;
  updateStates: Record<string, UpdateState>;
  toast?: Toast;
  routePulse: number;
  nextId: number;
}
