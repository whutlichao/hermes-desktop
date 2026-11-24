import type {
  ApprovalChoice,
  ApprovalHighRiskSheetRequest,
  ApprovalPersistentGrantInfo,
  ApprovalRespondResult,
  ApprovalRiskCategory,
  ApprovalState,
  ApprovalTopicSnapshot,
  ApprovalView,
  BridgeScope,
  CapabilityOrigin,
  CapabilityProviderKind,
  ConnectionKind,
  ErrorCode,
  ExternalAttribution,
} from "@hermes/contracts";
import { resolveExternalAttribution } from "./capabilityRegistry";

export interface ApprovalBinding {
  readonly connectionId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly approvalId: string;
  readonly ownerGeneration: number;
  readonly executionGeneration: number;
  readonly serverRequestId?: string | number;
}

export interface GatewayApprovalPayload {
  approvalId: string;
  serverRequestId?: string | number;
  connectionId: string;
  profileId: string;
  sessionId: string;
  turnId?: string | null;
  executionGeneration?: number | null;
  command?: string | null;
  description?: string;
  choices?: readonly string[];
  smartDenied?: boolean;
  smartDeniedReason?: string;
  expiresAt?: string | null;
  persistentGrant?: Partial<ApprovalPersistentGrantInfo> | null;
  riskCategories?: readonly string[];
  origin?: CapabilityOrigin | string | null;
  source?: string | null;
  providerKind?: CapabilityProviderKind | null;
  providerId?: string | null;
  mcpServer?: string | null;
  pluginName?: string | null;
  skillName?: string | null;
  toolset?: string | null;
  gatewayId?: string | null;
}

export interface MainApprovalContext {
  connectionLabel?: string | null;
  connectionKind?: ConnectionKind | null;
  hostDisplay?: string | null;
  profileDisplayName?: string | null;
  sessionTitle?: string | null;
  cwd?: string | null;
  ownerGeneration: number;
  authorityEpoch: number;
  connectionOnline: boolean;
}

export interface ApprovalIngestInput {
  gateway: GatewayApprovalPayload;
  main: MainApprovalContext;
}

export interface GatewayApprovalRespondPayload {
  connectionId: string;
  profileId: string;
  sessionId: string;
  turnId: string;
  approvalId: string;
  ownerGeneration: number;
  executionGeneration: number;
  choice: ApprovalChoice;
  serverRequestId?: string | number;
}

export interface GatewayApprovalRespondOutcome {
  status: "settled" | "settled_elsewhere_by_server";
  choice?: ApprovalChoice;
  message?: string;
}

export interface ApprovalCoordinatorPorts {
  now?: () => number;
  createApprovalKey?: () => string;
  confirmHighRiskApproval?: (request: ApprovalHighRiskSheetRequest) => Promise<boolean>;
  sendApprovalRespond?: (
    payload: GatewayApprovalRespondPayload,
  ) => Promise<GatewayApprovalRespondOutcome>;
  fetchPendingApprovals?: (scope: {
    connectionId: string;
    profileId: string;
  }) => Promise<readonly ApprovalIngestInput[]>;
  onChange?: (snapshot: ApprovalTopicSnapshot) => void;
}

interface InternalApprovalRecord {
  approvalKey: string;
  binding: ApprovalBinding;
  state: ApprovalState;
  connectionLabel: string;
  connectionKind: ConnectionKind;
  hostDisplay: string;
  profileDisplayName: string;
  sessionTitle: string;
  cwd: string | null;
  authorityEpoch: number;
  command: string | null;
  description: string;
  gatewayChoices: ApprovalChoice[];
  riskCategories: ApprovalRiskCategory[];
  smartDenied: boolean;
  smartDeniedReason?: string;
  expiresAt: string | null;
  missingContextFields: string[];
  persistentGrant?: ApprovalPersistentGrantInfo;
  inFlight: boolean;
  settledChoice?: ApprovalChoice;
  statusReason?: string;
  attribution: ExternalAttribution;
  updatedAt: string;
}

const TERMINAL_IMMUTABLE_STATES = new Set<ApprovalState>([
  "settled",
  "settled_elsewhere_by_server",
  "stale_owner",
  "expired",
  "orphaned",
]);

