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

You have long-term memory powered by the Cortex plugin. Memories persist permanently across sessions. Refer to the **cortex-memory** skill for full usage rules, search strategies, and behavioral guidelines.

### What Happens Automatically

- **Auto-Capture (always on):** Topic-level summaries extracted after turns. Implementation specifics require explicit saves.
- **Auto-Recall (off by default):** If enabled, relevant memories appear in \`<cortex_memories>\` tags before each turn — supplementary context, not exhaustive.

### Available Tools

- \`cortex_search_memory\` — Search long-term memory (query, limit, mode, scope)
- \`cortex_save_memory\` — Save facts, decisions, preferences (text, type, importance, checkNovelty)
- \`cortex_get_memory\` — Fetch full memory details by node ID
- \`cortex_forget\` — Remove memories by entity or session
- \`cortex_set_session_goal\` — Set session objective to bias recall and tag captures${opts?.agentRole ? `\n\nAgent role: ${opts.agentRole}` : ""}

### Commands

\`/checkpoint\` (save summary) · \`/sleep\` (clean session end) · \`/audit on|off\` (toggle API logging)

### Cortex vs File Memory

Your daily notes (\`memory/YYYY-MM-DD.md\`) contain detailed facts from recent conversations — read them first for exact values and specifics. Use \`cortex_search_memory\` for cross-session or older memories your notes don't cover. Use \`cortex_save_memory\` for important facts that should persist beyond daily notes (decisions, architecture choices, key metrics).${customSaveGuidance}
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
