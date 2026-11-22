import type { Gateway, GatewayKind, Profile } from "../types";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function gatewayKind(gateway: Gateway): string {
  const labels: Record<GatewayKind, string> = {
    local: "LOCAL",
    remote: "REMOTE",
    ssh: "SSH",
    cloud: "CLOUD",
  };
  return labels[gateway.kind];
}

export function gatewayTransport(gateway: Gateway): string {
  const labels: Record<GatewayKind, string> = {
    local: "App-managed",
    remote: "HTTP(S) + WS",
    ssh: "Attached tunnel",
    cloud: "Portal-managed",
  };
  return labels[gateway.kind];
}

export function isRemote(gateway: Gateway): boolean {
  return gateway.kind !== "local";
}

export function profileLabel(profile?: Profile): string {
  return profile ? profile.handle : "@—";
}

export function latency(gateway: Gateway): string {
  return gateway.latencyMs === null ? "—" : `${gateway.latencyMs} ms`;
}

export function healthLabel(gateway: Gateway): string {
  if (gateway.health === "testing") return "测试中";
  if (gateway.health === "reachable") return "在线";
  if (gateway.health === "degraded") return "延迟";
  return "不可达";
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "gateway";
}

export function pathParts(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function compactPath(path: string): string {
  const parts = pathParts(path);
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}
