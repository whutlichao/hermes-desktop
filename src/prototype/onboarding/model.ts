export const variantKeys = ["A", "B", "C"] as const;
export type Variant = (typeof variantKeys)[number];

export const variants: Array<{
  id: Variant;
  name: string;
  short: string;
  note: string;
}> = [
  {
    id: "A",
    name: "Relay Ledger",
    short: "Fleet rail + repair docket",
    note: "Persistent fleet rail, a quiet 720px welcome, and a right-hand repair docket.",
  },
  {
    id: "B",
    name: "Quiet Threshold",
    short: "Centered progressive card",
    note: "No rail by default. One decision at a time inside a centered threshold card.",
  },
  {
    id: "C",
    name: "Operator Bench",
    short: "Split fleet ledger + inspector",
    note: "Dense fleet ledger on the left, contextual connection inspector on the right.",
  },
];

export const sceneKeys = [
  "first-run",
  "local-recovery",
  "add-remote",
  "add-ssh",
  "conflicts",
  "startup",
  "empty-normal",
  "empty-onboarding",
  "empty-draft",
  "scope-banner",
] as const;
export type Scene = (typeof sceneKeys)[number];

export const scenes: Array<{
  id: Scene;
  label: string;
  group: "Onboarding" | "Connections" | "Empty";
  detail: string;
}> = [
  {
    id: "first-run",
    label: "首次运行",
    group: "Onboarding",
    detail: "尚未安装、无法执行或 CLI 版本不兼容",
  },
  {
    id: "local-recovery",
    label: "Local attach / ensure",
    group: "Onboarding",
    detail: "自动 ensure、受控重启与 blocked 恢复",
  },
  {
    id: "add-remote",
    label: "添加 Remote HTTP(S)",
    group: "Connections",
    detail: "Session token 或 Native OAuth / PKCE",
  },
  {
    id: "add-ssh",
    label: "添加 SSH host",
    group: "Connections",
    detail: "Probe、Test 与 tickets --serve / legacy 回退",
  },
  {
    id: "conflicts",
    label: "冲突与 registry 异常",
    group: "Connections",
    detail: "重复身份、重复名称与损坏的共享 registry",
  },
  {
    id: "startup",
    label: "启动选择策略",
    group: "Connections",
    detail: "Primary、last-used 与多 Profile 首次就绪",
  },
  {
    id: "empty-normal",
    label: "Normal Empty",
    group: "Empty",
    detail: "无 ActiveChat、无草稿；≤3 动作 + 1 条 Cron 提示",
  },
  {
    id: "empty-onboarding",
    label: "Onboarding Empty",
    group: "Empty",
    detail: "全部连接不可用；仍给 ≤3 个修复动作",
  },
  {
    id: "empty-draft",
    label: "有本地草稿",
    group: "Empty",
    detail: "草稿预填 composer；绝不自动 session.create",
  },
  {
    id: "scope-banner",
    label: "跨 Scope 回退",
    group: "Empty",
    detail: "非模态 route banner；保留 last-known",
  },
];

export const failureKeys = [
  "none",
  "hermes_not_found",
  "cli_not_executable",
  "cli_unsupported",
  "gateway_start_failed",
  "code_sha_mismatch",
  "socket_permission_denied",
  "service_unhealthy",
  "duplicate_identity",
  "duplicate_label",
  "registry_invalid",
  "registry_corrupt",
  "registry_unsupported",
  "token_sync_failed",
  "ssh_test_failed",
] as const;
export type Failure = (typeof failureKeys)[number];

export type ActionId =
  | "choose_cli"
  | "open_install_docs"
  | "open_update_docs"
  | "retry"
  | "restart_gateway"
  | "open_status"
  | "open_diagnostics"
  | "switch_remote"
  | "switch_ssh"
  | "resolve_conflict"
  | "keep_canonical"
  | "export_safe_summary"
  | "repair_registry"
  | "reauthorize"
  | "edit_target"
  | "edit_label"
  | "legacy_attach";

