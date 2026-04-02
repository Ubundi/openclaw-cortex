# OpenClaw-Cortex Learnings Reference

This document is a deep technical reference for both human engineers and coding agents working in the `openclaw-cortex` repo. It is intentionally reference-first rather than tutorial-first: every section aims to answer one or more of these questions quickly:

- What is this subsystem for?
- How does it actually work in the current implementation?
- What assumptions or trade-offs does it encode?
- If I need to change behavior, which files should I touch?
- If something breaks, where should I look first?

This file is grounded in the current implementation and companion docs, especially:

- `README.md`
- `CLAUDE.md`
- `docs/agent/SKILL.md`
- `docs/agent/plugin_hooks.md`
- `docs/agent/testing.md`
- `docs/testing/TESTING.md`
- `docs/architecture/HYBRID_ARCHITECTURE.md`
- `docs/architecture/CORTEX_API.md`

## Table of Contents

1. [Executive Model](#executive-model)
2. [System Boundaries](#system-boundaries)
3. [Runtime Lifecycle](#runtime-lifecycle)
4. [Recall Internals](#recall-internals)
5. [Capture Internals](#capture-internals)
6. [Session Goals, Recovery, and Continuity](#session-goals-recovery-and-continuity)
7. [Agent-Facing Behavior](#agent-facing-behavior)
8. [Tools, Commands, and CLI Surfaces](#tools-commands-and-cli-surfaces)
9. [Configuration Semantics](#configuration-semantics)
10. [Heartbeat, Metrics, and Background Maintenance](#heartbeat-metrics-and-background-maintenance)
11. [Testing and Verification](#testing-and-verification)
12. [Debugging Guide](#debugging-guide)
13. [How to Change X](#how-to-change-x)
14. [Key Gotchas and Trade-offs](#key-gotchas-and-trade-offs)
15. [Practical Start Points](#practical-start-points)

## Executive Model

`@ubundi/openclaw-cortex` is an OpenClaw plugin that adds a long-term memory layer backed by the Cortex API. The plugin does three major jobs:

1. It injects relevant memories before model turns.
2. It captures durable information after turns.
3. It exposes explicit memory tools, commands, CLI surfaces, and health/status plumbing.

The plugin is not a replacement for OpenClaw's built-in memory system. It is a supplemental layer:

- OpenClaw native memory remains file-first and local.
- Cortex adds structured, cross-session, API-backed memory.
- The plugin is the glue that makes Cortex feel native inside OpenClaw.

The most important conceptual split is:

- Automatic memory flow:
  - Auto-recall on `before_agent_start`
  - Auto-capture on `agent_end`
  - Recovery context
  - Heartbeat refresh / reflect behavior
- Explicit agent-driven memory operations:
  - `cortex_search_memory`
  - `cortex_save_memory`
  - `cortex_get_memory`
  - `cortex_forget`
  - `cortex_set_session_goal`
  - `/checkpoint`, `/sleep`, `/audit`
  - `openclaw cortex ...` CLI commands

If you keep that split clear, most of the codebase makes sense quickly.

## System Boundaries

### What OpenClaw owns

OpenClaw owns the runtime, agent lifecycle, plugin loading, base memory system, session event stream, tools profile, and command surfaces.

Important practical consequence:

- This plugin must adapt to OpenClaw runtime quirks rather than assuming an ideal plugin host.

### What Cortex owns

Cortex owns the remote memory backend: ingest, retrieve, forget, knowledge stats, async jobs, reflection, and tenant isolation.

Important practical consequence:

- Retrieval quality, indexing lag, score calibration, and some API semantics depend on the backend, not just this repo.

### What this plugin owns

This plugin owns:

- translating OpenClaw events into Cortex API calls
- formatting memory for model consumption
- filtering noisy capture data
- keeping memory traffic non-blocking and resilient
- exposing explicit memory actions as tools and commands
- bridging human/agent workflow expectations with actual backend behavior

### Why there is both a skill and a plugin

The repo also carries agent docs and a standalone `cortex-memory` skill. That exists because an OpenClaw skill is only prompt-level instruction. A skill can tell an agent how to call Cortex manually, but it cannot:

- register lifecycle hooks
- run background maintenance
- watch files
- register programmatic tools
- inject memory automatically per turn

So the current architecture is intentionally hybrid:

- Skill:
  - zero-dependency, prompt-level guidance, manual `curl` path
- Plugin:
  - automatic lifecycle integration and runtime-level capabilities

This is one of the core design learnings of the project.

## Runtime Lifecycle

### Core entry point

The main orchestration lives in `src/plugin/index.ts`.

This file is where the plugin:

- validates config
- resolves API key and user identity
- bootstraps client health/knowledge state
- creates recall/capture/heartbeat handlers
- injects AGENTS.md instructions
- registers tools, commands, hooks, services, CLI commands, and gateway methods

If you need to understand "how the whole thing gets wired together", start here.

### The dual-instance runtime quirk

One of the most important non-obvious behaviors is that OpenClaw runs two plugin instances:

- `[gateway]`
- `[plugins]`

Only the gateway instance gets `start()` called. Both instances can still need working hooks and commands.

That is why several things that might seem like service-start responsibilities actually happen eagerly during `register()`:

- user ID resolution
- client bootstrap
- command and hook readiness

This is not just an implementation preference. It is a runtime survival requirement. If you move critical initialization into `start()`, the non-gateway instance can silently misbehave.

### Hook registration compatibility

The plugin uses `registerHookCompat()` and prefers `api.on()` over `api.registerHook()`.

Why this matters:

- `api.registerHook()` may make hooks visible in OpenClaw UI/listing surfaces
- `api.on()` is what actually wires event dispatch reliably for lifecycle hooks

This is called out in both repo docs and code because it is an easy regression point for future refactors.

### Service lifecycle

The plugin also registers a service, but service startup is not the only lifecycle that matters.

Current service responsibilities include:

- retry queue lifecycle
- namespace derivation from workspace
- file-sync/watcher startup where applicable
- audit logger setup

Practical rule:

- If behavior must work before or without `start()`, do not place it only in service startup.

## Recall Internals

### Primary file

Recall behavior is centered in `src/features/recall/handler.ts`.

Supporting files:

- `src/features/recall/context-profile.ts`
- `src/features/recall/formatter.ts`
- `src/internal/message-provenance.ts`
- `src/internal/heartbeat-detect.ts`
- `src/internal/recall-echo-store.ts`

### What recall does at runtime

On `before_agent_start`, the plugin tries to prepend a `<cortex_memories>` block to the model context.

High-level flow:

1. hook fires
2. skip if auto-recall is disabled
3. choose a query source
4. skip heartbeats and some empty/too-short turns
5. skip when knowledge is known-empty, with periodic rechecks
6. infer or apply a recall profile
7. merge prompt, recent factual context, session goal, and role context
8. call `/v1/retrieve`
9. downgrade/retry/fallback if needed
10. format results and prepend them to the model input

### Query selection

The handler prefers the latest relevant user message over the raw prompt string. This is important because OpenClaw prompts can contain injected context or wrapper material that is not the actual user intent.

The logic also strips prior injected Cortex blocks so the plugin does not recursively query on its own memory formatting.

This is a very practical design choice:

- use the freshest user-authored signal
- avoid querying on previously injected memory
- reduce false matches caused by wrapper prompt noise

### Recall profile inference

Profiles exist so recall behavior can adapt to the shape of the turn instead of treating every query as the same problem.

Current profile concept:

- `auto`
- `default`
- `factual`
- `planning`
- `incident`
- `handoff`

The profile affects things like:

- retrieval limit
- retrieval mode
- query type
- optional context inclusion
- filtering expectations

If recall quality feels wrong for certain classes of prompts, profile inference is one of the first places to inspect.

### Factual context injection

For factual queries, the plugin can append a compact `Context:` block built from recent conversation lines. This is not the same thing as raw transcript replay. It is a bounded, filtered context slice intended to help the backend disambiguate factual follow-up questions.

This matters for prompts like:

- "what port was it again?"
- "which package did we settle on?"
- "what was the TTL?"

Without this, factual recall can over-index on globally relevant facts rather than the current thread of discussion.

### Session goal and role bias

Recall can be biased by two additional context sources:

- active session goal
- role preset context

The session goal is passed as a dedicated `session_goal` parameter to `/v1/retrieve`.

Role context is merged as descriptive query context such as:

- "software engineering, technical decisions, code architecture"

These biases are meant to improve retrieval relevance without fully rewriting the user's query.

### Retrieve first, fallback second

The preferred path is `/v1/retrieve`, which is the richer backend retrieval pipeline. If that path yields no results, the plugin can fall back to the broader agent-oriented `/v1/recall` API.

This fallback exists because:

- the richer path can sometimes return nothing for a real question
- the older/broader path can still salvage useful recall

Important learning:

- the plugin is opinionated about returning something useful when possible, but it still avoids fabricating memory context if both paths come back empty

### Timeouts, tiering, and cold-start behavior

Recall timeout handling is more nuanced than "abort after N milliseconds".

The plugin scales effective timeouts based on pipeline tier:

- tier 1: configured timeout
- tier 2: larger minimum / multiplier
- tier 3: larger again

Why:

- heavier backend tiers do more work
- a timeout that is fine for flat retrieval can be wrong for graph/reranked retrieval

The handler also has cold-start protection:

- after repeated hard failures, recall is temporarily disabled
- timeouts from slow service are treated differently from hard unreachable failures

The design goal is not "always recall". The design goal is:

- recall when healthy
- do not stall the user when unhealthy
- do not keep hammering a dead backend

### Fast-mode downgrade behavior

If the plugin thinks tier information is still unknown or a full retrieval times out, it can downgrade to `fast` mode.

This is one of the key production behaviors to preserve. Full recall quality is valuable, but the plugin prioritizes not blocking agent turns.

### Knowledge-empty skip behavior

When the plugin believes there are no memories yet, it skips recall entirely for a while and only rechecks the knowledge endpoint periodically.

This avoids wasting network work on a known-empty store, but it also includes a recheck loop so the plugin can recover when another instance or process ingests memories later.

### Recall output formatting

The final output is not a raw API payload. It is a curated XML-ish block for model consumption.

Formatting responsibilities include:

- score presentation
- collapsing/ordering
- safe escaping of adversarial content
- optional stats / "more available" hints

If the model starts behaving strangely in the presence of recalled content, inspect formatter behavior before assuming retrieval itself is wrong.

### Files to change for recall work

- query selection / skip rules:
  - `src/features/recall/handler.ts`
- profile inference and parameters:
  - `src/features/recall/context-profile.ts`
- rendered memory block format:
  - `src/features/recall/formatter.ts`
- conversation provenance filtering:
  - `src/internal/message-provenance.ts`
- heartbeat-turn detection:
  - `src/internal/heartbeat-detect.ts`
- recall echo suppression support:
  - `src/internal/recall-echo-store.ts`

## Capture Internals

### Primary file

Capture behavior is centered in `src/features/capture/handler.ts`.

Supporting files:

- `src/features/capture/filter.ts`
- `src/features/capture/compressor.ts`
- `src/internal/capture-watermark-store.ts`
- `src/internal/message-provenance.ts`
- `src/internal/recall-echo-store.ts`
- `src/internal/retry-queue.ts`

### What capture does at runtime

On `agent_end`, the plugin tries to ingest newly created durable conversation value into Cortex.

The important phrase is "newly created". Capture is delta-based, not whole-history based.

High-level flow:

1. hook fires
2. skip if auto-capture is disabled
3. skip aborted turns
4. use watermark to isolate only new messages
5. filter conversation candidates by provenance and role
6. sanitize and low-signal filter
7. strip volatile/transient content
8. suppress assistant echoes of recalled memory
9. skip low-value exchanges
10. cap/compress payload
11. dedupe repeated turns
12. submit async ingest job
13. queue retry if submission fails

### Watermarking

Watermarking is one of the most important capture design decisions. The plugin stores how much of the message stream has already been captured and only processes the delta after that point.

Without this, the plugin would keep re-ingesting the same transcript repeatedly and pollute memory.

If you ever see repeated memory duplication across normal conversation turns, watermark handling is a top suspect.

### Why capture is async

The plugin uses async job submission rather than blocking synchronous ingest for conversation capture.

Reason:

- large or slow ingest requests can hit proxy/runtime timeout behavior
- capture should never make the user wait for a post-turn memory operation

This is one of the strongest production learnings in the codebase:

- memory capture is useful, but user-facing responsiveness is more important than synchronous certainty

### Low-signal and volatile filtering

Capture does not treat every assistant response as durable memory material.

It deliberately filters out:

- heartbeat traffic
- TUI/status noise
- token counters / ephemeral operational noise
- stale transient statements
- some short or trivial exchanges

The purpose is to avoid a memory store full of:

- operational chatter
- stale process state
- repeated progress boilerplate

This is one of the most sensitive quality knobs in the system. Too permissive and memory quality degrades. Too aggressive and important details never land in Cortex.

### Echo suppression

The plugin tracks recently recalled content and avoids capturing assistant messages that merely parrot what was just injected from memory.

This protects against a classic memory feedback loop:

1. plugin recalls a memory
2. agent repeats it
3. capture ingests the repetition
4. retrieval becomes even more dominated by that same memory

This anti-loop logic is a major quality defense. Changes here should be handled carefully and tested specifically.

### Probe lookup suppression

The capture handler recognizes some short lookup-style turns and intentionally skips capturing them, except for benchmark seed sessions that need factual seed content retained.

This is another example of the repo encoding benchmark and production learnings directly into runtime behavior.

### Payload controls

Capture enforces multiple payload constraints:

- message count cap
- byte-size cap
- character cap
- per-message compression for oversized content

This exists because user/agent traffic can include pasted files, long outputs, or dense generated text. The plugin would rather trim oldest material and keep moving than fail hard on payload size.

### Duplicate-turn suppression

The handler keeps an in-memory fingerprint map of recent user/assistant turn pairs and skips duplicates within a TTL window.

This helps protect against:

- repeated benchmark probes
- agent repetition loops
- upstream replay weirdness

### Session goal tagging on capture

If session goals are enabled, the active goal is attached to capture payloads. This means goals influence not only retrieval but also the metadata created during ingest.

### Files to change for capture work

- main capture logic:
  - `src/features/capture/handler.ts`
- low-signal / volatile filtering:
  - `src/features/capture/filter.ts`
- oversized content compression:
  - `src/features/capture/compressor.ts`
- watermark persistence:
  - `src/internal/capture-watermark-store.ts`
- retry behavior:
  - `src/internal/retry-queue.ts`
- echo suppression support:
  - `src/internal/recall-echo-store.ts`
- message selection rules:
  - `src/internal/message-provenance.ts`

## Session Goals, Recovery, and Continuity

### Session goals

Session goals are a lightweight way of telling the memory system what this session is actually about.

Stored in:

- `src/internal/session-goal.ts`

Used by:

- recall retrieval bias
- capture tagging
- recovery context restoration
- explicit `cortex_set_session_goal` tool flow

This is conceptually important because it separates:

- user query text
- ongoing session objective

That helps ambiguous turns retrieve memories relevant to the actual project or task arc.

### Dirty session state and recovery

Recovery is implemented in `src/internal/session-state.ts`.

The plugin persists session continuity state so that if a prior lifecycle ended uncleanly, the next session can see:

- prior session key
- last activity timestamp
- prior summary
- prior session goal

This is rendered into a `<cortex_recovery>` block on the next session.

Important learning:

- recovery content is intended as context, not instructions
- the recovery formatter explicitly labels it that way

### Why `/checkpoint` and `/sleep` matter

`/checkpoint` exists to intentionally persist a useful session summary before a reset or session transition.

`/sleep` exists to mark a clean ending and clear dirty-session warning state.

Without this pair, session recovery becomes more accidental and less meaningful.

### Files to change

- session goal storage:
  - `src/internal/session-goal.ts`
- dirty session storage / recovery formatting:
  - `src/internal/session-state.ts`
- checkpoint command behavior:
  - `src/features/checkpoint/handler.ts`
- user command wiring:
  - `src/plugin/commands.ts`

## Agent-Facing Behavior

### AGENTS.md injection

The plugin can append or update a Cortex memory section inside `AGENTS.md`.

This logic lives in `src/internal/agent-instructions.ts`.

What it does:

- looks for a `## Cortex Memory` marker
- appends if missing
- replaces stale content if the hash changed
- leaves it alone if current

The injected block is intentionally concise. It lists:

- what happens automatically
- available tools
- commands
- the distinction between Cortex memory and file memory
- optional role / capture guidance

The design intent is important:

- keep AGENTS injection small
- defer detailed operational behavior to the richer skill/docs

That was reinforced by recent commits that explicitly slimmed AGENTS injection and deferred detail to the skill.

### Role detection and presets

Role detection lives in `src/internal/agent-roles.ts`.

The plugin can infer a role by scanning bootstrap files such as:

- `SOUL.md`
- `AGENTS.md`
- `USER.md`
- `IDENTITY.md`

It scores text against signal regexes and only classifies when:

- the score is above a threshold
- there is a clear winner

This matters because role is not cosmetic. It shapes:

- capture instructions
- capture categories
- recall context bias

Current built-in roles:

- `developer`
- `researcher`
- `manager`
- `support`
- `generalist`

### Practical interpretation

Role presets are best thought of as memory specialization hints, not persona engines.

If you want the plugin to remember engineering trade-offs better, role presets are the right place.

If you want the agent to sound different, this is probably the wrong subsystem.

### Files to change

- AGENTS block content:
  - `src/internal/agent-instructions.ts`
- role presets and inference:
  - `src/internal/agent-roles.ts`
- registration / injection timing:
  - `src/plugin/index.ts`

## Tools, Commands, and CLI Surfaces

### Tool surface

Tool implementations live in `src/plugin/tools.ts`.

The core tools are:

- `cortex_search_memory`
- `cortex_save_memory`
- `cortex_get_memory`
- `cortex_forget`
- `cortex_set_session_goal`

These are explicit agent affordances. They are not substitutes for automatic recall/capture; they are escape hatches and control points for when the model needs deterministic memory interaction.

### Search tool behavior

`cortex_search_memory` is more opinionated than a thin API wrapper.

It supports:

- mode coercion / query preparation
- scope handling
- retry on transient failures
- role context inclusion
- local result filtering / formatting

It is effectively the "agent-friendly search adapter" layer.

If search results feel bad in tool usage but auto-recall is okay, inspect:

- `src/plugin/tools.ts`
- `src/plugin/search-query.ts`

before blaming the backend.

### Save tool behavior

The save path includes:

- explicit save semantics
- optional novelty checking
- recent-save dedupe window
- fallback behavior when direct remember is not enough

This is one of the main places where the plugin tries to avoid redundant or low-value writes.

### Forget and get-memory behavior

These tools are important for trust and inspectability:

- `cortex_get_memory` lets agents inspect a specific node by ID
- `cortex_forget` provides scoped deletion workflows

The repo has had fixes around node ID preservation and actual API response shape alignment, so this is a good subsystem to regression-test when backend contracts change.

### Command surface

User-facing commands are wired in `src/plugin/commands.ts`.

Current commands:

- `/audit`
- `/checkpoint`
- `/sleep`

These commands do not require invoking the model for basic function.

### CLI surface

Terminal-level OpenClaw CLI integration is implemented under:

- `src/plugin/cli.ts`

This is the path for `openclaw cortex ...` commands such as status, search, and config/status-oriented workflows.

### Files to change

- tool implementations:
  - `src/plugin/tools.ts`
- tool search heuristics:
  - `src/plugin/search-query.ts`
- command handlers / wiring:
  - `src/plugin/commands.ts`
- CLI wiring:
  - `src/plugin/cli.ts`

## Configuration Semantics

### Primary file

Config schema lives in `src/plugin/config.ts`.

### Important defaults

Current defaults include:

- `autoRecall: false`
- `autoCapture: true`
- `recallLimit: 20`
- `recallTopK: 10`
- `recallProfile: "auto"`
- `recallQueryType: "combined"`
- `recallTimeoutMs: 60000`
- `toolTimeoutMs: 60000`
- `captureMaxPayloadBytes: 262144`
- `captureFilter: true`
- `dedupeWindowMinutes: 30`
- `noveltyThreshold: 0.85`
- `auditLog: true`
- `namespace: "openclaw"`
- `sessionGoal: true`

Note that some older docs or mental models may mention different defaults, especially around audit logging and earlier timeout assumptions. When in doubt, trust the schema in code.

### Semantic groups

You can think of config in five groups:

1. connectivity and identity
   - `apiKey`
   - `baseUrl`
   - `userId`
   - `namespace`
2. recall behavior
   - `autoRecall`
   - `recallLimit`
   - `recallTopK`
   - `recallQueryType`
   - `recallProfile`
   - `recallTimeoutMs`
   - `recallReferenceDate`
3. capture behavior
   - `autoCapture`
   - `captureMaxPayloadBytes`
   - `captureFilter`
   - `captureInstructions`
   - `captureCategories`
4. write hygiene
   - `dedupeWindowMinutes`
   - `noveltyThreshold`
5. context shaping and observability
   - `auditLog`
   - `sessionGoal`
   - `agentRole`

### Practical notes

- `baseUrl` enforces HTTPS except localhost development.
- `userId` is auto-generated and persisted if not explicitly supplied.
- `namespace` can be auto-derived from workspace path and hash.
- `recallReferenceDate` is mainly for benchmarks and historical replay.
- `captureInstructions` and `captureCategories` are for focused memory shaping, not general prompting.

### Files to change

- schema and defaults:
  - `src/plugin/config.ts`
- manifest/UI mirror:
  - `openclaw.plugin.json`
- docs:
  - `README.md`

Whenever config changes, update all three, not just the code schema.

## Heartbeat, Metrics, and Background Maintenance

### Heartbeat handler

Heartbeat behavior lives in `src/features/heartbeat/handler.ts`.

It performs periodic background maintenance such as:

- retry queue visibility
- knowledge refresh
- occasional stats refresh for pipeline tier
- reflect triggering after enough captures and enough elapsed time

This is not a turn-level memory operation. It is maintenance plumbing.

### Why heartbeat exists

Without heartbeat, the plugin would rely only on turn traffic to learn:

- whether knowledge state changed
- whether the backend maturity/tier changed
- whether consolidation should happen

Heartbeat makes the plugin more self-healing and observably alive.

### Metrics and stats

The plugin also tracks session stats and latency metrics in support code like:

- `src/internal/latency-metrics.ts`
- persistent stats handling in `src/plugin/index.ts`

These are useful for:

- recall counts
- save/search counts
- duplicate suppression visibility
- latency distributions

### Files to change

- heartbeat policy:
  - `src/features/heartbeat/handler.ts`
- latency calculations:
  - `src/internal/latency-metrics.ts`
- persistent session stats:
  - `src/plugin/index.ts`

## Testing and Verification

### Testing layers

The repo intentionally uses several testing layers:

1. unit tests
2. integration tests
3. manual harness scripts
4. live validation checklists / benchmark-driven validation

This matters because some behaviors are local logic problems while others only show up against a live OpenClaw runtime or live Cortex backend.

### Unit tests

Unit tests are the fastest confidence layer and mock external calls.

Good for:

- config validation
- handler logic
- filters
- formatter behavior
- retry and dedupe logic
- lifecycle wiring assumptions

When changing core runtime logic, add or update unit coverage first if possible.

### Integration tests

Integration tests hit the live Cortex API and are useful for contract-level confidence:

- health
- ingest
- retrieve
- end-to-end recall pipeline basics

These help catch backend contract drift.

### Manual tests and live checklist

`docs/testing/TESTING.md` is especially useful because it is not just a generic testing guide. It is a detailed validation ledger of which behaviors have actually been proven live, with caveats preserved.

This is an unusually valuable repo artifact. If you need to know whether a behavior is theoretically supported or empirically validated, this file is one of the best sources.

### Recommended local verification for most code changes

- `npm test`
- `npx tsc --noEmit`

If you touched live-client contracts or runtime behavior:

- relevant integration tests
- relevant manual or live validation path

### High-value test files by subsystem

- recall:
  - `tests/unit/recall.test.ts`
  - `tests/unit/cold-start.test.ts`
  - `tests/unit/format.test.ts`
- capture:
  - `tests/unit/capture.test.ts`
  - `tests/unit/capture-filter.test.ts`
  - `tests/unit/compressor.test.ts`
- tools:
  - `tests/unit/tools.test.ts`
- lifecycle/config:
  - `tests/unit/plugin-lifecycle.test.ts`
  - `tests/unit/config.test.ts`
  - `tests/unit/cli.test.ts`
- recovery/session:
  - `tests/unit/session-state.test.ts`
  - `tests/unit/checkpoint.test.ts`
- internals:
  - `tests/unit/retry-queue.test.ts`
  - `tests/unit/audit-logger.test.ts`
  - `tests/unit/agent-instructions.test.ts`
  - `tests/unit/agent-roles.test.ts`

## Debugging Guide

### Missing recall

Check in this order:

1. is `autoRecall` enabled?
2. does knowledge state believe there are memories?
3. is the turn being classified as heartbeat?
4. is the prompt too short or empty after stripping?
5. is cold-start cooldown active?
6. did `/v1/retrieve` or fallback `/v1/recall` fail?
7. did formatter produce an empty block because results were filtered out?

Best files:

- `src/features/recall/handler.ts`
- `src/features/recall/context-profile.ts`
- `src/features/recall/formatter.ts`
- `.cortex/audit/` if audit is enabled

### Missing capture

Check in this order:

1. is `autoCapture` enabled?
2. was the turn aborted?
3. did watermark leave no new delta?
4. did provenance filtering drop the messages?
5. did low-signal or volatile filtering erase the value?
6. was it classified as heartbeat or probe lookup?
7. did echo suppression remove the assistant turn?
8. did async submission fail and enter retry queue?

Best files:

- `src/features/capture/handler.ts`
- `src/features/capture/filter.ts`
- `src/internal/message-provenance.ts`
- `src/internal/retry-queue.ts`

### Wrong memories recalled

Check:

- profile inference
- session goal bias
- role context bias
- retrieve mode downgrade behavior
- fallback recall path
- formatter ordering / filtering

Also consider that the backend itself may be returning globally relevant rather than query-specific results. The repo's analysis docs have examples of exactly this kind of underperformance investigation.

### Commands/tools available but acting oddly

Check:

- tools profile in OpenClaw
- whether the runtime supports `api.registerTool()`
- search-query preparation logic
- API response contract assumptions in `src/plugin/tools.ts`

### AGENTS.md not updating

Check:

- whether `AGENTS.md` exists in the workspace
- whether marker/hash logic thinks the section is current
- whether file write failed and was only warned

Best file:

- `src/internal/agent-instructions.ts`

## How to Change X

### Change recall query selection

Edit:

- `src/features/recall/handler.ts`

Look for:

- latest user message extraction
- prompt stripping
- recent conversation context construction
- query/context merging

### Change recall strategy or prompt-type handling

Edit:

- `src/features/recall/context-profile.ts`
- `src/features/recall/handler.ts`

### Change how recalled memories are shown to the agent

Edit:

- `src/features/recall/formatter.ts`

### Change capture filtering or memory pollution defenses

Edit:

- `src/features/capture/filter.ts`
- `src/features/capture/handler.ts`

### Change duplicate suppression for capture

Edit:

- `src/features/capture/handler.ts`

### Change capture watermark behavior

Edit:

- `src/internal/capture-watermark-store.ts`
- `src/features/capture/handler.ts`

### Change session recovery behavior

Edit:

- `src/internal/session-state.ts`
- `src/plugin/index.ts`

### Change session goal behavior

Edit:

- `src/internal/session-goal.ts`
- `src/plugin/tools.ts`
- `src/features/recall/handler.ts`
- `src/features/capture/handler.ts`

### Change AGENTS.md injection content

Edit:

- `src/internal/agent-instructions.ts`

### Change role presets or auto-detection

Edit:

- `src/internal/agent-roles.ts`

### Change tool behavior

Edit:

- `src/plugin/tools.ts`
- `src/plugin/search-query.ts`

### Change slash commands

Edit:

- `src/plugin/commands.ts`
- specific feature handlers if needed

### Change CLI behavior

Edit:

- `src/plugin/cli.ts`

### Change config defaults or schema

Edit:

- `src/plugin/config.ts`
- `openclaw.plugin.json`
- `README.md`

### Change client/backend contract handling

Edit:

- `src/cortex/client.ts`

Then re-check:

- tools
- recall
- capture
- integration tests

### Change startup/bootstrap/runtime wiring

Edit:

- `src/plugin/index.ts`

Use extra caution here because small lifecycle changes can break one of the two OpenClaw plugin instances in non-obvious ways.

## Key Gotchas and Trade-offs

### The plugin is optimized for graceful degradation

Many code paths intentionally return "no memory" rather than surfacing a hard user-visible error.

That is a deliberate product choice. If you "improve visibility" by throwing more aggressively, you may make the runtime worse.

### Automatic memory quality is more important than raw ingest volume

Large parts of the codebase exist to avoid memory pollution:

- low-signal filtering
- volatile stripping
- probe lookup skipping
- echo suppression
- duplicate suppression
- dedupe / novelty checks on saves

If you loosen these without careful testing, the plugin may appear more active while becoming less useful.

### Some docs may lag the code

This repo has rich documentation, but defaults and API semantics evolve. When docs disagree with code, the implementation and tests should win.

### Runtime support is feature-gated by what OpenClaw exposes

Tools, commands, and gateway methods are conditionally registered. Do not assume every runtime supports every integration surface.

### Search quality and recall quality are related but not identical

Auto-recall and explicit tool search do not have identical shaping logic. A change that improves one can worsen the other.

### Benchmark behavior influenced some heuristics

Parts of the runtime include logic designed to make benchmark/probe traffic not poison long-term memory. Be careful when removing behavior that looks niche. It may encode painful empirical learnings.

### Heartbeat and turn hooks serve different goals

Do not stuff turn-level logic into heartbeat or vice versa without a strong reason. The repo treats user-facing latency and background maintenance as different concerns.

## Practical Start Points

### If you are a new human engineer

Read in this order:

1. `README.md`
2. `CLAUDE.md`
3. this file
4. `docs/agent/plugin_hooks.md`
5. `src/plugin/index.ts`
6. the subsystem file you plan to change

### If you are a coding agent dropped into this repo

Use this file as your high-level router, then go directly to:

- `src/plugin/index.ts` for wiring
- `src/features/recall/handler.ts` for pre-turn memory
- `src/features/capture/handler.ts` for post-turn memory
- `src/plugin/tools.ts` for explicit memory operations
- `src/plugin/config.ts` for behavioral defaults

Before making claims about behavior, check:

- unit tests for the subsystem
- `docs/testing/TESTING.md` for live validation status

### If you need one-sentence summaries

- Recall:
  - selective, profile-shaped, non-blocking memory injection before turns
- Capture:
  - filtered, delta-based, async memory ingestion after turns
- Session goals:
  - lightweight retrieval/capture bias for current task intent
- Recovery:
  - continuity hinting for unclean prior sessions
- Tools:
  - deterministic memory control when automatic flows are not enough
- Heartbeat:
  - maintenance and observability, not user-turn memory

## Final Mental Model

The best way to understand `openclaw-cortex` is as a quality-control layer between an event-driven agent runtime and a structured memory backend.

It is not just:

- "call retrieve before a turn"
- "call ingest after a turn"

It is a series of protective decisions about:

- what is worth remembering
- when memory should stay out of the way
- how to bias relevance without taking over the prompt
- how to survive backend slowness and runtime quirks
- how to give both people and agents explicit, inspectable control when the automatic path is not enough

If you preserve those goals while changing implementation details, you will usually stay aligned with how the repo is meant to work.
