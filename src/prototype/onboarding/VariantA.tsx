import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Info,
  KeyRound,
  Link2,
  Plus,
  Server,
  Star,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn } from "../../lib/ui";
import { Button, Field, StatusDot } from "../../components/ui";
import { useOnboarding } from "./OnboardingContext";
import { prototypeScenes } from "./model";
import {
  ConnectionGlyph,
  FailureCallout,
  FailureFacts,
  IssueBanner,
  KindBadge,
  ProtoTitlebar,
  ScenarioBar,
  SectionLabel,
  VariantSwitcher,
  StatusBadge,
} from "./parts";

function routeTarget(connections: ReturnType<typeof useOnboarding>["connections"], primaryId: string) {
  return connections.find((connection) => connection.id === primaryId) ?? connections[0];
}

function FleetRail({ onFleetToggle }: { onFleetToggle: () => void }) {
  const {
    connections,
    primaryId,
    lastUsedId,
    launchMode,
    setLaunchMode,
    setScene,
    setPrimary,
  } = useOnboarding();
  return (
    <aside className="ob-a-fleet" aria-label="连接舰队">
      <div className="ob-a-fleet-head">
        <div>
          <span className="ob-eyebrow">FLEET</span>
          <h2>Connections</h2>
        </div>
        <button type="button" className="ob-circle-button" onClick={onFleetToggle} aria-label="收起连接舰队">
          <ChevronDown size={13} />
        </button>
      </div>

      <button
        type="button"
        className="ob-a-new-connection"
        onClick={() => setScene("add-remote")}
      >
        <Plus size={13} />
        <span>添加连接</span>
        <span className="ob-a-new-hint">Remote / SSH</span>
      </button>

      <div className="ob-a-fleet-list">
        {connections.map((connection) => (
          <div
            className={cn(
              "ob-a-fleet-row",
              connection.status === "invalid" && "is-invalid",
              connection.primary && "is-primary",
            )}
            key={connection.id}
          >
            <button
              type="button"
              className="ob-a-fleet-main"
              onClick={() => setPrimary(connection.id)}
              aria-label={`将 ${connection.label} 设为 Primary`}
            >
              <ConnectionGlyph kind={connection.kind} />
              <span className="ob-a-fleet-copy">
                <span className="ob-a-fleet-name">
                  {connection.label}
                  {connection.primary && <Star size={9} fill="currentColor" />}
                </span>
                <span>{connection.host}</span>
              </span>
              <StatusBadge status={connection.status} />
            </button>
            {connection.id === lastUsedId && <span className="ob-a-last-used">last used</span>}
          </div>
        ))}
      </div>

      <div className="ob-a-fleet-profiles">
        <SectionLabel>PROFILE READINESS</SectionLabel>
        {(connections.find((connection) => connection.id === primaryId)?.profiles ?? []).map(
          (profile) => (
            <div className="ob-profile-line" key={profile.id}>
              <span>
                <b>{profile.handle}</b>
                <em>{profile.id}</em>
              </span>
              <span className={cn("ob-readiness", `is-${profile.readiness}`)}>
                {profile.readiness === "eager"
                  ? "eager"
                  : profile.readiness === "first-use"
                    ? "first use"
                    : "parked"}
              </span>
            </div>
          ),
        )}
      </div>

      <div className="ob-a-fleet-foot">
        <SectionLabel>LAUNCH POLICY</SectionLabel>
        <div className="ob-segmented ob-segmented-wide" role="group" aria-label="启动连接策略">
          <button
            type="button"
            className={cn(launchMode === "primary" && "is-active")}
            onClick={() => setLaunchMode("primary")}
            aria-pressed={launchMode === "primary"}
          >
            Primary
          </button>
          <button
            type="button"
            className={cn(launchMode === "last-used" && "is-active")}
            onClick={() => setLaunchMode("last-used")}
            aria-pressed={launchMode === "last-used"}
          >
            Last used
          </button>
        </div>
        <p>
          下次启动会落到{" "}
          <b>
            {launchMode === "primary"
              ? connections.find((connection) => connection.primary)?.label ?? "This device"
              : connections.find((connection) => connection.id === lastUsedId)?.label ?? "VPS-1"}
          </b>
          。瞬时断线不会改道。
        </p>
      </div>
    </aside>
  );
}

function FleetPopover({ onClose }: { onClose: () => void }) {
  return (
    <div className="ob-a-fleet-popover" role="dialog" aria-label="连接舰队">
      <div className="ob-a-popover-head">
        <span>FLEET · 1280 收起态</span>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      <FleetRail onFleetToggle={onClose} />
    </div>
  );
}

