import type {
  Artifact,
  Bot,
  Channel,
  Checkpoint,
  CronJob,
  FileNode,
  Gateway,
  McpServer,
  MemoryFile,
  Profile,
  Routine,
  Session,
  Skill,
  Subagent,
  Toolset,
} from "../types";
import artifactLatency from "../assets/artifact-latency.svg";

export const gateways: Gateway[] = [
  {
    id: "local",
    name: "This device",
    kind: "local",
    health: "reachable",
    latencyMs: 3,
    primary: false,
    appManaged: true,
    auth: "automatic",
    host: "127.0.0.1",
    detail: "Hermes runtime managed by this app",
    lastTest: "Reachable · HTTP 200 · WS open",
    lastTestTone: "ok",
    update: "idle",
    color: "#16181B",
  },
  {
    id: "homelab",
    name: "Homelab",
    kind: "ssh",
    health: "reachable",
    latencyMs: 24,
    primary: true,
    appManaged: false,
    auth: "ssh-key",
    host: "omer@homelab.lan:22",
    detail: "hermes gateway attach · managed tunnel",
    lastTest: "Reachable · HTTP 200 · WS open",
    lastTestTone: "ok",
    update: "idle",
    color: "#C8442E",
  },
  {
    id: "vps1",
    name: "VPS-1",
    kind: "remote",
    health: "degraded",
    latencyMs: 86,
    primary: false,
    appManaged: false,
    auth: "session-token",
    host: "https://vps1.hermes.run",
    detail: "hermes serve · Tailscale",
    lastTest: "Reachable · WS 86 ms",
    lastTestTone: "warn",
    update: "idle",
    color: "#2447C6",
  },
  {
    id: "cloud",
    name: "Hermes Cloud",
    kind: "cloud",
    health: "reachable",
    latencyMs: 120,
    primary: false,
    appManaged: false,
    auth: "portal",
    host: "cloud.hermes.run",
    detail: "Portal-managed instance",
    lastTest: "Reachable · platform-managed",
    lastTestTone: "ok",
    update: "skipped",
    color: "#3D7A55",
  },
  {
    id: "studio",
    name: "Studio Mac",
    kind: "remote",
    health: "error",
    latencyMs: null,
    primary: false,
    appManaged: false,
    auth: "oauth",
    host: "https://studio.hermes.run",
    detail: "hermes serve · LAN",
    lastTest: "Error · WS handshake timed out",
    lastTestTone: "error",
    update: "error",
    color: "#9A6A00",
  },
];

export const profiles: Profile[] = [
  {
    id: "default",
    gatewayId: "local",
    name: "default",
    handle: "@default",
    color: "#16181B",
    model: "Opus 4.5",
    effort: "High",
    initials: "D",
  },
  {
    id: "work",
    gatewayId: "local",
    name: "work",
    handle: "@work-local",
    color: "#6B6F76",
    model: "Sonnet 4.5",
    effort: "Medium",
    initials: "W",
  },
  {
    id: "research",
    gatewayId: "homelab",
    name: "research",
    handle: "@research-homelab",
    color: "#C8442E",
    model: "Opus 4.5",
    effort: "High",
    initials: "R",
  },
  {
    id: "ops",
    gatewayId: "homelab",
    name: "ops",
    handle: "@ops-homelab",
    color: "#9A6A00",
    model: "Sonnet 4.5",
    effort: "Medium",
    initials: "O",
  },
  {
    id: "vps-research",
    gatewayId: "vps1",
    name: "research",
    handle: "@research-vps-1",
    color: "#2447C6",
    model: "GPT-5.2",
    effort: "High",
    initials: "V",
  },
  {
    id: "cloud-ops",
    gatewayId: "cloud",
    name: "ops",
    handle: "@ops-cloud",
    color: "#3D7A55",
    model: "Opus 4.5",
    effort: "Low",
    initials: "C",
  },
  {
    id: "cloud-writer",
    gatewayId: "cloud",
    name: "writer",
    handle: "@writer-cloud",
    color: "#6B4E9A",
    model: "Sonnet 4.5",
    effort: "Medium",
    initials: "W",
  },
];

const localCheckpoints: Checkpoint[] = [
  {
    id: "cp-local-3",
    label: "Turn 4 · before build",
    time: "11:38",
    files: 6,
    kind: "auto",
    status: "available",
  },
  {
    id: "cp-local-2",
    label: "Turn 3 · before tidy",
    time: "11:21",
    files: 2,
    kind: "auto",
    status: "available",
  },
  {
    id: "cp-local-1",
    label: "Manual snapshot",
    time: "10:56",
    files: 14,
    kind: "manual",
    status: "available",
  },
];

const homelabCheckpoints: Checkpoint[] = [
  {
    id: "cp-hml-3",
    label: "Turn 6 · before dist cleanup",
    time: "11:39",
    files: 9,
    kind: "auto",
    status: "available",
  },
  {
    id: "cp-hml-2",
    label: "Turn 5 · after MCP reload",
    time: "11:32",
    files: 1,
    kind: "auto",
    status: "available",
  },
  {
    id: "cp-hml-1",
    label: "Manual snapshot",
    time: "10:47",
    files: 18,
    kind: "manual",
    status: "available",
  },
];

