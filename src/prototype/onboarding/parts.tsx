import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn } from "../../lib/ui";
import { HermesMark } from "../../components/Brand";
import { StatusDot } from "../../components/ui";
import {
  failures,
  getFailure,
  scenes,
  variants,
  type ActionId,
  type Scene,
  type SimConnection,
} from "./model";
import { useOnboarding } from "./OnboardingContext";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ob-kbd">{children}</kbd>;
}

export function ProtoTitlebar() {
  const { variant, scene } = useOnboarding();
  const current = variants.find((item) => item.id === variant);
  return (
    <header className="ob-titlebar">
      <span className="ob-traffic" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="ob-brand">
        <HermesMark size={15} />
        HERMES <em>DESKTOP</em>
      </span>
      <span className="ob-titlebar-scope">ONBOARDING PROTOTYPE · {variant}</span>
      <span className="ob-titlebar-route">FIRST RUN / CONNECTIONS / EMPTY</span>
      <div className="ob-titlebar-right">
        <span>{current?.name}</span>
        <span className="ob-sim-badge">SIMULATED · {scene}</span>
      </div>
    </header>
  );
}

export function ScenarioBar() {
  const {
    variant,
    scene,
    failure,
    connections,
    primaryId,
    launchMode,
    testsRun,
    registryWrites,
    draft,
    setScene,
    setFailure,
  } = useOnboarding();
  const [stateOpen, setStateOpen] = useState(false);
  const active = variants.find((item) => item.id === variant);
  const state = {
    variant,
    scene,
    error: failure,
    primary: primaryId,
    launchMode,
    connections: connections.map((connection) => ({
      id: connection.id,
      status: connection.status,
      registry: connection.issue ?? "ok",
    })),
    testsRun,
    registryWrites,
    draftChars: draft.length,
    network: "none",
  };
  return (
    <div className="ob-scenario-bar">
      <div className="ob-scenario-title">
        <SlidersHorizontal size={13} />
        <span>SCENARIO DESK</span>
      </div>
      <label className="ob-select-label">
        <span>SCENE</span>
        <span className="ob-select-wrap">
          <select
            aria-label="模拟场景"
            data-testid="scene-select"
            value={scene}
            onChange={(event) => setScene(event.target.value as Scene)}
          >
            {scenes.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <ChevronDown size={11} />
        </span>
      </label>
      <label className="ob-select-label ob-error-select">
        <span>FAILURE</span>
        <span className="ob-select-wrap">
          <select
            aria-label="模拟错误"
            data-testid="error-select"
            value={failure}
            onChange={(event) => setFailure(event.target.value as typeof failure)}
          >
            {failures.map((item) => (
              <option value={item.code} key={item.code}>
                {item.label}
              </option>
            ))}
          </select>
          <ChevronDown size={11} />
        </span>
      </label>
      <div className="ob-scenario-summary" aria-live="polite">
        <span className="ob-scenario-variant">{active?.short}</span>
        <span className="ob-scenario-divider" />
        <span>{getFailure(failure).headline}</span>
      </div>
      <button
        type="button"
        className={cn("ob-state-toggle", stateOpen && "is-open")}
        onClick={() => setStateOpen((open) => !open)}
        aria-expanded={stateOpen}
        data-testid="state-toggle"
      >
        STATE
      </button>
      <div className="ob-key-hint">
        <Kbd>←</Kbd>
        <Kbd>→</Kbd>
        <span>switch</span>
      </div>
      {stateOpen && (
        <div className="ob-state-popover" role="region" aria-label="当前原型状态">
          <div className="ob-state-popover-head">
            <span>VISIBLE STATE</span>
            <button type="button" onClick={() => setStateOpen(false)} aria-label="关闭状态面板">
              <X size={12} />
            </button>
          </div>
          <pre>{JSON.stringify(state, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export function VariantSwitcher() {
  const { variant, scene, setVariant } = useOnboarding();
  const current = variants.find((item) => item.id === variant) ?? variants[0];
  const index = variants.findIndex((item) => item.id === variant);
  const move = (direction: -1 | 1) => {
    const next = variants[(index + direction + variants.length) % variants.length];
    setVariant(next.id);
  };
  return (
    <div className="ob-switcher" role="group" aria-label="原型变体切换">
      <button
        type="button"
        onClick={() => move(-1)}
        aria-label="上一个变体"
        data-testid="variant-prev"
      >
        <ChevronLeft size={15} />
      </button>
      <div className="ob-switcher-copy">
        <span>
          <b>{current.id}</b> · {current.name}
        </span>
        <em>{scene} · prototype only</em>
      </div>
      <button
        type="button"
        onClick={() => move(1)}
        aria-label="下一个变体"
        data-testid="variant-next"
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

export function RepairResultSheet() {
  const { repairResult, closeRepairResult, finishOAuth, oauthStatus } = useOnboarding();
  if (!repairResult) return null;
  return (
    <aside
      className={cn("ob-repair-sheet", `tone-${repairResult.tone}`)}
      role="dialog"
      aria-label="原型动作结果"
    >
      <header>
        <span>PROTOTYPE RESPONSE</span>
        <button type="button" onClick={closeRepairResult} aria-label="关闭动作结果">
          <X size={14} />
        </button>
      </header>
      <h3>{repairResult.title}</h3>
      <p>{repairResult.body}</p>
      <dl>
        {repairResult.lines.map((line) => (
          <div key={line}>
            <dt>FACT</dt>
            <dd>{line}</dd>
          </div>
        ))}
      </dl>
      {repairResult.action === "reauthorize" && oauthStatus === "waiting" && (
        <button type="button" className="ob-button is-primary ob-wide-button" onClick={finishOAuth}>
          模拟完成授权
        </button>
      )}
      <footer>No network, filesystem or credential operation was performed.</footer>
    </aside>
  );
}

export function PrototypeToast() {
  const { toast, dismissToast } = useOnboarding();
  if (!toast) return null;
  return (
    <div className="ob-toast" role="status">
      <StatusDot tone="accent" />
      <span>{toast}</span>
      <button type="button" onClick={dismissToast} aria-label="关闭提示">
        <X size={11} />
      </button>
    </div>
  );
}

export function KindBadge({ kind }: { kind: SimConnection["kind"] }) {
  return <span className={cn("ob-kind", `kind-${kind}`)}>{kind === "local" ? "LOCAL" : kind === "ssh" ? "SSH" : "REMOTE"}</span>;
}

export function StatusBadge({ status }: { status: SimConnection["status"] }) {
  const labels: Record<SimConnection["status"], string> = {
    ready: "在线",
    degraded: "降级",
    blocked: "blocked",
    invalid: "registry_invalid",
  };
  const tone = status === "ready" ? "ok" : status === "degraded" ? "warn" : "error";
  return (
    <span className={cn("ob-status", `is-${status}`)}>
      <StatusDot tone={tone} />
      {labels[status]}
    </span>
  );
}

export function PrimaryTag({ lastUsed = false }: { lastUsed?: boolean }) {
  return (
    <span className={cn("ob-mini-tag", lastUsed ? "is-last" : "is-primary")}>
      {lastUsed ? "LAST-USED" : "PRIMARY"}
    </span>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ob-section-label">
      <span>{children}</span>
      <span className="ob-section-rule" />
      {action}
    </div>
  );
}

export function ActionRail({
  actions,
  className,
  compact = false,
}: {
  actions: ActionId[];
  className?: string;
  compact?: boolean;
}) {
  const { runAction } = useOnboarding();
  if (!actions.length) return null;
  return (
    <div className={cn("ob-action-rail", compact && "is-compact", className)}>
      {actions.map((action, index) => (
        <button
          type="button"
          key={action}
          className={cn("ob-action-button", index === 0 && "is-strong")}
          onClick={() => runAction(action)}
          data-action={action}
        >
          {labelForAction(action)}
          <ArrowRight size={11} />
        </button>
      ))}
    </div>
  );
}

function labelForAction(action: ActionId): string {
  const labels: Record<ActionId, string> = {
    choose_cli: "选择 Hermes CLI",
    open_install_docs: "安装文档",
    open_update_docs: "更新文档",
    retry: "Retry",
    restart_gateway: "受控重启一次",
    open_status: "Gateway status",
    open_diagnostics: "脱敏诊断",
    switch_remote: "改连 Remote",
    switch_ssh: "改连 SSH",
    resolve_conflict: "解决冲突",
    keep_canonical: "保留 canonical",
    export_safe_summary: "导出脱敏摘要",
    repair_registry: "备份并修复",
    reauthorize: "重新授权",
    edit_target: "修改目标",
    edit_label: "改设备名",
    legacy_attach: "Legacy attach-only",
  };
  return labels[action];
}

export function FailureFacts({ className }: { className?: string }) {
  const { failureMeta } = useOnboarding();
  return (
    <dl className={cn("ob-failure-facts", className)}>
      {failureMeta.safeFacts.map((fact) => {
        const [label, ...rest] = fact.split(":");
        return (
          <div key={fact}>
            <dt>{label}</dt>
            <dd>{rest.join(":").trim() || "yes"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function FailureCallout({
  compact = false,
  actions = true,
}: {
  compact?: boolean;
  actions?: boolean;
}) {
  const { failureMeta, localRecovered, registryRepaired } = useOnboarding();
  if (failureMeta.code === "none") return null;
  const recovered =
    (failureMeta.family === "local" && localRecovered) ||
    (failureMeta.code === "registry_corrupt" && registryRepaired);
  return (
    <section className={cn("ob-failure-callout", compact && "is-compact", recovered && "is-recovered")}>
      <div className="ob-failure-mark" aria-hidden="true">
        {recovered ? <StatusDot tone="ok" /> : <CircleSlash2 size={14} />}
      </div>
      <div className="ob-failure-copy">
        <div className="ob-failure-code">
          {recovered ? "RECOVERED (SIMULATED)" : failureMeta.state.toUpperCase()}
          <span>{failureMeta.code}</span>
        </div>
        <h3>{recovered ? "修复路径已跑通（模拟）" : failureMeta.headline}</h3>
        <p>{recovered ? "状态已转为 ready；原型没有执行真实修复。" : failureMeta.detail}</p>
        {!compact && <FailureFacts />}
        {actions && !recovered && <ActionRail actions={failureMeta.actions} compact />}
      </div>
    </section>
  );
}

export function IssueBanner({
  tone = "warning",
  code,
  children,
  action,
}: {
  tone?: "warning" | "danger" | "success";
  code: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cn("ob-issue-banner", `tone-${tone}`)} role="status">
      <span className="ob-issue-code">{code}</span>
      <div>{children}</div>
      {action && <div className="ob-issue-action">{action}</div>}
    </div>
  );
}

export function ConnectionGlyph({ kind }: { kind: SimConnection["kind"] }) {
  return (
    <span className={cn("ob-connection-glyph", `kind-${kind}`)} aria-hidden="true">
      {kind === "local" ? "L" : kind === "ssh" ? "S" : "R"}
    </span>
  );
}

export function TinyArrow() {
  return <ArrowLeft size={10} className="ob-rotate" />;
}
