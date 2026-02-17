# Cortex Plugin for OpenClaw — Architecture

## Overview

Cortex integrates into OpenClaw as two components:

1. **SKILL.md** (Phase 1) — A markdown file installed into OpenClaw's skill system. Teaches the agent how to call the Cortex REST API for retrieval and explicit ingestion. Zero-dependency entry point.
2. **@ubundi/openclaw-cortex** (Phase 2) — An npm plugin using OpenClaw's lifecycle hooks for automatic pre-turn memory injection (Auto-Recall), post-response fact extraction (Auto-Capture), and background file watching (MEMORY.md, daily logs, session transcripts). This is the primary integration for parity with Mem0/Cognee/Supermemory.

This split exists because OpenClaw skills are **prompt injections, not code plugins**. A skill is a markdown document loaded into the agent's system prompt — it can instruct the agent to run `curl` commands, but it cannot run background processes, watch files, or hook into lifecycle events.

## How OpenClaw Skills Work

A skill is a folder in `~/.openclaw/workspace/skills/` containing a `SKILL.md` file:

```
~/.openclaw/workspace/skills/cortex-memory/
└── SKILL.md    ← YAML frontmatter + markdown instructions
```

At session start, OpenClaw scans the skills directory, reads each `SKILL.md`, and injects the content into the agent's system prompt (under a `TOOLS.md` section). The agent then follows the instructions using its bash/shell tool to execute `curl`, `python3`, or other commands.

**Supported frontmatter fields:** `name`, `description`, `metadata`, `user-invokable`, `disable-model-invocation`, `argument-hint`, `compatibility`, `license`.

**What skills CAN do:**
- Teach the agent to call external APIs (via `curl` / shell commands)
- Declare required environment variables (API keys)
- Provide structured instructions for when/how to use the skill

**What skills CANNOT do:**
- Run background processes or daemons
- Watch files for changes
- Hook into OpenClaw lifecycle events (pre-compaction, session start/end)
- Register programmatic tool functions

Configuration lives in `~/.openclaw/openclaw.json`:
```json
{
  "skills": {
    "entries": {
      "cortex-memory": {
        "enabled": true,
        "apiKey": "sk-cortex-oc-user1",
        "env": {
          "CORTEX_BASE_URL": "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod"
        }
      }
    }
  }
}
```

The `apiKey` field injects as `CORTEX_API_KEY` (the `primaryEnv`), and `env` vars are available to all shell commands the agent runs.

## OpenClaw's Native Memory System

### Full Memory Hierarchy

OpenClaw uses a multi-tier file-first memory architecture where plain Markdown is the canonical source of truth and the vector index is a derived, ephemeral search layer.

| Component | Location | Purpose | Loading Behavior |
|---|---|---|---|
| `SOUL.md` | `~/.openclaw/workspace/SOUL.md` | Agent constitution — trust boundaries, tool limits, security invariants. | Injected at top of system prompt every session. |
| `USER.md` | `~/.openclaw/workspace/USER.md` | Operator preferences — timezone, formatting, risk tolerance. | Loaded every session. |
| `MEMORY.md` | `~/.openclaw/workspace/MEMORY.md` | Curated strategic knowledge — decisions, conventions, long-term facts. | **Private sessions only.** Never loaded in group chats. Exempt from temporal decay. |
| Daily logs | `~/.openclaw/workspace/memory/YYYY-MM-DD.md` | Append-only ephemeral logs — activities, tool outputs, tactical decisions. | Rolling 48-hour window: today + yesterday auto-loaded. Older logs retrieved on demand via search. |
| Session transcripts | `~/.openclaw/workspace/sessions/*.jsonl` | Raw operational history — full message/tool/response event stream. | Not directly loaded. Indexed by QMD backend if enabled. |
| Embedding index | `~/.openclaw/memory/{agentId}.sqlite` | Derived search layer — FTS5 (BM25) + sqlite-vec (cosine similarity). | Rebuilt incrementally on file changes via SHA-256 chunk hash dedup. |

### Retrieval Architecture

**Chunking**: 400-token sliding window with 80-token overlap (20%). Line-aware — maintains file path + line range metadata. SHA-256 hash per chunk for incremental delta re-indexing.

**Embedding fallback chain**: Local GGUF (node-llama-cpp) → OpenAI (batch API for 50% cost reduction) → Gemini → Voyage AI → BM25-only fallback.

**Fusion**: Weighted linear combination, explicitly NOT Reciprocal Rank Fusion. OpenClaw rejects RRF because it flattens score magnitudes — a 0.99 cosine hit and a 0.71 hit become ordinal #1 and #2, losing confidence signal.

