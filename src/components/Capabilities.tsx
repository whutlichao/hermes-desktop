import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  Fingerprint,
  KeyRound,
  Layers,
  MemoryStick,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react";
import type { CapabilityTab, CronJob, McpServer } from "../types";
import { useApp } from "../state/AppContext";
import {
  canHotReloadMcp,
  capabilityChannels,
  capabilityCronJobs,
  capabilityMcpServers,
  capabilityMemoryFiles,
  getActiveGateway,
  getGateway,
  getProfile,
  getProfilesForGateway,
} from "../state/store";
import { cn, gatewayKind } from "../lib/ui";
import {
  Button,
  Drawer,
  EmptyState,
  IconButton,
  InlineNotice,
  SectionTitle,
  Segmented,
  StatusDot,
  Toggle,
} from "./ui";

const tabs: Array<{ id: CapabilityTab; label: string; icon: typeof Sparkles }> = [
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "mcp", label: "MCP", icon: Network },
  { id: "memory", label: "Memory", icon: MemoryStick },
  { id: "cron", label: "Cron", icon: Clock3 },
  { id: "channels", label: "Channels", icon: Radio },
];

function ScopeBar() {
  const { state, dispatch } = useApp();
  const profiles = getProfilesForGateway(state, state.capabilities.scopeGatewayId);
  const gateway = getGateway(state, state.capabilities.scopeGatewayId);
  return (
    <div className="cap-scope">
      <span className="micro-label">Scope</span>
      <div className="scope-selects">
        <label>
          <span className="sr-only">Gateway</span>
          <select
            value={state.capabilities.scopeGatewayId}
            onChange={(event) => {
              const gatewayId = event.target.value;
              const nextProfiles = getProfilesForGateway(state, gatewayId);
              dispatch({
                type: "SET_CAPABILITY_SCOPE",
                gatewayId,
                profileId: nextProfiles[0]?.id ?? state.capabilities.scopeProfileId,
              });
            }}
          >
            {state.gateways.map((row) => (
              <option key={row.id} value={row.id}>{row.name} · {gatewayKind(row)}</option>
            ))}
          </select>
          <ChevronDown size={11} />
        </label>
        <span>/</span>
        <label>
          <span className="sr-only">Profile</span>
          <select
            value={state.capabilities.scopeProfileId}
            onChange={(event) =>
              dispatch({
                type: "SET_CAPABILITY_SCOPE",
                gatewayId: state.capabilities.scopeGatewayId,
                profileId: event.target.value,
              })
            }
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.handle}</option>
            ))}
          </select>
          <ChevronDown size={11} />
        </label>
      </div>
      {gateway?.id !== state.activeGatewayId && (
        <span className="scope-warning">只读作用域 · 非活动 Gateway</span>
      )}
    </div>
  );
}

