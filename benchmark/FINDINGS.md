# Benchmark Findings

> Does adding Cortex to an already-functional OpenClaw agent make its recall better, and on which question types?

---

## Short Answer

**Yes, and the signal is consistent across dataset sizes and pipeline maturity.** On V1 (8 sessions, Tier 1 cold), Cortex adds +0.10 overall on top of OpenClaw's compacted summary + `memory_search`. On V1.1 (45 sessions, Tier 3 mature, 3-pass judge), Cortex adds +0.10 overall against a full-fidelity OpenClaw baseline, with **+0.50 on rationale** and **+0.33 on synthesis**. The gain concentrates in **decision rationale** and **cross-session synthesis** — the question types where compaction is lossy and Cortex's structured entity memory has an architectural edge. A residual regression remains on "current state after migration" queries, where Cortex's thorough retrieval surfaces historical context that confuses the LLM where OpenClaw's temporal decay would have de-emphasised it.

---

## V1 Benchmark

### Methodology

Three-way comparison across 40 prompts drawn from 8 synthetic dev sessions:

| Condition | What the agent has |
|---|---|
| **Bare** | No memory — raw LLM only |
| **OpenClaw** | Compacted summary + `memory_search` (400-token chunks, 70% vector + 30% BM25, top-6) |
| **OC+Cortex** | Everything OpenClaw has, plus Cortex full-mode retrieval (top-10) |

Prompts span 4 categories:
- **A (15):** Specific facts — port numbers, config values, file paths, package choices
- **B (10):** Decision rationale — why X was chosen over Y
- **C (10):** Preferences/conventions — coding standards, workflow rules
- **D (5):** Cross-session synthesis — facts that span multiple sessions

Each answer is judged 0–3:
- **3** — Grounded correct (contains the specific project detail)
- **2** — Generic correct (reasonable but missing the specific)
- **1** — Abstained
- **0** — Hallucinated

### Results (Feb 23, 2026, commit `33a4a20`)

| Category | Bare | OpenClaw | OC+Cortex | OC vs Bare | +Cortex vs OC |
|---|---|---|---|---|---|
| **Overall** | 1.35 | 2.75 | **2.85** | +1.40 | **+0.10** |
| A: Specific facts (15) | 1.27 | 2.87 | 2.87 | +1.60 | 0.00 |
| B: Decision rationale (10) | 1.60 | 3.00 | 3.00 | +1.40 | 0.00 |
| C: Preferences/conventions (10) | 1.40 | 2.40 | **2.70** | +1.00 | **+0.30** |
| D: Cross-session synthesis (5) | 1.00 | 2.60 | **2.80** | +1.60 | **+0.20** |

| Score | Meaning | Bare | OpenClaw | OC+Cortex |
|---|---|---|---|---|
| 3 | Grounded correct | 3 | 30 | **34** |
| 2 | Generic correct | 10 | 10 | 6 |
| 1 | Abstained | 25 | 0 | 0 |
| 0 | Hallucinated | 2 | 0 | 0 |

Pipeline: Tier 1, maturity cold, 81 memories, 8 sessions.

---

## V1.1 Benchmark

### Methodology

Two-way comparison across 50 prompts drawn from 45 synthetic dev sessions (6-week "Arclight" project). The OpenClaw baseline is now a full-fidelity simulation — not compaction-only.

| Condition | What the agent has |
|---|---|
| **OpenClaw** | Compacted summary + recent session notes (last 2 sessions, always injected) + `memory_search` (LLM-extracted notes, 70% cosine + 30% BM25, temporal decay, MMR, top-6) |
| **OC+Cortex** | Everything above, plus Cortex full-pipeline retrieval (Tier 3: semantic + BM25 + question-matching + temporal + graph traversal, reranker enabled, top-8) |

Prompts span 5 categories:
- **F (15):** Factual — single verifiable specifics (port, TTL, key format, library)
- **R (10):** Rationale — why choices were made
- **E (10):** Evolution — how decisions changed over time
- **S (8):** Synthesis — connecting facts across multiple sessions
- **T (7):** Temporal — which version of a fact is current after migrations

### Results — 1-pass (Feb 24, 2026, commit `bb21444`, warm Tier 3)

Pipeline state at run time: Tier 3 mature, 695 nodes (492 FACT, 90 ENTITY), 1907 edges (179 MENTIONS, 811 ELABORATES, 223 SUPPORTS, 66 CONTRADICTS).

| Category | OpenClaw | OC+Cortex | Delta |
|---|---|---|---|
| **Overall** | 2.49 | **2.54** | **+0.05** |
| F: Factual (15) | 2.79 | 2.73 | -0.06 |
| R: Rationale (10) | 2.30 | **2.60** | **+0.30** |
| E: Evolution (10) | 2.70 | 2.70 | +0.00 |
| S: Synthesis (8) | 2.50 | 2.50 | +0.00 |
| T: Temporal (7) | 1.86 | 1.86 | +0.00 |