export interface FailureMeta {
  code: Failure;
  label: string;
  state: "none" | "blocked" | "warning";
  family: "local" | "registry" | "test";
  headline: string;
  detail: string;
  safeFacts: string[];
  actions: ActionId[];
}

export const failures: FailureMeta[] = [
  {
    code: "none",
    label: "无故障 · 正常路径",
    state: "none",
    family: "local",
    headline: "连接与修复状态正常",
    detail: "自动 attach / ensure 已完成；所有需要显示的事实均已脱敏。",
    safeFacts: ["Local owner ready", "Interactive ticket minted", "HTTP + WS healthy"],
    actions: [],
  },
  {
    code: "hermes_not_found",
    label: "hermes_not_found",
    state: "blocked",
    family: "local",
    headline: "在这台 Mac 上找不到 Hermes CLI",
    detail: "App 已检查登录 shell PATH 与常见安装目录。不会自动下载或打包 Python runtime。",
    safeFacts: ["phase: discover", "retryable: user action", "autoRetry: no"],
    actions: ["choose_cli", "open_install_docs", "retry", "switch_remote"],
  },
  {
    code: "cli_not_executable",
    label: "cli_not_executable",
    state: "blocked",
    family: "local",
    headline: "找到了候选 CLI，但无法执行",
    detail: "权限或文件类型阻止启动。Renderer 不会收到真实路径；请选择另一份 CLI 或查看脱敏诊断。",
    safeFacts: ["phase: validate", "retryable: user action", "autoRetry: no"],
    actions: ["choose_cli", "open_diagnostics"],
  },
  {
    code: "cli_unsupported",
    label: "cli_unsupported",
    state: "blocked",
    family: "local",
    headline: "这份 CLI 缺少可用的本地 attach 面",
    detail: "未检测到 ensure，或 attach / runtime protocol / session authority 能力不完整。",
    safeFacts: ["phase: capability probe", "retryable: user action", "autoRetry: no"],
    actions: ["choose_cli", "open_update_docs", "retry"],
  },
  {
    code: "gateway_start_failed",
    label: "gateway_start_failed",
    state: "blocked",
    family: "local",
    headline: "Local gateway 启动后立即退出",
    detail: "这不会触发自动安装或 service 管理。可以查看脱敏诊断，或由你显式 Retry。",
    safeFacts: ["phase: ensure", "retryable: user action", "autoRetry: no"],
    actions: ["retry", "open_status", "open_diagnostics"],
  },
  {
    code: "code_sha_mismatch",
    label: "code_sha_mismatch",
    state: "blocked",
    family: "local",
    headline: "owner 仍在运行旧代码",
    detail: "本 App 只对同一个 stale owner 做一次受控优雅 restart；若仍不一致就保持 blocked，绝不循环。",
    safeFacts: ["phase: version recovery", "restartAttempts: 0/1", "owner: same instance"],
    actions: ["restart_gateway", "open_diagnostics"],
  },
  {
    code: "socket_permission_denied",
    label: "socket_permission_denied",
    state: "blocked",
    family: "local",
    headline: "Local control socket 权限不安全",
    detail: "App 不会通过换 attach 方式绕过权限。请先修复权限，再显式 Retry；原始 socket 路径不会跨桥。",
    safeFacts: ["phase: control socket", "retryable: after manual fix", "autoRetry: no"],
    actions: ["open_diagnostics", "retry"],
  },
  {
    code: "service_unhealthy",
    label: "service_unhealthy",
    state: "blocked",
    family: "local",
    headline: "Hermes service 不健康",
    detail: "App 只 attach 现有 service。不会 reinstall、stop、enable 或启动第二个 owner。",
    safeFacts: ["phase: service check", "retryable: no", "autoRetry: no"],
    actions: ["open_status", "open_diagnostics"],
  },
  {
    code: "duplicate_identity",
    label: "duplicate_identity",
    state: "warning",
    family: "registry",
    headline: "这个目标已经注册过",
    detail: "同一个语义 URL 或 SSH 身份不能重复写入。右侧只展示既有连接的 display-safe 摘要。",
    safeFacts: ["error: duplicate_identity", "registry writes: 0", "secret fields: hidden"],
    actions: ["edit_label", "edit_target", "keep_canonical"],
  },
  {
    code: "duplicate_label",
    label: "duplicate_label",
    state: "warning",
    family: "registry",
    headline: "这个设备名已被使用",
    detail: "名称大小写不敏感唯一。可以改名，或确认使用既有连接；不会覆盖既有条目。",
    safeFacts: ["error: duplicate_label", "registry writes: 0", "existing label preserved"],
    actions: ["edit_label", "keep_canonical"],
  },
  {
    code: "registry_invalid",
    label: "registry_invalid",
    state: "warning",
    family: "registry",
    headline: "共享 registry 有冲突条目",
    detail: "外部文件中的后续同身份条目保留但不拨号。第一条有效条目是 canonical；本客户端不自动删除。",
    safeFacts: ["code: duplicate-identity", "canonical: Homelab", "quarantined raw: Main only"],
    actions: ["keep_canonical", "export_safe_summary", "resolve_conflict"],
  },
  {
    code: "registry_corrupt",
    label: "registry_corrupt",
    state: "blocked",
    family: "registry",
    headline: "共享 registry 无法解析",
    detail: "保留 last-known snapshot 并拒绝后台写入。只有你的显式修复动作才能备份并重写 canonical v2。",
    safeFacts: ["readState: degraded", "writes: refused", "last-known: preserved"],
    actions: ["repair_registry", "export_safe_summary"],
  },
  {
    code: "registry_unsupported",
    label: "registry_unsupported",
    state: "blocked",
    family: "registry",
    headline: "registry 版本高于当前客户端可写范围",
    detail: "以只读方式展示 last-known；不会降级覆盖未来版本。请更新客户端或在兼容应用中处理。",
    safeFacts: ["readState: unsupported", "writes: refused", "secret fields: hidden"],
    actions: ["open_update_docs", "export_safe_summary"],
  },
  {
    code: "token_sync_failed",
    label: "token_sync_failed",
    state: "warning",
    family: "registry",
    headline: "连接已保存，但 token 对账失败",
    detail: "连接条目是权威写入；token 仍是 warning。请重新授权，不会把明文 token 回填到 Renderer。",
    safeFacts: ["registry: committed", "token: needs reauth", "renderer token: absent"],
    actions: ["reauthorize", "open_diagnostics"],
  },
  {
    code: "ssh_test_failed",
    label: "ssh_test_failed",
    state: "warning",
    family: "test",
    headline: "SSH Test 未通过",
    detail: "测试不会写 registry，表单草稿完整保留。可修正 target、重试，或改用 legacy attach-only。",
    safeFacts: ["probe: failed", "registry writes: 0", "draft: preserved"],
    actions: ["edit_target", "retry", "legacy_attach"],
  },
];

