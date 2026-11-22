import {
  artifacts,
  bots,
  channels,
  createMemoryFiles,
  cronJobs,
  filesByGateway,
  gateways,
  initialTerminalLines,
  mcpServers,
  profiles,
  routines,
  sessions,
  skills,
  subagents,
  toolsets,
} from "../data/seed";
import type {
  Activity,
  AppState,
  Artifact,
  Attachment,
  Bot,
  CapabilityTab,
  Channel,
  ContextChip,
  CronJob,
  FileNode,
  Gateway,
  GatewayHealth,
  Message,
  Overlay,
  Profile,
  Reasoning,
  Session,
  SettingsSection,
  SidebarMode,
  ToastTone,
  UpdateState,
  WorkspaceMode,
  WorkspaceTab,
} from "../types";

export type AppAction =
  | { type: "SWITCH_GATEWAY"; gatewayId: string }
  | { type: "SWITCH_PROFILE"; profileId: string }
  | { type: "TOGGLE_ALL_PROFILES" }
  | { type: "SET_ALL_PROFILES"; value: boolean }
  | { type: "OPEN_SESSION"; sessionId: string }
  | { type: "NEW_SESSION" }
  | { type: "SET_SESSION_SEARCH"; value: string }
  | { type: "SET_SESSION_FILTER"; value: "all" | "pinned" }
  | { type: "TOGGLE_PIN"; sessionId: string }
  | { type: "SET_SIDEBAR_MODE"; mode: SidebarMode }
  | { type: "OPEN_BOT"; botId: string }
  | { type: "SET_OVERLAY"; overlay: Overlay }
  | { type: "CLOSE_OVERLAY" }
  | { type: "OPEN_SETTINGS"; section?: SettingsSection }
  | { type: "SET_SETTINGS_SECTION"; section: SettingsSection }
  | { type: "SET_SETTINGS_SCOPE"; gatewayId: string; profileId: string }
  | { type: "SET_CAPABILITY_TAB"; tab: CapabilityTab }
  | { type: "OPEN_CAPABILITIES"; tab?: CapabilityTab }
  | { type: "CLOSE_CAPABILITIES" }
  | { type: "SET_CAPABILITY_SCOPE"; gatewayId: string; profileId: string }
  | { type: "SET_SKILL_QUERY"; value: string }
  | { type: "SET_SKILL_CATEGORY"; value: string }
  | { type: "TOGGLE_SKILL"; skillId: string }
  | { type: "INSTALL_SKILL"; skillId: string }
  | { type: "TOGGLE_TOOLSET"; toolsetId: string }
  | { type: "SET_MCP_FILTER"; serverId: string; filters: string[] }
  | { type: "TOGGLE_MCP"; serverId: string }
  | { type: "RELOAD_MCP"; serverId?: string }
  | { type: "SET_MEMORY_FILE"; fileId: string; content: string }
  | { type: "TOGGLE_CHANNEL"; channelId: string }
  | { type: "SET_CHANNEL_CONNECTED"; channelId: string; connected: boolean }
  | { type: "RESTART_GATEWAY" }
  | { type: "TOGGLE_CRON"; jobId: string }
  | { type: "RUN_CRON"; jobId: string }
  | { type: "CRON_DONE"; jobId: string; ok: boolean }
  | { type: "TOGGLE_ROUTINE"; routineId: string }
  | { type: "OPEN_WORKSPACE"; tab?: WorkspaceTab }
  | { type: "WORKSPACE_MODE"; mode: WorkspaceMode }
  | { type: "SET_WORKSPACE_TAB"; tab: WorkspaceTab }
  | { type: "SET_PREVIEW_ARTIFACT"; artifactId: string }
  | { type: "SET_ANNOTATE"; value: boolean }
  | { type: "ADD_ANNOTATION"; x: number; y: number; comment: string }
  | { type: "CLEAR_ANNOTATIONS" }
  | { type: "SET_TERMINAL_COMMAND"; value: string }
  | { type: "TERMINAL_RUN"; command: string }
  | { type: "SET_GIT_SCOPE"; scope: "uncommitted" | "branch" | "last-turn" }
  | { type: "SET_GIT_FILE"; fileId?: string }
  | { type: "SET_SUBAGENT_SELECTED"; id?: string }
  | { type: "SET_SUBAGENT_STEER"; value: string }
  | { type: "STEER_SUBAGENT"; id: string; message: string }
  | { type: "STOP_SUBAGENT"; id: string }
  | { type: "SET_CHAT_DRAFT"; value: string }
  | { type: "SET_CHAT_MENUS"; menus: { modelPickerOpen?: boolean; slashOpen?: boolean; contextOpen?: boolean } }
  | { type: "ADD_ATTACHMENT"; attachment: Attachment }
  | { type: "REMOVE_ATTACHMENT"; id: string }
  | { type: "ADD_CONTEXT"; chip: ContextChip }
  | { type: "REMOVE_CONTEXT"; id: string }
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_PROFILE_MODEL"; gatewayId: string; profileId: string; model: string }
  | { type: "SET_REASONING"; reasoning: Reasoning }
  | { type: "HISTORY_PREV" }
  | { type: "HISTORY_NEXT" }
  | {
      type: "SEND_MESSAGE";
      content: string;
      reply: { content: string; activities?: Activity[]; approval?: Message["approval"] };
      attachments?: Attachment[];
      contexts?: ContextChip[];
    }
  | { type: "FINISH_STREAMING" }
  | { type: "TOGGLE_ACTIVITY"; activityId: string }
  | { type: "RESOLVE_APPROVAL"; approvalId: string; decision: "approved" | "denied" | "inspected" }
  | { type: "RESTORE_CHECKPOINT"; sessionId: string; checkpointId: string }
  | { type: "CREATE_CHECKPOINT"; sessionId: string }
  | { type: "TOGGLE_GATEWAY_SWITCHER"; open?: boolean }
  | { type: "TEST_GATEWAY"; gatewayId: string }
  | { type: "TEST_GATEWAY_RESULT"; gatewayId: string; ok: boolean; detail: string; latencyMs: number | null }
  | { type: "ADD_GATEWAY"; gateway: Gateway }
  | { type: "EDIT_GATEWAY"; gateway: Gateway }
  | { type: "REMOVE_GATEWAY"; gatewayId: string }
  | { type: "SET_PRIMARY"; gatewayId: string }
  | { type: "SET_RETURN_TO_LAST"; value: boolean }
  | { type: "UPDATE_ALL" }
  | { type: "UPDATE_ONE_RESULT"; gatewayId: string; state: UpdateState }
  | { type: "SET_TOAST"; title: string; message?: string; tone?: ToastTone }
  | { type: "DISMISS_TOAST"; id: string };

