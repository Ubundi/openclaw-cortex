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

Runner defaults are tuned for reproducibility: answer/compaction/judge calls use deterministic generation settings (`temperature=0`, `top_p=1`).

### Prerequisites

- Node.js 20+ or Bun
- A Cortex API key (`CORTEX_API_KEY`)
- An OpenAI-compatible LLM API key (`LLM_API_KEY`)

### Quick Start

```bash
# Dry run — validates scaffold, no API calls
npx tsx benchmark/v1/run.ts --dry-run

# First run — seed data into Cortex, then evaluate
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1/run.ts --seed

# Subsequent runs — reuse seeded data, only re-evaluate
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1/run.ts

# Isolated trial namespace (avoids mixing with previous seeded runs)
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1/run.ts --namespace-suffix trial-a --seed

# Tuned run: shuffled prompts + controlled concurrency + multi-pass judge
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... \
  npx tsx benchmark/v1/run.ts --shuffle-prompts --shuffle-seed 42 \
  --answer-concurrency 4 --judge-concurrency 4 --judge-passes 3
```

**Important:** Namespace base defaults to `benchmark-v1`. You can isolate runs with `--namespace-suffix` (or `BENCHMARK_NAMESPACE_SUFFIX`). Only use `--seed` on the first run for a namespace or when `seed-data.json` changes. Running without `--seed` skips ingestion and goes straight to retrieval + evaluation.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORTEX_API_KEY` | Yes | — | Cortex API key |
| `CORTEX_BASE_URL` | No | AWS prod URL | Cortex API endpoint |
| `BENCHMARK_NAMESPACE` | No | `benchmark-v1` | Cortex namespace for seed data |
| `BENCHMARK_NAMESPACE_SUFFIX` | No | — | Optional namespace suffix for isolated runs |
| `LLM_API_KEY` | Yes | — | OpenAI-compatible API key for answer + compaction |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM API endpoint |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model for answers and compaction |
| `JUDGE_API_KEY` | No | Falls back to `LLM_API_KEY` | Separate key for judge model |
| `JUDGE_BASE_URL` | No | Falls back to `LLM_BASE_URL` | Separate endpoint for judge |
| `JUDGE_MODEL` | No | `gpt-4.1-mini` | Model for scoring answers |

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Synthetic scaffold run (no API calls) |
| `--seed` | `false` | Ingests seed conversations before evaluation |
| `--debug-report` | `false` | Keeps full retrieval metadata in output JSON |
| `--namespace-suffix <suffix>` | — | Appends suffix to namespace base |
| `--shuffle-prompts` | `false` | Deterministically shuffles prompt order |
| `--shuffle-seed <int>` | `1337` | Seed used for prompt shuffle and retrieval mode ordering |
| `--answer-concurrency <int>` | `4` | Worker pool size for answer generation |
| `--judge-concurrency <int>` | `4` | Worker pool size for judge scoring |
| `--judge-passes <int>` | `1` | Judge passes per answer, aggregated by majority vote |

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

1. **Seed** — Ingests 8 conversation sessions into Cortex via async jobs. Retries up to 3x per session, then polls all pending jobs in parallel until complete (120s deadline).

2. **Warmup** — Warms the Cortex tenant, then generates a compacted summary from all 8 session transcripts.

3. **Retrieve** — For each of 40 prompts, runs both `fast` and `full` retrieval modes against Cortex. Mode order is randomized per prompt (deterministic from seed) to reduce order bias.

4. **Answer** — For each prompt, generates 3 answers (bare, compacted, cortex) via the LLM using a configurable concurrency pool.

5. **Judge** — Scores all 120 answers using the judge LLM on the 0-3 scale, with configurable concurrency and optional multi-pass voting.

6. **Report** — Writes JSON results to `benchmark/v1/results/` and prints a markdown summary table. By default retrieval payloads are trimmed for smaller files; full metadata is preserved only with `--debug-report`.

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

**JSON results** saved to `benchmark/v1/results/run-{timestamp}.json` containing retrievals, answers, judgments, latency metrics, and run config (including git commit, seed, prompt order, and concurrency settings).

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

### V1 Results (2026-02-20, gpt-4o-mini, clean tenant, 3-pass judge)

Run config: `--shuffle-prompts --shuffle-seed 42 --answer-concurrency 4 --judge-concurrency 4 --judge-passes 3`

#### Overall Scores

| Category                     | No Mem | Compacted | + Cortex | Comp vs Bare | Cortex vs Comp |
|------------------------------|--------|-----------|----------|--------------|----------------|
| **Overall Mean**             |   1.35 |      2.50 |     2.70 |        +1.15 |          +0.20 |
| A: Specific detail (15)      |   1.27 |      2.80 |     2.87 |        +1.53 |          +0.07 |
| B: Decision/rationale (10)   |   1.60 |      2.00 |     2.70 |        +0.40 |          +0.70 |
| C: Preference/convention (10) |   1.40 |      2.50 |     2.50 |        +1.10 |          +0.00 |
| D: Cross-session (5)         |   1.00 |      2.60 |     2.60 |        +1.60 |          +0.00 |

#### Score Distribution

| Score | Meaning              | No Mem | Compacted | + Cortex |
|-------|----------------------|--------|-----------|----------|
|     3 | Grounded correct     |      4 |        22 |       28 |
|     2 | Generic correct      |      7 |        16 |       12 |
|     1 | Abstained            |     28 |         2 |        0 |
|     0 | Hallucinated         |      1 |         0 |        0 |

#### Retrieval Latency

| Mode | p50      | p95      |
|------|----------|----------|
| Fast |    502ms |   1151ms |
| Full |   1002ms |   2183ms |

#### Key Findings

**Cortex's strongest value: preserving decision rationale (+0.70 over compaction)**

Category B is where Cortex dominates most. Compaction records *what* was decided but loses *why*. Cortex retrieves the original context with full reasoning intact:

- B06 (vitest over jest): Compaction **missed it** (1), Cortex grounded (3)
- B10 (ioredis over default redis): Compaction **missed it** (1), Cortex grounded (3)
- B02 (Drizzle over Prisma): Compaction generic (2), Cortex grounded (3) — bundle size rationale (~10MB vs ~50KB) preserved
- B09 (non-default port reason): Compaction said "port 3001" but lost "because another service uses 3000"

Compaction scored 2.00 on rationale questions — below its overall average — while Cortex scored 2.70. This is the clearest signal: **compaction remembers decisions, Cortex remembers why.**

**Cortex preserves specifics that compaction drops**

The exact numbers, file paths, and config values that matter when writing code:

- A13 (OTel span attributes `app.request_id`, `app.user_id`): Bare 1 → Compacted 2 → Cortex **3**
- A12 (JWT bug root cause — import-time env read): all three scored 3 on this run
- A09 (error message format `module.function: description`): 1 → 3 → **3**

**Zero hallucinations and zero abstentions with Cortex**

Cortex: 0/40 hallucinated, 0/40 abstained. Bare: 1/40 hallucinated, 28/40 abstained. Grounded retrieval prevents both fabrication and helpless non-answers.

**28/40 grounded correct vs 22/40 for compaction**

More than 27% more answers with the exact project-specific detail from ground truth.

#### Where Compaction Already Works Well

Category C (preferences/conventions) shows +0.00 delta — Cortex matches compaction at 2.70. Simple stated rules like "use named exports" or "no auto-commit" survive summarization fine. Cortex's value is concentrated in the harder recall tasks where compaction is lossy: rationale and specific implementation details.

Category D (cross-session synthesis) also shows +0.00 delta at 2.40. Cross-session questions require connecting facts from multiple sessions, which remains a harder retrieval problem. Both conditions score 2 (generic correct) on D03-D05, indicating the LLM recognizes the question domain but can't produce grounded specifics spanning sessions.

#### Clean Tenant Impact

An earlier run against a polluted tenant (duplicate data from failed runs) showed identical scores but **3-4x worse latency**:

| Mode | Polluted Tenant | Clean Tenant | Improvement |
|------|----------------|--------------|-------------|
| Fast p50 | 2063ms | 701ms | **-66%** |
| Full p50 | 3985ms | 937ms | **-76%** |

Duplicate data in the knowledge graph doesn't change retrieval accuracy (the right facts still rank highest) but significantly degrades performance. Tenant hygiene matters for production latency.

#### The Takeaway

> **Compaction is lossy compression. Cortex is lossless retrieval.**
>
> Compaction keeps the gist — it'll tell you "we use Zod" but forgets it's in `src/validation/` using `.parse()` not `.safeParse()`. It remembers you chose Drizzle but forgets you chose it for bundle size. Cortex retrieves the original context, preserving the specifics and rationale that matter when you're actually writing code.
>
> **Important caveat:** This result used a weak OpenClaw baseline (compacted summary only, no retrieval). See the Known Issues section below.

---

### Known Issues & Required Improvements

#### Issue 1: OpenClaw baseline was too weak in V1 results above — addressed in V1.1

The V1 results above used `Compacted` = one-shot LLM summary of all sessions, with no retrieval. This significantly underestimates what a real OpenClaw agent provides.

**What OpenClaw actually gives an agent after compaction:**
- The compacted summary (simulated ✓)
- `memory_search` — hybrid vector + BM25 search over indexed session history, which OpenClaw's system prompt instructs the agent to use as a **mandatory recall step** before answering factual questions (not simulated in V1 ✗)
- Recent session notes (today/yesterday daily logs, always injected) (not simulated in V1 ✗)
- Temporal decay — 30-day half-life exponential decay on retrieval scores (not simulated in V1 ✗)
- MMR re-ranking — diversity selection over 4× candidate pool (not simulated in V1 ✗)

**V1.1 resolves this with a proper full-fidelity OpenClaw simulation.** See the V1.1 section below for the corrected benchmark design. V1.1 also uses a much larger 45-session, 6-week project dataset designed to stress-test temporal reasoning and cross-session graph traversal — the scenarios where Cortex's architecture is expected to differentiate.

**Why V1's 8-session dataset couldn't show Cortex's advantage:** The V1 seed data produces only ~9 chunks. At this scale, both memory_search and Cortex retrieve nearly everything relevant for nearly every query. Cortex's advantages — knowledge graph traversal, entity resolution, SUPERSEDES chains for stale/updated facts — only emerge at scale and over time.

#### What V1.1 addresses

| Gap | V1 problem | V1.1 fix |
|-----|-----------|----------|
| **Scale** | 8 sessions → ~9 chunks. Both systems retrieve everything trivially. | 45-session Arclight dataset — large enough that BM25 + cosine faces real retrieval pressure. |
| **Temporal facts** | No contradictions. Cortex's SUPERSEDES chain untested. | Deliberate fact evolution: auth JWT→iron-session, email Resend→SendGrid, TTL 300s→600s. Category T prompts ask for the *current* value. |
| **Cross-session reasoning** | Category D scored 2.40 for both — cross-session retrieval untested. | Category S (Synthesis, 8 prompts) + Category T (Temporal, 7 prompts) require multi-session reasoning. |
| **OpenClaw baseline fidelity** | Compaction only — no retrieval, no decay, no recent injection. | Full simulation: memory note extraction + recent injection + hybrid BM25/cosine + temporal decay + MMR. |

The honest claim from V1 data: **Cortex matches OpenClaw on small fresh datasets and beats compaction-only baselines significantly.** V1.1 is designed to test whether Cortex differentiates on larger, temporally complex datasets against a proper retrieval baseline.

### Interpreting Your Own Results (V1)

- **Cortex vs OC > 0** = Cortex adds value beyond OpenClaw's native memory stack
- **Category B** was Cortex's strongest signal — rationale preservation
- A score of 2 everywhere suggests the LLM is answering generically — check if retrieval is returning relevant results in the JSON output
- **Fast vs Full latency** shows the speed/quality tradeoff in retrieval modes

### Troubleshooting (V1)

| Problem | Fix |
|---------|-----|
| `CORTEX_API_KEY is required` | Set the environment variable |
| Seed jobs timing out | Cortex may be under load — try again or increase the 120s deadline in `run.ts` |
| All answers scoring 1 | LLM is abstaining — check that compacted summary and retrieval results contain relevant data |
| Judge returning `null` scores | Judge LLM failing to produce valid JSON — try a more capable judge model |
| `LLM API 429` | Rate limited — lower `--answer-concurrency` / `--judge-concurrency`, retry, or use a higher-tier key |
| Result JSON is very large | Run without `--debug-report` (default is trimmed retrieval payloads) |

---

## V1.1: OpenClaw Native vs OpenClaw + Cortex

Tests whether Cortex improves over OpenClaw's **full native memory stack** — not just compaction, but the complete retrieval pipeline — on a 45-session, 6-week project history designed to stress-test temporal reasoning and cross-session graph traversal.

### What It Measures

Two conditions on 50 evaluation prompts:

| Condition | Memory Source |
|-----------|--------------|
| **OpenClaw** | Compacted summary + recent session notes (always injected) + `memory_search` (hybrid BM25+vector, temporal decay, MMR) |
| **+ Cortex** | Same OpenClaw foundation + Cortex retrieved memories (entity extraction, graph edges, semantic + structural reranking) |

The baseline is now a full-fidelity OpenClaw simulation — not a compaction-only weak baseline.

### OpenClaw Simulation Fidelity

| Feature | Implementation |
|---------|----------------|
| Memory note extraction | LLM extracts "what the agent would write to daily logs" per session (cached to `oc-memory-notes.json`) |
| Recent session injection | Last 2 sessions' notes always injected into both conditions (simulates today/yesterday daily log) |
| Chunking | 400-token sliding window, 80-token overlap |
| Embedding | `text-embedding-3-small` (configurable via `OC_EMBED_MODEL`) |
| Hybrid retrieval | 70% cosine + 30% BM25-normalized (matching OpenClaw's documented architecture) |
| Temporal decay | Exponential, 30-day half-life: `score × exp(-λ × age)` |
| MMR re-ranking | λ=0.7, 4× topK candidates → top-6 |
| Top-K | 6 (OpenClaw default `maxResults`) |

### Prerequisites

- Node.js 20+ or Bun
- A Cortex API key (`CORTEX_API_KEY`)
- An OpenAI-compatible LLM API key (`LLM_API_KEY`)

### Quick Start

```bash
# Dry run — validates scaffold, no API calls
npx tsx benchmark/v1.1/run.ts --dry-run

