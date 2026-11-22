export const variantKeys = ["A", "B", "C"] as const;
export type Variant = (typeof variantKeys)[number];

export const sceneKeys = ["empty", "running", "approval", "degraded"] as const;
export type Scene = (typeof sceneKeys)[number];

export const capTierKeys = ["served", "older", "unavailable", "refused"] as const;
export type CapTier = (typeof capTierKeys)[number];

export type Classification = "native" | "read_only" | "deep_link";
export type DomainGroup = "core" | "manage" | "execute";

export type DomainId =
  | "chat"
  | "approval"
  | "checkpoint"
  | "profile"
  | "session"
  | "skills"
  | "tools"
  | "mcp"
  | "memory"
  | "cron"
  | "messaging"
  | "files"
  | "git"
  | "terminal"
  | "subagents"
  | "settings"
  | "plugins";

export interface CapabilityDomain {
  id: DomainId;
  name: string;
  english: string;
  classification: Classification;
  group: DomainGroup;
  summary: string;
  methods: string[];
  paths: Record<Variant, string>;
}

const paths = (a: string, b: string, c: string): Record<Variant, string> => ({ A: a, B: b, C: c });

export const domains: CapabilityDomain[] = [
  {
    id: "chat",
    name: "聊天",
    english: "Chat",
    classification: "native",
    group: "core",
    summary: "720px 对话列是页面的正文，composer 固定在列底。",
    methods: ["prompt.submit", "prompt.cancel", "session.transcript"],
    paths: paths(
      "常驻 720px 对话列 + composer",
      "常驻 720px 对话列 + composer",
      "常驻 720px 对话列 + composer",
    ),
  },
  {
    id: "approval",
    name: "审批",
    english: "Approval",
    classification: "native",
    group: "core",
    summary: "审批卡留在 owning Session；壳层只给最小角标，不把审批变成全局收件箱。",
    methods: ["approval.pending", "approval.respond", "Main 原生确认"],
    paths: paths(
      "对话内审批卡 + route strip 角标",
      "对话内审批卡 + bottom dock 角标",
      "对话内审批卡 + top strip 角标",
    ),
  },
  {
    id: "checkpoint",
    name: "Checkpoint",
    english: "Checkpoint",
    classification: "native",
    group: "core",
    summary: "Snapshot 跟随 Session；列表、diff、restore 都在同一个有边界的面板里。",
    methods: ["rollback.list", "rollback.diff", "rollback.restore"],
    paths: paths(
      "⌘K → Checkpoint → 右侧抽屉",
      "⌘K → Checkpoint → 中央命令面板内详情",
      "底部能力托盘 → 核心 → Checkpoint",
    ),
  },
  {
    id: "profile",
    name: "Profile",
    english: "Profile",
    classification: "native",
    group: "core",
    summary: "当前执行作用域是常驻事实；切换用 popover，不占常驻面板。",
    methods: ["profiles.list", "config.get/set"],
    paths: paths(
      "route strip 的 profile chip → popover",
      "bottom dock 的 scope chip → popover",
      "top strip 的 profile chip → popover",
    ),
  },
  {
    id: "session",
    name: "Session",
    english: "Session",
    classification: "native",
    group: "core",
    summary: "open/resume/transcript 是原生；改名、删除、分支等 refused 动作永不渲染。",
    methods: ["session.list", "session.resume", "session.transcript"],
    paths: paths(
      "常驻 232px Session rail",
      "bottom dock → Sessions → 左侧 popover",
      "top strip 的 Session chips / 全部 Sessions",
    ),
  },
  {
    id: "skills",
    name: "Skills",
    english: "Skills",
    classification: "native",
    group: "manage",
    summary: "reload + 只读清单；older 网关降为只读并给出 CLI 深链。",
    methods: ["skills.reload", "skills.manage（older）"],
    paths: paths(
      "⌘K → Skills → 右侧抽屉",
      "⌘K → Skills → 中央面板内详情",
      "底部能力托盘 → 管理 → Skills",
    ),
  },
  {
    id: "tools",
    name: "Tools",
    english: "Tools",
    classification: "native",
    group: "manage",
    summary: "工具清单与安全规则；configure 只在探测可用时出现。",
    methods: ["tools.show", "tools.configure（older）"],
    paths: paths(
      "⌘K → Tools → 右侧抽屉",
      "⌘K → Tools → 中央面板内详情",
      "底部能力托盘 → 管理 → Tools",
    ),
  },
  {
    id: "mcp",
    name: "MCP",
    english: "MCP",
    classification: "native",
    group: "manage",
    summary: "活动 Gateway 可热重载；新增、删除、OAuth 在 older 时只留深链。",
    methods: ["reload.mcp", "mcp.servers.*（older）"],
    paths: paths(
      "⌘K → MCP → 右侧抽屉",
      "⌘K → MCP → 中央面板内详情",
      "底部能力托盘 → 管理 → MCP",
    ),
  },
  {
    id: "memory",
    name: "Memory",
    english: "Memory",
    classification: "read_only",
    group: "manage",
    summary: "只读上下文拆解；v1 不提供记忆编辑/删除开关。",
    methods: ["session.context_breakdown", "session.info"],
    paths: paths(
      "⌘K → Memory → 右侧抽屉",
      "⌘K → Memory → 中央面板内详情",
      "底部能力托盘 → 管理 → Memory",
    ),
  },
  {
    id: "cron",
    name: "Cron",
    english: "Cron",
    classification: "native",
    group: "manage",
    summary: "任务、heartbeat、loop 的 submit/status/cancel 都在原生面上。",
    methods: ["cron.submit", "cron.status", "cron.cancel"],
    paths: paths(
      "⌘K → Cron → 右侧抽屉",
      "空态建议 / ⌘K → Cron → 中央面板",
      "底部能力托盘 → 管理 → Cron",
    ),
  },
  {
    id: "messaging",
    name: "Messaging",
    english: "Messaging",
    classification: "read_only",
    group: "manage",
    summary: "Connector 状态只读；账号连接/授权走官方 surface 深链。",
    methods: ["connectors.*", "官方 CLI/Desktop 深链"],
    paths: paths(
      "⌘K → Messaging → 右侧抽屉",
      "⌘K → Messaging → 中央面板",
      "底部能力托盘 → 管理 → Messaging",
    ),
  },
  {
    id: "files",
    name: "Files / Artifacts",
    english: "Files / Artifacts",
    classification: "native",
    group: "execute",
    summary: "本机 attach/preview 与不可见路径的 opaque handle；远程 REST 未核实即深链。",
    methods: ["file.attach", "image.attach_bytes", "files.*"],
    paths: paths(
      "route strip 的 Workspace → Artifacts/Files",
      "bottom dock → Workspace → bottom sheet",
      "top strip Workspace → 左侧抽屉 Artifacts/Files",
    ),
  },
  {
    id: "git",
    name: "Git / worktree",
    english: "Git / worktree",
    classification: "deep_link",
    group: "execute",
    summary: "v1 不做第一类 Git UI；只复制精确 git/gh 命令或在 Terminal 执行。",
    methods: ["无 gateway method", "复制 git/gh 命令"],
    paths: paths(
      "Workspace → Git（只读 + CLI 深链）",
      "⌘K → Git → 复制 CLI 命令 / Terminal",
      "底部托盘 → 执行 → Git（只读 + CLI 深链）",
    ),
  },
  {
    id: "terminal",
    name: "Terminal",
    english: "Terminal",
    classification: "native",
    group: "execute",
    summary: "PTY 归 Main；首次打开走原生授权，拒绝时不伪造 shell。",
    methods: ["terminal.open/input/resize/close", "shell.exec"],
    paths: paths(
      "Workspace → Terminal",
      "bottom dock → Workspace → Terminal",
      "top strip Workspace → Terminal",
    ),
  },
  {
    id: "subagents",
    name: "Subagents",
    english: "Subagents",
    classification: "native",
    group: "execute",
    summary: "roster 与 steer/stop；-32601 时只读 last-known，不假装停止成功。",
    methods: ["subagent.list", "subagent.steer", "subagent.interrupt", "subagent.tail"],
    paths: paths(
      "Workspace → Agents",
      "⌘K → Subagents → 中央面板",
      "底部托盘 → 执行 → Subagents",
    ),
  },
  {
    id: "settings",
    name: "Settings",
    english: "Settings",
    classification: "native",
    group: "manage",
    summary: "逐 key 探测后显示；未知 key 隐藏，不伪造账户/计费/Cloud 设置。",
    methods: ["config.get/set", "model.options", "reload.env"],
    paths: paths(
      "rail footer 齿轮 / ⌘,",
      "bottom dock 菜单 / ⌘,",
      "top strip 齿轮 / ⌘,",
    ),
  },
  {
    id: "plugins",
    name: "Plugins",
    english: "Plugins",
    classification: "read_only",
    group: "manage",
    summary: "只读已安装清单；不加载官方 plugin.js，管理走官方 CLI/Desktop。",
    methods: ["plugins.list", "官方 CLI/Desktop 深链"],
    paths: paths(
      "⌘K → Plugins → 右侧抽屉",
      "⌘K → Plugins → 中央面板",
      "底部能力托盘 → 管理 → Plugins",
    ),
  },
];

