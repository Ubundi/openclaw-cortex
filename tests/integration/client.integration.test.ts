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

const TEST_NAMESPACE = `integration-test-${Date.now()}`;

describeIf(!!API_KEY)("CortexClient integration", () => {
  let client: CortexClient;

  beforeAll(() => {
    client = new CortexClient(BASE_URL, API_KEY!);
  });

  it("submitIngest enqueues text and returns job_id", async () => {
    const result = await client.submitIngest(
      "Integration test: the project uses PostgreSQL with pgvector for embeddings.",
      TEST_NAMESPACE,
    );

    expect(result).toBeDefined();
    expect(typeof result.job_id).toBe("string");
    expect(result.job_id.length).toBeGreaterThan(0);
    expect(typeof result.status).toBe("string");
    console.log(`  Submitted ingest job: ${result.job_id} (status: ${result.status})`);
  }, 15_000);

  it("submitIngestConversation enqueues messages and returns job_id", async () => {
    const result = await client.submitIngestConversation(
      [
        { role: "user", content: "What database does the project use?" },
        { role: "assistant", content: "The project uses PostgreSQL with pgvector for vector storage and retrieval." },
      ],
      TEST_NAMESPACE,
    );

    expect(result).toBeDefined();
    expect(typeof result.job_id).toBe("string");
    expect(result.job_id.length).toBeGreaterThan(0);
    expect(typeof result.status).toBe("string");
    console.log(`  Submitted conversation job: ${result.job_id} (status: ${result.status})`);
  }, 15_000);

  it("warmup returns tenant_id and already_warm flag", async () => {
    const result = await client.warmup();

    expect(result).toBeDefined();
    expect(typeof result.tenant_id).toBe("string");
    expect(result.tenant_id.length).toBeGreaterThan(0);
    expect(typeof result.already_warm).toBe("boolean");
    console.log(`  Warmup: tenant=${result.tenant_id}, already_warm=${result.already_warm}`);
  }, 30_000);

  it("reflect returns consolidation counts", async () => {
    const result = await client.reflect();

    expect(result).toBeDefined();
    expect(typeof result.nodes_created).toBe("number");
    expect(typeof result.edges_created).toBe("number");
    expect(typeof result.entities_processed).toBe("number");
    expect(typeof result.entities_skipped).toBe("number");
    console.log(`  Reflect: ${result.nodes_created} nodes, ${result.edges_created} edges (${result.entities_processed} processed, ${result.entities_skipped} skipped)`);
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

  it("compares fast vs full mode latency", async () => {
    const RUNS = 5;
    const QUERY = "What is the project about?";

    // Warm up both modes before sampling
    await client.retrieve(QUERY, 5, "fast", 10_000);
    await client.retrieve(QUERY, 5, "full", 10_000);

    const fastLatencies: number[] = [];
    const fullLatencies: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      await client.retrieve(QUERY, 5, "fast", 10_000);
      fastLatencies.push(Date.now() - t0);

      const t1 = Date.now();
      await client.retrieve(QUERY, 5, "full", 10_000);
      fullLatencies.push(Date.now() - t1);
    }

    fastLatencies.sort((a, b) => a - b);
    fullLatencies.sort((a, b) => a - b);

    const p50 = (arr: number[]) => arr[Math.floor(arr.length * 0.5)];
    const p95 = (arr: number[]) => arr[Math.floor(arr.length * 0.95)];

    console.log(`  fast — p50=${p50(fastLatencies)}ms  p95=${p95(fastLatencies)}ms  [${fastLatencies.map((l) => `${l}ms`).join(", ")}]`);
    console.log(`  full — p50=${p50(fullLatencies)}ms  p95=${p95(fullLatencies)}ms  [${fullLatencies.map((l) => `${l}ms`).join(", ")}]`);
    console.log(`  fast is ${((p50(fullLatencies) / p50(fastLatencies)) - 1) > 0 ? ((p50(fullLatencies) / p50(fastLatencies) - 1) * 100).toFixed(0) + "% faster" : "not faster"} at p50`);

    expect(Array.isArray(fastLatencies)).toBe(true);
    expect(Array.isArray(fullLatencies)).toBe(true);
  }, 120_000);
});
