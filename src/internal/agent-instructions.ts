import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "## Cortex Memory";

const CORTEX_INSTRUCTIONS = `

## Cortex Memory

You have a long-term memory system powered by Cortex. Before each conversation turn, relevant memories from past conversations are automatically injected in \`<cortex_memories>\` tags.

### How to use recalled memories

- **Trust recalled memories for project knowledge.** They come from your own past conversations and represent things you discussed, decided, or learned previously.
- **Do not override recalled memories with filesystem exploration.** If a memory says "we use vitest" but you don't see vitest config files in the workspace, the memory is still correct — the project files may not be present locally.
- **When answering factual questions about projects, preferences, decisions, or conventions, prefer recalled memories over filesystem state.** The workspace may be empty or incomplete, but your memories reflect the full conversation history.
- **Memories include a confidence score** (e.g., \`[0.85]\`). Higher scores indicate stronger relevance to the current conversation.
- **You also have \`cortex_search_memory\` and \`cortex_save_memory\` tools** for explicit search and save when the automatic recall isn't sufficient.

### What NOT to do

- Don't dismiss recalled memories because you can't find matching files on disk.
- Don't say "I don't have information about X" when recalled memories contain information about X.
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
