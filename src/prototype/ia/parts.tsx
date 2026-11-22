import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Command,
  Copy,
  FileText,
  Folder,
  GitBranch,
  Info,
  Layers,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Unplug,
  X,
} from "lucide-react";
import { useFocusTrap } from "../../components/ui";
import { cn } from "../../lib/ui";
import { useIa } from "./context";
import {
  artifactsDemo,
  approvalDemo,
  capTierKeys,
  channelsDemo,
  checkpointDemo,
  classificationLabel,
  counts,
  cronDemo,
  deferredDomains,
  demoSessions,
  domainById,
  domains,
  fileTree,
  groupLabel,
  mcpDemo,
  messagesBySession,
  pluginsDemo,
  refusedMethods,
  sceneKeys,
  scopes,
  skillsDemo,
  subagentsDemo,
  toolsDemo,
  variantMeta,
  type CapTier,
  type CapabilityDomain,
  type Classification,
  type DomainId,
  type Scene,
  type Variant,
} from "./data";
import type { DomainStatus } from "./context";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ia-kbd">{children}</kbd>;
}

export function HealthDot({ degraded = false }: { degraded?: boolean }) {
  return <span className={cn("ia-health-dot", degraded && "is-degraded")} aria-hidden="true" />;
}

export function RouteText({ compact = false }: { compact?: boolean }) {
  const { scope, connectionHealth, openScope } = useIa();
  const degraded = connectionHealth === "degraded";
  return (
    <div className={cn("ia-route-string", compact && "is-compact")} aria-label={`执行上下文 ${scope.gateway} ${scope.profile}`}>
      <span className="ia-route-you">YOU</span>
      <span className="ia-route-rule" aria-hidden="true" />
      <button type="button" className="ia-route-host" onClick={openScope}>
        {scope.gateway}
      </button>
      <span className="ia-route-rule is-short" aria-hidden="true" />
      <button type="button" className="ia-route-profile" onClick={openScope}>
        {scope.profile}
      </button>
      <span className={cn("ia-kind-chip", scope.kind !== "LOCAL" && "is-remote")}>{scope.kind}</span>
      <span className={cn("ia-health", degraded && "is-degraded")}>
        <HealthDot degraded={degraded} />
        {degraded ? "连接降级" : "在线"}
      </span>
      {!compact && <span className="ia-latency">{scope.latency}</span>}
    </div>
  );
}

export function ApprovalBadge({ short = false }: { short?: boolean }) {
  const { approvalPending, openApproval, scene } = useIa();
  if (!approvalPending) return null;
  const unverified = scene === "degraded";
  return (
    <button type="button" className="ia-approval-badge" onClick={openApproval}>
      <ShieldCheck size={13} />
      <span>{short ? "1" : unverified ? "1 个审批未验证" : "1 个后台审批"}</span>
      <em>{unverified ? "连接中断" : short ? "待审批" : "HOMELAB / @research"}</em>
    </button>
  );
}

export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function ActivityRow({ activity }: { activity: { name: string; status: "running" | "done"; summary: string; args: string; output: string } }) {
  return (
    <details className="ia-activity">
      <summary>
        <span className={cn("ia-activity-mark", activity.status === "running" && "is-running")} />
        <code>{activity.name}</code>
        <span>{activity.summary}</span>
        <ChevronRight size={12} className="ia-disclosure" />
      </summary>
      <div className="ia-activity-body">
        <div>
          <span className="ia-micro">ARGS</span>
          <pre>{activity.args}</pre>
        </div>
        <div>
          <span className="ia-micro">OUTPUT</span>
          <pre>{activity.output}</pre>
        </div>
      </div>
    </details>
  );
}

export function ApprovalCard({ compact = false }: { compact?: boolean }) {
  const { approvalStatus, setApprovalStatus, scene, notify } = useIa();
  const unverified = scene === "degraded" && approvalStatus === "pending";
  const resolved = approvalStatus === "approved" || approvalStatus === "denied";

  return (
    <section className={cn("ia-approval-card", compact && "is-compact")} aria-label="危险命令审批">
      <header>
        <span className="ia-approval-mark">
          <ShieldCheck size={15} />
        </span>
        <div>
          <span className="ia-micro">DANGEROUS COMMAND · APPROVAL</span>
          <h3>审批锚定在 owning Session</h3>
        </div>
        <span className={cn("ia-approval-state", unverified && "is-warn")}>
          {unverified ? "UNVERIFIED" : resolved ? (approvalStatus === "approved" ? "APPROVED" : "DENIED") : "PENDING"}
        </span>
      </header>

      <code className="ia-approval-command">{approvalDemo.command}</code>

      <dl className="ia-approval-meta">
        <div>
          <dt>目标</dt>
          <dd>
            {approvalDemo.gateway} / {approvalDemo.profile}
          </dd>
        </div>
        <div>
          <dt>工作目录</dt>
          <dd>{approvalDemo.cwd}</dd>
        </div>
        <div>
          <dt>所属 Session</dt>
          <dd>{approvalDemo.sessionTitle}</dd>
        </div>
      </dl>

      <p className="ia-approval-reason">
        <AlertTriangle size={13} />
        {unverified
          ? "连接中断：pending 只读 unverified。不会把审批改道到其他 Gateway，也不会自动 deny。"
          : approvalDemo.reason}
      </p>

      {approvalStatus === "inspected" && (
        <div className="ia-approval-inspect">
          <span className="ia-micro">EXACT COMMAND</span>
          <pre>{approvalDemo.command}</pre>
          <p>目标主机与 Profile 不随当前 scope 移动。Inspect 不会批准或执行。</p>
        </div>
      )}

      {!resolved && (
        <div className="ia-approval-actions">
          <button
            type="button"
            className="ia-button is-secondary"
            onClick={() => setApprovalStatus(approvalStatus === "inspected" ? "pending" : "inspected")}
          >
            {approvalStatus === "inspected" ? "收起命令" : "查看命令"}
          </button>
          {!unverified && (
            <>
              <button
                type="button"
                className="ia-button is-secondary"
                onClick={() => {
                  setApprovalStatus("denied");
                  notify("已拒绝该命令（模拟）。目标未执行。");
                }}
              >
                拒绝
              </button>
              <button
                type="button"
                className="ia-button is-primary"
                onClick={() => {
                  setApprovalStatus("approved");
                  notify("已批准（模拟）；高风险动作仍走 Main 原生确认。", "accent");
                }}
              >
                批准
              </button>
            </>
          )}
        </div>
      )}

      {resolved && (
        <p className="ia-resolution">
          <Check size={13} />
          {approvalStatus === "approved" ? "已批准（原型模拟）。" : "已拒绝（原型模拟）。"}没有连接真实 Gateway。
        </p>
      )}
    </section>
  );
}

export function MessageList({ showStreaming = false }: { showStreaming?: boolean }) {
  const { activeSessionId, scene, notify } = useIa();
  const messages = messagesBySession[activeSessionId] ?? [];
  return (
    <div className="ia-messages">
      {scene === "degraded" && (
        <div className="ia-connection-banner" role="status">
          <Unplug size={14} />
          <span>
            <b>HOMELAB 连接中断。</b> 当前 Session 保持可读；prompt 不会排队到其他 Gateway。
          </span>
          <RetryConnectionButton />
        </div>
      )}
      {messages.map((message) =>
        message.role === "system" ? (
          <div className="ia-system-line" key={message.id}>
            <ShieldCheck size={13} />
            <span>{message.content}</span>
          </div>
        ) : (
          <article className={cn("ia-message", message.role === "user" && "is-user")} key={message.id}>
            <span className="ia-avatar">{message.role === "user" ? "YOU" : "H"}</span>
            <div className="ia-message-main">
              <div className="ia-message-meta">
                <b>{message.author}</b>
                <span>{message.host}</span>
                <time>{message.time}</time>
              </div>
              <p className="ia-message-copy">
                <InlineText text={message.content} />
              </p>
              {message.activities?.map((activity) => <ActivityRow activity={activity} key={activity.name + activity.summary} />)}
              {message.approval && <ApprovalCard />}
            </div>
          </article>
        ),
      )}
      {showStreaming && (
        <div className="ia-streaming" role="status" aria-live="polite">
          <span className="ia-caret" />
          <span>Hermes 正在核对 17 个域的入口证据…</span>
          <button type="button" className="ia-inline-action" onClick={() => notify("已停止模拟流。")}>
            停止
          </button>
        </div>
      )}
    </div>
  );
}

