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
    recallLimit: 10,
    recallTimeoutMs: 500,
    fileSync: true,
    transcriptSync: true,
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

  it("disables recall after 3 consecutive failures", async () => {
    const recallMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const client = { recall: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 3 consecutive failures trigger cold-start
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

  it("re-enables recall after cooldown period", async () => {
    const recallMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const client = { recall: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // Trigger cold-start
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});
    await handler({ prompt: "query three here" }, {});

    // Advance past 30s cooldown
    vi.advanceTimersByTime(31_000);

    // Now resolve successfully
    recallMock.mockResolvedValueOnce({
      memories: [{ content: "test memory", confidence: 0.9, when: null, session_id: null, entities: [] }],
    });

    const result = await handler({ prompt: "query after cooldown" }, {});
    expect(recallMock).toHaveBeenCalled();
    expect(result?.prependContext).toContain("test memory");
  });

  it("resets failure counter on success", async () => {
    let callCount = 0;
    const recallMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new DOMException("aborted", "AbortError");
      return { memories: [{ content: "mem", confidence: 0.9, when: null, session_id: null, entities: [] }] };
    });
    const client = { recall: recallMock } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    // 2 failures
    await handler({ prompt: "query one here" }, {});
    await handler({ prompt: "query two here" }, {});

    // 1 success — resets counter
    await handler({ prompt: "query three here" }, {});

    // 2 more failures — should NOT trigger cold-start (counter was reset)
    recallMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    await handler({ prompt: "query four here" }, {});
    await handler({ prompt: "query five here" }, {});

    // Should still be callable (not in cooldown)
    recallMock.mockClear();
    recallMock.mockResolvedValueOnce({ memories: [] });
    await handler({ prompt: "query six here" }, {});
    expect(recallMock).toHaveBeenCalled();
  });

  it("exposes metrics on the handler", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);

    await handler({ prompt: "test query here" }, {});
    expect(handler.metrics.count).toBe(1);
  });
});