function SkillsPane() {
  const { state, dispatch } = useApp();
  const scopeProfile = getProfile(state, state.capabilities.scopeGatewayId, state.capabilities.scopeProfileId);
  const [category, setCategory] = useState("all");
  const categories = ["all", ...new Set(state.skills.map((skill) => skill.category))];
  const filtered = state.skills.filter((skill) => {
    const matchesQuery = `${skill.name} ${skill.description}`.toLowerCase().includes(state.capabilities.skillQuery.toLowerCase());
    const matchesCategory = category === "all" || skill.category === category;
    return matchesQuery && matchesCategory;
  });
  const installed = filtered.filter((skill) => skill.installed);
  const catalog = filtered.filter((skill) => !skill.installed);
  return (
    <div className="cap-pane">
      <SectionTitle
        title="Skills"
        detail={`${state.skills.filter((skill) => skill.installed && skill.enabled).length} 启用 · ${state.skills.filter((skill) => !skill.installed).length} 可从 Hub 安装`}
        action={<Button variant="secondary" onClick={() => dispatch({ type: "SET_TOAST", title: "Skills Hub", message: "目录已刷新（模拟）。" })}><RefreshCw size={12} /> 刷新 Hub</Button>}
      />
      <div className="search-bar">
        <Search size={13} />
        <input
          value={state.capabilities.skillQuery}
          onChange={(event) => dispatch({ type: "SET_SKILL_QUERY", value: event.target.value })}
          placeholder="搜索 Skills、来源、用途"
          aria-label="搜索 Skills"
        />
        <span>{filtered.length}</span>
      </div>
      <div className="filter-chips" role="group" aria-label="Skill 分类">
        {categories.map((item) => (
          <button
            type="button"
            key={item}
            className={cn((item === "all" ? category === "all" : category === item) && "is-active")}
            onClick={() => setCategory(item)}
          >
            {item === "all" ? "全部" : item}
          </button>
        ))}
      </div>

      <div className="curator-strip">
        <span className="curator-mark"><Activity size={13} /></span>
        <div><b>Curator 正常运行</b><span>每天扫描 Skills，保留高使用率条目；更新需你确认。</span></div>
        <button type="button" onClick={() => dispatch({ type: "SET_TOAST", title: "Curator report", message: "3 kept · 1 update available. 原型模拟。" })}>查看报告 <ArrowRight size={11} /></button>
      </div>

      <SectionTitle title="已安装" detail={`在 ${scopeProfile?.handle ?? "当前 profile"} 上生效`} />
      <div className="stack-list">
        {installed.map((skill) => (
          <div className="skill-row" key={skill.id}>
            <span className="skill-glyph"><Sparkles size={13} /></span>
            <div className="skill-copy">
              <div><b>{skill.name}</b><span>{skill.source}</span>{skill.curator?.includes("update") && <em>update</em>}</div>
              <p>{skill.description}</p>
              {skill.curator && <span className="row-note">{skill.curator}</span>}
            </div>
            <Toggle checked={skill.enabled} onChange={() => dispatch({ type: "TOGGLE_SKILL", skillId: skill.id })} label={`${skill.name} 启用`} />
          </div>
        ))}
      </div>

      <SectionTitle title="Skills Hub" detail="官方与社区 Skills · 安装前扫描" />
      <div className="hub-grid">
        {catalog.map((skill) => (
          <div className="hub-card" key={skill.id}>
            <div className="hub-card-head"><span>{skill.category}</span><ExternalLink size={11} /></div>
            <b>{skill.name}</b>
            <p>{skill.description}</p>
            <button type="button" onClick={() => dispatch({ type: "INSTALL_SKILL", skillId: skill.id })}>
              <Plus size={11} /> 一键安装
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolsPane() {
  const { state, dispatch } = useApp();
  const [approval, setApproval] = useState<"ask" | "allowlist">("ask");
  const [autoRead, setAutoRead] = useState(true);
  return (
    <div className="cap-pane">
      <SectionTitle
        title="Tools & Toolsets"
        detail="工具集决定 Hermes 能做什么；审批规则保护有副作用的动作。"
        action={<Button variant="secondary" onClick={() => dispatch({ type: "SET_TOAST", title: "Tool catalog updated", message: "已刷新工具清单（模拟）。" })}><RefreshCw size={12} /> 刷新</Button>}
      />
      <div className="rule-strip">
        <ShieldCheck size={15} />
        <div><b>Safety floor</b><span>破坏性命令始终显示目标主机、完整命令与工作目录。</span></div>
        <span>on</span>
      </div>

      <SectionTitle title="Approval" detail="适用于当前 (gateway, profile)" />
      <div className="setting-line">
        <div><b>危险命令</b><span>rm -rf、force push、prod mutation 等</span></div>
        <Segmented
          value={approval}
          options={[
            { value: "ask", label: "每次询问" },
            { value: "allowlist", label: "Allowlist" },
          ]}
          onChange={setApproval}
          label="危险命令审批"
        />
      </div>
      <div className="setting-line">
        <div><b>只读工具自动批准</b><span>读取文件、列目录、查询状态仍记录在工具轨迹中</span></div>
        <Toggle checked={autoRead} onChange={setAutoRead} label="只读工具自动批准" />
      </div>
      <div className="allowlist-box">
        <div><span>Command allowlist</span><b>pnpm build</b><b>git status</b><b>rg</b></div>
        <button type="button" onClick={() => dispatch({ type: "SET_TOAST", title: "Allowlist editor", message: "编辑 allowlist 需在完整设置中确认（模拟）。" })}>编辑</button>
      </div>

      <SectionTitle title="Toolsets" detail="关闭后从下一次推理起不可见" />
      <div className="stack-list toolsets-list">
        {state.toolsets.map((toolset) => (
          <div className="toolset-row" key={toolset.id}>
            <span className="toolset-icon"><Wrench size={13} /></span>
            <div><b>{toolset.name}</b><p>{toolset.description}</p><code>{toolset.examples}</code></div>
            <Toggle checked={toolset.enabled} onChange={() => dispatch({ type: "TOGGLE_TOOLSET", toolsetId: toolset.id })} label={`${toolset.name} toolset 启用`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function McpRow({ server }: { server: McpServer }) {
  const { state, dispatch } = useApp();
  const [expanded, setExpanded] = useState(false);
  const active = canHotReloadMcp(state);
  return (
    <div className={cn("mcp-row", expanded && "is-open")}>
      <div className="mcp-row-head">
        <span className={cn("transport-badge", server.transport)}>{server.transport.toUpperCase()}</span>
        <div className="mcp-copy">
          <div><b>{server.name}</b><span className={cn("mcp-status", `is-${server.status}`)}><StatusDot tone={server.status === "ready" ? "ok" : server.status === "stale" ? "warn" : "error"} />{server.status}</span></div>
          <p>{server.filters.length}/{server.tools.length} tools exposed</p>
        </div>
        <button type="button" className="mcp-expand" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          filters <ChevronDown size={12} />
        </button>
        <Toggle checked={server.enabled} onChange={() => dispatch({ type: "TOGGLE_MCP", serverId: server.id })} label={`${server.name} MCP 启用`} />
      </div>
      {expanded && (
        <div className="mcp-tools">
          <div className="mcp-tools-label">Per-server tool filter</div>
          <div className="filter-chips">
            {server.tools.map((tool) => {
              const selected = server.filters.includes(tool);
              return (
                <button
                  type="button"
                  key={tool}
                  className={cn(selected && "is-active")}
                  aria-pressed={selected}
                  onClick={() =>
                    dispatch({
                      type: "SET_MCP_FILTER",
                      serverId: server.id,
                      filters: selected ? server.filters.filter((item) => item !== tool) : [...server.filters, tool],
                    })
                  }
                >
                  {tool}
                </button>
              );
            })}
          </div>
          <div className="mcp-row-foot">
            <span>{active ? "Live session · hot reload available" : "配置只应用到目标 scope"}</span>
            <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "MCP server settings", message: `${server.name}: ${server.filters.length} tools enabled.` })}>高级设置</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function McpPane() {
  const { state, dispatch } = useApp();
  const servers = capabilityMcpServers(state);
  const active = canHotReloadMcp(state);
  const stale = servers.filter((server) => server.status !== "ready").length;
  return (
    <div className="cap-pane">
      <SectionTitle
        title="MCP Servers"
        detail={`${servers.filter((server) => server.enabled).length} 启用 · ${stale} 需要重载`}
        action={<Button variant="secondary" onClick={() => dispatch({ type: "SET_TOAST", title: "Add MCP server", message: "stdio / HTTP 配置向导（模拟）。" })}><Plus size={12} /> 添加</Button>}
      />
      {active ? (
        <div className="mcp-live-strip">
          <span className="live-mark"><Zap size={13} /></span>
          <div><b>Live session</b><span>可把配置热重载到当前窗口的会话，不重启 gateway。</span></div>
          <Button variant="primary" onClick={() => dispatch({ type: "RELOAD_MCP" })}>
            <RefreshCw size={12} /> 热重载全部
          </Button>
        </div>
      ) : (
        <InlineNotice tone="warn">
          该 scope 不是当前活动 Gateway。为防把配置推错机器，热重载不在这里显示；改动会在目标机器的下一次 Session 生效。
        </InlineNotice>
      )}
      <div className="stack-list mcp-list">
        {servers.map((server) => <McpRow server={server} key={server.id} />)}
      </div>
      {servers.length === 0 && (
        <EmptyState icon={<Network size={22} />} title="这个 scope 没有 MCP server" body="添加 stdio 或 HTTP server 后，可控制每个 server 暴露的 tools。" />
      )}
      <div className="cap-footnote">
        <KeyRound size={12} />
        MCP 凭据保存在目标机器上。原型不会读取、写入或测试任何真实 secret。
      </div>
    </div>
  );
}

function MemoryPane() {
  const { state, dispatch } = useApp();
  const files = capabilityMemoryFiles(state);
  const [selected, setSelected] = useState(files[0]?.id ?? "");
  const [preset, setPreset] = useState("Calm operator");
  const current = files.find((file) => file.id === selected) ?? files[0];
  useEffect(() => {
    if (!files.some((file) => file.id === selected)) setSelected(files[0]?.id ?? "");
  }, [files, selected]);
  return (
    <div className="cap-pane">
      <SectionTitle
        title="Memory & Context"
        detail="记忆随 profile 保存；项目上下文只暴露当前 Gateway 可读的文件。"
        action={
          <Button variant="secondary" onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "memoryGraph" })}>
            <Network size={12} /> Memory Graph
          </Button>
        }
      />
      <div className="memory-workspace">
        <div className="memory-editor">
          <div className="file-tabs" role="tablist" aria-label="Memory 文件">
            {files.map((file) => (
              <button
                type="button"
                role="tab"
                aria-selected={file.id === current?.id}
                key={file.id}
                className={cn(file.id === current?.id && "is-active")}
                onClick={() => setSelected(file.id)}
              >
                {file.name}
              </button>
            ))}
          </div>
          {current ? (
            <>
              <div className="memory-editor-meta">
                <span><FileText size={11} /> {current.name}</span>
                <span>auto-saved · simulated</span>
              </div>
              <textarea
                value={current.content}
                onChange={(event) => dispatch({ type: "SET_MEMORY_FILE", fileId: current.id, content: event.target.value })}
                aria-label={`编辑 ${current.name}`}
                spellCheck={false}
              />
            </>
          ) : (
            <EmptyState icon={<MemoryStick size={20} />} title="没有 memory 文件" body="该 profile 尚未创建本地记忆文件。" />
          )}
        </div>
        <aside className="memory-aside">
          <section>
            <div className="micro-label">Personality / SOUL</div>
            <div className="preset-list">
              {[
                ["Calm operator", "证据优先，先说明执行主机"],
                ["Research lead", "先给结论，再列来源与分歧"],
                ["Pair builder", "小步修改，持续自检"],
              ].map(([name, detail]) => (
                <button type="button" key={name} className={cn(preset === name && "is-active")} onClick={() => setPreset(name)}>
                  <span className="preset-mark">{preset === name ? <Check size={11} /> : <Brain size={11} />}</span>
                  <span><b>{name}</b><em>{detail}</em></span>
                </button>
              ))}
            </div>
            <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "SOUL preset applied", message: `${preset} · 已写入当前 profile（模拟）`, tone: "success" })}>应用 personality</Button>
          </section>
          <section>
            <div className="micro-label">Project context</div>
            <div className="context-file-list">
              <span><FileText size={11} /> .hermes/CONTEXT.md <em>read</em></span>
              <span><FileText size={11} /> docs/architecture.md <em>read</em></span>
              <span><FileText size={11} /> package.json <em>scoped</em></span>
            </div>
            <button type="button" className="aside-action" onClick={() => dispatch({ type: "SET_TOAST", title: "Context files", message: "可从当前 Gateway 的文件树添加（模拟）。" })}><Plus size={11} /> 添加项目上下文</button>
          </section>
          <section>
            <div className="micro-label">Memory Provider</div>
            <div className="provider-card">
              <span className="provider-icon"><Database size={13} /></span>
              <div><b>Local files</b><span>MEMORY.md · USER.md · SOUL.md</span></div>
              <span className="provider-status">READY</span>
            </div>
            <button type="button" className="aside-action" onClick={() => dispatch({ type: "SET_TOAST", title: "External memory provider", message: "连接外部 provider 需要凭据，原型中不执行。" })}>连接外部 provider <ArrowRight size={11} /></button>
          </section>
        </aside>
      </div>
      <div className="cap-footnote">
        <Fingerprint size={12} />
        当前 scope：{files[0]?.gatewayId ?? "—"} / {files[0]?.profileId ?? "—"} · 仅可编辑该 profile 的记忆文件。
      </div>
    </div>
  );
}

function CronRow({ job }: { job: CronJob }) {
  const { state, dispatch } = useApp();
  const [expanded, setExpanded] = useState(false);
  const gateway = getGateway(state, job.gatewayId);
  const profile = getProfile(state, job.gatewayId, job.profileId);
  const running = job.status === "running";
  return (
    <div className={cn("cron-row", expanded && "is-open")}>
      <div className="cron-row-head">
        <span className={cn("cron-icon", running && "is-running")}><Clock3 size={13} /></span>
        <div className="cron-copy">
          <div>
            <b>{job.name}</b>
            {job.heartbeat && <em className="marker">HEARTBEAT</em>}
            {job.loop && <em className="marker">LOOP</em>}
          </div>
          <p>{job.schedule} · 下次 {job.nextRun}</p>
          <span>{gateway?.name} / {profile?.handle}</span>
        </div>
        <span className={cn("cron-status", `is-${job.status}`)}>
          <StatusDot tone={job.status === "error" ? "error" : job.status === "paused" ? "idle" : job.status === "running" ? "warn" : "ok"} />
          {job.status === "active" ? "Active" : job.status === "paused" ? "Paused" : job.status === "running" ? "Running" : job.status}
        </span>
        <div className="cron-actions">
          <IconButton label={job.status === "paused" ? "恢复 Cron" : "暂停 Cron"} onClick={() => dispatch({ type: "TOGGLE_CRON", jobId: job.id })}>
            {job.status === "paused" ? <Play size={12} /> : <Pause size={12} />}
          </IconButton>
          <Button
            variant="quiet"
            disabled={running}
            onClick={() => {
              dispatch({ type: "RUN_CRON", jobId: job.id });
              window.setTimeout(() => dispatch({ type: "CRON_DONE", jobId: job.id, ok: job.status !== "error" }), 1400);
            }}
          >
            <Play size={11} /> 立即运行
          </Button>
          <button type="button" className="cron-expand" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            history <ChevronDown size={11} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="cron-history">
          <div className="cron-history-head"><span>最近运行</span><span>{job.lastRun}</span></div>
          {job.history.slice(0, 4).map((run) => (
            <div className="cron-run" key={run.id}>
              <span>{run.at}</span>
              <span className={cn("run-result", `is-${run.result}`)}>{run.result === "success" ? <Check size={10} /> : run.result === "error" ? <AlertTriangle size={10} /> : <RefreshCw size={10} className="spin" />}{run.result}</span>
              <span>{run.duration}</span>
              <button type="button" onClick={() => dispatch({ type: "SET_TOAST", title: "Cron log", message: `${job.name} · ${run.at} · ${run.result}` })}>日志 <ArrowRight size={9} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CronPane() {
  const { state, dispatch } = useApp();
  const scoped = capabilityCronJobs(state);
  const jobs = state.allProfiles ? state.cronJobs : scoped;
  const grouped = state.allProfiles
    ? [...new Set(jobs.map((job) => `${job.gatewayId}:${job.profileId}`))]
    : [];
  return (
    <div className="cap-pane">
      <SectionTitle
        title="Cron, Heartbeats & Loops"
        detail={`${jobs.filter((job) => job.status === "active").length} active · ${jobs.filter((job) => job.heartbeat).length} heartbeat · ${jobs.filter((job) => job.loop).length} loop`}
        action={<Button variant="secondary" onClick={() => dispatch({ type: "SET_TOAST", title: "New Cron", message: "创建计划任务需要确认 schedule 与目标 profile（模拟）。" })}><Plus size={12} /> 新建 Cron</Button>}
      />
      <div className="cron-aggregate">
        <div><Layers size={14} /><span><b>{state.allProfiles ? "All Profiles aggregation" : "Scoped scheduler"}</b><em>{state.allProfiles ? "跨 gateway 汇总，运行仍落在各自 profile" : "只显示当前 capability scope"}</em></span></div>
        <Button variant={state.allProfiles ? "primary" : "secondary"} onClick={() => dispatch({ type: "TOGGLE_ALL_PROFILES" })}>
          {state.allProfiles ? "返回 scoped" : "显示 All Profiles"}
        </Button>
      </div>
      {state.allProfiles && (
        <div className="cron-group-summary">
          {grouped.map((key) => {
            const [gatewayId, profileId] = key.split(":");
            const gateway = getGateway(state, gatewayId);
            const profile = getProfile(state, gatewayId, profileId);
            const groupJobs = jobs.filter((job) => job.gatewayId === gatewayId && job.profileId === profileId);
            return (
              <span key={key}>
                <b>{gateway?.name}</b> / {profile?.handle} <em>{groupJobs.length}</em>
              </span>
            );
          })}
        </div>
      )}
      <div className="stack-list cron-list">
        {jobs.map((job) => <CronRow job={job} key={job.id} />)}
      </div>
      {jobs.length === 0 && (
        <EmptyState icon={<Clock3 size={22} />} title="没有计划任务" body="Cron、heartbeat 与 loop 会显示在这里；所有运行都归属创建它的 profile。" />
      )}
      <div className="cap-footnote">
        <CircleHelp size={12} />
        All Profiles 是聚合视图；暂停或立即运行仍只作用于任务所属的 (gateway, profile)。
      </div>
    </div>
  );
}

function ChannelsPane() {
  const { state, dispatch } = useApp();
  const channels = capabilityChannels(state);
  return (
    <div className="cap-pane">
      <SectionTitle
        title="Messaging Channels"
        detail={`${channels.filter((channel) => channel.connected).length} connected · 凭据变更后需重启 gateway`}
        action={<Button variant="secondary" onClick={() => dispatch({ type: "SET_TOAST", title: "Add channel", message: "选择平台后需提供 bot token 或扫码（模拟）。" })}><Plus size={12} /> 添加 Channel</Button>}
      />
      {state.restartRequired && (
        <div className="restart-banner" role="alert">
          <span className="restart-mark"><RefreshCw size={14} /></span>
          <div><b>Credential changes are staged</b><span>重启 gateway 后，新的 channel 凭据与开关才会生效。</span></div>
          <Button variant="primary" onClick={() => dispatch({ type: "RESTART_GATEWAY" })}>立即重启 Gateway</Button>
        </div>
      )}
      <div className="channel-grid">
        {channels.map((channel) => (
          <div className={cn("channel-card", channel.connected && "is-connected")} key={channel.id}>
            <div className="channel-head">
              <span className="channel-mark">{channel.kind.slice(0, 1)}</span>
              <div><b>{channel.kind}</b><span>{channel.handle}</span></div>
              <Toggle checked={channel.connected} onChange={() => dispatch({ type: "TOGGLE_CHANNEL", channelId: channel.id })} label={`${channel.kind} 连接`} />
            </div>
            <div className="channel-foot">
              <span className={cn("channel-state", channel.connected ? "is-ready" : "is-paused")}>
                <StatusDot tone={channel.connected ? "ok" : "idle"} /> {channel.connected ? "ready" : "paused"}
              </span>
              {channel.kind === "Telegram" && (
                <button type="button" onClick={() => dispatch({ type: "SET_OVERLAY", overlay: "qr" })}>
                  Quick Setup QR <ExternalLink size={10} />
                </button>
              )}
              <button type="button" onClick={() => dispatch({ type: "SET_TOAST", title: `${channel.kind} settings`, message: `${channel.handle} · 凭据编辑为原型占位。` })}>配置</button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="channel-add"
          onClick={() => dispatch({ type: "SET_TOAST", title: "Add channel", message: "Webhook, Slack, Discord, WhatsApp, Signal（模拟）。" })}
        >
          <Plus size={16} />
          <span><b>连接另一个平台</b><em>Slack · Discord · WhatsApp · Signal · Webhook</em></span>
        </button>
      </div>
      <div className="channel-credential-note">
        <ShieldCheck size={13} />
        <div><b>Credentials stay on the gateway host</b><span>Desktop 只保存连接引用；切换 profile 时会重新读取该 scope 的 channel 状态。</span></div>
      </div>
    </div>
  );
}

export function CapabilitiesDrawer() {
  const { state, dispatch } = useApp();
  const gateway = getGateway(state, state.capabilities.scopeGatewayId);
  const profile = getProfile(state, state.capabilities.scopeGatewayId, state.capabilities.scopeProfileId);
  const tab = state.capabilities.tab;
  return (
    <Drawer
      open={state.capabilitiesOpen}
      title="Capabilities"
      description={`${gateway?.name ?? "Gateway"} · ${profile?.handle ?? "Profile"} · 所有操作都在选定 scope 内`}
      onClose={() => dispatch({ type: "CLOSE_CAPABILITIES" })}
      className="cap-drawer"
      toolbar={<ScopeBar />}
    >
      <div className="cap-layout">
        <nav className="cap-nav" aria-label="Capabilities sections">
          {tabs.map((item) => (
            <button
              type="button"
              key={item.id}
              className={cn(tab === item.id && "is-active")}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => dispatch({ type: "SET_CAPABILITY_TAB", tab: item.id })}
            >
              <item.icon size={14} />
              <span>{item.label}</span>
              {item.id === "channels" && state.restartRequired && <i className="nav-alert" />}
            </button>
          ))}
          <div className="cap-nav-scope">
            <StatusDot tone={getActiveGateway(state).id === state.capabilities.scopeGatewayId ? "ok" : "idle"} />
            <span>{getActiveGateway(state).id === state.capabilities.scopeGatewayId ? "活动 Gateway" : "非活动 scope"}</span>
          </div>
        </nav>
        <div className="cap-content">
          {tab === "skills" && <SkillsPane />}
          {tab === "tools" && <ToolsPane />}
          {tab === "mcp" && <McpPane />}
          {tab === "memory" && <MemoryPane />}
          {tab === "cron" && <CronPane />}
          {tab === "channels" && <ChannelsPane />}
        </div>
      </div>
    </Drawer>
  );
}