export const sessions: Session[] = [
  {
    id: "s-local-notes",
    gatewayId: "local",
    profileId: "default",
    title: "整理今日 Hermes 变更",
    preview: "本地 gateway · 3 个 tool 调用 · 刚刚",
    updatedAt: "刚刚",
    group: "today",
    pinned: true,
    checkpoints: localCheckpoints,
    messages: [
      {
        id: "m-local-1",
        role: "user",
        content: "把今天的 Hermes 变更整理成一页 brief，并检查本地 gateway。",
        time: "11:42",
        host: "LOCAL",
      },
      {
        id: "m-local-2",
        role: "assistant",
        time: "11:42",
        host: "THIS DEVICE",
        author: "Hermes",
        content:
          "本地 gateway 正常，当前 profile 是 `default`。我把今天的变更压缩成三条，先确认没有遗漏。\n\n- Desktop 多网关注册表：SSH 连接会复用 one-use ticket。\n- MCP 热重载只对活动 gateway 生效。\n- Checkpoints 仍是 per-session opt-in。\n\n需要我把这份 brief 存成 artifact，并清理旧的 `dist/` 吗？",
        activities: [
          {
            id: "a-local-status",
            name: "gateway_status",
            status: "done",
            summary: "HTTP 200 · 3 ms · WS open",
            args: '{ "leg": "http+ws", "profile": "default" }',
            output: '{ "gateway": "reachable", "latency_ms": 3, "profiles": 2 }',
          },
          {
            id: "a-local-read",
            name: "filesystem.read",
            status: "done",
            summary: "3 files · 1.8 KB",
            args: '{ "paths": ["CHANGELOG.md", "docs/desktop.md", "docs/gateways.md"] }',
            output: "Read 3 files. 42 changed lines summarised.",
          },
        ],
        approval: {
          id: "approval-local-build",
          command: "rm -rf ./dist && pnpm build",
          cwd: "~/hermes-web",
          targetGateway: "local",
          targetProfile: "default",
          status: "pending",
        },
      },
    ],
  },
  {
    id: "s-local-work",
    gatewayId: "local",
    profileId: "work",
    title: "Workspace README 校对",
    preview: "work profile · 昨天 18:12",
    updatedAt: "昨天",
    group: "yesterday",
    pinned: false,
    checkpoints: [
      { id: "cp-work-1", label: "Turn 2 · before copy edit", time: "18:04", files: 2, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-work-1",
        role: "user",
        content: "把 README 的运行步骤改成同事能直接照做的版本，不要加营销话术。",
        time: "18:10",
        host: "LOCAL",
      },
      {
        id: "m-work-2",
        role: "assistant",
        content:
          "已按「环境、命令、验证」三段重排。保留原有技术细节，删掉了两处夸张形容词。需要我把改动同步到 `docs/setup.md` 吗？",
        time: "18:12",
        host: "THIS DEVICE",
        author: "Hermes",
        activities: [
          { id: "a-work-edit", name: "patch", status: "done", summary: "README.md · +18 −9", args: '{ "path": "README.md" }', output: "Applied 1 patch." },
        ],
      },
    ],
  },
  {
    id: "s-homelab-deploy",
    gatewayId: "homelab",
    profileId: "research",
    title: "Homelab 部署检查",
    preview: "MCP 热重载 · 24 ms · 2 分钟前",
    updatedAt: "2 分钟前",
    group: "today",
    pinned: false,
    checkpoints: homelabCheckpoints,
    messages: [
      {
        id: "m-hml-1",
        role: "user",
        content: "检查 homelab 上的 gateway，然后帮我把 MCP 热重载打开。不要碰 prod profile。",
        time: "11:42",
        host: "LOCAL",
      },
      {
        id: "m-hml-2",
        role: "assistant",
        content:
          "先确认 gateway 与 MCP 的当前状态。我只读取配置，不会重启服务。\n\nGateway 在线，当前 profile 是 **research**。两个 MCP server 都在：**filesystem** 已启用，**github** 待重载。热重载已完成，下一步需要清理上次构建留下的 `dist/`，再重新生成 artifacts。",
        time: "11:42",
        host: "HOMELAB · RESEARCH",
        author: "Hermes",
        activities: [
          {
            id: "a-hml-status",
            name: "gateway_status",
            status: "done",
            summary: "HTTP 200 · 24 ms",
            args: '{ "leg": "http+ws", "profile": "research" }',
            output:
              '{\n  "gateway": "reachable",  "latency_ms": 24,\n  "profile": "research",\n  "mcp": { "filesystem": "ready", "github": "stale" }\n}',
          },
          {
            id: "a-hml-reload",
            name: "mcp.reload",
            status: "done",
            summary: "live session · 7 tools · 312 ms",
            args: '{ "server": "github", "scope": "live-session" }',
            output: "✓ reloaded · 7 tools · 312 ms",
            image: artifactLatency,
          },
        ],
        approval: {
          id: "approval-hml-build",
          command: "rm -rf ./dist && pnpm build",
          cwd: "~/hermes-web",
          targetGateway: "homelab",
          targetProfile: "research",
          status: "pending",
        },
      },
    ],
  },
  {
    id: "s-mcp-fail",
    gatewayId: "homelab",
    profileId: "research",
    title: "MCP 热重载失败",
    preview: "github server · 18 分钟前",
    updatedAt: "18 分钟前",
    group: "today",
    pinned: false,
    checkpoints: [
      { id: "cp-mcp-1", label: "Turn 2 · before env fix", time: "11:24", files: 1, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-mcp-1",
        role: "user",
        content: "github MCP 又掉线了，先别重启 gateway，看看能不能热重载。",
        time: "11:24",
        host: "LOCAL",
      },
      {
        id: "m-mcp-2",
        role: "assistant",
        content:
          "热重载被 gateway 拒绝了：`GITHUB_TOKEN` 在 SSH 登录环境里不可见。现有 session 仍在，但新工具不会挂上来。\n\n我建议先补环境变量，再重试；不建议此时重启整个 gateway。",
        time: "11:25",
        host: "HOMELAB · RESEARCH",
        author: "Hermes",
        activities: [
          {
            id: "a-mcp-fail",
            name: "mcp.reload",
            status: "error",
            summary: "HTTP 502 · token missing",
            args: '{ "server": "github", "scope": "live-session" }',
            output: "Error: GITHUB_TOKEN is not present in the remote login environment.",
          },
        ],
      },
    ],
  },
  {
    id: "s-cron-review",
    gatewayId: "homelab",
    profileId: "ops",
    title: "周报 cron 审查",
    preview: "All profiles · 41 分钟前",
    updatedAt: "41 分钟前",
    group: "today",
    pinned: false,
    checkpoints: [
      { id: "cp-cron-1", label: "Turn 1 · before schedule edit", time: "11:01", files: 1, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-cron-1",
        role: "user",
        content: "周报 cron 最近两次都跑了 12 分钟，看看是不是 prompt 太长。",
        time: "11:01",
        host: "LOCAL",
      },
      {
        id: "m-cron-2",
        role: "assistant",
        content:
          "两次运行都卡在同一个 web search 分支。Job 本身没有失败，但 12 分钟里大约 9 分钟在等待外部请求。\n\n可以把搜索改成预取，或把 timeout 从 90s 降到 45s。",
        time: "11:03",
        host: "HOMELAB · OPS",
        author: "Hermes",
        activities: [
          { id: "a-cron-history", name: "cron.history", status: "done", summary: "2 runs · 12m 08s / 12m 41s", args: '{ "job": "weekly-research-brief" }', output: "Both runs waited on web search." },
        ],
      },
    ],
  },
  {
    id: "s-vps-research",
    gatewayId: "vps1",
    profileId: "vps-research",
    title: "VPS 上的检索实验",
    preview: "GPT-5.2 · 86 ms · 昨天",
    updatedAt: "昨天",
    group: "yesterday",
    pinned: false,
    checkpoints: [
      { id: "cp-vps-1", label: "Turn 3 · before bench", time: "16:22", files: 4, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-vps-1",
        role: "user",
        content: "在 VPS-1 上跑一下这个检索脚本，结果放 artifacts，不要动 Homelab。",
        time: "16:18",
        host: "LOCAL",
      },
      {
        id: "m-vps-2",
        role: "assistant",
        content:
          "已在 **VPS-1 / research** 上运行。脚本读取了 42 个 RSS 源，去重后留下 17 条，生成 `research-signals.md`。\n\n这台机器的 WebSocket 腿是 86 ms，比 Homelab 慢，但没有丢连接。",
        time: "16:22",
        host: "VPS-1 · RESEARCH",
        author: "Hermes",
        activities: [
          { id: "a-vps-run", name: "terminal.exec", status: "done", summary: "python3 fetch_signals.py · 41.2s", args: '{ "cwd": "/srv/hermes/research" }', output: "42 feeds → 17 unique signals" },
        ],
      },
    ],
  },
  {
    id: "s-cloud-ops",
    gatewayId: "cloud",
    profileId: "cloud-ops",
    title: "Cloud 成本摘要",
    preview: "platform-managed · 昨天 18:00",
    updatedAt: "昨天",
    group: "yesterday",
    pinned: false,
    checkpoints: [
      { id: "cp-cloud-1", label: "Turn 2 · before digest", time: "18:03", files: 1, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-cloud-1",
        role: "user",
        content: "把 Hermes Cloud 昨天的成本摘要整理一下，重点看 subagent 的 token。",
        time: "18:01",
        host: "LOCAL",
      },
      {
        id: "m-cloud-2",
        role: "assistant",
        content:
          "昨天总成本比前一日低 8%。主要变化是 subagent 批次从 6 个降到 4 个，但单批 token 上升了 11%。\n\nCloud 由平台管理更新，本地不提供 shell；终端会回落到 This device。",
        time: "18:03",
        host: "HERMES CLOUD · OPS",
        author: "Hermes",
        activities: [
          { id: "a-cloud-digest", name: "cloud.usage", status: "done", summary: "24h · 4 subagent batches", args: '{ "window": "24h", "group_by": "subagent" }', output: "Cost −8% · tokens/batch +11%" },
        ],
      },
    ],
  },
  {
    id: "s-bot-research",
    gatewayId: "homelab",
    profileId: "research",
    title: "Research · Bot Chat",
    preview: "release notes 的第二段再压一下",
    updatedAt: "4 分钟前",
    group: "today",
    pinned: false,
    botId: "bot-research-homelab",
    checkpoints: [
      { id: "cp-bot-r-1", label: "Turn 8 · before rewrite", time: "11:36", files: 2, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-bot-r-1",
        role: "user",
        content: "把 Hermes 这周的 release notes 压缩成给团队看的 5 条，重点写多网关和 MCP。",
        time: "11:34",
        host: "LOCAL",
      },
      {
        id: "m-bot-r-2",
        role: "assistant",
        content:
          "已整理成 5 条，先给你看结构：\n\n1. **Gateway registry** 统一了 Local / Remote / SSH / Cloud 四种连接。\n2. 每个 gateway 的 profile 都有独立 socket，后台任务不会因切换而中断。\n3. **MCP hot reload** 只对活动 gateway 生效，避免把配置推错机器。\n4. Checkpoints 仍然默认关闭，但 Desktop 里可以按 turn 回滚。\n5. Telegram Quick Setup 保存凭据后必须重启 gateway。\n\n第二段我还可以再压 20%，要更短吗？",
        time: "11:36",
        host: "HOMELAB · RESEARCH",
        author: "Research",
        activities: [
          { id: "a-bot-r-read", name: "docs.read", status: "done", summary: "desktop.md · multi-connection.md", args: '{ "source": "hermes-agent docs" }', output: "Read 2 docs, 1,482 lines." },
        ],
      },
    ],
  },
  {
    id: "s-cloud-writer-notes",
    gatewayId: "cloud",
    profileId: "cloud-writer",
    title: "发布节奏草稿",
    preview: "草稿 · 25 分钟前",
    updatedAt: "25 分钟前",
    group: "today",
    pinned: false,
    checkpoints: [
      { id: "cp-writer-1", label: "Turn 1 · before outline", time: "10:50", files: 1, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-writer-1",
        role: "user",
        content: "把 Hermes 的更新写成三条推文，不要用感叹号。",
        time: "10:52",
        host: "LOCAL",
      },
      {
        id: "m-writer-2",
        role: "assistant",
        content:
          "三条草稿已放到 artifacts。语气保持克制，每条只讲一个变化：多网关注册表、执行上下文提示、MCP 热重载边界。",
        time: "10:54",
        host: "HERMES CLOUD · WRITER",
        author: "Hermes",
      },
    ],
  },
  {
    id: "s-bot-ops",
    gatewayId: "vps1",
    profileId: "vps-research",
    title: "Ops · Bot Chat",
    preview: "磁盘 78% · cron 正常",
    updatedAt: "12 分钟前",
    group: "today",
    pinned: false,
    botId: "bot-ops-vps",
    checkpoints: [
      { id: "cp-bot-o-1", label: "Turn 4 · before cleanup", time: "11:18", files: 1, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-bot-o-1",
        role: "user",
        content: "巡检一下 VPS-1，磁盘和 cron 都看一下。",
        time: "11:16",
        host: "LOCAL",
      },
      {
        id: "m-bot-o-2",
        role: "assistant",
        content:
          "VPS-1 正常。磁盘 **78%**，比昨天高 4%，主要是 `~/.hermes/checkpoints/store`。Cron 队列没有堆积，最近 6 次全部成功。\n\n建议今晚清一次 7 天前的 checkpoint，预计释放 1.2 GB。",
        time: "11:18",
        host: "VPS-1 · RESEARCH",
        author: "Ops",
        activities: [
          { id: "a-bot-o-run", name: "terminal.exec", status: "done", summary: "df -h · hermes cron list", args: '{ "host": "vps1" }', output: "disk 78% · 6/6 cron runs ok" },
        ],
      },
    ],
  },
  {
    id: "s-bot-writer",
    gatewayId: "cloud",
    profileId: "cloud-writer",
    title: "Writer · Bot Chat",
    preview: "三条推文草稿已放到 artifacts",
    updatedAt: "25 分钟前",
    group: "today",
    pinned: false,
    botId: "bot-writer-cloud",
    checkpoints: [
      { id: "cp-bot-w-1", label: "Turn 2 · before draft", time: "10:58", files: 1, kind: "auto", status: "available" },
    ],
    messages: [
      {
        id: "m-bot-w-1",
        role: "user",
        content: "把研究笔记写成三条推文，语气克制一点，不要用感叹号。",
        time: "10:56",
        host: "LOCAL",
      },
      {
        id: "m-bot-w-2",
        role: "assistant",
        content:
          "三条草稿已放到 artifacts：\n\n1. 一个桌面客户端同时连接本地、SSH、远程和 Cloud gateway。切换不打断后台任务。\n2. 每个 `(gateway, profile)` 都是独立执行上下文。输入框上方始终显示消息会落在哪台机器。\n3. MCP 热重载只对活动 gateway 生效；其他机器的配置在下次 session 生效。",
        time: "10:58",
        host: "HERMES CLOUD · WRITER",
        author: "Writer",
      },
    ],
  },
];

