import type { CortexClient, ConversationMessage } from "../../adapters/cortex/client.js";
import type { CortexConfig } from "../../plugin/config/schema.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { RetryQueue } from "../../internal/queue/retry-queue.js";
import type { AuditLogger } from "../../internal/audit/audit-logger.js";
import { filterLowSignalMessages } from "./filter.js";

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

const MIN_CONTENT_LENGTH = 50;

/** Strip injected recall block so we don't re-ingest recalled memories as new content */
const RECALL_BLOCK_RE = /\s*<cortex_memories>[\s\S]*?<\/cortex_memories>\s*/g;

function stripRecallBlock(text: string): string {
  return text.replace(RECALL_BLOCK_RE, "").trim();
}

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
  pluginSessionId?: string,
  auditLogger?: AuditLogger,
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
          content: stripRecallBlock(extractContent(msg.content)),
        }))
        .filter((msg) => msg.content.length > 0);

      // Drop low-signal messages (heartbeats, status lines, TUI artifacts)
      const filtered = config.captureFilter !== false
        ? filterLowSignalMessages(normalized)
        : normalized;

      if (!isWorthCapturing(filtered)) {
        logger.info("Cortex capture: skipping — not enough substantive content");
        return;
      }

      // API caps at 200 messages — take the most recent to stay within the limit
      const MAX_MESSAGES = 200;
      const trimmed = filtered.length > MAX_MESSAGES ? filtered.slice(-MAX_MESSAGES) : filtered;

      // Enforce byte-size cap — drop oldest messages until the transcript fits.
      // This prevents oversized payloads from pasted files or long tool outputs.
      const maxBytes = config.captureMaxPayloadBytes ?? 262_144;
      while (trimmed.length > 2) {
        const estimatedSize = trimmed.reduce((sum, m) => sum + Buffer.byteLength(m.role, "utf-8") + 2 + Buffer.byteLength(m.content, "utf-8") + 2, 0);
        if (estimatedSize <= maxBytes) break;
        trimmed.shift();
      }

      const totalChars = trimmed.reduce((sum, m) => sum + m.content.length, 0);
      logger.info(`Cortex capture: ${trimmed.length} messages, ${totalChars} chars`);

      // Advance watermark before async work so a second turn doesn't re-send this delta
      lastCapturedAt = event.messages.length;

      // Ensure userId is resolved before sending — in practice this resolves in <100ms
      // at startup, well before agent_end fires, but we await explicitly to be correct.
      if (userIdReady) await userIdReady;

      const sessionId = event.sessionKey ?? event.sessionId ?? pluginSessionId;
      logger.debug?.(`Cortex capture: sessionId=${sessionId}, userId=${getUserId?.()}`);

      // Flatten messages into a role: content transcript for ingestion
      const transcript = trimmed
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n\n");

      // Log a summary of what's being sent
      const roleCounts: Record<string, number> = {};
      for (const m of trimmed) {
        roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
      }
      const roleBreakdown = Object.entries(roleCounts).map(([r, n]) => `${r}=${n}`).join(", ");
      const preview = (transcript.length > 200 ? transcript.slice(0, 200) + "…" : transcript).replace(/\n/g, " ");
      logger.info(`Cortex capture summary: ${trimmed.length} msgs (${roleBreakdown}), ${transcript.length} chars, sessionId=${sessionId}`);
      logger.info(`Cortex capture preview: ${preview}`);

      if (auditLogger) {
        void auditLogger.log({
          feature: "auto-capture",
          method: "POST",
          endpoint: "/v1/jobs/ingest",
          payload: transcript,
          sessionId,
          userId: getUserId?.(),
          messageCount: trimmed.length,
        });
      }

      const doRemember = async () => {
        // Re-evaluate userId at call time so retries pick up the resolved value
        const userId = getUserId?.();
        // Use async job endpoint — /v1/remember and /v1/ingest both 503 under
        // the Lambda proxy timeout when the RESONATE pipeline is slow.
        // /v1/jobs/ingest returns immediately and processes in the background.
        const job = await client.submitIngest(transcript, sessionId, new Date().toISOString(), userId);
        logger.info(`Cortex capture: submitted job ${job.job_id} (status=${job.status})`);
        if (knowledgeState) {
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
