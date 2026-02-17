# @cortex/openclaw-plugin

OpenClaw plugin for [Cortex](https://github.com/ubundi/cortex) long-term memory. Provides:

- **Auto-Recall** — injects relevant memories before every agent turn via `before_agent_start` hook
- **Auto-Capture** — extracts facts from agent conversations via `agent_end` hook
- **File Sync** — watches `MEMORY.md` and daily logs for background ingestion into Cortex

## Installation

```bash
npx clawhub@latest install @cortex/openclaw-plugin
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "@cortex/openclaw-plugin": {
        "enabled": true,
        "config": {
          "apiKey": "sk-cortex-...",
          "baseUrl": "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
          "autoRecall": true,
          "autoCapture": true,
          "recallTopK": 5,
          "recallTimeoutMs": 500,
          "fileSync": true
        }
      }
    },
    "slots": {
      "memory": "@cortex/openclaw-plugin"
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
|--------|------|---------|-------------|
| `apiKey` | string | *required* | Cortex API key |
| `baseUrl` | string | `https://q5p64iw9c9...` | Cortex API base URL |
| `autoRecall` | boolean | `true` | Inject memories before each agent turn |
| `autoCapture` | boolean | `true` | Extract facts after agent responses |
| `recallTopK` | number | `5` | Number of memories to retrieve |
| `recallTimeoutMs` | number | `500` | Max time to wait for recall (ms) |
| `fileSync` | boolean | `true` | Watch MEMORY.md and daily logs |

## How It Works

### Auto-Recall

Before every agent turn, the plugin sends the user's prompt to Cortex's `/v1/retrieve` endpoint with `mode=fast` (BM25 + semantic search, no graph traversal). Results are formatted as XML and prepended to the agent's context:

```xml
<cortex_memories>
- [0.95] User prefers TypeScript over JavaScript
- [0.87] Project uses PostgreSQL with pgvector
</cortex_memories>
```

If the request exceeds `recallTimeoutMs`, the agent proceeds without memories (silent degradation).

### Auto-Capture

After each successful agent turn, the plugin extracts the last 20 messages and sends them to Cortex's `/v1/ingest/conversation` endpoint. A lightweight heuristic skips trivial exchanges (short messages, system-only turns).

Capture is fire-and-forget — it never blocks the agent.

### File Sync

The plugin watches OpenClaw's memory files and ingests changes into Cortex:

- **MEMORY.md**: Line-level diff with 2-second debounce. Only added lines are ingested.
- **memory/*.md** (daily logs): Offset-based append detection. New content is ingested as it's written.

## Development

```bash
npm install
npm run build    # TypeScript → dist/
npm test         # Run vitest
npm run test:watch
```

## Compatibility with SKILL.md

If both this plugin and the Cortex SKILL.md are active, the `<cortex_memories>` tag in the prepended context signals to the skill that recall has already happened — the agent can skip manual `curl` calls.

## License

MIT
