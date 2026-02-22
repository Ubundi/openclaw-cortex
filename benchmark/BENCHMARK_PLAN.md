# OpenClaw Cortex Benchmark Plan

**Version:** 0.4.0
**Date:** 2026-02-21
**Status:** V1 Complete — V1.1 Built (not yet run live) — V2 Planning

## Objective

Prove that an OpenClaw agent equipped with the Cortex memory plugin **performs measurably better** than one relying solely on OpenClaw's native memory system, and that the runtime overhead is acceptable.

The benchmark answers two questions in order of importance:

1. **"What does Cortex add over OpenClaw's built-in memory?"** — specific recall, grounded answers, reduced hallucination
2. **"What does it cost?"** — latency overhead, token usage, resource footprint

Cortex's raw retrieval quality is already proven via LongMemEval (82.9% single-session-user, 86.7% single-session-preference). We do not re-run that benchmark. Instead, we focus on the integration layer: **does the plugin improve the agent beyond what OpenClaw already provides?**

---

## OpenClaw's Native Memory System

OpenClaw uses a **file-first, multi-tier architecture** where plain Markdown is the canonical source of truth and the vector index is a derived, ephemeral search layer. The benchmark must compare against this full stack, not against a blank slate.

### Full Memory Hierarchy

| Layer | Location | Survives new session? | Detail fidelity | Notes |
|-------|----------|-----------------------|-----------------|-------|
| **`SOUL.md`** | `~/.openclaw/workspace/SOUL.md` | Yes — every session | Perfect (static) | Agent constitution — trust boundaries, tool limits, security invariants |
| **`USER.md`** | `~/.openclaw/workspace/USER.md` | Yes — every session | Perfect (static) | Operator preferences — timezone, formatting, risk tolerance |
| **`MEMORY.md`** | `~/.openclaw/workspace/MEMORY.md` | Yes — private sessions only | Perfect (curated) | Strategic facts, decisions, conventions. Exempt from temporal decay. Never loaded in group chats. |
| **Daily logs** | `memory/YYYY-MM-DD.md` | Rolling 48hr auto-load; older retrieved on demand | Append-only | Ephemeral session context — activities, tool outputs, tactical decisions |
| **Session transcripts** | `sessions/*.jsonl` | Not directly loaded | Raw (if QMD enabled) | Indexed by QMD backend. Stripped of system prompts + tool JSON before indexing. |
| **Embedding index** | `{agentId}.sqlite` | Rebuilt incrementally | Derived | FTS5 (BM25) + sqlite-vec (cosine similarity). SHA-256 per chunk for delta re-indexing. |

### Retrieval Pipeline

**Chunking:** 400-token sliding window, 80-token overlap (20%), line-aware with file path + line range metadata per chunk.

**Embedding fallback chain:** Local GGUF (node-llama-cpp) → OpenAI (batch API, 50% cost reduction) → Gemini → Voyage AI → BM25-only.

**Fusion (weighted linear, not RRF):**
```
Final Score = (0.70 × VectorScore) + (0.30 × NormalizedBM25Score)
```
BM25 normalized via `1/(1+rank)`. Union merge with `candidateMultiplier: 4` (fetches 4× results before fusion). OpenClaw explicitly rejects RRF because it flattens score magnitudes — a 0.99 cosine hit and a 0.71 hit become ordinal #1 and #2, losing confidence signal.

**Temporal decay:** Exponential with 30-day half-life. `MEMORY.md`, `SOUL.md`, and undated config files are exempt.

### Context Window Management and Compaction

**Auto-compact trigger:** `Context_Window - 20k reserve - 4k soft threshold` → fires at ~176k tokens on a 200k-token model.

**Pre-compaction memory flush:** Before compacting, OpenClaw injects a silent agentic turn instructing the agent to write lasting notes to the daily log (`memory/YYYY-MM-DD.md`). Only after this flush does compaction summarize the session.

**Known race condition:** The `memoryFlushCompactionCount` counter has a state synchronization bug. If compaction completes simultaneously with the flush, the dedup counters desynchronize, producing a "flush, skip, flush, skip" alternating pattern. **~50% of pre-compaction flushes are silently skipped** in active sessions — meaning compaction loses those facts regardless of the flush mechanism.

### What Compaction Loses

Compaction is the key competitor. Even in the best case (flush succeeds), it summarizes a 50-message session into a paragraph. This compression is lossy — and the race condition makes it lossier still:

| Information type | After compaction | After Cortex ingestion |
|-----------------|-----------------|----------------------|
| "Port 3001" | Becomes "set up a REST API" | Preserved as structured fact |
| "Cache key format `cache:{entity}:{id}`" | Dropped entirely | Preserved with exact format |
| "JWT secret loaded before dotenv" | Becomes "fixed an auth bug" | Preserved with root cause detail |
| "Always use named exports" | Diluted or lost in summary | Preserved as preference fact |
| "Chose Zod for TypeScript inference" | Becomes "made validation decisions" | Preserved with rationale |
| "Max 30-line functions" | Dropped from summary | Preserved as convention fact |