function makeCoordinatorError(code: ErrorCode, message: string): Error {
  const err = new Error(message);
  (err as { code?: ErrorCode }).code = code;
  return err;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeGatewayChoices(raw: readonly string[] | undefined): ApprovalChoice[] {
  const valid = new Set<ApprovalChoice>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === "once" || item === "session" || item === "always" || item === "deny") {
        valid.add(item);
      }
    }
  }
  valid.add("deny");
  const ordered: ApprovalChoice[] = ["once", "session", "always", "deny"];
  return ordered.filter((c) => valid.has(c));
}

function normalizePersistentGrant(
  raw: Partial<ApprovalPersistentGrantInfo> | null | undefined,
): ApprovalPersistentGrantInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const pattern = cleanText(raw.pattern);
  const scope = cleanText(raw.scope);
  const revokeHint = cleanText(raw.revokeHint);
  if (!pattern || !scope || !revokeHint) {
    return undefined;
  }
  return Object.freeze({ pattern, scope, revokeHint });
}

export function classifyApprovalRisk(
  command: string | null,
  description: string,
  gatewayHints?: readonly string[],
): ApprovalRiskCategory[] {
  const found = new Set<ApprovalRiskCategory>();
  const combined = `${command ?? ""}\n${description}`;

  if (/\b(?:sudo|doas|pkexec|su\s+-)\b/i.test(combined)) {
    found.add("sudo");
  }
  if (
    /(?:\.env\b|id_rsa|id_ed25519|authorized_keys|keychain|security\s+find-(?:generic|internet)-password|aws_secret|private[\s_-]*key|credentials|\.ssh\/|api[_-]*key|secret|token|passphrase)/i.test(
      combined,
    )
  ) {
    found.add("secret");
  }
  if (
    /(?:\bvault\b|\b1password\b|\bop\s+|\bpass\s+|\bsops\b|\bkms\b|\bbitwarden\b|\bgpg\b)/i.test(
      combined,
    )
  ) {
    found.add("vault");
  }
  if (
    /(?:\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bchmod\s+-R\s+777\b|\bchown\s+-R\b|\bgit\s+reset\s+--hard\b|\bgit\s+push\s+(?:--force|-f)\b|\bgit\s+clean\s+-[a-z]*f|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b|\bkill\s+-9\b|\bdiskutil\s+erase)/i.test(
      combined,
    )
  ) {
    found.add("destructive");
  }

  if (Array.isArray(gatewayHints)) {
    for (const hint of gatewayHints) {
      if (
        hint === "sudo" ||
        hint === "secret" ||
        hint === "vault" ||
        hint === "destructive" ||
        hint === "always"
      ) {
        found.add(hint);
      }
    }
  }

  return [...found];
}

export function requiresHighRiskConfirmationSheet(
  view: Pick<ApprovalView, "riskCategories">,
  choice: ApprovalChoice,
): boolean {
  if (choice === "deny") return false;
  if (choice === "always") return true;
  return view.riskCategories.some(
    (c) => c === "sudo" || c === "secret" || c === "vault" || c === "destructive",
  );
}

function validateCompleteness(input: {
  command: string | null;
  hostDisplay: string;
  profileId: string;
  profileDisplayName: string;
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  cwd: string | null;
  ownerGeneration: number;
  executionGeneration: number;
}): string[] {
  const missing: string[] = [];
  if (!cleanText(input.command)) missing.push("command");
  if (!cleanText(input.hostDisplay)) missing.push("host");
  if (!cleanText(input.profileId) || !cleanText(input.profileDisplayName)) missing.push("profile");
  if (!cleanText(input.sessionId) || !cleanText(input.sessionTitle)) missing.push("session");
  if (!cleanText(input.turnId)) missing.push("turnId");
  if (!cleanText(input.cwd)) missing.push("cwd");
  if (!(input.ownerGeneration > 0) || !(input.executionGeneration > 0)) {
    missing.push("generation");
  }
  return missing;
}

function isTupleMatch(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.profileId === b.profileId &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.approvalId === b.approvalId &&
    a.ownerGeneration === b.ownerGeneration &&
    a.executionGeneration === b.executionGeneration
  );
}

export class ApprovalAndRecoveryCoordinator {
  private readonly now: () => number;
  private readonly createApprovalKey: () => string;
  private readonly confirmHighRiskApproval: (
    request: ApprovalHighRiskSheetRequest,
  ) => Promise<boolean>;
  private readonly sendApprovalRespond: (
    payload: GatewayApprovalRespondPayload,
  ) => Promise<GatewayApprovalRespondOutcome>;
  private readonly fetchPendingApprovals: (scope: {
    connectionId: string;
    profileId: string;
  }) => Promise<readonly ApprovalIngestInput[]>;
  private readonly onChange?: (snapshot: ApprovalTopicSnapshot) => void;

