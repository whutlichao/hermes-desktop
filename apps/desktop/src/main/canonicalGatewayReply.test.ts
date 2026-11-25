import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeEvent, SessionTranscriptSnapshot } from "@hermes/contracts";
import { createTranscriptSyncController } from "@hermes/domain";
import { createTestSandbox } from "../../../../tests/helpers/sandbox";
import { startFakeGatewayServer } from "../../../../tests/helpers/fakeGatewayServer";
import { LocalBackendManager, createNodeLocalBackendPorts } from "./localBackendManager";
import { ConnectionSupervisor, LocalConnectionSupervisor } from "./connectionSupervisor";

const ENDPOINT_CAPABILITIES = ["session-authority-v1", "host-scope-interactive"];

const CANONICAL_CAPABILITIES = [
  "durable-admission-v1",
  "event-replay-v1",
  "local-cli-create-v1",
  "acp-editor-policy-v1",
  "acp-session-mcp-v1",
  "clarify-batch-v1",
  "plugin-rpc-v1",
  "session-client-v1",
  "session-transcript-v1",
  "session-list-picker-v1",
  "session-list-cursor-v1",
  "client-identity-v1",
  "client-activity-v1",
];

async function writeCanonicalFakeHermesCli(options: {
  cliPath: string;
  wsUrl: string;
  profileIdentity: string;
}) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profileId = profileIdx >= 0 && args[profileIdx + 1] ? args[profileIdx + 1] : "default";
const rest = profileIdx >= 0 ? args.slice(profileIdx + 2) : args;