# First run — extract memory notes + seed Cortex + evaluate
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1.1/run.ts --seed

# Subsequent runs — reuse seeded data + cached notes, only re-evaluate
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1.1/run.ts

# Force re-extract memory notes (if seed-data.json changed)
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1.1/run.ts --extract-notes

# Isolated trial namespace
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... npx tsx benchmark/v1.1/run.ts --namespace-suffix trial-a --seed

# Tuned run: shuffled prompts + multi-pass judge + higher concurrency
CORTEX_API_KEY=sk-cortex-... LLM_API_KEY=sk-... \
  npx tsx benchmark/v1.1/run.ts --shuffle-prompts --shuffle-seed 42 \
  --answer-concurrency 4 --judge-concurrency 4 --judge-passes 3
```

**Important:** Namespace defaults to `benchmark-v1.1`. Memory notes are cached after first extraction — use `--extract-notes` to force re-extraction. Only use `--seed` on the first run for a namespace.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORTEX_API_KEY` | Yes | — | Cortex API key |
| `CORTEX_BASE_URL` | No | AWS prod URL | Cortex API endpoint |
| `BENCHMARK_NAMESPACE` | No | `benchmark-v1.1` | Cortex namespace for seed data |
| `BENCHMARK_NAMESPACE_SUFFIX` | No | — | Optional suffix for isolated runs |
| `LLM_API_KEY` | Yes | — | OpenAI-compatible API key for answers, compaction, and note extraction |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM API endpoint |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model for answers, compaction, and note extraction |
| `JUDGE_API_KEY` | No | Falls back to `LLM_API_KEY` | Separate key for judge model |
| `JUDGE_BASE_URL` | No | Falls back to `LLM_BASE_URL` | Separate endpoint for judge |
| `JUDGE_MODEL` | No | `gpt-4.1-mini` | Model for scoring answers |
| `OC_EMBED_API_KEY` | No | Falls back to `LLM_API_KEY` | Key for OpenClaw embedding calls |
| `OC_EMBED_BASE_URL` | No | Falls back to `LLM_BASE_URL` | Endpoint for OpenClaw embeddings |
| `OC_EMBED_MODEL` | No | `text-embedding-3-small` | Embedding model for OC memory_search simulation |

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Synthetic scaffold run (no API calls) |
| `--seed` | `false` | Ingests 45 sessions into Cortex before evaluation |
| `--extract-notes` | `false` | Forces re-extraction of memory notes even if cache exists |
| `--debug-report` | `false` | Keeps full retrieval metadata in output JSON |
| `--namespace-suffix <suffix>` | — | Appends suffix to namespace base |
| `--shuffle-prompts` | `false` | Deterministically shuffles prompt order |
| `--shuffle-seed <int>` | `1337` | Seed used for prompt shuffle |
| `--answer-concurrency <int>` | `4` | Worker pool size for answer generation |
| `--judge-concurrency <int>` | `4` | Worker pool size for judge scoring |
| `--judge-passes <int>` | `1` | Judge passes per answer, aggregated by majority vote |
| `--extract-concurrency <int>` | `4` | Worker pool size for memory note extraction |
| `--cortex-top-k <int>` | `8` | Number of results to fetch from Cortex per prompt |

