import { describe, it, expect, vi } from "vitest";
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
    recallQueryType: "combined" as const,
    fileSync: true,
    transcriptSync: true,
    reflectIntervalMs: 3_600_000,
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
      retrieve: vi.fn().mockResolvedValue({
        results: [
          { node_id: "n1", type: "FACT", content: "User likes TypeScript", score: 0.92 },
          { node_id: "n2", type: "FACT", content: "Project uses Postgres", score: 0.85 },
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

  it("returns undefined when no results", async () => {
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

  it("maps recallMode 'balanced' to 'fast' in API call", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig({ recallMode: "balanced" }), logger);
    await handler({ prompt: "some query here" }, {});

    expect(client.retrieve).toHaveBeenCalledWith(
      "some query here",
      5,
      "fast", // balanced maps to fast
      500,
      "combined",
    );
  });

  it("passes 'full' mode through unchanged", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as CortexClient;

    const handler = createRecallHandler(client, makeConfig({ recallMode: "full" }), logger);
    await handler({ prompt: "some query here" }, {});

    expect(client.retrieve).toHaveBeenCalledWith(
      "some query here",
      5,
      "full",
      500,
      "combined",
    );
  });
});