export const channels: Channel[] = [
  { id: "tg-homelab", gatewayId: "homelab", profileId: "research", name: "Telegram", kind: "Telegram", handle: "@hermes_research_bot", connected: true, status: "ready" },
  { id: "discord-homelab", gatewayId: "homelab", profileId: "research", name: "Discord", kind: "Discord", handle: "#hermes-ops", connected: false, status: "paused" },
  { id: "slack-local", gatewayId: "local", profileId: "default", name: "Slack", kind: "Slack", handle: "#local-lab", connected: true, status: "ready" },
  { id: "wa-vps", gatewayId: "vps1", profileId: "vps-research", name: "WhatsApp", kind: "WhatsApp", handle: "+86 ··· 2048", connected: true, status: "ready" },
  { id: "signal-cloud", gatewayId: "cloud", profileId: "cloud-ops", name: "Signal", kind: "Signal", handle: "+1 ··· 9910", connected: false, status: "paused" },
  { id: "webhook-cloud", gatewayId: "cloud", profileId: "cloud-ops", name: "Webhook", kind: "Webhook", handle: "ci/build", connected: true, status: "ready" },
];

export const cronJobs: CronJob[] = [
  {
    id: "cron-weekly-brief",
    gatewayId: "homelab",
    profileId: "research",
    name: "Weekly research brief",
    schedule: "0 9 * * 1",
    nextRun: "Mon 09:00",
    lastRun: "Mon 09:00 · 2m 14s",
    status: "active",
    history: [
      { id: "run-1", at: "Mon 09:00", result: "success", duration: "2m 14s" },
      { id: "run-2", at: "Mon 08:59", result: "success", duration: "2m 08s" },
      { id: "run-3", at: "Mon 08:58", result: "success", duration: "2m 31s" },
    ],
  },
  {
    id: "cron-inbox",
    gatewayId: "local",
    profileId: "default",
    name: "Inbox triage",
    schedule: "*/30 * * * *",
    nextRun: "12:00",
    lastRun: "11:30 · 18s",
    status: "active",
    heartbeat: true,
    history: [
      { id: "run-4", at: "11:30", result: "success", duration: "18s" },
      { id: "run-5", at: "11:00", result: "success", duration: "21s" },
    ],
  },
  {
    id: "cron-cloud-digest",
    gatewayId: "cloud",
    profileId: "cloud-ops",
    name: "Cloud cost digest",
    schedule: "0 18 * * *",
    nextRun: "18:00",
    lastRun: "昨天 18:00 · 44s",
    status: "paused",
    history: [
      { id: "run-6", at: "昨天 18:00", result: "success", duration: "44s" },
      { id: "run-7", at: "前天 18:00", result: "error", duration: "1m 02s" },
    ],
  },
  {
    id: "cron-release-loop",
    gatewayId: "homelab",
    profileId: "research",
    name: "Release watch loop",
    schedule: "loop · every 15m",
    nextRun: "15m",
    lastRun: "3m ago · 9s",
    status: "active",
    loop: true,
    history: [
      { id: "run-8", at: "3m ago", result: "success", duration: "9s" },
      { id: "run-9", at: "18m ago", result: "success", duration: "11s" },
    ],
  },
];

