#!/usr/bin/env npx tsx
/**
 * V1 Benchmark Runner — Three-way memory comparison
 *
 * Proves Cortex memory improves agent recall over:
 *   1. No memory (bare LLM)
 *   2. OpenClaw native memory (compacted summary + memory_search simulation)
 *   3. Cortex retrieval + compacted summary
 *
 * The "Compacted" condition simulates a real OpenClaw agent after compaction:
 *   - Compacted summary of all sessions (what's in the context window)
 *   - memory_search results (400-token chunks, 70% vector + 30% BM25 fusion, top-6)
 *   This matches OpenClaw's documented retrieval architecture and its system prompt
 *   instruction to treat memory_search as a mandatory recall step for factual questions.
 *
 * Usage:
 *   npx tsx benchmark/v1/run.ts --seed                            # first run: seed data + evaluate
 *   npx tsx benchmark/v1/run.ts                                   # subsequent runs: evaluate only
 *   npx tsx benchmark/v1/run.ts --dry-run                         # scaffold test, no API calls
 *   npx tsx benchmark/v1/run.ts --namespace-suffix trial-a        # isolate namespace per trial
 *   npx tsx benchmark/v1/run.ts --shuffle-prompts --shuffle-seed 42
 *   npx tsx benchmark/v1/run.ts --answer-concurrency 4 --judge-concurrency 4
 *   npx tsx benchmark/v1/run.ts --judge-passes 3                  # multi-pass judging
 *   npx tsx benchmark/v1/run.ts --debug-report                    # keep full retrieval metadata in report
 *
 * Namespace defaults to "benchmark-v1" and can be suffixed for isolated reruns.
 * Only use --seed on the first run of a namespace or when seed-data.json changes.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CortexClient } from "../../src/adapters/cortex/client.js";
import type { RetrieveResult, RecallMemory, KnowledgeResponse, StatsResponse } from "../../src/adapters/cortex/client.js";
import { LatencyMetrics } from "../../src/internal/metrics/latency-metrics.js";
import { formatMemories } from "../../src/features/recall/formatter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeedSession {
  id: string;
  description: string;
  messages: { role: string; content: string }[];
}

interface EvalPrompt {
  id: string;
  category: string;
  prompt: string;
  groundTruth: string;
  sourceSession: string;
  compactionRetains: boolean;
}

// A text chunk from a seed session (for OpenClaw memory_search simulation)
interface Chunk {
  id: string;
  sessionId: string;
  content: string;
  embedding?: number[];
}

// A result from the simulated OpenClaw memory_search
interface OcSearchResult {
  chunkId: string;
  sessionId: string;
  content: string;
  score: number;
}

// Pre-built index for OpenClaw memory_search simulation
interface OcMemoryIndex {
  chunks: Chunk[];
  bm25: BM25Index;
}

interface RetrievalRecord {
  promptId: string;
  fastResults: RetrieveResult[];
  fullResults: RetrieveResult[];
  // Simulated OpenClaw memory_search results (used in Compacted condition)
  ocResults: OcSearchResult[];
  fastLatencyMs: number;
  fullLatencyMs: number;
  modeOrder: ["fast", "full"] | ["full", "fast"];
}

interface AnswerRecord {
  promptId: string;
  condition: "bare" | "compacted" | "cortex";
  answer: string | null;
  error?: string;
}

interface JudgeRecord {
  promptId: string;
  condition: "bare" | "compacted" | "cortex";
  score: number | null;
  rationale: string | null;
  passScores?: number[];
  error?: string;
}

interface BenchmarkReport {
  timestamp: string;
  config: {
    llmModel: string;
    judgeModel: string;
    dryRun: boolean;
    namespace: string;
    namespaceBase: string;
    namespaceSuffix: string | null;
    debugReport: boolean;
    answerConcurrency: number;
    judgeConcurrency: number;
    judgePasses: number;
    shuffleSeed: number;
    shufflePrompts: boolean;
    gitCommit: string;
    promptOrder: string[];
    ocSearchEnabled: boolean;
    ocEmbedModel: string;
    ocChunkCount: number;
  };
  cortexStats: {
    pipelineTier: number | null;
    pipelineMaturity: string | null;
    knowledgeMaturity: string | null;
    totalMemories: number | null;
    totalSessions: number | null;
  };
  seedJobIds: string[];
  compactedSummary: string;
  retrievals: RetrievalRecord[];
  answers: AnswerRecord[];
  judgments: JudgeRecord[];
  latency: {
    fast: { count: number; p50: number | null; p95: number | null; p99: number | null };
    full: { count: number; p50: number | null; p95: number | null; p99: number | null };
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const argv = process.argv.slice(2);

const DRY_RUN = hasFlag("--dry-run");
const SEED = hasFlag("--seed");
const DEBUG_REPORT = hasFlag("--debug-report");
const SHUFFLE_PROMPTS = hasFlag("--shuffle-prompts");
const SHUFFLE_SEED = parseInteger(getArgValue("--shuffle-seed"), 1337);
const ANSWER_CONCURRENCY = parsePositiveInteger(
  getArgValue("--answer-concurrency"),
  4,
);
const JUDGE_CONCURRENCY = parsePositiveInteger(
  getArgValue("--judge-concurrency"),
  4,
);
const JUDGE_PASSES = parsePositiveInteger(getArgValue("--judge-passes"), 1);

const CORTEX_API_KEY = process.env.CORTEX_API_KEY ?? "";
const CORTEX_BASE_URL =
  process.env.CORTEX_BASE_URL ??
  "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";

const JUDGE_API_KEY = process.env.JUDGE_API_KEY || LLM_API_KEY;
const JUDGE_BASE_URL = process.env.JUDGE_BASE_URL || LLM_BASE_URL;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4.1-mini";

// OpenClaw memory_search simulation — uses LLM API for embeddings by default.
// Override with OC_EMBED_* env vars if using a non-embedding-compatible LLM endpoint.
const OC_EMBED_API_KEY = process.env.OC_EMBED_API_KEY || LLM_API_KEY;
const OC_EMBED_BASE_URL = process.env.OC_EMBED_BASE_URL || LLM_BASE_URL;
const OC_EMBED_MODEL = process.env.OC_EMBED_MODEL || "text-embedding-3-small";
const OC_TOP_K = 6; // OpenClaw default maxResults

const NAMESPACE_BASE = process.env.BENCHMARK_NAMESPACE ?? "benchmark-v1";
const NAMESPACE_SUFFIX = normalizeNamespaceSuffix(
  getArgValue("--namespace-suffix") ?? process.env.BENCHMARK_NAMESPACE_SUFFIX ?? "",
);
const NAMESPACE = NAMESPACE_SUFFIX ? `${NAMESPACE_BASE}-${NAMESPACE_SUFFIX}` : NAMESPACE_BASE;
const GIT_COMMIT = getGitCommit();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seedData: SeedSession[] = JSON.parse(
  readFileSync(join(__dirname, "seed-data.json"), "utf-8"),
);

const prompts: EvalPrompt[] = JSON.parse(
  readFileSync(join(__dirname, "prompts.json"), "utf-8"),
);
const promptsById = new Map(prompts.map((p) => [p.id, p]));
const runPrompts = SHUFFLE_PROMPTS
  ? shuffleDeterministic(prompts, SHUFFLE_SEED)
  : [...prompts];
const runPromptOrder = runPrompts.map((p) => p.id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Condition = "bare" | "compacted" | "cortex";

function log(phase: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

function hasFlag(flag: string): boolean {
  return argv.includes(flag) || argv.some((arg) => arg.startsWith(`${flag}=`));
}

function getArgValue(flag: string): string | undefined {
  const direct = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const value = argv[idx + 1];
  return value.startsWith("--") ? undefined : value;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const n = parseInteger(raw, fallback);
  return n > 0 ? n : fallback;
}

function normalizeNamespaceSuffix(raw: string): string | null {
  const normalized = raw
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

// Reads the current git commit hash directly from .git/HEAD without spawning a process.
function getGitCommit(): string {
  try {
    const headPath = join(__dirname, "../../.git/HEAD");
    const head = readFileSync(headPath, "utf-8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = join(__dirname, "../../.git", head.slice(5));
      return readFileSync(refPath, "utf-8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function retrievalModeOrder(promptId: string): ["fast", "full"] | ["full", "fast"] {
  const h = hashString(`${promptId}:${SHUFFLE_SEED}`);
  return h % 2 === 0 ? ["fast", "full"] : ["full", "fast"];
}

function trimRetrieveResult(result: RetrieveResult): RetrieveResult {
  return {
    node_id: result.node_id,
    type: result.type,
    content: result.content,
    score: result.score,
    source: result.source,
    confidence: result.confidence,
  };
}

function trimRetrievalForReport(record: RetrievalRecord): RetrievalRecord {
  return {
    promptId: record.promptId,
    fastResults: record.fastResults.map(trimRetrieveResult),
    fullResults: record.fullResults.map(trimRetrieveResult),
    // OC results are already concise (truncated chunks), keep as-is
    ocResults: record.ocResults,
    fastLatencyMs: record.fastLatencyMs,
    fullLatencyMs: record.fullLatencyMs,
    modeOrder: record.modeOrder,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await worker(items[idx], idx);
      }
    }),
  );

  return results;
}

async function callLLM(
  messages: { role: string; content: string }[],
  opts: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 30_000,
  );

  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0,
        top_p: opts.topP ?? 1,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new Error(`LLM API returned no content (choices: ${data.choices?.length ?? 0})`);
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJudgeResponse(resp: string): { score: number; rationale: string } {
  const cleaned = resp.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Judge returned non-JSON response: ${cleaned.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]) as {
    score?: unknown;
    rationale?: unknown;
  };
  if (typeof parsed.score !== "number") {
    throw new Error(`Judge score missing/invalid: ${jsonMatch[0].slice(0, 120)}`);
  }
  const normalizedScore = Math.max(0, Math.min(3, Math.round(parsed.score)));
  const rationale =
    typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided";
  return { score: normalizedScore, rationale };
}

function aggregatePassScores(scores: number[]): number {
  const counts = new Map<number, number>();
  for (const score of scores) {
    counts.set(score, (counts.get(score) ?? 0) + 1);
  }

  let bestScore = scores[0] ?? 0;
  let bestCount = -1;
  for (const [score, count] of counts) {
    if (count > bestCount || (count === bestCount && score > bestScore)) {
      bestScore = score;
      bestCount = count;
    }
  }
  return bestScore;
}

// ---------------------------------------------------------------------------
// OpenClaw memory_search Simulation
//
// Implements OpenClaw's documented retrieval architecture:
//   - 400-token sliding window chunks with 80-token overlap
//   - Embedding: text-embedding-3-small (or configured OC_EMBED_MODEL)
//   - Fusion: 0.70 × cosine + 0.30 × BM25-normalized (OpenClaw's exact formula)
//   - Top-6 results (OpenClaw's default maxResults)
//
// This simulates what a well-configured OpenClaw agent would retrieve via
// memory_search before answering a factual question about prior sessions.
// ---------------------------------------------------------------------------

class BM25Index {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private readonly docs: string[][];
  private readonly avgdl: number;
  private readonly idf: Map<string, number>;

  constructor(documents: string[]) {
    this.docs = documents.map((d) => this.tokenize(d));
    this.avgdl = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
    const df = new Map<string, number>();
    for (const doc of this.docs) {
      for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    this.idf = new Map();
    const N = this.docs.length;
    for (const [term, freq] of df) {
      this.idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    }
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  }

  // Returns all docs ranked by BM25 score, highest first.
  rankAll(query: string): { idx: number; bm25Score: number }[] {
    const terms = this.tokenize(query);
    return this.docs
      .map((doc, idx) => {
        const dl = doc.length;
        const tf = new Map<string, number>();
        for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
        let score = 0;
        for (const term of terms) {
          const idf = this.idf.get(term) ?? 0;
          const f = tf.get(term) ?? 0;
          score +=
            idf *
            ((f * (this.k1 + 1)) /
              (f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl)));
        }
        return { idx, bm25Score: score };
      })
      .sort((a, b) => b.bm25Score - a.bm25Score);
  }
}

// Splits session text into overlapping chunks matching OpenClaw's chunking:
// 400-token target window, 80-token overlap (~4 chars/token approximation).
function chunkSessionText(text: string, sessionId: string): Chunk[] {
  const TARGET_CHARS = 400 * 4; // ~400 tokens
  const OVERLAP_CHARS = 80 * 4; // ~80 tokens
  const STRIDE = TARGET_CHARS - OVERLAP_CHARS;
  const chunks: Chunk[] = [];
  let start = 0;
  let idx = 0;
  while (start < text.length) {
    const end = Math.min(start + TARGET_CHARS, text.length);
    const content = text.slice(start, end).trim();
    if (content.length > 20) {
      chunks.push({ id: `${sessionId}:${idx}`, sessionId, content });
      idx++;
    }
    if (end >= text.length) break;
    start += STRIDE;
  }
  return chunks;
}

// Embeds a batch of texts via the OpenAI-compatible embeddings API.
async function embedBatch(
  texts: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embeddings API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Builds the OC memory index: chunks all sessions, embeds them, and builds BM25.
async function buildOcMemoryIndex(): Promise<OcMemoryIndex> {
  const chunks: Chunk[] = [];
  for (const session of seedData) {
    const text = session.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    chunks.push(...chunkSessionText(text, session.id));
  }

  // Embed all chunks (batched up to 100 at a time)
  const BATCH = 100;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const embeddings = await embedBatch(
      batch.map((c) => c.content),
      OC_EMBED_API_KEY,
      OC_EMBED_BASE_URL,
      OC_EMBED_MODEL,
    );
    for (let j = 0; j < batch.length; j++) batch[j].embedding = embeddings[j];
  }

  return { chunks, bm25: new BM25Index(chunks.map((c) => c.content)) };
}

// Runs hybrid search (70% vector + 30% BM25-normalized) matching OpenClaw's fusion formula.
function searchOcMemory(
  queryEmbedding: number[],
  query: string,
  index: OcMemoryIndex,
  topK = OC_TOP_K,
): OcSearchResult[] {
  const bm25Ranks = index.bm25.rankAll(query);
  // Map chunk index → BM25 rank position (0 = highest)
  const bm25RankMap = new Map(bm25Ranks.map((r, rankIdx) => [r.idx, rankIdx]));

  const fused = index.chunks.map((chunk, idx) => {
    const vecScore = chunk.embedding
      ? cosineSimilarity(queryEmbedding, chunk.embedding)
      : 0;
    const bm25Rank = bm25RankMap.get(idx) ?? index.chunks.length;
    // OpenClaw normalizes BM25 rank via 1/(1+rank) before fusion
    const bm25Norm = 1 / (1 + bm25Rank);
    return { idx, score: 0.7 * vecScore + 0.3 * bm25Norm };
  });

  return fused
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ idx, score }) => ({
      chunkId: index.chunks[idx].id,
      sessionId: index.chunks[idx].sessionId,
      content: index.chunks[idx].content,
      score,
    }));
}

// Formats OC search results for injection into the LLM prompt context.
function formatOcSearchResults(results: OcSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map((r) => `[session: ${r.sessionId}]\n${r.content}`)
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Phase 1: Seed
// ---------------------------------------------------------------------------

async function runSeedPhase(client: CortexClient): Promise<string[]> {
  log("seed", `Ingesting ${seedData.length} sessions into namespace: ${NAMESPACE}`);
  const jobIds: string[] = [];

  for (const session of seedData) {
    let jobId: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sessionId = `${NAMESPACE}:session:${session.id}`;
        const resp = await client.submitIngestConversation(
          session.messages,
          sessionId,
        );
        jobId = resp.job_id;
        log("seed", `  ${session.id}: submitted job ${jobId} (attempt ${attempt})`);
        break;
      } catch (err) {
        log("seed", `  ${session.id}: attempt ${attempt} failed: ${(err as Error).message}`);
        if (attempt < 3) await sleep(5_000 * attempt);
      }
    }
    if (!jobId) {
      throw new Error(`seed: all attempts failed for ${session.id}`);
    }
    jobIds.push(jobId);
  }

  log("seed", `All ${jobIds.length} jobs submitted. Polling for completion...`);

  const deadline = Date.now() + 300_000;
  const pending = new Set(jobIds);

  while (pending.size > 0 && Date.now() < deadline) {
    const pollResults = await Promise.all(
      [...pending].map(async (id) => {
        try {
          const status = await client.getJob(id);
          return { id, status };
        } catch (err) {
          return { id, error: err as Error };
        }
      }),
    );

    for (const result of pollResults) {
      if ("error" in result) {
        log("seed", `  Job ${result.id}: poll error (retrying): ${(result.error as Error).message}`);
        continue;
      }
      if (result.status.status === "completed") {
        pending.delete(result.id);
        log("seed", `  Job ${result.id}: completed`);
      } else if (result.status.status === "failed") {
        throw new Error(
          `seed: job ${result.id} failed: ${result.status.error ?? "unknown"}`,
        );
      }
    }
    if (pending.size > 0) await sleep(2_000);
  }

  if (pending.size > 0) {
    throw new Error(`seed: ${pending.size} jobs timed out after 300s`);
  }

  log("seed", "All jobs completed successfully.");
  return jobIds;
}

// ---------------------------------------------------------------------------
// Phase 2: Warmup + Compaction
// ---------------------------------------------------------------------------

interface CortexStatsSnapshot {
  pipelineTier: number | null;
  pipelineMaturity: string | null;
  knowledgeMaturity: string | null;
  totalMemories: number | null;
  totalSessions: number | null;
}

async function fetchCortexStats(client: CortexClient): Promise<CortexStatsSnapshot> {
  const snapshot: CortexStatsSnapshot = {
    pipelineTier: null,
    pipelineMaturity: null,
    knowledgeMaturity: null,
    totalMemories: null,
    totalSessions: null,
  };

  try {
    const stats = await client.stats();
    snapshot.pipelineTier = stats.pipeline_tier;
    snapshot.pipelineMaturity = stats.pipeline_maturity;
    log("stats", `Pipeline tier: ${stats.pipeline_tier}, maturity: ${stats.pipeline_maturity}`);
  } catch (err) {
    log("stats", `WARN GET /v1/stats failed: ${(err as Error).message}`);
  }

  try {
    const knowledge = await client.knowledge();
    snapshot.knowledgeMaturity = knowledge.maturity;
    snapshot.totalMemories = knowledge.total_memories;
    snapshot.totalSessions = knowledge.total_sessions;
    log("stats", `Knowledge: ${knowledge.total_memories} memories, ${knowledge.total_sessions} sessions, maturity: ${knowledge.maturity}`);
  } catch (err) {
    log("stats", `WARN GET /v1/knowledge failed: ${(err as Error).message}`);
  }

  return snapshot;
}

async function runWarmupPhase(client: CortexClient, didSeed: boolean): Promise<{ compactedSummary: string; cortexStats: CortexStatsSnapshot }> {
  log("warmup", "Warming up tenant...");
  await client.warmup();

  if (didSeed) {
    log("warmup", "Running reflect to consolidate entities across sessions...");
    const reflectResult = await client.reflect(NAMESPACE);
    log("warmup", `Reflect done: ${reflectResult.nodes_created} nodes, ${reflectResult.edges_created} edges, ${reflectResult.entities_processed} entities processed`);
  }

  // Fetch pipeline tier and knowledge stats after warmup
  const cortexStats = await fetchCortexStats(client);

  log("warmup", "Generating compacted summary from all sessions...");
  const allTranscripts = seedData
    .map((s) => {
      const header = `--- Session: ${s.description} ---`;
      const body = s.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      return `${header}\n${body}`;
    })
    .join("\n\n");

  const compactedSummary = await callLLM(
    [
      {
        role: "system",
        content:
          "You are a memory compaction system. Summarize the following conversation transcripts into a concise project memory. Preserve specific details like numbers, file paths, package names, and configuration values. Output a structured summary organized by topic.",
      },
      { role: "user", content: allTranscripts },
    ],
    { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL, timeoutMs: 60_000, maxTokens: 4096 },
  );

  log("warmup", `Compacted summary: ${compactedSummary.length} chars`);
  return { compactedSummary, cortexStats };
}

// ---------------------------------------------------------------------------
// Phase 3: Retrieve (Cortex + OpenClaw memory_search simulation)
// ---------------------------------------------------------------------------

async function runRetrievePhase(
  client: CortexClient,
): Promise<{ records: RetrievalRecord[]; fastMetrics: LatencyMetrics; fullMetrics: LatencyMetrics; ocChunkCount: number }> {

  // Build the OpenClaw memory_search index from seed sessions
  log("retrieve", `Building OpenClaw memory index (${seedData.length} sessions)...`);
  const ocIndex = await buildOcMemoryIndex();
  log("retrieve", `OC index ready: ${ocIndex.chunks.length} chunks`);

  // Batch-embed all prompts for OC search (single API call for all 40 queries)
  log("retrieve", `Embedding ${runPrompts.length} prompts for OpenClaw memory search...`);
  const promptEmbeddings = await embedBatch(
    runPrompts.map((p) => p.prompt),
    OC_EMBED_API_KEY,
    OC_EMBED_BASE_URL,
    OC_EMBED_MODEL,
  );

  log("retrieve", `Running retrieval for ${runPrompts.length} prompts (Cortex fast+full + OC search)...`);

  const fastMetrics = new LatencyMetrics(100);
  const fullMetrics = new LatencyMetrics(100);
  const records: RetrievalRecord[] = [];

  for (let i = 0; i < runPrompts.length; i++) {
    const p = runPrompts[i];
    const modeOrder = retrievalModeOrder(p.id);
    log("retrieve", `  [${i + 1}/${runPrompts.length}] ${p.id}: ${p.prompt.slice(0, 60)}`);

    let fastResults: RetrieveResult[] = [];
    let fullResults: RetrieveResult[] = [];
    let fastMs = 0;
    let fullMs = 0;

    for (const mode of modeOrder) {
      try {
        const start = Date.now();
        const response = await client.retrieve(p.prompt, 10, mode, 30_000);
        const duration = Date.now() - start;
        if (mode === "fast") {
          fastMs = duration;
          fastMetrics.record(duration);
          fastResults = response.results;
        } else {
          fullMs = duration;
          fullMetrics.record(duration);
          fullResults = response.results;
        }
      } catch (err) {
        log("retrieve", `    WARN ${mode} retrieval failed: ${(err as Error).message}`);
      }
    }

    // OC memory_search: pure local computation using pre-embedded query
    const ocResults = searchOcMemory(promptEmbeddings[i], p.prompt, ocIndex);

    records.push({
      promptId: p.id,
      fastResults,
      fullResults,
      ocResults,
      fastLatencyMs: fastMs,
      fullLatencyMs: fullMs,
      modeOrder,
    });
  }

  log(
    "retrieve",
    `Done. Fast p50=${fastMetrics.p50}ms p95=${fastMetrics.p95}ms | Full p50=${fullMetrics.p50}ms p95=${fullMetrics.p95}ms`,
  );
  return { records, fastMetrics, fullMetrics, ocChunkCount: ocIndex.chunks.length };
}

// ---------------------------------------------------------------------------
// Phase 4: Answer
// ---------------------------------------------------------------------------

async function runAnswerPhase(
  compactedSummary: string,
  retrievals: RetrievalRecord[],
): Promise<AnswerRecord[]> {
  log(
    "answer",
    `Generating answers for ${runPrompts.length} prompts x 3 conditions (concurrency=${ANSWER_CONCURRENCY})...`,
  );
  const retrievalByPromptId = new Map(retrievals.map((r) => [r.promptId, r]));
  const systemMsg =
    "You are a coding assistant helping with a TypeScript project. Answer based only on what you know about the project. If you don't have the information, say so.";

  const batches = await mapWithConcurrency(runPrompts, ANSWER_CONCURRENCY, async (p, idx) => {
    log("answer", `  [${idx + 1}/${runPrompts.length}] ${p.id}`);
    const promptAnswers: AnswerRecord[] = [];
    const retrieval = retrievalByPromptId.get(p.id);

    // Condition 1: Bare — no memory
    try {
      const bareAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          { role: "user", content: p.prompt },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      promptAnswers.push({ promptId: p.id, condition: "bare", answer: bareAnswer });
    } catch (err) {
      promptAnswers.push({
        promptId: p.id,
        condition: "bare",
        answer: null,
        error: (err as Error).message,
      });
    }

    // Condition 2: OpenClaw native — compacted summary + memory_search results
    // Simulates an OpenClaw agent after compaction: the agent has the compacted
    // summary in context and calls memory_search (mandatory for factual questions
    // per OpenClaw's system prompt instructions). Uses top-6 chunks via hybrid
    // search (70% vector + 30% BM25), matching OpenClaw's documented architecture.
    try {
      const ocResults = retrieval?.ocResults ?? [];
      const ocContext =
        ocResults.length > 0
          ? `\n\nMemory search results (from indexed session history):\n\n${formatOcSearchResults(ocResults)}`
          : "";

      const compactedAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          {
            role: "user",
            content: `Here is a project memory summary:\n\n${compactedSummary}${ocContext}\n\nQuestion: ${p.prompt}`,
          },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      promptAnswers.push({
        promptId: p.id,
        condition: "compacted",
        answer: compactedAnswer,
      });
    } catch (err) {
      promptAnswers.push({
        promptId: p.id,
        condition: "compacted",
        answer: null,
        error: (err as Error).message,
      });
    }

    // Condition 3: Cortex — compacted summary + Cortex retrieved memories
    try {
      const asRecallMemories: RecallMemory[] = (retrieval?.fullResults ?? []).map((r) => ({
        content: r.content,
        confidence: r.score,
        when: null,
        session_id: null,
        entities: r.metadata?.entity_refs ?? [],
      }));
      const memories = formatMemories(asRecallMemories);
      const cortexAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          {
            role: "user",
            content: `Here is a project memory summary:\n\n${compactedSummary}\n\nAdditionally, here are relevant memories retrieved from Cortex:\n\n${memories}\n\nQuestion: ${p.prompt}`,
          },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      promptAnswers.push({ promptId: p.id, condition: "cortex", answer: cortexAnswer });
    } catch (err) {
      promptAnswers.push({
        promptId: p.id,
        condition: "cortex",
        answer: null,
        error: (err as Error).message,
      });
    }

    return promptAnswers;
  });

  const answers = batches.flat();

  log("answer", `Generated ${answers.length} answers (${answers.filter((a) => a.error).length} errors).`);
  return answers;
}

// ---------------------------------------------------------------------------
// Phase 5: Judge
// ---------------------------------------------------------------------------

async function runJudgePhase(answers: AnswerRecord[]): Promise<JudgeRecord[]> {
  log(
    "judge",
    `Judging ${answers.length} answers (concurrency=${JUDGE_CONCURRENCY}, passes=${JUDGE_PASSES})...`,
  );

  const judgeSystemPrompt = `You are an evaluation judge. Given a question, expected ground truth answer, and an AI's response, score the response:

3 = Grounded correct — contains the specific project detail from the ground truth
2 = Generic correct — gives a reasonable answer but lacks the specific detail
1 = Abstained — says "I don't have that context" or similar
0 = Hallucinated — fabricated specific but wrong details

Respond with ONLY a JSON object: {"score": <0-3>, "rationale": "<brief explanation>"}`;

  const judgments = await mapWithConcurrency(answers, JUDGE_CONCURRENCY, async (a, i) => {
    const prompt = promptsById.get(a.promptId);
    if (!prompt) {
      return {
        promptId: a.promptId,
        condition: a.condition,
        score: null,
        rationale: null,
        error: `Prompt not found for ${a.promptId}`,
      } satisfies JudgeRecord;
    }
    if (a.answer === null) {
      return {
        promptId: a.promptId,
        condition: a.condition,
        score: null,
        rationale: `Skipped: ${a.error}`,
      } satisfies JudgeRecord;
    }

    if ((i + 1) % 10 === 0) {
      log("judge", `  [${i + 1}/${answers.length}]`);
    }

    try {
      const passScores: number[] = [];
      const passRationales: string[] = [];
      for (let pass = 0; pass < JUDGE_PASSES; pass++) {
        const resp = await callLLM(
          [
            { role: "system", content: judgeSystemPrompt },
            {
              role: "user",
              content: `Question: ${prompt.prompt}\n\nGround Truth: ${prompt.groundTruth}\n\nAI Response: ${a.answer}`,
            },
          ],
          { apiKey: JUDGE_API_KEY, baseUrl: JUDGE_BASE_URL, model: JUDGE_MODEL },
        );
        const parsed = parseJudgeResponse(resp);
        passScores.push(parsed.score);
        passRationales.push(parsed.rationale);
      }

      return {
        promptId: a.promptId,
        condition: a.condition,
        score: aggregatePassScores(passScores),
        rationale: passRationales[0] ?? null,
        passScores: JUDGE_PASSES > 1 ? passScores : undefined,
      } satisfies JudgeRecord;
    } catch (err) {
      return {
        promptId: a.promptId,
        condition: a.condition,
        score: null,
        rationale: null,
        error: (err as Error).message,
      } satisfies JudgeRecord;
    }
  });

  log("judge", `Judged ${judgments.length} answers (${judgments.filter((j) => j.score === null).length} failures).`);
  return judgments;
}

// ---------------------------------------------------------------------------
// Phase 6: Report
// ---------------------------------------------------------------------------

function buildReport(
  cortexStats: CortexStatsSnapshot,
  seedJobIds: string[],
  compactedSummary: string,
  retrievals: RetrievalRecord[],
  answers: AnswerRecord[],
  judgments: JudgeRecord[],
  fastMetrics: LatencyMetrics,
  fullMetrics: LatencyMetrics,
  ocChunkCount: number,
): BenchmarkReport {
  return {
    timestamp: new Date().toISOString(),
    config: {
      llmModel: LLM_MODEL,
      judgeModel: JUDGE_MODEL,
      dryRun: DRY_RUN,
      namespace: NAMESPACE,
      namespaceBase: NAMESPACE_BASE,
      namespaceSuffix: NAMESPACE_SUFFIX,
      debugReport: DEBUG_REPORT,
      answerConcurrency: ANSWER_CONCURRENCY,
      judgeConcurrency: JUDGE_CONCURRENCY,
      judgePasses: JUDGE_PASSES,
      shuffleSeed: SHUFFLE_SEED,
      shufflePrompts: SHUFFLE_PROMPTS,
      gitCommit: GIT_COMMIT,
      promptOrder: runPromptOrder,
      ocSearchEnabled: !DRY_RUN,
      ocEmbedModel: OC_EMBED_MODEL,
      ocChunkCount,
    },
    cortexStats,
    seedJobIds,
    compactedSummary,
    retrievals: DEBUG_REPORT ? retrievals : retrievals.map(trimRetrievalForReport),
    answers,
    judgments,
    latency: {
      fast: fastMetrics.summary(),
      full: fullMetrics.summary(),
    },
  };
}

function writeReport(report: BenchmarkReport): string {
  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const filename = `run-${ts}.json`;
  const filepath = join(resultsDir, filename);
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

function meanScore(
  judgments: JudgeRecord[],
  condition: Condition,
  category?: string,
  compactionRetains?: boolean,
): string {
  const filtered = judgments.filter(
    (j) => {
      if (j.condition !== condition || j.score === null) return false;
      const prompt = promptsById.get(j.promptId);
      if (!prompt) return false;
      if (category !== undefined && prompt.category !== category) return false;
      if (
        compactionRetains !== undefined &&
        prompt.compactionRetains !== compactionRetains
      ) {
        return false;
      }
      return true;
    },
  );
  if (filtered.length === 0) return "N/A";
  const avg = filtered.reduce((sum, j) => sum + j.score!, 0) / filtered.length;
  return avg.toFixed(2);
}

function scoreDistribution(
  judgments: JudgeRecord[],
  condition: Condition,
): { "3": number; "2": number; "1": number; "0": number; errors: number } {
  const dist = { "3": 0, "2": 0, "1": 0, "0": 0, errors: 0 };
  for (const j of judgments) {
    if (j.condition !== condition) continue;
    if (j.score === null) dist.errors++;
    else if (j.score === 3) dist["3"]++;
    else if (j.score === 2) dist["2"]++;
    else if (j.score === 1) dist["1"]++;
    else dist["0"]++;
  }
  return dist;
}

function fmtDelta(a: string, b: string): string {
  if (a === "N/A" || b === "N/A") return "  N/A";
  const d = parseFloat(b) - parseFloat(a);
  const sign = d >= 0 ? "+" : "";
  return `${sign}${d.toFixed(2)}`;
}

function printMarkdownSummary(report: BenchmarkReport): void {
  const j = report.judgments;
  const fl = report.latency.fast;
  const ul = report.latency.full;

  const bareAll = meanScore(j, "bare");
  const compAll = meanScore(j, "compacted");
  const cortAll = meanScore(j, "cortex");
  const bareRetained = meanScore(j, "bare", undefined, true);
  const compRetained = meanScore(j, "compacted", undefined, true);
  const cortRetained = meanScore(j, "cortex", undefined, true);
  const bareNotRetained = meanScore(j, "bare", undefined, false);
  const compNotRetained = meanScore(j, "compacted", undefined, false);
  const cortNotRetained = meanScore(j, "cortex", undefined, false);

  const categories = [
    { key: "A", label: "A: Specific detail (15)" },
    { key: "B", label: "B: Decision/rationale (10)" },
    { key: "C", label: "C: Preference/convention (10)" },
    { key: "D", label: "D: Cross-session (5)" },
  ];

  // --- Summary Table ---
  console.log("\n============================================================");
  console.log("                    BENCHMARK RESULTS");
  console.log("============================================================\n");

  console.log("### Scores by Condition (0-3 scale)\n");
  console.log("| Category                     | No Mem | OpenClaw  | + Cortex | OC vs Bare   | Cortex vs OC   |");
  console.log("|------------------------------|--------|-----------|----------|--------------|----------------|");
  console.log(
    `| **Overall Mean**             | ${bareAll.padStart(6)} | ${compAll.padStart(9)} | ${cortAll.padStart(8)} | ${fmtDelta(bareAll, compAll).padStart(12)} | ${fmtDelta(compAll, cortAll).padStart(14)} |`,
  );

  for (const cat of categories) {
    const b = meanScore(j, "bare", cat.key);
    const c = meanScore(j, "compacted", cat.key);
    const x = meanScore(j, "cortex", cat.key);
    console.log(
      `| ${cat.label.padEnd(28)} | ${b.padStart(6)} | ${c.padStart(9)} | ${x.padStart(8)} | ${fmtDelta(b, c).padStart(12)} | ${fmtDelta(c, x).padStart(14)} |`,
    );
  }

  // --- Score Distribution ---
  console.log("\n### Score Distribution\n");
  console.log("| Score | Meaning              | No Mem | OpenClaw  | + Cortex |");
  console.log("|-------|----------------------|--------|-----------|----------|");
  const bareDist = scoreDistribution(j, "bare");
  const compDist = scoreDistribution(j, "compacted");
  const cortDist = scoreDistribution(j, "cortex");
  const labels = [
    { score: "3", meaning: "Grounded correct" },
    { score: "2", meaning: "Generic correct" },
    { score: "1", meaning: "Abstained" },
    { score: "0", meaning: "Hallucinated" },
  ];
  for (const { score, meaning } of labels) {
    const bv = bareDist[score as keyof typeof bareDist];
    const cv = compDist[score as keyof typeof compDist];
    const xv = cortDist[score as keyof typeof cortDist];
    console.log(
      `|     ${score} | ${meaning.padEnd(20)} | ${String(bv).padStart(6)} | ${String(cv).padStart(9)} | ${String(xv).padStart(8)} |`,
    );
  }
  if (bareDist.errors + compDist.errors + cortDist.errors > 0) {
    console.log(
      `|     - | Errors               | ${String(bareDist.errors).padStart(6)} | ${String(compDist.errors).padStart(9)} | ${String(cortDist.errors).padStart(8)} |`,
    );
  }

  // --- Latency ---
  console.log("\n### Retrieval Latency\n");
  const fmtMs = (v: number | null) => (v !== null ? `${v}ms` : "N/A");
  console.log(`| Mode | p50      | p95      | Samples |`);
  console.log(`|------|----------|----------|---------|`);
  console.log(`| Fast | ${fmtMs(fl.p50).padStart(8)} | ${fmtMs(fl.p95).padStart(8)} | ${String(fl.count).padStart(7)} |`);
  console.log(`| Full | ${fmtMs(ul.p50).padStart(8)} | ${fmtMs(ul.p95).padStart(8)} | ${String(ul.count).padStart(7)} |`);

  // --- Cortex Pipeline Stats ---
  const cs = report.cortexStats;
  console.log("\n### Cortex Pipeline Stats\n");
  console.log(`| Metric             | Value                |`);
  console.log(`|--------------------|----------------------|`);
  console.log(`| Pipeline Tier      | ${cs.pipelineTier !== null ? String(cs.pipelineTier) : "N/A".padStart(20)} |`);
  console.log(`| Pipeline Maturity  | ${(cs.pipelineMaturity ?? "N/A").padStart(20)} |`);
  console.log(`| Knowledge Maturity | ${(cs.knowledgeMaturity ?? "N/A").padStart(20)} |`);
  console.log(`| Total Memories     | ${cs.totalMemories !== null ? String(cs.totalMemories).padStart(20) : "N/A".padStart(20)} |`);
  console.log(`| Total Sessions     | ${cs.totalSessions !== null ? String(cs.totalSessions).padStart(20) : "N/A".padStart(20)} |`);

  // --- Summary Retention Slices ---
  console.log("\n### Summary Retention Slices\n");
  console.log("| Slice                      | No Mem | OpenClaw  | + Cortex | OC vs Bare   | Cortex vs OC   |");
  console.log("|----------------------------|--------|-----------|----------|--------------|----------------|");
  console.log(
    `| Compaction-retained prompts| ${bareRetained.padStart(6)} | ${compRetained.padStart(9)} | ${cortRetained.padStart(8)} | ${fmtDelta(bareRetained, compRetained).padStart(12)} | ${fmtDelta(compRetained, cortRetained).padStart(14)} |`,
  );
  console.log(
    `| Non-retained prompts       | ${bareNotRetained.padStart(6)} | ${compNotRetained.padStart(9)} | ${cortNotRetained.padStart(8)} | ${fmtDelta(bareNotRetained, compNotRetained).padStart(12)} | ${fmtDelta(compNotRetained, cortNotRetained).padStart(14)} |`,
  );

  // --- Per-Prompt Breakdown ---
  console.log("\n### Per-Prompt Breakdown\n");
  console.log("| ID  | Cat | Prompt (truncated)                     | Bare | OpenClaw | Cortex |");
  console.log("|-----|-----|----------------------------------------|------|----------|--------|");
  const judgmentByPromptAndCondition = new Map<string, JudgeRecord>(
    j.map((entry) => [`${entry.promptId}:${entry.condition}`, entry]),
  );
  for (const p of prompts) {
    const bareJ = judgmentByPromptAndCondition.get(`${p.id}:bare`);
    const compJ = judgmentByPromptAndCondition.get(`${p.id}:compacted`);
    const cortJ = judgmentByPromptAndCondition.get(`${p.id}:cortex`);
    const fmtScore = (rec: JudgeRecord | undefined) =>
      rec?.score !== null && rec?.score !== undefined ? String(rec.score) : "ERR";
    const truncated = p.prompt.length > 40 ? p.prompt.slice(0, 37) + "..." : p.prompt;
    console.log(
      `| ${p.id.padEnd(3)} |  ${p.category}  | ${truncated.padEnd(38)} |    ${fmtScore(bareJ)} |        ${fmtScore(compJ)} |      ${fmtScore(cortJ)} |`,
    );
  }

  // --- Config ---
  console.log(`\n------------------------------------------------------------`);
  console.log(`Model: ${report.config.llmModel} | Judge: ${report.config.judgeModel}`);
  console.log(`Namespace: ${report.config.namespace}`);
  console.log(`Git commit: ${report.config.gitCommit}`);
  console.log(`Answer concurrency: ${report.config.answerConcurrency} | Judge concurrency: ${report.config.judgeConcurrency}`);
  console.log(`Judge passes: ${report.config.judgePasses} | Shuffle seed: ${report.config.shuffleSeed} | Shuffle prompts: ${report.config.shufflePrompts}`);
  console.log(`OpenClaw simulation: compacted summary + memory_search (${report.config.ocChunkCount} chunks, top-${OC_TOP_K}, model: ${report.config.ocEmbedModel})`);
  console.log(`Debug report: ${report.config.debugReport}`);
  console.log(`Dry run: ${report.config.dryRun}`);
  console.log(`------------------------------------------------------------`);
}

// ---------------------------------------------------------------------------
// Dry-run stubs
// ---------------------------------------------------------------------------

function dryRunSeedPhase(): string[] {
  log("seed", "[DRY-RUN] Skipping seed — returning synthetic job IDs");
  return seedData.map((_, i) => `dry-run-job-${i}`);
}

function dryRunWarmupPhase(): string {
  log("warmup", "[DRY-RUN] Skipping warmup — returning synthetic summary");
  return "Project uses TypeScript with bun, vitest, port 3001, Zod validation, ioredis with 300s TTL, named exports, no auto-commit.";
}

function dryRunRetrievePhase(): {
  records: RetrievalRecord[];
  fastMetrics: LatencyMetrics;
  fullMetrics: LatencyMetrics;
  ocChunkCount: number;
} {
  log("retrieve", "[DRY-RUN] Skipping retrieval — returning synthetic results");
  const fastMetrics = new LatencyMetrics(100);
  const fullMetrics = new LatencyMetrics(100);
  const rand = mulberry32(SHUFFLE_SEED);
  const records: RetrievalRecord[] = runPrompts.map((p) => {
    fastMetrics.record(Math.round(50 + rand() * 100));
    fullMetrics.record(Math.round(200 + rand() * 300));
    const modeOrder = retrievalModeOrder(p.id);
    return {
      promptId: p.id,
      fastResults: [
        { node_id: "dry-1", type: "FACT" as const, content: `Synthetic fact for ${p.id}`, score: 0.85 },
      ],
      fullResults: [
        { node_id: "dry-1", type: "FACT" as const, content: `Synthetic fact for ${p.id}`, score: 0.92 },
        { node_id: "dry-2", type: "INSIGHT" as const, content: `Synthetic insight for ${p.id}`, score: 0.78 },
      ],
      ocResults: [
        { chunkId: `dry:0`, sessionId: "s01", content: `Synthetic OC chunk for ${p.id}`, score: 0.80 },
      ],
      fastLatencyMs: 75,
      fullLatencyMs: 350,
      modeOrder,
    };
  });
  return { records, fastMetrics, fullMetrics, ocChunkCount: 0 };
}

function dryRunAnswerPhase(): AnswerRecord[] {
  log("answer", "[DRY-RUN] Skipping LLM answers — returning synthetic responses");
  const answers: AnswerRecord[] = [];
  for (const p of runPrompts) {
    answers.push({ promptId: p.id, condition: "bare", answer: "I don't have specific project context to answer this." });
    answers.push({ promptId: p.id, condition: "compacted", answer: `Based on the project summary and memory search: ${p.groundTruth.slice(0, 50)}...` });
    answers.push({ promptId: p.id, condition: "cortex", answer: p.groundTruth });
  }
  return answers;
}

function dryRunJudgePhase(answers: AnswerRecord[]): JudgeRecord[] {
  log("judge", "[DRY-RUN] Skipping LLM judging — returning synthetic scores");
  return answers.map((a) => ({
    promptId: a.promptId,
    condition: a.condition,
    score: a.condition === "bare" ? 1 : a.condition === "compacted" ? 2 : 3,
    rationale: `[DRY-RUN] Synthetic score for ${a.condition} condition`,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== Cortex V1 Benchmark ===`);
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}${SEED ? " +SEED" : ""}`);
  console.log(`Namespace: ${NAMESPACE}`);
  console.log(`Git commit: ${GIT_COMMIT}`);
  console.log(`Report mode: ${DEBUG_REPORT ? "debug" : "trimmed"}`);
  console.log(
    `Answer concurrency: ${ANSWER_CONCURRENCY} | Judge concurrency: ${JUDGE_CONCURRENCY} | Judge passes: ${JUDGE_PASSES}`,
  );
  console.log(
    `Shuffle prompts: ${SHUFFLE_PROMPTS} | Shuffle seed: ${SHUFFLE_SEED}`,
  );

  if (!DRY_RUN) {
    if (!CORTEX_API_KEY) throw new Error("CORTEX_API_KEY is required");
    if (!LLM_API_KEY) throw new Error("LLM_API_KEY is required");
    console.log(`LLM: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
    console.log(`Judge: ${JUDGE_MODEL} @ ${JUDGE_BASE_URL}`);
    console.log(`OC embed: ${OC_EMBED_MODEL} @ ${OC_EMBED_BASE_URL}`);
    if (JUDGE_MODEL === LLM_MODEL && JUDGE_BASE_URL === LLM_BASE_URL) {
      log(
        "config",
        "WARN judge and answer model are identical; set JUDGE_MODEL/JUDGE_BASE_URL to reduce evaluator bias.",
      );
    }
  }

  console.log(`Sessions: ${seedData.length}, Prompts: ${runPrompts.length}\n`);

  const client = DRY_RUN
    ? (null as unknown as CortexClient)
    : new CortexClient(CORTEX_BASE_URL, CORTEX_API_KEY);

  // Phase 1: Seed (only with --seed flag to avoid re-ingesting)
  let seedJobIds: string[];
  if (DRY_RUN) {
    seedJobIds = dryRunSeedPhase();
  } else if (SEED) {
    seedJobIds = await runSeedPhase(client);
  } else {
    log("seed", "Skipping seed phase (data already ingested). Use --seed to re-ingest.");
    seedJobIds = [];
  }

  // Phase 2: Warmup + Reflect + Compaction + Stats
  const didSeed = SEED && !DRY_RUN;
  const nullStats: CortexStatsSnapshot = { pipelineTier: null, pipelineMaturity: null, knowledgeMaturity: null, totalMemories: null, totalSessions: null };
  const { compactedSummary, cortexStats } = DRY_RUN
    ? { compactedSummary: dryRunWarmupPhase(), cortexStats: nullStats }
    : await runWarmupPhase(client, didSeed);

  // Phase 3: Retrieve — Cortex (fast + full) + OpenClaw memory_search simulation
  const { records: retrievals, fastMetrics, fullMetrics, ocChunkCount } = DRY_RUN
    ? dryRunRetrievePhase()
    : await runRetrievePhase(client);

  // Phase 4: Answer
  const answers = DRY_RUN
    ? dryRunAnswerPhase()
    : await runAnswerPhase(compactedSummary, retrievals);

  // Phase 5: Judge
  const judgments = DRY_RUN
    ? dryRunJudgePhase(answers)
    : await runJudgePhase(answers);

  // Phase 6: Report
  const report = buildReport(
    cortexStats,
    seedJobIds,
    compactedSummary,
    retrievals,
    answers,
    judgments,
    fastMetrics,
    fullMetrics,
    ocChunkCount,
  );

  const filepath = writeReport(report);
  log("report", `Results written to: ${filepath}`);

  printMarkdownSummary(report);
}

main().catch((err) => {
  console.error("\nBenchmark failed:", err);
  process.exit(1);
});