if (rest[0] === "--version") {
  console.log("Hermes Agent v0.23.4");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "--help") {
  console.log("{run,ensure,attach,tickets,restart}");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "ensure" && rest[2] === "--help") {
  console.log("--json --timeout");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "attach" && rest[2] === "--help") {
  console.log("--json --recover");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "tickets") {
  console.log(JSON.stringify({ protocol: 1, purposes: ["interactive", "native-http"] }));
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "ensure") {
  console.log(JSON.stringify({
    state: "ready",
    attachable: true,
    install_code_sha: "sha_canonical",
    client_code_sha: "sha_canonical",
    endpoint: {
      profile_id: ${JSON.stringify(options.profileIdentity)},
      instance_id: "inst-canonical-1",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ${JSON.stringify(ENDPOINT_CAPABILITIES)},
      code_sha: "sha_canonical",
      ws_url: ${JSON.stringify(options.wsUrl)},
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  }));
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "attach") {
  const ticket = "tkt_canonical_" + profileId + "_" + Date.now();
  console.log(JSON.stringify({
    state: "ready",
    ticket,
    expires_in_seconds: 30,
    endpoint: {
      profile_id: ${JSON.stringify(options.profileIdentity)},
      instance_id: "inst-canonical-1",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ${JSON.stringify(ENDPOINT_CAPABILITIES)},
      code_sha: "sha_canonical",
      ws_url: ${JSON.stringify(options.wsUrl)},
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(options.cliPath, script, { encoding: "utf8", mode: 0o755 });
}

async function bootCanonicalSupervisor(input: {
  sandbox: ReturnType<typeof createTestSandbox>;
  wsUrl: string;
  validTickets: Set<string>;
  profileIdentity: string;
}): Promise<ConnectionSupervisor> {
  const cliPath = path.join(input.sandbox.rootDir, "hermes");
  await writeCanonicalFakeHermesCli({
    cliPath,
    wsUrl: input.wsUrl,
    profileIdentity: input.profileIdentity,
  });
  const ports = createNodeLocalBackendPorts({
    userDataDir: input.sandbox.userDataDir,
    hermesHomeDir: input.sandbox.hermesHomeDir,
    hermesHomeKind: "temp",
    appVersion: "0.1.0",
    buildMode: "dev",
    pickCliFile: async () => ({ cancelled: true }),
  });
  await ports.writeOverridePath(cliPath);
  const origRun = ports.runProcess;
  ports.runProcess = async (req) => {
    const res = await origRun(req);
    if (req.args.includes("attach") && req.args.includes("--json") && res.exitCode === 0) {
      const parsed = JSON.parse(res.stdout) as { ticket?: string };
      if (parsed.ticket) input.validTickets.add(parsed.ticket);
    }
    return res;
  };
  const backend = new LocalBackendManager(ports);
  const supervisor = new LocalConnectionSupervisor(backend);
  const connected = await supervisor.connectLocal("default");
  expect(connected.ok).toBe(true);
  return supervisor;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Canonical Hermes 0.23.4 gateway reply delivery (R11 repro)", () => {
  it("delivers streamed assistant reply and clears activeTurnId from canonical method=event notifications", async () => {
    const sandbox = createTestSandbox("hermes-r11-live-event-");
    let passed = false;
    const profileIdentity = sandbox.hermesHomeDir;
    const validTickets = new Set<string>();
    const sessionId = "local-canonical-sess-1";
    let admissionSeq = 0;

    const gw = await startFakeGatewayServer({
      validTickets,
      runtimeDescribe: {
        instance_id: "inst-canonical-1",
        profile_id: profileIdentity,
        authority_epoch: 1,
        capabilities: CANONICAL_CAPABILITIES,
        session_create: { sources: ["cli", "gui"], parameters: ["title"] },
      },
      profiles: [{ name: "default", path: profileIdentity, is_default: true }],
      initialSessions: [],
      onRpc: (method, params, ctx) => {
        if (method === "subscribe") {
          ctx.replyError(-32601, "unknown method: subscribe — not available on this Hermes backend", {
            reason: "unknown_method",
          });
          return true;
        }
        if (method === "profiles.list") {
          ctx.replyResult({
            profiles: [
              { name: "default", path: profileIdentity, is_default: true, model: "gpt-4o-mini" },
            ],
          });
          return true;
        }
        if (method === "session.list") {
          ctx.replyResult({ sessions: [], scope: params.scope ?? "live", next_cursor: null });
          return true;
        }
        if (method === "session.create") {
          ctx.replyResult({
            session_id: sessionId,
            stored_session_id: sessionId,
            messages: [],
            message_count: 0,
            running: false,
            authority_epoch: 1,
            replay_epoch: "epoch-canonical-1",
            last_sequence: 0,
            subscription_id: "sub-canonical-1",
            revision: 0,
            execution_generation: 0,
            pending: [],
            prompts: [],
          });
          return true;
        }
        if (method === "prompt.submit") {
          admissionSeq += 1;
          const admissionId = `adm-${admissionSeq}`;
          const submissionId = String(params.submission_id ?? "");
          ctx.replyResult({
            admission_id: admissionId,
            ref: { profile_id: profileIdentity, session_id: sessionId },
            sequence: admissionSeq,
            status: "queued",
            outcome: null,
            authority_epoch: 1,
            execution_generation: null,
          });

          setTimeout(() => {
            const common = {
              authority_epoch: 1,
              execution_generation: 1,
              admission_id: admissionId,
              session_id: sessionId,
              replay_epoch: "epoch-canonical-1",
            };
            ctx.sendNotification("event", {
              type: "session.info",
              session_id: sessionId,
              payload: {
                stored_session_id: sessionId,
                pending: [
                  {
                    admission_id: admissionId,
                    sequence: 1,
                    status: "queued",
                    outcome: null,
                    authority_epoch: 1,
                    execution_generation: null,
                    input_id: submissionId,
                    text: params.text,
                  },
                ],
                running: false,
                execution_generation: 0,
                revision: 0,
              },
              replay_epoch: "epoch-canonical-1",
              seq: 1,
            });
            ctx.sendNotification("event", { ...common, type: "message.start", payload: {}, seq: 2 });
            ctx.sendNotification("event", {
              ...common,
              type: "session.info",
              payload: {
                stored_session_id: sessionId,
                pending: [
                  {
                    admission_id: admissionId,
                    sequence: 1,
                    status: "started",
                    outcome: null,
                    authority_epoch: 1,
                    execution_generation: 1,
                    input_id: submissionId,
                    text: params.text,
                  },
                ],
                running: true,
                execution_generation: 1,
                revision: 0,
              },
              seq: 3,
            });
            ctx.sendNotification("event", {
              ...common,
              type: "message.delta",
              payload: { text: "MOCK_HERMES_", turn_id: "gw-turn-1", segment: 0, offset: 0 },
              seq: 4,
            });
            ctx.sendNotification("event", {
              ...common,
              type: "message.delta",
              payload: { text: "REPLY_OK", turn_id: "gw-turn-1", segment: 0, offset: 12 },
              seq: 5,
            });
            ctx.sendNotification("event", {
              ...common,
              type: "message.complete",
              payload: {
                text: "MOCK_HERMES_REPLY_OK",
                content: "MOCK_HERMES_REPLY_OK",
                admission_id: admissionId,
                outcome: "completed",
                status: "complete",
                persisted_turn: {
                  row_ids: [1, 2],
                  complete: true,
                  user_row_id: 1,
                  final_assistant_row_id: 2,
                  submission_id: submissionId,
                },
              },
              seq: 6,
            });
            ctx.sendNotification("event", {
              ...common,
              type: "session.info",
              payload: {
                stored_session_id: sessionId,
                pending: [],
                running: false,
                execution_generation: 1,
                revision: 1,
              },
              seq: 7,
            });
          }, 15);
          return true;
        }
        return false;
      },
    });

    let supervisor: ConnectionSupervisor | null = null;
    try {
      supervisor = await bootCanonicalSupervisor({
        sandbox,
        wsUrl: gw.wsUrl,
        validTickets,
        profileIdentity,
      });

      const created = (await supervisor.handlers["sessions.create"](
        { title: "Canonical Live Repro" },
        { connectionId: "local", profileId: profileIdentity },
      )) as { session: { sessionId: string }; transcript: SessionTranscriptSnapshot };

      const sync = createTranscriptSyncController();
      sync.applySnapshot(created.transcript, created.transcript.snapshotSeq ?? 0, { replace: true });
      const unsub = supervisor.subscribe(
        "session.transcript",
        { connectionId: "local", profileId: profileIdentity, sessionId: created.session.sessionId },
        (ev: BridgeEvent) => {
          sync.acceptEvent(ev);
        },
      );

      await supervisor.handlers["prompts.send"](
        { sessionId: created.session.sessionId, text: "你好啊。" },
        { connectionId: "local", profileId: profileIdentity, sessionId: created.session.sessionId },
      );

      await waitUntil(() => {
        const snap = sync.getSnapshot();
        return Boolean(
          snap &&
            snap.activeTurnId === null &&
            snap.messages.some(
              (m) => m.role === "assistant" && m.text.includes("MOCK_HERMES_REPLY_OK") && !m.streaming,
            ),
        );
      });

      const finalSnap = sync.getSnapshot();
      const assistantMessages = (finalSnap?.messages ?? []).filter((m) => m.role === "assistant");
      unsub();

      expect({
        activeTurnId: finalSnap?.activeTurnId ?? null,
        hasAssistantReply: assistantMessages.some(
          (m) => m.text.includes("MOCK_HERMES_REPLY_OK") && m.streaming === false,
        ),
        hasStreamingPlaceholder: assistantMessages.some((m) => Boolean(m.streaming)),
      }).toEqual({
        activeTurnId: null,
        hasAssistantReply: true,
        hasStreamingPlaceholder: false,
      });
      passed = true;
    } finally {
      await supervisor?.dispose();
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  it("preserves persisted assistant replies keyed by message_uid/row_id on session.resume and clears finished optimistic turns", async () => {
    const sandbox = createTestSandbox("hermes-r11-resume-uid-");
    let passed = false;
    const profileIdentity = sandbox.hermesHomeDir;
    const validTickets = new Set<string>();
    const sessionId = "local-canonical-sess-2";
    let turnCompletedOnGateway = false;

    const gw = await startFakeGatewayServer({
      validTickets,
      runtimeDescribe: {
        instance_id: "inst-canonical-2",
        profile_id: profileIdentity,
        authority_epoch: 1,
        capabilities: CANONICAL_CAPABILITIES,
        session_create: { sources: ["cli", "gui"], parameters: ["title"] },
      },
      profiles: [{ name: "default", path: profileIdentity, is_default: true }],
      initialSessions: [],
      onRpc: (method, params, ctx) => {
        if (method === "subscribe") {
          ctx.replyError(-32601, "unknown method: subscribe — not available on this Hermes backend", {
            reason: "unknown_method",
          });
          return true;
        }
        if (method === "profiles.list") {
          ctx.replyResult({
            profiles: [
              { name: "default", path: profileIdentity, is_default: true, model: "gpt-4o-mini" },
            ],
          });
          return true;
        }
        if (method === "session.list") {
          ctx.replyResult({
            sessions:
              params.scope === "live"
                ? [
                    {
                      session_id: sessionId,
                      id: sessionId,
                      title: "Multi-turn Session",
                      source: "local",
                      message_count: turnCompletedOnGateway ? 4 : 2,
                      running: false,
                    },
                  ]
                : [],
            scope: params.scope ?? "live",
            next_cursor: null,
          });
          return true;
        }
        if (method === "prompt.submit") {
          turnCompletedOnGateway = true;
          ctx.replyResult({
            admission_id: "adm-2",
            ref: { profile_id: profileIdentity, session_id: sessionId },
            sequence: 2,
            status: "queued",
            outcome: null,
            authority_epoch: 1,
            execution_generation: null,
          });
          return true;
        }
        if (method === "session.resume") {
          const messages: Array<Record<string, unknown>> = [
            {
              role: "user",
              content: "1",
              _db_persisted: true,
              message_uid: "uid-user-1",
              message_id: "adm-1",
              timestamp: 1795580900.1,
              row_id: 1,
            },
            {
              role: "assistant",
              content: "FIRST_REPLY_OK",
              _db_persisted: true,
              message_uid: "uid-assistant-1",
              timestamp: 1795580901.2,
              finish_reason: "stop",
              row_id: 2,
            },
          ];
          if (turnCompletedOnGateway) {
            messages.push(
              {
                role: "user",
                content: "你好啊。",
                _db_persisted: true,
                message_uid: "uid-user-2",
                message_id: "adm-2",
                timestamp: 1795580939.5,
                row_id: 3,
              },
              {
                role: "assistant",
                content: "SECOND_REPLY_OK",
                _db_persisted: true,
                message_uid: "uid-assistant-2",
                timestamp: 1795580941.4,
                finish_reason: "stop",
                row_id: 4,
              },
            );
          }
          ctx.replyResult({
            session_id: sessionId,
            stored_session_id: sessionId,
            messages,
            message_count: messages.length,
            running: false,
            authority_epoch: 1,
            replay_epoch: "epoch-canonical-2",
            last_sequence: 13,
            subscription_id: "sub-canonical-2",
            revision: turnCompletedOnGateway ? 2 : 1,
            execution_generation: turnCompletedOnGateway ? 2 : 1,
            pending: [],
            prompts: [],
          });
          return true;
        }
        return false;
      },
    });

    let supervisor: ConnectionSupervisor | null = null;
    try {
      supervisor = await bootCanonicalSupervisor({
        sandbox,
        wsUrl: gw.wsUrl,
        validTickets,
        profileIdentity,
      });

      // Part A: Initial select/resume must not drop persisted assistant messages lacking message_id
      const selected = (await supervisor.handlers["sessions.select"](
        { sessionId },
        { connectionId: "local", profileId: profileIdentity, sessionId },
      )) as { transcript: SessionTranscriptSnapshot | null };

      expect(selected.transcript?.activeTurnId).toBeNull();
      expect(
        selected.transcript?.messages.some(
          (m) => m.role === "assistant" && m.text.includes("FIRST_REPLY_OK") && !m.streaming,
        ),
      ).toBe(true);

      // Part B: Send a second message, then resume after gateway persisted the reply (running=false, pending=[])
      await supervisor.handlers["prompts.send"](
        { sessionId, text: "你好啊。" },
        { connectionId: "local", profileId: profileIdentity, sessionId },
      );

      const resumed = (await supervisor.handlers["sessions.resume"](
        { sessionId },
        { connectionId: "local", profileId: profileIdentity, sessionId },
      )) as { transcript: SessionTranscriptSnapshot };

      expect(resumed.transcript.activeTurnId).toBeNull();
      expect(
        resumed.transcript.messages.some(
          (m) => m.role === "assistant" && m.text.includes("SECOND_REPLY_OK") && !m.streaming,
        ),
      ).toBe(true);
      expect(resumed.transcript.messages.some((m) => Boolean(m.streaming))).toBe(false);
      passed = true;
    } finally {
      await supervisor?.dispose();
      await gw.close();
      sandbox.cleanup(passed);
    }
  });
});