| Score | Meaning | OpenClaw | OC+Cortex |
|---|---|---|---|
| 3 | Grounded correct | 30 | **31** |
| 2 | Generic correct | 15 | 17 |
| 1 | Abstained | 2 | **0** |
| 0 | Hallucinated | 2 | 2 |
| ERR | Answer error | 1 | **0** |

Cortex latency: p50 5,500ms · p95 12,105ms · p99 19,133ms.

*Note: 1-pass judging at temperature=0 suppresses variance. Several category deltas (Synthesis, Factual) were masked by deterministic integer rounding. See 3-pass results below for the reference measurement.*

### Results — 3-pass (Feb 24, 2026, commit `21455e3`, warm Tier 3)

Same tenant and pipeline. Judge: `gpt-4.1-mini`, temperature=0.3, 3 passes averaged (mean). One Cortex retrieval 500 on S05 — fell back to OC-only for that prompt.

| Category | OpenClaw | OC+Cortex | Delta |
|---|---|---|---|
| **Overall** | 2.49 | **2.59** | **+0.10** |
| F: Factual (15) | 2.79 | 2.78 | **-0.01** |
| R: Rationale (10) | 2.30 | **2.80** | **+0.50** |
| E: Evolution (10) | 2.77 | 2.63 | **-0.14** |
| S: Synthesis (8) | 2.38 | **2.71** | **+0.33** |
| T: Temporal (7) | 1.90 | 1.71 | **-0.19** |

| Score | Meaning | OpenClaw | OC+Cortex |
|---|---|---|---|
| 3 | Grounded correct | 30 | **34** |
| 2 | Generic correct | 15 | 14 |
| 1 | Abstained | 2 | **0** |
| 0 | Hallucinated | 2 | 2 |
| ERR | Answer error | 1 | **0** |

Cortex latency: p50 9,427ms · p95 17,015ms · p99 23,061ms.

### 1-pass vs 3-pass — what judging variance reveals

| Category | 1-pass Δ | 3-pass Δ | Interpretation |
|---|---|---|---|
| Overall | +0.05 | **+0.10** | 3-pass is the reference |
| F: Factual | -0.06 | **-0.01** | 1-pass delta was rounding noise; Cortex neutral on factual |
| R: Rationale | +0.30 | **+0.50** | Signal is stronger than 1-pass showed; R01, R07 unanimously `[1,1,1]→[3,3,3]` |
| E: Evolution | +0.00 | **-0.14** | 1-pass suppressed a real regression on "current state after migration" questions |
| S: Synthesis | +0.00 | **+0.33** | 1-pass suppressed a real gain; temperature unlocked signal |
| T: Temporal | +0.00 | **-0.19** | Same character as Evolution regression — see Key Finding 4 |

### Cold vs Warm — the Tier 3 difference

The same tenant was evaluated twice: once cold (reflect returned 0 nodes — graph not yet settled) and once warm (Tier 3, mature). The cold → warm transition eliminates the broad cold-pipeline regressions:

| Category | Cold delta | Warm 1-pass Δ | Warm 3-pass Δ |
|---|---|---|---|
| Overall | +0.00 | +0.05 | +0.10 |
| R: Rationale | +0.40 | +0.30 | +0.50 |
| S: Synthesis | **-0.25** | +0.00 | +0.33 |
| T: Temporal | **-0.29** | +0.00 | -0.19 |

Cold-pipeline temporal regression (-0.29): Cortex lacked reranker and graph traversal entirely — broad failure. Warm 3-pass temporal regression (-0.19): a different, narrower failure on "current state after migration" queries (see Key Finding 4). The two regressions have different causes.

---

## Key Findings

### 1. Rationale recall is Cortex's strongest and most consistent advantage (+0.50, V1.1 3-pass)

Decision rationale — *why* Drizzle over Prisma, *why* iron-session over JWT, *why* presigned URLs — is where compaction loses nuance. Cortex stores and retrieves the original reasoning context rather than the compressed gist. In V1 this was masked because OpenClaw alone already hit 3.00 on B (ceiling). In V1.1 with a harder dataset and proper retrieval baseline, the +0.50 gap is unmistakable: `R01` (Fastify over Express) and `R07` (presigned URLs) both moved 1→3 with unanimous judge agreement across all 3 passes `[1,1,1]→[3,3,3]`.

### 2. Synthesis recall is real but suppressed by 1-pass judging (+0.33, V1.1 3-pass)

