import {
  REFUSED_GATEWAY_METHODS,
  SETTINGS_SECTION_IDS,
  type CapabilityMethodTier,
  type CapabilityRuntimeStatus,
  type CapabilitySnapshot,
  type GatewayConfigSnapshot,
  type GatewayConfigValue,
  type SessionCliDeepLink,
  type SettingsSectionId,
  type SupportedGatewayConfigKey,
} from "@hermes/contracts";
import type { CopyKey } from "./copy";
import type { OverlaySurface } from "./shell";

const REFUSED_SET: ReadonlySet<string> = new Set<string>(REFUSED_GATEWAY_METHODS);

const FORBIDDEN_CONFIG_KEY_PREFIXES = [
  "voice.",
  "cloud.",
  "account.",
  "billing.",
  "bots.",
  "kanban.",
  "memory_graph.",
] as const;

export function isRefusedGatewayMethod(
  method: string,
  methodTiers?: Record<string, CapabilityMethodTier>,
): boolean {
  if (REFUSED_SET.has(method)) {
    return true;
  }
  if (methodTiers && methodTiers[method] === "refused") {
    return true;
  }
  return false;
}

export function filterRenderableSessionCapabilities(
  methods: readonly string[],
  methodTiers?: Record<string, CapabilityMethodTier>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const method of methods) {
    const trimmed = method.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (isRefusedGatewayMethod(trimmed, methodTiers)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sanitizeCliToken(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "");
  return cleaned || fallback;
}

function sanitizeCliTitle(raw: string | undefined): string {
  const base = (raw ?? "New Title").replace(/["`$\\]/g, "").trim();
  return base || "New Title";
}

export function buildSessionCliDeepLinks(input: {
  sessionId: string;
  profileId?: string | null;
  title?: string;
}): SessionCliDeepLink[] {
  const safeSessionId = sanitizeCliToken(input.sessionId, "session_id");
  const safeProfileId = input.profileId ? sanitizeCliToken(input.profileId, "default") : "default";
  const profileFlag = safeProfileId !== "default" ? `--profile ${safeProfileId} ` : "";
  const safeTitle = sanitizeCliTitle(input.title);
  const executionNoteKey: CopyKey = "session.cli.neverExecutedNotice";

  return [
    {
      actionId: "rename",
      labelKey: "session.cli.action.rename",
      command: `hermes session rename ${profileFlag}${safeSessionId} "${safeTitle}"`,
      executionNoteKey,
    },
    {
      actionId: "delete",
      labelKey: "session.cli.action.delete",
      command: `hermes session delete ${profileFlag}${safeSessionId}`,
      executionNoteKey,
    },
    {
      actionId: "branch",
      labelKey: "session.cli.action.branch",
      command: `hermes session branch ${profileFlag}${safeSessionId}`,
      executionNoteKey,
    },
    {
      actionId: "archive",
      labelKey: "session.cli.action.archive",
      command: `hermes session archive ${profileFlag}${safeSessionId}`,
      executionNoteKey,
    },
    {
      actionId: "compress",
      labelKey: "session.cli.action.compress",
      command: `hermes session compress ${profileFlag}${safeSessionId}`,
      executionNoteKey,
    },
    {
      actionId: "undo",
      labelKey: "session.cli.action.undo",
      command: `hermes session undo ${profileFlag}${safeSessionId}`,
      executionNoteKey,
    },
  ];
}

export interface ProfileManagementAvailability {
  canManageNatively: boolean;
  runtimeStatus: CapabilityRuntimeStatus;
  cliCommand: string;
  docsUrl: string;
  noteKey: CopyKey;
}

export function resolveProfileManagementAvailability(
  snapshot: CapabilitySnapshot,
): ProfileManagementAvailability {
  const profileDomain = snapshot.domains.find((d) => d.domain === "profile");
  const runtimeStatus: CapabilityRuntimeStatus = profileDomain?.runtimeStatus ?? "unknown";
  const canManageNatively = Boolean(
    snapshot.capabilitiesReady &&
      profileDomain &&
      profileDomain.probed &&
      (profileDomain.runtimeStatus === "available" ||
        profileDomain.runtimeStatus === "read_only" ||
        profileDomain.runtimeStatus === "degraded") &&
      profileDomain.degradation?.reason !== "refused" &&
      profileDomain.degradation?.reason !== "method_not_found",
  );

  return {
    canManageNatively,
    runtimeStatus,
    cliCommand: "hermes profile list",
    docsUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/profiles",
    noteKey: "scope.profileDeepLinkNote",
  };
}

export interface SettingsFieldSpec {
  key: SupportedGatewayConfigKey;
  section: Extract<SettingsSectionId, "model" | "workspace" | "safety" | "memory" | "chat">;
  labelKey: CopyKey;
  kind: "select" | "boolean";
  options?: readonly string[];
  defaultValue: GatewayConfigValue;
}

export interface ProjectedSettingsField extends SettingsFieldSpec {
  value: GatewayConfigValue;
  readOnly: boolean;
}

export const SETTINGS_FIELD_CATALOG: readonly SettingsFieldSpec[] = [
  {
    key: "model.default",
    section: "model",
    labelKey: "settings.field.model.default",
    kind: "select",
    options: ["claude-3-7-sonnet", "gpt-4.1", "gemini-2.5-pro"],
    defaultValue: "claude-3-7-sonnet",
  },
  {
    key: "model.reasoning_effort",
    section: "model",
    labelKey: "settings.field.model.reasoning_effort",
    kind: "select",
    options: ["low", "medium", "high"],
    defaultValue: "medium",
  },
  {
    key: "workspace.default_tab",
    section: "workspace",
    labelKey: "settings.field.workspace.default_tab",
    kind: "select",
    options: ["artifacts", "files", "terminal", "agents"],
    defaultValue: "artifacts",
  },
  {
    key: "workspace.auto_open_artifacts",
    section: "workspace",
    labelKey: "settings.field.workspace.auto_open_artifacts",
    kind: "boolean",
    defaultValue: false,
  },
  {
    key: "safety.approval_policy",
    section: "safety",
    labelKey: "settings.field.safety.approval_policy",
    kind: "select",
    options: ["prompt", "strict", "read_only"],
    defaultValue: "prompt",
  },
  {
    key: "safety.redact_diagnostics",
    section: "safety",
    labelKey: "settings.field.safety.redact_diagnostics",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "memory.context_window",
    section: "memory",
    labelKey: "settings.field.memory.context_window",
    kind: "select",
    options: ["64k", "128k", "200k"],
    defaultValue: "128k",
  },
  {
    key: "memory.auto_summarize",
    section: "memory",
    labelKey: "settings.field.memory.auto_summarize",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "chat.send_on_enter",
    section: "chat",
    labelKey: "settings.field.chat.send_on_enter",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "chat.stream_tokens",
    section: "chat",
    labelKey: "settings.field.chat.stream_tokens",
    kind: "boolean",
    defaultValue: true,
  },
];

export function isAllowedGatewayConfigKey(key: string): key is SupportedGatewayConfigKey {
  if (FORBIDDEN_CONFIG_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return false;
  }
  return SETTINGS_FIELD_CATALOG.some((spec) => spec.key === key);
}

export function projectSettingsSectionFields(
  section: SettingsSectionId,
  snapshot: GatewayConfigSnapshot | null | undefined,
): ProjectedSettingsField[] {
  if (!snapshot || !snapshot.supported) {
    return [];
  }
  if (!SETTINGS_SECTION_IDS.includes(section)) {
    return [];
  }
  const supportedSet = new Set(
    snapshot.supportedKeys.filter((k) => isAllowedGatewayConfigKey(k)),
  );
  return SETTINGS_FIELD_CATALOG.filter(
    (spec) => spec.section === section && supportedSet.has(spec.key),
  ).map((spec) => ({
    ...spec,
    value: Object.hasOwn(snapshot.values, spec.key)
      ? snapshot.values[spec.key]
      : spec.defaultValue,
    readOnly: snapshot.readOnly,
  }));
}

export interface FocusRegistrationEntry {
  surfaceId: OverlaySurface;
  triggerId: string | null;
  fallbackOrder: string[];
}

const DEFAULT_FALLBACK_ORDER = ["composer-input", "rail-new-session"] as const;

export class SurfaceFocusReturnStack {
  private stack: FocusRegistrationEntry[] = [];

  register(
    surfaceId: OverlaySurface,
    options: { triggerId?: string | null; fallbackOrder?: string[] } = {},
  ): void {
    this.stack = this.stack.filter((item) => item.surfaceId !== surfaceId);
    this.stack.push({
      surfaceId,
      triggerId: options.triggerId ?? null,
      fallbackOrder: options.fallbackOrder ?? [...DEFAULT_FALLBACK_ORDER],
    });
  }

  resolveReturn(
    surfaceId: OverlaySurface,
    isTargetFocusable: (id: string) => boolean = () => true,
  ): string | null {
    const entry = [...this.stack].reverse().find((item) => item.surfaceId === surfaceId);
    if (!entry) return null;
    if (entry.triggerId && isTargetFocusable(entry.triggerId)) {
      return entry.triggerId;
    }
    for (const candidate of entry.fallbackOrder) {
      if (isTargetFocusable(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  closeTopmost(
    _reason: "escape" | "close_button" | "backdrop" | "programmatic" = "escape",
    isTargetFocusable: (id: string) => boolean = () => true,
  ): { closedSurface: OverlaySurface | null; returnTargetId: string | null } {
    if (this.stack.length === 0) {
      return { closedSurface: null, returnTargetId: null };
    }
    const top = this.stack[this.stack.length - 1];
    const returnTargetId = this.resolveReturn(top.surfaceId, isTargetFocusable);
    this.stack.pop();
    return {
      closedSurface: top.surfaceId,
      returnTargetId,
    };
  }

  closeSurface(
    surfaceId: OverlaySurface,
    isTargetFocusable: (id: string) => boolean = () => true,
  ): { closedSurface: OverlaySurface | null; returnTargetId: string | null } {
    const exists = this.stack.some((item) => item.surfaceId === surfaceId);
    if (!exists) {
      return { closedSurface: null, returnTargetId: null };
    }
    const returnTargetId = this.resolveReturn(surfaceId, isTargetFocusable);
    this.stack = this.stack.filter((item) => item.surfaceId !== surfaceId);
    return {
      closedSurface: surfaceId,
      returnTargetId,
    };
  }

  clearOnWindowClose(): void {
    this.stack = [];
  }

  getStack(): readonly FocusRegistrationEntry[] {
    return this.stack;
  }
}
