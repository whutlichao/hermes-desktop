import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Layers,
  Maximize2,
  Mic,
  Minus,
  PanelRight,
  Pin,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import type { Artifact, FileNode, Subagent, WorkspaceTab } from "../types";
import { useApp } from "../state/AppContext";
import {
  getActiveFiles,
  getActiveGateway,
  getActiveProfile,
  getArtifactPreview,
  getGitFile,
  workspaceBodyMounted,
} from "../state/store";
import { cn } from "../lib/ui";
import {
  Button,
  CopyButton,
  EmptyState,
  IconButton,
  Markdown,
  Segmented,
  StatusDot,
  Toggle,
} from "./ui";

const tabs: Array<{ id: WorkspaceTab; label: string; icon: typeof Layers }> = [
  { id: "artifacts", label: "Artifacts", icon: Layers },
  { id: "files", label: "Files", icon: Folder },
  { id: "git", label: "Git", icon: FolderGit2 },
  { id: "agents", label: "Agents", icon: Workflow },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "voice", label: "Voice", icon: Mic },
];

function ArtifactPreview({ artifact }: { artifact?: Artifact }) {
  const { state, dispatch } = useApp();
  const [comment, setComment] = useState("这里的来源需要再注明");
  const [focusedPin, setFocusedPin] = useState<string | null>(null);
  if (!artifact) {
    return <EmptyState icon={<Layers size={22} />} title="没有可预览的 artifact" body="工具生成 HTML、图片或 Markdown 后，会显示在此 scope 的 Artifacts 中。" />;
  }
  const preview = state.workspace.preview;
  const addPin = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!preview.annotate) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 10;
    const y = Math.round(((event.clientY - rect.top) / rect.height) * 1000) / 10;
    dispatch({ type: "ADD_ANNOTATION", x, y, comment: comment.trim() || "未命名 pin" });
    dispatch({
      type: "ADD_CONTEXT",
      chip: {
        id: `pin-${Date.now()}`,
        label: `pin @ ${artifact.name}`,
        kind: "artifact",
        detail: `${x}% × ${y}% · ${comment}`,
      },
    });
    setComment("");
  };
  return (
    <div className="artifact-preview-shell">
      <div className="artifact-toolbar">
        <div>
          <FileText size={12} />
          <b>{artifact.name}</b>
          <span>{artifact.kind.toUpperCase()} · {artifact.size}</span>
        </div>
        <div className="artifact-tools">
          <button
            type="button"
            className={cn("annotation-toggle", preview.annotate && "is-active")}
            onClick={() => dispatch({ type: "SET_ANNOTATE", value: !preview.annotate })}
            aria-pressed={preview.annotate}
          >
            <Pin size={11} /> Annotate
          </button>
          <IconButton label="在新窗口打开" onClick={() => dispatch({ type: "SET_TOAST", title: "Preview", message: "Open-in-window is disabled in this prototype; use the embedded preview." })}>
            <Maximize2 size={12} />
          </IconButton>
        </div>
      </div>
      {preview.annotate && (
        <div className="annotation-capture">
          <span className="pin-number">{preview.annotations.length + 1}</span>
          <input
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="给这个位置留一句注释…"
            aria-label="Annotation 注释"
          />
          <span>点击预览放置 pin · 自动附到 composer</span>
          {preview.annotations.length > 0 && (
            <button type="button" onClick={() => dispatch({ type: "CLEAR_ANNOTATIONS" })}>清除</button>
          )}
        </div>
      )}
      <div
        className={cn("artifact-stage", preview.annotate && "is-annotating")}
        onClick={addPin}
        role={preview.annotate ? "button" : undefined}
        tabIndex={preview.annotate ? 0 : undefined}
        aria-label={preview.annotate ? "点击放置 annotation pin" : undefined}
        onKeyDown={(event) => {
          if (!preview.annotate || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          dispatch({ type: "ADD_ANNOTATION", x: 50, y: 50, comment: comment || "中心位置" });
        }}
      >
        {artifact.kind === "html" && (
          <iframe title={`${artifact.name} 预览`} srcDoc={artifact.html} sandbox="" />
        )}
        {artifact.kind === "image" && artifact.image && <img src={artifact.image} alt={artifact.summary} />}
        {artifact.kind === "markdown" && <div className="markdown-preview"><Markdown content={artifact.markdown ?? ""} /></div>}
        {preview.annotations.map((pin, index) => (
          <button
            type="button"
            key={pin.id}
            className={cn("annotation-pin", focusedPin === pin.id && "is-focused")}
            style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
            onClick={(event) => { event.stopPropagation(); setFocusedPin(pin.id); }}
            aria-label={`Pin ${index + 1}: ${pin.comment}`}
          >
            {index + 1}
          </button>
        ))}
        {preview.annotate && <div className="annotate-mask" aria-hidden="true" />}
      </div>
      {focusedPin && (
        <div className="annotation-thread">
          <Pin size={11} />
          <span>{preview.annotations.find((pin) => pin.id === focusedPin)?.comment}</span>
          <button type="button" onClick={() => dispatch({ type: "SET_TOAST", title: "Pin attached", message: "这条 annotation 已在 composer 的上下文里。", tone: "success" })}>已附到 Composer</button>
        </div>
      )}
      <footer className="artifact-preview-foot">
        <span>{artifact.summary}</span>
        <span>{artifact.updatedAt}</span>
        <span className="sim-inline">Simulated preview</span>
      </footer>
    </div>
  );
}