### Known Limitations (relevant to benchmark design)

1. **Recall degrades after months** — flat vector space saturates; old and current facts compete in the same embedding space, dropping accuracy to ~60-70%.
2. **No knowledge graph** — flat vector matching only; no relationship tracking between concepts.
3. **Cross-project noise** — single SQLite index per agent, no workspace isolation in search.
4. **Lossy compaction** — ~50% of pre-compaction flushes skipped due to race condition; compaction summaries lose tactical nuance.
5. **No memory consolidation** — files grow forever; no supersedes/contradicts/dedup logic.

**The core hypothesis:** Compaction preserves the gist but loses specifics, and the race condition bug means it loses even more than intended. Cortex preserves structured facts with full fidelity and retrieves the *relevant* ones via semantic search. The benchmark tests whether this difference matters in practice.

---

## V1: Quick Proof (Direct API, No OpenClaw Runtime)

V1 bypasses the need for a programmable OpenClaw runtime. It tests the recall path directly: seed data via the Cortex HTTP API, simulate what each memory system would provide as context, and evaluate which produces better answers.

**Goal:** Produce a publishable quality + latency scorecard in 2-3 days.

### V1 Architecture

```
seed-data.json ──► POST /v1/jobs/ingest/conversation ──► Cortex API (seeded)
     │                                                         │
     │                                                   /v1/retrieve
     │                                                         │
     ▼                                                         ▼
Generate compacted                                    Retrieved memories
summary of sessions                                   (structured facts)
     │                                                         │
     ▼                                                         ▼
LLM call with                                        LLM call with
compacted summary                                    compacted summary
(OpenClaw native)                                    + Cortex memories
     │                                                         │
     └──────────────────┬──────────────────────────────────────┘
                        ▼
               LLM judge scores both
               against ground truth
```

### V1.1 Seed Data

Create a fixture file with 8 synthetic conversation sessions covering distinct categories:

| Session | Content | Tests |
|---------|---------|-------|
| 1: Project setup | "We're using TypeScript, bun, vitest. The project is a REST API on port 3001." | Config values, tooling preferences |
| 2: Architecture decision | "We chose Zod over Joi because of TypeScript inference. The validation layer lives in src/validation/." | Decision recall, architecture |
| 3: Bug fix | "Found a race condition in the WebSocket handler — the heartbeat timer wasn't cleared on disconnect." | Bug recall, technical details |
| 4: User preferences | "Always use named exports. Never auto-commit. Put types in a separate types.ts." | Preference retention |
| 5: Feature work | "Built a caching layer using Redis. TTL is 300s. Cache key format is `cache:{entity}:{id}`." | Implementation details |
| 6: Code review | "We agreed to keep functions under 30 lines. No default exports. Error messages must include the operation name." | Convention recall |
| 7: Debugging session | "The auth middleware was failing silently because the JWT secret was read from process.env at import time, before dotenv loaded." | Root cause recall |
| 8: Planning | "Next sprint: add rate limiting (express-rate-limit), migrate to Drizzle ORM, and add OpenTelemetry tracing." | Future plans, library choices |

Each session is a list of `{role, content}` messages that will be ingested via `POST /v1/jobs/ingest/conversation`.

#### Seed Data Design Principles

The seed data must contain information that survives compaction poorly — specifics that a summary would drop or dilute:

- Use non-default values: port 3001 not 3000, TTL 300s not 60s
- Use specific but less-common tools: Drizzle not Prisma, bun not npm
- Include project-specific details: exact cache key formats, specific file paths, particular bug root causes
- Include rationale and context: *why* a choice was made, not just *what* was chosen
- Include conventions with specific thresholds: "30 lines" not "keep functions short"

### V1.2 Generating the Compacted Baseline

To simulate OpenClaw's native memory fairly, we generate a compacted summary of all 8 sessions. This represents what the agent would have after running `/compact` or auto-compaction.

**Method:** Use an LLM to produce a compacted summary of the seed sessions, using the same approach OpenClaw's compaction would:

```typescript
const compactedSummary = await llm.chat([
  { role: "system", content: "Summarize the following conversation sessions into a concise memory summary. Capture the key topics, decisions, and direction of work. Be concise — this summary replaces the full transcripts." },
  { role: "user", content: allSessionTranscripts }
]);
```

This produces something like:
> "Working on a TypeScript REST API. Using bun and vitest. Made architecture decisions around validation (chose Zod). Fixed bugs in WebSocket handler and auth middleware. Established coding conventions. Using Redis for caching. Planning to add rate limiting, migrate to Drizzle ORM, and add OpenTelemetry."

This summary is **realistic** — it's what compaction actually produces. The specifics (port 3001, cache key format, JWT root cause, 30-line rule) are lost.

### V1.3 Evaluation Prompts

40 prompts across 4 categories, each with a ground truth answer derived from the seed data:

