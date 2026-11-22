import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  FileDiff,
  FileText,
  Folder,
  History,
  Layers,
  Link2,
  Mic,
  Paperclip,
  PanelRight,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  X,
} from "lucide-react";
import type { Activity, Attachment, ContextChip, Gateway, Message, Profile, Reasoning, Session } from "../types";
import { useApp } from "../state/AppContext";
import {
  getActiveBot,
  getActiveFiles,
  getActiveGateway,
  getActiveProfile,
  getActiveSession,
  getGateway,
  getProfile,
  getRoutinesForBot,
  scopedMcpServers,
} from "../state/store";
import { cn, compactPath, gatewayKind, healthLabel, isRemote, latency } from "../lib/ui";
import { HermesMark } from "./Brand";
import {
  Button,
  CopyButton,
  EmptyState,
  IconButton,
  InlineNotice,
  Kbd,
  Markdown,
  Segmented,
  StatusDot,
  Toggle,
} from "./ui";

const models = [
  { name: "Opus 4.5", provider: "Anthropic", note: "默认 · 深度执行" },
  { name: "Sonnet 4.5", provider: "Anthropic", note: "平衡 · 日常" },
  { name: "GPT-5.2", provider: "OpenAI", note: "长上下文" },
  { name: "Gemini 3 Pro", provider: "Google", note: "多模态" },
];

const reasonings: Reasoning[] = ["Off", "Low", "Medium", "High", "Max"];

const slashCommands = [
  { command: "/checkpoint", label: "Checkpoint & rollback", hint: "查看当前 Session 快照", icon: History },
  { command: "/journey", label: "Memory Graph", hint: "查看记忆与引用路径", icon: Workflow },
  { command: "/memory", label: "Memory & Context", hint: "编辑 MEMORY.md / USER.md / SOUL.md", icon: Sparkles },
  { command: "/model", label: "Model routing", hint: "切换模型与 reasoning", icon: Layers },
  { command: "/new", label: "New Session", hint: "在当前 scope 新建对话", icon: Plus },
  { command: "/compact", label: "Compact context", hint: "压缩历史并保留决策", icon: FileText },
  { command: "/help", label: "Keyboard shortcuts", hint: "查看键盘操作", icon: Command },
];

function flattenFiles(nodes: ReturnType<typeof getActiveFiles>): Array<{ id: string; name: string; path: string; kind: "file" | "folder" }> {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, path: node.path, kind: node.kind },
    ...(node.children ? flattenFiles(node.children) : []),
  ]);
}

function routeCopy(gateway: Gateway, profile: Profile) {
  return {
    origin: "YOU",
    host: gateway.name.toUpperCase(),
    profile: profile.handle,
    kind: gatewayKind(gateway),
  };
}

function makeReply(gateway: Gateway, profile: Profile, prompt: string): {
  content: string;
  activities: Activity[];
} {
  const scope = `${gateway.name} / ${profile.name}`;
  const lower = prompt.toLowerCase();
  const activity: Activity = {
    id: `live-${Date.now()}`,
    name: "gateway_status",
    status: "done",
    summary: `${healthLabel(gateway)} · ${latency(gateway)} · WS open`,
    args: `{ "gateway": "${gateway.id}", "profile": "${profile.id}", "leg": "http+ws" }`,
    output: `{ "scope": "${scope}", "health": "${gateway.health}", "simulated": true }`,
  };
  if (lower.includes("mcp") || prompt.includes("工具")) {
    return {
      content: `我在 **${scope}** 上检查了 MCP。活动 Gateway 的 server 可以在 live session 热重载；其他连接会在下一次 Session 挂载。\n\n这是一个原型模拟回复，没有向真实 daemon 发起请求。`,
      activities: [
        activity,
        {
          id: `mcp-${Date.now()}`,
          name: "mcp.reload",
          status: "done",
          summary: "live-session · 4 tools · 318 ms",
          args: '{ "scope": "live-session", "server": "filesystem" }',
          output: "✓ simulated reload · 4 tools visible",
        },
      ],
    };
  }
  if (lower.includes("checkpoint") || prompt.includes("回滚")) {
    return {
      content: `可以。Checkpoint 跟随 Session，而不是全局设置。当前在 **${scope}** 上会先列出该 Session 的快照，再由你确认恢复范围。\n\n打开 Checkpoint 面板即可试走恢复流程。`,
      activities: [
        activity,
        {
          id: `cp-${Date.now()}`,
          name: "checkpoints.list",
          status: "done",
          summary: "3 snapshots · scoped to session",
          args: `{ "session": "${gateway.id}", "includeFiles": true }`,
          output: "3 snapshots available. No restore performed.",
        },
      ],
    };
  }
  if (lower.includes("terminal") || prompt.includes("命令")) {
    return {
      content: `命令会落在 **${scope}**。${gateway.kind === "cloud" || gateway.kind === "remote" ? "这个连接没有直属 shell，终端会回落到 This device；SSH 网关才有 managed tunnel。" : "可以通过工作区终端检查当前主机状态。"} \n\n我不会在未获批准时执行破坏性命令。`,
      activities: [
        activity,
        {
          id: `shell-${Date.now()}`,
          name: "terminal.inspect",
          status: "done",
          summary: "read-only · no command dispatched",
          args: '{ "mode": "inspect" }',
          output: `Resolved target ${gateway.name}; execution awaits explicit approval.`,
        },
      ],
    };
  }
  return {
    content: `收到。这条消息会被路由到 **${scope}**，并使用 **${profile.model} / ${profile.effort}**。\n\n当前是 Hermes Desktop 的交互原型，所有 gateway、工具输出与延迟均为模拟数据。你可以继续检查：\n\n- \`⌘K\` 打开命令面板\n- 点击顶部路由串切换 Gateway / Profile\n- 从右侧工作区查看 Artifacts、Terminal、Git 与 Subagents\n\n需要我继续时，告诉我希望执行在哪台机器，以及是否允许改动文件。`,
    activities: [activity],
  };
}

