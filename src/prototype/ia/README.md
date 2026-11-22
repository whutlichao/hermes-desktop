# Quiet Relay Shell IA prototype (throwaway)

一次性探索产物，对应 Issue #13「极简壳层 IA 与能力披露路径」。仅在
`prototype/quiet-relay-shell-ia` 分支存在，不进入 `main`、不接真实后端、不写持久化。

## 运行

```sh
pnpm dev --host 127.0.0.1 --port 4173
```

打开 `http://127.0.0.1:4173/?variant=A`（B / C 同理）。

## 三个结构变体

- **A · Relay Rail（用户选定基线）**：1440×900 常驻 232px Session rail；1280×800
  自动收起为 route strip 的 Sessions popover。720px 对话列、composer、能力 counts 一行、
  Workspace / 审批右抽屉。
- **B · Quiet Field**：无侧栏，route line + 720px 对话列 + 底部 dock；能力用 ⌘K 命令
  面板或左侧 popover，Workspace 用底部 sheet。
- **C · Dispatch Board**：顶部 route/session strip + 720px 对话列 + 底部能力托盘；
  Workspace 为左侧抽屉。

底部浮动条切换变体，`←` / `→` 快捷键等价；`⌘K` 能力搜索、`⌘,` Settings、`⌘B`
Workspace、`Esc` 关闭浮层。

## 模拟状态

- 能力档：`served` / `older` / `unavailable`（`-32601`）/ `refused`
- 场景：静止空态 / 运行中 / 后台待审批 / 连接降级
- URL 参数：`?variant=A|B|C&scene=empty|running|approval|degraded&cap=served|older|unavailable|refused`

17 个非延期域均有真实抵达路径；Voice / Bot Mode / Memory Graph / Kanban 仅出现在
披露底注中，无任何可点击假入口。