#### Category A: Specific Detail Recall (15 prompts)

Questions with a single verifiable answer that compaction would lose.

| # | Prompt | Ground Truth | Source Session | Compaction retains? |
|---|--------|-------------|---------------|-------------------|
| 1 | "What port does the dev server run on?" | 3001 | Session 1 | No — summarized as "REST API" |
| 2 | "What's the cache TTL we're using?" | 300 seconds | Session 5 | No — dropped |
| 3 | "What format are our cache keys?" | `cache:{entity}:{id}` | Session 5 | No — dropped |
| 4 | "What caused the auth middleware to fail?" | JWT secret read before dotenv loaded | Session 7 | No — summarized as "fixed auth bug" |
| 5 | "What ORM are we migrating to?" | Drizzle | Session 8 | Maybe — may survive as "Drizzle" |
| ... | *(15 total)* | | | |

#### Category B: Decision & Rationale Recall (10 prompts)

Questions that require remembering *why* a choice was made — the rationale, not just the choice.

| # | Prompt | Ground Truth | Source Session | Compaction retains? |
|---|--------|-------------|---------------|-------------------|
| 1 | "Why did we choose Zod over Joi?" | TypeScript inference support | Session 2 | No — "chose Zod" but not why |
| 2 | "Why was the WebSocket handler failing?" | Race condition — heartbeat timer not cleared on disconnect | Session 3 | No — "fixed WebSocket bug" |
| ... | *(10 total)* | | | |

#### Category C: Preference & Convention (10 prompts)

Prompts where the correct behavior depends on a previously stated preference or convention.

| # | Prompt | Expected Behavior | Source Session | Compaction retains? |
|---|--------|------------------|---------------|-------------------|
| 1 | "Should I use default or named exports?" | Named exports | Session 4 | No — "established conventions" |
| 2 | "Where should I put the type definitions?" | Separate types.ts file | Session 4 | No — dropped |
| 3 | "What's our max function length rule?" | 30 lines | Session 6 | No — "coding conventions" |
| ... | *(10 total)* | | | |

#### Category D: Cross-Session Synthesis (5 prompts)

Questions that require connecting information from multiple sessions.

| # | Prompt | Ground Truth | Source Sessions | Compaction retains? |
|---|--------|-------------|----------------|-------------------|
| 1 | "What testing and validation tools are we using?" | vitest + Zod | Sessions 1, 2 | Partially — may list tools |
| 2 | "What libraries are we adding next and what do we already use for caching?" | Adding express-rate-limit, Drizzle, OpenTelemetry; already using Redis | Sessions 5, 8 | Partially |
| ... | *(5 total)* | | | |

The "Compaction retains?" column is key — it makes the benchmark hypothesis explicit and testable per prompt.

### V1.4 Scoring

#### The Three Conditions

For each of the 40 prompts, the script runs **three LLM calls**:

```typescript
// CONDITION 1 — No memory (fresh session, nothing)
const bareResponse = await llm.chat([
  { role: "system", content: "You are a coding assistant." },
  { role: "user", content: prompt }
]);

// CONDITION 2 — OpenClaw native (compacted summary only)
const compactedResponse = await llm.chat([
  { role: "system", content: "You are a coding assistant." },
  { role: "user", content: `Here is context from previous sessions:\n${compactedSummary}\n\n${prompt}` }
]);

// CONDITION 3 — OpenClaw + Cortex (compacted summary + recalled memories)
const cortexResponse = await llm.chat([
  { role: "system", content: "You are a coding assistant." },
  { role: "user", content: `Here is context from previous sessions:\n${compactedSummary}\n\n${cortexMemoriesXml}\n\n${prompt}` }
]);
```

This gives us a **three-way comparison**:
1. **No memory** — the absolute floor (fresh session, blank slate)
2. **Compacted** — what OpenClaw gives you today
3. **Compacted + Cortex** — what OpenClaw gives you with the plugin

The real story is the delta between conditions 2 and 3. Condition 1 provides a floor reference.

#### Retrieval Hit (automated, no LLM needed)

Did `/v1/retrieve` return results containing the relevant information?

- **hit**: at least one result contains a keyword/phrase from the ground truth
- **miss**: no results are relevant
- **partial**: results are tangentially related but don't contain the key fact

Metric: `retrieval_hit_rate` = hits / total prompts

#### Answer Quality (LLM-as-judge)

A separate judge LLM (GPT-4o recommended to avoid self-evaluation bias) scores each response on a 4-point scale:

| Score | Label | Meaning | Example |
|-------|-------|---------|---------|
| 3 | **Grounded correct** | Correct with project-specific detail | "You chose Zod because of TypeScript inference — the validation layer is in src/validation/" |
| 2 | **Generic correct** | Correct in general terms but lacks project specifics | "Zod is a good choice for TypeScript validation" |
| 1 | **Abstained** | "I don't have that context" — honest, not harmful | "I don't have information about your validation library choices" |
| 0 | **Hallucinated** | Fabricated a specific but wrong answer | "You chose Joi because of its plugin ecosystem" |

