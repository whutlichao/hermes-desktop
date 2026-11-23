import type {
  CapabilityClassification,
  CapabilityDeepLink,
  CapabilityDegradation,
  CapabilityDomainId,
  CapabilityDomainSummary,
  CapabilityEntry,
  CapabilityGroup,
  CapabilityMethodTier,
  CapabilityRuntimeStatus,
  CapabilitySnapshot,
  CapabilitySource,
} from "@hermes/contracts";
import type { CopyKey } from "./copy";

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
});

const EXPLICIT_REVERSE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "session.list": "sessions.list",
  "session.steer": "prompt.steer",
  "session.info": "session.status",
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
    handlerId: "capabilities.probeDomain",
    evidenceTestId: "cap-action-checkpoint-list",
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
];

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function parseDescribeMethodTiers(
  describeResult: Record<string, unknown> | null | undefined,
): {
  methodTiers: Record<string, CapabilityMethodTier>;
  sessionCreateSpec?: { sources: string[]; parameters: string[] };
  versionOrSha?: string;
} {
  const methodTiers: Record<string, CapabilityMethodTier> = {};
  if (!describeResult || typeof describeResult !== "object") {
    return { methodTiers };
  }

  for (const m of asStringArray(describeResult.served_methods)) {
    methodTiers[m] = "served";
  }
  for (const m of asStringArray(describeResult.older_methods)) {
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
  for (const m of asStringArray(describeResult.refused_methods)) {
    methodTiers[m] = "refused";
  }

  // Fallback when runtime.describe uses capabilities map or capability tags without served_methods
  if (Object.keys(methodTiers).length === 0) {
    const caps = describeResult.capabilities;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      const capMap = caps as Record<string, unknown>;
      for (const [k, v] of Object.entries(capMap)) {
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

  const versionOrSha =
    typeof describeResult.code_sha === "string"
      ? describeResult.code_sha
      : typeof describeResult.gateway_version === "string"
        ? describeResult.gateway_version
        : typeof describeResult.version === "string"
          ? describeResult.version
          : undefined;

  return { methodTiers, sessionCreateSpec, versionOrSha };
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

  getSnapshot(): CapabilitySnapshot {
    return this.snapshot;
  }

  getMethodTier(method: string): CapabilityMethodTier {
    if (this.notFoundMethods.has(method)) return "unknown";
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
    this.notFoundMethods.clear();
    this.probedDomains.clear();
    this.timedOutDomains.clear();
    this.invalidatedReason = undefined;
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
    this.notFoundMethods.clear();
    this.probedDomains.clear();
    this.timedOutDomains.clear();
    this.invalidatedReason = input.reason;

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
      if (this.notFoundMethods.has(req)) {
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