export function getFailure(code: Failure): FailureMeta {
  return failures.find((entry) => entry.code === code) ?? failures[0];
}

export function defaultFailureFor(scene: Scene): Failure {
  if (scene === "first-run") return "hermes_not_found";
  if (scene === "local-recovery") return "gateway_start_failed";
  if (scene === "add-ssh") return "ssh_test_failed";
  if (scene === "conflicts") return "registry_invalid";
  return "none";
}

export const actionLabels: Record<ActionId, string> = {
  choose_cli: "选择 Hermes CLI",
  open_install_docs: "查看安装文档",
  open_update_docs: "查看更新文档",
  retry: "Retry",
  restart_gateway: "受控重启一次",
  open_status: "打开 gateway status",
  open_diagnostics: "打开脱敏诊断",
  switch_remote: "改连 Remote",
  switch_ssh: "改连 SSH",
  resolve_conflict: "解决冲突条目",
  keep_canonical: "保留 canonical",
  export_safe_summary: "导出脱敏摘要",
  repair_registry: "备份并修复 registry",
  reauthorize: "重新授权",
  edit_target: "修改目标",
  edit_label: "改设备名",
  legacy_attach: "尝试 legacy attach-only",
};

export type ConnectionKind = "local" | "remote" | "ssh";
export type ConnectionStatus = "ready" | "degraded" | "blocked" | "invalid";

