import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Brain,
  Check,
  Command,
  Fingerprint,
  FolderTree,
  History,
  KeyRound,
  Link2,
  MemoryStick,
  MessageSquare,
  Plus,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { useApp } from "../state/AppContext";
import { getActiveGateway, getActiveProfile, getActiveSession } from "../state/store";
import { cn } from "../lib/ui";
import {
  Button,
  CopyButton,
  EmptyState,
  IconButton,
  InlineNotice,
  Kbd,
  Modal,
  Segmented,
  StatusDot,
  Toggle,
} from "./ui";
import { HermesMark } from "./Brand";

export function WindowTitlebar() {
  const { state } = useApp();
  const gateway = getActiveGateway(state);
  return (
    <header className="window-titlebar">
      <div className="traffic-lights" aria-hidden="true">
        <i /><i /><i />
      </div>
      <div className="window-title">
        <HermesMark size={13} />
        <span>HERMES DESKTOP</span>
        <em>Prototype</em>
      </div>
      <div className="window-title-meta">
        <span className={cn("window-context", gateway.kind !== "local" && "is-remote")}>
          <span className="window-dot" />
          {gateway.name.toUpperCase()}
        </span>
        <span className="window-sim">SIMULATED DATA</span>
        <span className="window-version">0.9.4</span>
      </div>
    </header>
  );
}

