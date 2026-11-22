import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Bot,
  Cable,
  Check,
  ChevronDown,
  CloudCog,
  Cpu,
  Download,
  FolderOpen,
  KeyRound,
  Laptop,
  Layers,
  MemoryStick,
  Mic,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { Gateway, GatewayAuth, GatewayKind, SettingsSection } from "../types";
import { useApp } from "../state/AppContext";
import { getActiveGateway, getActiveProfile, getProfilesForGateway } from "../state/store";
import { cn, gatewayKind, gatewayTransport, healthLabel, latency, slugify } from "../lib/ui";
import { simulateGatewayTest, simulateUpdateAll } from "../lib/simulation";
import {
  Button,
  Field,
  IconButton,
  InlineNotice,
  Modal,
  SectionTitle,
  Segmented,
  StatusDot,
  Toggle,
} from "./ui";

const sections: Array<{ id: SettingsSection; label: string; icon: typeof Cpu }> = [
  { id: "model", label: "Model", icon: Cpu },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "safety", label: "Safety", icon: ShieldCheck },
  { id: "memory", label: "Memory & Context", icon: MemoryStick },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "chat", label: "Chat", icon: Sparkles },
  { id: "gateways", label: "Gateways", icon: Network },
  { id: "updates", label: "Updates", icon: Download },
];

function AppliesTo() {
  const { state, dispatch } = useApp();
  const profiles = state.profiles;
  const current = profiles.find(
    (profile) =>
      profile.gatewayId === state.settings.scopeGatewayId &&
      profile.id === state.settings.scopeProfileId,
  );
  return (
    <div className="applies-row">
      <span className="micro-label">Applies to</span>
      <div className="applies-chips">
        {profiles.map((profile) => (
          <button
            type="button"
            key={`${profile.gatewayId}:${profile.id}`}
            className={cn(profile.id === current?.id && "is-active")}
            onClick={() =>
              dispatch({
                type: "SET_SETTINGS_SCOPE",
                gatewayId: profile.gatewayId,
                profileId: profile.id,
              })
            }
            title={`${state.gateways.find((gateway) => gateway.id === profile.gatewayId)?.name} / ${profile.handle}`}
          >
            <span style={{ color: profile.color }}>{profile.initials}</span>
            {profile.handle}
          </button>
        ))}
      </div>
      {current && (
        <span className="applies-note">
          <StatusDot tone="ok" />
          {state.gateways.find((gateway) => gateway.id === current.gatewayId)?.name}
        </span>
      )}
    </div>
  );
}

