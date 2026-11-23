import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleDot,
  KeyRound,
  Laptop,
  Link2,
  RotateCcw,
  Server,
  Star,
  Terminal,
} from "lucide-react";
import { cn } from "../../lib/ui";
import { Button, Field } from "../../components/ui";
import { useOnboarding } from "./OnboardingContext";
import {
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

function BTopRoute() {
  const { connections, primaryId, launchMode } = useOnboarding();
  const target = connections.find((connection) => connection.id === primaryId) ?? connections[0];
  return (
    <div className="ob-b-top-route">
      <div className="ob-b-route-copy">
        <span className="ob-eyebrow">QUIET THRESHOLD · PROGRESSIVE ONBOARDING</span>
        <div className="ob-b-route-line">
          <span>YOU</span>
          <i />
          <b>{target?.label ?? "UNSET"}</b>
          <i />
          <span>{target?.profiles[0]?.handle ?? "@—"}</span>
          <KindBadge kind={target?.kind ?? "local"} />
        </div>
      </div>
      <div className="ob-b-top-meta">
        <span>{connections.filter((connection) => connection.status === "ready").length} ready</span>
        <span>{launchMode}</span>
        <span>No persistent rail</span>
      </div>
    </div>
  );
}

function BThresholdLayout({
  step,
  kicker,
  aside,
  children,
}: {
  step: string;
  kicker: string;
  aside: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="ob-b-threshold">
      <div className="ob-b-aside">
        <span className="ob-b-big-index">{step}</span>
        <span className="ob-eyebrow">{kicker}</span>
        {aside}
      </div>
      <div className="ob-b-card">{children}</div>
    </div>
  );
}

function BCardHead({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: string;
}) {
  return (
    <header className="ob-b-card-head">
      <span className="ob-eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{detail}</p>
    </header>
  );
}

function BFirstRun() {
  const {
    failureMeta,
    setScene,
    runAction,
  } = useOnboarding();
  const localFailure = failureMeta.family === "local" && failureMeta.code !== "none";
  return (
    <BThresholdLayout
      step="01"
      kicker="ORIGIN"
      aside={
        <>
          <h2>一台机器就够了。</h2>
          <p>
            先选一个起点。Local 是 App-managed；Remote 与 SSH 是外部 fleet。
            不需要先规划所有连接。
          </p>
          <div className="ob-b-aside-fact">
            <span>NO RUNTIME BUNDLE</span>
            <b>App never installs Hermes for you.</b>
          </div>
        </>
      }
    >
      <BCardHead
        eyebrow="FIRST RUN"
        title="Hermes 从哪里出发？"
        detail="选一条路线；后面的表单、测试和修复路径会按这条路线展开。"
      />
      <div className="ob-b-origin-list">
        <button
          type="button"
          className={cn("ob-b-origin-card", localFailure && "has-issue")}
          onClick={() => {
            if (localFailure) runAction("choose_cli");
            else setScene("empty-normal");
          }}
        >
          <span className="ob-b-origin-icon"><Laptop size={17} /></span>
          <span>
            <b>This device</b>
            <em>Local · attach / ensure 已安装的 Hermes</em>
          </span>
          <span className={cn("ob-b-origin-state", localFailure ? "is-blocked" : "is-ready")}>
            {localFailure ? failureMeta.code : "ready"}
          </span>
          <ChevronRight size={14} />
        </button>
        <button type="button" className="ob-b-origin-card" onClick={() => setScene("add-remote")}>
          <span className="ob-b-origin-icon"><Link2 size={17} /></span>
          <span>
            <b>Remote HTTP(S)</b>
            <em>Session token 或 Native OAuth / PKCE</em>
          </span>
          <span className="ob-b-origin-state is-ready">HTTP + WS</span>
          <ChevronRight size={14} />
        </button>
        <button type="button" className="ob-b-origin-card" onClick={() => setScene("add-ssh")}>
          <span className="ob-b-origin-icon"><Terminal size={17} /></span>
          <span>
            <b>SSH host</b>
            <em>Probe → Test → tickets --serve / legacy</em>
          </span>
          <span className="ob-b-origin-state is-ready">managed tunnel</span>
          <ChevronRight size={14} />
        </button>
      </div>
      {localFailure && (
        <div className="ob-b-card-failure">
          <FailureCallout compact />
        </div>
      )}
      <footer className="ob-b-card-foot">
        <span>Local 失败不会阻止你添加 Remote / SSH。</span>
        <button type="button" onClick={() => setScene("local-recovery")}>
          查看自动 attach / ensure
          <ArrowRight size={11} />
        </button>
      </footer>
    </BThresholdLayout>
  );
}

function BLocalRecovery() {
  const { failure, failureMeta, localRecovered, restartAttempts, setScene } = useOnboarding();
  const localFailure = failureMeta.family === "local" && failure !== "none";
  const stages = [
    ["01", "Discover", "登录 shell PATH → 常见目录"],
    ["02", "Ensure", "60s deadline · 不另起第二个 owner"],
    ["03", "Recover", "同一 stale owner 最多一次 graceful restart"],
    ["04", "Mint", "ticket 30s / single-use / Main only"],
    ["05", "Attach", "host-scope 共享；否则 per-Profile 回退"],
  ];
  return (
    <BThresholdLayout
      step="02"
      kicker="RECOVER"
      aside={
        <>
          <h2>恢复也有边界。</h2>
          <p>不安装 service，不 kill owner，不重试无限。失败是 typed fact，不是日志墙。</p>
          <div className="ob-b-aside-fact">
            <span>STATE</span>
            <b>{localRecovered ? "recovered" : localFailure ? failureMeta.state : "ready"}</b>
            <em>{restartAttempts}/1 controlled restart</em>
          </div>
        </>
      }
    >
      <BCardHead
        eyebrow="LOCAL ATTACH / ENSURE"
        title={localRecovered ? "线路已恢复。" : localFailure ? failureMeta.headline : "自动连接已完成。"}
        detail={
          localRecovered
            ? "这一次受控 restart 已让 code_sha 对齐；没有循环重启。"
            : localFailure
              ? failureMeta.detail
              : "ensure、host-scope ticket 与 HTTP/WS 都走通了；没有写入任何 path 或 secret。"
        }
      />
      <div className="ob-b-stage-stack">
        {stages.map(([index, name, detail], position) => {
          const blockedIndex =
            failure === "hermes_not_found" || failure === "cli_not_executable"
              ? 1
              : failure === "gateway_start_failed"
                ? 2
                : failure === "code_sha_mismatch"
                  ? 3
                  : failure === "socket_permission_denied" || failure === "service_unhealthy"
                    ? 5
                    : 0;
          const blocked = localFailure && !localRecovered && blockedIndex === position + 1;
          const done = !blocked && (!localFailure || localRecovered || position + 1 < blockedIndex);
          return (
            <div className={cn("ob-b-stage", blocked && "is-blocked", done && "is-done")} key={name}>
              <span>{index}</span>
              <div>
                <b>{name}</b>
                <p>{detail}</p>
              </div>
              <em>{blocked ? "blocked" : done ? "done" : "waiting"}</em>
            </div>
          );
        })}
      </div>
      {localFailure && !localRecovered && <FailureCallout compact />}
      <footer className="ob-b-card-foot">
        <span>Local 可继续作为 onboarding 的起点，也可以先跳过。</span>
        <div>
          <Button variant="quiet" onClick={() => setScene("first-run")}>返回首次运行</Button>
          <Button variant="secondary" onClick={() => setScene("add-remote")}>改连 Remote</Button>
        </div>
      </footer>
    </BThresholdLayout>
  );
}

function BStepper({ current }: { current: number }) {
  const steps = ["Type", "Endpoint", "Auth", "Test"];
  return (
    <div className="ob-b-stepper" aria-label={`当前步骤 ${current + 1} / 4`}>
      {steps.map((step, index) => (
        <div
          className={cn("ob-b-stepper-step", index === current && "is-active", index < current && "is-done")}
          key={step}
        >
          <span>{index + 1}</span>
          <b>{step}</b>
        </div>
      ))}
    </div>
  );
}

function BDuplicateCard() {
  const { duplicateVisible, failure, connections, runAction } = useOnboarding();
  if (!duplicateVisible) return null;
  const existing = connections.find((connection) => connection.id === "vps1");
  return (
    <div className="ob-b-duplicate">
      <span className="ob-eyebrow">{failure}</span>
      <h3>这已经是 {existing?.label ?? "VPS-1"} 了。</h3>
      <p>
        {existing?.host} · 凭据 {existing?.hasToken ? "已保存（隐藏）" : "无"}。
        这次输入没有覆盖既有连接。
      </p>
      <div>
        <Button variant="secondary" onClick={() => runAction("edit_label")}>改设备名</Button>
        <Button variant="quiet" onClick={() => runAction("edit_target")}>改目标</Button>
      </div>
    </div>
  );
}

function BRemoteForm() {
  const {
    form,
    formKind,
    setForm,
    testStatus,
    testMessage,
    oauthStatus,
    startOAuth,
    finishOAuth,
    cancelOAuth,
    runTest,
    saveForm,
    savedForm,
    failure,
    setScene,
    runAction,
  } = useOnboarding();
  if (formKind !== "remote") return null;
  const currentStep = testStatus === "passed" ? 3 : form.authMode === "oauth" && oauthStatus !== "idle" ? 2 : 1;
  return (
    <BThresholdLayout
      step="03"
      kicker="EXTEND"
      aside={
        <>
          <h2>一次只决定一件事。</h2>
          <p>类型、端点、认证与测试分开。失败时，已经填写的内容不会被清空。</p>
          <div className="ob-b-aside-fact">
            <span>WRITE BOUNDARY</span>
            <b>Test ≠ Save</b>
            <em>测试只探测；保存才写 registry。</em>
          </div>
        </>
      }
    >
      <div className="ob-b-card-head is-form">
        <div>
          <span className="ob-eyebrow">ADD CONNECTION · REMOTE</span>
          <h1>接一条远程线路。</h1>
        </div>
        <button type="button" className="ob-b-kind-switch" onClick={() => setScene("add-ssh")}>
          <Terminal size={12} /> SSH instead
        </button>
      </div>
      <BStepper current={currentStep} />
      <form
        className="ob-b-form"
        onSubmit={(event) => {
          event.preventDefault();
          saveForm();
        }}
      >
        <div className="ob-b-question">
          <span className="ob-b-question-index">A</span>
          <Field label="这台机器叫什么？" hint="显示在 route、Session 与 Primary 选择中">
            <input
              value={form.label}
              onChange={(event) => setForm({ label: event.target.value })}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="ob-b-question">
          <span className="ob-b-question-index">B</span>
          <Field label="Gateway URL" hint="只支持 HTTP(S)；尾斜杠与大小写不构成不同身份">
            <input
              value={form.target}
              onChange={(event) => setForm({ target: event.target.value })}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="ob-b-question">
          <span className="ob-b-question-index">C</span>
          <fieldset className="ob-b-auth">
            <legend>怎样证明你可以进入？</legend>
            <button
              type="button"
              className={cn(form.authMode === "session-token" && "is-active")}
              onClick={() => setForm({ authMode: "session-token" })}
            >
              <span><KeyRound size={15} /></span>
              <b>Session token</b>
              <em>粘贴一次，保存后不回填</em>
              <span className="ob-b-radio">{form.authMode === "session-token" && <i />}</span>
            </button>
            <button
              type="button"
              className={cn(form.authMode === "oauth" && "is-active")}
              onClick={() => setForm({ authMode: "oauth" })}
            >
              <span><CircleDot size={15} /></span>
              <b>Native OAuth / PKCE</b>
              <em>由 Main 打开系统浏览器</em>
              <span className="ob-b-radio">{form.authMode === "oauth" && <i />}</span>
            </button>
          </fieldset>
        </div>
        <div className="ob-b-auth-body">
          {form.authMode === "session-token" ? (
            <>
              <Field label="Session token" hint="只在本字段内输入；Renderer 绝不显示已经保存的 token">
                <input
                  type="password"
                  value={form.token}
                  onChange={(event) => setForm({ token: event.target.value })}
                  placeholder="tok_••••••••"
                  autoComplete="new-password"
                />
              </Field>
              <span className="ob-b-token-fact">
                saved token: {savedForm?.tokenStored ? "Main only" : "none"}
              </span>
            </>
          ) : oauthStatus === "waiting" ? (
            <div className="ob-b-oauth-wait">
              <span className="ob-wait-dot" />
              <div>
                <b>等待系统浏览器回调</b>
                <p>Renderer 只收到等待状态；没有 token 或 callback URL。</p>
              </div>
              <Button variant="secondary" onClick={finishOAuth}>模拟完成</Button>
              <Button variant="quiet" onClick={cancelOAuth}>取消</Button>
            </div>
          ) : oauthStatus === "granted" ? (
            <div className="ob-b-oauth-done">
              <Check size={14} />
              <span>已授权（模拟）· hasToken = true · bytes stay in Main</span>
            </div>
          ) : (
            <button type="button" className="ob-b-oauth-start" onClick={startOAuth}>
              <span>打开系统浏览器开始 OAuth</span>
              <ArrowRight size={13} />
            </button>
          )}
        </div>

        <BDuplicateCard />
        {savedForm && (
          <IssueBanner tone="success" code="saved">
            <b>{savedForm.label}</b> 已保存；{savedForm.tokenStored ? "token 只在 Main" : "没有渲染已保存 token"}。
          </IssueBanner>
        )}
        {failure === "token_sync_failed" && (
          <IssueBanner
            tone="warning"
            code="token_sync_failed"
            action={
              <button type="button" className="ob-inline-action" onClick={() => runAction("reauthorize")}>
                重新授权
              </button>
            }
          >
            连接写入成功，token 对账失败；重新授权会开启新的 native 流程。
          </IssueBanner>
        )}
        <div className="ob-b-test-block">
          <div className={cn("ob-b-test-state", `is-${testStatus}`)}>
            <span />
            <div>
              <b>{testStatus === "idle" ? "尚未 Test" : testStatus === "running" ? "测试中…" : testStatus === "passed" ? "Test 通过" : "Test 失败"}</b>
              <p>{testMessage}</p>
            </div>
          </div>
          <div className="ob-b-card-actions">
            <Button
              variant="secondary"
              onClick={() => runTest("remote")}
              disabled={testStatus === "running" || oauthStatus === "waiting"}
            >
              Test connection
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={oauthStatus === "waiting" || (!form.token && form.authMode === "session-token" && oauthStatus !== "granted")}
            >
              保存到 registry
              <ArrowRight size={11} />
            </Button>
          </div>
        </div>
      </form>
    </BThresholdLayout>
  );
}

function BSshForm() {
  const {
    form,
    formKind,
    setForm,
    testStatus,
    testMessage,
    runTest,
    saveForm,
    savedForm,
    failure,
    setScene,
    runAction,
  } = useOnboarding();
  if (formKind !== "ssh") return null;
  return (
    <BThresholdLayout
      step="03"
      kicker="EXTEND"
      aside={
        <>
          <h2>先测试，再相信。</h2>
          <p>SSH probe 检查目标与 Hermes attach 面。Test 只读，不写 registry，也不会替你确认 host key。</p>
          <div className="ob-b-aside-fact">
            <span>TEST SEMANTICS</span>
            <b>Probe ≠ Commit</b>
            <em>registry writes stay at zero.</em>
          </div>
        </>
      }
    >
      <div className="ob-b-card-head is-form">
        <div>
          <span className="ob-eyebrow">ADD CONNECTION · SSH</span>
          <h1>接一台 SSH host。</h1>
        </div>
        <button type="button" className="ob-b-kind-switch" onClick={() => setScene("add-remote")}>
          <Link2 size={12} /> Remote instead
        </button>
      </div>
      <BStepper current={testStatus === "passed" ? 3 : 2} />
      <form
        className="ob-b-form"
        onSubmit={(event) => {
          event.preventDefault();
          saveForm();
        }}
      >
        <div className="ob-b-question">
          <span className="ob-b-question-index">A</span>
          <Field label="设备名" hint="唯一；名称冲突不会覆盖既有连接">
            <input value={form.label} onChange={(event) => setForm({ label: event.target.value })} />
          </Field>
        </div>
        <div className="ob-b-question">
          <span className="ob-b-question-index">B</span>
          <Field label="SSH target" hint="user@host:port；keyPath 不参与身份键">
            <input value={form.target} onChange={(event) => setForm({ target: event.target.value })} />
          </Field>
        </div>
        <div className="ob-b-question">
          <span className="ob-b-question-index">C</span>
          <Field label="Remote Profile" hint="连接后 default Profile eager；其余首次使用再激活">
            <input
              value={form.remoteProfile}
              onChange={(event) => setForm({ remoteProfile: event.target.value })}
            />
          </Field>
        </div>
        <div className="ob-b-ssh-choice">
          <div className="is-preferred">
            <span><Terminal size={13} /> tickets --serve</span>
            <b>默认</b>
            <p>共享 transport、可交互 ticket；每次新 WS 重新 mint。</p>
          </div>
          <div className={cn(failure === "ssh_test_failed" && "is-blocked")}>
            <span><Server size={13} /> legacy attach-only</span>
            <b>回退</b>
            <p>per-Profile ticket；owner 可能 idle exit。</p>
          </div>
        </div>
        {failure === "ssh_test_failed" && (
          <IssueBanner
            tone="warning"
            code="ssh_test_failed"
            action={
              <button type="button" className="ob-inline-action" onClick={() => runAction("legacy_attach")}>
                legacy attach-only
              </button>
            }
          >
            <b>Test 失败。</b> {form.label} / {form.target} 仍保留；没有写入 registry。
          </IssueBanner>
        )}
        {savedForm && (
          <IssueBanner tone="success" code="saved">
            <b>{savedForm.label}</b> 已保存；host key 仍归系统 SSH known_hosts。
          </IssueBanner>
        )}
        <div className="ob-b-test-block">
          <div className={cn("ob-b-test-state", `is-${testStatus}`)}>
            <span />
            <div>
              <b>{testStatus === "idle" ? "尚未 Test" : testStatus === "running" ? "Probe 中…" : testStatus === "passed" ? "Probe 通过" : "Probe 失败"}</b>
              <p>{testMessage}</p>
            </div>
          </div>
          <div className="ob-b-card-actions">
            <Button variant="secondary" onClick={() => runTest("ssh")} disabled={testStatus === "running"}>
              Test SSH
            </Button>
            <Button variant="primary" type="submit" disabled={testStatus !== "passed"}>
              保存到 registry
              <ArrowRight size={11} />
            </Button>
          </div>
        </div>
      </form>
    </BThresholdLayout>
  );
}

function BConflicts() {
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
    <BThresholdLayout
      step="04"
      kicker="RECONCILE"
      aside={
        <>
          <h2>解释冲突，而不是掩埋它。</h2>
          <p>外部 registry 是共享文件。重复条目保留在文件内，但不拨号；删除必须由你显式做出。</p>
          <div className="ob-b-aside-fact">
            <span>CANONICAL</span>
            <b>Homelab</b>
            <em>first valid entry by file order</em>
          </div>
        </>
      }
    >
      <BCardHead
        eyebrow="SHARED REGISTRY"
        title={conflictResolved ? "冲突项已隔离。" : "有一组连接需要解释。"}
        detail={
          conflictResolved
            ? "重复项仍原样保留在外部文件中；只有拨号和展示被隔离。"
            : "这不是连接失败，而是 registry 身份冲突。选择只影响拨号，不删除外部数据。"
        }
      />
      <div className="ob-b-conflict-stack">
        <article className="ob-b-conflict-card is-canonical">
          <header>
            <span className="ob-eyebrow">CANONICAL · 01</span>
            <span className="ob-b-conflict-state">active</span>
          </header>
          <div>
            <ConnectionGlyph kind="ssh" />
            <span><b>Homelab</b><em>homelab.lan · tickets --serve</em></span>
          </div>
          <p>按文件顺序，第一个通过校验的身份条目。继续参与连接。</p>
        </article>
        {invalid.map((entry, index) => (
          <article className="ob-b-conflict-card is-duplicate" key={entry.id}>
            <header>
              <span className="ob-eyebrow">DUPLICATE · 0{index + 2}</span>
              <span className="ob-b-conflict-state">not dialed</span>
            </header>
            <div>
              <ConnectionGlyph kind={entry.kind} />
              <span><b>{entry.label}</b><em>{entry.note} · secret hidden</em></span>
            </div>
            <p>保留在外部文件；raw entry 只在 Main 可见。</p>
          </article>
        ))}
        {(failure === "registry_corrupt" || failure === "registry_unsupported") && (
          <div className={cn("ob-b-registry-card", registryRepaired && "is-repaired")}>
            <span className="ob-eyebrow">{registryRepaired ? "REPAIRED" : failure === "registry_corrupt" ? "CORRUPT" : "UNSUPPORTED"}</span>
            <b>{registryRepaired ? "canonical v2 rebuilt" : failure === "registry_corrupt" ? "JSON 无法读取；写入已拒绝。" : "未来版本 registry；只读。"}</b>
            {!registryRepaired && failure === "registry_corrupt" && (
              <Button variant="primary" onClick={() => runAction("repair_registry")}>备份并修复</Button>
            )}
            {failure === "registry_unsupported" && (
              <Button variant="secondary" onClick={() => runAction("open_update_docs")}>查看更新文档</Button>
            )}
          </div>
        )}
        {failure === "token_sync_failed" && (
          <div className="ob-b-registry-card">
            <span className="ob-eyebrow">TOKEN SYNC WARNING</span>
            <b>连接已提交；token 对账失败，Renderer 没有回填任何凭据。</b>
            <Button variant="secondary" onClick={() => runAction("reauthorize")}>
              重新授权
            </Button>
          </div>
        )}
      </div>
      <div className="ob-b-decision">
        <div>
          <span className="ob-eyebrow">YOUR CALL</span>
          <b>{conflictResolved ? "canonical 已保留" : "你想保留哪个拨号身份？"}</b>
        </div>
        <div>
          <Button variant="primary" onClick={() => runAction("keep_canonical")}>
            保留 canonical
          </Button>
          <Button variant="secondary" onClick={() => runAction("resolve_conflict")}>
            只隔离重复项
          </Button>
          <Button variant="quiet" onClick={() => runAction("export_safe_summary")}>
            导出摘要
          </Button>
        </div>
      </div>
      {failureMeta.family === "registry" && <FailureFacts className="ob-b-registry-facts" />}
    </BThresholdLayout>
  );
}

