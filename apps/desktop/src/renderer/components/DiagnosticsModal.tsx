import { useState } from "react";
import type { SanitizedDiagnosticsPayload } from "@hermes/contracts";
import { getCopy } from "@hermes/domain";
import { FocusDialog } from "./Modal";

interface DiagnosticsModalProps {
  open: boolean;
  report: SanitizedDiagnosticsPayload | null;
  onClose: () => void;
  onCopied: () => void;
}

export function DiagnosticsModal({
  open,
  report,
  onClose,
  onCopied,
}: DiagnosticsModalProps) {
  const [copied, setCopied] = useState(false);

  const jsonText = report ? JSON.stringify(report, null, 2) : "";

  const handleCopy = async () => {
    if (!jsonText) return;
    try {
      await navigator.clipboard?.writeText(jsonText);
    } catch {
      // Ignore clipboard failures in headless/restricted contexts
    }
    setCopied(true);
    onCopied();
  };

  return (
    <FocusDialog
      open={open}
      title={getCopy("diagnostics.title")}
      description={getCopy("diagnostics.description")}
      closeLabel={getCopy("diagnostics.close")}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
    >
      {!report ? (
        <p>{getCopy("diagnostics.empty")}</p>
      ) : (
        <>
          <div className="diagnostics-grid">
            <div>
              <span>App</span>
              <strong>
                {report.appName} {report.appVersion}
              </strong>
            </div>
            <div>
              <span>Mode</span>
              <strong>
                {report.buildMode} · {report.arch}
              </strong>
            </div>
            <div>
              <span>HERMES_HOME</span>
              <strong>{report.hermesHomeKind}</strong>
            </div>
            <div>
              <span>Failure</span>
              <strong>{report.typedFailureCode ?? "none"}</strong>
            </div>
          </div>

          <pre className="diagnostics-json" tabIndex={0} aria-label={getCopy("diagnostics.title")}>
            {jsonText}
          </pre>

          <div className="empty-relay-actions">
            <button type="button" className="button button-primary" onClick={handleCopy}>
              {copied ? getCopy("diagnostics.copiedNotice") : getCopy("diagnostics.copyAction")}
            </button>
          </div>
        </>
      )}
    </FocusDialog>
  );
}