export const deferredDomains = [
  {
    id: "voice",
    name: "Voice",
    reason: "voice.* / wake.* 为 older；依赖本地音频与 OS 权限。",
    replacement: "无 v1 入口",
  },
  {
    id: "bots",
    name: "Bots / Bot Mode",
    reason: "Bot Mode 的账号绑定、群聊与投递面尚未裁决。",
    replacement: "Routines 走 Cron",
  },
  {
    id: "memory-graph",
    name: "Memory Graph",
    reason: "learning.* / insights.get 为 older；图渲染成本高。",
    replacement: "Memory 只读上下文",
  },
  {
    id: "kanban",
    name: "Kanban",
    reason: "未发现 gateway API 或官方 Desktop Kanban 事实。",
    replacement: "无 v1 入口",
  },
] as const;

export const refusedMethods = [
  "session.title",
  "session.delete",
  "session.branch",
  "session.archive",
  "session.compress",
  "session.undo",
  "session.close",
  "session.activate",
  "session.cwd.set",
  "session.workspace.move",
  "session.set_hidden",
  "session.status",
  "session.mutate",
  "session.save",
  "session.export",
  "session.prune",
];

export const classificationLabel: Record<Classification, string> = {
  native: "原生",
  read_only: "只读",
  deep_link: "深链",
};