**Expected distribution:**

```
                      No Memory      Compacted        Compacted + Cortex
Grounded (3)            ~0%           ~10-20%            ~70-85%
Generic (2)           ~20-30%         ~30-40%            ~5-10%
Abstained (1)         ~40-50%         ~20-30%            ~5%
Hallucinated (0)      ~20-30%         ~10-20%            ~5-10%
```

The story: **Compaction gets you from "I don't know" to "vaguely right." Cortex gets you from "vaguely right" to "exactly right with specifics."**

#### Metrics

- `mean_score_bare`: mean score (0-3) across all prompts with no memory
- `mean_score_compacted`: mean score (0-3) with compacted summary only
- `mean_score_cortex`: mean score (0-3) with compacted summary + Cortex memories
- `delta_cortex_vs_compacted`: the improvement Cortex adds over native memory
- `delta_cortex_vs_bare`: the total improvement over no memory
- `grounded_rate` per condition: % of prompts scoring 3
- `hallucination_rate` per condition: % of prompts scoring 0
- `retrieval_hit_rate`: % of prompts where relevant facts were returned by `/v1/retrieve`
- Per-category breakdowns for all metrics (A: specific detail, B: decision/rationale, C: preference/convention, D: cross-session)

### V1.5 Latency Collection

Measured alongside every `/v1/retrieve` call during the evaluation run. No extra infrastructure needed.

| Metric | How |
|--------|-----|
| `retrieve_ms` per call | `Date.now()` around each fetch |
| `retrieve_p50`, `retrieve_p95` | Computed from all 40 calls |
| Fast vs full comparison | Run all 40 prompts in both modes |
| Token overhead | Count characters in returned results, estimate tokens |

### V1.6 Output

A single JSON results file + a markdown summary table. See `benchmark/RUN_GUIDE.md` for full results and interpretation.

**First run results (2026-02-20, gpt-4o-mini answers, gpt-4.1-mini judge, clean Cortex tenant):**

```
┌──────────────────────────────┬──────────┬──────────┬──────────┬──────────────┐
│ Metric                       │ No Mem   │Compacted │ + Cortex │ Cortex Delta │
├──────────────────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ QUALITY (40 prompts)         │          │          │          │              │
│ Mean score (0-3)             │   1.35   │   2.40   │   2.73   │  +0.33       │
│ Grounded correct (score 3)   │  2.5%    │  50.0%   │  72.5%   │  +22.5pp     │
│ Generic correct (score 2)    │  35.0%   │  40.0%   │  27.5%   │              │
│ Abstained (score 1)          │  57.5%   │  10.0%   │   0.0%   │              │
│ Hallucinated (score 0)       │   5.0%   │   0.0%   │   0.0%   │  -5.0pp      │
├──────────────────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ BY CATEGORY (mean score 0-3) │          │          │          │              │
│ A: Specific detail (15)      │   1.33   │   2.60   │   2.80   │  +0.20       │
│ B: Decision/rationale (10)   │   1.50   │   1.80   │   2.80   │  +1.00       │
│ C: Preference/convention (10)│   1.40   │   2.70   │   2.70   │  +0.00       │
│ D: Cross-session (5)         │   1.00   │   2.40   │   2.40   │  +0.00       │
├──────────────────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ LATENCY (retrieve only)      │          │          │          │              │
│ Fast mode p50                │  N/A     │  N/A     │   701ms  │              │
│ Fast mode p95                │  N/A     │  N/A     │  1057ms  │              │
│ Full mode p50                │  N/A     │  N/A     │   937ms  │              │
│ Full mode p95                │  N/A     │  N/A     │  1501ms  │              │
└──────────────────────────────┴──────────┴──────────┴──────────┴──────────────┘
```

**Key finding:** Cortex's largest gain is on Category B (decision/rationale: +1.00). Compaction records *what* was decided but loses *why*. Categories C and D show +0.00 delta — simple rules survive summarization, and cross-session synthesis remains a harder retrieval problem for both conditions.

**Tenant hygiene note:** A polluted tenant (duplicate data from failed seeding runs) produced identical quality scores but 3-4x worse latency (fast p50: 2063ms vs 701ms). Duplicate data doesn't hurt retrieval accuracy but significantly degrades performance.

### V1.7 Implementation Checklist

```
benchmark/
├── v1/
│   ├── run.ts                  # Single-file orchestrator
│   ├── seed-data.json          # 8 conversation sessions
│   ├── prompts.json            # 40 evaluation prompts + ground truth
│   └── results/                # Git-ignored output
│       └── .gitkeep
```

