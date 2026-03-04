import type { ConversationMessage } from "../../adapters/cortex/client.js";

/**
 * Patterns that match low-signal content not worth ingesting into memory.
 * Applied to both auto-capture messages and file sync text blocks.
 */
const LOW_SIGNAL_PATTERNS: RegExp[] = [
  /\bHEARTBEAT[_\s]?OK\b/i,
  /\btask completed at \d/i,
  /\bstatus[:\s]+(idle|connected|ok|ready)\b/i,
  /^(ok|done|yes|no|sure|thanks|got it|acknowledged)\.?$/i,
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,             // timestamp-only lines
  /^agent .+\| session .+\| anthropic\//i,              // TUI status bar
  /^[─━═]{10,}$/,                                       // decorative rules
  /^connected \| idle$/i,
  /tokens \d+k?\/\d+k? \(\d+%\)/i,                     // token counter

  // OpenClaw session management boilerplate
  /\bsession startup sequence\b/i,
  /\bnew session was started via \/new\b/i,
  /\bgreet the user in your configured persona\b/i,
  /\bdo not mention internal steps,? files,? tools/i,
  /\bexecute your session startup\b/i,
  /\bruntime model differs? from default.model\b/i,
];

/** Returns true if the content matches a known low-signal pattern. */
export function isLowSignal(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Filters out messages whose content is entirely low-signal noise. */
export function filterLowSignalMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((m) => !isLowSignal(m.content));
}

/** Filters out low-signal lines from a text block, returning the cleaned text. */
export function filterLowSignalLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isLowSignal(line))
    .join("\n");
}
