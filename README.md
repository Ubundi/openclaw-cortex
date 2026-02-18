# @ubundi/openclaw-cortex

[![npm version](https://img.shields.io/npm/v/%40ubundi%2Fopenclaw-cortex.svg)](https://www.npmjs.com/package/@ubundi/openclaw-cortex)
[![CI](https://github.com/Ubundi/openclaw-cortex/actions/workflows/ci.yml/badge.svg)](https://github.com/Ubundi/openclaw-cortex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

![OpenClaw Cortex Logo](assets/logo.png)

[OpenClaw](https://github.com/openclaw/openclaw) plugin for [Cortex](https://github.com/ubundi/cortex) long-term memory. Gives your agent persistent memory that survives across sessions — who you are, what your project does, decisions you made weeks ago, and how things changed over time.

- **Auto-Recall** — injects relevant memories before every agent turn via `before_agent_start` hook
- **Auto-Capture** — extracts facts from conversations via `agent_end` hook
- **File Sync** — watches `MEMORY.md`, daily logs, and session transcripts for background ingestion
- **Periodic Reflect** — consolidates memories, resolves SUPERSEDES chains, detects contradictions
- **Resilience** — retry queue with exponential backoff, cold-start detection, latency metrics

> **Cortex availability:** Cortex is currently privately hosted and in early testing — it is not yet a public service. API keys are not self-serve; to request access email [matthew@ubundi.co.za](mailto:matthew@ubundi.co.za). A public sign-up is planned for the future.

## Prerequisites

- Node.js `>=20`
- [OpenClaw](https://github.com/openclaw/openclaw) with plugin support (`openclaw` peer dependency is `>=0.1.0`)
- Cortex API key — available on request (see availability note above)

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
           "config": {
             "apiKey": "${CORTEX_API_KEY}"
           }
         }
       },
       "slots": {
         "memory": "@ubundi/openclaw-cortex"
       }
     }
   }
   ```

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
          apiKey: "sk-cortex-...",
          // Cortex hosted API endpoint — provided with your API key. Omit to use the default.
          baseUrl: "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
          autoRecall: true,
          autoCapture: true,
          recallTopK: 5,
          recallTimeoutMs: 500,
          recallMode: "fast",
          fileSync: true,
          transcriptSync: true,
          reflectIntervalMs: 3600000
        }
      }
    },
    slots: {
      memory: "@ubundi/openclaw-cortex"
    }
  }
}
```

Environment variables are supported via `${VAR_NAME}` syntax:

```json
{
  "apiKey": "${CORTEX_API_KEY}",
  "baseUrl": "${CORTEX_BASE_URL}"
}
```

### Config Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | _required_ | Cortex API key |

All other options are pre-configured with sensible defaults and can be tuned via the OpenClaw plugin config UI.

### Recall Modes

| Mode | What it does | Server-side latency |
|---|---|---|
| `fast` | BM25 + semantic search only | ~80-150ms |
| `balanced` | Adds light reranking | ~150-300ms |
| `full` | Adds graph traversal + full reranker | ~300-600ms |

Use `fast` (default) for auto-recall where latency matters. Use `full` for explicit recall via SKILL.md where depth matters more than speed.

## How It Works

### Auto-Recall

Before every agent turn, the plugin queries Cortex's `/v1/retrieve` endpoint and prepends results to the agent's context:

```xml
<cortex_memories>
- [0.95] User prefers TypeScript over JavaScript
- [0.87] Project uses PostgreSQL with pgvector
</cortex_memories>
```

If the request exceeds `recallTimeoutMs`, the agent proceeds without memories (silent degradation). After 3 consecutive failures, recall is disabled for 30 seconds (cold-start detection) to avoid hammering a cold ECS task.

### Auto-Capture

After each successful agent turn, the plugin extracts the last 20 messages and sends them to Cortex's `/v1/ingest/conversation` endpoint. A heuristic skips trivial exchanges (short messages, system-only turns).

Capture is fire-and-forget — it never blocks the agent. Failed ingestions are queued for retry with exponential backoff (up to 5 retries).

### File Sync

The plugin watches OpenClaw's memory files and ingests changes into Cortex:

- **MEMORY.md** — Line-level diff with 2-second debounce. Only added lines are ingested.
- **memory/\*.md** (daily logs) — Offset-based append detection. New content is ingested as it's written.
- **sessions/\*.jsonl** (transcripts) — Strips system prompts, tool JSON, and base64 images. Cleans dialogue into conversation format and batch ingests with session-scoped IDs.

Failed file sync operations are queued for retry, so transient network failures don't cause data loss.

### Periodic Reflect

Every `reflectIntervalMs` (default: 1 hour), the plugin calls Cortex's `/v1/reflect` endpoint to consolidate memories:

- Merges duplicate facts ingested across sessions
- Marks stale facts as superseded (SUPERSEDES chains)
- Detects contradictions between facts
- Tracks belief drift over time

Set `reflectIntervalMs: 0` to disable.

### Observability

On shutdown, the plugin logs recall latency percentiles:

```
Cortex recall latency (847 samples): p50=120ms p95=340ms p99=480ms
```

Use this to tune `recallTimeoutMs` and `recallMode` for your deployment.

## Compatibility with SKILL.md

If both this plugin and the Cortex SKILL.md are active, the `<cortex_memories>` tag in the prepended context signals to the skill that recall has already happened — the agent can skip manual `curl` calls.

## Troubleshooting

- `apiKey` errors on startup: confirm `config.apiKey` is set and `${CORTEX_API_KEY}` resolves in your environment.
- Plugin installed but no memory behavior: verify both `"enabled": true` and `"slots.memory": "@ubundi/openclaw-cortex"` in `openclaw.json`.
- Frequent recall timeouts: increase `recallTimeoutMs` and/or set `recallMode` to `"fast"`.
- No useful memories returned: ensure prior sessions were captured (`autoCapture`) or file sync is enabled (`fileSync`, `transcriptSync`).

## Development

```bash
npm install
npm run build      # TypeScript → dist/
npm test           # Run vitest (150 tests)
npm run test:watch # Watch mode
npm run test:integration # Live Cortex API tests (requires CORTEX_API_KEY)
```

Manual proof scripts live under `tests/manual/`.

## License

MIT
