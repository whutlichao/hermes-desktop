import { describe, expect, it } from "vitest";
import {
  buildSshCommandArgs,
  classifySshStderr,
  extractRemotePortFromWsUrl,
  formatSshDestination,
  formatSshHostDisplay,
  getSshFailureCopy,
  parseKeygenFingerprintOutput,
  parseSshProbeOutput,
  parseSshServeLine,
  rewriteForwardedWsUrl,
  shellQuotePosix,
  validateSshTargetInput,
  buildRemoteHermesShellCommand,
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
    expect(validateSshTargetInput({})).toMatchObject({ valid: false });
    expect(validateSshTargetInput({ host: "lab example.com" })).toMatchObject({ valid: false });
    expect(validateSshTargetInput({ host: "lab.example.com", user: "-evil" })).toMatchObject({
      valid: false,
    });
    expect(validateSshTargetInput({ host: "lab.example.com", user: "bad user" })).toMatchObject({
      valid: false,
    });
    expect(validateSshTargetInput({ host: "lab.example.com", port: 0 })).toMatchObject({
      valid: false,
    });
    expect(validateSshTargetInput({ host: "lab.example.com", port: 1.5 })).toMatchObject({
      valid: false,
    });
    expect(validateSshTargetInput({ host: " lab.example.com ", user: " ubuntu ", port: 22 })).toEqual({
      valid: true,
    });
    expect(formatSshDestination({ host: "lab.example.com" })).toBe("lab.example.com");
    expect(formatSshDestination({ host: " lab.example.com ", user: " ubuntu " })).toBe(
      "ubuntu@lab.example.com",
    );
    expect(formatSshHostDisplay(" lab.example.com ")).toBe("lab.example.com");
    expect(formatSshHostDisplay("lab.example.com", 22)).toBe("lab.example.com");
    expect(formatSshHostDisplay("lab.example.com", 2222)).toBe("[lab.example.com]:2222");
    expect(shellQuotePosix("safe/arg:1")).toBe("safe/arg:1");
    expect(shellQuotePosix("a b'c")).toBe("'a b'\\''c'");
    expect(
      buildRemoteHermesShellCommand({
        remoteHermesPath: "",
        remoteProfile: "default",
        args: ["gateway", "tickets --serve"],
      }),
    ).toBe("hermes gateway 'tickets --serve'");
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
    const askpassArgs = buildSshCommandArgs({
      host: "lab.example.com",
      port: 22,
      useAskpass: true,
      knownHostsPath: "/tmp/known_hosts",
      remoteCommand: "hermes gateway tickets --serve",
    });
    expect(askpassArgs).not.toContain("BatchMode=yes");
    expect(askpassArgs).not.toContain("-p");
    expect(askpassArgs.at(-1)).toBe("hermes gateway tickets --serve");
    expect(
      buildRemoteHermesShellCommand({ remoteProfile: "ops", args: ["gateway", "tickets"] }),
    ).toBe("hermes --profile ops gateway tickets");
    expect(
      buildRemoteHermesShellCommand({
        remoteHermesPath: "/opt/hermes cli",
        args: ["gateway", "tickets"],
      }),
    ).toBe("'/opt/hermes cli' gateway tickets");
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
    expect(classifySshStderr("host key for host has changed")).toBe("host_key_changed");
    expect(classifySshStderr("offending key in known_hosts")).toBe("host_key_changed");
    expect(classifySshStderr("Are you sure you want to continue connecting?")).toBe(
      "host_key_unknown",
    );
    expect(classifySshStderr("Authentication failed")).toBe("ssh_auth_failed");
    expect(classifySshStderr("Too many authentication failures")).toBe("ssh_auth_failed");
    expect(classifySshStderr("Enter passphrase for key")).toBe("ssh_auth_failed");
    expect(classifySshStderr("zsh: hermes: No such file or directory")).toBe(
      "remote_hermes_not_found",
    );
    expect(classifySshStderr("something else")).toBe("ssh_unreachable");
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
    expect(parseSshProbeOutput("", 0, "hermes not found")).toEqual({
      kind: "remote_hermes_not_found",
    });
    expect(
      parseSshProbeOutput(JSON.stringify({ runtime_protocol: 2 }), 0),
    ).toEqual({ kind: "failure", code: "protocol_unsupported" });
    expect(
      parseSshProbeOutput(
        JSON.stringify({
          purposes: ["interactive", 42],
          windowsServiceSession: true,
          remote_port: 8787,
        }),
        0,
      ),
    ).toEqual({
      kind: "modern",
      supportsInteractive: true,
      windowsServiceSession: true,
      purposes: ["interactive"],
      remotePort: 8787,
    });
    expect(parseSshProbeOutput(JSON.stringify({ port: 9999 }), 0)).toMatchObject({
      kind: "modern",
      remotePort: 9999,
    });
    expect(parseSshProbeOutput("not json", 0, "unknown option: --json")).toEqual({
      kind: "legacy_attach_only",
      reason: "tickets_subcommand_missing",
    });
    expect(parseSshProbeOutput("", 0, "unrecognized arguments: x")).toEqual({
      kind: "legacy_attach_only",
      reason: "tickets_subcommand_missing",
    });
    expect(parseSshProbeOutput("", 0, "invalid choice: tickets")).toEqual({
      kind: "legacy_attach_only",
      reason: "tickets_subcommand_missing",
    });
    expect(parseSshProbeOutput("", 0, "unknown command")).toEqual({
      kind: "legacy_attach_only",
      reason: "tickets_subcommand_missing",
    });
    expect(parseSshProbeOutput("", 0, "ssh: connect to host x port 22: timed out")).toEqual({
      kind: "failure",
      code: "ssh_timeout",
    });
    expect(parseSshProbeOutput("", 0, "")).toEqual({
      kind: "failure",
      code: "protocol_unsupported",
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
    expect(parseSshServeLine("")).toEqual({ kind: "ignored" });
    expect(parseSshServeLine("not json")).toEqual({ kind: "ignored" });
    expect(parseSshServeLine(JSON.stringify({ ok: false, error: "profile_not_served" }))).toEqual({
      kind: "error",
      code: "profile_unavailable",
    });
    expect(parseSshServeLine(JSON.stringify({ code: "profile_mismatch" }))).toEqual({
      kind: "error",
      code: "profile_unavailable",
    });
    expect(parseSshServeLine(JSON.stringify({ code: "protocol_unsupported" }))).toEqual({
      kind: "error",
      code: "protocol_unsupported",
    });
    expect(parseSshServeLine(JSON.stringify({ code: "other" }))).toEqual({
      kind: "error",
      code: "ticket_unavailable",
    });
    expect(parseSshServeLine(JSON.stringify({ ticket: "tkt_bad" }))).toEqual({
      kind: "error",
      code: "protocol_unsupported",
    });
    expect(
      parseSshServeLine(
        JSON.stringify({
          event: "ready",
          remote_port: 7777,
          endpoint: {
            ws_url: "ws://127.0.0.1:7777/api/ws",
            runtime_protocol: 1,
            capabilities: ["session-authority-v1"],
          },
        }),
      ),
    ).toMatchObject({ kind: "ready", remotePort: 7777 });
    expect(parseSshServeLine(JSON.stringify({ event: "ready" }))).toEqual({ kind: "ready" });
    expect(parseSshServeLine(JSON.stringify({ event: "other" }))).toEqual({ kind: "ignored" });
  });

  it("extracts/rewrites loopback ports and parses keygen fingerprints and failure copy", () => {
    expect(extractRemotePortFromWsUrl("ws://127.0.0.1:8787/api/ws")).toBe(8787);
    expect(extractRemotePortFromWsUrl("wss://example.com/api/ws")).toBe(443);
    expect(extractRemotePortFromWsUrl("ws://example.com/api/ws")).toBe(80);
    expect(extractRemotePortFromWsUrl("ws://example.com:0/api/ws")).toBeNull();
    expect(extractRemotePortFromWsUrl("ws://example.com:70000/api/ws")).toBeNull();
    expect(extractRemotePortFromWsUrl("not a url")).toBeNull();
    expect(rewriteForwardedWsUrl("wss://example.com:8443/api/ws?x=1", 54321)).toBe(
      "wss://127.0.0.1:54321/api/ws?x=1",
    );
    expect(rewriteForwardedWsUrl("ws://example.com", 54321)).toBe("ws://127.0.0.1:54321/");
    const challenge = parseKeygenFingerprintOutput(
      "# comment\n256 SHA256:abc123 lab.example.com (ED25519)\n",
      "lab.example.com",
    );
    expect(challenge).toEqual({
      hostDisplay: "lab.example.com",
      keyType: "ED25519",
      fingerprint: "SHA256:abc123",
    });
    expect(parseKeygenFingerprintOutput("no fingerprint", "host")).toBeNull();
    expect(parseKeygenFingerprintOutput("2048 MD5:aa:bb host", "host")).toEqual({
      hostDisplay: "host",
      keyType: "SSH",
      fingerprint: "MD5:aa:bb",
    });
    for (const code of [
      "host_key_unknown",
      "host_key_changed",
      "ssh_auth_failed",
      "ssh_timeout",
      "remote_hermes_not_found",
      "protocol_unsupported",
      "ticket_unavailable",
      "windows_session0_attach_only",
      "tunnel_failed",
      "ssh_unreachable",
    ] as const) {
      expect(getSshFailureCopy(code).length).toBeGreaterThan(0);
    }
  });
});
