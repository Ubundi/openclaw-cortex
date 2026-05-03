# openclaw-cortex

OpenClaw plugin that gives AI agents long-term memory via the Cortex API.
Hooks into OpenClaw's agent lifecycle to automatically recall relevant memories
before each turn and capture new facts after each turn.

## Tech Stack

- TypeScript (strict, ES2022, ESM-only)
- Node >= 20
- Vitest for testing
- Zod for config validation
- Peer dependency on `openclaw` runtime

## Directory Structure

- `src/plugin/` — Plugin entry point, config schema, CLI, tools, commands, OpenClaw lifecycle registration
- `src/cortex/` — HTTP client for all Cortex API endpoints
- `src/features/recall/` — Before-turn memory injection (recall handler, formatter, context profiles)
- `src/features/capture/` — After-turn fact extraction (capture handler, filter)
- `src/features/checkpoint/` — `/checkpoint` command handler (saves session summary to Cortex)
- `src/features/heartbeat/` — `gateway:heartbeat` hook for periodic health/knowledge refresh
- `src/internal/` — Shared utilities (retry queue, latency metrics, dedupe, message sanitizer, provenance, session state, watermark store, audit logger)
- `openclaw.plugin.json` — Plugin manifest (id, config schema, UI hints)
- `tests/unit/` — Unit tests (all mocked, no API key needed)
- `tests/integration/` — Live API tests (requires CORTEX_API_KEY)
- `tests/manual/` — End-to-end lifecycle simulations
- `benchmark/` — Recall quality benchmarks (real OpenClaw runtime via `openclaw agent` CLI)
- `scripts/` — Build helpers (API key injection, version sync, release verification)

## Build & Verify

```bash
npm ci                    # install deps
npm run build             # tsc
npx tsc --noEmit          # type check only
npm test                  # unit tests (no API key needed)
npm run test:integration  # live API tests (needs CORTEX_API_KEY)
npm run verify-release    # checks version consistency across package.json and plugin manifest
```

## Key Patterns

- **Hook registration**: Uses `registerHookCompat()` which prefers `api.on()` over `api.registerHook()` — `api.registerHook()` only registers for display, `api.on()` is required for events to fire. See src/plugin/index.ts:161
- **Config validation**: Plugin config is validated via Zod at registration time — see src/plugin/index.ts
- **Capture via async jobs**: Capture flattens messages into a transcript and submits via `/v1/jobs/ingest` (async). Synchronous endpoints (`/v1/remember`, `/v1/ingest`) 503 under the Lambda proxy timeout. See src/features/capture/handler.ts
- **Capture watermark**: Only new messages since last capture are sent to Cortex, not the full history — see src/features/capture/handler.ts
- **API key resolution**: Resolved at runtime in order: plugin config `apiKey` → `CORTEX_API_KEY` env var. Users must provide their own key via config or env var. Generate keys at https://cortex.ubundi.com.
- **Namespace derivation**: Workspace directory is hashed to auto-scope memories per project — see src/plugin/index.ts:33
- **userId lifecycle**: Resolved eagerly in `register()` (not `start()`). This is critical because the OpenClaw runtime runs two plugin instances (`[gateway]` and `[plugins]`) — only `[gateway]` gets `start()` called. Commands and hooks (recall/capture/checkpoint/sleep) must work on both instances. The capture handler awaits `userIdReady` before firing — see src/plugin/index.ts

## Non-Obvious Things

- **Dual-instance runtime**: OpenClaw runs two plugin instances — `[gateway]` (gets `start()` called, has workspaceDir) and `[plugins]` (only gets `register()`, no `start()`). All initialization that commands or hooks depend on MUST happen in `register()`, not `start()`. Use `start()` only for things that genuinely need workspaceDir (audit logging, namespace derivation). Deferring userId or bootstrapClient to `start()` will break the `[plugins]` instance silently.
- `npm run version` auto-syncs the version from package.json into openclaw.plugin.json before git add.
- Integration and manual tests hit the live Cortex API and need `CORTEX_API_KEY` set.
- The plugin does NOT declare `kind: "memory"` — it coexists with the built-in memory system rather than replacing it. Cortex supplements the default memory plugin (USER.md, daily logs) with long-term cross-session recall/capture via the Cortex API.
- CI runs on Node 20 and 22. Tests must pass on both.
- All changes must pass the GitHub Actions workflow before merging. Run `npm test` and `npx tsc --noEmit` locally to catch issues before pushing.

## Versioning

This package follows [semver](https://semver.org/). When the user asks to bump the version, evaluate the changes since the last release and recommend the correct level. Push back if the user picks the wrong one.

- **patch** (e.g. 2.3.0 → 2.3.1): Bug fixes, internal refactors, default value tweaks, documentation updates, test fixes. No new user-facing features. No config schema changes that would break existing configs. Examples: fixing an endpoint path, lowering a default, improving agent instructions, adding noise filters.
- **minor** (e.g. 2.3.0 → 2.4.0): New features, new tools, new config options, new CLI commands, new hooks — anything that adds capability without breaking existing setups. Removing a feature that was opt-in or undocumented is also minor if no existing config breaks. Examples: adding `cortex_forget` tool, adding heartbeat reflect, adding a new recall profile.
- **major** (e.g. 2.0.0 → 3.0.0): Breaking changes that require users to update their config, workflow, or integration. Examples: removing a config option that users may have set, changing the plugin ID, renaming tools, changing the config schema in a way that rejects previously valid configs, dropping Node version support.

**Quick test**: "Would an existing user's setup break or behave differently after upgrading without changing their config?"
- No → patch or minor (depending on whether new features were added)
- Yes, but only if they used an opt-in feature that was removed → minor
- Yes, for any default or required config → major

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

## Cortex API Reference

The Cortex API backend lives in the `Ubundi/cortex` repo on GitHub (private). When you need to understand API behavior, timeouts, error codes, or endpoint contracts, use the GitHub MCP plugin to search the repo:

```
mcp__plugin_github_github__search_code  query: "<keyword> repo:Ubundi/cortex language:Python"
mcp__plugin_github_github__get_file_contents  owner: "Ubundi", repo: "cortex", path: "<file>"
```

Key paths in that repo:
- `infrastructure/external/cortex_pipeline_service.py` — Pipeline service integration
- API routes and handlers are in the `api/` and `application/` directories
