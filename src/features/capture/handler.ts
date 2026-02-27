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

/** How often (in captures) to re-probe /v1/knowledge for tier changes */
const KNOWLEDGE_REFRESH_EVERY_N = 5;
/** Minimum interval between knowledge refreshes */
const KNOWLEDGE_REFRESH_MIN_INTERVAL_MS = 5 * 60_000; // 5 minutes

export function createCaptureHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  retryQueue?: RetryQueue,
  knowledgeState?: KnowledgeState,
  getUserId?: () => string | undefined,
  userIdReady?: Promise<void>,
) {
  let captureCounter = 0;
  let lastCapturedAt = 0;
  let capturesSinceRefresh = 0;

  return async (event: AgentEndEvent): Promise<void> => {
    logger.info("Cortex capture: hook fired");

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
        logger.info("Cortex capture: skipping — not enough substantive content");
        return;
      }

      // API caps at 200 messages — take the most recent to stay within the limit
      const MAX_MESSAGES = 200;
      const trimmed = normalized.length > MAX_MESSAGES ? normalized.slice(-MAX_MESSAGES) : normalized;

      // Advance watermark before async work so a second turn doesn't re-send this delta
      lastCapturedAt = event.messages.length;

      // Ensure userId is resolved before sending — in practice this resolves in <100ms
      // at startup, well before agent_end fires, but we await explicitly to be correct.
      if (userIdReady) await userIdReady;

      const sessionId = event.sessionKey ?? event.sessionId;

      const doRemember = async () => {
        // Re-evaluate userId at call time so retries pick up the resolved value
        const userId = getUserId?.();
        const res = await client.rememberConversation(trimmed, sessionId, undefined, undefined, userId);
        logger.info(`Cortex capture: remembered ${res.memories_created} memories`);
        if (knowledgeState && res.memories_created > 0) {
          knowledgeState.hasMemories = true;
        }

        // Periodically refresh knowledge state so totalSessions (and thus
        // the tier / effective timeout) stays current as memories accumulate.
        if (knowledgeState) {
          capturesSinceRefresh++;
          const elapsed = Date.now() - knowledgeState.lastChecked;
          if (
            capturesSinceRefresh >= KNOWLEDGE_REFRESH_EVERY_N &&
            elapsed >= KNOWLEDGE_REFRESH_MIN_INTERVAL_MS
          ) {
            capturesSinceRefresh = 0;
            try {
              const knowledge = await client.knowledge(undefined, userId);
              const prevSessions = knowledgeState.totalSessions;
              knowledgeState.totalSessions = knowledge.total_sessions;
              knowledgeState.maturity = knowledge.maturity;
              knowledgeState.lastChecked = Date.now();
              if (knowledge.total_sessions !== prevSessions) {
                logger.info(
                  `Cortex knowledge refreshed: sessions ${prevSessions} → ${knowledge.total_sessions}`,
                );
              }
            } catch {
              logger.debug?.("Cortex knowledge refresh failed, will retry later");
            }
          }
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
