import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecallHandler } from "../../src/features/recall/handler.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { CortexConfig } from "../../src/plugin/config.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallLimit: 10,
    recallQueryType: "combined",
    recallProfile: "auto",
    recallTimeoutMs: 500,
    ...overrides,
    namespace: overrides.namespace ?? "test",
  };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("cold-start detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disables recall after 3 consecutive hard failures (not timeouts)", async () => {
    // Use connection errors, not AbortError — timeouts don't count toward cold-start
    const recallMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = { retrieve: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 3 consecutive hard failures trigger cold-start
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("consecutive failures"),
    );

    // Next call should be skipped (cold-start cooldown)
    recallMock.mockClear();
    await handler({ prompt: "query four here" }, {});
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("does not trigger cold-start from timeouts alone", async () => {
    const recallMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const client = { retrieve: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 3 consecutive timeouts should NOT trigger cold-start
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("consecutive failures"),
    );

    // Next call should still attempt retrieve (not in cooldown)
    recallMock.mockClear();
    recallMock.mockResolvedValueOnce({ results: [] });
    await handler({ prompt: "query four here" }, {});
    expect(recallMock).toHaveBeenCalled();
  });

  it("re-enables recall after cooldown period", async () => {
    const recallMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = { retrieve: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // Trigger cold-start with hard failures
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    // Advance past 30s cooldown
    vi.advanceTimersByTime(31_000);

    // Now resolve successfully
    recallMock.mockResolvedValueOnce({
      results: [{ node_id: "1", type: "FACT", content: "test memory", score: 0.9, confidence: 0.9 }],
    });

    const result = await handler({ prompt: "query after cooldown" }, {});
    expect(recallMock).toHaveBeenCalled();
    expect(result?.prependContext).toContain("test memory");
  });

  it("resets failure counter on success", async () => {
    let callCount = 0;
    const recallMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("ECONNREFUSED");
      return { results: [{ node_id: "1", type: "FACT", content: "mem", score: 0.9, confidence: 0.9 }] };
    });
    const client = { retrieve: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 2 hard failures
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});

    // 1 success — resets counter
    await handler({ prompt: "query three here" }, {});

    // 2 more hard failures — should NOT trigger cold-start (counter was reset)
    recallMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await handler({ prompt: "query four here" }, {});
    await handler({ prompt: "query five here" }, {});

    // Should still be callable (not in cooldown)
    recallMock.mockClear();
    recallMock.mockResolvedValueOnce({ results: [] });
    await handler({ prompt: "query six here" }, {});
    expect(recallMock).toHaveBeenCalled();
  });

  it("downgrades from full to fast mode on server timeout (500/504)", async () => {
    let callCount = 0;
    const retrieveMock = vi.fn().mockImplementation(async (_q: string, _topK: number, mode: string) => {
      callCount++;
      if (mode === "full") throw new Error("Cortex retrieve failed: 500 — {\"message\":\"Internal Server Error\"}");
      // "fast" mode succeeds
      return { results: [{ node_id: "1", type: "FACT", content: "fast mode memory", score: 0.8, confidence: 0.8 }] };
    });
    const client = { retrieve: retrieveMock } as unknown as CortexClient;

    const knowledgeState = { hasMemories: true, lastChecked: Date.now(), totalSessions: 5, maturity: "mature" as const, pipelineTier: 3 as const };
    const handler = createRecallHandler(client, makeConfig(), logger, undefined, knowledgeState);

    const result = await handler({ prompt: "what database did we choose" }, {});

    // Should have been called twice: first full (fails), then fast (succeeds)
    expect(retrieveMock).toHaveBeenCalledTimes(2);
    expect(retrieveMock.mock.calls[0][2]).toBe("full");
    expect(retrieveMock.mock.calls[1][2]).toBe("fast");
    expect(result?.prependContext).toContain("fast mode memory");
  });

  it("does not trigger cold-start from server 500/504 timeouts", async () => {
    const retrieveMock = vi.fn().mockRejectedValue(new Error("Cortex retrieve failed: 504 — {\"detail\":\"Request timed out\"}"));
    const client = { retrieve: retrieveMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 3 consecutive 504s should NOT trigger cold-start (they're timeouts, not dead service)
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("consecutive failures"),
    );
  });

  it("exposes metrics on the handler", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    await handler({ prompt: "test query here" }, {});
    expect(handler.metrics.count).toBe(1);
  });
});
