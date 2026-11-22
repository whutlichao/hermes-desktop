import { useEffect, useRef } from "react";
import {
  ArrowLeftRight,
  Check,
  CloudCog,
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { useApp } from "../state/AppContext";
import {
  getActiveGateway,
  getActiveProfile,
  getProfilesForGateway,
} from "../state/store";
import { cn, gatewayKind, gatewayTransport, healthLabel, latency } from "../lib/ui";
import { simulateGatewayTest, simulateUpdateAll } from "../lib/simulation";
import { Button, IconButton, StatusDot, Toggle, useFocusTrap } from "./ui";

function GatewayIcon({ kind }: { kind: "local" | "remote" | "ssh" | "cloud" }) {
  if (kind === "local") return <Server size={14} />;
  if (kind === "ssh") return <Terminal size={14} />;
  if (kind === "cloud") return <CloudCog size={14} />;
  return <ExternalLink size={14} />;
}

export function GatewaySwitcher() {
  const { state, dispatch } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const activeGateway = getActiveGateway(state);
  const activeProfile = getActiveProfile(state);
  const profiles = getProfilesForGateway(state, activeGateway.id);
  useFocusTrap(
    state.gatewaySwitcherOpen,
    ref,
    () => dispatch({ type: "TOGGLE_GATEWAY_SWITCHER", open: false }),
  );

  useEffect(() => {
    if (!state.gatewaySwitcherOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        dispatch({ type: "TOGGLE_GATEWAY_SWITCHER", open: false });
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [state.gatewaySwitcherOpen, dispatch]);

  if (!state.gatewaySwitcherOpen) return null;

  return (
    <div className="gateway-switcher" ref={ref} role="dialog" aria-label="切换 Gateway 与 Profile">
      <header className="switcher-head">
        <div>
          <h2>Gateway & Profile</h2>
        </div>
        <IconButton label="关闭切换器" onClick={() => dispatch({ type: "TOGGLE_GATEWAY_SWITCHER", open: false })}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="switcher-union">
        <div>
          <b>All Profiles</b>
          <span>按 Gateway & Profile 合并 Session</span>
        </div>
        <Toggle
          checked={state.allProfiles}
          onChange={() => dispatch({ type: "TOGGLE_ALL_PROFILES" })}
          label="All Profiles 联合视图"
        />
      </div>

      <div className="switcher-section-label">
        <span>Gateways</span>
        <button type="button" onClick={() => dispatch({ type: "OPEN_SETTINGS", section: "gateways" })}>
          <Settings2 size={11} /> 管理
        </button>
      </div>
      <div className="gateway-list">
        {state.gateways.map((gateway) => {
          const selected = gateway.id === state.activeGatewayId && !state.allProfiles;
          return (
            <div className={cn("gateway-choice", selected && "is-active", gateway.health === "error" && "has-error")} key={gateway.id}>
              <button
                type="button"
                className="gateway-choice-main"
                onClick={() => dispatch({ type: "SWITCH_GATEWAY", gatewayId: gateway.id })}
              >
                <span className="gateway-icon"><GatewayIcon kind={gateway.kind} /></span>
                <span className="gateway-choice-copy">
                  <span className="gateway-name-line">
                    <b>{gateway.name}</b>
                    {gateway.primary && <em>PRIMARY</em>}
                    {gateway.kind === "local" && <em>APP-MANAGED</em>}
                  </span>
                  <span>{gatewayKind(gateway)} · {gateway.host}</span>
                </span>
                <span className="gateway-health">
                  <StatusDot
                    tone={gateway.health === "error" ? "error" : gateway.health === "testing" ? "warn" : "ok"}
                    ring={selected}
                  />
                  <span>{healthLabel(gateway)}</span>
                  <em>{latency(gateway)}</em>
                </span>
                {selected ? <Check size={13} /> : <ArrowLeftRight size={12} className="gateway-select-hint" />}
              </button>
              <IconButton
                className="gateway-test-button"
                label={`测试 ${gateway.name}`}
                disabled={gateway.health === "testing"}
                onClick={() => simulateGatewayTest(dispatch, gateway)}
              >
                <RefreshCw size={11} className={cn(gateway.health === "testing" && "spin")} />
              </IconButton>
            </div>
          );
        })}
      </div>

      <div className="switcher-section-label profiles-label">
        <span>Profiles on {activeGateway.name}</span>
        <span>{gatewayTransport(activeGateway)}</span>
      </div>
      <div className="profile-list">
        {profiles.map((profile) => (
          <button
            type="button"
            key={profile.id}
            className={cn("profile-choice", profile.id === activeProfile.id && !state.allProfiles && "is-active")}
            onClick={() => dispatch({ type: "SWITCH_PROFILE", profileId: profile.id })}
          >
            <span className="profile-initial" style={{ color: profile.color, borderColor: `${profile.color}55` }}>{profile.initials}</span>
            <span><b>{profile.handle}</b><em>{profile.model} / {profile.effort}</em></span>
            {profile.id === activeProfile.id && !state.allProfiles && <Check size={13} />}
          </button>
        ))}
      </div>

      <footer className="switcher-foot">
        <div className="switcher-toggle">
          <span>启动时回到上次使用的 Gateway</span>
          <Toggle
            checked={state.returnToLastGateway}
            onChange={(value) => dispatch({ type: "SET_RETURN_TO_LAST", value })}
            label="启动时回到上次使用的 Gateway"
          />
        </div>
        <div className="switcher-actions">
          <Button
            variant="quiet"
            onClick={() => simulateGatewayTest(dispatch, activeGateway)}
            disabled={activeGateway.health === "testing"}
          >
            <RefreshCw size={12} className={cn(activeGateway.health === "testing" && "spin")} /> Test
          </Button>
          <Button variant="quiet" onClick={() => simulateUpdateAll(dispatch, state.gateways)}>
            <Download size={12} /> Update all
          </Button>
          <Button variant="secondary" onClick={() => dispatch({ type: "OPEN_SETTINGS", section: "gateways" })}>
            <Plus size={12} /> 连接 Gateway
          </Button>
        </div>
      </footer>
    </div>
  );
}
