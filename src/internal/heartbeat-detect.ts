import type { ConversationMessage } from "../cortex/client.js";

/**
 * Patterns that identify heartbeat turns — periodic status checks that produce
 * low-signal operational noise. Used by both recall (skip retrieval) and capture
 * (skip ingestion) handlers.
 */
const HEARTBEAT_PATTERNS: RegExp[] = [
  /\bHEARTBEAT[_.\s]?(?:md|OK)\b/i,
  /\bif nothing needs attention,?\s*reply\b/i,
  /\bdo not infer or repeat old tasks\b/i,
  /\bheartbeat poll\b/i,
  /\bfollow it strictly\.?\s*do not infer/i,
];

/** Check if a prompt string matches heartbeat patterns. */
export function isHeartbeatTurn(prompt: string): boolean {
  return HEARTBEAT_PATTERNS.some((p) => p.test(prompt));
}

/** Check if any user message in the array matches heartbeat patterns. */
export function containsHeartbeatPrompt(messages: ConversationMessage[]): boolean {
  return messages.some(
    (m) => m.role === "user" && HEARTBEAT_PATTERNS.some((p) => p.test(m.content)),
  );
}
