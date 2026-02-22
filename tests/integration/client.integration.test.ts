/**
 * Integration tests against a real Cortex API instance.
 *
 * Run with:
 *   CORTEX_API_KEY=sk-cortex-... npm run test:integration
 *
 * These tests are skipped if CORTEX_API_KEY is not set.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CortexClient } from "../../src/cortex/client.js";

const API_KEY = process.env.CORTEX_API_KEY;
const BASE_URL =
  process.env.CORTEX_BASE_URL ??
  "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod";

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

const TEST_SESSION = `integration-test-${Date.now()}`;

describeIf(!!API_KEY)("CortexClient integration", () => {
  let client: CortexClient;

  beforeAll(() => {
    client = new CortexClient(BASE_URL, API_KEY!);
  });

  it("remember stores text and returns memory summary", async () => {
    const result = await client.remember(
      "Integration test: the project uses PostgreSQL with pgvector for embeddings.",
      TEST_SESSION,
    );

    expect(result).toBeDefined();
    expect(typeof result.memories_created).toBe("number");
    expect(Array.isArray(result.entities_found)).toBe(true);
    expect(Array.isArray(result.facts)).toBe(true);
    console.log(`  Remembered ${result.memories_created} memories, entities: ${result.entities_found.join(", ")}`);
  }, 30_000);

  it("rememberConversation stores messages and returns memory summary", async () => {
    const result = await client.rememberConversation(
      [
        { role: "user", content: "What database does the project use?" },
        { role: "assistant", content: "The project uses PostgreSQL with pgvector for vector storage and retrieval." },
      ],
      TEST_SESSION,
    );

    expect(result).toBeDefined();
    expect(typeof result.memories_created).toBe("number");
    expect(Array.isArray(result.facts)).toBe(true);
    console.log(`  Remembered ${result.memories_created} memories from conversation`);
  }, 30_000);

  it("recall returns memories with expected shape", async () => {
    const result = await client.recall("What database does the project use?", 10_000);

    expect(result).toBeDefined();
    expect(result.memories).toBeDefined();
    expect(Array.isArray(result.memories)).toBe(true);

    if (result.memories.length > 0) {
      const first = result.memories[0];
      expect(typeof first.content).toBe("string");
      expect(typeof first.confidence).toBe("number");
      console.log(`  Recalled ${result.memories.length} memories, top: [${first.confidence.toFixed(3)}] "${first.content.slice(0, 80)}"`);
    } else {
      console.log("  No memories recalled (tenant may be empty or not yet indexed)");
    }
  }, 15_000);

  it("recall respects timeout", async () => {
    const start = Date.now();

    try {
      await client.recall("test query", 1);
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    console.log(`  Timeout fired in ${elapsed}ms`);
  });

  it("knowledge returns summary with expected shape", async () => {
    const result = await client.knowledge();

    expect(result).toBeDefined();
    expect(typeof result.total_memories).toBe("number");
    expect(typeof result.total_sessions).toBe("number");
    expect(typeof result.maturity).toBe("string");
    expect(Array.isArray(result.entities)).toBe(true);
    console.log(`  Knowledge: ${result.total_memories} memories, ${result.total_sessions} sessions, maturity=${result.maturity}`);
  }, 15_000);

  it("healthCheck returns true for live API", async () => {
    const healthy = await client.healthCheck();
    expect(healthy).toBe(true);
  });
});
