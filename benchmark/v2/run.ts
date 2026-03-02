#!/usr/bin/env npx tsx
/**
 * V2 Benchmark Runner — Real OpenClaw Runtime Memory Evaluation
 *
 * Unlike V1/V1.1 which simulate OpenClaw's memory pipeline, V2 sends
 * conversations and recall probes through a live OpenClaw agent via the
 * `openclaw agent` CLI. This tests the complete stack: real compaction,
 * real memory_search, real file sync, real plugin hooks.
 *
 * Two conditions are tested sequentially:
 *   1. Baseline — OpenClaw agent without the Cortex plugin
 *   2. Cortex  — Same agent with the Cortex plugin installed
 *
 * Reuses V1.1's Arclight dataset (45 sessions, 50 prompts with ground truth)
 * for direct comparison with simulated results.
 *
 * Usage:
 *   npx tsx benchmark/v2/run.ts --condition baseline --agent my-agent
 *   npx tsx benchmark/v2/run.ts --condition cortex --agent my-agent --skip-seed
 *   npx tsx benchmark/v2/run.ts --dry-run --condition baseline
 *   npx tsx benchmark/v2/run.ts --compare results/baseline-*.json results/cortex-*.json
 *   npx tsx benchmark/v2/run.ts --condition baseline --agent my-agent --seed-concurrency 2
 *   npx tsx benchmark/v2/run.ts --condition cortex --agent my-agent --probe-concurrency 4
 *   npx tsx benchmark/v2/run.ts --condition baseline --judge-passes 3
 *   npx tsx benchmark/v2/run.ts --condition baseline --settle-seconds 30
 *
 * Environment variables:
 *   JUDGE_MODEL       — Judge LLM model (default: gpt-4.1-mini)
 *   JUDGE_API_KEY     — Judge LLM API key (required unless --dry-run)
 *   JUDGE_BASE_URL    — Judge LLM base URL (default: https://api.openai.com/v1)
 *   OPENCLAW_TIMEOUT  — Timeout in seconds for openclaw agent calls (default: 120)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

interface AgentResponse {
  sessionId: string;
  promptId?: string;
  message: string;
  response: string | null;
  error?: string;
  durationMs: number;
}

interface ProbeResult {
  promptId: string;
  category: string;
  prompt: string;
  groundTruth: string;
  response: string | null;
  error?: string;
  durationMs: number;
}

interface JudgeRecord {
  promptId: string;
  score: number | null;
  rationale: string | null;
  passScores?: number[];
  error?: string;
}

interface BenchmarkReport {
  timestamp: string;
  condition: string;
  config: {
    agentId: string;
    judgeModel: string;
    judgePasses: number;
    judgeTemperature: number;
    dryRun: boolean;
    seedConcurrency: number;
    probeConcurrency: number;
    settleSeconds: number;
    openclawTimeout: number;
    gitCommit: string;
    promptCount: number;
    sessionCount: number;
  };
  seedResults: AgentResponse[];
  probeResults: ProbeResult[];
  judgments: JudgeRecord[];
}

// ---------------------------------------------------------------------------
// Paths & Data Loading
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Reuse V1.1 dataset
const seedDataPath = join(__dirname, "..", "v1.1", "seed-data.json");
const promptsPath = join(__dirname, "..", "v1.1", "prompts.json");

if (!existsSync(seedDataPath)) {
  console.error(`Seed data not found: ${seedDataPath}`);
  process.exit(1);
}
if (!existsSync(promptsPath)) {
  console.error(`Prompts not found: ${promptsPath}`);
  process.exit(1);
}

const seedData: SeedSession[] = JSON.parse(readFileSync(seedDataPath, "utf-8"));
const prompts: EvalPrompt[] = JSON.parse(readFileSync(promptsPath, "utf-8"));
const promptsById = new Map(prompts.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONDITION = getArgValue("--condition") ?? "baseline";
if (!["baseline", "cortex"].includes(CONDITION)) {
  console.error(`--condition must be "baseline" or "cortex", got "${CONDITION}"`);
  process.exit(1);
}

const AGENT_ID = getArgValue("--agent");
const DRY_RUN = hasFlag("--dry-run");
const SKIP_SEED = hasFlag("--skip-seed");
const SEED_CONCURRENCY = parsePositiveInteger(getArgValue("--seed-concurrency"), 1);
const PROBE_CONCURRENCY = parsePositiveInteger(getArgValue("--probe-concurrency"), 1);
const SETTLE_SECONDS = parsePositiveInteger(getArgValue("--settle-seconds"), 10);
const OPENCLAW_TIMEOUT = parsePositiveInteger(
  getArgValue("--openclaw-timeout") ?? process.env.OPENCLAW_TIMEOUT,
  120,
);

const JUDGE_PASSES = parsePositiveInteger(getArgValue("--judge-passes"), 3);
const JUDGE_TEMPERATURE = (() => {
  const raw = getArgValue("--judge-temperature");
  if (raw !== undefined) return parseFloat(raw);
  return JUDGE_PASSES > 1 ? 0.3 : 0;
})();
const JUDGE_CONCURRENCY = parsePositiveInteger(getArgValue("--judge-concurrency"), 4);
const JUDGE_API_KEY = process.env.JUDGE_API_KEY ?? "";
const JUDGE_BASE_URL = process.env.JUDGE_BASE_URL ?? "https://api.openai.com/v1";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-4.1-mini";

const COMPARE_MODE = hasFlag("--compare");

const GIT_COMMIT = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
})();

if (!DRY_RUN && !COMPARE_MODE && !AGENT_ID) {
  console.error("--agent is required (the OpenClaw agent ID to target)");
  process.exit(1);
}

if (!DRY_RUN && !COMPARE_MODE && !JUDGE_API_KEY) {
  console.error("JUDGE_API_KEY is required (set in environment)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(phase: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

// ---------------------------------------------------------------------------
// OpenClaw Agent Communication
// ---------------------------------------------------------------------------

/**
 * Send a message to the OpenClaw agent via CLI and return the response.
 * Uses `openclaw agent --message "..." --json` which returns structured output.
 *
 * All arguments are passed as array elements to execFileSync (no shell injection).
 */
