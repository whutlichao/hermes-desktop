import { useEffect, useRef, useState } from "react";
import type {
  CapabilitySnapshot,
  CronJobActionRequest,
  CronStateView,
  CronSubmitRequest,
  DomainInspectTab,
  MemoryContextView,
  MessagingStatusView,
} from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";
import { AttributionBadge } from "./AttributionBadge";
import { FocusDialog } from "./Modal";

interface DomainInspectDrawerProps {
  open: boolean;
  tab: DomainInspectTab;
  snapshot: CapabilitySnapshot;
  busy: boolean;
  error: string | null;
  onTabChange: (tab: DomainInspectTab) => void;
  onClose: () => void;
  onRefresh: (tab: DomainInspectTab) => void;
  onSubmitCron: (request: CronSubmitRequest) => void;
  onCancelCron: (request: CronJobActionRequest) => void;
  onRecoverCron: (request: CronJobActionRequest) => void;
  onCopyText: (text: string) => void;
  onOpenDocs: (url: string) => void;
}

const TABS: Array<{ id: DomainInspectTab; labelKey: CopyKey }> = [
  { id: "memory", labelKey: "domainInspect.tab.memory" },
  { id: "messaging", labelKey: "domainInspect.tab.messaging" },
  { id: "cron", labelKey: "domainInspect.tab.cron" },
];

function statusNotice(tab: "memory" | "messaging", status: string): CopyKey | null {
  if (status === "empty" || status === "available") return null;
  if (tab === "memory") {
    if (status === "unsupported") return "memory.stateUnsupported";
    if (status === "unknown") return "memory.stateUnknown";
    return "memory.stateError";
  }
  if (status === "unsupported") return "messaging.stateUnsupported";
  if (status === "unknown") return "messaging.stateUnknown";
  return "messaging.stateError";
}