function useRevealedText(content: string, active: boolean, onDone: () => void) {
  const [count, setCount] = useState(active ? 0 : content.length);
  const doneRef = useRef(false);
  useEffect(() => {
    doneRef.current = false;
    if (!active) {
      setCount(content.length);
      return;
    }
    setCount(0);
    let current = 0;
    const timer = window.setInterval(() => {
      current = Math.min(content.length, current + Math.max(4, Math.round(content.length / 50)));
      setCount(current);
      if (current >= content.length) {
        window.clearInterval(timer);
        if (!doneRef.current) {
          doneRef.current = true;
          onDone();
        }
      }
    }, 24);
    return () => window.clearInterval(timer);
  }, [content, active, onDone]);
  return content.slice(0, count);
}

function StreamingMessage({ message, onDone }: { message: Message; onDone: () => void }) {
  const visible = useRevealedText(message.content, true, onDone);
  return (
    <div aria-live="polite">
      <Markdown content={visible} />
      <span className="stream-caret" aria-hidden="true" />
    </div>
  );
}

function ActivityRow({ activity, onToggle }: { activity: Activity; onToggle: () => void }) {
  return (
    <div className={cn("activity", activity.expanded && "is-open")}>
      <button type="button" className="activity-head" onClick={onToggle} aria-expanded={Boolean(activity.expanded)}>
        <Code2 size={13} />
        <b>{activity.name}</b>
        <span>{activity.summary}</span>
        <em className={cn(activity.status === "error" && "is-error")}>
          <StatusDot tone={activity.status === "error" ? "error" : activity.status === "running" ? "warn" : "ok"} />
          {activity.status === "error" ? "失败" : activity.status === "running" ? "运行中" : "完成"}
        </em>
        <ChevronRight size={12} className="activity-chevron" />
      </button>
      {activity.expanded && (
        <div className="activity-body">
          {activity.args && (
            <div className="activity-block">
              <span>ARGS</span>
              <pre>{activity.args}</pre>
            </div>
          )}
          {activity.output && (
            <div className="activity-block">
              <span>OUTPUT</span>
              <pre>{activity.output}</pre>
              <CopyButton value={activity.output} compact />
            </div>
          )}
          {activity.image && <img className="activity-image" src={activity.image} alt="工具输出：模拟 gateway 延迟图表" />}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ message }: { message: Message }) {
  const { state, dispatch } = useApp();
  const [inspected, setInspected] = useState(false);
  const approval = message.approval;
  if (!approval) return null;
  const target = getGateway(state, approval.targetGateway);
  const profile = getProfile(state, approval.targetGateway, approval.targetProfile);
  const resolved = approval.status !== "pending";
  return (
    <div className={cn("approval-card", resolved && `is-${approval.status}`)}>
      <div className="approval-head">
        <ShieldCheck size={14} />
        <b>需要批准：清理构建目录</b>
        <span>{resolved ? approval.status.toUpperCase() : "DANGEROUS"}</span>
      </div>
      <div className="approval-command">
        <code>{approval.command}</code>
        <CopyButton value={approval.command} compact />
      </div>
      <div className="approval-meta">
        <span><i>目标主机</i> {target?.name ?? approval.targetGateway}</span>
        <span><i>Profile</i> {profile?.handle ?? approval.targetProfile}</span>
        <span><i>工作目录</i> {approval.cwd}</span>
      </div>
      {inspected && !resolved && (
        <div className="approval-inspect">
          <div><b>HTTP</b><span>{target?.health === "reachable" ? "200 · 可达" : "不可达"}</span></div>
          <div><b>WebSocket</b><span>{target?.health === "reachable" ? "已打开 · managed" : "未连接"}</span></div>
          <div><b>风险</b><span>rm -rf 会删除当前工作目录下的 dist/</span></div>
          <p>命令不会跨主机执行。批准后，目标仍是 <strong>{target?.name}</strong> / <strong>{profile?.name}</strong>。</p>
        </div>
      )}
      <div className="approval-actions">
        {resolved ? (
          <span className="approval-resolution">
            {approval.status === "approved" && <><Check size={12} /> 已批准并标记执行目标</>}
            {approval.status === "denied" && <>已拒绝 · 未执行</>}
          </span>
        ) : (
          <>
            <Button
              variant="quiet"
              onClick={() => dispatch({ type: "RESOLVE_APPROVAL", approvalId: approval.id, decision: "denied" })}
            >
              拒绝
            </Button>
            <Button variant="secondary" onClick={() => setInspected((value) => !value)} aria-expanded={inspected}>
              {inspected ? "收起检查" : "检查"}
            </Button>
            <Button
              variant="primary"
              onClick={() => dispatch({ type: "RESOLVE_APPROVAL", approvalId: approval.id, decision: "approved" })}
            >
              批准并运行
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function MessageView({
  message,
  streaming,
  onStreamDone,
}: {
  message: Message;
  streaming: boolean;
  onStreamDone: () => void;
}) {
  const { state, dispatch } = useApp();
  if (message.role === "system") {
    return (
      <div className="system-message">
        <span />
        <p>{message.content}</p>
        <span />
      </div>
    );
  }
  const user = message.role === "user";
  return (
    <article className={cn("message", user ? "is-user" : "is-assistant")}>
      <div className="message-avatar" aria-hidden="true">
        {user ? "Y" : <HermesMark size={13} />}
      </div>
      <div className="message-main">
        <header className="message-meta">
          <b>{user ? "You" : message.author ?? "Hermes"}</b>
          <span className="message-host">{message.host}</span>
          <span>{message.time}</span>
          {!user && <StatusDot tone="ok" />}
        </header>
        {user ? (
          <div className="user-bubble">
            <p>{message.content}</p>
            {Boolean(message.attachments?.length) && (
              <div className="message-attachments">
                {message.attachments?.map((attachment) => (
                  <span key={attachment.id}><FileText size={10} /> {attachment.name}</span>
                ))}
              </div>
            )}
          </div>
        ) : streaming ? (
          <StreamingMessage message={message} onDone={onStreamDone} />
        ) : (
          <div className="assistant-copy">
            <Markdown content={message.content} />
            <div className="message-actions">
              <CopyButton value={message.content} compact />
            </div>
          </div>
        )}
        {Boolean(message.activities?.length) && (
          <div className="activity-stack">
            {message.activities?.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                onToggle={() => dispatch({ type: "TOGGLE_ACTIVITY", activityId: activity.id })}
              />
            ))}
          </div>
        )}
        {!user && !streaming && message.activities?.some((activity) => activity.name === "mcp.reload") && (
          <button
            type="button"
            className="artifact-link"
            onClick={() => {
              dispatch({ type: "OPEN_WORKSPACE", tab: "artifacts" });
              dispatch({ type: "SET_PREVIEW_ARTIFACT", artifactId: "art-latency" });
            }}
          >
            <FileText size={13} />
            <span><b>artifacts/gateway-latency.html</b><em>新工具输出 · 12.8 KB</em></span>
            <span>预览 →</span>
          </button>
        )}
        <ApprovalCard message={message} />
        {!user && !streaming && (
          <div className="message-foot">
            <span>{state.chat.model} · {state.chat.reasoning}</span>
            <span>{state.sessions.find((session) => session.id === state.activeSessionId)?.checkpoints.length ?? 0} Checkpoint</span>
          </div>
        )}
      </div>
    </article>
  );
}

function RouteBar() {
  const { state, dispatch } = useApp();
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const copy = routeCopy(gateway, profile);
  const activeSession = getActiveSession(state);
  return (
    <header className="route-bar">
      <button
        type="button"
        className="route-string"
        onClick={() => dispatch({ type: "TOGGLE_GATEWAY_SWITCHER" })}
        aria-expanded={state.gatewaySwitcherOpen}
        aria-label={`当前执行上下文：${gateway.name}，${profile.name}。打开 Gateway 切换器`}
      >
        <span className="route-origin"><StatusDot tone="ok" /> {copy.origin}</span>
        <span className="route-line" />
        <span key={`${state.routePulse}-${gateway.id}`} className={cn("route-host", isRemote(gateway) && "is-remote")}>
          <span className="route-ring" />
          {copy.host}
        </span>
        <span className="route-line short" />
        <span className="route-profile">{state.allProfiles ? "ALL PROFILES" : copy.profile}</span>
        <span className={cn("route-kind", isRemote(gateway) && "is-remote")}>{copy.kind}</span>
        <span className="route-latency">{healthLabel(gateway)} · {latency(gateway)}</span>
        <ChevronDown size={12} />
      </button>

      <div className="route-actions">
        {activeSession && (
          <button
            type="button"
            className="header-text-button"
            onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "checkpoints" })}
            title="Checkpoint & rollback"
          >
            <History size={13} />
            <span>{activeSession.checkpoints.length}</span>
          </button>
        )}
        <button
          type="button"
          className={cn("header-text-button command-trigger", state.allProfiles && "is-active")}
          onClick={() => dispatch({ type: "TOGGLE_ALL_PROFILES" })}
          aria-pressed={state.allProfiles}
        >
          <Layers size={13} />
          <span>All Profiles</span>
        </button>
        <IconButton label="打开命令面板（⌘K）" onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "palette" })}>
          <Command size={15} />
        </IconButton>
        <IconButton label="打开 Capabilities" onClick={() => dispatch({ type: "OPEN_CAPABILITIES" })}>
          <Sparkles size={15} />
        </IconButton>
        <button
          type="button"
          className={cn("workspace-trigger", state.workspace.mode === "open" && "is-active")}
          onClick={() => dispatch({ type: "OPEN_WORKSPACE" })}
          aria-label="打开工作区"
        >
          <PanelRight size={15} />
          <span>Workspace</span>
        </button>
      </div>
    </header>
  );
}

