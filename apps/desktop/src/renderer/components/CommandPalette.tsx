import { useEffect, useId, useMemo, useState } from "react";
import type { CapabilityEntry } from "@hermes/contracts";
import { getCopy, type CopyKey } from "@hermes/domain";
import { FocusDialog } from "./Modal";
import {
  getCapabilityStatusCopyKey,
  type CapabilityActionHandler,
} from "./capabilityHandlers";

interface CommandPaletteProps {
  open: boolean;
  query: string;
  entries: readonly CapabilityEntry[];
  countsSummary: string;
  handlers: Record<string, CapabilityActionHandler>;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onAnnounce: (message: string) => void;
}

const DEFERRED_DOMAINS = new Set(["voice", "bots", "memory_graph", "kanban"]);

export function CommandPalette({
  open,
  query,
  entries,
  countsSummary,
  handlers,
  onQueryChange,
  onClose,
  onAnnounce,
}: CommandPaletteProps) {
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(0);

  // Strictly source executable options from CapabilityRegistry entries, filtering out deferred/refused/orphan actions
  const auditedEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.classification !== "deferred" &&
          !DEFERRED_DOMAINS.has(entry.domain) &&
          entry.degradation?.reason !== "refused" &&
          Boolean(entry.handlerId && handlers[entry.handlerId]) &&
          Boolean(entry.evidenceTestId),
      ),
    [entries, handlers],
  );

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return auditedEntries;
    return auditedEntries.filter((entry) => {
      const label = getCopy(entry.labelKey as CopyKey).toLowerCase();
      const hint = entry.hintKey ? getCopy(entry.hintKey as CopyKey).toLowerCase() : "";
      const domain = entry.domain.toLowerCase();
      const actionId = entry.actionId.toLowerCase();
      return (
        label.includes(q) ||
        hint.includes(q) ||
        domain.includes(q) ||
        actionId.includes(q)
      );
    });
  }, [auditedEntries, query]);

  useEffect(() => {
    if (!open) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((prev) =>
      filteredEntries.length === 0 ? 0 : Math.min(prev, filteredEntries.length - 1),
    );
  }, [filteredEntries.length, open]);

  const activeEntry = filteredEntries[activeIndex] ?? null;
  const optionDomId = (actionId: string) =>
    `${listboxId}-opt-${actionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const executeEntry = (entry: CapabilityEntry) => {
    if (entry.runtimeStatus === "unavailable") {
      onAnnounce(
        `${getCopy(entry.labelKey as CopyKey)} · ${getCopy("capabilities.status.unavailable")}`,
      );
      return;
    }
    const handler = handlers[entry.handlerId];
    if (!handler) return;
    if (entry.actionId !== "capabilities.open") {
      onClose();
    } else {
      onClose();
    }
    void handler(entry);
  };

  return (
    <FocusDialog
      open={open}
      title={getCopy("palette.title")}
      closeLabel={getCopy("shortcuts.close")}
      onClose={onClose}
    >
      <div className="palette-meta-bar">
        <span>{countsSummary}</span>
      </div>
      <label htmlFor="palette-search-input" className="sr-only">
        {getCopy("palette.placeholder")}
      </label>
      <input
        id="palette-search-input"
        data-autofocus="true"
        role="combobox"
        aria-expanded={filteredEntries.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeEntry ? optionDomId(activeEntry.actionId) : undefined}
        className="palette-search"
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || filteredEntries.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((prev) => (prev + 1) % filteredEntries.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((prev) => (prev - 1 + filteredEntries.length) % filteredEntries.length);
          } else if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(0);
          } else if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(filteredEntries.length - 1);
          } else if (event.key === "Enter" && activeEntry) {
            event.preventDefault();
            executeEntry(activeEntry);
          }
        }}
        placeholder={getCopy("palette.placeholder")}
      />
      {filteredEntries.length === 0 ? (
        <p className="palette-empty">{getCopy("palette.empty")}</p>
      ) : (
        <div
          id={listboxId}
          role="listbox"
          aria-label={getCopy("palette.title")}
          className="palette-listbox"
        >
          {filteredEntries.map((entry, index) => {
            const isActive = index === activeIndex;
            const isUnavailable = entry.runtimeStatus === "unavailable";
            const statusLabel = getCopy(getCapabilityStatusCopyKey(entry.runtimeStatus));
            const label = getCopy(entry.labelKey as CopyKey);
            const hint = entry.hintKey ? getCopy(entry.hintKey as CopyKey) : "";
            return (
              <div
                key={entry.actionId}
                id={optionDomId(entry.actionId)}
                role="option"
                aria-selected={isActive}
                aria-disabled={isUnavailable || undefined}
                data-testid={entry.evidenceTestId}
                data-action-id={entry.actionId}
                data-domain={entry.domain}
                className={[
                  "palette-item",
                  "palette-option",
                  isActive && "is-active",
                  isUnavailable && "is-unavailable",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => executeEntry(entry)}
              >
                <span className="palette-option-main">
                  <span className="palette-option-title-row">
                    <strong>{label}</strong>
                    <span className={`cap-status-badge is-${entry.runtimeStatus}`}>
                      {statusLabel}
                    </span>
                  </span>
                  {hint && <span className="palette-option-hint">{hint}</span>}
                </span>
                {entry.shortcut && <kbd className="kbd">{entry.shortcut}</kbd>}
              </div>
            );
          })}
        </div>
      )}
    </FocusDialog>
  );
}
