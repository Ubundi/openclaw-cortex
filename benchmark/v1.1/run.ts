#!/usr/bin/env npx tsx
/**
 * V1.1 Benchmark Runner — OpenClaw native vs OpenClaw + Cortex
 *
 * Compares two memory retrieval approaches over a realistic 45-session,
 * 6-week developer project history (the "Arclight" project):
 *
 *   1. OpenClaw native — compacted summary of all sessions (simulating
 *      OpenClaw's /compact) + recent session notes injected directly (simulating
 *      today/yesterday daily log injection) + memory_search results from an
 *      index of LLM-extracted memory notes (not raw transcripts). Hybrid
 *      retrieval: 70% cosine + 30% BM25-normalized, top-6, with temporal
 *      decay (30-day half-life) and MMR re-ranking (λ=0.7).
 *
 *   2. OpenClaw + Cortex — same compacted summary + recent notes as foundation,
 *      combined with Cortex retrieved memories (entity extraction, graph edges,
 *      semantic + structural reranking).
 *
 * Fidelity notes vs real OpenClaw:
 *   - Memory notes are LLM-extracted from transcripts (simulates pre-compaction
 *     flush + daily log writing). Real OpenClaw indexes MEMORY.md + daily logs.
 *   - Temporal decay applied: 30-day half-life, age computed from session day.
 *   - MMR re-ranking: λ=0.7, 4×topK candidates considered before selection.
 *   - Recent session injection: last 2 sessions' notes go directly into context
 *     (simulates today/yesterday daily log always-injection).
 *
 * Usage:
 *   npx tsx benchmark/v1.1/run.ts --seed                       # first run: seed Cortex + evaluate
 *   npx tsx benchmark/v1.1/run.ts                              # subsequent runs: evaluate only
 *   npx tsx benchmark/v1.1/run.ts --extract-notes              # force re-extract memory notes
 *   npx tsx benchmark/v1.1/run.ts --dry-run                    # no API calls, synthetic results
 *   npx tsx benchmark/v1.1/run.ts --namespace-suffix trial-a   # isolate namespace per trial
 *   npx tsx benchmark/v1.1/run.ts --shuffle-prompts --shuffle-seed 42
 *   npx tsx benchmark/v1.1/run.ts --answer-concurrency 4 --judge-concurrency 4
 *   npx tsx benchmark/v1.1/run.ts --extract-concurrency 6
 *   npx tsx benchmark/v1.1/run.ts --judge-passes 3
 *   npx tsx benchmark/v1.1/run.ts --cortex-top-k 10
 *   npx tsx benchmark/v1.1/run.ts --debug-report
 *
 * Memory notes are cached to oc-memory-notes.json after first extraction.
 * Use --extract-notes to force re-extraction if seed-data.json changes.
 * Namespace defaults to "benchmark-v1.1". Only use --seed on the first run.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CortexClient } from "../../src/cortex/client.js";
import type { RetrieveResult } from "../../src/cortex/client.js";
import { LatencyMetrics } from "../../src/shared/metrics/latency-metrics.js";
// Note: the plugin's formatMemories expects RecallMemory[] (agent API),
// but the benchmark uses RetrieveResult[] (internal API). Format inline instead.

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
  category: string; // F, R, E, S, T
  prompt: string;
  groundTruth: string;
  sourceSession: string;
}

// LLM-extracted memory note for a session (cached to oc-memory-notes.json)
interface OcMemoryNote {
  sessionId: string;
  dayNumber: number; // parsed from session description, used for temporal decay
  notes: string;    // what the agent "wrote to disk" during this session
}

// A chunked segment of extracted memory notes
interface Chunk {
  id: string;
  sessionId: string;
  dayNumber: number; // for temporal decay
  content: string;
  embedding?: number[];
}

interface OcMemoryIndex {
  chunks: Chunk[];
  bm25: BM25Index;
  maxDayNumber: number;
}

interface OcSearchResult {
  chunkId: string;
  sessionId: string;
  content: string;
  score: number; // post-decay, post-MMR score
}

interface RetrievalRecord {
  promptId: string;
  ocResults: OcSearchResult[];
  cortexResults: RetrieveResult[];
  cortexLatencyMs: number;
}

interface AnswerRecord {
  promptId: string;
  condition: "compacted" | "cortex";
  answer: string | null;
  error?: string;
}

interface JudgeRecord {
  promptId: string;
  condition: "compacted" | "cortex";
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
    extractConcurrency: number;
    shuffleSeed: number;
    shufflePrompts: boolean;
    gitCommit: string;
    promptOrder: string[];
    ocEmbedModel: string;
    ocChunkCount: number;
    ocTopK: number;
    ocMmrLambda: number;
    ocDecayHalfLifeDays: number;
    ocNotesExtracted: boolean;
    cortexTopK: number;
  };
  seedJobIds: string[];
  compactedSummary: string;
  recentNotes: string;
  retrievals: RetrievalRecord[];
  answers: AnswerRecord[];
  judgments: JudgeRecord[];
  latency: {
    cortex: { count: number; p50: number | null; p95: number | null; p99: number | null };
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
const FORCE_EXTRACT = hasFlag("--extract-notes");
const SHUFFLE_PROMPTS = hasFlag("--shuffle-prompts");
const SHUFFLE_SEED = parseInteger(getArgValue("--shuffle-seed"), 1337);
const ANSWER_CONCURRENCY = parsePositiveInteger(getArgValue("--answer-concurrency"), 4);
const JUDGE_CONCURRENCY = parsePositiveInteger(getArgValue("--judge-concurrency"), 4);
const JUDGE_PASSES = parsePositiveInteger(getArgValue("--judge-passes"), 1);
const EXTRACT_CONCURRENCY = parsePositiveInteger(getArgValue("--extract-concurrency"), 4);
const CORTEX_TOP_K = parsePositiveInteger(getArgValue("--cortex-top-k"), 8);

// OpenClaw memory_search constants — fixed to match documented architecture
const OC_TOP_K = 6;                    // OpenClaw default maxResults
const OC_MMR_LAMBDA = 0.7;            // λ in MMR: higher = more relevance weight vs diversity
const OC_DECAY_HALF_LIFE_DAYS = 30;   // temporal decay half-life
const OC_MMR_CANDIDATES = 4;          // multiplier: topK * OC_MMR_CANDIDATES candidates fed into MMR

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

const OC_EMBED_API_KEY = process.env.OC_EMBED_API_KEY || LLM_API_KEY;
const OC_EMBED_BASE_URL = process.env.OC_EMBED_BASE_URL || LLM_BASE_URL;
const OC_EMBED_MODEL = process.env.OC_EMBED_MODEL || "text-embedding-3-small";

const NAMESPACE_BASE = process.env.BENCHMARK_NAMESPACE ?? "benchmark-v1.1";
const NAMESPACE_SUFFIX = normalizeNamespaceSuffix(
  getArgValue("--namespace-suffix") ?? process.env.BENCHMARK_NAMESPACE_SUFFIX ?? "",
);
const NAMESPACE = NAMESPACE_SUFFIX ? `${NAMESPACE_BASE}-${NAMESPACE_SUFFIX}` : NAMESPACE_BASE;
const GIT_COMMIT = getGitCommit();

const OC_NOTES_CACHE_PATH = join(__dirname, "oc-memory-notes.json");

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

// Parses "Week N, Day N — ..." → day number (1-indexed).
function parseDayNumber(description: string): number {
  const match = description.match(/Day (\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 1;
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

async function callLLM(
  messages: { role: string; content: string }[],
  opts: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    maxTokens?: number;
    temperature?: number;
  },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
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
    if (content === undefined || content === null) throw new Error(`LLM returned no content`);
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
  if (!jsonMatch) throw new Error(`Judge returned non-JSON: ${cleaned.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; rationale?: unknown };
  if (typeof parsed.score !== "number") throw new Error(`Judge score missing: ${jsonMatch[0].slice(0, 120)}`);
  const normalizedScore = Math.max(0, Math.min(3, Math.round(parsed.score)));
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided";
  return { score: normalizedScore, rationale };
}

function aggregatePassScores(scores: number[]): number {
  const counts = new Map<number, number>();
  for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
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

// ---------------------------------------------------------------------------
// Phase 0: Memory Note Extraction
//
// Simulates OpenClaw's pre-compaction memory flush + daily log writing.
// For each session, an LLM extracts what the agent "would have written"
// to its memory files. These notes are what memory_search indexes —
// matching real OpenClaw where memory_search hits MEMORY.md / daily logs,
// not raw session transcripts.
//
// Results are cached to oc-memory-notes.json. Use --extract-notes to force
// re-extraction when seed-data.json changes.
// ---------------------------------------------------------------------------

async function extractMemoryNotes(): Promise<OcMemoryNote[]> {
  log("extract", `Extracting memory notes from ${seedData.length} sessions (concurrency=${EXTRACT_CONCURRENCY})...`);

  const extractSystemPrompt =
    "You are an AI agent writing to your daily memory log. Given a conversation transcript, extract the key facts, decisions, values, file paths, package names, configuration values, and technical choices that emerged. Write concise, specific notes as you would append to a daily log file. Focus on what should be remembered long-term — avoid restating conversation flow. Output plain text only.";

  const notes = await mapWithConcurrency(seedData, EXTRACT_CONCURRENCY, async (session, i) => {
    log("extract", `  [${i + 1}/${seedData.length}] ${session.id}: ${session.description.slice(0, 50)}`);
    const transcript = session.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const extracted = await callLLM(
      [
        { role: "system", content: extractSystemPrompt },
        { role: "user", content: `Session: ${session.description}\n\n${transcript}` },
      ],
      { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL, maxTokens: 512 },
    );
    return {
      sessionId: session.id,
      dayNumber: parseDayNumber(session.description),
      notes: extracted.trim(),
    } satisfies OcMemoryNote;
  });

  log("extract", `Extracted ${notes.length} memory notes. Saving to cache...`);
  writeFileSync(OC_NOTES_CACHE_PATH, JSON.stringify(notes, null, 2));
  return notes;
}

async function loadOrExtractMemoryNotes(): Promise<{ notes: OcMemoryNote[]; fromCache: boolean }> {
  if (!FORCE_EXTRACT && existsSync(OC_NOTES_CACHE_PATH)) {
    log("extract", `Loading memory notes from cache: ${OC_NOTES_CACHE_PATH}`);
    const notes = JSON.parse(readFileSync(OC_NOTES_CACHE_PATH, "utf-8")) as OcMemoryNote[];
    log("extract", `Loaded ${notes.length} cached memory notes.`);
    return { notes, fromCache: true };
  }
  const notes = await extractMemoryNotes();
  return { notes, fromCache: false };
}

// ---------------------------------------------------------------------------
// OpenClaw memory_search Simulation
//
// Implements OpenClaw's documented retrieval architecture:
//   - 400-token sliding window chunks with 80-token overlap
//   - Embedding: text-embedding-3-small (or configured OC_EMBED_MODEL)
//   - Fusion: 0.70 × cosine + 0.30 × BM25-normalized
//   - Temporal decay: score × exp(-λ × ageInDays), 30-day half-life
//   - MMR re-ranking: λ=0.7, 4×topK candidates
//   - Top-6 results (OpenClaw's default maxResults)
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

// Splits extracted memory notes into overlapping chunks.
function chunkNote(note: OcMemoryNote): Chunk[] {
  const TARGET_CHARS = 400 * 4; // ~400 tokens
  const OVERLAP_CHARS = 80 * 4; // ~80 tokens
  const STRIDE = TARGET_CHARS - OVERLAP_CHARS;

  const chunks: Chunk[] = [];
  let start = 0;
  let idx = 0;

  while (start < note.notes.length) {
    const end = Math.min(start + TARGET_CHARS, note.notes.length);
    const content = note.notes.slice(start, end).trim();
    if (content.length > 20) {
      chunks.push({ id: `${note.sessionId}:${idx}`, sessionId: note.sessionId, dayNumber: note.dayNumber, content });
      idx++;
    }
    if (end >= note.notes.length) break;
    start += STRIDE;
  }
  return chunks;
}

async function embedBatch(
  texts: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embeddings API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
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

// Applies exponential temporal decay: score × exp(-λ × ageInDays)
function applyTemporalDecay(score: number, dayNumber: number, maxDayNumber: number): number {
  const ageInDays = maxDayNumber - dayNumber;
  const lambda = Math.LN2 / OC_DECAY_HALF_LIFE_DAYS;
  return score * Math.exp(-lambda * ageInDays);
}

// MMR re-ranking: selects diverse top-K from candidates.
// Maximises: λ × relevance(d) - (1-λ) × max_cosine(d, already_selected)
function mmrRerank(
  candidates: Array<{ decayedScore: number; chunk: Chunk }>,
  topK: number,
): OcSearchResult[] {
  const selected: Array<{ decayedScore: number; chunk: Chunk }> = [];
  const remaining = [...candidates];

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMMRScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].decayedScore;
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((s) =>
                cosineSimilarity(remaining[i].chunk.embedding!, s.chunk.embedding!),
              ),
            );
      const mmrScore = OC_MMR_LAMBDA * relevance - (1 - OC_MMR_LAMBDA) * maxSim;
      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected.map(({ decayedScore, chunk }) => ({
    chunkId: chunk.id,
    sessionId: chunk.sessionId,
    content: chunk.content,
    score: decayedScore,
  }));
}

// Builds the OC memory index from extracted notes (not raw transcripts).
async function buildOcMemoryIndex(notes: OcMemoryNote[]): Promise<OcMemoryIndex> {
  const chunks: Chunk[] = [];
  for (const note of notes) chunks.push(...chunkNote(note));

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

  const maxDayNumber = Math.max(...notes.map((n) => n.dayNumber));
  return { chunks, bm25: new BM25Index(chunks.map((c) => c.content)), maxDayNumber };
}

// Full OC memory_search: hybrid fusion → temporal decay → MMR → top-K.
function searchOcMemory(
  queryEmbedding: number[],
  query: string,
  index: OcMemoryIndex,
  topK = OC_TOP_K,
): OcSearchResult[] {
  const bm25Ranks = index.bm25.rankAll(query);
  const bm25RankMap = new Map(bm25Ranks.map((r, rankIdx) => [r.idx, rankIdx]));

  // Step 1: hybrid fusion (70% cosine + 30% BM25-normalized)
  const scored = index.chunks.map((chunk, idx) => {
    const vecScore = chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
    const bm25Norm = 1 / (1 + (bm25RankMap.get(idx) ?? index.chunks.length));
    const rawScore = 0.7 * vecScore + 0.3 * bm25Norm;

    // Step 2: temporal decay
    const decayedScore = applyTemporalDecay(rawScore, chunk.dayNumber, index.maxDayNumber);
    return { decayedScore, chunk };
  });

  // Step 3: take top candidates for MMR (4× topK)
  const candidates = scored
    .sort((a, b) => b.decayedScore - a.decayedScore)
    .slice(0, Math.min(topK * OC_MMR_CANDIDATES, scored.length));

  // Step 4: MMR re-ranking
  return mmrRerank(candidates, topK);
}

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
        const resp = await client.submitIngestConversation(session.messages, sessionId);
        jobId = resp.job_id;
        log("seed", `  ${session.id}: job ${jobId} (attempt ${attempt})`);
        break;
      } catch (err) {
        log("seed", `  ${session.id}: attempt ${attempt} failed: ${(err as Error).message}`);
        if (attempt < 3) await sleep(5_000 * attempt);
      }
    }
    if (!jobId) throw new Error(`seed: all attempts failed for ${session.id}`);
    jobIds.push(jobId);
  }

  log("seed", `All ${jobIds.length} jobs submitted. Polling...`);

  const deadline = Date.now() + 180_000;
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
        log("seed", `  Job ${result.id}: poll error: ${(result.error as Error).message}`);
        continue;
      }
      if (result.status.status === "completed") {
        pending.delete(result.id);
        log("seed", `  Job ${result.id}: completed`);
      } else if (result.status.status === "failed") {
        throw new Error(`seed: job ${result.id} failed: ${result.status.error ?? "unknown"}`);
      }
    }
    if (pending.size > 0) await sleep(2_000);
  }

  if (pending.size > 0) throw new Error(`seed: ${pending.size} jobs timed out after 180s`);
  log("seed", "All jobs completed.");
  return jobIds;
}

// ---------------------------------------------------------------------------
// Phase 2: Warmup + Reflect + Compaction
// ---------------------------------------------------------------------------

async function runWarmupPhase(client: CortexClient, didSeed: boolean): Promise<string> {
  log("warmup", "Warming up tenant...");
  await client.warmup();

  if (didSeed) {
    log("warmup", "Running reflect to consolidate entities across sessions...");
    const result = await client.reflect(NAMESPACE);
    log(
      "warmup",
      `Reflect done: ${result.nodes_created} nodes, ${result.edges_created} edges, ${result.entities_processed} entities processed`,
    );
  }

  log("warmup", "Generating compacted summary from all session transcripts...");
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
  return compactedSummary;
}

// ---------------------------------------------------------------------------
// Phase 3: Build Index + Retrieve
// ---------------------------------------------------------------------------

async function runRetrievePhase(
  client: CortexClient,
  ocNotes: OcMemoryNote[],
): Promise<{
  records: RetrievalRecord[];
  cortexMetrics: LatencyMetrics;
  chunkCount: number;
}> {
  log("retrieve", `Building OpenClaw memory index from ${ocNotes.length} extracted note sets...`);
  const ocIndex = await buildOcMemoryIndex(ocNotes);
  log("retrieve", `OC index ready: ${ocIndex.chunks.length} chunks, max day: ${ocIndex.maxDayNumber}`);

  log("retrieve", `Embedding ${runPrompts.length} prompts for OpenClaw memory search...`);
  const promptEmbeddings = await embedBatch(
    runPrompts.map((p) => p.prompt),
    OC_EMBED_API_KEY,
    OC_EMBED_BASE_URL,
    OC_EMBED_MODEL,
  );

  log("retrieve", `Running retrieval for ${runPrompts.length} prompts...`);
  const cortexMetrics = new LatencyMetrics(100);
  const records: RetrievalRecord[] = [];

  for (let i = 0; i < runPrompts.length; i++) {
    const p = runPrompts[i];
    log("retrieve", `  [${i + 1}/${runPrompts.length}] ${p.id} (${p.category}): ${p.prompt.slice(0, 60)}`);

    // OpenClaw memory_search: hybrid fusion + temporal decay + MMR
    const ocResults = searchOcMemory(promptEmbeddings[i], p.prompt, ocIndex);

    // Cortex: full retrieval pipeline
    let cortexResults: RetrieveResult[] = [];
    let cortexLatencyMs = 0;
    try {
      const start = Date.now();
      const response = await client.retrieve(p.prompt, CORTEX_TOP_K, "full", 30_000);
      cortexLatencyMs = Date.now() - start;
      cortexMetrics.record(cortexLatencyMs);
      cortexResults = response.results;
    } catch (err) {
      log("retrieve", `    WARN cortex retrieval failed: ${(err as Error).message}`);
    }

    records.push({ promptId: p.id, ocResults, cortexResults, cortexLatencyMs });
  }

  log("retrieve", `Done. Cortex p50=${cortexMetrics.p50}ms p95=${cortexMetrics.p95}ms`);
  return { records, cortexMetrics, chunkCount: ocIndex.chunks.length };
}

// ---------------------------------------------------------------------------
// Phase 4: Answer
// ---------------------------------------------------------------------------

async function runAnswerPhase(
  compactedSummary: string,
  recentNotes: string,
  retrievals: RetrievalRecord[],
): Promise<AnswerRecord[]> {
  log(
    "answer",
    `Generating answers (${runPrompts.length} prompts × 2 conditions, concurrency=${ANSWER_CONCURRENCY})...`,
  );
  const retrievalByPromptId = new Map(retrievals.map((r) => [r.promptId, r]));

  const systemMsg =
    "You are a coding assistant with access to project history for the Arclight developer analytics platform. Answer based only on what the project history tells you. If the information is not in the provided context, say so explicitly.";

  // Both conditions share this foundation: compacted summary + recent session notes.
  // This mirrors real OpenClaw where the compacted session and daily logs are
  // always injected regardless of which retrieval path is used.
  const sharedFoundation =
    recentNotes.length > 0
      ? `Here is a project memory summary:\n\n${compactedSummary}\n\nRecent session notes (last 2 days, always injected):\n\n${recentNotes}`
      : `Here is a project memory summary:\n\n${compactedSummary}`;

  const batches = await mapWithConcurrency(runPrompts, ANSWER_CONCURRENCY, async (p, idx) => {
    log("answer", `  [${idx + 1}/${runPrompts.length}] ${p.id}`);
    const results: AnswerRecord[] = [];
    const retrieval = retrievalByPromptId.get(p.id);

    // Condition 1: OpenClaw native
    // Foundation (compacted + recent injection) + memory_search results
    try {
      const ocContext =
        retrieval && retrieval.ocResults.length > 0
          ? `\n\nMemory search results (hybrid BM25+vector, temporally decayed, MMR-ranked):\n\n${formatOcSearchResults(retrieval.ocResults)}`
          : "";

      const compactedAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          { role: "user", content: `${sharedFoundation}${ocContext}\n\nQuestion: ${p.prompt}` },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      results.push({ promptId: p.id, condition: "compacted", answer: compactedAnswer });
    } catch (err) {
      results.push({ promptId: p.id, condition: "compacted", answer: null, error: (err as Error).message });
    }

    // Condition 2: OpenClaw + Cortex
    // Same foundation + Cortex retrieved memories replacing memory_search
    try {
      const cortexResults = retrieval?.cortexResults ?? [];
      const memories = cortexResults.length > 0
        ? cortexResults.map((r) => `- [${(r.score ?? 0).toFixed(2)}] ${r.content}`).join("\n")
        : "";
      const cortexAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          {
            role: "user",
            content: `${sharedFoundation}\n\nAdditionally, here are relevant memories retrieved from Cortex:\n\n${memories}\n\nQuestion: ${p.prompt}`,
          },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      results.push({ promptId: p.id, condition: "cortex", answer: cortexAnswer });
    } catch (err) {
      results.push({ promptId: p.id, condition: "cortex", answer: null, error: (err as Error).message });
    }

    return results;
  });

  const answers = batches.flat();
  log("answer", `Generated ${answers.length} answers (${answers.filter((a) => a.error).length} errors).`);
  return answers;
}

// ---------------------------------------------------------------------------
// Phase 5: Judge
// ---------------------------------------------------------------------------

async function runJudgePhase(answers: AnswerRecord[]): Promise<JudgeRecord[]> {
  log("judge", `Judging ${answers.length} answers (concurrency=${JUDGE_CONCURRENCY}, passes=${JUDGE_PASSES})...`);

  const judgeSystemPrompt = `You are an evaluation judge. Given a question, expected ground truth answer, and an AI's response, score the response:

3 = Grounded correct — contains the specific project detail from the ground truth
2 = Generic correct — gives a reasonable answer but lacks the specific detail
1 = Abstained — says it doesn't have the context or gives a non-answer
0 = Hallucinated — fabricated specific but wrong details

Respond with ONLY a JSON object: {"score": <0-3>, "rationale": "<brief explanation>"}`;

  const judgments = await mapWithConcurrency(answers, JUDGE_CONCURRENCY, async (a, i) => {
    const prompt = promptsById.get(a.promptId);
    if (!prompt) {
      return { promptId: a.promptId, condition: a.condition, score: null, rationale: null, error: `Prompt not found` } satisfies JudgeRecord;
    }
    if (a.answer === null) {
      return { promptId: a.promptId, condition: a.condition, score: null, rationale: `Skipped: ${a.error}` } satisfies JudgeRecord;
    }

    if ((i + 1) % 10 === 0) log("judge", `  [${i + 1}/${answers.length}]`);

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
      return { promptId: a.promptId, condition: a.condition, score: null, rationale: null, error: (err as Error).message } satisfies JudgeRecord;
    }
  });

  log("judge", `Judged ${judgments.length} (${judgments.filter((j) => j.score === null).length} failures).`);
  return judgments;
}

// ---------------------------------------------------------------------------
// Phase 6: Report
// ---------------------------------------------------------------------------

function buildReport(
  seedJobIds: string[],
  compactedSummary: string,
  recentNotes: string,
  retrievals: RetrievalRecord[],
  answers: AnswerRecord[],
  judgments: JudgeRecord[],
  cortexMetrics: LatencyMetrics,
  chunkCount: number,
  notesFromCache: boolean,
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
      extractConcurrency: EXTRACT_CONCURRENCY,
      shuffleSeed: SHUFFLE_SEED,
      shufflePrompts: SHUFFLE_PROMPTS,
      gitCommit: GIT_COMMIT,
      promptOrder: runPromptOrder,
      ocEmbedModel: OC_EMBED_MODEL,
      ocChunkCount: chunkCount,
      ocTopK: OC_TOP_K,
      ocMmrLambda: OC_MMR_LAMBDA,
      ocDecayHalfLifeDays: OC_DECAY_HALF_LIFE_DAYS,
      ocNotesExtracted: !notesFromCache,
      cortexTopK: CORTEX_TOP_K,
    },
    seedJobIds,
    compactedSummary,
    recentNotes,
    retrievals: DEBUG_REPORT
      ? retrievals
      : retrievals.map((r) => ({
          promptId: r.promptId,
          ocResults: r.ocResults.map((x) => ({ ...x, content: x.content.slice(0, 200) })),
          cortexResults: r.cortexResults.map((x) => ({
            node_id: x.node_id,
            type: x.type,
            content: x.content,
            score: x.score,
            source: x.source,
            confidence: x.confidence,
          })),
          cortexLatencyMs: r.cortexLatencyMs,
        })),
    answers,
    judgments,
    latency: { cortex: cortexMetrics.summary() },
  };
}

function writeReport(report: BenchmarkReport): string {
  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const filepath = join(resultsDir, `run-${ts}.json`);
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

type Condition = "compacted" | "cortex";

function meanScore(judgments: JudgeRecord[], condition: Condition, category?: string): string {
  const filtered = judgments.filter((j) => {
    if (j.condition !== condition || j.score === null) return false;
    if (category !== undefined) {
      const p = promptsById.get(j.promptId);
      if (!p || p.category !== category) return false;
    }
    return true;
  });
  if (filtered.length === 0) return "N/A";
  const avg = filtered.reduce((sum, j) => sum + j.score!, 0) / filtered.length;
  return avg.toFixed(2);
}

function scoreDist(
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
  return `${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
}

function printSummary(report: BenchmarkReport): void {
  const j = report.judgments;
  const cl = report.latency.cortex;

  const categories = [
    { key: "F", label: "F: Factual (15)" },
    { key: "R", label: "R: Rationale (10)" },
    { key: "E", label: "E: Evolution (10)" },
    { key: "S", label: "S: Synthesis (8)" },
    { key: "T", label: "T: Temporal (7)" },
  ];

  const compAll = meanScore(j, "compacted");
  const cortAll = meanScore(j, "cortex");

  console.log("\n============================================================");
  console.log("               BENCHMARK V1.1 RESULTS");
  console.log("        OpenClaw Native  vs  OpenClaw + Cortex");
  console.log("============================================================\n");

  console.log("### Scores by Category (0-3 scale)\n");
  console.log("| Category                       | OpenClaw | + Cortex | Delta  |");
  console.log("|--------------------------------|----------|----------|--------|");
  console.log(
    `| **Overall Mean**               | ${compAll.padStart(8)} | ${cortAll.padStart(8)} | ${fmtDelta(compAll, cortAll).padStart(6)} |`,
  );
  for (const cat of categories) {
    const c = meanScore(j, "compacted", cat.key);
    const x = meanScore(j, "cortex", cat.key);
    console.log(
      `| ${cat.label.padEnd(30)} | ${c.padStart(8)} | ${x.padStart(8)} | ${fmtDelta(c, x).padStart(6)} |`,
    );
  }

  console.log("\n### Score Distribution\n");
  console.log("| Score | Meaning              | OpenClaw | + Cortex |");
  console.log("|-------|----------------------|----------|----------|");
  const compDist = scoreDist(j, "compacted");
  const cortDist = scoreDist(j, "cortex");
  for (const { score, meaning } of [
    { score: "3", meaning: "Grounded correct" },
    { score: "2", meaning: "Generic correct" },
    { score: "1", meaning: "Abstained" },
    { score: "0", meaning: "Hallucinated" },
  ]) {
    const cv = compDist[score as keyof typeof compDist];
    const xv = cortDist[score as keyof typeof cortDist];
    console.log(`|     ${score} | ${meaning.padEnd(20)} | ${String(cv).padStart(8)} | ${String(xv).padStart(8)} |`);
  }
  if (compDist.errors + cortDist.errors > 0) {
    console.log(`|     - | Errors               | ${String(compDist.errors).padStart(8)} | ${String(cortDist.errors).padStart(8)} |`);
  }

  console.log("\n### Cortex Retrieval Latency\n");
  const fmtMs = (v: number | null) => (v !== null ? `${v}ms` : "N/A");
  console.log(`| p50      | p95      | p99      | Samples |`);
  console.log(`|----------|----------|----------|---------|`);
  console.log(`| ${fmtMs(cl.p50).padStart(8)} | ${fmtMs(cl.p95).padStart(8)} | ${fmtMs(cl.p99).padStart(8)} | ${String(cl.count).padStart(7)} |`);

  console.log("\n### Per-Prompt Breakdown\n");
  console.log("| ID  | Cat | Prompt (truncated)                     | OpenClaw | Cortex |");
  console.log("|-----|-----|----------------------------------------|----------|--------|");
  const judgmentMap = new Map<string, JudgeRecord>(
    j.map((entry) => [`${entry.promptId}:${entry.condition}`, entry]),
  );
  for (const p of prompts) {
    const compJ = judgmentMap.get(`${p.id}:compacted`);
    const cortJ = judgmentMap.get(`${p.id}:cortex`);
    const fmt = (rec: JudgeRecord | undefined) =>
      rec?.score !== null && rec?.score !== undefined ? String(rec.score) : "ERR";
    const truncated = p.prompt.length > 40 ? p.prompt.slice(0, 37) + "..." : p.prompt;
    console.log(`| ${p.id.padEnd(3)} |  ${p.category}  | ${truncated.padEnd(38)} |        ${fmt(compJ)} |      ${fmt(cortJ)} |`);
  }

  console.log(`\n------------------------------------------------------------`);
  console.log(`Sessions: ${seedData.length}  |  Prompts: ${prompts.length}`);
  console.log(`OC: compaction + recent-injection + memory_search`);
  console.log(`    top-${report.config.ocTopK}, 70% vec+30% BM25, decay λ=ln2/${report.config.ocDecayHalfLifeDays}d, MMR λ=${report.config.ocMmrLambda}`);
  console.log(`    chunks: ${report.config.ocChunkCount} | embed: ${report.config.ocEmbedModel}`);
  console.log(`    notes: ${report.config.ocNotesExtracted ? "freshly extracted" : "loaded from cache"}`);
  console.log(`Cortex: full retrieval pipeline (top-${report.config.cortexTopK})`);
  console.log(`Model: ${report.config.llmModel} | Judge: ${report.config.judgeModel}`);
  console.log(`Namespace: ${report.config.namespace} | Git: ${report.config.gitCommit}`);
  console.log(`Concurrency: answer=${report.config.answerConcurrency} judge=${report.config.judgeConcurrency} extract=${report.config.extractConcurrency}`);
  console.log(`Judge passes: ${report.config.judgePasses} | Shuffle: ${report.config.shufflePrompts} (seed ${report.config.shuffleSeed})`);
  console.log(`------------------------------------------------------------`);
}

// ---------------------------------------------------------------------------
// Dry-run stubs
// ---------------------------------------------------------------------------

function dryRunExtractPhase(): OcMemoryNote[] {
  log("extract", "[DRY-RUN] Skipping extraction — returning synthetic notes");
  return seedData.map((s) => ({
    sessionId: s.id,
    dayNumber: parseDayNumber(s.description),
    notes: `[DRY-RUN] Synthetic memory notes for session ${s.id}: ${s.description}`,
  }));
}

function dryRunSeedPhase(): string[] {
  log("seed", "[DRY-RUN] Skipping seed");
  return seedData.map((_, i) => `dry-run-job-${i}`);
}

function dryRunWarmupPhase(): string {
  log("warmup", "[DRY-RUN] Skipping warmup — returning synthetic summary");
  return "Project uses bun + Fastify (port 4000, ES2022). DB: Drizzle + Neon PostgreSQL, UUID PKs, snake_case tables. Auth: iron-session (7d, arclight_session cookie) — migrated from JWT week 4. Email: SendGrid (SENDGRID_API_KEY) — switched from Resend week 4. Cache: ioredis (src/lib/redis.ts), key format arclight:{entity}:{id}, TTL 600s. Jobs: BullMQ on Redis. Tests: vitest, 80% coverage target. CI: GitHub Actions. Logging: Pino, LOG_LEVEL env, default info.";
}

function dryRunRetrievePhase(): {
  records: RetrievalRecord[];
  cortexMetrics: LatencyMetrics;
  chunkCount: number;
} {
  log("retrieve", "[DRY-RUN] Returning synthetic results");
  const cortexMetrics = new LatencyMetrics(100);
  const rand = mulberry32(SHUFFLE_SEED);
  const records: RetrievalRecord[] = runPrompts.map((p) => {
    cortexMetrics.record(Math.round(200 + rand() * 300));
    return {
      promptId: p.id,
      ocResults: [
        { chunkId: "dry:0", sessionId: "s01", content: `Synthetic OC note chunk for ${p.id}`, score: 0.81 },
      ],
      cortexResults: [
        { node_id: "dry-1", type: "FACT" as const, content: `Synthetic fact for ${p.id}`, score: 0.91 },
      ],
      cortexLatencyMs: 250,
    };
  });
  return { records, cortexMetrics, chunkCount: seedData.length * 2 };
}

function dryRunAnswerPhase(compactedSummary: string): AnswerRecord[] {
  log("answer", "[DRY-RUN] Returning synthetic answers");
  const answers: AnswerRecord[] = [];
  for (const p of runPrompts) {
    answers.push({
      promptId: p.id,
      condition: "compacted",
      answer: `Based on the project summary and memory search: ${p.groundTruth.slice(0, 60)}... (simplified)`,
    });
    answers.push({ promptId: p.id, condition: "cortex", answer: p.groundTruth });
  }
  return answers;
}

function dryRunJudgePhase(answers: AnswerRecord[]): JudgeRecord[] {
  log("judge", "[DRY-RUN] Returning synthetic scores");
  return answers.map((a) => ({
    promptId: a.promptId,
    condition: a.condition,
    score: a.condition === "compacted" ? 2 : 3,
    rationale: `[DRY-RUN] Synthetic score for ${a.condition}`,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== Cortex V1.1 Benchmark — OpenClaw Native vs OpenClaw + Cortex ===`);
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}${SEED ? " +SEED" : ""}${FORCE_EXTRACT ? " +EXTRACT" : ""}`);
  console.log(`Namespace: ${NAMESPACE} | OC top-k: ${OC_TOP_K} | Cortex top-k: ${CORTEX_TOP_K}`);
  console.log(`Git commit: ${GIT_COMMIT}`);
  console.log(`Sessions: ${seedData.length} | Prompts: ${runPrompts.length}`);

  if (!DRY_RUN) {
    if (!CORTEX_API_KEY) throw new Error("CORTEX_API_KEY is required");
    if (!LLM_API_KEY) throw new Error("LLM_API_KEY is required");
    console.log(`LLM: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
    console.log(`Judge: ${JUDGE_MODEL} @ ${JUDGE_BASE_URL}`);
    console.log(`OC embed: ${OC_EMBED_MODEL} @ ${OC_EMBED_BASE_URL}`);
  }
  console.log();

  // Phase 0: Load or extract memory notes
  const { notes: ocNotes, fromCache } = DRY_RUN
    ? { notes: dryRunExtractPhase(), fromCache: false }
    : await loadOrExtractMemoryNotes();

  // Identify recent session notes: last 2 sessions by day number (injected into
  // both condition contexts, simulating OpenClaw's today/yesterday daily log injection)
  const sortedByDay = [...ocNotes].sort((a, b) => b.dayNumber - a.dayNumber);
  const recentNotes = sortedByDay
    .slice(0, 2)
    .map((n) => `[${n.sessionId} — day ${n.dayNumber}]\n${n.notes}`)
    .join("\n\n---\n\n");

  const client = DRY_RUN
    ? (null as unknown as CortexClient)
    : new CortexClient(CORTEX_BASE_URL, CORTEX_API_KEY);

  // Phase 1: Seed Cortex
  let seedJobIds: string[];
  if (DRY_RUN) {
    seedJobIds = dryRunSeedPhase();
  } else if (SEED) {
    seedJobIds = await runSeedPhase(client);
  } else {
    log("seed", "Skipping (use --seed to ingest).");
    seedJobIds = [];
  }

  // Phase 2: Warmup + Reflect + Compaction
  const compactedSummary = DRY_RUN
    ? dryRunWarmupPhase()
    : await runWarmupPhase(client, SEED);

  // Phase 3: Build OC index + Retrieve
  const { records: retrievals, cortexMetrics, chunkCount } = DRY_RUN
    ? dryRunRetrievePhase()
    : await runRetrievePhase(client, ocNotes);

  // Phase 4: Answer
  const answers = DRY_RUN
    ? dryRunAnswerPhase(compactedSummary)
    : await runAnswerPhase(compactedSummary, recentNotes, retrievals);

  // Phase 5: Judge
  const judgments = DRY_RUN ? dryRunJudgePhase(answers) : await runJudgePhase(answers);

  // Phase 6: Report
  const report = buildReport(
    seedJobIds,
    compactedSummary,
    recentNotes,
    retrievals,
    answers,
    judgments,
    cortexMetrics,
    chunkCount,
    fromCache,
  );
  const filepath = writeReport(report);
  log("report", `Written to: ${filepath}`);

  printSummary(report);
}

main().catch((err) => {
  console.error("\nBenchmark failed:", err);
  process.exit(1);
});