- [x] Create `seed-data.json` with 8 sessions (realistic multi-turn conversations)
- [x] Create `prompts.json` with 40 prompts, ground truth, category tags, and "compaction retains?" flags
- [x] Generate compacted summary from seed sessions (generated live in warmup phase, not stored as a fixture)
- [x] Write `run.ts`:
  - [x] Seed: ingest all sessions via `/v1/jobs/ingest/conversation`, poll jobs until complete
  - [x] Retrieve: for each prompt, call `/v1/retrieve` (fast + full), record results + latency
  - [x] Answer: for each prompt, run 3 LLM calls (bare, compacted, compacted + cortex)
  - [x] Judge: score all 120 responses (40 prompts x 3 conditions) via judge LLM
  - [x] Report: write JSON results + print markdown summary
- [x] Run against live Cortex API and collect first results

**Additional features implemented beyond the initial plan:**
- `--dry-run` flag for scaffold validation without API calls
- `--namespace-suffix` for isolated trial namespaces per run
- `--shuffle-prompts` / `--shuffle-seed` for randomized prompt ordering
- `--answer-concurrency` / `--judge-concurrency` worker pool controls
- `--judge-passes` multi-pass voting for score stability
- `--debug-report` flag to preserve full retrieval payloads in JSON output
- Separate `JUDGE_MODEL` / `JUDGE_API_KEY` support for avoiding self-evaluation bias
- Error-resilient retrieval (failed calls continue with empty results rather than crashing)

**Estimated cost:** 8 ingestion jobs + 80 retrieve calls (40 fast + 40 full) + 120 answer LLM calls + 120 judge LLM calls. Low cost, high signal.

---

## V1.1: OpenClaw Native vs OpenClaw + Cortex (Proper Full-Stack Baseline)

**Status:** Built and dry-run validated. Not yet run live.

V1.1 addresses the fundamental weakness of V1: the compaction-only baseline significantly underestimates what a real OpenClaw agent gets. V1.1 simulates OpenClaw's complete memory stack and uses a much larger, temporally complex dataset to stress-test Cortex's architectural differentiators.

### What Changed from V1

| Aspect | V1 | V1.1 |
|--------|----|-------|
| Baseline conditions | Bare / Compacted / + Cortex | OpenClaw native / OpenClaw + Cortex |
| Baseline memory | Compacted summary only | Compacted summary + recent injection + `memory_search` |
| Retrieval simulation | None | Hybrid 70% cosine + 30% BM25, temporal decay, MMR |
| Indexed content | Raw transcripts (never implemented) | LLM-extracted memory notes (simulates MEMORY.md / daily logs) |
| Recent session injection | No | Yes — last 2 sessions' notes always in context |
| Temporal decay | No | Yes — 30-day half-life exponential |
| MMR re-ranking | No | Yes — λ=0.7, 4× candidate pool |
| Dataset | 8 sessions (9 chunks) | 45 sessions, 6-week "Arclight" project |
| Prompt count | 40 | 50 |
| Prompt categories | A/B/C/D | F/R/E/S/T |
| Temporal prompts | No | Yes (Category T: 7 prompts) |
| Evolution prompts | No | Yes (Category E: 10 prompts) |

### V1.1 Architecture

```
Phase 0: Extract                Phase 1: Seed (--seed only)
  45 sessions                     POST /v1/jobs/ingest/conversation × 45
  → LLM extracts notes            → poll until complete (180s)
  → oc-memory-notes.json          → /v1/reflect (entity consolidation)
  (cached, reused on reruns)
                                        │
Phase 3: Build OC Index + Retrieve      │
  notes → 400-token chunks       ◄──────┘
  → embed (text-embedding-3-small)
  → BM25 index                   Phase 2: Warmup + Compaction
  → for each prompt:               /v1/warmup
      hybrid search (70/30)         → compacted summary of all 45 sessions
      + temporal decay (30d)        → recentNotes = last 2 sessions' notes
      + MMR (λ=0.7)
      → OC top-6 results
      + /v1/retrieve (full, top-8)
      → Cortex results

Phase 4: Answer
  sharedFoundation = compacted + recentNotes
  Condition A (OpenClaw): sharedFoundation + OC memory_search results
  Condition B (Cortex):   sharedFoundation + Cortex retrieved memories

Phase 5: Judge → Phase 6: Report
```

### V1.1 Dataset: Arclight Project

45 sessions simulating a 6-week developer analytics platform build:

| Period | Sessions | Content |
|--------|----------|---------|
| Week 1–2 | s01–s18 | Project setup, auth design (iron-session chosen), DB schema, initial routes |
| Week 3–4 | s19–s36 | Redis caching (ioredis, TTL 300s→600s), BullMQ, email (Resend→SendGrid), JWT→iron-session migration |
| Week 5–6 | s37–s45 | Performance, vitest testing, GitHub Actions CI, observability planning |

Key differentiators from V1 seed data:
- **Deliberate fact evolution:** auth migrated JWT → iron-session (week 4), email Resend → SendGrid (week 4), cache TTL 300s → 600s
- **Non-default specifics:** port 4000, key format `arclight:{entity}:{id}`, 30-day session cookie, snake_case tables, UUID PKs
- **Rationale embedded:** why Drizzle (type-safe, lightweight), why iron-session (simpler for session scale), why BullMQ (Redis already present)
- **At scale:** 45 sessions produce enough chunks that cosine similarity degrades — retrieval becomes non-trivial

