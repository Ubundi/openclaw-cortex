# Changelog

All notable changes to the Kwanda Cortex Memory skill will be documented in this file.

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
