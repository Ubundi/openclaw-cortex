import type {
  CortexClient,
  ForgetResponse,
  NodeDetailResponse,
  RecallMemory,
} from "../cortex/client.js";
import type { CortexConfig } from "./config.js";
import type { ToolDefinition, Logger } from "./types.js";
import type { AuditLogger } from "../internal/audit-logger.js";
import type { RecentSaves } from "../internal/dedupe.js";
import type { KnowledgeState } from "./index.js";
import { formatMemories } from "../features/recall/formatter.js";
import { coerceSearchMode, filterSearchResults, prepareSearchQuery } from "./search-query.js";

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
  getActiveSessionKey?: () => string | undefined;
  userIdReady: Promise<void>;
  sessionId: string;
  sessionStats: SessionStats;
  persistStats: (stats: SessionStats) => void;
  auditLoggerProxy: AuditLogger;
  knowledgeState: KnowledgeState;
  recentSaves: RecentSaves | null;
}

type SearchScope = "all" | "session" | "long-term";

const FORGET_QUERY_LIMIT = 10;
const FORGET_QUERY_MIN_CONFIDENCE = 0.5;

function coerceSearchScope(input: unknown): SearchScope {
  switch (input) {
    case "session":
    case "long-term":
    case "all":
      return input;
    default:
      return "all";
  }
}

