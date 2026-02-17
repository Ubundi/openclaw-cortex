# Testing Documentation

`@ubundi/openclaw-cortex` v0.2.0 — tested February 17, 2026

## Test Layers

| Layer | Command | Count | What it proves |
|-------|---------|-------|----------------|
| Unit tests | `npm test` | 52 tests | All modules work in isolation with mocked Cortex API |
| Integration tests | `npm run test:integration` | 9 tests | Client methods work against the live Cortex API |
| Harness simulation | `npx tsx test-harness.ts` | 4-turn session | Full plugin lifecycle works end-to-end |
| Persistence proof | `npx tsx test-persistence.ts` | 1 round-trip | Captured data actually persists and is retrievable |
| File sync proof | `npx tsx test-filesync.ts` | 3 file types | MEMORY.md, daily logs, and transcript sync all work |
| Edge cases + retry | `npx tsx test-edge-cases.ts` | 17 assertions | Empty prompts, huge messages, invalid config, network drops, retry recovery |

All tests require `CORTEX_API_KEY` env var for integration/harness/persistence/filesync/edge-cases.

---

## Unit Tests (52 passing)

```bash
npm test
```

Covers all modules with mocked HTTP responses:

- **client.test.ts** — `CortexClient.retrieve()`, `CortexClient.ingestConversation()`, `CortexClient.health()`, timeout handling, error codes
- **recall.test.ts** — `createRecallHandler()` returns `prependContext` with formatted memories, respects `autoRecall: false`, handles empty results, cold-start detection after 3 consecutive failures, cold-start cooldown skips recall
- **capture.test.ts** — `createCaptureHandler()` sends recent messages to ingest, respects `autoCapture: false`, skips trivial exchanges (`isWorthCapturing`), skips failed turns (`success: false`), queues failures to retry queue
- **cold-start.test.ts** — Cold-start detection triggers after 3 failures, resets on success, cooldown period skips recall
- **format.test.ts** — `formatMemories()` produces `<cortex_memories>` XML with score and content
- **metrics.test.ts** — `LatencyMetrics.record()` and `summary()` with p50/p95/p99 percentiles
- **retry-queue.test.ts** — Exponential backoff, max retries, queue start/stop
- **transcript-cleaner.test.ts** — Strips system prompts, tool JSON, base64 images from transcripts

### Verified behaviors

- Recall returns `undefined` (not an error) when no memories match
- Recall returns `undefined` when prompt is empty or < 5 characters
- Capture skips when `event.success` is falsy
- Capture skips when messages lack substantive content (< 20 chars per role)
- Retry queue uses exponential backoff up to 5 retries
- Cold-start detection disables recall for 30s after 3 consecutive failures

---

## Integration Tests (9 passing)

```bash
CORTEX_API_KEY=your-key npm run test:integration
```

Uses a dedicated `vitest.integration.config.ts` to run separately from unit tests. Each run generates a unique session ID (`Date.now()`) to avoid cross-run data collisions.

### client.integration.test.ts

- **health** — `GET /v1/health` returns `{ status: "ok" }`
- **ingest/conversation** — `POST /v1/ingest/conversation` accepts messages and returns `{ facts, entities, nodes_created }`
- **retrieve** — `POST /v1/retrieve` returns `{ results: [{ content, score, node_id, type }] }`

### recall-pipeline.integration.test.ts

- **end-to-end recall** — Seeds unique data via ingest, waits for indexing, then verifies `createRecallHandler()` returns `prependContext` containing the seeded content
- Uses run-specific entity names (`TestUser-recall-TIMESTAMP`) to assert only data from this run is recalled

