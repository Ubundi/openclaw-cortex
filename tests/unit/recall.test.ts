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
    recallQueryType: "combined",
    recallProfile: "auto",
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
  it("uses latest user message as recall query instead of full prompt", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler(
      {
        prompt: "<cortex_memories>\n- [1.00] noisy prior memory\n</cortex_memories>\nSystem startup boilerplate...",
        messages: [
          { role: "user", content: [{ type: "text", text: "What is the default Redis cache TTL we use?" }] },
        ],
      },
      {},
    );

    expect(client.recall).toHaveBeenCalledWith(
      "What is the default Redis cache TTL we use?",
      500,
      { limit: 10, queryType: "factual", userId: undefined, context: undefined, minConfidence: 0.5 },
    );
  });

  it("falls back to sanitized prompt when no user message is available", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler(
      {
        prompt: "<cortex_memories>\n- [1.00] noisy prior memory\n</cortex_memories>\nWhat package manager does this project use?",
      },
      {},
    );

    expect(client.recall).toHaveBeenCalledWith(
      "What package manager does this project use?",
      500,
      { limit: 10, queryType: "combined", userId: undefined, context: undefined, minConfidence: undefined },
    );
  });

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

  it("truncates prompts longer than 2000 chars", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const longPrompt = "x".repeat(3000);
    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler({ prompt: longPrompt }, {});

    const calledQuery = (client.recall as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledQuery.length).toBe(2000);
  });

  it("does not truncate prompts at or under 2000 chars", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;

    const exactPrompt = "y".repeat(2000);
    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler({ prompt: exactPrompt }, {});

    const calledQuery = (client.recall as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledQuery.length).toBe(2000);
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
      { limit: 15, queryType: "combined", userId: undefined, context: undefined, minConfidence: undefined },
    );
  });

  it("skips recall when knowledgeState.hasMemories is false and recently checked", async () => {
    const client = { recall: vi.fn(), knowledge: vi.fn() } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: false, totalSessions: 0, pipelineTier: 1, maturity: "cold", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeUndefined();
    expect(client.recall).not.toHaveBeenCalled();
    expect(client.knowledge).not.toHaveBeenCalled();
  });

  it("re-checks knowledge when hasMemories is false and lastChecked is stale", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({
        memories: [{ content: "remembered", confidence: 0.9, when: null, session_id: null, entities: [] }],
      }),
      knowledge: vi.fn().mockResolvedValue({ total_memories: 5, total_sessions: 2, maturity: "warming" }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 2, pipeline_maturity: "warming" }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = {
      hasMemories: false,
      totalSessions: 0,
      pipelineTier: 1,
      maturity: "cold",
      lastChecked: Date.now() - 6 * 60_000, // 6 minutes ago — past the 5-min re-check interval
    };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(client.knowledge).toHaveBeenCalled();
    expect(ks.hasMemories).toBe(true);
    expect(ks.totalSessions).toBe(2);
    expect(result).toBeDefined();
    expect(result!.prependContext).toContain("remembered");
  });

  it("stays skipped after knowledge re-check still shows zero memories", async () => {
    const client = {
      recall: vi.fn(),
      knowledge: vi.fn().mockResolvedValue({ total_memories: 0, total_sessions: 0, maturity: "cold" }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = {
      hasMemories: false,
      totalSessions: 0,
      pipelineTier: 1,
      maturity: "cold",
      lastChecked: Date.now() - 6 * 60_000,
    };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(client.knowledge).toHaveBeenCalled();
    expect(ks.hasMemories).toBe(false);
    expect(result).toBeUndefined();
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("handles knowledge re-check failure gracefully", async () => {
    const client = {
      recall: vi.fn(),
      knowledge: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as CortexClient;
    const ks: KnowledgeState = {
      hasMemories: false,
      totalSessions: 0,
      pipelineTier: 1,
      maturity: "cold",
      lastChecked: Date.now() - 6 * 60_000,
    };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(client.knowledge).toHaveBeenCalled();
    expect(result).toBeUndefined();
    // lastChecked should be updated so we don't re-check every call
    expect(ks.lastChecked).toBeGreaterThan(Date.now() - 1000);
  });

  it("allows recall when knowledgeState.hasMemories is true", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({
        memories: [{ content: "test", confidence: 0.9, when: null, session_id: null, entities: [] }],
      }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 5, pipelineTier: 1, maturity: "warming", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeDefined();
    expect(client.recall).toHaveBeenCalled();
  });

  it("uses tier-aware timeout for Tier 2", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 20, pipelineTier: 2, maturity: "warming", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 500 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 2: max(500 * 1.5, 12000) = 12000ms
    expect(client.recall).toHaveBeenCalledWith("some longer query", 12000, { limit: 10, queryType: "combined", userId: undefined, context: undefined, minConfidence: undefined });
  });

  it("uses tier-aware timeout for Tier 3", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 35, pipelineTier: 3, maturity: "mature", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 500 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 3: max(500 * 2, 20000) = 20000ms
    expect(client.recall).toHaveBeenCalledWith("some longer query", 20000, { limit: 10, queryType: "combined", userId: undefined, context: undefined, minConfidence: undefined });
  });

  it("respects user-configured timeout when higher than tier floor", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 35, pipelineTier: 3, maturity: "mature", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 15000 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 3: max(15000 * 2, 20000) = 30000ms
    expect(client.recall).toHaveBeenCalledWith("some longer query", 30000, { limit: 10, queryType: "combined", userId: undefined, context: undefined, minConfidence: undefined });
  });
});

describe("deriveEffectiveTimeout", () => {
  it("returns config value for Tier 1", () => {
    expect(deriveEffectiveTimeout(500, 1)).toBe(500);
  });

  it("scales 1.5× with 12s floor for Tier 2", () => {
    expect(deriveEffectiveTimeout(500, 2)).toBe(12000);    // max(750, 12000)
    expect(deriveEffectiveTimeout(10000, 2)).toBe(15000);  // max(15000, 12000)
  });

  it("scales 2× with 20s floor for Tier 3", () => {
    expect(deriveEffectiveTimeout(500, 3)).toBe(20000);    // max(1000, 20000)
    expect(deriveEffectiveTimeout(15000, 3)).toBe(30000);  // max(30000, 20000)
  });
});
