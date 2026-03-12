import type { CortexClient, RetrieveResult, RecallMemory } from "../../cortex/client.js";
import type { CortexConfig } from "../../plugin/config.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { formatMemoriesWithStats } from "./formatter.js";
import { inferRecallProfile, getProfileParams } from "./context-profile.js";
import type { RecallProfile, RecallProfileParams } from "./context-profile.js";
import { LatencyMetrics } from "../../internal/latency-metrics.js";
import { sanitizeConversationText, stripInjectedCortexBlocks } from "../capture/filter.js";
import type { RecallEchoStore } from "../../internal/recall-echo-store.js";
import { isHeartbeatTurn } from "../../internal/heartbeat-detect.js";
import {
  filterConversationMessagesForMemory,
  shouldUseUserMessageForMemory,
} from "../../internal/message-provenance.js";

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
const FALLBACK_RECALL_MIN_SCORE = 0.15;
const FALLBACK_RECALL_SCORE_WINDOW = 0.2;

/**
 * Parses a machine-readable [cortex-date: YYYY-MM-DD] marker from the start of
 * a query. The benchmark runner injects this into probe messages so the recall
 * handler can pass the correct reference_date to /v1/retrieve without requiring
 * any manual plugin configuration from the user.
 *
 * Returns the extracted ISO date string and the query with the marker stripped.
 */
const CORTEX_DATE_MARKER_RE = /^\[cortex-date:\s*([^\]]+)\]\s*/;

function extractReferenceDateMarker(raw: string): { embeddedDate: string | null; query: string } {
  const match = CORTEX_DATE_MARKER_RE.exec(raw);
  if (!match) return { embeddedDate: null, query: raw };
  return { embeddedDate: match[1].trim(), query: raw.slice(match[0].length).trim() };
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
    if (!shouldUseUserMessageForMemory(m)) continue;
    const text = sanitizeConversationText(extractText(m.content));
    if (text) return text;
  }
  return undefined;
}

function selectRecallQuery(event: BeforeAgentStartEvent): { source: "messages" | "prompt"; query: string } {
  const fromMessages = getLatestUserQuery(event.messages);
  if (fromMessages) return { source: "messages", query: fromMessages };

  const fromPrompt = stripInjectedCortexBlocks(event.prompt ?? "");
  return { source: "prompt", query: fromPrompt };
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildRecentConversationContext(
  messages: unknown[] | undefined,
  selectedQuery: string,
): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const lines: string[] = [];
  for (const msg of filterConversationMessagesForMemory(
    messages.filter((message): message is Record<string, unknown> => typeof message === "object" && message !== null),
  )) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "unknown";
    if (role === "system") continue;
    const text = sanitizeConversationText(extractText(m.content)).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }

  if (lines.length === 0) return undefined;

  // If we only have the latest user query, there's no extra context to add.
  if (lines.length === 1) {
    const only = lines[0];
    const normalizedOnly = normalizeForCompare(only.replace(/^user:\s*/i, ""));
    if (normalizedOnly === normalizeForCompare(selectedQuery)) return undefined;
  }

  const MAX_CONTEXT_LINES = 6;
  const MAX_CONTEXT_CHARS = 900;
  const recent = lines.slice(-MAX_CONTEXT_LINES).join("\n");
  return recent.length > MAX_CONTEXT_CHARS ? recent.slice(-MAX_CONTEXT_CHARS) : recent;
}

