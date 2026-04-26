import type { ConversationMessage } from "../../cortex/client.js";

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

  // Filesystem metadata chatter (highly repetitive, low semantic value)
  /^User has a (file|directory) named /i,
  /^The (file|directory) ['"].+['"] has permissions /i,
  /\bwith permissions\s+[d-][rwx-]{9}\b/i,
  /\bowned by user ['"][^'"]+['"]\b/i,
  /\band group ['"][^'"]+['"]\b/i,
  /\bsize of \d+ bytes\b/i,
  /\blast modified on\b/i,
  /\bcreated on\b/i,

];

const AUDIT_STATUS_LINE_PATTERNS: RegExp[] = [
  /^\*\*Cortex Audit Log\*\*$/i,
  /^Audit log is already enabled\.$/i,
  /^Audit log is already off\. No data is being recorded\.$/i,
  /^(?:\*\*)?Audit log enabled\.(?:\*\*)?$/i,
  /^(?:\*\*)?Audit log disabled\.(?:\*\*)?$/i,
  /^(?:\*\*)?Audit log enabled\.(?:\*\*)?\s+Log path:\s*`?.*\/\.cortex\/audit\/`?$/i,
  /^(?:\*\*)?Audit log disabled\.(?:\*\*)?\s+`?.*\/\.cortex\/audit\/`?$/i,
  /^All data sent to and received from Cortex will be recorded locally\.$/i,
  /^All Cortex API calls are being recorded at:$/i,
  /^Cortex API calls are no longer being recorded\.$/i,
  /^Existing log files are preserved and can be reviewed at:$/i,
  /^The audit log records all data sent to and received from the Cortex API, stored locally for inspection\.$/i,
  /^- Status:\s*(?:\*\*)?(?:on|off)(?:\*\*)?$/i,
  /^- Config default:\s*(?:on|off)$/i,
  /^- Log path:\s*`?.*\/\.cortex\/audit\/`?$/i,
  /^Log path:\s*`?.*\/\.cortex\/audit\/`?$/i,
  /^`?.*\/\.cortex\/audit\/`?$/i,
  /^Turn off with\s+`?\/audit off`?(?:\. Log files are preserved when disabled\.|\.)?$/i,
  /^Toggle:\s*`?\/audit on`?\s*[·-]\s*`?\/audit off`?$/i,
  /^\*\*Cortex Audit Log\*\*\s+Toggle:\s*`?\/audit on`?\s*[·-]\s*`?\/audit off`?$/i,
];

function isAuditStatusBoilerplate(content: string): boolean {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return false;
  if (lines.length === 1) return AUDIT_STATUS_LINE_PATTERNS.some((pattern) => pattern.test(lines[0]));
  return lines.every((line) => AUDIT_STATUS_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

/**
 * Strip OpenClaw runtime metadata wrappers injected by the Telegram/messaging
 * integration. These blocks carry message IDs, sender info, and timestamps that
 * pollute both capture (junk memories) and recall (degraded semantic search).
 *
 * Pattern: `<Label> (untrusted metadata):\n```json\n{...}\n```\n`
 */
const OPTIONAL_TIMESTAMP_PREFIX_RE = String.raw`(?:\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[A-Z]{2,6}\]\s*)?`;
const RUNTIME_METADATA_RE = new RegExp(
  "^\\s*" + OPTIONAL_TIMESTAMP_PREFIX_RE + "[\\w ]+\\(untrusted metadata\\):\\s*```json\\s*\\{[\\s\\S]*?\\}\\s*```[ \\t]*",
  "i",
);
const GENERIC_METADATA_FENCE_RE = new RegExp(
  "^\\s*" + OPTIONAL_TIMESTAMP_PREFIX_RE + "(?:conversation info|sender|chat info|thread info|message info|context info):\\s*```json\\s*\\{[\\s\\S]*?\\}\\s*```[ \\t]*",
  "i",
);
const INJECTED_CORTEX_BLOCK_RE = /^\s*<(?:cortex_memories|cortex_recovery)>[\s\S]*?<\/(?:cortex_memories|cortex_recovery)>\s*/i;
const SOURCE_RECEIPT_BLOCK_RE = /^\s*\[Source Receipt\][\s\S]*?\[\/Source Receipt\]\s*/i;
const BLOCK_WRAPPER_START_RE = /^\[(replying to|quoting)\b[^\]]*\]$/i;
const BLOCK_WRAPPER_END_RE = /^\[\/(replying|quoting)\]$/i;
const CHANNEL_ENVELOPE_RE = String.raw`(?:telegram|whatsapp|signal|discord|slack|email|sms)\s+(?:group(?:\s+chat)?|dm|direct message|private chat|thread|channel|server|workspace|conversation|message|chat)\b`;
const PLAINTEXT_METADATA_LINE_RE = new RegExp(
  String.raw`^\[(?:forwarded from|replying to|/replying|quoting|/quoting|id:[^\]]*chat:[^\]]*|id:[^\]]*|${CHANNEL_ENVELOPE_RE})[^\]]*\]$`,
  "i",
);
const PLAINTEXT_METADATA_PREFIX_RE = new RegExp(
  String.raw`^\[(?:forwarded from|replying to|quoting|id:[^\]]*chat:[^\]]*|id:[^\]]*|${CHANNEL_ENVELOPE_RE})[^\]]*\]\s*`,
  "i",
);
const SLACK_DM_SYSTEM_LINE_RE = /^System:\s*\[[^\]]+\]\s*Slack DM from [^:\n]{1,120}:\s*(.*)$/i;

function stripLeadingPattern(text: string, pattern: RegExp): string {
  let current = text;
  while (pattern.test(current)) {
    current = current.replace(pattern, "");
  }
  return current;
}