export interface SessionGroup {
  id: string;
  label: string;
  sublabel?: string;
  sessions: Session[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInitialState(): AppState {
  return {
    gateways: clone(gateways),
    profiles: clone(profiles),
    sessions: clone(sessions),
    channels: clone(channels),
    cronJobs: clone(cronJobs),
    mcpServers: clone(mcpServers),
    skills: clone(skills),
    toolsets: clone(toolsets),
    memoryFiles: createMemoryFiles(),
    artifacts: clone(artifacts),
    filesByGateway: clone(filesByGateway),
    subagents: clone(subagents),
    bots: clone(bots),
    routines: clone(routines),
    activeGatewayId: "local",
    activeProfileId: "default",
    activeSessionId: "s-local-notes",
    lastProfileByGateway: {
      local: "default",
      homelab: "research",
      vps1: "vps-research",
      cloud: "cloud-ops",
    },
    allProfiles: false,
    sidebarMode: "sessions",
    sessionSearch: "",
    sessionFilter: "all",
    chat: {
      draft: "",
      attachments: [],
      contexts: [],
      history: [],
      historyIndex: -1,
      streaming: false,
      model: "Opus 4.5",
      reasoning: "High",
      modelPickerOpen: false,
      slashOpen: false,
      contextOpen: false,
    },
    workspace: {
      mode: "closed",
      tab: "artifacts",
      terminal: {
        gatewayId: "local",
        lines: clone(initialTerminalLines),
        command: "",
        running: false,
        startedAt: 0,
      },
      preview: { annotate: false, annotations: [] },
      git: { scope: "uncommitted" },
      agents: { steer: "" },
    },
    capabilities: {
      tab: "skills",
      scopeGatewayId: "local",
      scopeProfileId: "default",
      skillQuery: "",
      skillCategory: "all",
    },
    capabilitiesOpen: false,
    settings: {
      section: "model",
      scopeGatewayId: "local",
      scopeProfileId: "default",
    },
    overlay: "none",
    gatewaySwitcherOpen: false,
    restartRequired: false,
    primaryGatewayId: "homelab",
    lastUsedGatewayId: "homelab",
    returnToLastGateway: false,
    updateStates: Object.fromEntries(
      gateways.map((gateway) => [gateway.id, "idle" as UpdateState]),
    ) as Record<string, UpdateState>,
    routePulse: 0,
    nextId: 1000,
  };
}

export function getGateway(state: AppState, gatewayId: string): Gateway | undefined {
  return state.gateways.find((gateway) => gateway.id === gatewayId);
}

export function getProfile(state: AppState, gatewayId: string, profileId: string): Profile | undefined {
  return state.profiles.find((profile) => profile.gatewayId === gatewayId && profile.id === profileId);
}

export function getProfileById(state: AppState, profileId: string): Profile | undefined {
  return state.profiles.find((profile) => profile.id === profileId);
}

export function getActiveGateway(state: AppState): Gateway {
  return getGateway(state, state.activeGatewayId) ?? state.gateways[0];
}

export function getActiveProfile(state: AppState): Profile {
  return getProfile(state, state.activeGatewayId, state.activeProfileId) ?? state.profiles[0];
}

export function getProfilesForGateway(state: AppState, gatewayId: string): Profile[] {
  return state.profiles.filter((profile) => profile.gatewayId === gatewayId);
}

function firstSessionForScope(state: AppState, gatewayId: string, profileId: string): Session | undefined {
  return (
    state.sessions.find(
      (session) => session.gatewayId === gatewayId && session.profileId === profileId && !session.botId,
    ) ??
    state.sessions.find((session) => session.gatewayId === gatewayId && session.profileId === profileId)
  );
}

export function getActiveSession(state: AppState): Session | undefined {
  return state.sessions.find((session) => session.id === state.activeSessionId);
}

export function getActiveBot(state: AppState): Bot | undefined {
  return state.bots.find((bot) => bot.id === state.activeBotId);
}

export function getRoutinesForBot(state: AppState, botId: string) {
  return state.routines.filter((routine) => routine.botId === botId);
}

export function getActiveFiles(state: AppState): FileNode[] {
  return state.filesByGateway[state.activeGatewayId] ?? [];
}

export function scopedSessions(state: AppState): Session[] {
  if (state.allProfiles) {
    return state.sessions;
  }
  return state.sessions.filter(
    (session) =>
      session.gatewayId === state.activeGatewayId && session.profileId === state.activeProfileId,
  );
}

export function scopedChannels(state: AppState): Channel[] {
  return state.channels.filter(
    (channel) =>
      channel.gatewayId === state.activeGatewayId && channel.profileId === state.activeProfileId,
  );
}

export function scopedCronJobs(state: AppState): CronJob[] {
  return state.cronJobs.filter(
    (job) => job.gatewayId === state.activeGatewayId && job.profileId === state.activeProfileId,
  );
}

export function scopedMcpServers(state: AppState) {
  return state.mcpServers.filter(
    (server) =>
      server.gatewayId === state.activeGatewayId && server.profileId === state.activeProfileId,
  );
}

export function capabilityMcpServers(state: AppState) {
  return state.mcpServers.filter(
    (server) =>
      server.gatewayId === state.capabilities.scopeGatewayId &&
      server.profileId === state.capabilities.scopeProfileId,
  );
}

export function capabilityChannels(state: AppState) {
  return state.channels.filter(
    (channel) =>
      channel.gatewayId === state.capabilities.scopeGatewayId &&
      channel.profileId === state.capabilities.scopeProfileId,
  );
}

export function capabilityCronJobs(state: AppState) {
  return state.cronJobs.filter(
    (job) =>
      job.gatewayId === state.capabilities.scopeGatewayId &&
      job.profileId === state.capabilities.scopeProfileId,
  );
}

export function capabilityMemoryFiles(state: AppState) {
  return state.memoryFiles.filter(
    (file) =>
      file.gatewayId === state.capabilities.scopeGatewayId &&
      file.profileId === state.capabilities.scopeProfileId,
  );
}

export function canHotReloadMcp(state: AppState): boolean {
  return state.capabilities.scopeGatewayId === state.activeGatewayId;
}

export function workspaceBodyMounted(state: AppState): boolean {
  return state.workspace.mode !== "closed";
}

export function visibleSessions(state: AppState): Session[] {
  let list = scopedSessions(state);
  if (state.sidebarMode === "sessions") {
    list = list.filter((session) => !session.botId);
  }
  if (state.sessionFilter === "pinned") {
    list = list.filter((session) => session.pinned);
  }
  const query = state.sessionSearch.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (session) =>
        session.title.toLowerCase().includes(query) ||
        session.preview.toLowerCase().includes(query) ||
        session.id.toLowerCase().includes(query),
    );
  }
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const order = { today: 0, yesterday: 1, earlier: 2 };
    return order[a.group] - order[b.group];
  });
}

export function sessionGroups(state: AppState): SessionGroup[] {
  const list = visibleSessions(state);
  if (state.allProfiles) {
    const groups = new Map<string, SessionGroup>();
    for (const session of list) {
      const key = `${session.gatewayId}:${session.profileId}`;
      const gateway = getGateway(state, session.gatewayId);
      const profile = getProfile(state, session.gatewayId, session.profileId);
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          label: gateway?.name ?? session.gatewayId,
          sublabel: profile ? `${profile.handle} · ${profiles.length > 1 ? "profile" : "default"}` : undefined,
          sessions: [],
        });
      }
      groups.get(key)!.sessions.push(session);
    }
    return [...groups.values()];
  }

  const pinned = list.filter((session) => session.pinned);
  const grouped: SessionGroup[] = [];
  if (pinned.length) grouped.push({ id: "pinned", label: "Pinned", sessions: pinned });
  const labels: Record<Session["group"], string> = {
    today: "今天",
    yesterday: "昨天",
    earlier: "更早",
  };
  for (const group of ["today", "yesterday", "earlier"] as const) {
    const rows = list.filter((session) => !session.pinned && session.group === group);
    if (rows.length) grouped.push({ id: group, label: labels[group], sessions: rows });
  }
  return grouped;
}