export interface SimProfile {
  id: string;
  handle: string;
  readiness: "eager" | "first-use" | "parked";
}

export interface SimConnection {
  id: string;
  label: string;
  kind: ConnectionKind;
  host: string;
  status: ConnectionStatus;
  primary: boolean;
  lastUsed: string;
  auth: "app-managed" | "session-token" | "oauth" | "ssh-key";
  hasToken: boolean;
  profiles: SimProfile[];
  note: string;
  issue?: "registry_invalid" | "registry_corrupt" | "token_sync_failed";
}

const allProfiles: Record<string, SimProfile[]> = {
  local: [
    { id: "default", handle: "@default", readiness: "eager" },
    { id: "work", handle: "@work-local", readiness: "first-use" },
  ],
  homelab: [
    { id: "research", handle: "@research", readiness: "eager" },
    { id: "ops", handle: "@ops", readiness: "first-use" },
  ],
  vps1: [
    { id: "vps-research", handle: "@research-vps", readiness: "eager" },
    { id: "vps-writer", handle: "@writer-vps", readiness: "first-use" },
  ],
  studio: [{ id: "studio", handle: "@studio", readiness: "eager" }],
};

export function connectionsForScene(scene: Scene, failure: Failure): SimConnection[] {
  const failureMeta = getFailure(failure);
  const localStatus: ConnectionStatus =
    failureMeta.family === "local" && failure !== "none" ? "blocked" : "ready";
  const allUnavailable = scene === "empty-onboarding";
  const localOnly = scene === "first-run";
  const rows: SimConnection[] = [
    {
      id: "local",
      label: "This device",
      kind: "local",
      host: "Local Hermes runtime",
      status: allUnavailable ? "blocked" : localStatus,
      primary: false,
      lastUsed: "现在",
      auth: "app-managed",
      hasToken: false,
      profiles: allProfiles.local,
      note: failureMeta.family === "local" ? failure : "ensure · host-scope interactive",
      issue: failure === "token_sync_failed" && scene === "conflicts" ? "token_sync_failed" : undefined,
    },
  ];
  if (localOnly) return rows;

  rows.push(
    {
      id: "homelab",
      label: "Homelab",
      kind: "ssh",
      host: "homelab.lan · 22",
      status: allUnavailable ? "blocked" : "ready",
      primary: true,
      lastUsed: "12 分钟前",
      auth: "ssh-key",
      hasToken: false,
      profiles: allProfiles.homelab,
      note: allUnavailable ? "tunnel unavailable" : "tickets --serve · shared WS",
      issue: failure === "registry_invalid" ? "registry_invalid" : undefined,
    },
    {
      id: "vps1",
      label: "VPS-1",
      kind: "remote",
      host: "vps1.hermes.run",
      status: allUnavailable ? "blocked" : "degraded",
      primary: false,
      lastUsed: "刚刚",
      auth: "session-token",
      hasToken: true,
      profiles: allProfiles.vps1,
      note: allUnavailable ? "HTTP timeout" : "Tailscale · 86 ms",
      issue: failure === "token_sync_failed" ? "token_sync_failed" : undefined,
    },
    {
      id: "studio",
      label: "Studio Mac",
      kind: "remote",
      host: "studio.hermes.run",
      status: allUnavailable ? "blocked" : "blocked",
      primary: false,
      lastUsed: "昨天",
      auth: "oauth",
      hasToken: false,
      profiles: allProfiles.studio,
      note: allUnavailable ? "auth required" : "OAuth reauth required",
    },
  );

  if (scene === "conflicts") {
    rows.push(
      {
        id: "homelab-duplicate",
        label: "Homelab (external)",
        kind: "ssh",
        host: "homelab.lan · 22",
        status: "invalid",
        primary: false,
        lastUsed: "—",
        auth: "ssh-key",
        hasToken: false,
        profiles: [],
        note: "duplicate-identity · not dialed",
        issue: "registry_invalid",
      },
      {
        id: "vps-copy",
        label: "VPS-1 Copy",
        kind: "remote",
        host: "vps1.hermes.run",
        status: "invalid",
        primary: false,
        lastUsed: "—",
        auth: "session-token",
        hasToken: true,
        profiles: [],
        note: "duplicate-identity · token hidden",
        issue: "registry_invalid",
      },
    );
  }

  return rows;
}

