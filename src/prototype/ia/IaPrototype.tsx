import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/ui";
import "./ia.css";
import {
  capTierKeys,
  domains,
  sceneKeys,
  scopes,
  terminalBanner,
  variantKeys,
  type CapTier,
  type DomainId,
  type Scene,
  type Variant,
} from "./data";
import {
  IaContext,
  type ApprovalStatus,
  type IaApi,
  type Notice,
  type Surface,
  type WorkspaceTab,
} from "./context";
import { CommandPalette, NoticeView, PrototypeSwitcher, SettingsModal } from "./parts";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";

const fallbackVariant: Variant = "A";
const fallbackScene: Scene = "running";
const fallbackTier: CapTier = "served";
const surfaces: Surface[] = [
  "none",
  "palette",
  "settings",
  "capability",
  "workspace",
  "approval",
  "sessions",
  "scope",
];

interface InitialState {
  variant: Variant;
  scene: Scene;
  capTier: CapTier;
  surface: Surface;
  domainId: DomainId;
  sessionId: string;
  scopeId: string;
}

function readInitialState(): InitialState {
  const params = new URLSearchParams(window.location.search);
  const variantParam = params.get("variant")?.toUpperCase() as Variant | undefined;
  const sceneParam = params.get("scene") as Scene | undefined;
  const tierParam = params.get("cap") as CapTier | undefined;
  const surfaceParam = params.get("surface") as Surface | undefined;
  const domainParam = params.get("domain") as DomainId | undefined;
  const sessionParam = params.get("session");
  const variant = variantParam && variantKeys.includes(variantParam) ? variantParam : fallbackVariant;
  const scene = sceneParam && sceneKeys.includes(sceneParam) ? sceneParam : fallbackScene;
  const capTier = tierParam && capTierKeys.includes(tierParam) ? tierParam : fallbackTier;
  const surface = surfaceParam && surfaces.includes(surfaceParam) ? surfaceParam : "none";
  const domainId = domainParam && domains.some((domain) => domain.id === domainParam) ? domainParam : "chat";
  const sessionId =
    sessionParam && ["s1", "s2", "s3", "s4", "s5", ""].includes(sessionParam)
      ? sessionParam
      : scene === "empty"
        ? ""
        : scene === "approval"
          ? "s3"
          : "s1";
  const scopeId = scopes.some((scope) => scope.id === params.get("scope")) ? (params.get("scope") as string) : scopes[0].id;
  return { variant, scene, capTier, surface, domainId, sessionId, scopeId };
}

function cycleVariant(variant: Variant, direction: -1 | 1): Variant {
  const index = variantKeys.indexOf(variant);
  return variantKeys[(index + direction + variantKeys.length) % variantKeys.length];
}

