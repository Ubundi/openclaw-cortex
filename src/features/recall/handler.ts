import type { CortexClient } from "../../cortex/client.js";
import type { CortexConfig } from "../../core/config/schema.js";
import { formatMemories } from "./formatter.js";
import { LatencyMetrics } from "../../shared/metrics/latency-metrics.js";

interface BeforeAgentStartEvent {
  prompt: string;
  messages?: unknown[];
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}

interface BeforeAgentStartResult {
  prependContext?: string;
}

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/**
 * Cold-start detection: if the first N requests all timeout or fail,
 * assume the ECS task is cold and disable recall temporarily.
 * Re-enable after a cooldown period.
 */
const COLD_START_WINDOW = 3; // consecutive failures to trigger cold-start
const COLD_START_COOLDOWN_MS = 30_000; // wait 30s before retrying

export function createRecallHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  metrics?: LatencyMetrics,
) {
  const recallMetrics = metrics ?? new LatencyMetrics();
  let consecutiveFailures = 0;
  let coldStartUntil = 0;

  const handler = async (
    event: BeforeAgentStartEvent,
    _ctx: AgentContext,
  ): Promise<BeforeAgentStartResult | void> => {
    if (!config.autoRecall) return;

    const prompt = event.prompt?.trim();
    if (!prompt || prompt.length < 5) return;

    // Cold-start gate: skip recall while service is warming
    if (coldStartUntil > Date.now()) {
      logger.debug?.("Cortex recall: skipped (cold-start cooldown)");
      return;
    }

    const start = Date.now();

    try {
      // recallMode maps to Cortex API mode parameter:
      // "fast" = BM25 + semantic only (~80-150ms server-side)
      // "balanced" = adds light reranking (~150-300ms)
      // "full" = adds graph traversal + full reranker (~300-600ms)
      const apiMode = config.recallMode === "balanced" ? "fast" : config.recallMode;
      const response = await client.retrieve(
        prompt,
        config.recallTopK,
        apiMode as "fast" | "full",
        config.recallTimeoutMs,
      );

      const elapsed = Date.now() - start;
      recallMetrics.record(elapsed);
      consecutiveFailures = 0; // reset on success

      if (!response.results?.length) return;

      const formatted = formatMemories(response.results);
      if (!formatted) return;

      logger.debug?.(
        `Cortex recall: ${response.results.length} memories in ${elapsed}ms`,
      );
      return { prependContext: formatted };
    } catch (err) {
      const elapsed = Date.now() - start;
      recallMetrics.record(elapsed);
      consecutiveFailures++;

      // Enter cold-start cooldown after consecutive failures
      if (consecutiveFailures >= COLD_START_WINDOW) {
        coldStartUntil = Date.now() + COLD_START_COOLDOWN_MS;
        logger.warn(
          `Cortex recall: ${consecutiveFailures} consecutive failures, disabling for ${COLD_START_COOLDOWN_MS / 1000}s`,
        );
        consecutiveFailures = 0;
      }

      // Silent degradation — proceed without memories
      if ((err as Error).name === "AbortError") {
        logger.debug?.("Cortex recall timed out, proceeding without memories");
      } else {
        logger.warn(`Cortex recall failed: ${String(err)}`);
      }
      return;
    }
  };

  // Expose metrics for observability
  handler.metrics = recallMetrics;
  return handler;
}