```
Final Score = (0.70 × VectorScore) + (0.30 × NormalizedBM25Score)
```

BM25 normalized via `1/(1+rank)`. Union merge (not intersection) with `candidateMultiplier: 4` (fetches 4x results before fusion).

**Temporal decay**: Exponential decay with 30-day half-life.

```
Recency Score = exp(-λ × Age_in_Hours)
λ = ln(2) / Half_Life_in_Hours
```

`MEMORY.md`, `SOUL.md`, and non-dated config files are **exempt** from decay.

### QMD Backend (Advanced, Optional)

The Quantized Markdown backend replaces the default SQLite pipeline with a 3-model local inference stack:

1. **Query expansion** (1.7B GGUF) — generates semantic permutations of the query
2. **Dense embedding** (300M model) — maps expanded queries to vectors
3. **Cross-encoder reranking** (0.6B Qwen-based) — reorders candidates before returning

QMD also provides **session transcript indexing** — strips system prompts, base64 images, and tool JSON from `sessions/*.jsonl`, projects the dialogue into clean Markdown, then chunks and indexes it. This allows queries like "What server IP did we discuss last Tuesday?"

**Known bugs**: SQLite WAL mode causes stale reads — the main process holds a cached read-only connection that can't see QMD's writes, silently dropping valid search results until gateway restart.

### Context Window Management

**Auto-compaction trigger**: `Context_Window - Reserve_Tokens(20k) - Soft_Threshold(4k)`. For a 200k-token window, triggers at ~176k tokens.

**Pre-compaction memory flush**: When nearing the soft threshold, OpenClaw pauses the message queue and injects a silent agentic turn. The system prompt instructs: "Session nearing compaction. Store durable memories now. Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."

**Known race condition**: The `memoryFlushCompactionCount` logic has a state synchronization bug. If compaction completes simultaneously with the flush, the dedup counters desynchronize, causing a "flush, skip, flush, skip" pattern on alternating cycles. This means **~50% of pre-compaction flushes may be skipped** in active sessions.

### Privacy and Multi-Agent Isolation

- **Private vs. group sessions**: MEMORY.md only loaded in DM/private sessions. Group chats get an isolated session namespace with no access to private memory.
- **Multi-agent workspaces**: Each agent defined in `openclaw.json` gets a fully separate workspace directory — its own SOUL.md, MEMORY.md, daily logs, and SQLite index. Zero cross-agent visibility.

### Known Limitations

1. **No knowledge graph** — flat vector matching, no relationship tracking between concepts.
2. **Contextual isolation degrades over time** — after months, SQLite index saturates with thousands of flat vector points. Recall accuracy drops to ~60-70% as old and current facts compete in the same embedding space.
3. **Cross-project noise** — queries return hits from unrelated projects/timeframes.
4. **Lossy compaction** — despite the pre-compaction flush, the race condition bug means half the flushes may be skipped. Compaction summaries lose tactical nuance.
5. **No memory consolidation** — files grow forever, no supersedes/contradicts/dedup logic.

### Competitive Landscape

#### Already in OpenClaw

