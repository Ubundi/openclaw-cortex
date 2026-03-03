import type { CortexClient } from "../../adapters/cortex/client.js";
import type { CortexConfig } from "../../plugin/config/schema.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { AuditLogger } from "../../internal/audit/audit-logger.js";
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

/** Cortex API enforces a 2 000-char limit on the recall query field. */
const MAX_QUERY_LENGTH = 2000;

/**
 * When hasMemories is false, re-check the /knowledge endpoint after this
 * interval. Prevents the plugin from being permanently stuck when a different
 * plugin instance ingested memories or the initial check failed.
 */
const KNOWLEDGE_RECHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Derives an effective recall timeout that respects the server's adaptive pipeline tiers.
 * Higher tiers run heavier pipelines (reranking, graph traversal) that need more time.
 * The pipeline tier is fetched from the Cortex `/v1/stats` endpoint and cached.
 */
export function deriveEffectiveTimeout(configuredMs: number, pipelineTier: 1 | 2 | 3): number {
  if (pipelineTier >= 3) return Math.max(configuredMs, 2000);
  if (pipelineTier >= 2) return Math.max(configuredMs, 1500);
  return configuredMs;
}

export function createRecallHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  metrics?: LatencyMetrics,
  knowledgeState?: KnowledgeState,
  getUserId?: () => string | undefined,
  auditLogger?: AuditLogger,
) {
  const recallMetrics = metrics ?? new LatencyMetrics();
  let consecutiveFailures = 0;
  let coldStartUntil = 0;

  const handler = async (
    event: BeforeAgentStartEvent,
    _ctx: AgentContext,
  ): Promise<BeforeAgentStartResult | void> => {
    logger.info("Cortex recall: hook fired");

    if (!config.autoRecall) return;

    // Skip recall when we know there are no memories yet, but periodically
    // re-check in case another plugin instance ingested memories or the
    // initial /knowledge check failed at startup.
    if (knowledgeState && !knowledgeState.hasMemories) {
      const sinceLastCheck = Date.now() - knowledgeState.lastChecked;
      if (sinceLastCheck < KNOWLEDGE_RECHECK_INTERVAL_MS) {
        logger.info("Cortex recall: skipped (no memories yet)");
        return;
      }
      // Re-check knowledge state in the background (non-blocking)
      try {
        const userId = getUserId?.();
        const [knowledge, stats] = await Promise.all([
          client.knowledge(undefined, userId),
          client.stats(undefined, userId).catch(() => null),
        ]);
        knowledgeState.hasMemories = knowledge.total_memories > 0;
        knowledgeState.totalSessions = knowledge.total_sessions;
        knowledgeState.maturity = knowledge.maturity;
        if (stats) {
          knowledgeState.pipelineTier = stats.pipeline_tier;
        }
        knowledgeState.lastChecked = Date.now();
        if (!knowledgeState.hasMemories) {
          logger.info("Cortex recall: skipped (no memories yet)");
          return;
        }
        logger.debug?.(`Cortex recall: knowledge re-check found ${knowledge.total_memories} memories`);
      } catch {
        knowledgeState.lastChecked = Date.now();
        logger.info("Cortex recall: skipped (no memories yet)");
        return;
      }
    }

    const rawPrompt = event.prompt?.trim();
    if (!rawPrompt || rawPrompt.length < 5) return;

    // Cortex API rejects queries longer than 2 000 chars (422).
    // Subagent prompts routinely exceed this — truncate to the limit.
    const prompt = rawPrompt.length > MAX_QUERY_LENGTH
      ? rawPrompt.slice(0, MAX_QUERY_LENGTH)
      : rawPrompt;

    // Cold-start gate: skip recall while service is warming
    if (coldStartUntil > Date.now()) {
      logger.debug?.("Cortex recall: skipped (cold-start cooldown)");
      return;
    }

    const start = Date.now();

    const effectiveTimeout = knowledgeState
      ? deriveEffectiveTimeout(config.recallTimeoutMs, knowledgeState.pipelineTier)
      : config.recallTimeoutMs;

    try {
      const currentUserId = getUserId?.();

      if (auditLogger) {
        void auditLogger.log({
          feature: "auto-recall",
          method: "POST",
          endpoint: "/v1/recall",
          payload: prompt,
          userId: currentUserId,
        });
      }

      let response;
      try {
        response = await client.recall(
          prompt,
          effectiveTimeout,
          { limit: config.recallLimit, userId: currentUserId, queryType: "factual" },
        );
      } catch (retryErr) {
        // Single retry on transient 502/503 gateway errors
        if (/50[23]/.test(String(retryErr))) {
          await new Promise((r) => setTimeout(r, 1000));
          response = await client.recall(
            prompt,
            effectiveTimeout,
            { limit: config.recallLimit, userId: currentUserId, queryType: "factual" },
          );
        } else {
          throw retryErr;
        }
      }

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
