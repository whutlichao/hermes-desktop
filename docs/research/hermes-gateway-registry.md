# 官方 gateway-connections registry：schema、锁、revision 与并发写

- 调研日期：2026-11-22
- 对应票：[Research：官方 gateway-connections registry schema 与并发写](https://github.com/whutlichao/hermes-destop/issues/21)
- 上游源码快照：`NousResearch/hermes-agent@0f602c5f6f18615632535251d62a2db74ce93b69`（sparse checkout：`apps/desktop/electron`、`apps/shared/src`、`apps/desktop/src/lib`）
- 结论：官方 Desktop 与 Webapp 通过 `<HERMES_HOME>/gateway-connections.json` 与 `gateway-connection-tokens.json` 共享一份 0600 的连接注册表；并发写靠 `<store>.lock` 目录锁 + `revision` + 冲突重放（rebase），不是直接拒绝。**但官方当前不会保留任意未知字段，也不会拒绝 `version > 2`**，这与用户 Q8 的口头预期存在差异，必须由 [共享 gateway-connections registry 的并发与凭据契约](https://github.com/whutlichao/hermes-destop/issues/10) 明确取舍。

## 1. 文件位置与共享面

| 项 | 事实 |
| --- | --- |
| 目录 | `uiPreferencesRoot(HERMES_HOME)`，即 `HERMES_HOME` 经 `realpath` 后的根目录；默认 `~/.hermes` |
| 连接文件 | `<root>/gateway-connections.json` |
| 令牌文件 | `<root>/gateway-connection-tokens.json` |
| 权限 | 两个文件均以 `0600` 写入 |
| 共享者 | Electron main 与 Webapp 的 Python 孪生实现（`hermes_cli/gateway_connections.py`）读写同一份文件 |
| Renderer/插件 | 永远拿不到 token 字节；插件 SDK 的 `host.connections()` 只返回 label / kind / primary |

来源：

- [gateway-connections-store.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L1-L40)
- [ui-preferences.ts `uiPreferencesRoot`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/ui-preferences.ts#L45-L58)
- [main.ts 注入 root](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/main.ts#L1972-L1974)
- [multi-connection-desktop.md Security notes](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/website/docs/user-guide/multi-connection-desktop.md#L335-L358)

## 2. `gateway-connections.json` 文档形状

文档 = **v2 registry** + 存储层附加字段：

```jsonc
{
  "version": 2,
  "primary": "local",
  "launchMode": "primary",        // 或 "last-used"
  "lastUsed": "local",
  "connections": [ /* RegistryConnection[] */ ],
  "quarantined": [ /* 可选：坏条目原文，最多 20 条 */ ],
  "revision": 7,                  // 存储层
  "importedFrom": { "/path/to/userData": { "at": 1760000000000 } },
  "quarantinedOverflow": [ /* 合并时超出上限的坏条目原文 */ ],
  "importNotices": [ /* 无法解密等提示 */ ]
}
```

`RegistryConnection` 的已知字段：

| 字段 | 适用 kind | 说明 |
| --- | --- | --- |
| `id` | 全部 | `local` 固定为 `"local"`；其余缺省时由 label 派生 |
| `kind` | 全部 | `local` / `remote` / `ssh` / `cloud` |
| `label` | 全部 | 必填的设备名；大小写不敏感唯一；最长 64；冲突时自动加 ` 2` / ` 3` 后缀，不丢条目 |
| `url` | `remote` / `cloud` | 规范化 base URL；缺失则条目进入 `quarantined` |
| `authMode` | `remote` / `cloud` | `"token"` 或 `"oauth"` |
| `token` | `remote` / `cloud` / `ssh` | 不透明 secret envelope；存储层写入时转成 `{encoding:"plain", value:"…"}` |
| `headers` | `remote` / `cloud` | 额外网关头（如 Cloudflare Access）的 secret envelope map |
| `org` / `name` | `cloud` | Portal 组织与实例名 |
| `host` / `user` / `port` / `keyPath` / `remoteHermesPath` / `remoteProfile` | `ssh` | `port` 为 22 时不落盘（省略即默认 22） |

来源：

- [connection-registry.ts `ConnectionRegistry`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/connection-registry.ts#L42-L110)
- [connection-registry.ts `normalizeRegistry`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/connection-registry.ts#L1248-L1420)
- [connection-config.ts `normalizeSshConfig`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/connection-config.ts#L445-L530)
- [gateway-connections-store.ts `StoreDoc`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L95-L120)

## 3. `gateway-connection-tokens.json` 文档形状

```jsonc
{
  "version": 1,
  "revision": 3,
  "tokens": {
    "<connectionId>": { /* NativeTokenSet + baseUrl */ }
  },
  "unbound": {
    "<normalizedBaseUrl>": { /* NativeTokenSet */ }
  },
  "undecrypted": {
    "<normalizedBaseUrl>": { /* 原 secret envelope */ }
  }
}
```

关键行为：

- token set 与其签发 URL 绑定：条目的 `url` / `authMode` 变化或条目被删除时，`dropTokens` 会删掉对应 `tokens[id]`。
- 尚无保存条目的 URL 登录放 `unbound`；keychain 打不开的导入 blob 原样留 `undecrypted`，不丢。
- token 文件也独立加锁、独立 `revision`；写连接后写 token 的顺序固定为“先连接锁，再 token 锁”，避免反序死锁。

来源：[gateway-connections-store.ts tokens 合约](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L23-L40)、[`signedInIdsGone`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L539-L556)、[`dropTokens`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L793-L814)

## 4. 锁、原子写与 revision 冲突

### 锁

- 锁是 `<store>.lock` **目录**，`mkdir` 即抢锁；目录内写 `owner` 文件，内容是 `<pid>-<random>` token。
- 抢不到时轮询 20 ms，最多等 3 秒；锁目录 mtime 超过 10 秒视为 stale，可被 break。
- 释放前重新确认 owner token；若锁已被别人 break 并重抢，本次写入抛 `gateway connections store is busy`，不覆盖别人的保存。
- 锁是同步实现，因为 Electron main 的 registry 读写位于同步 IPC 路径；一次写只持有毫秒级。

### 原子写

- 同目录写临时文件 `<file>.<pid>.<ts>.tmp`，`mode: 0o600`，再 `renameSync` 替换。
- 若读到的文件不可解析，先复制为 `<file>.corrupt-<ms>` 再覆盖。
- 只有 `ENOENT` 读作“没有 store”；其他读取失败拒绝写入。

### revision 与重放

- 每次成功写入 `revision = 磁盘 revision + 1`。
- 写入前若发现磁盘 `revision` 已不是本进程上次读到的值，不直接拒绝：调用 `rebaseRegistry(base, next, disk)`，把本进程从 `base` 到 `next` 的改动重放到 `disk` 上。
- 重放规则：本进程改过/新增的条目按 `id` upsert；本进程删过的条目删除；`primary` / `launchMode` / `lastUsed` / `quarantined` 只有在本进程真正改过时才覆盖磁盘值，其余以磁盘为准。

来源：[锁与常量](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L60-L75)、[`withStoreLockSync`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L180-L216)、[`replaceDoc`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L218-L238)、[`write`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L777-L792)、[`rebaseRegistry`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L405-L439)

## 5. 外部变更监听

- `watch({onRegistry, onTokens})` 对两个文件各做 `fs.watchFile` stat 轮询，间隔 `1500 ms`，`persistent: false`。
- registry 回调报告的是**另一个 writer** 相对本进程最后写入/宣布状态的 per-connection 变化（saved / removed / changed），不是每次 stat 都报。
- 读到新文件后更新 cache 与 revision；Renderer 不需要轮询。

来源：[`watch`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L905-L940)、[`registryChanges`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L441-L490)

## 6. 重复与迁移规则

### 重复身份

- `remote` / `cloud`：normalized URL = `trim()` + 去掉末尾 `/` + `lowercase()`；跨 `remote`/`cloud` 两种 kind 一起查重。
- `ssh`：`lowercase(user)@lowercase(host):port(default 22)::trim(remoteProfile)`。
- `local`：永远恰好一条，id 固定 `"local"`，不可删除。
- label：大小写不敏感唯一；冲突自动加后缀，不丢连接。

### 迁移

- 每个 Electron userData 目录只在 `importedFrom` 中首次出现时合并一次。
- 合并顺序：v1 `connection.json` → v2 `connections.json` → 共享 store；按 `id`，再按 URL / SSH 重复规则。
- 已有 store 永不被覆盖；userData 文件永不被写；导入后不再读取旧文件，所以“删除后重启又回来”不会发生。
- 旧文件中的 keychain secret 在导入时解密一次；解不开的保留原 envelope 并写入 `importNotices`。

来源：[`mergeRegistries`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L344-L403)、[`importUserData`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts#L712-L751)、[`migrateV1ToRegistry`](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/connection-registry.ts#L1436-L1575)

## 7. 与用户 Q8 预期的差异（必须由 #10 决策）

用户 Q8 的口头要求包含“保留未知字段”“`version > 2` fail-safe”。官方当前实现与此不一致：

1. **未知字段不保留。** `normalizeRegistry` 只构造已知字段的 `clean` 对象；每条连接的未知字段不会进入内存模型，下一次写入即丢失。顶层未知字段同理，只有 `revision` / `importedFrom` / `importNotices` / `quarantinedOverflow` 这些存储层字段被显式传递。坏条目原文会进 `quarantined`（最多 20 条），合并溢出的进 `quarantinedOverflow`，但这不是“任意未知字段保留”。
2. **`version > 2` 不拒绝。** `normalizeRegistry` 无条件把 `version` 写成 `REGISTRY_VERSION`（当前 2），不检查输入版本；比它旧的 v1 由 `migrateV1ToRegistry` 迁移。也就是说，未来版本文件会被降级读取，而不是 fail-safe 拒绝。
3. **`revision` 变化不是拒绝。** 官方选择 rebase 重放；若独立客户端选择“版本/未知字段保守拒绝”，会与官方 Desktop/Webapp 的共存行为不同，必须明确承担“官方升级后本客户端拒绝写入”的代价。

因此 [共享 gateway-connections registry 的并发与凭据契约](https://github.com/whutlichao/hermes-destop/issues/10) 必须显式选择：

- **A. 严格跟随官方归一化**：未知字段丢弃、`version > 2` 按 v2 读、revision 冲突 rebase；与官方共存最顺，但未来版本新增字段会在本客户端写入时丢失。
- **B. 额外保留未知字段**：在内存与写回中保留未知 per-connection / top-level 字段；需要自行维护 schema 与合并规则，且要验证官方不会因未知字段报错。
- **C. 保守拒绝**：检测到未知字段或 `version > 2` 时只读或拒绝写入；最安全，但会与官方 Desktop/Webapp 的“向前兼容”路径分叉。

本报告不替用户拍板，只把差异与代价摊开。

## 8. 对独立客户端的直接影响

- **不要长持锁跨 IPC / 网络**：官方锁是同步、毫秒级；独立客户端若在 Main 进程中做 async 读改写，必须把锁的临界区压到纯磁盘操作，否则会阻塞其他写入 3 秒并触发 busy。
- **写连接与写 token 的顺序固定**：先连接锁、再 token 锁；反过来会与官方 writer 形成锁序反转风险。
- **不要复用被删除连接的 id**：id 是 label slug，可能被回收；token 绑定 URL/authMode 正是为了避免 id 回收后串用凭据。
- **监听外部变更**：官方 watcher 是 1500 ms stat 轮询；独立客户端可复用同一节奏，避免过于频繁地整文件读取。
- **凭据形态**：`gateway-connections.json` 里的 `token` / `headers` 是 `{encoding:"plain", value}` envelope；`gateway-connection-tokens.json` 里的 OAuth set 是结构化对象。Renderer 与插件都不得接触原始字节。

## 9. 一手出处

- [gateway-connections-store.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/gateway-connections-store.ts)
- [connection-registry.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/connection-registry.ts)
- [connection-config.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/connection-config.ts)
- [ui-preferences.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/ui-preferences.ts)
- [main.ts](https://github.com/NousResearch/hermes-agent/blob/0f602c5f6f18615632535251d62a2db74ce93b69/apps/desktop/electron/main.ts)
- [Connecting Desktop to Many Hermes Instances](https://hermes-agent.nousresearch.com/docs/user-guide/multi-connection-desktop)