export function stripRuntimeMetadata(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return stripLeadingPattern(
    stripLeadingPattern(normalized, RUNTIME_METADATA_RE),
    GENERIC_METADATA_FENCE_RE,
  ).trim();
}

/**
 * Strip plugin-injected Cortex context blocks so only literal user/assistant text
 * is used for recall queries, capture payloads, and recovery summaries.
 */
export function stripInjectedCortexBlocks(text: string): string {
  return stripLeadingPattern(
    stripLeadingPattern(text, INJECTED_CORTEX_BLOCK_RE),
    SOURCE_RECEIPT_BLOCK_RE,
  ).trim();
}

export function stripPlaintextMetadataArtifacts(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let activeBlock: "replying" | "quoting" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (!activeBlock) cleaned.push("");
      continue;
    }

    if (activeBlock) {
      if (BLOCK_WRAPPER_END_RE.test(line)) activeBlock = null;
      continue;
    }

    const blockStart = BLOCK_WRAPPER_START_RE.exec(line);
    if (blockStart) {
      activeBlock = /^replying/i.test(blockStart[1]) ? "replying" : "quoting";
      continue;
    }

    if (PLAINTEXT_METADATA_LINE_RE.test(line)) continue;

    const strippedPrefix = rawLine.replace(PLAINTEXT_METADATA_PREFIX_RE, "").trim();
    if (!strippedPrefix) continue;
    cleaned.push(strippedPrefix);
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractSlackDmEnvelopeBody(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const header = SLACK_DM_SYSTEM_LINE_RE.exec(lines[0]?.trim() ?? "");
  if (!header) return text;

  const headerBody = header[1]?.trim() ?? "";
  const bodyAfterMetadata = stripPlaintextMetadataArtifacts(stripRuntimeMetadata(lines.slice(1).join("\n"))).trim();
  return bodyAfterMetadata || headerBody;
}

export function sanitizeConversationText(text: string): string {
  return stripPlaintextMetadataArtifacts(
    stripRuntimeMetadata(
      extractSlackDmEnvelopeBody(stripInjectedCortexBlocks(text)),
    ),
  ).trim();
}

/**
 * Patterns that match volatile/transient state — facts likely to go stale
 * quickly and pollute long-term memory when auto-captured.
 *
 * These are applied per-sentence within message content. Unlike LOW_SIGNAL_PATTERNS
 * (which reject entire messages), volatile patterns strip individual sentences
 * from otherwise valuable messages before they reach the capture pipeline.
 */
const VOLATILE_STATE_PATTERNS: RegExp[] = [
  // Version/release statements: "version 2.5.0", "v3.1.2", "running node 20.11"
  /\b(?:version|v)\s*\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/i,
  /\brunning (?:node|python|ruby|go|java|php|deno|bun)\s*\d+/i,

  // Task/progress status: "task X is in progress", "currently working on", "is done/complete"
  /\b(?:task|ticket|issue|PR|pull request)\s+\S+\s+(?:is|are|was)\s+(?:in[- ]progress|pending|blocked|done|complete|finished|closed|merged)\b/i,
  /\bcurrently (?:working on|building|debugging|investigating|deploying|testing|fixing|running|implementing)\b/i,
  /\b(?:is|are) currently (?:running|deploying|building|testing|failing|passing)\b/i,

  // Ephemeral runtime state: ports, PIDs, active connections
  /\b(?:running|listening|serving) (?:on|at) (?:port|:)\s*\d{2,5}\b/i,
  /\bPID\s*(?:is\s*)?\d+\b/i,

  // Temporal markers that signal snapshot-in-time facts
  /\b(?:right now|at the moment|at this point|as of (?:now|today)|for now)\b/i,

  // Deploy/build status that changes frequently
  /\b(?:deploy(?:ment)?|build|pipeline|CI)\s+(?:is|are|was)\s+(?:running|in[- ]progress|queued|pending|failing|passing|green|red)\b/i,
];

/**
 * Returns true if a sentence is primarily a volatile/transient state assertion.
 * Only matches when the volatile pattern dominates the sentence (short sentences
 * or sentences where the volatile content is the main claim).
 */
export function isVolatileStatement(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (!trimmed || trimmed.length > 300) return false;
  return VOLATILE_STATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Strips volatile/transient sentences from message content while preserving
 * durable facts. Operates on sentence boundaries (split by period, newline,
 * or semicolon). Returns the cleaned text, or the original if nothing was stripped.
 */
export function stripVolatileStatements(text: string): string {
  // Split on sentence boundaries: newlines, periods followed by space/end, semicolons
  const sentences = text.split(/(?<=\.)\s+|\n+|(?<=;)\s*/);
  const kept = sentences.filter((sentence) => !isVolatileStatement(sentence));

  if (kept.length === sentences.length) return text; // nothing stripped
  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || text; // never return empty — preserve original if all sentences matched
}

/** Returns true if the content matches a known low-signal pattern. */
export function isLowSignal(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (isAuditStatusBoilerplate(trimmed)) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Filters out messages whose content is entirely low-signal noise. */
export function filterLowSignalMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((m) => !isLowSignal(m.content));
}

/**
 * Strips volatile/transient statements from message content within a conversation.
 * Unlike filterLowSignalMessages (which drops entire messages), this preserves
 * messages but removes individual volatile sentences from their content.
 */
export function stripVolatileContent(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((m) => ({
    ...m,
    content: stripVolatileStatements(m.content),
  }));
}

/** Filters out low-signal lines from a text block, returning the cleaned text. */
export function filterLowSignalLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isLowSignal(line))
    .join("\n");
}