function ContextMenu({
  gateway,
  onClose,
}: {
  gateway: Gateway;
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const files = flattenFiles(getActiveFiles(state)).slice(0, 8);
  const add = (chip: ContextChip) => {
    dispatch({ type: "ADD_CONTEXT", chip });
    if (state.chat.draft.endsWith("@")) {
      dispatch({ type: "SET_CHAT_DRAFT", value: state.chat.draft.slice(0, -1) });
    }
    onClose();
  };
  return (
    <div className="composer-menu context-menu" role="dialog" aria-label="引用上下文">
      <div className="menu-heading">
        <div><b>引用上下文</b><span>{gateway.name} · scoped</span></div>
        <IconButton label="关闭" onClick={onClose}><X size={13} /></IconButton>
      </div>
      <div className="menu-note">文件和目录来自当前 Gateway 的主机，不会跨机器解析。</div>
      <div className="menu-scroll">
        <div className="menu-section-label">Files</div>
        {files.map((file) => {
          const Icon = file.kind === "folder" ? Folder : FileText;
          return (
            <button
              type="button"
              key={file.id}
              className="menu-row"
              onClick={() => add({ id: `ctx-${file.id}-${Date.now()}`, label: compactPath(file.path), kind: file.kind, detail: file.path })}
            >
              <Icon size={13} />
              <span><b>{file.name}</b><em>{compactPath(file.path)}</em></span>
              <Plus size={12} />
            </button>
          );
        })}
        <div className="menu-section-label">Other references</div>
        <button
          type="button"
          className="menu-row"
          onClick={() => add({ id: `ctx-diff-${Date.now()}`, label: "git diff · uncommitted", kind: "diff", detail: "current worktree" })}
        >
          <FileDiff size={13} />
          <span><b>Git diff</b><em>未提交改动 · 4 files</em></span>
          <Plus size={12} />
        </button>
        <button
          type="button"
          className="menu-row"
          onClick={() =>
            add({
              id: `ctx-url-${Date.now()}`,
              label: "hermes docs · desktop",
              kind: "url",
              detail: "https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
            })
          }
        >
          <Link2 size={13} />
          <span><b>URL</b><em>docs/user-guide/desktop</em></span>
          <Plus size={12} />
        </button>
      </div>
      <div className="menu-foot">键入 <Kbd>@</Kbd> 可随时打开此列表</div>
    </div>
  );
}

function SlashMenu({ onClose }: { onClose: () => void }) {
  const { dispatch } = useApp();
  const run = (command: string) => {
    dispatch({ type: "SET_CHAT_DRAFT", value: "" });
    if (command === "/new") dispatch({ type: "NEW_SESSION" });
    else if (command === "/checkpoint") dispatch({ type: "SET_OVERLAY", overlay: "checkpoints" });
    else if (command === "/journey") dispatch({ type: "SET_OVERLAY", overlay: "memoryGraph" });
    else if (command === "/memory") dispatch({ type: "OPEN_CAPABILITIES", tab: "memory" });
    else if (command === "/model") dispatch({ type: "SET_CHAT_MENUS", menus: { modelPickerOpen: true, slashOpen: false } });
    else if (command === "/help") dispatch({ type: "SET_OVERLAY", overlay: "shortcuts" });
    else if (command === "/compact") {
      dispatch({
        type: "SET_TOAST",
        title: "Context compacted",
        message: "保留决策与工具结果；历史压缩为摘要。（模拟）",
        tone: "success",
      });
    }
    onClose();
  };
  return (
    <div className="composer-menu slash-menu" role="dialog" aria-label="Slash commands">
      <div className="menu-heading">
        <div><b>Slash commands</b><span>在当前 Session 执行</span></div>
        <IconButton label="关闭" onClick={onClose}><X size={13} /></IconButton>
      </div>
      <div className="menu-scroll">
        {slashCommands.map((item) => (
          <button type="button" className="menu-row slash-row" key={item.command} onClick={() => run(item.command)}>
            <item.icon size={13} />
            <span><b>{item.command}</b><em>{item.hint}</em></span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="menu-foot">斜杠命令只作用于当前 <b>{stateLabel()}</b>（模拟）</div>
    </div>
  );
}

function stateLabel() {
  return "Gateway / Profile";
}

function AttachMenu({ onClose }: { onClose: () => void }) {
  const { dispatch } = useApp();
  const add = (attachment: Attachment) => {
    dispatch({ type: "ADD_ATTACHMENT", attachment });
    onClose();
  };
  return (
    <div className="composer-menu attach-menu" role="dialog" aria-label="添加附件">
      <div className="menu-heading">
        <div><b>添加附件</b><span>仅保存在本次原型会话</span></div>
        <IconButton label="关闭" onClick={onClose}><X size={13} /></IconButton>
      </div>
      <button type="button" className="menu-row" onClick={() => add({ id: `att-file-${Date.now()}`, name: "brief.md", kind: "file", detail: "2.4 KB" })}>
        <FileText size={13} /><span><b>文件</b><em>从当前主机选择</em></span><Paperclip size={12} />
      </button>
      <button type="button" className="menu-row" onClick={() => add({ id: `att-folder-${Date.now()}`, name: "src/", kind: "folder", detail: "12 files" })}>
        <Folder size={13} /><span><b>目录</b><em>递归引用文件清单</em></span><Paperclip size={12} />
      </button>
      <button type="button" className="menu-row" onClick={() => add({ id: `att-artifact-${Date.now()}`, name: "gateway-latency.html", kind: "artifact", detail: "artifact" })}>
        <Sparkles size={13} /><span><b>Artifact</b><em>从当前 profile 的 artifacts</em></span><Paperclip size={12} />
      </button>
    </div>
  );
}

function ModelMenu({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { state, dispatch } = useApp();
  return (
    <div className="composer-menu model-menu" role="dialog" aria-label="模型与推理级别">
      <div className="menu-heading">
        <div><b>Model & reasoning</b><span>{profile.handle} · provider routing auto</span></div>
        <IconButton label="关闭" onClick={onClose}><X size={13} /></IconButton>
      </div>
      <div className="model-list">
        {models.map((model) => (
          <button
            type="button"
            key={model.name}
            className={cn("model-row", state.chat.model === model.name && "is-active")}
            onClick={() => dispatch({ type: "SET_MODEL", model: model.name })}
          >
            <span className="model-mark">{model.name.slice(0, 1)}</span>
            <span><b>{model.name}</b><em>{model.provider} · {model.note}</em></span>
            {state.chat.model === model.name && <Check size={13} />}
          </button>
        ))}
      </div>
      <div className="model-config">
        <div className="field-inline">
          <span>Reasoning</span>
          <Segmented
            value={state.chat.reasoning}
            options={reasonings.map((reasoning) => ({ value: reasoning, label: reasoning }))}
            onChange={(value) => dispatch({ type: "SET_REASONING", reasoning: value })}
            label="推理级别"
          />
        </div>
        <div className="model-fact"><span>Fallback</span><b>Anthropic → OpenRouter</b></div>
        <div className="model-fact"><span>Subagent</span><b>Sonnet 4.5 · max 3</b></div>
      </div>
      <div className="menu-foot">Routing is stored per profile. <span className="sim-inline">Simulated</span></div>
    </div>
  );
}

function Composer() {
  const { state, dispatch } = useApp();
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const textId = useId();

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(160, Math.max(26, textarea.scrollHeight))}px`;
  }, [state.chat.draft]);

  const closeMenus = () => {
    setAttachOpen(false);
    setSlashOpen(false);
    setContextOpen(false);
    dispatch({ type: "SET_CHAT_MENUS", menus: { modelPickerOpen: false, slashOpen: false, contextOpen: false } });
  };

  const send = () => {
    const content = state.chat.draft.trim();
    if (!content && state.chat.attachments.length === 0 && state.chat.contexts.length === 0) return;
    const reply = makeReply(gateway, profile, content || "已附加引用");
    dispatch({
      type: "SEND_MESSAGE",
      content,
      reply,
      attachments: state.chat.attachments,
      contexts: state.chat.contexts,
    });
    closeMenus();
    textareaRef.current?.focus();
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    dispatch({ type: "SET_CHAT_DRAFT", value });
    setSlashOpen(value.startsWith("/"));
    if (value.endsWith("@")) setContextOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.metaKey && state.chat.history.length) {
      const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
      if (atStart || !state.chat.draft) {
        event.preventDefault();
        dispatch({ type: "HISTORY_PREV" });
        return;
      }
    }
    if (event.key === "ArrowDown" && !event.shiftKey && state.chat.historyIndex >= 0) {
      event.preventDefault();
      dispatch({ type: "HISTORY_NEXT" });
      return;
    }
    if (event.key === "Escape") {
      closeMenus();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const pickSuggestion = (prompt: string) => {
    dispatch({ type: "SET_CHAT_DRAFT", value: prompt });
    textareaRef.current?.focus();
  };

  const showEmpty = !getActiveSession(state)?.messages.length;

  return (
    <div className="composer-shell">
      {showEmpty && (
        <div className="prompt-suggestions" aria-label="建议提示">
          <button type="button" onClick={() => pickSuggestion("检查当前 Gateway 的 HTTP 与 WebSocket 状态")}>检查 Gateway 双链路</button>
          <button type="button" onClick={() => pickSuggestion("在不重启 Gateway 的前提下热重载 MCP")}>热重载 MCP</button>
          <button type="button" onClick={() => pickSuggestion("列出当前 Session 可恢复的 Checkpoint")}>查看 Checkpoint</button>
        </div>
      )}
      <div className="composer-context">
        <StatusDot tone={gateway.health === "error" ? "error" : "ok"} ring />
        <span>将从 <b>{gateway.name}</b> · <b>{profile.handle}</b> 执行</span>
        <span className={cn("sim-tag", isRemote(gateway) && "is-remote")}>{isRemote(gateway) ? "REMOTE CONTEXT" : "LOCAL"}</span>
      </div>
      <div className={cn("composer", state.chat.streaming && "is-streaming")}>
        {(state.chat.attachments.length > 0 || state.chat.contexts.length > 0) && (
          <div className="composer-chips">
            {state.chat.contexts.map((context) => (
              <span className="context-chip" key={context.id}>
                {context.kind === "diff" ? <FileDiff size={10} /> : context.kind === "folder" ? <Folder size={10} /> : context.kind === "url" ? <Link2 size={10} /> : <AtSign size={10} />}
                {context.label}
                <button type="button" aria-label={`移除引用 ${context.label}`} onClick={() => dispatch({ type: "REMOVE_CONTEXT", id: context.id })}><X size={9} /></button>
              </span>
            ))}
            {state.chat.attachments.map((attachment) => (
              <span className="attachment-chip" key={attachment.id}>
                <Paperclip size={10} />{attachment.name}
                <button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => dispatch({ type: "REMOVE_ATTACHMENT", id: attachment.id })}><X size={9} /></button>
              </span>
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor={textId}>发送消息给 {gateway.name} 的 {profile.name}</label>
        <textarea
          id={textId}
          ref={textareaRef}
          value={state.chat.draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="问 Hermes，或键入 / 和 @…"
          rows={1}
          spellCheck={false}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              const file = event.clipboardData.files[0];
              dispatch({ type: "ADD_ATTACHMENT", attachment: { id: `paste-${Date.now()}`, name: file.name, kind: "file", detail: `${Math.round(file.size / 1024)} KB` } });
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <div className="menu-anchor">
              <IconButton label="添加附件" onClick={() => { setAttachOpen((value) => !value); setSlashOpen(false); setContextOpen(false); }} aria-expanded={attachOpen}>
                <Plus size={15} />
              </IconButton>
              <IconButton label="引用上下文" onClick={() => { setContextOpen((value) => !value); setAttachOpen(false); setSlashOpen(false); }} aria-expanded={contextOpen}>
                <AtSign size={15} />
              </IconButton>
              <button
                type="button"
                className={cn("tool-text", slashOpen && "is-active")}
                aria-label="Slash commands"
                title="Slash commands"
                onClick={() => { setSlashOpen((value) => !value); setAttachOpen(false); setContextOpen(false); }}
              >
                /
              </button>
              <button
                type="button"
                className="model-chip"
                onClick={() => dispatch({ type: "SET_CHAT_MENUS", menus: { modelPickerOpen: !state.chat.modelPickerOpen, slashOpen: false, contextOpen: false } })}
                aria-expanded={state.chat.modelPickerOpen}
              >
                <b>{state.chat.model}</b><span>/</span>{state.chat.reasoning}<ChevronDown size={11} />
              </button>
            </div>
            <span className="composer-shortcut"><Kbd>↑</Kbd> 历史 <Kbd>⇧↵</Kbd> 换行</span>
          </div>
          <div className="composer-end">
            <IconButton label="语音模式" onClick={() => dispatch({ type: "OPEN_WORKSPACE", tab: "voice" })}>
              <Mic size={15} />
            </IconButton>
            {state.chat.streaming ? (
              <button type="button" className="send-button is-stop" aria-label="停止生成" onClick={() => dispatch({ type: "FINISH_STREAMING" })}>
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button type="button" className="send-button" aria-label="发送消息" onClick={send}>
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
        {attachOpen && <AttachMenu onClose={() => setAttachOpen(false)} />}
        {contextOpen && <ContextMenu gateway={gateway} onClose={() => setContextOpen(false)} />}
        {slashOpen && <SlashMenu onClose={() => setSlashOpen(false)} />}
        {state.chat.modelPickerOpen && <ModelMenu profile={profile} onClose={() => dispatch({ type: "SET_CHAT_MENUS", menus: { modelPickerOpen: false } })} />}
      </div>
    </div>
  );
}

function BotHeaderStrip() {
  const { state, dispatch } = useApp();
  const bot = getActiveBot(state);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  if (!bot || state.sidebarMode !== "bots") return null;
  const routines = getRoutinesForBot(state, bot.id);
  const gateway = getGateway(state, bot.gatewayId);
  return (
    <div className="bot-context-strip">
      <span className="bot-avatar large" style={{ background: bot.color }}>{bot.avatar}</span>
      <div>
        <b>{bot.name}</b>
        <span>{bot.title} · {gateway?.name} · {bot.handle}</span>
      </div>
      <button type="button" onClick={() => setRoutinesOpen((value) => !value)} aria-expanded={routinesOpen}>
        <Workflow size={12} /> Routines <em>{routines.length}</em> <ChevronDown size={11} />
      </button>
      {routinesOpen && (
        <div className="routines-popover">
          <div className="menu-heading"><div><b>Bot Routines</b><span>只作用于 {bot.handle}</span></div><IconButton label="关闭" onClick={() => setRoutinesOpen(false)}><X size={13} /></IconButton></div>
          {routines.map((routine) => (
            <div className="routine-row" key={routine.id}>
              <span><b>{routine.name}</b><em>{routine.schedule} · 下次 {routine.nextRun}</em></span>
              <Toggle checked={routine.status === "active"} onChange={() => dispatch({ type: "TOGGLE_ROUTINE", routineId: routine.id })} label={`${routine.name} 启用`} />
            </div>
          ))}
          <div className="menu-foot">Routines 是 Bot Mode 的调度层，与 Cron 共用执行队列。</div>
        </div>
      )}
    </div>
  );
}

function CheckpointMarker({ session }: { session?: Session }) {
  const { dispatch } = useApp();
  if (!session?.checkpoints.length) return null;
  const last = session.checkpoints[0];
  return (
    <button type="button" className="checkpoint-marker" onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "checkpoints" })}>
      <History size={12} />
      <span>Checkpoint · {last.time}</span>
      <em>{last.files} files</em>
      <span>恢复</span>
    </button>
  );
}

export function ChatSurface() {
  const { state, dispatch } = useApp();
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const session = getActiveSession(state);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesLength = session?.messages.length ?? 0;
  const previousSessionRef = useRef<string | undefined>(undefined);
  const previousCountRef = useRef(0);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = previousSessionRef.current !== session?.id;
    const countChanged = previousCountRef.current !== messagesLength;
    if (sessionChanged) {
      node.scrollTo({ top: 0, behavior: "auto" });
    } else if (countChanged || state.chat.streaming) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
    previousSessionRef.current = session?.id;
    previousCountRef.current = messagesLength;
  }, [messagesLength, session?.id, state.chat.streaming]);

  const onlineMcp = scopedMcpServers(state).filter((server) => server.enabled).length;
  const hiddenWorkspace = state.workspace.mode === "hidden";

  return (
    <main className="chat-main">
      <RouteBar />
      <BotHeaderStrip />
      {gateway.health === "error" && (
        <div className="chat-alert-wrap">
          <InlineNotice
            tone="danger"
            action={<Button variant="secondary" onClick={() => dispatch({ type: "TOGGLE_GATEWAY_SWITCHER" })}>切换 Gateway</Button>}
          >
            <b>{gateway.name} 不可达。</b> 当前 Session 仍然显示，但新消息不会送达；请先 Test 或切换到其它执行上下文。
          </InlineNotice>
        </div>
      )}
      <div className="transcript" ref={scrollRef}>
        <div className="thread">
          {!session ? (
            <EmptyState
              icon={<HermesMark size={30} />}
              title="没有打开的 Session"
              body="在当前 Gateway / Profile 下新建对话，或者从左侧选择一个 Session。"
              action={<Button variant="primary" onClick={() => dispatch({ type: "NEW_SESSION" })}><Plus size={13} /> 新对话</Button>}
            />
          ) : session.messages.length === 0 ? (
            <div className="fresh-session">
              <div className="fresh-mark"><HermesMark size={28} /></div>
              <h1>安静地去问。</h1>
              <p>告诉 Hermes 你要完成什么。第一条消息之后，这里只留下对话与必要的工具轨迹。</p>
              <div className="fresh-scope">
                <span><StatusDot tone="ok" /> HTTP + WS</span>
                <span>{gateway.name}</span>
                <span>{profile.handle}</span>
                <span>{profile.model} / {profile.effort}</span>
              </div>
            </div>
          ) : (
            <>
              <div className="session-intro">
                <div className="session-intro-meta">
                  <span>{gateway.name} · {profile.handle}</span>
                  <span>·</span>
                  <span>{session.updatedAt}</span>
                </div>
                <h1>{session.title}</h1>
              </div>
              <div className="route-spine" aria-hidden="true" />
              {session.messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  streaming={state.chat.streaming && message.id === state.chat.streamingMessageId}
                  onStreamDone={() => dispatch({ type: "FINISH_STREAMING" })}
                />
              ))}
              <CheckpointMarker session={session} />
            </>
          )}
        </div>
      </div>
      <Composer />
      <footer className="statusbar">
        <span className="status-context">
          <StatusDot tone={gateway.health === "error" ? "error" : "ok"} ring />
          {gateway.name.toUpperCase()} · {state.allProfiles ? "ALL PROFILES" : profile.name}
        </span>
        <span>MCP {onlineMcp}/{scopedMcpServers(state).length}</span>
        <span>context <span className="context-meter"><i /></span> 38%</span>
        <span className="branch-label"><FileDiff size={10} /> main</span>
        <button type="button" className="status-settings" onClick={() => dispatch({ type: "OPEN_SETTINGS", section: "safety" })}>
          <ShieldCheck size={10} /> Safety
        </button>
        <span className="status-spacer" />
        {hiddenWorkspace && (
          <button type="button" className="hidden-workspace-chip" onClick={() => dispatch({ type: "OPEN_WORKSPACE" })}>
            <PanelRight size={10} /> Workspace hidden · state kept
          </button>
        )}
        <button type="button" className="status-command" onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "palette" })}>
          <Command size={10} /> ⌘K
        </button>
        <span className="status-sim">原型模拟 · 未连接真实 gateway</span>
      </footer>
    </main>
  );
}
