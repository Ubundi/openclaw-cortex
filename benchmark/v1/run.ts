#!/usr/bin/env npx tsx
/**
 * V1 Benchmark Runner — Three-way memory comparison
 *
 * Proves Cortex memory improves agent recall over:
 *   1. No memory (bare LLM)
 *   2. Compacted summary (OpenClaw-style)
 *   3. Cortex retrieval + compacted summary
 *
 * Usage:
 *   npx tsx benchmark/v1/run.ts              # full live run
 *   npx tsx benchmark/v1/run.ts --dry-run    # scaffold test, no API calls
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CortexClient } from "../../src/cortex/client.js";
import type { RetrieveResult } from "../../src/cortex/client.js";
import { LatencyMetrics } from "../../src/shared/metrics/latency-metrics.js";
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

interface RetrievalRecord {
  promptId: string;
  fastResults: RetrieveResult[];
  fullResults: RetrieveResult[];
  fastLatencyMs: number;
  fullLatencyMs: number;
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
  error?: string;
}

interface BenchmarkReport {
  timestamp: string;
  config: {
    llmModel: string;
    judgeModel: string;
    dryRun: boolean;
    namespace: string;
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

const DRY_RUN = process.argv.includes("--dry-run");

const CORTEX_API_KEY = process.env.CORTEX_API_KEY ?? "";
const CORTEX_BASE_URL =
  process.env.CORTEX_BASE_URL ??
  "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";

const JUDGE_API_KEY = process.env.JUDGE_API_KEY || LLM_API_KEY;
const JUDGE_BASE_URL = process.env.JUDGE_BASE_URL || LLM_BASE_URL;
const JUDGE_MODEL = process.env.JUDGE_MODEL || LLM_MODEL;

const NAMESPACE = `benchmark-v1-${Date.now()}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seedData: SeedSession[] = JSON.parse(
  readFileSync(join(__dirname, "seed-data.json"), "utf-8"),
);

const prompts: EvalPrompt[] = JSON.parse(
  readFileSync(join(__dirname, "prompts.json"), "utf-8"),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(phase: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

async function callLLM(
  messages: { role: string; content: string }[],
  opts: { apiKey: string; baseUrl: string; model: string; timeoutMs?: number; maxTokens?: number },
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
        const resp = await client.submitIngestConversation(
          session.messages,
          NAMESPACE,
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

  const deadline = Date.now() + 120_000;
  const pending = new Set(jobIds);

  while (pending.size > 0 && Date.now() < deadline) {
    for (const id of [...pending]) {
      try {
        const status = await client.getJob(id);
        if (status.status === "completed") {
          pending.delete(id);
          log("seed", `  Job ${id}: completed`);
        } else if (status.status === "failed") {
          throw new Error(`seed: job ${id} failed: ${status.error ?? "unknown"}`);
        }
      } catch (err) {
        if ((err as Error).message.startsWith("seed:")) throw err;
        log("seed", `  Job ${id}: poll error (retrying): ${(err as Error).message}`);
      }
    }
    if (pending.size > 0) await sleep(2_000);
  }

  if (pending.size > 0) {
    throw new Error(`seed: ${pending.size} jobs timed out after 120s`);
  }

  log("seed", "All jobs completed successfully.");
  return jobIds;
}

// ---------------------------------------------------------------------------
// Phase 2: Warmup + Compaction
// ---------------------------------------------------------------------------

async function runWarmupPhase(client: CortexClient): Promise<string> {
  log("warmup", "Warming up tenant...");
  await client.warmup();

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
  return compactedSummary;
}

// ---------------------------------------------------------------------------
// Phase 3: Retrieve
// ---------------------------------------------------------------------------

async function runRetrievePhase(
  client: CortexClient,
): Promise<{ records: RetrievalRecord[]; fastMetrics: LatencyMetrics; fullMetrics: LatencyMetrics }> {
  log("retrieve", `Running retrieval for ${prompts.length} prompts (fast + full)...`);

  const fastMetrics = new LatencyMetrics(100);
  const fullMetrics = new LatencyMetrics(100);
  const records: RetrievalRecord[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    log("retrieve", `  [${i + 1}/${prompts.length}] ${p.id}: ${p.prompt.slice(0, 60)}`);

    const fastStart = Date.now();
    const fastResp = await client.retrieve(p.prompt, 10, "fast", 10_000);
    const fastMs = Date.now() - fastStart;
    fastMetrics.record(fastMs);

    const fullStart = Date.now();
    const fullResp = await client.retrieve(p.prompt, 10, "full", 10_000);
    const fullMs = Date.now() - fullStart;
    fullMetrics.record(fullMs);

    records.push({
      promptId: p.id,
      fastResults: fastResp.results,
      fullResults: fullResp.results,
      fastLatencyMs: fastMs,
      fullLatencyMs: fullMs,
    });
  }

  log("retrieve", `Done. Fast p50=${fastMetrics.p50}ms p95=${fastMetrics.p95}ms | Full p50=${fullMetrics.p50}ms p95=${fullMetrics.p95}ms`);
  return { records, fastMetrics, fullMetrics };
}

// ---------------------------------------------------------------------------
// Phase 4: Answer
// ---------------------------------------------------------------------------

async function runAnswerPhase(
  compactedSummary: string,
  retrievals: RetrievalRecord[],
): Promise<AnswerRecord[]> {
  log("answer", `Generating answers for ${prompts.length} prompts x 3 conditions...`);
  const answers: AnswerRecord[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const retrieval = retrievals.find((r) => r.promptId === p.id)!;
    log("answer", `  [${i + 1}/${prompts.length}] ${p.id}`);

    const systemMsg = "You are a coding assistant helping with a TypeScript project. Answer based only on what you know about the project. If you don't have the information, say so.";

    // Condition 1: Bare
    try {
      const bareAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          { role: "user", content: p.prompt },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      answers.push({ promptId: p.id, condition: "bare", answer: bareAnswer });
    } catch (err) {
      answers.push({ promptId: p.id, condition: "bare", answer: null, error: (err as Error).message });
    }

    // Condition 2: Compacted
    try {
      const compactedAnswer = await callLLM(
        [
          { role: "system", content: systemMsg },
          {
            role: "user",
            content: `Here is a project memory summary:\n\n${compactedSummary}\n\nQuestion: ${p.prompt}`,
          },
        ],
        { apiKey: LLM_API_KEY, baseUrl: LLM_BASE_URL, model: LLM_MODEL },
      );
      answers.push({ promptId: p.id, condition: "compacted", answer: compactedAnswer });
    } catch (err) {
      answers.push({ promptId: p.id, condition: "compacted", answer: null, error: (err as Error).message });
    }

    // Condition 3: Cortex
    try {
      const memories = formatMemories(retrieval.fullResults);
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
      answers.push({ promptId: p.id, condition: "cortex", answer: cortexAnswer });
    } catch (err) {
      answers.push({ promptId: p.id, condition: "cortex", answer: null, error: (err as Error).message });
    }
  }

  log("answer", `Generated ${answers.length} answers (${answers.filter((a) => a.error).length} errors).`);
  return answers;
}

// ---------------------------------------------------------------------------
// Phase 5: Judge
// ---------------------------------------------------------------------------

async function runJudgePhase(answers: AnswerRecord[]): Promise<JudgeRecord[]> {
  log("judge", `Judging ${answers.length} answers...`);
  const judgments: JudgeRecord[] = [];

  const judgeSystemPrompt = `You are an evaluation judge. Given a question, expected ground truth answer, and an AI's response, score the response:

3 = Grounded correct — contains the specific project detail from the ground truth
2 = Generic correct — gives a reasonable answer but lacks the specific detail
1 = Abstained — says "I don't have that context" or similar
0 = Hallucinated — fabricated specific but wrong details

Respond with ONLY a JSON object: {"score": <0-3>, "rationale": "<brief explanation>"}`;

  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    const prompt = prompts.find((p) => p.id === a.promptId)!;

    if (a.answer === null) {
      judgments.push({
        promptId: a.promptId,
        condition: a.condition,
        score: null,
        rationale: `Skipped: ${a.error}`,
      });
      continue;
    }

    if ((i + 1) % 10 === 0) {
      log("judge", `  [${i + 1}/${answers.length}]`);
    }

    try {
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

      const cleaned = resp.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned) as { score: number; rationale: string };
      judgments.push({
        promptId: a.promptId,
        condition: a.condition,
        score: parsed.score,
        rationale: parsed.rationale,
      });
    } catch (err) {
      judgments.push({
        promptId: a.promptId,
        condition: a.condition,
        score: null,
        rationale: null,
        error: (err as Error).message,
      });
    }
  }

  log("judge", `Judged ${judgments.length} answers (${judgments.filter((j) => j.score === null).length} failures).`);
  return judgments;
}

// ---------------------------------------------------------------------------
// Phase 6: Report
// ---------------------------------------------------------------------------

function buildReport(
  seedJobIds: string[],
  compactedSummary: string,
  retrievals: RetrievalRecord[],
  answers: AnswerRecord[],
  judgments: JudgeRecord[],
  fastMetrics: LatencyMetrics,
  fullMetrics: LatencyMetrics,
): BenchmarkReport {
  return {
    timestamp: new Date().toISOString(),
    config: {
      llmModel: LLM_MODEL,
      judgeModel: JUDGE_MODEL,
      dryRun: DRY_RUN,
      namespace: NAMESPACE,
    },
    seedJobIds,
    compactedSummary,
    retrievals,
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
  condition: string,
  category?: string,
): string {
  const filtered = judgments.filter(
    (j) =>
      j.condition === condition &&
      j.score !== null &&
      (category === undefined || prompts.find((p) => p.id === j.promptId)?.category === category),
  );
  if (filtered.length === 0) return "N/A";
  const avg = filtered.reduce((sum, j) => sum + j.score!, 0) / filtered.length;
  return avg.toFixed(2);
}

function scoreDistribution(
  judgments: JudgeRecord[],
  condition: string,
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
  console.log("| Category                     | No Mem | Compacted | + Cortex | Comp vs Bare | Cortex vs Comp |");
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
  console.log("| Score | Meaning              | No Mem | Compacted | + Cortex |");
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

  // --- Per-Prompt Breakdown ---
  console.log("\n### Per-Prompt Breakdown\n");
  console.log("| ID  | Cat | Prompt (truncated)                     | Bare | Comp | Cortex |");
  console.log("|-----|-----|----------------------------------------|------|------|--------|");
  for (const p of prompts) {
    const bareJ = j.find((x) => x.promptId === p.id && x.condition === "bare");
    const compJ = j.find((x) => x.promptId === p.id && x.condition === "compacted");
    const cortJ = j.find((x) => x.promptId === p.id && x.condition === "cortex");
    const fmtScore = (rec: JudgeRecord | undefined) => rec?.score !== null && rec?.score !== undefined ? String(rec.score) : "ERR";
    const truncated = p.prompt.length > 40 ? p.prompt.slice(0, 37) + "..." : p.prompt;
    console.log(
      `| ${p.id.padEnd(3)} |  ${p.category}  | ${truncated.padEnd(38)} |    ${fmtScore(bareJ)} |    ${fmtScore(compJ)} |      ${fmtScore(cortJ)} |`,
    );
  }

  // --- Config ---
  console.log(`\n------------------------------------------------------------`);
  console.log(`Model: ${report.config.llmModel} | Judge: ${report.config.judgeModel}`);
  console.log(`Namespace: ${report.config.namespace}`);
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
} {
  log("retrieve", "[DRY-RUN] Skipping retrieval — returning synthetic results");
  const fastMetrics = new LatencyMetrics(100);
  const fullMetrics = new LatencyMetrics(100);
  const records: RetrievalRecord[] = prompts.map((p) => {
    fastMetrics.record(Math.round(50 + Math.random() * 100));
    fullMetrics.record(Math.round(200 + Math.random() * 300));
    return {
      promptId: p.id,
      fastResults: [
        { node_id: "dry-1", type: "FACT" as const, content: `Synthetic fact for ${p.id}`, score: 0.85 },
      ],
      fullResults: [
        { node_id: "dry-1", type: "FACT" as const, content: `Synthetic fact for ${p.id}`, score: 0.92 },
        { node_id: "dry-2", type: "INSIGHT" as const, content: `Synthetic insight for ${p.id}`, score: 0.78 },
      ],
      fastLatencyMs: 75,
      fullLatencyMs: 350,
    };
  });
  return { records, fastMetrics, fullMetrics };
}

function dryRunAnswerPhase(): AnswerRecord[] {
  log("answer", "[DRY-RUN] Skipping LLM answers — returning synthetic responses");
  const answers: AnswerRecord[] = [];
  for (const p of prompts) {
    answers.push({ promptId: p.id, condition: "bare", answer: "I don't have specific project context to answer this." });
    answers.push({ promptId: p.id, condition: "compacted", answer: `Based on the project summary: ${p.groundTruth.slice(0, 50)}...` });
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
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  console.log(`Namespace: ${NAMESPACE}`);

  if (!DRY_RUN) {
    if (!CORTEX_API_KEY) throw new Error("CORTEX_API_KEY is required");
    if (!LLM_API_KEY) throw new Error("LLM_API_KEY is required");
    console.log(`LLM: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
    console.log(`Judge: ${JUDGE_MODEL} @ ${JUDGE_BASE_URL}`);
  }

  console.log(`Sessions: ${seedData.length}, Prompts: ${prompts.length}\n`);

  const client = DRY_RUN
    ? (null as unknown as CortexClient)
    : new CortexClient(CORTEX_BASE_URL, CORTEX_API_KEY);

  // Phase 1: Seed
  const seedJobIds = DRY_RUN ? dryRunSeedPhase() : await runSeedPhase(client);

  // Phase 2: Warmup + Compaction
  const compactedSummary = DRY_RUN ? dryRunWarmupPhase() : await runWarmupPhase(client);

  // Phase 3: Retrieve
  const { records: retrievals, fastMetrics, fullMetrics } = DRY_RUN
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
    seedJobIds,
    compactedSummary,
    retrievals,
    answers,
    judgments,
    fastMetrics,
    fullMetrics,
  );

  const filepath = writeReport(report);
  log("report", `Results written to: ${filepath}`);

  printMarkdownSummary(report);
}

main().catch((err) => {
  console.error("\nBenchmark failed:", err);
  process.exit(1);
});
