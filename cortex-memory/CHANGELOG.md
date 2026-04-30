# Changelog

All notable changes to the Kwanda Cortex Memory skill will be documented in this file.

## [2.0.2] - 2026-04-29

### Changed
- Corrected Cortex API key placement guidance after runtime validation errors: `plugins.entries.openclaw-cortex.config.apiKey` must remain a plain string on OpenClaw 2026.4.26.
- Clarified that ClawDeploy mirrors the same key into `~/.openclaw/secrets.json["cortex"]` for local tooling, but that mirror is not the plugin config source.

### Rationale
Provider-style SecretRef objects are valid for managed model/provider keys, but the current `openclaw-cortex` plugin config path validates `apiKey` as a string and rejects SecretRef objects. The documentation now matches the ClawDeploy compatibility path.

## [2.0.1] - 2026-04-29

**Superseded by 2.0.2.** This entry captured an attempted SecretRef migration that caused runtime validation errors and should not be followed for current deployments.

### Changed
- Documented the managed Cortex API key shape as a file-backed OpenClaw SecretRef: `plugins.entries.openclaw-cortex.config.apiKey` points to `/cortex`, while the raw key lives in `~/.openclaw/secrets.json`.
- Updated deployment examples and configuration reference to avoid placing raw Cortex API keys in `openclaw.json`.

### Rationale
This was the intended direction before live/runtime validation showed that the current `openclaw-cortex` plugin config requires `apiKey` to remain a string. See 2.0.2 for the corrected placement.

## [2.0.0] - 2026-04-06

### Changed
- **Major simplification** — reduced SKILL.md from 161 lines to 108 lines by removing prescriptive rules in favor of trust-the-agent guidance
- **Introduction** reframed — agent is no longer "memory-augmented assistant"; Cortex is positioned as an addition to normal workspace files (daily notes, `memory/YYYY-MM-DD.md`)
- **Description** updated — "on-demand search tools for cross-session recall" replaces "auto-recall before turns"
- **Auto-Recall** now documented as off by default
- **Tools** restructured from numbered "Core Capabilities" list to flat tool headings (`cortex_search_memory`, `cortex_save_memory`, etc.)
- **Guardrails** condensed from detailed do/don't lists to 4 concise rules
- **CLI actions** removed `openclaw cortex info` command
- **Session Goal** removed role-specific guidance (developer/researcher/manager/support biases) and `clear=true` parameter
- **README** updated — description reflects on-demand model, testing checklist simplified

### Removed
- **Connection Check** section (and Error Handling subsection) — runtime handles connectivity
- **Operating Modes** section — distinction between automatic and explicit modes was unnecessary overhead
- **Memory Verification Protocol** section — replaced by simpler guardrail "never fabricate specific values"
- **Mandatory Behavioral Rules** section (6 rules) — key behaviors preserved in simplified "When to Use Cortex Search", "Saving Tips", and "Guardrails" sections
- **Live State vs Memory** section — guidance was rarely actionable

### Added
- **What Happens Automatically** section — concise summary of auto-capture and auto-recall
- **When to Use Cortex Search** section — guides when to search vs answer from context
- **Saving Tips** section — what to explicitly save and how to structure saves
- Note clarifying `cortex_save_memory` saves to Cortex, not daily notes

### Rationale
The previous version was heavily prescriptive — 6 mandatory rules, a multi-step verification protocol, role-specific biases — all adding token cost without proportional value. Agents following simpler guidance ("don't fabricate", "search when notes don't cover it") produce equivalent results. The rewrite trusts the agent more and costs fewer tokens per invocation.

## [1.4.0] - 2026-03-24

### Added
- **`user-invocable: true`** in frontmatter — framework v2.0.0 requires this field; cortex-memory is user-invocable (users say "remember this", "search memories", "forget X")
- **Error Handling** subsection under Connection Check — framework v2.0.0 requires an explicit error handling section; consolidates the fallback-to-file-based-memory guidance into a `####` heading matching the pattern used by email/calendar skills

### Rationale
Framework v2.0.0 makes `user-invocable` a required frontmatter field and Error Handling a required section. The v1.2.0 changelog noted Error Handling was intentionally removed because its content was distributed across Connection Check and behavioral rules — the new `####` subsection preserves that distribution while satisfying the framework requirement without duplication.

