import { describe, it, expect, vi } from "vitest";
import { createRecallHandler, deriveEffectiveTimeout, mapRetrieveToRecallMemories } from "../../src/features/recall/handler.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { CortexConfig } from "../../src/plugin/config.js";
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
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
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

    expect(client.retrieve).toHaveBeenCalledWith(
      "What is the default Redis cache TTL we use?",
      10,
      "fast",
      500,
      "factual",
      { referenceDate: expect.any(String), userId: undefined },
    );
  });

  it("falls back to sanitized prompt when no user message is available", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler(
      {
        prompt: "<cortex_memories>\n- [1.00] noisy prior memory\n</cortex_memories>\nWhat package manager does this project use?",
      },
      {},
    );

    expect(client.retrieve).toHaveBeenCalledWith(
      "What package manager does this project use?",
      10,
      "full",
      500,
      "combined",
      { referenceDate: expect.any(String), userId: undefined },
    );
  });

  it("augments factual queries with recent conversation context when available", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler(
      {
        prompt: "System prompt wrapper",
        messages: [
          { role: "assistant", content: "We switched auth to OAuth 2.1 with PKCE and removed legacy tokens." },
          { role: "user", content: "What is the auth flow we settled on?" },
        ],
      },
      {},
    );

    const calledQuery = (client.retrieve as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledQuery).toContain("What is the auth flow we settled on?");
    expect(calledQuery).toContain("Context:");
    expect(calledQuery).toContain("assistant: We switched auth to OAuth 2.1 with PKCE and removed legacy tokens.");
    expect(calledQuery).toContain("user: What is the auth flow we settled on?");
  });

  it("returns prependContext with formatted memories", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({
        results: [
          { node_id: "1", type: "FACT", content: "User likes TypeScript", score: 0.92, confidence: 0.92 },
          { node_id: "2", type: "FACT", content: "Project uses Postgres", score: 0.85, confidence: 0.85 },
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
    const client = { retrieve: vi.fn() } as unknown as CortexClient;
    const handler = createRecallHandler(client, makeConfig({ autoRecall: false }), logger);

    const result = await handler({ prompt: "test prompt" }, {});

    expect(result).toBeUndefined();
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("returns undefined for short prompts", async () => {
    const client = { retrieve: vi.fn() } as unknown as CortexClient;
    const handler = createRecallHandler(client, makeConfig(), logger);

    const result = await handler({ prompt: "hi" }, {});

    expect(result).toBeUndefined();
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("returns undefined when no memories", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeUndefined();
  });

  it("handles timeout gracefully", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const client = {
      retrieve: vi.fn().mockRejectedValue(abortError),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "some query here" }, {});

    expect(result).toBeUndefined();
  });

  it("handles network errors gracefully", async () => {
    const client = {
      retrieve: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    const result = await handler({ prompt: "some query here" }, {});

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("truncates prompts longer than 2000 chars", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const longPrompt = "x".repeat(3000);
    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler({ prompt: longPrompt }, {});

    const calledQuery = (client.retrieve as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledQuery.length).toBe(2000);
  });

  it("does not truncate prompts at or under 2000 chars", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const exactPrompt = "y".repeat(2000);
    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler({ prompt: exactPrompt }, {});

    const calledQuery = (client.retrieve as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledQuery.length).toBe(2000);
  });

  it("passes recallLimit to client.retrieve", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig({ recallLimit: 15 }), logger);
    await handler({ prompt: "some query here" }, {});

    expect(client.retrieve).toHaveBeenCalledWith(
      "some query here",
      15,
      "full",
      500,
      "combined",
      { referenceDate: expect.any(String), userId: undefined },
    );
  });

  it("skips recall when knowledgeState.hasMemories is false and recently checked", async () => {
    const client = { retrieve: vi.fn(), knowledge: vi.fn() } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: false, totalSessions: 0, pipelineTier: 1, maturity: "cold", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeUndefined();
    expect(client.retrieve).not.toHaveBeenCalled();
    expect(client.knowledge).not.toHaveBeenCalled();
  });

  it("re-checks knowledge when hasMemories is false and lastChecked is stale", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({
        results: [{ node_id: "1", type: "FACT", content: "remembered", score: 0.9, confidence: 0.9 }],
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
      retrieve: vi.fn(),
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
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("handles knowledge re-check failure gracefully", async () => {
    const client = {
      retrieve: vi.fn(),
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
      retrieve: vi.fn().mockResolvedValue({
        results: [{ node_id: "1", type: "FACT", content: "test", score: 0.9, confidence: 0.9 }],
      }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 5, pipelineTier: 1, maturity: "warming", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig(), logger, undefined, ks);
    const result = await handler({ prompt: "some longer query" }, {});

    expect(result).toBeDefined();
    expect(client.retrieve).toHaveBeenCalled();
  });

  it("uses tier-aware timeout for Tier 2", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 20, pipelineTier: 2, maturity: "warming", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 500 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 2: max(500 * 1.5, 12000) = 12000ms
    expect(client.retrieve).toHaveBeenCalledWith(
      "some longer query",
      10,
      "full",
      12000,
      "combined",
      { referenceDate: expect.any(String), userId: undefined },
    );
  });

  it("uses tier-aware timeout for Tier 3", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 35, pipelineTier: 3, maturity: "mature", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 500 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 3: max(500 * 2, 20000) = 20000ms
    expect(client.retrieve).toHaveBeenCalledWith(
      "some longer query",
      10,
      "full",
      20000,
      "combined",
      { referenceDate: expect.any(String), userId: undefined },
    );
  });

  it("respects user-configured timeout when higher than tier floor", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;
    const ks: KnowledgeState = { hasMemories: true, totalSessions: 35, pipelineTier: 3, maturity: "mature", lastChecked: Date.now() };

    const handler = createRecallHandler(client, makeConfig({ recallTimeoutMs: 15000 }), logger, undefined, ks);
    await handler({ prompt: "some longer query" }, {});

    // Tier 3: max(15000 * 2, 20000) = 30000ms
    expect(client.retrieve).toHaveBeenCalledWith(
      "some longer query",
      10,
      "full",
      30000,
      "combined",
      { referenceDate: expect.any(String), userId: undefined },
    );
  });
});

it("strips [cortex-date] marker from query and uses it as referenceDate", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler(
      {
        prompt: "[cortex-date: 2024-11-18]\n\nWhat is the default Redis cache TTL we use?",
      },
      {},
    );

    expect(client.retrieve).toHaveBeenCalledWith(
      "What is the default Redis cache TTL we use?",
      10,
      "fast",
      500,
      "factual",
      { referenceDate: "2024-11-18", userId: undefined },
    );
  });

  it("strips [cortex-date] from latest user message and uses it as referenceDate", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig(), logger);
    await handler(
      {
        prompt: "system preamble",
        messages: [
          { role: "user", content: "[cortex-date: 2024-11-18]\n\nWhat auth flow did we settle on?" },
        ],
      },
      {},
    );

    const [calledQuery, , , , , calledOptions] = (client.retrieve as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledQuery).toBe("What auth flow did we settle on?");
    expect(calledOptions.referenceDate).toBe("2024-11-18");
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

