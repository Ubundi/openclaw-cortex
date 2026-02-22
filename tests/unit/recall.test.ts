import { describe, it, expect, vi } from "vitest";
import { createRecallHandler, deriveEffectiveTimeout } from "../../src/features/recall/handler.js";
import type { CortexClient } from "../../src/adapters/cortex/client.js";
import type { CortexConfig } from "../../src/plugin/config/schema.js";
import type { KnowledgeState } from "../../src/plugin/index.js";

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

describe("createRecallHandler", () => {
  it("returns prependContext with formatted memories", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({
        memories: [
          { content: "User likes TypeScript", confidence: 0.92, when: null, session_id: null, entities: [] },
          { content: "Project uses Postgres", confidence: 0.85, when: null, session_id: null, entities: [] },
        ],
      }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "Tell me about the project" }, {});

    expect(result).toBeDefined();
    expect(result!.prependContext).toContain("<cortex_memories>");
    expect(result!.prependContext).toContain("User likes TypeScript");
    expect(result!.prependContext).toContain("[0.92]");
  });

  it("returns undefined when autoRecall is disabled", async () => {
    const client = { recall: vi.fn() } as unknown as CortexClient;
    const handler = createRecallHandler(client, makeConfig({ autoRecall: false }), logger);

    const result = await handler({ prompt: "test prompt" }, {});

    expect(result).toBeUndefined();
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("returns undefined for short prompts", async () => {
    const client = { recall: vi.fn() } as unknown as CortexClient;
    const handler = createRecallHandler(client, makeConfig(), logger);

    const result = await handler({ prompt: "hi" }, {});

    expect(result).toBeUndefined();
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("returns undefined when no memories", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeUndefined();
  });

  it("handles timeout gracefully", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const client = {
      recall: vi.fn().mockRejectedValue(abortError),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "some query here" }, {});

    expect(result).toBeUndefined();
  });

  it("handles network errors gracefully", async () => {
    const client = {
      recall: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "some query here" }, {});

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("passes recallLimit to client.recall", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig({ recallLimit: 15 }), logger);
    await handler({ prompt: "some query here" }, {});

    expect(client.recall).toHaveBeenCalledWith(
      "some query here",
      500,
      { limit: 15 },
    );
  });

  it("skips recall when knowledgeState.hasMemories is false", async () => {
    const client = { recall: vi.fn() } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: false, totalSessions: 0, maturity: "cold", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeUndefined();
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("allows recall when knowledgeState.hasMemories is true", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({
        memories: [{ content: "test", confidence: 0.9, when: null, session_id: null, entities: [] }],
      }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 5, maturity: "warming", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeDefined();
    expect(client.recall).toHaveBeenCalled();
  });

  it("uses tier-aware timeout for Tier 2", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 20, maturity: "warming", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 500 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 2 floor is 1500ms, should override the configured 500ms
    expect(client.recall).toHaveBeenCalledWith("some longer query", 1500, { limit: 10 });
  });

  it("uses tier-aware timeout for Tier 3", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 35, maturity: "mature", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 500 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 3 floor is 2000ms, should override the configured 500ms
    expect(client.recall).toHaveBeenCalledWith("some longer query", 2000, { limit: 10 });
  });

  it("respects user-configured timeout when higher than tier floor", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 35, maturity: "mature", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 5000 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // User configured 5000ms > Tier 3 floor 2000ms, so use 5000ms
    expect(client.recall).toHaveBeenCalledWith("some longer query", 5000, { limit: 10 });
  });
});

describe("deriveEffectiveTimeout", () => {
  it("returns config value for Tier 1 (<15 sessions)", () => {
    expect(deriveEffectiveTimeout(500, 0)).toBe(500);
    expect(deriveEffectiveTimeout(500, 14)).toBe(500);
  });

  it("enforces 1500ms floor for Tier 2 (15-29 sessions)", () => {
    expect(deriveEffectiveTimeout(500, 15)).toBe(1500);
    expect(deriveEffectiveTimeout(500, 29)).toBe(1500);
    expect(deriveEffectiveTimeout(2000, 20)).toBe(2000);
  });

  it("enforces 2000ms floor for Tier 3 (30+ sessions)", () => {
    expect(deriveEffectiveTimeout(500, 30)).toBe(2000);
    expect(deriveEffectiveTimeout(500, 100)).toBe(2000);
    expect(deriveEffectiveTimeout(3000, 50)).toBe(3000);
  });
});