### V1.1 Evaluation Prompts

50 prompts across 5 categories:

| Category | Count | What it tests | Cortex differentiator |
|----------|-------|---------------|----------------------|
| F: Factual | 15 | Single verifiable specifics (port, TTL, key format, package) | Recall precision under scale |
| R: Rationale | 10 | Why choices were made | Context preservation (rationale lives in original session, not summary) |
| E: Evolution | 10 | How decisions changed over time | Surfacing history vs current state |
| S: Synthesis | 8 | Connecting info across sessions | Graph traversal vs flat retrieval |
| T: Temporal | 7 | Which version of a fact is current | SUPERSEDES chain vs decayed flat retrieval |

Category T is the strongest test of Cortex's SUPERSEDES mechanism — these prompts ask for the *current* value of facts that changed during the project (auth method, email provider, cache TTL).

### V1.1 OpenClaw Simulation Constants

Fixed to match OpenClaw's documented architecture — not tunable:

```typescript
const OC_TOP_K = 6;                    // OpenClaw default maxResults
const OC_MMR_LAMBDA = 0.7;            // diversity vs relevance balance
const OC_DECAY_HALF_LIFE_DAYS = 30;   // temporal decay rate
const OC_MMR_CANDIDATES = 4;          // candidates = topK × 4 before MMR
```

### V1.1 Implementation Checklist

```
benchmark/
├── v1.1/
│   ├── run.ts                  # Single-file orchestrator (v1.1)
│   ├── seed-data.json          # 45 session Arclight dataset
│   ├── prompts.json            # 50 evaluation prompts + ground truth
│   ├── oc-memory-notes.json    # Cached extracted memory notes (git-ignored)
│   └── results/                # Git-ignored output
│       └── .gitkeep
```

- [x] Create `seed-data.json` with 45 sessions (6-week Arclight project lifecycle)
- [x] Create `prompts.json` with 50 prompts, ground truth, F/R/E/S/T categories
- [x] Write `run.ts`:
  - [x] Phase 0: Memory note extraction (LLM per session, cached to `oc-memory-notes.json`)
  - [x] Phase 1: Seed Cortex (45 sessions via `/v1/jobs/ingest/conversation`, poll + reflect)
  - [x] Phase 2: Warmup + reflect + compaction (generates compacted summary)
  - [x] Phase 3: Build OC memory index + retrieve (hybrid search + Cortex full-pipeline)
  - [x] Phase 4: Answer (2 conditions, shared foundation, configurable concurrency)
  - [x] Phase 5: Judge (configurable passes, majority vote aggregation)
  - [x] Phase 6: Report (JSON + markdown summary with per-prompt table)
- [x] Dry-run validated (all 50 prompts, 2 conditions, correct output format)
- [ ] Run against live Cortex API and collect first results

**Additional features in V1.1 beyond V1:**
- `--extract-notes` flag to force re-extraction of memory notes
- `--extract-concurrency` for parallel note extraction
- `--cortex-top-k` for Cortex result count (separate from fixed OC top-6)
- `OC_EMBED_MODEL` / `OC_EMBED_API_KEY` / `OC_EMBED_BASE_URL` for embedding configuration
- Per-prompt breakdown table in console output
- `recentNotes` field preserved in report JSON for debugging

**Estimated cost (live run):** 45 note extractions + 45 ingestion jobs + 1 reflect + 1 compaction + 50 prompt embeddings + chunk embeddings + 50 Cortex retrievals + 100 answer LLM calls + 100 judge LLM calls.

---

## V2: Full Agent Loop (Requires OpenClaw Runtime)

V2 tests the complete integration: the plugin running inside OpenClaw, injecting memories via `prependContext`, with OpenClaw's full memory stack active (sessions, pruning, compaction, workspace files).

**Prerequisite:** A way to programmatically run OpenClaw agent sessions and capture turn-level events (hook timing, injected context, agent response). If OpenClaw doesn't expose this, we build a minimal simulation harness that mimics the plugin API contract.

### V2.1 What V2 Adds Over V1

| Aspect | V1 | V2 |
|--------|----|----|
| Baseline | Simulated compaction | Real OpenClaw compaction + pruning |
| Retrieval | Direct API call | Through plugin recall handler (query construction, top_k, mode, timeout) |
| Memory formatting | Raw API results as XML | Plugin's `<cortex_memories>` XML with safety preamble |
| Agent behavior | Isolated LLM call | Full agent turn with tool use, multi-step reasoning |
| Capture testing | Not tested | Verify auto-capture extracts useful facts from agent turns |
| File sync testing | Not tested | Verify MEMORY.md / daily log changes reach Cortex |
| Compaction interaction | Simulated | Real compaction + Cortex working together |
| End-to-end latency | Retrieve only | Full turn: hook dispatch → retrieve → format → LLM → response |