### Execution Phases

1. **Extract** — Per-session LLM extraction of memory notes from transcripts (simulates pre-compaction flush + daily log writing). Results cached to `oc-memory-notes.json`. Skipped if cache exists unless `--extract-notes` is set.

2. **Seed** — Ingests all 45 sessions into Cortex via async jobs. Retries up to 3× per session, polls all pending jobs in parallel (180s deadline). Only runs with `--seed`.

3. **Warmup** — Warms the Cortex tenant, runs `reflect` (entity consolidation across sessions), then generates a compacted summary from all 45 session transcripts.

4. **Retrieve** — Builds the OC memory index from extracted notes, embeds all 50 prompts, runs `memory_search` (hybrid + decay + MMR) and Cortex full-pipeline retrieval for each prompt.

5. **Answer** — For each prompt, generates 2 answers (OpenClaw native, OpenClaw + Cortex) using a configurable concurrency pool. Both conditions receive the same foundation: compacted summary + recent session notes.

6. **Judge** — Scores all 100 answers using the judge LLM on the 0–3 scale.

7. **Report** — Writes JSON to `benchmark/v1.1/results/` and prints a markdown summary table with per-category breakdown and per-prompt scores.

### Output

**Markdown table** printed to stdout:

```
| Category                       | OpenClaw | + Cortex | Delta  |
|--------------------------------|----------|----------|--------|
| **Overall Mean**               |     2.XX |     2.XX |  +0.XX |
| F: Factual (15)                |     ...  |     ...  |  ...   |
| R: Rationale (10)              |     ...  |     ...  |  ...   |
| E: Evolution (10)              |     ...  |     ...  |  ...   |
| S: Synthesis (8)               |     ...  |     ...  |  ...   |
| T: Temporal (7)                |     ...  |     ...  |  ...   |
```

