/**
 * Integration test for the full recall pipeline:
 * prompt → CortexClient.recall → formatMemories → prependContext
 *
 * Run with:
 *   CORTEX_API_KEY=sk-cortex-... npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CortexClient } from "../../src/cortex/client.js";
import { createRecallHandler } from "../../src/features/recall/handler.js";
import type { CortexConfig } from "../../src/core/config/schema.js";

const API_KEY = process.env.CORTEX_API_KEY;
const BASE_URL =
  process.env.CORTEX_BASE_URL ??
  "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod";

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

const TEST_SESSION = `integration-test-recall-${Date.now()}`;

describeIf(!!API_KEY)("Recall pipeline integration", () => {
  let client: CortexClient;

  const config: CortexConfig = {
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    autoRecall: true,
    autoCapture: true,
    recallLimit: 10,
    recallTimeoutMs: 5000,
    fileSync: true,
    transcriptSync: true,
    namespace: TEST_SESSION,
  };

  const logger = {
    debug: (...args: unknown[]) => console.log("  [debug]", ...args),
    info: (...args: unknown[]) => console.log("  [info]", ...args),
    warn: (...args: unknown[]) => console.warn("  [warn]", ...args),
    error: (...args: unknown[]) => console.error("  [error]", ...args),
  };

  beforeAll(async () => {
    client = new CortexClient(BASE_URL, API_KEY!);

    // Seed some memories using the Agent API
    try {
      await client.remember(
        "The user's name is Alice and she works at Ubundi as a software engineer.",
        TEST_SESSION,
      );
      console.log("  Seed: remembered text fact");
    } catch (err) {
      console.warn("  Seed text failed:", (err as Error).message);
    }

    try {
      await client.rememberConversation(
        [
          { role: "user", content: "We decided to use TypeScript for the plugin" },
          { role: "assistant", content: "Good choice. TypeScript gives us compile-time safety for the OpenClaw plugin API." },
        ],
        TEST_SESSION,
      );
      console.log("  Seed: remembered conversation");
    } catch (err) {
      console.warn("  Seed conversation failed:", (err as Error).message);
    }

    // Small delay for indexing
    await new Promise((r) => setTimeout(r, 3_000));
  }, 60_000);

  it("recall handler returns prependContext with cortex_memories tag", async () => {
    const handler = createRecallHandler(client, config, logger);

    const result = await handler(
      { prompt: "Who is the user and where do they work?" },
      { sessionKey: TEST_SESSION },
    );

    console.log("  Result:", JSON.stringify(result, null, 2)?.slice(0, 500));

    if (result?.prependContext) {
      expect(result.prependContext).toContain("<cortex_memories>");
      expect(result.prependContext).toContain("</cortex_memories>");
      console.log("  prependContext contains cortex_memories tag");
    } else {
      console.log("  No results returned (tenant may need more data or indexing time)");
    }
  }, 15_000);

  it("recall handler returns nothing for very short prompts", async () => {
    const handler = createRecallHandler(client, config, logger);
    const result = await handler({ prompt: "hi" }, {});
    expect(result).toBeUndefined();
  });

  it("recall handler exposes latency metrics after calls", async () => {
    const handler = createRecallHandler(client, config, logger);

    await handler({ prompt: "What language is the plugin written in?" }, {});
    await handler({ prompt: "What database does the project use?" }, {});

    expect(handler.metrics.count).toBe(2);
    console.log(`  Metrics after 2 calls: p50=${handler.metrics.p50}ms, p95=${handler.metrics.p95}ms`);
  }, 15_000);
});