  private readonly recordsByKey = new Map<string, InternalApprovalRecord>();
  private keySeq = 0;
  private activeScope: BridgeScope | null = null;

  constructor(ports: ApprovalCoordinatorPorts = {}) {
    this.now = ports.now ?? (() => Date.now());
    this.createApprovalKey =
      ports.createApprovalKey ?? (() => `apr_${++this.keySeq}_${Math.abs(this.now()).toString(36)}`);
    this.confirmHighRiskApproval = ports.confirmHighRiskApproval ?? (async () => false);
    this.sendApprovalRespond =
      ports.sendApprovalRespond ?? (async () => ({ status: "settled" }));
    this.fetchPendingApprovals = ports.fetchPendingApprovals ?? (async () => []);
    this.onChange = ports.onChange;
  }

  setActiveScope(scope: BridgeScope | null): void {
    this.activeScope = scope ? { ...scope } : null;
  }

  getActiveScope(): BridgeScope | null {
    return this.activeScope ? { ...this.activeScope } : null;
  }

  getBinding(approvalKey: string): ApprovalBinding | null {
    const rec = this.recordsByKey.get(approvalKey);
    if (!rec) return null;
    return Object.freeze({ ...rec.binding });
  }

  hasPendingForSession(connectionId: string, profileId: string, sessionId: string): boolean {
    for (const rec of this.recordsByKey.values()) {
      if (
        rec.binding.connectionId === connectionId &&
        rec.binding.profileId === profileId &&
        rec.binding.sessionId === sessionId &&
        (rec.state === "actionable" ||
          rec.state === "context_incomplete" ||
          rec.state === "unverified" ||
          rec.state === "submitting" ||
          rec.state === "delivery_unknown")
      ) {
        return true;
      }
    }
    return false;
  }

  snapshot(): ApprovalTopicSnapshot {
    const views = [...this.recordsByKey.values()].map((rec) => this.toImmutableView(rec));
    const pendingCount = views.filter(
      (v) =>
        v.state === "actionable" ||
        v.state === "context_incomplete" ||
        v.state === "unverified" ||
        v.state === "submitting" ||
        v.state === "delivery_unknown",
    ).length;
    const orphanedCount = views.filter((v) => v.state === "orphaned").length;
    return Object.freeze({
      approvals: Object.freeze(views),
      pendingCount,
      orphanedCount,
    });
  }

  receive(input: ApprovalIngestInput): ApprovalView {
    const record = this.upsertRecord(input);
    this.emitChange();
    return this.toImmutableView(record);
  }

