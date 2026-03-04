import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "## Cortex Memory";

const CORTEX_INSTRUCTIONS = `

## Cortex Memory

You have a long-term memory system powered by Cortex. Before each conversation turn, relevant memories from past conversations are automatically injected in \`<cortex_memories>\` tags.

### How to use recalled memories

- **Use recalled memories for historical context.** They are strongest for preferences, prior decisions, rationale, and cross-session continuity.
- **For volatile current-state facts, verify against live workspace/runtime first.** Examples: versions, ports, env/config defaults, active dependencies, and script commands.
- **If memory and live state conflict, report both with timing context.** Example: "Memory says X (from March 4, 2026), current repo shows Y."
- **Memories include a confidence score** (e.g., \`[0.85]\`). Higher scores indicate stronger relevance to the current conversation.
- **You also have \`cortex_search_memory\` and \`cortex_save_memory\` tools** for explicit search and save when the automatic recall isn't sufficient.

### What NOT to do

- Don't treat recalled memory as the sole source of truth for volatile config/version questions.
- Don't ignore recalled memories when the question is about history, rationale, decisions, or user preferences.
- Don't fabricate details beyond what the memories state — if a memory says "TTL is 600s", use 600s, don't guess a different value.

### When to search explicitly

- When asked a specific factual question (port numbers, library choices, config values), use \`cortex_search_memory\` to look up the answer before responding from general knowledge.
- When auto-recalled memories don't cover the topic being asked about, search before saying "I don't know."
`;

interface Logger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * Appends Cortex memory instructions to AGENTS.md if not already present.
 * Idempotent — checks for the marker heading before appending.
 * Non-fatal — logs a warning and returns silently on any error.
 */
export async function injectAgentInstructions(
  workspaceDir: string,
  logger: Logger,
): Promise<void> {
  const agentsMdPath = join(workspaceDir, "AGENTS.md");

  try {
    let content: string;
    try {
      content = await readFile(agentsMdPath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // AGENTS.md doesn't exist — skip silently
        return;
      }
      throw err;
    }

    if (content.includes(MARKER)) {
      // Already injected
      return;
    }

    await appendFile(agentsMdPath, CORTEX_INSTRUCTIONS, "utf-8");
    logger.info("Cortex instructions appended to AGENTS.md");
  } catch (err) {
    logger.warn(`Cortex: failed to inject AGENTS.md instructions: ${String(err)}`);
  }
}
