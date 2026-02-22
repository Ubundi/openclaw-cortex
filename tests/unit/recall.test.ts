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
});
