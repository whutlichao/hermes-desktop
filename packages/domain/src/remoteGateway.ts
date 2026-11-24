import type {
  RemoteTestActionId,
  RemoteTestLegOutcome,
  RemoteTestResult,
} from "@hermes/contracts";

export type RemoteEndpointValidationResult =
  | {
      valid: true;
      normalizedUrl: string;
      originDisplay: string;
      wsUrl: string;
      isLoopback: boolean;
    }
  | {
      valid: false;
      code: "invalid_request";
      messageKey: "remote.error.invalidUrl" | "remote.error.httpsRequired" | "remote.error.credentialsInUrl";
    };

export interface FormattedRemoteTestSummary {
  ok: boolean;
  httpPassed: boolean;
  wsPassed: boolean;
  httpStatus: RemoteTestLegOutcome;
  wsStatus: RemoteTestLegOutcome;
  failedStage?: RemoteTestResult["failedStage"];
  originDisplay?: string;
  messageKey?: string;
  actions: RemoteTestActionId[];
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }
  return false;
}

export function deriveRemoteWsUrl(baseUrl: string, wsPath = "/api/ws"): string {
  const parsed = new URL(baseUrl);
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const cleanSubPath = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  return `${wsProtocol}//${parsed.host.toLowerCase()}${basePath}${cleanSubPath}`;
}

export function validateRemoteEndpointUrl(rawUrl: string): RemoteEndpointValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.invalidUrl",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.invalidUrl",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.invalidUrl",
    };
  }

  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    return {
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.credentialsInUrl",
    };
  }

  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    return {
      valid: false,
      code: "invalid_request",
      messageKey: "remote.error.httpsRequired",
    };
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const normalizedUrl = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${cleanPath}`;
  return {
    valid: true,
    normalizedUrl,
    originDisplay: normalizedUrl,
    wsUrl: deriveRemoteWsUrl(normalizedUrl),
    isLoopback: loopback,
  };
}

export function formatRemoteTestSummary(result: RemoteTestResult): FormattedRemoteTestSummary {
  return {
    ok: result.ok,
    httpPassed: result.httpLeg.ok,
    wsPassed: result.wsLeg.ok,
    httpStatus: result.httpLeg.status,
    wsStatus: result.wsLeg.status,
    failedStage: result.failedStage,
    originDisplay: result.originDisplay,
    messageKey: result.messageKey,
    actions: [...result.actions],
  };
}
