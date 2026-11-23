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
  "settings.emptyGateways": "尚未添加任何 Gateway，当前无模拟数据。",
  "settings.close": "关闭 Settings",
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
