import type { CortexClient, ConversationMessage } from "../client.js";
import type { CortexConfig } from "../config.js";
import type { RetryQueue } from "../utils/retry-queue.js";

interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const MIN_CONTENT_LENGTH = 20;
const RECENT_MESSAGES_COUNT = 20;

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block,
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function isWorthCapturing(messages: ConversationMessage[]): boolean {
  const hasUser = messages.some((m) => m.role === "user" && m.content.length > MIN_CONTENT_LENGTH);
  const hasAssistant = messages.some(
    (m) => m.role === "assistant" && m.content.length > MIN_CONTENT_LENGTH,
  );
  return hasUser && hasAssistant;
}

export function createCaptureHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  retryQueue?: RetryQueue,
) {
  let captureCounter = 0;

  return async (event: AgentEndEvent, ctx: AgentContext): Promise<void> => {
    if (!config.autoCapture) return;
    if (!event.success) return;
    if (!event.messages?.length) return;

    try {
      const recent = event.messages.slice(-RECENT_MESSAGES_COUNT);

      const normalized: ConversationMessage[] = recent
        .filter(
          (msg): msg is { role: string; content: unknown } =>
            typeof msg === "object" &&
            msg !== null &&
            "role" in msg &&
            "content" in msg,
        )
        .map((msg) => ({
          role: String(msg.role),
          content: extractContent(msg.content),
        }))
        .filter((msg) => msg.content.length > 0);

      if (!isWorthCapturing(normalized)) {
        logger.debug?.("Cortex capture: skipping — not enough substantive content");
        return;
      }

      const sessionId = ctx.sessionKey ?? ctx.sessionId;

      const doIngest = async () => {
        const res = await client.ingestConversation(normalized, sessionId);
        logger.debug?.(
          `Cortex capture: ingested ${res.facts.length} facts, ${res.entities.length} entities (${res.nodes_created} nodes)`,
        );
      };

      // Fire-and-forget with retry on failure
      doIngest().catch((err) => {
        logger.warn(`Cortex capture failed, queuing for retry: ${String(err)}`);
        if (retryQueue) {
          retryQueue.enqueue(doIngest, `capture-${++captureCounter}`);
        }
      });
    } catch (err) {
      logger.warn(`Cortex capture error: ${String(err)}`);
    }
  };
}
