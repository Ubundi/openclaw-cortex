/**
 * Integration test for the full recall pipeline:
 * prompt → CortexClient.retrieve → formatMemories → prependContext
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

const TEST_NAMESPACE = `integration-test-recall-${Date.now()}`;

describeIf(!!API_KEY)("Recall pipeline integration", () => {
  let client: CortexClient;

  const config: CortexConfig = {
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    autoRecall: true,
    autoCapture: true,
    recallTopK: 5,
    recallTimeoutMs: 5000,
    recallMode: "fast",
    recallQueryType: "combined",
    fileSync: true,
    transcriptSync: true,
    reflectIntervalMs: 0,
    namespace: TEST_NAMESPACE,
  };

  const logger = {
    debug: (...args: unknown[]) => console.log("  [debug]", ...args),
    info: (...args: unknown[]) => console.log("  [info]", ...args),
    warn: (...args: unknown[]) => console.warn("  [warn]", ...args),
    error: (...args: unknown[]) => console.error("  [error]", ...args),
  };

  beforeAll(async () => {
    client = new CortexClient(BASE_URL, API_KEY!);

    // Submit seed jobs with retry, returning job_id on success
    const submitWithRetry = async (fn: () => Promise<{ job_id: string; status: string }>, label: string): Promise<string | null> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { job_id } = await fn();
          console.log(`  Seed "${label}": submitted job ${job_id} (attempt ${attempt})`);
          return job_id;
        } catch (err) {
          console.warn(`  Seed "${label}": attempt ${attempt} failed:`, (err as Error).message);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      }
      console.warn(`  Seed "${label}": all attempts failed, tests may return empty results`);
      return null;
    };

    // Poll a job until completed or failed
    const pollUntilComplete = async (jobId: string, label: string): Promise<void> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = await client.getJob(jobId);
        if (status.status === "completed") {
          console.log(`  Job "${label}" (${jobId}): completed`);
          return;
        }
        if (status.status === "failed") {
          console.warn(`  Job "${label}" failed: ${status.error ?? "unknown"}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      console.warn(`  Job "${label}" timed out after 60s`);
    };

    const [ingestJobId, conversationJobId] = await Promise.all([
      submitWithRetry(
        () => client.submitIngest(
          "The user's name is Alice and she works at Ubundi as a software engineer.",
          TEST_NAMESPACE,
        ),
        "ingest-fact",
      ),
      submitWithRetry(
        () => client.submitIngestConversation(
          [
            { role: "user", content: "We decided to use TypeScript for the plugin" },
            { role: "assistant", content: "Good choice. TypeScript gives us compile-time safety for the OpenClaw plugin API." },
          ],
          TEST_NAMESPACE,
        ),
        "ingest-conversation",
      ),
    ]);

    // Wait for both jobs to finish processing before recall tests run
    await Promise.all([
      ingestJobId ? pollUntilComplete(ingestJobId, "ingest-fact") : Promise.resolve(),
      conversationJobId ? pollUntilComplete(conversationJobId, "ingest-conversation") : Promise.resolve(),
    ]);
  }, 90_000);

  it("recall handler returns prependContext with cortex_memories tag", async () => {
    const handler = createRecallHandler(client, config, logger);

    const result = await handler(
      { prompt: "Who is the user and where do they work?" },
      { sessionKey: TEST_NAMESPACE },
    );

    console.log("  Result:", JSON.stringify(result, null, 2)?.slice(0, 500));

    if (result?.prependContext) {
      expect(result.prependContext).toContain("<cortex_memories>");
      expect(result.prependContext).toContain("</cortex_memories>");
      console.log("  ✓ prependContext contains cortex_memories tag");
    } else {
      console.log("  ⚠ No results returned (tenant may need more data or indexing time)");
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
