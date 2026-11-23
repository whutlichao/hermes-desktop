import type {
  ApprovalView,
  CapabilityClassification,
  CapabilityDeepLink,
  CapabilityDegradation,
  CapabilityDomainId,
  CapabilityDomainSummary,
  CapabilityEntry,
  CapabilityGroup,
  CapabilityMethodTier,
  CapabilityOrigin,
  CapabilityProviderKind,
  CapabilityRuntimeStatus,
  CapabilitySnapshot,
  CapabilitySource,
  ExtensionCliAction,
  ExtensionInventoryStatus,
  ExtensionInventoryView,
  ExtensionPluginRow,
  ExternalAttribution,
  McpInventoryRow,
  McpInventoryView,
  SkillInventoryRow,
  SkillsInventoryView,
  ToolInventoryRow,
  ToolsInventoryView,
} from "@hermes/contracts";
import { getCopy, type CopyKey } from "./copy";

export interface CapabilityDomainMeta {
  domain: CapabilityDomainId;
  group: CapabilityGroup;
  classification: CapabilityClassification;
  labelKey: CopyKey;
  probeMethod?: string;
  requiredMethods: string[];
  deepLink?: CapabilityDeepLink;
}

export const CAPABILITY_DOMAIN_CATALOG: readonly CapabilityDomainMeta[] = [
  // Core 5 (eagerly probed on connect via idempotent read-only checks)
  {
    domain: "chat",
    group: "core",
    classification: "native",
    labelKey: "capabilities.domain.chat",
    probeMethod: "session.info",
    requiredMethods: ["prompt.submit"],
  },
  {
    domain: "approval",
    group: "core",
    classification: "native",
    labelKey: "capabilities.domain.approval",
    probeMethod: "approval.list",
    requiredMethods: ["approval.list"],
  },
  {
    domain: "session",
    group: "core",
    classification: "native",
    labelKey: "capabilities.domain.session",
    probeMethod: "session.list",
    requiredMethods: ["session.list"],
  },
  {
    domain: "terminal",
    group: "core",
    classification: "native",
    labelKey: "capabilities.domain.terminal",
    probeMethod: "terminal.list",
    requiredMethods: ["shell.exec"],
  },
  {
    domain: "settings",
    group: "core",
    classification: "native",
    labelKey: "capabilities.domain.settings",
    probeMethod: "config.get",
    requiredMethods: [],
  },

  // Admin 8 (lazily probed when opened)
  {
    domain: "profile",
    group: "admin",
    classification: "native",
    labelKey: "capabilities.domain.profile",
    probeMethod: "profiles.list",
    requiredMethods: ["profiles.list"],
  },
  {
    domain: "skills",
    group: "admin",
    classification: "native",
    labelKey: "capabilities.domain.skills",
    probeMethod: "skills.list",
    requiredMethods: ["skills.list"],
    deepLink: {
      kind: "cli",
      label: "只读 · 管理请使用 CLI",
      cliCommand: "hermes skills list",
    },
  },
  {
    domain: "tools",
    group: "admin",
    classification: "native",
    labelKey: "capabilities.domain.tools",
    probeMethod: "tools.show",
    requiredMethods: ["tools.show"],
  },
  {
    domain: "mcp",
    group: "admin",
    classification: "native",
    labelKey: "capabilities.domain.mcp",
    probeMethod: "mcp.list",
    requiredMethods: ["mcp.list"],
    deepLink: {
      kind: "cli",
      label: "在官方 CLI/Desktop 打开",
      cliCommand: "hermes mcp list",
    },
  },
  {
    domain: "memory",
    group: "admin",
    classification: "read_only",
    labelKey: "capabilities.domain.memory",
    probeMethod: "session.context_breakdown",
    requiredMethods: ["session.context_breakdown"],
  },
  {
    domain: "cron",
    group: "admin",
    classification: "native",
    labelKey: "capabilities.domain.cron",
    probeMethod: "cron.status",
    requiredMethods: ["cron.status"],
  },
  {
    domain: "messaging",
    group: "admin",
    classification: "read_only",
    labelKey: "capabilities.domain.messaging",
    probeMethod: "messaging.status",
    requiredMethods: ["messaging.status"],
    deepLink: {
      kind: "docs",
      label: "在官方 CLI/Desktop 打开",
      url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging",
    },
  },
  {
    domain: "plugins",
    group: "admin",
    classification: "read_only",
    labelKey: "capabilities.domain.plugins",
    probeMethod: "plugins.list",
    requiredMethods: ["plugins.list"],
    deepLink: {
      kind: "cli",
      label: "只读 · 在官方 CLI/Desktop 打开",
      cliCommand: "hermes plugins list",
    },
  },

  // Exec 4 (lazily probed when opened)
  {
    domain: "checkpoint",
    group: "exec",
    classification: "native",
    labelKey: "capabilities.domain.checkpoint",
    probeMethod: "checkpoint.list",
    requiredMethods: ["checkpoint.list"],
  },
  {
    domain: "files_artifacts",
    group: "exec",
    classification: "native",
    labelKey: "capabilities.domain.files_artifacts",
    probeMethod: "files.list",
    requiredMethods: ["files.list"],
  },
  {
    domain: "git_worktree",
    group: "exec",
    classification: "deep_link",
    labelKey: "capabilities.domain.git_worktree",
    requiredMethods: [],
    deepLink: {
      kind: "cli",
      label: "在 Terminal 中使用 git / gh",
      cliCommand: "git status",
    },
  },
  {
    domain: "subagents",
    group: "exec",
    classification: "native",
    labelKey: "capabilities.domain.subagents",
    probeMethod: "subagents.list",
    requiredMethods: ["subagents.list"],
  },

  // Deferred 4 (ONLY disclosure footnote; zero actions/buttons/tabs/menu items/⌘K entries)
  {
    domain: "voice",
    group: "deferred",
    classification: "deferred",
    labelKey: "capabilities.domain.voice",
    requiredMethods: [],
  },
  {
    domain: "bots",
    group: "deferred",
    classification: "deferred",
    labelKey: "capabilities.domain.bots",
    requiredMethods: [],
  },
  {
    domain: "memory_graph",
    group: "deferred",
    classification: "deferred",
    labelKey: "capabilities.domain.memory_graph",
    requiredMethods: [],
  },
  {
    domain: "kanban",
    group: "deferred",
    classification: "deferred",
    labelKey: "capabilities.domain.kanban",
    requiredMethods: [],
  },
];

export const CORE_CAPABILITY_DOMAINS: readonly CapabilityDomainId[] = [
  "chat",
  "approval",
  "session",
  "terminal",
  "settings",
];

/**
 * Explicit alias table ONLY — heuristic or regex method guessing is strictly forbidden.
 */
export const EXPLICIT_METHOD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "session.activate": "session.resume",
  "session.close": "session.detach",
  "session.status": "session.info",
  "sessions.list": "session.list",
  "prompt.steer": "session.steer",
  "subagents.list": "subagent.list",
  "subagents.steer": "subagent.steer",
  "subagents.interrupt": "subagent.interrupt",
  "subagents.tail": "subagent.tail",
  "checkpoint.list": "rollback.list",
  "checkpoint.diff": "rollback.diff",
  "checkpoint.restore": "rollback.restore",
  "reload.skills": "skills.reload",
  "reload.mcp": "mcp.reload",
});

const EXPLICIT_REVERSE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "session.list": "sessions.list",
  "session.steer": "prompt.steer",
  "session.info": "session.status",
  "subagent.list": "subagents.list",
  "subagent.steer": "subagents.steer",
  "subagent.interrupt": "subagents.interrupt",
  "subagent.tail": "subagents.tail",
  "rollback.list": "checkpoint.list",
  "rollback.diff": "checkpoint.diff",
  "rollback.restore": "checkpoint.restore",
  "skills.reload": "reload.skills",
  "mcp.reload": "reload.mcp",
});

export function resolveExplicitMethodAlias(method: string): string | null {
  if (Object.hasOwn(EXPLICIT_METHOD_ALIASES, method)) {
    return EXPLICIT_METHOD_ALIASES[method];
  }
  return null;
}

export interface MethodResolutionResult {
  method: string;
  tier: CapabilityMethodTier;
  aliasUsed?: string;
}