function sendToAgent(
  message: string,
  opts: {
    agentId: string;
    sessionId?: string;
    timeoutSeconds?: number;
  },
): { response: string | null; durationMs: number; error?: string } {
  const start = Date.now();
  const args = ["agent", "--message", message, "--json"];

  if (opts.agentId) {
    args.push("--agent", opts.agentId);
  }
  if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  }
  if (opts.timeoutSeconds) {
    args.push("--timeout", String(opts.timeoutSeconds));
  }

  try {
    const result = execFileSync("openclaw", args, {
      encoding: "utf-8",
      timeout: (opts.timeoutSeconds ?? OPENCLAW_TIMEOUT) * 1000 + 5000, // 5s buffer over agent timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const durationMs = Date.now() - start;

    // Parse JSON output from openclaw agent --json
    try {
      const parsed = JSON.parse(result);
      // The openclaw agent --json output contains the agent's reply text
      const responseText =
        parsed.text ??
        parsed.message ??
        parsed.response ??
        parsed.payloads?.[0]?.text ??
        (typeof parsed === "string" ? parsed : result.trim());
      return { response: String(responseText), durationMs };
    } catch {
      // If not valid JSON, treat the raw output as the response
      return { response: result.trim(), durationMs };
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    return { response: null, durationMs, error: errMsg.slice(0, 500) };
  }
}

// ---------------------------------------------------------------------------
// LLM Utility (for judging — same as V1.1)
// ---------------------------------------------------------------------------

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

function parseJudgeResponse(resp: string): { score: number; rationale: string } {
  const cleaned = resp.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge returned non-JSON: ${cleaned.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; rationale?: unknown };
  if (typeof parsed.score !== "number")
    throw new Error(`Judge score missing: ${jsonMatch[0].slice(0, 120)}`);
  const normalizedScore = Math.max(0, Math.min(3, Math.round(parsed.score)));
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided";
  return { score: normalizedScore, rationale };
}

function aggregatePassScores(scores: number[]): number {
  if (scores.length === 0) return 0;
  if (scores.length === 1) return scores[0];
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
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
// Phase 1: Seed — Send conversations through the live agent
// ---------------------------------------------------------------------------

function runSeedPhase(): AgentResponse[] {
  if (SKIP_SEED) {
    log("seed", "Skipping seed phase (--skip-seed)");
    return [];
  }

  log("seed", `Seeding ${seedData.length} conversations through live agent...`);
  const allResponses: AgentResponse[] = [];

  for (let i = 0; i < seedData.length; i++) {
    const session = seedData[i];
    const sessionId = `benchmark-seed-${session.id}-${Date.now()}`;
    const userTurns = session.messages.filter((m) => m.role === "user");

    log("seed", `  [${i + 1}/${seedData.length}] ${session.id}: ${session.description.slice(0, 60)} (${userTurns.length} turns)`);

    if (DRY_RUN) {
      for (const turn of userTurns) {
        allResponses.push({
          sessionId,
          message: turn.content.slice(0, 100),
          response: "[dry-run] Simulated response",
          durationMs: 0,
        });
      }
      continue;
    }

    for (let t = 0; t < userTurns.length; t++) {
      const turn = userTurns[t];
      log("seed", `    turn ${t + 1}/${userTurns.length}: ${turn.content.slice(0, 60)}...`);

      const result = sendToAgent(turn.content, {
        agentId: AGENT_ID!,
        sessionId,
        timeoutSeconds: OPENCLAW_TIMEOUT,
      });

      allResponses.push({
        sessionId,
        message: turn.content.slice(0, 200),
        response: result.response?.slice(0, 500) ?? null,
        error: result.error,
        durationMs: result.durationMs,
      });

      if (result.error) {
        log("seed", `    ERROR on turn ${t + 1}: ${result.error.slice(0, 100)}`);
      }
    }
  }

  const errors = allResponses.filter((r) => r.error).length;
  log("seed", `Seeded ${allResponses.length} turns (${errors} errors).`);
  return allResponses;
}

// ---------------------------------------------------------------------------
// Phase 2: Settle — Wait for memory processing
// ---------------------------------------------------------------------------

function runSettlePhase(): void {
  if (DRY_RUN) {
    log("settle", "[dry-run] Skipping settle.");
    return;
  }

  log("settle", `Waiting ${SETTLE_SECONDS}s for memory processing (compaction, file sync, capture jobs)...`);
  const start = Date.now();
  execFileSync("sleep", [String(SETTLE_SECONDS)]);
  log("settle", `Settled (${Date.now() - start}ms).`);
}

// ---------------------------------------------------------------------------
// Phase 3: Probe — Send recall prompts and collect responses
// ---------------------------------------------------------------------------

function runProbePhase(): ProbeResult[] {
  log("probe", `Sending ${prompts.length} recall probes to agent...`);
  const results: ProbeResult[] = [];

  // All probes go to a fresh session so there's no prior conversation context
  const probeSessionId = `benchmark-probe-${CONDITION}-${Date.now()}`;

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    log("probe", `  [${i + 1}/${prompts.length}] ${p.id}: ${p.prompt.slice(0, 60)}...`);

    if (DRY_RUN) {
      results.push({
        promptId: p.id,
        category: p.category,
        prompt: p.prompt,
        groundTruth: p.groundTruth,
        response: "[dry-run] Simulated recall response with some generic information.",
        durationMs: 0,
      });
      continue;
    }

    const result = sendToAgent(p.prompt, {
      agentId: AGENT_ID!,
      sessionId: probeSessionId,
      timeoutSeconds: OPENCLAW_TIMEOUT,
    });

    results.push({
      promptId: p.id,
      category: p.category,
      prompt: p.prompt,
      groundTruth: p.groundTruth,
      response: result.response,
      error: result.error,
      durationMs: result.durationMs,
    });

    if (result.error) {
      log("probe", `    ERROR: ${result.error.slice(0, 100)}`);
    }
  }

  const errors = results.filter((r) => r.error).length;
  const latencies = results.filter((r) => !r.error).map((r) => r.durationMs);
  const avgMs = latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  log("probe", `Probed ${results.length} (${errors} errors, avg ${Math.round(avgMs)}ms per probe).`);
  return results;
}

// ---------------------------------------------------------------------------
// Phase 4: Judge — Score responses against ground truth
// ---------------------------------------------------------------------------

async function runJudgePhase(probeResults: ProbeResult[]): Promise<JudgeRecord[]> {
  log(
    "judge",
    `Judging ${probeResults.length} responses (concurrency=${JUDGE_CONCURRENCY}, passes=${JUDGE_PASSES}, temp=${JUDGE_TEMPERATURE})...`,
  );

  const judgeSystemPrompt = `You are an evaluation judge. Given a question, expected ground truth answer, and an AI agent's response, score the response:

3 = Grounded correct — contains the specific project detail from the ground truth
2 = Generic correct — gives a reasonable answer but lacks the specific detail
1 = Abstained — says it doesn't have the context or gives a non-answer
0 = Hallucinated — fabricated specific but wrong details

The AI agent may give a longer, more conversational response than a direct answer. Focus on whether the key factual content from the ground truth is present.

Respond with ONLY a JSON object: {"score": <0-3>, "rationale": "<brief explanation>"}`;

  const judgments = await mapWithConcurrency(probeResults, JUDGE_CONCURRENCY, async (probe, i) => {
    if (probe.response === null) {
      return {
        promptId: probe.promptId,
        score: null,
        rationale: `Skipped: ${probe.error ?? "no response"}`,
      } satisfies JudgeRecord;
    }

    if ((i + 1) % 10 === 0) log("judge", `  [${i + 1}/${probeResults.length}]`);

    if (DRY_RUN) {
      return {
        promptId: probe.promptId,
        score: Math.floor(Math.random() * 4),
        rationale: "[dry-run] Simulated judgment",
      } satisfies JudgeRecord;
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
              content: `Question: ${probe.prompt}\n\nGround Truth: ${probe.groundTruth}\n\nAI Response: ${probe.response}`,
            },
          ],
          {
            apiKey: JUDGE_API_KEY,
            baseUrl: JUDGE_BASE_URL,
            model: JUDGE_MODEL,
            temperature: JUDGE_TEMPERATURE,
          },
        );
        const parsed = parseJudgeResponse(resp);
        passScores.push(parsed.score);
        passRationales.push(parsed.rationale);
      }
      return {
        promptId: probe.promptId,
        score: aggregatePassScores(passScores),
        rationale: passRationales[0] ?? null,
        passScores: JUDGE_PASSES > 1 ? passScores : undefined,
      } satisfies JudgeRecord;
    } catch (err) {
      return {
        promptId: probe.promptId,
        score: null,
        rationale: null,
        error: (err as Error).message,
      } satisfies JudgeRecord;
    }
  });

  log("judge", `Judged ${judgments.length} (${judgments.filter((j) => j.score === null).length} failures).`);
  return judgments;
}