function AFirstRun() {
  const { failureMeta, setScene, runAction } = useOnboarding();
  const localFailure = failureMeta.family === "local" && failureMeta.code !== "none";
  return (
    <div className="ob-a-first-run">
      <div className="ob-a-first-copy">
        <span className="ob-eyebrow">FIRST RUN · LOCAL FIRST</span>
        <h1>先让一台机器<br />接上这条线路。</h1>
        <p>
          Hermes Desktop 不打包运行时。它找到你已安装的 Hermes，自动 attach / ensure；
          找不到时，也不会偷偷安装。
        </p>
        <div className="ob-a-first-actions">
          {localFailure ? (
            <>
              <Button variant="primary" onClick={() => runAction(failureMeta.actions[0] ?? "choose_cli")}>
                {failureMeta.actions[0] === "choose_cli" ? "选择 Hermes CLI" : "修复 Local"}
                <ArrowRight size={12} />
              </Button>
              <Button variant="secondary" onClick={() => setScene("local-recovery")}>
                查看 attach / ensure
              </Button>
              <Button variant="quiet" onClick={() => setScene("add-remote")}>
                改连 Remote / SSH
                <ArrowRight size={11} />
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={() => setScene("empty-normal")}>
                打开安静桌面
                <ArrowRight size={12} />
              </Button>
              <Button variant="secondary" onClick={() => setScene("add-remote")}>
                添加 Remote
              </Button>
              <Button variant="quiet" onClick={() => setScene("add-ssh")}>
                添加 SSH host
              </Button>
            </>
          )}
        </div>
        <div className="ob-quiet-fact">
          <StatusDot tone="ok" />
          <span>4 个延期域没有首次运行入口；这里不会出现空 CTA。</span>
        </div>
      </div>

      <div className="ob-a-first-map" aria-label="首次运行路径">
        <div className="ob-a-route-map">
          <div className="ob-a-route-node is-you">
            <span>01</span>
            <b>YOU</b>
            <em>这台 Mac</em>
          </div>
          <span className="ob-a-route-connector" />
          <div className={cn("ob-a-route-node", localFailure ? "is-blocked" : "is-ready")}>
            <span>02</span>
            <b>LOCAL</b>
            <em>{localFailure ? failureMeta.code : "ensure ready"}</em>
          </div>
          <span className="ob-a-route-connector" />
          <div className="ob-a-route-node">
            <span>03</span>
            <b>CHAT</b>
            <em>720px column</em>
          </div>
        </div>
        <div className={cn("ob-a-first-note", localFailure && "is-warning")}>
          <div className="ob-a-note-icon">{localFailure ? <Terminal size={14} /> : <Check size={14} />}</div>
          <div>
            <b>{localFailure ? "本地运行时还没有就绪" : "本地运行时可用"}</b>
            <p>
              {localFailure
                ? "右侧 docket 显示失败分类与全部允许的修复动作。你也可以先加别的机器。"
                : "Local 是 App-managed，不可移除；其他连接按 last-used 或 Primary 策略加入。"}
            </p>
          </div>
        </div>
        <div className="ob-a-alternate">
          <span>OR START ELSEWHERE</span>
          <button type="button" onClick={() => setScene("add-remote")}>
            <Link2 size={13} />
            Remote HTTP(S)
          </button>
          <button type="button" onClick={() => setScene("add-ssh")}>
            <Terminal size={13} />
            SSH host
          </button>
        </div>
      </div>
    </div>
  );
}

function ALocalRecovery() {
  const {
    failure,
    failureMeta,
    restartAttempts,
    localRecovered,
    testStatus,
    setScene,
  } = useOnboarding();
  const steps = [
    {
      code: "discover",
      title: "定位 Hermes CLI",
      detail: "登录 shell PATH → 常见目录；找不到就 blocked。",
      state:
        failure === "hermes_not_found" || failure === "cli_not_executable"
          ? "blocked"
          : "done",
    },
    {
      code: "ensure",
      title: "gateway ensure --json",
      detail: "60s deadline；没有 service 时启动 detached unmanaged owner。",
      state: failure === "gateway_start_failed" && !localRecovered ? "blocked" : "done",
    },
    {
      code: "version",
      title: "code_sha 校验",
      detail:
        failure === "code_sha_mismatch"
          ? localRecovered
            ? `已完成同一 owner 的受控 restart ${restartAttempts}/1；code_sha 已一致。`
            : `同一 owner 受控 restart ${restartAttempts}/1；仍不一致则保持 blocked。`
          : "client / install / endpoint 三方一致。",
      state: failure === "code_sha_mismatch" && !localRecovered ? "blocked" : "done",
    },
    {
      code: "transport",
      title: "host-scope interactive",
      detail:
        failure === "socket_permission_denied"
          ? "control socket 权限不安全；不绕过、不改 attach 路径。"
          : failure === "service_unhealthy"
            ? "service 不健康；只 attach，不 reinstall / stop。"
            : "可用时共享一条 WS；否则回退 per-Profile ticket。",
      state:
        failure === "socket_permission_denied" || failure === "service_unhealthy"
          ? "blocked"
          : "done",
    },
    {
      code: "ready",
      title: "HTTP + WS ready",
      detail: "ticket 单次、30s、仅 Main 内存；每次重连重新 mint。",
      state:
        failureMeta.family === "local" && failure !== "none" && !localRecovered
          ? "pending"
          : testStatus === "passed"
            ? "done"
            : "pending",
    },
  ];
  return (
    <div className="ob-a-recovery">
      <div className="ob-a-page-head">
        <span className="ob-eyebrow">LOCAL BACKEND · ATTACH / ENSURE</span>
        <h1>把本地运行时和安全边界对齐。</h1>
        <p>
          这是一条有边界的恢复链：App 只 attach / ensure，不拥有 owner 的结束权，也不会自动安装。
        </p>
      </div>
      <div className="ob-a-timeline">
        {steps.map((step, index) => (
          <div className={cn("ob-a-step", `is-${step.state}`)} key={step.code}>
            <span className="ob-a-step-index">{String(index + 1).padStart(2, "0")}</span>
            <div className="ob-a-step-copy">
              <div>
                <b>{step.title}</b>
                <span>{step.code}</span>
              </div>
              <p>{step.detail}</p>
            </div>
            <span className="ob-a-step-state">
              {step.state === "done" ? "done" : step.state === "blocked" ? "blocked" : "waiting"}
            </span>
          </div>
        ))}
      </div>
      <div className="ob-a-recovery-foot">
        <div>
          <Info size={13} />
          <span>ticket、socket 路径、原始 stderr 不进入 Renderer；诊断只在用户主动触发时生成。</span>
        </div>
        <Button variant="quiet" onClick={() => setScene("startup")}>
          下一张：启动选择
          <ArrowRight size={11} />
        </Button>
      </div>
    </div>
  );
}