### Verified API contract

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/v1/health` | GET | — | `{ status: string }` |
| `/v1/ingest/conversation` | POST | `{ messages, session_id }` | `{ facts: [], entities: [], nodes_created: number }` |
| `/v1/retrieve` | POST | `{ query, top_k, mode }` | `{ results: [{ content, score, node_id, type }] }` |

### Known API gaps

- `/v1/reflect` returns **404** — the endpoint does not exist in the current Cortex API version. `PeriodicReflect` service will log errors but not crash.
- `retrieve` does **not** filter by `session_id` — results come from all sessions for the API key.

---

## Harness Simulation (test-harness.ts)

```bash
CORTEX_API_KEY=your-key npx tsx test-harness.ts
```

Simulates a 4-turn OpenClaw coding session without OpenClaw installed. Exercises the full plugin lifecycle:

### What it does

1. **Registers** the plugin — calls `plugin.register(api)` with a mock `PluginApi`
2. **Starts services** — boots retry queue (file sync and reflect disabled)
3. **Runs 4 agent turns**, each consisting of:
   - `before_agent_start` hook fires → Cortex recalls relevant memories
   - Simulated agent generates a response using recalled context
   - `agent_end` hook fires → Cortex captures the conversation
4. **Stops services** — shuts down cleanly, prints latency metrics

### Verified behaviors

| Behavior | Result |
|----------|--------|
| `register()` wires hooks and services | 2 hooks (`before_agent_start`, `agent_end`) + 1 service registered |
| Recall returns semantically relevant memories | DB questions → PostgreSQL facts, language questions → TypeScript facts |
| Memories formatted as `<cortex_memories>` XML | Confirmed across all 4 turns |
| Capture fires after every turn | No errors on any turn |
| Latency warms up over turns | 2686ms (cold) → 1083ms → 1293ms → 774ms (warm) |
| Services start and stop cleanly | Latency report printed on shutdown |

### Simulated prompts

| Turn | Prompt | Memories Recalled |
|------|--------|-------------------|
| 1 | "What database does this project use?" | 6 — PostgreSQL, pgvector |
| 2 | "Can you help me add a new index to the users table?" | 7 — PostgreSQL, Ubundi |
| 3 | "What language is the backend written in?" | 7 — TypeScript decisions |
| 4 | "Add a caching layer in front of database queries" | 6 — PostgreSQL, pgvector |

### Limitations

- The simulated agent is a fake function, not an LLM — it can't validate that `prependContext` actually improves responses
- `prependContext` consumption by OpenClaw can only be verified inside OpenClaw

---

## Persistence Proof (test-persistence.ts)

```bash
CORTEX_API_KEY=your-key npx tsx test-persistence.ts
```

Proves that data captured via `ingestConversation()` actually persists in Cortex and is retrievable via `retrieve()`.

### How it works

1. **Ingest** — sends a conversation containing a unique marker string (`persistence-proof-TIMESTAMP`)
2. **Wait 15s** — allows Cortex to index the ingested data
3. **Recall** — queries Cortex for the marker
4. **Assert** — checks that the marker appears in the recalled results

### Test result (Feb 17, 2026)

```
Marker: persistence-proof-1771334865769

1. Ingesting conversation with unique marker...
   Ingested: 3 facts, 2 entities, 5 nodes created
   Facts:
     - "User's secret project codename is persistence-proof-1771334865769"
     - "User's secret project uses Rust for the backend"
     - "Assistant noted that the project codename is persistence-proof-..."

2. Waiting 15s for Cortex to index...

3. Recalling with marker query...
   Retrieved 11 results

4. PASS — Data persisted and retrieved successfully.
   Match: "User's secret project codename is persistence-proof-1771334865769"
   Score: 0.84
```

### What this proves

- `ingestConversation()` successfully stores data in Cortex
- Cortex extracts structured facts and entities from raw conversation
- Ingested data is retrievable via semantic search within ~15 seconds
- The full capture → index → recall pipeline works end-to-end

---

## File Sync Proof (test-filesync.ts)

```bash
CORTEX_API_KEY=your-key npx tsx test-filesync.ts
```

Proves that all three file sync channels work: MEMORY.md, daily logs, and session transcripts. Creates a temp workspace, starts the plugin with `fileSync: true` and `transcriptSync: true`, writes files, waits for ingestion + indexing, then recalls to verify.

### How it works

1. **Create temp workspace** — `MEMORY.md`, `memory/`, `sessions/` directories
2. **Start plugin** with file sync enabled — watchers attach to all three paths
3. **Write MEMORY.md** — adds a line with a unique marker
4. **Write daily log** — creates `memory/2026-02-17.md` with marker content
5. **Write transcript** — creates `sessions/test-session.jsonl` with marker dialogue
6. **Wait 18s** — 2s debounce + ingestion + Cortex indexing
7. **Recall each source** — queries Cortex for the marker from each file type
8. **Cleanup** — removes temp workspace

### Test result (Feb 17, 2026)

```
Marker: filesync-1771335406558

