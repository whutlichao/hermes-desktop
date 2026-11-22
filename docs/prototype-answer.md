# Hermes Desktop Quiet Relay 原型交付说明

## Answer

已在隔离分支 `hermes-desktop-prototype` 交付 Hermes Desktop 的可交互桌面原型。视觉方向为用户确认的 **B. 静默邮路 / Quiet Relay**：纸白、墨黑、邮政朱红路由线，常驻 `YOU → HOMELAB → @research` 执行上下文串，720px 对话列，`⌘K` 命令面板、Gateway/Profile 切换器、Capabilities 抽屉与可 Hide/Close 的 Workspace 轨道。

功能覆盖已按确认的 A/B/C/D 四类全部落地：多 Gateway（Local / Remote HTTP(S) / SSH / Hermes Cloud）与 Profile 作用域切换；流式对话、Markdown/代码、工具轨迹、Dangerous Approval、`@`/`/`、附件、模型与 reasoning、prompt history、Session 搜索/置顶/分组、Checkpoint；Skills、Tools、MCP、Memory、Cron、Channels、Settings；Artifacts、Files、Git、Subagents、Terminal、Voice、Bot Mode。所有 Gateway 健康度、延迟、SSH、Cloud、Telegram QR、语音、终端、Git 与更新结果均为明确标注的原型模拟，不声称连接真实 Hermes daemon。

交付物包括 `PRODUCT.md`、`DESIGN.md`、`.impeccable/config.json`、`.impeccable/design.json`、`.impeccable/surfaces/desktop-app.md`、Vite + React + TypeScript 源码、`README.md` 与本文件。PR 以 PR-only 方式保持开启等待人工 review，不自动合并；本文件按交付规则不记录 PR number 与 CI 状态，PR 编号、body 路径和最终 HEAD CI 读取记录在仓库外 ledger，最终 PR HEAD 由协调者复查。

## Skill 执行证据

- **Skill 名称**：`impeccable`
- **文件路径**：`/Users/apple/.agents/skills/impeccable/SKILL.md`
- **调用方式**：如实记录为**直接读取 SKILL.md + 调用其 CLI 脚本**，不是宿主原生 `$impeccable` 调用。未把直接读取写成 native invocation。
- **执行的脚本**：`impeccable context`、`impeccable concept-seed --scope direction --mode operate`、`impeccable shot`、`impeccable surface-brief read`、`impeccable detect src --json`。
- **执行前上下文**：worktree 根目录；`.impeccable/config.json` 记录 `buildPath: "code"`；`impeccable context` 初始输出为 `productPath PRODUCT.md`、`designPath null`、`surfaceBriefPath null`、`hasVisualImplementation false`、`platform web`，账户状态为 `ACCOUNT: not signed in`。
- **视觉方向过程**：`concept-seed` 以 Operate mode 完成 direction roll，记录 reference `seed:656fc4c4345c1029`。dealt catalog challengers 为 `vernacular-ephemera-cassette-j-card`、`rw-manual-acetate-tab-board`、`pop-culture-shelf-doujin-event-catalog`、`wayfinding-cartography-signage-terminal-yellow-wayfinding`、`emigre-bitmap-specimen`、`signals-instruments-split-flap-concourse`。Quiet Relay 不是 dice assignment；它是与 Meridian、Signal Yellow 并列的三条自选 grounded directions 之一。由于协调者未提供可监控的浏览器选择页，选择动作通过 `orchestration ask` 升级给协调者，用户明确选择 **B. 静默邮路 Quiet Relay**。该事实同时写入 `.impeccable/surfaces/desktop-app.md` 的 FORM 块。
- **craft-floor 合规**：在写 UI 前读取 `/Users/apple/.agents/skills/impeccable/reference/craft-floor.md`。核对结果：正文/占位符对比度、阴影偏移与柔化、标题上方没有 kicker/eyebrow、无渐变文字、无装饰性玻璃、无双轴网格/条纹背景、状态不只依赖颜色、文本measure 在 720px 列内、`prefers-reduced-motion` 生效、焦点环/选区/caret/scrollbar 均已主题化。发现并移除了 Capabilities、Gateway switcher、Checkpoint、Memory Graph、QR、Shortcuts、Bot form 与 fresh-session 的 eyebrow；把 `@`/`/`/附件菜单保留为功能性控件而非永久面板。
- **截图验收**：使用 `impeccable shot` 渲染最终 `dist`，覆盖 1440×900 与 1280×800 的 5 个核心状态，并额外检查 13 个扩展状态。所有截图均为最终源码构建后的页面。
- **设计产物**：`DESIGN.md` 含 token-bearing frontmatter；`.impeccable/design.json` 为 schemaVersion 2 sidecar，包含 17 个颜色的 tonal ramp、7 个 typography roles、4 个阴影、4 个 motion token、4 个 breakpoints、10 个可独立渲染的组件 snippet。`PRODUCT.md`、`DESIGN.md`、`.impeccable/config.json`、`.impeccable/design.json`、`.impeccable/surfaces/` 均提交。