export function resolveMethodWithAlias(
  requestedMethod: string,
  methodTiers: Record<string, CapabilityMethodTier>,
): MethodResolutionResult {
  if (Object.hasOwn(methodTiers, requestedMethod) && methodTiers[requestedMethod] !== "unknown") {
    return {
      method: requestedMethod,
      tier: methodTiers[requestedMethod],
    };
  }

  const forwardAlias = resolveExplicitMethodAlias(requestedMethod);
  if (forwardAlias && Object.hasOwn(methodTiers, forwardAlias)) {
    return {
      method: forwardAlias,
      tier: methodTiers[forwardAlias],
      aliasUsed: `${requestedMethod} -> ${forwardAlias}`,
    };
  }

  if (Object.hasOwn(EXPLICIT_REVERSE_ALIASES, requestedMethod)) {
    const rev = EXPLICIT_REVERSE_ALIASES[requestedMethod];
    if (Object.hasOwn(methodTiers, rev)) {
      return {
        method: rev,
        tier: methodTiers[rev],
        aliasUsed: `${requestedMethod} -> ${rev}`,
      };
    }
  }

  return {
    method: requestedMethod,
    tier: Object.hasOwn(methodTiers, requestedMethod) ? methodTiers[requestedMethod] : "unknown",
  };
}

interface ActionTemplate {
  domain: CapabilityDomainId;
  group: CapabilityGroup;
  actionId: string;
  labelKey: CopyKey;
  hintKey?: CopyKey;
  shortcut?: string;
  classification: Exclude<CapabilityClassification, "deferred">;
  requiredMethods: string[];
  handlerId: string;
  evidenceTestId: string;
  localOnly?: boolean;
  localFallbackDegraded?: boolean;
  deepLink?: CapabilityDeepLink;
}

