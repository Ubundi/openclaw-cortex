import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecallHandler } from "../../src/features/recall/handler.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { CortexConfig } from "../../src/core/config/schema.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallTopK: 5,
    recallTimeoutMs: 500,
    recallMode: "fast" as const,
    fileSync: true,
    transcriptSync: true,
    reflectIntervalMs: 3_600_000,
    ...overrides,
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

  it("disables recall after 3 consecutive failures", async () => {
    const client = {
      retrieve: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 3 consecutive failures trigger cold-start
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("consecutive failures"),
    );

    // Next call should be skipped (cold-start cooldown)
    client.retrieve.mockClear();
    await handler({ prompt: "query four here" }, {});
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("re-enables recall after cooldown period", async () => {
    const client = {
      retrieve: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // Trigger cold-start
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    // Advance past 30s cooldown
    vi.advanceTimersByTime(31_000);

    // Now resolve successfully
    client.retrieve.mockResolvedValueOnce({
      results: [{ node_id: "n1", type: "FACT", content: "test memory", score: 0.9 }],
      query: "test",
      mode: "fast",
    });

    const result = await handler({ prompt: "query after cooldown" }, {});
    expect(client.retrieve).toHaveBeenCalled();
    expect(result?.prependContext).toContain("test memory");
  });

  it("resets failure counter on success", async () => {
    let callCount = 0;
    const client = {
      retrieve: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) throw new DOMException("aborted", "AbortError");
        return { results: [{ node_id: "n1", type: "FACT", content: "mem", score: 0.9 }] };
      }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 2 failures
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});

    // 1 success — resets counter
    await handler({ prompt: "query three here" }, {});

    // 2 more failures — should NOT trigger cold-start (counter was reset)
    client.retrieve.mockRejectedValue(new DOMException("aborted", "AbortError"));
    await handler({ prompt: "query four here" }, {});
    await handler({ prompt: "query five here" }, {});

    // Should still be callable (not in cooldown)
    client.retrieve.mockClear();
    client.retrieve.mockResolvedValueOnce({ results: [] });
    await handler({ prompt: "query six here" }, {});
    expect(client.retrieve).toHaveBeenCalled();
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