function BStartup() {
  const {
    connections,
    primaryId,
    lastUsedId,
    launchMode,
    setLaunchMode,
    setPrimary,
  } = useOnboarding();
  const primary = connections.find((connection) => connection.id === primaryId);
  const last = connections.find((connection) => connection.id === lastUsedId);
  return (
    <BThresholdLayout
      step="05"
      kicker="ARRIVAL"
      aside={
        <>
          <h2>回来时，落到哪里？</h2>
          <p>启动落位是一个明确策略，不是连接列表的副作用。</p>
          <div className="ob-b-aside-fact">
            <span>NEXT LAUNCH</span>
            <b>{launchMode === "primary" ? primary?.label : last?.label}</b>
            <em>{launchMode} policy</em>
          </div>
        </>
      }
    >
      <BCardHead
        eyebrow="STARTUP"
        title="选择启动目的地。"
        detail="Primary 是默认；last-used 是最近成功使用。瞬时断线不会触发回退。"
      />
      <div className="ob-b-policy-choice">
        <button
          type="button"
          className={cn(launchMode === "primary" && "is-active")}
          onClick={() => setLaunchMode("primary")}
        >
          <span className="ob-b-policy-icon"><Star size={15} /></span>
          <span><b>打开 Primary</b><em>{primary?.label ?? "This device"}</em></span>
          <span className="ob-b-radio">{launchMode === "primary" && <i />}</span>
        </button>
        <button
          type="button"
          className={cn(launchMode === "last-used" && "is-active")}
          onClick={() => setLaunchMode("last-used")}
        >
          <span className="ob-b-policy-icon"><RotateCcw size={15} /></span>
          <span><b>回到 last-used</b><em>{last?.label ?? "VPS-1"} · 最近成功</em></span>
          <span className="ob-b-radio">{launchMode === "last-used" && <i />}</span>
        </button>
      </div>
      <SectionLabel>SET PRIMARY</SectionLabel>
      <div className="ob-b-startup-list">
        {connections.map((connection) => (
          <div className={cn("ob-b-startup-row", connection.primary && "is-primary")} key={connection.id}>
            <button
              type="button"
              className="ob-b-star"
              onClick={() => setPrimary(connection.id)}
              aria-label={`将 ${connection.label} 设为 Primary`}
            >
              <Star size={13} fill={connection.primary ? "currentColor" : "none"} />
            </button>
            <span>
              <b>{connection.label}</b>
              <em>{connection.host}</em>
            </span>
            <div className="ob-b-profile-chips">
              {connection.profiles.map((profile) => (
                <span className={`is-${profile.readiness}`} key={profile.id}>{profile.handle}</span>
              ))}
            </div>
            <StatusBadge status={connection.status} />
          </div>
        ))}
      </div>
      <p className="ob-b-startup-note">
        多网关首次就绪：默认 Profile eager；其他 Profile 在用户第一次激活后常连。原型不会真的建立连接。
      </p>
    </BThresholdLayout>
  );
}