**Mem0** — Market leader. npm plugin (`@mem0/openclaw-mem0`) with Auto-Recall (injects relevant memories before every agent turn) and Auto-Capture (extracts facts after every response). 30-second setup. Memories stored externally, immune to compaction erasure. Graph memory uses Neo4j but primarily for storage, not retrieval traversal. Free tier → usage-based Flex → enterprise. Open-source self-host option available. Known issue: Auto-Recall was [silently broken](https://github.com/mem0ai/mem0/issues/4037) due to incorrect property name, suggesting the OpenClaw integration isn't heavily battle-tested.

**Cognee** — Knowledge graph focus. TypeScript npm plugin. Syncs MEMORY.md and daily logs into Cognee's graph via ECL pipelines. Keeps Markdown as source of truth, graph as query layer. Strong on multi-hop reasoning — outperforms competitors on Human-like Correctness and DeepEval benchmarks. Open-source core.

**Supermemory** — Cross-platform memory API. Full OpenClaw plugin with auto-recall/auto-capture (similar model to Mem0). Works across OpenClaw, ChatGPT, Claude, Gemini — one memory brain for all platforms. Requires Supermemory Pro plan.

**Hippocampus Memory** — Community SKILL.md-based skill (same format as Cortex). Part of an "AI Brain" project giving agents human-like cognitive components. Closest precedent to our approach — a skill, not a plugin.

#### Broader Market (Not in OpenClaw Yet)

**Zep / Graphiti** — Technical leader. Temporal knowledge graph purpose-built for agents. Bi-temporal data model tracks both when events occurred and when they were ingested. P95 retrieval latency of 300ms via hybrid search (semantic + BM25 + graph traversal) with zero LLM calls at retrieval time. Outperforms Mem0 across the board on LoCoMo benchmark. Published [research paper](https://arxiv.org/abs/2501.13956). Graphiti is open-source (Neo4j-backed), Zep is the managed enterprise platform. **No OpenClaw plugin yet.**

**Letta (MemGPT)** — Agent framework with built-in memory management. Memory as a first-class agentic capability. Different model — it IS the agent framework, not a memory layer you add.

#### Competitive Comparison

| Capability | Mem0 | Cognee | Zep/Graphiti | Supermemory | **Cortex** |
|---|---|---|---|---|---|
| Knowledge graph | Neo4j (storage) | Yes (ECL) | Yes (temporal) | No | Yes (Postgres + pgvector) |
| Graph traversal at retrieval | No | Yes | **Yes** (Graphiti) | No | Yes (spreading activation, shallow) |
| Temporal reasoning | Basic | Basic | **Best** (bi-temporal) | No | Yes (SUPERSEDES chains + temporal channel) |
| Entity resolution | Basic | Yes | Yes | No | Yes (alias/nickname/fuzzy) |
| Memory consolidation | Update/merge | Graph-level | Temporal versioning | No | Yes (reflect, SUPERSEDES, CONTRADICTS) |
| Self-hosted option | Yes (OSS) | Yes (OSS) | Yes (Graphiti OSS) | No | Yes |
| Managed service | Yes | No | Yes (Zep) | Yes | Yes (AWS) |
| OpenClaw integration type | **npm plugin** | **npm plugin** | None | **npm plugin** | Skill (Phase 1) + npm plugin (Phase 2) |
| Auto-Recall (pre-turn injection) | **Yes** | **Yes** | N/A | **Yes** | No (Phase 1) / Yes (Phase 2, not built) |
| Auto-Capture (post-turn extraction) | **Yes** | **Yes** | N/A | **Yes** | No (Phase 1) / Yes (Phase 2, not built) |
| Retrieval channels | ~2 (embed + BM25) | ~2 (graph + embed) | 3 (embed + BM25 + graph) | ~1 (embed) | 5 (BM25 + semantic + question + temporal + graph) |
| Retrieval latency (no LLM calls) | Yes | No (ECL pipeline) | **Yes** (p95 ~300ms) | Yes | Partial — full mode uses LLM classifier + reranker; fast mode avoids LLM calls |
| Neo4j dependency | Yes | No | Yes | No | No (Postgres-only) |

#### Cortex Differentiation

1. **5-way hybrid retrieval** — BM25 + semantic + question-matching + temporal + graph traversal with RRF fusion. More channels doesn't automatically mean better recall — Zep achieves strong results with 3 channels and zero LLM calls at retrieval time. Cortex's advantage is *coverage breadth* (temporal anchoring and question-matching catch queries the standard channels miss), but the tradeoff is latency: full-mode retrieval involves an LLM classifier and optional cross-encoder reranker, adding ~200-400ms over a pure embedding+BM25 path. Fast mode (`mode=fast`) drops these to stay within ~80-150ms, at the cost of losing graph traversal and reranking.
2. **ENGRAVE extraction pipeline** — structured fact/entity/edge extraction, not just "store this memory."
3. **SUPERSEDES/CONTRADICTS/belief drift** — explicit memory lifecycle management, not append-only.
4. **Postgres-only stack** — no Neo4j dependency. This is genuinely simpler to operate (one database, not two), and aligns with OpenClaw's own PostgreSQL + pgvector RFC. The tradeoff: Postgres is not a native graph database. Cortex's graph traversal uses recursive SQL queries (spreading activation), which works well for shallow traversals (2-3 hops) but won't match Neo4j/Graphiti performance for deep multi-hop reasoning across large graphs. For the typical agent memory use case (entity lookups, relationship context, temporal chains), this is sufficient — but it's a ceiling, not an advantage.

#### Cortex Gap: No Auto-Recall/Auto-Capture

Mem0, Cognee, and Supermemory are npm **plugins** that hook into OpenClaw's plugin lifecycle — they inject memories before every turn (Auto-Recall) and extract facts after every response (Auto-Capture) without the agent deciding to do so.

Cortex's SKILL.md approach means the agent must *decide* to call Cortex. There is no equivalent of Auto-Recall or Auto-Capture without building a proper npm plugin.

**This is the single largest competitive risk.** Without Auto-Recall, Cortex relies on the agent choosing to call it — but agents are unreliable skill invokers. In practice, the model will use native `memory_search` (zero-effort, always available) and only call Cortex when the skill instructions happen to be salient in the context window. For routine queries where long-term memory matters most, the agent simply won't think to use Cortex. This means Phase 1 users get demonstrably worse memory than a 30-second Mem0 install.

**Mitigation strategy:** Phase 2 (npm plugin with `before_agent_start` hook) must be treated as the real launch, not a follow-up. Phase 1 exists to validate retrieval quality and gather early feedback, but it should not be marketed as a competitive alternative to Mem0/Cognee/Supermemory. The honest pitch for Phase 1 is: "try Cortex's retrieval quality now, automatic integration is coming."

### OpenClaw's Own Roadmap (relevant)

- **5-tier memory system (T0-T4)**: Scheduled LLM jobs to compress, promote, and archive aging daily logs into topic summaries. Mirrors human long-term consolidation. Cortex's `reflect()` already does this.
- **PostgreSQL + pgvector RFC**: Replace SQLite with Postgres for WAL-safe concurrency and horizontal scaling. Cortex already runs on Postgres + pgvector.
- **Knowledge graph memory** ([Issue #2910](https://github.com/openclaw/openclaw/issues/2910)): Community feature request for graph-based memory using OpenMemory/Cognee/Zep. Indicates demand for exactly what Cortex provides.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        OpenClaw                               │
│                                                               │
│  Native Memory (unchanged)                                    │
│  ├── SOUL.md            (agent constitution — every session)  │
│  ├── USER.md            (operator preferences — every session)│
│  ├── MEMORY.md          (strategic facts — private only)      │
│  ├── memory/*.md        (daily logs — 48hr auto-load)         │
│  ├── sessions/*.jsonl   (raw transcripts)                     │
│  └── {agentId}.sqlite   (FTS5 + sqlite-vec index)            │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  @ubundi/openclaw-cortex (Phase 2 — npm plugin)      │     │
│  │                                                      │     │
│  │  • Auto-Recall: before_agent_start → prependContext  │     │
│  │  • Auto-Capture: post-response → extract + ingest    │     │
│  │  • File Sync: watches MEMORY.md, memory/*.md,        │     │
│  │    sessions/*.jsonl → diff/append ingest              │     │
│  │  • Uses OpenClaw plugin lifecycle hooks               │     │
│  └───────────────────────┬──────────────────────────────┘     │
│                          │                                    │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  cortex-memory SKILL.md (fallback / zero-dependency) │     │
│  │                                                      │     │
│  │  Agent reads instructions, runs curl commands:       │     │
│  │  • "Recall from Cortex"  → curl POST /v1/retrieve    │     │
│  │  • "Remember in Cortex"  → curl POST /v1/ingest      │     │
│  │  • "Ingest conversation" → curl POST /v1/ingest/     │     │
│  │                              conversation            │     │
│  └───────────────────────┬──────────────────────────────┘     │
└──────────────────────────┤────────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Cortex API (AWS)                      │
│                                                         │
│  API Gateway → Lambda (auth) → ALB → ECS Fargate        │
│                                        │                │
│                                   ┌────▼────┐           │
│                                   │  RDS    │           │
│                                   │ Postgres│           │
│                                   │+pgvector│           │
│                                   └─────────┘           │
│                                                         │
│  Tenant isolation: API key → tenant_id → database       │
└─────────────────────────────────────────────────────────┘
```

## Why Cortex Solves OpenClaw's Specific Problems

| OpenClaw Limitation | Root Cause | How Cortex Solves It |
|---|---|---|
| Recall drops to ~60-70% after months | Flat vector space saturates — old and current facts compete | Graph-structured storage with typed edges. Spreading activation retrieval traverses relationships, not just embeddings. |
| Cross-project noise | Single SQLite index, no workspace isolation in search | Tenant-level DB isolation. Session ID prefixes for project scoping. |
| No relationship reasoning | sqlite-vec does cosine similarity only, no graph | Entity nodes, typed edges (MENTIONS, SUPPORTS, CONTRADICTS, ELABORATES), graph traversal channel in retrieval. |
| Compaction loses data (~50% flush skip rate) | memoryFlushCompactionCount race condition | npm plugin's file watcher ingests memory files independently of compaction. Auto-capture also extracts facts from conversation before compaction occurs. |
| Temporal confusion (old facts outrank new) | 30-day exponential decay is too coarse | SUPERSEDES edges explicitly mark replaced facts. Temporal channel with date-anchored retrieval. Belief drift tracking. |
| No consolidation (files grow forever) | Append-only architecture, no dedup | `reflect()` synthesizes cross-session observations. SUPERSEDES/CONTRADICTS prune stale facts. |

## Component 1: SKILL.md (the skill)

See `docs/openclaw/SKILL.md` for the full skill file.

The skill teaches the agent three capabilities via curl commands:

- **Recall** (`POST /v1/retrieve`) — for cross-session facts, entity relationships, temporal queries
- **Remember** (`POST /v1/ingest`) — for explicit "remember this" requests
- **Ingest Conversation** (`POST /v1/ingest/conversation`) — for end-of-session batching with speaker attribution
- **Bootstrap** (`POST /v1/ingest`) — first-run ingestion of existing MEMORY.md

**Decision guidance for the agent** — when to use Cortex vs. native `memory_search`:

| Situation | `memory_search` | Cortex recall |
|---|---|---|
| Recent context from today | Faster (local) | Unnecessary |
| Simple keyword lookup | Faster (local) | Unnecessary |
| Cross-session facts | Noisy after months | **Graph-structured retrieval** |
| Entity relationships | Can't traverse | **Graph traversal** |
| Temporal changes | No SUPERSEDES tracking | **Temporal + SUPERSEDES chain** |
| Scoped project queries | Cross-project noise | **Session-scoped retrieval** |

## Component 2: File Sync (built into the npm plugin)

The npm plugin watches OpenClaw's memory files and automatically ingests changes into Cortex. This runs inside the plugin process — no separate daemon or background service needed.

### What It Watches

| Source | Signal Quality | Ingestion Strategy |
|---|---|---|
| `MEMORY.md` | Highest — user-validated strategic facts | Diff against last-ingested version, send delta |
| `memory/YYYY-MM-DD.md` | Medium — daily session context | Detect appended lines, send new content |
| `sessions/*.jsonl` | Lower but comprehensive — full transcripts | Strip system prompts/tool JSON, project to clean text, batch ingest |

### Why File Sync Matters

Auto-capture (post-response hook) only sees conversation content that flows through the agent. But OpenClaw's native memory system also writes directly to files — MEMORY.md edits, daily log appends, session transcripts. Without file watching, this content would never reach Cortex.

The pre-compaction memory flush has a **known race condition** that causes ~50% of flushes to be skipped in active sessions. File sync mitigates this by ingesting from files independently of the compaction lifecycle.

### Design

```typescript
// Inside @ubundi/openclaw-cortex — file sync module
import { watch } from "fs";
import { readFile } from "fs/promises";

class FileSync {
  private lastContent = new Map<string, string>();
  private lastOffsets = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  start(workspacePath: string, apiKey: string, baseUrl: string) {
    // MEMORY.md — line-level diff ingestion.
    // Only sends added/changed lines, not the full file.
    // MEMORY.md grows over months — re-ingesting full content on every
    // edit would create duplicate facts in the graph and waste API calls.
    watch(`${workspacePath}/MEMORY.md`, () => {
      // Debounce: MEMORY.md may be written in rapid bursts during
      // compaction flushes. Wait 2s after last write before diffing.
      const key = "MEMORY.md";
      clearTimeout(this.debounceTimers.get(key));
      this.debounceTimers.set(key, setTimeout(async () => {
        const current = await readFile(`${workspacePath}/MEMORY.md`, "utf-8");
        const previous = this.lastContent.get(key) ?? "";
        if (current === previous) return;

        const diff = this.lineDiff(previous, current);
        if (diff.added.trim()) {
          await this.postIngest(diff.added, "openclaw:memory-md", apiKey, baseUrl);
        }
        // diff.removed: we don't act on removals here — Cortex's
        // SUPERSEDES mechanism handles fact invalidation at retrieval
        // time, not at ingestion time.
        this.lastContent.set(key, current);
      }, 2000));
    });

    // Daily logs — append-only ingestion (offset-based, not diff).
    // Daily logs are append-only by design, so offset tracking is correct.
    watch(`${workspacePath}/memory/`, { recursive: true }, async (_event, filename) => {
      if (!filename?.endsWith(".md")) return;
      const fullPath = `${workspacePath}/memory/${filename}`;
      const content = await readFile(fullPath, "utf-8");
      const lastOffset = this.lastOffsets.get(fullPath) ?? 0;
      const newContent = content.slice(lastOffset);
      if (newContent.trim()) {
        await this.postIngest(newContent, `openclaw:daily:${filename}`, apiKey, baseUrl);
      }
      this.lastOffsets.set(fullPath, content.length);
    });
  }

  private lineDiff(previous: string, current: string): { added: string; removed: string } {
    const prevLines = new Set(previous.split("\n"));
    const currLines = new Set(current.split("\n"));
    const added = current.split("\n").filter(l => !prevLines.has(l)).join("\n");
    const removed = previous.split("\n").filter(l => !currLines.has(l)).join("\n");
    return { added, removed };
  }

  private async postIngest(text: string, sessionId: string, apiKey: string, baseUrl: string) {
    await fetch(`${baseUrl}/v1/ingest`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, session_id: sessionId }),
    });
  }
}
```

**Limitations of line-level diffing**: This is a set-difference on lines, not a semantic diff. If a user rewords an existing fact ("Joined Acme in 2024" → "Joined Acme Corp in January 2024"), the old line shows as removed and the new line as added — Cortex ingests the new wording as a fresh fact. The old fact remains in the graph until `reflect()` or SUPERSEDES resolution marks it stale. This is acceptable: the alternative (semantic dedup at file-sync time) would require an LLM call per edit, defeating the purpose of lightweight background sync.

## Responsibility Matrix

| Concern | OpenClaw Native | Cortex npm Plugin | Cortex Skill |
|---|---|---|---|
| Current session context | **Primary** | Does not touch | Does not touch |
| SOUL.md / USER.md | **Primary** | Does not touch | Does not touch |
| Auto-recall (pre-turn injection) | None | **Primary** (`before_agent_start` hook) | Cannot (passive doc) |
| Auto-capture (post-turn extraction) | None | **Primary** (post-response hook) | Cannot (passive doc) |
| Curated long-term facts | **Primary** (MEMORY.md) | Auto-ingests on change (file sync) | Can ingest on request |
| Daily session logs | **Primary** (memory/*.md) | Auto-ingests on append (file sync) | Can ingest on request |
| Session transcripts | **Primary** (sessions/*.jsonl) | Can ingest (clean + project, file sync) | — |
| Cross-session fact retrieval | Weak (~60-70% after months) | **Primary** (via API) | **Primary** (via API) |
| Entity tracking | None | **Primary** (via API) | **Primary** (via API) |
| Relationship reasoning | None | **Primary** (via API) | **Primary** (via API) |
| Temporal reasoning | Coarse (30-day decay only) | **Primary** (via API) | **Primary** (via API) |
| Memory consolidation | None (append-only) | **Primary** (SUPERSEDES) | **Primary** (SUPERSEDES) |
| Background ingestion | — | **Primary** (auto-capture + file sync) | Cannot (passive doc) |
| Compaction loss mitigation | Partial (flush has race bug) | **Primary** (auto-capture + file sync) | — |

## Tenant Model

Each OpenClaw user gets a Cortex API key mapped to an isolated tenant database:

```
User Alice  →  sk-cortex-oc-alice  →  tenant_oc_alice  →  cortex_oc_alice (database)
User Bob    →  sk-cortex-oc-bob    →  tenant_oc_bob    →  cortex_oc_bob (database)
```

For multi-project isolation within a user, `session_id` prefixes:
```
session_id: "openclaw:project-frontend:memory-md"
session_id: "openclaw:project-backend:daily:2026-02-17"
```

For multi-agent OpenClaw setups (separate workspace per agent), each agent can have its own Cortex API key or share a tenant with agent-scoped session IDs.

## Implementation Phases

### Phase 1: SKILL.md + Manual Ingestion

- Write and test the `SKILL.md` file (see `docs/openclaw/SKILL.md`).
- Publish to ClawHub for installation via `npx clawhub@latest install cortex-memory`.
- Users can immediately: recall from Cortex, explicitly remember, bootstrap existing MEMORY.md.
- No daemon needed — the agent handles all API calls via curl.

**Honest assessment:** Phase 1 is a worse user experience than Mem0. A user who runs `npm install @mem0/openclaw-mem0` gets automatic memory injection on every turn in 30 seconds. A user who installs the Cortex skill gets agent-initiated recall — meaning the agent must *decide* to call Cortex, which in practice it often won't, especially for routine queries where memory would be most valuable. The skill is a low-cost entry point for validating the API and getting early feedback, but it is not competitive with existing npm plugin integrations. Phase 1's real purpose is proving the retrieval quality advantage exists, so that Phase 2 has a defensible reason to ship.

### Phase 2: npm Plugin — Auto-Recall + Auto-Capture (the real launch)

> **This is the actual product launch.** Phase 1 validates retrieval quality; Phase 2 delivers the user experience that competes with Mem0/Cognee/Supermemory. Until this ships, Cortex is not a serious alternative for most OpenClaw users — the skill-based approach requires agent cooperation that isn't reliable enough for production use.

> **Why not MCP?** Investigated and ruled out. OpenClaw silently ignores `mcpServers` config (ACP layer disables MCP; issues #8188, #13248, #4240 are open feature requests, #4834 was closed as Not Planned). Even if supported, MCP is pull-based — tools require explicit model invocation, resources require explicit client reads. There is no MCP mechanism for server-initiated pre-turn context injection. Every competitor (Mem0, Cognee, Supermemory, MemOS) uses OpenClaw's npm plugin `before_agent_start` hook instead.

- Build `@ubundi/openclaw-cortex` — a lightweight TypeScript npm plugin.
- Implement **auto-recall** via `before_agent_start` hook:
  ```typescript
  api.on("before_agent_start", async (event, ctx) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
    try {
      const res = await fetch(`${CORTEX_BASE_URL}/v1/retrieve`, {
        method: "POST",
        headers: { "x-api-key": CORTEX_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ query: event.prompt, top_k: 5, mode: "fast" }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const memories = await res.json();
      if (!memories.results?.length) return {};
      const formatted = memories.results
        .map((r: any) => `- [${r.score.toFixed(2)}] ${r.content}`)
        .join("\n");
      return { prependContext: `<cortex_memories>\n${formatted}\n</cortex_memories>` };
    } catch (err) {
      clearTimeout(timeout);
      // Timeout or network failure — proceed without memories rather than blocking the agent
      return {};
    }
  });
  ```
- Implement **auto-capture** via post-response hook — extract and ingest key facts after agent responses.
- Implement **file sync** — watch MEMORY.md (diff-based), daily logs (append-based), and optionally session transcripts. Runs inside the plugin process, no separate daemon needed. See [Component 2: File Sync](#component-2-file-sync-built-into-the-npm-plugin) for design details.
- User installs via: `npx clawhub@latest install @ubundi/openclaw-cortex`
- Configuration in `openclaw.json`:
  ```json
  {
    "plugins": {
      "@ubundi/openclaw-cortex": {
        "enabled": true,
        "settings": {
          "apiKey": "sk-cortex-oc-user1",
          "baseUrl": "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
          "autoRecall": true,
          "autoCapture": true,
          "recallTopK": 5,
          "recallTimeoutMs": 500
        }
      }
    }
  }
  ```
- SKILL.md remains available as the zero-dependency fallback (agent-initiated recall only, no npm install required).
- **Key design decisions**:
  - **Auto-recall latency budget — honest numbers.** The `mode=fast` retrieval parameter disables graph traversal, reranking, session expansion, query expansion, and token packing — server-side processing drops to ~80-150ms (BM25 + semantic + RRF fusion only). But the user never sees server-side latency alone. The full request path is: user's machine → API Gateway → Lambda authorizer → ALB → ECS Fargate → RDS → back. For a user in us-east-1, expect ~200-300ms total. For a user in Europe or Asia-Pacific, expect ~400-600ms. This is the real latency budget, and it's tight.
    - **Timeout policy**: The plugin must enforce a hard timeout (default: 500ms, configurable via `recallTimeoutMs`). If exceeded, the agent proceeds without memories — a silent degradation, not an error. This is the only correct behavior: a 2-second hang before every agent response is worse than missing memories.
    - **What users in distant regions actually experience**: At 400-600ms, auto-recall adds a noticeable pause before every response. This may be acceptable for users who value memory quality, but the plugin should expose a `recallEnabled` toggle and consider skip-on-cold-start logic (first request to a cold ECS task adds ~2-5s; the plugin should detect this and disable recall until the service is warm).
    - **Comparison**: Mem0's managed API is also an external network call with similar latency characteristics. Their plugin faces the same problem — it's not unique to Cortex. But Mem0's infrastructure is multi-region (US, EU, AP endpoints), which Cortex currently is not. If auto-recall latency proves to be a real adoption blocker, deploying Cortex to additional AWS regions is the fix, not optimizing server-side processing further.
  - Auto-capture selectivity: don't ingest every turn. Use a lightweight heuristic (message length, presence of factual assertions, user corrections) to filter noise.
  - Dedup with SKILL.md: if both plugin and SKILL.md are active, the agent may double-recall. Plugin should set a `<cortex_memories>` tag the skill can detect to skip explicit recall.

### Phase 3: Advanced Features

- Tune auto-recall relevance (precision vs. coverage tradeoff based on user feedback).
- Session transcript ingestion — strip system prompts, base64, tool JSON from `sessions/*.jsonl`, project to clean text, batch ingest via `POST /v1/ingest/conversation` with speaker attribution. Built into the plugin's file sync module.
- Add explicit `cortex_relate` command for entity-centric queries in SKILL.md.
- Conversation ingestion in SKILL.md for end-of-session batching.
- Periodic reflection trigger via `POST /v1/reflect` endpoint.

### Phase 4: MCP Server (for non-OpenClaw clients)

- Build a Cortex MCP server exposing `cortex_recall`, `cortex_ingest`, and `cortex_relate` as MCP tools.
- Target: Claude Desktop, Claude Code, VS Code Copilot, Cursor, and other MCP-compatible hosts.
- These clients DO support MCP tools natively — the agent calls them on demand.
- No auto-recall (MCP can't do pre-turn injection), but structured tool integration is still valuable for clients that don't have a plugin system like OpenClaw's.
- Reuses the same Cortex API — just a different transport layer.

## API Endpoints Used

| Action | Cortex API Endpoint | Triggered By |
|---|---|---|
| Auto-recall (pre-turn) | `POST /v1/retrieve` | npm plugin `before_agent_start` hook — every agent turn |
| Auto-capture (post-turn) | `POST /v1/ingest` | npm plugin post-response hook — selective |
| Explicit recall | `POST /v1/retrieve` | Agent decides to query Cortex (skill) |
| Explicit remember | `POST /v1/ingest` | User asks agent to remember (skill) |
| Conversation ingest | `POST /v1/ingest/conversation` | Agent at end of session (skill) |
| Bootstrap | `POST /v1/ingest` | First-run ingestion of MEMORY.md (skill) |
| MEMORY.md sync | `POST /v1/ingest` | File change detected (npm plugin file sync) |
| Daily log sync | `POST /v1/ingest` | File append detected (npm plugin file sync) |
| Transcript sync | `POST /v1/ingest/conversation` | JSONL cleaned and batched (npm plugin file sync) |

## Requirements (must be resolved before shipping)

### Phase 1 blockers

1. **Skill latency tolerance**: The skill calls Cortex via `curl` — a network round-trip to AWS. If p95 > 500ms, the agent will learn to avoid it and default to native `memory_search`. **Requirement**: Cortex API p95 latency must stay under 400ms for `/v1/retrieve` with `mode=fast`. Measure against realistic query loads before publishing the skill. If latency is unacceptable, the skill should include explicit guidance telling the agent when the latency tradeoff is worth it (cross-session facts, entity queries) vs. when to use native search (recent context, simple keywords).
2. **MEMORY.md chunk size**: Large MEMORY.md files may exceed the ingest endpoint's text limit. The skill's bootstrap command (`curl POST /v1/ingest` with the full MEMORY.md content) will silently fail or truncate for power users with months of curated facts. **Requirement**: Either increase the ingest endpoint's text limit, or add chunking guidance to the skill instructions (split at heading boundaries, ingest in parts).

### Phase 2 blockers

3. **File sync debouncing**: File watcher fires on every write. During compaction flushes, MEMORY.md may be written multiple times in rapid succession. Without debouncing, each write triggers an API call — redundant work that could hit API Gateway rate limits. **Decision**: 2-second cooldown after last write event before diffing and ingesting. Already reflected in the file sync design above.
4. **Offline / network failure behavior**: When Cortex API is unreachable (network outage, cold ECS task, API Gateway throttle), the plugin must degrade gracefully. **Requirements**: (a) Auto-recall: timeout and proceed without memories (already designed — `recallTimeoutMs`). (b) Auto-capture: queue failed ingestions in memory and retry with exponential backoff. (c) File sync: queue diffs locally and replay on reconnect. No data loss on transient failures.
5. **Auto-recall latency budget**: Covered in detail in Phase 2 design decisions above. The hard timeout (`recallTimeoutMs`, default 500ms) is the answer — but the default value needs validation against real user experience. **Requirement**: Instrument latency in the plugin and collect p50/p95/p99 from early adopters before making the default final.

## Open Questions

1. **Multi-region deployment**: Auto-recall latency for users outside us-east-1 may be 400-600ms. Need to evaluate demand by region and cost of deploying Cortex to eu-west-1 / ap-southeast-1. This is a scaling decision, not a launch blocker — Phase 2 ships single-region with the timeout as the safety valve.
2. **Transcript cleaning**: How much system prompt / tool JSON to strip from `sessions/*.jsonl`? Need sample files to tune. Affects Phase 3 (transcript ingestion), not Phase 1 or 2.
3. **Multi-agent isolation**: Should separate OpenClaw agents share a Cortex tenant (with agent-scoped session IDs) or get separate tenants? Affects tenant provisioning workflow but not core plugin functionality.
4. **ClawHub publishing**: Review process, security audit requirements, listing criteria. Needs investigation before Phase 1 ships.