Cross-session synthesis — connecting facts spread across multiple sessions — benefits from Cortex's graph-linked retrieval. The 1-pass warm run showed +0.00, masking this gain: at temperature=0, the judge deterministically scored borderline answers as 2 for both conditions. With temperature=0.3, S02/S03/S04 consistently flipped 2→3 for Cortex. The signal is real.

### 3. Factual recall: Cortex is neutral, not a regression (-0.01, confirmed noise)

The 1-pass -0.06 Factual delta was rounding noise from integer scoring. 3-pass mean scoring narrows it to -0.01. Cortex does not hurt factual recall — OpenClaw's BM25 hybrid already retrieves single facts with high precision, and Cortex neither adds nor subtracts meaningfully.

### 4. "Current state after migration" queries regress on warm Tier 3 (-0.14 Evolution, -0.19 Temporal)

This is a distinct failure mode from the cold-pipeline regression. The affected prompts all ask for the *current* value of something that changed: *"What system handles background job processing **now**?"*, *"**Most recent** change to authentication?"*. Cortex retrieves both the old and new versions of the fact (its semantic retrieval is thorough), surfacing historical context alongside the current answer. This confuses the LLM into hedging. OpenClaw's temporal decay specifically de-weights stale content, so it surfaces the recent fact more cleanly. The regressions are concentrated in E03, E04, T01, T06 — all recency-discriminating queries. This is not fixed by Tier 3 warmth; it is an architectural property of how Cortex retrieves vs how OC weights recency.

### 5. Cold-pipeline regressions (Tier 1) are a separate, different failure mode

On a cold tenant with no graph, Cortex's semantic-only retrieval produces broad temporal regressions (-0.29) across all queries in the category. On a warm Tier 3 tenant, those broad regressions disappear. The residual warm regressions (Finding 4) are narrower and mechanistically different. The distinction matters for deployment: Tier 3 warmth is necessary but not sufficient to eliminate all temporal degradation.

### 6. Cortex eliminates abstentions and answer errors

Across all runs, OC+Cortex consistently drives abstentions and answer errors to zero. The richer retrieval context prevents the LLM from giving up or producing malformed responses.

### 7. Convention and preference recall benefits at small scale (+0.30 V1 Cat C)

Short declarative rules — "never auto-commit", "no `as` type assertions" — survive compaction well enough that OC already scores reasonably. Cortex retrieves them verbatim with higher specificity. This advantage is stronger at small scale (V1 Cat C +0.30) and flattens at larger scale where both conditions retrieve well.

---

## Caveats and Limitations

**V1.1 Tier 3 is the reference result.** V1 uses only 8 sessions (Tier 1, cold), which understates the full pipeline. The V1.1 warm run is the correct measurement of Cortex against a realistic OpenClaw stack.

**Synthetic seed data.** Both datasets are crafted — real dev sessions have more noise, tangents, and implicit context. Results likely overestimate recall quality for both conditions against a real workspace.

**Single project domain.** All 45 V1.1 sessions belong to one cohesive project (Arclight) with consistent terminology and a single technology stack. Real OpenClaw deployments span diverse workspaces — different languages, domains, team conventions. A single-project benchmark likely makes retrieval easier for both conditions than a messier, multi-domain real-world distribution would.

**OpenClaw simulation is a best-case baseline.** The OC `memory_search` is simulated using the documented architecture. A real OpenClaw agent may retrieve differently depending on configuration.

**3-pass judging reduces but doesn't eliminate variance.** V1.1 results are now 3-pass mean (temp=0.3) with `gpt-4.1-mini`. Single-pass 1-pass results suppressed real signal in Synthesis and inflated the Factual regression. The 3-pass mean is the reference measurement. Same-family LLM/judge models may still share evaluation biases.

**Reflect log shows 0 nodes** but graph evidence confirms it worked. The `/v1/reflect` API returned `{nodes_created: 0, edges_created: 0}` in the response, but the stats endpoint shows 811 ELABORATES edges (the observation nodes reflect creates). The response schema mismatch is a known logging artifact — reflect did execute and the graph is populated.

---

## Run History

### V1 (8 sessions, 40 prompts, three-way comparison)

| Date | Commit | Overall Bare | Overall OC | Overall OC+Cortex | Cortex Delta | Pipeline |
|---|---|---|---|---|---|---|
| Feb 23, 2026 | `33a4a20` | 1.35 | 2.75 | 2.85 | +0.10 | Tier 1, cold |

### V1.1 (45 sessions, 50 prompts, OC vs OC+Cortex)

