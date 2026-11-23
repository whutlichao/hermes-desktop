import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Info,
  KeyRound,
  Laptop,
  Link2,
  Plus,
  RefreshCw,
  Server,
  Star,
  Terminal,
  X,
} from "lucide-react";
import { cn } from "../../lib/ui";
import { Button, Field, StatusDot } from "../../components/ui";
import { useOnboarding } from "./OnboardingContext";
import {
  ActionRail,
  ConnectionGlyph,
  FailureCallout,
  FailureFacts,
  IssueBanner,
  KindBadge,
  ProtoTitlebar,
  ScenarioBar,
  SectionLabel,
  StatusBadge,
  VariantSwitcher,
} from "./parts";

function CCommandBar({ onFleetToggle }: { onFleetToggle: () => void }) {
  const { scene, setScene, connections } = useOnboarding();
  const group =
    scene.startsWith("empty") || scene === "scope-banner"
      ? "empty"
      : scene === "startup"
        ? "startup"
        : scene === "conflicts"
          ? "registry"
          : scene === "add-remote" || scene === "add-ssh"
            ? "connect"
            : "onboard";
  return (
    <div className="ob-c-commandbar">
      <button type="button" className="ob-c-fleet-trigger" onClick={onFleetToggle}>
        <span>FLEET</span>
        <b>{connections.length}</b>
        <ChevronDown size={11} />
      </button>
      <nav className="ob-c-nav" aria-label="Onboarding 工作台">
        <button
          type="button"
          className={cn(group === "onboard" && "is-active")}
          onClick={() => setScene("first-run")}
        >
          Onboarding
        </button>
        <button
          type="button"
          className={cn(group === "connect" && "is-active")}
          onClick={() => setScene("add-remote")}
        >
          Connections
        </button>
        <button
          type="button"
          className={cn(group === "registry" && "is-active")}
          onClick={() => setScene("conflicts")}
        >
          Registry
        </button>
        <button
          type="button"
          className={cn(group === "startup" && "is-active")}
          onClick={() => setScene("startup")}
        >
          Startup
        </button>
        <button
          type="button"
          className={cn(group === "empty" && "is-active")}
          onClick={() => setScene("empty-normal")}
        >
          Empty
        </button>
      </nav>
      <div className="ob-c-command-actions">
        <button type="button" onClick={() => setScene("add-ssh")}>
          <Terminal size={12} />
          SSH
        </button>
        <button type="button" className="is-strong" onClick={() => setScene("add-remote")}>
          <Plus size={12} />
          Connect
        </button>
      </div>
    </div>
  );
}

function CLedger({ compact = false }: { compact?: boolean }) {
  const {
    connections,
    setPrimary,
    launchMode,
    setLaunchMode,
    setScene,
    failureMeta,
  } = useOnboarding();
  const ready = connections.filter((connection) => connection.status === "ready").length;
  const blocked = connections.filter((connection) => connection.status === "blocked" || connection.status === "invalid").length;
  return (
    <aside className={cn("ob-c-ledger", compact && "is-popover")} aria-label="Fleet ledger">
      <div className="ob-c-ledger-head">
        <div>
          <span className="ob-eyebrow">FLEET LEDGER</span>
          <h2>Connections</h2>
        </div>
        <button type="button" className="ob-circle-button" onClick={() => setScene("add-remote")} aria-label="添加连接">
          <Plus size={13} />
        </button>
      </div>
      <div className="ob-c-stat-row">
        <div><span>READY</span><b>{ready}</b></div>
        <div><span>BLOCKED</span><b>{blocked}</b></div>
        <div><span>WRITES</span><b>0</b></div>
      </div>
      <div className="ob-c-table">
        <div className="ob-c-table-head">
          <span>DEVICE</span>
          <span>KIND</span>
          <span>STATE</span>
          <span>PRIMARY</span>
        </div>
        {connections.map((connection) => (
          <div
            className={cn(
              "ob-c-table-row",
              connection.status === "invalid" && "is-invalid",
              connection.primary && "is-primary",
            )}
            key={connection.id}
          >
            <div className="ob-c-device">
              <ConnectionGlyph kind={connection.kind} />
              <span><b>{connection.label}</b><em>{connection.host}</em></span>
            </div>
            <KindBadge kind={connection.kind} />
            <StatusBadge status={connection.status} />
            <button
              type="button"
              className="ob-c-primary-cell"
              onClick={() => setPrimary(connection.id)}
              aria-label={`将 ${connection.label} 设为 Primary`}
            >
              <Star size={12} fill={connection.primary ? "currentColor" : "none"} />
              <span>{connection.primary ? "yes" : "set"}</span>
            </button>
          </div>
        ))}
      </div>
      <div className="ob-c-ledger-profiles">
        <SectionLabel>PROFILES · SELECTED SCOPE</SectionLabel>
        {(connections.find((connection) => connection.primary)?.profiles ?? []).map((profile) => (
          <div className="ob-c-profile-line" key={profile.id}>
            <span><b>{profile.handle}</b><em>{profile.id}</em></span>
            <span className={cn("ob-readiness", `is-${profile.readiness}`)}>{profile.readiness}</span>
          </div>
        ))}
      </div>
      <div className="ob-c-ledger-foot">
        <SectionLabel>LAUNCH</SectionLabel>
        <div className="ob-segmented ob-segmented-wide" role="group" aria-label="启动连接策略">
          <button
            type="button"
            className={cn(launchMode === "primary" && "is-active")}
            onClick={() => setLaunchMode("primary")}
          >
            Primary
          </button>
          <button
            type="button"
            className={cn(launchMode === "last-used" && "is-active")}
            onClick={() => setLaunchMode("last-used")}
          >
            Last used
          </button>
        </div>
        <p>
          <StatusDot tone={failureMeta.family === "local" && failureMeta.code !== "none" ? "error" : "ok"} />
          {failureMeta.family === "local" && failureMeta.code !== "none" ? failureMeta.code : "registry stable"}
        </p>
      </div>
    </aside>
  );
}