function normalizeSessionKey(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getSearchSessionIds(deps: ToolsDeps): string[] {
  const activeSessionKey = normalizeSessionKey(deps.getActiveSessionKey?.());
  if (activeSessionKey) return [activeSessionKey];

  const toolSessionId = normalizeSessionKey(deps.sessionId);
  return toolSessionId ? [toolSessionId] : [];
}

function getLongTermExcludedSessionIds(deps: ToolsDeps): Set<string> {
  const sessionIds = new Set<string>();
  const activeSessionKey = normalizeSessionKey(deps.getActiveSessionKey?.());
  if (activeSessionKey) sessionIds.add(activeSessionKey);
  return sessionIds;
}

function getMemoryDisplayScore(memory: RecallMemory): number {
  return memory.relevance ?? memory.confidence;
}

function sortMemoriesByDisplayScore(memories: RecallMemory[]): RecallMemory[] {
  return [...memories].sort((a, b) => getMemoryDisplayScore(b) - getMemoryDisplayScore(a));
}

function formatForgetMatches(memories: RecallMemory[]): string {
  const previews = memories.slice(0, 3).map(
    (memory) => `- [${memory.confidence.toFixed(2)}] ${memory.content}`,
  );
  return previews.length > 0 ? `Matching memories:\n${previews.join("\n")}` : "";
}

function collectEntityNames(memories: RecallMemory[]): string[] {
  const entities = new Set<string>();
  for (const memory of memories) {
    for (const entity of memory.entities ?? []) {
      const trimmed = entity.trim();
      if (trimmed) entities.add(trimmed);
    }
  }
  return [...entities];
}

function extractRelatedEntityNames(node: NodeDetailResponse): string[] {
  const entities = new Set<string>();

  for (const entity of node.entities ?? []) {
    const trimmed = entity.trim();
    if (trimmed) entities.add(trimmed);
  }

  for (const relatedNode of node.related_nodes ?? []) {
    if (relatedNode.type !== "ENTITY") continue;
    const label = typeof relatedNode.content === "string" && relatedNode.content.trim().length > 0
      ? relatedNode.content.trim()
      : typeof relatedNode.name === "string" && relatedNode.name.trim().length > 0
        ? relatedNode.name.trim()
        : relatedNode.node_id;
    if (label) entities.add(label);
  }

  return [...entities];
}

function formatNodeDetail(node: NodeDetailResponse): string {
  const lines = [
    `ID: ${node.node_id}`,
    `Type: ${node.type}`,
  ];

  if (typeof node.confidence === "number") {
    lines.push(`Confidence: ${node.confidence.toFixed(2)}`);
  }

  const relatedEntities = extractRelatedEntityNames(node);
  if (relatedEntities.length > 0) {
    lines.push(`Related entities: ${relatedEntities.join(", ")}`);
  }

  if (node.created_at) {
    lines.push(`Created: ${node.created_at}`);
  }

  if (node.updated_at) {
    lines.push(`Updated: ${node.updated_at}`);
  }

  return `${lines.join("\n")}\n\n${node.content}`;
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
    description: "Search long-term memory for facts, preferences, and past context. Use when you need to recall something the user mentioned before or retrieve stored knowledge. Use 'mode' to narrow results to a specific category and 'scope' to focus on the current session versus older memories.",
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
        scope: {
          type: "string",
          enum: ["all", "session", "long-term"],
          description: "Search across all memories (default), only the current session, or only long-term memories from other sessions.",
          default: "all",
        },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const query = String(params.query ?? "");
      const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
      const mode = coerceSearchMode(typeof params.mode === "string" ? params.mode : undefined);
      const scope = coerceSearchScope(params.scope);
      const initialRecallLimit = scope === "long-term"
        ? Math.min(50, Math.max(limit, Math.ceil(limit * 2)))
        : limit;

      await userIdReady;
      const userId = getUserId();

      const prepared = prepareSearchQuery(query, mode);

      logger.debug?.(
        `Cortex search: "${prepared.effectiveQuery.slice(0, 80)}" (limit=${limit}, mode=${prepared.mode}, scope=${scope})`,
      );
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
        const doRecall = async (
          recallLimit: number,
          sessionFilter?: string,
          attempt = 0,
        ): ReturnType<typeof client.recall> => {
          try {
            return await client.recall(prepared.effectiveQuery, config.toolTimeoutMs, {
              limit: recallLimit,
              userId: userId,
              queryType: prepared.queryType,
              memoryType: prepared.memoryType,
              ...(sessionFilter ? { sessionFilter } : {}),
            });
          } catch (err) {
            if (attempt < 1 && /50[23]/.test(String(err))) {
              await new Promise((r) => setTimeout(r, 1500));
              return doRecall(recallLimit, sessionFilter, attempt + 1);
            }
            throw err;
          }
        };

        let scopedMemories: RecallMemory[];

        if (scope === "session") {
          const sessionIds = getSearchSessionIds(deps);
          const responses = await Promise.all(
            sessionIds.map((sessionFilter) => doRecall(limit, sessionFilter)),
          );
          const combinedMemories = responses.flatMap((response) => response.memories ?? []);
          scopedMemories = responses.length > 1
            ? sortMemoriesByDisplayScore(combinedMemories)
            : combinedMemories;
        } else if (scope === "long-term") {
          const excludedSessionIds = getLongTermExcludedSessionIds(deps);
          let expandedRecallLimit = initialRecallLimit;
          let response = await doRecall(expandedRecallLimit);
          scopedMemories = excludedSessionIds.size > 0
            ? (response.memories ?? []).filter(
                (memory) => !excludedSessionIds.has(memory.session_id ?? ""),
              )
            : (response.memories ?? []);

          while (
            excludedSessionIds.size > 0 &&
            scopedMemories.length < limit &&
            expandedRecallLimit < 50 &&
            (response.memories?.length ?? 0) >= expandedRecallLimit
          ) {
            expandedRecallLimit = Math.min(
              50,
              Math.max(expandedRecallLimit + limit, Math.ceil(expandedRecallLimit * 1.5)),
            );
            logger.debug?.(
              `Cortex search: expanding long-term scope fetch to ${expandedRecallLimit} results`,
            );
            response = await doRecall(expandedRecallLimit);
            scopedMemories = (response.memories ?? []).filter(
              (memory) => !excludedSessionIds.has(memory.session_id ?? ""),
            );
          }
        } else {
          const response = await doRecall(initialRecallLimit);
          scopedMemories = response.memories ?? [];
        }

        const filteredMemories = filterSearchResults(scopedMemories, prepared.mode)
          .slice(0, Math.min(limit, config.recallTopK));

        if (!filteredMemories.length) {
          return { content: [{ type: "text", text: "No memories found matching that query." }] };
        }

        logger.debug?.(`Cortex search returned ${filteredMemories.length} memories after filtering`);
        const formatted = formatMemories(filteredMemories, config.recallTopK);
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
    getActiveSessionKey,
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
      const effectiveSessionId = normalizeSessionKey(getActiveSessionKey?.()) ?? sessionId;
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
        sessionId: effectiveSessionId,
        userId,
      });

      try {
        const now = new Date();
        const referenceDate = now.toISOString().slice(0, 10);
        await client.remember(
          enrichedText,
          effectiveSessionId,
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
            effectiveSessionId,
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
    description: "Selectively remove memories from long-term storage. Use when the user says something is wrong, outdated, or should be forgotten. Target by entity name or by session ID; use 'query' to identify candidate memories and entities before deleting anything.",
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
        query: {
          type: "string",
          description: "Search for related memories first and surface candidate entities or sessions to confirm before forgetting.",
        },
      },
    },
    async execute(_id, params) {
      const entity = typeof params.entity === "string" ? params.entity.trim() : undefined;
      const session = typeof params.session === "string" ? params.session.trim() : undefined;
      const query = typeof params.query === "string" ? params.query.trim() : undefined;

      if (!entity && !session && !query) {
        return {
          content: [{ type: "text", text: "Please specify an 'entity', a 'session', or a 'query' to forget." }],
        };
      }

      await userIdReady;
      const userId = getUserId();

      const results: string[] = [];

      if (query) {
        void auditLoggerProxy.log({
          feature: "tool-forget-memory",
          method: "POST",
          endpoint: "/v1/recall",
          payload: query,
          userId,
        });

        try {
          const response = await client.recall(query, config.toolTimeoutMs, {
            limit: FORGET_QUERY_LIMIT,
            userId,
          });
          const matchedMemories = response.memories ?? [];
          const highConfidenceMemories = matchedMemories.filter(
            (memory) => memory.confidence >= FORGET_QUERY_MIN_CONFIDENCE,
          );
          const entityNames = collectEntityNames(highConfidenceMemories);

          if (entityNames.length === 0) {
            if (matchedMemories.length === 0) {
              results.push(`No memories found matching "${query}".`);
            } else {
              const prefix = highConfidenceMemories.length === 0
                ? `Matched ${matchedMemories.length} memor${matchedMemories.length === 1 ? "y" : "ies"}, but none met the confidence threshold of ${FORGET_QUERY_MIN_CONFIDENCE.toFixed(2)}.`
                : `Found ${highConfidenceMemories.length} high-confidence memor${highConfidenceMemories.length === 1 ? "y" : "ies"}, but none included named entities to forget.`;
              const previewBlock = formatForgetMatches(highConfidenceMemories.length > 0 ? highConfidenceMemories : matchedMemories);
              results.push(
                [
                  prefix,
                  previewBlock,
                  "No memories were deleted. Confirm the exact 'entity' or 'session' with the user before forgetting.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              );
            }
          } else {
            const previewBlock = formatForgetMatches(highConfidenceMemories);
            results.push(
              [
                `Found ${highConfidenceMemories.length} matching memories.`,
                previewBlock,
                `Candidate entities: ${entityNames.join(", ")}.`,
                "No memories were deleted from the query matches. Confirm the exact 'entity' or 'session' with the user before forgetting.",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }
        } catch (err) {
          logger.warn(`Cortex forget query failed: ${String(err)}`);
          results.push(`Failed to search memories for query "${query}": ${String(err)}`);
        }
      }

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

export function buildGetMemoryTool(deps: ToolsDeps): ToolDefinition {
  const {
    client,
    config,
    logger,
    getUserId,
    userIdReady,
    auditLoggerProxy,
  } = deps;

  return {
    name: "cortex_get_memory",
    description: "Fetch a specific memory by its node ID when you already know the exact memory identifier.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The Cortex node ID of the memory to retrieve.",
        },
      },
      required: ["id"],
    },
    async execute(_id, params) {
      const memoryId = typeof params.id === "string" ? params.id.trim() : "";
      if (!memoryId) {
        return { content: [{ type: "text", text: "Please provide a memory 'id' to retrieve." }] };
      }

      await userIdReady;
      const userId = getUserId();

      void auditLoggerProxy.log({
        feature: "tool-get-memory",
        method: "GET",
        endpoint: `/v1/nodes/${memoryId}`,
        payload: memoryId,
        userId,
      });

      try {
        const response = await client.getNode(memoryId, config.toolTimeoutMs);
        return { content: [{ type: "text", text: formatNodeDetail(response) }] };
      } catch (err) {
        logger.warn(`Cortex get memory failed: ${String(err)}`);
        return { content: [{ type: "text", text: `Failed to fetch memory "${memoryId}": ${String(err)}` }] };
      }
    },
  };
}
