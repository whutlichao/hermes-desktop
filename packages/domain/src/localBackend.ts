import type {
  ConnectionActualState,
  LocalCliSourceKind,
  LocalCliSummary,
  LocalFailureCode,
  LocalInspectionPhase,
  LocalSafeActionId,
  LocalTypedFailure,
  SanitizedDiagnosticsPayload,
} from "@hermes/contracts";
import { redactSensitiveData, redactString } from "./hostBridge";

export const LOGIN_SHELL_TIMEOUT_MS = 5000 as const;
export const PATH_SENTINEL_BEGIN = "__HERMES_PATH_BEGIN__" as const;
export const PATH_SENTINEL_END = "__HERMES_PATH_END__" as const;

export const HERMES_INSTALL_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/desktop" as const;
export const HERMES_UPDATE_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/desktop" as const;

export interface LocalFailureCopy {
  whatHappened: string;
  possibleCauses: string;
  nextStep: string;
}

interface FailureCatalogSpec {
  actual: ConnectionActualState;
  retryable: boolean;
  autoRetry: boolean;
  actions: LocalSafeActionId[];
  copy: LocalFailureCopy;
}

const LOCAL_FAILURE_CATALOG: Record<LocalFailureCode, FailureCatalogSpec> = {
  hermes_not_found: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["choose_cli", "open_install_docs", "retry"],
    copy: {
      whatHappened: "未在本机定位到可用的 hermes CLI。",
      possibleCauses: "可能尚未安装 hermes，或安装位置不在登录 shell PATH 与常见目录中。",
      nextStep: "请手动选择 hermes CLI、按安装文档完成安装后重新检测，或改连 Remote / SSH。",
    },
  },
  cli_not_executable: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["choose_cli", "open_diagnostics", "retry"],
    copy: {
      whatHappened: "已定位到 hermes CLI，但当前文件不具备可执行权限。",
      possibleCauses: "文件权限未设置可执行位，或选择了非可执行脚本与符号链接。",
      nextStep: "请重新选择有效的 hermes 可执行文件，或导出脱敏诊断信息后重试。",
    },
  },
  cli_unsupported: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["choose_cli", "open_update_docs", "retry"],
    copy: {
      whatHappened: "当前 hermes CLI 缺少桌面端所需的 Gateway 接入能力。",
      possibleCauses: "本机安装的 hermes CLI 版本过旧，不支持 ensure --json 或 attach --json 命令。",
      nextStep: "请查看升级文档更新 hermes CLI，或选择新版 hermes CLI 后重新检测。",
    },
  },
  protocol_unsupported: {
    actual: "blocked",
    retryable: false,
    autoRetry: false,
    actions: ["choose_cli", "open_update_docs", "open_diagnostics"],
    copy: {
      whatHappened: "本机 hermes CLI 与当前客户端的 Gateway 协议版本不兼容。",
      possibleCauses: "本地 runtime 协议版本不是 v1，或缺少权威会话控制能力声明。",
      nextStep: "请参考升级文档更新 hermes CLI，或选择兼容版本并导出脱敏诊断信息。",
    },
  },
  code_sha_mismatch: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["restart_gateway", "open_diagnostics"],
    copy: {
      whatHappened: "运行中的本地 Gateway 与当前 hermes CLI 代码版本不一致。",
      possibleCauses: "你在更新 hermes 后，后台仍保留着旧版本代码启动的 Gateway 进程。",
      nextStep: "请重启本地 Gateway 以对齐版本，如仍不一致请导出脱敏诊断信息。",
    },
  },
  gateway_start_failed: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["retry", "open_status", "open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 启动失败，未能进入就绪状态。",
      possibleCauses: "本地运行环境异常、端口冲突或后台监督进程退出。",
      nextStep: "请查看运行状态或导出脱敏诊断信息，并在确认环境后重新检测。",
    },
  },
  gateway_starting_timeout: {
    actual: "reconnecting",
    retryable: true,
    autoRetry: true,
    actions: ["retry", "open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 正在启动中，但超过预期等待时间尚未就绪。",
      possibleCauses: "首次初始化耗时较长或后台服务启动缓慢。",
      nextStep: "系统将等待就绪；你也可以立即重新检测或导出脱敏诊断信息。",
    },
  },
  runtime_exited: {
    actual: "reconnecting",
    retryable: true,
    autoRetry: true,
    actions: ["retry", "open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 运行时已退出。",
      possibleCauses: "后台进程收到退出信号或运行中途异常终止。",
      nextStep: "请重新检测本地后端状态，必要时导出脱敏诊断信息。",
    },
  },
  owner_lost: {
    actual: "reconnecting",
    retryable: true,
    autoRetry: true,
    actions: ["retry", "open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 控制进程已失联。",
      possibleCauses: "原运行实例已关闭或正在重启切换。",
      nextStep: "请重新检测连接状态，或导出脱敏诊断信息查看详情。",
    },
  },
  ticket_unavailable: {
    actual: "reconnecting",
    retryable: true,
    autoRetry: true,
    actions: ["retry", "open_diagnostics"],
    copy: {
      whatHappened: "未能获取本地 Gateway 的一次性连接凭据。",
      possibleCauses: "本地控制通道忙碌或正在切换运行实例。",
      nextStep: "请稍后重新检测，或导出脱敏诊断信息排查原因。",
    },
  },
  control_timeout: {
    actual: "reconnecting",
    retryable: true,
    autoRetry: true,
    actions: ["retry", "open_diagnostics"],
    copy: {
      whatHappened: "本地控制通道响应超时。",
      possibleCauses: "本地 Gateway 正忙或系统资源暂时紧张。",
      nextStep: "请重新检测本地连接，或导出脱敏诊断信息。",
    },
  },
  socket_permission_denied: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["open_diagnostics", "retry"],
    copy: {
      whatHappened: "无法访问本地 Gateway 控制 socket，权限校验未通过。",
      possibleCauses: "控制 socket 的所有者或文件权限与当前桌面用户不匹配。",
      nextStep: "请导出脱敏诊断信息核对状态，修复本机权限后重新检测。",
    },
  },
  service_unhealthy: {
    actual: "blocked",
    retryable: false,
    autoRetry: false,
    actions: ["open_status", "open_diagnostics"],
    copy: {
      whatHappened: "本机已安装的 Hermes 系统服务处于不健康状态。",
      possibleCauses: "系统后台服务启动异常或处于失败停止状态，客户端不会强行重装服务。",
      nextStep: "请查看运行状态或导出脱敏诊断信息，并在终端确认系统服务健康。",
    },
  },
  profile_unavailable: {
    actual: "blocked",
    retryable: false,
    autoRetry: false,
    actions: ["switch_profile", "open_diagnostics"],
    copy: {
      whatHappened: "当前选择的本地 Profile 不可用或未被本地 Gateway 托管。",
      possibleCauses: "该 Profile 已被停用、配置不匹配或尚未加载。",
      nextStep: "请切换到其他可用 Profile，或导出脱敏诊断信息。",
    },
  },
  gateway_other_session: {
    actual: "blocked",
    retryable: false,
    autoRetry: false,
    actions: ["open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 当前运行在其他桌面会话中，无法直接接入。",
      possibleCauses: "目标进程属于其他登录会话，当前用户会话没有接入权限。",
      nextStep: "请在当前用户桌面启动本地 Hermes，或导出脱敏诊断信息。",
    },
  },
  gateway_elevated: {
    actual: "blocked",
    retryable: false,
    autoRetry: false,
    actions: ["open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 正在以提权身份运行，当前客户端已阻止接入。",
      possibleCauses: "后台进程以管理员权限启动，与当前普通用户权限不兼容。",
      nextStep: "请改用普通用户权限运行本地 Gateway，或导出脱敏诊断信息。",
    },
  },
  authorization: {
    actual: "blocked",
    retryable: false,
    autoRetry: false,
    actions: ["open_diagnostics"],
    copy: {
      whatHappened: "本地 Gateway 拒绝了当前客户端的接入授权。",
      possibleCauses: "本地控制面认证校验失败或上下文不匹配。",
      nextStep: "请导出脱敏诊断信息并检查本地 Hermes 登录与运行状态。",
    },
  },
  update_paused: {
    actual: "reconnecting",
    retryable: true,
    autoRetry: true,
    actions: ["retry", "open_status"],
    copy: {
      whatHappened: "本地 Gateway 因正在升级而暂停接受新连接。",
      possibleCauses: "后台正在执行版本更新与重启。",
      nextStep: "请稍候并重新检测，或查看当前运行状态。",
    },
  },
  invalid_control_state: {
    actual: "blocked",
    retryable: true,
    autoRetry: false,
    actions: ["open_diagnostics", "retry"],
    copy: {
      whatHappened: "本地控制通道返回了无法识别的状态数据。",
      possibleCauses: "控制 socket 状态文件损坏或当前实例版本异常。",
      nextStep: "请导出脱敏诊断信息，并确认本地 Gateway 状态后重新检测。",
    },
  },
};

