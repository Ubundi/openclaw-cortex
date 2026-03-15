# @ubundi/openclaw-cortex

[![npm version](https://img.shields.io/npm/v/%40ubundi%2Fopenclaw-cortex.svg)](https://www.npmjs.com/package/@ubundi/openclaw-cortex)
[![CI](https://github.com/Ubundi/openclaw-cortex/actions/workflows/ci.yml/badge.svg)](https://github.com/Ubundi/openclaw-cortex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

![OpenClaw Cortex Banner](assets/readme_assets/Hero%20Banner.png)

[OpenClaw](https://github.com/openclaw/openclaw) plugin for [Cortex](https://github.com/ubundi/cortex) long-term memory. Gives your agent persistent memory that survives across sessions — who you are, what your project does, decisions you made weeks ago, and how things changed over time.

![Features](assets/readme_assets/Feature%20Cards.png)

- **Auto-Recall** — injects relevant memories before every agent turn via `before_agent_start` hook
- **Auto-Capture** — extracts facts from conversations via `agent_end` hook
- **Agent Tools** — `cortex_search_memory` and `cortex_save_memory` tools the LLM can invoke directly
- **Commands** — `/checkpoint` to save session context, `/sleep` to mark a clean end, `/audit` to toggle local logging
- **CLI Commands** — `openclaw cortex {status,memories,search,config,pair,reset}` for terminal access
- **Recovery Detection** — detects unclean prior sessions and prepends recovery context at session start
- **Heartbeat** — periodic health, knowledge state refresh, and activity-aware reflect triggering via `gateway:heartbeat`
- **Gateway RPC** — `cortex.status` method for programmatic health and metrics access
- **Deduplication** — client-side dedupe window and novelty threshold to prevent redundant memory saves
- **Resilience** — retry queue with exponential backoff, cold-start detection, latency metrics

## Prerequisites

- Node.js `>=20`
- [OpenClaw](https://github.com/openclaw/openclaw) with plugin support (`openclaw` peer dependency is `>=0.1.0`)

## Installation

```bash
openclaw plugins install @ubundi/openclaw-cortex
```

Or link locally for development:

```bash
openclaw plugins install -l ./path/to/openclaw-cortex
```

## Quick Start

1. Install the plugin:

   ```bash
   openclaw plugins install @ubundi/openclaw-cortex
   ```

2. Set the tools profile to `full` so the agent can access memory tools:

   ```bash
   openclaw config set tools.profile full
   openclaw gateway restart
   ```

   > **Note:** OpenClaw defaults to the `messaging` tools profile, which excludes memory tools. The plugin's own tools (`cortex_search_memory`, `cortex_save_memory`) are registered directly and work on any profile, but the built-in `memory_search`, `read`, `write`, and other tools require `full`. This must be re-applied after running `openclaw configure` as the wizard resets it.

3. Add your API key and plugin config to `openclaw.json`:

   ```json
   {
     "plugins": {
       "entries": {
         "@ubundi/openclaw-cortex": {
           "enabled": true,
           "config": {
             "apiKey": "your-cortex-api-key"
           }
         }
       },
       "slots": {
         "memory": "@ubundi/openclaw-cortex"
       }
     }
   }
   ```

   Alternatively, set the `CORTEX_API_KEY` environment variable instead of putting the key in config:

   ```bash
   export CORTEX_API_KEY="your-cortex-api-key"
   ```

   On first run the plugin generates a unique ID for this installation, persists it at `~/.openclaw/cortex-user-id`, and scopes all memories to that ID.

4. Run an agent turn. If configured correctly, recall data is prepended in a `<cortex_memories>` block before the model turn.

## Configuration

Add to your `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "@ubundi/openclaw-cortex": {
        enabled: true,
        config: {
          apiKey: "your-cortex-api-key",  // required — or set CORTEX_API_KEY env var
          autoRecall: true,
          autoCapture: true,
          recallLimit: 20,
          recallTimeoutMs: 60000,
          toolTimeoutMs: 60000,
          // userId: "my-team-shared-id",  // override the auto-generated install ID
        },
      },
    },
    slots: {
      memory: "@ubundi/openclaw-cortex",
    },
  },
}
```

### Config Options

| Option                   | Type    | Default      | Description                                                                                      |
| ------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `apiKey`                 | string  | —            | **Required.** Your Cortex API key. Can also be set via the `CORTEX_API_KEY` environment variable. |
| `userId`                 | string  | _auto_       | Memory scope ID. Auto-generated per install and persisted at `~/.openclaw/cortex-user-id`. Override to share memory across machines or team members. |
| `autoRecall`             | boolean | `true`       | Inject relevant memories before each agent turn                                                  |
| `autoCapture`            | boolean | `true`       | Extract and store facts after each agent turn                                                    |
| `recallLimit`            | number  | `20`         | Max number of memories returned per recall                                                       |
| `recallTopK`             | number  | `10`         | Max memories returned after scoring (applied after `recallLimit`)                                |
| `recallQueryType`        | string  | `"combined"` | Recall query mode: `"factual"`, `"emotional"`, `"combined"`, or `"codex"`                        |
| `recallProfile`          | string  | `"auto"`     | Recall profile: `"auto"`, `"default"`, `"factual"`, `"planning"`, `"incident"`, `"handoff"`. `auto` picks the best profile based on context. |
| `recallTimeoutMs`        | number  | `60000`      | Auto-recall timeout in ms. Scales with knowledge tier via `deriveEffectiveTimeout`.              |
| `recallReferenceDate`    | string  | _now_        | Optional fixed ISO 8601 date as temporal anchor for recall. For benchmarks only — leave unset in production. |
| `toolTimeoutMs`          | number  | `60000`      | Timeout for explicit tool calls (`cortex_search_memory`, `/checkpoint`). Longer than auto-recall since the user is actively waiting. |
| `captureMaxPayloadBytes` | number  | `262144`     | Max byte size of capture payloads (256KB default). Oversized transcripts are trimmed from the oldest messages. |
| `captureFilter`          | boolean | `true`       | Enable built-in filter to drop low-signal content (heartbeat messages, TUI artifacts, token counters) before ingestion. |
| `auditLog`               | boolean | `false`      | Enable local audit log. Records every payload sent to Cortex at `.cortex/audit/` in the workspace. Also toggleable at runtime via `/audit on`. |
| `dedupeWindowMinutes`    | number  | `30`         | Time window (minutes) for client-side deduplication of explicit memory saves. Set to 0 to disable. |
| `noveltyThreshold`       | number  | `0.85`       | Similarity score (0–1) above which an existing memory is considered a duplicate. Lower = stricter. |
| `namespace`              | string  | `"openclaw"` | Memory namespace. Auto-derived from workspace directory when not set explicitly.                 |

## How It Works

![Architecture](assets/readme_assets/Arch%20Diagram.png)

## Source Layout

```text
src/
  index.ts                  # Public package entrypoint
  cortex/
    client.ts               # HTTP client for all Cortex API endpoints
  plugin/                   # Plugin wiring, config, CLI, tools, commands
    index.ts
    config.ts
    cli.ts
    commands.ts
    tools.ts
    search-query.ts
    types.ts
  features/                 # Feature modules
    capture/                # After-turn fact extraction
    checkpoint/             # /checkpoint command handler
    heartbeat/              # gateway:heartbeat hook
    recall/                 # Before-turn memory injection + context profiles
  internal/                 # Shared utilities (not stable public API)
    agent-instructions.ts
    api-key.ts
    audit-logger.ts
    capture-watermark-store.ts
    cleaner.ts
    dedupe.ts
    heartbeat-detect.ts
    latency-metrics.ts
    message-provenance.ts
    message-sanitizer.ts
    recall-echo-store.ts
    retry-queue.ts
    safe-path.ts
    session-state.ts
    user-id.ts
```

For npm consumers, import from the package root (`@ubundi/openclaw-cortex`). Internal module paths are implementation details and may change between versions.

### Auto-Recall

Before every agent turn, the plugin queries Cortex's `/v1/recall` endpoint and prepends results to the agent's context:

```xml
<cortex_memories>
- [0.95] User prefers TypeScript over JavaScript
- [0.87] Project uses PostgreSQL with pgvector
</cortex_memories>
```

If the request exceeds `recallTimeoutMs`, the agent proceeds without memories (silent degradation). After 3 consecutive hard failures (connection errors, not timeouts), recall is disabled for 30 seconds (cold-start detection) to avoid hammering a dead service. Timeouts from a slow-but-running backend do not trigger the cold-start gate.

![Recall Strategy Tiers](assets/readme_assets/Recall.png)

### Recovery Detection

If the previous session ended uncleanly (e.g. the process crashed or you reset without `/sleep`), the plugin detects this on the next `before_agent_start` and prepends a recovery block before the first turn:

```xml
<cortex_recovery>
Unclean session detected. Last known context: ...
</cortex_recovery>
```

This lets the agent pick up where it left off without you having to re-explain. Use `/checkpoint` before `/sleep` or `/new` to make this context more useful.

### Auto-Capture

After each agent turn completes, the plugin flattens the turn's new `user` and `assistant` messages into a `role: content` transcript and submits it to Cortex's `/v1/jobs/ingest` endpoint (async job queue). The job returns immediately and processes in the background — this avoids Lambda proxy timeouts that occur with synchronous ingestion. A watermark tracks how much of the conversation has already been ingested, so each message is sent exactly once — no overlap between turns. A heuristic skips trivial exchanges (short messages, turns without a substantive response).

Capture is fire-and-forget — it never blocks the agent. Failed ingestions are queued for retry with exponential backoff (up to 5 retries).

### Agent Tools

The plugin registers two tools the LLM agent can invoke directly:

- **`cortex_search_memory`** — search long-term memory with a natural language query. Returns matching memories with confidence scores. Use when the agent needs to recall something specific.
- **`cortex_save_memory`** — explicitly save a fact, preference, or piece of information to long-term memory. Use when the user asks "remember this" or the agent identifies something worth persisting.

These work alongside Auto-Recall/Auto-Capture — the automatic hooks handle background memory flow, while the tools give the agent explicit control when needed.

> Agent tools require the OpenClaw runtime to support `api.registerTool()`. On older runtimes, the plugin gracefully skips tool registration.

### Commands

The plugin registers auto-reply commands that execute without invoking the AI agent:

```
/checkpoint                  # Auto-summarize recent messages and save to Cortex
/checkpoint <summary>        # Save a custom summary to Cortex
/sleep                       # Mark the session as cleanly ended (clears recovery state)
/audit                       # Show audit log status
/audit on                    # Start recording all data sent to Cortex
/audit off                   # Stop recording (existing logs preserved)
```

`/checkpoint` is designed to be run before `/new` or resetting the agent. It saves what you were working on so the next session can recover context without manual re-explanation.

`/sleep` marks the session as cleanly ended. Without it, the next session will see a recovery warning. Use `/checkpoint` first if you want the context saved.

The audit log writes to `.cortex/audit/` in your workspace — an `index.jsonl` with metadata and a `payloads/` directory with full content of every transmission. Useful for compliance, debugging, or verifying exactly what data leaves your machine.

### CLI Commands

The plugin registers terminal-level commands under `openclaw cortex`:

```bash
openclaw cortex status             # API health check with latency and memory counts
openclaw cortex memories           # Memory count, session count, maturity, top entities
openclaw cortex search [query...]  # Search memories from the terminal with natural-language questions
openclaw cortex search --mode decisions what database did we choose
openclaw cortex config             # Show current plugin configuration
openclaw cortex pair               # Generate a TooToo pairing code to link your agent
openclaw cortex reset              # Permanently delete all memories (prompts for confirmation)
openclaw cortex reset --yes        # Skip confirmation
```

### Gateway RPC

The `cortex.status` RPC method exposes plugin health and metrics programmatically:

```json
{
  "version": "1.7.5",
  "healthy": true,
  "knowledgeState": { "hasMemories": true, "totalSessions": 42, "maturity": "mature", "tier": 3 },
  "recallMetrics": { "count": 120, "p50": 95, "p95": 280, "p99": 450 },
  "retryQueuePending": 0,
  "config": { "autoRecall": true, "autoCapture": true, "namespace": "myproject-a1b2c3d4" }
}
```

### Observability

On session start, the plugin logs a single status line:

```
Cortex v1.7.5 ready
Cortex connected — 1,173 memories, 4 sessions (cold), tier 1
```

Recall latency percentiles are logged at debug level on shutdown. Enable verbose logging to see them, or run `openclaw cortex status` for live metrics.

![Observability](assets/readme_assets/Observability.png)

## Privacy & Data

This plugin sends data to the Cortex API to provide memory functionality. Here's what leaves your machine:

| Data | When | How to disable |
|------|------|----------------|
| Conversation messages (user + assistant) | After each agent turn | `autoCapture: false` |
| Your current prompt | Before each agent turn | `autoRecall: false` |

Additionally, a randomly generated installation ID (`userId`) and a workspace namespace hash are sent with every request to scope your data. No personally identifiable information is collected.

Before transmission, the plugin strips runtime metadata from captured messages and removes prior recalled memories to prevent feedback loops.

All data is transmitted over HTTPS. Each installation's data is isolated server-side by its unique `userId` — no other installation can access your memories. This isolation has been verified via cross-user recall testing.

Capture payloads are capped at 256KB by default (`captureMaxPayloadBytes`) to prevent oversized transmissions from pasted files or verbose replies.

To see exactly what data leaves your machine, enable the audit log with `/audit on` or `auditLog: true` in your config. This records every payload to `.cortex/audit/` in your workspace.

To disable all network activity, set `autoRecall: false` and `autoCapture: false` in your config.

## Compatibility with SKILL.md

If both this plugin and the Cortex SKILL.md are active, the `<cortex_memories>` tag in the prepended context signals to the skill that recall has already happened — the agent can skip manual `curl` calls.

## Troubleshooting

- **Agent not using plugin tools**: Check `tools.profile` in `openclaw.json` — OpenClaw defaults to `"messaging"`, which excludes memory tools. Run `openclaw config set tools.profile full && openclaw gateway restart`. The configure wizard resets this, so re-check after any reconfiguration.
- Plugin installed but no memory behavior: verify both `"enabled": true` and `"slots.memory": "@ubundi/openclaw-cortex"` in `openclaw.json`.
- `Cannot find module 'zod'` during plugin load (older installs): run `npm install --prefix ~/.openclaw/extensions/openclaw-cortex --omit=dev zod`.
- Frequent recall timeouts: increase `recallTimeoutMs` for auto-recall or `toolTimeoutMs` for explicit searches.
- No useful memories returned: ensure prior sessions were captured (`autoCapture`) or saved explicitly with `cortex_save_memory` or `/checkpoint`.

## Development

```bash
npm install
npm run build      # TypeScript → dist/
npm test           # Run vitest (375 tests)
npm run test:watch # Watch mode
npm run test:integration # Live Cortex API tests (uses the baked-in API key)
```

Manual proof scripts live under `tests/manual/`.

## Built by Ubundi

<a href="https://ubundi.com"><img src="assets/ubundi_logo.jpeg" alt="Ubundi" width="60" /></a>

openclaw-cortex is an open-source project by [Ubundi](https://ubundi.com) — a South African venture studio shaping human-centred AI. Based in Cape Town, Ubundi builds at the intersection of AI capability and African context, developing tools that ensure the benefits of AI reach their continent first.

openclaw-cortex was built as part of the infrastructure behind Cortex, Ubundi's long-term memory layer for AI agents — where robust cross-session recall is foundational to delivering contextually relevant, grounded responses.

→ [ubundi.com](https://ubundi.com)

## License

MIT
