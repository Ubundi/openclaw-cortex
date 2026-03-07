import type { CortexClient } from "../../cortex/client.js";
import type { CortexConfig } from "../../plugin/config.js";
import type { AuditLogger } from "../../internal/audit-logger.js";

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

function buildSummaryFromMessages(messages: unknown[]): string | null {
  const userMessages = messages
    .filter(
      (msg): msg is { role: string; content: unknown } =>
        typeof msg === "object" &&
        msg !== null &&
        "role" in msg &&
        (msg as Record<string, unknown>).role === "user",
    )
    .slice(-MAX_SUMMARY_MESSAGES);

  if (userMessages.length === 0) return null;

  const bullets = userMessages
    .map((msg) => {
      const text = extractContent(msg.content).trim();
      const truncated = text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) + "…" : text;
      return `- ${truncated}`;
    })
    .filter((b) => b.length > 2);

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