export const draftPreview =
  "把今天在 Homelab 上跑完的 MCP 迁移整理成三条结论，并保留失败的 WebSocket 日志摘要。";

export const prototypeScenes: Record<
  Scene,
  { title: string; eyebrow: string; body: string }
> = {
  "first-run": {
    eyebrow: "FIRST RUN · LOCAL",
    title: "先让 Hermes 知道从哪里出发",
    body: "不必先配置整支舰队。先修复本地运行时，或直接改连一台你已经能访问的机器。",
  },
  "local-recovery": {
    eyebrow: "LOCAL ATTACH / ENSURE",
    title: "把旧 owner 与连接契约对齐",
    body: "ensure 是主路径；host-scope 不可用时回退 per-Profile ticket。ticket 只留在 Main 内存。",
  },
  "add-remote": {
    eyebrow: "NEW CONNECTION · REMOTE HTTP(S)",
    title: "添加一台 Remote Gateway",
    body: "静态 token 与 Native OAuth 是两条明确的认证路径。已保存凭据永不回填 Renderer。",
  },
  "add-ssh": {
    eyebrow: "NEW CONNECTION · SSH",
    title: "添加一台 SSH host",
    body: "先 probe，再 Test；Test 只验证目标，不写 registry。支持 tickets --serve 与 legacy attach-only。",
  },
  conflicts: {
    eyebrow: "REGISTRY · CONFLICT DESK",
    title: "先解释冲突，再决定保留什么",
    body: "外部条目不被静默删除；重复身份保留在文件里，但只有 canonical 可以拨号。",
  },
  startup: {
    eyebrow: "STARTUP · SCOPE",
    title: "启动后落到哪台机器",
    body: "Primary 是显式默认，last-used 是最近成功使用的 Scope；两者都能被用户看见。",
  },
  "empty-normal": {
    eyebrow: "NORMAL EMPTY",
    title: "安静地去问。",
    body: "没有 ActiveChat，也没有未落库草稿。同步仍在线，会话不会在启动时被自动创建。",
  },
  "empty-onboarding": {
    eyebrow: "ONBOARDING EMPTY",
    title: "还没有可用的连接",
    body: "所有连接都不可用。先完成一个连接修复路径，或添加一台可访问的 Remote / SSH 机器。",
  },
  "empty-draft": {
    eyebrow: "DRAFT PROTECTED",
    title: "草稿还在这里",
    body: "草稿属于 ActiveChat（或新对话 draftId），不会进入 Gateway queue，也不会被自动发送。",
  },
  "scope-banner": {
    eyebrow: "SCOPE FALLBACK",
    title: "已退回仍在线的 Scope",
    body: "前一个 Session 被移除；非模态 route banner 解释回退。输入区保持可用，不抢焦点。",
  },
};
