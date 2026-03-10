# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Tools profile documentation**: Added Quick Start step and troubleshooting entry for `tools.profile` configuration. OpenClaw defaults to the `messaging` profile which excludes memory tools — users must set `tools.profile: "full"` after installation and after any reconfiguration.

## [2.3.0] - 2026-03-10

### Removed

- **File sync feature**: Removed background file watchers for `MEMORY.md`, daily logs (`memory/*.md`), and session transcripts (`sessions/*.jsonl`). Auto-capture already ingests everything meaningful from conversations — file sync was double-ingesting the same information through a more fragile path, adding complexity and attack surface without clear benefit.
- **`fileSync` config option**: No longer needed. Previously controlled `MEMORY.md` and daily log watching.
- **`transcriptSync` config option**: No longer needed. Previously controlled session transcript watching.

### Changed

- **Capture narrows to user/assistant only**: Tool messages (`role: "tool"`) are no longer captured or used for turn fingerprinting. Conversation content between user and assistant is what matters for memory; tool output was adding noise.
- **Simpler plugin lifecycle**: Service start/stop no longer manages file watchers — only retry queue, audit logging, and namespace derivation.

## [1.7.5] - 2026-03-05

### Added

- **`/checkpoint` command**: Saves a session summary to Cortex before resetting. Auto-extracts from recent messages or accepts a manual summary as args (`/checkpoint working on auth refactor`). Tells you to `/sleep` or `/new` after saving.
- **`/sleep` command**: Marks the current session as cleanly ended, clearing the recovery warning state so the next session starts clean.
- **Recovery detection**: `before_agent_start` now checks for unclean prior sessions (plugin crashed or reset without `/sleep`). If detected, a `<cortex_recovery>` block is prepended to the first turn of the new session so the agent knows what was in progress.
- **Heartbeat hook**: `gateway:heartbeat` fires periodically to refresh health status and knowledge state (total memories, maturity, tier) without waiting for a full recall cycle.
- **CLI commands** (`openclaw cortex ...`): Terminal-level commands registered via `api.registerCli()`:
  - `openclaw cortex status` — API health check with latency and memory counts
  - `openclaw cortex memories` — Memory count, session count, maturity, and top entities
  - `openclaw cortex search <query>` — Search memories from the terminal
  - `openclaw cortex config` — Show the current plugin configuration
  - `openclaw cortex pair` — Generate a TooToo pairing code to link your agent
  - `openclaw cortex reset` — Permanently delete all memories for this agent (with confirmation prompt)
- **`recallProfile` config** (`auto` | `default` | `factual` | `planning` | `incident` | `handoff`, default `auto`): Recall profile selection. `auto` picks the best profile based on context.
- **`recallTopK` config** (default `20`): Max memories returned after scoring, separate from `recallLimit`.
- **`recallReferenceDate` config**: Optional fixed ISO 8601 date as the temporal anchor for recall queries. For benchmarks only — leave unset in production.
- **`recallQueryType` codex option**: `recallQueryType` now accepts `"codex"` in addition to `factual`, `emotional`, and `combined`.

### Changed

- **`/memories` command removed**: Replaced by the terminal-level `openclaw cortex memories` and `openclaw cortex search` CLI commands.
- **`recallLimit` default raised**: From `10` to `20`.
- **`captureFilter` is now a boolean**: Previously a regex-based pattern list; now a simple `true`/`false` toggle (default `true`) to enable the built-in low-signal content filter.
- **Clean logging**: Consolidated plugin output to two info-level lines max (`Cortex v{version} ready` + connection status). All registration internals, tool call details, and latency stats moved to debug level.
- **Eager bootstrap**: userId resolution, health check, and knowledge probe now run in `register()` instead of `start()`. This is necessary because the OpenClaw runtime runs two plugin instances (`[gateway]` and `[plugins]`) and only `[gateway]` gets `start()` called. Commands and hooks must work on both instances.

### Fixed

- **`/memories` command hang**: The `/memories` command hung indefinitely when dispatched to the `[plugins]` runtime instance, which never calls `start()`. The `userIdReady` promise was initialized as a never-resolving placeholder and only replaced in `start()` — but the command handler awaited it before any logging, causing a silent infinite hang. Moved userId resolution back to `register()` so it resolves eagerly in all runtime instances.
- **Recall skipping on `[plugins]` instance**: The `[plugins]` runtime instance always skipped recall with "no memories yet" because `bootstrapClient()` (which probes `/knowledge` and sets `hasMemories`) was only called in `start()`. Moved the knowledge probe to `register()` so both `[gateway]` and `[plugins]` instances know about existing memories.
- **Capture silently dropping data**: The capture handler received `userIdReady` by value at registration time, capturing the initial never-resolving promise. When `start()` reassigned the variable, the capture handler still held the stale reference. Any turn with real content to capture would hang at the await and silently fail to ingest. Fixed by making `userIdReady` a `const` resolved eagerly in `register()`.

## [1.1.2] - 2026-03-01