function RetryConnectionButton() {
  const { retryConnection } = useIa();
  return (
    <button type="button" className="ia-inline-action" onClick={retryConnection}>
      <RefreshCw size={12} /> 重试连接
    </button>
  );
}

export function Composer() {
  const { scene, scope, openWorkspace, openPalette, notify } = useIa();
  const degraded = scene === "degraded";
  const [draft, setDraft] = useState("");
  const [queued, setQueued] = useState(false);

  const submit = () => {
    if (!draft.trim()) return;
    notify(`已进入模拟队列：${draft.trim().slice(0, 36)}${draft.trim().length > 36 ? "…" : ""}`);
    setDraft("");
    setQueued(true);
  };

  if (degraded) {
    return (
      <div className="ia-composer is-disabled">
        <div className="ia-composer-context">
          <span>{scope.gateway}</span>
          <span>{scope.profile}</span>
          <span className="ia-composer-sim">SIM</span>
        </div>
        <div className="ia-composer-disabled">
          <Unplug size={14} />
          <span>连接中断：输入暂停，避免静默排队到其他 Gateway。</span>
          <RetryConnectionButton />
        </div>
      </div>
    );
  }

  return (
    <div className="ia-composer">
      <div className="ia-composer-context">
        <span>{scope.gateway}</span>
        <span>{scope.profile}</span>
        <span className="ia-chip">Opus 4.5</span>
        <span className="ia-chip">reasoning High</span>
        <span className="ia-composer-sim">SIM</span>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={`给 ${scope.gateway} / ${scope.profile} 发消息…`}
        aria-label="消息输入"
        rows={2}
        data-ia-composer
      />
      <div className="ia-composer-foot">
        <div className="ia-composer-tools">
          <button type="button" className="ia-inline-action" onClick={() => openWorkspace("files")}>
            <Folder size={13} /> 上下文
          </button>
          <button type="button" className="ia-inline-action" onClick={openPalette}>
            <Command size={13} /> 能力
          </button>
          <span className="ia-composer-hint">
            <Kbd>⏎</Kbd> 发送 · <Kbd>⇧⏎</Kbd> 换行
          </span>
        </div>
        <button type="button" className="ia-send" onClick={submit} disabled={!draft.trim()} aria-label="发送">
          <ArrowUp size={15} />
        </button>
      </div>
      {queued && <p className="ia-queued">已进入模拟队列 · 不会连接真实 Gateway。</p>}
    </div>
  );
}

export function CapabilityBadge({ classification }: { classification: Classification }) {
  return (
    <span className={cn("ia-cap-badge", `is-${classification}`)}>
      <span aria-hidden="true" />
      {classificationLabel[classification]}
    </span>
  );
}

export function DomainStatusTag({ status }: { status: DomainStatus }) {
  return (
    <span className={cn("ia-status-tag", `is-${status}`)}>
      {status === "available" ? "可用" : status === "read_only" ? "只读" : "不支持"}
    </span>
  );
}

export function CapabilityRow({
  domain,
  variant,
  onSelect,
  active = false,
}: {
  domain: CapabilityDomain;
  variant: Variant;
  onSelect: (id: DomainId) => void;
  active?: boolean;
}) {
  const { domainStatus } = useIa();
  const status = domainStatus(domain.id);
  return (
    <button
      type="button"
      className={cn("ia-cap-row", active && "is-active", status !== "available" && "is-degraded")}
      onClick={() => onSelect(domain.id)}
    >
      <span className="ia-cap-main">
        <span className="ia-cap-name">
          {domain.name}
          <em>{domain.english}</em>
        </span>
        <span className="ia-cap-path">{domain.paths[variant]}</span>
      </span>
      <span className="ia-cap-side">
        <CapabilityBadge classification={domain.classification} />
        <DomainStatusTag status={status} />
      </span>
    </button>
  );
}