export const mcpServers: McpServer[] = [
  {
    id: "mcp-filesystem",
    gatewayId: "homelab",
    profileId: "research",
    name: "filesystem",
    transport: "stdio",
    status: "ready",
    tools: ["read", "write", "list", "stat"],
    enabled: true,
    filters: ["read", "write", "list", "stat"],
  },
  {
    id: "mcp-github",
    gatewayId: "homelab",
    profileId: "research",
    name: "github",
    transport: "http",
    status: "stale",
    tools: ["issues", "pulls", "repos", "search", "commits", "reviews", "actions"],
    enabled: true,
    filters: ["issues", "pulls", "repos", "search"],
  },
  {
    id: "mcp-fetch",
    gatewayId: "homelab",
    profileId: "research",
    name: "fetch",
    transport: "stdio",
    status: "ready",
    tools: ["fetch_url", "extract_markdown"],
    enabled: true,
    filters: ["fetch_url", "extract_markdown"],
  },
  {
    id: "mcp-postgres",
    gatewayId: "vps1",
    profileId: "vps-research",
    name: "postgres",
    transport: "stdio",
    status: "ready",
    tools: ["query", "schema", "explain", "list_tables"],
    enabled: true,
    filters: ["query", "schema", "list_tables"],
  },
  {
    id: "mcp-slack",
    gatewayId: "local",
    profileId: "default",
    name: "slack",
    transport: "http",
    status: "ready",
    tools: ["history", "post", "search", "users", "channels"],
    enabled: true,
    filters: ["history", "post", "search"],
  },
];

