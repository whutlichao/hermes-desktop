import type {
  SshFailureCode,
  SshHostKeyChallenge,
} from "@hermes/contracts";
import { parseEnsureOrAttachOutput, type EnsureOrAttachParseResult } from "./gatewayProtocol";

export interface SshTargetValidation {
  valid: boolean;
  reason?: string;
}

export function validateSshTargetInput(input: {
  host?: string;
  user?: string;
  port?: number;
}): SshTargetValidation {
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!host) {
    return { valid: false, reason: "SSH 主机不能为空" };
  }
  if (host.startsWith("-") || /\s/.test(host)) {
    return { valid: false, reason: "SSH 主机格式无效" };
  }
  const user = typeof input.user === "string" ? input.user.trim() : "";
  if (user && (user.startsWith("-") || /\s/.test(user))) {
    return { valid: false, reason: "SSH 用户名格式无效" };
  }
  if (input.port !== undefined) {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return { valid: false, reason: "SSH 端口必须在 1-65535 之间" };
    }
  }
  return { valid: true };
}

export function formatSshDestination(input: { user?: string; host: string }): string {
  const host = input.host.trim();
  const user = input.user?.trim();
  return user ? `${user}@${host}` : host;
}

export function formatSshHostDisplay(host: string, port?: number): string {
  const cleanHost = host.trim();
  const p = port && port !== 22 ? port : 22;
  return p === 22 ? cleanHost : `[${cleanHost}]:${p}`;
}

export function shellQuotePosix(arg: string): string {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function buildRemoteHermesShellCommand(options: {
  remoteHermesPath?: string;
  remoteProfile?: string;
  args: string[];
}): string {
  const bin = options.remoteHermesPath?.trim() || "hermes";
  const parts = [bin];
  if (options.remoteProfile?.trim() && options.remoteProfile.trim() !== "default") {
    parts.push("--profile", options.remoteProfile.trim());
  }
  parts.push(...options.args);
  return parts.map(shellQuotePosix).join(" ");
}

export function buildSshCommandArgs(options: {
  host: string;
  user?: string;
  port?: number;
  keyPath?: string;
  knownHostsPath?: string;
  useAskpass?: boolean;
  forward?: { localPort: number; remotePort: number };
  remoteCommand?: string;
}): string[] {
  const args: string[] = [];

  // Strict host key enforcement: NEVER StrictHostKeyChecking=no
  if (!options.useAskpass) {
    args.push("-o", "BatchMode=yes");
  }
  args.push("-o", "StrictHostKeyChecking=yes");
  args.push("-o", "ConnectTimeout=10");
  args.push("-o", "ServerAliveInterval=15");
  args.push("-o", "ServerAliveCountMax=3");

  if (options.knownHostsPath) {
    args.push("-o", `UserKnownHostsFile=${options.knownHostsPath}`);
    args.push("-o", "GlobalKnownHostsFile=/dev/null");
  }

  if (options.port && options.port !== 22) {
    args.push("-p", String(options.port));
  }
  if (options.keyPath?.trim()) {
    args.push("-i", options.keyPath.trim(), "-o", "IdentitiesOnly=yes");
  }
  if (options.forward) {
    args.push("-N");
    args.push("-o", "ExitOnForwardFailure=yes");
    args.push(
      "-L",
      `127.0.0.1:${options.forward.localPort}:127.0.0.1:${options.forward.remotePort}`,
    );
  }

  args.push(formatSshDestination({ user: options.user, host: options.host }));

  if (options.remoteCommand) {
    args.push(options.remoteCommand);
  }

  return args;
}

export function classifySshStderr(stderr: string): SshFailureCode {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("remote host identification has changed") ||
    lower.includes("host key for") && lower.includes("has changed") ||
    lower.includes("offending") && lower.includes("key")
  ) {
    return "host_key_changed";
  }
  if (
    lower.includes("host key verification failed") ||
    lower.includes("no ") && lower.includes("host key is known") ||
    lower.includes("are you sure you want to continue connecting")
  ) {
    return "host_key_unknown";
  }
  if (
    lower.includes("permission denied") ||
    lower.includes("authentication failed") ||
    lower.includes("too many authentication failures") ||
    lower.includes("enter passphrase")
  ) {
    return "ssh_auth_failed";
  }
  if (lower.includes("timed out") || lower.includes("operation timed out")) {
    return "ssh_timeout";
  }
  if (
    lower.includes("command not found") ||
    lower.includes("no such file or directory") && lower.includes("hermes")
  ) {
    return "remote_hermes_not_found";
  }
  return "ssh_unreachable";
}