| Date | Commit | Overall OC | Overall OC+Cortex | Cortex Delta | Judge passes | Pipeline |
|---|---|---|---|---|---|---|
| Feb 24, 2026 | `bb21444` | 2.49 | 2.54 | +0.05 | 1-pass, temp=0 | Tier 3, mature |
| Feb 24, 2026 | `bb21444` | 2.52 | 2.52 | +0.00 | 1-pass, temp=0 | cold (graph not settled) |
| Feb 24, 2026 | `21455e3` | 2.49 | **2.59** | **+0.10** | **3-pass, temp=0.3** | Tier 3, mature |

*(Result files stored in `benchmark/v1/results/` and `benchmark/v1.1/results/`.)*

---

## V2 Benchmark (Real OpenClaw Runtime)

### Methodology

V2 replaces simulation with a live OpenClaw agent. Conversations and recall probes are sent through `openclaw agent --message "..." --json`, exercising the full runtime stack — real compaction, real `memory_search`, real plugin hooks, real file sync.

Two conditions run sequentially on separate agent instances:

| Condition | Agent Configuration |
|-----------|---------------------|
| **Baseline** | OpenClaw agent without the Cortex plugin — native memory only |
| **Cortex** | Same agent with the Cortex plugin installed and active |

Reuses V1.1's Arclight dataset (45 sessions / 136 user turns for seeding, 50 recall prompts with ground truth) for direct comparison. Agent generates its own responses to seed conversations rather than being fed scripted answers — knowledge captured depends on the agent's actual understanding.

Judging: same 0-3 scale, `gpt-4.1-mini`, 3-pass mean (temp=0.3).

### Results

*Pending first live run. Results will appear here after running against a live OpenClaw instance on EC2.*

### What to Watch For

- **Baseline vs V1.1 simulated baseline** — Does the real OpenClaw native memory score similarly to V1.1's simulated 2.49? If so, the simulation was accurate. If the real agent scores higher (from workspace files, SOUL.md, better compaction), the simulated baseline was pessimistic. If lower, real compaction is lossier than simulated.

- **Cortex delta vs V1.1 delta** — V1.1 showed +0.10 overall, +0.50 rationale, +0.33 synthesis. If V2 shows similar deltas, the plugin works as expected in production. If deltas are larger, real-world capture + file sync adds value the simulation missed. If smaller, the simulation overestimated Cortex's contribution.

- **Temporal/Evolution regression** — V1.1 showed -0.14 Evolution and -0.19 Temporal on warm Tier 3. Does the real agent exhibit the same pattern? If the real agent handles recency better (via its own temporal decay + Cortex together), the regression may be smaller.

- **Agent response latency** — V2 measures full turn time (not just retrieval). The overhead of the Cortex plugin on end-to-end response time.

- **Capture quality** — V1/V1.1 seeded Cortex directly via API. V2 seeds through the agent, so Cortex captures whatever the `agent_end` hook extracts. If capture misses key facts, recall quality will suffer regardless of retrieval quality.

### Run History

| Date | Commit | Condition | Overall | Agent | Notes |
|------|--------|-----------|---------|-------|-------|
| *pending* | | baseline | | | |
| *pending* | | cortex | | | |

---

## Conclusion

Cortex delivers a consistent, meaningful improvement to an already-functional OpenClaw agent. The **V1.1 3-pass warm result (+0.10 overall) is the reference number** for production scenarios — it uses the most reliable judging methodology against the strongest baseline. The +0.05 from 1-pass judging understated the true signal by suppressing Synthesis and inflating the Factual regression.

The advantage concentrates in **decision rationale (+0.50)** and **cross-session synthesis (+0.33)** — question types where compaction loses nuance and Cortex's structured entity memory retrieves original context with relationships intact. Factual recall is neutral (-0.01): Cortex does not hurt it, but OpenClaw's BM25 hybrid already handles it.

The residual weakness is on **"current state after migration" queries** (-0.14 Evolution, -0.19 Temporal on warm Tier 3). Cortex's thorough retrieval surfaces both old and new versions of changed facts, confusing the LLM where OpenClaw's temporal decay would have cleanly surfaced the current value. This is an architectural property, not a pipeline maturity issue — it persists on warm Tier 3.

The practical implication: Cortex earns its place for users whose workflows accumulate nuanced, cross-session, or implicitly-stated project knowledge. For short-history projects where `memory_search` retrieves everything relevant, the marginal benefit is lower. For projects with frequent migration-style changes where "what is the *current* value?" questions are common, Cortex adds noise on those specific queries.

**The metrics to watch in future runs:** rationale recall on larger datasets, "current state" query precision as SUPERSEDES chains mature in the graph, and whether adaptive retrieval (bypassing Cortex for temporal/recency-discriminating queries) can eliminate the Evolution/Temporal regression while preserving Rationale and Synthesis gains.