function CheckpointsOverlay() {
  const { state, dispatch } = useApp();
  const session = getActiveSession(state);
  const [fullRestore, setFullRestore] = useState(false);
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const open = state.overlay === "checkpoints";
  return (
    <Modal
      open={open}
      title="Checkpoint & Rollback"
      description={session ? `${session.title} · ${gateway.name} / ${profile.handle}` : "当前 Session"}
      onClose={() => dispatch({ type: "CLOSE_OVERLAY" })}
      className="checkpoints-modal"
      footer={
        session ? (
          <>
            <span className="modal-foot-note"><ShieldCheck size={11} /> 恢复是显式动作；不会跨 Session 或跨主机。</span>
            <Button variant="secondary" onClick={() => dispatch({ type: "CREATE_CHECKPOINT", sessionId: session.id })}>
              <Plus size={12} /> 创建快照
            </Button>
          </>
        ) : undefined
      }
    >
      {!session ? (
        <EmptyState icon={<History size={22} />} title="没有打开的 Session" body="先选择一个 Session，再查看它的 Checkpoint。" />
      ) : (
        <div className="checkpoints-body">
          <div className="checkpoint-scope">
            <div><StatusDot tone="ok" /><span>作用域固定为</span><b>{gateway.name}</b><span>/</span><b>{profile.handle}</b></div>
            <span>{session.checkpoints.length} snapshots</span>
          </div>
          {session.checkpoints.length === 0 ? (
            <EmptyState
              icon={<History size={22} />}
              title="还没有 Checkpoint"
              body="开启自动快照，或在下一步行动前手动创建。"
              action={<Button variant="primary" onClick={() => dispatch({ type: "CREATE_CHECKPOINT", sessionId: session.id })}><Plus size={12} /> 创建快照</Button>}
            />
          ) : (
            <div className="checkpoint-list">
              {session.checkpoints.map((checkpoint, index) => (
                <div className={cn("checkpoint-row", checkpoint.status === "restored" && "is-restored")} key={checkpoint.id}>
                  <span className="checkpoint-rail">
                    <i />
                    {index < session.checkpoints.length - 1 && <b />}
                  </span>
                  <div className="checkpoint-copy">
                    <div>
                      <b>{checkpoint.label}</b>
                      <span className={cn("kind-tag", checkpoint.kind)}>{checkpoint.kind}</span>
                      {checkpoint.status === "restored" && <span className="restored-tag"><Check size={9} /> RESTORED</span>}
                    </div>
                    <p>{checkpoint.time} · {checkpoint.files} files touched · scoped to this Session</p>
                  </div>
                  <Button
                    variant="quiet"
                    disabled={checkpoint.status === "restored"}
                    onClick={() => dispatch({ type: "RESTORE_CHECKPOINT", sessionId: session.id, checkpointId: checkpoint.id })}
                  >
                    <RotateCcw size={11} /> {checkpoint.status === "restored" ? "已恢复" : "恢复"}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="checkpoint-options">
            <div className="setting-line">
              <div><b>完整恢复（--all）</b><span>同时还原手改内容；默认只还原工具改动</span></div>
              <Toggle checked={fullRestore} onChange={setFullRestore} label="完整恢复" />
            </div>
            <p>默认恢复保留你在工具调用之后手改的文件。勾选 `--all` 才会把整个工作树回到快照。</p>
          </div>
          <InlineNotice tone="warn">
            Checkpoint 跟随 Session 而不是全域设置。即使 All Profiles 打开，恢复也只会作用于当前 Session 所在的 (gateway, profile)。
          </InlineNotice>
        </div>
      )}
    </Modal>
  );
}

interface GraphNode {
  id: string;
  label: string;
  detail: string;
  type: "memory" | "user" | "soul" | "context" | "session";
  x: number;
  y: number;
  icon: typeof MemoryStick;
}

const graphNodes: GraphNode[] = [
  { id: "memory", label: "MEMORY.md", detail: "6 durable facts · execution safety, language, evidence-first answers.", type: "memory", x: 48, y: 22, icon: MemoryStick },
  { id: "user", label: "USER.md", detail: "Lin · Asia/Shanghai · keyboard-first, low dashboard tolerance.", type: "user", x: 25, y: 54, icon: UserRound },
  { id: "soul", label: "SOUL.md", detail: "Calm operator · name the host, preserve running work, inspect before act.", type: "soul", x: 70, y: 53, icon: Brain },
  { id: "context", label: "Project context", detail: ".hermes/CONTEXT.md · docs/architecture.md · package.json", type: "context", x: 18, y: 22, icon: FolderTree },
  { id: "docs", label: "Hermes docs", detail: "desktop · multi-connection-desktop · checkpoints · programmatic integration", type: "context", x: 82, y: 20, icon: BookOpen },
  { id: "session", label: "Active Session", detail: "Homelab 部署检查 · research profile · 3 checkpoints", type: "session", x: 48, y: 82, icon: MessageSquare },
];

const graphEdges: Array<[string, string, string]> = [
  ["user", "memory", "preference"],
  ["soul", "memory", "voice"],
  ["user", "soul", "personality"],
  ["context", "memory", "facts"],
  ["docs", "memory", "sources"],
  ["session", "memory", "recall"],
  ["session", "user", "profile"],
  ["session", "context", "reads"],
];

function MemoryGraphOverlay() {
  const { state, dispatch } = useApp();
  const [selectedId, setSelectedId] = useState("memory");
  const [filter, setFilter] = useState("all");
  const selected = graphNodes.find((node) => node.id === selectedId) ?? graphNodes[0];
  const position = (id: string) => graphNodes.find((node) => node.id === id) ?? graphNodes[0];
  return (
    <Modal
      open={state.overlay === "memoryGraph"}
      title="Memory Graph"
      description="记忆不是聊天记录：查看 facts、来源与当前 Session 的引用路径。"
      onClose={() => dispatch({ type: "CLOSE_OVERLAY" })}
      className="memory-graph-modal"
      footer={
        <>
          <span className="modal-foot-note"><Fingerprint size={11} /> {getActiveGateway(state).name} / {getActiveProfile(state).handle}</span>
          <Button variant="secondary" onClick={() => dispatch({ type: "OPEN_CAPABILITIES", tab: "memory" })}>
            打开 Memory 编辑器 <ArrowRight size={12} />
          </Button>
        </>
      }
    >
      <div className="memory-graph-toolbar">
        <Segmented
          value={filter}
          options={[
            { value: "all", label: "All nodes" },
            { value: "memory", label: "Memory" },
            { value: "context", label: "Sources" },
          ]}
          onChange={setFilter}
          label="Memory graph 筛选"
        />
        <div className="graph-legend">
          <span><i className="memory" /> Memory</span>
          <span><i className="context" /> Context</span>
          <span><i className="session" /> Session</span>
        </div>
      </div>
      <div className="memory-graph-layout">
        <div className="graph-canvas">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {graphEdges.map(([from, to, label], index) => {
              const a = position(from);
              const b = position(to);
              const dim =
                filter !== "all" &&
                !(from === selectedId || to === selectedId) &&
                !(filter === "memory" && (position(from).type === "memory" || position(to).type === "memory")) &&
                !(filter === "context" && (position(from).type === "context" || position(to).type === "context"));
              return (
                <g key={`${from}-${to}`} className={cn("graph-edge", dim && "is-dim")}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 1}>{label}</text>
                  {index === 2 && <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r="1.1" />}
                </g>
              );
            })}
          </svg>
          <div className="you-node">
            <span><HermesMark size={14} /></span>
            <b>YOU</b>
            <em>current session</em>
          </div>
          {graphNodes.map((node) => {
            const dim =
              filter !== "all" &&
              !(node.id === selectedId) &&
              !(filter === "memory" && (node.type === "memory" || node.type === "soul" || node.type === "user")) &&
              !(filter === "context" && node.type === "context");
            return (
              <button
                type="button"
                key={node.id}
                className={cn("graph-node", `type-${node.type}`, node.id === selectedId && "is-selected", dim && "is-dim")}
                style={{ left: `${node.x}%`, top: `${node.y}%` }}
                onClick={() => setSelectedId(node.id)}
                aria-pressed={node.id === selectedId}
              >
                <span><node.icon size={12} /></span>
                <b>{node.label}</b>
              </button>
            );
          })}
          <div className="graph-center-label" aria-hidden="true">
            <span />
            <em>retrieval field · simulated</em>
          </div>
        </div>
        <aside className="graph-detail">
          <div className="micro-label">Selected node</div>
          <span className="detail-icon"><selected.icon size={16} /></span>
          <h3>{selected.label}</h3>
          <span className={cn("detail-type", selected.type)}>{selected.type}</span>
          <p>{selected.detail}</p>
          <div className="graph-facts">
            <div><span>Last read</span><b>2 min ago</b></div>
            <div><span>Scope</span><b>{getActiveProfile(state).handle}</b></div>
            <div><span>Source</span><b>local file</b></div>
          </div>
          <button
            type="button"
            className="graph-open"
            onClick={() => dispatch({ type: "ADD_CONTEXT", chip: { id: `graph-${Date.now()}`, label: selected.label, kind: "artifact", detail: selected.detail } })}
          >
            <Link2 size={11} /> 引用到 Composer
          </button>
          <div className="graph-detail-note">Graph 是原型渲染；节点与边均为演示数据。</div>
        </aside>
      </div>
    </Modal>
  );
}

function QrGraphic() {
  const cells: Array<{ x: number; y: number }> = [];
  const finder = (x: number, y: number) => {
    if (x < 7 && y < 7) return (x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
    if (x >= 14 && y < 7) return (x === 14 || y === 0 || x === 20 || y === 6 || (x >= 16 && x <= 18 && y >= 2 && y <= 4));
    if (x < 7 && y >= 14) return (x === 0 || y === 14 || x === 6 || y === 20 || (x >= 2 && x <= 4 && y >= 16 && y <= 18));
    if ((x === 6 || y === 6) && (x < 9 || y < 9)) return false;
    return ((x * 7 + y * 11 + x * y) % 13) < 6;
  };
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 21; x += 1) {
      if (finder(x, y)) cells.push({ x, y });
    }
  }
  return (
    <svg viewBox="-1 -1 23 23" className="qr-graphic" role="img" aria-label="Telegram Quick Setup 演示二维码">
      <rect x="-1" y="-1" width="23" height="23" fill="#fff" />
      {cells.map((cell) => <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="1" height="1" fill="#16181b" />)}
    </svg>
  );
}

function QrOverlay() {
  const { state, dispatch } = useApp();
  return (
    <Modal
      open={state.overlay === "qr"}
      title="Telegram Quick Setup"
      description="在手机上打开 Telegram，扫描后确认绑定；凭据只保存在 gateway host。"
      onClose={() => dispatch({ type: "CLOSE_OVERLAY" })}
      className="qr-modal"
    >
      <div className="qr-layout">
        <div className="qr-frame">
          <QrGraphic />
          <span className="qr-corner top-left" />
          <span className="qr-corner top-right" />
          <span className="qr-corner bottom-left" />
          <span className="qr-corner bottom-right" />
        </div>
        <div className="qr-copy">
          <span className="telegram-mark">T</span>
          <h3>@hermes_research_bot</h3>
          <ol>
            <li><span>1</span><p>在 Telegram 中扫描左侧二维码。</p></li>
            <li><span>2</span><p>点击 Start，确认发给测试群的消息。</p></li>
            <li><span>3</span><p>回到 Desktop，重启 gateway 让 channel 生效。</p></li>
          </ol>
          <div className="qr-warning"><QrCode size={12} /> 演示二维码不可扫描，也不会建立真实 Telegram 绑定。</div>
          <Button
            variant="primary"
            onClick={() => {
              dispatch({ type: "RESTART_GATEWAY" });
              dispatch({ type: "CLOSE_OVERLAY" });
            }}
          >
            模拟保存并重启 Gateway
          </Button>
        </div>
      </div>
      <div className="qr-foot">
        <span><KeyRound size={11} /> bot token → gateway host</span>
        <span><Smartphone size={11} /> one-use pairing</span>
        <CopyButton value="hermes gateway channel telegram --profile research" />
      </div>
    </Modal>
  );
}

function ShortcutsOverlay() {
  const { state, dispatch } = useApp();
  const groups = [
    { title: "Global", rows: [["⌘ K", "打开命令面板"], ["⌘ N", "新建 Session"], ["Esc", "关闭最上层面板 / 返回焦点"], ["⌘ ,", "打开 Settings"]] },
    { title: "Navigation", rows: [["↑ / ↓", "在命令面板与列表中移动"], ["↵", "执行选中命令或发送消息"], ["⇧ ↵", "在 Composer 内换行"], ["↑ / ↓", "在 Composer 中翻阅 prompt history"]] },
    { title: "Workspace", rows: [["Hide", "保留终端 scrollback 与 preview 状态"], ["Close", "释放终端、预览与 annotations"]] },
  ];
  return (
    <Modal
      open={state.overlay === "shortcuts"}
      title="Keyboard shortcuts"
      description="Keyboard-first，不只是快捷键列表：焦点会回到触发面板的控件。"
      onClose={() => dispatch({ type: "CLOSE_OVERLAY" })}
      className="shortcuts-modal"
    >
      <div className="shortcut-groups">
        {groups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            {group.rows.map(([key, label]) => (
              <div className="shortcut-row" key={`${key}-${label}`}><Kbd>{key}</Kbd><span>{label}</span></div>
            ))}
          </section>
        ))}
      </div>
      <div className="shortcuts-note"><Command size={12} /> 所有面板都有可见焦点环；`Escape` 先关闭面板，再回到原触发位置。</div>
    </Modal>
  );
}

export function GlobalOverlays() {
  return (
    <>
      <CheckpointsOverlay />
      <MemoryGraphOverlay />
      <QrOverlay />
      <ShortcutsOverlay />
    </>
  );
}

export function ToastView() {
  const { state, dispatch } = useApp();
  if (!state.toast) return null;
  return (
    <div className={cn("toast", `toast-${state.toast.tone}`)} role="status" aria-live="polite">
      <span className="toast-mark">
        {state.toast.tone === "success" ? <Check size={12} /> : state.toast.tone === "danger" ? <ShieldCheck size={12} /> : <Sparkles size={12} />}
      </span>
      <div><b>{state.toast.title}</b>{state.toast.message && <span>{state.toast.message}</span>}</div>
      <IconButton label="关闭通知" onClick={() => dispatch({ type: "DISMISS_TOAST", id: state.toast!.id })}><X size={12} /></IconButton>
    </div>
  );
}