## 视觉系统摘要

- **世界**：Quiet Relay。邮路/调度单据的形式语言：细线、圆点、箭头、测量标签、纸面与墨色。
- **主色**：Paper `#f7f7f5`、Raised Paper `#fbfbf8`、Ink `#16181b`、Postal Vermilion `#c8442e`、Accent Text `#a73826`、Hairline `#e2e2db`。
- **字体**：Schibsted Grotesk（拉丁标题/正文，中文字符回退 PingFang SC）；Spline Sans Mono（路径、延迟、模型名、终端、代码）。所有字体自托管，不请求 Google Fonts。
- **布局**：232px Session rail + 720px 对话列 + 关闭态 448px Workspace rail；在 1380px 与 1220px 断点收窄，1280×800 下不产生横向滚动。
- **签名组件**：常驻路由串、Dangerous Approval 卡、Hide/Close 轨道、`⌘K` 命令面板。
- **动效**：路由 leg 到达 420ms ease-out；抽屉 300ms；所有动效在 reduced-motion 下压到 0.01ms。

## 验证证据

### 1. 红 → 绿 TDD

先写 `src/state/store.test.ts`，在 `src/state/store.ts` 尚不存在时运行 `pnpm test`，得到预期红测：

```text
$ vitest run
FAIL  src/state/store.test.ts [ src/state/store.test.ts ]
Error: Failed to load url ./store ... Does the file exist?
Test Files  1 failed (1)
Tests  no tests
[ELIFECYCLE] Test failed.
```

实现 reducer 与 selectors 后，最终绿测：

```text
$ vitest run
✓ src/state/store.test.ts (8 tests) 5ms
Test Files  1 passed (1)
Tests  8 passed (8)
Start at  12:12:59
Duration  300ms
```

8 项测试覆盖：

1. Local → Homelab 同时重绑 sessions、channels、Cron、MCP，并保留跨 scope 数据。
2. MCP hot reload 只对 active Gateway 的 capability scope 为真。
3. All Profiles 显示 union，同时 active `(gateway, profile)` 保持明确。
4. Hide 保留 terminal scrollback 与 mounted body；Close 释放，重新打开回到初始 shell。
5. Channel 变更后 persistent restart banner 保持，直到 `RESTART_GATEWAY`。
6. Dangerous approval 解析后目标 host 不变。
7. Inspect 后仍可 Approve（修复了 inspected 状态锁死后续决策的问题）。
8. 移除承载 active bot 的 Gateway 后回到 Local sessions，capabilities/settings scope 同步回 Local。

### 2. TypeScript

```text
$ pnpm exec tsc --noEmit
EXIT: 0
```

`tsconfig.json` 开启 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`，`src` 与 `vite.config.ts` 均纳入检查。

### 3. Production build

```text
$ pnpm build
vite v6.4.6 building for production...
✓ 1850 modules transformed.
dist/assets/index-DqyGYuB_.css   115.84 kB │ gzip: 18.34 kB
dist/assets/index-DYY9yGZM.js    545.34 kB │ gzip: 162.32 kB
✓ built in 1.26s
EXIT: 0
```

构建有一条非失败警告：单一 JS chunk 约 545 kB，超过 Vite 默认 500 kB 提示。原因为原型把字体、Markdown/highlighting、图标与全部交互界面打进单一入口；不影响构建或运行。若进入生产化阶段，应按 Capabilities / Workspace / Settings 做动态 import 分包。

### 4. Browser interaction / accessibility check

除状态层单测外，使用本机 Playwright（Chromium 1248）对最终 `dist` 跑真实交互检查，结果：

```text
PASS focus-return, Cmd/Ctrl+K, Escape, gateway re-scope, MCP scope guard,
     Hide/Close, approval, no overflow, console clean