**JSON results** saved to `benchmark/v1.1/results/run-{timestamp}.json`.

Footer shows full simulation config: OC chunk count, embed model, top-K, decay λ, MMR λ, notes extraction status, Cortex top-K, concurrency, judge passes.

### Evaluation Prompts

50 prompts across 5 categories:

| Category | Count | Tests |
|----------|-------|-------|
| F: Factual | 15 | Single verifiable specifics (port, TTL, key format, library versions) |
| R: Rationale | 10 | Why choices were made (Drizzle vs Prisma, iron-session vs JWT) |
| E: Evolution | 10 | How decisions changed over time (what replaced what, when) |
| S: Synthesis | 8 | Connecting info across multiple sessions |
| T: Temporal | 7 | Which version of a fact is current (port changed, TTL changed, auth migrated) |

### Seed Data

45 synthetic sessions covering a 6-week "Arclight" developer analytics platform project:

- **Weeks 1–2:** Project setup (bun + Fastify + Neon PostgreSQL + Drizzle), auth design (iron-session chosen over JWT), initial API routes
- **Weeks 3–4:** Feature work (Redis caching with ioredis, BullMQ jobs, SendGrid email), auth migration from JWT to iron-session in practice, cache TTL decisions
- **Weeks 5–6:** Performance optimization, testing (vitest, 80% coverage), CI/CD (GitHub Actions), observability (Pino, OpenTelemetry tracing planned)

