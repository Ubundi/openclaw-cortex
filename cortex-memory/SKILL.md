---
name: cortex-memory
description: Use when searching, saving, or recalling cross-session memory. Auto-capture runs after every turn; explicit save needed for implementation specifics. Tools — `cortex_search_memory`, `cortex_save_memory`.
---

# Kwanda Cortex Memory

You have long-term memory via Cortex in addition to your normal workspace files. Cortex stores facts, decisions, and preferences across sessions and makes them searchable.

Keep doing everything you normally do — read your daily notes, write to `memory/YYYY-MM-DD.md`, answer from what you know. Cortex adds cross-session search on top.

## What Happens Automatically

- **Auto-Capture**: after each turn, topic-level summaries are extracted and stored in Cortex. You don't need to do anything.
- **Auto-Recall** (off by default): if enabled, memories appear in `<cortex_memories>` before each turn.

## Tools

### cortex_search_memory
Search long-term Cortex memory. Use this when your notes don't cover what you need — especially for things from older sessions.
```
cortex_search_memory(query="Redis cache key pattern", mode="facts", limit=5)
cortex_search_memory(query="email provider migration", mode="decisions", limit=10)
```
Parameters: `query` (required), `limit` (1–50, default 10), `mode` (all | decisions | preferences | facts | recent), `scope` (all | session | long-term).

### cortex_save_memory
Explicitly save a fact to Cortex for cross-session recall. Use this for important details that auto-capture might miss — exact values, specific decisions, config choices.
```
cortex_save_memory(text="API server runs on port 4000, Vite dev server on port 3000.", type="fact", importance="high")
cortex_save_memory(text="Chose Drizzle over Prisma — no codegen step, migrations are reviewable SQL.", type="decision", importance="high")
```
Parameters: `text` (required), `type` (preference | decision | fact | transient), `importance` (high | normal | low), `checkNovelty` (bool).

**Important**: `cortex_save_memory` saves to Cortex, not to your daily notes. Keep writing to `memory/YYYY-MM-DD.md` as normal — Cortex saves are in addition to your notes, not instead of.

### cortex_get_memory
Fetch full details of a specific memory by node ID (from search results).
```
cortex_get_memory(nodeId="e2c5e67b-8c73-446b-bacc-a576659b896f")
```

### cortex_forget
Remove memories by entity or session. Always search first, show candidates to the user, and confirm before deleting.
```
cortex_forget(entity="SendGrid")
cortex_forget(session="abc-123-def")
```

### cortex_set_session_goal
Set the session objective to bias recall and tag captures.
```
cortex_set_session_goal(goal="Debug the authentication timeout issue")
```

## When to Use Cortex Search

You don't need to search Cortex for everything. Use it when:
- Your notes don't have what you need
- The question is about something from an older session
- You need to find a decision or rationale from weeks ago
- The user asks about something you don't recall from context

Don't search Cortex as a prerequisite for answering. If you know the answer from your notes or context, just answer.

## Saving Tips

Auto-capture handles general topics. Explicitly save specific values that someone might ask for later:
- Exact config values, port numbers, paths
- Library/tool choices with rationale
- Architecture decisions
- Key metrics (before/after)

Structure saves as self-contained facts:
```
cortex_save_memory(text="Redis cache key pattern: arclight:user:{userId}, cache-aside with invalidation helper. Decided 2026-01-15.", type="decision", importance="high")
```

## Commands

`/checkpoint` (save summary before reset) · `/sleep` (clean session end) · `/audit on|off` (toggle API logging)

## Live CLI Actions

When the user asks for live Cortex state and you have terminal access:
```bash
openclaw cortex status     # health and connection check
openclaw cortex memories   # recent memory summaries
openclaw cortex search ... # terminal-based memory lookup
openclaw cortex config     # current plugin settings
openclaw cortex pair       # TooToo pairing code
```

**Confirmation required:** `openclaw cortex reset` is destructive. Never run it unless the user has explicitly asked.

## Guardrails

- Never save your reasoning or assumptions — only user-stated facts
- Never fabricate specific values not in your notes or Cortex results
- Never delete memories without explicit user confirmation
- Don't spam saves — batch related facts into one

## Privacy & Data Handling

Conversation transcripts are sent to the Cortex API for fact extraction. Volatile state (versions, ports, task statuses) is stripped before capture. Secrets and credentials are filtered by the capture pipeline.

Runtime credentials use a hybrid placement for compatibility. For managed Kwanda agents, `plugins.entries.openclaw-cortex.config.apiKey` must be a plain string because OpenClaw 2026.4.26 rejects provider-style SecretRef objects in plugin config. ClawDeploy also mirrors the same value into `~/.openclaw/secrets.json` under `cortex` for local tooling; do not replace the plugin field with a SecretRef unless the runtime adds first-class support.

**User controls:** Disable auto-capture (`autoCapture: false`), disable auto-recall (`autoRecall: false`), forget specific memories (`cortex_forget`), audit all API traffic (`/audit on`). All data is scoped per user and per workspace (namespace isolation).