describe("mapRetrieveToRecallMemories", () => {
  it("preserves retrieve ranking score as relevance and confidence separately", () => {
    const [memory] = mapRetrieveToRecallMemories([
      {
        node_id: "1",
        type: "FACT",
        content: "Project uses PostgreSQL",
        score: 0.42,
        confidence: 0.96,
        source: "semantic",
      },
    ]);

    expect(memory.relevance).toBe(0.42);
    expect(memory.confidence).toBe(0.96);
    expect(memory.source_origin).toBeUndefined();
  });

  it("maps provenance and session_id from retrieve metadata instead of retrieval stage", () => {
    const [memory] = mapRetrieveToRecallMemories([
      {
        node_id: "1",
        type: "FACT",
        content: "Worker jobs come from pg-boss",
        score: 0.67,
        source: "reranked",
        metadata: {
          occurred_at: "2026-03-10T10:00:00Z",
          entity_refs: ["pg-boss"],
          session_id: "sess-123",
          source_origin: "transcript",
          derivation_mode: "extracted",
          source_app: "openclaw",
        },
      },
    ]);

    expect(memory.relevance).toBe(0.67);
    expect(memory.confidence).toBe(0.67);
    expect(memory.when).toBe("2026-03-10T10:00:00Z");
    expect(memory.entities).toEqual(["pg-boss"]);
    expect(memory.session_id).toBe("sess-123");
    expect(memory.source_origin).toBe("transcript");
    expect(memory.derivation_mode).toBe("extracted");
    expect(memory.source_app).toBe("openclaw");
  });

  it("falls back to retrieval score when retrieve confidence is omitted", () => {
    const [memory] = mapRetrieveToRecallMemories([
      {
        node_id: "1",
        type: "FACT",
        content: "The queue runs on pg-boss",
        score: 0.18,
      },
    ]);

    expect(memory.relevance).toBe(0.18);
    expect(memory.confidence).toBe(0.18);
  });
});