### Fixed

- **Capture 422 fix**: Enforce 50,000 character limit on capture payloads to prevent Cortex API rejections. After byte-size trimming, a second pass drops oldest messages until the transcript fits within the API's character limit.

## [1.1.1] - 2026-03-01

### Added

- **Capture content filter**: `captureFilter` config with regex-based pattern matching to drop low-signal content (heartbeat messages, TUI artifacts, token counters) before ingestion.

### Changed

- **File sync logging**: Upgraded watch start/stop and sync events from debug to info/warn with path details for better production visibility.

## [1.1.0] - 2026-03-01

### Added

- **Audit logging**: `/audit` command and `auditLog` config option. Records every payload sent to Cortex at `.cortex/audit/` in the workspace — index file with metadata plus full payload content. Toggleable at runtime via `/audit on` and `/audit off`.
- **Capture payload size cap**: `captureMaxPayloadBytes` config (default 256KB). Oversized transcripts are trimmed from the oldest messages to stay within the limit.

## [1.0.0] - 2026-02-27

### Added

- **Agent Tools**: `cortex_search_memory` and `cortex_save_memory` tools registered via `api.registerTool()`, giving the LLM agent explicit memory search and save capabilities alongside auto-recall/capture.
- **Auto-Reply Command**: `/memories [query]` command registered via `api.registerCommand()`. Shows memory status without args, searches memories with args. Executes without invoking the AI agent.
- **Gateway RPC**: `cortex.status` method registered via `api.registerGatewayMethod()` for programmatic access to plugin health, knowledge state, recall metrics, and config.
- **Async capture pipeline**: Auto-capture now submits transcripts via `/v1/jobs/ingest` (async job queue) instead of synchronous endpoints, avoiding Lambda proxy timeouts.
- **Recall filtering**: `client.recall()` supports `minConfidence` and `includeUngrounded` options, matching the full Cortex `/v1/recall` request schema.
- **Tool timeout**: `toolTimeoutMs` config (default 10s) for explicit tool calls, separate from the auto-recall `recallTimeoutMs`.
- **Timestamp passthrough**: All Cortex API calls include `reference_date` for accurate temporal indexing.
- **Recall block stripping**: Captured messages are stripped of prior `<cortex_memories>` blocks to prevent feedback loops.

### Changed

- **Session tracking**: `cortex_save_memory` passes a per-lifecycle session ID to `/v1/remember`, enabling SESSION nodes in the Cortex graph for tier progression.
- **RememberResponse**: Aligned with API — surfaces `emotions`, `values`, `beliefs`, `insights` from the RESONATE pipeline.
- **Hook registration**: Uses `api.on()` for lifecycle hooks. `api.registerHook()` only registers for display — `api.on()` is required for events to fire.
- **PluginApi interface**: Extended with `registerHook`, `registerTool`, `registerCommand`, and `registerGatewayMethod` types.
- **Capture debug logging**: Logs message count, character size, sessionId, and userId on each capture.
- All new registrations are optional — the plugin gracefully skips features when the runtime doesn't support them.

### Fixed

- **Session resolution**: Capture handler falls back to `pluginSessionId` when runtime session ID is unavailable.
- **Recall feedback loop**: Prior `<cortex_memories>` blocks are stripped from captured messages to prevent recalled content from being re-ingested as new facts.

## [0.3.2] - 2026-02-18

### Added

- `verify-release` script to enforce release consistency across `package.json`, `openclaw.plugin.json`, plugin version wiring, and documented/default `recallTimeoutMs` values.
- Plugin lifecycle unit tests covering register/start/stop wiring, missing-workspace sync behavior, invalid config rejection, and recall-latency logging.

### Changed

- CI now includes a release consistency gate (`npm run verify-release`) and a package smoke check (`npm pack --dry-run`) before tests.
- Hardened recall behavior by reducing default `recallTimeoutMs` from `2000` to `500`.

## [0.3.1] - 2026-02-18

### Fixed

- Plugin version metadata now read from `package.json` at build time instead of being hardcoded.
- Restored `hono` to `package-lock.json` as a dev dependency so `npm ci` succeeds on all Node versions.

## [0.3.0] - 2026-02-18

### Added

- `recallQueryType` config option (`factual` | `emotional` | `combined`) passed to `/v1/retrieve`.
- `namespace` config option with automatic derivation from workspace directory (basename + path hash) to isolate memory per project without manual config.
- `healthCheck()` on `CortexClient` for startup connectivity verification.
- `reference_date` passed on all ingest calls for accurate temporal indexing.
- Path-traversal protection on `MEMORY.md` sync via `safePath()` guard (symlink rejection, directory confinement).

### Changed

- Cortex API surface fully aligned: query type, reference date, and health check now wired end-to-end.

## [0.2.0] - 2026-02-17

### Added

- Auto-Recall and Auto-Capture hooks.
- Background file sync for `MEMORY.md`, daily logs, and transcripts.
- Periodic reflect support.
- Unit and integration test coverage.
