export const COPY_CATALOG = {
  "app.name": "Hermes Desktop",
  "app.subtitle": "Quiet Relay",
  "skip.toComposer": "跳到对话输入",
  "nav.sessionsLandmark": "Session 导航",
  "nav.sessionsTab": "Sessions",
  "nav.newSession": "新建 Session",
  "nav.sessionsCount": "Sessions",
  "nav.sessionsEmptyTitle": "尚无可用 Session",
  "nav.sessionsEmptyBody": "尚未连接到任何 Gateway，连接就绪后将同步当前 Scope 的 Session 列表。",
  "nav.openScopeSettings": "管理连接",
  "route.you": "YOU",
  "route.unconnectedGateway": "未连接 Gateway",
  "route.noProfile": "未选择 Profile",
  "route.statusUnconnected": "未连接",
  "route.openScopePopover": "切换 Scope",
  "route.openWorkspace": "打开 Workspace",
  "route.openCapabilities": "能力 17 可达 4 延期",
  "route.capabilitiesBadge": "能力 17 可达 / 4 延期",
  "empty.title": "尚未连接到 Hermes Gateway",
  "empty.body": "发生了什么：当前没有可用连接。可能原因：尚未配置本机 CLI 或远程 Gateway。下一步：前往 Settings 添加或检查连接。",
  "empty.actionSettings": "打开 Settings",
  "empty.actionPalette": "打开命令面板",
  "empty.actionShortcuts": "查看键盘快捷键",
  "composer.label": "向当前 Scope 发送消息",
  "composer.placeholder": "请先连接 Gateway 后再输入消息...",
  "composer.send": "发送消息",
  "composer.unconnectedHint": "当前未连接任何 Gateway，输入已禁用，不会发送或创建假 Session。",
  "status.footer": "单窗口 · 单 Pane · 仅展示真实状态",
  "status.modeMock": "浏览器 Mock 模式（不触网）",
  "status.modeElectron": "Electron 宿主模式",
  "palette.title": "命令面板",
  "palette.placeholder": "搜索命令或跳转目标...",
  "palette.empty": "没有匹配的命令。",
  "palette.cmdNewSession": "新建 Session",
  "palette.cmdNewSessionHint": "在当前 Scope 创建新 Session",
  "palette.cmdSettings": "打开 Settings",
  "palette.cmdSettingsHint": "查看连接与客户端偏好",
  "palette.cmdWorkspace": "切换 Workspace 抽屉",
  "palette.cmdWorkspaceHint": "显示或隐藏右侧 Workspace 面板",
  "palette.cmdCapabilities": "查看能力目录",
  "palette.cmdCapabilitiesHint": "查看 17 个可达域与 4 个延期披露",
  "palette.cmdShortcuts": "查看键盘快捷键",
  "palette.cmdShortcutsHint": "查看应用内快捷键一览",
  "settings.title": "Settings",
  "settings.description": "管理 Gateway 连接与本地偏好设置。",
  "settings.gatewaysTitle": "Gateways",
  "settings.emptyGateways": "尚未添加任何 Gateway，当前无模拟数据。",
  "settings.aboutTitle": "About",
  "settings.updatesTitle": "Updates",
  "settings.updatesNotice": "本地开发构建，不检查更新",
  "settings.close": "关闭 Settings",
  "gateways.sectionTitle": "Gateways 连接注册表",
  "gateways.launchPolicyLabel": "启动目标策略",
  "gateways.launchModePrimary": "优先启动 Primary",
  "gateways.launchModeLastUsed": "优先启动上次使用（last-used）",
  "gateways.nextLaunchBadge": "NEXT LAUNCH",
  "gateways.primaryBadge": "Primary",
  "gateways.lastUsedBadge": "上次使用",
  "gateways.localBadge": "本机",
  "gateways.hasTokenLabel": "Main 已保存凭据（Main only）",
  "gateways.noTokenLabel": "未配置凭据",
  "gateways.setPrimaryAction": "设为 Primary",
  "gateways.setLastUsedAction": "标记为上次使用",
  "gateways.renameAction": "编辑 / 改名",
  "gateways.removeAction": "移除连接",
  "gateways.addAction": "添加连接",
  "gateways.saveAction": "保存连接",
  "gateways.discardEditAction": "放弃编辑",
  "gateways.backupRepairAction": "备份并修复",
  "gateways.exportSafeSummaryAction": "导出脱敏摘要",
  "gateways.duplicateExternalBadge": "外部重复 · 不拨号",
  "gateways.conflictTitle": "检测到重复连接，已保留当前输入",
  "gateways.conflictEditLabelAction": "修改设备名",
  "gateways.conflictEditTargetAction": "修改目标地址",
  "gateways.conflictKeepCanonicalAction": "保留既有连接",
  "gateways.formTitleAdd": "添加 Gateway 连接",
  "gateways.formTitleEdit": "编辑 Connection",
  "gateways.fieldKind": "连接类型",
  "gateways.fieldLabel": "设备名称",
  "gateways.fieldUrl": "Gateway 地址",
  "gateways.fieldAuthMode": "认证方式",
  "gateways.fieldToken": "静态 Token（仅写入 Main）",
  "gateways.fieldSshHost": "SSH 主机",
  "gateways.fieldSshUser": "SSH 用户名",
  "gateways.fieldSshPort": "SSH 端口（默认 22）",
  "gateways.fieldRemoteProfile": "远端 Profile（可选）",
  "registry.issue.futureVersion": "检测到未知字段或更高版本格式，首次写回前将备份 sidecar 文件。",
  "registry.issue.unsupported": "当前 registry 文件版本或结构不受支持，已切换为只读保护模式。",
  "registry.issue.corrupt": "共享 registry 文件 JSON 损坏，已保留上次已知快照并暂停写入。",
  "registry.issue.unavailable": "无法读取共享 registry 文件，已保留上次已知快照并暂停写入。",
  "registry.issue.conflict": "检测到外部并发写入，已按 last-writer-wins 合并差异。",
  "registry.issue.externalDuplicate": "检测到外部重复条目，仅首条合法连接可拨号，其余已隔离。",
  "registry.issue.reset": "共享 registry 文件已被外部移除，已恢复默认本机状态。",
  "registry.issue.busy": "共享 registry 正在被其他客户端写入，请稍后重试。",
  "registry.issue.tokenSyncFailed": "连接已保存，但 OAuth token 同步失败，将在下次操作时重试。",
  "registry.issue.localNotRemovable": "本机 Local 连接不可移除。",
  "registry.issue.duplicateIdentity": "目标连接地址或 SSH 目标已存在。",
  "registry.issue.duplicateLabel": "该设备名称已被其他连接使用。",
  "registry.issue.invalidInput": "连接参数无效，请检查设备名称与目标地址。",
  "registry.issue.invalidPrimary": "无法将无效或重复连接设为 Primary。",
  "registry.issue.notFound": "未找到目标 Connection。",
  "capabilities.title": "能力目录",
  "capabilities.summary": "17 可达 / 4 延期",
  "capabilities.deferredFootnote": "4 个 Phase 1 延期域（Voice、Bot Mode、Memory Graph、Kanban）无 v1 入口。",
  "capabilities.close": "关闭能力目录",
  "workspace.title": "Workspace",
  "workspace.emptyBody": "请先连接到 Gateway 并打开 Session，再查看 Workspace 内容。",
  "workspace.hide": "隐藏 Workspace",
  "workspace.close": "关闭 Workspace",
  "shortcuts.title": "键盘快捷键",
  "shortcuts.description": "所有全局快捷键均通过原生菜单与统一命令通道分发。",
  "shortcuts.close": "关闭快捷键帮助",
  "popover.sessionsTitle": "Sessions",
  "popover.close": "关闭 Sessions 浮层",
  "scope.popoverTitle": "选择 Scope",
  "scope.empty": "当前无可用 Connection 或 Profile。",
  "scope.close": "关闭 Scope 浮层",
  "local.title": "This device",
  "local.statusBlocked": "连接受阻",
  "local.statusReconnecting": "正在重试",
  "local.statusReady": "CLI 已就绪",
  "local.statusPending": "正在检测本机 CLI",
  "local.whatHappenedLabel": "发生了什么",
  "local.possibleCausesLabel": "可能原因",
  "local.nextStepLabel": "下一步",
  "local.cliSummaryLabel": "CLI 摘要",
  "local.cliVersionLabel": "CLI 版本",
  "local.restartAttemptLabel": "自动重启次数",
  "local.escapeRemoteSsh": "改连 Remote / SSH",
  "local.escapeRemoteSshHint": "如暂不在本机运行 Hermes，可前往 Settings 添加 Remote HTTP(S) 或 SSH 连接。",
  "local.remoteEscapeTitle": "改连 Remote / SSH",
  "local.remoteEscapeBody": "本机无需强制安装 hermes CLI，你可以直接在 Settings 中添加 Remote HTTP(S) 或 SSH 连接。",
  "local.remoteEscapeAction": "前往 Settings 配置",
  "local.remoteEscapeClose": "关闭引导",
  "local.action.choose_cli": "选择本机 CLI",
  "local.action.open_install_docs": "查看安装文档",
  "local.action.open_update_docs": "查看升级文档",
  "local.action.retry": "重新检测",
  "local.action.restart_gateway": "重启 Gateway",
  "local.action.open_status": "查看运行状态",
  "local.action.open_diagnostics": "导出脱敏诊断",
  "local.action.switch_profile": "切换 Profile",
  "local.selectCancelled": "已取消选择 CLI，保留当前状态不变。",
  "local.inspectReadyBody": "本机 hermes CLI 已就绪，暂无活动 Gateway 会话。",
  "diagnostics.title": "脱敏诊断摘要",
  "diagnostics.description": "以下信息已脱敏，不含本机路径、用户名、Token、Ticket 或原始 stderr。",
  "diagnostics.copyAction": "复制脱敏 JSON",
  "diagnostics.copiedNotice": "已复制脱敏诊断 JSON",
  "diagnostics.close": "关闭脱敏诊断",
  "diagnostics.empty": "尚未生成诊断数据，请先导出脱敏诊断。",
  "local.action.connectLocal": "连接本机 Gateway",
  "route.statusReady": "已连接",
  "route.statusConnecting": "正在连接",
  "route.statusReconnecting": "正在重连",
  "route.statusBlocked": "连接受阻",
  "scope.profileSection": "可用 Profile",
  "scope.connectionSection": "已配置 Connection",
  "scope.switchNotice": "已切换当前 Scope",
  "chat.emptyTitle": "已连接到当前 Scope",
  "chat.emptyBody": "选择左侧 Session，或点击「新建 Session」开始第一条对话。",
  "chat.unavailableTitle": "当前 Gateway 暂不支持 Chat",
  "chat.unavailableBody": "服务端未声明 prompt.submit 能力，已隐藏对话输入，不会发送假消息。",
  "chat.composerPlaceholder": "向当前 Scope 发送消息（Enter 发送，Shift+Enter 换行）...",
  "chat.sendAction": "发送消息",
  "chat.stopAction": "停止 Turn",
  "chat.stoppingAction": "正在停止...",
  "chat.stopFailed": "停止 Turn 失败：Gateway 未确认停止，当前运行状态保持不变。",
  "chat.sendFailed": "发送消息失败，请检查 Gateway 状态后重试。",
  "chat.roleUser": "YOU",
  "chat.roleAssistant": "HERMES",
  "chat.roleSystem": "SYSTEM",
  "chat.streamingBadge": "正在输出",
  "chat.stoppedBadge": "已停止",
  "chat.toolsLabel": "工具执行",
  "chat.toolRunning": "执行中",
  "chat.toolCompleted": "已完成",
  "chat.toolFailed": "失败",
  "chat.toolCancelled": "已取消",
  "chat.newSessionDefaultTitle": "新对话",
} as const;