export function extractPathFromShellOutput(stdout: string): string | null {
  const clean = stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const beginIndex = clean.lastIndexOf(PATH_SENTINEL_BEGIN);
  if (beginIndex === -1) return null;
  const afterBegin = clean.slice(beginIndex + PATH_SENTINEL_BEGIN.length);
  const endIndex = afterBegin.indexOf(PATH_SENTINEL_END);
  if (endIndex === -1) return null;
  const extracted = afterBegin.slice(0, endIndex).trim();
  if (!extracted) return null;
  return extracted;
}

export interface CliProbeInput {
  versionOutput: string;
  gatewayHelpOutput: string;
  ensureHelpOutput?: string;
  attachHelpOutput?: string;
  ticketsProbeJson?: string;
}

export type CliProbeClassification =
  | {
      kind: "ready";
      version?: string;
      supportsEnsureJson: boolean;
      supportsAttachJson: boolean;
      supportsTicketsProbe: boolean;
    }
  | {
      kind: "failure";
      code: Extract<LocalFailureCode, "cli_unsupported" | "protocol_unsupported">;
      phase: LocalInspectionPhase;
      version?: string;
    };

function extractSanitizedVersion(versionOutput: string): string | undefined {
  const match = versionOutput.match(/\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/);
  return match ? match[0] : undefined;
}

