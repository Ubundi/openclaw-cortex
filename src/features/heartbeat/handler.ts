import type { CortexClient } from "../../cortex/client.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { RetryQueue } from "../../internal/retry-queue.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/** Minimum interval between knowledge refreshes triggered by heartbeat */
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Minimum interval between reflect calls — consolidation is expensive */
const MIN_REFLECT_INTERVAL_MS = 15 * 60_000; // 15 minutes

export function createHeartbeatHandler(
  client: CortexClient,
  logger: Logger,
  knowledgeState: KnowledgeState,
  retryQueue: RetryQueue,
  getUserId: () => string | undefined,
): () => Promise<void> {
  let refreshing = false;
  let lastReflectAt = 0;

  return async () => {
    // Log retry queue status on each heartbeat for observability
    const pending = retryQueue.pending;
    if (pending > 0) {
      logger.info(`Cortex heartbeat: ${pending} retry task(s) pending`);
    }

    // Throttle knowledge refreshes to avoid hammering the API
    const elapsed = Date.now() - knowledgeState.lastChecked;
    if (elapsed < MIN_REFRESH_INTERVAL_MS) return;

    // Prevent concurrent refreshes if heartbeats overlap
    if (refreshing) return;
    refreshing = true;

    try {
      const userId = getUserId();
      const [knowledge, stats] = await Promise.allSettled([
        client.knowledge(undefined, userId),
        client.stats(undefined, userId),
      ]);

      if (knowledge.status === "fulfilled") {
        const prev = {
          sessions: knowledgeState.totalSessions,
          maturity: knowledgeState.maturity,
        };
        knowledgeState.hasMemories = knowledge.value.total_memories > 0;
        knowledgeState.totalSessions = knowledge.value.total_sessions;
        knowledgeState.maturity = knowledge.value.maturity;
        knowledgeState.lastChecked = Date.now();

        if (
          knowledge.value.total_sessions !== prev.sessions ||
          knowledge.value.maturity !== prev.maturity
        ) {
          logger.info(
            `Cortex heartbeat: sessions ${prev.sessions} → ${knowledge.value.total_sessions}, maturity ${prev.maturity} → ${knowledge.value.maturity}`,
          );
        }
      }

      if (stats.status === "fulfilled") {
        knowledgeState.pipelineTier = stats.value.pipeline_tier;
      }

      // Periodically trigger reflect to consolidate the knowledge graph.
      // Reflect deduplicates entities, infers relationships, and strengthens
      // connections — improving recall quality over time.
      if (knowledgeState.hasMemories && Date.now() - lastReflectAt >= MIN_REFLECT_INTERVAL_MS) {
        lastReflectAt = Date.now();
        client.reflect().then(
          (result) => {
            logger.info(
              `Cortex reflect: job ${result.job_id} submitted (status=${result.status})`,
            );
          },
          () => {
            logger.debug?.("Cortex heartbeat: reflect failed");
          },
        );
      }
    } catch {
      logger.debug?.("Cortex heartbeat: knowledge refresh failed");
    } finally {
      refreshing = false;
    }
  };
}