export type CopyKey = keyof typeof COPY_CATALOG;

const BANNED_TRANSLATIONS = [
  "网关",
  "配置文件",
  "作用域",
  "工作区",
  "草稿",
  "轮次",
  "检查点",
];

const BANNED_BARE_BUTTONS = new Set(["确定", "取消"]);

const CANONICAL_ENGLISH_TERMS = [
  "Gateway",
  "Connection",
  "Profile",
  "Scope",
  "Session",
  "Workspace",
  "Draft",
  "Turn",
  "Approval",
  "Checkpoint",
];

export interface TerminologyViolation {
  key?: string;
  reason: string;
  text: string;
}

export function getCopy(key: CopyKey): string {
  return COPY_CATALOG[key];
}

export function validateTerminology(text: string, key?: string): TerminologyViolation[] {
  const violations: TerminologyViolation[] = [];
  const trimmed = text.trim();

  if (BANNED_BARE_BUTTONS.has(trimmed)) {
    violations.push({
      key,
      reason: `按钮文案禁止使用裸“${trimmed}”，请使用明确动词`,
      text,
    });
  }

  for (const banned of BANNED_TRANSLATIONS) {
    if (text.includes(banned)) {
      violations.push({
        key,
        reason: `发现禁止使用的旧中文译名“${banned}”，请保留固定英文术语`,
        text,
      });
    }
  }

  // Enforce single half-width space between CJK and ASCII alphanumeric (excluding standalone shortcuts like ⌘K)
  if (/[\u4e00-\u9fff][A-Za-z0-9]/.test(text) || /[A-Za-z0-9][\u4e00-\u9fff]/.test(text)) {
    violations.push({
      key,
      reason: "中文与英文/数字之间必须保留一个半角空格",
      text,
    });
  }

  // Enforce canonical casing for the 10 fixed English terms when appearing as standalone words
  for (const term of CANONICAL_ENGLISH_TERMS) {
    const lowerRe = new RegExp(`\\b${term.toLowerCase()}\\b`, "g");
    const matches = text.match(lowerRe);
    if (matches) {
      for (const m of matches) {
        if (m !== term && m !== term.toUpperCase()) {
          violations.push({
            key,
            reason: `固定英文术语“${term}”大小写错误（发现“${m}”）`,
            text,
          });
        }
      }
    }
  }

  return violations;
}

export function lintCopyCatalog(catalog: Record<string, string>): TerminologyViolation[] {
  const violations: TerminologyViolation[] = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (!value || value.trim() === "" || value === key) {
      violations.push({
        key,
        reason: "文案缺失或为原始 key",
        text: value ?? "",
      });
      continue;
    }
    violations.push(...validateTerminology(value, key));
  }
  return violations;
}
