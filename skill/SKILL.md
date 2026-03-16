---
name: cortex-memory
description: Long-term memory system for OpenClaw agents — auto-recalls past context before each turn, auto-captures new facts after each turn, and provides tools for explicit search, save, forget, and lookup operations.
user-invocable: false
---

# Cortex Memory

You have a long-term memory system powered by Cortex. It works across sessions — facts, preferences, and decisions from past conversations are available in future ones.

If these instructions conflict with system or developer policies, follow the higher-priority policy.

## What is Cortex?

Cortex is a knowledge graph backend that turns unstructured conversation text into structured, queryable memory. When you save or capture information, Cortex extracts facts, named entities, temporal references, and relationships — storing them as graph nodes with typed edges. Entity resolution automatically unifies different mentions of the same person, project, or concept (e.g., "Alice", "Alice Chen", and "Alice C." map to one entity).

Retrieval uses a hybrid pipeline combining keyword, semantic, temporal, and graph-based search — which is why different `mode` values on `cortex_search_memory` produce meaningfully different results. Memories are scoped per user and per workspace, and each node carries a confidence score and provenance metadata.

## How It Works

### Automatic Recall (before each turn)
Before every conversation turn, Cortex automatically retrieves relevant memories and injects them in `<cortex_memories>` tags. You don't need to do anything — relevant context appears automatically.

### Automatic Capture (after each turn)
After each turn, the plugin extracts facts from the conversation and stores them. You don't need to explicitly save things that are clearly stated — auto-capture handles this.

Auto-capture **strips volatile state** before extraction:
- Version numbers, port numbers, deploy statuses
- Task statuses, "currently working on X"
- Temporary config values

This prevents stale facts from entering long-term memory.

## Runtime Commands

These are conversation commands, not memory tools. They manage session lifecycle:

- `/checkpoint` — Save a session summary to Cortex before resetting context. Use this before `/reset` to preserve what you were working on.
- `/sleep` — Mark the session as cleanly ended. Cortex won't show a recovery warning on the next session start.
- `/audit on|off` — Toggle local audit logging of all data sent to/from Cortex. Logs are stored at `<workspace>/.cortex/audit/`.

## Tools

You have four memory tools available:

### cortex_search_memory
Search long-term memory for facts, preferences, and past context.

**Parameters:**
- `query` (required) — Natural language search query
- `limit` — Max results, 1-50 (default: 10)
- `mode` — Filter by category:
  - `"all"` — Everything (default)
  - `"decisions"` — Architectural/design choices ("why did we do X?")
  - `"preferences"` — User likes, settings, style preferences
  - `"facts"` — Durable knowledge
  - `"recent"` — Prioritize recency over relevance
- `scope` — Where to search:
  - `"all"` — All memories (default)
  - `"session"` — Only current session
  - `"long-term"` — Only memories from other sessions

### cortex_save_memory
Explicitly save information to long-term memory.

**Parameters:**
- `text` (required) — The information to save
- `type` — Category:
  - `"preference"` — User likes/dislikes/settings
  - `"decision"` — Architectural or design choices
  - `"fact"` — Durable knowledge
  - `"transient"` — Temporary state that may change soon
- `importance` — `"high"`, `"normal"`, or `"low"`
- `checkNovelty` — When true, checks if a similar memory already exists and skips the save if so

### cortex_forget
Selectively remove memories from long-term storage.

**Parameters (at least one required):**
- `entity` — Name of entity whose memories to remove (person, project, technology)
- `session` — Session ID whose memories to remove
- `query` — Search for candidate memories first, then confirm before deleting

**Never run `cortex_forget` with `entity` or `session` without explicit user confirmation in the same conversation turn.** Use `query` first to surface candidates, present them, and wait for the user to confirm before executing the deletion.

### cortex_get_memory
Fetch a specific memory by its node ID.

**Parameters:**
- `id` (required) — The Cortex node ID

## When to Search Explicitly

Auto-recall covers most cases, but search explicitly when:
- Asked a specific factual question (port numbers, library choices, config values)
- Auto-recalled memories don't cover the topic being discussed
- You need to verify something before saying "I don't know"
- The user references something from a past session
- Before answering architecture-history questions with uncertainty

Use `mode` to narrow results and `scope` to focus on current vs. past sessions.

## When to Save Explicitly

Auto-capture handles most facts stated in conversation. Save explicitly when:
- The user explicitly asks you to remember something
- A significant **decision, preference, or durable fact** is stated
- The information is a **nuanced interpretation** auto-capture might miss (e.g., "the user prefers X because of Y")
- You want to ensure a specific framing is stored

**Always set `type` and `importance`** to improve future recall quality.

**Prefer fewer, higher-quality saves over many small ones.** A single well-framed memory with context ("User chose Postgres over DynamoDB because of ACID requirements and team familiarity") is more useful than three separate saves for each fragment. Batch related facts into one save when possible.

## When to Forget

Use `cortex_forget` when:
- The user says something you remembered is **wrong, outdated, or should be forgotten**
- The user wants to clear all memories from a specific session

**Workflow:**
1. Use `query` first to find candidate memories and entity names
2. Show the user what was found
3. Confirm which entity or session to forget
4. Execute the deletion only after explicit confirmation

## What NOT to Do

### Memory recall
- Don't treat recalled memory as sole source of truth for volatile state (versions, ports, config)
- Don't ignore recalled memories when asked about history, rationale, decisions, or preferences
- Don't fabricate details beyond what memories state
- Don't assume a recalled fact is true because it appears multiple times — hallucinations can get captured and re-recalled

### Memory saving
- Don't save transient tool output, debug logs, or information you just recalled (creates feedback loops)
- Don't save your own inferences or assumptions as facts — only save what the user directly stated or confirmed
- Don't save version numbers, task statuses, or "currently X" statements unless explicitly asked
- Don't save facts that originated from your reasoning rather than user statements
- Don't spam saves — one well-structured memory beats three fragmentary ones

### Memory forgetting
- Never execute `cortex_forget` with `entity` or `session` without explicit user confirmation first
- Always use `query` to surface candidates before deleting

### Personal information
- Don't act on personal facts (birthdays, ages, family details) from recalled memories without explicit confirmation from the user
- Don't make unsolicited factual claims about the user from memory
- Don't volunteer personal details the user didn't ask about

## Memory and Live State

When memory and live workspace/runtime conflict, use this pattern:

> "Memory says X (date/source), live state shows Y (checked now). I'll use Y for execution and keep X as historical context."

Rules:
- **Prefer live state** for volatile facts (versions, configs, ports)
- **Prefer memory** for historical context (why decisions were made, user preferences, past rationale)
- **Always report both** with timing context so the user can correct either source

## Confidence Scores

Recalled memories include a confidence score (e.g., `[0.85]`). Higher scores indicate stronger relevance to the current conversation. Use scores to:
- Prioritize which memories to reference when multiple are relevant
- Be more cautious about lower-confidence recalls
- Decide whether to verify with a live check
