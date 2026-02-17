# Security Analysis: @ubundi/openclaw-cortex

Date: February 17, 2026
Reviewer: Codex (static code audit)
Scope: Plugin code in `src/` (transport/auth, recall/capture flows, file sync, retry behavior, config validation)

## Executive Summary

The plugin has a solid baseline (schema validation, minimal dependencies, graceful recall degradation), but there are multiple high/medium-risk gaps for production agent use:

1. Untrusted memory content is injected directly into model context.
2. File sync paths are not hardened against symlink/path escape.
3. Network transport is not restricted to HTTPS.
4. Non-recall API calls have no request timeout.
5. Retry queue has no capacity limit.
6. Session IDs can collide across projects when one API key is reused.

The highest priority fixes are 1 and 2.

## Findings

### 1) High: Prompt-injection path via recalled memory

- Severity: High
- Affected code:
  - `src/features/recall/formatter.ts:7`
  - `src/features/recall/handler.ts:89`
- Issue:
  - Retrieved memory content (`r.content`) is interpolated into `prependContext` without escaping or delimiting hardening.
- Why this matters:
  - If Cortex stores adversarial text, it can act as second-order prompt injection and influence tool usage, data access, or policy behavior.
- Recommended fix:
  - Escape/sanitize memory text before insertion.
  - Prevent tag breakout (`</cortex_memories>`).
  - Add explicit preamble that recalled memories are untrusted data, not instructions.
  - Optionally wrap each memory in structured JSON or code fences to reduce instruction salience.

### 2) High: File sync can read unintended files via symlink/path tricks

- Severity: High
- Affected code:
  - `src/features/sync/watcher.ts:73`
  - `src/features/sync/watcher.ts:99`
  - `src/features/sync/daily-logs-sync.ts:25`
  - `src/features/sync/transcripts-sync.ts:26`
- Issue:
  - Paths derived from watch events are joined and read directly. There is no `realpath` boundary enforcement or symlink rejection.
- Why this matters:
  - A crafted workspace can cause ingestion of files outside expected memory/session directories (local data exfiltration to Cortex).
- Recommended fix:
  - Resolve `realpath` before reads.
  - Reject symlinks (`lstat` + `isSymbolicLink`).
  - Enforce allowed-root checks for canonical paths.
  - Drop events with path traversal segments or mismatched roots.

### 3) Medium: `baseUrl` does not enforce HTTPS

- Severity: Medium
- Affected code:
  - `src/core/config/schema.ts:8`
  - `src/cortex/client.ts:65`
- Issue:
  - URL validation allows non-HTTPS schemes.
- Why this matters:
  - Misconfiguration or tampering could send API key and memory payloads over insecure transport.
- Recommended fix:
  - Enforce `https:` by default.
  - Allow `http://localhost` only in explicit development mode.

### 4) Medium: Missing timeout/cancellation for ingest and reflect APIs

- Severity: Medium
- Affected code:
  - `src/cortex/client.ts:83` (`ingest`)
  - `src/cortex/client.ts:103` (`ingestConversation`)
  - `src/cortex/client.ts:120` (`reflect`)
- Issue:
  - Only `retrieve` has `AbortController` timeout.
- Why this matters:
  - Hanging requests can accumulate under network failures and degrade plugin stability.
- Recommended fix:
  - Add a shared timeout wrapper for all fetch calls.
  - Set bounded timeouts per endpoint (for example ingest 5-10s, reflect 10-30s).

### 5) Medium: Retry queue is unbounded

- Severity: Medium
- Affected code:
  - `src/shared/queue/retry-queue.ts:21`
  - `src/shared/queue/retry-queue.ts:48`
- Issue:
  - Queue grows without limit when failures persist or file churn is high.
- Why this matters:
  - Memory growth and replay storms after reconnect.
- Recommended fix:
  - Add max queue capacity.
  - Coalesce duplicate tasks by key.
  - Apply bounded drop/backpressure policy with explicit logging.

### 6) Medium: Session namespace collisions across projects/agents

- Severity: Medium
- Affected code:
  - `src/core/plugin.ts:88`
  - `src/features/sync/daily-logs-sync.ts:32`
- Issue:
  - Fixed prefix (`openclaw`) with filename-based IDs can collide when multiple repos share one API key/tenant.
- Why this matters:
  - Memory mixing and unintended cross-project recall.
- Recommended fix:
  - Include stable workspace/agent namespace in session IDs by default.
  - Add explicit config for namespace override.

## Existing Strengths

- Config is schema-validated (`zod`) with type constraints.
- Recall has timeout and graceful fallback path.
- System/developer transcript roles are excluded during transcript cleaning.
- Retry logic has exponential backoff and max retry attempts per task.

## Suggested Remediation Plan (Tomorrow)

1. Patch recall formatting hardening.
2. Patch file sync path safety checks.
3. Enforce HTTPS in config/client.
4. Add timeout wrapper for all Cortex client methods.
5. Add retry queue max size + dedupe behavior.
6. Add namespace scoping for session IDs.
7. Add tests for each new security control.

## Suggested Test Additions

- Prompt injection defense:
  - Recalled content containing `</cortex_memories>` is escaped and cannot break wrapper.
- File sync safety:
  - Symlink under watched path pointing outside root is rejected.
  - Canonical path outside allowed roots is rejected.
- Transport hardening:
  - Non-HTTPS `baseUrl` rejected unless localhost-dev exception is enabled.
- Timeout behavior:
  - `ingest`, `ingestConversation`, and `reflect` abort within configured timeout.
- Retry hardening:
  - Queue never exceeds configured cap.
  - Duplicate enqueue keys are coalesced.

## Residual Risk if Unchanged

If shipped as-is for autonomous agents, primary risk is memory-to-prompt injection and local file exfiltration through file-sync path handling. These are the two controls to implement first before broad rollout.