function ModelSettings() {
  const { state, dispatch } = useApp();
  const scopedProfile = state.profiles.find(
    (profile) =>
      profile.gatewayId === state.settings.scopeGatewayId &&
      profile.id === state.settings.scopeProfileId,
  );
  const [selected, setSelected] = useState(scopedProfile?.model ?? state.chat.model);
  const [fallback, setFallback] = useState(true);
  const [routing, setRouting] = useState("auto");
  useEffect(() => {
    setSelected(scopedProfile?.model ?? state.chat.model);
  }, [scopedProfile?.id, scopedProfile?.model, state.chat.model]);
  return (
    <div className="settings-pane">
      <SectionTitle title="Model & reasoning" detail="模型路由跟随 profile；切换 profile 时自动恢复它上一次的选择。" />
      <div className="model-settings-list">
        {[
          ["Opus 4.5", "Anthropic", "深度执行 · 默认"],
          ["Sonnet 4.5", "Anthropic", "平衡 · 日常"],
          ["GPT-5.2", "OpenAI", "长上下文与代码"],
          ["Gemini 3 Pro", "Google", "多模态"],
        ].map(([name, provider, detail]) => (
          <button
            type="button"
            key={name}
            className={cn("model-setting-row", selected === name && "is-active")}
            onClick={() => setSelected(name)}
          >
            <span className="provider-token">{provider.slice(0, 1)}</span>
            <span><b>{name}</b><em>{provider} · {detail}</em></span>
            {selected === name && <Check size={14} />}
          </button>
        ))}
      </div>
      <div className="settings-block">
        <div className="setting-line">
          <div><b>Provider routing</b><span>Auto 会按延迟与可用性在同级模型中路由</span></div>
          <Segmented
            value={routing}
            options={[{ value: "auto", label: "Auto" }, { value: "pinned", label: "Pinned" }]}
            onChange={setRouting}
            label="Provider routing"
          />
        </div>
        <div className="setting-line">
          <div><b>Fallback model</b><span>主模型不可用时切到 Sonnet 4.5</span></div>
          <Toggle checked={fallback} onChange={setFallback} label="Fallback model" />
        </div>
        <div className="setting-line">
          <div><b>Subagent model</b><span>委派任务默认使用 Sonnet 4.5 · 最多 3 个并发</span></div>
          <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "Subagent routing", message: "子代理模型路由编辑器（模拟）。" })}>配置</Button>
        </div>
      </div>
      <div className="settings-save-row">
        <span>修改只应用到当前 profile。</span>
        <Button
          variant="primary"
          onClick={() => {
            dispatch({
              type: "SET_PROFILE_MODEL",
              gatewayId: state.settings.scopeGatewayId,
              profileId: state.settings.scopeProfileId,
              model: selected,
            });
            dispatch({
              type: "SET_TOAST",
              title: "Model settings saved",
              message: `${selected} · ${scopedProfile?.handle ?? state.settings.scopeProfileId}（模拟）`,
              tone: "success",
            });
          }}
        >
          保存 Model
        </Button>
      </div>
    </div>
  );
}

function WorkspaceSettings() {
  const { state, dispatch } = useApp();
  const [worktrees, setWorktrees] = useState(true);
  const [openTerminal, setOpenTerminal] = useState(false);
  return (
    <div className="settings-pane">
      <SectionTitle title="Workspace" detail="工作区根目录、worktree 策略与终端行为按 profile 保存。" />
      <div className="settings-block">
        <Field label="Workspace root" hint="文件树与 @ 引用只会读取此目录及显式允许的路径。">
          <div className="input-with-action">
            <input defaultValue={state.settings.scopeGatewayId === "local" ? "~/workspace" : "~/hermes-web"} readOnly />
            <Button variant="quiet"><FolderOpen size={12} /> 选择</Button>
          </div>
        </Field>
        <div className="setting-line">
          <div><b>独立 Worktree</b><span>子代理与 Git review 默认使用隔离 worktree</span></div>
          <Toggle checked={worktrees} onChange={setWorktrees} label="独立 Worktree" />
        </div>
        <div className="setting-line">
          <div><b>打开终端时自动运行</b><span>在工作区终端中打开并保留 scrollback</span></div>
          <Toggle checked={openTerminal} onChange={setOpenTerminal} label="打开终端时自动运行" />
        </div>
        <div className="setting-line">
          <div><b>Hide 行为</b><span>隐藏时保留终端、预览和 pin 状态；只有 Close 才释放</span></div>
          <span className="fixed-value">Hide keeps state</span>
        </div>
      </div>
      <div className="settings-block compact-block">
        <div className="micro-label">Worktree location</div>
        <code className="path-code">~/.hermes/worktrees/{state.settings.scopeProfileId}/</code>
      </div>
      <div className="settings-save-row"><span>Workspace 设置会随 Gateway 能力自动调整。</span><Button variant="primary" onClick={() => dispatch({ type: "SET_TOAST", title: "Workspace saved", message: "路径与 worktree 策略已保存（模拟）。", tone: "success" })}>保存 Workspace</Button></div>
    </div>
  );
}