function ArtifactsPane() {
  const { state, dispatch } = useApp();
  const artifacts = state.artifacts.filter(
    (artifact) =>
      artifact.gatewayId === state.activeGatewayId &&
      artifact.profileId === state.activeProfileId,
  );
  const selected = getArtifactPreview(state) ?? artifacts[0];
  return (
    <div className="workspace-pane artifacts-pane">
      <div className="artifact-strip" role="tablist" aria-label="Artifacts">
        {artifacts.map((artifact) => (
          <button
            type="button"
            key={artifact.id}
            role="tab"
            aria-selected={selected?.id === artifact.id}
            className={cn(selected?.id === artifact.id && "is-active")}
            onClick={() => dispatch({ type: "SET_PREVIEW_ARTIFACT", artifactId: artifact.id })}
          >
            {artifact.kind === "html" ? <FileCode2 size={12} /> : <FileText size={12} />}
            <span>{artifact.name}</span>
            <em>{artifact.size}</em>
          </button>
        ))}
      </div>
      {artifacts.length === 0 ? (
        <EmptyState icon={<Layers size={22} />} title="这个 scope 还没有 artifacts" body="当 Hermes 生成报告、图表或 HTML 预览时，它们会落在当前 Gateway / Profile。" />
      ) : (
        <ArtifactPreview artifact={selected} />
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selectedId: string;
  onSelect: (node: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const folder = node.kind === "folder";
  return (
    <div className="tree-node">
      <button
        type="button"
        className={cn("tree-row", selectedId === node.id && "is-active")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (folder) setOpen((value) => !value);
          else onSelect(node);
        }}
        aria-expanded={folder ? open : undefined}
      >
        {folder ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : <span className="tree-spacer" />}
        {folder ? <Folder size={12} /> : <File size={12} />}
        <span>{node.name}</span>
        {!folder && <em>{node.ext}</em>}
      </button>
      {folder && open && node.children?.map((child) => (
        <TreeNode key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FilesPane() {
  const { state, dispatch } = useApp();
  const [selected, setSelected] = useState<FileNode | null>(null);
  const files = getActiveFiles(state);
  const current = selected ?? getGitFile(state) ?? files[0]?.children?.[0] ?? files[0];
  return (
    <div className="workspace-pane files-pane">
      <div className="file-browser-head">
        <span><Folder size={12} /> {getActiveGateway(state).name} · host files</span>
        <span>read only</span>
      </div>
      <div className="file-browser">
        <div className="file-tree">
          {files.map((node) => (
            <TreeNode key={node.id} node={node} depth={0} selectedId={current?.id ?? ""} onSelect={setSelected} />
          ))}
        </div>
        <div className="file-preview">
          {current ? (
            <>
              <div className="file-preview-head">
                <div><FileText size={11} /><b>{current.name}</b></div>
                <CopyButton value={current.content ?? ""} compact />
              </div>
              <code className="file-path">{current.path}</code>
              <pre className="file-content">{current.content ?? "// Directory preview is not expanded in this prototype."}</pre>
              <div className="file-preview-actions">
                <Button variant="quiet" onClick={() => dispatch({ type: "ADD_CONTEXT", chip: { id: `ctx-file-${Date.now()}`, label: current.path, kind: current.kind, detail: current.path } })}>
                  <Pin size={11} /> 作为 @ 引用
                </Button>
                <span>Host-scoped</span>
              </div>
            </>
          ) : (
            <EmptyState icon={<Folder size={20} />} title="空目录" body="此 Gateway 没有可读取的文件。" />
          )}
        </div>
      </div>
    </div>
  );
}

const diffRows = [
  { kind: "meta", text: "@@ -18,7 +18,9 @@ export function GatewayRegistry()" },
  { kind: "ctx", text: "  const [editing, setEditing] = useState<Gateway | null>(null);" },
  { kind: "del", text: "- const gateways = useLiveGateways();" },
  { kind: "add", text: "+ const gateways = useGatewayRegistry();" },
  { kind: "add", text: "+ const active = useActiveScope();" },
  { kind: "ctx", text: "  return (" },
  { kind: "ctx", text: "    <RegistryList rows={gateways} />" },
  { kind: "add", text: "+   <ExecutionContext value={active} />" },
  { kind: "ctx", text: "  );" },
];

function GitPane() {
  const { state, dispatch } = useApp();
  const files = [
    { name: "src/components/GatewayRegistry.tsx", add: 42, del: 8 },
    { name: "src/state/scope.ts", add: 18, del: 3 },
    { name: "src/components/Routes.tsx", add: 11, del: 6 },
    { name: "README.md", add: 4, del: 1 },
  ];
  const [selectedFile, setSelectedFile] = useState(files[0].name);
  return (
    <div className="workspace-pane git-pane">
      <div className="git-branch-bar">
        <div><GitBranch size={12} /><b>hermes-desktop-prototype</b><span>→ main</span></div>
        <span className="clean-indicator"><StatusDot tone="warn" /> 4 changed</span>
      </div>
      <div className="git-toolbar">
        <Segmented
          value={state.workspace.git.scope}
          options={[
            { value: "uncommitted", label: "Uncommitted" },
            { value: "branch", label: "Branch" },
            { value: "last-turn", label: "Last turn" },
          ]}
          onChange={(scope) => dispatch({ type: "SET_GIT_SCOPE", scope })}
          label="Diff 范围"
        />
        <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "Diff refreshed", message: "4 changed files · working tree（模拟）。" })}><RefreshCw size={11} /> 刷新</Button>
      </div>
      <div className="git-content">
        <div className="diff-files">
          <div className="diff-files-head"><span>CHANGED FILES</span><span>±</span></div>
          {files.map((file) => (
            <button type="button" key={file.name} className={cn(selectedFile === file.name && "is-active")} onClick={() => setSelectedFile(file.name)}>
              <FileCode2 size={11} />
              <span>{file.name}</span>
              <em><i>+{file.add}</i><b>−{file.del}</b></em>
            </button>
          ))}
        </div>
        <div className="diff-view">
          <div className="diff-head"><span>{selectedFile}</span><CopyButton value={diffRows.map((row) => row.text).join("\n")} compact /></div>
          <div className="diff-code">
            {diffRows.map((row, index) => (
              <div className={cn("diff-line", `is-${row.kind}`)} key={`${row.text}-${index}`}>
                <span>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : row.kind === "meta" ? "@" : " "}</span>
                <code>{row.text}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="worktree-card">
        <div className="worktree-head">
          <span className="worktree-mark"><FolderGit2 size={13} /></span>
          <div><b>Isolated worktree</b><span>scratch/hermes-desktop-prototype · clean at a91f02c</span></div>
          <span className="worktree-status"><StatusDot tone="ok" /> READY</span>
        </div>
        <div className="worktree-actions">
          <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "New worktree", message: "从当前 HEAD 创建隔离 worktree（模拟）。" })}><Plus size={11} /> New worktree</Button>
          <Button variant="quiet" onClick={() => dispatch({ type: "SET_TOAST", title: "Commit preview", message: "提交只会在原型状态中演练，不触碰真实 Git。" })}><GitCommitHorizontal size={11} /> Commit</Button>
          <Button variant="secondary" onClick={() => dispatch({ type: "SET_TOAST", title: "PR preview", message: "PR body 与 branch 已准备；原型不会推送（模拟）。" })}><GitPullRequest size={11} /> Open PR</Button>
        </div>
      </div>
    </div>
  );
}

function SubagentRow({ agent, active, onClick }: { agent: Subagent; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cn("subagent-row", active && "is-active")} onClick={onClick}>
      <span className={cn("subagent-mark", agent.status)}><Workflow size={12} /></span>
      <span className="subagent-copy">
        <b>{agent.name}</b>
        <em>{agent.task}</em>
        <span>{agent.activity}</span>
      </span>
      <span className="subagent-meta">
        <i>{agent.elapsed}</i>
        <StatusDot tone={agent.status === "running" ? "warn" : agent.status === "done" ? "ok" : "idle"} />
      </span>
    </button>
  );
}

function AgentsPane() {
  const { state, dispatch } = useApp();
  const agents = state.subagents.filter(
    (agent) => agent.gatewayId === state.activeGatewayId && agent.profileId === state.activeProfileId,
  );
  const selectedId = state.workspace.agents.selectedId ?? agents[0]?.id;
  const selected = agents.find((agent) => agent.id === selectedId);
  return (
    <div className="workspace-pane agents-pane">
      <div className="agents-head">
        <h3>Live subagents</h3>
        <span>{agents.filter((agent) => agent.status === "running").length} running</span>
      </div>
      {agents.length === 0 ? (
        <EmptyState icon={<Workflow size={22} />} title="这个 scope 没有 subagent" body="Hermes 委派任务后，子代理会带着独立上下文出现在这里。" />
      ) : (
        <>
          <div className="subagent-list">
            {agents.map((agent) => (
              <SubagentRow key={agent.id} agent={agent} active={agent.id === selectedId} onClick={() => dispatch({ type: "SET_SUBAGENT_SELECTED", id: agent.id })} />
            ))}
          </div>
          {selected && (
            <div className="subagent-inspector">
              <div className="inspector-head">
                <div><span className={cn("presence-dot", selected.status)} /> <b>{selected.name}</b><span>{selected.model}</span></div>
                <span>{selected.elapsed}</span>
              </div>
              <p className="inspector-task">{selected.task}</p>
              <div className="transcript-mini">
                {selected.transcript.map((line, index) => (
                  <div key={`${line}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{line}</p></div>
                ))}
              </div>
              <div className="steer-box">
                <textarea
                  value={state.workspace.agents.steer}
                  onChange={(event) => dispatch({ type: "SET_SUBAGENT_STEER", value: event.target.value })}
                  placeholder="在主线程里给这个子代理补充方向…"
                  aria-label="Steer subagent"
                />
                <div>
                  <Button
                    variant="secondary"
                    disabled={!state.workspace.agents.steer.trim() || selected.status !== "running"}
                    onClick={() => dispatch({ type: "STEER_SUBAGENT", id: selected.id, message: state.workspace.agents.steer })}
                  >
                    发送 steer
                  </Button>
                  <Button variant="quiet" disabled={selected.status !== "running"} onClick={() => dispatch({ type: "STOP_SUBAGENT", id: selected.id })}>
                    <Square size={10} /> 停止
                  </Button>
                  <span>Steering 在下一个检查点生效</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TerminalPane() {
  const { state, dispatch } = useApp();
  const gateway = getActiveGateway(state);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const prompt = gateway.kind === "ssh" ? `${gateway.name.toLowerCase()}:~/hermes-web $` : "this-device:~ $";
  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [state.workspace.terminal.lines.length]);

  const run = () => {
    const command = state.workspace.terminal.command.trim();
    if (!command) return;
    historyRef.current = [command, ...historyRef.current.filter((item) => item !== command)];
    setHistoryIndex(-1);
    dispatch({ type: "TERMINAL_RUN", command });
  };
  return (
    <div className="workspace-pane terminal-pane">
      <div className="terminal-head">
        <div>
          <Terminal size={12} />
          <b>{gateway.kind === "ssh" ? gateway.name : "This device"}</b>
          <span>{gateway.kind === "ssh" ? "SSH · managed tunnel" : "Local shell fallback"}</span>
        </div>
        <span className="terminal-sim">SIMULATED</span>
        <IconButton label="清屏" onClick={() => dispatch({ type: "TERMINAL_RUN", command: "clear" })}><RotateCcw size={11} /></IconButton>
      </div>
      <div className="terminal-screen" ref={terminalRef} onClick={() => inputRef.current?.focus()}>
        <div className="terminal-lines" aria-live="polite">
          {state.workspace.terminal.lines.map((line, index) => (
            <div key={`${line}-${index}`} className={cn(line.startsWith("zsh:") && "is-error", line.match(/^[a-z-]+:~\$/) && "is-command", line.includes("simulated") && "is-muted")}>
              {line}
            </div>
          ))}
        </div>
        <div className="terminal-input-line">
          <span>{prompt}</span>
          <input
            ref={inputRef}
            value={state.workspace.terminal.command}
            onChange={(event) => dispatch({ type: "SET_TERMINAL_COMMAND", value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                run();
              } else if (event.key === "ArrowUp" && historyRef.current.length) {
                event.preventDefault();
                const next = Math.min(historyRef.current.length - 1, historyIndex + 1);
                setHistoryIndex(next);
                dispatch({ type: "SET_TERMINAL_COMMAND", value: historyRef.current[next] });
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                const next = historyIndex - 1;
                setHistoryIndex(next);
                dispatch({ type: "SET_TERMINAL_COMMAND", value: next >= 0 ? historyRef.current[next] : "" });
              }
            }}
            aria-label="终端命令"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="terminal-caret" />
        </div>
      </div>
      <div className="terminal-foot">
        <span><StatusDot tone="ok" /> {state.workspace.terminal.gatewayId === gateway.id ? "scope preserved" : "fallback shell"}</span>
        <span>Scrollback kept on Hide</span>
        <button type="button" onClick={() => dispatch({ type: "SET_TOAST", title: "Terminal session copied", message: "模拟 scrollback 已复制到剪贴板。" })}><Copy size={10} /> Copy session</button>
      </div>
    </div>
  );
}

function VoicePane() {
  const { state, dispatch } = useApp();
  const [listening, setListening] = useState(false);
  const [wake, setWake] = useState(true);
  const [tts, setTts] = useState(true);
  const [transcript, setTranscript] = useState("");
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);
  return (
    <div className="workspace-pane voice-pane">
      <div className="voice-head">
        <div className="micro-label">Voice mode</div>
        <div className="voice-mode-status"><span className={cn("voice-live-dot", listening && "is-listening")} />{listening ? "Listening" : wake ? "Hey Hermes · armed" : "Standby"}</div>
      </div>
      <div className={cn("voice-stage", listening && "is-listening")}>
        <div className="voice-orbit" aria-hidden="true">
          <div className="voice-orbit-inner" />
        </div>
        <div className="voice-wave" aria-hidden="true">
          {[18, 31, 42, 26, 56, 36, 64, 48, 28, 44, 22, 38, 16, 30, 12].map((height, index) => (
            <i key={index} style={{ height, animationDelay: `${index * 34}ms` }} />
          ))}
        </div>
        <h3>{listening ? "正在听…" : "按住说话"}</h3>
        <p>{listening ? `音频将进入 ${gateway.name.toUpperCase()} · ${profile.handle}` : "Push-to-talk 或说 “Hey Hermes”"}</p>
        <button
          type="button"
          className={cn("push-to-talk", listening && "is-listening")}
          onPointerDown={() => {
            setListening(true);
            setTranscript("检查 Homelab 的 MCP 状态，不要重启 gateway");
          }}
          onPointerUp={() => setListening(false)}
          onPointerLeave={() => setListening(false)}
          onKeyDown={(event) => {
            if (event.key === " " && !event.repeat) {
              event.preventDefault();
              setListening(true);
              setTranscript("检查 Homelab 的 MCP 状态，不要重启 gateway");
            }
          }}
          onKeyUp={(event) => {
            if (event.key === " ") setListening(false);
          }}
        >
          {listening ? <Square size={13} fill="currentColor" /> : <Mic size={15} />}
        </button>
      </div>
      <div className="voice-transcript">
        <span className="micro-label">Transcript · simulated</span>
        <p>{transcript || "松开后，识别结果会先进入 composer，再由你确认发送。"}</p>
        {transcript && (
          <Button
            variant="secondary"
            onClick={() => {
              dispatch({ type: "SET_CHAT_DRAFT", value: transcript });
              dispatch({ type: "SET_TOAST", title: "Transcript moved to composer", message: "尚未发送；请确认后提交。", tone: "success" });
            }}
          >
            放入 Composer <ArrowRight size={11} />
          </Button>
        )}
      </div>
      <div className="voice-options">
        <div className="setting-line"><div><b>Hey Hermes</b><span>本地 wake word · 原型不请求麦克风</span></div><Toggle checked={wake} onChange={setWake} label="Hey Hermes" /></div>
        <div className="setting-line"><div><b>语音回复</b><span>Warm neutral · 可被 Space 打断</span></div><Toggle checked={tts} onChange={setTts} label="语音回复" /></div>
      </div>
      <div className="cap-footnote"><Radio size={12} /> Voice 是可视化模拟，不会打开麦克风或上传音频。</div>
    </div>
  );
}

export function WorkspaceRail() {
  const { state, dispatch } = useApp();
  const ref = useRef<HTMLElement>(null);
  const mounted = workspaceBodyMounted(state);
  const hidden = state.workspace.mode === "hidden";
  const gateway = getActiveGateway(state);
  const profile = getActiveProfile(state);

  useEffect(() => {
    if (ref.current) {
      (ref.current as HTMLElement & { inert: boolean }).inert = hidden;
    }
  }, [hidden]);

  if (!mounted) return null;

  return (
    <aside ref={ref} className={cn("workspace-rail", hidden && "is-hidden")} aria-hidden={hidden} aria-label="Workspace">
      <header className="workspace-head">
        <div>
          <div className="workspace-title"><PanelRight size={13} /><b>Workspace</b><span>{gateway.name} · {profile.handle}</span></div>
          <div className="workspace-subtitle"><StatusDot tone="ok" /> scoped to active execution context <span className="sim-inline">SIM</span></div>
        </div>
        <div className="workspace-head-actions">
          <button type="button" onClick={() => dispatch({ type: "WORKSPACE_MODE", mode: "hidden" })} title="Hide · 保留状态">
            <Minus size={13} /><span>Hide</span>
          </button>
          <IconButton label="Close · 释放工作区状态" onClick={() => dispatch({ type: "WORKSPACE_MODE", mode: "closed" })}>
            <X size={14} />
          </IconButton>
        </div>
      </header>
      <nav className="workspace-tabs" role="tablist" aria-label="Workspace sections">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            role="tab"
            aria-selected={state.workspace.tab === tab.id}
            className={cn(state.workspace.tab === tab.id && "is-active")}
            onClick={() => dispatch({ type: "SET_WORKSPACE_TAB", tab: tab.id })}
          >
            <tab.icon size={12} />
            <span>{tab.label}</span>
            {tab.id === "agents" && <em>{state.subagents.filter((agent) => agent.status === "running" && agent.gatewayId === state.activeGatewayId).length || ""}</em>}
          </button>
        ))}
      </nav>
      <div className="workspace-body" role="tabpanel">
        {state.workspace.tab === "artifacts" && <ArtifactsPane />}
        {state.workspace.tab === "files" && <FilesPane />}
        {state.workspace.tab === "git" && <GitPane />}
        {state.workspace.tab === "agents" && <AgentsPane />}
        {state.workspace.tab === "terminal" && <TerminalPane />}
        {state.workspace.tab === "voice" && <VoicePane />}
      </div>
    </aside>
  );
}