function mergeQueryAndContext(query: string, context: string | undefined): string {
  if (!context) return query;
  const cleaned = context.trim();
  if (!cleaned) return query;

  const separator = "\n\nContext:\n";
  const availableContextChars = MAX_QUERY_LENGTH - query.length - separator.length;
  if (availableContextChars <= 0) return query;

  const trimmedContext = cleaned.length > availableContextChars
    ? cleaned.slice(0, availableContextChars)
    : cleaned;
  return `${query}${separator}${trimmedContext}`;
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

export function mapRetrieveToRecallMemories(results: RetrieveResult[]): RecallMemory[] {
  return results.map((r): RecallMemory => ({
    content: r.content,
    confidence: r.confidence ?? r.score,
    relevance: r.score,
    when: r.metadata?.occurred_at ?? null,
    session_id: typeof r.metadata?.session_id === "string" ? r.metadata.session_id : null,
    entities: r.metadata?.entity_refs ?? [],
    type: r.type,
    source_origin: typeof r.metadata?.source_origin === "string" ? r.metadata.source_origin : undefined,
    derivation_mode: typeof r.metadata?.derivation_mode === "string" ? r.metadata.derivation_mode : undefined,
    source_app: typeof r.metadata?.source_app === "string" ? r.metadata.source_app : undefined,
  }));
}

export interface RecallStats {
  memoriesReturned: number;
  collapsedCount: number;
}

function applyProfileFilters(memories: RecallMemory[], profileParams: RecallProfileParams): RecallMemory[] {
  if (profileParams.minConfidence == null) return memories;
  return memories.filter((memory) => memory.confidence >= profileParams.minConfidence!);
}

function filterFallbackRecallMemories(memories: RecallMemory[]): RecallMemory[] {
  if (memories.length === 0) return memories;

  const score = (m: RecallMemory) => m.relevance ?? m.confidence;
  const topScore = memories.reduce((max, m) => Math.max(max, score(m)), -Infinity);
  const minScore = Math.max(FALLBACK_RECALL_MIN_SCORE, topScore - FALLBACK_RECALL_SCORE_WINDOW);
  const filtered = memories.filter((memory) => score(memory) >= minScore);
  // Always keep at least the top result — this is a fallback path that should return something
  return filtered.length > 0 ? filtered : memories.slice(0, 1);
}

export function createRecallHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  metrics?: LatencyMetrics,
  knowledgeState?: KnowledgeState,
  getUserId?: () => string | undefined,
  auditLogger?: AuditLogger,
  onRecallStats?: (stats: RecallStats) => void,
  echoStore?: RecallEchoStore,
) {
  const recallMetrics = metrics ?? new LatencyMetrics();
  let consecutiveFailures = 0;
  let coldStartUntil = 0;

  async function fallbackToBroadRecall(
    query: string,
    timeoutMs: number,
    profileParams: RecallProfileParams,
    userId: string | undefined,
    logger: Logger,
    auditLogger: AuditLogger | undefined,
  ): Promise<RecallMemory[]> {
    if (typeof client.recall !== "function") return [];

    logger.debug?.("Cortex recall: retrieve returned no memories, falling back to broad recall");

    if (auditLogger) {
      void auditLogger.log({
        feature: "auto-recall-fallback",
        method: "POST",
        endpoint: "/v1/recall",
        payload: query,
        userId,
      });
    }

    try {
      const response = await client.recall(query, timeoutMs, {
        limit: profileParams.limit,
        context: profileParams.context,
        userId,
        queryType: profileParams.queryType,
      });
      return filterFallbackRecallMemories(response.memories ?? []);
    } catch (err) {
      logger.debug?.(`Cortex recall fallback failed: ${String(err)}`);
      return [];
    }
  }

  const handler = async (
    event: BeforeAgentStartEvent,
    _ctx: AgentContext,
  ): Promise<BeforeAgentStartResult | void> => {
    logger.info("Cortex recall: hook fired");

    if (!config.autoRecall) return;

    // Skip recall for heartbeat turns — they're periodic status checks that
    // don't need memory context. Recalling during heartbeats floods the agent
    // with operational noise and can trigger unsolicited actions from recalled facts.
    const { source: promptSource, query: promptQuery } = selectRecallQuery(event);
    if (isHeartbeatTurn(promptQuery)) {
      logger.info("Cortex recall: skipped (heartbeat turn)");
      return;
    }

    // Skip recall when we know there are no memories yet, but periodically
    // re-check in case another plugin instance ingested memories or the
    // initial /knowledge check failed at startup.
    if (knowledgeState && !knowledgeState.hasMemories) {
      const sinceLastCheck = Date.now() - knowledgeState.lastChecked;
      if (sinceLastCheck < KNOWLEDGE_RECHECK_INTERVAL_MS) {
        logger.info("Cortex recall: skipped (no memories yet)");
        return;
      }
      // Re-check knowledge state — only fetch /v1/knowledge (lightweight).
      // Pipeline tier is refreshed by the heartbeat handler separately.
      try {
        const userId = getUserId?.();
        if (!userId) {
          logger.warn("Cortex recall: skipped knowledge re-check (user ID unavailable)");
          return;
        }
        const knowledge = await client.knowledge(userId);
        knowledgeState.hasMemories = knowledge.total_memories > 0;
        knowledgeState.totalSessions = knowledge.total_sessions;
        knowledgeState.maturity = knowledge.maturity;
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

    const querySource = promptSource;
    const selectedQuery = promptQuery;
    // Extract a [cortex-date: YYYY-MM-DD] marker if present (injected by the
    // benchmark runner for historical datasets). Strips the marker from the query
    // so it doesn't pollute the semantic search, and uses it as reference_date.
    const { embeddedDate, query: cleanedQuery } = extractReferenceDateMarker(selectedQuery.trim());
    const rawPrompt = cleanedQuery;
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
      const factualContext = profile === "factual"
        ? buildRecentConversationContext(event.messages, prompt)
        : undefined;
      const profileParams = getProfileParams(profile, config, factualContext);
      const retrieveQuery = mergeQueryAndContext(prompt, profileParams.context);
      logger.debug?.(`Cortex recall: profile=${profile}`);

      const retrieveOptions = {
        // Priority: embedded marker from message > config override > real current time.
        // The embedded marker is injected by the benchmark runner for historical datasets
        // so no user config is needed. config.recallReferenceDate is a fallback override.
        referenceDate: embeddedDate ?? config.recallReferenceDate ?? new Date().toISOString(),
        userId: currentUserId,
      };

      if (auditLogger) {
        void auditLogger.log({
          feature: "auto-recall",
          method: "POST",
          endpoint: "/v1/retrieve",
          payload: retrieveQuery,
          userId: currentUserId,
        });
      }

      const retrieveMode = profileParams.mode ?? "full";
      logger.debug?.(`Cortex recall: mode=${retrieveMode}`);

      let rawResponse;
      try {
        rawResponse = await client.retrieve(
          retrieveQuery,
          profileParams.limit,
          retrieveMode,
          effectiveTimeout,
          profileParams.queryType,
          retrieveOptions,
        );
      } catch (retryErr) {
        // On transient 502/503 (cold start, gateway blip), retry once after
        // a short delay. Dropping recall entirely on a single failure is a
        // direct answer-quality regression — most cold starts resolve in ~1-2s.
        if (/50[23]/.test(String(retryErr))) {
          logger.debug?.("Cortex recall: transient 502/503, retrying once after 1.5s");
          await new Promise((r) => setTimeout(r, 1500));
          try {
            rawResponse = await client.retrieve(
              retrieveQuery,
              profileParams.limit,
              retrieveMode,
              effectiveTimeout,
              profileParams.queryType,
              retrieveOptions,
            );
          } catch (retryErr2) {
            logger.debug?.("Cortex recall: retry failed, proceeding without memories");
            return;
          }
        } else {
          throw retryErr;
        }
      }

      const elapsed = Date.now() - start;
      recallMetrics.record(elapsed);
      consecutiveFailures = 0; // reset on success

      let memories = applyProfileFilters(mapRetrieveToRecallMemories(rawResponse.results), profileParams);

      if (!memories.length) {
        memories = await fallbackToBroadRecall(
          prompt,
          effectiveTimeout,
          profileParams,
          currentUserId,
          logger,
          auditLogger,
        );
      }

      if (!memories.length) return;

      // Store recalled content so the capture handler can detect echo loops.
      // Must happen before formatting/truncation to capture full content.
      if (echoStore) {
        echoStore.storeRecalled(memories.map((m) => m.content));
      }

      const { text: formatted, collapsedCount } = formatMemoriesWithStats(memories, config.recallTopK);
      if (!formatted) return;

      onRecallStats?.({ memoriesReturned: memories.length, collapsedCount });

      logger.debug?.(
        `Cortex recall: ${memories.length} memories in ${elapsed}ms${collapsedCount > 0 ? ` (${collapsedCount} collapsed)` : ""}`,
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
