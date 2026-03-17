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
 * Builds a slim pointer block for AGENTS.md. The full operational instructions
 * live in the `cortex-memory` skill (skill/SKILL.md); this block only contains
 * a brief orientation and any workspace-specific custom save guidance.
 */
export function buildCortexInstructions(opts?: CortexInstructionOptions): string {
  const customSaveGuidance = buildCustomSaveGuidance(opts);

  return `

## Cortex Memory

You have long-term memory powered by the Cortex plugin. Refer to the **cortex-memory** skill for full usage instructions.

**Quick reference:**
- Relevant memories are auto-injected in \`<cortex_memories>\` tags before each turn. These are **context clues, not complete answers** — always search for specifics before answering detailed questions or hedging.
- New facts are auto-captured after each turn (volatile state like versions/ports is stripped).
- Tools: \`cortex_search_memory\`, \`cortex_save_memory\`, \`cortex_forget\`, \`cortex_get_memory\`.
- Commands: \`/checkpoint\` (save session summary), \`/sleep\` (clean session end), \`/audit\` (toggle API logging).
- At session start, identify the user's primary objective and call \`cortex_set_session_goal\` to set it. Update if the goal shifts.${opts?.agentRole ? `\n- Agent role: ${opts.agentRole} — memory capture and recall are tuned for this focus area.` : ""}
- **Before saying "I don't know" or "I can't confirm", search with \`cortex_search_memory\`.**
- For volatile facts (versions, ports, config), verify against live workspace — don't rely solely on memory.
- Never save your own inferences as facts. Only save what the user explicitly stated.
- Always confirm with the user before forgetting memories.
- **TooToo Bridge:** If a \`<tootoo_bridge>\` block appears, and the user has opened in a personal or reflective way, your first move should usually be exactly one short direct discovery question. Prefer clean shapes like \`What do you value most in your work?\`, \`What matters most to you in your work?\`, or \`What are your non-negotiables?\`. Don't lead with frameworks or exercises, don't derail concrete tasks, return to practical help after the answer, and don't mention TooToo by name. See the cortex-memory skill for full guidance.${customSaveGuidance}
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
 * Injects or updates a slim Cortex memory pointer in AGENTS.md.
 *
 * The full operational instructions live in the cortex-memory skill
 * (skill/SKILL.md). This block provides a brief orientation and any
 * workspace-specific custom save guidance from the plugin config.
 *
 * - If AGENTS.md doesn't exist, skip silently.
 * - If the marker is absent, append the pointer block.
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
