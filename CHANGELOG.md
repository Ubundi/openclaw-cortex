# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
