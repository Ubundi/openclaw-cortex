import type { CortexClient, ForgetResponse } from "../cortex/client.js";
import type { CortexConfig } from "./config.js";
import type { ToolDefinition, Logger } from "./types.js";
import type { AuditLogger } from "../internal/audit-logger.js";
import type { RecentSaves } from "../internal/dedupe.js";
import type { KnowledgeState } from "./index.js";
import { formatMemories } from "../features/recall/formatter.js";
import { coerceSearchMode, prepareSearchQuery } from "./search-query.js";

export interface SessionStats {
  saves: number;
  savesSkippedDedupe: number;
  savesSkippedNovelty: number;
  searches: number;
  recallCount: number;
  recallMemoriesTotal: number;
  recallDuplicatesCollapsed: number;
}

export interface ToolsDeps {
  client: CortexClient;
  config: CortexConfig;
  logger: Logger;
  getUserId: () => string | undefined;
  userIdReady: Promise<void>;
  sessionId: string;
  sessionStats: SessionStats;
  persistStats: (stats: SessionStats) => void;
  auditLoggerProxy: AuditLogger;
  knowledgeState: KnowledgeState;
  recentSaves: RecentSaves | null;
}

export function buildSearchMemoryTool(deps: ToolsDeps): ToolDefinition {
  const {
    client,
    config,
    logger,
    getUserId,
    userIdReady,
    sessionStats,
    persistStats,
    auditLoggerProxy,
  } = deps;

  return {
    name: "cortex_search_memory",
    description: "Search long-term memory for facts, preferences, and past context. Use when you need to recall something the user mentioned before or retrieve stored knowledge. Use 'mode' to narrow results to a specific category.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query for memory retrieval",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (1-50)",
          default: 10,
        },
        mode: {
          type: "string",
          enum: ["all", "decisions", "preferences", "facts", "recent"],
          description: "Filter memories by category. 'all' returns everything (default), 'decisions' returns architectural/design choices, 'preferences' returns user likes/settings, 'facts' returns durable knowledge, 'recent' prioritizes recency over relevance.",
        },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const query = String(params.query ?? "");
      const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
      const mode = coerceSearchMode(typeof params.mode === "string" ? params.mode : undefined);

      await userIdReady;
      const userId = getUserId();

      const prepared = prepareSearchQuery(query, mode);

      logger.debug?.(`Cortex search: "${prepared.effectiveQuery.slice(0, 80)}" (limit=${limit}, mode=${prepared.mode})`);
      sessionStats.searches++;
      persistStats(sessionStats);

      void auditLoggerProxy.log({
        feature: "tool-search-memory",
        method: "POST",
        endpoint: "/v1/recall",
        payload: prepared.effectiveQuery,
        userId,
      });

      try {
        const doRecall = async (attempt = 0): ReturnType<typeof client.recall> => {
          try {
            return await client.recall(prepared.effectiveQuery, config.toolTimeoutMs, {
              limit,
              userId: userId,
              queryType: prepared.queryType,
              memoryType: prepared.memoryType,
            });
          } catch (err) {
            if (attempt < 1 && /50[23]/.test(String(err))) {
              await new Promise((r) => setTimeout(r, 1500));
              return doRecall(attempt + 1);
            }
            throw err;
          }
        };

        const response = await doRecall();

        if (!response.memories?.length) {
          return { content: [{ type: "text", text: "No memories found matching that query." }] };
        }

        logger.debug?.(`Cortex search returned ${response.memories.length} memories`);
        const formatted = formatMemories(response.memories, config.recallTopK);
        return { content: [{ type: "text", text: formatted }] };
      } catch (err) {
        logger.warn(`Cortex search failed: ${String(err)}`);
        return { content: [{ type: "text", text: `Memory search failed: ${String(err)}` }] };
      }
    },
  };
}

