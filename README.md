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
- **Commands** — `/memories` for status and search, `/audit` to toggle local audit logging
- **File Sync** — watches `MEMORY.md`, daily logs, and session transcripts for background ingestion
- **Gateway RPC** — `cortex.status` method for programmatic health and metrics access
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

2. Add a minimal plugin config to `openclaw.json`:

   ```json
   {
     "plugins": {
       "entries": {
         "@ubundi/openclaw-cortex": {
           "enabled": true,
           "config": {}
         }
       },
       "slots": {
         "memory": "@ubundi/openclaw-cortex"
       }
     }
   }
   ```

   That's it — no API key, no account, no setup. On first run the plugin generates a unique ID for this installation, persists it at `~/.openclaw/cortex-user-id`, and scopes all memories to that ID.

3. Run an agent turn. If configured correctly, recall data is prepended in a `<cortex_memories>` block before the model turn.

## Configuration

Add to your `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "@ubundi/openclaw-cortex": {
        enabled: true,
        config: {
          // All fields are optional — the plugin works with no config at all.
          autoRecall: true,
          autoCapture: true,
          recallLimit: 10,
          recallTimeoutMs: 60000,
          toolTimeoutMs: 60000,
          fileSync: true,
          transcriptSync: true,
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

| Option            | Type    | Default | Description                                                                                      |
| ----------------- | ------- | ------- | ------------------------------------------------------------------------------------------------ |
| `userId`          | string  | _auto_  | Memory scope ID. Auto-generated per install and persisted at `~/.openclaw/cortex-user-id`. Override to share memory across machines or team members. |
| `autoRecall`      | boolean | `true`  | Inject relevant memories before each agent turn                                                  |
| `autoCapture`     | boolean | `true`  | Extract and store facts after each agent turn                                                    |
| `recallLimit`     | number  | `10`    | Max number of memories returned per recall                                                       |
| `recallTimeoutMs` | number  | `60000` | Auto-recall timeout in ms. Scales with knowledge tier via `deriveEffectiveTimeout`.              |
| `toolTimeoutMs`   | number  | `60000` | Timeout for explicit tool calls (`cortex_search_memory`, `/memories`). Longer than auto-recall since the user is actively waiting. |
| `fileSync`        | boolean | `true`  | Watch and ingest `MEMORY.md` and daily log files                                                 |
| `transcriptSync`  | boolean | `true`  | Watch and ingest session transcript files                                                        |
| `captureMaxPayloadBytes` | number | `262144` | Max byte size of capture payloads (256KB default). Oversized transcripts are trimmed from the oldest messages. |
| `auditLog`        | boolean | `false` | Enable local audit log. Records every payload sent to Cortex at `.cortex/audit/` in the workspace. Also toggleable at runtime via `/audit on`. |
| `namespace`       | string  | `"openclaw"` | Memory namespace. Auto-derived from workspace directory when not set explicitly.            |

## How It Works

![Architecture](assets/readme_assets/Arch%20Diagram.png)

## Source Layout

```text
src/
  index.ts                  # Public package entrypoint
  plugin/                   # Plugin wiring and config
    index.ts
    config/
      schema.ts
  adapters/                 # External service adapters
    cortex/
      client.ts
  features/                 # Feature modules
    capture/
    recall/
    sync/
  internal/                 # Internal helpers (not stable public API)
    audit/
    fs/
    identity/
    metrics/
    queue/
    transcript/
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

### Auto-Capture

After each agent turn completes, the plugin flattens the turn's new messages into a `role: content` transcript and submits it to Cortex's `/v1/jobs/ingest` endpoint (async job queue). The job returns immediately and processes in the background — this avoids Lambda proxy timeouts that occur with synchronous ingestion. A watermark tracks how much of the conversation has already been ingested, so each message is sent exactly once — no overlap between turns. Tool call results (`role: "tool"`) are included alongside `user` and `assistant` messages, since tool output is where the substantive work of an agentic turn lives. A heuristic skips trivial exchanges (short messages, turns without a substantive response).

Capture is fire-and-forget — it never blocks the agent. Failed ingestions are queued for retry with exponential backoff (up to 5 retries).

### File Sync

The plugin watches OpenClaw's memory files and ingests changes into Cortex:

- **MEMORY.md** — Line-level diff with 2-second debounce. Only added lines are ingested.
- **memory/\*.md** (daily logs) — Offset-based append detection. New content is ingested as it's written.
- **sessions/\*.jsonl** (transcripts) — Strips system prompts, tool JSON, and base64 images. Cleans dialogue into conversation format and batch ingests with session-scoped IDs.