// ---------------------------------------------------------------------------
// Phase 5: Report
// ---------------------------------------------------------------------------

function buildReport(
  seedResults: AgentResponse[],
  probeResults: ProbeResult[],
  judgments: JudgeRecord[],
): BenchmarkReport {
  return {
    timestamp: new Date().toISOString(),
    condition: CONDITION,
    config: {
      agentId: AGENT_ID ?? "dry-run",
      judgeModel: JUDGE_MODEL,
      judgePasses: JUDGE_PASSES,
      judgeTemperature: JUDGE_TEMPERATURE,
      dryRun: DRY_RUN,
      seedConcurrency: SEED_CONCURRENCY,
      probeConcurrency: PROBE_CONCURRENCY,
      settleSeconds: SETTLE_SECONDS,
      openclawTimeout: OPENCLAW_TIMEOUT,
      gitCommit: GIT_COMMIT,
      promptCount: prompts.length,
      sessionCount: seedData.length,
    },
    seedResults,
    probeResults,
    judgments,
  };
}

function writeReport(report: BenchmarkReport): string {
  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const filepath = join(resultsDir, `${report.condition}-${ts}.json`);
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

// ---------------------------------------------------------------------------
// Summary & Comparison
// ---------------------------------------------------------------------------

function meanScore(judgments: JudgeRecord[], category?: string): string {
  const filtered = judgments.filter((j) => {
    if (j.score === null) return false;
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

function scoreDist(judgments: JudgeRecord[]): {
  "3": number;
  "2": number;
  "1": number;
  "0": number;
  errors: number;
} {
  const dist = { "3": 0, "2": 0, "1": 0, "0": 0, errors: 0 };
  for (const j of judgments) {
    if (j.score === null) dist.errors++;
    else {
      const bucket = Math.round(j.score) as 0 | 1 | 2 | 3;
      dist[String(bucket) as "0" | "1" | "2" | "3"]++;
    }
  }
  return dist;
}

function fmtDelta(a: string, b: string): string {
  if (a === "N/A" || b === "N/A") return "  N/A";
  const d = parseFloat(b) - parseFloat(a);
  return `${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
}

const CATEGORIES = [
  { key: "F", label: "F: Factual (15)" },
  { key: "R", label: "R: Rationale (10)" },
  { key: "E", label: "E: Evolution (10)" },
  { key: "S", label: "S: Synthesis (8)" },
  { key: "T", label: "T: Temporal (7)" },
];

function printSummary(report: BenchmarkReport): void {
  const j = report.judgments;

  console.log("\n============================================================");
  console.log(`               BENCHMARK V2 RESULTS`);
  console.log(`               Condition: ${report.condition.toUpperCase()}`);
  console.log("============================================================\n");

  const overall = meanScore(j);
  console.log("### Scores by Category (0-3 scale)\n");
  console.log("| Category                       | Score    |");
  console.log("|--------------------------------|----------|");
  console.log(`| **Overall Mean**               | ${overall.padStart(8)} |`);
  for (const cat of CATEGORIES) {
    const s = meanScore(j, cat.key);
    console.log(`| ${cat.label.padEnd(30)} | ${s.padStart(8)} |`);
  }

  const dist = scoreDist(j);
  console.log("\n### Score Distribution\n");
  console.log("| Score | Meaning              | Count    |");
  console.log("|-------|----------------------|----------|");
  console.log(`|   3   | Grounded correct     | ${String(dist["3"]).padStart(8)} |`);
  console.log(`|   2   | Generic correct      | ${String(dist["2"]).padStart(8)} |`);
  console.log(`|   1   | Abstained            | ${String(dist["1"]).padStart(8)} |`);
  console.log(`|   0   | Hallucinated         | ${String(dist["0"]).padStart(8)} |`);
  console.log(`| ERR   | Error                | ${String(dist.errors).padStart(8)} |`);

  // Probe latency stats
  const latencies = report.probeResults.filter((r) => !r.error).map((r) => r.durationMs).sort((a, b) => a - b);
  if (latencies.length > 0) {
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    console.log("\n### Agent Response Latency (probe turns)\n");
    console.log(`p50: ${(p50 / 1000).toFixed(1)}s · p95: ${(p95 / 1000).toFixed(1)}s`);
  }
}

function runComparison(): void {
  // Find the two result files from args after --compare
  const compareIdx = process.argv.indexOf("--compare");
  const files = process.argv.slice(compareIdx + 1).filter((a) => !a.startsWith("--"));

  if (files.length < 2) {
    console.error("--compare requires two result file paths");
    process.exit(1);
  }

  const reportA: BenchmarkReport = JSON.parse(readFileSync(files[0], "utf-8"));
  const reportB: BenchmarkReport = JSON.parse(readFileSync(files[1], "utf-8"));

  console.log("\n============================================================");
  console.log("               BENCHMARK V2 COMPARISON");
  console.log(`        ${reportA.condition.toUpperCase()}  vs  ${reportB.condition.toUpperCase()}`);
  console.log("============================================================\n");

  const jA = reportA.judgments;
  const jB = reportB.judgments;

  const overallA = meanScore(jA);
  const overallB = meanScore(jB);

  console.log("### Scores by Category (0-3 scale)\n");
  console.log(`| Category                       | ${reportA.condition.padEnd(8)} | ${reportB.condition.padEnd(8)} | Delta  |`);
  console.log("|--------------------------------|----------|----------|--------|");
  console.log(
    `| **Overall Mean**               | ${overallA.padStart(8)} | ${overallB.padStart(8)} | ${fmtDelta(overallA, overallB).padStart(6)} |`,
  );
  for (const cat of CATEGORIES) {
    const a = meanScore(jA, cat.key);
    const b = meanScore(jB, cat.key);
    console.log(
      `| ${cat.label.padEnd(30)} | ${a.padStart(8)} | ${b.padStart(8)} | ${fmtDelta(a, b).padStart(6)} |`,
    );
  }

  const distA = scoreDist(jA);
  const distB = scoreDist(jB);

  console.log("\n### Score Distribution\n");
  console.log(`| Score | Meaning              | ${reportA.condition.padEnd(8)} | ${reportB.condition.padEnd(8)} |`);
  console.log("|-------|----------------------|----------|----------|");
  for (const s of ["3", "2", "1", "0"] as const) {
    const labels = { "3": "Grounded correct", "2": "Generic correct", "1": "Abstained", "0": "Hallucinated" };
    console.log(
      `|   ${s}   | ${labels[s].padEnd(20)} | ${String(distA[s]).padStart(8)} | ${String(distB[s]).padStart(8)} |`,
    );
  }
  console.log(
    `| ERR   | ${"Error".padEnd(20)} | ${String(distA.errors).padStart(8)} | ${String(distB.errors).padStart(8)} |`,
  );

  // Per-prompt comparison table
  console.log("\n### Per-Prompt Comparison\n");
  console.log(`| ID  | Cat | ${reportA.condition.padEnd(5)} | ${reportB.condition.padEnd(5)} | Δ     | Prompt (truncated)                          |`);
  console.log("|-----|-----|-------|-------|-------|---------------------------------------------|");

  const scoresA = new Map(jA.map((j) => [j.promptId, j.score]));
  const scoresB = new Map(jB.map((j) => [j.promptId, j.score]));

  for (const p of prompts) {
    const sa = scoresA.get(p.id);
    const sb = scoresB.get(p.id);
    const saStr = sa !== null && sa !== undefined ? sa.toFixed(1) : "ERR";
    const sbStr = sb !== null && sb !== undefined ? sb.toFixed(1) : "ERR";
    const delta =
      sa !== null && sa !== undefined && sb !== null && sb !== undefined
        ? `${sb - sa >= 0 ? "+" : ""}${(sb - sa).toFixed(1)}`
        : " N/A";
    console.log(
      `| ${p.id.padEnd(3)} |  ${p.category}  | ${saStr.padStart(5)} | ${sbStr.padStart(5)} | ${delta.padStart(5)} | ${p.prompt.slice(0, 43).padEnd(43)} |`,
    );
  }

  // V1.1 comparison note
  console.log("\n### V1.1 Simulated Reference (for comparison)\n");
  console.log("| Category                       | OC (sim) | +Cortex (sim) | Sim Δ  |");
  console.log("|--------------------------------|----------|---------------|--------|");
  console.log("| **Overall Mean**               |     2.49 |          2.59 |  +0.10 |");
  console.log("| F: Factual (15)                |     2.79 |          2.78 |  -0.01 |");
  console.log("| R: Rationale (10)              |     2.30 |          2.80 |  +0.50 |");
  console.log("| E: Evolution (10)              |     2.77 |          2.63 |  -0.14 |");
  console.log("| S: Synthesis (8)               |     2.38 |          2.71 |  +0.33 |");
  console.log("| T: Temporal (7)                |     1.90 |          1.71 |  -0.19 |");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (COMPARE_MODE) {
    runComparison();
    return;
  }

  console.log("============================================================");
  console.log("  V2 Benchmark: Real OpenClaw Runtime Memory Evaluation");
  console.log("============================================================");
  console.log(`  Condition:     ${CONDITION}`);
  console.log(`  Agent:         ${AGENT_ID ?? "dry-run"}`);
  console.log(`  Sessions:      ${seedData.length}`);
  console.log(`  Prompts:       ${prompts.length}`);
  console.log(`  Skip seed:     ${SKIP_SEED}`);
  console.log(`  Dry run:       ${DRY_RUN}`);
  console.log(`  Judge:         ${JUDGE_MODEL} (${JUDGE_PASSES} passes, temp=${JUDGE_TEMPERATURE})`);
  console.log(`  Git commit:    ${GIT_COMMIT}`);
  console.log("============================================================\n");

  // Phase 1: Seed
  const seedResults = runSeedPhase();

  // Phase 2: Settle
  if (!SKIP_SEED) {
    runSettlePhase();
  }

  // Phase 3: Probe
  const probeResults = runProbePhase();

  // Phase 4: Judge
  const judgments = await runJudgePhase(probeResults);

  // Phase 5: Report
  const report = buildReport(seedResults, probeResults, judgments);
  const filepath = writeReport(report);
  printSummary(report);

  console.log(`\nResults written to: ${filepath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