export const groupLabel: Record<DomainGroup, string> = {
  core: "核心",
  manage: "管理",
  execute: "执行",
};

export const domainById = Object.fromEntries(domains.map((domain) => [domain.id, domain])) as Record<
  DomainId,
  CapabilityDomain
>;

export const counts = {
  total: domains.length,
  native: domains.filter((domain) => domain.classification === "native").length,
  readOnly: domains.filter((domain) => domain.classification === "read_only").length,
  deepLink: domains.filter((domain) => domain.classification === "deep_link").length,
  deferred: deferredDomains.length,
};

export interface Scope {
  id: string;
  gateway: string;
  profile: string;
  kind: "LOCAL" | "SSH" | "REMOTE" | "CLOUD";
  host: string;
  latency: string;
}

export const scopes: Scope[] = [
  {
    id: "homelab-research",
    gateway: "HOMELAB",
    profile: "@research",
    kind: "SSH",
    host: "homelab.tailnet",
    latency: "38 ms",
  },
  {
    id: "local-default",
    gateway: "LOCAL",
    profile: "@default",
    kind: "LOCAL",
    host: "this-mac",
    latency: "4 ms",
  },
  {
    id: "cloud-ops",
    gateway: "CLOUD",
    profile: "@ops",
    kind: "CLOUD",
    host: "portal-managed",
    latency: "112 ms",
  },
];