function SafetySettings() {
  const { dispatch } = useApp();
  const [approval, setApproval] = useState("always");
  const [readOnly, setReadOnly] = useState(true);
  const [sshConfirm, setSshConfirm] = useState(true);
  return (
    <div className="settings-pane">
      <SectionTitle title="Safety" detail="所有审批都显示精确命令、工作目录与目标主机。" />
      <div className="safety-seal">
        <ShieldCheck size={18} />
        <div><b>Execution context is a safety control</b><span>跨 Gateway 的操作不会被静默重定向；审批卡始终锁定发起时的目标主机。</span></div>
        <span>FLOOR</span>
      </div>
      <div className="settings-block">
        <div className="setting-line vertical">
          <div><b>危险命令</b><span>删除、force push、部署与数据库变更</span></div>
          <Segmented
            value={approval}
            options={[{ value: "always", label: "始终批准" }, { value: "allowlist", label: "Allowlist 自动" }, { value: "block", label: "全部阻止" }]}
            onChange={setApproval}
            label="危险命令审批策略"
          />
        </div>
        <div className="setting-line">
          <div><b>只读工具自动批准</b><span>仍记录完整参数与输出到工具轨迹</span></div>
          <Toggle checked={readOnly} onChange={setReadOnly} label="只读工具自动批准" />
        </div>
        <div className="setting-line">
          <div><b>SSH 命令二次确认</b><span>目标为 SSH gateway 时增加一次 target 确认</span></div>
          <Toggle checked={sshConfirm} onChange={setSshConfirm} label="SSH 命令二次确认" />
        </div>
      </div>
      <div className="settings-block">
        <SectionTitle title="Allowlist" detail="匹配完整命令，不支持模糊前缀自动放行。" action={<Button variant="quiet"><Plus size={11} /> 添加规则</Button>} />
        {["pnpm build", "git status", "rg --files"].map((command) => (
          <div className="allowlist-rule" key={command}><code>{command}</code><span>scope: {approval === "always" ? "current profile" : "all profiles"}</span><IconButton label={`删除规则 ${command}`}><X size={11} /></IconButton></div>
        ))}
      </div>
      <div className="settings-save-row"><span>安全策略不允许仅靠颜色表达状态。</span><Button variant="primary" onClick={() => dispatch({ type: "SET_TOAST", title: "Safety saved", message: "审批策略已更新（模拟）。", tone: "success" })}>保存 Safety</Button></div>
    </div>
  );
}