export function buildSaveMemoryTool(deps: ToolsDeps): ToolDefinition {
  const {
    client,
    config,
    logger,
    getUserId,
    userIdReady,
    sessionId,
    sessionStats,
    persistStats,
    auditLoggerProxy,
    knowledgeState,
    recentSaves,
  } = deps;

  return {
    name: "cortex_save_memory",
    description: "Explicitly save a fact, preference, or piece of information to long-term memory. Use when the user asks you to remember something specific. Provide type and importance to help organize memories for better retrieval.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The information to save to memory (a fact, preference, or context)",
        },
        type: {
          type: "string",
          enum: ["preference", "decision", "fact", "transient"],
          description: "Category of this memory. 'preference' for user likes/dislikes/settings, 'decision' for architectural or design choices, 'fact' for durable knowledge, 'transient' for temporary state that may change soon.",
        },
        importance: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "How important this memory is for future recall. 'high' for critical preferences or decisions, 'normal' for general facts, 'low' for minor context.",
        },
        checkNovelty: {
          type: "boolean",
          description: "When true, checks if a similar memory already exists before saving. Skips the save if a near-duplicate is found. Defaults to false.",
        },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const text = String(params.text ?? "");
      if (!text || text.length < 5) {
        return { content: [{ type: "text", text: "Text too short to save as a memory." }] };
      }

      const memoryType = typeof params.type === "string" ? params.type : undefined;
      const importance = typeof params.importance === "string" ? params.importance : undefined;
      const checkNovelty = params.checkNovelty === true;

      await userIdReady;
      const userId = getUserId();
      if (!userId) {
        logger.warn("Cortex save: missing user_id");
        return { content: [{ type: "text", text: "Failed to save memory: Cortex ingest requires user_id." }] };
      }

      // Prepend metadata tags so they're stored with the memory text
      const metaTags: string[] = [];
      if (memoryType) metaTags.push(`[type:${memoryType}]`);
      if (importance) metaTags.push(`[importance:${importance}]`);
      const enrichedText = metaTags.length > 0 ? `${metaTags.join(" ")} ${text}` : text;

      // Client-side dedupe — skip if near-duplicate was saved recently
      if (recentSaves?.isDuplicate(text)) {
        logger.debug?.(`Cortex save skipped (duplicate within window): "${text.slice(0, 60)}"`);
        sessionStats.savesSkippedDedupe++;
        persistStats(sessionStats);
        return {
          content: [{ type: "text", text: "This memory is very similar to one saved recently. Skipped to avoid duplication." }],
        };
      }

      // Novelty check — query existing memories to see if this is already stored
      if (checkNovelty) {
        try {
          const existing = await client.retrieve(
            text,
            1,
            "fast",
            config.toolTimeoutMs,
            "factual",
            { userId },
          );
          const topScore = existing.results?.[0]?.score ?? 0;
          if (topScore >= config.noveltyThreshold) {
            logger.debug?.(`Cortex save skipped (not novel, score=${topScore.toFixed(2)}): "${text.slice(0, 60)}"`);
            sessionStats.savesSkippedNovelty++;
            persistStats(sessionStats);
            recentSaves?.record(text);
            return {
              content: [{
                type: "text",
                text: `This memory already exists (similarity ${(topScore * 100).toFixed(0)}%). Skipped to avoid duplication.`,
              }],
            };
          }
        } catch (err) {
          // Novelty check is best-effort — proceed with save on failure
          logger.debug?.(`Cortex novelty check failed, proceeding with save: ${String(err)}`);
        }
      }

      logger.debug?.(`Cortex save: "${enrichedText.slice(0, 80)}"`);

      void auditLoggerProxy.log({
        feature: "tool-save-memory",
        method: "POST",
        endpoint: "/v1/remember",
        payload: enrichedText,
        sessionId,
        userId,
      });

      try {
        const now = new Date();
        const referenceDate = now.toISOString().slice(0, 10);
        await client.remember(
          enrichedText,
          sessionId,
          config.toolTimeoutMs,
          referenceDate,
          userId,
          "openclaw",
          "OpenClaw",
        );
        if (knowledgeState) {
          knowledgeState.hasMemories = true;
        }
        recentSaves?.record(text);
        sessionStats.saves++;
        persistStats(sessionStats);
        logger.debug?.("Cortex remember accepted");
        return {
          content: [{
            type: "text",
            text: "Memory submitted for processing. It should be available shortly.",
          }],
        };
      } catch (err) {
        logger.warn(`Cortex save failed, falling back to async ingest: ${String(err)}`);

        try {
          const referenceDate = new Date().toISOString();
          const job = await client.submitIngest(
            enrichedText,
            sessionId,
            referenceDate,
            userId,
            "openclaw",
            "OpenClaw",
          );
          if (knowledgeState) {
            knowledgeState.hasMemories = true;
          }
          recentSaves?.record(text);
          sessionStats.saves++;
          persistStats(sessionStats);
          return {
            content: [{
              type: "text",
              text: `Memory save queued (job ${job.job_id}, status=${job.status}). It should be available shortly.`,
            }],
          };
        } catch (fallbackErr) {
          logger.warn(`Cortex save fallback failed: ${String(fallbackErr)}`);
          return { content: [{ type: "text", text: `Failed to save memory: ${String(err)}` }] };
        }
      }
    },
  };
}

