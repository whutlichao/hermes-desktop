import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Cable,
  ChevronRight,
  Command,
  CornerDownLeft,
  FileSearch,
  FolderGit2,
  History,
  Layers,
  ListChecks,
  MemoryStick,
  MessageSquarePlus,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import { useApp } from "../state/AppContext";
import { getActiveGateway, getActiveProfile } from "../state/store";
import { cn } from "../lib/ui";
import { simulateGatewayTest, simulateUpdateAll } from "../lib/simulation";
import { Kbd, useFocusTrap } from "./ui";

interface CommandItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  group: string;
  icon: typeof Command;
  run: () => void;
}

export function CommandPalette() {
  const { state, dispatch } = useApp();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  const close = () => dispatch({ type: "CLOSE_OVERLAY" });
  useFocusTrap(state.overlay === "palette", paletteRef, close);

  const commands = useMemo<CommandItem[]>(() => {
    const capability = (tab: "skills" | "tools" | "mcp" | "memory" | "cron" | "channels", label: string, hint: string, icon: typeof Command) => ({
      id: `cap-${tab}`,
      label,
      hint,
      keywords: `capability ${tab} ${label}`,
      group: "Capabilities",
      icon,
      run: () => dispatch({ type: "OPEN_CAPABILITIES", tab }),
    });
    const workspace = (tab: "artifacts" | "files" | "git" | "agents" | "terminal" | "voice", label: string, hint: string, icon: typeof Command) => ({
      id: `ws-${tab}`,
      label,
      hint,
      keywords: `workspace ${tab} ${label}`,
      group: "Workspace",
      icon,
      run: () => dispatch({ type: "OPEN_WORKSPACE", tab }),
    });
    const setting = (section: "model" | "workspace" | "safety" | "memory" | "voice" | "chat" | "gateways" | "updates", label: string, icon: typeof Command) => ({
      id: `set-${section}`,
      label,
      hint: "打开 Settings",
      keywords: `settings preference ${section} ${label}`,
      group: "Settings",
      icon,
      run: () => dispatch({ type: "OPEN_SETTINGS", section }),
    });
    return [
      { id: "new-session", label: "新对话", hint: "在当前 Gateway / Profile 新建 Session", keywords: "new session chat 新对话", group: "Session", icon: MessageSquarePlus, run: () => dispatch({ type: "NEW_SESSION" }) },
      { id: "switch-gateway", label: "切换 Gateway / Profile", hint: `${gateway.name} · ${profile.handle}`, keywords: "switch gateway profile context 切换", group: "Session", icon: Cable, run: () => dispatch({ type: "TOGGLE_GATEWAY_SWITCHER", open: true }) },
      { id: "all-profiles", label: "切换 All Profiles 联合视图", hint: state.allProfiles ? "当前已启用" : "按 Gateway & Profile 分组", keywords: "all profiles union 联合", group: "Session", icon: Layers, run: () => dispatch({ type: "TOGGLE_ALL_PROFILES" }) },
      { id: "bot-mode", label: "打开 Bot Mode", hint: "Bots roster、Bot Chat 与 Routines", keywords: "bot mode bots routines", group: "Session", icon: Bot, run: () => dispatch({ type: "SET_SIDEBAR_MODE", mode: "bots" }) },
      {
        id: "test-active",
        label: `测试 ${gateway.name}`,
        hint: `${gateway.host} · HTTP + WS 模拟探测`,
        keywords: "test gateway connection probe 测试",
        group: "Fleet",
        icon: RefreshCw,
        run: () => simulateGatewayTest(dispatch, gateway),
      },
      {
        id: "update-all",
        label: "Update all instances",
        hint: "Cloud 由平台管理，将跳过",
        keywords: "update all instances fleet 更新",
        group: "Fleet",
        icon: RefreshCw,
        run: () => simulateUpdateAll(dispatch, state.gateways),
      },
      setting("gateways", "Gateway registry", Network),
      capability("skills", "Skills", "已安装 Skills、Hub 与 Curator", Sparkles),
      capability("mcp", "MCP Servers", "配置、tool filters 与热重载", Network),
      capability("memory", "Memory & Context", "MEMORY.md / USER.md / SOUL.md", MemoryStick),
      capability("cron", "Cron / Heartbeats / Loops", "计划任务、运行历史与聚合", History),
      capability("channels", "Messaging Channels", "Telegram / Discord / Slack / Webhooks", Cable),
      capability("tools", "Tools & Toolsets", "工具集开关与审批规则", ShieldCheck),
      workspace("artifacts", "Artifacts & 文件预览", "带注释 pins 的预览工作区", FileSearch),
      workspace("terminal", "Embedded Terminal", "当前主机上的模拟 shell", Terminal),
      workspace("git", "Git Review & Worktrees", "diff 与隔离 worktree", FolderGit2),
      workspace("agents", "Live Subagents", "检查、steer 或停止子代理", Workflow),
      workspace("voice", "Voice Mode / Wake Word", "Push-to-talk、Hey Hermes 与 TTS", Command),
      { id: "checkpoints", label: "Checkpoint & Rollback", hint: "当前 Session 的快照", keywords: "checkpoint rollback restore 回滚", group: "Session", icon: History, run: () => dispatch({ type: "SET_OVERLAY", overlay: "checkpoints" }) },
      { id: "memory-graph", label: "Memory Graph · /journey", hint: "查看记忆、来源与引用路径", keywords: "journey memory graph 记忆图谱", group: "Memory", icon: Network, run: () => dispatch({ type: "SET_OVERLAY", overlay: "memoryGraph" }) },
      setting("model", "Model & reasoning", ListChecks),
      setting("safety", "Safety rules", ShieldCheck),
      setting("updates", "Updates", RefreshCw),
      { id: "shortcuts", label: "Keyboard shortcuts", hint: "⌘K、Escape、焦点与导航", keywords: "keyboard shortcuts help 快捷键", group: "Help", icon: Command, run: () => dispatch({ type: "SET_OVERLAY", overlay: "shortcuts" }) },
    ];
  }, [dispatch, gateway, profile.handle, state.allProfiles, state.gateways]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint} ${command.keywords}`.toLowerCase().includes(normalized),
    );
  }, [commands, query]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    filtered.forEach((command) => {
      map.set(command.group, [...(map.get(command.group) ?? []), command]);
    });
    return [...map.entries()];
  }, [filtered]);

  useEffect(() => {
    setSelected(0);
    inputRef.current?.focus();
  }, [query]);

  useEffect(() => {
    itemRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (state.overlay !== "palette") return null;

  const execute = (command?: CommandItem) => {
    if (!command) return;
    close();
    window.setTimeout(command.run, 0);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      execute(filtered[selected]);
    } else if (event.key === "Escape") {
      close();
    }
  };

  let flatIndex = -1;

  return (
    <div className="palette-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={paletteRef} className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onKeyDown={onKeyDown}>
        <div className="palette-input-wrap">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索命令、Gateway、Setting…"
            aria-label="搜索命令"
            autoComplete="off"
          />
          <Kbd>esc</Kbd>
          <button type="button" className="palette-close" onClick={close} aria-label="关闭命令面板"><X size={13} /></button>
        </div>
        <div className="palette-scope">
          <span><span className="scope-dot" /> {gateway.name} · {state.allProfiles ? "All Profiles" : profile.handle}</span>
          <em>模拟内容</em>
        </div>
        <div className="palette-list" role="listbox" aria-label="命令">
          {filtered.length === 0 ? (
            <div className="palette-empty">
              <FileSearch size={24} />
              <h3>没有匹配的命令</h3>
              <p>试试 “Gateway”、“MCP”、“Memory” 或 “Terminal”。</p>
            </div>
          ) : (
            groups.map(([group, items]) => (
              <section className="palette-group" key={group}>
                <div className="palette-group-label">{group}</div>
                {items.map((command) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const Icon = command.icon;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected === index}
                      key={command.id}
                      ref={(node) => { itemRefs.current[index] = node; }}
                      className={cn("palette-row", selected === index && "is-selected")}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => execute(command)}
                    >
                      <span className="palette-icon"><Icon size={14} /></span>
                      <span><b>{command.label}</b><em>{command.hint}</em></span>
                      {selected === index ? <CornerDownLeft size={13} /> : <ChevronRight size={12} />}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
        <footer className="palette-foot">
          <span><Kbd><ArrowUp size={9} /></Kbd><Kbd><ArrowDown size={9} /></Kbd> 导航</span>
          <span><Kbd><CornerDownLeft size={9} /></Kbd> 执行</span>
          <span><Kbd>esc</Kbd> 关闭</span>
          <span className="palette-foot-brand"><Command size={10} /> Hermes commands</span>
        </footer>
      </section>
    </div>
  );
}
