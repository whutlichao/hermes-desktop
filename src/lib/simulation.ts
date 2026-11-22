import type { Dispatch } from "react";
import type { Gateway } from "../types";
import type { AppAction } from "../state/store";

export function simulateGatewayTest(
  dispatch: Dispatch<AppAction>,
  gateway: Gateway,
  onResult?: () => void,
) {
  dispatch({ type: "TEST_GATEWAY", gatewayId: gateway.id });
  window.setTimeout(() => {
    const failed = gateway.health === "error" || gateway.id === "studio";
    const latencyMs = failed
      ? null
      : gateway.latencyMs ?? (gateway.kind === "local" ? 3 : gateway.kind === "ssh" ? 24 : 84);
    dispatch({
      type: "TEST_GATEWAY_RESULT",
      gatewayId: gateway.id,
      ok: !failed,
      detail: failed
        ? "Error · HTTP 200 · WS handshake timed out"
        : `Reachable · HTTP 200 · WS open · ${latencyMs} ms`,
      latencyMs,
    });
    onResult?.();
  }, 950);
}

export function simulateUpdateAll(dispatch: Dispatch<AppAction>, gateways: Gateway[]) {
  dispatch({ type: "UPDATE_ALL" });
  gateways.forEach((gateway, index) => {
    if (gateway.kind === "cloud") return;
    window.setTimeout(() => {
      dispatch({
        type: "UPDATE_ONE_RESULT",
        gatewayId: gateway.id,
        state: gateway.health === "error" ? "error" : "done",
      });
    }, 1100 + index * 420);
  });
}
