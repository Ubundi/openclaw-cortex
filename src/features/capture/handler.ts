import type { CortexClient, ConversationMessage } from "../../adapters/cortex/client.js";
import type { CortexConfig } from "../../plugin/config/schema.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { RetryQueue } from "../../internal/queue/retry-queue.js";

interface AgentEndEvent {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  messages: unknown[];
  aborted: boolean;
  error?: string;
  usageTotals?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  };
}

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const MIN_CONTENT_LENGTH = 20;

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block): string => {
        if (typeof block !== "object" || block === null) return "";
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "tool_result") return extractContent(b.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isWorthCapturing(messages: ConversationMessage[]): boolean {
  const hasUser = messages.some((m) => m.role === "user" && m.content.length > MIN_CONTENT_LENGTH);
  const hasSubstantiveResponse = messages.some(
    (m) => (m.role === "assistant" || m.role === "tool") && m.content.length > MIN_CONTENT_LENGTH,
  );
  return hasUser && hasSubstantiveResponse;
}

export function createCaptureHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  retryQueue?: RetryQueue,
  knowledgeState?: KnowledgeState,
  getUserId?: () => string | undefined,
) {
  let captureCounter = 0;
  let lastCapturedAt = 0;

  return async (event: AgentEndEvent): Promise<void> => {
    if (!config.autoCapture) return;
    if (event.aborted) return;
    if (!event.messages?.length) return;

    try {
      const delta = event.messages.slice(lastCapturedAt);

      const normalized: ConversationMessage[] = delta
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

      // Advance watermark before async work so a second turn doesn't re-send this delta
      lastCapturedAt = event.messages.length;

      const sessionId = event.sessionKey ?? event.sessionId;
      const userId = getUserId?.();

      const doRemember = async () => {
        const res = await client.rememberConversation(normalized, sessionId, undefined, undefined, userId);
        logger.debug?.(`Cortex capture: remembered ${res.memories_created} memories`);
        if (knowledgeState && res.memories_created > 0) {
          knowledgeState.hasMemories = true;
        }
      };

      // Fire-and-forget with retry on failure
      doRemember().catch((err) => {
        logger.warn(`Cortex capture failed, queuing for retry: ${String(err)}`);
        if (retryQueue) {
          retryQueue.enqueue(doRemember, `capture-${++captureCounter}`);
        }
      });
    } catch (err) {
      logger.warn(`Cortex capture error: ${String(err)}`);
    }
  };
}
