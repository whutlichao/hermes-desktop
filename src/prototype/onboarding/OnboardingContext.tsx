import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  actionLabels,
  connectionsForScene,
  defaultFailureFor,
  draftPreview,
  failureKeys,
  getFailure,
  sceneKeys,
  variantKeys,
  type ActionId,
  type Failure,
  type Scene,
  type SimConnection,
  type Variant,
} from "./model";

type LaunchMode = "primary" | "last-used";
type AddKind = "remote" | "ssh";
type RemoteAuthMode = "session-token" | "oauth";
type TestStatus = "idle" | "running" | "passed" | "failed";
type OAuthStatus = "idle" | "waiting" | "granted";

interface AddForm {
  kind: AddKind;
  label: string;
  target: string;
  remoteProfile: string;
  authMode: RemoteAuthMode;
  token: string;
}

export interface RepairResult {
  action: ActionId;
  title: string;
  body: string;
  lines: string[];
  tone: "default" | "success" | "warning";
}

export interface SavedForm {
  label: string;
  kind: AddKind;
  authMode: RemoteAuthMode | "ssh-key";
  tokenStored: boolean;
}

export interface OnboardingApi {
  variant: Variant;
  scene: Scene;
  failure: Failure;
  failureMeta: ReturnType<typeof getFailure>;
  connections: SimConnection[];
  primaryId: string;
  lastUsedId: string;
  launchMode: LaunchMode;
  form: AddForm;
  formKind: AddKind;
  testStatus: TestStatus;
  testMessage: string;
  testsRun: number;
  registryWrites: number;
  oauthStatus: OAuthStatus;
  savedForm: SavedForm | null;
  duplicateVisible: boolean;
  conflictResolved: boolean;
  registryRepaired: boolean;
  restartAttempts: number;
  localRecovered: boolean;
  draft: string;
  composerSubmitted: boolean;
  repairResult: RepairResult | null;
  toast: string | null;
  setVariant: (variant: Variant) => void;
  setScene: (scene: Scene) => void;
  setFailure: (failure: Failure) => void;
  setFormKind: (kind: AddKind) => void;
  setForm: (patch: Partial<AddForm>) => void;
  setPrimary: (id: string) => void;
  setLaunchMode: (mode: LaunchMode) => void;
  setDraft: (value: string) => void;
  runTest: (kind: AddKind | "local") => void;
  startOAuth: () => void;
  finishOAuth: () => void;
  cancelOAuth: () => void;
  saveForm: () => void;
  runAction: (action: ActionId) => void;
  closeRepairResult: () => void;
  submitComposer: () => void;
  dismissToast: () => void;
  note: (message: string) => void;
}

const OnboardingContext = createContext<OnboardingApi | null>(null);

interface Initial {
  variant: Variant;
  scene: Scene;
  failure: Failure;
}

function readInitial(): Initial {
  const params = new URLSearchParams(window.location.search);
  const variantParam = params.get("variant")?.toUpperCase();
  const sceneParam = params.get("scene");
  const failureParam = params.get("error");
  const variant = variantKeys.includes(variantParam as Variant)
    ? (variantParam as Variant)
    : "A";
  const scene = sceneKeys.includes(sceneParam as Scene) ? (sceneParam as Scene) : "first-run";
  const failure = failureKeys.includes(failureParam as Failure)
    ? (failureParam as Failure)
    : defaultFailureFor(scene);
  return { variant, scene, failure };
}