function TestTrail() {
  const {
    formKind,
    testStatus,
    testMessage,
    testsRun,
    registryWrites,
    oauthStatus,
  } = useOnboarding();
  return (
    <section className="ob-a-test-trail">
      <SectionLabel>
        {formKind === "ssh" ? "PROBE / TEST TRAIL" : "HTTP / WS TEST TRAIL"}
      </SectionLabel>
      <div className="ob-a-test-row">
        <span className={cn("ob-test-dot", testStatus === "passed" ? "is-ok" : testStatus === "failed" ? "is-error" : testStatus === "running" ? "is-running" : "")} />
        <div>
          <b>
            {testStatus === "idle"
              ? "尚未 Test"
              : testStatus === "running"
                ? "Test 运行中"
                : testStatus === "passed"
                  ? "Test 通过"
                  : "Test 失败"}
          </b>
          <p>{testMessage}</p>
        </div>
      </div>
      <dl className="ob-a-test-facts">
        <div><dt>tests</dt><dd>{testsRun}</dd></div>
        <div><dt>registry writes</dt><dd>{registryWrites}</dd></div>
        <div><dt>oauth</dt><dd>{oauthStatus}</dd></div>
      </dl>
      <div className="ob-a-test-boundary">
        <KeyRound size={12} />
        <span>Test 是探测，不是提交。已保存 token 永不出现在此。</span>
      </div>
    </section>
  );
}

function AddKindTabs() {
  const { formKind, setScene } = useOnboarding();
  return (
    <div className="ob-a-kind-tabs" role="tablist" aria-label="连接类型">
      <button
        type="button"
        role="tab"
        aria-selected={formKind === "remote"}
        className={cn(formKind === "remote" && "is-active")}
        onClick={() => setScene("add-remote")}
      >
        <Link2 size={13} />
        Remote HTTP(S)
        <span>token / OAuth</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={formKind === "ssh"}
        className={cn(formKind === "ssh" && "is-active")}
        onClick={() => setScene("add-ssh")}
      >
        <Terminal size={13} />
        SSH host
        <span>tickets --serve</span>
      </button>
    </div>
  );
}

function DuplicateInline() {
  const { duplicateVisible, failure, connections, runAction } = useOnboarding();
  const existing = connections.find((connection) => connection.kind === "remote" && connection.id === "vps1");
  if (!duplicateVisible) return null;
  return (
    <IssueBanner
      tone="warning"
      code={failure}
      action={
        <div className="ob-inline-actions">
          <button type="button" onClick={() => runAction("edit_label")}>改设备名</button>
          <button type="button" onClick={() => runAction("edit_target")}>改目标</button>
        </div>
      }
    >
      <b>写入被拒绝。</b> 既有连接：{existing?.label ?? "VPS-1"} · {existing?.host ?? "vps1.hermes.run"} ·
      凭据 {existing?.hasToken ? "已保存（隐藏）" : "无"}。当前表单草稿仍保留。
    </IssueBanner>
  );
}