  onExpiryTick(nowMs: number = this.now()): boolean {
    let changed = false;
    for (const rec of this.recordsByKey.values()) {
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state) || rec.inFlight) continue;
      if (rec.expiresAt) {
        const expMs = Date.parse(rec.expiresAt);
        if (Number.isFinite(expMs) && nowMs >= expMs) {
          rec.state = "expired";
          rec.updatedAt = new Date(nowMs).toISOString();
          changed = true;
        }
      }
    }
    if (changed) this.emitChange();
    return changed;
  }

  onConnectionOffline(connectionId: string, profileId?: string): boolean {
    let changed = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const rec of this.recordsByKey.values()) {
      if (rec.binding.connectionId !== connectionId) continue;
      if (profileId && rec.binding.profileId !== profileId) continue;
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state)) continue;
      if (rec.state !== "unverified" && rec.state !== "delivery_unknown") {
        rec.state = "unverified";
        rec.updatedAt = nowIso;
        changed = true;
      }
    }
    if (changed) this.emitChange();
    return changed;
  }

  onOwnerGenerationChanged(
    connectionId: string,
    newOwnerGeneration: number,
    profileId?: string,
  ): boolean {
    let changed = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const rec of this.recordsByKey.values()) {
      if (rec.binding.connectionId !== connectionId) continue;
      if (profileId && rec.binding.profileId !== profileId) continue;
      if (rec.binding.ownerGeneration >= newOwnerGeneration) continue;
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state)) continue;
      rec.inFlight = false;
      rec.state = "stale_owner";
      rec.updatedAt = nowIso;
      changed = true;
    }
    if (changed) this.emitChange();
    return changed;
  }

  onScopeRemoved(scope: { connectionId: string; profileId?: string }): boolean {
    let changed = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const rec of this.recordsByKey.values()) {
      if (rec.binding.connectionId !== scope.connectionId) continue;
      if (scope.profileId && rec.binding.profileId !== scope.profileId) continue;
      if (rec.state === "settled" || rec.state === "settled_elsewhere_by_server" || rec.state === "orphaned") {
        continue;
      }
      rec.inFlight = false;
      rec.state = "orphaned";
      rec.updatedAt = nowIso;
      changed = true;
    }
    if (changed) this.emitChange();
    return changed;
  }

  reconcile(
    scope: { connectionId: string; profileId?: string; ownerGeneration: number },
    pendingFromGateway: readonly ApprovalIngestInput[],
  ): ApprovalTopicSnapshot {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    // 1. Any older ownerGeneration immediately becomes stale_owner
    this.onOwnerGenerationChanged(scope.connectionId, scope.ownerGeneration, scope.profileId);

    // 2. Same-generation resync marks all active records for this scope & ownerGeneration as unverified first
    for (const rec of this.recordsByKey.values()) {
      if (rec.binding.connectionId !== scope.connectionId) continue;
      if (scope.profileId && rec.binding.profileId !== scope.profileId) continue;
      if (rec.binding.ownerGeneration !== scope.ownerGeneration) continue;
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state)) continue;
      if (!rec.inFlight) {
        rec.state = "unverified";
        rec.updatedAt = nowIso;
      }
    }

    // 3. Reconcile against authoritative pending by exact 4-tuple (approvalId, ownerGeneration, executionGeneration, turnId)
    for (const item of pendingFromGateway) {
      const candidateBinding = this.buildBinding(item);
      const existing = this.findMatchingRecord(candidateBinding);
      if (existing && TERMINAL_IMMUTABLE_STATES.has(existing.state)) {
        // Never revive stale_owner / settled / expired / orphaned cards in-place
        continue;
      }
      this.upsertRecord(item);
    }

    // 4. Missing records stay unverified (never auto-deny!), unless deadline passed -> expired
    this.onExpiryTick(nowMs);
    this.emitChange();
    return this.snapshot();
  }

  async respond(approvalKey: string, choice: ApprovalChoice): Promise<ApprovalRespondResult> {
    const rec = this.recordsByKey.get(approvalKey);
    if (!rec) {
      throw makeCoordinatorError("not_found", "未找到对应的 Approval 请求");
    }

    if (rec.inFlight) {
      throw makeCoordinatorError("conflict", "同一 Approval 已有正在提交的响应");
    }

    this.assertRespondAllowed(rec, choice);
    const currentView = this.toImmutableView(rec);

    if (requiresHighRiskConfirmationSheet(currentView, choice)) {
      const isOwningSessionBackground = !currentView.isOwningSessionActive;
      rec.inFlight = true;
      rec.updatedAt = new Date(this.now()).toISOString();
      this.emitChange();
      let confirmed = false;
      try {
        confirmed = await this.confirmHighRiskApproval({
          approvalKey: rec.approvalKey,
          choice,
          connectionLabel: rec.connectionLabel,
          connectionKind: rec.connectionKind,
          hostDisplay: rec.hostDisplay,
          profileDisplayName: rec.profileDisplayName,
          sessionTitle: rec.sessionTitle,
          isOwningSessionBackground,
          command: rec.command ?? "",
          cwd: rec.cwd ?? "",
          riskCategories: currentView.riskCategories,
          ...(rec.persistentGrant ? { persistentGrant: rec.persistentGrant } : {}),
        });
      } catch (err) {
        rec.inFlight = false;
        rec.updatedAt = new Date(this.now()).toISOString();
        this.emitChange();
        throw err;
      }
      if (!confirmed) {
        rec.inFlight = false;
        rec.updatedAt = new Date(this.now()).toISOString();
        this.emitChange();
        return {
          status: "cancelled_pending",
          approval: this.toImmutableView(rec),
        };
      }
      try {
        this.assertRespondAllowed(rec, choice);
      } catch (err) {
        rec.inFlight = false;
        rec.updatedAt = new Date(this.now()).toISOString();
        this.emitChange();
        throw err;
      }
    }

    const expectedBinding: ApprovalBinding = { ...rec.binding };
    rec.inFlight = true;
    rec.state = "submitting";
    rec.updatedAt = new Date(this.now()).toISOString();
    this.emitChange();

    try {
      const outcome = await this.sendApprovalRespond({
        connectionId: expectedBinding.connectionId,
        profileId: expectedBinding.profileId,
        sessionId: expectedBinding.sessionId,
        turnId: expectedBinding.turnId,
        approvalId: expectedBinding.approvalId,
        ownerGeneration: expectedBinding.ownerGeneration,
        executionGeneration: expectedBinding.executionGeneration,
        choice,
        ...(expectedBinding.serverRequestId !== undefined
          ? { serverRequestId: expectedBinding.serverRequestId }
          : {}),
      });

      rec.inFlight = false;
      rec.updatedAt = new Date(this.now()).toISOString();
      const postRpcState: ApprovalState =
        this.recordsByKey.get(approvalKey)?.state ?? rec.state;
      if (
        postRpcState === "stale_owner" ||
        postRpcState === "orphaned" ||
        postRpcState === "expired"
      ) {
        this.emitChange();
        return {
          status: "settled_elsewhere_by_server",
          approval: this.toImmutableView(rec),
          message: outcome.message,
        };
      }

      if (outcome.status === "settled_elsewhere_by_server") {
        rec.state = "settled_elsewhere_by_server";
        rec.statusReason = outcome.message ?? "该 Approval 已在别处处理或已不再等待";
        this.emitChange();
        return {
          status: "settled_elsewhere_by_server",
          approval: this.toImmutableView(rec),
          message: rec.statusReason,
        };
      }

      rec.state = "settled";
      rec.settledChoice = outcome.choice ?? choice;
      this.emitChange();
      return {
        status: "settled",
        approval: this.toImmutableView(rec),
      };
    } catch {
      rec.inFlight = false;
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state)) {
        this.emitChange();
        return {
          status: "settled_elsewhere_by_server",
          approval: this.toImmutableView(rec),
        };
      }

      rec.state = "delivery_unknown";
      rec.updatedAt = new Date(this.now()).toISOString();
      this.emitChange();

      // ACK loss: check authoritative pending list before assuming settled/failed
      try {
        const pending = await this.fetchPendingApprovals({
          connectionId: expectedBinding.connectionId,
          profileId: expectedBinding.profileId,
        });
        const stillPending = pending.find((item) => {
          const b = this.buildBinding(item);
          return (
            b.approvalId === expectedBinding.approvalId &&
            b.ownerGeneration === expectedBinding.ownerGeneration &&
            b.executionGeneration === expectedBinding.executionGeneration &&
            b.turnId === expectedBinding.turnId
          );
        });
        if (stillPending) {
          this.upsertRecord(stillPending);
          this.emitChange();
          return {
            status: "pending_reconciled",
            approval: this.toImmutableView(rec),
          };
        }

        rec.state = "settled_elsewhere_by_server";
        rec.statusReason = "已在权威 pending 中确认不再等待";
        rec.updatedAt = new Date(this.now()).toISOString();
        this.emitChange();
        return {
          status: "settled_elsewhere_by_server",
          approval: this.toImmutableView(rec),
          message: rec.statusReason,
        };
      } catch {
        // Still offline / unreachable during pending probe -> keep delivery_unknown
        return {
          status: "delivery_unknown",
          approval: this.toImmutableView(rec),
        };
      }
    }
  }

  dismissOrphaned(approvalKey: string): ApprovalTopicSnapshot {
    const rec = this.recordsByKey.get(approvalKey);
    if (!rec) {
      throw makeCoordinatorError("not_found", "未找到对应的孤立 Approval 记录");
    }
    if (rec.state !== "orphaned") {
      throw makeCoordinatorError("conflict", "仅已孤立的只读 Approval 记录可被清除");
    }
    this.recordsByKey.delete(approvalKey);
    this.emitChange();
    return this.snapshot();
  }

  markSettledElsewhereByServer(input: {
    connectionId: string;
    profileId: string;
    sessionId?: string;
    approvalId: string;
    turnId?: string;
    ownerGeneration?: number;
    executionGeneration?: number;
    reason?: string;
  }): boolean {
    let changed = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const rec of this.recordsByKey.values()) {
      if (rec.binding.connectionId !== input.connectionId) continue;
      if (rec.binding.profileId !== input.profileId) continue;
      if (input.sessionId && rec.binding.sessionId !== input.sessionId) continue;
      if (rec.binding.approvalId !== input.approvalId) continue;
      if (input.turnId && rec.binding.turnId !== input.turnId) continue;
      if (
        input.ownerGeneration !== undefined &&
        rec.binding.ownerGeneration !== input.ownerGeneration
      ) {
        continue;
      }
      if (
        input.executionGeneration !== undefined &&
        rec.binding.executionGeneration !== input.executionGeneration
      ) {
        continue;
      }
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state)) continue;
      rec.inFlight = false;
      rec.state = "settled_elsewhere_by_server";
      rec.statusReason = input.reason ?? "该 Approval 已在别处处理或已不再等待";
      rec.updatedAt = nowIso;
      changed = true;
    }
    if (changed) this.emitChange();
    return changed;
  }

  markExpired(input: {
    connectionId: string;
    profileId: string;
    approvalId: string;
    sessionId?: string;
    turnId?: string;
  }): boolean {
    let changed = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const rec of this.recordsByKey.values()) {
      if (rec.binding.connectionId !== input.connectionId) continue;
      if (rec.binding.profileId !== input.profileId) continue;
      if (rec.binding.approvalId !== input.approvalId) continue;
      if (input.sessionId && rec.binding.sessionId !== input.sessionId) continue;
      if (input.turnId && rec.binding.turnId !== input.turnId) continue;
      if (TERMINAL_IMMUTABLE_STATES.has(rec.state)) continue;
      rec.inFlight = false;
      rec.state = "expired";
      rec.updatedAt = nowIso;
      changed = true;
    }
    if (changed) this.emitChange();
    return changed;
  }

  private assertRespondAllowed(rec: InternalApprovalRecord, choice: ApprovalChoice): void {
    if (rec.state === "orphaned") {
      throw makeCoordinatorError("approval_scope_mismatch", "该 Approval 已孤立为只读，无法转发");
    }
    if (rec.state === "stale_owner" || rec.state === "expired") {
      throw makeCoordinatorError("approval_stale", "该 Approval 已失效或过期");
    }
    if (rec.state === "settled" || rec.state === "settled_elsewhere_by_server") {
      throw makeCoordinatorError("conflict", "该 Approval 已处理，不能重复提交");
    }
    if (rec.state === "unverified" || rec.state === "delivery_unknown") {
      throw makeCoordinatorError("conflict", "该 Approval 正在等待权威对账校验");
    }
    const view = this.toImmutableView(rec);
    if (rec.state === "context_incomplete" && choice !== "deny") {
      throw makeCoordinatorError("invalid_request", "上下文不完整时仅允许拒绝或查看详情");
    }
    if (!view.allowedChoices.includes(choice)) {
      throw makeCoordinatorError("invalid_request", "当前 Approval 不支持该操作选项");
    }
  }

  private buildBinding(input: ApprovalIngestInput): ApprovalBinding {
    return {
      connectionId: cleanText(input.gateway.connectionId),
      profileId: cleanText(input.gateway.profileId),
      sessionId: cleanText(input.gateway.sessionId),
      turnId: cleanText(input.gateway.turnId),
      approvalId: cleanText(input.gateway.approvalId),
      ownerGeneration:
        typeof input.main.ownerGeneration === "number" && Number.isFinite(input.main.ownerGeneration)
          ? input.main.ownerGeneration
          : 0,
      executionGeneration:
        typeof input.gateway.executionGeneration === "number" &&
        Number.isFinite(input.gateway.executionGeneration)
          ? input.gateway.executionGeneration
          : 0,
      ...(input.gateway.serverRequestId !== undefined
        ? { serverRequestId: input.gateway.serverRequestId }
        : {}),
    };
  }

  private findMatchingRecord(binding: ApprovalBinding): InternalApprovalRecord | undefined {
    for (const rec of this.recordsByKey.values()) {
      if (isTupleMatch(rec.binding, binding)) {
        return rec;
      }
    }
    return undefined;
  }

  private upsertRecord(input: ApprovalIngestInput): InternalApprovalRecord {
    const binding = this.buildBinding(input);
    const existing = this.findMatchingRecord(binding);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    if (existing && TERMINAL_IMMUTABLE_STATES.has(existing.state)) {
      return existing;
    }

    const command = cleanText(input.gateway.command) || null;
    const description = cleanText(input.gateway.description);
    const hostDisplay = cleanText(input.main.hostDisplay);
    const profileDisplayName = cleanText(input.main.profileDisplayName);
    const sessionTitle = cleanText(input.main.sessionTitle);
    const connectionLabel = cleanText(input.main.connectionLabel) || binding.connectionId;
    const connectionKind: ConnectionKind = input.main.connectionKind ?? "local";
    const cwd = cleanText(input.main.cwd) || null;
    const expiresAt = cleanText(input.gateway.expiresAt) || null;
    const persistentGrant = normalizePersistentGrant(input.gateway.persistentGrant);
    const gatewayChoices = normalizeGatewayChoices(input.gateway.choices);
    const riskCategories = classifyApprovalRisk(
      command,
      description,
      input.gateway.riskCategories,
    );
    const attribution = resolveExternalAttribution({
      origin: input.gateway.origin,
      source: input.gateway.source,
      providerKind: input.gateway.providerKind,
      providerId: input.gateway.providerId,
      mcpServer: input.gateway.mcpServer,
      pluginName: input.gateway.pluginName,
      skillName: input.gateway.skillName,
      toolset: input.gateway.toolset,
      gatewayId: input.gateway.gatewayId,
    });

    const missingContextFields = validateCompleteness({
      command,
      hostDisplay,
      profileId: binding.profileId,
      profileDisplayName,
      sessionId: binding.sessionId,
      sessionTitle,
      turnId: binding.turnId,
      cwd,
      ownerGeneration: binding.ownerGeneration,
      executionGeneration: binding.executionGeneration,
    });

    let nextState: ApprovalState = "actionable";
    if (expiresAt) {
      const expMs = Date.parse(expiresAt);
      if (Number.isFinite(expMs) && nowMs >= expMs) {
        nextState = "expired";
      }
    }
    if (nextState !== "expired" && !input.main.connectionOnline) {
      nextState = "unverified";
    } else if (nextState !== "expired" && missingContextFields.length > 0) {
      nextState = "context_incomplete";
    }

    if (existing) {
      existing.connectionLabel = connectionLabel;
      existing.connectionKind = connectionKind;
      existing.hostDisplay = hostDisplay;
      existing.profileDisplayName = profileDisplayName;
      existing.sessionTitle = sessionTitle;
      existing.cwd = cwd;
      existing.authorityEpoch = input.main.authorityEpoch;
      existing.command = command;
      existing.description = description;
      existing.gatewayChoices = gatewayChoices;
      existing.riskCategories = riskCategories;
      existing.smartDenied = Boolean(input.gateway.smartDenied);
      existing.smartDeniedReason = cleanText(input.gateway.smartDeniedReason) || undefined;
      existing.expiresAt = expiresAt;
      existing.missingContextFields = missingContextFields;
      existing.persistentGrant = persistentGrant;
      existing.attribution = attribution;
      existing.state = nextState;
      existing.updatedAt = nowIso;
      return existing;
    }

    const approvalKey = this.createApprovalKey();
    const created: InternalApprovalRecord = {
      approvalKey,
      binding: Object.freeze(binding),
      state: nextState,
      connectionLabel,
      connectionKind,
      hostDisplay,
      profileDisplayName,
      sessionTitle,
      cwd,
      authorityEpoch: input.main.authorityEpoch,
      command,
      description,
      gatewayChoices,
      riskCategories,
      smartDenied: Boolean(input.gateway.smartDenied),
      smartDeniedReason: cleanText(input.gateway.smartDeniedReason) || undefined,
      expiresAt,
      missingContextFields,
      persistentGrant,
      inFlight: false,
      attribution,
      updatedAt: nowIso,
    };
    this.recordsByKey.set(approvalKey, created);
    return created;
  }

  private computeAllowedChoices(rec: InternalApprovalRecord): readonly ApprovalChoice[] {
    if (
      rec.state === "settled" ||
      rec.state === "settled_elsewhere_by_server" ||
      rec.state === "stale_owner" ||
      rec.state === "expired" ||
      rec.state === "orphaned" ||
      rec.state === "unverified" ||
      rec.state === "delivery_unknown" ||
      rec.state === "submitting"
    ) {
      return Object.freeze([]);
    }
    if (rec.state === "context_incomplete") {
      return Object.freeze(["deny"]);
    }
    const choices: ApprovalChoice[] = [];
    for (const c of rec.gatewayChoices) {
      if (c === "once") {
        choices.push("once");
      } else if (c === "session") {
        if (!rec.smartDenied) {
          choices.push("session");
        }
      } else if (c === "always") {
        if (!rec.smartDenied && rec.persistentGrant) {
          choices.push("always");
        }
      } else if (c === "deny") {
        choices.push("deny");
      }
    }
    if (!choices.includes("deny")) {
      choices.push("deny");
    }
    return Object.freeze(choices);
  }

  private toImmutableView(rec: InternalApprovalRecord): ApprovalView {
    const allowedChoices = this.computeAllowedChoices(rec);
    const canApprove =
      rec.state === "actionable" &&
      !rec.inFlight &&
      allowedChoices.some((c) => c === "once" || c === "session" || c === "always");
    const canDeny =
      (rec.state === "actionable" || rec.state === "context_incomplete") &&
      !rec.inFlight &&
      allowedChoices.includes("deny");
    const isOwningSessionActive = Boolean(
      this.activeScope &&
        this.activeScope.connectionId === rec.binding.connectionId &&
        (this.activeScope.profileId ?? "default") === rec.binding.profileId &&
        this.activeScope.sessionId === rec.binding.sessionId,
    );
    const requiresHighRiskSheet =
      rec.riskCategories.some(
        (c) => c === "sudo" || c === "secret" || c === "vault" || c === "destructive",
      ) || allowedChoices.includes("always");

    return Object.freeze({
      approvalKey: rec.approvalKey,
      state: rec.state,
      connectionId: rec.binding.connectionId,
      profileId: rec.binding.profileId,
      sessionId: rec.binding.sessionId,
      connectionLabel: rec.connectionLabel,
      connectionKind: rec.connectionKind,
      hostDisplay: rec.hostDisplay,
      profileDisplayName: rec.profileDisplayName,
      sessionTitle: rec.sessionTitle,
      turnId: rec.binding.turnId || null,
      cwd: rec.cwd,
      ownerGeneration: rec.binding.ownerGeneration,
      authorityEpoch: rec.authorityEpoch,
      executionGeneration: rec.binding.executionGeneration,
      riskCategories: Object.freeze([...rec.riskCategories]),
      requiresHighRiskSheet,
      command: rec.command,
      description: rec.description,
      allowedChoices,
      smartDenied: rec.smartDenied,
      ...(rec.smartDeniedReason ? { smartDeniedReason: rec.smartDeniedReason } : {}),
      expiresAt: rec.expiresAt,
      missingContextFields: Object.freeze([...rec.missingContextFields]),
      ...(rec.persistentGrant ? { persistentGrant: rec.persistentGrant } : {}),
      isOwningSessionActive,
      inFlight: rec.inFlight,
      ...(rec.settledChoice ? { settledChoice: rec.settledChoice } : {}),
      ...(rec.statusReason ? { statusReason: rec.statusReason } : {}),
      canApprove,
      canDeny,
      canInspect: true,
      canDismiss: rec.state === "orphaned",
      attribution: rec.attribution,
      updatedAt: rec.updatedAt,
    });
  }

  private emitChange(): void {
    this.onChange?.(this.snapshot());
  }
}