export type SshProbeParseResult =
  | {
      kind: "modern";
      supportsInteractive: boolean;
      windowsServiceSession: boolean;
      purposes: string[];
      remotePort?: number;
    }
  | {
      kind: "legacy_attach_only";
      reason: string;
    }
  | {
      kind: "remote_hermes_not_found";
    }
  | {
      kind: "failure";
      code: SshFailureCode;
    };

export function parseSshProbeOutput(
  stdout: string,
  exitCode: number | null,
  stderr = "",
): SshProbeParseResult {
  const stderrLower = stderr.toLowerCase();
  if (
    exitCode === 127 ||
    stderrLower.includes("command not found") ||
    (stderrLower.includes("hermes") && stderrLower.includes("not found"))
  ) {
    return { kind: "remote_hermes_not_found" };
  }

  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      const protocol =
        typeof raw.protocol === "number"
          ? raw.protocol
          : typeof raw.runtime_protocol === "number"
            ? raw.runtime_protocol
            : 1;
      if (protocol !== 1) {
        return { kind: "failure", code: "protocol_unsupported" };
      }
      const purposes = Array.isArray(raw.purposes)
        ? raw.purposes.filter((p): p is string => typeof p === "string")
        : [];
      const windowsServiceSession = Boolean(
        raw.windows_service_session ?? raw.windowsServiceSession,
      );
      const remotePort =
        typeof raw.remote_port === "number" && Number.isInteger(raw.remote_port)
          ? raw.remote_port
          : typeof raw.port === "number" && Number.isInteger(raw.port)
            ? raw.port
            : undefined;
      return {
        kind: "modern",
        supportsInteractive: purposes.includes("interactive"),
        windowsServiceSession,
        purposes,
        ...(remotePort ? { remotePort } : {}),
      };
    } catch {
      // fall through to stderr/exit inspection
    }
  }

  if (
    stderrLower.includes("no such command") ||
    stderrLower.includes("unknown command") ||
    stderrLower.includes("unrecognized arguments") ||
    stderrLower.includes("invalid choice") ||
    stderrLower.includes("unknown option") ||
    exitCode === 2
  ) {
    return { kind: "legacy_attach_only", reason: "tickets_subcommand_missing" };
  }

  if (stderr.trim()) {
    return { kind: "failure", code: classifySshStderr(stderr) };
  }

  return { kind: "failure", code: "protocol_unsupported" };
}

export type SshServeLineParseResult =
  | {
      kind: "ready";
      remotePort?: number;
      endpoint?: Extract<EnsureOrAttachParseResult, { kind: "ready" }>["endpoint"];
    }
  | {
      kind: "ticket";
      ticket: string;
      expiresInSeconds: number;
      endpoint: Extract<EnsureOrAttachParseResult, { kind: "ready" }>["endpoint"];
    }
  | {
      kind: "error";
      code: "ticket_unavailable" | "protocol_unsupported" | "profile_unavailable";
    }
  | {
      kind: "ignored";
    };