Key design properties:
- Non-default specifics: port 4000, TTL 600s, key format `arclight:{entity}:{id}`, 30-day session expiry
- Deliberate contradictions: auth migrated from JWT → iron-session (week 4), email changed from Resend → SendGrid (week 4), cache TTL changed from 300s → 600s
- Rationale embedded: *why* Drizzle (type-safe, lightweight), *why* iron-session (simpler than JWT for this use case), *why* BullMQ (Redis already present)
- Cross-session dependencies: later sessions reference decisions from earlier sessions

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `CORTEX_API_KEY is required` | Set the environment variable |
| `LLM_API_KEY is required` | Required for note extraction, compaction, answers, and judge |
| Memory note extraction slow | Use `--extract-concurrency 8` or a faster model |
| Seed jobs timing out | 45 sessions takes ~3 minutes — increase the 180s deadline in `run.ts` if needed |
| OC index empty | Check that `oc-memory-notes.json` exists; run with `--extract-notes` to generate it |
| All OpenClaw answers scoring 1 | LLM abstaining — check that compacted summary and OC search results contain relevant data |
| Judge returning `null` scores | Judge failing to produce valid JSON — try a more capable judge model |
| `LLM API 429` | Rate limited — lower concurrency flags, retry, or use a higher-tier key |
| Result JSON is very large | Run without `--debug-report` (default is trimmed) |
