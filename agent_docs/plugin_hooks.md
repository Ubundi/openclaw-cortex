# Plugin Hooks & OpenClaw Integration

## Plugin Registration

The plugin exports a default object matching OpenClaw's plugin interface — see src/plugin/index.ts:176.
OpenClaw calls `plugin.register(api)` with a PluginApi that provides logging, hook registration, and service management.

## Hook Contract

### before_agent_start (Recall)

- **When**: Before every agent turn
- **Input**: `event.prompt` (string), `event.messages` (optional array), `ctx.sessionKey` / `ctx.sessionId`
- **Output**: `{ prependContext: string }` — XML block of recalled memories injected into the LLM context
- **Handler**: src/features/recall/handler.ts
- **Behavior**:
  - Skipped if `autoRecall: false`
  - Skipped if prompt is empty or < 5 characters
  - Skipped during cold-start cooldown (30s after 3 consecutive API failures)
  - Returns `undefined` (not error) when no memories match

### agent_end (Capture)

- **When**: After every agent turn (fire-and-forget, return value ignored)
- **Input**: `event.messages` (full cumulative session history), `event.aborted`, `event.sessionKey` / `event.sessionId`
- **Handler**: src/features/capture/handler.ts
- **Ingestion**: Flattens messages into `role: content` transcript, submits via `/v1/jobs/ingest` (async job queue). Synchronous endpoints 503 under the Lambda proxy timeout.
- **Behavior**:
  - Skipped if `autoCapture: false`
  - Skipped if `event.aborted` is true
  - Uses watermark to only send new messages since last capture
  - Skipped if turn delta lacks substantive content (< 20 chars per role)
  - Awaits `userIdReady` before firing (userId is required by API)
  - Messages are trimmed to 200-item API limit
  - Payload capped at `captureMaxPayloadBytes` (default 256KB) — oldest messages dropped if exceeded

## API Surface Beyond Hooks

The plugin conditionally registers these if the runtime supports them:

| Feature | API Method | Runtime Check |
|---------|-----------|---------------|
| Agent tools (cortex_search_memory, cortex_save_memory) | `api.registerTool()` | `if (api.registerTool)` |
| /memories command | `api.registerCommand()` | `if (api.registerCommand)` |
| /audit command | `api.registerCommand()` | `if (api.registerCommand)` |
| cortex.status RPC | `api.registerGatewayMethod()` | `if (api.registerGatewayMethod)` |

All three degrade gracefully on older runtimes that lack these methods.

## Service Lifecycle

Registered via `api.registerService({ id: "cortex-services", start, stop })`:

- **register()**: Resolves userId eagerly, runs health check + knowledge probe via `bootstrapClient()`. This must happen in `register()` because the OpenClaw runtime runs two plugin instances (`[gateway]` and `[plugins]`) and only `[gateway]` gets `start()` called. Commands and hooks must work on both.
- **start**: Boots retry queue, derives namespace from workspace dir, starts file sync watchers, initializes audit logger if enabled
- **stop**: Stops watchers, drains retry queue
- Idempotency guard prevents double-start
- `start()` is only called on the `[gateway]` instance — never assume it will fire

## Configuration

Defined in src/plugin/config/schema.ts using Zod. The plugin manifest (openclaw.plugin.json) mirrors this schema for OpenClaw's UI. Key defaults: autoRecall=true, autoCapture=true, fileSync=true, transcriptSync=true, recallLimit=10, recallTimeoutMs=10000, toolTimeoutMs=10000, captureMaxPayloadBytes=262144, auditLog=false.

## Hook Registration

Hooks are registered via `registerHookCompat()` which prefers `api.on()` over `api.registerHook()`. `api.registerHook()` only registers hooks for display in `openclaw hooks list` but does not wire up event dispatch. `api.on()` is required for lifecycle events to actually fire.