function withToast(
  state: AppState,
  title: string,
  message?: string,
  tone: ToastTone = "default",
): AppState {
  return {
    ...state,
    toast: { id: `toast-${state.nextId}`, title, message, tone },
    nextId: state.nextId + 1,
  };
}

function updateSession(state: AppState, sessionId: string, update: (session: Session) => Session): AppState {
  return {
    ...state,
    sessions: state.sessions.map((session) => (session.id === sessionId ? update(session) : session)),
  };
}

function profileDefaults(state: AppState, gatewayId: string, profileId: string) {
  const profile = getProfile(state, gatewayId, profileId);
  const scopeChanged =
    state.activeGatewayId !== gatewayId || state.activeProfileId !== profileId;
  return {
    activeGatewayId: gatewayId,
    activeProfileId: profileId,
    lastProfileByGateway: { ...state.lastProfileByGateway, [gatewayId]: profileId },
    chat: {
      ...state.chat,
      model: profile?.model ?? state.chat.model,
      reasoning: profile?.effort ?? state.chat.reasoning,
      streaming: false,
      streamingMessageId: undefined,
    },
    capabilities: { ...state.capabilities, scopeGatewayId: gatewayId, scopeProfileId: profileId },
    settings: { ...state.settings, scopeGatewayId: gatewayId, scopeProfileId: profileId },
    workspace: scopeChanged ? workspaceForScope(state, gatewayId) : state.workspace,
  };
}

function workspaceForScope(state: AppState, gatewayId: string) {
  const gateway = getGateway(state, gatewayId);
  const attachedShell = gateway?.kind === "ssh" || gateway?.kind === "local";
  const lines = [
    "Hermes terminal · simulated host shell",
    attachedShell
      ? `Host: ${gateway?.name ?? "attached gateway"} over SSH. Path: ~/hermes-web.`
      : "Host: This device. Cloud and HTTP gateways have no shell; the terminal runs here.",
    "Type `help` for demo commands. This shell is not connected to a real gateway.",
  ];
  return {
    ...state.workspace,
    terminal: {
      ...state.workspace.terminal,
      gatewayId: attachedShell ? gatewayId : "local",
      lines,
      command: "",
      running: false,
      startedAt: 0,
    },
    preview: { annotate: false, annotations: [] },
    agents: { steer: "" },
    hiddenAt: undefined,
  };
}

function terminalHost(state: AppState, gatewayId: string): string {
  const gateway = getGateway(state, gatewayId);
  if (!gateway) return "this-device";
  if (gateway.kind === "ssh") return gateway.name.toLowerCase();
  if (gateway.kind === "local") return "this-device";
  return "this-device";
}

function terminalBanner(state: AppState): string[] {
  const gateway = getActiveGateway(state);
  const host = terminalHost(state, gateway.id);
  return [
    "Hermes terminal · simulated host shell",
    host === "this-device"
      ? "Host: This device. Cloud and HTTP gateways have no shell; the terminal runs here."
      : `Host: ${gateway.name} over SSH. Path: ~/hermes-web.`,
    "Type `help` for demo commands. This shell is not connected to a real gateway.",
  ];
}

function terminalPrompt(state: AppState): string {
  const gateway = getActiveGateway(state);
  const host = terminalHost(state, gateway.id);
  return host === "this-device" ? "this-device:~ $" : `${host}:~/hermes-web $`;
}

function runTerminalCommand(state: AppState, raw: string): string[] {
  const command = raw.trim();
  if (!command) return state.workspace.terminal.lines;
  if (command === "clear") return terminalBanner(state);
  const prompt = terminalPrompt(state);
  const gateway = getActiveGateway(state);
  const lines = [...state.workspace.terminal.lines, `${prompt} ${command}`];

  if (command === "help") {
    return [
      ...lines,
      "Demo commands: help · pwd · ls · git status · hermes gateway status · whoami · clear",
    ];
  }
  if (command === "pwd") {
    return [...lines, terminalHost(state, gateway.id) === "this-device" ? "/Users/lin/workspace" : "/home/omer/hermes-web"];
  }
  if (command === "ls") {
    return [...lines, "README.md   docs/   package.json   src/   dist/"];
  }
  if (command === "whoami") {
    return [...lines, terminalHost(state, gateway.id) === "this-device" ? "lin" : "omer"];
  }
  if (command === "git status") {
    return [...lines, "On branch main", "Your branch is up to date with 'origin/main'.", "nothing to commit, working tree clean"];
  }
  if (command === "hermes gateway status") {
    return [
      ...lines,
      `gateway: ${gateway.kind === "cloud" ? "platform-managed" : "reachable"} · ${gateway.name}`,
      `profile: ${state.activeProfileId} · latency: ${gateway.latencyMs ?? "—"} ms`,
      "mcp: 2 servers ready · ws: open",
    ];
  }
  return [...lines, `zsh: command not found: ${command.split(" ")[0]}`];
}