Failed file sync operations are queued for retry, so transient network failures don't cause data loss.

### Agent Tools

The plugin registers two tools the LLM agent can invoke directly:

- **`cortex_search_memory`** — search long-term memory with a natural language query. Returns matching memories with confidence scores. Use when the agent needs to recall something specific.
- **`cortex_save_memory`** — explicitly save a fact, preference, or piece of information to long-term memory. Use when the user asks "remember this" or the agent identifies something worth persisting.

These work alongside Auto-Recall/Auto-Capture — the automatic hooks handle background memory flow, while the tools give the agent explicit control when needed.

> Agent tools require the OpenClaw runtime to support `api.registerTool()`. On older runtimes, the plugin gracefully skips tool registration.

### Commands

The plugin registers auto-reply commands that execute without invoking the AI agent:

```
/memories              # Show memory status (count, maturity, tier, latency)
/memories dark mode    # Search memories for "dark mode"
/audit                 # Show audit log status
/audit on              # Start recording all data sent to Cortex
/audit off             # Stop recording (existing logs preserved)
```

The audit log writes to `.cortex/audit/` in your workspace — an `index.jsonl` with metadata and a `payloads/` directory with full content of every transmission. Useful for compliance, debugging, or verifying exactly what data leaves your machine.

### Gateway RPC

The `cortex.status` RPC method exposes plugin health and metrics programmatically:

```json
{
  "version": "1.0.0",
  "healthy": true,
  "knowledgeState": { "hasMemories": true, "totalSessions": 42, "maturity": "mature", "tier": 3 },
  "recallMetrics": { "count": 120, "p50": 95, "p95": 280, "p99": 450 },
  "retryQueuePending": 0,
  "config": { "autoRecall": true, "autoCapture": true, "fileSync": true, "transcriptSync": true, "namespace": "myproject-a1b2c3d4" }
}
```

### Observability

On session start, the plugin logs a single status line:

```
Cortex v1.1.2 ready
Cortex connected — 1,173 memories, 4 sessions (cold)
```

Recall latency percentiles are logged at debug level on shutdown. Enable verbose logging to see them, or use the `/memories` command for live metrics.

![Observability](assets/readme_assets/Observability.png)

## Privacy & Data

This plugin sends data to the Cortex API to provide memory functionality. Here's what leaves your machine:

| Data | When | How to disable |
|------|------|----------------|
| Conversation messages (user + assistant) | After each agent turn | `autoCapture: false` |
| Your current prompt | Before each agent turn | `autoRecall: false` |
| MEMORY.md changes (added lines only) | On file save | `fileSync: false` |
| Daily log files (`memory/*.md`) | On file save | `fileSync: false` |
| Session transcripts (`sessions/*.jsonl`) | On file save | `transcriptSync: false` |

Additionally, a randomly generated installation ID (`userId`) and a workspace namespace hash are sent with every request to scope your data. No personally identifiable information is collected.

Before transmission, the plugin strips system prompts, tool call JSON, and base64-encoded images from transcripts. Prior recalled memories are also stripped from captured messages to prevent feedback loops.

All data is transmitted over HTTPS. Each installation's data is isolated server-side by its unique `userId` — no other installation can access your memories. This isolation has been verified via cross-user recall testing.

Capture payloads are capped at 256KB by default (`captureMaxPayloadBytes`) to prevent oversized transmissions from pasted files or long tool outputs.

To see exactly what data leaves your machine, enable the audit log with `/audit on` or `auditLog: true` in your config. This records every payload to `.cortex/audit/` in your workspace.

To disable all network activity, set `autoRecall: false`, `autoCapture: false`, `fileSync: false`, and `transcriptSync: false` in your config.

## Compatibility with SKILL.md

If both this plugin and the Cortex SKILL.md are active, the `<cortex_memories>` tag in the prepended context signals to the skill that recall has already happened — the agent can skip manual `curl` calls.

## Troubleshooting

- Plugin installed but no memory behavior: verify both `"enabled": true` and `"slots.memory": "@ubundi/openclaw-cortex"` in `openclaw.json`.
- Frequent recall timeouts: increase `recallTimeoutMs` for auto-recall or `toolTimeoutMs` for explicit searches.
- No useful memories returned: ensure prior sessions were captured (`autoCapture`) or file sync is enabled (`fileSync`, `transcriptSync`).

## Development

```bash
npm install
npm run build      # TypeScript → dist/
npm test           # Run vitest (230 tests)
npm run test:watch # Watch mode
npm run test:integration # Live Cortex API tests (uses the baked-in API key)
```

Manual proof scripts live under `tests/manual/`.

## License

MIT