## [1.3.0] - 2026-03-21

### Added
- **Memory Verification Protocol** section — step-by-step process for verifying auto-recalled memories before citing specific details. Agent must confirm an exact match exists in recalled content before citing it; if the detail is inferred or absent, agent must search explicitly or abstain rather than guess.
- Explicit list of high-risk detail types (port numbers, directory paths, library/tool names, API endpoints, config values, dates, version numbers) that require verification before citation

### Changed
- **README** updated — description now references the verification protocol; testing checklist includes a verification behavior check

### Rationale
Auto-recalled memories are summaries, not verbatim records. The most common failure mode is the agent citing a close-but-wrong specific value (e.g. port 3001 instead of 3000) from general context in `<cortex_memories>`. The verification protocol makes this an explicit decision point rather than leaving it to implicit judgment, complementing the existing Rule 5 (Precision Over Confidence) with a concrete workflow.

## [1.2.0] - 2026-03-20

### Added
- **Connection Check** section — agent confirms Cortex reachability by checking for `<cortex_memories>` presence before probing with a tool call; falls back to file-based memory gracefully
- **Operating Modes** section — explicitly names Automatic (runtime-managed recall/capture) and Explicit (agent-invoked tools) modes so the agent understands what it controls vs what the runtime handles
- **Role-specific guidance** under Session Goal — behavioral biases for developer, researcher, manager, and support roles
- **Zero-placeholder tool examples** for every Core Capability (search, save, forget, get, session goal)
- **CLI code block** with inline comments replacing the previous prose list

### Changed
- **Introduction** expanded from one sentence to a role-framing paragraph
- **Rule 6 (Save Implementation Details)** condensed — removed redundant trigger paragraph, added inline `cortex_save_memory` call example
- **Guardrails** trimmed — removed "never save tool output or recalled info" rule (enforced by runtime's RecallEchoStore/CaptureWatermarkStore, not the agent)
- **Session Goals** folded into Core Capabilities #5 (was a standalone section)
- **README** updated — description reflects operating modes, testing checklist renamed to Connection & Modes, CLI guidance condensed

### Removed
- **Tone and Style** section — coverage distributed across TooToo Bridge (conversational tone), Live State vs Memory (conflict reporting), and Guardrails (timing context)
- **Error Handling** section — coverage distributed across Connection Check (unreachability), Rule 5 (no hallucination), and Rule 2 (no-results behavior)

### Rationale
Benchmarked against email-assistant, calendar-assistant, and the openclaw-cortex runtime source. Key finding: the runtime already enforces feedback-loop prevention and context-profile selection, so SKILL.md rules duplicating that were trimmed. Added operating modes and connection check patterns from the other skills, adapted to Cortex's passive-connectivity model. Tone and Error Handling sections removed intentionally — their content is distributed across other sections rather than duplicated, keeping token cost down while preserving all behavioral rules.

## [1.1.0] - 2026-03-18

### Changed
- Removed unsupported frontmatter attributes (`version`, `tools`, `user-invocable`) from SKILL.md
- Restructured SKILL.md to follow repo conventions:
  - Added "Core Capabilities" section (replaces flat "Tools" and "Commands" lists)
  - Added "Guardrails and Security" section (consolidates "What NOT to Do" items)
  - Added "Tone and Style" section
  - Added "Privacy & Data Handling" section
  - Renamed "Errors" to "Error Handling" with expanded guidance
- Removed duplicated save/capture guidance (was repeated in both "Mandatory Behavioral Rules" and "Save & Capture")
- Condensed TooToo Bridge section from 28 lines to 15 lines
- Added Support footer to README.md

### Rationale
Alignment with repo conventions established by email-assistant and calendar-assistant skills. No behavioral changes — same agent instructions, reorganized for consistency.

## [1.0.0] - 2026-03-16

### Added
- Initial release
- Comprehensive agent instructions for cortex memory tools (search, save, forget, get)
- Agent command reference (/checkpoint, /sleep, /audit)
- Memory hygiene guidelines (what to save, what not to save)
- Volatile state handling guidance
- Confidence score interpretation
- Memory vs. live state conflict resolution patterns
- Deployment guide with full configuration reference
- CLI command documentation
- Testing checklist
- Troubleshooting guide
- Privacy and data handling documentation
