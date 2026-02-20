# Benchmark Run Guide

## V1: Three-Way Memory Comparison

Tests whether Cortex memory improves agent recall over bare LLM and compacted summaries.

### What It Measures

Each of 40 evaluation prompts is answered under 3 conditions:

| Condition | Memory Source |
|-----------|--------------|
| **Bare** | No memory — raw LLM |
| **Compacted** | LLM-generated summary of all sessions (simulates OpenClaw native compaction) |
| **Cortex** | Compacted summary + Cortex retrieved memories |

A judge LLM scores each answer on a 4-point scale:

- **3** — Grounded correct (specific project detail matches ground truth)
- **2** — Generic correct (reasonable but lacks specifics)
- **1** — Abstained ("I don't have that context")
- **0** — Hallucinated (fabricated wrong specifics)

### Prerequisites

- Node.js 18+ or Bun
- A Cortex API key (`CORTEX_API_KEY`)
- An OpenAI-compatible LLM API key (`LLM_API_KEY`)

### Quick Start

```bash
# Dry run — validates scaffold, no API calls
npx tsx benchmark/v1/run.ts --dry-run

# Full live run
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1/run.ts
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORTEX_API_KEY` | Yes | — | Cortex API key |
| `CORTEX_BASE_URL` | No | AWS prod URL | Cortex API endpoint |
| `LLM_API_KEY` | Yes | — | OpenAI-compatible API key for answer + compaction |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM API endpoint |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model for answers and compaction |
| `JUDGE_API_KEY` | No | Falls back to `LLM_API_KEY` | Separate key for judge model |
| `JUDGE_BASE_URL` | No | Falls back to `LLM_BASE_URL` | Separate endpoint for judge |
| `JUDGE_MODEL` | No | Falls back to `LLM_MODEL` | Model for scoring answers |

### Using a Different LLM Provider

Any OpenAI-compatible API works. Examples:

```bash
# Anthropic via OpenAI-compatible proxy
LLM_BASE_URL=https://api.anthropic.com/v1 LLM_MODEL=claude-sonnet-4-20250514 ...

# Local Ollama
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3 LLM_API_KEY=unused ...

# Separate judge model (e.g., stronger model for scoring)
JUDGE_MODEL=gpt-4o JUDGE_API_KEY=sk-... ...
```

### Execution Phases

The runner executes 6 phases sequentially:

1. **Seed** — Ingests 8 conversation sessions into Cortex via async jobs. Retries up to 3x per session, polls all jobs until complete (120s deadline).

2. **Warmup** — Warms the Cortex tenant, then generates a compacted summary by asking the LLM to summarize all 8 session transcripts.

3. **Retrieve** — For each of 40 prompts, runs both `fast` and `full` retrieval modes against Cortex. Records latency and results.

4. **Answer** — For each prompt, generates 3 answers (bare, compacted, cortex) via the LLM.

5. **Judge** — Scores all 120 answers using the judge LLM on the 0-3 scale.

6. **Report** — Writes full JSON results to `benchmark/v1/results/` and prints a markdown summary table.

### Output

**Markdown table** printed to stdout:

```
| Metric                       | No Mem | Compacted | + Cortex | Delta |
|------------------------------|--------|-----------|----------|-------|
| Mean score (0-3)             |   1.00 |      2.15 |     2.78 | +1.78 |
| A: Specific detail (15)      |   0.87 |      1.93 |     2.80 | +1.93 |
| B: Decision/rationale (10)   |   1.10 |      2.30 |     2.70 | +1.60 |
| ...                          |        |           |          |       |
```

**JSON results** saved to `benchmark/v1/results/run-{timestamp}.json` containing all retrievals, answers, judgments, latency metrics, and config.

### Evaluation Prompts

40 prompts across 4 categories:

| Category | Count | Tests |
|----------|-------|-------|
| A: Specific Detail | 15 | Single verifiable facts (port numbers, file paths, TTLs) |
| B: Decision/Rationale | 10 | Why choices were made (Zod over Joi, Drizzle over Prisma) |
| C: Preference/Convention | 10 | Stated rules (named exports, no auto-commit) |
| D: Cross-Session | 5 | Connecting info across multiple sessions |

### Seed Data

8 synthetic conversation sessions covering:

1. Project setup (TypeScript, bun, vitest, port 3001)
2. Architecture (Zod validation, `src/validation/`)
3. Bug fix (WebSocket heartbeat: 30s ping, 5s pong timeout)
4. Preferences (named exports, no auto-commit, root `types.ts`)
5. Redis caching (ioredis, TTL 300s, `cache:{entity}:{id}`)
6. Code review (30-line max, error message format, no `as`)
7. JWT debugging (import-time env read, lazy getter fix)
8. Planning (express-rate-limit, Drizzle ORM, OpenTelemetry)

Each session embeds non-default specifics (port 3001 not 3000, TTL 300s not 60s) that compaction tends to lose.

### Interpreting Results

- **Delta > 0** between Cortex and Compacted = Cortex adds value
- **Category A** is the strongest signal — specific details are what compaction loses
- **Category D** tests cross-session synthesis, the hardest recall task
- **Fast vs Full latency** shows the speed/quality tradeoff in retrieval modes
- A score of 2 everywhere suggests the LLM is answering generically — check if retrieval is returning relevant results in the JSON output

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `CORTEX_API_KEY is required` | Set the environment variable |
| Seed jobs timing out | Cortex may be under load — try again or increase the 120s deadline in `run.ts` |
| All answers scoring 1 | LLM is abstaining — check that compacted summary and retrieval results contain relevant data |
| Judge returning `null` scores | Judge LLM failing to produce valid JSON — try a more capable judge model |
| `LLM API 429` | Rate limited — the runner calls sequentially, but you may need to wait or use a higher-tier key |