export const skills: Skill[] = [
  {
    id: "skill-hermes-docs",
    name: "hermes-docs",
    description: "Read and cite the official Hermes Agent documentation.",
    category: "Research",
    installed: true,
    enabled: true,
    source: "bundled",
    curator: "Curator kept · last verified 2h ago",
  },
  {
    id: "skill-github-pr",
    name: "github-pr-workflow",
    description: "Branch, commit, and open PRs with a clean review trail.",
    category: "Engineering",
    installed: true,
    enabled: true,
    source: "bundled",
    curator: "Curator kept · used 8 times",
  },
  {
    id: "skill-impeccable",
    name: "impeccable",
    description: "Design, critique, and polish production interfaces.",
    category: "Design",
    installed: true,
    enabled: true,
    source: "hub",
    curator: "Curator suggestion · update available",
  },
  {
    id: "skill-tdd",
    name: "test-driven-development",
    description: "Red-green-refactor with integration tests that matter.",
    category: "Engineering",
    installed: true,
    enabled: false,
    source: "bundled",
    curator: "Curator kept · disabled by user",
  },
  {
    id: "skill-design-md",
    name: "design-md",
    description: "Turn an implemented interface into a durable design system.",
    category: "Design",
    installed: false,
    enabled: false,
    source: "hub",
  },
  {
    id: "skill-deep-research",
    name: "deep-research",
    description: "Multi-source research with citations and a written report.",
    category: "Research",
    installed: false,
    enabled: false,
    source: "hub",
  },
  {
    id: "skill-browser-use",
    name: "browser-use",
    description: "Drive a real browser to verify and capture web UI.",
    category: "Engineering",
    installed: false,
    enabled: false,
    source: "hub",
  },
  {
    id: "skill-office-docs",
    name: "office-docs",
    description: "Create and inspect DOCX / XLSX / PPTX deliverables.",
    category: "Ops",
    installed: false,
    enabled: false,
    source: "hub",
  },
];