function findApproval(state: AppState, approvalId: string) {
  for (const session of state.sessions) {
    for (const message of session.messages) {
      if (message.approval?.id === approvalId) return { session, message, approval: message.approval };
    }
  }
  return undefined;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SWITCH_GATEWAY": {
      const gateway = getGateway(state, action.gatewayId);
      if (!gateway) return state;
      const gatewayProfiles = getProfilesForGateway(state, action.gatewayId);
      if (!gatewayProfiles.length) {
        return withToast(
          state,
          `${gateway.name} 当前不可达`,
          "没有发现 profile。先运行 Test，或检查 SSH / WebSocket 腿。",
          "danger",
        );
      }
      const profileId =
        state.lastProfileByGateway[action.gatewayId] ?? gatewayProfiles[0].id;
      const session = firstSessionForScope(state, action.gatewayId, profileId);
      const next = {
        ...state,
        ...profileDefaults(state, action.gatewayId, profileId),
        activeSessionId: session?.id ?? state.activeSessionId,
        activeBotId: session?.botId,
        lastUsedGatewayId: action.gatewayId,
        gatewaySwitcherOpen: false,
        capabilitiesOpen: false,
        routePulse: state.routePulse + 1,
      };
      return withToast(
        next,
        `Execution context · ${gateway.name}`,
        `${profileId} · ${gateway.kind === "local" ? "this device" : gateway.kind.toUpperCase()} · ${gateway.latencyMs ?? "—"} ms`,
        gateway.health === "error" ? "danger" : "default",
      );
    }

    case "SWITCH_PROFILE": {
      const profile = getProfileById(state, action.profileId);
      if (!profile || profile.gatewayId !== state.activeGatewayId) return state;
      const session = firstSessionForScope(state, profile.gatewayId, profile.id);
      const next = {
        ...state,
        ...profileDefaults(state, profile.gatewayId, profile.id),
        activeSessionId: session?.id ?? state.activeSessionId,
        activeBotId: session?.botId,
        gatewaySwitcherOpen: false,
        routePulse: state.routePulse + 1,
      };
      return withToast(next, `Profile · ${profile.handle}`, `${getActiveGateway(state).name} · ${profile.model}`, "default");
    }

    case "TOGGLE_ALL_PROFILES":
    case "SET_ALL_PROFILES": {
      const allProfiles =
        action.type === "TOGGLE_ALL_PROFILES" ? !state.allProfiles : action.value;
      let next = { ...state, allProfiles };
      if (!allProfiles) {
        const session = getActiveSession(next);
        if (
          session &&
          (session.gatewayId !== next.activeGatewayId || session.profileId !== next.activeProfileId)
        ) {
          next = {
            ...next,
            activeSessionId: firstSessionForScope(next, next.activeGatewayId, next.activeProfileId)?.id ?? next.activeSessionId,
          };
        }
      }
      return withToast(
        next,
        allProfiles ? "All profiles · union view" : "Scoped view",
        allProfiles ? "Sessions grouped by gateway and profile." : `${getActiveGateway(next).name} · ${next.activeProfileId}`,
      );
    }

    case "OPEN_SESSION": {
      const session = state.sessions.find((row) => row.id === action.sessionId);
      if (!session) return state;
      const next = {
        ...state,
        ...profileDefaults(state, session.gatewayId, session.profileId),
        activeSessionId: session.id,
        activeBotId: session.botId,
        sidebarMode: session.botId ? ("bots" as const) : ("sessions" as const),
        overlay: "none" as const,
        capabilitiesOpen: false,
        gatewaySwitcherOpen: false,
        routePulse: state.routePulse + 1,
      };
      return next;
    }

    case "NEW_SESSION": {
      const id = `s-${state.nextId}`;
      const newSession: Session = {
        id,
        gatewayId: state.activeGatewayId,
        profileId: state.activeProfileId,
        title: "新对话",
        preview: "空对话",
        updatedAt: "刚刚",
        group: "today",
        pinned: false,
        messages: [],
        checkpoints: [],
      };
      return {
        ...state,
        sessions: [newSession, ...state.sessions],
        activeSessionId: id,
        activeBotId: undefined,
        sidebarMode: "sessions",
        overlay: "none",
        capabilitiesOpen: false,
        chat: {
          ...state.chat,
          draft: "",
          attachments: [],
          contexts: [],
          streaming: false,
          streamingMessageId: undefined,
        },
        nextId: state.nextId + 1,
      };
    }

    case "SET_SESSION_SEARCH":
      return { ...state, sessionSearch: action.value };
    case "SET_SESSION_FILTER":
      return { ...state, sessionFilter: action.value };
    case "TOGGLE_PIN": {
      const session = state.sessions.find((row) => row.id === action.sessionId);
      if (!session) return state;
      const next = updateSession(state, action.sessionId, (row) => ({ ...row, pinned: !row.pinned }));
      return withToast(next, session.pinned ? "Session unpinned" : "Session pinned", session.title);
    }

    case "SET_SIDEBAR_MODE": {
      if (action.mode === "bots") {
        const bot = state.bots.find((row) => row.id === state.activeBotId) ?? state.bots[0];
        if (!bot) return state;
        const next = {
          ...state,
          ...profileDefaults(state, bot.gatewayId, bot.profileId),
          sidebarMode: "bots" as const,
          activeBotId: bot.id,
          activeSessionId: bot.sessionId,
          capabilitiesOpen: false,
          overlay: "none" as const,
          routePulse: state.routePulse + 1,
        };
        return withToast(next, `Bots · ${bot.handle}`, `${getGateway(state, bot.gatewayId)?.name} · ${bot.title}`);
      }
      const current = getActiveSession(state);
      const session = current && !current.botId ? current : firstSessionForScope(state, state.activeGatewayId, state.activeProfileId);
      return {
        ...state,
        sidebarMode: "sessions",
        activeBotId: undefined,
        activeSessionId: session?.id ?? state.activeSessionId,
      };
    }

    case "OPEN_BOT": {
      const bot = state.bots.find((row) => row.id === action.botId);
      if (!bot) return state;
      const next = {
        ...state,
        ...profileDefaults(state, bot.gatewayId, bot.profileId),
        sidebarMode: "bots" as const,
        activeBotId: bot.id,
        activeSessionId: bot.sessionId,
        capabilitiesOpen: false,
        overlay: "none" as const,
        gatewaySwitcherOpen: false,
        routePulse: state.routePulse + 1,
      };
      return withToast(next, `Opened ${bot.handle}`, `${getGateway(state, bot.gatewayId)?.name} · ${bot.title}`);
    }

    case "SET_OVERLAY":
    case "CLOSE_OVERLAY":
      return {
        ...state,
        overlay: action.type === "CLOSE_OVERLAY" ? "none" : action.overlay,
        gatewaySwitcherOpen: false,
        chat: { ...state.chat, modelPickerOpen: false, slashOpen: false, contextOpen: false },
      };

    case "OPEN_SETTINGS": {
      return {
        ...state,
        overlay: "settings",
        settings: {
          ...state.settings,
          section: action.section ?? state.settings.section,
          scopeGatewayId: state.activeGatewayId,
          scopeProfileId: state.activeProfileId,
        },
        capabilitiesOpen: false,
        gatewaySwitcherOpen: false,
      };
    }

    case "SET_SETTINGS_SECTION":
      return { ...state, settings: { ...state.settings, section: action.section } };

    case "SET_SETTINGS_SCOPE": {
      if (!getProfile(state, action.gatewayId, action.profileId)) return state;
      return {
        ...state,
        settings: { ...state.settings, scopeGatewayId: action.gatewayId, scopeProfileId: action.profileId },
      };
    }

    case "SET_CAPABILITY_TAB":
      return { ...state, capabilities: { ...state.capabilities, tab: action.tab } };

    case "OPEN_CAPABILITIES": {
      const next = {
        ...state,
        capabilitiesOpen: true,
        capabilities: {
          ...state.capabilities,
          tab: action.tab ?? state.capabilities.tab,
          scopeGatewayId: state.activeGatewayId,
          scopeProfileId: state.activeProfileId,
        },
        overlay: "none" as const,
        gatewaySwitcherOpen: false,
        workspace: state.workspace.mode === "open" ? { ...state.workspace, mode: "hidden" as const } : state.workspace,
      };
      return next;
    }

    case "CLOSE_CAPABILITIES":
      return { ...state, capabilitiesOpen: false };

    case "SET_CAPABILITY_SCOPE": {
      if (!getProfile(state, action.gatewayId, action.profileId)) return state;
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          scopeGatewayId: action.gatewayId,
          scopeProfileId: action.profileId,
        },
      };
    }

    case "SET_SKILL_QUERY":
      return { ...state, capabilities: { ...state.capabilities, skillQuery: action.value } };
    case "SET_SKILL_CATEGORY":
      return { ...state, capabilities: { ...state.capabilities, skillCategory: action.value } };

    case "TOGGLE_SKILL": {
      const skill = state.skills.find((row) => row.id === action.skillId);
      if (!skill) return state;
      const next = {
        ...state,
        skills: state.skills.map((row) =>
          row.id === action.skillId ? { ...row, enabled: !row.enabled } : row,
        ),
      };
      return withToast(next, skill.enabled ? "Skill disabled" : "Skill enabled", skill.name);
    }

    case "INSTALL_SKILL": {
      const skill = state.skills.find((row) => row.id === action.skillId);
      if (!skill) return state;
      const next = {
        ...state,
        skills: state.skills.map((row) =>
          row.id === action.skillId
            ? {
                ...row,
                installed: true,
                enabled: true,
                source: "hub" as const,
                curator: "Installed from Skills Hub · scanned",
              }
            : row,
        ),
      };
      return withToast(next, "Installed from Skills Hub", `${skill.name} · enabled on ${state.capabilities.scopeProfileId}`, "success");
    }

    case "TOGGLE_TOOLSET": {
      const toolset = state.toolsets.find((row) => row.id === action.toolsetId);
      if (!toolset) return state;
      const next = {
        ...state,
        toolsets: state.toolsets.map((row) =>
          row.id === action.toolsetId ? { ...row, enabled: !row.enabled } : row,
        ),
      };
      return withToast(next, toolset.enabled ? "Toolset disabled" : "Toolset enabled", toolset.name);
    }

    case "SET_MCP_FILTER":
      return {
        ...state,
        mcpServers: state.mcpServers.map((server) =>
          server.id === action.serverId ? { ...server, filters: action.filters } : server,
        ),
      };

    case "TOGGLE_MCP":
      return {
        ...state,
        mcpServers: state.mcpServers.map((server) =>
          server.id === action.serverId ? { ...server, enabled: !server.enabled } : server,
        ),
      };

    case "RELOAD_MCP": {
      if (!canHotReloadMcp(state)) {
        return withToast(
          state,
          "Hot reload unavailable",
          "Only the gateway the window is connected to can hot-reload MCP into a live session.",
          "danger",
        );
      }
      const target = state.mcpServers.filter(
        (server) =>
          server.gatewayId === state.capabilities.scopeGatewayId &&
          server.profileId === state.capabilities.scopeProfileId &&
          (!action.serverId || server.id === action.serverId),
      );
      const next = {
        ...state,
        mcpServers: state.mcpServers.map((server) =>
          target.some((row) => row.id === server.id) ? { ...server, status: "ready" as const } : server,
        ),
      };
      const gateway = getGateway(state, state.capabilities.scopeGatewayId);
      return withToast(
        next,
        "MCP hot-reloaded",
        `${target.map((server) => server.name).join(", ") || "server"} → live session on ${gateway?.name ?? "gateway"}`,
        "success",
      );
    }

    case "SET_MEMORY_FILE":
      return {
        ...state,
        memoryFiles: state.memoryFiles.map((file) =>
          file.id === action.fileId ? { ...file, content: action.content } : file,
        ),
      };

    case "TOGGLE_CHANNEL":
    case "SET_CHANNEL_CONNECTED": {
      const channel = state.channels.find((row) =>
        action.type === "TOGGLE_CHANNEL" ? row.id === action.channelId : row.id === action.channelId,
      );
      if (!channel) return state;
      const connected =
        action.type === "TOGGLE_CHANNEL" ? !channel.connected : action.connected;
      const next = {
        ...state,
        channels: state.channels.map((row) =>
          row.id === channel.id
            ? {
                ...row,
                connected,
                status: connected ? ("ready" as const) : ("paused" as const),
              }
            : row,
        ),
        restartRequired: true,
      };
      return withToast(
        next,
        connected ? "Channel enabled" : "Channel disconnected",
        `${channel.kind} · restart the gateway to apply credentials or toggles.`,
        "default",
      );
    }

    case "RESTART_GATEWAY": {
      const next = {
        ...state,
        restartRequired: false,
        channels: state.channels.map((channel) =>
          channel.connected ? { ...channel, status: "ready" as const } : channel,
        ),
      };
      return withToast(next, "Gateway restarted", "Credentials and channel toggles are live. (simulated)", "success");
    }

    case "TOGGLE_CRON": {
      const job = state.cronJobs.find((row) => row.id === action.jobId);
      if (!job) return state;
      const next = {
        ...state,
        cronJobs: state.cronJobs.map((row) =>
          row.id === action.jobId
            ? { ...row, status: row.status === "paused" ? ("active" as const) : ("paused" as const) }
            : row,
        ),
      };
      return withToast(next, job.status === "paused" ? "Cron resumed" : "Cron paused", job.name);
    }

    case "RUN_CRON": {
      const job = state.cronJobs.find((row) => row.id === action.jobId);
      if (!job) return state;
      const next = {
        ...state,
        cronJobs: state.cronJobs.map((row) =>
          row.id === action.jobId
            ? {
                ...row,
                status: "running" as const,
                history: [
                  { id: `run-${state.nextId}`, at: "刚刚", result: "running" as const, duration: "…" },
                  ...row.history,
                ],
              }
            : row,
        ),
        nextId: state.nextId + 1,
      };
      return withToast(next, "Cron started", `${job.name} · running on its owning profile`, "default");
    }

    case "CRON_DONE": {
      const next = {
        ...state,
        cronJobs: state.cronJobs.map((row) =>
          row.id === action.jobId
            ? {
                ...row,
                status: action.ok ? ("active" as const) : ("error" as const),
                lastRun: `刚刚 · ${action.ok ? "12s" : "error"}`,
                history: row.history.map((run) =>
                  run.at === "刚刚" ? { ...run, result: action.ok ? ("success" as const) : ("error" as const), duration: action.ok ? "12s" : "—" } : run,
                ),
              }
            : row,
        ),
      };
      return withToast(next, action.ok ? "Cron finished" : "Cron failed", action.ok ? "Result delivered." : "Check the job log.", action.ok ? "success" : "danger");
    }

    case "TOGGLE_ROUTINE": {
      const routine = state.routines.find((row) => row.id === action.routineId);
      if (!routine) return state;
      return {
        ...state,
        routines: state.routines.map((row) =>
          row.id === action.routineId
            ? { ...row, status: row.status === "active" ? ("paused" as const) : ("active" as const) }
            : row,
        ),
      };
    }

    case "OPEN_WORKSPACE": {
      const tab = action.tab ?? state.workspace.tab;
      const gateway = getActiveGateway(state);
      const host = gateway.kind === "ssh" || gateway.kind === "local" ? gateway.id : "local";
      const terminal =
        tab === "terminal" && state.workspace.mode === "closed"
          ? {
              ...state.workspace.terminal,
              gatewayId: host,
              lines: terminalBanner(state),
              command: "",
              running: false,
              startedAt: Date.now(),
            }
          : state.workspace.terminal;
      return {
        ...state,
        capabilitiesOpen: false,
        overlay: "none",
        workspace: {
          ...state.workspace,
          mode: "open",
          tab,
          terminal,
        },
      };
    }

    case "WORKSPACE_MODE": {
      if (action.mode === "closed") {
        return {
          ...state,
          workspace: {
            ...state.workspace,
            mode: "closed",
            terminal: {
              ...state.workspace.terminal,
              lines: terminalBanner(state),
              command: "",
              running: false,
              startedAt: 0,
            },
            preview: { annotate: false, annotations: [] },
          },
        };
      }
      return {
        ...state,
        workspace: {
          ...state.workspace,
          mode: action.mode,
          hiddenAt: action.mode === "hidden" ? Date.now() : undefined,
        },
      };
    }

    case "SET_WORKSPACE_TAB":
      return { ...state, workspace: { ...state.workspace, tab: action.tab } };

    case "SET_PREVIEW_ARTIFACT":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          mode: "open",
          tab: "artifacts",
          preview: { ...state.workspace.preview, artifactId: action.artifactId },
        },
      };

    case "SET_ANNOTATE":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          preview: { ...state.workspace.preview, annotate: action.value },
        },
      };

    case "ADD_ANNOTATION":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          preview: {
            ...state.workspace.preview,
            annotations: [
              ...state.workspace.preview.annotations,
              {
                id: `pin-${state.nextId}`,
                x: action.x,
                y: action.y,
                comment: action.comment,
                createdAt: "刚刚",
              },
            ],
          },
        },
        nextId: state.nextId + 1,
      };

    case "CLEAR_ANNOTATIONS":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          preview: { ...state.workspace.preview, annotations: [] },
        },
      };

    case "SET_TERMINAL_COMMAND":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          terminal: { ...state.workspace.terminal, command: action.value },
        },
      };

    case "TERMINAL_RUN":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          terminal: {
            ...state.workspace.terminal,
            lines: runTerminalCommand(state, action.command),
            command: "",
            running: false,
          },
        },
      };

    case "SET_GIT_SCOPE":
      return { ...state, workspace: { ...state.workspace, git: { ...state.workspace.git, scope: action.scope } } };
    case "SET_GIT_FILE":
      return { ...state, workspace: { ...state.workspace, git: { ...state.workspace.git, fileId: action.fileId } } };

    case "SET_SUBAGENT_SELECTED":
      return { ...state, workspace: { ...state.workspace, agents: { ...state.workspace.agents, selectedId: action.id } } };
    case "SET_SUBAGENT_STEER":
      return { ...state, workspace: { ...state.workspace, agents: { ...state.workspace.agents, steer: action.value } } };
    case "STEER_SUBAGENT": {
      const agent = state.subagents.find((row) => row.id === action.id);
      if (!agent) return state;
      const next = {
        ...state,
        subagents: state.subagents.map((row) =>
          row.id === action.id
            ? { ...row, activity: `Steering queued: ${action.message.slice(0, 48)}` }
            : row,
        ),
        workspace: { ...state.workspace, agents: { ...state.workspace.agents, steer: "" } },
      };
      return withToast(next, "Steering queued", `${agent.name} will see it at its next checkpoint.`);
    }
    case "STOP_SUBAGENT": {
      const agent = state.subagents.find((row) => row.id === action.id);
      if (!agent) return state;
      const next = {
        ...state,
        subagents: state.subagents.map((row) =>
          row.id === action.id ? { ...row, status: "stopped" as const, activity: "Stopped by user" } : row,
        ),
      };
      return withToast(next, "Subagent stopped", agent.name, "danger");
    }

    case "SET_CHAT_DRAFT":
      return {
        ...state,
        chat: {
          ...state.chat,
          draft: action.value,
          slashOpen: action.value.startsWith("/"),
          contextOpen: action.value.includes("@") && !action.value.startsWith("@"),
        },
      };

    case "SET_CHAT_MENUS":
      return {
        ...state,
        chat: {
          ...state.chat,
          modelPickerOpen: action.menus.modelPickerOpen ?? state.chat.modelPickerOpen,
          slashOpen: action.menus.slashOpen ?? state.chat.slashOpen,
          contextOpen: action.menus.contextOpen ?? state.chat.contextOpen,
        },
      };

    case "ADD_ATTACHMENT":
      return { ...state, chat: { ...state.chat, attachments: [...state.chat.attachments, action.attachment] } };
    case "REMOVE_ATTACHMENT":
      return { ...state, chat: { ...state.chat, attachments: state.chat.attachments.filter((item) => item.id !== action.id) } };
    case "ADD_CONTEXT":
      return { ...state, chat: { ...state.chat, contexts: [...state.chat.contexts, action.chip], contextOpen: false } };
    case "REMOVE_CONTEXT":
      return { ...state, chat: { ...state.chat, contexts: state.chat.contexts.filter((item) => item.id !== action.id) } };
    case "SET_MODEL":
      return {
        ...state,
        chat: { ...state.chat, model: action.model, modelPickerOpen: false },
        profiles: state.profiles.map((profile) =>
          profile.gatewayId === state.activeGatewayId && profile.id === state.activeProfileId
            ? { ...profile, model: action.model }
            : profile,
        ),
      };
    case "SET_PROFILE_MODEL":
      return {
        ...state,
        profiles: state.profiles.map((profile) =>
          profile.gatewayId === action.gatewayId && profile.id === action.profileId
            ? { ...profile, model: action.model }
            : profile,
        ),
        chat:
          state.activeGatewayId === action.gatewayId && state.activeProfileId === action.profileId
            ? { ...state.chat, model: action.model }
            : state.chat,
      };
    case "SET_REASONING":
      return {
        ...state,
        chat: { ...state.chat, reasoning: action.reasoning, modelPickerOpen: false },
        profiles: state.profiles.map((profile) =>
          profile.gatewayId === state.activeGatewayId && profile.id === state.activeProfileId
            ? { ...profile, effort: action.reasoning }
            : profile,
        ),
      };

    case "HISTORY_PREV": {
      if (!state.chat.history.length) return state;
      const index = state.chat.historyIndex < 0 ? state.chat.history.length - 1 : Math.max(0, state.chat.historyIndex - 1);
      return { ...state, chat: { ...state.chat, historyIndex: index, draft: state.chat.history[index] } };
    }
    case "HISTORY_NEXT": {
      if (state.chat.historyIndex < 0) return state;
      if (state.chat.historyIndex >= state.chat.history.length - 1) {
        return { ...state, chat: { ...state.chat, historyIndex: -1, draft: "" } };
      }
      const index = state.chat.historyIndex + 1;
      return { ...state, chat: { ...state.chat, historyIndex: index, draft: state.chat.history[index] } };
    }

    case "SEND_MESSAGE": {
      const session = getActiveSession(state);
      const content = action.content.trim();
      if (!session || (!content && !action.attachments?.length)) return state;
      const userId = `m-${state.nextId}`;
      const assistantId = `m-${state.nextId + 1}`;
      const attachment = action.attachments ?? state.chat.attachments;
      const contexts = action.contexts ?? state.chat.contexts;
      const userMessage: Message = {
        id: userId,
        role: "user",
        content: content || "（已附加引用）",
        time: "刚刚",
        host: "LOCAL",
        attachments: [...attachment, ...contexts.map((context) => ({
          id: context.id,
          name: context.label,
          kind: context.kind,
          detail: context.detail,
        }))],
      };
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        content: action.reply.content,
        time: "刚刚",
        host: `${getActiveGateway(state).name.toUpperCase()} · ${getActiveProfile(state).name.toUpperCase()}`,
        author: state.sidebarMode === "bots" ? getActiveBot(state)?.name ?? "Hermes" : "Hermes",
        activities: action.reply.activities,
        approval: action.reply.approval,
      };
      const nextSession: Session = {
        ...session,
        title: session.messages.length === 0 ? content.slice(0, 32) || session.title : session.title,
        preview: action.reply.content.slice(0, 80),
        updatedAt: "刚刚",
        group: "today",
        messages: [...session.messages, userMessage, assistantMessage],
      };
      return {
        ...state,
        sessions: state.sessions.map((row) => (row.id === session.id ? nextSession : row)),
        chat: {
          ...state.chat,
          draft: "",
          attachments: [],
          contexts: [],
          history: [...state.chat.history, content],
          historyIndex: -1,
          streaming: true,
          streamingMessageId: assistantId,
          modelPickerOpen: false,
          slashOpen: false,
          contextOpen: false,
        },
        routePulse: state.routePulse + 1,
        nextId: state.nextId + 2,
      };
    }

    case "FINISH_STREAMING":
      return { ...state, chat: { ...state.chat, streaming: false, streamingMessageId: undefined } };

    case "TOGGLE_ACTIVITY":
      return {
        ...state,
        sessions: state.sessions.map((session) => ({
          ...session,
          messages: session.messages.map((message) => ({
            ...message,
            activities: message.activities?.map((activity) =>
              activity.id === action.activityId ? { ...activity, expanded: !activity.expanded } : activity,
            ),
          })),
        })),
      };

    case "RESOLVE_APPROVAL": {
      const found = findApproval(state, action.approvalId);
      if (
        !found ||
        found.approval.status === "approved" ||
        found.approval.status === "denied"
      ) {
        return state;
      }
      if (action.decision === "inspected") {
        return {
          ...state,
          sessions: state.sessions.map((session) => ({
            ...session,
            messages: session.messages.map((message) =>
              message.approval?.id === action.approvalId
                ? { ...message, approval: { ...message.approval!, status: "inspected" } }
                : message,
            ),
          })),
        };
      }
      const gateway = getGateway(state, found.approval.targetGateway);
      const profile = getProfile(state, found.approval.targetGateway, found.approval.targetProfile);
      const system: Message = {
        id: `m-${state.nextId}`,
        role: "system",
        content:
          action.decision === "approved"
            ? `已批准危险命令，在 ${gateway?.name ?? found.approval.targetGateway} / ${profile?.name ?? found.approval.targetProfile} 执行。`
            : `已拒绝危险命令。目标 ${gateway?.name ?? found.approval.targetGateway} / ${profile?.name ?? found.approval.targetProfile} 未执行。`,
        time: "刚刚",
        host: gateway?.name ?? found.approval.targetGateway,
      };
      const next = {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === found.session.id
            ? {
                ...session,
                messages: [
                  ...session.messages.map((message) =>
                    message.approval?.id === action.approvalId
                      ? { ...message, approval: { ...message.approval!, status: action.decision } }
                      : message,
                  ),
                  system,
                ],
              }
            : session,
        ),
        nextId: state.nextId + 1,
      };
      return withToast(
        next,
        action.decision === "approved" ? "Command approved" : "Command denied",
        `${found.approval.command} · ${gateway?.name ?? found.approval.targetGateway}`,
        action.decision === "approved" ? "success" : "default",
      );
    }

    case "RESTORE_CHECKPOINT": {
      const session = state.sessions.find((row) => row.id === action.sessionId);
      const checkpoint = session?.checkpoints.find((row) => row.id === action.checkpointId);
      if (!session || !checkpoint) return state;
      const system: Message = {
        id: `m-${state.nextId}`,
        role: "system",
        content: `已恢复 Checkpoint「${checkpoint.label}」。保留手改内容；完整还原需显式选择 --all。`,
        time: "刚刚",
        host: getGateway(state, session.gatewayId)?.name ?? session.gatewayId,
      };
      const next = {
        ...state,
        sessions: state.sessions.map((row) =>
          row.id === session.id
            ? {
                ...row,
                checkpoints: row.checkpoints.map((cp) =>
                  cp.id === checkpoint.id ? { ...cp, status: "restored" as const } : cp,
                ),
                messages: [...row.messages, system],
              }
            : row,
        ),
        overlay: "none" as const,
        nextId: state.nextId + 1,
      };
      return withToast(next, "Checkpoint restored", checkpoint.label, "success");
    }

    case "CREATE_CHECKPOINT": {
      const session = state.sessions.find((row) => row.id === action.sessionId);
      if (!session) return state;
      const next = {
        ...state,
        sessions: state.sessions.map((row) =>
          row.id === session.id
            ? {
                ...row,
                checkpoints: [
                  {
                    id: `cp-${state.nextId}`,
                    label: "Manual snapshot",
                    time: "刚刚",
                    files: 4,
                    kind: "manual" as const,
                    status: "available" as const,
                  },
                  ...row.checkpoints,
                ],
              }
            : row,
        ),
        nextId: state.nextId + 1,
      };
      return withToast(next, "Checkpoint created", "Manual snapshot · simulation", "success");
    }

    case "TOGGLE_GATEWAY_SWITCHER":
      return {
        ...state,
        gatewaySwitcherOpen: action.open ?? !state.gatewaySwitcherOpen,
        chat: { ...state.chat, modelPickerOpen: false, slashOpen: false, contextOpen: false },
      };

    case "TEST_GATEWAY": {
      const next = {
        ...state,
        gateways: state.gateways.map((gateway) =>
          gateway.id === action.gatewayId
            ? { ...gateway, health: "testing" as const, lastTest: "Testing HTTP + WebSocket…", lastTestTone: "warn" as const }
            : gateway,
        ),
      };
      return withToast(next, "Testing connection", "HTTP + WebSocket probe running (simulated).");
    }

    case "TEST_GATEWAY_RESULT": {
      const gateway = getGateway(state, action.gatewayId);
      if (!gateway) return state;
      const next = {
        ...state,
        gateways: state.gateways.map((row) =>
          row.id === action.gatewayId
            ? {
                ...row,
                health: (action.ok ? "reachable" : "error") as GatewayHealth,
                latencyMs: action.latencyMs,
                lastTest: action.detail,
                lastTestTone: action.ok ? ("ok" as const) : ("error" as const),
              }
            : row,
        ),
      };
      return withToast(next, action.ok ? "Reachable" : "Connection test failed", action.detail, action.ok ? "success" : "danger");
    }

    case "ADD_GATEWAY": {
      if (
        state.gateways.some(
          (gateway) =>
            gateway.id === action.gateway.id ||
            gateway.name.trim().toLowerCase() === action.gateway.name.trim().toLowerCase(),
        )
      ) {
        return withToast(
          state,
          "Device name already in use",
          "Gateway names must be unique so execution context stays unambiguous.",
          "danger",
        );
      }
      const profile: Profile = {
        id: `${action.gateway.id}-default`,
        gatewayId: action.gateway.id,
        name: "default",
        handle: `@default-${action.gateway.id}`,
        color: action.gateway.color,
        model: state.chat.model,
        effort: state.chat.reasoning,
        initials: "D",
      };
      const next = {
        ...state,
        gateways: [...state.gateways, action.gateway],
        profiles: [...state.profiles, profile],
        updateStates: { ...state.updateStates, [action.gateway.id]: "idle" as UpdateState },
        lastProfileByGateway: {
          ...state.lastProfileByGateway,
          [action.gateway.id]: profile.id,
        },
      };
      return withToast(next, "Connection saved", `${action.gateway.name} · run Test to verify HTTP + WS.`, "success");
    }

    case "EDIT_GATEWAY": {
      const current = getGateway(state, action.gateway.id);
      if (!current) return state;
      if (
        state.gateways.some(
          (gateway) =>
            gateway.id !== action.gateway.id &&
            gateway.name.trim().toLowerCase() === action.gateway.name.trim().toLowerCase(),
        )
      ) {
        return withToast(
          state,
          "Device name already in use",
          "Choose a unique name before saving this connection.",
          "danger",
        );
      }
      const next = {
        ...state,
        gateways: state.gateways.map((gateway) =>
          gateway.id === action.gateway.id
            ? {
                ...gateway,
                ...action.gateway,
                kind: current.kind,
                appManaged: current.appManaged,
                primary: current.primary,
                health: current.health,
                latencyMs: current.latencyMs,
              }
            : gateway,
        ),
      };
      return withToast(next, "Connection updated", `${action.gateway.name} · re-test to confirm both legs.`, "success");
    }

    case "REMOVE_GATEWAY": {
      const gateway = getGateway(state, action.gatewayId);
      if (!gateway) return state;
      if (gateway.kind === "local" || gateway.appManaged) {
        return withToast(state, "Cannot remove local entry", "The app-managed local gateway is permanent.", "danger");
      }
      const primary = state.primaryGatewayId === gateway.id;
      const remainingBots = state.bots.filter((row) => row.gatewayId !== gateway.id);
      const activeBotRemoved =
        state.activeBotId !== undefined && !remainingBots.some((bot) => bot.id === state.activeBotId);
      const scopeGatewayId =
        state.capabilities.scopeGatewayId === gateway.id ? "local" : state.capabilities.scopeGatewayId;
      const scopeProfileId =
        state.capabilities.scopeGatewayId === gateway.id ? "default" : state.capabilities.scopeProfileId;
      const settingsGatewayId =
        state.settings.scopeGatewayId === gateway.id ? "local" : state.settings.scopeGatewayId;
      const settingsProfileId =
        state.settings.scopeGatewayId === gateway.id ? "default" : state.settings.scopeProfileId;
      const next = {
        ...state,
        gateways: state.gateways.filter((row) => row.id !== gateway.id),
        profiles: state.profiles.filter((row) => row.gatewayId !== gateway.id),
        sessions: state.sessions.filter((row) => row.gatewayId !== gateway.id),
        channels: state.channels.filter((row) => row.gatewayId !== gateway.id),
        cronJobs: state.cronJobs.filter((row) => row.gatewayId !== gateway.id),
        mcpServers: state.mcpServers.filter((row) => row.gatewayId !== gateway.id),
        memoryFiles: state.memoryFiles.filter((row) => row.gatewayId !== gateway.id),
        artifacts: state.artifacts.filter((row) => row.gatewayId !== gateway.id),
        subagents: state.subagents.filter((row) => row.gatewayId !== gateway.id),
        bots: remainingBots,
        routines: state.routines.filter((row) => row.gatewayId !== gateway.id),
        filesByGateway: Object.fromEntries(
          Object.entries(state.filesByGateway).filter(([gatewayId]) => gatewayId !== gateway.id),
        ),
        activeGatewayId: state.activeGatewayId === gateway.id ? "local" : state.activeGatewayId,
        activeProfileId: state.activeGatewayId === gateway.id ? "default" : state.activeProfileId,
        activeSessionId: state.activeGatewayId === gateway.id ? "s-local-notes" : state.activeSessionId,
        activeBotId: activeBotRemoved ? undefined : state.activeBotId,
        sidebarMode: activeBotRemoved ? ("sessions" as const) : state.sidebarMode,
        primaryGatewayId: primary ? "local" : state.primaryGatewayId,
        lastUsedGatewayId:
          state.lastUsedGatewayId === gateway.id ? "local" : state.lastUsedGatewayId,
        lastProfileByGateway: Object.fromEntries(
          Object.entries(state.lastProfileByGateway).filter(([gatewayId]) => gatewayId !== gateway.id),
        ),
        updateStates: Object.fromEntries(
          Object.entries(state.updateStates).filter(([gatewayId]) => gatewayId !== gateway.id),
        ) as Record<string, UpdateState>,
        capabilities: { ...state.capabilities, scopeGatewayId, scopeProfileId },
        settings: {
          ...state.settings,
          scopeGatewayId: settingsGatewayId,
          scopeProfileId: settingsProfileId,
        },
        gatewaySwitcherOpen: false,
        overlay: "none" as const,
      };
      return withToast(next, "Connection removed", `${gateway.name} · the instance itself is untouched.`);
    }

    case "SET_PRIMARY": {
      const gateway = getGateway(state, action.gatewayId);
      if (!gateway) return state;
      const next = {
        ...state,
        primaryGatewayId: gateway.id,
        gateways: state.gateways.map((row) => ({ ...row, primary: row.id === gateway.id })),
      };
      return withToast(next, "Primary gateway updated", `${gateway.name} is the registry fallback.`);
    }

    case "SET_RETURN_TO_LAST": {
      const next = { ...state, returnToLastGateway: action.value };
      return withToast(
        next,
        action.value ? "Resume last-used gateway" : "Start on Primary",
        action.value ? "Next launch opens the last gateway that connected successfully." : "Next launch opens the Primary gateway.",
      );
    }

    case "UPDATE_ALL": {
      const next = {
        ...state,
        gateways: state.gateways.map((gateway) => {
          if (gateway.kind === "cloud") return { ...gateway, update: "skipped" as UpdateState };
          if (gateway.health === "error") return { ...gateway, update: "error" as UpdateState };
          return { ...gateway, update: "updating" as UpdateState };
        }),
        updateStates: Object.fromEntries(
          state.gateways.map((gateway) => [
            gateway.id,
            gateway.kind === "cloud" ? "skipped" : gateway.health === "error" ? "error" : "updating",
          ]),
        ) as Record<string, UpdateState>,
      };
      return withToast(next, "Updating all instances", "Eligible gateways update in parallel; Cloud is platform-managed.", "default");
    }

    case "UPDATE_ONE_RESULT": {
      const next = {
        ...state,
        gateways: state.gateways.map((gateway) =>
          gateway.id === action.gatewayId ? { ...gateway, update: action.state } : gateway,
        ),
        updateStates: { ...state.updateStates, [action.gatewayId]: action.state },
      };
      return next;
    }

    case "SET_TOAST":
      return withToast(state, action.title, action.message, action.tone);

    case "DISMISS_TOAST":
      return state.toast?.id === action.id ? { ...state, toast: undefined } : state;

    default:
      return state;
  }
}

export function getArtifactPreview(state: AppState): Artifact | undefined {
  const artifact = state.artifacts.find((item) => item.id === state.workspace.preview.artifactId);
  if (
    !artifact ||
    artifact.gatewayId !== state.activeGatewayId ||
    artifact.profileId !== state.activeProfileId
  ) {
    return undefined;
  }
  return artifact;
}

export function getGitFile(state: AppState): FileNode | undefined {
  const id = state.workspace.git.fileId;
  if (!id) return undefined;
  const walk = (nodes: FileNode[]): FileNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = walk(node.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(getActiveFiles(state));
}