export function CapabilityList({
  variant,
  query = "",
  onSelect,
  activeId,
}: {
  variant: Variant;
  query?: string;
  onSelect: (id: DomainId) => void;
  activeId?: DomainId;
}) {
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (["core", "manage", "execute"] as const).map((group) => ({
      group,
      items: domains.filter(
        (domain) =>
          domain.group === group &&
          (!needle ||
            domain.name.toLowerCase().includes(needle) ||
            domain.english.toLowerCase().includes(needle) ||
            domain.summary.toLowerCase().includes(needle) ||
            domain.methods.some((method) => method.toLowerCase().includes(needle))),
      ),
    }));
  }, [query]);

  return (
    <div className="ia-cap-groups">
      {groups.map(({ group, items }) =>
        items.length ? (
          <section className="ia-cap-group" key={group}>
            <div className="ia-group-heading">
              <span>{groupLabel[group]}</span>
              <span>{items.length}</span>
            </div>
            {items.map((domain) => (
              <CapabilityRow
                key={domain.id}
                domain={domain}
                variant={variant}
                onSelect={onSelect}
                active={activeId === domain.id}
              />
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}

function TierNotice({ domain, status }: { domain: CapabilityDomain; status: DomainStatus }) {
  const { capTier, copy } = useIa();
  if (status === "available") return null;
  if (status === "read_only") {
    return (
      <div className="ia-tier-notice is-readonly">
        <Info size={14} />
        <div>
          <b>{capTier === "older" ? "older gateway · 只读探测" : "只读域"}</b>
          <p>
            {domain.name} 在 v1 只展示探测通过的事实。没有真实 handler 的动作不会出现；需要管理时使用官方 CLI/Desktop 深链。
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="ia-tier-notice is-unavailable">
      <Unplug size={14} />
      <div>
        <b>-32601 · 当前网关不支持 {domain.name}</b>
        <p>
          该域不进入主入口，也不显示假按钮。请查看网关版本与文档，或使用官方 CLI/Desktop。
        </p>
        <button type="button" className="ia-inline-action" onClick={() => copy(`hermes docs gateway ${domain.english}`, "文档深链已复制")}>
          <Copy size={12} /> 复制文档深链
        </button>
      </div>
    </div>
  );
}

function ToggleLine({
  label,
  detail,
  initial,
  disabled = false,
}: {
  label: string;
  detail: string;
  initial: boolean;
  disabled?: boolean;
}) {
  const { notify } = useIa();
  const [on, setOn] = useState(initial);
  return (
    <div className="ia-toggle-line">
      <div>
        <b>{label}</b>
        <span>{detail}</span>
      </div>
      {disabled ? (
        <span className="ia-readonly-text">{on ? "只读 · 已启用" : "只读 · 已停用"}</span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${label} 开关`}
          className={cn("ia-switch", on && "is-on")}
          onClick={() => {
            setOn(!on);
            notify(`${label} 已${on ? "停用" : "启用"}（模拟）。`);
          }}
        >
          <span />
        </button>
      )}
    </div>
  );
}

function CommandBlock({ command, label = "复制命令" }: { command: string; label?: string }) {
  const { copy } = useIa();
  return (
    <div className="ia-command-block">
      <code>{command}</code>
      <button type="button" className="ia-inline-action" onClick={() => copy(command, "命令已复制")}>
        <Copy size={12} /> {label}
      </button>
    </div>
  );
}

function DomainPreview({ domain }: { domain: CapabilityDomain }) {
  const { domainStatus, openWorkspace, openSettings, openApproval, openSessions, scope, setScope, notify } = useIa();
  const status = domainStatus(domain.id);
  const [restored, setRestored] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<Record<string, string>>({});

  if (status === "unavailable") return null;

  switch (domain.id) {
    case "chat":
      return (
        <div className="ia-domain-preview">
          <div className="ia-method-row">
            {domain.methods.map((method) => (
              <code key={method}>{method}</code>
            ))}
          </div>
          <p className="ia-preview-copy">对话列和 composer 常驻；发送会进入模拟队列，不连接真实 Gateway。</p>
          <button type="button" className="ia-button is-secondary" onClick={() => document.querySelector<HTMLTextAreaElement>("[data-ia-composer]")?.focus()}>
            聚焦 composer
          </button>
        </div>
      );
    case "approval":
      return (
        <div className="ia-domain-preview">
          <div className="ia-inline-facts">
            <span>pending <b>1</b></span>
            <span>owning session <b>{approvalDemo.sessionTitle}</b></span>
            <span>route <b>{approvalDemo.gateway} / {approvalDemo.profile}</b></span>
          </div>
          <p className="ia-preview-copy">壳层角标只负责导航；批准/拒绝始终回到 owning Session 的精确绑定。</p>
          <div className="ia-row-actions">
            <button type="button" className="ia-button is-primary" onClick={openApproval}>打开审批</button>
            <button type="button" className="ia-button is-secondary" onClick={() => openSessions()}>查看 Session</button>
          </div>
        </div>
      );
    case "checkpoint":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {checkpointDemo.map((snapshot) => (
              <div className="ia-list-row" key={snapshot.id}>
                <div>
                  <b>{snapshot.label}</b>
                  <span>{snapshot.time} · {snapshot.files} files · {snapshot.kind}</span>
                </div>
                {status === "available" ? (
                  <button
                    type="button"
                    className="ia-inline-action"
                    onClick={() => {
                      setRestored(snapshot.id);
                      notify(`已模拟恢复 ${snapshot.label}；真实 restore 需要显式用户手势。`, "accent");
                    }}
                  >
                    {restored === snapshot.id ? "已恢复" : "恢复"}
                  </button>
                ) : (
                  <span className="ia-readonly-text">只读列表</span>
                )}
              </div>
            ))}
          </div>
          <p className="ia-preview-copy">restore 缺失时只保留 list/diff，不显示恢复按钮。</p>
        </div>
      );
    case "profile":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {scopes.map((item) => (
              <button
                type="button"
                className={cn("ia-list-row is-button", item.id === scope.id && "is-active")}
                key={item.id}
                onClick={() => {
                  setScope(item.id);
                  notify(`作用域已切换到 ${item.gateway} / ${item.profile}。`, "accent");
                }}
              >
                <div>
                  <b>{item.gateway} <em>{item.profile}</em></b>
                  <span>{item.kind} · {item.host} · {item.latency}</span>
                </div>
                <span className="ia-status-tag is-available">{item.id === scope.id ? "当前" : "切换"}</span>
              </button>
            ))}
          </div>
          <p className="ia-preview-copy">切换作用域是显式手势；运行中的工作不会因为切换 scope 而销毁。</p>
        </div>
      );
    case "session":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {demoSessions.map((session) => (
              <button type="button" className="ia-list-row is-button" key={session.id} onClick={() => openSessions()}>
                <div>
                  <b>{session.title}</b>
                  <span>{session.scope} · {session.time} · {session.preview}</span>
                </div>
                {session.status === "approval" && <span className="ia-status-tag is-readonly">审批</span>}
              </button>
            ))}
          </div>
          <div className="ia-deeplink-note">
            <span className="ia-micro">REFUSED · 永不渲染原生按钮</span>
            <p>改名、删除、分支、归档等方法按 CLI 深链处理：</p>
            <CommandBlock command={`hermes session rename ${demoSessions[0].id} "新标题"`} label="复制 CLI 深链" />
          </div>
        </div>
      );
    case "skills":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {skillsDemo.map((skill) => (
              <ToggleLine key={skill.id} label={skill.name} detail={skill.detail} initial={skill.on} disabled={status !== "available"} />
            ))}
          </div>
          <div className="ia-row-actions">
            {status === "available" && (
              <button type="button" className="ia-button is-secondary" onClick={() => notify("Skills 已重新加载（模拟）。")}>
                <RefreshCw size={12} /> skills.reload
              </button>
            )}
            <CommandBlock command="hermes skills list" label="复制 CLI 深链" />
          </div>
        </div>
      );
    case "tools":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {toolsDemo.map((tool) => (
              <ToggleLine key={tool.id} label={tool.name} detail={tool.detail} initial={tool.on} disabled={status !== "available"} />
            ))}
          </div>
          <p className="ia-preview-copy">configure 不可用时只保留真实工具清单，不显示灰色开关。</p>
        </div>
      );
    case "mcp":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {mcpDemo.map((server) => (
              <div className="ia-list-row" key={server.id}>
                <div>
                  <b>{server.name}</b>
                  <span>{server.transport} · {server.tools} tools · {server.status}</span>
                </div>
                <span className="ia-status-tag is-available">{server.status === "ready" ? "ready" : "stale"}</span>
              </div>
            ))}
          </div>
          <div className="ia-row-actions">
            {status === "available" && (
              <button type="button" className="ia-button is-secondary" onClick={() => notify("活动 Gateway 的 MCP 已热重载（模拟）。")}>
                <RefreshCw size={12} /> 热重载全部
              </button>
            )}
            <CommandBlock command="hermes mcp add filesystem --stdio" label="复制 CLI 深链" />
          </div>
        </div>
      );
    case "memory":
      return (
        <div className="ia-domain-preview">
          <div className="ia-context-bars">
            <div><span>MEMORY.md</span><i style={{ width: "42%" }} /><b>42%</b></div>
            <div><span>USER.md</span><i style={{ width: "23%" }} /><b>23%</b></div>
            <div><span>SESSION</span><i style={{ width: "35%" }} /><b>35%</b></div>
          </div>
          <p className="ia-preview-copy">Memory 在 v1 只读：展示上下文拆解，不提供编辑/删除开关。Memory Graph 延期，无图入口。</p>
          <CommandBlock command="hermes memory show" label="复制 CLI 深链" />
        </div>
      );
    case "cron":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {cronDemo.map((job) => (
              <div className="ia-list-row" key={job.id}>
                <div>
                  <b>{job.name}</b>
                  <span>{job.schedule} · next {job.next}</span>
                </div>
                {status === "available" ? (
                  <button type="button" className="ia-inline-action" onClick={() => notify(`${job.name} 已${job.status === "active" ? "暂停" : "恢复"}（模拟）。`)}>
                    {job.status === "active" ? "暂停" : "恢复"}
                  </button>
                ) : (
                  <span className="ia-readonly-text">{job.status}</span>
                )}
              </div>
            ))}
          </div>
          <p className="ia-preview-copy">Routines 归 Cron；Bots / Bot Mode 延期，不出现在任务类型里。</p>
        </div>
      );
    case "messaging":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {channelsDemo.map((channel) => (
              <div className="ia-list-row" key={channel.id}>
                <div>
                  <b>{channel.name}</b>
                  <span>{channel.handle}</span>
                </div>
                <span className="ia-status-tag is-readonly">{channel.status}</span>
              </div>
            ))}
          </div>
          <p className="ia-preview-copy">只读状态；账号连接/授权走官方 surface，不显示“连接账号”假按钮。</p>
          <CommandBlock command="hermes connectors status" label="复制官方 CLI 深链" />
        </div>
      );
    case "files":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {artifactsDemo.map((artifact) => (
              <div className="ia-list-row" key={artifact.id}>
                <div>
                  <b>{artifact.name}</b>
                  <span>{artifact.kind} · {artifact.updated} · {artifact.summary}</span>
                </div>
                <span className="ia-status-tag is-available">可预览</span>
              </div>
            ))}
          </div>
          <div className="ia-row-actions">
            <button type="button" className="ia-button is-primary" onClick={() => openWorkspace("files")}>打开 Files</button>
            <button type="button" className="ia-button is-secondary" onClick={() => openWorkspace("artifacts")}>打开 Artifacts</button>
          </div>
          <p className="ia-preview-copy">本地 attach/preview 是原生；远程 artifact REST 未核实前只留深链。</p>
        </div>
      );
    case "git":
      return (
        <div className="ia-domain-preview">
          <div className="ia-tier-notice is-readonly">
            <GitBranch size={14} />
            <div>
              <b>深链域 · 无 gateway method</b>
              <p>v1 不伪造 Git/worktree UI；复制精确命令或在 Terminal 中执行。</p>
            </div>
          </div>
          <CommandBlock command="git status --short && git worktree list" />
          <div className="ia-row-actions">
            <button type="button" className="ia-button is-secondary" onClick={() => openWorkspace("terminal")}>在 Terminal 打开</button>
          </div>
        </div>
      );
    case "terminal":
      return (
        <div className="ia-domain-preview">
          <div className="ia-terminal-preview">
            <span>$ hermes gateway status</span>
            <span>scope: HOMELAB / @research</span>
            <span>health: reachable · ws: open · simulated</span>
          </div>
          <button type="button" className="ia-button is-secondary" onClick={() => openWorkspace("terminal")}>打开 Terminal</button>
          <p className="ia-preview-copy">首次打开需要 Main 原生授权；拒绝授权时不伪造 shell。</p>
        </div>
      );
    case "subagents":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {subagentsDemo.map((agent) => (
              <div className="ia-list-row" key={agent.id}>
                <div>
                  <b>{agent.name}</b>
                  <span>{agent.status} · {agent.elapsed} · {agent.model} · {agent.task}</span>
                </div>
                {status === "available" && agentState[agent.id] !== "stopped" ? (
                  <div className="ia-row-inline">
                    <button type="button" className="ia-inline-action" onClick={() => notify(`${agent.name} 已收到 steer（模拟）。`)}>steer</button>
                    <button
                      type="button"
                      className="ia-inline-action"
                      onClick={() => {
                        setAgentState((current) => ({ ...current, [agent.id]: "stopped" }));
                        notify(`${agent.name} 已停止（模拟）。`);
                      }}
                    >
                      stop
                    </button>
                  </div>
                ) : (
                  <span className="ia-readonly-text">{agentState[agent.id] === "stopped" ? "stopped" : "只读 roster"}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    case "settings":
      return (
        <div className="ia-domain-preview">
          <p className="ia-preview-copy">Settings 逐 key 探测；未知 key 隐藏。Capability 披露矩阵也在 Settings 内。</p>
          <button type="button" className="ia-button is-primary" onClick={openSettings}>打开 Settings</button>
        </div>
      );
    case "plugins":
      return (
        <div className="ia-domain-preview">
          <div className="ia-list">
            {pluginsDemo.map((plugin) => (
              <div className="ia-list-row" key={plugin.id}>
                <div>
                  <b>{plugin.name}</b>
                  <span>{plugin.version} · {plugin.source}</span>
                </div>
                <span className="ia-status-tag is-readonly">只读</span>
              </div>
            ))}
          </div>
          <p className="ia-preview-copy">v1 不加载官方 plugin.js；安装/启停/删除走官方 CLI/Desktop 深链。</p>
          <CommandBlock command="hermes plugins list" label="复制 CLI 深链" />
        </div>
      );
    default:
      return null;
  }
}

export function CapabilityDetail({ domain, variant }: { domain: CapabilityDomain; variant: Variant }) {
  const { domainStatus, capTier } = useIa();
  const status = domainStatus(domain.id);
  return (
    <div className="ia-domain-detail">
      <div className="ia-domain-title">
        <div>
          <span className="ia-micro">{domain.english.toUpperCase()}</span>
          <h3>{domain.name}</h3>
        </div>
        <div className="ia-domain-badges">
          <CapabilityBadge classification={domain.classification} />
          <DomainStatusTag status={status} />
        </div>
      </div>
      <p className="ia-domain-summary">{domain.summary}</p>
      <div className="ia-method-row">
        {domain.methods.map((method) => (
          <code key={method}>{method}</code>
        ))}
      </div>
      <div className="ia-current-path">
        <span className="ia-micro">变体 {variant} 的抵达路径 · cap={capTier}</span>
        <b>{domain.paths[variant]}</b>
      </div>
      <TierNotice domain={domain} status={status} />
      <DomainPreview domain={domain} />
      <div className="ia-path-compare">
        <span className="ia-micro">三种壳层的路径对照</span>
        {(["A", "B", "C"] as const).map((key) => (
          <div className={cn("ia-path-line", key === variant && "is-current")} key={key}>
            <span>{key}</span>
            <p>{domain.paths[key]}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SurfaceFrame({
  kind,
  side,
  title,
  subtitle,
  onClose,
  children,
  className,
  actions,
  modal = true,
}: {
  kind: "drawer" | "sheet" | "modal" | "popover";
  side?: "left" | "right";
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  modal?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useFocusTrap(true, ref, onClose);
  return (
    <>
      {modal && (
        <div
          className="ia-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        />
      )}
      <section
        ref={ref}
        className={cn("ia-surface", `ia-surface-${kind}`, side && `is-${side}`, className)}
        role="dialog"
        aria-modal={modal}
        aria-labelledby={titleId}
      >
        <header className="ia-surface-head">
          <div className="ia-surface-title">
            {subtitle && <span className="ia-micro">{subtitle}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="ia-surface-actions">
            {actions}
            <button type="button" className="ia-icon-button" aria-label="关闭" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="ia-surface-body">{children}</div>
      </section>
    </>
  );
}

export function CommandPalette() {
  const { variant, closeSurface, openCapability, openWorkspace, openSettings, openSessions, domainId } = useIa();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return domains.filter(
      (domain) =>
        !needle ||
        domain.name.toLowerCase().includes(needle) ||
        domain.english.toLowerCase().includes(needle) ||
        domain.methods.some((method) => method.toLowerCase().includes(needle)),
    );
  }, [query]);

  return (
    <SurfaceFrame
      kind="modal"
      title="能力与命令"
      subtitle={`⌘K · ${variantMeta[variant].name}`}
      onClose={closeSurface}
      className="ia-palette"
    >
      <div className="ia-search-field">
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && filtered[0]) openCapability(filtered[0].id);
          }}
          placeholder="搜索 17 个可达域、method 或路径…"
          aria-label="搜索能力"
        />
        <Kbd>ESC</Kbd>
      </div>
      <div className="ia-palette-summary">
        <span>{counts.total} 可达</span>
        <span>原生 {counts.native}</span>
        <span>只读 {counts.readOnly}</span>
        <span>深链 {counts.deepLink}</span>
        <span className="is-muted">延期 {counts.deferred} 无入口</span>
      </div>
      <div className="ia-quick-nav">
        <button type="button" onClick={() => { closeSurface(); openSessions(); }}>
          <Layers size={14} /> Sessions
        </button>
        <button type="button" onClick={() => { closeSurface(); openWorkspace(); }}>
          <PanelRight size={14} /> Workspace
        </button>
        <button type="button" onClick={() => { closeSurface(); openSettings(); }}>
          <Settings2 size={14} /> Settings
        </button>
      </div>
      <CapabilityList
        variant={variant}
        query={query}
        activeId={domainId}
        onSelect={(id) => {
          openCapability(id);
        }}
      />
      <div className="ia-palette-foot">
        <Info size={13} />
        <p>
          Phase 1 延期域不进入命令列表：{deferredDomains.map((domain) => domain.name).join(" / ")}。没有假按钮、占位开关或静默改道。
        </p>
      </div>
    </SurfaceFrame>
  );
}

export function SettingsModal() {
  const { variant, scope, setScope, notify, closeSurface } = useIa();
  const [section, setSection] = useState<"capabilities" | "scope" | "keyboard" | "boundary">("capabilities");
  return (
    <SurfaceFrame
      kind="modal"
      title="Settings"
      subtitle={`${scope.gateway} / ${scope.profile} · SIMULATED`}
      onClose={closeSurface}
      className="ia-settings"
    >
      <div className="ia-tabs" role="tablist" aria-label="Settings 分区">
        {(
          [
            ["capabilities", "能力披露"],
            ["scope", "作用域"],
            ["keyboard", "键盘"],
            ["boundary", "原型边界"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={section === id}
            className={cn(section === id && "is-active")}
            key={id}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "capabilities" && (
        <div className="ia-settings-section">
          <div className="ia-matrix-summary">
            <div><b>{counts.total}</b><span>可达域</span></div>
            <div><b>{counts.native}</b><span>原生</span></div>
            <div><b>{counts.readOnly}</b><span>只读</span></div>
            <div><b>{counts.deepLink}</b><span>深链</span></div>
            <div className="is-deferred"><b>{counts.deferred}</b><span>延期 · 无入口</span></div>
          </div>
          <div className="ia-matrix">
            <div className="ia-matrix-head">
              <span>域</span>
              <span>分档</span>
              <span>变体 {variant} 路径</span>
            </div>
            {domains.map((domain) => (
              <div className="ia-matrix-row" key={domain.id}>
                <span><b>{domain.name}</b><em>{domain.english}</em></span>
                <CapabilityBadge classification={domain.classification} />
                <span>{domain.paths[variant]}</span>
              </div>
            ))}
          </div>
          <section className="ia-deferred-block">
            <div className="ia-group-heading"><span>Phase 1 延期 · 无 v1 入口</span><span>{counts.deferred}</span></div>
            {deferredDomains.map((domain) => (
              <div className="ia-deferred-row" key={domain.id}>
                <b>{domain.name}</b>
                <span>{domain.reason}</span>
                <em>{domain.replacement}</em>
              </div>
            ))}
          </section>
          <section className="ia-refused-block">
            <span className="ia-micro">REFUSED METHODS · 永不渲染入口</span>
            <p>{refusedMethods.join(" · ")}</p>
            <p>这些方法不会出现原生按钮；需要时只提供已标注的 CLI 深链，且不自动执行。</p>
          </section>
        </div>
      )}

      {section === "scope" && (
        <div className="ia-settings-section">
          <p className="ia-settings-copy">作用域是显式事实。切换不会 teardown 后台流、工具执行或待审批。</p>
          <div className="ia-list">
            {scopes.map((item) => (
              <button
                type="button"
                className={cn("ia-list-row is-button", item.id === scope.id && "is-active")}
                key={item.id}
                onClick={() => {
                  setScope(item.id);
                  notify(`作用域已切换到 ${item.gateway} / ${item.profile}。`, "accent");
                }}
              >
                <div>
                  <b>{item.gateway} <em>{item.profile}</em></b>
                  <span>{item.kind} · {item.host} · {item.latency}</span>
                </div>
                <span className="ia-status-tag is-available">{item.id === scope.id ? "当前" : "切换"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {section === "keyboard" && (
        <div className="ia-settings-section">
          <div className="ia-shortcut-list">
            {[
              ["⌘K", "打开能力与命令面板"],
              ["⌘,", "打开 Settings"],
              ["⌘B", "打开 / 隐藏 Workspace"],
              ["← / →", "切换 A / B / C 变体"],
              ["Esc", "关闭当前浮层并返回焦点"],
              ["⌘W / ⌘Q", "由 #8 HostBridge 与原生菜单承接"],
            ].map(([key, label]) => (
              <div key={key}><Kbd>{key}</Kbd><span>{label}</span></div>
            ))}
          </div>
          <p className="ia-settings-copy">焦点陷阱、Escape 返回、可见 focus ring、状态文字配对均按 WCAG 2.2 AA 基线处理。</p>
        </div>
      )}

      {section === "boundary" && (
        <div className="ia-settings-section">
          <div className="ia-boundary-card">
            <Info size={16} />
            <div>
              <b>这是抛弃型 IA 原型，不是生产实现。</b>
              <p>所有 Gateway 健康、延迟、审批、文件、Terminal 与能力探测均为模拟；没有真实网络请求、SSH 隧道、OAuth、凭据或文件系统写入。</p>
              <p>17 个非延期域都有可指点的路径；4 个延期域只在披露面出现，没有假入口。</p>
            </div>
          </div>
        </div>
      )}
    </SurfaceFrame>
  );
}

export function WorkspaceContent() {
  const {
    workspaceTab,
    setWorkspaceTab,
    scope,
    capTier,
    domainStatus,
    notify,
    copy,
    closeWorkspace,
    terminalLines,
    appendTerminal,
    resetTerminal,
  } = useIa();
  const [selectedFile, setSelectedFile] = useState("~/workspace/release-notes.md");
  const [selectedArtifact, setSelectedArtifact] = useState(artifactsDemo[0].id);
  const [terminalDraft, setTerminalDraft] = useState("");
  const [agentState, setAgentState] = useState<Record<string, string>>({});

  const tabs = [
    ["artifacts", "Artifacts", <Layers size={13} />],
    ["files", "Files", <Folder size={13} />],
    ["git", "Git", <GitBranch size={13} />],
    ["agents", "Agents", <CircleDot size={13} />],
    ["terminal", "Terminal", <SquareTerminal size={13} />],
  ] as const;

  const runTerminal = () => {
    const command = terminalDraft.trim();
    if (!command) return;
    appendTerminal(`$ ${command}`);
    if (command === "help") {
      appendTerminal("commands: help, pwd, ls, git status, hermes gateway status, clear");
    } else if (command === "pwd") {
      appendTerminal("/home/roy/workspaces/hermes-destop");
    } else if (command === "ls") {
      appendTerminal("PRODUCT.md  DESIGN.md  release-notes.md  src/");
    } else if (command.includes("git status")) {
      appendTerminal("On branch prototype/quiet-relay-shell-ia");
      appendTerminal("nothing to commit, working tree clean · simulated");
    } else if (command.includes("hermes gateway status")) {
      appendTerminal(`scope: ${scope.gateway} / ${scope.profile} · health: ${capTier === "refused" ? "refused-safe" : "reachable"}`);
      appendTerminal("ws: open · simulated · no live shell");
    } else if (command === "clear") {
      resetTerminal();
    } else {
      appendTerminal(`simulated: command accepted · no live host · ${command}`);
    }
    setTerminalDraft("");
  };

  return (
    <div className="ia-workspace">
      <div className="ia-workspace-scope">
        <span>{scope.gateway}</span>
        <span>{scope.profile}</span>
        <span className="ia-chip">{scope.kind}</span>
        <span className="ia-workspace-note">Hide 保留状态 · Close 释放</span>
      </div>
      <div className="ia-tabs ia-workspace-tabs" role="tablist" aria-label="Workspace 视图">
        {tabs.map(([id, label, icon]) => (
          <button
            type="button"
            role="tab"
            aria-selected={workspaceTab === id}
            className={cn(workspaceTab === id && "is-active")}
            key={id}
            onClick={() => setWorkspaceTab(id)}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {workspaceTab === "artifacts" && (
        <div className="ia-workspace-pane">
          <div className="ia-artifact-grid">
            {artifactsDemo.map((artifact) => (
              <button
                type="button"
                className={cn("ia-artifact-card", selectedArtifact === artifact.id && "is-active")}
                key={artifact.id}
                onClick={() => setSelectedArtifact(artifact.id)}
              >
                <span className="ia-artifact-mark"><FileText size={15} /></span>
                <b>{artifact.name}</b>
                <span>{artifact.kind} · {artifact.updated}</span>
                <p>{artifact.summary}</p>
              </button>
            ))}
          </div>
          <div className="ia-preview-card">
            <span className="ia-micro">PREVIEW · SIMULATED</span>
            <h3>{artifactsDemo.find((artifact) => artifact.id === selectedArtifact)?.name}</h3>
            <div className="ia-paper-preview">
              <span>Phase 1 · Hermes Desktop</span>
              <b>17 个可达域，4 个延期域。</b>
              <p>常驻只保留执行上下文与对话；能力通过 ⌘K、抽屉、popover 与空态披露。</p>
              <div className="ia-preview-rule" />
              <span>原生 13 · 只读 3 · 深链 1</span>
            </div>
            <div className="ia-row-actions">
              <button type="button" className="ia-button is-secondary" onClick={() => copy("~/workspace/release-notes.html", "路径已复制")}>
                <Copy size={12} /> 复制路径
              </button>
              <button type="button" className="ia-button is-secondary" onClick={() => setWorkspaceTab("files")}>在 Files 查看</button>
            </div>
          </div>
        </div>
      )}

      {workspaceTab === "files" && (
        <div className="ia-workspace-pane is-split">
          <div className="ia-file-tree">
            {fileTree[0].children?.map((node) => (
              <div key={node.path}>
                <button
                  type="button"
                  className={cn("ia-file-row", selectedFile === node.path && "is-active")}
                  onClick={() => setSelectedFile(node.path)}
                >
                  {node.children ? <Folder size={13} /> : <FileText size={13} />}
                  <span>{node.name}</span>
                  <em>{"size" in node ? node.size : ""}</em>
                </button>
                {node.children?.map((child) => (
                  <button
                    type="button"
                    className={cn("ia-file-row is-child", selectedFile === child.path && "is-active")}
                    key={child.path}
                    onClick={() => setSelectedFile(child.path)}
                  >
                    <FileText size={13} />
                    <span>{child.name}</span>
                    <em>{child.size}</em>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="ia-file-preview">
            <span className="ia-micro">OPAQUE HANDLE · READ-ONLY PREVIEW</span>
            <h3>{selectedFile.split("/").pop()}</h3>
            <pre>
              {selectedFile.endsWith(".md")
                ? "# Release notes\n\n17 个可达域：原生 13 / 只读 3 / 深链 1。\n4 个延期域没有 v1 入口。"
                : "// preview is simulated\n// no live filesystem access\n"}
            </pre>
            <button type="button" className="ia-button is-secondary" onClick={() => copy(selectedFile, "路径已复制")}>
              <Copy size={12} /> 复制路径
            </button>
          </div>
        </div>
      )}

      {workspaceTab === "git" && (
        <div className="ia-workspace-pane">
          <div className="ia-tier-notice is-readonly">
            <GitBranch size={14} />
            <div>
              <b>深链域 · v1 不做第一类 Git UI</b>
              <p>这里只提供精确命令与 Terminal。没有 commit/PR 假按钮，也不调用不存在的 git.* method。</p>
            </div>
          </div>
          <CommandBlock command="git status --short && git worktree list" />
          <div className="ia-row-actions">
            <button type="button" className="ia-button is-secondary" onClick={() => setWorkspaceTab("terminal")}>在 Terminal 打开</button>
          </div>
        </div>
      )}

      {workspaceTab === "agents" && (
        <div className="ia-workspace-pane">
          {domainStatus("subagents") === "read_only" && (
            <div className="ia-tier-notice is-readonly">
              <Info size={14} />
              <div><b>older gateway · 只读 roster</b><p>steer/stop 在探测失败时隐藏，不假装停止成功。</p></div>
            </div>
          )}
          <div className="ia-list">
            {subagentsDemo.map((agent) => (
              <div className="ia-list-row" key={agent.id}>
                <div>
                  <b>{agent.name}</b>
                  <span>{agent.task}</span>
                  <span className="ia-list-meta">{agent.model} · {agent.elapsed} · {domainStatus("subagents") === "read_only" ? "last-known" : agent.status}</span>
                </div>
                {domainStatus("subagents") === "available" && agentState[agent.id] !== "stopped" ? (
                  <div className="ia-row-inline">
                    <button type="button" className="ia-inline-action" onClick={() => notify(`${agent.name} 已收到 steer（模拟）。`)}>steer</button>
                    <button
                      type="button"
                      className="ia-inline-action"
                      onClick={() => {
                        setAgentState((current) => ({ ...current, [agent.id]: "stopped" }));
                        notify(`${agent.name} 已停止（模拟）。`);
                      }}
                    >
                      stop
                    </button>
                  </div>
                ) : (
                  <span className="ia-readonly-text">{agentState[agent.id] === "stopped" ? "stopped" : "只读"}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {workspaceTab === "terminal" && (
        <div className="ia-workspace-pane">
          <div className="ia-terminal">
            <div className="ia-terminal-head">
              <span>{scope.gateway} / {scope.profile}</span>
              <span>SIMULATED PTY</span>
            </div>
            <div className="ia-terminal-body" aria-live="polite">
              {terminalLines.map((line, index) => (
                <span key={index} className={line.startsWith("$") ? "is-command" : undefined}>{line}</span>
              ))}
            </div>
            <form
              className="ia-terminal-form"
              onSubmit={(event) => {
                event.preventDefault();
                runTerminal();
              }}
            >
              <span>$</span>
              <input
                value={terminalDraft}
                onChange={(event) => setTerminalDraft(event.target.value)}
                placeholder="输入模拟命令…"
                aria-label="模拟终端命令"
              />
              <button type="submit" className="ia-inline-action" disabled={!terminalDraft.trim()}>运行</button>
            </form>
          </div>
          <div className="ia-row-actions">
            <button type="button" className="ia-button is-secondary" onClick={() => closeWorkspace(false)}>隐藏并保留 scrollback</button>
            <button type="button" className="ia-button is-secondary" onClick={() => resetTerminal()}>清空 scrollback</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkspaceSurface({ kind, side }: { kind: "drawer" | "sheet"; side?: "left" | "right" }) {
  const { closeWorkspace, scope } = useIa();
  return (
    <SurfaceFrame
      kind={kind}
      side={side}
      title="Workspace"
      subtitle={`${scope.gateway} / ${scope.profile} · SIM`}
      onClose={() => closeWorkspace(false)}
      actions={
        <>
          <button type="button" className="ia-button is-ghost" onClick={() => closeWorkspace(false)}>隐藏</button>
          <button type="button" className="ia-button is-ghost" onClick={() => closeWorkspace(true)}>关闭</button>
        </>
      }
      className="ia-workspace-surface"
    >
      <WorkspaceContent />
    </SurfaceFrame>
  );
}

export function ScopePopover({ className }: { className?: string }) {
  const { scope, setScope, closeSurface, notify } = useIa();
  return (
    <SurfaceFrame
      kind="popover"
      title="切换作用域"
      subtitle="SCOPE · SIM"
      onClose={closeSurface}
      className={cn("ia-scope-popover", className)}
      modal={false}
    >
      <p className="ia-popover-copy">当前执行上下文决定聊天、工具、文件与 Terminal 落在哪台机器。</p>
      <div className="ia-list">
        {scopes.map((item) => (
          <button
            type="button"
            className={cn("ia-list-row is-button", item.id === scope.id && "is-active")}
            key={item.id}
            onClick={() => {
              setScope(item.id);
              closeSurface();
              notify(`作用域已切换到 ${item.gateway} / ${item.profile}。`, "accent");
            }}
          >
            <div>
              <b>{item.gateway} <em>{item.profile}</em></b>
              <span>{item.kind} · {item.host} · {item.latency}</span>
            </div>
            <span className="ia-status-tag is-available">{item.id === scope.id ? "当前" : "切换"}</span>
          </button>
        ))}
      </div>
    </SurfaceFrame>
  );
}

export function SessionsPopover({ className }: { className?: string }) {
  const { setActiveSession, closeSurface, scene, setScene, openCapability, notify } = useIa();
  const [query, setQuery] = useState("");
  const filtered = demoSessions.filter((session) => {
    const needle = query.trim().toLowerCase();
    return !needle || session.title.toLowerCase().includes(needle) || session.preview.toLowerCase().includes(needle);
  });
  return (
    <SurfaceFrame
      kind="popover"
      title="Sessions"
      subtitle="RECENT · SIM"
      onClose={closeSurface}
      className={cn("ia-sessions-popover", className)}
      modal={false}
    >
      <div className="ia-search-field is-compact">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Session" aria-label="搜索 Session" />
      </div>
      <div className="ia-list">
        {filtered.map((session) => (
          <button
            type="button"
            className="ia-list-row is-button"
            key={session.id}
            onClick={() => {
              setActiveSession(session.id);
              if (scene === "empty") setScene("running");
              closeSurface();
            }}
          >
            <div>
              <b>{session.title}</b>
              <span>{session.scope} · {session.time}</span>
              <span className="ia-list-preview">{session.preview}</span>
            </div>
            {session.status === "approval" && <span className="ia-status-tag is-readonly">审批</span>}
          </button>
        ))}
      </div>
      <div className="ia-popover-actions">
        <button
          type="button"
          className="ia-button is-primary"
          onClick={() => {
            setActiveSession("");
            setScene("empty");
            closeSurface();
            notify("已新建空白 Session（模拟）。");
          }}
        >
          新对话
        </button>
        <button
          type="button"
          className="ia-button is-secondary"
          onClick={() => {
            closeSurface();
            openCapability("session");
          }}
        >
          Session 能力详情
        </button>
      </div>
    </SurfaceFrame>
  );
}

export function ApprovalSurface({ kind, side, className }: { kind: "drawer" | "popover"; side?: "left" | "right"; className?: string }) {
  const { closeSurface, setActiveSession, setScene, scene, notify } = useIa();
  return (
    <SurfaceFrame
      kind={kind}
      side={side}
      title="后台待审批"
      subtitle={`${approvalDemo.gateway} / ${approvalDemo.profile} · SIM`}
      onClose={closeSurface}
      className={cn("ia-approval-surface", className)}
      modal={kind === "drawer"}
    >
      <ApprovalCard compact />
      <div className="ia-approval-locate">
        <span className="ia-micro">OWNING SESSION</span>
        <p>审批属于「{approvalDemo.sessionTitle}」，不跟随当前 scope 或当前 Session 移动。</p>
        <button
          type="button"
          className="ia-button is-primary"
          onClick={() => {
            setActiveSession(approvalDemo.sessionId);
            if (scene === "empty") setScene("approval");
            closeSurface();
            notify(`已定位到 ${approvalDemo.sessionTitle}。`, "accent");
          }}
        >
          定位所属 Session
        </button>
      </div>
    </SurfaceFrame>
  );
}

export function CapabilitySurface({ kind, className }: { kind: "drawer" | "sheet"; className?: string }) {
  const { domainId, variant, closeSurface, setDomain } = useIa();
  const domain = domainById[domainId];
  const [view, setView] = useState<"list" | "detail">("detail");
  return (
    <SurfaceFrame
      kind={kind}
      side={kind === "drawer" ? "right" : undefined}
      title={view === "list" ? "能力索引" : "能力详情"}
      subtitle={view === "list" ? `${counts.total} 可达 · ${counts.deferred} 延期无入口` : `${domain.english.toUpperCase()} · ${variantMeta[variant].name}`}
      onClose={closeSurface}
      className={cn("ia-capability-surface", className)}
      actions={
        <button type="button" className="ia-button is-ghost" onClick={() => setView(view === "list" ? "detail" : "list")}>
          {view === "list" ? <ArrowRight size={12} /> : <ArrowLeft size={12} />}
          {view === "list" ? "详情" : "全部"}
        </button>
      }
    >
      {view === "list" ? (
        <div className="ia-capability-drawer-list">
          <div className="ia-palette-summary">
            <span>{counts.total} 可达</span>
            <span>原生 {counts.native}</span>
            <span>只读 {counts.readOnly}</span>
            <span>深链 {counts.deepLink}</span>
            <span className="is-muted">延期 {counts.deferred} 无入口</span>
          </div>
          <CapabilityList
            variant={variant}
            activeId={domainId}
            onSelect={(id) => {
              setDomain(id);
              setView("detail");
            }}
          />
        </div>
      ) : (
        <CapabilityDetail domain={domain} variant={variant} />
      )}
    </SurfaceFrame>
  );
}

export function CapabilityPaletteSurface({ variant, className }: { variant: Variant; className?: string }) {
  const { domainId, closeSurface, setDomain, openCapability } = useIa();
  return (
    <SurfaceFrame
      kind="sheet"
      title="能力索引"
      subtitle={`${variantMeta[variant].name} · 17 可达 / 4 延期`}
      onClose={closeSurface}
      className={cn("ia-capability-palette", className)}
    >
      <div className="ia-capability-palette-grid">
        <div className="ia-capability-palette-list">
          <div className="ia-palette-summary">
            <span>{counts.total} 可达</span>
            <span>原生 {counts.native}</span>
            <span>只读 {counts.readOnly}</span>
            <span>深链 {counts.deepLink}</span>
            <span className="is-muted">延期 {counts.deferred} 无入口</span>
          </div>
          <CapabilityList
            variant={variant}
            activeId={domainId}
            onSelect={(id) => {
              setDomain(id);
              openCapability(id);
            }}
          />
        </div>
        <div className="ia-capability-palette-detail">
          <CapabilityDetail domain={domainById[domainId]} variant={variant} />
        </div>
      </div>
    </SurfaceFrame>
  );
}

function ControlRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ia-control-row">
      <span className="ia-micro">{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function PrototypeSwitcher() {
  const { variant, setVariant, scene, setScene, capTier, setCapTier } = useIa();
  const [controls, setControls] = useState(false);

  const cycle = (direction: -1 | 1) => {
    const index = (["A", "B", "C"] as const).indexOf(variant);
    const next = (index + direction + 3) % 3;
    setVariant((["A", "B", "C"] as const)[next]);
  };

  return (
    <>
      {controls && (
        <div className="ia-controls" role="group" aria-label="原型模拟状态">
          <div className="ia-controls-head">
            <span>PROTOTYPE · 模拟状态</span>
            <button type="button" className="ia-icon-button" aria-label="收起状态" onClick={() => setControls(false)}>
              <X size={13} />
            </button>
          </div>
          <ControlRow label="CAPABILITY">
            {capTierKeys.map((tier) => (
              <button
                type="button"
                key={tier}
                className={cn("ia-segment", capTier === tier && "is-active")}
                aria-pressed={capTier === tier}
                onClick={() => setCapTier(tier)}
              >
                {tier === "unavailable" ? "-32601" : tier}
              </button>
            ))}
          </ControlRow>
          <ControlRow label="SCENE">
            {sceneKeys.map((item) => (
              <button
                type="button"
                key={item}
                className={cn("ia-segment", scene === item && "is-active")}
                aria-pressed={scene === item}
                onClick={() => setScene(item)}
              >
                {item === "empty" ? "静止空态" : item === "running" ? "运行中" : item === "approval" ? "后台审批" : "连接降级"}
              </button>
            ))}
          </ControlRow>
          <p className="ia-controls-note">状态只影响本原型，不连接真实 Gateway。</p>
        </div>
      )}
      <div className="ia-switcher" role="group" aria-label="原型变体切换">
        <button type="button" className="ia-switcher-arrow" onClick={() => cycle(-1)} aria-label="上一个变体">
          <ArrowLeft size={14} />
        </button>
        <div className="ia-switcher-label">
          <b>{variant}</b>
          <span>{variantMeta[variant].name}</span>
          <em>{variantMeta[variant].shell}</em>
        </div>
        <button type="button" className="ia-switcher-arrow" onClick={() => cycle(1)} aria-label="下一个变体">
          <ArrowRight size={14} />
        </button>
        <div className="ia-switcher-divider" />
        <button type="button" className="ia-switcher-state" onClick={() => setControls((value) => !value)} aria-expanded={controls}>
          <span className="ia-status-dot" />
          {capTier === "unavailable" ? "-32601" : capTier} · {scene === "empty" ? "空态" : scene === "running" ? "运行中" : scene === "approval" ? "审批" : "降级"}
          <ChevronDown size={12} />
        </button>
      </div>
    </>
  );
}

export function NoticeView() {
  const { notice } = useIa();
  if (!notice) return null;
  return (
    <div className={cn("ia-notice", notice.tone === "accent" && "is-accent")} role="status" aria-live="polite">
      <Check size={13} />
      {notice.message}
    </div>
  );
}

export function EmptyStateA() {
  const { openPalette, openWorkspace, setActiveSession, openCapability } = useIa();
  return (
    <div className="ia-empty ia-empty-a">
      <span className="ia-micro">RESTING SURFACE · A</span>
      <h1>安静，但一切可达。</h1>
      <p>常驻只保留 Session rail 与对话。Workspace 与 17 个能力域从右侧抽屉或 ⌘K 进入。</p>
      <div className="ia-empty-actions">
        <button type="button" className="ia-button is-primary" onClick={() => setActiveSession("s1")}>继续最近 Session</button>
        <button type="button" className="ia-button is-secondary" onClick={openPalette}><Command size={12} /> 能力目录</button>
        <button type="button" className="ia-button is-secondary" onClick={() => openWorkspace("artifacts")}>打开 Workspace</button>
      </div>
      <button type="button" className="ia-empty-note" onClick={() => openCapability("cron")}>
        <span className="ia-status-dot is-idle" />
        没有运行中的任务 · Cron 0 个计划
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

export function EmptyStateB() {
  const { openCapability, setActiveSession, openPalette } = useIa();
  return (
    <div className="ia-empty ia-empty-b">
      <span className="ia-micro">RESTING SURFACE · B</span>
      <h1>今天要做什么？</h1>
      <p>没有侧栏作为默认入口。用 composer 直接开始，或从下面三个上下文命令进入。</p>
      <div className="ia-command-cards">
        <button type="button" onClick={() => openCapability("mcp")}>
          <span className="ia-command-key">01</span>
          <b>检查 MCP 连接</b>
          <span>活动 Gateway 热重载与只读降级</span>
          <ArrowRight size={13} />
        </button>
        <button type="button" onClick={() => openCapability("cron")}>
          <span className="ia-command-key">02</span>
          <b>安排 Cron</b>
          <span>heartbeat / loop / 任务状态</span>
          <ArrowRight size={13} />
        </button>
        <button type="button" onClick={() => setActiveSession("s1")}>
          <span className="ia-command-key">03</span>
          <b>恢复最近 Session</b>
          <span>发布前检查 · HOMELAB / @research</span>
          <ArrowRight size={13} />
        </button>
      </div>
      <button type="button" className="ia-empty-note" onClick={openPalette}>
        <Command size={12} />
        按 ⌘K 搜索全部 17 个可达域
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

export function EmptyStateC() {
  const { setScope, scope, setActiveSession, openCapability } = useIa();
  return (
    <div className="ia-empty ia-empty-c">
      <span className="ia-micro">RESTING SURFACE · C</span>
      <h1>从哪个上下文开始？</h1>
      <p>顶部只保留路由与会话条。选择执行上下文后，对话列保持 720px 不动。</p>
      <div className="ia-scope-cards">
        {scopes.map((item) => (
          <button
            type="button"
            className={cn(item.id === scope.id && "is-active")}
            key={item.id}
            onClick={() => setScope(item.id)}
          >
            <span>{item.kind}</span>
            <b>{item.gateway}</b>
            <em>{item.profile}</em>
            <p>{item.host} · {item.latency}</p>
          </button>
        ))}
      </div>
      <div className="ia-empty-recent">
        <button type="button" onClick={() => setActiveSession("s1")}>
          继续最近 Session <span>发布前检查</span> <ArrowRight size={12} />
        </button>
        <button type="button" onClick={() => openCapability("cron")}>
          检查 Cron <span>0 个计划</span> <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

export function VariantTag({ variant }: { variant: Variant }) {
  return (
    <span className="ia-variant-tag">
      <b>{variant}</b>
      {variantMeta[variant].name}
    </span>
  );
}

export function WorkspaceTrigger({ label = "Workspace" }: { label?: string }) {
  const { openWorkspace, workspaceTab } = useIa();
  return (
    <button type="button" className="ia-workspace-trigger" onClick={() => openWorkspace(workspaceTab)}>
      <PanelRight size={14} />
      <span>{label}</span>
    </button>
  );
}

export function SettingsTrigger() {
  const { openSettings } = useIa();
  return (
    <button type="button" className="ia-icon-button" aria-label="Settings" onClick={openSettings}>
      <Settings2 size={15} />
    </button>
  );
}

export function PanelTrigger({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ia-dock-button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function CountPill({ value, label }: { value: string | number; label: string }) {
  return (
    <span className="ia-count-pill">
      <b>{value}</b> {label}
    </span>
  );
}

export function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="ia-icon-button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

export function HomeGlyph() {
  return (
    <span className="ia-home-glyph" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="ia-micro">{children}</span>;
}

export function SmallStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="ia-small-stat">
      <b>{value}</b> {label}
    </span>
  );
}

export function SceneChip({ scene }: { scene: Scene }) {
  return (
    <span className="ia-scene-chip">
      {scene === "empty" ? "静止空态" : scene === "running" ? "运行中" : scene === "approval" ? "后台审批" : "连接降级"}
    </span>
  );
}

export function CapTierChip({ tier }: { tier: CapTier }) {
  return <span className={cn("ia-scene-chip", tier === "unavailable" && "is-warn")}>{tier === "unavailable" ? "-32601" : tier}</span>;
}

export function ArrowHint({ direction }: { direction: "left" | "right" }) {
  return direction === "left" ? <ArrowLeft size={12} /> : <ArrowRight size={12} />;
}

export function DownHint() {
  return <ArrowDown size={12} />;
}

export function Chevron() {
  return <ChevronRight size={12} />;
}

export function Divider() {
  return <span className="ia-divider" />;
}

export function PanelLeftIcon() {
  return <PanelLeft size={14} />;
}

export function SettingsIcon() {
  return <Settings2 size={14} />;
}

export function CommandIcon() {
  return <Command size={14} />;
}

export function TerminalIcon() {
  return <SquareTerminal size={14} />;
}

export function AlertIcon() {
  return <AlertTriangle size={14} />;
}

export function DotIcon() {
  return <CircleDot size={14} />;
}

export function FileIcon() {
  return <FileText size={14} />;
}

export function FolderIcon() {
  return <Folder size={14} />;
}

export function CheckIcon() {
  return <Check size={14} />;
}