```

验证内容：

- 从命令面板触发按钮打开 `⌘K` 后焦点进入搜索框；`Escape` 关闭并把焦点还给触发按钮。
- `⌘K` 全局快捷键、`ArrowDown` 选择移动、`Escape` 关闭均生效。
- Capabilities 抽屉同样返回焦点。
- 点击 Homelab 后 route 变为 `HOMELAB`、session 切到「Homelab 部署检查」、composer 出现 `REMOTE CONTEXT`。
- MCP 在 active Homelab scope 显示「热重载全部」；把 capability scope 切到非活动 Local 后按钮消失并显示只读作用域提示。
- Workspace 中运行 `hermes gateway status` 后 Hide，rail 仍以 `is-hidden` + `aria-hidden` 存在于 DOM；重新打开仍能看到该命令输出；Close 后 rail 卸载；再次打开回到初始 shell banner。
- 危险命令 Inspect 后 Approve 仍可执行，系统消息写明目标 Homelab。
- 1280×800 无页面级横向溢出，浏览器 console 无错误（补了 inline SVG favicon 消除唯一的 `/favicon.ico` 404）。

### 5. Design detector

```text
$ impeccable detect src --json
[]
EXIT: 0
```

### 6. 截图验收

最终构建后使用 `impeccable shot` 逐状态渲染并打开检查。五张核心状态的两种尺寸：

| 状态 | 1440×900 | 1280×800 | 检查结果 |
| --- | --- | --- | --- |
| 1. Local 默认对话 | `/tmp/hermes-final3-local/1440x900.png` | `/tmp/hermes-final3-local/1280x800.png` | 720px 列居中，路由、工具行、Approval、Checkpoint、composer、statusbar 完整；无裁切 |
| 2. Remote + Gateway switcher | `/tmp/hermes-final3-remote/1440x900.png` | `/tmp/hermes-final3-remote/1280x800.png` | 四类连接、Primary、health/latency、profile、return-to-last、Test/Update all 可见；popover 不被窗口裁切 |
| 3. `⌘K` 命令面板 | `/tmp/hermes-final3-palette/1440x900.png` | `/tmp/hermes-final3-palette/1280x800.png` | 分组、键盘提示、选中态、scope strip 清晰；无背景误交互 |
| 4. Capabilities（Skills） | `/tmp/hermes-final3-capabilities/1440x900.png` | `/tmp/hermes-final3-capabilities/1280x800.png` | Scope 标签不再换行；nav、Curator、installed、Hub 完整；1280 下内容可滚动 |
| 5. Workspace（Artifacts） | `/tmp/hermes-final3-workspace/1440x900.png` | `/tmp/hermes-final3-workspace/1280x800.png` | 对话列与 420px rail 不重叠；artifact 预览、Annotate、Hide/Close 完整 |

额外检查的 13 个状态（1440×900 与 1280×800）：

```text
mcp, memory, cron, channels, terminal, git, agents, bots,
checkpoints, memory-graph, settings, registry, all-profiles
```

对应截图在 `/tmp/hermes-final2-<state>/`。检查结论：无控件重叠、无横向裁切、无 composer/statusbar 遮挡；1280×800 下抽屉与设置弹窗均保持可滚动，默认对话停在顶部而非强制滚到底部。

### 7. 评审过程中修复的视觉/交互缺陷

- Capabilities 顶部的 scope 文案在 1280 下被压成多行 → 改为 `Scope` 并给 scope 容器 `white-space: nowrap` / `flex-shrink: 0`。
- 命令面板无条件挂载导致隐藏层参与布局/焦点 → 只在 `overlay === "palette"` 时渲染。
- 默认 Session 初次打开自动滚到底部 → 切换 Session 回到顶部，只有新消息才跟随底部。
- Demo 页 Toast 覆盖 composer → 非 `local` demo 启动时清除初始 toast。
- 表单 label 未与原生控件关联 → `Field` 改为包裹式 `<label>`。
- 命令面板与 Gateway switcher 缺少焦点陷阱 → 统一 `useFocusTrap`，并以 `getClientRects()` 过滤不可见元素；Escape 返回触发控件。
- Annotate 遮罩拦截点击 → pin 放置恢复可用，并自动把 pin 作为 composer context chip。
- `@` 选择后残留字符 → 选择完成即移除末尾 `@`。
- Edit Gateway 保存后无验证 → 保存即触发模拟 Test。
- 移除 Gateway 后可能留下 stale bot / stale capability scope → reducer 同步清理 active bot、sidebar mode、capability/settings scope 与 updateStates。
- Settings 的 Model 保存作用域与“Applies to”不一致 → 新增 `SET_PROFILE_MODEL`，保存到所选 profile；聊天内模型选择也回写 active profile。
- Approved/Denied 后不允许再操作，inspected 后又被锁死 → reducer 只把 approved/denied 视为终态。
- 标题上方 kicker/eyebrow 违反 craft-floor ban → 全部移除。

## Hermes 功能对照表

状态说明：**实现** = 原型内可操作；**模拟** = 交互与数据完整，但不发起真实外部操作；“模拟”是全部 Gateway/网络相关功能的共同边界。

### A. 多 Gateway 与 Profile

| 能力 | 状态 | 实现位置 / 验收 |
| --- | --- | --- |
| Local / Remote HTTP(S) / SSH / Cloud 四类连接 | 实现 + 模拟 | `src/data/seed.ts` 5 个 Gateway；`Settings.tsx` 类型选择器、auth 选项、SSH `hermes gateway attach` 与一次性 ticket 文案、Cloud Portal-managed |
| Gateway registry、Primary、唯一设备名 | 实现 | `ADD_GATEWAY` / `EDIT_GATEWAY` 拒绝重复名；Local/App-managed 不可移除；`SET_PRIMARY` 同步 `primary` 旗标 |
| health / latency 常驻 | 实现 + 模拟 | route bar、侧栏 scope card、statusbar、registry row、switcher row 均显示文本状态与 ms |
| 启动时回到 last-used Gateway | 实现（UI 状态） | Gateway switcher footer toggle；写入 `returnToLastGateway` 并给 toast；不跨页面 reload 持久化 |
| Test（HTTP + WS） | 实现 + 模拟 | `simulateGatewayTest`：950ms 后返回 `Reachable · HTTP 200 · WS open` 或 `WS handshake timed out`，更新 health/lastTest/latency |
| Add / Edit / Remove Gateway | 实现 | Settings → Gateways；Add/Edit 表单；Remove 有确认与 scope 清理；删除后实例数据本身不删除 |
| Update all instances fan-out | 实现 + 模拟 | Cloud 标记 `skipped/platform-managed`；不可达 `error`；其余逐行 `updating → done` |
| 快速 Gateway/Profile switcher | 实现 | `GatewaySwitcher.tsx`，每个 Gateway 行与 profile 卡可切换 |
| All Profiles union 视图 | 实现 | sidebar 分组显示 `Gateway / @profile`；`scopedSessions` 保留 active scope 明确 |
| Sessions/channels/Cron/memory/files/MCP/settings 重绑 | 实现 | `profileDefaults`、`workspaceForScope` 与各 scope selectors；单测覆盖 sessions/channels/cron/MCP |
| Local vs Remote/SSH/Cloud 环境提示 | 实现 | route string、composer context、statusbar、workspace rail subtitle、switcher 行、banner；状态以文字 + 结构表达 |

### B. 核心对话与执行

| 能力 | 状态 | 实现位置 / 验收 |
| --- | --- | --- |
| 流式回答模拟 | 实现 + 模拟 | `Chat.tsx` streaming caret + 本地 timer；可发送 prompt / demo turns / stop |
| Markdown 与代码渲染、复制 | 实现 | `react-markdown` + GFM + highlight；`CopyButton` |
| 工具调用行折叠/展开 | 实现 | Activity row 展开 args/output/image；MCP reload 行可跳到 artifact |
| Dangerous Command Approval | 实现 | 精确 command/cwd/target Gateway/Profile；Approve/Deny/Inspect；target 不随 scope 移动 |
| `@` context picker | 实现 | 文件、文件夹、git diff、URL；选中后作为 context chip 附到 composer |
| `/` slash menu | 实现 | `/status`、`/memory`、`/checkpoint` 等命令菜单 |
| 附件 chips | 实现 | attach menu + 粘贴文件生成 chip + 移除 |
| 模型 / reasoning picker | 实现 | Chat 内 model menu 与 Settings Model；provider routing/fallback/subagent model 摘要 |
| Prompt history `↑`/`↓` | 实现 | composer 键盘历史；发送后清空；Shift+Enter 换行 |
| Session 搜索 / 置顶 / 分组 | 实现 | 搜索 title/preview/id；Pinned；今天/昨天/更早；All Profiles 分组 |
| Checkpoints & Rollback | 实现 + 模拟 | 当前 Session 快照列表、恢复、创建；`--all` 显式开关；恢复后系统消息 |

### C. 能力与运维

| 能力 | 状态 | 实现位置 / 验收 |
| --- | --- | --- |
| Skills installed toggles + Curator + Hub | 实现 + 模拟 | Skills pane；4 个 installed、Curator strip、Hub 一键安装（写入状态） |
| Tools & Toolsets + approval/safety | 实现（UI 状态） | Tools pane：危险命令 ask/allowlist、只读自动批准、allowlist、toolset toggles；这些开关在原型内为本地交互 |
| MCP stdio/HTTP、tool filters、hot reload | 实现 + 模拟 | MCP 列表、transport badge、filters、enabled；hot reload 只在 active Gateway scope 出现，单测 + Playwright 验证 |
| Memory `MEMORY.md` / `USER.md` / `SOUL.md` | 实现 | 可编辑三个文件、personality presets、project context、Memory Provider 状态 |
| `/journey` Memory Graph | 实现 + 模拟 | `Overlays.tsx` 节点、连线、来源、选中详情、跳 Memory editor |
| Cron / Heartbeats / Loops | 实现 + 模拟 | 计划任务、pause/resume、run now、history、HEARTBEAT/LOOP 标记；All Profiles 聚合按钮与分组 |
| Messaging Channels | 实现 + 模拟 | Telegram/Discord/Slack/WhatsApp/Signal/Webhook 类型、连接开关、Telegram Quick Setup QR、凭据变更后 restart banner + 立即重启 |
| Settings 8 个 section | 实现 | Model、Workspace、Safety、Memory & Context、Voice、Chat、Gateways、Updates；Applies-to chip row |
| 每 profile 设置作用域 | 实现 | `SET_PROFILE_MODEL` 写入所选 profile；capability/settings scope 独立于 active scope |

### D. Workspace 扩展

| 能力 | 状态 | 实现位置 / 验收 |
| --- | --- | --- |
| Hide vs Close 状态语义 | 实现 | `workspaceBodyMounted`；Hide 保留 DOM 且 inert，Close 卸载；单测 + Playwright 验证 terminal scrollback |
| Artifacts / file browser / preview | 实现 + 模拟 | artifact strip、HTML iframe sandbox、image、Markdown；文件树按 active Gateway 读取 seed |
| Annotate pin-comment | 实现 | 点击预览放置编号 pin、写入 annotation thread，并自动加入 composer context |
| Git review + worktrees | 实现 + 模拟 | diff files、选文件、diff code、scope segmented、isolated worktree card；commit/PR 为原型 toast |
| Live subagents | 实现 + 模拟 | running/done 列表、选中 inspect、steer、stop；输出为 seed |
| Embedded Terminal | 实现 + 模拟 | 随 active Gateway 显示 Local/SSH prompt；支持 help/pwd/ls/git status/hermes gateway status/clear；History ↑/↓ |
| Voice / Wake Word | 实现 + 模拟 | Push-to-talk（pointer/space）、Hey Hermes toggle、TTS toggle、transcript 放入 composer；不请求麦克风 |
| Bot Mode | 实现 | Sessions | Bots 切换、union roster、Bot Chat、Routines popover；bot 状态与最新消息为 seed |

## 双轴 code-review

### 轴一：Standards（代码质量、架构、可访问性、安全）

**结论：通过，带一条构建体积提示。**

- **深模块边界**：`src/state/store.ts` 是纯 reducer + scope selectors 的领域模块；组件只负责投影与派发 action，不在 UI 内复制 scope 规则。测试直接打 reducer，不依赖 React。
- **类型与穷尽性**：`strict` + `noUnused*` + `noFallthroughCasesInSwitch`；action union 与 domain types 集中在 `src/types.ts`；`tsc --noEmit` 退出 0。
- **状态一致性**：Gateway/Profile 切换、All Profiles、MCP 热重载守卫、approval target、channel restart banner、Hide/Close、checkpoint、bot removal 均有单测或 Playwright 覆盖。
- **安全边界**：无 `fetch`、WebSocket、SSH、OAuth 或凭据持久化；token 字段 `type=password` 且不进入 store；危险命令必须显式批准；artifact iframe 使用 `sandbox=""`；Markdown 未启用 raw HTML。
- **可访问性**：所有图标按钮有 `aria-label`；Toggle 使用 `role="switch"` + `aria-checked`；modal/drawer 有 `aria-modal`、`aria-labelledby`、焦点陷阱与 Escape 返回；`aria-live` 用于 streaming 与 toast；`prefers-reduced-motion` 压制动效；状态不只依赖颜色。
- **浏览器表面**：selection、caret、focus ring、scrollbar、placeholder 均由 Quiet Relay 调色板主题化；没有默认蓝焦点环或未样式化滚动条。
- **文案**：中文主文案 + English Hermes 术语；危险操作命名目标与动作；空态与控制文案说明下一步。
- **测试**：8 个 reducer 测试 + Playwright 交互检查。没有为纯展示组件添加脆弱快照。
- **遗留**：545 kB single chunk；后续生产化应做路由级/抽屉级动态 import。`pnpm` 12 对 esbuild build script 的审批需按 README 用 `--allow-build=esbuild`；`package.json` 的 legacy `pnpm.onlyBuiltDependencies` 对 pnpm 10 有效。

### 轴二：Spec（用户确认的 A/B/C/D 与交付约束）

**结论：A/B/C/D 四类均可达；所有外部系统为明确模拟。**

- **A 多 Gateway/Profile**：四类连接、registry、health/latency、Primary、last-used toggle、Test、Add/Edit/Remove、Update all、快速 switcher、All Profiles、全量 re-scope、ambient context 均已覆盖。
- **B 对话/执行**：streaming、Markdown/code copy、工具轨迹、approval、`@`/`/`/附件、model/reasoning、history、search/pin/group、checkpoint 均已覆盖。
- **C 能力/运维**：Skills、Tools、MCP、Memory、Cron、Channels、Settings 八个 section 全部可达；Cron 聚合、MCP hot reload 守卫、channel restart banner、Telegram QR 均有可见交互。
- **D Workspace**：Artifacts/Files/Git/Agents/Terminal/Voice + Bot Mode；Hide/Close 语义由 reducer、单测与浏览器测试共同证明。
- **极简约束**：默认 Local 屏幕只有侧栏、720px 对话列、路由条、composer 与 statusbar；Gateway 列表、Skills/MCP/Cron、Workspace 不常驻。空 Session 有独立安静欢迎态。
- **中文文案**：主界面中文，技术词保留 Gateway、Profile、MCP、Skills、Cron、Worktree、Checkpoint、Session；英文 micro-label 只用于测量/状态。
- **PR-only**：分支 `hermes-desktop-prototype`，未合并；未添加 `AGENTS.md` 或 `docs/agents/`；未提交 `node_modules`、`dist` 或 transient `.impeccable/mocks|questions|review`。

### 已知边界与诚实声明

- 没有真实 Hermes daemon、HTTP/WS probe、SSH tunnel、Cloud Portal、Telegram bot、OAuth、麦克风或文件系统访问；所有网络/远端结果由 `src/lib/simulation.ts` 和 seed 数据生成。
- Telegram QR 是可视化占位，不可扫描；Voice 不申请权限、不上传音频；Terminal 只识别 demo 命令；Git commit/PR 按钮只给 toast；artifact HTML 为静态 `srcDoc`。
- “启动时回到上次 Gateway”、Tools 的 approval/allowlist、Voice 的 wake/TTS 等偏好在当前页面会话内可见，但不跨 reload 持久化；这是原型边界，不是真实设置存储。
- Add channel、MCP 高级设置、新建 Cron、Tool allowlist 编辑等深层编辑以原型向导/toast 表示；所有入口、状态与作用域可见。
- `pnpm build` 有 545 kB chunk 警告，退出码 0；未做代码分割，以免在原型阶段引入不必要的路由复杂度。

## 交付范围与文件

新增/修改文件均在 Ownership 内：

```text
.gitignore
.impeccable/config.json
.impeccable/design.json
.impeccable/surfaces/desktop-app.md
PRODUCT.md
DESIGN.md
README.md
index.html
package.json
pnpm-lock.yaml
tsconfig.json
vite.config.ts
src/**
docs/prototype-answer.md
```

静态 artifact SVG 已从 `public/artifact-latency.svg` 移到 `src/assets/artifact-latency.svg` 并通过 Vite import 使用，避免 Ownership 外的 `public/` 路径。`pnpm-workspace.yaml` 未提交；构建脚本配置写入 `package.json`。`node_modules/`、`dist/`、`.impeccable/mocks/`、`.impeccable/questions/`、`.impeccable/review/` 均由 `.gitignore` 排除。

交付前检查：

```text
git status --porcelain   # 仅 scoped 新文件
git diff --check         # 无 whitespace error
git diff --cached --numstat  # 仅上述 prototype/design/docs 文件
```

最终 PR 保持开启，不自动合并，等待人工 review。
