import { describe, expect, it, vi } from "vitest";
import type { TurnRecoveryTopicSnapshot } from "@hermes/contracts";
import { TurnRecoveryCoordinator } from "./turnRecoveryCoordinator";

describe("TurnRecoveryCoordinator (Issue #43 TDD slices)", () => {
  it("Slice 1: pauses session/queue on unknown turn, shows 'Turn lost during restart', and resolves via prompt.resolve_unknown without auto-discard/resend", async () => {
    const snapshots: TurnRecoveryTopicSnapshot[] = [];
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T10:00:00.000Z"),
      onChange: (snap) => snapshots.push(snap),
    });

    const view = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-1",
      ownerGeneration: 2,
      activeTurnId: null,
      executionGeneration: 4,
      unknownTurns: [
        {
          admissionId: "adm-lost-1",
          executionGeneration: 3,
          turnId: "turn-lost-1",
          originalInput: "删除旧的 build 产物",
          lostReason: "owner_restarted",
          message: "Turn lost during restart",
        },
      ],
      queuedAdmissions: [
        {
          admissionId: "adm-follower-1",
          submissionId: "sub-follower-1",
          text: "下一步运行测试",
          position: 1,
          state: "queued",
        },
      ],
    });

    expect(view.queuePaused).toBe(true);
    expect(view.unknownTurn).not.toBeNull();
    expect(view.unknownTurn?.admissionId).toBe("adm-lost-1");
    expect(view.unknownTurn?.executionGeneration).toBe(3);
    expect(view.unknownTurn?.message).toBe("Turn lost during restart");
    expect(view.unknownTurn?.originalInput).toBe("删除旧的 build 产物");
    expect(view.queuedAdmissions).toHaveLength(1);
    expect(view.queuedAdmissions[0].admissionId).toBe("adm-follower-1");

    const sendResolve = vi.fn(async (payload: { admission_id: string; execution_generation: number }) => {
      expect(payload).toEqual({
        admission_id: "adm-lost-1",
        execution_generation: 3,
      });
      return {
        settled: true,
        status: "interrupted",
        followersReleased: true,
        queuedAdmissions: [
          {
            admissionId: "adm-follower-1",
            submissionId: "sub-follower-1",
            text: "下一步运行测试",
            position: 1,
            state: "queued" as const,
          },
        ],
      };
    });

    const resolved = await coord.resolveUnknown(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-1",
      },
      sendResolve,
    );

    expect(sendResolve).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      resolved: true,
      status: "interrupted",
      admissionId: "adm-lost-1",
      executionGeneration: 3,
    });

    const after = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-1",
    });
    expect(after?.unknownTurn).toBeNull();
    expect(after?.queuePaused).toBe(false);
    expect(after?.stopState).toBe("stopped");
    expect(after?.queuedAdmissions).toHaveLength(1);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  it("Slice 2: caps stop at 'stopping' until interrupt receipt/terminal, and marks cancel_outcome_unknown on ACK loss, disconnect, or owner change without cross-generation auto-resend", async () => {
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T10:05:00.000Z"),
    });

    coord.noteTurnStarted({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop",
      turnId: "turn-9",
      executionGeneration: 5,
      ownerGeneration: 1,
    });

    // Receipt says interrupt was accepted (stopping), NOT yet terminal
    const stoppingRes = await coord.requestStop(
      { connectionId: "local", profileId: "default", sessionId: "s-stop" },
      async ({ turnId, executionGeneration }) => {
        expect(turnId).toBe("turn-9");
        expect(executionGeneration).toBe(5);
        const mid = coord.getSessionView({
          connectionId: "local",
          profileId: "default",
          sessionId: "s-stop",
        });
        expect(mid?.stopState).toBe("stopping");
        return { accepted: true, status: "stopping" };
      },
    );
    expect(stoppingRes.status).toBe("stopping");
    expect(
      coord.getSessionView({ connectionId: "local", profileId: "default", sessionId: "s-stop" })?.activeTurnId,
    ).toBe("turn-9");

    // Owner changes while stopping -> cancel_outcome_unknown (no auto-resend!)
    coord.onOwnerGenerationChanged("local", 2, "default");
    const afterOwnerChange = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop",
    });
    expect(afterOwnerChange?.stopState).toBe("cancel_outcome_unknown");
    expect(afterOwnerChange?.ownerGeneration).toBe(2);

    // Resume reveals turn already stopped
    const reconciled = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop",
      ownerGeneration: 2,
      activeTurnId: null,
      executionGeneration: 5,
      lastTurnOutcome: "stopped",
    });
    expect(reconciled.stopState).toBe("stopped");
    expect(reconciled.activeTurnId).toBeNull();

    // New turn ACK loss during stop -> cancel_outcome_unknown
    coord.noteTurnStarted({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop",
      turnId: "turn-10",
      executionGeneration: 6,
      ownerGeneration: 2,
    });
    await expect(
      coord.requestStop(
        { connectionId: "local", profileId: "default", sessionId: "s-stop" },
        async () => {
          const err = new Error("Stop ACK timeout");
          (err as { code?: string }).code = "timeout";
          throw err;
        },
      ),
    ).rejects.toThrow("Stop ACK timeout");

    const unknownStop = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop",
    });
    expect(unknownStop?.stopState).toBe("cancel_outcome_unknown");
    expect(unknownStop?.stopRequestedGeneration).toBe(6);

    // Disconnect while another turn is stopping also yields cancel_outcome_unknown
    coord.noteTurnStarted({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-disc",
      turnId: "turn-11",
      executionGeneration: 1,
      ownerGeneration: 2,
    });
    await coord.requestStop(
      { connectionId: "local", profileId: "default", sessionId: "s-disc" },
      async () => ({ accepted: true, status: "stopping" }),
    );
    coord.onConnectionOffline("local", "default");
    const afterDisc = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-disc",
    });
    expect(afterDisc?.stopState).toBe("cancel_outcome_unknown");
    expect(afterDisc?.lastKnownUnverified).toBe(true);

    // Auto-reconnect may first see the old turn still running and return to idle. A later
    // authoritative resume showing the turn terminal must still surface "stopped".
    const autoResume = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-disc",
      ownerGeneration: 3,
      activeTurnId: "turn-11",
      executionGeneration: 1,
      lastTurnOutcome: null,
    });
    expect(autoResume.stopState).toBe("idle");
    const terminalResume = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-disc",
      ownerGeneration: 3,
      activeTurnId: null,
      executionGeneration: 1,
      lastTurnOutcome: "interrupted",
    });
    expect(terminalResume.stopState).toBe("stopped");
  });

  it("Slice 3 & 4: requires admitted receipt for queue card, prevents duplicate enqueue on ACK loss via receipt/snapshot check + same submissionId retry, distinguishes queued cancel outcomes, and blocks offline queuing", async () => {
    let subSeq = 0;
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T10:10:00.000Z"),
      createSubmissionId: () => `sub-${++subSeq}`,
    });

    // Offline -> rejected immediately, zero queue cards
    await expect(
      coord.submitQueued(
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "s-q",
          text: "offline draft",
          online: false,
        },
        async () => ({ admitted: true, admission_id: "adm-never" }),
      ),
    ).rejects.toMatchObject({ code: "unreachable" });
    expect(
      coord.getSessionView({ connectionId: "local", profileId: "default", sessionId: "s-q" })
        ?.queuedAdmissions ?? [],
    ).toEqual([]);

    // Online queue submit ACK lost -> delivery_unknown (NO queue card yet!)
    const lostRes = await coord.submitQueued(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-q",
        text: "queued item 1",
        online: true,
      },
      async () => {
        const err = new Error("ACK lost");
        (err as { code?: string }).code = "timeout";
        throw err;
      },
    );
    expect(lostRes.status).toBe("delivery_unknown");
    expect(lostRes.deliveryUnknown?.submissionId).toBe("sub-1");
    expect(lostRes.deliveryUnknown?.canRetrySameSubmission).toBe(false);

    // Retrying BEFORE checking receipt/snapshot is forbidden!
    await expect(
      coord.retryQueued(
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "s-q",
          submissionId: "sub-1",
          online: true,
        },
        async () => ({ admitted: true, admission_id: "adm-dup" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    // Check receipt reports NOT found -> unlocks retry with SAME submissionId
    const checkMissing = await coord.checkQueueReceipt(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-q",
        submissionId: "sub-1",
      },
      async () => ({ found: false }),
    );
    expect(checkMissing.found).toBe(false);
    expect(checkMissing.canRetrySameSubmission).toBe(true);

    // Retry reuses exact same submissionId ("sub-1") and receives server admissionId
    const retried = await coord.retryQueued(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-q",
        submissionId: "sub-1",
        online: true,
      },
      async (payload) => {
        expect(payload.submission_id).toBe("sub-1");
        expect(payload.queued).toBe(true);
        return { admitted: true, admission_id: "adm-101", position: 1, execution_generation: 2 };
      },
    );
    expect(retried.status).toBe("admitted");
    expect(retried.admission?.admissionId).toBe("adm-101");

    // Second item ACK lost, but receipt check finds it WAS already admitted -> adopts server id, NO duplicate!
    const lost2 = await coord.submitQueued(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-q",
        text: "queued item 2",
        online: true,
      },
      async () => {
        const err = new Error("ACK lost 2");
        (err as { code?: string }).code = "timeout";
        throw err;
      },
    );
    expect(lost2.deliveryUnknown?.submissionId).toBe("sub-2");

    const foundCheck = await coord.checkQueueReceipt(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-q",
        submissionId: "sub-2",
      },
      async () => ({
        found: true,
        admission: {
          admissionId: "adm-102",
          submissionId: "sub-2",
          text: "queued item 2",
          position: 2,
          state: "queued",
        },
      }),
    );
    expect(foundCheck.found).toBe(true);
    expect(foundCheck.admission?.admissionId).toBe("adm-102");
    const qView = coord.getSessionView({ connectionId: "local", profileId: "default", sessionId: "s-q" });
    expect(qView?.pendingDeliveryUnknown).toEqual([]);
    expect(qView?.queuedAdmissions.map((a) => a.admissionId)).toEqual(["adm-101", "adm-102"]);

    // Disconnect marks queued admissions as lastKnownUnverified
    coord.onConnectionOffline("local", "default");
    expect(
      coord.getSessionView({ connectionId: "local", profileId: "default", sessionId: "s-q" })
        ?.queuedAdmissions[0].lastKnownUnverified,
    ).toBe(true);

    // Queued cancel outcomes: cancelled, stopped, already_started, and ACK loss -> cancel_unknown
    const cancel1 = await coord.cancelQueued(
      { connectionId: "local", profileId: "default", sessionId: "s-q", admissionId: "adm-101" },
      async () => ({ status: "cancelled", cancelled: true }),
    );
    expect(cancel1.outcome).toBe("cancelled");

    const cancel2 = await coord.cancelQueued(
      { connectionId: "local", profileId: "default", sessionId: "s-q", admissionId: "adm-102" },
      async () => {
        const err = new Error("Cancel ACK lost");
        (err as { code?: string }).code = "timeout";
        throw err;
      },
    );
    expect(cancel2.outcome).toBe("cancel_unknown");
  });

  it("Slice 5: enforces running executionGeneration on steer and requires explicit new_turn/queue choice on failure without silent fallback", () => {
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T10:15:00.000Z"),
    });

    coord.noteTurnStarted({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-steer",
      turnId: "turn-s1",
      executionGeneration: 7,
      ownerGeneration: 1,
    });

    // Matching generation allowed
    expect(
      coord.evaluateSteerPrecheck({
        connectionId: "local",
        profileId: "default",
        sessionId: "s-steer",
        turnId: "turn-s1",
        executionGeneration: 7,
        text: "请聚焦测试目录",
      }),
    ).toEqual({
      allowed: true,
      turnId: "turn-s1",
      executionGeneration: 7,
    });

    // Generation mismatch rejected with explicit fallback choices
    const mismatch = coord.evaluateSteerPrecheck({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-steer",
      turnId: "turn-s1",
      executionGeneration: 6,
      text: "请聚焦测试目录",
    });
    expect(mismatch.allowed).toBe(false);

    // Turn finished -> recordSteerFailure exposes explicit ["new_turn", "queue"] fallback
    coord.noteTurnTerminal({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-steer",
      turnId: "turn-s1",
      executionGeneration: 7,
      outcome: "completed",
    });
    const finishedCheck = coord.evaluateSteerPrecheck({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-steer",
      turnId: "turn-s1",
      executionGeneration: 7,
      text: "补充说明",
    });
    expect(finishedCheck).toMatchObject({ allowed: false, reason: "turn_finished" });

    const failureResult = coord.recordSteerFailure({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-steer",
      turnId: "turn-s1",
      executionGeneration: 7,
      text: "补充说明",
      reason: "turn_finished",
      message: "当前 Turn 已结束，无法中途纠偏",
    });
    expect(failureResult).toMatchObject({
      ok: true,
      steered: false,
      status: "failed",
      requiresExplicitFallback: true,
      reason: "turn_finished",
      text: "补充说明",
      allowedFallbacks: ["new_turn", "queue"],
    });
    expect(
      coord.getSessionView({ connectionId: "local", profileId: "default", sessionId: "s-steer" })
        ?.pendingSteerFallback?.allowedFallbacks,
    ).toEqual(["new_turn", "queue"]);
  });

  it("Slice S2: explicit stopped:false keeps cancel_outcome_unknown with a typed conflict instead of resetting to idle", async () => {
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T10:40:00.000Z"),
    });
    coord.noteTurnStarted({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop-false",
      turnId: "turn-stop-false",
      executionGeneration: 9,
      ownerGeneration: 1,
    });

    await expect(
      coord.requestStop(
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "s-stop-false",
          turnId: "turn-stop-false",
          executionGeneration: 9,
        },
        async () => ({ stopped: false }),
      ),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("发生了什么") });

    const view = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-stop-false",
    });
    expect(view?.stopState).toBe("cancel_outcome_unknown");
    expect(view?.stopOutcomeMessage).toContain("停止请求保持待确认");
    expect(view?.stopRequestedTurnId).toBe("turn-stop-false");
    expect(view?.stopRequestedGeneration).toBe(9);
  });

  it("Slice P6: keeps every unknown turn and never lets a malformed first entry erase a valid later entry", async () => {
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T10:45:00.000Z"),
    });

    const twoUnknown = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-multi-unknown",
      ownerGeneration: 3,
      activeTurnId: null,
      executionGeneration: 6,
      unknownTurns: [
        { admissionId: "adm-a", executionGeneration: 4, originalInput: "first" },
        { admissionId: "adm-b", executionGeneration: 5, originalInput: "second" },
      ],
    });
    expect(twoUnknown.queuePaused).toBe(true);
    expect(twoUnknown.unknownTurns.map((item) => item.admissionId)).toEqual(["adm-a", "adm-b"]);
    expect(twoUnknown.unknownTurn?.admissionId).toBe("adm-a");

    await coord.resolveUnknown(
      { connectionId: "local", profileId: "default", sessionId: "s-multi-unknown", admissionId: "adm-a" },
      async () => ({ settled: true, status: "interrupted" }),
    );
    const afterFirst = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-multi-unknown",
    });
    expect(afterFirst?.unknownTurns.map((item) => item.admissionId)).toEqual(["adm-b"]);
    expect(afterFirst?.queuePaused).toBe(true);

    await coord.resolveUnknown(
      { connectionId: "local", profileId: "default", sessionId: "s-multi-unknown", admissionId: "adm-b" },
      async () => ({ settled: true, status: "interrupted" }),
    );
    const afterSecond = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-multi-unknown",
    });
    expect(afterSecond?.unknownTurns).toEqual([]);
    expect(afterSecond?.queuePaused).toBe(false);

    const malformedFirst = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-malformed-unknown",
      ownerGeneration: 4,
      activeTurnId: null,
      executionGeneration: 7,
      unknownTurns: [
        { executionGeneration: 6 },
        { admissionId: "adm-valid", executionGeneration: 6, originalInput: "keep me" },
      ],
    });
    expect(malformedFirst.queuePaused).toBe(true);
    expect(malformedFirst.unknownTurns.map((item) => item.admissionId)).toEqual(["adm-valid"]);
    expect(malformedFirst.unknownTurn?.originalInput).toBe("keep me");
    expect(malformedFirst.unknownTurnProtocolError).toContain("无法解析");

    await coord.resolveUnknown(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-malformed-unknown",
        admissionId: "adm-valid",
      },
      async () => ({ settled: true, status: "interrupted" }),
    );
    const afterMalformedDiscard = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-malformed-unknown",
    });
    expect(afterMalformedDiscard?.unknownTurns).toEqual([]);
    expect(afterMalformedDiscard?.queuePaused).toBe(true);
    expect(afterMalformedDiscard?.unknownTurnProtocolError).toContain("无法解析");
  });

  it("keeps delivery_unknown unresolved when a canonical pending snapshot cannot prove absence", async () => {
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T11:00:00.000Z"),
    });

    const lost = await coord.submitQueued(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-unresolved",
        text: "cannot prove",
        online: true,
        submissionId: "sub-unresolved",
      },
      async () => {
        const err = new Error("ACK lost");
        (err as { code?: string }).code = "timeout";
        throw err;
      },
    );
    expect(lost.status).toBe("delivery_unknown");

    const check = await coord.checkQueueReceipt(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-unresolved",
        submissionId: "sub-unresolved",
      },
      async () => ({ found: false, absenceConfirmed: false }),
    );
    expect(check).toMatchObject({ found: false, canRetrySameSubmission: false });

    const view = coord.getSessionView({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-unresolved",
    });
    expect(view?.pendingDeliveryUnknown).toHaveLength(1);
    expect(view?.pendingDeliveryUnknown[0]).toMatchObject({
      submissionId: "sub-unresolved",
      state: "delivery_unknown",
      canRetrySameSubmission: false,
    });
    expect(view?.pendingDeliveryUnknown[0]?.statusReason).toContain("无法确认");

    await expect(
      coord.retryQueued(
        {
          connectionId: "local",
          profileId: "default",
          sessionId: "s-unresolved",
          submissionId: "sub-unresolved",
          online: true,
        },
        async () => ({ admitted: true, admission_id: "adm-dup" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not unlock retry from a canonical pending snapshot that omits terminal rows", async () => {
    const coord = new TurnRecoveryCoordinator({
      now: () => Date.parse("2026-11-23T11:10:00.000Z"),
    });

    await coord.submitQueued(
      {
        connectionId: "local",
        profileId: "default",
        sessionId: "s-canonical-absence",
        text: "terminal row absent",
        online: true,
        submissionId: "sub-canonical-absence",
      },
      async () => {
        const err = new Error("ACK lost");
        (err as { code?: string }).code = "timeout";
        throw err;
      },
    );

    const canonical = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-canonical-absence",
      ownerGeneration: 1,
      activeTurnId: null,
      executionGeneration: 2,
      queuedAdmissions: [],
      queueSnapshotProvesAbsence: false,
    });
    expect(canonical.pendingDeliveryUnknown[0]).toMatchObject({
      submissionId: "sub-canonical-absence",
      state: "delivery_unknown",
      canRetrySameSubmission: false,
    });

    const legacy = coord.reconcileFromResume({
      connectionId: "local",
      profileId: "default",
      sessionId: "s-canonical-absence",
      ownerGeneration: 1,
      activeTurnId: null,
      executionGeneration: 2,
      queuedAdmissions: [],
    });
    expect(legacy.pendingDeliveryUnknown[0]).toMatchObject({
      submissionId: "sub-canonical-absence",
      state: "retry_ready",
      canRetrySameSubmission: true,
    });
  });
});
