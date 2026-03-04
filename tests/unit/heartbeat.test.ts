import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHeartbeatHandler } from "../../src/features/heartbeat/handler.js";
import type { CortexClient } from "../../src/adapters/cortex/client.js";
import type { KnowledgeState } from "../../src/plugin/index.js";
import type { RetryQueue } from "../../src/internal/queue/retry-queue.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeKnowledgeState(overrides: Partial<KnowledgeState> = {}): KnowledgeState {
  return {
    hasMemories: false,
    totalSessions: 0,
    pipelineTier: 1,
    maturity: "cold",
    lastChecked: 0,
    ...overrides,
  };
}

function makeRetryQueue(pending = 0): RetryQueue {
  return { pending } as unknown as RetryQueue;
}

describe("createHeartbeatHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes knowledge state when stale", async () => {
    const client = {
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 50,
        total_sessions: 8,
        maturity: "warming",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 2, pipeline_maturity: "warming" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: 0 });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    await handler();

    expect(client.knowledge).toHaveBeenCalledWith(undefined, "user-1");
    expect(client.stats).toHaveBeenCalledWith(undefined, "user-1");
    expect(state.hasMemories).toBe(true);
    expect(state.totalSessions).toBe(8);
    expect(state.maturity).toBe("warming");
    expect(state.pipelineTier).toBe(2);
    expect(state.lastChecked).toBeGreaterThan(0);
  });

  it("skips refresh when checked recently", async () => {
    const client = {
      knowledge: vi.fn(),
      stats: vi.fn(),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: Date.now() });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    await handler();

    expect(client.knowledge).not.toHaveBeenCalled();
    expect(client.stats).not.toHaveBeenCalled();
  });

  it("logs when sessions or maturity change", async () => {
    const client = {
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 200,
        total_sessions: 25,
        maturity: "mature",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 3, pipeline_maturity: "mature" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({
      lastChecked: 0,
      totalSessions: 10,
      maturity: "warming",
    });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    await handler();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("sessions 10 → 25"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("maturity warming → mature"),
    );
  });

  it("does not log when state is unchanged", async () => {
    const client = {
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 50,
        total_sessions: 8,
        maturity: "warming",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 2, pipeline_maturity: "warming" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({
      lastChecked: 0,
      totalSessions: 8,
      maturity: "warming",
    });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    await handler();

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("sessions"),
    );
  });

  it("logs retry queue status when tasks are pending", async () => {
    const client = {
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 0,
        total_sessions: 0,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: 0 });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(3), () => "user-1");

    await handler();

    expect(logger.info).toHaveBeenCalledWith("Cortex heartbeat: 3 retry task(s) pending");
  });

  it("does not log retry queue when empty", async () => {
    const client = {
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 0,
        total_sessions: 0,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: 0 });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(0), () => "user-1");

    await handler();

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("retry task"),
    );
  });

  it("handles knowledge endpoint failure gracefully", async () => {
    const client = {
      knowledge: vi.fn().mockRejectedValue(new Error("503")),
      stats: vi.fn().mockRejectedValue(new Error("503")),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: 0, totalSessions: 5 });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    await handler();

    // State should remain unchanged
    expect(state.totalSessions).toBe(5);
    expect(state.lastChecked).toBe(0);
  });

  it("updates tier even when knowledge fails", async () => {
    const client = {
      knowledge: vi.fn().mockRejectedValue(new Error("timeout")),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 3, pipeline_maturity: "mature" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: 0, pipelineTier: 1 });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    await handler();

    expect(state.pipelineTier).toBe(3);
    // lastChecked not updated since knowledge failed
    expect(state.lastChecked).toBe(0);
  });

  it("prevents concurrent refreshes", async () => {
    let resolveKnowledge!: (v: any) => void;
    const client = {
      knowledge: vi.fn().mockImplementation(
        () => new Promise((r) => { resolveKnowledge = r; }),
      ),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
    } as unknown as CortexClient;

    const state = makeKnowledgeState({ lastChecked: 0 });
    const handler = createHeartbeatHandler(client, logger, state, makeRetryQueue(), () => "user-1");

    // Fire two heartbeats while first is still in-flight
    const p1 = handler();
    const p2 = handler();

    resolveKnowledge({
      total_memories: 10,
      total_sessions: 2,
      maturity: "cold",
      entities: [],
    });

    await Promise.all([p1, p2]);

    // Only one knowledge call despite two heartbeat invocations
    expect(client.knowledge).toHaveBeenCalledTimes(1);
  });
});