function MemorySettings() {
  const { dispatch } = useApp();
  const [checkpoints, setCheckpoints] = useState(true);
  const [autoCompact, setAutoCompact] = useState(true);
  const [provider, setProvider] = useState("local");
  return (
    <div className="settings-pane">
      <SectionTitle title="Memory & Context" detail="Memory 按 profile 保存；Checkpoints 按 session 保存。" action={<Button variant="quiet" onClick={() => dispatch({ type: "OPEN_CAPABILITIES", tab: "memory" })}>编辑 Memory <ArrowRight size={11} /></Button>} />
      <div className="settings-block">
        <div className="setting-line"><div><b>Checkpoints 自动快照</b><span>每次工具改动前保留可回滚快照</span></div><Toggle checked={checkpoints} onChange={setCheckpoints} label="Checkpoints 自动快照" /></div>
        <div className="setting-line"><div><b>自动压缩长上下文</b><span>保留决策、未完成事项与工具结果</span></div><Toggle checked={autoCompact} onChange={setAutoCompact} label="自动压缩长上下文" /></div>
        <div className="setting-line"><div><b>最大保留</b><span>每个 session 的自动 Checkpoint 数量</span></div><span className="fixed-value">12 snapshots</span></div>
      </div>
      <div className="settings-block">
        <div className="micro-label">Memory provider</div>
        <div className="provider-options">
          {[
            ["local", "Local files", "MEMORY.md / USER.md / SOUL.md"],
            ["external", "External provider", "未配置 · 需要 API key"],
          ].map(([id, label, hint]) => (
            <button type="button" key={id} className={cn(provider === id && "is-active")} onClick={() => setProvider(id)}>
              <span className="provider-token">{id === "local" ? "L" : "E"}</span>
              <span><b>{label}</b><em>{hint}</em></span>
              {provider === id && <Check size={13} />}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-save-row"><span>Memory Graph 不离开本机，除非连接外部 provider。</span><Button variant="primary" onClick={() => dispatch({ type: "SET_TOAST", title: "Memory saved", message: "Memory 与 Checkpoint 偏好已保存（模拟）。", tone: "success" })}>保存 Memory</Button></div>
    </div>
  );
}

function VoiceSettings() {
  const { dispatch } = useApp();
  const [wake, setWake] = useState(true);
  const [tts, setTts] = useState(true);
  const [voice, setVoice] = useState("Warm neutral");
  return (
    <div className="settings-pane">
      <SectionTitle title="Voice" detail="Wake word 只监听本地麦克风；不会将音频发往未选择的 provider。" action={<Button variant="quiet" onClick={() => dispatch({ type: "OPEN_WORKSPACE", tab: "voice" })}>打开 Voice Mode <ArrowRight size={11} /></Button>} />
      <div className="voice-setting-hero">
        <div className="waveform-static" aria-hidden="true">
          {[12, 24, 8, 34, 18, 42, 28, 13, 36, 21, 9, 27, 16, 32, 11].map((height, index) => <i key={index} style={{ height }} />)}
        </div>
        <div><b>“Hey Hermes”</b><span>等待唤醒 · 本地监听</span></div>
        <Toggle checked={wake} onChange={setWake} label="Hey Hermes 唤醒词" />
      </div>
      <div className="settings-block">
        <div className="setting-line"><div><b>语音回复（TTS）</b><span>回复完成后朗读；可随时用 Space 打断</span></div><Toggle checked={tts} onChange={setTts} label="语音回复" /></div>
        <div className="setting-line"><div><b>Voice</b><span>当前 provider 的可用音色</span></div><span className="fixed-value">{voice}</span></div>
        <div className="voice-choice-row">
          {["Warm neutral", "Crisp editorial", "Low and calm"].map((name) => (
            <button type="button" key={name} className={cn(voice === name && "is-active")} onClick={() => setVoice(name)}>{name}</button>
          ))}
        </div>
      </div>
      <div className="settings-note"><Mic size={13} /> 原型不会请求麦克风权限；Voice Mode 状态为模拟。</div>
    </div>
  );
}

function ChatSettings() {
  const { dispatch } = useApp();
  const [stream, setStream] = useState(true);
  const [toolRows, setToolRows] = useState(true);
  const [copyAs, setCopyAs] = useState("markdown");
  return (
    <div className="settings-pane">
      <SectionTitle title="Chat" detail="控制回答节奏与工具轨迹的默认呈现。" />
      <div className="settings-block">
        <div className="setting-line"><div><b>流式回答</b><span>逐段显示，停止按钮可立即中断</span></div><Toggle checked={stream} onChange={setStream} label="流式回答" /></div>
        <div className="setting-line"><div><b>工具调用行</b><span>默认折叠；展开可见 args、output 与 image</span></div><Toggle checked={toolRows} onChange={setToolRows} label="工具调用行" /></div>
        <div className="setting-line vertical"><div><b>复制格式</b><span>回答工具栏的默认复制格式</span></div><Segmented value={copyAs} options={[{ value: "markdown", label: "Markdown" }, { value: "plain", label: "纯文本" }]} onChange={setCopyAs} label="复制格式" /></div>
        <div className="setting-line"><div><b>会话分组</b><span>今天 / 昨天 / 更早；置顶单独显示</span></div><span className="fixed-value">按日期</span></div>
      </div>
      <div className="settings-block settings-preview">
        <div className="micro-label">Welcome message</div>
        <p>安静地去问。告诉 Hermes 你要完成什么。第一条消息之后，这里只留下对话与必要的工具轨迹。</p>
      </div>
      <div className="settings-save-row"><span>Chat 偏好按 profile 保存。</span><Button variant="primary" onClick={() => dispatch({ type: "SET_TOAST", title: "Chat saved", message: "呈现方式已更新（模拟）。", tone: "success" })}>保存 Chat</Button></div>
    </div>
  );
}

function GatewayForm({
  gateway,
  onClose,
}: {
  gateway?: Gateway;
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const [kind, setKind] = useState<GatewayKind>(gateway?.kind ?? "remote");
  const [name, setName] = useState(gateway?.name ?? "");
  const [host, setHost] = useState(gateway?.host ?? "");
  const [auth, setAuth] = useState<GatewayAuth>(gateway?.auth ?? "session-token");
  const [token, setToken] = useState("");
  const [nameError, setNameError] = useState("");
  const isEdit = Boolean(gateway);
  const kindLocked = gateway?.kind === "local" || gateway?.kind === "cloud";

  const submit = () => {
    if (!name.trim()) {
      setNameError("请为这台机器填写唯一名称。");
      return;
    }
    const duplicate = state.gateways.some(
      (row) => row.id !== gateway?.id && row.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (duplicate) {
      setNameError("该名称已被另一台机器使用。");
      return;
    }
    const nextGateway: Gateway = {
      id: gateway?.id ?? slugify(name),
      name: name.trim(),
      kind,
      health: gateway?.health ?? "degraded",
      latencyMs: gateway?.latencyMs ?? null,
      primary: gateway?.primary ?? false,
      appManaged: kind === "local",
      auth,
      host: kind === "cloud" ? "cloud.hermes.run" : host.trim(),
      detail:
        kind === "ssh"
          ? "hermes gateway attach · managed tunnel"
          : kind === "cloud"
            ? "Portal-managed instance"
            : "hermes serve · session token",
      lastTest: gateway?.lastTest ?? "Not tested yet",
      lastTestTone: gateway?.lastTestTone ?? "warn",
      update: gateway?.update ?? "idle",
      color: gateway?.color ?? "#C8442E",
    };
    if (gateway) {
      dispatch({ type: "EDIT_GATEWAY", gateway: nextGateway });
      window.setTimeout(() => simulateGatewayTest(dispatch, nextGateway), 200);
    } else {
      dispatch({ type: "ADD_GATEWAY", gateway: nextGateway });
      window.setTimeout(() => simulateGatewayTest(dispatch, nextGateway), 200);
    }
    onClose();
  };

  return (
    <div className="gateway-form">
      <div className="gateway-form-head">
        <div>
          <h3>{isEdit ? `编辑 ${gateway?.name}` : "连接 Hermes Gateway"}</h3>
        </div>
        <IconButton label="关闭表单" onClick={onClose}><X size={14} /></IconButton>
      </div>
      {!kindLocked && (
        <div className="gateway-kind-picker" role="group" aria-label="连接类型">
          {([
            ["remote", "Remote HTTP(S)", Cable, "LAN · Tailscale · VPS"],
            ["ssh", "SSH", Terminal, "Managed tunnel + attach"],
            ["cloud", "Hermes Cloud", CloudCog, "Portal-managed"],
          ] as const).map(([id, label, Icon, hint]) => (
            <button
              type="button"
              key={id}
              className={cn(kind === id && "is-active")}
              onClick={() => {
                setKind(id);
                setAuth(id === "ssh" ? "ssh-key" : id === "cloud" ? "portal" : "session-token");
              }}
            >
              <Icon size={14} />
              <span><b>{label}</b><em>{hint}</em></span>
            </button>
          ))}
        </div>
      )}
      <div className="gateway-form-grid">
        <Field label="Device name" hint="必须唯一，例如 Homelab、Studio Mac">
          <input value={name} onChange={(event) => { setName(event.target.value); setNameError(""); }} placeholder="Homelab" />
        </Field>
        {kind !== "cloud" && (
          <Field label={kind === "ssh" ? "SSH target" : "Gateway URL"} hint={kind === "ssh" ? "user@host:port" : "https://host · HTTP + WS"}>
            <input value={host} onChange={(event) => setHost(event.target.value)} placeholder={kind === "ssh" ? "omer@homelab.lan:22" : "https://vps1.hermes.run"} />
          </Field>
        )}
        <Field label="Authentication" hint={kind === "ssh" ? "使用系统 SSH agent / key" : kind === "cloud" ? "通过 Hermes Portal 授权" : "token 或 OAuth 由 gateway 提供"}>
          <div className="select-wrap">
            <select value={auth} onChange={(event) => setAuth(event.target.value as GatewayAuth)}>
              {kind === "remote" && <><option value="session-token">Session token</option><option value="oauth">OAuth</option></>}
              {kind === "ssh" && <option value="ssh-key">SSH key</option>}
              {kind === "cloud" && <option value="portal">Portal OAuth</option>}
              {kind === "local" && <option value="automatic">App-managed</option>}
            </select>
            <ChevronDown size={12} />
          </div>
        </Field>
        {kind === "remote" && auth === "session-token" && (
          <Field label="Session token" hint="仅保存在 gateway host；原型不存储真实 token">
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="tok_••••••••" autoComplete="off" />
          </Field>
        )}
      </div>
      {nameError && <p className="form-error" role="alert">{nameError}</p>}
      <div className="gateway-form-note">
        {kind === "ssh" ? <><KeyRound size={13} /> Desktop 会复用系统 SSH agent，并为 gateway attach 创建一次性 ticket。</> : kind === "cloud" ? <><CloudCog size={13} /> 实例与更新由 Hermes Portal 管理；连接只保存引用。</> : <><Network size={13} /> 保存后会测试 HTTP 与 WebSocket 两条腿，不重启实例。</>}
      </div>
      <div className="gateway-form-actions">
        <Button variant="quiet" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={submit}>{isEdit ? "保存并重新 Test" : "保存并 Test"}</Button>
      </div>
    </div>
  );
}

function GatewayRegistry() {
  const { state, dispatch } = useApp();
  const [editing, setEditing] = useState<Gateway | "new" | null>(null);
  const [removing, setRemoving] = useState<Gateway | null>(null);

  if (editing) {
    return <GatewayForm gateway={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />;
  }

  return (
    <div className="settings-pane gateway-registry">
      <SectionTitle
        title="Gateway registry"
        detail="四种连接共存。Local 由 App 管理；Cloud 由 Portal 管理；同一个窗口只连接一个活动 gateway。"
        action={<Button variant="primary" onClick={() => setEditing("new")}><Plus size={12} /> 连接 Gateway</Button>}
      />
      <div className="registry-summary">
        <span><StatusDot tone="ok" /> {state.gateways.filter((gateway) => gateway.health === "reachable").length} reachable</span>
        <span>{state.gateways.length} registered</span>
        <span>Primary · {state.gateways.find((gateway) => gateway.id === state.primaryGatewayId)?.name}</span>
        <Button variant="quiet" onClick={() => simulateUpdateAll(dispatch, state.gateways)}><RefreshCw size={11} /> Update all</Button>
      </div>
      <div className="registry-list">
        {state.gateways.map((gateway) => (
          <div className={cn("registry-row", gateway.id === state.activeGatewayId && "is-active")} key={gateway.id}>
            <div className="registry-main">
              <span className={cn("registry-icon", `kind-${gateway.kind}`)}>
                {gateway.kind === "local" ? <Laptop size={14} /> : gateway.kind === "ssh" ? <Terminal size={14} /> : gateway.kind === "cloud" ? <CloudCog size={14} /> : <Server size={14} />}
              </span>
              <div className="registry-copy">
                <div>
                  <b>{gateway.name}</b>
                  <span className={cn("kind-pill", `kind-${gateway.kind}`)}>{gatewayKind(gateway)}</span>
                  {gateway.id === state.primaryGatewayId && <span className="primary-pill"><Star size={8} fill="currentColor" /> PRIMARY</span>}
                  {gateway.id === state.activeGatewayId && <span className="active-pill">ACTIVE</span>}
                </div>
                <p>{gateway.host} · {gatewayTransport(gateway)}</p>
                <span className={cn("registry-health", gateway.lastTestTone === "error" && "is-error")}>
                  <StatusDot tone={gateway.health === "error" ? "error" : gateway.health === "testing" ? "warn" : "ok"} />
                  {healthLabel(gateway)} · {latency(gateway)} · {gateway.lastTest}
                </span>
              </div>
              <div className="registry-row-actions">
                <Button
                  variant="quiet"
                  disabled={gateway.health === "testing"}
                  onClick={() => simulateGatewayTest(dispatch, gateway)}
                >
                  <RefreshCw size={11} className={cn(gateway.health === "testing" && "spin")} /> Test
                </Button>
                <Button variant="quiet" onClick={() => dispatch({ type: "SET_PRIMARY", gatewayId: gateway.id })} disabled={gateway.id === state.primaryGatewayId}>
                  <Star size={11} /> Primary
                </Button>
                <IconButton label={`编辑 ${gateway.name}`} onClick={() => setEditing(gateway)}><Pencil size={12} /></IconButton>
                <IconButton
                  label={`移除 ${gateway.name}`}
                  disabled={gateway.kind === "local" || gateway.appManaged}
                  onClick={() => setRemoving(gateway)}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            </div>
            <div className="registry-update">
              <span className={cn("update-state", `is-${gateway.update}`)}>
                {gateway.update === "updating" ? <RefreshCw size={10} className="spin" /> : gateway.update === "done" ? <Check size={10} /> : gateway.update === "skipped" ? <CloudCog size={10} /> : gateway.update === "error" ? <AlertTriangle size={10} /> : <Download size={10} />}
                {gateway.update === "idle" ? "update ready" : gateway.update === "skipped" ? "platform-managed" : gateway.update}
              </span>
              {gateway.kind === "local" && <span className="locked-note">App-managed · 不可移除</span>}
            </div>
            <button
              type="button"
              className="registry-connect"
              onClick={() => {
                dispatch({ type: "SWITCH_GATEWAY", gatewayId: gateway.id });
                dispatch({ type: "CLOSE_OVERLAY" });
              }}
            >
              切换到此 Gateway <ArrowRight size={11} />
            </button>
            {removing?.id === gateway.id && (
              <div className="remove-confirm">
                <InlineNotice tone="danger">
                  <b>移除连接「{gateway.name}」？</b> 实例本身不会被删除；此 scope 的 Session、Cron、MCP 与 Memory 将从列表隐藏。
                </InlineNotice>
                <Button variant="quiet" onClick={() => setRemoving(null)}>取消</Button>
                <Button variant="danger" onClick={() => { dispatch({ type: "REMOVE_GATEWAY", gatewayId: gateway.id }); setRemoving(null); }}>移除连接</Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="registry-footnote">
        <KeyRound size={12} /> 所有健康、延迟与测试结果均为原型模拟。不会发起真实 HTTP / WebSocket / SSH 请求。
      </div>
    </div>
  );
}

function UpdatesSettings() {
  const { state, dispatch } = useApp();
  return (
    <div className="settings-pane">
      <SectionTitle
        title="Updates"
        detail="Hermes Desktop 更新与 gateway instance 更新分开管理。"
        action={<Button variant="primary" onClick={() => simulateUpdateAll(dispatch, state.gateways)}><Download size={12} /> Update all instances</Button>}
      />
      <div className="update-hero">
        <span className="update-mark"><BadgeCheck size={18} /></span>
        <div><b>Hermes Desktop 0.9.4</b><span>已是最新版本 · 检查于今天 11:20</span></div>
        <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "Desktop is up to date", message: "0.9.4 · stable channel（模拟）。", tone: "success" })}><RefreshCw size={11} /> 检查</Button>
      </div>
      <SectionTitle title="Gateway instances" detail="Cloud 由 Portal 平台更新；不可达实例会跳过。" />
      <div className="registry-update-list">
        {state.gateways.map((gateway) => (
          <div className="update-row" key={gateway.id}>
            <span className={cn("registry-icon", `kind-${gateway.kind}`)}>{gateway.kind === "local" ? <Laptop size={13} /> : gateway.kind === "cloud" ? <CloudCog size={13} /> : <Server size={13} />}</span>
            <div><b>{gateway.name}</b><span>{gatewayTransport(gateway)} · {gateway.kind === "cloud" ? "Portal-managed" : "update channel stable"}</span></div>
            <span className={cn("update-state", `is-${gateway.update}`)}>
              {gateway.update === "idle" ? "up to date" : gateway.update === "skipped" ? "skipped" : gateway.update === "updating" ? <><RefreshCw size={10} className="spin" /> updating</> : gateway.update === "done" ? <><Check size={10} /> updated</> : gateway.update === "error" ? <><AlertTriangle size={10} /> unreachable</> : gateway.update}
            </span>
            <Button variant="quiet" disabled={gateway.kind === "cloud" || gateway.update === "updating"} onClick={() => simulateUpdateAll(dispatch, [gateway])}>更新</Button>
          </div>
        ))}
      </div>
      <div className="settings-note"><Layers size={13} /> 更新状态按 row 展示；原型只模拟 fan-out，不下载或执行任何真实更新。</div>
    </div>
  );
}

export function SettingsOverlay() {
  const { state, dispatch } = useApp();
  const open = state.overlay === "settings";
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const profiles = getProfilesForGateway(state, state.settings.scopeGatewayId);
  return (
    <Modal
      open={open}
      title="Settings"
      description={`${gateway.name} · ${profile.handle} · 设置按 profile 保存`}
      onClose={() => dispatch({ type: "CLOSE_OVERLAY" })}
      className="settings-modal"
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((section) => (
            <button
              type="button"
              key={section.id}
              className={cn(state.settings.section === section.id && "is-active")}
              aria-current={state.settings.section === section.id ? "page" : undefined}
              onClick={() => dispatch({ type: "SET_SETTINGS_SECTION", section: section.id })}
            >
              <section.icon size={14} />
              <span>{section.label}</span>
              {section.id === "gateways" && <em>{state.gateways.length}</em>}
            </button>
          ))}
          <div className="settings-nav-foot">
            <Settings2 size={11} /> Hermes Desktop
            <span>0.9.4</span>
          </div>
        </nav>
        <div className="settings-content">
          {state.settings.section !== "gateways" && state.settings.section !== "updates" && profiles.length > 1 && <AppliesTo />}
          {state.settings.section === "model" && <ModelSettings />}
          {state.settings.section === "workspace" && <WorkspaceSettings />}
          {state.settings.section === "safety" && <SafetySettings />}
          {state.settings.section === "memory" && <MemorySettings />}
          {state.settings.section === "voice" && <VoiceSettings />}
          {state.settings.section === "chat" && <ChatSettings />}
          {state.settings.section === "gateways" && <GatewayRegistry />}
          {state.settings.section === "updates" && <UpdatesSettings />}
          {state.settings.section !== "gateways" && (
            <div className="settings-simulation-note"><Bot size={11} /> Prototype simulation · 设置不会写入真实 Hermes 配置。</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
