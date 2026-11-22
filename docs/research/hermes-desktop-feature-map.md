# 官方 Desktop 功能—API 对照与 plugin SDK 边界

- 调研日期：2026-11-22
- 对应票：[Research：官方 Desktop 功能—API 对照与 plugin SDK 边界](https://github.com/whutlichao/hermes-destop/issues/22)
- 上游源码/文档快照：`NousResearch/hermes-agent@0f602c5f6f18615632535251d62a2db74ce93b69`
- 结论：官方 Desktop 的大多数聊天与管理能力可以落在共享 gateway 的 `hermes-gateway-v1` JSON-RPC 上；但 **OpenRPC 里存在不等于共享 gateway 会服务**——必须按 served / older handler / refused 三档 feature-detect。官方 Desktop 的窗口、快捷键、托盘、HUD、文件对话框、更新器等外壳能力不在 gateway API 内；官方 plugin SDK 依赖宿主自己的 UI registry 与 `window.hermesDesktop` 桥，**不是可移植的插件标准**。

## 1. 官方 Desktop 能力清单（用户可见面）

来源：[Hermes Desktop 文档](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/user-guide/desktop.md)

| 能力面 | 官方 Desktop 提供的内容 | 主要落点 |
| --- | --- | --- |
| Chat | 流式回复、工具活动、Markdown、拖放附件、草稿、右侧预览、时间线、队列编辑、Turn lost 提示 | WS 事件 + `prompt.*` + `session.*` |
| Sessions | 保存会话、跨 profile 并发、搜索、归档、`@session` 链接 | `session.list` / `transcript` / `resume` / `mutate` |
| Model | composer 模型选择、reasoning/effort、favorites、subagent 模型 | `model.options`、`config.get/set`、`session.mutate` |
| Files / Artifacts | 文件树、预览、artifact 画廊、远程下载 | `file.attach` + gateway REST |
| Terminal | 真终端、多 tab、隐藏保活、按 gateway 运行 | `shell.exec`、`terminal.resize` + 本地 PTY |
| Subagents | live roster、steer/stop、tail | `subagent.list/steer/interrupt/tail` |
| Git review | 工作树 diff、stage/revert/commit、worktree、PR | 本地 git/`gh` + agent 工具；非 gateway 核心 |
| Memory Graph | 技能/记忆节点图、时间线、分享 layout code | `learning.*`、`insights.get` |
| Voice | 麦克风、朗读、wake word、HUD 语音 | `voice.*`、`wake.*` + 本地音频 |
| HUD / Quick Entry | 置顶浮条、全局热键、窗口上下文 | 纯 Electron/OS 能力 |
| Settings / onboarding | provider/model/tool/MCP/gateway 设置、首次运行 | `config.*`、`onboarding.*`、`mcp.*` |
| Management panes | Skills、Cron、Profiles、Messaging、Agents/Command Center、Bots | `skills.*`、`cron.*`、`profiles.*`、`connectors.*`、`bot_*` |
| Bot Mode | 每个 profile 一个 bot、群聊、Routines | `bot_relay.*`、`cron.*`、`profiles.*` |
| Plugin SDK | 磁盘 `plugin.js` 扩展 pane/page/命令/主题 | 宿主 registry + `host.request` |

## 2. API 面三档：served / older / refused

官方 OpenRPC 文档有 **264 个 method**；但共享 gateway 的 `/api/ws` dispatch 表把它们分成：

| 档位 | 数量 | 客户端的正确姿势 |
| --- | --- | --- |
| **Served by the gateway** | 112 | 可以按契约原生实现；仍要先读 `runtime.describe` 的 `capabilities` 与 `session_create` |
| **Served for a session the client holds** | 4 | `connection.respond`、`connectors.connect`、`connectors.operation.status`、`connectors.operation.wake`：只对“本客户端持有的 session”原生化；账号级调用走 older handler |
| **Answered by an older handler** | 161 | 可以调用，但 owner 未定（ledger `decision: undecided`）；必须把 `-32601` 当“此处不可用”，不能承诺为稳定 API |
| **Refused（`-32601`）** | 16 | 共享 gateway 明确拒绝；改用替代路径 |
| **Plugin family** | 1 个模式 | `plugin.{plugin_id}.{name}`；owner 声明 `plugin-rpc-v1` 才存在 |

注意：这些数量来自 dispatch 表，不能与 OpenRPC 的 264 个 method 做简单加总；它们是不同视角的清单。

### 16 个 refused 与替代路径

`agents.list`、`session.activate`、`session.archive`、`session.branch`、`session.branch_stored`、`session.branch_whole`、`session.close`、`session.compress`、`session.cwd.set`、`session.delete`、`session.set_hidden`、`session.status`、`session.title`、`session.undo`、`session.usage`、`session.workspace.move`。

共享 gateway 上：

- `session.activate` / `session.close` → `session.resume` / `session.detach`
- 会话列表 → `session.list`（`picker: true`、`scope: "stored"`、`cursor`）
- 历史读取 → `session.transcript`
- 会话变更 → `session.mutate` / `session.save` / `session.export` / `session.prune`，具体字段以 OpenRPC 为准
- `session.status` / `session.usage` → `session.info` / `session.stats` / `session.account_usage`

### Served 档里与“极简桌面端”直接相关的能力

聊天与会话：`runtime.describe`、`session.create`、`session.resume`、`session.detach`、`session.list`、`session.transcript`、`session.history`、`session.info`、`session.stats`、`session.context_breakdown`、`session.events.since`、`prompt.submit`、`prompt.cancel`、`prompt.background`、`prompt.btw`、`prompt.receipt`、`prompt.resolve_unknown`、`prompt.replace_queued`、`prompt.steer_queued`、`session.steer`、`session.redirect`、`session.interrupt`。

审批与交互：`approval.pending`、`approval.received`、`approval.respond`、`clarify.lock`、`clarify.respond`、`command.dispatch`、`commands.catalog`、`complete.path`、`complete.slash`、`slash.exec`。

配置与发现：`config.get`、`config.set`、`model.options`、`profiles.list`、`plugins.list`、`reload.env`、`reload.mcp`、`skills.reload`、`tools.show`、`commands.catalog`。

自动化与执行：`cron.submit`、`cron.cancel`、`cron.status`、`cron.recover`、`process.list`、`process.kill`、`process.stop`、`shell.exec`、`file.attach`、`subagent.list`、`subagent.steer`、`subagent.interrupt`、`subagent.tail`、`rollback.list`、`rollback.diff`、`rollback.restore`、`rollback.session_diff`、`preview.restart`、`image.attach_bytes`、`llm.oneshot`。

团队/群组能力：`groups.*`、`bot_relay.*`、`bot_delivery.list`、`handoff.*`、`a2a.forward`、`worker.*`、`delegation.pause`、`session.automation`。这些是否进入 v1 由能力矩阵票决定，不能因为 served 就默认全做。

来源：

- [Programmatic Integration — Which methods the shared gateway answers](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/developer-guide/programmatic-integration.md#L84-L112)
- [gateway-contract.openrpc.json](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/src/gateway-contract.openrpc.json)

## 3. Older handler 档里的功能与风险

以下官方 Desktop 能力主要落在 older handler，独立客户端可以调用，但不能当作稳定契约：

| 能力 | 相关 method | 风险 |
| --- | --- | --- |
| Skills 管理 | `skills.manage`（安装/启停/删除） | 与 `skills.reload` 不同；owner 未定 |
| Tools / toolsets | `tools.list`、`tools.configure`、`toolsets.list` | 可能只在 TUI/Desktop 的旧 handler 存在 |
| MCP | `mcp.servers.*`、`mcp.catalog` | 含 OAuth 轮询等多步流程，需 `-32601` 降级 |
| Projects / 文件树 | `projects.*` | 大多为 Desktop/Webapp 便利面，不是聊天核心 |
| Voice / Wake | `voice.*`、`wake.*` | 依赖本地音频与 OS 权限 |
| Display / Preview | `display.*`、`preview.*` | `preview.restart` 是 served，其余 display 在 older |
| Vault / Connectors | `vault.*`、`connectors.*` | 凭据与第三方账号，涉及升级门禁 |
| Plugins 管理 | `plugins.manage`、`plugins.catalog.lookup` | 官方 plugin 安装面，独立客户端未兼容 plugin SDK 时不应暴露 |
| Billing / Subscription / Free tier | `billing.*`、`subscription.*`、`free_tier.*` | 与 Hermes Cloud 账号绑定，v1 不做 |
| Desktop metrics | `shared_metrics.desktop_*` | 官方 Desktop 专用遥测；本项目默认无遥测，不实现 |

关键机制：官方文档明确要求 WebSocket 客户端在 `gateway.ready` 后**每连接调用一次** `client.capabilities({server_requests: true})`；不调用会被当作旧客户端，所有 server→client 请求（审批、clarify、sudo、secret 等）立即失败，而不是等待超时。这是新客户端的硬性握手。

来源：[Programmatic Integration — server→client requests](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/developer-guide/programmatic-integration.md#L150-L154)

## 4. Gateway API 之外、必须由桌面外壳自己实现的能力

这些能力在官方 Desktop 中存在，但不属于 `hermes-gateway-v1` 的 JSON-RPC；独立客户端必须自行实现或明确延后：

| 能力 | 为什么不在 gateway API 内 | v1 建议 |
| --- | --- | --- |
| 窗口 / tab / pane / 多窗口 | Electron/React 壳层状态 | 按 Quiet Relay 三区做单窗口单活动聊天；多窗口延后 |
| 快捷键 / 命令面板 / 菜单 | 宿主 UI | 原生实现核心键位 |
| 托盘 / 最小化 / 全局热键 / Quick Entry / HUD | OS 集成 | v1 可不做 HUD；Quick Entry 延后 |
| 文件对话框 / 拖放 / 剪贴板 | Electron 主进程 | 原生实现 |
| 自动更新 / 签名 / 公证 | 发布管线 | v1 不做 |
| 本地仓库扫描 / worktree / PR | 本地 git + `gh` | 二级能力按需；不是 gateway RPC |
| 音频采集 / TTS 播放 / 麦克风权限 | OS + 本地音频 | 二级；依赖 voice provider |
| 远程 artifact 下载 | gateway REST/流式接口，不是 JSON-RPC | 需要单独研究 REST 路由与鉴权头 |
| 远程 OAuth 登录 | 浏览器 loopback + session cookie | 需要 Main 进程 loopback server |
| SSH 隧道 / 本地 gateway attach | 系统 `ssh` + control socket | 已在协议 research 覆盖 |
| 官方 plugin 加载 / 热重载 / UI kit | 宿主 registry 与 `window.hermesDesktop` | v1 明确不做官方 SDK 兼容 |

## 5. Plugin SDK 边界

### 它是什么

- 一个磁盘 ESM 文件：`$HERMES_HOME/desktop-plugins/<id>/plugin.js`；也可作为 unified package 的 `desktop/plugin.js` 或内置插件。
- 只能 import `@hermes/plugin-sdk`、`react`、`react/jsx-runtime`；无 JSX、无构建步骤。
- 通过 `PluginContext.register` 注入 pane、page、sidebar nav、status bar、palette、keybind、theme、composer middleware、settings page 等贡献点。
- `host.request` 就是 gateway JSON-RPC；`host.requestProfile(route, ...)` 可按 registry source + profile 路由，不切换前台。
- `host.connections()` / `host.agents()` / `host.ensureAgent()` / `host.warmAgent()` 暴露多网关 roster，但**不暴露 token 字节**。

### 它不是什么

- **不是沙箱。** 插件在 renderer realm 里以完整 app authority 执行；loader 只做错误隔离。插件能触达 React singleton、整个 SDK 与 `window.hermesDesktop` 原生桥（文件、git、终端、安装）。
- 磁盘插件的信任来自“本地文件本来就能跑代码”；catalog 插件靠人工审核 pinned commit + lint + import allowlist，仍不是安全边界。
- 不是跨客户端标准：`@hermes/plugin-sdk` 绑定官方 Desktop 的 UI registry、nanostore atoms、React Query、UI kit、窗口桥与插件加载器。独立客户端即使复用 gateway 协议，也不能直接运行官方 `plugin.js`。
- `ctx.socket` 在 OAuth remote 上是 no-op，插件必须自备 polling fallback。

来源：

- [Desktop Plugin SDK](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/developer-guide/desktop-plugin-sdk.md)
- [Security model](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/developer-guide/desktop-plugin-sdk.md#L2419-L2448)
- [Host API](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/developer-guide/desktop-plugin-sdk.md#L1379-L1545)
- [Security notes — connections and tokens](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/user-guide/multi-connection-desktop.md#L335-L358)

## 6. 对“全能力可达、分期实现”的可执行分层

以下只是把 research 事实映射到候选分层，**最终取舍由 [Hermes 全能力矩阵与 Phase 1 延期清单](https://github.com/whutlichao/hermes-destop/issues/12) 决定**，本报告不替用户拍板。

| 层 | 候选范围 | 依据 |
| --- | --- | --- |
| **P1 原生（核心）** | 聊天流、会话列表/恢复/transcript、prompt submit/cancel/steer、审批/clarify、profiles、model options、config get/set、cron、skills reload、tools show、subagents、process、shell、file attach、rollback、context breakdown、命令补全 | 全部在 served 档，且有明确契约 |
| **P1 原生（连接）** | Local / Remote HTTP(S) / SSH、连接 registry、多 `(Gateway, Profile)` 常连、切换不丢后台 | 协议 + registry research 已覆盖 |
| **P2 原生（管理面）** | Skills 安装/管理、MCP servers、Projects、Voice/Wake、Display/Preview、Vault/Connectors、plugin 管理 | 多在 older handler；需逐项 feature-detect 与降级 |
| **P2/只读或深链** | Hermes Cloud portal、Billing/Subscription、Free tier、Desktop metrics、官方 plugin 安装 | 账号/平台绑定，或不属于本项目目标 |
| **明确不做（v1）** | 官方 Desktop plugin.js 兼容、HUD/Quick Entry/托盘全家桶、多窗口/tab 布局、自动更新/签名 | 外壳成本高，且不影响“极简 + 全能力真实入口”的核心 |

## 7. 对地图票的直接影响

- [Hermes 全能力矩阵与 Phase 1 延期清单](https://github.com/whutlichao/hermes-destop/issues/12)：必须按 served / older / refused 三档，而不是按 OpenRPC 全量承诺；每个延期项要写明“无入口 / 只读 / 深链”的真实形态。
- [插件与扩展面策略](https://github.com/whutlichao/hermes-destop/issues/16)：官方 plugin SDK 依赖宿主 UI registry 与原生桥，v1 兼容成本高；若要兼容，需要单独的 adapter/宿主实现，不能声称“加载官方 plugin.js 即可”。
- [极简壳层 IA 与能力披露路径](https://github.com/whutlichao/hermes-destop/issues/13)：三级能力必须在 UI 明确标注“只读/在官方 Desktop 打开”，且不得留假按钮；`-32601` 时要显示真实不可用，而不是静默失败。
- [HostBridge 契约与 Electron 安全边界](https://github.com/whutlichao/hermes-destop/issues/8)：HostBridge 只投影 typed request/event 与能力探测结果；不暴露 token、URL、SSH key、原始 `window.hermesDesktop` 桥。

## 8. 一手出处

- [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [Connecting Desktop to Many Hermes Instances](https://hermes-agent.nousresearch.com/docs/user-guide/multi-connection-desktop)
- [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Gateway Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)
- [Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
- [Features Overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview)
- 上游源码：<https://github.com/NousResearch/hermes-agent/tree/0f602c5f6f18615632535251d62a2db74ce93b69>
