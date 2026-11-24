import type {
  ExternalAttribution,
  SessionTranscriptSnapshot,
  ToolExecutionRow,
} from "@hermes/contracts";

export const SAMPLE_SESSION_TITLE = "示例对话 · 模拟数据";

const BUILTIN_ATTRIBUTION: ExternalAttribution = {
  origin: "builtin",
  sourceLabel: "Hermes 内置",
  accessibleLabel: "Hermes 内置工具",
};

const SAMPLE_TIMES = {
  userOne: "2026-11-24T02:18:01.000Z",
  assistantOne: "2026-11-24T02:18:06.000Z",
  userTwo: "2026-11-24T02:18:24.000Z",
  assistantTwo: "2026-11-24T02:18:31.000Z",
  approval: "2026-11-24T02:18:44.000Z",
} as const;

export function buildSampleTranscript(
  connectionId: string,
  profileId: string,
  sessionId: string,
): SessionTranscriptSnapshot {
  const toolRows: ToolExecutionRow[] = [
    {
      toolCallId: "mock-sample-tool-typecheck",
      name: "shell.exec",
      status: "completed",
      summary: "pnpm typecheck · 0 errors",
      durationMs: 2400,
      attribution: BUILTIN_ATTRIBUTION,
    },
    {
      toolCallId: "mock-sample-tool-files",
      name: "files.list",
      status: "completed",
      summary: "docs/release · 12 files",
      durationMs: 180,
      attribution: BUILTIN_ATTRIBUTION,
    },
  ];

  return {
    connectionId,
    profileId,
    sessionId,
    messages: [
      {
        messageId: "mock-sample-u1",
        sessionId,
        role: "user",
        text: "帮我检查一下这周的发布准备，先跑一遍 typecheck 和测试。",
        createdAt: SAMPLE_TIMES.userOne,
        status: "complete",
      },
      {
        messageId: "mock-sample-a1",
        sessionId,
        role: "assistant",
        text:
          "好的，我先在 `hermes-desktop` 仓库确认分支和工作区状态，然后跑 `pnpm typecheck`。测试会先列出来，执行前再请你确认。",
        createdAt: SAMPLE_TIMES.assistantOne,
        turnId: "mock-sample-turn-1",
        streaming: false,
        status: "complete",
        toolRows,
      },
      {
        messageId: "mock-sample-u2",
        sessionId,
        role: "user",
        text: "把 docs/release 的清单也看一下，测试可以一起跑。",
        createdAt: SAMPLE_TIMES.userTwo,
        status: "complete",
      },
      {
        messageId: "mock-sample-a2",
        sessionId,
        role: "assistant",
        text:
          "`pnpm typecheck` 已通过，`docs/release` 下共 12 个文件。`pnpm test` 会写入本地缓存，需要一次 Approval；批准后我会继续。",
        createdAt: SAMPLE_TIMES.assistantTwo,
        turnId: "mock-sample-turn-2",
        streaming: false,
        status: "complete",
      },
    ],
    activeTurnId: null,
    turnStopping: false,
    chatAvailable: true,
    supportedActions: {
      promptSubmit: true,
      promptCancel: true,
      promptSteer: true,
      sessionCreate: true,
      sessionResume: true,
    },
    pendingApprovals: [
      {
        approvalId: "mock-sample-approval-1",
        sessionId,
        toolName: "shell.exec",
        summary: "pnpm test -- --runInBand · cwd /workspace/hermes-desktop · 需要你的确认",
        status: "pending",
        requestedAt: SAMPLE_TIMES.approval,
        attribution: BUILTIN_ATTRIBUTION,
      },
    ],
    snapshotSeq: 0,
  };
}

interface CannedReply {
  text: string;
  toolRows?: ToolExecutionRow[];
}

const CANNED_REPLIES: readonly CannedReply[] = [
  {
    text:
      "（模拟数据）收到。当前分支仍然是 `feat/release-check`，typecheck 已通过；我会先汇总发布文档，再继续测试。",
    toolRows: [
      {
        toolCallId: "mock-canned-tool-files",
        name: "files.list",
        status: "completed",
        summary: "docs/release · 12 files",
        durationMs: 180,
        attribution: BUILTIN_ATTRIBUTION,
      },
    ],
  },
  {
    text:
      "（模拟数据）好的。我会把 `pnpm test` 标记为下一项，跑完后按模块汇总通过数和失败用例。",
  },
  {
    text:
      "（模拟数据）已记录。当前没有新的阻塞项，建议先处理待审批的 `pnpm test`，然后看 `docs/release` 的变更说明。",
  },
];

export function buildCannedMockReply(
  prompt: string,
  turnSeq: number,
): { text: string; toolRows?: ToolExecutionRow[] } {
  const hash = Array.from(prompt).reduce(
    (acc, char) => (acc * 31 + (char.codePointAt(0) ?? 0)) >>> 0,
    17,
  );
  const variant = CANNED_REPLIES[hash % CANNED_REPLIES.length]!;
  return {
    text: variant.text,
    ...(variant.toolRows
      ? {
          toolRows: variant.toolRows.map((row) => ({
            ...row,
            toolCallId: `${row.toolCallId}-${turnSeq}`,
          })),
        }
      : {}),
  };
}
