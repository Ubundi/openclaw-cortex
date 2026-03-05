# openclaw-cortex

OpenClaw plugin that gives AI agents long-term memory via the Cortex API.
Hooks into OpenClaw's agent lifecycle to automatically recall relevant memories
before each turn and capture new facts after each turn. Also syncs local files
(MEMORY.md, daily logs, session transcripts) into Cortex in the background.

## Tech Stack

- TypeScript (strict, ES2022, ESM-only)
- Node >= 20
- Vitest for testing
- Zod for config validation
- Peer dependency on `openclaw` runtime

## Directory Structure

- `src/plugin/` — Plugin entry point, config schema, OpenClaw lifecycle registration
- `src/adapters/cortex/` — HTTP client for all Cortex API endpoints
- `src/features/recall/` — Before-turn memory injection (recall handler + formatter)
- `src/features/capture/` — After-turn fact extraction (capture handler)
- `src/features/sync/` — File watchers for MEMORY.md, daily logs, transcripts
- `src/internal/` — Shared utilities (retry queue, latency metrics, transcript cleaner, fs safety, identity)
- `openclaw.plugin.json` — Plugin manifest (id, config schema, UI hints)
- `tests/unit/` — Unit tests (all mocked, no API key needed)
- `tests/integration/` — Live API tests (requires CORTEX_API_KEY)
- `tests/manual/` — End-to-end lifecycle simulations
- `benchmark/` — Recall quality benchmarks (real OpenClaw runtime via `openclaw agent` CLI)
- `scripts/` — Build helpers (API key injection, version sync, release verification)

## Build & Verify

```bash
npm ci                    # install deps
npm run build             # tsc + inject-api-key (needs BUILD_API_KEY env var for prod builds)
npx tsc --noEmit          # type check only
npm test                  # unit tests (262 tests, no API key needed)
npm run test:integration  # live API tests (needs CORTEX_API_KEY)
npm run verify-release    # checks version consistency across package.json and plugin manifest
```

## Key Patterns

- **Hook registration**: Uses `registerHookCompat()` which prefers `api.on()` over `api.registerHook()` — `api.registerHook()` only registers for display, `api.on()` is required for events to fire. See src/plugin/index.ts:161
- **Config validation**: Plugin config is validated via Zod at registration time — see src/plugin/index.ts
- **Capture via async jobs**: Capture flattens messages into a transcript and submits via `/v1/jobs/ingest` (async). Synchronous endpoints (`/v1/remember`, `/v1/ingest`) 503 under the Lambda proxy timeout. See src/features/capture/handler.ts
- **Capture watermark**: Only new messages since last capture are sent to Cortex, not the full history — see src/features/capture/handler.ts
- **API key baking**: Production builds embed the API key at build time via scripts/inject-api-key.mjs into src/internal/identity/api-key.ts
- **Namespace derivation**: Workspace directory is hashed to auto-scope memories per project — see src/plugin/index.ts:33
- **userId lifecycle**: Resolved eagerly in `register()` (not `start()`). This is critical because the OpenClaw runtime runs two plugin instances (`[gateway]` and `[plugins]`) — only `[gateway]` gets `start()` called. Commands like `/memories` and hooks like recall/capture must work on both instances. The capture handler awaits `userIdReady` before firing — see src/plugin/index.ts

## Non-Obvious Things

- **Dual-instance runtime**: OpenClaw runs two plugin instances — `[gateway]` (gets `start()` called, has workspaceDir) and `[plugins]` (only gets `register()`, no `start()`). All initialization that commands or hooks depend on MUST happen in `register()`, not `start()`. Use `start()` only for things that genuinely need workspaceDir (file sync, audit logging, namespace derivation). Deferring userId or bootstrapClient to `start()` will break the `[plugins]` instance silently.
- `npm run build` requires `BUILD_API_KEY` env var to bake the API key into the bundle. Without it, the baked key is empty and the plugin authenticates with whatever the runtime provides.
- `npm run version` auto-syncs the version from package.json into openclaw.plugin.json before git add.
- Integration and manual tests hit the live Cortex API and need `CORTEX_API_KEY` set.
- The plugin does NOT declare `kind: "memory"` — it coexists with the built-in memory system rather than replacing it. Cortex supplements the default memory plugin (USER.md, daily logs) with long-term cross-session recall/capture via the Cortex API.
- CI runs on Node 20 and 22. Tests must pass on both.
- All changes must pass the GitHub Actions workflow before merging. Run `npm test` and `npx tsc --noEmit` locally to catch issues before pushing.

## Skills

- `/release [patch|minor|major] [--dry-run]` — Bump version, run checks, commit, tag, and push to trigger npm publish. See `.claude/skills/release.md`

## Benchmarks

The benchmark (`benchmark/v2/`) measures recall quality using a real OpenClaw runtime via `openclaw agent` CLI. It sends 45 Arclight project sessions through a live agent, then probes with 50 recall questions. Supports three conditions: baseline (no plugins), clawvault, and cortex.

```bash
# Quick start (on the server with a running agent):
npx tsx benchmark/v2/run.ts --condition baseline --agent <agent-id>
npx tsx benchmark/v2/run.ts --condition cortex --agent <agent-id>
npx tsx benchmark/v2/run.ts --compare results/baseline-*.json results/cortex-*.json
```

See `benchmark/RUN_GUIDE.md` for full instructions, `benchmark/FINDINGS.md` for results, `benchmark/BENCHMARK_PLAN.md` for design rationale.

## Agent Docs

Read the relevant files before starting work:

- `docs/agent/testing.md` — Test layers, how to run each, what needs API keys, manual test scripts
- `docs/agent/plugin_hooks.md` — OpenClaw plugin API, hook contracts, data flow between recall/capture and the runtime