export function buildForgetMemoryTool(deps: ToolsDeps): ToolDefinition {
  const {
    client,
    config,
    logger,
    getUserId,
    userIdReady,
    auditLoggerProxy,
  } = deps;

  return {
    name: "cortex_forget",
    description: "Selectively remove memories from long-term storage. Use when the user says something is wrong, outdated, or should be forgotten. Target by entity name (a person, project, or concept) or by session ID.",
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Name of the entity whose memories should be removed (e.g. a person, project, technology). Removes all memories referencing this entity.",
        },
        session: {
          type: "string",
          description: "Session ID whose memories should be removed. Removes all memories from that session.",
        },
      },
    },
    async execute(_id, params) {
      const entity = typeof params.entity === "string" ? params.entity.trim() : undefined;
      const session = typeof params.session === "string" ? params.session.trim() : undefined;

      if (!entity && !session) {
        return {
          content: [{ type: "text", text: "Please specify either an 'entity' name or a 'session' ID to forget." }],
        };
      }

      await userIdReady;
      const userId = getUserId();

      const results: string[] = [];

      if (entity) {
        void auditLoggerProxy.log({
          feature: "tool-forget-memory",
          method: "DELETE",
          endpoint: `/v1/forget/entity/${entity}`,
          payload: entity,
          userId,
        });

        try {
          const response: ForgetResponse = await client.forgetEntity(entity, config.toolTimeoutMs);
          results.push(`Removed ${response.memories_removed} memor${response.memories_removed === 1 ? "y" : "ies"} referencing "${entity}".`);
          logger.info(`Cortex forget: removed ${response.memories_removed} memories for entity "${entity}"`);
        } catch (err) {
          logger.warn(`Cortex forget entity failed: ${String(err)}`);
          results.push(`Failed to forget entity "${entity}": ${String(err)}`);
        }
      }

      if (session) {
        void auditLoggerProxy.log({
          feature: "tool-forget-memory",
          method: "DELETE",
          endpoint: `/v1/forget/session/${session}`,
          payload: session,
          userId,
        });

        try {
          const response: ForgetResponse = await client.forgetSession(session, config.toolTimeoutMs);
          results.push(`Removed ${response.memories_removed} memor${response.memories_removed === 1 ? "y" : "ies"} from session "${session}".`);
          logger.info(`Cortex forget: removed ${response.memories_removed} memories for session "${session}"`);
        } catch (err) {
          logger.warn(`Cortex forget session failed: ${String(err)}`);
          results.push(`Failed to forget session "${session}": ${String(err)}`);
        }
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    },
  };
}