### V2.2 Multi-Session Continuity

Simulate a 5-session development arc where each session builds on the previous:

1. **Session 1:** Design — "Let's plan a caching layer for the API"
2. **Session 2:** Implement — "Start building what we designed"
3. **Session 3:** Test — "Write tests for the caching layer"
4. **Session 4:** Debug — "The cache is returning stale data, help me fix it"
5. **Session 5:** Refactor — "Clean up the caching implementation"

Between sessions: auto-capture ingests the transcript, compaction runs on the OpenClaw side. The next session tests whether the agent references prior specifics (not just the gist).

**Metrics:**
- `context_retained`: % of key decisions from session N referenced in session N+1
- `specific_detail_retained`: % of specific values/formats/thresholds retained (vs. only the gist)
- `redundant_questions`: count of times the agent asks for info it was previously given
- `continuity_score`: LLM-judge rating (1-5) of how seamlessly sessions connect

### V2.3 Performance Benchmarks

Full overhead measurement of the plugin inside the OpenClaw process:

#### Turn Latency

| Scenario | Plugin State | What it measures |
|----------|-------------|-----------------|
| Baseline | No plugin loaded | Pure OpenClaw turn time |
| Plugin loaded, recall off | `autoRecall: false` | Overhead of having the plugin installed |
| Fast mode | `recallMode: "fast"` | Typical recall overhead |
| Full mode | `recallMode: "full"` | Maximum recall overhead |
| Cold start | Fresh ECS container | Worst-case first turn |

Metrics: `turn_latency_p50`, `turn_latency_p95`, `turn_latency_p99` per scenario. Minimum 50 turns per scenario.

#### Resource Footprint

| Resource | How to collect | Frequency |
|----------|---------------|-----------|
| Heap used (MB) | `process.memoryUsage().heapUsed` | Every 5s |
| RSS (MB) | `process.memoryUsage().rss` | Every 5s |
| Event loop delay (ms) | `perf_hooks.monitorEventLoopDelay()` | Histogram per minute |
| Network calls (count) | Intercepted fetch counter | Cumulative |

Scenarios: idle (5 min), active (10 turns), sustained (50 turns / 30 min — check for leaks).

#### Context Window Token Overhead

Measure tokens in `prependContext` across varied queries with `top_k` values of 1, 5, 10, 20.

Metrics: `tokens_injected_p50`, `context_budget_pct` (as % of model context limit).

#### Failure Modes

| Scenario | Setup | Expected |
|----------|-------|----------|
| API down | Block network | ~0ms overhead after 3 failures (cold-start cooldown) |
| Slow API | Mock with 3s delay | Timeout at `recallTimeoutMs` boundary |
| Sustained failures | 100+ failed captures | RetryQueue caps at 100 tasks, memory stable |
| Recovery | Restore after 30s outage | Recall resumes within one turn |

### V2.4 Infrastructure

```
benchmark/
├── v1/                         # (from V1, kept as-is)
│   ├── run.ts
│   ├── seed-data.json
│   ├── prompts.json
│   └── results/
│
├── v2/
│   ├── harness.ts              # Agent session simulator / OpenClaw integration
│   ├── scenarios/
│   │   ├── quality.ts          # 40-prompt quality evaluation through plugin
│   │   ├── continuity.ts       # 5-session multi-session arc
│   │   ├── latency.ts          # Turn latency across modes
│   │   └── failure.ts          # Degraded API scenarios
│   ├── mock-server.ts          # Local mock Cortex API for failure/latency testing
│   ├── collectors/
│   │   ├── latency.ts          # Turn timing
│   │   ├── tokens.ts           # Context window measurement
│   │   └── resources.ts        # Memory, event loop
│   └── results/
│       └── .gitkeep
│
├── shared/
│   ├── seed-data.json          # Shared seed data (used by both V1 and V2)
│   ├── prompts.json            # Shared evaluation prompts
│   ├── judge.ts                # LLM-as-judge scorer
│   └── reporter.ts             # Markdown + JSON output
│
└── results/                    # Aggregated results across versions
    └── .gitkeep
```

---

## Cortex API — Architecture Reference & Proposed Changes

### API Architecture Reference

The Cortex API (`Ubundi/cortex`) is a Python-based memory backend with a 5-way hybrid retrieval pipeline:

1. **BM25** — keyword search over fact content, phrasings, entity refs
2. **Semantic** — embedding cosine similarity
3. **Question matching** — query matched against pre-generated question embeddings per fact
4. **Temporal** — date/time phrase resolution and proximity scoring
5. **Graph traversal** — spreading activation from seed results (full mode only)

Results are fused via RRF, optionally reranked by cross-encoder (full mode only), then token-budget packed.

The `MemoryReflector` synthesizes cross-session observation nodes from entity-scoped fact clusters. These are stored as FACT nodes retrievable through all 5 channels — Cortex gets smarter over time, not just larger.

### Fast vs Full Mode