export function IaPrototype() {
  const initial = useMemo(readInitialState, []);
  const [variant, setVariantState] = useState<Variant>(initial.variant);
  const [scene, setSceneState] = useState<Scene>(initial.scene);
  const [capTier, setCapTier] = useState<CapTier>(initial.capTier);
  const [surface, setSurface] = useState<Surface>(initial.surface);
  const [domainId, setDomainId] = useState<DomainId>(initial.domainId);
  const [activeSessionId, setActiveSessionIdState] = useState(initial.sessionId);
  const [scopeId, setScopeId] = useState(initial.scopeId);
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus>("pending");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("artifacts");
  const [terminalLines, setTerminalLines] = useState<string[]>([...terminalBanner]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const scope = scopes.find((item) => item.id === scopeId) ?? scopes[0];
  const connectionHealth = scene === "degraded" ? "degraded" : "reachable";
  const approvalPending = approvalStatus === "pending" ? 1 : 0;

  const notify = useCallback((message: string, tone: "default" | "accent" = "default") => {
    setNotice({ id: Date.now(), message, tone });
  }, []);

  const copy = useCallback(
    async (value: string, label = "已复制") => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      notify(label, "accent");
    },
    [notify],
  );

  const setScene = useCallback((next: Scene) => {
    setSceneState(next);
    if (next === "empty") {
      setActiveSessionIdState("");
    } else if (next === "approval") {
      setActiveSessionIdState("s3");
    } else {
      setActiveSessionIdState((current) => current || "s1");
    }
  }, []);

  const setActiveSession = useCallback(
    (sessionId: string) => {
      setActiveSessionIdState(sessionId);
      if (!sessionId) {
        setSceneState("empty");
      } else if (scene === "empty") {
        setSceneState("running");
      } else if (scene === "approval" && sessionId !== "s3") {
        setSceneState("running");
      }
    },
    [scene],
  );

  const setVariant = useCallback((next: Variant) => {
    setVariantState(next);
  }, []);

  const openPalette = useCallback(() => setSurface("palette"), []);
  const openSettings = useCallback(() => setSurface("settings"), []);
  const openApproval = useCallback(() => setSurface("approval"), []);
  const openSessions = useCallback(() => setSurface("sessions"), []);
  const openScope = useCallback(() => setSurface("scope"), []);
  const closeSurface = useCallback(() => setSurface("none"), []);
  const openCapability = useCallback((domain?: DomainId) => {
    if (domain) setDomainId(domain);
    setSurface("capability");
  }, []);
  const openWorkspace = useCallback((tab?: WorkspaceTab) => {
    if (tab) setWorkspaceTab(tab);
    setSurface("workspace");
  }, []);

  const closeWorkspace = useCallback((resetTerminal = false) => {
    if (resetTerminal) setTerminalLines([...terminalBanner]);
    setSurface("none");
  }, []);

  const appendTerminal = useCallback((line: string) => {
    setTerminalLines((current) => [...current.slice(-80), line]);
  }, []);

  const resetTerminal = useCallback(() => {
    setTerminalLines([...terminalBanner]);
  }, []);

  const retryConnection = useCallback(() => {
    setScene("running");
    notify("已重新连接 HOMELAB（模拟）。", "accent");
  }, [notify, setScene]);

  const domainStatus = useCallback(
    (domain: DomainId): "available" | "read_only" | "unavailable" => {
      const optional = ["skills", "tools", "mcp", "subagents"];
      if (capTier === "unavailable" && optional.includes(domain)) return "unavailable";
      if (capTier === "older" && optional.includes(domain)) return "read_only";
      const entry = domains.find((item) => item.id === domain);
      if (entry?.classification === "read_only") return "read_only";
      return "available";
    },
    [capTier],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", variant);
    url.searchParams.set("scene", scene);
    url.searchParams.set("cap", capTier);
    if (activeSessionId) url.searchParams.set("session", activeSessionId);
    else url.searchParams.delete("session");
    if (surface === "none") url.searchParams.delete("surface");
    else url.searchParams.set("surface", surface);
    if (domainId === "chat") url.searchParams.delete("domain");
    else url.searchParams.set("domain", domainId);
    if (scopeId === scopes[0].id) url.searchParams.delete("scope");
    else url.searchParams.set("scope", scopeId);
    window.history.replaceState(null, "", url);
  }, [variant, scene, capTier, activeSessionId, surface, domainId, scopeId]);

  useEffect(() => {
    document.title = `Hermes Desktop — IA prototype ${variant} · ${scene}`;
  }, [variant, scene]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, [contenteditable='true']"));
      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSurface((current) => (current === "palette" ? "none" : "palette"));
        return;
      }
      if (modifier && event.key === ",") {
        event.preventDefault();
        setSurface((current) => (current === "settings" ? "none" : "settings"));
        return;
      }
      if (modifier && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSurface((current) => (current === "workspace" ? "none" : "workspace"));
        return;
      }
      if (event.key === "Escape" && surface !== "none") {
        setSurface("none");
        return;
      }
      if (!editing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        setVariantState((current) => cycleVariant(current, event.key === "ArrowLeft" ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface]);

  const api: IaApi = {
    variant,
    scene,
    capTier,
    surface,
    domainId,
    activeSessionId,
    scope,
    connectionHealth,
    approvalStatus,
    approvalPending,
    workspaceTab,
    terminalLines,
    notice,
    setVariant,
    setScene,
    setCapTier,
    openPalette,
    openSettings,
    openCapability,
    openWorkspace,
    openApproval,
    openSessions,
    openScope,
    closeSurface,
    setSurface,
    setDomain: setDomainId,
    setActiveSession,
    setScope: setScopeId,
    setApprovalStatus,
    setWorkspaceTab,
    closeWorkspace,
    appendTerminal,
    resetTerminal,
    retryConnection,
    notify,
    copy,
    domainStatus,
  };

  const params = new URLSearchParams(window.location.search);
  const showSwitcher = import.meta.env.DEV || params.get("prototype") === "1";

  return (
    <IaContext.Provider value={api}>
      <div className={cn("ia-root", `ia-variant-${variant.toLowerCase()}`)}>
        {variant === "A" && <VariantA />}
        {variant === "B" && <VariantB />}
        {variant === "C" && <VariantC />}
      </div>
      {surface === "palette" && <CommandPalette />}
      {surface === "settings" && <SettingsModal />}
      {showSwitcher && <PrototypeSwitcher />}
      <NoticeView />
    </IaContext.Provider>
  );
}