export const toolsets: Toolset[] = [
  { id: "tool-web", name: "Web", description: "Search and fetch pages with source citations.", enabled: true, examples: "web_search, web_fetch" },
  { id: "tool-terminal", name: "Terminal", description: "Run shells, scripts, and host commands.", enabled: true, examples: "terminal, process" },
  { id: "tool-files", name: "Files", description: "Read, write, patch, and inspect host files.", enabled: true, examples: "read_file, patch, list" },
  { id: "tool-browser", name: "Browser", description: "Drive Chromium for verification and screenshots.", enabled: false, examples: "browser_navigate, browser_click" },
  { id: "tool-media", name: "Media", description: "Vision, image generation, TTS, and transcription.", enabled: false, examples: "vision_analyze, image_generate" },
  { id: "tool-memory", name: "Memory", description: "Read and curate MEMORY.md and USER.md.", enabled: true, examples: "memory_read, memory_write" },
  { id: "tool-delegation", name: "Delegation", description: "Spawn isolated subagents and review work.", enabled: true, examples: "delegate_task, review_pr" },
  { id: "tool-mcp", name: "MCP", description: "Expose tools from connected MCP servers.", enabled: true, examples: "mcp.filesystem.read" },
];

export function createMemoryFiles(): MemoryFile[] {
  const rows: Array<{ gatewayId: string; profileId: string; user: string; role: string }> = [
    { gatewayId: "local", profileId: "default", user: "Lin", role: "solo builder" },
    { gatewayId: "local", profileId: "work", user: "Lin", role: "work profile" },
    { gatewayId: "homelab", profileId: "research", user: "Lin", role: "research lead" },
    { gatewayId: "homelab", profileId: "ops", user: "Lin", role: "homelab operator" },
    { gatewayId: "vps1", profileId: "vps-research", user: "Lin", role: "remote researcher" },
    { gatewayId: "cloud", profileId: "cloud-ops", user: "Lin", role: "cloud operator" },
    { gatewayId: "cloud", profileId: "cloud-writer", user: "Lin", role: "editorial writer" },
  ];

  return rows.flatMap(({ gatewayId, profileId, user, role }) => [
    {
      id: `mem-${gatewayId}-${profileId}`,
      gatewayId,
      profileId,
      name: "MEMORY.md" as const,
      content: `# MEMORY\n\n- ${user} prefers concise, evidence-first answers.\n- This agent runs on ${gatewayId} / ${profileId} (${role}).\n- Never assume another gateway's filesystem or credentials are in scope.\n- Ask before destructive commands; show the exact command and target host.\n- Prefer plain Chinese with English technical terms: Gateway, Profile, MCP, Cron, Worktree, Checkpoint.`,
    },
    {
      id: `user-${gatewayId}-${profileId}`,
      gatewayId,
      profileId,
      name: "USER.md" as const,
      content: `# USER\n\n- Name: ${user}\n- Timezone: Asia/Shanghai\n- Working style: keyboard-first, low tolerance for dashboard clutter.\n- Wants to know which machine will execute a command before approving it.\n- Prefers a short answer first; details on request.`,
    },
    {
      id: `soul-${gatewayId}-${profileId}`,
      gatewayId,
      profileId,
      name: "SOUL.md" as const,
      content: `# SOUL\n\nYou are Hermes on ${gatewayId}/${profileId}: calm, direct, and careful with state.\n\n- Name the execution host when it matters.\n- Keep tool work inspectable, never theatrical.\n- Preserve running work across context switches.\n- Treat rollback as a safety tool, not a time machine.`,
    },
  ]);
}

