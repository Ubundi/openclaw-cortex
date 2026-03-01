# Testing

## Quick Reference

| What | Command | Needs API Key |
|------|---------|---------------|
| Unit tests | `npm test` | No |
| Unit tests (watch) | `npm run test:watch` | No |
| Integration tests | `CORTEX_API_KEY=key npm run test:integration` | Yes |
| Harness simulation | `CORTEX_API_KEY=key npx tsx tests/manual/test-harness.ts` | Yes |
| Persistence proof | `CORTEX_API_KEY=key npx tsx tests/manual/test-persistence.ts` | Yes |
| File sync proof | `CORTEX_API_KEY=key npx tsx tests/manual/test-filesync.ts` | Yes |
| Edge cases | `CORTEX_API_KEY=key npx tsx tests/manual/test-edge-cases.ts` | Yes |

## Unit Tests

- Config: vitest.config.ts — includes `tests/**/*.test.ts`, excludes `tests/integration/**`
- All external calls are mocked. No network access.
- Vitest globals are enabled (`describe`, `it`, `expect` available without imports).

### Test file map

| File | Covers |
|------|--------|
| client.test.ts | CortexClient methods, timeout handling, error codes |
| recall.test.ts | Recall handler, autoRecall flag, cold-start detection |
| capture.test.ts | Capture handler, watermark, content filtering, aborted turns |
| cold-start.test.ts | Cold-start trigger after 3 failures, cooldown |
| format.test.ts | Memory XML formatting, adversarial content escaping |
| metrics.test.ts | LatencyMetrics p50/p95/p99, rolling window |
| config.test.ts | Zod schema validation, defaults, HTTPS enforcement |
| plugin-lifecycle.test.ts | Full register/start/stop lifecycle, service management |
| retry-queue.test.ts | Exponential backoff, max retries, deduplication |
| daily-logs-sync.test.ts | Incremental offset-based ingestion |
| transcripts-sync.test.ts | Transcript cleaning + conversation ingestion |
| memory-md-sync.test.ts | Line-diff detection, debounce |
| transcript-cleaner.test.ts | System prompt stripping, tool JSON removal |
| sync-path-safety.test.ts | Symlink checks, path traversal rejection |
| safe-path.test.ts | Path safety validation |
| sync.test.ts | lineDiff utility |
| watcher.test.ts | File watcher setup |
| audit-logger.test.ts | Audit log directory creation, index writing, payload files, rotation, error resilience |

## Integration Tests

- Config: vitest.integration.config.ts
- Hits the live Cortex API. Each run uses a unique session ID to avoid data collisions.
- Tests cover: health check, conversation ingest, retrieve, and end-to-end recall pipeline.

## Manual Tests

Located in tests/manual/. These are standalone scripts (run with `npx tsx`) that exercise the full plugin lifecycle without OpenClaw installed. See docs/TESTING.md for detailed output examples and verified behaviors.
