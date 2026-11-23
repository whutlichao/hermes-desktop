import { describe, expect, it } from "vitest";
import {
  buildSshCommandArgs,
  classifySshStderr,
  extractRemotePortFromWsUrl,
  parseSshProbeOutput,
  parseSshServeLine,
  rewriteForwardedWsUrl,
  validateSshTargetInput,
} from "./ssh";

describe("SSH domain protocol, host key classification, and arg safety", () => {
  it("validates SSH target inputs and rejects option-injection leading dashes", () => {
    expect(
      validateSshTargetInput({ host: "lab.example.com", user: "ubuntu", port: 2222 }),
    ).toEqual({ valid: true });

    expect(
      validateSshTargetInput({ host: "-oProxyCommand=evil", user: "ubuntu", port: 22 }),
    ).toMatchObject({ valid: false });

    expect(
      validateSshTargetInput({ host: "lab.example.com", user: "-evil", port: 22 }),
    ).toMatchObject({ valid: false });

    expect(
      validateSshTargetInput({ host: "lab.example.com", port: 70000 }),
    ).toMatchObject({ valid: false });
  });

  it("never emits StrictHostKeyChecking=no and always enforces BatchMode=yes and StrictHostKeyChecking=yes", () => {
    const cmdArgs = buildSshCommandArgs({
      host: "lab.example.com",
      user: "ubuntu",
      port: 2222,
      keyPath: "/tmp/id_ed25519",
      knownHostsPath: "/tmp/known_hosts",
      remoteCommand: "hermes gateway tickets --probe --json",
    });

    expect(cmdArgs).toContain("BatchMode=yes");
    expect(cmdArgs).toContain("StrictHostKeyChecking=yes");
    expect(cmdArgs).not.toContain("StrictHostKeyChecking=no");
    expect(cmdArgs.join(" ")).not.toContain("StrictHostKeyChecking=no");
    expect(cmdArgs).toContain("-p");
    expect(cmdArgs).toContain("2222");
    expect(cmdArgs).toContain("-i");
    expect(cmdArgs).toContain("/tmp/id_ed25519");
    expect(cmdArgs).toContain("UserKnownHostsFile=/tmp/known_hosts");

    const tunnelArgs = buildSshCommandArgs({
      host: "lab.example.com",
      port: 22,
      forward: { localPort: 41234, remotePort: 8787 },
    });
    expect(tunnelArgs).toContain("-N");
    expect(tunnelArgs).toContain("ExitOnForwardFailure=yes");
    expect(tunnelArgs).toContain("127.0.0.1:41234:127.0.0.1:8787");
    expect(tunnelArgs).not.toContain("StrictHostKeyChecking=no");
  });

  it("classifies unknown host key vs changed host key vs auth failure vs unreachable", () => {
    expect(
      classifySshStderr("No ED25519 host key is known for lab.example.com and you have requested strict checking.\nHost key verification failed."),
    ).toBe("host_key_unknown");

    expect(
      classifySshStderr("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed."),
    ).toBe("host_key_changed");

    expect(
      classifySshStderr("Permission denied (publickey,keyboard-interactive)."),
    ).toBe("ssh_auth_failed");

    expect(
      classifySshStderr("ssh: Could not resolve hostname bad.invalid: nodename nor servname provided"),
    ).toBe("ssh_unreachable");

    expect(
      classifySshStderr("ssh: connect to host lab.example.com port 22: Operation timed out"),
    ).toBe("ssh_timeout");
  });

  it("parses tickets --probe --json for modern interactive, Windows Session 0, and legacy CLI", () => {
    const modern = parseSshProbeOutput(
      JSON.stringify({
        protocol: 1,
        purposes: ["interactive", "native-http"],
        windows_service_session: false,
      }),
      0,
    );
    expect(modern).toEqual({
      kind: "modern",
      supportsInteractive: true,
      windowsServiceSession: false,
      purposes: ["interactive", "native-http"],
    });

    const winSession0 = parseSshProbeOutput(
      JSON.stringify({
        protocol: 1,
        purposes: ["interactive"],
        windows_service_session: true,
      }),
      0,
    );
    expect(winSession0).toEqual({
      kind: "modern",
      supportsInteractive: true,
      windowsServiceSession: true,
      purposes: ["interactive"],
    });

    const legacy = parseSshProbeOutput("", 2, "Error: No such command 'tickets'.");
    expect(legacy).toEqual({
      kind: "legacy_attach_only",
      reason: "tickets_subcommand_missing",
    });

    const missingHermes = parseSshProbeOutput("", 127, "zsh: command not found: hermes");
    expect(missingHermes).toEqual({
      kind: "remote_hermes_not_found",
    });
  });

  it("parses tickets --serve lines and rewrites remote loopback wsUrl to local tunnel port", () => {
    const ticketLine = parseSshServeLine(
      JSON.stringify({
        ticket: "tkt_ssh_1",
        expires_in_seconds: 30,
        endpoint: {
          profile_id: "default",
          instance_id: "inst-ssh-1",
          authority_epoch: 2,
          runtime_protocol: 1,
          capabilities: ["session-authority-v1", "host-scope-interactive"],
          ws_url: "ws://127.0.0.1:8787/api/ws",
        },
      }),
    );

    expect(ticketLine.kind).toBe("ticket");
    if (ticketLine.kind === "ticket") {
      expect(ticketLine.ticket).toBe("tkt_ssh_1");
      expect(ticketLine.expiresInSeconds).toBe(30);
      expect(extractRemotePortFromWsUrl(ticketLine.endpoint.wsUrl)).toBe(8787);
      expect(rewriteForwardedWsUrl(ticketLine.endpoint.wsUrl, 54321)).toBe(
        "ws://127.0.0.1:54321/api/ws",
      );
    }

    const unavailable = parseSshServeLine(JSON.stringify({ ok: false, error: "ticket_unavailable" }));
    expect(unavailable).toEqual({ kind: "error", code: "ticket_unavailable" });
  });
});