function ARemoteForm() {
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
  } = useOnboarding();
  if (formKind !== "remote") return null;
  return (
    <div className="ob-a-form-wrap">
      <div className="ob-a-page-head">
        <span className="ob-eyebrow">NEW CONNECTION · REMOTE HTTP(S)</span>
        <h1>添加 Remote Gateway</h1>
        <p>输入、Test、保存被刻意分开。Test 不写 registry；Save 才提交连接与凭据。</p>
      </div>
      <AddKindTabs />
      <form
        className="ob-a-form"
        onSubmit={(event) => {
          event.preventDefault();
          saveForm();
        }}
      >
        <div className="ob-a-form-grid">
          <Field label="Device name" hint="大小写不敏感唯一；最长 64 字符">
            <input
              value={form.label}
              onChange={(event) => setForm({ label: event.target.value })}
              placeholder="VPS-2"
              autoComplete="off"
            />
          </Field>
          <Field label="Gateway URL" hint="HTTP(S) base；语义化 URL 参与身份查重">
            <input
              value={form.target}
              onChange={(event) => setForm({ target: event.target.value })}
              placeholder="https://vps2.hermes.run"
              autoComplete="off"
            />
          </Field>
        </div>

        <fieldset className="ob-auth-choice">
          <legend>Authentication</legend>
          <button
            type="button"
            className={cn(form.authMode === "session-token" && "is-active")}
            onClick={() => setForm({ authMode: "session-token" })}
            aria-pressed={form.authMode === "session-token"}
          >
            <KeyRound size={14} />
            <span>
              <b>Session token</b>
              <em>提交一次；保存后不回填</em>
            </span>
          </button>
          <button
            type="button"
            className={cn(form.authMode === "oauth" && "is-active")}
            onClick={() => setForm({ authMode: "oauth" })}
            aria-pressed={form.authMode === "oauth"}
          >
            <CircleDot size={14} />
            <span>
              <b>Native OAuth / PKCE</b>
              <em>Main 打开系统浏览器</em>
            </span>
          </button>
        </fieldset>

        {form.authMode === "session-token" ? (
          <div className="ob-a-token-row">
            <Field label="Session token" hint="仅提交给 Main；Renderer 不展示已保存值">
              <input
                type="password"
                value={form.token}
                onChange={(event) => setForm({ token: event.target.value })}
                placeholder="tok_••••••••"
                autoComplete="new-password"
                spellCheck={false}
              />
            </Field>
            <div className="ob-a-token-note">
              <KeyRound size={13} />
              <span>
                已保存 = <b>{savedForm?.tokenStored ? "有，Main only" : "无"}</b>
                <br />
                Renderer 永远不读取 token 字节。
              </span>
            </div>
          </div>
        ) : (
          <div className="ob-a-oauth">
            <div>
              <span className="ob-eyebrow">NATIVE HANDSHAKE</span>
              <h3>
                {oauthStatus === "idle"
                  ? "准备好再打开系统浏览器"
                  : oauthStatus === "waiting"
                    ? "等待 loopback 回调…"
                    : "已授权（模拟）"}
              </h3>
              <p>不会在 Renderer 中显示 access token、refresh token 或原始回调 URL。</p>
            </div>
            {oauthStatus === "idle" && (
              <Button variant="primary" onClick={startOAuth}>
                开始 OAuth
                <ExternalArrow />
              </Button>
            )}
            {oauthStatus === "waiting" && (
              <div className="ob-oauth-waiting">
                <span className="ob-wait-dot" />
                <Button variant="secondary" onClick={finishOAuth}>模拟完成授权</Button>
                <Button variant="quiet" onClick={cancelOAuth}>取消</Button>
              </div>
            )}
            {oauthStatus === "granted" && (
              <span className="ob-oauth-granted"><Check size={13} /> hasToken = true · bytes in Main</span>
            )}
          </div>
        )}

        <DuplicateInline />
        {savedForm && (
          <IssueBanner tone="success" code="saved">
            <b>{savedForm.label}</b> 已写入模拟 registry · {savedForm.authMode} ·
            {savedForm.tokenStored ? " token 保存在 Main" : " 无明文 token 留在表单"}
          </IssueBanner>
        )}
        {failure === "token_sync_failed" && (
          <IssueBanner tone="warning" code="token_sync_failed">
            连接写入成功，token 对账失败。按钮只触发重新授权，不回填 secret。
          </IssueBanner>
        )}
        <div className="ob-a-form-foot">
          <div>
            <span>TEST</span>
            <p>{testMessage}</p>
          </div>
          <div className="ob-a-form-actions">
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
              保存连接
              <ArrowRight size={11} />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ExternalArrow() {
  return <ArrowRight size={11} className="ob-dash-arrow" />;
}

function ASshForm() {
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
  } = useOnboarding();
  if (formKind !== "ssh") return null;
  return (
    <div className="ob-a-form-wrap">
      <div className="ob-a-page-head">
        <span className="ob-eyebrow">NEW CONNECTION · SSH</span>
        <h1>添加 SSH host</h1>
        <p>先 probe 目标与 Hermes capability；Test 只读探测，不改写 registry。</p>
      </div>
      <AddKindTabs />
      <form
        className="ob-a-form"
        onSubmit={(event) => {
          event.preventDefault();
          saveForm();
        }}
      >
        <div className="ob-a-form-grid">
          <Field label="Device name" hint="唯一设备名">
            <input
              value={form.label}
              onChange={(event) => setForm({ label: event.target.value })}
              placeholder="Build box"
              autoComplete="off"
            />
          </Field>
          <Field label="SSH target" hint="user@host:port；身份键不包含 keyPath">
            <input
              value={form.target}
              onChange={(event) => setForm({ target: event.target.value })}
              placeholder="omer@build.lan:22"
              autoComplete="off"
            />
          </Field>
          <Field label="Remote Profile" hint="默认 Profile 会在首次激活后 eager">
            <input
              value={form.remoteProfile}
              onChange={(event) => setForm({ remoteProfile: event.target.value })}
              placeholder="default"
              autoComplete="off"
            />
          </Field>
          <Field label="Authentication" hint="复用系统 SSH agent / known_hosts">
            <input value="SSH agent · system known_hosts" readOnly aria-readonly="true" />
          </Field>
        </div>

        <div className="ob-a-ssh-paths">
          <div className={cn("ob-a-ssh-path", testStatus === "passed" && "is-active")}>
            <span><Terminal size={13} /> tickets --serve</span>
            <b>首选</b>
            <p>可交互 ticket、共享多 Profile WebSocket；每次连接重新 mint。</p>
          </div>
          <div className={cn("ob-a-ssh-path", failure === "ssh_test_failed" && "is-blocked")}>
            <span><Server size={13} /> legacy attach-only</span>
            <b>降级</b>
            <p>仅 per-Profile ticket；接受 owner 可能 idle exit，不伪装 always-connected。</p>
          </div>
        </div>

        {failure === "ssh_test_failed" && (
          <IssueBanner
            tone="warning"
            code="ssh_test_failed"
            action={
              <button
                type="button"
                className="ob-inline-action"
                onClick={() => {
                  setForm({ target: "omer@build.lan:2222" });
                }}
              >
                填充新 target
              </button>
            }
          >
            <b>Test 失败，表单未丢。</b> 已保留 {form.label} / {form.target} / @{form.remoteProfile}；
            registry writes 仍为 0。
          </IssueBanner>
        )}
        {savedForm && (
          <IssueBanner tone="success" code="saved">
            <b>{savedForm.label}</b> 已保存为 SSH 连接；host key 与 agent 仍由系统策略负责。
          </IssueBanner>
        )}

        <div className="ob-a-form-foot">
          <div>
            <span>TEST</span>
            <p>{testMessage}</p>
          </div>
          <div className="ob-a-form-actions">
            <Button variant="secondary" onClick={() => runTest("ssh")} disabled={testStatus === "running"}>
              Test SSH
            </Button>
            <Button variant="primary" type="submit" disabled={testStatus !== "passed"}>
              保存连接
              <ArrowRight size={11} />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function AConflicts() {
  const {
    connections,
    failure,
    failureMeta,
    conflictResolved,
    registryRepaired,
    runAction,
  } = useOnboarding();
  const invalid = connections.filter((connection) => connection.status === "invalid");
  const tokenIssue = connections.find((connection) => connection.issue === "token_sync_failed");
  return (
    <div className="ob-a-conflicts">
      <div className="ob-a-page-head">
        <span className="ob-eyebrow">SHARED REGISTRY · CONFLICT DESK</span>
        <h1>冲突不是垃圾桶，是待解释的事实。</h1>
        <p>
          canonical 条目来自文件顺序；重复项保留、不拨号。任何删除都必须由你显式做出。
        </p>
      </div>
      <div className="ob-a-issue-stack">
        <div className="ob-a-issue-head">
          <div>
            <span className="ob-eyebrow">ISSUES</span>
            <b>{failureMeta.family === "registry" && failure !== "none" ? 2 : 1} open</b>
          </div>
          <button type="button" onClick={() => runAction("export_safe_summary")}>
            <Wrench size={11} />
            导出脱敏摘要
          </button>
        </div>
        <div className="ob-a-issue-row is-canonical">
          <span className="ob-issue-order">01</span>
          <div>
            <b>Homelab</b>
            <span>canonical · homelab.lan · tickets --serve</span>
          </div>
          <span className="ob-issue-state">通过</span>
        </div>
        {invalid.map((entry) => (
          <div className="ob-a-issue-row is-invalid" key={entry.id}>
            <span className="ob-issue-order">02</span>
            <div>
              <b>{entry.label}</b>
              <span>{entry.note} · secret hidden</span>
            </div>
            <span className="ob-issue-state">保留 / 不拨号</span>
          </div>
        ))}
        {failure === "registry_corrupt" && (
          <div className={cn("ob-a-registry-blocked", registryRepaired && "is-repaired")}>
            <span className="ob-eyebrow">{registryRepaired ? "REPAIRED" : "READ DEGRADED"}</span>
            <b>{registryRepaired ? "canonical v2 已重建（模拟）" : "registry JSON 无法解析"}</b>
            <p>last-known snapshot 保留；watcher 和 flush 不会自动修复。</p>
            {!registryRepaired && (
              <Button variant="primary" onClick={() => runAction("repair_registry")}>
                备份并修复
              </Button>
            )}
          </div>
        )}
        {failure === "registry_unsupported" && (
          <div className="ob-a-registry-blocked">
            <span className="ob-eyebrow">READ ONLY</span>
            <b>检测到更高版本 registry</b>
            <p>不会用旧 schema 覆盖。你可以更新客户端，或先导出安全摘要。</p>
            <Button variant="secondary" onClick={() => runAction("open_update_docs")}>
              查看更新说明
            </Button>
          </div>
        )}
        {failure === "token_sync_failed" && tokenIssue && (
          <div className="ob-a-registry-blocked is-token">
            <span className="ob-eyebrow">TOKEN SYNC WARNING</span>
            <b>{tokenIssue.label} · 需要重新授权</b>
            <p>连接已写成功；token 对账失败不影响连接存在性。</p>
            <Button variant="secondary" onClick={() => runAction("reauthorize")}>
              重新授权
            </Button>
          </div>
        )}
      </div>
      <div className="ob-a-conflict-decision">
        <div>
          <span className="ob-eyebrow">DECISION</span>
          <h3>{conflictResolved ? "canonical 已保留（模拟）" : "你想怎样处理重复项？"}</h3>
          <p>
            {conflictResolved
              ? "重复项仍在外部文件中，只是不参与拨号。没有静默删除。"
              : "保留 canonical 不删除任何数据；解决冲突只隔离拨号，并留下可审计摘要。"}
          </p>
        </div>
        <div className="ob-a-conflict-actions">
          <Button variant="primary" onClick={() => runAction("keep_canonical")}>
            保留 canonical
          </Button>
          <Button variant="secondary" onClick={() => runAction("resolve_conflict")}>
            隔离重复项
          </Button>
          <Button variant="quiet" onClick={() => runAction("export_safe_summary")}>
            导出摘要
          </Button>
        </div>
      </div>
    </div>
  );
}

function AStartup() {
  const { connections, launchMode, setLaunchMode, primaryId, lastUsedId, setPrimary } = useOnboarding();
  const primary = routeTarget(connections, primaryId);
  const last = connections.find((connection) => connection.id === lastUsedId);
  const target = launchMode === "primary" ? primary : last;
  return (
    <div className="ob-a-startup">
      <div className="ob-a-page-head">
        <span className="ob-eyebrow">STARTUP · PRIMARY / LAST-USED</span>
        <h1>启动落位必须是可见的选择。</h1>
        <p>Primary 是显式默认；last-used 是最近成功使用的 Scope。二者都不是对连接健康的猜测。</p>
      </div>
      <div className="ob-a-startup-grid">
        <section className="ob-a-startup-policy">
          <SectionLabel>POLICY</SectionLabel>
          <button
            type="button"
            className={cn("ob-a-policy-row", launchMode === "primary" && "is-active")}
            onClick={() => setLaunchMode("primary")}
          >
            <span className="ob-policy-radio">{launchMode === "primary" && <i />}</span>
            <span>
              <b>启动时打开 Primary</b>
              <em>{primary?.label ?? "This device"} · 明确默认</em>
            </span>
            <Star size={12} />
          </button>
          <button
            type="button"
            className={cn("ob-a-policy-row", launchMode === "last-used" && "is-active")}
            onClick={() => setLaunchMode("last-used")}
          >
            <span className="ob-policy-radio">{launchMode === "last-used" && <i />}</span>
            <span>
              <b>回到 last-used</b>
              <em>{last?.label ?? "VPS-1"} · 最近成功使用的 Scope</em>
            </span>
            <CircleDot size={12} />
          </button>
          <div className="ob-a-next-launch">
            <span>NEXT LAUNCH</span>
            <b>{target?.label}</b>
            <span>{target?.profiles[0]?.handle ?? "@default"} · {target?.kind}</span>
          </div>
        </section>

        <section className="ob-a-primary-list">
          <SectionLabel action={<span className="ob-mini-count">{connections.filter((row) => row.status === "ready").length} ready</span>}>
            CONNECTIONS
          </SectionLabel>
          {connections.map((connection) => (
            <div className={cn("ob-a-primary-row", connection.primary && "is-primary")} key={connection.id}>
              <button
                type="button"
                onClick={() => setPrimary(connection.id)}
                aria-label={`将 ${connection.label} 设为 Primary`}
                className="ob-a-primary-toggle"
              >
                {connection.primary ? <Star size={12} fill="currentColor" /> : <Star size={12} />}
              </button>
              <div className="ob-a-primary-copy">
                <span><b>{connection.label}</b><KindBadge kind={connection.kind} /></span>
                <em>{connection.host} · 上次 {connection.lastUsed}</em>
              </div>
              <div className="ob-a-profile-dots" aria-label={`${connection.profiles.length} profiles`}>
                {connection.profiles.map((profile) => (
                  <span key={profile.id} className={`is-${profile.readiness}`} title={`${profile.handle} · ${profile.readiness}`} />
                ))}
              </div>
              <StatusBadge status={connection.status} />
            </div>
          ))}
        </section>
      </div>
      <div className="ob-a-startup-note">
        <Info size={13} />
        <span>
          多 Profile 首次就绪：所选 Gateway 的 default Profile eager；其余 Profile 在第一次激活后常连。
          瞬时 reconnecting 不会改变 Scope。
        </span>
      </div>
    </div>
  );
}

function EmptyComposer() {
  const {
    scene,
    draft,
    setDraft,
    submitComposer,
    composerSubmitted,
  } = useOnboarding();
  return (
    <div className="ob-a-composer-wrap">
      <div className="ob-a-composer-context">
        <StatusDot tone="ok" />
        <span>将从 <b>Homelab</b> · <b>@research</b> 执行</span>
        <span>LOCAL DRAFT · MAIN STORE</span>
      </div>
      <div className="ob-a-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="原型 composer"
          rows={2}
          placeholder="问 Hermes，或键入 / 和 @…"
        />
        <div className="ob-a-composer-foot">
          <span>{scene === "empty-draft" ? "草稿已保留；不会自动创建 Session" : "无草稿时才显示空态"}</span>
          <button type="button" aria-label="发送消息" onClick={submitComposer}>
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
      {composerSubmitted && (
        <p className="ob-a-composer-note">
          原型：消息留在本地状态，没有自动 <code>session.create</code>，也没有发送。
        </p>
      )}
    </div>
  );
}

function AEmpty() {
  const {
    scene,
    connections,
    failureMeta,
    note,
    runAction,
    setScene,
    draft,
  } = useOnboarding();
  const onboarding = scene === "empty-onboarding";
  const fallback = scene === "scope-banner";
  const hasDraft = scene === "empty-draft";
  return (
    <div className={cn("ob-a-empty", hasDraft && "has-draft")}>
      <div className="ob-a-empty-stage">
        {fallback && (
          <div className="ob-a-route-banner" role="status">
            <span>ROUTE CHANGED</span>
            <p>
              原 Session 已被移除；已按最近存活祖先回退到 <b>Homelab / @ops</b>。
              聊天保持只读，输入区仍可用。
            </p>
            <button type="button" onClick={() => note("原型：banner dismissed，不改变 active chat")}>
              知道了
            </button>
          </div>
        )}
        {hasDraft ? (
          <div className="ob-a-draft-state">
            <div className="ob-a-draft-mark"><CircleDot size={22} /></div>
            <span className="ob-eyebrow">UNSENT LOCAL DRAFT</span>
            <h1>草稿还在这里。</h1>
            <p>
              有未落库草稿，所以这里不是空态。composer 预填了上次输入；不会自动创建 Session，
              也不会把草稿送进 Gateway queue。
            </p>
            <div className="ob-a-draft-preview">
              <span>ACTIVE DRAFT · {draft.length} chars</span>
              <p>{draft || "（空）"}</p>
            </div>
          </div>
        ) : (
          <div className="ob-a-welcome">
            <div className="ob-a-welcome-mark">
              <span />
              <HermesMarkLite />
            </div>
            <span className="ob-eyebrow">{onboarding ? "ONBOARDING EMPTY" : "NORMAL EMPTY"}</span>
            <h1>{onboarding ? "还没有可用的连接。" : "安静地去问。"}</h1>
            <p>
              {onboarding
                ? "所有连接都不可用。先修复 Local，或添加一台能访问的 Remote / SSH host。空态不会变成能力目录。"
                : "告诉 Hermes 你要完成什么。第一条消息之后，这里只留下对话与必要的工具轨迹。"}
            </p>
            {!onboarding && (
              <div className="ob-a-empty-actions">
                <button type="button" onClick={() => setScene("empty-draft")}>
                  <span>继续最近 Session</span>
                  <ArrowRight size={12} />
                </button>
                <button type="button" onClick={() => note("原型：能力目录会走 ⌘K，不在空态铺开。")}>
                  <span>能力目录</span>
                  <kbd>⌘K</kbd>
                </button>
                <button type="button" onClick={() => note("原型：Workspace 从右侧抽屉打开。")}>
                  <span>打开 Workspace</span>
                  <span>→</span>
                </button>
              </div>
            )}
            {onboarding && (
              <div className="ob-a-empty-actions">
                <button type="button" onClick={() => runAction("retry")}>
                  <span>修复 Local</span>
                  <ArrowRight size={12} />
                </button>
                <button type="button" onClick={() => setScene("add-remote")}>
                  <span>添加 Remote</span>
                  <ArrowRight size={12} />
                </button>
                <button type="button" onClick={() => setScene("add-ssh")}>
                  <span>添加 SSH</span>
                  <ArrowRight size={12} />
                </button>
              </div>
            )}
            <button
              type="button"
              className="ob-a-cron-hint"
              onClick={() => note("原型：Cron 状态会进入详情，不在空态铺开。")}
            >
              <span className={onboarding ? "is-warn" : ""} />
              <b>{onboarding ? "Cron 0 个计划 · 全部暂停" : "没有运行中的任务 · Cron 0 个计划"}</b>
              <em>查看 →</em>
            </button>
          </div>
        )}
        <EmptyComposer />
      </div>
      <div className="ob-a-empty-whisper">
        <span>{connections.filter((connection) => connection.status === "ready").length} ready</span>
        <span>{failureMeta.family === "local" && failureMeta.code !== "none" ? failureMeta.code : "scope stable"}</span>
        <span>4 延期域 · 无 CTA</span>
      </div>
    </div>
  );
}

function HermesMarkLite() {
  return (
    <svg viewBox="0 0 20 20" width="28" height="28" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.3 11.7c2.2-1.2 4.9-2.1 9.4-2.5M6.1 8.9l2.3-2.5M6.1 13.4l2.3 2.1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="12.6" cy="9.3" r="1.1" fill="currentColor" />
    </svg>
  );
}

function ADocket() {
  const {
    scene,
    failureMeta,
    connections,
    primaryId,
    launchMode,
    formKind,
    runTest,
    testsRun,
    registryWrites,
    testStatus,
  } = useOnboarding();
  const target = routeTarget(connections, primaryId);
  const localFailure = failureMeta.family === "local" && failureMeta.code !== "none";
  const isAdd = scene === "add-remote" || scene === "add-ssh";
  return (
    <aside className="ob-a-docket" aria-label="修复与连接 docket">
      <div className="ob-a-docket-head">
        <span className="ob-eyebrow">ROUTE DOCKET</span>
        <span className={cn("ob-docket-state", localFailure && "is-blocked")}>
          {localFailure ? failureMeta.state : "ready"}
        </span>
      </div>
      <div className="ob-a-docket-route">
        <span>YOU</span>
        <span className="ob-docket-rule" />
        <b>{target?.label ?? "UNSET"}</b>
        <span className="ob-docket-rule" />
        <span>{target?.profiles[0]?.handle ?? "@—"}</span>
      </div>

      {isAdd ? (
        <>
          <TestTrail />
          <div className="ob-a-docket-actions">
            <Button
              variant="secondary"
              onClick={() => runTest(formKind)}
              disabled={testStatus === "running"}
            >
              {formKind === "ssh" ? "Test SSH again" : "Test remote again"}
            </Button>
            <span>
              <b>{testsRun}</b> tests · <b>{registryWrites}</b> writes
            </span>
          </div>
          <FailureCallout compact />
          <div className="ob-a-docket-note">
            <KeyRound size={12} />
            <span>ticket 30s / 单次 / 只留 Main；OAuth 回调 URL 也不显示。</span>
          </div>
        </>
      ) : (
        <>
          {localFailure ? (
            <FailureCallout />
          ) : (
            <div className="ob-a-docket-ready">
              <div className="ob-a-docket-ready-head">
                <Check size={14} />
                <b>{scene === "empty-onboarding" ? "连接不可用" : "连接健康"}</b>
              </div>
              <p>
                {scene === "empty-onboarding"
                  ? "空的不是意图，是可达性。空态保留 3 个修复动作，不铺能力目录。"
                  : "route 和 composer 已就绪；空态不会在启动时自动创建 Session。"}
              </p>
              <dl>
                <div><dt>PRIMARY</dt><dd>{connections.find((row) => row.primary)?.label ?? target?.label}</dd></div>
                <div><dt>LAUNCH</dt><dd>{launchMode}</dd></div>
                <div><dt>PROFILES</dt><dd>{target?.profiles.length ?? 0} · eager default</dd></div>
              </dl>
            </div>
          )}

          {scene === "startup" && (
            <div className="ob-a-docket-primary">
              <SectionLabel>PRIMARY SOURCE</SectionLabel>
              <p>Primary 只影响启动偏好；不会让离线连接变成可用。</p>
              <span>{connections.find((connection) => connection.primary)?.label ?? "—"}</span>
            </div>
          )}

          {scene === "conflicts" && (
            <div className="ob-a-docket-primary">
              <SectionLabel>SAFE SUMMARY</SectionLabel>
              <FailureFacts />
              <p>原始 quarantined 条目与 token 字节均不跨桥；这里只显示原因、计数和修复入口。</p>
            </div>
          )}

          {!localFailure && scene !== "conflicts" && (
            <div className="ob-a-docket-cron" role="status">
              <span className="ob-docket-cron-dot" />
              <div>
                <b>No running work</b>
                <em>Cron 0 plans · last run 10:42</em>
              </div>
              <button type="button" onClick={() => runTest("local")}>status</button>
            </div>
          )}
        </>
      )}
      <footer className="ob-a-docket-foot">
        <span>SIMULATION</span>
        <span>no daemon · no credentials</span>
      </footer>
    </aside>
  );
}

function AMain() {
  const { scene } = useOnboarding();
  const [fleetOpen, setFleetOpen] = useState(false);
  const target = useOnboarding();
  const primary = routeTarget(target.connections, target.primaryId);
  return (
    <main className="ob-a-main">
      <header className="ob-a-route">
        <div className="ob-a-route-left">
          <button
            type="button"
            className="ob-a-fleet-trigger"
            onClick={() => setFleetOpen((open) => !open)}
            aria-expanded={fleetOpen}
          >
            <span>Fleet</span>
            <b>{target.connections.length}</b>
            <ChevronDown size={11} />
          </button>
          <span className="ob-a-route-origin"><StatusDot tone="ok" /> YOU</span>
          <span className="ob-a-route-line" />
          <b>{primary?.label ?? "UNSET"}</b>
          <span className="ob-a-route-line short" />
          <span>{primary?.profiles[0]?.handle ?? "@—"}</span>
          <KindBadge kind={primary?.kind ?? "local"} />
          <span className="ob-a-route-health">
            {primary?.status === "blocked" ? "blocked" : primary?.status === "degraded" ? "降级 · 86 ms" : "在线 · 24 ms"}
          </span>
        </div>
        <div className="ob-a-route-right">
          <span className="ob-a-route-step">{prototypeScenes[scene].eyebrow}</span>
          <button type="button" onClick={() => target.setScene("startup")}>Startup</button>
        </div>
      </header>
      {fleetOpen && <FleetPopover onClose={() => setFleetOpen(false)} />}
      <div className="ob-a-scroll">
        {scene === "first-run" && <AFirstRun />}
        {scene === "local-recovery" && <ALocalRecovery />}
        {scene === "add-remote" && <ARemoteForm />}
        {scene === "add-ssh" && <ASshForm />}
        {scene === "conflicts" && <AConflicts />}
        {scene === "startup" && <AStartup />}
        {(scene === "empty-normal" ||
          scene === "empty-onboarding" ||
          scene === "empty-draft" ||
          scene === "scope-banner") && <AEmpty />}
      </div>
      <footer className="ob-a-status">
        <span><StatusDot tone="ok" /> LOCAL OWNER · simulated</span>
        <span>720px conversation invariant</span>
        <span>Registry revision 12</span>
        <span className="ob-a-status-spacer" />
        <span>4 deferred domains · 0 false CTAs</span>
      </footer>
    </main>
  );
}

export function VariantA() {
  return (
    <div className="ob-root ob-variant-a">
      <ProtoTitlebar />
      <ScenarioBar />
      <div className="ob-a-shell">
        <FleetRail onFleetToggle={() => undefined} />
        <AMain />
        <ADocket />
      </div>
      {import.meta.env.DEV && <VariantSwitcher />}
    </div>
  );
}