const ACTION_TEMPLATES: readonly ActionTemplate[] = [
  // Core 5
  {
    domain: "chat",
    group: "core",
    actionId: "chat.submit",
    labelKey: "cap.action.chat.submit",
    hintKey: "cap.hint.chat.submit",
    classification: "native",
    requiredMethods: ["prompt.submit"],
    handlerId: "chat.focusComposer",
    evidenceTestId: "cap-action-chat-submit",
  },
  {
    domain: "chat",
    group: "core",
    actionId: "chat.cancel",
    labelKey: "cap.action.chat.cancel",
    hintKey: "cap.hint.chat.cancel",
    classification: "native",
    requiredMethods: ["prompt.cancel"],
    handlerId: "chat.stopTurn",
    evidenceTestId: "cap-action-chat-cancel",
  },
  {
    domain: "chat",
    group: "core",
    actionId: "chat.steer",
    labelKey: "cap.action.chat.steer",
    hintKey: "cap.hint.chat.steer",
    classification: "native",
    requiredMethods: ["session.steer"],
    handlerId: "chat.focusSteer",
    evidenceTestId: "cap-action-chat-steer",
  },
  {
    domain: "approval",
    group: "core",
    actionId: "approval.inspect",
    labelKey: "cap.action.approval.inspect",
    hintKey: "cap.hint.approval.inspect",
    classification: "native",
    requiredMethods: ["approval.list"],
    handlerId: "capabilities.inspectApproval",
    evidenceTestId: "cap-action-approval-inspect",
  },
  {
    domain: "session",
    group: "core",
    actionId: "session.create",
    labelKey: "palette.cmdNewSession",
    hintKey: "palette.cmdNewSessionHint",
    shortcut: "⌘N",
    classification: "native",
    requiredMethods: ["session.create"],
    handlerId: "session.create",
    evidenceTestId: "cap-action-session-create",
  },
  {
    domain: "session",
    group: "core",
    actionId: "session.list",
    labelKey: "cap.action.session.list",
    hintKey: "cap.hint.session.list",
    classification: "native",
    requiredMethods: ["session.list"],
    handlerId: "surface.openSessions",
    evidenceTestId: "cap-action-session-list",
  },
  {
    domain: "session",
    group: "core",
    actionId: "session.resume",
    labelKey: "cap.action.session.resume",
    hintKey: "cap.hint.session.resume",
    classification: "native",
    requiredMethods: ["session.resume"],
    handlerId: "session.resumeActive",
    evidenceTestId: "cap-action-session-resume",
  },
  {
    domain: "session",
    group: "core",
    actionId: "session.manage_cli",
    labelKey: "cap.action.session.manageCli",
    hintKey: "cap.hint.session.manageCli",
    classification: "deep_link",
    requiredMethods: [],
    handlerId: "capabilities.copyCli",
    evidenceTestId: "cap-action-session-manage-cli",
    localOnly: true,
    deepLink: {
      kind: "cli",
      label: "在官方 CLI/Desktop 打开",
      cliCommand: "hermes sessions --help",
    },
  },
  {
    domain: "terminal",
    group: "core",
    actionId: "terminal.open",
    labelKey: "cap.action.terminal.open",
    hintKey: "cap.hint.terminal.open",
    classification: "native",
    requiredMethods: ["shell.exec"],
    handlerId: "workspace.openTerminal",
    evidenceTestId: "cap-action-terminal-open",
    localFallbackDegraded: true,
  },
  {
    domain: "settings",
    group: "core",
    actionId: "settings.open",
    labelKey: "palette.cmdSettings",
    hintKey: "palette.cmdSettingsHint",
    shortcut: "⌘,",
    classification: "native",
    requiredMethods: [],
    handlerId: "surface.openSettings",
    evidenceTestId: "cap-action-settings-open",
    localOnly: true,
  },
  {
    domain: "settings",
    group: "core",
    actionId: "capabilities.open",
    labelKey: "palette.cmdCapabilities",
    hintKey: "palette.cmdCapabilitiesHint",
    classification: "native",
    requiredMethods: [],
    handlerId: "surface.openCapabilities",
    evidenceTestId: "cap-action-capabilities-open",
    localOnly: true,
  },
  {
    domain: "settings",
    group: "core",
    actionId: "shortcuts.open",
    labelKey: "palette.cmdShortcuts",
    hintKey: "palette.cmdShortcutsHint",
    shortcut: "⌘?",
    classification: "native",
    requiredMethods: [],
    handlerId: "surface.openShortcuts",
    evidenceTestId: "cap-action-shortcuts-open",
    localOnly: true,
  },

  // Admin 8
  {
    domain: "profile",
    group: "admin",
    actionId: "profile.switch",
    labelKey: "cap.action.profile.switch",
    hintKey: "cap.hint.profile.switch",
    classification: "native",
    requiredMethods: ["profiles.list"],
    handlerId: "surface.openScopePopover",
    evidenceTestId: "cap-action-profile-switch",
  },
  {
    domain: "skills",
    group: "admin",
    actionId: "skills.list",
    labelKey: "cap.action.skills.list",
    hintKey: "cap.hint.skills.list",
    classification: "native",
    requiredMethods: ["skills.list"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-skills-list",
    deepLink: {
      kind: "cli",
      label: "只读 · 管理请使用 CLI",
      cliCommand: "hermes skills list",
    },
  },
  {
    domain: "tools",
    group: "admin",
    actionId: "tools.show",
    labelKey: "cap.action.tools.show",
    hintKey: "cap.hint.tools.show",
    classification: "native",
    requiredMethods: ["tools.show"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-tools-show",
  },
  {
    domain: "mcp",
    group: "admin",
    actionId: "mcp.status",
    labelKey: "cap.action.mcp.status",
    hintKey: "cap.hint.mcp.status",
    classification: "native",
    requiredMethods: ["mcp.list"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-mcp-status",
    deepLink: {
      kind: "cli",
      label: "在官方 CLI/Desktop 打开",
      cliCommand: "hermes mcp list",
    },
  },
  {
    domain: "memory",
    group: "admin",
    actionId: "memory.inspect",
    labelKey: "cap.action.memory.inspect",
    hintKey: "cap.hint.memory.inspect",
    classification: "read_only",
    requiredMethods: ["session.context_breakdown"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-memory-inspect",
  },
  {
    domain: "cron",
    group: "admin",
    actionId: "cron.status",
    labelKey: "cap.action.cron.status",
    hintKey: "cap.hint.cron.status",
    classification: "native",
    requiredMethods: ["cron.status"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-cron-status",
  },
  {
    domain: "messaging",
    group: "admin",
    actionId: "messaging.status",
    labelKey: "cap.action.messaging.status",
    hintKey: "cap.hint.messaging.status",
    classification: "read_only",
    requiredMethods: ["messaging.status"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-messaging-status",
    deepLink: {
      kind: "docs",
      label: "在官方 CLI/Desktop 打开",
      url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging",
    },
  },
  {
    domain: "plugins",
    group: "admin",
    actionId: "plugins.list",
    labelKey: "cap.action.plugins.list",
    hintKey: "cap.hint.plugins.list",
    classification: "read_only",
    requiredMethods: ["plugins.list"],
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-plugins-list",
    deepLink: {
      kind: "cli",
      label: "只读 · 在官方 CLI/Desktop 打开",
      cliCommand: "hermes plugins list",
    },
  },

  // Exec 4
  {
    domain: "checkpoint",
    group: "exec",
    actionId: "checkpoint.list",
    labelKey: "cap.action.checkpoint.list",
    hintKey: "cap.hint.checkpoint.list",
    classification: "native",
    requiredMethods: ["checkpoint.list"],
    handlerId: "workspace.openCheckpoints",
    evidenceTestId: "cap-action-checkpoint-list",
  },
  {
    domain: "checkpoint",
    group: "exec",
    actionId: "checkpoint.diff",
    labelKey: "cap.action.checkpoint.diff",
    hintKey: "cap.hint.checkpoint.diff",
    classification: "native",
    requiredMethods: ["checkpoint.diff"],
    handlerId: "workspace.openCheckpoints",
    evidenceTestId: "cap-action-checkpoint-diff",
  },
  {
    domain: "checkpoint",
    group: "exec",
    actionId: "checkpoint.restore",
    labelKey: "cap.action.checkpoint.restore",
    hintKey: "cap.hint.checkpoint.restore",
    classification: "native",
    requiredMethods: ["checkpoint.restore"],
    handlerId: "workspace.openCheckpoints",
    evidenceTestId: "cap-action-checkpoint-restore",
  },
  {
    domain: "files_artifacts",
    group: "exec",
    actionId: "workspace.open",
    labelKey: "palette.cmdWorkspace",
    hintKey: "palette.cmdWorkspaceHint",
    shortcut: "⌘B",
    classification: "native",
    requiredMethods: [],
    handlerId: "workspace.toggle",
    evidenceTestId: "cap-action-workspace-open",
    localOnly: true,
  },
  {
    domain: "files_artifacts",
    group: "exec",
    actionId: "files_artifacts.browse",
    labelKey: "cap.action.files.browse",
    hintKey: "cap.hint.files.browse",
    classification: "native",
    requiredMethods: ["files.list"],
    handlerId: "workspace.openFiles",
    evidenceTestId: "cap-action-files-browse",
  },
  {
    domain: "git_worktree",
    group: "exec",
    actionId: "git_worktree.open_terminal",
    labelKey: "cap.action.git.terminal",
    hintKey: "cap.hint.git.terminal",
    classification: "deep_link",
    requiredMethods: [],
    handlerId: "workspace.openGit",
    evidenceTestId: "cap-action-git-terminal",
    localOnly: true,
    deepLink: {
      kind: "cli",
      label: "在 Terminal 中使用 git / gh",
      cliCommand: "git status",
    },
  },
  {
    domain: "subagents",
    group: "exec",
    actionId: "subagents.list",
    labelKey: "cap.action.subagents.list",
    hintKey: "cap.hint.subagents.list",
    classification: "native",
    requiredMethods: ["subagents.list"],
    handlerId: "workspace.openAgents",
    evidenceTestId: "cap-action-subagents-list",
  },
  {
    domain: "subagents",
    group: "exec",
    actionId: "subagents.steer",
    labelKey: "cap.action.subagents.steer",
    hintKey: "cap.hint.subagents.steer",
    classification: "native",
    requiredMethods: ["subagents.steer"],
    handlerId: "workspace.openAgents",
    evidenceTestId: "cap-action-subagents-steer",
  },
  {
    domain: "subagents",
    group: "exec",
    actionId: "subagents.interrupt",
    labelKey: "cap.action.subagents.interrupt",
    hintKey: "cap.hint.subagents.interrupt",
    classification: "native",
    requiredMethods: ["subagents.interrupt"],
    handlerId: "workspace.openAgents",
    evidenceTestId: "cap-action-subagents-interrupt",
  },
  {
    domain: "subagents",
    group: "exec",
    actionId: "subagents.tail",
    labelKey: "cap.action.subagents.tail",
    hintKey: "cap.hint.subagents.tail",
    classification: "native",
    requiredMethods: ["subagents.tail"],
    handlerId: "workspace.openAgents",
    evidenceTestId: "cap-action-subagents-tail",
  },
];

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

const UNSAFE_SECRET_OR_PATH_RE =
  /(?:https?|wss?|file):\/\/|\/Users\/|\/home\/|[A-Za-z]:\\|\.\.\/|sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_-]{6,}|Bearer\s+\S+|token=\S+|secret=\S+/i;

function sanitizeProviderToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (UNSAFE_SECRET_OR_PATH_RE.test(trimmed)) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (!/^[A-Za-z0-9._:@-]{1,48}$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeDisplayText(raw: unknown, maxLen = 120): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (UNSAFE_SECRET_OR_PATH_RE.test(trimmed)) return undefined;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

function sanitizeSafeErrorCode(raw: unknown, fallback: string): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^[A-Z0-9_:-]{2,32}$/.test(trimmed)) {
      return trimmed;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const code = (raw as Record<string, unknown>).code;
    if (typeof code === "string" && /^[A-Z0-9_:-]{2,32}$/.test(code.trim())) {
      return code.trim();
    }
  }
  return fallback;
}

export interface ExternalAttributionInput {
  origin?: CapabilityOrigin | string | null;
  source?: string | null;
  providerKind?: CapabilityProviderKind | null;
  providerId?: string | null;
  mcpServer?: string | null;
  pluginName?: string | null;
  skillName?: string | null;
  toolset?: string | null;
  gatewayId?: string | null;
}

function buildExternalAttribution(
  kind: CapabilityProviderKind,
  rawId: unknown,
): ExternalAttribution {
  const id = sanitizeProviderToken(rawId);
  if (!id) {
    const unknownLabel = getCopy("attribution.unknown");
    return {
      origin: "unknown",
      sourceLabel: unknownLabel,
      accessibleLabel: unknownLabel,
    };
  }
  const prefixByKind: Record<CapabilityProviderKind, string> = {
    mcp: "MCP",
    plugin: "Plugin",
    skill: "Skill",
    tool: "Tool",
    gateway: "Gateway",
  };
  const providerLabel = `${prefixByKind[kind]} · ${id}`;
  const fullLabel = `${getCopy("attribution.externalPrefix")}${providerLabel}`;
  return {
    origin: "external",
    provider: {
      kind,
      id,
      label: providerLabel,
    },
    sourceLabel: fullLabel,
    accessibleLabel: fullLabel,
  };
}

export function resolveExternalAttribution(
  input: ExternalAttributionInput = {},
): ExternalAttribution {
  const source = typeof input.source === "string" ? input.source.trim().toLowerCase() : "";
  const origin = typeof input.origin === "string" ? input.origin.trim().toLowerCase() : "";

  if (input.mcpServer != null || input.providerKind === "mcp" || source === "mcp") {
    return buildExternalAttribution("mcp", input.mcpServer ?? input.providerId);
  }

  if (input.pluginName != null || input.providerKind === "plugin" || source === "plugin") {
    return buildExternalAttribution("plugin", input.pluginName ?? input.providerId);
  }

  if (
    source === "hub" ||
    source === "custom" ||
    (input.providerKind === "skill" && (origin === "external" || source === "external"))
  ) {
    return buildExternalAttribution("skill", input.skillName ?? input.providerId);
  }

  if (
    input.providerKind === "tool" ||
    (input.toolset != null &&
      source !== "bundled" &&
      source !== "builtin" &&
      source !== "core" &&
      origin !== "builtin")
  ) {
    return buildExternalAttribution("tool", input.toolset ?? input.providerId);
  }

  if (input.providerKind === "gateway" || input.gatewayId != null) {
    return buildExternalAttribution("gateway", input.gatewayId ?? input.providerId);
  }

  if (origin === "external" || source === "external") {
    if (input.providerKind && input.providerId) {
      return buildExternalAttribution(input.providerKind, input.providerId);
    }
    const unknownLabel = getCopy("attribution.unknown");
    return {
      origin: "unknown",
      sourceLabel: unknownLabel,
      accessibleLabel: unknownLabel,
    };
  }

  if (
    origin === "builtin" ||
    source === "bundled" ||
    source === "builtin" ||
    source === "core"
  ) {
    const builtinLabel = getCopy("attribution.builtin");
    return {
      origin: "builtin",
      sourceLabel: builtinLabel,
      accessibleLabel: builtinLabel,
    };
  }

  const unknownLabel = getCopy("attribution.unknown");
  return {
    origin: "unknown",
    sourceLabel: unknownLabel,
    accessibleLabel: unknownLabel,
  };
}

export interface ProjectApprovalViewInput extends ExternalAttributionInput {
  approvalId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  status?: "pending" | "approved" | "denied";
  requestedAt: string;
}

export function projectApprovalView(input: ProjectApprovalViewInput): ApprovalView {
  return {
    approvalId: input.approvalId,
    sessionId: input.sessionId,
    toolName: input.toolName,
    summary: input.summary,
    status: input.status ?? "pending",
    requestedAt: input.requestedAt,
    attribution: resolveExternalAttribution(input),
  };
}

export const OFFICIAL_PLUGINS_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/plugins";
export const OFFICIAL_SKILLS_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/skills";
export const OFFICIAL_TOOLS_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/tools";
export const OFFICIAL_MCP_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/mcp";

function buildCliAction(id: string, label: string, command: string): ExtensionCliAction {
  return {
    id,
    label,
    command,
    note: getCopy("extensions.cli.neverExecuted"),
  };
}

function extractCount(directCount: unknown, listOrCount: unknown): number | undefined {
  if (typeof directCount === "number" && Number.isFinite(directCount) && directCount >= 0) {
    return Math.floor(directCount);
  }
  if (typeof listOrCount === "number" && Number.isFinite(listOrCount) && listOrCount >= 0) {
    return Math.floor(listOrCount);
  }
  if (Array.isArray(listOrCount)) {
    return listOrCount.length;
  }
  return undefined;
}

export function projectPluginRows(rawPlugins: unknown): ExtensionPluginRow[] {
  if (!Array.isArray(rawPlugins)) return [];
  const rows: ExtensionPluginRow[] = [];

  for (const item of rawPlugins) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const safeName =
      sanitizeProviderToken(raw.name) ?? sanitizeProviderToken(raw.key);
    if (!safeName) continue;

    const safeKey = sanitizeProviderToken(raw.key) ?? undefined;
    const pluginKey = safeKey ?? safeName;
    const safeVersion =
      sanitizeDisplayText(raw.version, 32) ?? getCopy("extensions.unreportedValue");
    const enabled = Boolean(raw.enabled);
    const enabledLabel = enabled
      ? getCopy("extensions.plugins.enabledLabel")
      : getCopy("extensions.plugins.disabledLabel");

    const hasError =
      raw.error !== undefined &&
      raw.error !== null &&
      raw.error !== false &&
      raw.error !== "";
    const loadStatus: "ok" | "failed" | "unknown" = hasError
      ? "failed"
      : typeof raw.enabled === "boolean"
        ? "ok"
        : "unknown";
    const loadStatusLabel =
      loadStatus === "failed"
        ? getCopy("extensions.plugins.loadStatusFailed")
        : loadStatus === "ok"
          ? getCopy("extensions.plugins.loadStatusOk")
          : getCopy("extensions.plugins.loadStatusUnknown");
    const errorCode =
      loadStatus === "failed"
        ? sanitizeSafeErrorCode(raw.error_code ?? raw.error, "PLUGIN_LOAD_FAILED")
        : undefined;

    const toolCount = extractCount(raw.tool_count ?? raw.toolCount, raw.tools);
    const hookCount = extractCount(raw.hook_count ?? raw.hookCount, raw.hooks);
    const commandCount = extractCount(raw.command_count ?? raw.commandCount, raw.commands);

    const cliActions: ExtensionCliAction[] = /^[A-Za-z0-9._@-]{1,48}$/.test(pluginKey)
      ? [
          buildCliAction(
            `plugin-enable-${pluginKey}`,
            getCopy("extensions.plugins.cliEnableLabel"),
            `hermes plugins enable ${pluginKey}`,
          ),
          buildCliAction(
            `plugin-remove-${pluginKey}`,
            getCopy("extensions.plugins.cliRemoveLabel"),
            `hermes plugins remove ${pluginKey}`,
          ),
          buildCliAction(
            `plugin-update-${pluginKey}`,
            getCopy("extensions.plugins.cliUpdateLabel"),
            `hermes plugins update ${pluginKey}`,
          ),
        ]
      : [];

    rows.push({
      pluginKey,
      name: safeName,
      version: safeVersion,
      enabled,
      enabledLabel,
      loadStatus,
      loadStatusLabel,
      ...(errorCode ? { errorCode } : {}),
      ...(safeKey ? { key: safeKey } : {}),
      ...(toolCount !== undefined ? { toolCount } : {}),
      ...(hookCount !== undefined ? { hookCount } : {}),
      ...(commandCount !== undefined ? { commandCount } : {}),
      skillsLabel: getCopy("extensions.plugins.skillsUnreported"),
      cliActions,
      attribution: resolveExternalAttribution({ pluginName: safeName }),
    });
  }

  rows.sort((a, b) => {
    const aFailed = a.loadStatus === "failed" ? 0 : 1;
    const bFailed = b.loadStatus === "failed" ? 0 : 1;
    if (aFailed !== bFailed) return aFailed - bFailed;
    return a.name.localeCompare(b.name, "en");
  });

  return rows;
}

export function projectSkillRows(rawSkills: unknown): SkillInventoryRow[] {
  if (!Array.isArray(rawSkills)) return [];
  const rows: SkillInventoryRow[] = [];

  for (const item of rawSkills) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = sanitizeProviderToken(raw.name) ?? sanitizeProviderToken(raw.id);
    if (!name) continue;
    const skillId = sanitizeProviderToken(raw.id) ?? name;
    const description = sanitizeDisplayText(raw.description, 160);
    const category = sanitizeDisplayText(raw.category, 48);
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;

    rows.push({
      skillId,
      name,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      attribution: resolveExternalAttribution({
        origin: typeof raw.origin === "string" ? raw.origin : undefined,
        source: typeof raw.source === "string" ? raw.source : undefined,
        skillName: name,
        mcpServer: typeof raw.mcp_server === "string" ? raw.mcp_server : undefined,
        pluginName: typeof raw.plugin === "string" ? raw.plugin : undefined,
      }),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return rows;
}

export function projectToolRows(rawTools: unknown): ToolInventoryRow[] {
  if (!Array.isArray(rawTools)) return [];
  const rows: ToolInventoryRow[] = [];

  for (const item of rawTools) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = sanitizeProviderToken(raw.name) ?? sanitizeProviderToken(raw.id);
    if (!name) continue;
    const toolId = sanitizeProviderToken(raw.id) ?? name;
    const description = sanitizeDisplayText(raw.description, 160);
    const toolset = sanitizeDisplayText(raw.toolset, 48);
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
    const rawSource = typeof raw.source === "string" ? raw.source : undefined;
    const mcpServer =
      typeof raw.mcp_server === "string"
        ? raw.mcp_server
        : typeof raw.server === "string"
          ? raw.server
          : undefined;
    const pluginName = typeof raw.plugin === "string" ? raw.plugin : undefined;
    const externalToolset =
      typeof raw.external_provider === "string"
        ? raw.external_provider
        : rawSource === "external" || rawSource === "custom"
          ? toolset
          : undefined;

    rows.push({
      toolId,
      name,
      ...(description ? { description } : {}),
      ...(toolset ? { toolset } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      attribution: resolveExternalAttribution({
        origin: typeof raw.origin === "string" ? raw.origin : undefined,
        source: rawSource,
        mcpServer,
        pluginName,
        toolset: externalToolset,
      }),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return rows;
}

export function projectMcpRows(rawServers: unknown): McpInventoryRow[] {
  if (!Array.isArray(rawServers)) return [];
  const rows: McpInventoryRow[] = [];

  for (const item of rawServers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = sanitizeProviderToken(raw.name) ?? sanitizeProviderToken(raw.id);
    if (!name) continue;
    const serverId = sanitizeProviderToken(raw.id) ?? name;
    const rawStatus = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
    const hasError =
      rawStatus === "error" ||
      rawStatus === "failed" ||
      (raw.error !== undefined && raw.error !== null && raw.error !== "");
    const status: "connected" | "disconnected" | "error" | "unknown" = hasError
      ? "error"
      : rawStatus === "connected" || rawStatus === "ready" || raw.connected === true
        ? "connected"
        : rawStatus === "disconnected" || rawStatus === "stopped" || raw.connected === false
          ? "disconnected"
          : "unknown";
    const statusLabel =
      status === "connected"
        ? getCopy("extensions.mcp.statusConnected")
        : status === "disconnected"
          ? getCopy("extensions.mcp.statusDisconnected")
          : status === "error"
            ? getCopy("extensions.mcp.statusError")
            : getCopy("extensions.mcp.statusUnknown");
    const toolCount = extractCount(raw.tool_count ?? raw.toolCount, raw.tools);
    const errorCode =
      status === "error"
        ? sanitizeSafeErrorCode(raw.error_code ?? raw.error, "MCP_SERVER_ERROR")
        : undefined;

    rows.push({
      serverId,
      name,
      status,
      statusLabel,
      ...(toolCount !== undefined ? { toolCount } : {}),
      ...(errorCode ? { errorCode } : {}),
      attribution: resolveExternalAttribution({ mcpServer: name }),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return rows;
}

function parseDescribeMethodTiers(
  describeResult: Record<string, unknown> | null | undefined,
): {
  methodTiers: Record<string, CapabilityMethodTier>;
  sessionCreateSpec?: { sources: string[]; parameters: string[] };
  versionOrSha?: string;
  pluginRpcAdvertised: boolean;
  gatewayToolsets?: string[];
  portableMcpServers?: string[];
  hasExplicitMethodCatalog: boolean;
} {
  const methodTiers: Record<string, CapabilityMethodTier> = {};
  if (!describeResult || typeof describeResult !== "object") {
    return {
      methodTiers,
      pluginRpcAdvertised: false,
      hasExplicitMethodCatalog: false,
    };
  }

  const servedList = asStringArray(describeResult.served_methods);
  const olderList = asStringArray(describeResult.older_methods);
  const refusedList = asStringArray(describeResult.refused_methods);
  const hasExplicitMethodCatalog =
    Array.isArray(describeResult.served_methods) ||
    Array.isArray(describeResult.older_methods) ||
    Array.isArray(describeResult.refused_methods);

  for (const m of servedList) {
    methodTiers[m] = "served";
  }
  for (const m of olderList) {
    if (methodTiers[m] !== "served") {
      methodTiers[m] = "older";
    }
  }
  for (const m of asStringArray(describeResult.session_bound_methods)) {
    if (!methodTiers[m]) {
      methodTiers[m] = "session_bound";
    }
  }
  for (const m of asStringArray(describeResult.plugin_family_methods)) {
    if (!methodTiers[m]) {
      methodTiers[m] = "plugin_family";
    }
  }
  // Refused ALWAYS wins
  for (const m of refusedList) {
    methodTiers[m] = "refused";
  }

  let pluginRpcAdvertised = false;
  const caps = describeResult.capabilities;
  if (caps && typeof caps === "object" && !Array.isArray(caps)) {
    const capMap = caps as Record<string, unknown>;
    if (capMap["plugin-rpc-v1"] === true) {
      pluginRpcAdvertised = true;
    }
  } else if (Array.isArray(caps)) {
    const capList = asStringArray(caps);
    if (capList.includes("plugin-rpc-v1")) {
      pluginRpcAdvertised = true;
    }
  }

  // Fallback when runtime.describe uses capabilities map or capability tags without served_methods
  if (Object.keys(methodTiers).length === 0) {
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      const capMap = caps as Record<string, unknown>;
      for (const [k, v] of Object.entries(capMap)) {
        if (k === "plugin-rpc-v1" || k.startsWith("plugin.")) continue;
        if (v === true) methodTiers[k] = "served";
        else if (v === false) methodTiers[k] = "refused";
      }
      if (capMap.chat === true && !methodTiers["prompt.submit"]) {
        methodTiers["prompt.submit"] = "served";
        methodTiers["prompt.cancel"] = "served";
        methodTiers["session.steer"] = "served";
      }
    } else {
      const capList = asStringArray(caps);
      if (capList.includes("session-authority-v1")) {
        methodTiers["session.list"] = "served";
        methodTiers["session.create"] = "served";
        methodTiers["session.resume"] = "served";
        methodTiers["profiles.list"] = "served";
      }
      if (capList.includes("chat-v1") || capList.includes("prompt.submit")) {
        methodTiers["prompt.submit"] = "served";
        methodTiers["prompt.cancel"] = "served";
        methodTiers["session.steer"] = "served";
      }
    }
  }

  let sessionCreateSpec: { sources: string[]; parameters: string[] } | undefined;
  const rawCreate = describeResult.session_create;
  if (rawCreate && typeof rawCreate === "object" && !Array.isArray(rawCreate)) {
    const obj = rawCreate as Record<string, unknown>;
    sessionCreateSpec = {
      sources: asStringArray(obj.sources),
      parameters: asStringArray(obj.parameters),
    };
  }

  const gatewayToolsets = Array.isArray(describeResult.toolsets)
    ? asStringArray(describeResult.toolsets)
    : undefined;
  const portableMcpServers = Array.isArray(describeResult.mcp_servers)
    ? asStringArray(describeResult.mcp_servers)
    : undefined;

  const versionOrSha =
    typeof describeResult.code_sha === "string"
      ? describeResult.code_sha
      : typeof describeResult.gateway_version === "string"
        ? describeResult.gateway_version
        : typeof describeResult.version === "string"
          ? describeResult.version
          : undefined;

  return {
    methodTiers,
    sessionCreateSpec,
    versionOrSha,
    pluginRpcAdvertised,
    ...(gatewayToolsets ? { gatewayToolsets } : {}),
    ...(portableMcpServers ? { portableMcpServers } : {}),
    hasExplicitMethodCatalog,
  };
}

export interface ConnectHandshakeInput {
  connectionId: string;
  profileId: string;
  ownerGeneration: number;
  authorityEpoch: number;
  gatewayVersionOrSha: string;
  describeResult?: Record<string, unknown> | null;
  serverRequestsSupported: boolean;
}

export interface ProbeOutcomeInput {
  domain: CapabilityDomainId;
  method: string;
  outcome: "ok" | "method_not_found" | "timeout" | "refused";
  expectedOwnerGeneration: number;
  expectedAuthorityEpoch: number;
  expectedGeneration?: number;
}

export interface MethodNotFoundInput {
  method: string;
  expectedOwnerGeneration: number;
  expectedAuthorityEpoch: number;
}

export interface InvalidateCapabilitiesInput {
  reason: string;
  connectionId?: string;
  profileId?: string;
  ownerGeneration?: number;
  authorityEpoch?: number;
  gatewayVersionOrSha?: string;
}

export interface ApplyPluginsInventoryInput {
  expectedOwnerGeneration: number;
  expectedAuthorityEpoch: number;
  expectedGeneration?: number;
  outcome: "ok" | "method_not_found" | "refused" | "older" | "error";
  rawPlugins?: unknown;
  errorCode?: unknown;
}

export interface ApplySkillsInventoryInput {
  expectedOwnerGeneration: number;
  expectedAuthorityEpoch: number;
  expectedGeneration?: number;
  outcome: "ok" | "method_not_found" | "refused" | "older" | "error";
  rawSkills?: unknown;
  reloaded?: boolean;
  errorCode?: unknown;
}

export interface ApplyToolsInventoryInput {
  expectedOwnerGeneration: number;
  expectedAuthorityEpoch: number;
  expectedGeneration?: number;
  outcome: "ok" | "method_not_found" | "refused" | "older" | "error";
  rawTools?: unknown;
  errorCode?: unknown;
}

export interface ApplyMcpInventoryInput {
  expectedOwnerGeneration: number;
  expectedAuthorityEpoch: number;
  expectedGeneration?: number;
  outcome: "ok" | "method_not_found" | "refused" | "older" | "error";
  rawServers?: unknown;
  reloaded?: boolean;
  errorCode?: unknown;
}

export class CapabilityRegistry {
  private generation = 1;
  private invalidationGeneration = 1;
  private connected = false;
  private serverRequestsSupported = false;
  private legacyOwner = false;
  private sessionCreateSpec: { sources: string[]; parameters: string[] } | undefined;
  private methodTiers: Record<string, CapabilityMethodTier> = {};
  private notFoundMethods = new Set<string>();
  private probedDomains = new Set<CapabilityDomainId>();
  private timedOutDomains = new Set<CapabilityDomainId>();
  private invalidatedReason: string | undefined;
  private pluginRpcAdvertised = false;
  private gatewayToolsets: string[] | undefined;
  private portableMcpServers: string[] | undefined;
  private hasExplicitMethodCatalog = false;

  private pluginsState: {
    probed: boolean;
    status?: ExtensionInventoryStatus;
    rows: ExtensionPluginRow[];
    fetchedAt: string | null;
    errorCode?: string;
    degradation?: CapabilityDegradation;
  } = {
    probed: false,
    rows: [],
    fetchedAt: null,
  };

  private skillsState: {
    probed: boolean;
    status?: ExtensionInventoryStatus;
    items: SkillInventoryRow[];
    lastReloadedAt?: string;
    errorCode?: string;
  } = {
    probed: false,
    items: [],
  };

  private toolsState: {
    probed: boolean;
    status?: ExtensionInventoryStatus;
    items: ToolInventoryRow[];
    errorCode?: string;
  } = {
    probed: false,
    items: [],
  };

  private mcpState: {
    probed: boolean;
    status?: ExtensionInventoryStatus;
    items: McpInventoryRow[];
    lastReloadedAt?: string;
    errorCode?: string;
  } = {
    probed: false,
    items: [],
  };

  private key = {
    connectionId: "none",
    profileId: "default",
    ownerGeneration: 0,
    authorityEpoch: 0,
    gatewayVersionOrSha: "unconnected",
  };

  private snapshot: CapabilitySnapshot;

  constructor() {
    this.snapshot = this.buildSnapshot();
  }

  private resetExtensionStates(): void {
    this.pluginsState = {
      probed: false,
      rows: [],
      fetchedAt: null,
    };
    this.skillsState = {
      probed: false,
      items: [],
    };
    this.toolsState = {
      probed: false,
      items: [],
    };
    this.mcpState = {
      probed: false,
      items: [],
    };
  }

  getSnapshot(): CapabilitySnapshot {
    return this.snapshot;
  }

  getMethodTier(method: string): CapabilityMethodTier {
    const forward = resolveExplicitMethodAlias(method);
    const reverse = EXPLICIT_REVERSE_ALIASES[method];
    if (
      this.notFoundMethods.has(method) ||
      (forward !== null && this.notFoundMethods.has(forward)) ||
      (reverse !== undefined && this.notFoundMethods.has(reverse))
    ) {
      return "unknown";
    }
    return resolveMethodWithAlias(method, this.methodTiers).tier;
  }

  isMethodRefused(method: string): boolean {
    return this.getMethodTier(method) === "refused";
  }

  applyConnectHandshake(input: ConnectHandshakeInput): CapabilitySnapshot {
    if (
      input.connectionId === this.key.connectionId &&
      input.ownerGeneration < this.key.ownerGeneration
    ) {
      return this.snapshot;
    }

    const parsed = parseDescribeMethodTiers(input.describeResult);
    this.generation += 1;
    this.invalidationGeneration = this.generation;
    this.connected = true;
    this.serverRequestsSupported = input.serverRequestsSupported;
    this.legacyOwner = !input.serverRequestsSupported;
    this.sessionCreateSpec = parsed.sessionCreateSpec;
    this.methodTiers = parsed.methodTiers;
    this.pluginRpcAdvertised = parsed.pluginRpcAdvertised;
    this.gatewayToolsets = parsed.gatewayToolsets;
    this.portableMcpServers = parsed.portableMcpServers;
    this.hasExplicitMethodCatalog = parsed.hasExplicitMethodCatalog;
    this.notFoundMethods.clear();
    this.probedDomains.clear();
    this.timedOutDomains.clear();
    this.invalidatedReason = undefined;
    this.resetExtensionStates();
    this.key = {
      connectionId: input.connectionId,
      profileId: input.profileId,
      ownerGeneration: input.ownerGeneration,
      authorityEpoch: input.authorityEpoch,
      gatewayVersionOrSha: parsed.versionOrSha ?? input.gatewayVersionOrSha,
    };

    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  applyProbeOutcome(input: ProbeOutcomeInput): CapabilitySnapshot {
    if (
      !this.connected ||
      input.expectedOwnerGeneration !== this.key.ownerGeneration ||
      input.expectedAuthorityEpoch !== this.key.authorityEpoch ||
      (input.expectedGeneration !== undefined && input.expectedGeneration < this.invalidationGeneration)
    ) {
      return this.snapshot;
    }

    this.probedDomains.add(input.domain);

    if (input.outcome === "ok") {
      this.timedOutDomains.delete(input.domain);
      if (!this.methodTiers[input.method]) {
        this.methodTiers[input.method] = "served";
      }
    } else if (input.outcome === "method_not_found") {
      this.timedOutDomains.delete(input.domain);
      this.notFoundMethods.add(input.method);
      this.methodTiers[input.method] = "unknown";
    } else if (input.outcome === "refused") {
      this.timedOutDomains.delete(input.domain);
      this.methodTiers[input.method] = "refused";
    } else if (input.outcome === "timeout") {
      this.timedOutDomains.add(input.domain);
    }

    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  markMethodNotFound(input: MethodNotFoundInput): CapabilitySnapshot {
    if (
      !this.connected ||
      input.expectedOwnerGeneration !== this.key.ownerGeneration ||
      input.expectedAuthorityEpoch !== this.key.authorityEpoch
    ) {
      return this.snapshot;
    }

    this.notFoundMethods.add(input.method);
    this.methodTiers[input.method] = "unknown";
    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  invalidate(input: InvalidateCapabilitiesInput): CapabilitySnapshot {
    this.generation += 1;
    this.invalidationGeneration = this.generation;
    this.connected = false;
    this.serverRequestsSupported = false;
    this.legacyOwner = false;
    this.sessionCreateSpec = undefined;
    this.methodTiers = {};
    this.pluginRpcAdvertised = false;
    this.gatewayToolsets = undefined;
    this.portableMcpServers = undefined;
    this.hasExplicitMethodCatalog = false;
    this.notFoundMethods.clear();
    this.probedDomains.clear();
    this.timedOutDomains.clear();
    this.invalidatedReason = input.reason;
    this.resetExtensionStates();

    this.key = {
      connectionId: input.connectionId ?? this.key.connectionId,
      profileId: input.profileId ?? this.key.profileId,
      ownerGeneration: input.ownerGeneration ?? this.key.ownerGeneration,
      authorityEpoch: input.authorityEpoch ?? this.key.authorityEpoch,
      gatewayVersionOrSha: input.gatewayVersionOrSha ?? this.key.gatewayVersionOrSha,
    };

    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  private isValidEpochAndGeneration(input: {
    expectedOwnerGeneration: number;
    expectedAuthorityEpoch: number;
    expectedGeneration?: number;
  }): boolean {
    if (!this.connected) return false;
    if (input.expectedOwnerGeneration !== this.key.ownerGeneration) return false;
    if (input.expectedAuthorityEpoch !== this.key.authorityEpoch) return false;
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration < this.invalidationGeneration
    ) {
      return false;
    }
    return true;
  }

  applyPluginsInventory(input: ApplyPluginsInventoryInput): CapabilitySnapshot {
    if (!this.isValidEpochAndGeneration(input)) {
      return this.snapshot;
    }

    this.probedDomains.add("plugins");
    const now = new Date().toISOString();

    if (input.outcome === "ok") {
      this.timedOutDomains.delete("plugins");
      this.methodTiers["plugins.list"] = "served";
      const rows = projectPluginRows(input.rawPlugins);
      this.pluginsState = {
        probed: true,
        status: rows.length > 0 ? "available" : "empty",
        rows,
        fetchedAt: now,
      };
    } else if (input.outcome === "method_not_found" || input.outcome === "refused") {
      this.timedOutDomains.delete("plugins");
      if (input.outcome === "method_not_found") {
        this.notFoundMethods.add("plugins.list");
        this.methodTiers["plugins.list"] = "unknown";
      } else {
        this.methodTiers["plugins.list"] = "refused";
      }
      this.pluginsState = {
        probed: true,
        status: "unsupported",
        rows: [],
        fetchedAt: now,
        degradation: {
          reason: input.outcome === "refused" ? "refused" : "method_not_found",
          missingMethods: ["plugins.list"],
        },
      };
    } else if (input.outcome === "older") {
      this.timedOutDomains.delete("plugins");
      this.methodTiers["plugins.list"] = "older";
      this.pluginsState = {
        probed: true,
        status: "unknown",
        rows: [],
        fetchedAt: now,
        degradation: { reason: "older" },
      };
    } else {
      this.pluginsState = {
        probed: true,
        status: "error",
        rows: [],
        fetchedAt: now,
        errorCode: sanitizeSafeErrorCode(input.errorCode, "PLUGINS_FETCH_FAILED"),
      };
    }

    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  applySkillsInventory(input: ApplySkillsInventoryInput): CapabilitySnapshot {
    if (!this.isValidEpochAndGeneration(input)) {
      return this.snapshot;
    }

    this.probedDomains.add("skills");
    const prevReloadedAt = this.skillsState.lastReloadedAt;
    const lastReloadedAt = input.reloaded ? new Date().toISOString() : prevReloadedAt;

    if (input.outcome === "ok") {
      this.timedOutDomains.delete("skills");
      if (!this.methodTiers["skills.list"]) {
        this.methodTiers["skills.list"] = "served";
      }
      const items = projectSkillRows(input.rawSkills);
      this.skillsState = {
        probed: true,
        status: items.length > 0 ? "available" : "empty",
        items,
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    } else if (input.outcome === "method_not_found" || input.outcome === "refused") {
      this.timedOutDomains.delete("skills");
      if (input.outcome === "method_not_found") {
        this.notFoundMethods.add("skills.list");
        this.methodTiers["skills.list"] = "unknown";
      } else {
        this.methodTiers["skills.list"] = "refused";
      }
      this.skillsState = {
        probed: true,
        status: "unsupported",
        items: [],
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    } else if (input.outcome === "older") {
      this.skillsState = {
        probed: true,
        status: "unknown",
        items: [],
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    } else {
      this.skillsState = {
        probed: true,
        status: "error",
        items: [],
        errorCode: sanitizeSafeErrorCode(input.errorCode, "SKILLS_FETCH_FAILED"),
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    }

    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  applyToolsInventory(input: ApplyToolsInventoryInput): CapabilitySnapshot {
    if (!this.isValidEpochAndGeneration(input)) {
      return this.snapshot;
    }

    this.probedDomains.add("tools");

    if (input.outcome === "ok") {
      this.timedOutDomains.delete("tools");
      if (!this.methodTiers["tools.show"]) {
        this.methodTiers["tools.show"] = "served";
      }
      const items = projectToolRows(input.rawTools);
      this.toolsState = {
        probed: true,
        status: items.length > 0 ? "available" : "empty",
        items,
      };
    } else if (input.outcome === "method_not_found" || input.outcome === "refused") {
      this.timedOutDomains.delete("tools");
      if (input.outcome === "method_not_found") {
        this.notFoundMethods.add("tools.show");
        this.methodTiers["tools.show"] = "unknown";
      } else {
        this.methodTiers["tools.show"] = "refused";
      }
      this.toolsState = {
        probed: true,
        status: "unsupported",
        items: [],
      };
    } else if (input.outcome === "older") {
      this.toolsState = {
        probed: true,
        status: "unknown",
        items: [],
      };
    } else {
      this.toolsState = {
        probed: true,
        status: "error",
        items: [],
        errorCode: sanitizeSafeErrorCode(input.errorCode, "TOOLS_FETCH_FAILED"),
      };
    }

    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  applyMcpInventory(input: ApplyMcpInventoryInput): CapabilitySnapshot {
    if (!this.isValidEpochAndGeneration(input)) {
      return this.snapshot;
    }

    this.probedDomains.add("mcp");
    const prevReloadedAt = this.mcpState.lastReloadedAt;
    const lastReloadedAt = input.reloaded ? new Date().toISOString() : prevReloadedAt;

    if (input.outcome === "ok") {
      this.timedOutDomains.delete("mcp");
      if (!this.methodTiers["mcp.list"]) {
        this.methodTiers["mcp.list"] = "served";
      }
      const items = projectMcpRows(input.rawServers);
      this.mcpState = {
        probed: true,
        status: items.length > 0 ? "available" : "empty",
        items,
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    } else if (input.outcome === "method_not_found" || input.outcome === "refused") {
      this.timedOutDomains.delete("mcp");
      if (input.outcome === "method_not_found") {
        this.notFoundMethods.add("mcp.list");
        this.methodTiers["mcp.list"] = "unknown";
      } else {
        this.methodTiers["mcp.list"] = "refused";
      }
      this.mcpState = {
        probed: true,
        status: "unsupported",
        items: [],
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    } else if (input.outcome === "older") {
      this.mcpState = {
        probed: true,
        status: "unknown",
        items: [],
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    } else {
      this.mcpState = {
        probed: true,
        status: "error",
        items: [],
        errorCode: sanitizeSafeErrorCode(input.errorCode, "MCP_FETCH_FAILED"),
        ...(lastReloadedAt ? { lastReloadedAt } : {}),
      };
    }

    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  private deriveUnprobedExtensionStatus(method: string): ExtensionInventoryStatus {
    if (!this.connected) return "unknown";
    if (this.notFoundMethods.has(method)) return "unsupported";
    const tier = this.getMethodTier(method);
    if (tier === "refused") return "unsupported";
    if (tier === "older") return "unknown";
    if (tier === "unknown" && this.hasExplicitMethodCatalog) return "unsupported";
    return "unknown";
  }

  private buildExtensionInventoryView(): ExtensionInventoryView {
    const pluginsStatus =
      this.pluginsState.status ?? this.deriveUnprobedExtensionStatus("plugins.list");
    const skillsStatus =
      this.skillsState.status ?? this.deriveUnprobedExtensionStatus("skills.list");
    const toolsStatus =
      this.toolsState.status ?? this.deriveUnprobedExtensionStatus("tools.show");
    const mcpStatus =
      this.mcpState.status ?? this.deriveUnprobedExtensionStatus("mcp.list");

    const skillsReloadSupported =
      this.connected && this.getMethodTier("reload.skills") === "served";
    const mcpReloadSupported =
      this.connected && this.getMethodTier("reload.mcp") === "served";

    const plugins = this.pluginsState.rows;
    const enabledCount = plugins.filter((p) => p.enabled).length;
    const failedCount = plugins.filter((p) => p.loadStatus === "failed").length;

    const skills: SkillsInventoryView = {
      status: skillsStatus,
      items: this.skillsState.items,
      reloadSupported: skillsReloadSupported,
      ...(this.skillsState.lastReloadedAt
        ? { lastReloadedAt: this.skillsState.lastReloadedAt }
        : {}),
      ...(this.skillsState.errorCode ? { errorCode: this.skillsState.errorCode } : {}),
      cliActions: [
        buildCliAction(
          "skills-list-cli",
          getCopy("extensions.copyCliAction"),
          "hermes skills list",
        ),
      ],
      docsUrl: OFFICIAL_SKILLS_DOCS_URL,
    };

    const tools: ToolsInventoryView = {
      status: toolsStatus,
      items: this.toolsState.items,
      ...(this.toolsState.errorCode ? { errorCode: this.toolsState.errorCode } : {}),
      cliActions: [
        buildCliAction(
          "tools-list-cli",
          getCopy("extensions.copyCliAction"),
          "hermes tools list",
        ),
      ],
      docsUrl: OFFICIAL_TOOLS_DOCS_URL,
    };

    const mcp: McpInventoryView = {
      status: mcpStatus,
      items: this.mcpState.items,
      reloadSupported: mcpReloadSupported,
      ...(this.mcpState.lastReloadedAt
        ? { lastReloadedAt: this.mcpState.lastReloadedAt }
        : {}),
      ...(this.mcpState.errorCode ? { errorCode: this.mcpState.errorCode } : {}),
      cliActions: [
        buildCliAction(
          "mcp-list-cli",
          getCopy("extensions.copyCliAction"),
          "hermes mcp list",
        ),
      ],
      docsUrl: OFFICIAL_MCP_DOCS_URL,
    };

    return {
      status: pluginsStatus,
      scope: {
        connectionId: this.key.connectionId,
        profileId: this.key.profileId,
        ...(this.connected ? { gatewayVersion: this.key.gatewayVersionOrSha } : {}),
        perPluginProfile: false,
      },
      sourceKind: "gateway_reported",
      sourceLabel: "Gateway 报告",
      plugins,
      counts: {
        reported: plugins.length,
        enabled: enabledCount,
        failed: failedCount,
      },
      pluginRpcAdvertised: this.pluginRpcAdvertised,
      ...(this.gatewayToolsets ? { gatewayToolsets: [...this.gatewayToolsets] } : {}),
      ...(this.portableMcpServers
        ? { portableMcpServers: [...this.portableMcpServers] }
        : {}),
      fetchedAt: this.pluginsState.fetchedAt,
      generation: this.generation,
      ...(this.pluginsState.errorCode ? { errorCode: this.pluginsState.errorCode } : {}),
      ...(this.pluginsState.degradation
        ? { degradation: this.pluginsState.degradation }
        : {}),
      cliActions: [
        buildCliAction(
          "plugins-list-cli",
          getCopy("extensions.copyCliAction"),
          "hermes plugins list",
        ),
      ],
      docsUrl: OFFICIAL_PLUGINS_DOCS_URL,
      skills,
      tools,
      mcp,
    };
  }

  private evaluateMethods(
    requiredMethods: string[],
    options: {
      domain: CapabilityDomainId;
      classification: CapabilityClassification;
      localOnly?: boolean;
      localFallbackDegraded?: boolean;
    },
  ): {
    runtimeStatus: CapabilityRuntimeStatus;
    source: CapabilitySource;
    aliasUsed?: string;
    degradation?: CapabilityDegradation;
  } {
    if (options.classification === "deferred") {
      return {
        runtimeStatus: "unavailable",
        source: "deferred",
      };
    }

    if (options.classification === "deep_link" || options.localOnly) {
      return {
        runtimeStatus: options.classification === "deep_link" ? "deep_link" : "available",
        source: options.classification === "deep_link" ? "deep_link" : "static_local",
      };
    }

    if (!this.connected) {
      if (options.localFallbackDegraded) {
        return {
          runtimeStatus: "degraded",
          source: "fallback",
          degradation: { reason: "unconnected", detail: "仅本地 PTY 可用" },
        };
      }
      return {
        runtimeStatus: "unavailable",
        source: "static_local",
        degradation: { reason: "unconnected" },
      };
    }

    // Legacy owner check for server-request-dependent approval domain
    if (options.domain === "approval" && !this.serverRequestsSupported) {
      return {
        runtimeStatus: "unavailable",
        source: "client_capabilities",
        degradation: {
          reason: "missing_server_requests",
          missingMethods: ["client.capabilities:server_requests"],
        },
      };
    }

    if (this.timedOutDomains.has(options.domain)) {
      return {
        runtimeStatus: "unknown",
        source: "probe",
        degradation: { reason: "timeout" },
      };
    }

    if (requiredMethods.length === 0) {
      return {
        runtimeStatus: "available",
        source: this.probedDomains.has(options.domain) ? "probe" : "static_local",
      };
    }

    let hasOlder = false;
    let aliasUsed: string | undefined;
    const missing: string[] = [];
    let refusedHit = false;
    let notFoundHit = false;

    for (const req of requiredMethods) {
      const forward = resolveExplicitMethodAlias(req);
      const reverse = EXPLICIT_REVERSE_ALIASES[req];
      if (
        this.notFoundMethods.has(req) ||
        (forward !== null && this.notFoundMethods.has(forward)) ||
        (reverse !== undefined && this.notFoundMethods.has(reverse))
      ) {
        notFoundHit = true;
        missing.push(req);
        continue;
      }
      const resolved = resolveMethodWithAlias(req, this.methodTiers);
      if (resolved.aliasUsed) {
        aliasUsed = resolved.aliasUsed;
      }
      if (this.notFoundMethods.has(resolved.method)) {
        notFoundHit = true;
        missing.push(req);
        continue;
      }
      if (resolved.tier === "refused") {
        refusedHit = true;
        missing.push(req);
        continue;
      }
      if (resolved.tier === "older") {
        hasOlder = true;
        continue;
      }
      if (resolved.tier === "unknown") {
        missing.push(req);
      }
    }

    if (refusedHit) {
      return {
        runtimeStatus: "unavailable",
        source: "runtime_describe",
        aliasUsed,
        degradation: { reason: "refused", missingMethods: missing },
      };
    }

    if (missing.length > 0) {
      if (options.localFallbackDegraded) {
        return {
          runtimeStatus: "degraded",
          source: "fallback",
          aliasUsed,
          degradation: {
            reason: notFoundHit ? "method_not_found" : "unconnected",
            missingMethods: missing,
          },
        };
      }
      return {
        runtimeStatus: "unavailable",
        source: notFoundHit ? "probe" : "runtime_describe",
        aliasUsed,
        degradation: {
          reason: notFoundHit ? "method_not_found" : "unconnected",
          missingMethods: missing,
        },
      };
    }

    if (hasOlder) {
      return {
        runtimeStatus: "degraded",
        source: this.probedDomains.has(options.domain) ? "probe" : "runtime_describe",
        aliasUsed,
        degradation: { reason: "older" },
      };
    }

    if (options.classification === "read_only") {
      return {
        runtimeStatus: "read_only",
        source: aliasUsed ? "alias" : this.probedDomains.has(options.domain) ? "probe" : "runtime_describe",
        aliasUsed,
      };
    }

    return {
      runtimeStatus: "available",
      source: aliasUsed ? "alias" : this.probedDomains.has(options.domain) ? "probe" : "runtime_describe",
      aliasUsed,
    };
  }

  private buildSnapshot(): CapabilitySnapshot {
    const builtinAttribution = resolveExternalAttribution({ source: "bundled" });
    const domains: CapabilityDomainSummary[] = CAPABILITY_DOMAIN_CATALOG.map((meta) => {
      const evaluated = this.evaluateMethods(meta.requiredMethods, {
        domain: meta.domain,
        classification: meta.classification,
        localOnly:
          meta.requiredMethods.length === 0 &&
          meta.classification === "native" &&
          !this.timedOutDomains.has(meta.domain),
        localFallbackDegraded: meta.domain === "terminal",
      });

      // Non-core remote domains that have not yet been probed on this connection stay unknown
      // unless explicitly refused or already determined from runtime.describe
      let runtimeStatus = evaluated.runtimeStatus;
      if (
        this.connected &&
        meta.group !== "core" &&
        meta.classification !== "deep_link" &&
        meta.classification !== "deferred" &&
        !this.probedDomains.has(meta.domain) &&
        evaluated.degradation?.reason !== "refused" &&
        runtimeStatus === "unavailable"
      ) {
        runtimeStatus = "unknown";
      }

      return {
        domain: meta.domain,
        group: meta.group,
        classification: meta.classification,
        runtimeStatus,
        labelKey: meta.labelKey,
        probed: this.probedDomains.has(meta.domain),
        ...(meta.probeMethod ? { probeMethod: meta.probeMethod } : {}),
        ...(evaluated.degradation ? { degradation: evaluated.degradation } : {}),
        ...(meta.deepLink ? { deepLink: meta.deepLink } : {}),
        attribution: builtinAttribution,
      };
    });

    const entries: CapabilityEntry[] = [];
    for (const tpl of ACTION_TEMPLATES) {
      const evaluated = this.evaluateMethods(tpl.requiredMethods, {
        domain: tpl.domain,
        classification: tpl.classification,
        localOnly: tpl.localOnly,
        localFallbackDegraded: tpl.localFallbackDegraded,
      });

      // Never render refused methods as executable entries
      if (evaluated.degradation?.reason === "refused") {
        continue;
      }

      entries.push({
        domain: tpl.domain,
        group: tpl.group,
        actionId: tpl.actionId,
        labelKey: tpl.labelKey,
        ...(tpl.hintKey ? { hintKey: tpl.hintKey } : {}),
        ...(tpl.shortcut ? { shortcut: tpl.shortcut } : {}),
        classification: tpl.classification,
        runtimeStatus: evaluated.runtimeStatus,
        source: evaluated.source,
        requiredMethods: [...tpl.requiredMethods],
        handlerId: tpl.handlerId,
        evidenceTestId: tpl.evidenceTestId,
        generation: this.generation,
        ...(evaluated.aliasUsed ? { aliasUsed: evaluated.aliasUsed } : {}),
        ...(tpl.deepLink ? { deepLink: tpl.deepLink } : {}),
        ...(evaluated.degradation ? { degradation: evaluated.degradation } : {}),
        attribution: builtinAttribution,
      });
    }

    return {
      key: { ...this.key },
      generation: this.generation,
      capabilitiesReady: this.connected,
      serverRequestsSupported: this.serverRequestsSupported,
      legacyOwner: this.legacyOwner,
      ...(this.sessionCreateSpec ? { sessionCreateSpec: this.sessionCreateSpec } : {}),
      counts: {
        total: 21,
        native: 13,
        readOnly: 3,
        deepLink: 1,
        reachable: 17,
        deferred: 4,
      },
      domains,
      entries,
      methodTiers: { ...this.methodTiers },
      extensions: this.buildExtensionInventoryView(),
      ...(this.invalidatedReason ? { invalidatedReason: this.invalidatedReason } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
}

export function auditCapabilityIntegrity(
  snapshot: CapabilitySnapshot,
  registeredHandlerIds: ReadonlySet<string>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const deferredIds = new Set(["voice", "bots", "memory_graph", "kanban"]);

  for (const entry of snapshot.entries) {
    if (entry.classification === "deferred" || deferredIds.has(entry.domain)) {
      errors.push(`Forbidden deferred entry rendered/exported: ${entry.domain}/${entry.actionId}`);
    }
    if (!entry.domain || !entry.actionId || !entry.labelKey || !entry.classification || !entry.runtimeStatus || !entry.source) {
      errors.push(`Incomplete CapabilityEntry metadata for ${entry.actionId || "<unknown>"}`);
    }
    if (!entry.handlerId || !registeredHandlerIds.has(entry.handlerId)) {
      errors.push(`Detected orphan action without registered handler: ${entry.actionId} -> ${entry.handlerId}`);
    }
    if (!entry.evidenceTestId) {
      errors.push(`Missing evidenceTestId on CapabilityEntry: ${entry.actionId}`);
    }
    if (entry.degradation?.reason === "refused") {
      errors.push(`Refused capability entry must never be rendered: ${entry.actionId}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