function CLedgerPopover({ onClose }: { onClose: () => void }) {
  return (
    <div className="ob-c-ledger-popover" role="dialog" aria-label="Fleet ledger">
      <div className="ob-c-ledger-popover-head">
        <span>1280 · FLEET POPOVER</span>
        <button type="button" onClick={onClose} aria-label="关闭连接列表"><X size={13} /></button>
      </div>
      <CLedger compact />
    </div>
  );
}

function CPageHead({
  kicker,
  title,
  body,
  actions,
}: {
  kicker: string;
  title: string;
  body: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ob-c-page-head">
      <div>
        <span className="ob-eyebrow">{kicker}</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {actions && <div className="ob-c-page-actions">{actions}</div>}
    </div>
  );
}

function CFirstRun() {
  const {
    failureMeta,
    connections,
    setScene,
    runAction,
  } = useOnboarding();
  const local = connections.find((connection) => connection.id === "local");
  const localFailure = failureMeta.family === "local" && failureMeta.code !== "none";
  return (
    <div className="ob-c-page">
      <CPageHead
        kicker="FIRST RUN · OPERATOR BENCH"
        title="把起点接到桌面。"
        body="左侧是完整 fleet 事实；右侧只显示当前需要做的一个决定。每次 Test、Save 与修复都留下可见边界。"
        actions={
          <Button variant="secondary" onClick={() => setScene("add-remote")}>
            添加 Remote
            <ArrowRight size={11} />
          </Button>
        }
      />
      <div className="ob-c-onboard-grid">
        <section className="ob-c-boot-card">
          <div className="ob-c-boot-head">
            <div>
              <span className="ob-eyebrow">LOCAL · APP-MANAGED</span>
              <h2>This device</h2>
            </div>
            <StatusBadge status={local?.status ?? "blocked"} />
          </div>
          <div className={cn("ob-c-boot-state", localFailure && "is-blocked")}>
            <span>{localFailure ? <X size={16} /> : <Check size={16} />}</span>
            <div>
              <b>{localFailure ? "本地运行时未就绪" : "本地运行时已就绪"}</b>
              {!localFailure && (
                <p>ensure 成功，host-scope ticket 可用；没有打包或安装 Python runtime。</p>
              )}
            </div>
          </div>
          {localFailure ? (
            <FailureCallout compact />
          ) : (
            <div className="ob-c-ready-facts">
              <div><span>transport</span><b>HTTP + WS</b></div>
              <div><span>ticket</span><b>Main only</b></div>
              <div><span>service</span><b>attach only</b></div>
            </div>
          )}
          <footer>
            <Button variant="quiet" onClick={() => setScene("local-recovery")}>
              查看 attach / ensure 详情
              <ArrowRight size={11} />
            </Button>
            {localFailure && (
              <Button variant="primary" onClick={() => runAction(failureMeta.actions[0] ?? "choose_cli")}>
                开始修复
              </Button>
            )}
          </footer>
        </section>
        <section className="ob-c-lane-card">
          <span className="ob-eyebrow">OR START ELSEWHERE</span>
          <button type="button" onClick={() => setScene("add-remote")}>
            <span className="ob-c-lane-icon"><Link2 size={16} /></span>
            <span><b>Remote HTTP(S)</b><em>Token 或 native OAuth</em></span>
            <ChevronDown size={12} className="ob-rotate-minus-90" />
          </button>
          <button type="button" onClick={() => setScene("add-ssh")}>
            <span className="ob-c-lane-icon"><Terminal size={16} /></span>
            <span><b>SSH host</b><em>tickets --serve / legacy</em></span>
            <ChevronDown size={12} className="ob-rotate-minus-90" />
          </button>
          <p>跳过 Local 不会被视为修复成功；只是让另一个连接先成为起点。</p>
        </section>
      </div>
      <div className="ob-c-notes-strip">
        <div><span>NO AUTO INSTALL</span><p>发现失败只给文档与显式 Retry。</p></div>
        <div><span>NO AUTO SESSION</span><p>首次运行不会偷偷创建第一个 Session。</p></div>
        <div><span>NO SECRET ECHO</span><p>已保存 token 永不回填表单。</p></div>
      </div>
    </div>
  );
}

