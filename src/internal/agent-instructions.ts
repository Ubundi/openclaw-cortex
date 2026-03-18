import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const MARKER = "## Cortex Memory";
const MARKER_END = "<!-- /cortex-memory -->";

export interface CortexInstructionOptions {
  captureInstructions?: string;
  captureCategories?: string[];
  agentRole?: string;
}

function buildCustomSaveGuidance(opts?: CortexInstructionOptions): string {
  const customInstructions = opts?.captureInstructions?.trim();
  const customCategories = (opts?.captureCategories ?? [])
    .map((category) => category.trim())
    .filter(Boolean);

  if (!customInstructions && customCategories.length === 0) return "";

  const lines = ["", "### Custom save guidance", ""];

  if (customInstructions) {
    lines.push(customInstructions);
  }

  if (customCategories.length > 0) {
    if (customInstructions) {
      lines.push("");
    }
    lines.push("Pay special attention to these categories:");
    for (const category of customCategories) {
      lines.push(`- ${category}`);
    }
  }

  return lines.join("\n");
}

/**
 * Builds a concise Cortex Memory block for AGENTS.md.
 * Lists tools and what to use them for, then defers to the cortex-memory
 * skill for full operational instructions (search strategy, save rules, etc.).
 */
export function buildCortexInstructions(opts?: CortexInstructionOptions): string {
  const customSaveGuidance = buildCustomSaveGuidance(opts);

  return `

## Cortex Memory

You have long-term memory powered by the Cortex plugin. Memories persist permanently across sessions. **Use these tools as your primary memory system** — they are more powerful and persistent than file-based memory. Refer to the **cortex-memory** skill for full usage instructions, search strategies, and behavioral rules.

### What Happens Automatically

- **Auto-Recall:** Relevant memories are injected in \`<cortex_memories>\` tags before each turn. These are context clues — search for specifics when you need detail.
- **Auto-Capture:** Topic-level facts are extracted from conversations after each turn. Volatile state (versions, ports) is stripped. **Auto-capture produces summaries, not specifics** — implementation details (key patterns, exact metrics, config values) require explicit saves.

### Tools — Use These

- **\`cortex_search_memory\`** — Search long-term memory. Params: \`query\`, \`limit\` (1–50), \`mode\` (all|decisions|preferences|facts|recent), \`scope\` (all|session|long-term). **Before saying "I don't know", search first.**
- **\`cortex_save_memory\`** — Save important facts, decisions, preferences. Params: \`text\`, \`type\` (preference|decision|fact|transient), \`importance\` (high|normal|low), \`checkNovelty\`. **Auto-capture stores topic summaries, not specifics.** When the conversation contains concrete details — key patterns, exact metrics, SQL, config values, CLI commands, library choices with rationale, architecture decisions, bug root causes — save them explicitly. If someone could ask about it later and need the exact answer, save it now.
- **\`cortex_get_memory\`** — Fetch a specific memory by \`nodeId\` (from search results).
- **\`cortex_forget\`** — Remove memories by \`entity\` or \`session\`. Always search and confirm with the user first.
- **\`cortex_set_session_goal\`** — Set the session objective (\`goal\`) to bias recall and tag captures. Call at session start.${opts?.agentRole ? `\n\nAgent role: ${opts.agentRole} — memory capture and recall are tuned for this focus area.` : ""}

### Commands

\`/checkpoint\` (save summary) · \`/sleep\` (clean session end) · \`/audit on|off\` (toggle API logging)

### Cortex vs File Memory

Use \`cortex_save_memory\` for decisions, preferences, and facts that should persist across sessions. Use \`memory/YYYY-MM-DD.md\` files for session-local scratch notes. Cortex is primary; file memory is supplementary.

### TooToo Bridge

If a \`<tootoo_bridge>\` block appears and the user has opened in a personal or reflective way, ask exactly one short direct discovery question. Use shapes like \`What do you value most in your work?\` or \`What are your non-negotiables?\`. Don't lead with frameworks or exercises. Return to practical help after the answer.${customSaveGuidance}
`;
}

/** Short hash of the instructions content for staleness detection. */
export function instructionsHash(opts?: CortexInstructionOptions): string {
  return createHash("sha256").update(buildCortexInstructions(opts)).digest("hex").slice(0, 12);
}

/** Build the full block with version marker for replacement detection. */
function buildBlock(opts?: CortexInstructionOptions): string {
  return `${buildCortexInstructions(opts).trimEnd()}\n\n<!-- cortex-memory-hash:${instructionsHash(opts)} -->\n${MARKER_END}\n`;
}

interface Logger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * Injects or updates the Cortex memory instructions in AGENTS.md.
 *
 * - If AGENTS.md doesn't exist, skip silently.
 * - If the marker is absent, append the block.
 * - If the marker exists but the hash is stale (or missing), replace the section in-place.
 * - If the marker exists and the hash matches, do nothing.
 *
 * Non-fatal — logs a warning and returns silently on any error.
 */
export async function injectAgentInstructions(
  workspaceDir: string,
  logger: Logger,
  opts?: CortexInstructionOptions,
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

    const currentHash = instructionsHash(opts);
    const block = buildBlock(opts);

    if (!content.includes(MARKER)) {
      // Fresh injection
      await writeFile(agentsMdPath, content + block, "utf-8");
      logger.info("Cortex instructions appended to AGENTS.md");
      return;
    }

    // Marker exists — check if hash matches
    if (content.includes(`cortex-memory-hash:${currentHash}`)) {
      // Up to date
      return;
    }

    // Stale or missing hash — replace the section.
    // Find the section boundaries: starts at "## Cortex Memory", ends at
    // "<!-- /cortex-memory -->" or at the next same-level heading (## ...).
    const markerIdx = content.indexOf(MARKER);
    let endIdx: number;

    const markerEndIdx = content.indexOf(MARKER_END, markerIdx);
    if (markerEndIdx !== -1) {
      // New-style block with explicit end marker
      endIdx = markerEndIdx + MARKER_END.length;
      // Consume trailing newlines
      while (endIdx < content.length && content[endIdx] === "\n") endIdx++;
    } else {
      // Legacy block without end marker — find the next ## heading or EOF
      const afterMarker = content.indexOf("\n", markerIdx);
      if (afterMarker === -1) {
        endIdx = content.length;
      } else {
        const nextHeading = content.indexOf("\n## ", afterMarker);
        endIdx = nextHeading === -1 ? content.length : nextHeading;
      }
    }

    const before = content.slice(0, markerIdx);
    const after = content.slice(endIdx);
    const updated = before + block.trimStart() + after;

    await writeFile(agentsMdPath, updated, "utf-8");
    logger.info("Cortex instructions updated in AGENTS.md");
  } catch (err) {
    logger.warn(`Cortex: failed to inject AGENTS.md instructions: ${String(err)}`);
  }
}