function MemoryPanel({ memory }: { memory: MemoryContextView }) {
  const noticeKey = statusNotice("memory", memory.status);
  if (noticeKey) {
    return (
      <div className="domain-inspect-state" data-testid="memory-state-notice">
        {getCopy(noticeKey)}
      </div>
    );
  }
  return (
    <section aria-labelledby="memory-panel-title">
      <h3 id="memory-panel-title">{getCopy("memory.title")}</h3>
      <p className="domain-inspect-note">{getCopy("memory.readOnlyNote")}</p>
      <dl className="domain-inspect-meta">
        {memory.sourceMethod && (
          <div>
            <dt>{getCopy("memory.sourceMethodLabel")}</dt>
            <dd>
              <code>{memory.sourceMethod}</code>
            </dd>
          </div>
        )}
        {(memory.totalTokens !== undefined || memory.maxTokens !== undefined) && (
          <div>
            <dt>{getCopy("memory.totalTokensLabel")}</dt>
            <dd>
              {memory.totalTokens ?? getCopy("common.notProvided")}
              {memory.maxTokens !== undefined ? ` / ${memory.maxTokens}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {memory.sections.length === 0 ? (
        <div className="domain-inspect-state">{getCopy("memory.stateEmpty")}</div>
      ) : (
        <ul
          className="domain-inspect-list"
          aria-label={getCopy("domainInspect.memorySectionsLabel")}
          data-testid="memory-sections"
        >
          {memory.sections.map((section) => (
            <li key={section.id} className="domain-inspect-row">
              <span className="domain-inspect-row-title">{section.label}</span>
              <span className="domain-inspect-row-meta">
                {section.tokens !== undefined ? `${section.tokens} Token` : null}
                {section.percentage !== undefined ? ` · ${section.percentage}%` : null}
                {section.entryCount !== undefined ? ` · ${section.entryCount} 项` : null}
              </span>
              {section.summary && <p className="domain-inspect-row-note">{section.summary}</p>}
            </li>
          ))}
        </ul>
      )}
      {memory.notes.length > 0 && (
        <section aria-label={getCopy("domainInspect.notesLabel")}>
          <h4>{getCopy("domainInspect.notesLabel")}</h4>
          <ul className="domain-inspect-notes">
            {memory.notes.map((note, index) => (
              <li key={`${index}-${note.slice(0, 12)}`}>{note}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function MessagingPanel({ messaging }: { messaging: MessagingStatusView }) {
  const noticeKey = statusNotice("messaging", messaging.status);
  if (noticeKey) {
    return (
      <div className="domain-inspect-state" data-testid="messaging-state-notice">
        {getCopy(noticeKey)}
      </div>
    );
  }
  return (
    <section aria-labelledby="messaging-panel-title">
      <h3 id="messaging-panel-title">{getCopy("messaging.title")}</h3>
      <p className="domain-inspect-note">{getCopy("messaging.readOnlyNote")}</p>
      {messaging.connectors.length === 0 ? (
        <div className="domain-inspect-state">{getCopy("messaging.stateEmpty")}</div>
      ) : (
        <ul
          className="domain-inspect-list"
          aria-label={getCopy("domainInspect.connectorsLabel")}
          data-testid="messaging-connectors"
        >
          {messaging.connectors.map((connector) => (
            <li key={connector.connectorId} className="domain-inspect-row">
              <div className="domain-inspect-row-head">
                <span className="domain-inspect-row-title">{connector.label}</span>
                <AttributionBadge
                  attribution={connector.attribution}
                  testId={`messaging-attribution-${connector.connectorId}`}
                />
                <span
                  className={[
                    "status-pill",
                    connector.status === "error"
                      ? "is-blocked"
                      : connector.status === "connected"
                        ? "is-ready"
                        : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {connector.statusLabel}
                </span>
              </div>
              <span className="domain-inspect-row-meta">{connector.platform}</span>
              {connector.detail && (
                <p className="domain-inspect-row-note">{connector.detail}</p>
              )}
              {connector.errorCode && (
                <p className="domain-inspect-row-note">
                  {getCopy("domainInspect.errorTitle")} · {connector.errorCode}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CronPanel({
  cron,
  busy,
  onSubmit,
  onCancel,
  onRecover,
}: {
  cron: CronStateView;
  busy: boolean;
  onSubmit: (request: CronSubmitRequest) => void;
  onCancel: (request: CronJobActionRequest) => void;
  onRecover: (request: CronJobActionRequest) => void;
}) {
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");

  if (cron.mode === "unavailable") {
    return (
      <div className="domain-inspect-state" data-testid="cron-unavailable-notice">
        {getCopy("cron.unavailableNotice")}
      </div>
    );
  }

  return (
    <section aria-labelledby="cron-panel-title">
      <h3 id="cron-panel-title">{getCopy("cron.title")}</h3>
      <p className="domain-inspect-note">{getCopy("cron.routinesFoldedNote")}</p>
      {cron.mode === "read_only" && (
        <div className="domain-inspect-state" data-testid="cron-read-only-notice">
          {getCopy("cron.readOnlyFallbackNote")}
        </div>
      )}

      {cron.recentRunSummary && (
        <p className="domain-inspect-note">
          {getCopy("chat.emptyCronRecentPrefix")}
          {cron.recentRunSummary}
        </p>
      )}

      {cron.jobs.length === 0 ? (
        <div className="domain-inspect-state">{getCopy("cron.stateEmpty")}</div>
      ) : (
        <ul
          className="domain-inspect-list"
          aria-label={getCopy("domainInspect.jobsLabel")}
          data-testid="cron-jobs"
        >
          {cron.jobs.map((job) => (
            <li key={job.jobId} className="domain-inspect-row" data-testid={`cron-job-${job.jobId}`}>
              <div className="domain-inspect-row-head">
                <span className="domain-inspect-row-title">{job.name}</span>
                <AttributionBadge
                  attribution={job.attribution}
                  testId={`cron-attribution-${job.jobId}`}
                />
                <span
                  className={[
                    "status-pill",
                    job.status === "failed"
                      ? "is-blocked"
                      : job.status === "running"
                        ? "is-warn"
                        : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {job.statusLabel}
                </span>
              </div>
              <dl className="domain-inspect-meta">
                <div>
                  <dt>{getCopy("domainInspect.jobScheduleLabel")}</dt>
                  <dd>
                    <code>{job.schedule}</code>
                  </dd>
                </div>
                {job.lastRunAt && (
                  <div>
                    <dt>{getCopy("domainInspect.jobLastRunLabel")}</dt>
                    <dd>{job.lastRunAt}</dd>
                  </div>
                )}
                {job.nextRunAt && (
                  <div>
                    <dt>{getCopy("domainInspect.jobNextRunLabel")}</dt>
                    <dd>{job.nextRunAt}</dd>
                  </div>
                )}
                {job.lastOutcome && (
                  <div>
                    <dt>{getCopy("domainInspect.jobOutcomeLabel")}</dt>
                    <dd>{job.lastOutcome}</dd>
                  </div>
                )}
              </dl>
              {job.promptSummary && <p className="domain-inspect-row-note">{job.promptSummary}</p>}
              {job.errorCode && (
                <p className="domain-inspect-row-note">
                  {getCopy("domainInspect.errorTitle")} · {job.errorCode}
                </p>
              )}
              <div className="domain-inspect-row-actions">
                {job.canCancel && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => onCancel({ jobId: job.jobId })}
                  >
                    {getCopy("cron.action.cancel")}
                  </button>
                )}
                {job.canRecover && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => onRecover({ jobId: job.jobId })}
                  >
                    {getCopy("cron.action.recover")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cron.supportedActions.canSubmit && (
        <form
          className="cron-submit-form"
          aria-labelledby="cron-submit-title"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            onSubmit({ name: name.trim(), schedule: schedule.trim(), prompt: prompt.trim() });
          }}
        >
          <h4 id="cron-submit-title">{getCopy("cron.submitSectionTitle")}</h4>
          <label>
            <span>{getCopy("cron.field.name")}</span>
            <input
              type="text"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>{getCopy("cron.field.schedule")}</span>
            <input
              type="text"
              value={schedule}
              placeholder="0 9 * * *"
              disabled={busy}
              onChange={(event) => setSchedule(event.target.value)}
            />
          </label>
          <label>
            <span>{getCopy("cron.field.prompt")}</span>
            <textarea
              rows={2}
              value={prompt}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || !name.trim() || !schedule.trim() || !prompt.trim()}
          >
            {getCopy(busy ? "domainInspect.submitBusy" : "cron.action.submit")}
          </button>
        </form>
      )}
    </section>
  );
}

export function DomainInspectDrawer({
  open,
  tab,
  snapshot,
  busy,
  error,
  onTabChange,
  onClose,
  onRefresh,
  onSubmitCron,
  onCancelCron,
  onRecoverCron,
  onCopyText,
  onOpenDocs,
}: DomainInspectDrawerProps) {
  const tabRefs = useRef<Record<DomainInspectTab, HTMLButtonElement | null>>({
    memory: null,
    messaging: null,
    cron: null,
  });
  const activeIndex = TABS.findIndex((item) => item.id === tab);
  const view = tab === "memory" ? snapshot.memory : tab === "messaging" ? snapshot.messaging : snapshot.cron;
  const cliActions = "cliActions" in view ? view.cliActions : [];
  const docsUrl = "docsUrl" in view ? view.docsUrl : undefined;

  useEffect(() => {
    if (!open) return;
    onRefresh(tab);
  }, [open, tab, onRefresh]);

  const moveTab = (delta: number) => {
    const nextIndex = (activeIndex + delta + TABS.length) % TABS.length;
    const next = TABS[nextIndex];
    if (!next) return;
    onTabChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <FocusDialog
      open={open}
      title={getCopy("domainInspect.title")}
      closeLabel={getCopy("domainInspect.close")}
      className="domain-inspect-drawer"
      scrimClassName="is-drawer domain-inspect-scrim"
      onClose={onClose}
    >
      <div className="domain-inspect-toolbar">
        <div
          className="domain-inspect-tablist"
          role="tablist"
          aria-label={getCopy("domainInspect.tablistLabel")}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowRight") {
              event.preventDefault();
              moveTab(1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              moveTab(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              onTabChange("memory");
              tabRefs.current.memory?.focus();
            } else if (event.key === "End") {
              event.preventDefault();
              onTabChange("cron");
              tabRefs.current.cron?.focus();
            }
          }}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[item.id] = el;
              }}
              type="button"
              role="tab"
              id={`domain-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`domain-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={["domain-inspect-tab", tab === item.id && "is-active"]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onTabChange(item.id)}
            >
              {getCopy(item.labelKey)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button-secondary domain-inspect-refresh"
          disabled={busy}
          onClick={() => onRefresh(tab)}
        >
          {getCopy(busy ? "domainInspect.busy" : "domainInspect.refreshAction")}
        </button>
      </div>

      <div
        role="tabpanel"
        id={`domain-panel-${tab}`}
        aria-labelledby={`domain-tab-${tab}`}
        className="domain-inspect-panel"
      >
        {error && (
          <div className="domain-inspect-state is-error" role="alert">
            <strong>{getCopy("domainInspect.errorTitle")}</strong>
            <span>{error}</span>
          </div>
        )}
        {tab === "memory" && (
          <MemoryPanel memory={snapshot.memory} />
        )}
        {tab === "messaging" && (
          <MessagingPanel messaging={snapshot.messaging} />
        )}
        {tab === "cron" && (
          <CronPanel
            cron={snapshot.cron}
            busy={busy}
            onSubmit={onSubmitCron}
            onCancel={onCancelCron}
            onRecover={onRecoverCron}
          />
        )}

        <div className="domain-inspect-actions">
          {cliActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="button button-secondary"
              onClick={() => onCopyText(action.command)}
            >
              {getCopy("domainInspect.copyCliAction")} · {action.command}
            </button>
          ))}
          {docsUrl && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onOpenDocs(docsUrl)}
            >
              {getCopy("domainInspect.openDocsAction")}
            </button>
          )}
        </div>
      </div>
    </FocusDialog>
  );
}
