import { useMemo } from "react";
import type {
  CapabilityDomainSummary,
  CapabilityEntry,
  CapabilityGroup,
  CapabilitySnapshot,
} from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";
import { FocusDialog } from "./Modal";
import {
  getCapabilityStatusCopyKey,
  type CapabilityActionHandler,
} from "./capabilityHandlers";

interface CapabilitiesDrawerProps {
  open: boolean;
  snapshot: CapabilitySnapshot;
  handlers: Record<string, CapabilityActionHandler>;
  onClose: () => void;
}

const GROUP_ORDER: Array<{ group: Exclude<CapabilityGroup, "deferred">; titleKey: CopyKey }> = [
  { group: "core", titleKey: "capabilities.group.core" },
  { group: "admin", titleKey: "capabilities.group.admin" },
  { group: "exec", titleKey: "capabilities.group.exec" },
];

const DEFERRED_DOMAINS = new Set(["voice", "bots", "memory_graph", "kanban"]);

function getClassificationCopyKey(classification: CapabilityDomainSummary["classification"]): CopyKey {
  switch (classification) {
    case "native":
      return "capabilities.class.native";
    case "read_only":
      return "capabilities.class.read_only";
    case "deep_link":
      return "capabilities.class.deep_link";
    case "deferred":
      return "capabilities.class.deferred";
  }
}

export function CapabilitiesDrawer({
  open,
  snapshot,
  handlers,
  onClose,
}: CapabilitiesDrawerProps) {
  const entriesByDomain = useMemo(() => {
    const map = new Map<string, CapabilityEntry[]>();
    for (const entry of snapshot.entries) {
      if (
        entry.classification === "deferred" ||
        DEFERRED_DOMAINS.has(entry.domain) ||
        entry.degradation?.reason === "refused" ||
        !entry.handlerId ||
        !handlers[entry.handlerId] ||
        !entry.evidenceTestId
      ) {
        continue;
      }
      const list = map.get(entry.domain) ?? [];
      list.push(entry);
      map.set(entry.domain, list);
    }
    return map;
  }, [handlers, snapshot.entries]);

  const countsLine = `能力 ${snapshot.counts.reachable} 可达 ${snapshot.counts.deferred} 延期`;

  return (
    <FocusDialog
      open={open}
      title={getCopy("capabilities.title")}
      description={countsLine}
      closeLabel={getCopy("capabilities.close")}
      className="capabilities-drawer"
      scrimClassName="is-drawer"
      onClose={onClose}
    >
      <div className="cap-summary-strip" data-testid="capabilities-counts-summary">
        <span className="cap-counts-line">{countsLine}</span>
        <span className="cap-key-meta">
          {snapshot.key.connectionId} · {snapshot.key.profileId} · gen {snapshot.generation}
        </span>
      </div>

      {snapshot.legacyOwner && (
        <div className="cap-notice is-warn" role="status">
          {getCopy("capabilities.legacyOwnerNotice")}
        </div>
      )}

      {!snapshot.capabilitiesReady && (
        <p className="cap-empty-note">{getCopy("capabilities.probeSummaryEmpty")}</p>
      )}

      <div className="cap-groups">
        {GROUP_ORDER.map(({ group, titleKey }) => {
          const domains = snapshot.domains.filter(
            (d) => d.group === group && d.classification !== "deferred" && !DEFERRED_DOMAINS.has(d.domain),
          );
          return (
            <section
              key={group}
              className="cap-group"
              aria-label={getCopy(titleKey)}
              data-testid={`cap-group-${group}`}
            >
              <header className="cap-group-header">
                <h3>{getCopy(titleKey)}</h3>
                <span className="cap-group-count">{domains.length}</span>
              </header>

              <ul className="cap-domain-list">
                {domains.map((domain) => {
                  const domainEntries = entriesByDomain.get(domain.domain) ?? [];
                  const statusLabel = getCopy(getCapabilityStatusCopyKey(domain.runtimeStatus));
                  const classLabel = getCopy(getClassificationCopyKey(domain.classification));

                  return (
                    <li
                      key={domain.domain}
                      className="cap-domain-card"
                      data-testid={`cap-domain-${domain.domain}`}
                    >
                      <div className="cap-domain-row">
                        <div className="cap-domain-title-wrap">
                          <strong>{getCopy(domain.labelKey as CopyKey)}</strong>
                          <span className="cap-class-tag">{classLabel}</span>
                        </div>
                        <span className={`cap-status-badge is-${domain.runtimeStatus}`}>
                          {statusLabel}
                        </span>
                      </div>

                      {domain.degradation?.reason === "older" && (
                        <p className="cap-domain-note">{getCopy("capabilities.olderNotice")}</p>
                      )}
                      {domain.degradation?.reason === "refused" && (
                        <p className="cap-domain-note">{getCopy("capabilities.refusedNotice")}</p>
                      )}
                      {domain.degradation?.reason === "timeout" && (
                        <p className="cap-domain-note">{getCopy("capabilities.timeoutNotice")}</p>
                      )}

                      {domain.deepLink?.cliCommand && (
                        <p className="cap-deeplink-meta">
                          <code>{domain.deepLink.cliCommand}</code>
                        </p>
                      )}

                      {domainEntries.length > 0 && (
                        <div className="cap-entry-actions">
                          {domainEntries.map((entry) => {
                            const disabled = entry.runtimeStatus === "unavailable";
                            const handler = handlers[entry.handlerId];
                            return (
                              <button
                                key={entry.actionId}
                                type="button"
                                className="button button-secondary cap-action-btn"
                                data-testid={entry.evidenceTestId}
                                data-action-id={entry.actionId}
                                disabled={disabled}
                                onClick={() => {
                                  if (!handler || disabled) return;
                                  void handler(entry);
                                }}
                              >
                                {getCopy(entry.labelKey as CopyKey)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {/* Phase 1 Deferred 4 domains: disclosure footnote ONLY — zero actions, tabs, toggles, or CTAs */}
      <div className="deferred-footnote" data-testid="capabilities-deferred-footnote">
        {getCopy("capabilities.deferredFootnote")}
      </div>
    </FocusDialog>
  );
}
