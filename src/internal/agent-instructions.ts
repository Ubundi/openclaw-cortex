import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const MARKER = "## Cortex Memory";
const MARKER_END = "<!-- /cortex-memory -->";

export interface CortexInstructionOptions {
  captureInstructions?: string;
  captureCategories?: string[];
}

function buildCustomSaveGuidance(opts?: CortexInstructionOptions): string {
  const customInstructions = opts?.captureInstructions?.trim();
  const customCategories = (opts?.captureCategories ?? [])
    .map((category) => category.trim())
    .filter(Boolean);

  if (!customInstructions && customCategories.length === 0) return "";

  const lines = ["### Custom save guidance", ""];

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

export function buildCortexInstructions(opts?: CortexInstructionOptions): string {
  const customSaveGuidance = buildCustomSaveGuidance(opts);

  return `

## Cortex Memory

You have a long-term memory system powered by Cortex. Before each conversation turn, relevant memories from past conversations are automatically injected in \`<cortex_memories>\` tags.

### How to use recalled memories

- **Use recalled memories for historical context.** They are strongest for preferences, prior decisions, rationale, and cross-session continuity.
- **For volatile current-state facts, verify against live workspace/runtime first.** Examples: versions, ports, env/config defaults, active dependencies, and script commands.
- **If memory and live state conflict, report both with timing context.** Example: "Memory says X (from March 4, 2026), current repo shows Y."
- **Memories include a confidence score** (e.g., \`[0.85]\`). Higher scores indicate stronger relevance to the current conversation.
- **You also have \`cortex_search_memory\`, \`cortex_get_memory\`, \`cortex_save_memory\`, and \`cortex_forget\` tools** for explicit search, lookup by ID, save, and selective removal when the automatic recall isn't sufficient.

### When to search explicitly

- When asked a specific factual question (port numbers, library choices, config values), use \`cortex_search_memory\` to look up the answer before responding from general knowledge.
- When auto-recalled memories don't cover the topic being asked about, search before saying "I don't know."
- Use \`mode\` to narrow results: \`"decisions"\` for "why did we do X?", \`"preferences"\` for style/config questions, \`"facts"\` for durable knowledge, \`"recent"\` when recency matters more than relevance.
- Use \`scope\` to focus the search on the current session, older long-term memories, or all stored memories.
- Use \`cortex_get_memory\` when you already have a specific memory ID and want the full details for that node.

### How auto-capture works

After each conversation turn, the plugin automatically extracts facts from the conversation and stores them in long-term memory. You do **not** need to explicitly save things that are clearly stated in the conversation — auto-capture handles this. However:

- Auto-capture **strips volatile state** (version numbers, task statuses, "currently working on X", port numbers, deploy status) before extraction to prevent stale facts from entering long-term memory.
- Auto-capture submits the conversation transcript and the backend extracts facts — you don't control exactly what gets extracted.
- If something is important and you're unsure whether auto-capture will pick it up, use \`cortex_save_memory\` explicitly.

### When to save explicitly

- When the user explicitly asks you to remember something.
- When a significant **decision, preference, or durable fact** is stated — especially if it would be useful in future sessions.
- When the information is a **nuanced interpretation** that auto-capture might miss (e.g., "the user prefers X because of Y" rather than a bare statement of X).
- Set \`type\` (\`"preference"\`, \`"decision"\`, \`"fact"\`, \`"transient"\`) and \`importance\` (\`"high"\`, \`"normal"\`, \`"low"\`) to improve future recall quality.
- Use \`type: "transient"\` for state that **will change soon** (current task in progress, temporary workaround, short-lived config). Transient memories are useful for session continuity but should not be treated as durable truth.
- **Don't save** transient tool output, debug logs, or information you just recalled — that creates feedback loops.
- **Don't save your own inferences or assumptions as facts.** Only save things the user has directly stated or confirmed. If you're uncertain about a fact, ask the user before saving it.${customSaveGuidance ? `\n\n${customSaveGuidance}` : ""}

### When to forget

- When the user says something you remembered is **wrong, outdated, or should be forgotten**, use \`cortex_forget\` with the entity name to remove those memories.
- When the user wants to clear all memories from a specific session, use \`cortex_forget\` with the session ID.
- Use \`query\` on \`cortex_forget\` to find candidate memories and entity names when the user describes the memory but doesn't know the exact entity or session yet.
- **Always confirm with the user before forgetting** — deletion is permanent.

### What NOT to do

- Don't treat recalled memory as the sole source of truth for volatile config/version questions.
- Don't ignore recalled memories when the question is about history, rationale, decisions, or user preferences.
- Don't fabricate details beyond what the memories state — if a memory says "TTL is 600s", use 600s, don't guess a different value.
- **Don't act on personal facts (birthdays, ages, anniversaries, family details) from recalled memories without explicit prior confirmation from the user.** Recalled memories can contain hallucinations that were captured as facts — ask to verify before acting on personal claims.
- **Don't make unsolicited factual claims about the user.** If the user didn't ask, don't volunteer personal details from memory (e.g., don't spontaneously wish happy birthday based on a recalled memory).
- **Don't assume a recalled fact is true because it appears multiple times.** Hallucinations can get captured and re-recalled repeatedly, creating false confidence through repetition.
- **Don't save facts that originated from your own reasoning rather than the user's statements.** If you infer "the user's birthday is March 10" from context clues, do NOT save that — only save what the user explicitly tells you.
- **Don't save version numbers, task statuses, or "currently X" statements** unless the user explicitly asks you to remember them. These go stale fast and auto-capture already filters them out.
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
 * Injects or updates Cortex memory instructions in AGENTS.md.
 *
 * - If AGENTS.md doesn't exist, skip silently.
 * - If the marker is absent, append the full block.
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