function BComposer() {
  const { draft, setDraft, submitComposer, composerSubmitted, scene } = useOnboarding();
  return (
    <div className="ob-b-composer-wrap">
      <div className="ob-b-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="原型 composer"
          rows={2}
          placeholder="问 Hermes，或键入 / 和 @…"
        />
        <div className="ob-b-composer-bar">
          <span>{scene === "empty-draft" ? "DRAFT · persisted by Main" : "Homelab / @research"}</span>
          <button type="button" onClick={submitComposer} aria-label="发送消息">
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
      {composerSubmitted && (
        <span className="ob-b-composer-note">原型：未自动 session.create，也未向 daemon 发送。</span>
      )}
    </div>
  );
}

function BEmpty() {
  const { scene, note, setScene, runAction, draft } = useOnboarding();
  const onboarding = scene === "empty-onboarding";
  const fallback = scene === "scope-banner";
  const hasDraft = scene === "empty-draft";
  return (
    <div className="ob-b-empty">
      {fallback && (
        <div className="ob-b-route-banner" role="status">
          <span>ROUTE FALLBACK</span>
          <p>原 Session 已移除，已退回 Homelab / @ops；last-known transcript 保留。</p>
          <button type="button" onClick={() => note("原型：banner dismissed，焦点不移动。")}>dismiss</button>
        </div>
      )}
      <div className="ob-b-empty-center">
        <span className="ob-b-empty-orbit" aria-hidden="true"><i /><i /><i /></span>
        <span className="ob-eyebrow">{hasDraft ? "UNSENT DRAFT" : onboarding ? "ONBOARDING EMPTY" : "NORMAL EMPTY"}</span>
        <h1>{hasDraft ? "草稿还在这里。" : onboarding ? "还没有可用的连接。" : "安静地去问。"}</h1>
        <p>
          {hasDraft
            ? "检测到未落库草稿，因此不进入空态。composer 已预填；不会自动创建 Session。"
            : onboarding
              ? "所有连接都不可用。先修一条路，或直接连接 Remote / SSH。这里仍然只给 ≤3 个动作。"
              : "告诉 Hermes 你要完成什么。第一条消息之后，这里只留下对话与必要的工具轨迹。"}
        </p>
        {!hasDraft && !onboarding && (
          <div className="ob-b-empty-actions">
            <button type="button" onClick={() => setScene("empty-draft")}>
              <span>继续最近 Session</span>
              <em>last active chat</em>
              <ArrowRight size={13} />
            </button>
            <button type="button" onClick={() => note("原型：能力目录从 ⌘K 打开。")}>
              <span>能力目录</span>
              <em>⌘K</em>
              <ArrowRight size={13} />
            </button>
            <button type="button" onClick={() => note("原型：Workspace 打开右侧抽屉。")}>
              <span>Workspace</span>
              <em>right drawer</em>
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {!hasDraft && onboarding && (
          <div className="ob-b-empty-actions">
            <button type="button" onClick={() => runAction("retry")}>
              <span>修复 Local</span>
              <em>blocked</em>
              <ArrowRight size={13} />
            </button>
            <button type="button" onClick={() => setScene("add-remote")}>
              <span>添加 Remote</span>
              <em>token / OAuth</em>
              <ArrowRight size={13} />
            </button>
            <button type="button" onClick={() => setScene("add-ssh")}>
              <span>添加 SSH</span>
              <em>probe / test</em>
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {hasDraft && (
          <div className="ob-b-draft-card">
            <span>{draft.length} chars · LOCAL DRAFT</span>
            <p>{draft || "（空）"}</p>
          </div>
        )}
        {!hasDraft && (
          <button
            type="button"
            className="ob-b-low-frequency"
            onClick={() => note("原型：Cron 详情不在空态展开。")}
          >
            <span>{onboarding ? "Cron 暂停 · 0 plans" : "没有运行中的任务 · Cron 0 个计划"}</span>
            <em>view</em>
          </button>
        )}
      </div>
      <BComposer />
      <footer className="ob-b-empty-foot">
        <span>≤3 actions</span>
        <span>1 low-frequency status</span>
        <span>no capability catalog</span>
      </footer>
    </div>
  );
}

export function VariantB() {
  const { scene } = useOnboarding();
  return (
    <div className="ob-root ob-variant-b">
      <ProtoTitlebar />
      <ScenarioBar />
      <main className="ob-b-main">
        <BTopRoute />
        <div className="ob-b-scroll">
          {scene === "first-run" && <BFirstRun />}
          {scene === "local-recovery" && <BLocalRecovery />}
          {scene === "add-remote" && <BRemoteForm />}
          {scene === "add-ssh" && <BSshForm />}
          {scene === "conflicts" && <BConflicts />}
          {scene === "startup" && <BStartup />}
          {(scene === "empty-normal" ||
            scene === "empty-onboarding" ||
            scene === "empty-draft" ||
            scene === "scope-banner") && <BEmpty />}
        </div>
      </main>
      {import.meta.env.DEV && <VariantSwitcher />}
    </div>
  );
}