=== 1. Register plugin with fileSync + transcriptSync ===
  File sync: watching MEMORY.md
  File sync: watching memory/*.md
  File sync: watching sessions/*.jsonl

=== 2-4. Write files ===
  MEMORY.md: "The project codename for file sync test is filesync-... and it uses Elixir."
  memory/2026-02-17.md: deployment + migration notes
  sessions/test-session.jsonl: 2-message dialogue about deployment

=== 5. Wait 18s for debounce + ingestion + indexing ===
  Transcript sync: ingested 2 facts from test-session.jsonl (3 nodes)
  Daily log sync: ingested from 2026-02-17.md
  MEMORY.md sync: ingested diff

=== 6. Recall tests ===
  [MEMORY.md]     PASS — content recalled
  [Daily Log]     PASS — content recalled
  [Transcript]    PASS — content recalled

Results: 3 passed, 0 failed
```

### What this proves

- File watchers attach correctly to `MEMORY.md`, `memory/*.md`, and `sessions/*.jsonl`
- MEMORY.md debounce (2s) and line-diff detection work — only new lines are ingested
- Daily log offset-based append detection works — new content is ingested on file change
- Transcript cleaner processes `.jsonl` files and extracts conversation messages
- All three ingestion paths deliver data to Cortex successfully
- Ingested file content is retrievable via semantic recall

---

## OpenClaw Hook Contract Verification

Verified against OpenClaw source (`openclaw/openclaw` on GitHub, `src/plugins/types.ts`):

### `before_agent_start` — Recall Hook

| Field | OpenClaw sends | Our plugin expects | Match |
|-------|---------------|-------------------|-------|
| `event.prompt` | `string` | `string` | Yes |
| `event.messages` | `unknown[]` (optional) | `unknown[]` (optional) | Yes |
| `ctx.agentId` | `string?` | `string?` | Yes |
| `ctx.sessionKey` | `string?` | `string?` | Yes |
| `ctx.sessionId` | `string?` | `string?` | Yes |
| `ctx.workspaceDir` | `string?` | `string?` | Yes |
| `ctx.messageProvider` | `string?` | not used | Fine (extra field ignored) |
| Returns `prependContext` | Merged via `mergeBeforePromptBuild` | Yes | Yes |

### `agent_end` — Capture Hook

| Field | OpenClaw sends | Our plugin expects | Match |
|-------|---------------|-------------------|-------|
| `event.messages` | `unknown[]` | `unknown[]` | Yes |
| `event.success` | `boolean` | `boolean` | Yes |
| `event.error` | `string?` | `string?` | Yes |
| `event.durationMs` | `number?` | `number?` | Yes |
| Context fields | Same `PluginHookAgentContext` | Same shape | Yes |
| Returns void | Fire-and-forget | Yes | Yes |

### `prependContext` handling

OpenClaw concatenates `prependContext` from multiple plugins with `\n\n`:

```typescript
prependContext: acc?.prependContext && next.prependContext
  ? `${acc.prependContext}\n\n${next.prependContext}`
  : (next.prependContext ?? acc?.prependContext),
```

Our `<cortex_memories>` XML block will be injected correctly.

### Logger compatibility

OpenClaw's `PluginLogger` expects `(message: string)` — single string argument. All plugin logger calls updated to use template literals (`\`Cortex recall failed: ${String(err)}\``) instead of variadic args.

### Reference implementation

Verified against OpenClaw's bundled `memory-lancedb` plugin (`extensions/memory-lancedb/index.ts`) which uses the same pattern:
- `api.on("before_agent_start", ...)` returning `{ prependContext }`
- `api.on("agent_end", ...)` as fire-and-forget
- `api.registerService(...)` with `start`/`stop`

---

## What remains untested

These can only be validated by running the plugin inside OpenClaw:

| Gap | Why |
|-----|-----|
| `prependContext` consumption | We return it from the hook, but only OpenClaw can confirm it reaches the LLM context |
| Periodic reflect | `/v1/reflect` returns 404 — blocked on Cortex backend |
| Retry queue under real network conditions | Unit tested with mocks, but real transient failures may behave differently |
| Plugin discovery and loading | `openclaw plugins install @ubundi/openclaw-cortex` → does OpenClaw find and load the manifest correctly? |

---

## Running all tests

```bash
# Unit tests (no API key needed)
npm test

# Integration tests (requires live Cortex API)
CORTEX_API_KEY=your-key npm run test:integration

# Full lifecycle simulation
CORTEX_API_KEY=your-key npx tsx test-harness.ts

# Persistence proof
CORTEX_API_KEY=your-key npx tsx test-persistence.ts

# File sync proof
CORTEX_API_KEY=your-key npx tsx test-filesync.ts
```
