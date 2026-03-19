import type { CortexClient } from "../../cortex/client.js";
import type { CortexConfig } from "../../plugin/config.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { sanitizeConversationText } from "../capture/filter.js";
import { filterConversationMessagesForMemory } from "../../internal/message-provenance.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

interface CommandContext {
  args?: string;
}

const MAX_SUMMARY_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 500;
const MIN_SUMMARY_MESSAGE_CHARS = 20;
const LEADING_TIMESTAMP_RE = /^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[A-Z]{2,6}\]\s*/;
const COMMAND_RE = /^\/[\w-]+(?:\s|$)/;
const INLINE_CORTEX_BLOCK_RE = /<cortex_(?:memories|recovery)>[\s\S]*?<\/cortex_(?:memories|recovery)>/gi;

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block): string => {
        if (typeof block !== "object" || block === null) return "";
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeSummaryCandidate(text: string): string {
  return text
    .replace(INLINE_CORTEX_BLOCK_RE, " ")
    .replace(LEADING_TIMESTAMP_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSummaryFromMessages(messages: unknown[]): string | null {
  const candidates = filterConversationMessagesForMemory(
    messages.filter(
      (msg): msg is { role: string; content: unknown; provenance?: unknown } =>
        typeof msg === "object" &&
        msg !== null &&
        "role" in msg &&
        "content" in msg &&
        (msg as Record<string, unknown>).role === "user",
    ),
  );

  if (candidates.length === 0) return null;

  const seen = new Set<string>();
  const bullets: string[] = [];

  for (let i = candidates.length - 1; i >= 0 && bullets.length < MAX_SUMMARY_MESSAGES; i--) {
    const raw = extractContent(candidates[i].content);
    const sanitized = sanitizeConversationText(raw);
    const normalized = normalizeSummaryCandidate(sanitized);
    if (!normalized || normalized.length < MIN_SUMMARY_MESSAGE_CHARS) continue;
    if (COMMAND_RE.test(normalized)) continue;

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const truncated = normalized.length > MAX_MESSAGE_CHARS
      ? normalized.slice(0, MAX_MESSAGE_CHARS) + "…"
      : normalized;
    bullets.push(`- ${truncated}`);
  }

  bullets.reverse();

  if (bullets.length === 0) return null;
  return bullets.join("\n");
}

export function createCheckpointHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  getUserId: () => string | undefined,
  userIdReady: Promise<void>,
  getLastMessages: () => unknown[],
  pluginSessionId?: string,
  auditLogger?: AuditLogger,
): (ctx: CommandContext) => Promise<{ text: string }> {
  return async (ctx) => {
    try {
      await userIdReady;

      let summary: string;

      if (ctx.args?.trim()) {
        summary = ctx.args.trim();
      } else {
        const messages = getLastMessages();
        const extracted = buildSummaryFromMessages(messages);
        if (!extracted) {
          return {
            text: [
              `**No session context to checkpoint.**`,
              ``,
              `There are no recent messages to summarize. You can provide your own summary:`,
              `\`/checkpoint working on auth refactor\``,
            ].join("\n"),
          };
        }
        summary = extracted;
      }

      const text = `[SESSION CHECKPOINT] ${summary}`;
      const userId = getUserId();
      if (!userId) {
        logger.warn("Cortex checkpoint: missing user_id");
        return { text: "Checkpoint failed: Cortex ingest requires user_id." };
      }
      const referenceDate = new Date().toISOString().slice(0, 10);

      logger.info(`Cortex checkpoint: saving (${text.length} chars)`);

      if (auditLogger) {
        void auditLogger.log({
          feature: "command-checkpoint",
          method: "POST",
          endpoint: "/v1/remember",
          payload: text,
          sessionId: pluginSessionId,
          userId,
        });
      }

      await client.remember(
        text,
        pluginSessionId,
        config.toolTimeoutMs,
        referenceDate,
        userId,
        "openclaw",
        "OpenClaw",
      );

      logger.info("Cortex checkpoint: saved");
      return {
        text: [
          `**Checkpoint saved.**`,
          ``,
          `A summary of your current session has been stored in Cortex.`,
          `When you start a new session, this context will be available for recall.`,
          ``,
          `You can now safely run \`/sleep\` or reset with \`/new\`.`,
        ].join("\n"),
      };
    } catch (err) {
      logger.warn(`Cortex checkpoint failed: ${String(err)}`);
      return { text: `Checkpoint failed: ${String(err)}` };
    }
  };
}
