# 官方 Hermes Gateway 协议与可复用客户端面

- 调研日期：2026-11-22
- 对应票：[Research：官方 Hermes Gateway 协议与可复用客户端面](https://github.com/whutlichao/hermes-destop/issues/20)
- 上游源码快照：`NousResearch/hermes-agent@0f602c5f6f18615632535251d62a2db74ce93b69`（sparse checkout：`apps/desktop/electron`、`apps/shared/src`、`apps/desktop/src/lib`）
- 结论：独立客户端应把 `hermes-gateway-v1` WebSocket JSON-RPC 作为主控制面，Local / Remote / SSH 只负责产出 `{url, protocols, profile_id, instance_id}`；`@hermes/shared` 是可复用的 Node 客户端来源，但必须 vendor 固定子集并记录上游 commit。

## 1. 三条连接路径

| 路径 | 官方入口 | 客户端要做什么 | 关键约束 |
| --- | --- | --- | --- |
| Local | `hermes gateway attach --json` 或直接读 local control socket | 取 `url`、`protocols`、`endpoint`；每次重连重新 attach | ticket 单次使用、30 秒 TTL；loopback；请求无 `Origin`；subprotocol 必须是 `hermes-gateway-v1` + `hermes-gateway-ticket.<ticket>` |
| Remote HTTP(S) | 对端运行 `hermes serve`（或 dashboard 后端） | 对 base URL 做 HTTP + WebSocket 双检；用 session token / OAuth / legacy cookie 认证 | 绑定非 loopback 会触发 auth gate；`/api/ws` 与 HTTP 是两条腿；代理可能只放行 HTTP 而挡 WS |
| SSH | 系统 `ssh` + `hermes gateway tickets --probe/--serve` + `hermes gateway attach --start` | 探测 `purposes`/`windows_service_session`；建 `ssh -L`；保持一条长生命周期 `tickets --serve` channel | `interactive` ticket 可让一条 socket 服务多 Profile；否则退回 `attach` 的单 Profile ticket；Windows session 0 只 attach 不 start |

官方文档：

- [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [Gateway over SSH: client contract](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-ssh-clients)
- [Gateway Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)
- [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)

### Local control socket 的实际形状

`apps/shared/src/node/control-socket.vectors.json` 把 local control socket 固定为“一行 JSON 请求、一行 JSON 回复”的 protocol 1：

- `resolve-profile`：返回 `state`、`attachable`、`update_fenced`、`control`、`install_code_sha` 与 `endpoint`；`endpoint` 含 `api_origin`、`profile_id`、`instance_id`、`authority_epoch`、`runtime_protocol`、`capabilities`、`code_sha`、`ws_url`、`ws_protocol`、`ticket_protocol_prefix`。
- `session-ticket`：请求 `profile_id`、`instance_id`、`purpose`（`interactive` / `native-http` / `native-profile-create` / `native-profile-registry`）；回复 `ticket` 与 `expires_in_seconds: 30`。
- 错误是稳定可判别的：`stale runtime instance`、`bootstrap binding rejected`、`invalid bootstrap envelope/parameters`、`authenticated runtime bootstrap unavailable`。

来源：[control-socket.vectors.json](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/src/node/control-socket.vectors.json)

## 2. `hermes-gateway-v1` 主控制面

官方 OpenRPC 文档有 264 个 method，但不是每个 method 都由 shared gateway 实际服务。公开文档把它们分成：

- **Served by the gateway**：112 个，含 `runtime.describe`、`session.create`、`session.resume`、`session.list`、`session.transcript`、`prompt.submit`、`prompt.cancel`、`approval.respond`、`clarify.respond`、`session.steer`、`session.redirect`、`session.interrupt`、`rollback.list/restore/diff`、`subagent.list/steer/interrupt/tail`、`process.list/kill/stop`、`skills.reload`、`cron.submit/cancel/status/recover`、`shell.exec`、`file.attach`、`commands.catalog` 等。
- **Answered by an older handler**：161 个，含 `mcp.servers.*`、`tools.list/configure`、`skills.manage`、`voice.*`、`wake.*`、`pet.*`、`billing.*`、`subscription.*`、`connectors.*`、`vault.*`、`display.*`、`projects.*`、`plugins.manage` 等。客户端必须把 `-32601` 当作“这个 owner 不提供该能力”，不能假设存在。
- **Refused**：16 个，含 `agents.list`、`session.activate`、`session.close`、`session.delete`、`session.title`、`session.branch` 等；shared gateway 上应改用 `session.resume` / `session.detach` / `session.mutate` 等替代路径。

来源：

- [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration#which-methods-the-shared-gateway-answers)
- [gateway-contract.openrpc.json](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/src/gateway-contract.openrpc.json)

### 会话与审批

- `session.create` 前先读 `runtime.describe`，确认 `session_create.sources` 与 `session_create.parameters`；`client: { name, version }` 只在 owner 声明 `client` 时发送。
- `prompt.submit` 接受 `submission_id`、附件、`truncate_before_row_id` / `truncate_before_user_ordinal` + `confirm_truncate` 等 rewind 参数；不要在普通提交中残留截断参数。
- 审批、clarify、sudo/secret、vault、connection、terminal/preview 是 **server→client JSON-RPC request**，不是 event；客户端必须用同一个 id 回复，未实现的 method 应回 `-32601` 让 agent fail fast。
- 事件通过 `gateway.ready`、`message.*`、`prompt.*`、`approval.request/settled`、`tool.*` 等流式推送；canonical 事件带 `authority_epoch` / `execution_generation`，审批回复必须带 `session_id`、`execution_generation`、`prompt_id`、`choice`。

来源：[Gateway Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)、[gateway-types.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/src/gateway-types.ts)、[gateway-events.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/src/gateway-events.ts)

## 3. 可 vendoring 的官方客户端代码

`@hermes/shared` 是 `private: true` 的 workspace 包，不能直接作为 npm 依赖安装；但它是 MIT，可 vendor 固定子集。最小可用集合：

| 文件/导出 | 作用 |
| --- | --- |
| `src/node/gateway-client.ts` (`./gateway-client`) | ticketed WebSocket dial、`runtime.describe`、`session.create` contract、重连 + 有界 owner recovery、typed request/event |
| `src/gateway-types.ts` (`./gateway-types`) | `AnyGatewayEvent`、canonical prompt/approval 类型 |
| `src/gateway-events.ts` (`./gateway-events`) | 事件 map 与 framing 类型 |
| `src/gateway-canonical.ts` (`./gateway-canonical`) | canonical request/result 适配、`session.create`/`prompt.submit` 参数规范化 |
| `src/json-rpc-channel.ts` (`./json-rpc-channel`) | JSON-RPC 请求关联、timeout、heartbeat、server request 分发 |
| `src/reconnect-backoff.ts` (`./reconnect-backoff`) | 1s→30s 指数退避 |

`gateway-client.ts` 的 `GatewayClient` 构造参数是 `connect(start, recover)`，每次重连都会重新调用；这正好对应 Local/SSH 的“每次重连重新 attach/ticket”。它不关心 URL 从哪来，适合把 transport 留在 Main 进程。

来源：[apps/shared/package.json](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/package.json)、[gateway-client.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/shared/src/node/gateway-client.ts)

## 4. 主要风险

1. **协议漂移**：OpenRPC 有 264 个 method，但 served / older / refused 会随上游变化；必须用 `runtime.describe` 能力协商，不能把 method 列表写死。
2. **ticket 泄漏**：ticket 是凭据，30 秒单次；不能写日志、URL、Renderer 配置。所有 attach/ticket 输出只在 Main 进程解析。
3. **`Origin` guard**：Local 与 SSH-forwarded 请求必须无 `Origin`；浏览器/WSP 默认会带 Origin，所以不能从 Renderer 直连。
4. **SSH Windows session 0**：`windows_service_session: true` 时只能 `attach`，不能 `--start`；错误提示要指向“在普通用户桌面启动 Hermes”。
5. **版本错配**：`attach` 返回的 `client_code_sha` 与 `endpoint.code_sha` 不一致时，说明 gateway 在 `hermes update` 后仍跑旧代码；应提示重启 gateway，而不是继续 attach。
6. **older handler 的语义**：161 个 method 由 older handler 回答，部分能力可能只在 Desktop/Webapp 的 REST 层存在；Capability Matrix 票必须逐项核实，不能按 OpenRPC 存在就承诺原生。

## 5. 对地图票的直接影响

- [HostBridge 契约与 Electron 安全边界](https://github.com/whutlichao/hermes-destop/issues/8)：HostBridge 只投影 typed request/event，不暴露 ticket/URL/凭据；所有 attach/ticket 在 Main。
- [ConnectionSupervisor 与 always-connected 连接生命周期](https://github.com/whutlichao/hermes-destop/issues/9)：每个 `(Gateway, Profile)` 的逻辑连接可由 `GatewayClient` + `connect(start, recover)` 承接；支持 `interactive` 时复用一条 socket。
- [Local backend attach/ensure 与版本恢复契约](https://github.com/whutlichao/hermes-destop/issues/11)：直接使用 `attach --json` / `ensure` 与 control socket 的 `resolve-profile` / `session-ticket`，不要自造 bootstrap。
- [Hermes 全能力矩阵与 Phase 1 延期清单](https://github.com/whutlichao/hermes-destop/issues/12)：以 served / older / refused 三档和 `runtime.describe` 为依据，逐项决定 native / read-only / deep-link / deferred。

## 6. 一手出处

- Hermes Desktop：<https://hermes-agent.nousresearch.com/docs/user-guide/desktop>
- Programmatic Integration：<https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration>
- Gateway over SSH：<https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-ssh-clients>
- Gateway Internals：<https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals>
- Desktop Plugin SDK：<https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk>
- 上游快照：<https://github.com/NousResearch/hermes-agent/tree/0f602c5f6f18615632535251d62a2db74ce93b69>