export function classifyCliProbeOutput(input: CliProbeInput): CliProbeClassification {
  const version = extractSanitizedVersion(input.versionOutput);
  const gatewayHelp = input.gatewayHelpOutput;
  const hasEnsureVerb = /\bensure\b/.test(gatewayHelp);
  const hasAttachVerb = /\battach\b/.test(gatewayHelp);
  const hasTicketsVerb = /\btickets\b/.test(gatewayHelp);

  const ensureHelp = input.ensureHelpOutput ?? "";
  const attachHelp = input.attachHelpOutput ?? "";

  const supportsEnsureJson = hasEnsureVerb && ensureHelp.includes("--json");
  const supportsAttachJson = hasAttachVerb && attachHelp.includes("--json");
  const supportsLegacyRecover = hasAttachVerb && attachHelp.includes("--recover") && attachHelp.includes("--json");
  const supportsTicketsProbe = hasTicketsVerb;

  if (!supportsEnsureJson && !supportsAttachJson && !supportsLegacyRecover) {
    return {
      kind: "failure",
      code: "cli_unsupported",
      phase: "probe_capabilities",
      version,
    };
  }

  if (input.ticketsProbeJson !== undefined && input.ticketsProbeJson.trim() !== "") {
    try {
      const parsed = JSON.parse(input.ticketsProbeJson) as {
        protocol?: unknown;
        capabilities?: unknown;
      };
      if (parsed.protocol !== 1) {
        return {
          kind: "failure",
          code: "protocol_unsupported",
          phase: "probe_capabilities",
          version,
        };
      }
      if (
        Array.isArray(parsed.capabilities) &&
        !parsed.capabilities.includes("session-authority-v1")
      ) {
        return {
          kind: "failure",
          code: "protocol_unsupported",
          phase: "probe_capabilities",
          version,
        };
      }
    } catch {
      return {
        kind: "failure",
        code: "protocol_unsupported",
        phase: "probe_capabilities",
        version,
      };
    }
  }

  return {
    kind: "ready",
    version,
    supportsEnsureJson,
    supportsAttachJson,
    supportsTicketsProbe,
  };
}

