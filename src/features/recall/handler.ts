import type { CortexClient } from "../../adapters/cortex/client.js";
import type { CortexConfig } from "../../plugin/config/schema.js";
import type { KnowledgeState } from "../../plugin/index.js";
import { formatMemories } from "./formatter.js";
import { LatencyMetrics } from "../../internal/metrics/latency-metrics.js";

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

/**
 * Derives an effective recall timeout that respects the server's adaptive pipeline tiers.
 * Higher tiers run heavier pipelines (reranking, graph traversal) that need more time.
 */
export function deriveEffectiveTimeout(configuredMs: number, totalSessions: number): number {
  if (totalSessions >= 30) return Math.max(configuredMs, 2000); // Tier 3
  if (totalSessions >= 15) return Math.max(configuredMs, 1500); // Tier 2
  return configuredMs; // Tier 1
}

export function createRecallHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  metrics?: LatencyMetrics,
  knowledgeState?: KnowledgeState,
) {
  const recallMetrics = metrics ?? new LatencyMetrics();
  let consecutiveFailures = 0;
  let coldStartUntil = 0;

  const handler = async (
    event: BeforeAgentStartEvent,
    _ctx: AgentContext,
  ): Promise<BeforeAgentStartResult | void> => {
    if (!config.autoRecall) return;

    // Skip recall when we know there are no memories yet
    if (knowledgeState && !knowledgeState.hasMemories) {
      logger.debug?.("Cortex recall: skipped (no memories yet)");
      return;
    }

    const prompt = event.prompt?.trim();
    if (!prompt || prompt.length < 5) return;

    // Cold-start gate: skip recall while service is warming
    if (coldStartUntil > Date.now()) {
      logger.debug?.("Cortex recall: skipped (cold-start cooldown)");
      return;
    }

    const start = Date.now();

    const effectiveTimeout = knowledgeState
      ? deriveEffectiveTimeout(config.recallTimeoutMs, knowledgeState.totalSessions)
      : config.recallTimeoutMs;

    try {
      const response = await client.recall(
        prompt,
        effectiveTimeout,
        { limit: config.recallLimit },
      );

      const elapsed = Date.now() - start;
      recallMetrics.record(elapsed);
      consecutiveFailures = 0; // reset on success

      if (!response.memories?.length) return;

      const formatted = formatMemories(response.memories);
      if (!formatted) return;

      logger.debug?.(
        `Cortex recall: ${response.memories.length} memories in ${elapsed}ms`,
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
