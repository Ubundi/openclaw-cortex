import { describe, expect, it, vi } from "vitest";
import {
  PassiveExtractionQueue,
  type PassiveExtractionJob,
} from "../../src/features/bridge/passive-queue.js";

function job(overrides: Partial<PassiveExtractionJob> = {}): PassiveExtractionJob {
  return {
    agentUserId: overrides.agentUserId ?? "agent-user-1",
    sessionKey: overrides.sessionKey ?? "session-1",
    turnIndex: overrides.turnIndex ?? 2,
    messages: overrides.messages ?? [
      { role: "user", content: "I want the handoff to make the owner and next step obvious.", index: 0 },
    ],
    activeModelRef: overrides.activeModelRef,
    enqueuedAt: overrides.enqueuedAt ?? Date.now(),
    deadlineAt: overrides.deadlineAt ?? Date.now() + 10_000,
  };
}

describe("passive extraction background queue", () => {
  it("enqueues and returns before the background processor runs", async () => {
    const processJob = vi.fn().mockResolvedValue(undefined);
    const queue = new PassiveExtractionQueue({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      processJob,
      autoStart: false,
    });

    expect(queue.enqueue(job())).toEqual({ enqueued: true, reason: "enqueued" });
    expect(processJob).not.toHaveBeenCalled();

    await queue.drain();

    expect(processJob).toHaveBeenCalledTimes(1);
    expect(processJob.mock.calls[0][0]).toMatchObject({
      agentUserId: "agent-user-1",
      sessionKey: "session-1",
    });
  });

  it("coalesces not-started pending work for the same user session", async () => {
    const processJob = vi.fn().mockResolvedValue(undefined);
    const queue = new PassiveExtractionQueue({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      processJob,
      autoStart: false,
    });

    expect(queue.enqueue(job({ turnIndex: 2 }))).toEqual({ enqueued: true, reason: "enqueued" });
    expect(queue.enqueue(job({
      turnIndex: 4,
      messages: [
        { role: "user", content: "I want decisions written down in one place.", index: 2 },
      ],
    }))).toEqual({ enqueued: true, reason: "coalesced" });

    await queue.drain();

    expect(processJob).toHaveBeenCalledTimes(1);
    expect(processJob.mock.calls[0][0]).toMatchObject({
      turnIndex: 4,
      messages: [
        { role: "user", content: "I want decisions written down in one place.", index: 2 },
      ],
    });
  });

  it("drops jobs when global or per-user limits are exhausted", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const queue = new PassiveExtractionQueue({
      logger,
      processJob: vi.fn(),
      autoStart: false,
      maxGlobalDepth: 1,
    });

    expect(queue.enqueue(job({ sessionKey: "session-1" }))).toEqual({ enqueued: true, reason: "enqueued" });
    expect(queue.enqueue(job({ sessionKey: "session-2" }))).toEqual({
      enqueued: false,
      reason: "queue_backpressure",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("passive_job_dropped reason=queue_backpressure"));
  });

  it("drops stale jobs instead of processing them", async () => {
    const processJob = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const queue = new PassiveExtractionQueue({
      logger,
      processJob,
      autoStart: false,
    });

    expect(queue.enqueue(job({ deadlineAt: Date.now() - 1 }))).toEqual({ enqueued: true, reason: "enqueued" });
    await queue.drain();

    expect(processJob).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("passive_job_dropped reason=stale"));
  });
});
