import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  closeLabel: string;
  onClose: () => void;
  className?: string;
  scrimClassName?: string;
  children: ReactNode;
}

export function FocusDialog({
  open,
  title,
  description,
  closeLabel,
  onClose,
  className,
  scrimClassName,
  children,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const windowClosingRef = useRef(false);

  // Capture trigger element synchronously in useLayoutEffect BEFORE parent App sets `inert` on shellRef
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active !== document.documentElement) {
      previousFocusRef.current = active;
    } else {
      previousFocusRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    const markClosing = () => {
      windowClosingRef.current = true;
    };
    window.addEventListener("beforeunload", markClosing);
    window.addEventListener("pagehide", markClosing);
    return () => {
      window.removeEventListener("beforeunload", markClosing);
      window.removeEventListener("pagehide", markClosing);
    };
  }, []);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const previous = previousFocusRef.current ?? (document.activeElement as HTMLElement | null);
    const root = dialogRef.current;

    const getFocusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getClientRects().length > 0);

    const list = getFocusables();
    const autofocusTarget = root.querySelector<HTMLElement>("[data-autofocus]");
    if (autofocusTarget && list.includes(autofocusTarget)) {
      autofocusTarget.focus();
    } else if (list.length > 0) {
      list[0].focus();
    } else {
      root.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== "Tab") return;
      const items = getFocusables();
      if (items.length === 0) return;
      const current = document.activeElement as HTMLElement;
      if (event.shiftKey && current === items[0]) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && current === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      if (windowClosingRef.current) return;
      if (
        previous &&
        document.contains(previous) &&
        !previous.hasAttribute("disabled") &&
        previous.getClientRects().length > 0
      ) {
        previous.focus();
        return;
      }
      const fallbackComposer = document.getElementById("composer-input");
      if (fallbackComposer && !fallbackComposer.hasAttribute("disabled")) {
        fallbackComposer.focus();
        return;
      }
      const fallbackNewSession = document.getElementById("rail-new-session");
      if (fallbackNewSession && !fallbackNewSession.hasAttribute("disabled")) {
        fallbackNewSession.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className={["modal-scrim", scrimClassName].filter(Boolean).join(" ")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={["dialog-panel", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && (
              <p id={descId} className="dialog-description">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