The plugin maps `recallMode` to the API's `mode` parameter:

| Plugin Mode | API Mode | Pipeline Stages | Expected Latency |
|-------------|----------|----------------|-----------------|
| `fast` | `fast` | BM25 + semantic + question + temporal → RRF fusion | 80-150ms server |
| `balanced` | `fast` | Same as fast (mapped at plugin level) | 80-150ms server |
| `full` | `full` | All of fast + graph traversal + cross-encoder reranker | 300-600ms server |

V1 benchmarks both modes on the same prompts to measure the quality/latency tradeoff. V1.1 uses `full` mode only (Cortex's complete pipeline with graph traversal).

### Proposed API Changes

These are **not required for V1 or V2** but would improve diagnostic depth for future benchmarking.

#### P1 — Server-Side Timing Headers (Low effort)

Add response headers to `/v1/retrieve`:

```
X-Cortex-Processing-Ms: 145
X-Cortex-Pipeline-Mode: fast
X-Cortex-Channels-Used: bm25,semantic,question
```

Enables: `total_ms = network_ms + server_processing_ms` decomposition.

#### P2 — `/v1/stats` Endpoint (Low effort)

`GET /v1/stats` returning node/edge counts by type. Enables: verify ingestion completeness before evaluation runs.

#### P3 — Retrieval Debug Mode via API (Medium effort)

Add `debug: true` to `/v1/retrieve` request body. Response includes `_debug` object with per-channel scores, fusion counts, per-stage timing. Enables: diagnose why a specific recall succeeded or failed.

#### P4 — Ingestion Job Result Summary (Low effort)

When `/v1/jobs/:jobId` returns `completed`, include `facts_extracted`, `nodes_created`, `edges_created`, `processing_ms`. Enables: verify extraction quality before running retrieval.

#### P5 — Reflect Response Detail (Medium effort, blocked on /v1/reflect deploy)

Include cluster-level detail in reflect response: entity name, facts analyzed, observations created. Enables: measure reflection effectiveness.

---

## Open Questions

1. **OpenClaw test runtime** — Do we have a way to programmatically run OpenClaw agent sessions? This blocks V2 but not V1 or V1.1. *(V1/V1.1 unblocked — both bypass runtime entirely.)*
2. **LLM judge model** — GPT-4o avoids self-evaluation bias if the agent under test uses Claude. For V1/V1.1 this is the judge for answer quality scoring. *(Resolved for V1/V1.1: using `gpt-4.1-mini` as judge, configurable via `JUDGE_MODEL`.)*
3. **Compaction fidelity** — The V1/V1.1 compacted summary is generated by a one-shot LLM call. Real OpenClaw compaction may behave differently (incremental, per-session). For V2, we should use actual OpenClaw compaction output. *(V1/V1.1 use deterministic one-shot compaction with `temperature=0`. V2 should capture real compaction output.)*
4. **Namespace isolation** — V1/V1.1 needs a clean Cortex namespace per run. Does the API support namespace deletion/reset, or do we need a fresh namespace each time? *(Resolved: namespace maps to `session_id`, not server-side tenant isolation — all data shares the tenant for a given API key. Use `--namespace-suffix` to isolate runs logically. Polluted tenants from old runs degrade latency 3-4x but do not affect quality scores.)*
5. **Reflect endpoint** — `/v1/reflect` currently returns 404. V1 and V1.1 quality tests work without it; V1.1 calls reflect post-seed but handles failure gracefully. Add reflection benchmarks when it ships. *(Still outstanding.)*
6. **Compaction variability** — Compaction output varies by LLM run. *(Resolved for V1/V1.1: compacted summary is regenerated each run at `temperature=0`, making it deterministic for a given model and transcripts.)*
7. **Retrieval deduplication** — V1 analysis revealed Cortex returns semantically near-duplicate results from different sessions, consuming result slots. Categories C and D showed +0.00 delta. V1.1 addresses this partly by using `reflect` post-seed for entity consolidation, and by using a larger dataset where result diversity becomes more meaningful. *(Partially addressed — server-side deduplication still a proposed improvement.)*
8. **Cross-session synthesis gap** — V1 Category D (cross-session) scored 2.40 for both conditions. V1.1 Category S and T directly target this with 15 prompts requiring synthesis and temporal reasoning. *(Being tested in V1.1 — results pending first live run.)*
9. **Memory note extraction quality** — V1.1 uses LLM-extracted notes to simulate OpenClaw's MEMORY.md/daily logs. The extraction quality (what facts get preserved vs dropped) affects the fairness of the OpenClaw baseline. *(Open — review extraction prompts after first live run.)*
10. **OpenClaw simulation accuracy** — The V1.1 OC simulation is an approximation. Real OpenClaw also has workspace files (SOUL.md, USER.md), pruning, and the memory flush race condition (~50% skip rate). These are not simulated — the benchmark gives OpenClaw a slightly optimistic baseline. *(Acceptable for V1.1 — V2 should use real OpenClaw runtime.)*