export function parseSshServeLine(line: string): SshServeLineParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignored" };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { kind: "ignored" };
  }

  const errCode = typeof raw.error === "string" ? raw.error : typeof raw.code === "string" ? raw.code : "";
  if (raw.ok === false || errCode) {
    if (errCode === "profile_unavailable" || errCode === "profile_not_served" || errCode === "profile_mismatch") {
      return { kind: "error", code: "profile_unavailable" };
    }
    if (errCode === "protocol_unsupported") {
      return { kind: "error", code: "protocol_unsupported" };
    }
    return { kind: "error", code: "ticket_unavailable" };
  }

  if (typeof raw.ticket === "string" && raw.ticket.trim()) {
    const parsed = parseEnsureOrAttachOutput(trimmed, 0);
    if (parsed.kind === "ready" && parsed.ticket) {
      return {
        kind: "ticket",
        ticket: parsed.ticket,
        expiresInSeconds: parsed.expiresInSeconds,
        endpoint: parsed.endpoint,
      };
    }
    return { kind: "error", code: "protocol_unsupported" };
  }

  if (raw.state === "ready" || raw.event === "ready") {
    const remotePort =
      typeof raw.remote_port === "number" && Number.isInteger(raw.remote_port)
        ? raw.remote_port
        : undefined;
    const parsed = raw.endpoint ? parseEnsureOrAttachOutput(trimmed, 0) : null;
    return {
      kind: "ready",
      ...(remotePort ? { remotePort } : {}),
      ...(parsed && parsed.kind === "ready" ? { endpoint: parsed.endpoint } : {}),
    };
  }

  return { kind: "ignored" };
}

export function extractRemotePortFromWsUrl(wsUrl: string): number | null {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.port) {
      const portNum = Number.parseInt(parsed.port, 10);
      return Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : null;
    }
    return parsed.protocol === "wss:" ? 443 : 80;
  } catch {
    return null;
  }
}

export function rewriteForwardedWsUrl(remoteWsUrl: string, localPort: number): string {
  const parsed = new URL(remoteWsUrl);
  const scheme = parsed.protocol === "wss:" ? "wss:" : "ws:";
  return `${scheme}//127.0.0.1:${localPort}${parsed.pathname || "/api/ws"}${parsed.search || ""}`;
}

export function parseKeygenFingerprintOutput(
  output: string,
  hostDisplay: string,
): SshHostKeyChallenge | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Example: 256 SHA256:abcdef... host (ED25519)
    const fpMatch = line.match(/\b(SHA256:[A-Za-z0-9+/=]+|MD5:[0-9a-f:]+)/i);
    if (!fpMatch) continue;
    const typeMatch = line.match(/\(([^)]+)\)\s*$/);
    return {
      hostDisplay,
      keyType: typeMatch ? typeMatch[1].toUpperCase() : "SSH",
      fingerprint: fpMatch[1],
    };
  }
  return null;
}

export function getSshFailureCopy(code: SshFailureCode): string {
  switch (code) {
    case "host_key_unknown":
      return "尚未信任此 SSH 主机密钥，请核对指纹后再确认信任。";
    case "host_key_changed":
      return "该 SSH 主机的已记录密钥已变更，存在中间人风险，已硬阻断连接。";
    case "ssh_auth_failed":
      return "SSH 认证失败，请检查私钥、passphrase 或 ssh-agent 配置后重试。";
    case "ssh_timeout":
      return "SSH 连接超时，请检查主机可达性与端口配置。";
    case "remote_hermes_not_found":
      return "远端主机未找到 hermes CLI，请填写远端 hermes 路径或确认已安装。";
    case "protocol_unsupported":
      return "远端 Hermes Gateway 协议版本不兼容，请检查升级或改用 legacy attach-only 模式。";
    case "ticket_unavailable":
      return "未能从远端获取有效的 Gateway 接入凭据。";
    case "windows_session0_attach_only":
      return "远端 Windows Session 0 服务仅支持 attach，请在远端普通用户桌面启动 Hermes。";
    case "tunnel_failed":
      return "SSH 本地端口转发隧道建立失败，请检查远端 Gateway 端口与本地转发权限。";
    case "ssh_unreachable":
    default:
      return "无法通过 SSH 连接到目标主机，请检查主机名、端口与网络状态。";
  }
}