export interface DemoSession {
  id: string;
  title: string;
  preview: string;
  time: string;
  group: "今天" | "昨天";
  scope: string;
  status: "idle" | "running" | "approval";
  unread?: number;
}

export const demoSessions: DemoSession[] = [
  {
    id: "s1",
    title: "发布前检查",
    preview: "Phase 1 能力矩阵已收敛，继续核对 17 个真实入口。",
    time: "刚刚",
    group: "今天",
    scope: "HOMELAB / @research",
    status: "running",
  },
  {
    id: "s2",
    title: "Homelab 部署检查",
    preview: "审批：rm -rf ~/hermes/workspaces/old-build",
    time: "2 分钟前",
    group: "今天",
    scope: "HOMELAB / @research",
    status: "approval",
    unread: 1,
  },
  {
    id: "s3",
    title: "发布说明草稿",
    preview: "把 17 个可达域写成发布说明，延期域不入导航。",
    time: "12 分钟前",
    group: "今天",
    scope: "HOMELAB / @research",
    status: "idle",
  },
  {
    id: "s4",
    title: "MCP 迁移复盘",
    preview: "filesystem + linear 已热重载，4 个工具可见。",
    time: "昨天",
    group: "昨天",
    scope: "HOMELAB / @research",
    status: "idle",
  },
  {
    id: "s5",
    title: "Local 空态设计",
    preview: "保留 720px 对话列，空态只给恢复与两个上下文入口。",
    time: "昨天",
    group: "昨天",
    scope: "LOCAL / @default",
    status: "idle",
  },
];

export interface DemoActivity {
  name: string;
  status: "running" | "done";
  summary: string;
  args: string;
  output: string;
}

export interface DemoMessage {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  time: string;
  host: string;
  content: string;
  activities?: DemoActivity[];
  approval?: boolean;
}

