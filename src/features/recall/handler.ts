import type { CortexClient } from "../../adapters/cortex/client.js";
import type { CortexConfig } from "../../plugin/config/schema.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { AuditLogger } from "../../internal/audit/audit-logger.js";
import { formatMemories } from "./formatter.js";
import { inferRecallProfile, getProfileParams } from "./context-profile.js";
import type { RecallProfile } from "./context-profile.js";
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

/** Strip injected recall block so prior recalls don't pollute future recall queries. */
const RECALL_BLOCK_RE = /\s*<cortex_memories>[\s\S]*?<\/cortex_memories>\s*/g;

function stripRecallBlock(text: string): string {
  return text.replace(RECALL_BLOCK_RE, "\n").trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block): string => {
        if (typeof block === "string") return block;
        if (typeof block !== "object" || block === null) return "";
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") return b.text;
        if ("content" in b) return extractText(b.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if ("content" in c) return extractText(c.content);
  }
  return "";
}

function getLatestUserQuery(messages: unknown[] | undefined): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (String(m.role) !== "user") continue;
    const text = stripRecallBlock(extractText(m.content));
    if (text) return text;
  }
  return undefined;
}

function selectRecallQuery(event: BeforeAgentStartEvent): { source: "messages" | "prompt"; query: string } {
  const fromMessages = getLatestUserQuery(event.messages);
  if (fromMessages) return { source: "messages", query: fromMessages };

  const fromPrompt = stripRecallBlock(event.prompt ?? "");
  return { source: "prompt", query: fromPrompt };
}

/**
 * Derives an effective recall timeout that respects the server's adaptive pipeline tiers.
 * Higher tiers run heavier pipelines (reranking, graph traversal) that need more time.
 * The pipeline tier is fetched from the Cortex `/v1/stats` endpoint and cached.
 *
 * Tier 1: flat retrieval — use the configured timeout as-is.
 * Tier 2: reranking — multiply by 1.5× (minimum 12s).
 * Tier 3: graph traversal + reranking — multiply by 2× (minimum 20s).
 */
export function deriveEffectiveTimeout(configuredMs: number, pipelineTier: 1 | 2 | 3): number {
  if (pipelineTier >= 3) return Math.max(configuredMs * 2, 20_000);
  if (pipelineTier >= 2) return Math.max(configuredMs * 1.5, 12_000);
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

    const { source: querySource, query: selectedQuery } = selectRecallQuery(event);
    const rawPrompt = selectedQuery.trim();
    if (!rawPrompt || rawPrompt.length < 5) return;

    // Cortex API rejects queries longer than 2 000 chars (422).
    // Subagent prompts routinely exceed this — truncate to the limit.
    const prompt = rawPrompt.length > MAX_QUERY_LENGTH
      ? rawPrompt.slice(0, MAX_QUERY_LENGTH)
      : rawPrompt;
    logger.debug?.(`Cortex recall: query_source=${querySource}, query_len=${prompt.length}`);

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

      // Infer recall profile from prompt (or use static config override)
      const profile: RecallProfile = config.recallProfile === "auto"
        ? inferRecallProfile(prompt)
        : config.recallProfile as RecallProfile;
      const profileParams = getProfileParams(profile, config);
      logger.debug?.(`Cortex recall: profile=${profile}`);

      const recallOptions = {
        limit: profileParams.limit,
        userId: currentUserId,
        queryType: profileParams.queryType,
        context: profileParams.context,
        minConfidence: profileParams.minConfidence,
      };

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
        response = await client.recall(prompt, effectiveTimeout, recallOptions);
      } catch (retryErr) {
        // Single retry on transient 502/503 gateway errors
        if (/50[23]/.test(String(retryErr))) {
          await new Promise((r) => setTimeout(r, 1000));
          response = await client.recall(prompt, effectiveTimeout, recallOptions);
        } else {
          throw retryErr;
        }
      }

      const elapsed = Date.now() - start;
      recallMetrics.record(elapsed);
      consecutiveFailures = 0; // reset on success

      if (!response.memories?.length) return;

      const formatted = formatMemories(response.memories, config.recallTopK);
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

      // Silent degradation — proceed without memories.
      // Timeouts indicate a slow-but-running service, not a dead one —
      // don't count them toward the cold-start gate.
      if ((err as Error).name === "AbortError") {
        logger.debug?.("Cortex recall timed out, proceeding without memories");
        consecutiveFailures = Math.max(consecutiveFailures - 1, 0); // undo the increment above
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
