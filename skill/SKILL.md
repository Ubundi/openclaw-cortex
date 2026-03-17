---
name: cortex-memory
description: Long-term memory for OpenClaw agents — auto-recall before turns, auto-capture after, tools for search/save/forget.
tools: ["cortex"]
user-invocable: false
---

# Cortex Memory

You have long-term memory via Cortex. Facts, preferences, and decisions persist across sessions. Memories are auto-recalled before each turn and auto-captured after.

## Mandatory Behavioral Rules

These are non-negotiable. Violating them produces incorrect answers.

**1. AUTO-RECALL IS A STARTING POINT.** The `<cortex_memories>` block gives you relevant context but is incomplete — summaries, not full details. Never treat it as the complete picture.

**2. ALWAYS VERIFY BEFORE HEDGING.** Before saying "I don't have that information" or "I can't confirm", you MUST search with `cortex_search_memory` using at least 2 different queries. Only abstain after search confirms the information isn't available.

**3. SEARCH STRATEGY.** For factual questions: search the specific entity or topic. For temporal questions: search the event name. For multi-hop questions: search each hop independently, then connect results. Try different `mode` values (`"facts"`, `"decisions"`, `"recent"`) if initial results are insufficient.

**4. TOOL PRIORITY.** `cortex_search_memory` for detailed fact retrieval. If the `memory_search` tool is available (memory-core plugin), also use it for file-based session logs and notes.

**5. CONFIDENCE CALIBRATION.** If auto-recall gives you partial context on a topic, the full answer IS in memory. Search harder — don't hedge.

## Session Goals

At session start, call `cortex_set_session_goal` with the user's primary objective. This biases recall and tags captures. Update if the goal shifts fundamentally; don't update for sub-tasks.

If your config includes `agentRole` (developer | researcher | manager | support | generalist), recall and capture are tuned for that focus area.

## Tools

- **cortex_search_memory** — Search memory. `query` (required), `limit` (1–50), `mode` (all | decisions | preferences | facts | recent), `scope` (all | session | long-term)
- **cortex_save_memory** — Save a fact. `text` (required), `type` (preference | decision | fact | transient), `importance` (high | normal | low), `checkNovelty` (bool)
- **cortex_forget** — Remove memories. Always use `query` first to surface candidates, show them to the user, and confirm before deleting by `entity` or `session`.
- **cortex_get_memory** — Fetch a specific memory by node ID.
- **cortex_set_session_goal** — Set or clear (`clear: true`) the session objective.

## Commands

`/checkpoint` (save summary before reset) · `/sleep` (clean session end) · `/audit on|off` (toggle API logging)

## Save & Capture

Auto-capture handles most conversation facts. Volatile state (versions, ports, deploy statuses) is stripped automatically. Save explicitly for: decisions, preferences, nuanced interpretations the user stated, or when the user asks. Always set `type` and `importance`. Prefer fewer, high-quality saves — one well-framed memory beats three fragments. Never save your own inferences as facts.

## What NOT to Do

**Recall:**
- Don't treat auto-recall as exhaustive — it's a starting point (rule 1)
- Don't hedge without searching first (rule 2)
- Don't trust recalled volatile state (versions, ports) — verify live
- Don't fabricate details beyond what memories state
- Don't assume repeated recall = truth — hallucinations can get re-captured

**Saving:**
- Don't save tool output, debug logs, or info you just recalled (feedback loops)
- Don't save your reasoning or assumptions — only user-stated facts
- Don't spam saves — batch related facts into one

**Forgetting:**
- Never delete without explicit user confirmation in the same turn

**Personal info:**
- Don't act on personal facts (birthdays, family) from memory without user confirmation
- Don't volunteer personal details the user didn't ask about

## Live State vs Memory

When memory and live workspace conflict: use live state for volatile facts, memory for historical context (decisions, rationale). Report both with timing so the user can correct either.

## Errors

If Cortex is unreachable: auto-recall degrades silently, auto-capture retries in background, explicit tool calls return errors (don't retry in a loop). Never hallucinate memories when recall is missing.