export const messagesBySession: Record<string, DemoMessage[]> = {
  s1: [
    {
      id: "m1",
      role: "user",
      author: "You",
      time: "10:42",
      host: "HOMELAB / @research",
      content: "把 Phase 1 的能力矩阵整理成发布说明。先只列 v1 的真实入口，不要写延期域。",
    },
    {
      id: "m2",
      role: "assistant",
      author: "Hermes",
      time: "10:42",
      host: "HOMELAB / @research",
      content:
        "已按四档矩阵收敛：**17 个可达域**（原生 13 / 只读 3 / 深链 1），**4 个延期域**不进入 v1 导航。当前写入会落在 HOMELAB。",
      activities: [
        {
          name: "session.transcript",
          status: "done",
          summary: "42 messages · 3.2 s",
          args: '{ "session": "phase-1-release-check", "include": ["messages", "tools"] }',
          output: "42 messages · 9 tool calls · 3 checkpoints",
        },
        {
          name: "capability.snapshot",
          status: "done",
          summary: "served · 21 domains · generation 12",
          args: '{ "scope": "HOMELAB/@research", "server_requests": true }',
          output: "native 13 · read_only 3 · deep_link 1 · deferred 4",
        },
      ],
    },
    {
      id: "m3",
      role: "assistant",
      author: "Hermes",
      time: "10:43",
      host: "HOMELAB / @research",
      content:
        "发布说明的骨架已经写好。接下来可以继续生成检查清单，或打开 **Workspace → Artifacts** 查看草稿。所有数据都是原型模拟，不会连接真实 daemon。",
    },
  ],
  s2: [
    {
      id: "m4",
      role: "user",
      author: "You",
      time: "10:36",
      host: "HOMELAB / @research",
      content: "清理旧构建目录，然后重新 attach。命令先给我确认。",
    },
    {
      id: "m5",
      role: "assistant",
      author: "Hermes",
      time: "10:37",
      host: "HOMELAB / @research",
      content: "这条命令会删除 HOMELAB 上的旧构建目录。请确认目标主机、Profile 与工作目录。",
      approval: true,
    },
    {
      id: "m6",
      role: "system",
      author: "HostBridge",
      time: "10:37",
      host: "HOMELAB / @research",
      content: "审批锚定在 owning Session；连接中断时 pending 只读 unverified，绝不改道到其他 Gateway。",
    },
  ],
  s3: [
    {
      id: "m7",
      role: "user",
      author: "You",
      time: "10:28",
      host: "HOMELAB / @research",
      content: "写一版给内部评审的发布说明，重点解释为什么极简壳层仍能抵达全部能力。",
    },
    {
      id: "m8",
      role: "assistant",
      author: "Hermes",
      time: "10:29",
      host: "HOMELAB / @research",
      content:
        "可以。核心论点是：**常驻只保留执行上下文与对话**，其余 12 个域按频率分层披露；但每个入口都必须绑定真实 handler，延期域不出现假按钮。",
      activities: [
        {
          name: "docs.read",
          status: "done",
          summary: "3 files · 18.4 KB",
          args: '{ "paths": ["PRODUCT.md", "DESIGN.md", "issue-12-resolution"] }',
          output: "read-only · no writes",
        },
      ],
    },
  ],
  s4: [
    {
      id: "m9",
      role: "user",
      author: "You",
      time: "昨天",
      host: "HOMELAB / @research",
      content: "复盘一下 MCP 迁移里哪些动作是原生、哪些要深链。",
    },
    {
      id: "m10",
      role: "assistant",
      author: "Hermes",
      time: "昨天",
      host: "HOMELAB / @research",
      content:
        "**原生**：`reload.mcp` 与活动 Gateway 的 server 状态。**深链**：新增、删除与 OAuth 多步流程。older 网关缺 method 时，只留只读列表与 CLI 命令。",
    },
  ],
  s5: [
    {
      id: "m11",
      role: "user",
      author: "You",
      time: "昨天",
      host: "LOCAL / @default",
      content: "空态能不能不放一整块能力目录？",
    },
    {
      id: "m12",
      role: "assistant",
      author: "Hermes",
      time: "昨天",
      host: "LOCAL / @default",
      content:
        "可以。空态只给三个真实动作：恢复最近 Session、打开 `⌘K`、打开 Workspace。Cron 与 Skills 等低频域留在能力索引，不把空态做成仪表盘。",
    },
  ],
};

export const approvalDemo = {
  id: "approval-1",
  command: "rm -rf ~/hermes/workspaces/old-build && hermes gateway attach --json",
  cwd: "/home/roy/workspaces/hermes-destop",
  gateway: "HOMELAB",
  profile: "@research",
  reason: "危险命令：会删除 HOMELAB 上的旧构建目录。",
  sessionId: "s2",
  sessionTitle: "Homelab 部署检查",
};

export const checkpointDemo = [
  { id: "cp1", label: "before registry edit", time: "10:31", files: 3, kind: "auto" },
  { id: "cp2", label: "release notes draft", time: "10:18", files: 5, kind: "manual" },
  { id: "cp3", label: "session start", time: "09:54", files: 0, kind: "auto" },
];

export const skillsDemo = [
  { id: "sk1", name: "release-notes", detail: "从决策票生成发布说明", on: true },
  { id: "sk2", name: "mcp-audit", detail: "列出 server 与工具可见性", on: true },
  { id: "sk3", name: "checkpoint-sweep", detail: "为长 Session 创建自动快照", on: false },
  { id: "sk4", name: "skill-curator", detail: "检查重复与失效技能", on: true },
];

export const toolsDemo = [
  { id: "tl1", name: "shell", detail: "命令执行 · 需审批", on: true },
  { id: "tl2", name: "files", detail: "读写工作区文件", on: true },
  { id: "tl3", name: "web", detail: "搜索与抓取", on: false },
];

