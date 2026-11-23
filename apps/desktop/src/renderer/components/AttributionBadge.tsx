import type { ExternalAttribution } from "@hermes/contracts";
import { getCopy } from "@hermes/domain";

interface AttributionBadgeProps {
  attribution?: ExternalAttribution | null;
  testId?: string;
}

/**
 * Renders a single normalized provenance badge using positive evidence only.
 * Missing or null attribution resolves to "来源未知" and never assumes "内置".
 */
export function AttributionBadge({ attribution, testId }: AttributionBadgeProps) {
  const unknownLabel = getCopy("attribution.unknown");
  const resolved: ExternalAttribution =
    attribution && attribution.sourceLabel
      ? attribution
      : {
          origin: "unknown",
          sourceLabel: unknownLabel,
          accessibleLabel: unknownLabel,
        };

  return (
    <span
      className={`attribution-badge is-${resolved.origin}`}
      aria-label={resolved.accessibleLabel}
      data-attribution-origin={resolved.origin}
      data-testid={testId}
    >
      {resolved.sourceLabel}
    </span>
  );
}