const FORBIDDEN_APPROVAL_OVERRIDE_KEYS = new Set([
  "target",
  "connection",
  "connectionId",
  "profile",
  "profileId",
  "session",
  "sessionId",
  "command",
  "scope",
  "serverRequestId",
  "approvalId",
  "turnId",
  "ownerGeneration",
  "executionGeneration",
  "cwd",
  "host",
  "hostDisplay",
  "binding",
]);

/**
 * Validates a Renderer `approvals.respond` request payload, rejecting any
 * writable target, scope, command, or internal identity override fields.
 */
export function assertApprovalRespondPayloadSafe(payload: Record<string, unknown>): {
  approvalKey: string;
  choice: ApprovalChoice;
} {
  for (const key of FORBIDDEN_APPROVAL_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      throw makeCoordinatorError(
        "invalid_request",
        "Approval 响应仅允许传入 approvalKey 与 choice，禁止客户端改写目标或命令",
      );
    }
  }
  const approvalKey = cleanText(payload.approvalKey);
  if (!approvalKey) {
    throw makeCoordinatorError("invalid_request", "缺少有效的 approvalKey");
  }
  const choice = payload.choice;
  if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") {
    throw makeCoordinatorError("invalid_request", "无效的 Approval 操作选项");
  }
  return { approvalKey, choice };
}

/**
 * Validates a Renderer `approvals.dismissOrphaned` request payload.
 */
export function assertApprovalDismissPayloadSafe(payload: Record<string, unknown>): {
  approvalKey: string;
} {
  for (const key of FORBIDDEN_APPROVAL_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      throw makeCoordinatorError("invalid_request", "禁止传入只读上下文覆写字段");
    }
  }
  const approvalKey = cleanText(payload.approvalKey);
  if (!approvalKey) {
    throw makeCoordinatorError("invalid_request", "缺少有效的 approvalKey");
  }
  return { approvalKey };
}