function initialForm(kind: AddKind): AddForm {
  return {
    kind,
    label: kind === "remote" ? "VPS-2" : "Build box",
    target: kind === "remote" ? "https://vps2.hermes.run" : "omer@build.lan:22",
    remoteProfile: "default",
    authMode: "session-token",
    token: "",
  };
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(readInitial, []);
  const [variant, setVariantState] = useState<Variant>(initial.variant);
  const [scene, setSceneState] = useState<Scene>(initial.scene);
  const [failure, setFailureState] = useState<Failure>(initial.failure);
  const [primaryId, setPrimaryIdState] = useState(
    initial.scene === "first-run" ? "local" : "homelab",
  );
  const [launchMode, setLaunchModeState] = useState<LaunchMode>("last-used");
  const [form, setFormState] = useState<AddForm>(() =>
    initialForm(initial.scene === "add-ssh" ? "ssh" : "remote"),
  );
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState("尚未 Test。Test 只做探测，不写 registry。");
  const [testsRun, setTestsRun] = useState(0);
  const [registryWrites, setRegistryWrites] = useState(0);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>("idle");
  const [savedForm, setSavedForm] = useState<SavedForm | null>(null);
  const [duplicateVisible, setDuplicateVisible] = useState(false);
  const [conflictResolved, setConflictResolved] = useState(false);
  const [registryRepaired, setRegistryRepaired] = useState(false);
  const [restartAttempts, setRestartAttempts] = useState(0);
  const [localRecovered, setLocalRecovered] = useState(false);
  const [draft, setDraftState] = useState(initial.scene === "empty-draft" ? draftPreview : "");
  const [composerSubmitted, setComposerSubmitted] = useState(false);
  const [repairResult, setRepairResult] = useState<RepairResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const failureMeta = getFailure(failure);
  const lastUsedId = "vps1";

  const connections = useMemo(() => {
    return connectionsForScene(scene, failure).map((connection) => ({
      ...connection,
      primary: connection.id === primaryId,
      status:
        connection.id === "local" && localRecovered
          ? "ready"
          : connection.id === "local" && registryRepaired && failure === "registry_corrupt"
            ? "ready"
            : connection.status,
    }));
  }, [scene, failure, primaryId, localRecovered, registryRepaired]);

  const notify = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", variant);
    url.searchParams.set("scene", scene);
    url.searchParams.set("error", failure);
    url.searchParams.set("prototype", "1");
    window.history.replaceState(null, "", url);
  }, [variant, scene, failure]);

  useEffect(() => {
    document.title = `Hermes Desktop — onboarding prototype ${variant} · ${scene}`;
  }, [variant, scene]);

  const resetTransient = useCallback(
    (nextScene: Scene, nextFailure: Failure) => {
      setFailureState(nextFailure);
      setSceneState(nextScene);
      setTestStatus("idle");
      setTestMessage("尚未 Test。Test 只做探测，不写 registry。");
      setOauthStatus("idle");
      setSavedForm(null);
      setDuplicateVisible(false);
      setConflictResolved(false);
      setRegistryRepaired(false);
      setRestartAttempts(0);
      setLocalRecovered(false);
      setComposerSubmitted(false);
      setRepairResult(null);
      setPrimaryIdState(nextScene === "first-run" ? "local" : "homelab");
      setFormState(initialForm(nextScene === "add-ssh" ? "ssh" : "remote"));
      setDraftState(nextScene === "empty-draft" ? draftPreview : "");
      if (nextFailure !== "ssh_test_failed") {
        setTestsRun(0);
        setRegistryWrites(0);
      }
    },
    [],
  );

  const setVariant = useCallback((next: Variant) => {
    setVariantState(next);
  }, []);

  const setScene = useCallback(
    (next: Scene) => {
      resetTransient(next, defaultFailureFor(next));
    },
    [resetTransient],
  );

  const setFailure = useCallback((next: Failure) => {
    setFailureState(next);
    setTestStatus("idle");
    setTestMessage("尚未 Test。Test 只做探测，不写 registry。");
    setDuplicateVisible(false);
    setConflictResolved(false);
    setRegistryRepaired(false);
    setRestartAttempts(0);
    setLocalRecovered(false);
    setRepairResult(null);
  }, []);

  const setFormKind = useCallback((kind: AddKind) => {
    setFormState(initialForm(kind));
    setTestStatus("idle");
    setTestMessage("尚未 Test。Test 只做探测，不写 registry。");
    setOauthStatus("idle");
    setSavedForm(null);
    setDuplicateVisible(false);
  }, []);

  const setForm = useCallback((patch: Partial<AddForm>) => {
    setFormState((current) => ({ ...current, ...patch }));
    setTestStatus("idle");
    setSavedForm(null);
    setDuplicateVisible(false);
  }, []);

  const setPrimary = useCallback(
    (id: string) => {
      setPrimaryIdState(id);
      notify(`Primary 已切换（模拟）· 启动策略${launchMode === "primary" ? "会落到这里" : "仍按 last-used"}`);
    },
    [launchMode, notify],
  );

  const setLaunchMode = useCallback((mode: LaunchMode) => {
    setLaunchModeState(mode);
    setRepairResult(null);
  }, []);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    setComposerSubmitted(false);
  }, []);

  const runTest = useCallback(
    (kind: AddKind | "local") => {
      setTestsRun((current) => current + 1);
      setTestStatus("running");
      setTestMessage(
        kind === "local"
          ? "正在执行 ensure，并探测 host-scope interactive…"
          : kind === "ssh"
            ? "正在 SSH probe，检查 tickets --serve…"
            : "正在测试 HTTP 与 WebSocket 两条腿…",
      );
      window.setTimeout(() => {
        const failed =
          (kind === "ssh" && failure === "ssh_test_failed") ||
          (kind === "local" && failureMeta.family === "local" && failure !== "none") ||
          (kind === "remote" && failure === "token_sync_failed");
        if (failed) {
          setTestStatus("failed");
          setTestMessage(
            kind === "ssh"
              ? "Test 失败 · ticket 面未通过；表单草稿已保留，registry 未写入。"
              : kind === "remote"
                ? "Test 失败 · 凭据过期；连接未写入，输入仍留在当前表单。"
                : `${failureMeta.code} · 状态保持 blocked；未自动重试或安装。`,
          );
        } else {
          setTestStatus("passed");
          setTestMessage(
            kind === "ssh"
              ? "Test 通过 · tickets --serve 可用；registry writes 仍为 0。"
              : kind === "remote"
                ? "Test 通过 · HTTP 200 / WS open；未持久化任何明文 token。"
                : "ensure 完成 · HTTP + WS ready；ticket 只留 Main 内存。",
          );
        }
      }, 700);
    },
    [failure, failureMeta.code, failureMeta.family],
  );

  const startOAuth = useCallback(() => {
    setOauthStatus("waiting");
    setRepairResult({
      action: "reauthorize",
      title: "Native OAuth / PKCE 握手（模拟）",
      body: "Main 打开系统浏览器并监听本机 loopback。Renderer 只看到等待与授权结果，不接触 token、cookie 或 refresh secret。",
      lines: ["callback: loopback (site suppressed)", "token bytes: Main only", "renderer state: waiting"],
      tone: "default",
    });
  }, []);

  const finishOAuth = useCallback(() => {
    setOauthStatus("granted");
    setTestStatus("idle");
    setTestMessage("OAuth 已授权（模拟）· token set 仅交给 Main；Renderer 只收到 hasToken=true。");
    setRepairResult(null);
    notify("Native OAuth 已授权（模拟）· 明文 token 未进入 Renderer");
  }, [notify]);

  const cancelOAuth = useCallback(() => {
    setOauthStatus("idle");
    setTestMessage("OAuth 已取消；没有写入 registry 或 token 文件。");
    setRepairResult(null);
  }, []);

  const saveForm = useCallback(() => {
    if (failure === "duplicate_identity" || failure === "duplicate_label") {
      setDuplicateVisible(true);
      setRegistryWrites(0);
      setRepairResult(null);
      notify("写入被拒绝 · registry 保持不变");
      return;
    }
    if (form.kind === "ssh" && testStatus !== "passed") {
      setTestMessage("先通过 Test 再保存；Test 本身不会写 registry。");
      return;
    }
    const tokenStored =
      form.kind === "remote" && form.authMode === "session-token" && form.token.length > 0;
    setSavedForm({
      label: form.label,
      kind: form.kind,
      authMode: form.kind === "ssh" ? "ssh-key" : form.authMode,
      tokenStored,
    });
    setRegistryWrites(1);
    setFormState((current) => ({ ...current, token: "" }));
    setTestMessage(
      failure === "token_sync_failed"
        ? "连接已提交，但 token 对账失败（模拟）；需要重新授权。"
        : tokenStored
          ? "已保存 · token 仅由 Main 保存；表单里已清空。"
          : "已保存连接（模拟）；registry revision +1。",
    );
    notify(
      failure === "token_sync_failed"
        ? "连接写入成功 · token_sync_failed warning"
        : "连接已写入模拟 registry",
    );
  }, [failure, form, notify, testStatus]);

  const runAction = useCallback(
    (action: ActionId) => {
      if (action === "switch_remote") {
        resetTransient("add-remote", "none");
        return;
      }
      if (action === "switch_ssh") {
        resetTransient("add-ssh", "ssh_test_failed");
        return;
      }
      if (action === "edit_target" || action === "edit_label") {
        setRepairResult({
          action,
          title: action === "edit_target" ? "修改目标，不覆盖既有连接" : "修改设备名，不覆盖既有连接",
          body: "表单草稿仍保留在当前 Renderer 内。提交前会重新做身份与 label 唯一性校验。",
          lines: [
            action === "edit_target" ? "identity check: on next save" : "label check: case-insensitive",
            "existing connection: untouched",
            "plaintext token: never backfilled",
          ],
          tone: "default",
        });
        return;
      }
      if (action === "keep_canonical" || action === "resolve_conflict") {
        setConflictResolved(true);
        setRepairResult({
          action,
          title: action === "resolve_conflict" ? "冲突条目已隔离（模拟）" : "保留 canonical 条目",
          body:
            action === "resolve_conflict"
              ? "重复项仍保留在外部文件中，但不参与拨号；后续写入按 revision 重新对账。"
              : "Homelab 继续作为 canonical。外部重复条目仍原样保留，未执行删除。",
          lines: ["canonical: Homelab", "duplicate dial: disabled", "raw entry: Main only"],
          tone: "success",
        });
        return;
      }
      if (action === "repair_registry") {
        setRegistryRepaired(true);
        setRepairResult({
          action,
          title: "registry 已备份并修复（模拟）",
          body: "显式 mutation 触发备份与 canonical v2 重写；last-known 曾保留，后台 watcher 未自动修复。",
          lines: ["backup: .corrupt (simulated)", "canonical: v2", "writes: resumed"],
          tone: "success",
        });
        return;
      }
      if (action === "reauthorize") {
        startOAuth();
        return;
      }
      if (action === "restart_gateway") {
        if (restartAttempts > 0) {
          setRepairResult({
            action,
            title: "不重复重启",
            body: "同一个 stale owner 只允许一次受控优雅 restart。仍不一致时保持 blocked，交给你判断。",
            lines: ["restartAttempts: 1/1", "state: blocked", "autoRetry: no"],
            tone: "warning",
          });
          return;
        }
        setRestartAttempts(1);
        setTestStatus("running");
        window.setTimeout(() => {
          setLocalRecovered(true);
          setTestStatus("passed");
          setTestMessage("受控 restart 完成（模拟）· code_sha 已一致；未 kill 其他 owner。");
          setRepairResult({
            action,
            title: "受控重启完成（模拟）",
            body: "只对同一 stale owner 做了一次优雅 restart，随后重新 ensure 并校验 code_sha。",
            lines: ["restartAttempts: 1/1", "code_sha: matched", "state: ready"],
            tone: "success",
          });
        }, 700);
        return;
      }
      if (action === "retry") {
        runTest("local");
        setRepairResult({
          action,
          title: "Retry 是显式动作",
          body:
            failure === "hermes_not_found"
              ? "再次探测仍可能失败；不会自动下载 runtime。若已安装，先用「选择 Hermes CLI」。"
              : "retryable 只代表用户可安全重试，不保证成功；blocked 永不自动重试。",
          lines: ["autoRetry: no", "installer: none", "state: probing (simulated)"],
          tone: "warning",
        });
        return;
      }
      if (action === "legacy_attach") {
        setTestMessage("legacy attach-only 回退已标记（模拟）· 每 Profile 单条 ticket，不接受 host-scope。");
        setRepairResult({
          action,
          title: "Legacy attach-only 回退",
          body: "有 attach --recover 时继续；现代 ensure 不存在时只走 per-Profile ticket。不会伪造 always-connected。",
          lines: ["transport: per-profile", "host-scope: unavailable", "registry writes: 0"],
          tone: "warning",
        });
        return;
      }

      const details: Partial<Record<ActionId, RepairResult>> = {
        choose_cli: {
          action,
          title: "系统文件选择器（模拟）",
          body: "你只会看到 display-safe 来源与版本；真实路径留在 Main。Renderer 拿不到路径，也不写 registry。",
          lines: ["action: choose_cli", "path exposed: no", "registry writes: 0"],
          tone: "default",
        },
        open_install_docs: {
          action,
          title: "安装 Hermes（安全说明）",
          body: "v1 只 attach / ensure 已安装的 Hermes，不打包 Python runtime，也不会自动执行安装器。",
          lines: ["1. 安装官方 Hermes CLI", "2. 回到这里 Retry 或选择 CLI", "3. 不分享路径或日志原文"],
          tone: "default",
        },
        open_update_docs: {
          action,
          title: "更新 Hermes / 兼容性说明",
          body: "兼容性按 CLI verb 与 protocol capability 判定，不只比 semver。更新后再显式 Retry。",
          lines: ["runtime_protocol: 1", "session-authority-v1: required", "auto-update: no"],
          tone: "default",
        },
        open_status: {
          action,
          title: "gateway status（脱敏）",
          body: "展示状态摘要与修复建议；不暴露原始 socket、service 路径、ticket 或命令输出。",
          lines: ["service: blocked", "owner: unmanaged", "raw stderr: withheld"],
          tone: "warning",
        },
        open_diagnostics: {
          action,
          title: "脱敏诊断（模拟）",
          body: "诊断报告由 Main 生成；路径、端点、ticket、原始 stderr 与凭据字节全部移除。",
          lines: [
            `code: ${failureMeta.code}`,
            "phase: local-backend",
            "ticket/path/url: redacted",
            "export: user initiated only",
          ],
          tone: "default",
        },
        export_safe_summary: {
          action,
          title: "脱敏摘要已准备（模拟）",
          body: "只包含连接名、kind、readState 与 issue code；不含 quarantined 原文或任何 secret。",
          lines: ["connections: 6", "issues: 2", "secret fields: absent"],
          tone: "success",
        },
      };
      const result = details[action];
      if (result) {
        setRepairResult(result);
      } else {
        setRepairResult({
          action,
          title: actionLabels[action],
          body: "这是一个原型动作；没有调用真实后端、文件系统或凭据服务。",
          lines: ["simulation: true"],
          tone: "default",
        });
      }
    },
    [
      failure,
      failureMeta.code,
      restartAttempts,
      resetTransient,
      runTest,
      startOAuth,
    ],
  );

  const submitComposer = useCallback(() => {
    setComposerSubmitted(true);
    notify("原型：消息留在本地草稿；没有自动 session.create，也没有发送到 daemon。");
  }, [notify]);

  const api: OnboardingApi = {
    variant,
    scene,
    failure,
    failureMeta,
    connections,
    primaryId,
    lastUsedId,
    launchMode,
    form,
    formKind: form.kind,
    testStatus,
    testMessage,
    testsRun,
    registryWrites,
    oauthStatus,
    savedForm,
    duplicateVisible,
    conflictResolved,
    registryRepaired,
    restartAttempts,
    localRecovered,
    draft,
    composerSubmitted,
    repairResult,
    toast,
    setVariant,
    setScene,
    setFailure,
    setFormKind,
    setForm,
    setPrimary,
    setLaunchMode,
    setDraft,
    runTest,
    startOAuth,
    finishOAuth,
    cancelOAuth,
    saveForm,
    runAction,
    closeRepairResult: () => setRepairResult(null),
    submitComposer,
    dismissToast: () => setToast(null),
    note: notify,
  };

  return <OnboardingContext.Provider value={api}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingApi {
  const value = useContext(OnboardingContext);
  if (!value) throw new Error("useOnboarding must be used inside OnboardingProvider");
  return value;
}
