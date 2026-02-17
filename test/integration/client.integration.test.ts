/**
 * Integration tests against a real Cortex API instance.
 *
 * Run with:
 *   CORTEX_API_KEY=sk-cortex-... npm run test:integration
 *
 * These tests are skipped if CORTEX_API_KEY is not set.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CortexClient } from "../../src/client.js";

const API_KEY = process.env.CORTEX_API_KEY;
const BASE_URL =
  process.env.CORTEX_BASE_URL ??
  "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod";

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(!!API_KEY)("CortexClient integration", () => {
  let client: CortexClient;

  beforeAll(() => {
    client = new CortexClient(BASE_URL, API_KEY!);
  });

  it("ingest accepts text and returns nodes_created + facts", async () => {
    const result = await client.ingest(
      "Integration test: the project uses PostgreSQL with pgvector for embeddings.",
      "integration-test",
    );

    expect(result).toBeDefined();
    expect(typeof result.nodes_created).toBe("number");
    expect(typeof result.edges_created).toBe("number");
    expect(Array.isArray(result.facts)).toBe(true);
    expect(Array.isArray(result.entities)).toBe(true);
    console.log(`  Ingested: ${result.nodes_created} nodes, ${result.facts.length} facts, ${result.entities.length} entities`);
  }, 30_000);

  it("ingestConversation accepts messages and returns facts", async () => {
    const result = await client.ingestConversation(
      [
        { role: "user", content: "What database does the project use?" },
        { role: "assistant", content: "The project uses PostgreSQL with pgvector for vector storage and retrieval." },
      ],
      "integration-test",
    );

    expect(result).toBeDefined();
    expect(typeof result.nodes_created).toBe("number");
    expect(Array.isArray(result.facts)).toBe(true);
    console.log(`  Conversation: ${result.nodes_created} nodes, ${result.facts.length} facts, ${result.entities.length} entities`);
  }, 30_000);

  it("retrieve returns results with expected shape", async () => {
    const result = await client.retrieve("What database does the project use?", 5, "fast", 10_000);

    expect(result).toBeDefined();
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);

    if (result.results.length > 0) {
      const first = result.results[0];
      expect(typeof first.node_id).toBe("string");
      expect(typeof first.type).toBe("string");
      expect(typeof first.content).toBe("string");
      expect(typeof first.score).toBe("number");
      console.log(`  Retrieved ${result.results.length} results, top: [${first.type}] ${first.score.toFixed(3)} "${first.content.slice(0, 80)}"`);
    } else {
      console.log("  No results (tenant may be empty or not yet indexed)");
    }
  }, 15_000);

  it("retrieve respects timeout", async () => {
    const start = Date.now();

    try {
      await client.retrieve("test query", 5, "fast", 1);
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    console.log(`  Timeout fired in ${elapsed}ms`);
  });

  it("retrieve with mode=full returns results", async () => {
    const result = await client.retrieve("PostgreSQL", 3, "full", 10_000);

    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    console.log(`  Full mode: ${result.results.length} results`);
  }, 15_000);

  it("measures retrieve latency (fast mode)", async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await client.retrieve("What is the project about?", 5, "fast", 10_000);
      latencies.push(Date.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    console.log(`  Latencies: ${latencies.map((l) => `${l}ms`).join(", ")}`);
    console.log(`  p50=${p50}ms, p95=${p95}ms`);

    if (p95 > 2000) {
      console.warn(`  ⚠ p95 (${p95}ms) exceeds default recallTimeoutMs (2000ms)`);
    }
  }, 60_000);
});
