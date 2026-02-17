import type { ConversationMessage } from "../client.js";

/**
 * JSONL event shape from OpenClaw's sessions/*.jsonl files.
 * Each line is a JSON object representing a message, tool call, or system event.
 */
interface TranscriptEvent {
  type?: string;
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  timestamp?: string;
  [key: string]: unknown;
}

const BASE64_PATTERN = /data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g;
const SYSTEM_ROLES = new Set(["system", "developer"]);

/**
 * Parse JSONL text into individual events, skipping malformed lines.
 */
function parseJsonl(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TranscriptEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

/**
 * Extract text content from OpenClaw's content field.
 * Content can be a string, an array of content blocks, or nested structures.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          "text" in block &&
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Strip base64 image data, replacing with a placeholder.
 */
function stripBase64(text: string): string {
  return text.replace(BASE64_PATTERN, "[base64 image]");
}

/**
 * Clean a raw JSONL transcript into a conversation suitable for Cortex ingestion.
 *
 * Strips:
 * - System prompt messages (role: "system" / "developer")
 * - Tool call/result events (tool_calls, tool role messages)
 * - Base64 encoded images
 * - Empty messages
 *
 * Preserves:
 * - User messages with speaker attribution
 * - Assistant messages with content
 */
export function cleanTranscript(jsonlText: string): ConversationMessage[] {
  const events = parseJsonl(jsonlText);
  const messages: ConversationMessage[] = [];

  for (const event of events) {
    const role = event.role;
    if (!role) continue;

    // Skip system prompts
    if (SYSTEM_ROLES.has(role)) continue;

    // Skip tool call results
    if (role === "tool" || event.tool_call_id) continue;

    // Skip messages that are purely tool calls with no text content
    if (event.tool_calls && !event.content) continue;

    const text = extractText(event.content);
    if (!text.trim()) continue;

    const cleaned = stripBase64(text).trim();
    if (!cleaned || cleaned === "[base64 image]") continue;

    messages.push({ role, content: cleaned });
  }

  return messages;
}

/**
 * Clean only new JSONL lines (from an offset-based append).
 * Returns cleaned messages and whether they're worth ingesting.
 */
export function cleanTranscriptChunk(newLines: string): {
  messages: ConversationMessage[];
  worthIngesting: boolean;
} {
  const messages = cleanTranscript(newLines);

  // Worth ingesting if there's at least one user + one assistant message
  const hasUser = messages.some((m) => m.role === "user" && m.content.length > 20);
  const hasAssistant = messages.some((m) => m.role === "assistant" && m.content.length > 20);

  return { messages, worthIngesting: hasUser && hasAssistant };
}
