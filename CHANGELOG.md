# Changelog

All notable changes to this project will be documented in this file.

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