const SOURCE_LABELS: Record<LocalCliSourceKind, string> = {
  override: "手动选择",
  login_shell_ilc: "登录 Shell",
  login_shell_lc: "Shell PATH",
  common_dir: "默认安装位置",
  none: "未定位",
};

function sanitizeBinaryDisplayName(rawName: string | undefined): string {
  if (!rawName) return "hermes";
  const segments = rawName.split(/[\\/]/).filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : "hermes";
  return base.replace(/[^\w.-]/g, "") || "hermes";
}

export function formatDisplaySafeCliSummary(input: {
  status: LocalCliSummary["status"];
  sourceKind: LocalCliSourceKind;
  binaryName?: string;
  version?: string;
  hasOverride: boolean;
  supportsEnsureJson: boolean;
  supportsAttachJson: boolean;
  supportsTicketsProbe: boolean;
}): LocalCliSummary {
  const safeBase = sanitizeBinaryDisplayName(input.binaryName);
  const displayName =
    input.status === "missing"
      ? "未检测到 hermes CLI"
      : `${safeBase} (${SOURCE_LABELS[input.sourceKind]})`;

  return {
    status: input.status,
    displayName,
    sourceKind: input.sourceKind,
    version: input.version,
    hasOverride: input.hasOverride,
    supportsEnsureJson: input.supportsEnsureJson,
    supportsAttachJson: input.supportsAttachJson,
    supportsTicketsProbe: input.supportsTicketsProbe,
  };
}

export function mapLocalFailure(
  code: LocalFailureCode,
  phase: LocalInspectionPhase,
  extras?: {
    profileId?: string;
    restartAttempts?: { current: number; max: number };
    reasonCode?: string;
  },
): LocalTypedFailure {
  const spec = LOCAL_FAILURE_CATALOG[code];
  const actual = spec.actual;
  // Invariant: blocked failures must NEVER auto-retry
  const autoRetry = actual === "blocked" ? false : spec.autoRetry;

  return {
    code,
    phase,
    retryable: spec.retryable,
    autoRetry,
    actual,
    actions: [...spec.actions],
    ...(extras?.profileId ? { profileId: extras.profileId } : {}),
    ...(extras?.restartAttempts ? { restartAttempts: extras.restartAttempts } : {}),
    ...(extras?.reasonCode ? { reasonCode: extras.reasonCode } : {}),
  };
}

export function getLocalFailureCopy(code: LocalFailureCode): LocalFailureCopy {
  return LOCAL_FAILURE_CATALOG[code].copy;
}

export interface DiagnosticsRedactionContext {
  homeDir?: string;
  username?: string;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactDiagnosticsText(
  text: string,
  context?: DiagnosticsRedactionContext,
): string {
  let out = redactString(text);
  if (context?.homeDir && context.homeDir.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(context.homeDir), "g"), "[REDACTED_HOME]");
  }
  if (context?.username && context.username.length > 1) {
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(context.username)}\\b`, "gi"),
      "[REDACTED_USER]",
    );
  }
  return redactString(out);
}

export function sanitizeDiagnosticsPayload(
  payload: SanitizedDiagnosticsPayload,
  context?: DiagnosticsRedactionContext,
): SanitizedDiagnosticsPayload {
  const redactedNotes = payload.notes.map((note) => redactDiagnosticsText(note, context));
  const redacted = redactSensitiveData({
    ...payload,
    cliSummary: payload.cliSummary
      ? formatDisplaySafeCliSummary({
          status: payload.cliSummary.status,
          sourceKind: payload.cliSummary.sourceKind,
          binaryName: payload.cliSummary.displayName.split(" ")[0],
          version: payload.cliSummary.version,
          hasOverride: payload.cliSummary.hasOverride,
          supportsEnsureJson: payload.cliSummary.supportsEnsureJson,
          supportsAttachJson: payload.cliSummary.supportsAttachJson,
          supportsTicketsProbe: payload.cliSummary.supportsTicketsProbe,
        })
      : null,
    notes: redactedNotes,
  });

  return redacted;
}