export const artifacts: Artifact[] = [
  {
    id: "art-gateway-check",
    gatewayId: "homelab",
    profileId: "research",
    sessionId: "s-homelab-deploy",
    name: "gateway-check.md",
    kind: "markdown",
    updatedAt: "2 分钟前",
    size: "4.2 KB",
    summary: "Homelab gateway, MCP and profile audit",
    markdown:
      "# Homelab gateway check\n\n- Gateway: reachable · 24 ms\n- Profile: research\n- MCP: filesystem ready, github reloaded\n- Pending: clean dist/ and rebuild artifacts\n\n## Next\n\nApprove the build card, then verify the artifact directory.",
  },
  {
    id: "art-latency",
    gatewayId: "homelab",
    profileId: "research",
    sessionId: "s-homelab-deploy",
    name: "gateway-latency.html",
    kind: "html",
    updatedAt: "2 分钟前",
    size: "12.8 KB",
    summary: "Gateway HTTP + WebSocket latency report",
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:34px;background:#f7f7f5;color:#16181b;font:14px/1.6 -apple-system,"PingFang SC",sans-serif}
      h1{font-size:26px;letter-spacing:-.03em;margin:0 0 4px} p{margin:0 0 28px;color:#61656c}
      .row{display:grid;grid-template-columns:110px 1fr 54px;align-items:center;gap:12px;margin:12px 0;font-size:12px}
      .bar{height:8px;background:#e4e4dc;position:relative}.bar i{display:block;height:100%;background:#c8442e}
      .note{margin-top:28px;padding-top:14px;border-top:1px solid #d8d8d0;color:#767a81;font-size:11px}
    </style></head><body>
      <h1>Gateway latency</h1><p>HTTP + WebSocket probe · 5 samples · simulated</p>
      <div class="row"><span>This device</span><span class="bar"><i style="width:5%"></i></span><b>3 ms</b></div>
      <div class="row"><span>Homelab</span><span class="bar"><i style="width:22%"></i></span><b>24 ms</b></div>
      <div class="row"><span>VPS-1</span><span class="bar"><i style="width:58%"></i></span><b>86 ms</b></div>
      <div class="row"><span>Hermes Cloud</span><span class="bar"><i style="width:72%"></i></span><b>120 ms</b></div>
      <div class="note">A pass means both the HTTP and WebSocket legs answered. Prototype data only.</div>
    </body></html>`,
  },
  {
    id: "art-changes",
    gatewayId: "local",
    profileId: "default",
    sessionId: "s-local-notes",
    name: "hermes-changes.html",
    kind: "html",
    updatedAt: "刚刚",
    size: "9.1 KB",
    summary: "Today's Hermes Desktop change brief",
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:34px;background:#f7f7f5;color:#16181b;font:14px/1.65 -apple-system,"PingFang SC",sans-serif}
      h1{font-size:28px;letter-spacing:-.035em;margin:0 0 4px} .meta{color:#767a81;font:10px/1.5 "SF Mono",monospace;letter-spacing:.04em}
      h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;margin:30px 0 8px;color:#61656c}
      p{margin:0 0 14px;max-width:60ch} b{font-weight:600}
    </style></head><body>
      <h1>Today at Hermes</h1><div class="meta">FRIDAY · 22 NOV 2026 · LOCAL / DEFAULT</div>
      <h2>Multi-gateway</h2><p>One desktop registry now holds <b>Local</b>, <b>Remote HTTP</b>, <b>SSH</b>, and <b>Hermes Cloud</b> connections. Every gateway stays connected; switching never stops background work.</p>
      <h2>Safety</h2><p>MCP hot reload is limited to the gateway the window is connected to. Edits on other machines apply on their next session.</p>
      <h2>Recovery</h2><p>Checkpoints remain per-session and opt-in. Restoring a snapshot keeps hand edits unless a full restore is chosen.</p>
    </body></html>`,
  },
  {
    id: "art-cloud-digest",
    gatewayId: "cloud",
    profileId: "cloud-ops",
    sessionId: "s-cloud-ops",
    name: "cost-digest.md",
    kind: "markdown",
    updatedAt: "昨天",
    size: "2.6 KB",
    summary: "Hermes Cloud 24h cost digest",
    markdown:
      "# Cloud cost digest\n\n- Total cost: −8% day over day\n- Subagent batches: 6 → 4\n- Tokens per batch: +11%\n- Managed updates: platform-managed\n",
  },
];

export const filesByGateway: Record<string, FileNode[]> = {
  local: [
    {
      id: "f-local-home",
      name: "workspace",
      kind: "folder",
      path: "~/workspace",
      children: [
        { id: "f-local-notes", name: "notes.md", kind: "file", path: "~/workspace/notes.md", ext: "md", content: "# Notes\n\n- Keep the default screen quiet.\n- Show execution host before a destructive command.\n- Hide is not close.\n" },
        { id: "f-local-config", name: "hermes.config.yaml", kind: "file", path: "~/workspace/hermes.config.yaml", ext: "yaml", content: "model:\n  default: Opus 4.5\n  reasoning: high\ncheckpoints:\n  enabled: true\n" },
        {
          id: "f-local-src",
          name: "hermes-web",
          kind: "folder",
          path: "~/workspace/hermes-web",
          children: [
            { id: "f-local-app", name: "App.tsx", kind: "file", path: "~/workspace/hermes-web/src/App.tsx", ext: "tsx", content: "export function App() {\n  return <Chat />;\n}\n" },
            { id: "f-local-readme", name: "README.md", kind: "file", path: "~/workspace/hermes-web/README.md", ext: "md", content: "# Hermes Web\n\nRun `pnpm dev` and connect a gateway.\n" },
          ],
        },
      ],
    },
  ],
  homelab: [
    {
      id: "f-hml-home",
      name: "hermes-web",
      kind: "folder",
      path: "~/hermes-web",
      children: [
        {
          id: "f-hml-src",
          name: "src",
          kind: "folder",
          path: "~/hermes-web/src",
          children: [
            { id: "f-hml-mcp", name: "mcp.ts", kind: "file", path: "~/hermes-web/src/mcp.ts", ext: "ts", content: "export async function reload(server: string) {\n  return gateway.request(\"mcp.reload\", { server, scope: \"live-session\" });\n}\n" },
            { id: "f-hml-app", name: "App.tsx", kind: "file", path: "~/hermes-web/src/App.tsx", ext: "tsx", content: "export function App() {\n  return <GatewaySwitcher />;\n}\n" },
          ],
        },
        {
          id: "f-hml-docs",
          name: "docs",
          kind: "folder",
          path: "~/hermes-web/docs",
          children: [
            { id: "f-hml-answer", name: "prototype-answer.md", kind: "file", path: "~/hermes-web/docs/prototype-answer.md", ext: "md", content: "# Prototype answer\n\nThis build is a simulation.\n" },
            { id: "f-hml-adr", name: "adr-004-scope.md", kind: "file", path: "~/hermes-web/docs/adr-004-scope.md", ext: "md", content: "# Scope\n\nEvery surface follows (gateway, profile).\n" },
          ],
        },
        { id: "f-hml-package", name: "package.json", kind: "file", path: "~/hermes-web/package.json", ext: "json", content: "{\n  \"name\": \"hermes-web\",\n  \"private\": true\n}\n" },
        { id: "f-hml-dist", name: "dist", kind: "folder", path: "~/hermes-web/dist", children: [] },
      ],
    },
  ],
  vps1: [
    {
      id: "f-vps-home",
      name: "srv",
      kind: "folder",
      path: "/srv/hermes",
      children: [
        { id: "f-vps-config", name: "config.yaml", kind: "file", path: "/srv/hermes/config.yaml", ext: "yaml", content: "terminal:\n  cwd: /srv/hermes\nmcp:\n  postgres: enabled\n" },
        { id: "f-vps-runbook", name: "runbook.md", kind: "file", path: "/srv/hermes/runbook.md", ext: "md", content: "# VPS runbook\n\n- Check disk weekly.\n- Prune checkpoints older than 7 days.\n- Never expose the dashboard without a sign-in provider.\n" },
      ],
    },
  ],
  cloud: [
    {
      id: "f-cloud-home",
      name: "cloud",
      kind: "folder",
      path: "/cloud/ops",
      children: [
        { id: "f-cloud-cost", name: "cost-digest.md", kind: "file", path: "/cloud/ops/cost-digest.md", ext: "md", content: "# Cloud cost digest\n\nManaged by Hermes Cloud. Read-only from this desktop.\n" },
      ],
    },
  ],
  studio: [],
};

export const subagents: Subagent[] = [
  {
    id: "sub-research",
    gatewayId: "homelab",
    profileId: "research",
    name: "research-worker",
    task: "扫描 Hermes 文档中的 multi-gateway 行为",
    status: "running",
    elapsed: "02:14",
    model: "Sonnet 4.5",
    activity: "读取 docs/multi-connection-desktop.md",
    transcript: [
      "Loaded PRODUCT.md and the official Desktop docs.",
      "Indexed the registry, scope and update sections.",
      "Currently checking SSH one-use ticket behaviour.",
    ],
  },
  {
    id: "sub-review",
    gatewayId: "homelab",
    profileId: "research",
    name: "code-review",
    task: "审查 gateway switcher 状态机",
    status: "running",
    elapsed: "01:08",
    model: "Opus 4.5",
    activity: "检查 scoped selectors 与 hot-reload guard",
    transcript: ["Read src/state/store.ts.", "Comparing scope reset rules against the docs.", "One finding queued for the parent."],
  },
  {
    id: "sub-docs",
    gatewayId: "local",
    profileId: "default",
    name: "docs-writer",
    task: "整理 README 验证步骤",
    status: "done",
    elapsed: "04:31",
    model: "Sonnet 4.5",
    activity: "完成 · 6 个步骤",
    transcript: ["Drafted install, typecheck, build and screenshot steps.", "Removed two marketing phrases.", "Returned the patch to the parent."],
  },
  {
    id: "sub-vps",
    gatewayId: "vps1",
    profileId: "vps-research",
    name: "log-triage",
    task: "检查 VPS gateway 日志",
    status: "stopped",
    elapsed: "00:46",
    model: "GPT-5.2",
    activity: "已停止 · 用户接管",
    transcript: ["Found a slow WebSocket handshake.", "Stopped after the parent took over."],
  },
];

export const bots: Bot[] = [
  {
    id: "bot-research-homelab",
    name: "Research",
    handle: "@research-homelab",
    gatewayId: "homelab",
    profileId: "research",
    title: "Research lead",
    avatar: "R",
    color: "#C8442E",
    latest: "release notes 的第二段再压一下",
    unread: 2,
    status: "active",
    section: "Team",
    sessionId: "s-bot-research",
  },
  {
    id: "bot-ops-vps",
    name: "Ops",
    handle: "@ops-vps-1",
    gatewayId: "vps1",
    profileId: "vps-research",
    title: "Site reliability",
    avatar: "O",
    color: "#2447C6",
    latest: "磁盘 78% · cron 正常",
    unread: 0,
    status: "idle",
    section: "Team",
    sessionId: "s-bot-ops",
  },
  {
    id: "bot-writer-cloud",
    name: "Writer",
    handle: "@writer-cloud",
    gatewayId: "cloud",
    profileId: "cloud-writer",
    title: "Editorial",
    avatar: "W",
    color: "#6B4E9A",
    latest: "三条推文草稿已放到 artifacts",
    unread: 1,
    status: "idle",
    section: "Studio",
    sessionId: "s-bot-writer",
  },
];

export const routines: Routine[] = [
  { id: "routine-research", botId: "bot-research-homelab", gatewayId: "homelab", profileId: "research", name: "Release notes sweep", schedule: "每天 08:30", nextRun: "明天 08:30", status: "active" },
  { id: "routine-ops", botId: "bot-ops-vps", gatewayId: "vps1", profileId: "vps-research", name: "Disk + cron check", schedule: "每 6 小时", nextRun: "17:00", status: "active" },
  { id: "routine-writer", botId: "bot-writer-cloud", gatewayId: "cloud", profileId: "cloud-writer", name: "Draft thread", schedule: "周二 / 周四", nextRun: "周二 10:00", status: "paused" },
];

export const initialTerminalLines = [
  "Hermes terminal · simulated host shell",
  "Type `help` for demo commands. This shell is not connected to a real gateway.",
];