export const mcpDemo = [
  { id: "mc1", name: "filesystem", transport: "stdio", tools: 4, status: "ready" },
  { id: "mc2", name: "linear", transport: "http", tools: 7, status: "ready" },
  { id: "mc3", name: "playwright", transport: "stdio", tools: 12, status: "stale" },
];

export const cronDemo = [
  { id: "cr1", name: "晨间 fleet 摘要", schedule: "每天 08:30", next: "明天 08:30", status: "active" },
  { id: "cr2", name: "Worktree 清理提醒", schedule: "每周五 17:00", next: "周五 17:00", status: "active" },
  { id: "cr3", name: "MCP 健康探测", schedule: "每 6 小时", next: "14:00", status: "paused" },
];

export const channelsDemo = [
  { id: "ch1", name: "Telegram", handle: "@hermes_ops", status: "ready" },
  { id: "ch2", name: "Discord", handle: "#build-relay", status: "ready" },
  { id: "ch3", name: "Slack", handle: "#hermes-lab", status: "paused" },
];

export const pluginsDemo = [
  { id: "pl1", name: "hermes-worktree", version: "0.4.2", source: "官方 CLI 安装" },
  { id: "pl2", name: "hermes-remote-preview", version: "0.2.0", source: "官方 CLI 安装" },
];

export const subagentsDemo = [
  {
    id: "sa1",
    name: "release-auditor",
    task: "核对 17 个域的入口与证据行",
    status: "running",
    elapsed: "02:14",
    model: "Sonnet 4.5",
  },
  {
    id: "sa2",
    name: "ia-screenshotter",
    task: "在 1440×900 / 1280×800 截取三变体",
    status: "done",
    elapsed: "01:08",
    model: "GPT-5.2",
  },
];

export const fileTree = [
  {
    name: "workspace",
    path: "~/workspace",
    children: [
      { name: "PRODUCT.md", path: "~/workspace/PRODUCT.md", size: "8.1 KB" },
      { name: "DESIGN.md", path: "~/workspace/DESIGN.md", size: "14.6 KB" },
      { name: "release-notes.md", path: "~/workspace/release-notes.md", size: "4.2 KB" },
      { name: "src", path: "~/workspace/src", children: [
        { name: "App.tsx", path: "~/workspace/src/App.tsx", size: "2.2 KB" },
        { name: "styles.css", path: "~/workspace/src/styles.css", size: "182 KB" },
      ] },
    ],
  },
];

export const artifactsDemo = [
  {
    id: "ar1",
    name: "release-notes.html",
    kind: "HTML",
    updated: "10:43",
    summary: "Phase 1 发布说明草稿 · 17 可达域",
  },
  {
    id: "ar2",
    name: "ia-map.svg",
    kind: "SVG",
    updated: "10:21",
    summary: "三变体永久 vs 隐藏对照",
  },
];

export const terminalBanner = [
  "Hermes Desktop · simulated terminal",
  "host: homelab.tailnet · profile: @research · no live shell",
  "type `help`, `pwd`, `git status`, or `hermes gateway status`",
];

export const variantMeta: Record<Variant, { name: string; shell: string; permanent: string; disclose: string }> = {
  A: {
    name: "Relay Rail",
    shell: "1440 常驻左栏 / 1280 收起 + 720px 对话列 + 右抽屉",
    permanent: "1440 Session rail / 1280 popover · route strip · 720px 对话列 · composer · 能力 counts 一行",
    disclose: "⌘K · 右侧抽屉 · Workspace · 空态",
  },
  B: {
    name: "Quiet Field",
    shell: "无侧栏 + 720px 对话列 + 底部 dock",
    permanent: "route line · 720px 对话列 · composer · bottom dock",
    disclose: "⌘K 命令面板 · 左侧 popover · bottom sheet · 空态",
  },
  C: {
    name: "Dispatch Board",
    shell: "顶部路由/会话条 + 720px 对话列 + 底部能力托盘",
    permanent: "top route/session strip · 720px 对话列 · capability shelf",
    disclose: "底部托盘 · 左侧 Workspace 抽屉 · popover",
  },
};