function CLocalRecovery() {
  const { failure, failureMeta, localRecovered, restartAttempts, setScene } = useOnboarding();
  const localFailure = failureMeta.family === "local" && failure !== "none";
  const rows = [
    ["discover", "CLI 发现", "PATH / override / 常见目录", "hermes_not_found", "cli_not_executable"],
    ["ensure", "ensure", "60s deadline · 不并发起第二个 owner", "gateway_start_failed", ""],
    ["version", "版本恢复", "同一 stale owner 最多一次 graceful restart", "code_sha_mismatch", ""],
    ["control", "control socket", "权限与 peer 校验；不换 attach 绕过", "socket_permission_denied", "service_unhealthy"],
    ["dial", "Local dial", "ticket 30s / 单次 / Main only", "", ""],
  ];
  return (
    <div className="ob-c-page">
      <CPageHead
        kicker="LOCAL RECOVERY · TYPED FAILURES"
        title={localRecovered ? "恢复链已跑通。" : localFailure ? failureMeta.headline : "自动路径全绿。"}
        body="把恢复过程做成可读的表格，而不是无限 spinner。每一行都对应 #11 的安全动作边界。"
        actions={<Button variant="quiet" onClick={() => setScene("startup")}>Startup policy <ArrowRight size={11} /></Button>}
      />
      <div className="ob-c-recovery-grid">
        <section className="ob-c-recovery-table">
          <div className="ob-c-recovery-head">
            <span>PHASE</span>
            <span>FACT</span>
            <span>STATE</span>
          </div>
          {rows.map(([code, title, detail, errorA, errorB]) => {
            const failed =
              localFailure &&
              !localRecovered &&
              (failure === errorA || (errorB && failure === errorB));
            const done = !failed && (!localFailure || localRecovered || !errorA);
            return (
              <div className={cn("ob-c-recovery-row", failed && "is-blocked", done && "is-done")} key={code}>
                <span className="ob-c-phase">{code}</span>
                <div><b>{title}</b><p>{detail}</p></div>
                <span className="ob-c-recovery-state">{failed ? "blocked" : done ? "done" : "waiting"}</span>
              </div>
            );
          })}
        </section>
        <aside className="ob-c-recovery-docket">
          <span className="ob-eyebrow">FAILURE OBJECT</span>
          <FailureFacts />
          <div className="ob-c-recovery-restart">
            <span>RESTART ATTEMPTS</span>
            <b>{restartAttempts}/1</b>
            <p>只对同一 stale owner，且只由 code_sha 恢复或用户显式触发。</p>
          </div>
          {localFailure && !localRecovered ? (
            <FailureCallout compact />
          ) : (
            <div className="ob-c-clear-state"><Check size={14} /> no failing phase</div>
          )}
          <div className="ob-c-ticket-note">
            <KeyRound size={12} />
            <p>ticket、socket 路径、raw stderr 只在 Main；此面板仅有 safe code 与动作。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CAddTabs({
  kind,
  onChange,
}: {
  kind: "remote" | "ssh";
  onChange: (kind: "remote" | "ssh") => void;
}) {
  return (
    <div className="ob-c-add-tabs" role="tablist" aria-label="连接类型">
      <button
        type="button"
        role="tab"
        aria-selected={kind === "remote"}
        className={cn(kind === "remote" && "is-active")}
        onClick={() => onChange("remote")}
      >
        <Link2 size={13} />
        Remote HTTP(S)
        <span>token / OAuth</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={kind === "ssh"}
        className={cn(kind === "ssh" && "is-active")}
        onClick={() => onChange("ssh")}
      >
        <Terminal size={13} />
        SSH host
        <span>probe / test</span>
      </button>
    </div>
  );
}

function CTestInspector() {
  const { testStatus, testMessage, testsRun, registryWrites, formKind, oauthStatus, runTest } = useOnboarding();
  return (
    <aside className="ob-c-test-inspector">
      <div className="ob-c-test-inspector-head">
        <span className="ob-eyebrow">PROBE INSPECTOR</span>
        <span className={cn("ob-c-test-pill", `is-${testStatus}`)}>
          {testStatus === "idle" ? "not run" : testStatus}
        </span>
      </div>
      <p>{testMessage}</p>
      <dl>
        <div><dt>tests</dt><dd>{testsRun}</dd></div>
        <div><dt>registry writes</dt><dd>{registryWrites}</dd></div>
        <div><dt>oauth</dt><dd>{oauthStatus}</dd></div>
      </dl>
      <Button variant="secondary" onClick={() => runTest(formKind)} disabled={testStatus === "running"}>
        <RefreshCw size={11} className={cn(testStatus === "running" && "spin")} />
        Test again
      </Button>
      <div className="ob-c-inspector-note">
        <Info size={12} />
        <span>Test 是独立探测；保存连接才是 registry mutation。</span>
      </div>
    </aside>
  );
}

function CDuplicateNotice() {
  const { duplicateVisible, failure, connections, runAction } = useOnboarding();
  if (!duplicateVisible) return null;
  const existing = connections.find((connection) => connection.id === "vps1");
  return (
    <IssueBanner
      tone="warning"
      code={failure}
      action={
        <div className="ob-inline-actions">
          <button type="button" onClick={() => runAction("edit_label")}>rename</button>
          <button type="button" onClick={() => runAction("edit_target")}>retarget</button>
        </div>
      }
    >
      <b>当前输入与既有连接冲突。</b> 既有：{existing?.label} · {existing?.host} ·
      token {existing?.hasToken ? "saved/hidden" : "none"}。没有写 registry。
    </IssueBanner>
  );
}

function CRemoteForm() {
  const {
    form,
    formKind,
    setForm,
    setScene,
    testStatus,
    oauthStatus,
    startOAuth,
    finishOAuth,
    cancelOAuth,
    saveForm,
    savedForm,
    failure,
    connections,
  } = useOnboarding();
  if (formKind !== "remote") return null;
  const target = connections.find((connection) => connection.id === "vps1");
  return (
    <div className="ob-c-page">
      <CPageHead
        kicker="CONNECTIONS · REMOTE HTTP(S)"
        title="在 inspector 里新增一条远程线路。"
        body="字段、认证与测试共用同一张工作台；右侧 probe 只读，左侧 Save 才提交。"
        actions={
          <span className="ob-c-target-chip">
            <StatusDot tone="warn" /> {target?.label ?? "VPS-1"} · existing
          </span>
        }
      />
      <CAddTabs kind="remote" onChange={(kind) => setScene(kind === "remote" ? "add-remote" : "add-ssh")} />
      <div className="ob-c-connect-grid">
        <form
          className="ob-c-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveForm();
          }}
        >
          <div className="ob-c-form-head">
            <span className="ob-eyebrow">DRAFT CONNECTION</span>
            <span>revision base 12</span>
          </div>
          <div className="ob-c-form-grid">
            <Field label="Device name" hint="label 大小写不敏感唯一">
              <input
                value={form.label}
                onChange={(event) => setForm({ label: event.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Gateway URL" hint="remote 语义 URL 是身份键">
              <input
                value={form.target}
                onChange={(event) => setForm({ target: event.target.value })}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="ob-c-auth-block">
            <span className="ob-eyebrow">AUTH MODE</span>
            <div className="ob-c-auth-options">
              <button
                type="button"
                className={cn(form.authMode === "session-token" && "is-active")}
                onClick={() => setForm({ authMode: "session-token" })}
              >
                <KeyRound size={12} />
                <span>Session token</span>
                <em>submit once</em>
              </button>
              <button
                type="button"
                className={cn(form.authMode === "oauth" && "is-active")}
                onClick={() => setForm({ authMode: "oauth" })}
              >
                <CircleDot size={12} />
                <span>OAuth / PKCE</span>
                <em>native Main flow</em>
              </button>
            </div>
          </div>
          {form.authMode === "session-token" ? (
            <div className="ob-c-token-grid">
              <Field label="Session token" hint="已保存值不回填；原型不存储实际 token">
                <input
                  type="password"
                  value={form.token}
                  onChange={(event) => setForm({ token: event.target.value })}
                  placeholder="tok_••••••••"
                  autoComplete="new-password"
                />
              </Field>
              <div className="ob-c-token-state">
                <span>SAVED TOKEN</span>
                <b>{savedForm?.tokenStored ? "Main only" : "none"}</b>
                <p>Renderer 仅看到 hasToken 布尔值。</p>
              </div>
            </div>
          ) : oauthStatus === "waiting" ? (
            <div className="ob-c-oauth-wait">
              <span className="ob-wait-dot" />
              <div><b>等待 native callback</b><p>Renderer 不接收 token 或 callback URL。</p></div>
              <Button variant="secondary" onClick={finishOAuth}>complete</Button>
              <Button variant="quiet" onClick={cancelOAuth}>cancel</Button>
            </div>
          ) : oauthStatus === "granted" ? (
            <div className="ob-c-oauth-granted"><Check size={13} /> authorized · hasToken=true</div>
          ) : (
            <button type="button" className="ob-c-oauth-start" onClick={startOAuth}>
              Start native OAuth
              <ArrowRight size={12} />
            </button>
          )}
          <CDuplicateNotice />
          {savedForm && (
            <IssueBanner tone="success" code="saved">
              <b>{savedForm.label}</b> committed · {savedForm.authMode} · registry writes +1
            </IssueBanner>
          )}
          {failure === "token_sync_failed" && (
            <IssueBanner tone="warning" code="token_sync_failed">
              connection committed · token needs reauth · Renderer token absent
            </IssueBanner>
          )}
          <div className="ob-c-form-foot">
            <span>Test 不写 registry；Save 才更新 revision。</span>
            <div>
              <Button
                variant="primary"
                type="submit"
                disabled={oauthStatus === "waiting" || (!form.token && form.authMode === "session-token" && oauthStatus !== "granted")}
              >
                Commit connection
                <ArrowRight size={11} />
              </Button>
            </div>
          </div>
        </form>
        <CTestInspector />
      </div>
      {testStatus === "failed" && <FailureCallout compact />}
    </div>
  );
}

function CSshForm() {
  const {
    form,
    formKind,
    setForm,
    setScene,
    testStatus,
    saveForm,
    savedForm,
    failure,
    connections,
  } = useOnboarding();
  if (formKind !== "ssh") return null;
  const target = connections.find((connection) => connection.id === "homelab");
  return (
    <div className="ob-c-page">
      <CPageHead
        kicker="CONNECTIONS · SSH HOST"
        title="在 ledger 旁验证一条 SSH 线路。"
        body="Test 只做 probe；保存独立提交。host key、agent 与 known_hosts 仍由系统 ssh 处理。"
        actions={
          <span className="ob-c-target-chip">
            <StatusDot tone="ok" /> {target?.label ?? "Homelab"} · canonical
          </span>
        }
      />
      <CAddTabs kind="ssh" onChange={(kind) => setScene(kind === "remote" ? "add-remote" : "add-ssh")} />
      <div className="ob-c-connect-grid">
        <form
          className="ob-c-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveForm();
          }}
        >
          <div className="ob-c-form-head">
            <span className="ob-eyebrow">DRAFT CONNECTION</span>
            <span>identity · no keyPath</span>
          </div>
          <div className="ob-c-form-grid">
            <Field label="Device name" hint="唯一 label；冲突会拒绝写入">
              <input value={form.label} onChange={(event) => setForm({ label: event.target.value })} />
            </Field>
            <Field label="SSH target" hint="user@host:port">
              <input value={form.target} onChange={(event) => setForm({ target: event.target.value })} />
            </Field>
            <Field label="Remote Profile" hint="default Profile eager">
              <input
                value={form.remoteProfile}
                onChange={(event) => setForm({ remoteProfile: event.target.value })}
              />
            </Field>
            <Field label="Host identity" hint="known_hosts / system ssh">
              <input value="managed by macOS ssh" readOnly aria-readonly="true" />
            </Field>
          </div>
          <div className="ob-c-ssh-modes">
            <div className="is-preferred"><Terminal size={13} /><span><b>tickets --serve</b><em>共享 transport；每次重新 mint</em></span><span>default</span></div>
            <div className={cn(failure === "ssh_test_failed" && "is-blocked")}><Server size={13} /><span><b>legacy attach-only</b><em>per-Profile；可能 idle exit</em></span><span>fallback</span></div>
          </div>
          {failure === "ssh_test_failed" && (
            <IssueBanner tone="warning" code="ssh_test_failed">
              <b>Probe failed.</b> {form.target} 草稿保留 · registry writes 0 · 未确认 host key。
            </IssueBanner>
          )}
          {savedForm && (
            <IssueBanner tone="success" code="saved">
              <b>{savedForm.label}</b> committed as SSH · host key remains system-owned
            </IssueBanner>
          )}
          <div className="ob-c-form-foot">
            <span>Test 通过后才允许提交连接。</span>
            <Button variant="primary" type="submit" disabled={testStatus !== "passed"}>
              Commit SSH connection
              <ArrowRight size={11} />
            </Button>
          </div>
        </form>
        <CTestInspector />
      </div>
      {failure === "ssh_test_failed" && (
        <div className="ob-c-ssh-actions">
          <ActionRail actions={["edit_target", "retry", "legacy_attach"]} />
        </div>
      )}
    </div>
  );
}

function CConflicts() {
  const {
    connections,
    failure,
    failureMeta,
    conflictResolved,
    registryRepaired,
    runAction,
  } = useOnboarding();
  const invalid = connections.filter((connection) => connection.status === "invalid");
  return (
    <div className="ob-c-page">
      <CPageHead
        kicker="REGISTRY · CONFLICT QUEUE"
        title="把冲突做成一条可审计的队列。"
        body="canonical 与 duplicate 是文件事实；解决动作只影响拨号与展示，不自动删除外部条目。"
        actions={
          <Button variant="secondary" onClick={() => runAction("export_safe_summary")}>
            导出脱敏摘要
          </Button>
        }
      />
      <div className="ob-c-conflict-grid">
        <section className="ob-c-conflict-queue">
          <div className="ob-c-conflict-head">
            <span>ENTRY</span>
            <span>IDENTITY</span>
            <span>ACTION</span>
          </div>
          <div className="ob-c-conflict-row is-canonical">
            <span className="ob-c-conflict-index">01</span>
            <div><b>Homelab</b><em>homelab.lan · tickets --serve</em></div>
            <span className="ob-c-conflict-canonical">canonical</span>
            <span className="ob-c-conflict-action">keep</span>
          </div>
          {invalid.map((entry, index) => (
            <div className="ob-c-conflict-row is-invalid" key={entry.id}>
              <span className="ob-c-conflict-index">0{index + 2}</span>
              <div><b>{entry.label}</b><em>{entry.kind} · {entry.note}</em></div>
              <span className="ob-c-conflict-canonical">duplicate</span>
              <span className="ob-c-conflict-action">skip dial</span>
            </div>
          ))}
          {failure === "registry_corrupt" && (
            <div className={cn("ob-c-conflict-row is-error", registryRepaired && "is-repaired")}>
              <span className="ob-c-conflict-index">!</span>
              <div>
                <b>{registryRepaired ? "registry repaired" : "registry_corrupt"}</b>
                <em>{registryRepaired ? "canonical v2 · writes resumed" : "JSON parse failed · writes refused"}</em>
              </div>
              <span className="ob-c-conflict-canonical">{registryRepaired ? "fixed" : "blocked"}</span>
              {!registryRepaired && (
                <button type="button" onClick={() => runAction("repair_registry")}>repair</button>
              )}
            </div>
          )}
          {failure === "registry_unsupported" && (
            <div className="ob-c-conflict-row is-error">
              <span className="ob-c-conflict-index">!</span>
              <div><b>future registry version</b><em>read-only · no rewrite</em></div>
              <span className="ob-c-conflict-canonical">unsupported</span>
              <button type="button" onClick={() => runAction("open_update_docs")}>docs</button>
            </div>
          )}
          {failure === "token_sync_failed" && (
            <div className="ob-c-conflict-row is-warning">
              <span className="ob-c-conflict-index">!</span>
              <div><b>VPS-1 token sync</b><em>connection committed · token not bound</em></div>
              <span className="ob-c-conflict-canonical">warning</span>
              <button type="button" onClick={() => runAction("reauthorize")}>reauth</button>
            </div>
          )}
        </section>
        <aside className="ob-c-conflict-detail">
          <span className="ob-eyebrow">DECISION RECORD</span>
          <h2>{conflictResolved ? "canonical retained" : "Keep which dial identity?"}</h2>
          <p>
            {conflictResolved
              ? "重复项仍保留在外部文件中；只有拨号被隔离，未删除任何条目。"
              : "本客户端新增会拒绝 duplicate；外部重复会保留并标记 registry_invalid。删除不是自动动作。"}
          </p>
          <FailureFacts />
          <div className="ob-c-conflict-buttons">
            <Button variant="primary" onClick={() => runAction("keep_canonical")}>保留 canonical</Button>
            <Button variant="secondary" onClick={() => runAction("resolve_conflict")}>只隔离重复项</Button>
            <Button variant="quiet" onClick={() => runAction("export_safe_summary")}>导出摘要</Button>
          </div>
          <div className="ob-c-conflict-safe">
            <KeyRound size={12} />
            <span>raw quarantined entry、token、原始 URL 的 userinfo/query/fragment 不进入 Renderer。</span>
          </div>
        </aside>
      </div>
      {failureMeta.family === "registry" && failure !== "none" && (
        <div className="ob-c-registry-footnote">
          <Info size={12} />
          <span>外部文件是共享状态；原型只演示修复语义，不访问真实 registry。</span>
        </div>
      )}
    </div>
  );
}

function CStartup() {
  const {
    connections,
    primaryId,
    lastUsedId,
    launchMode,
    setLaunchMode,
    setPrimary,
  } = useOnboarding();
  const target =
    launchMode === "primary"
      ? connections.find((connection) => connection.id === primaryId)
      : connections.find((connection) => connection.id === lastUsedId);
  return (
    <div className="ob-c-page">
      <CPageHead
        kicker="STARTUP · DESTINATION"
        title="把启动落位写成一条规则。"
        body="Primary 与 last-used 是两条不同的启动策略；连接状态变化不会静默改写 Scope。"
        actions={
          <span className="ob-c-next-target">
            <span>NEXT LAUNCH</span>
            <b>{target?.label}</b>
          </span>
        }
      />
      <div className="ob-c-startup-grid">
        <section className="ob-c-startup-policy">
          <span className="ob-eyebrow">LAUNCH MODE</span>
          <button
            type="button"
            className={cn(launchMode === "primary" && "is-active")}
            onClick={() => setLaunchMode("primary")}
          >
            <span className="ob-b-radio">{launchMode === "primary" && <i />}</span>
            <span><b>Primary</b><em>显式默认连接</em></span>
            <Star size={13} />
          </button>
          <button
            type="button"
            className={cn(launchMode === "last-used" && "is-active")}
            onClick={() => setLaunchMode("last-used")}
          >
            <span className="ob-b-radio">{launchMode === "last-used" && <i />}</span>
            <span><b>Last used</b><em>最近成功使用的 Scope</em></span>
            <CircleDot size={13} />
          </button>
          <div className="ob-c-startup-explainer">
            <span>FALLBACK ORDER</span>
            <p>仅权威移除后回退：同 Scope 最近 Session → 同 Connection 默认 Profile → 其他 Connection → Local → 空态。</p>
          </div>
        </section>
        <section className="ob-c-startup-table">
          <div className="ob-c-startup-head">
            <span>CONNECTION</span>
            <span>PROFILES</span>
            <span>PRIMARY</span>
          </div>
          {connections.map((connection) => (
            <div className={cn("ob-c-startup-row", connection.primary && "is-primary")} key={connection.id}>
              <div className="ob-c-startup-device">
                <ConnectionGlyph kind={connection.kind} />
                <span><b>{connection.label}</b><em>{connection.host} · last used {connection.lastUsed}</em></span>
              </div>
              <div className="ob-c-startup-profiles">
                {connection.profiles.map((profile) => (
                  <span className={`is-${profile.readiness}`} key={profile.id}>{profile.handle}</span>
                ))}
              </div>
              <button type="button" onClick={() => setPrimary(connection.id)}>
                <Star size={12} fill={connection.primary ? "currentColor" : "none"} />
                {connection.primary ? "primary" : "set"}
              </button>
            </div>
          ))}
        </section>
      </div>
      <div className="ob-c-startup-note">
        <Laptop size={13} />
        <span>多 Profile：default eager；其余首次激活后常连。原型不建立真实连接，也不写持久化。</span>
      </div>
    </div>
  );
}

function CComposer() {
  const { draft, setDraft, submitComposer, composerSubmitted, scene } = useOnboarding();
  return (
    <div className="ob-c-composer-wrap">
      <div className="ob-c-composer-context">
        <StatusDot tone="ok" />
        <span>Homelab / @research</span>
        <span>{scene === "empty-draft" ? "DRAFT · local" : "NO ACTIVE CHAT"}</span>
      </div>
      <div className="ob-c-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="原型 composer"
          rows={2}
          placeholder="问 Hermes，或键入 / 和 @…"
        />
        <button type="button" onClick={submitComposer} aria-label="发送消息">
          <ArrowRight size={15} />
        </button>
      </div>
      {composerSubmitted && (
        <span className="ob-c-composer-note">prototype · 没有 session.create，也没有发送</span>
      )}
    </div>
  );
}

function CEmpty() {
  const { scene, note, setScene, runAction, draft } = useOnboarding();
  const onboarding = scene === "empty-onboarding";
  const fallback = scene === "scope-banner";
  const hasDraft = scene === "empty-draft";
  return (
    <div className="ob-c-conversation">
      {fallback && (
        <div className="ob-c-route-banner" role="status">
          <span>ROUTE FALLBACK</span>
          <p>原 Session 已移除；已退回 Homelab / @ops。last-known 内容保留，输入未禁用。</p>
          <button type="button" onClick={() => note("原型：dismiss banner，不抢焦点。")}>dismiss</button>
        </div>
      )}
      <div className="ob-c-conversation-scroll">
        <div className="ob-c-thread">
          {hasDraft ? (
            <div className="ob-c-draft-state">
              <div className="ob-c-thread-mark"><CircleDot size={24} /></div>
              <span className="ob-eyebrow">LOCAL DRAFT · NOT EMPTY</span>
              <h1>草稿还在这里。</h1>
              <p>检测到未落库内容，因此不显示空态。composer 保持预填；不会自动新建 Session 或发送。</p>
              <div className="ob-c-draft-preview">
                <span>DRAFT · {draft.length} chars</span>
                <p>{draft || "（空）"}</p>
              </div>
            </div>
          ) : (
            <div className="ob-c-upcoming">
              <div className="ob-c-thread-mark">
                <span />
                <span />
                <span />
              </div>
              <span className="ob-eyebrow">{onboarding ? "ONBOARDING EMPTY" : "NORMAL EMPTY"}</span>
              <h1>{onboarding ? "还没有可用的连接。" : "安静地去问。"}</h1>
              <p>
                {onboarding
                  ? "全部连接不可用。保留 3 个修复动作与 1 条低频状态，不把空态做成能力目录。"
                  : "没有 ActiveChat，也没有草稿。同步仍在线；启动不会自动 session.create。"}
              </p>
              {!onboarding ? (
                <div className="ob-c-empty-actions">
                  <button type="button" onClick={() => setScene("empty-draft")}>
                    <span>继续最近 Session</span>
                    <em>last active chat</em>
                    <ArrowRight size={12} />
                  </button>
                  <button type="button" onClick={() => note("原型：能力目录从 ⌘K 打开，不在这里铺开。")}>
                    <span>能力目录</span>
                    <em>⌘K</em>
                    <ArrowRight size={12} />
                  </button>
                  <button type="button" onClick={() => note("原型：Workspace 走右侧抽屉。")}>
                    <span>Workspace</span>
                    <em>drawer</em>
                    <ArrowRight size={12} />
                  </button>
                </div>
              ) : (
                <div className="ob-c-empty-actions">
                  <button type="button" onClick={() => runAction("retry")}>
                    <span>修复 Local</span>
                    <em>blocked</em>
                    <ArrowRight size={12} />
                  </button>
                  <button type="button" onClick={() => setScene("add-remote")}>
                    <span>添加 Remote</span>
                    <em>token / OAuth</em>
                    <ArrowRight size={12} />
                  </button>
                  <button type="button" onClick={() => setScene("add-ssh")}>
                    <span>添加 SSH</span>
                    <em>probe / test</em>
                    <ArrowRight size={12} />
                  </button>
                </div>
              )}
              <button
                type="button"
                className="ob-c-cron-row"
                onClick={() => note("原型：Cron 详情从低频状态进入。")}
              >
                <StatusDot tone="warn" />
                <span>{onboarding ? "Cron 0 个计划 · 暂停" : "没有运行中的任务 · Cron 0 个计划"}</span>
                <em>open status</em>
              </button>
            </div>
          )}
          <CComposer />
        </div>
      </div>
      <footer className="ob-c-conversation-foot">
        <span>≤3 actions</span>
        <span>1 low-frequency Cron</span>
        <span>720px column</span>
      </footer>
    </div>
  );
}

function CWorkbench() {
  const { scene, setScene, connections, primaryId, failureMeta } = useOnboarding();
  const target = connections.find((connection) => connection.id === primaryId) ?? connections[0];
  const [fleetOpen, setFleetOpen] = useState(false);
  return (
    <main className="ob-c-main">
      <header className="ob-c-route-strip">
        <div>
          <span className="ob-eyebrow">WORKBENCH</span>
          <span>YOU</span>
          <i />
          <b>{target?.label}</b>
          <i />
          <span>{target?.profiles[0]?.handle ?? "@—"}</span>
          <KindBadge kind={target?.kind ?? "local"} />
          <span className="ob-c-route-status">
            <StatusDot tone={failureMeta.family === "local" && failureMeta.code !== "none" ? "error" : "ok"} />
            {failureMeta.family === "local" && failureMeta.code !== "none" ? failureMeta.code : "route stable"}
          </span>
        </div>
        <div>
          <button type="button" onClick={() => setScene("conflicts")}>
            registry 12
          </button>
          <button type="button" onClick={() => setScene("startup")}>
            startup
          </button>
        </div>
      </header>
      {fleetOpen && <CLedgerPopover onClose={() => setFleetOpen(false)} />}
      <CCommandBar onFleetToggle={() => setFleetOpen((open) => !open)} />
      <div className="ob-c-workbench-scroll">
        {scene === "first-run" && <CFirstRun />}
        {scene === "local-recovery" && <CLocalRecovery />}
        {scene === "add-remote" && <CRemoteForm />}
        {scene === "add-ssh" && <CSshForm />}
        {scene === "conflicts" && <CConflicts />}
        {scene === "startup" && <CStartup />}
        {(scene === "empty-normal" ||
          scene === "empty-onboarding" ||
          scene === "empty-draft" ||
          scene === "scope-banner") && <CEmpty />}
      </div>
      <footer className="ob-c-status">
        <span>REGISTRY revision 12</span>
        <span>tickets --serve simulated</span>
        <span>token bytes · Main only</span>
        <span className="ob-c-status-spacer" />
        <span>PROTOTYPE / throwaway branch</span>
      </footer>
    </main>
  );
}

export function VariantC() {
  return (
    <div className="ob-root ob-variant-c">
      <ProtoTitlebar />
      <ScenarioBar />
      <div className="ob-c-shell">
        <CLedger />
        <CWorkbench />
      </div>
      {import.meta.env.DEV && <VariantSwitcher />}
    </div>
  );
}
