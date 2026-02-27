# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Agent Tools**: `cortex_search_memory` and `cortex_save_memory` tools registered via `api.registerTool()`, giving the LLM agent explicit memory search and save capabilities alongside auto-recall/capture.
- **Auto-Reply Command**: `/memories [query]` command registered via `api.registerCommand()`. Shows memory status without args, searches memories with args. Executes without invoking the AI agent.
- **Gateway RPC**: `cortex.status` method registered via `api.registerGatewayMethod()` for programmatic access to plugin health, knowledge state, recall metrics, and config.

### Changed

- **Session tracking**: `cortex_save_memory` now passes a per-lifecycle session ID to `/v1/remember`, creating SESSION nodes in the Cortex graph so `total_sessions` increments and tier progression works correctly.
- **RememberResponse aligned with API**: Added `emotions`, `values`, `beliefs`, `insights` fields to match the Cortex RESONATE pipeline output. `cortex_save_memory` tool response now surfaces these when present.
- **Recall filtering**: `client.recall()` now supports `minConfidence` and `includeUngrounded` options, matching the full Cortex `/v1/recall` request schema.
- **Tool timeout**: Added `toolTimeoutMs` config (default 10s) for explicit tool calls (`cortex_search_memory`, `/memories`). Auto-recall hook keeps the fast `recallTimeoutMs` (default 2s) to avoid blocking agent turns, while user-initiated searches get a longer window to complete.
- **Agent tool logging**: `cortex_search_memory` and `cortex_save_memory` now log query, result count, and entity info via `api.logger.info()` for visibility in `openclaw logs`.
- **Hook registration**: Uses `api.on()` for lifecycle hooks (`before_agent_start`, `agent_end`), matching the Hindsight reference implementation. `api.registerHook()` only registers hooks for display in `openclaw hooks list` but does not wire up event dispatch — `api.on()` is required for hooks to actually fire.
- **Capture uses text format**: Auto-capture now flattens conversation messages into a transcript and sends via `client.remember(text)` instead of `client.rememberConversation(messages)`. The `/v1/remember` messages format was consistently returning 503 (server timeout during conversation parsing), while the text format works reliably.
- **Capture debug logging**: Logs message count, total character size, sessionId, and userId on each capture for diagnosing API failures.
- **PluginApi interface**: Extended with `registerHook`, `registerTool`, `registerCommand`, and `registerGatewayMethod` types aligned with the official OpenClaw plugin documentation.
- All new registrations are optional — the plugin gracefully skips features when the runtime doesn't support them, maintaining backward compatibility with older OpenClaw versions.

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
