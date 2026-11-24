import { describe, expect, it } from "vitest";
import {
  HOST_COMMANDS,
  LOCAL_FAILURE_CODES,
  LOCAL_SAFE_ACTION_IDS,
  type LocalFailureCode,
} from "@hermes/contracts";
import {
  classifyCliProbeOutput,
  extractPathFromShellOutput,
  formatDisplaySafeCliSummary,
  getLocalFailureCopy,
  mapLocalFailure,
  redactSensitiveData,
  sanitizeDiagnosticsPayload,
  validateTerminology,
} from "@hermes/domain";

describe("Local backend domain rules & redaction (Ticket #25)", () => {
  it("exposes additive HostBridge local commands, failure codes, and safe action IDs", () => {
    expect(HOST_COMMANDS).toContain("local.inspect");
    expect(HOST_COMMANDS).toContain("local.selectCli");
    expect(HOST_COMMANDS).toContain("local.diagnose");
    expect(LOCAL_FAILURE_CODES).toContain("hermes_not_found");
    expect(LOCAL_FAILURE_CODES).toContain("cli_not_executable");
    expect(LOCAL_FAILURE_CODES).toContain("cli_unsupported");
    expect(LOCAL_FAILURE_CODES).toContain("protocol_unsupported");
    expect(LOCAL_SAFE_ACTION_IDS).toEqual([
      "choose_cli",
      "open_install_docs",
      "open_update_docs",
      "retry",
      "restart_gateway",
      "open_status",
      "open_diagnostics",
      "switch_profile",
    ]);
  });

  it("extracts PATH from login shell stdout using sentinels while ignoring MOTD and ANSI banners", () => {
    const noisyStdout = [
      "\u001b[32mWelcome to Oh My Zsh!\u001b[0m",
      "Last login: Mon Nov 23 10:00:00 on ttys001",
      "__HERMES_PATH_BEGIN__/opt/homebrew/bin:/Users/alice/.local/bin:/usr/bin__HERMES_PATH_END__",
      "warning: fortune banner after marker",
    ].join("\n");

    expect(extractPathFromShellOutput(noisyStdout)).toBe(
      "/opt/homebrew/bin:/Users/alice/.local/bin:/usr/bin",
    );
    expect(extractPathFromShellOutput("just a motd banner without markers")).toBeNull();
    expect(extractPathFromShellOutput("__HERMES_PATH_BEGIN__   __HERMES_PATH_END__")).toBeNull();
  });

  it("classifies CLI support by verb/capability rather than semver", () => {
    const modern = classifyCliProbeOutput({
      versionOutput: "Hermes Agent v0.0.1-custom\nInstall directory: /Users/alice/.hermes/hermes-agent",
      gatewayHelpOutput: "positional arguments:\n  {run,ensure,attach,tickets,status}",
      ensureHelpOutput: "options:\n  --json  Emit one credential-free JSON result",
      attachHelpOutput: "options:\n  --json  Emit one JSON result",
      ticketsProbeJson: JSON.stringify({
        protocol: 1,
        purposes: ["native-http", "interactive"],
        windows_service_session: false,
      }),
    });
    expect(modern.kind).toBe("ready");
    if (modern.kind === "ready") {
      expect(modern.version).toBe("v0.0.1-custom");
      expect(modern.supportsEnsureJson).toBe(true);
      expect(modern.supportsAttachJson).toBe(true);
      expect(modern.supportsTicketsProbe).toBe(true);
    }

    const unsupportedCli = classifyCliProbeOutput({
      versionOutput: "Hermes Agent v9.9.9",
      gatewayHelpOutput: "positional arguments:\n  {run,status}",
      ensureHelpOutput: "",
      attachHelpOutput: "",
    });
    expect(unsupportedCli).toEqual({
      kind: "failure",
      code: "cli_unsupported",
      phase: "probe_capabilities",
      version: "v9.9.9",
    });

    const unsupportedProtocol = classifyCliProbeOutput({
      versionOutput: "Hermes Agent v0.23.3",
      gatewayHelpOutput: "positional arguments:\n  {ensure,attach,tickets}",
      ensureHelpOutput: "--json",
      attachHelpOutput: "--json",
      ticketsProbeJson: JSON.stringify({ protocol: 2, purposes: ["interactive"] }),
    });
    expect(unsupportedProtocol).toEqual({
      kind: "failure",
      code: "protocol_unsupported",
      phase: "probe_capabilities",
      version: "v0.23.3",
    });
  });

  it("maps every LocalFailureCode to safe actual/retryable/autoRetry/actions and compliant zh-CN copy", () => {
    const cases: Array<{
      code: LocalFailureCode;
      expectedActual: "blocked" | "reconnecting";
      expectedRetryable: boolean;
      requiredActions: string[];
    }> = [
      {
        code: "hermes_not_found",
        expectedActual: "blocked",
        expectedRetryable: true,
        requiredActions: ["choose_cli", "open_install_docs", "retry"],
      },
      {
        code: "cli_not_executable",
        expectedActual: "blocked",
        expectedRetryable: true,
        requiredActions: ["choose_cli", "open_diagnostics"],
      },
      {
        code: "cli_unsupported",
        expectedActual: "blocked",
        expectedRetryable: true,
        requiredActions: ["choose_cli", "open_update_docs", "retry"],
      },
      {
        code: "protocol_unsupported",
        expectedActual: "blocked",
        expectedRetryable: false,
        requiredActions: ["choose_cli", "open_update_docs", "open_diagnostics"],
      },
      {
        code: "code_sha_mismatch",
        expectedActual: "blocked",
        expectedRetryable: true,
        requiredActions: ["restart_gateway", "open_diagnostics"],
      },
      {
        code: "socket_permission_denied",
        expectedActual: "blocked",
        expectedRetryable: true,
        requiredActions: ["open_diagnostics", "retry"],
      },
      {
        code: "service_unhealthy",
        expectedActual: "blocked",
        expectedRetryable: false,
        requiredActions: ["open_status", "open_diagnostics"],
      },
      {
        code: "gateway_starting_timeout",
        expectedActual: "reconnecting",
        expectedRetryable: true,
        requiredActions: ["retry", "open_diagnostics"],
      },
    ];

    for (const entry of cases) {
      const mapped = mapLocalFailure(entry.code, "probe_cli");
      expect(mapped.actual).toBe(entry.expectedActual);
      expect(mapped.retryable).toBe(entry.expectedRetryable);
      if (mapped.actual === "blocked") {
        expect(mapped.autoRetry).toBe(false);
      }
      for (const action of entry.requiredActions) {
        expect(mapped.actions).toContain(action);
      }
    }

    for (const code of LOCAL_FAILURE_CODES) {
      const mapped = mapLocalFailure(code, "locate_cli");
      if (mapped.actual === "blocked") {
        expect(mapped.autoRetry).toBe(false);
      }
      const copy = getLocalFailureCopy(code);
      expect(copy.whatHappened.length).toBeGreaterThan(0);
      expect(copy.possibleCauses.length).toBeGreaterThan(0);
      expect(copy.nextStep.length).toBeGreaterThan(0);
      expect(validateTerminology(copy.whatHappened)).toEqual([]);
      expect(validateTerminology(copy.possibleCauses)).toEqual([]);
      expect(validateTerminology(copy.nextStep)).toEqual([]);
    }
  });

  it("never exposes raw paths in display-safe CLI summary", () => {
    const summary = formatDisplaySafeCliSummary({
      status: "ready",
      sourceKind: "override",
      binaryName: "/Users/alice/.local/bin/hermes",
      version: "v0.23.3",
      hasOverride: true,
      supportsEnsureJson: true,
      supportsAttachJson: true,
      supportsTicketsProbe: true,
    });

    expect(summary.displayName).not.toContain("/Users/alice");
    expect(summary.displayName).not.toContain("/");
    expect(summary.displayName).toContain("hermes");
  });

  it("sanitizes diagnostics payload by removing paths, home/username, URL credentials/queries, secrets, and raw stderr", () => {
    const rawReport = sanitizeDiagnosticsPayload(
      {
        generatedAt: "2026-11-23T06:00:00.000Z",
        appName: "Hermes Desktop",
        appVersion: "0.1.0",
        bridgeVersion: 1,
        buildMode: "dev",
        mode: "electron",
        platform: "darwin",
        arch: "arm64",
        hermesHomeKind: "sandbox",
        connectionsCount: 0,
        cliSummary: formatDisplaySafeCliSummary({
          status: "missing",
          sourceKind: "none",
          hasOverride: false,
          supportsEnsureJson: false,
          supportsAttachJson: false,
          supportsTicketsProbe: false,
        }),
        typedFailureCode: "hermes_not_found",
        failurePhase: "locate_cli",
        stages: [
          { phase: "override", outcome: "skipped" },
          { phase: "login_shell_ilc", outcome: "timeout", durationMs: 5000 },
        ],
        notes: [
          "stderr: /Users/alice/.local/bin/hermes failed at https://alice:secret@relay.example.com/ws?token=tok_123#frag",
          "ticket=tkt_999 cookie=sid=xyz passphrase=my-pass key=ssh-ed25519-AAA",
          "home is /Users/alice and user alice",
        ],
      },
      { homeDir: "/Users/alice", username: "alice" },
    );

    const serialized = JSON.stringify(rawReport);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("tok_123");
    expect(serialized).not.toContain("tkt_999");
    expect(serialized).not.toContain("sid=xyz");
    expect(serialized).not.toContain("my-pass");
    expect(serialized).not.toContain("ssh-ed25519-AAA");
    expect(serialized).not.toContain("#frag");
    expect(serialized).not.toContain("stderr:");
    expect(rawReport.typedFailureCode).toBe("hermes_not_found");
    expect(rawReport.hermesHomeKind).toBe("sandbox");

    const obj = redactSensitiveData({
      stderr: "fatal: permission denied /opt/homebrew/bin/hermes",
      cliPath: "/Users/alice/bin/hermes",
      safeText: "CLI 检查完成",
    });
    expect(obj.stderr).toBe("[REDACTED]");
    expect(obj.cliPath).toBe("[REDACTED]");
    expect(obj.safeText).toBe("CLI 检查完成");
  });
});
