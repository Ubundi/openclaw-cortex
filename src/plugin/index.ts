import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import packageJson from "../../package.json" with { type: "json" };
import { CortexConfigSchema, configSchema, type CortexConfig } from "./config/schema.js";
import { CortexClient } from "../adapters/cortex/client.js";
import { createRecallHandler } from "../features/recall/handler.js";
import { createCaptureHandler } from "../features/capture/handler.js";
import { FileSyncWatcher } from "../features/sync/watcher.js";
import { RetryQueue } from "../internal/queue/retry-queue.js";
import { LatencyMetrics } from "../internal/metrics/latency-metrics.js";
import { loadOrCreateUserId } from "../internal/identity/user-id.js";
import { BAKED_API_KEY } from "../internal/identity/api-key.js";
import { formatMemories } from "../features/recall/formatter.js";
import { AuditLogger } from "../internal/audit/audit-logger.js";
import { RecentSaves } from "../internal/dedupe.js";
import { injectAgentInstructions } from "../internal/agent-instructions.js";
import { createCheckpointHandler } from "../features/checkpoint/handler.js";
import { createHeartbeatHandler } from "../features/heartbeat/handler.js";
import {
  buildSessionSummaryFromMessages,
  formatRecoveryContext,
  SessionStateStore,
} from "../internal/session/session-state.js";

const version = packageJson.version;
const STATS_FILE = join(homedir(), ".openclaw", "cortex-session-stats.json");

interface SessionStats {
  saves: number;
  savesSkippedDedupe: number;
  savesSkippedNovelty: number;
  searches: number;
  recallCount: number;
  recallMemoriesTotal: number;
  recallDuplicatesCollapsed: number;
}

function persistStats(stats: SessionStats): void {
  try {
    writeFileSync(STATS_FILE, JSON.stringify({ ...stats, updatedAt: Date.now() }) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Best-effort — stats display is non-critical
  }
}

function loadPersistedStats(): SessionStats | null {
  try {
    const raw = JSON.parse(readFileSync(STATS_FILE, "utf-8"));
    return {
      saves: raw.saves ?? 0,
      savesSkippedDedupe: raw.savesSkippedDedupe ?? 0,
      savesSkippedNovelty: raw.savesSkippedNovelty ?? 0,
      searches: raw.searches ?? 0,
      recallCount: raw.recallCount ?? 0,
      recallMemoriesTotal: raw.recallMemoriesTotal ?? 0,
      recallDuplicatesCollapsed: raw.recallDuplicatesCollapsed ?? 0,
    };
  } catch {
    return null;
  }
}

export interface KnowledgeState {
  hasMemories: boolean;
  totalSessions: number;
  pipelineTier: 1 | 2 | 3;
  maturity: "cold" | "warming" | "mature" | "unknown";
  lastChecked: number;
}

/**
 * Derives a workspace-scoped namespace from the workspace directory path.
 * Uses the directory basename plus a short hash of the full path to avoid collisions
 * when multiple workspaces share the same basename.
 */
function deriveNamespace(workspaceDir: string): string {
  const name = basename(workspaceDir).replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = createHash("sha256").update(workspaceDir).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

function resolveSessionKey(
  value: Record<string, unknown> | undefined,
  fallbackSessionId: string,
): string {
  if (typeof value?.sessionKey === "string" && value.sessionKey.length > 0) return value.sessionKey;
  if (typeof value?.sessionId === "string" && value.sessionId.length > 0) return value.sessionId;
  return fallbackSessionId;
}

function mergePrependContext(recoveryContext: string | undefined, recallContext: string | undefined): string | undefined {
  if (recoveryContext && recallContext) return `${recoveryContext}\n\n${recallContext}`;
  return recoveryContext ?? recallContext;
}

function isAbortError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "name" in err) {
    return err.name === "AbortError";
  }
  return String(err).includes("AbortError");
}

async function resetCompletedAfterAbort(
  client: CortexClient,
  userId: string,
): Promise<boolean> {
  try {
    const knowledge = await client.knowledge(undefined, userId);
    return knowledge.total_memories === 0 && knowledge.total_sessions === 0;
  } catch {
    return false;
  }
}

// --- OpenClaw Plugin API types (per docs.openclaw.ai/tools/plugin) ---

interface HookMetadata {
  name: string;
  description: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

interface CommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: CommandContext) => Promise<{ text: string }> | { text: string };
}

interface CommandContext {
  senderId?: string;
  channel?: string;
  isAuthorizedSender?: boolean;
  args?: string;
  commandBody?: string;
  config?: Record<string, unknown>;
}

interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: {
    debug?(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  // Legacy hook registration (kept for backward compatibility)
  on?(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  // Modern hook registration with metadata
  registerHook?(
    hookName: string,
    handler: (...args: any[]) => any,
    metadata: HookMetadata,
  ): void;
  registerService(service: {
    id: string;
    start?: (ctx: { workspaceDir?: string }) => void;
    stop?: (ctx: { workspaceDir?: string }) => void;
  }): void;
  // Agent tools (LLM-invocable functions)
  registerTool?(definition: ToolDefinition, options?: { optional?: boolean }): void;
  // Auto-reply commands (execute without AI agent)
  registerCommand?(definition: CommandDefinition): void;
  // Gateway RPC methods
  registerGatewayMethod?(
    name: string,
    handler: (ctx: { respond: (ok: boolean, data: unknown) => void }) => void,
  ): void;
  // CLI commands (terminal-level, uses Commander.js)
  registerCli?(
    registrar: (ctx: { program: CliProgram; config: Record<string, unknown>; workspaceDir?: string; logger: Logger }) => void,
    opts?: { commands?: string[] },
  ): void;
}

interface CliProgram {
  command(name: string): CliCommand;
}

interface CliCommand {
  description(desc: string): CliCommand;
  command(name: string): CliCommand;
  argument(name: string, desc: string): CliCommand;
  option(flags: string, desc: string, defaultValue?: string): CliCommand;
  action(fn: (...args: any[]) => void | Promise<void>): CliCommand;
}

interface Logger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}


async function bootstrapClient(
  client: CortexClient,
  logger: Logger,
  knowledgeState: KnowledgeState,
  userId: string | undefined,
): Promise<void> {
  try {
    const healthy = await client.healthCheck();
    if (!healthy) {
      logger.info("Cortex offline — API unreachable");
      return;
    }
  } catch {
    logger.info("Cortex offline — API unreachable");
    return;
  }

  try {
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

    logger.info(
      `Cortex connected — ${knowledge.total_memories.toLocaleString()} memories, ${knowledge.total_sessions} sessions (${knowledge.maturity}), tier ${knowledgeState.pipelineTier}`,
    );
  } catch {
    // Knowledge endpoint unavailable — health check passed so API is reachable
    logger.info("Cortex connected");
  }
}

/**
 * Registers a hook using the modern registerHook API if available,
 * falling back to the legacy api.on() for older OpenClaw runtimes.
 */
function registerHookCompat(
  api: PluginApi,
  hookName: string,
  handler: (...args: any[]) => any,
  metadata: HookMetadata,
): void {
  if (api.on) {
    api.on(hookName, handler);
  } else if (api.registerHook) {
    api.registerHook(hookName, handler, metadata);
  } else {
    api.logger.warn(`Cortex: cannot register hook "${hookName}" — no registerHook or on method available`);
  }
}

/** Tool names that must survive the tools.profile allowlist filter. */
const CORTEX_TOOL_NAMES = ["cortex_search_memory", "cortex_save_memory"] as const;

/**
 * Ensures `tools.alsoAllow` in the OpenClaw config includes our tool names.
 * Without this, profiles like "coding" silently filter out plugin tools —
 * auto-recall/capture hooks still work, but the agent can't explicitly
 * search or save memories.
 *
 * Runs once on first registration; idempotent thereafter.
 */
function ensureToolsAllowlist(logger: Logger): void {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    // Only needed when a tools profile is active (which creates a fixed allowlist)
    if (!config.tools?.profile) return;

    const existing: string[] = Array.isArray(config.tools.alsoAllow)
      ? config.tools.alsoAllow
      : [];
    const missing = CORTEX_TOOL_NAMES.filter((name) => !existing.includes(name));
    if (missing.length === 0) return;

    config.tools.alsoAllow = [...existing, ...missing];
    // Preserve original file permissions (e.g. 0o600) to avoid security audit warnings
    let mode: number | undefined;
    try { mode = statSync(configPath).mode & 0o777; } catch { /* ignore */ }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: mode ?? 0o600 });
    logger.info(
      `Cortex: enabled memory tools for "${config.tools.profile}" profile`,
    );
  } catch {
    // Config unreadable — tools may be filtered by the profile allowlist.
    // Hooks (auto-recall, auto-capture) still work regardless.
    logger.warn(
      `Cortex: could not verify tool access — if the agent cannot use cortex_search_memory or cortex_save_memory, add them to tools.alsoAllow in openclaw.json`,
    );
  }
}

const plugin = {
  id: "openclaw-cortex",
  name: "Cortex Memory",
  description:
    "Long-term memory powered by Cortex — Auto-Recall, Auto-Capture, and background file sync",
  version,
  // No `kind` — cortex supplements the built-in memory system rather than replacing it
  configSchema,

  register(api: PluginApi) {
    const raw = api.pluginConfig ?? {};
    const parsed = CortexConfigSchema.safeParse(raw);

    if (!parsed.success) {
      api.logger.error(
        "Cortex plugin config invalid:",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      return;
    }

    // BUILD_API_KEY must be injected into dist at build/publish time.
    // If the placeholder "__OPENCLAW_API_KEY__" is still present, Cortex
    // calls will fail — but we allow it so unit tests (which mock the
    // client) can exercise registration. Only bail on a truly empty key
    // (which can happen if inject-api-key.mjs runs with an empty var).
    if (!(BAKED_API_KEY as string)) {
      api.logger.error(
        "Cortex plugin misconfigured: empty API key. Rebuild with BUILD_API_KEY=... npm run build, or install the published package.",
      );
      return;
    }

    // Ensure our tools survive the profile allowlist filter (one-time config patch)
    ensureToolsAllowlist(api.logger);

    const config: CortexConfig = parsed.data;
    const client = new CortexClient(config.baseUrl, BAKED_API_KEY);
    const retryQueue = new RetryQueue(api.logger);
    const recallMetrics = new LatencyMetrics();
    const sessionState = new SessionStateStore();
    const knowledgeState: KnowledgeState = {
      hasMemories: false,
      totalSessions: 0,
      pipelineTier: 1,
      maturity: "unknown",
      lastChecked: 0,
    };

    // Session ID for this plugin lifecycle — groups tool-saved memories into
    // a single Cortex SESSION node so total_sessions increments properly.
    const sessionId = randomUUID();

    // Whether the user explicitly set a namespace vs. relying on default
    const userSetNamespace = raw.namespace != null;
    let namespace = config.namespace;
    let started = false;
    let watcher: FileSyncWatcher | null = null;

    // Audit logger is created lazily in start(ctx) when workspaceDir is available,
    // or on-demand via the /audit command. The proxy always exists so handlers can
    // start logging without a restart when toggled on at runtime.
    let auditLoggerInner: AuditLogger | undefined;
    let workspaceDirResolved: string | undefined;
    const auditLoggerProxy: AuditLogger = {
      log(entry) {
        return auditLoggerInner?.log(entry) ?? Promise.resolve();
      },
    } as AuditLogger;

    // userId: use explicit config value if provided, otherwise load/create a
    // stable UUID persisted at ~/.openclaw/cortex-user-id. Resolved eagerly so
    // commands and hooks work even if start() is never called (e.g. [plugins]
    // instances in multi-process runtimes). The capture handler awaits
    // userIdReady before firing — user_id is required by the API.
    let userId: string | undefined = config.userId;
    const userIdReady: Promise<void> = userId
      ? Promise.resolve()
      : loadOrCreateUserId()
          .then((id) => {
            userId = id;
            api.logger.debug?.(`Cortex user ID: ${id}`);
          })
          .catch(() => {
            userId = randomUUID();
            api.logger.warn("Cortex: could not persist user ID, using ephemeral ID for this session");
          });

    // Health check + knowledge probe — runs after userId resolves so recall
    // knows whether memories exist. Must happen in register() because some
    // runtime instances never call start().
    void userIdReady.then(() => bootstrapClient(client, api.logger, knowledgeState, userId));

    api.logger.info(`Cortex v${version} ready`);

    // --- Hooks ---

    // Track last messages for /checkpoint command (populated by agent_end wrapper)
    let lastMessages: unknown[] = [];
    const recoveryCheckedSessions = new Set<string>();
    const recallHandler = createRecallHandler(
      client,
      config,
      api.logger,
      recallMetrics,
      knowledgeState,
      () => userId,
      auditLoggerProxy,
      (stats) => {
        sessionStats.recallCount++;
        sessionStats.recallMemoriesTotal += stats.memoriesReturned;
        sessionStats.recallDuplicatesCollapsed += stats.collapsedCount;
        persistStats(sessionStats);
      },
    );

    // Auto-Recall: inject relevant memories before every agent turn
    registerHookCompat(
      api,
      "before_agent_start",
      async (
        event: { prompt: string; messages?: unknown[] },
        ctx: { sessionKey?: string; sessionId?: string },
      ) => {
        const activeSessionKey = resolveSessionKey(ctx, sessionId);
        let recoveryContext: string | undefined;

        if (!recoveryCheckedSessions.has(activeSessionKey)) {
          recoveryCheckedSessions.add(activeSessionKey);
          try {
            const dirty = await sessionState.readDirtyFromPriorLifecycle(sessionId);
            if (dirty) {
              recoveryContext = formatRecoveryContext(dirty);
              await sessionState.clear();
              api.logger.warn(`Cortex recovery: detected unclean previous session (${dirty.sessionKey})`);
            }
          } catch (err) {
            api.logger.debug?.(`Cortex recovery check failed: ${String(err)}`);
          }
        }

        const recallResult = await recallHandler(event, ctx);
        const combined = mergePrependContext(recoveryContext, recallResult?.prependContext);
        if (!combined) return recallResult;
        return { prependContext: combined };
      },
      {
        name: "openclaw-cortex.recall",
        description: "Inject relevant Cortex memories before agent turn",
      },
    );

    // Auto-Capture: extract facts after agent responses
    const captureHandler = createCaptureHandler(client, config, api.logger, retryQueue, knowledgeState, () => userId, userIdReady, sessionId, auditLoggerProxy);
    registerHookCompat(
      api,
      "agent_end",
      async (event: { messages?: unknown[]; [key: string]: unknown }) => {
        if (event.messages?.length) {
          lastMessages = event.messages;
          const activeSessionKey = resolveSessionKey(event, sessionId);
          const summary = buildSessionSummaryFromMessages(event.messages);
          try {
            await sessionState.markDirty({
              pluginSessionId: sessionId,
              sessionKey: activeSessionKey,
              summary,
            });
          } catch (err) {
            api.logger.debug?.(`Cortex session state update failed: ${String(err)}`);
          }
        }
        return captureHandler(event as any);
      },
      {
        name: "openclaw-cortex.capture",
        description: "Extract and store facts from conversation after agent turn",
      },
    );

    // Heartbeat: periodic health + knowledge refresh
    registerHookCompat(
      api,
      "gateway:heartbeat",
      createHeartbeatHandler(client, api.logger, knowledgeState, retryQueue, () => userId),
      {
        name: "openclaw-cortex.heartbeat",
        description: "Periodic health check and knowledge state refresh",
      },
    );

    // --- Session Stats ---

    const sessionStats = {
      saves: 0,
      savesSkippedDedupe: 0,
      savesSkippedNovelty: 0,
      searches: 0,
      recallCount: 0,
      recallMemoriesTotal: 0,
      recallDuplicatesCollapsed: 0,
    };

    // Reset persisted stats for this new session
    persistStats(sessionStats);

    // --- Agent Tools ---

    const recentSaves = config.dedupeWindowMinutes > 0
      ? new RecentSaves(config.dedupeWindowMinutes)
      : null;

    if (api.registerTool) {
      api.registerTool({
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
          const mode = typeof params.mode === "string" ? params.mode : "all";

          await userIdReady;

          // Augment query based on mode to improve retrieval precision
          let effectiveQuery = query;
          let queryType: "factual" | "emotional" | "combined" | "codex" = "combined";

          switch (mode) {
            case "decisions":
              effectiveQuery = `[type:decision] ${query}`;
              queryType = "factual";
              break;
            case "preferences":
              effectiveQuery = `[type:preference] ${query}`;
              queryType = "factual";
              break;
            case "facts":
              effectiveQuery = `[type:fact] ${query}`;
              queryType = "factual";
              break;
            case "recent":
              queryType = "combined";
              break;
          }

          api.logger.debug?.(`Cortex search: "${effectiveQuery.slice(0, 80)}" (limit=${limit}, mode=${mode})`);
          sessionStats.searches++;
          persistStats(sessionStats);

          void auditLoggerProxy.log({
            feature: "tool-search-memory",
            method: "POST",
            endpoint: "/v1/recall",
            payload: effectiveQuery,
            userId,
          });

          try {
            const doRecall = async (attempt = 0): ReturnType<typeof client.recall> => {
              try {
                return await client.recall(effectiveQuery, config.toolTimeoutMs, {
                  limit,
                  userId: userId,
                  queryType,
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

            api.logger.debug?.(`Cortex search returned ${response.memories.length} memories`);
            const formatted = formatMemories(response.memories, config.recallTopK);
            return { content: [{ type: "text", text: formatted }] };
          } catch (err) {
            api.logger.warn(`Cortex search failed: ${String(err)}`);
            return { content: [{ type: "text", text: `Memory search failed: ${String(err)}` }] };
          }
        },
      });

      api.registerTool({
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
          if (!userId) {
            api.logger.warn("Cortex save: missing user_id");
            return { content: [{ type: "text", text: "Failed to save memory: Cortex ingest requires user_id." }] };
          }

          // Prepend metadata tags so they're stored with the memory text
          const metaTags: string[] = [];
          if (memoryType) metaTags.push(`[type:${memoryType}]`);
          if (importance) metaTags.push(`[importance:${importance}]`);
          const enrichedText = metaTags.length > 0 ? `${metaTags.join(" ")} ${text}` : text;

          // Item 5: Client-side dedupe — skip if near-duplicate was saved recently
          if (recentSaves?.isDuplicate(text)) {
            api.logger.debug?.(`Cortex save skipped (duplicate within window): "${text.slice(0, 60)}"`);
            sessionStats.savesSkippedDedupe++;
            persistStats(sessionStats);
            return {
              content: [{ type: "text", text: "This memory is very similar to one saved recently. Skipped to avoid duplication." }],
            };
          }

          // Item 7: Novelty check — query existing memories to see if this is already stored
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
                api.logger.debug?.(`Cortex save skipped (not novel, score=${topScore.toFixed(2)}): "${text.slice(0, 60)}"`);
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
              api.logger.debug?.(`Cortex novelty check failed, proceeding with save: ${String(err)}`);
            }
          }

          api.logger.debug?.(`Cortex save: "${enrichedText.slice(0, 80)}"`);

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
            api.logger.debug?.("Cortex remember accepted");
            return {
              content: [{
                type: "text",
                text: "Memory submitted for processing. It should be available shortly.",
              }],
            };
          } catch (err) {
            api.logger.warn(`Cortex save failed, falling back to async ingest: ${String(err)}`);

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
              api.logger.warn(`Cortex save fallback failed: ${String(fallbackErr)}`);
              return { content: [{ type: "text", text: `Failed to save memory: ${String(err)}` }] };
            }
          }
        },
      });

      api.logger.debug?.("Cortex tools registered: cortex_search_memory, cortex_save_memory");
    }

    // --- Auto-Reply Commands ---

    if (api.registerCommand) {
      const checkpointHandler = createCheckpointHandler(
        client,
        config,
        api.logger,
        () => userId,
        userIdReady,
        () => lastMessages,
        sessionId,
        auditLoggerProxy,
      );

      api.registerCommand({
        name: "audit",
        description: "Toggle or check Cortex audit log (records all data sent to Cortex)",
        acceptsArgs: true,
        handler: (ctx) => {
          const arg = ctx.args?.trim().toLowerCase();

          if (arg === "on") {
            if (!workspaceDirResolved) {
              return { text: "Cannot enable audit log — no workspace directory available. The plugin must be started with a workspace first." };
            }
            if (auditLoggerInner) {
              return { text: `Audit log is already enabled.\nAll Cortex API calls are being recorded at:\n\`${workspaceDirResolved}/.cortex/audit/\`` };
            }
            auditLoggerInner = new AuditLogger(workspaceDirResolved, api.logger);
            api.logger.info(`Cortex audit log enabled via command: ${workspaceDirResolved}/.cortex/audit/`);
            return {
              text: [
                `**Audit log enabled.**`,
                ``,
                `All data sent to and received from Cortex will be recorded locally.`,
                `Log path: \`${workspaceDirResolved}/.cortex/audit/\``,
                ``,
                `Turn off with \`/audit off\`. Log files are preserved when disabled.`,
              ].join("\n"),
            };
          }

          if (arg === "off") {
            if (!auditLoggerInner) {
              return { text: "Audit log is already off. No data is being recorded." };
            }
            auditLoggerInner = undefined;
            api.logger.info("Cortex audit log disabled via command");
            return {
              text: [
                `**Audit log disabled.**`,
                ``,
                `Cortex API calls are no longer being recorded.`,
                `Existing log files are preserved and can be reviewed at:`,
                `\`${workspaceDirResolved}/.cortex/audit/\``,
              ].join("\n"),
            };
          }

          // No args — show status
          const status = auditLoggerInner ? "on" : "off";
          const lines = [
            `**Cortex Audit Log**`,
            ``,
            `The audit log records all data sent to and received from the Cortex API, stored locally for inspection.`,
            ``,
            `- Status: **${status}**`,
            `- Config default: ${config.auditLog ? "on" : "off"}`,
          ];
          if (workspaceDirResolved) {
            lines.push(`- Log path: \`${workspaceDirResolved}/.cortex/audit/\``);
          }
          lines.push("", "Toggle: `/audit on` · `/audit off`");
          return { text: lines.join("\n") };
        },
      });

      api.registerCommand({
        name: "checkpoint",
        description: "Save a session checkpoint to Cortex before resetting",
        acceptsArgs: true,
        handler: checkpointHandler,
      });

      api.registerCommand({
        name: "sleep",
        description: "Mark the current session as cleanly ended (clears recovery warning state)",
        acceptsArgs: false,
        handler: async () => {
          try {
            await sessionState.clear();
            return {
              text: [
                `**Session ended cleanly.**`,
                ``,
                `Cortex will not show a recovery warning when you start your next session.`,
                `Use \`/checkpoint\` before \`/sleep\` if you want to save a summary of what you were working on.`,
              ].join("\n"),
            };
          } catch (err) {
            return { text: `Failed to mark session clean: ${String(err)}` };
          }
        },
      });

      api.logger.debug?.("Cortex commands registered: /audit, /checkpoint, /sleep");
    }

    // --- Gateway RPC ---

    if (api.registerGatewayMethod) {
      api.registerGatewayMethod("cortex.status", ({ respond }) => {
        const recallSummary = recallMetrics.summary();
        respond(true, {
          version,
          healthy: knowledgeState.lastChecked > 0,
          knowledgeState: {
            hasMemories: knowledgeState.hasMemories,
            totalSessions: knowledgeState.totalSessions,
            maturity: knowledgeState.maturity,
            tier: knowledgeState.pipelineTier,
            lastChecked: knowledgeState.lastChecked,
          },
          recallMetrics: recallSummary,
          retryQueuePending: retryQueue.pending,
          config: {
            autoRecall: config.autoRecall,
            autoCapture: config.autoCapture,
            fileSync: config.fileSync,
            transcriptSync: config.transcriptSync,
            namespace,
          },
        });
      });

      api.logger.debug?.("Cortex RPC registered: cortex.status");
    }

    // --- CLI Commands (terminal-level) ---

    if (api.registerCli) {
      api.registerCli(
        ({ program }) => {
          const cortex = program.command("cortex").description("Cortex memory CLI commands");

          cortex
            .command("status")
            .description("Check Cortex API health and show memory status")
            .action(async () => {
              await userIdReady;

              console.log("Cortex Status Check");
              console.log("=".repeat(50));

              // Health check
              const startHealth = Date.now();
              let healthy = false;
              try {
                healthy = await client.healthCheck();
                const ms = Date.now() - startHealth;
                console.log(`  API Health:     ${healthy ? "OK" : "UNREACHABLE"} (${ms}ms)`);
              } catch {
                console.log(`  API Health:     UNREACHABLE`);
              }

              if (!healthy) {
                console.log("\nAPI is unreachable. Check baseUrl and network connectivity.");
                return;
              }

              // Knowledge
              try {
                const startKnowledge = Date.now();
                const knowledge = await client.knowledge(undefined, userId);
                const ms = Date.now() - startKnowledge;
                console.log(`  Knowledge:      OK (${ms}ms)`);
                console.log(`    Memories:     ${knowledge.total_memories.toLocaleString()}`);
                console.log(`    Sessions:     ${knowledge.total_sessions}`);
                console.log(`    Maturity:     ${knowledge.maturity}`);
              } catch (err) {
                console.log(`  Knowledge:      FAILED — ${String(err)}`);
              }

              // Stats
              try {
                const startStats = Date.now();
                const stats = await client.stats(undefined, userId);
                const ms = Date.now() - startStats;
                console.log(`  Stats:          OK (${ms}ms)`);
                console.log(`    Pipeline:     tier ${stats.pipeline_tier}`);
              } catch (err) {
                console.log(`  Stats:          FAILED — ${String(err)}`);
              }

              // Recall
              try {
                const startRecall = Date.now();
                await client.recall("test", 5000, { limit: 1, userId });
                const ms = Date.now() - startRecall;
                console.log(`  Recall:         OK (${ms}ms)`);
              } catch (err) {
                console.log(`  Recall:         FAILED — ${String(err)}`);
              }

              // Retrieve
              try {
                const startRetrieve = Date.now();
                await client.retrieve("test", 1, "fast", 5000, undefined, { userId });
                const ms = Date.now() - startRetrieve;
                console.log(`  Retrieve:       OK (${ms}ms)`);
              } catch (err) {
                console.log(`  Retrieve:       FAILED — ${String(err)}`);
              }

              console.log("");
              console.log(`  Version:        ${version}`);
              console.log(`  User ID:        ${userId ?? "unknown"}`);
              console.log(`  Base URL:       ${config.baseUrl}`);
              console.log(`  Auto-Recall:    ${config.autoRecall ? "on" : "off"}`);
              console.log(`  Auto-Capture:   ${config.autoCapture ? "on" : "off"}`);
              console.log(`  File Sync:      ${config.fileSync ? "on" : "off"}`);
              console.log(`  Dedupe Window:  ${config.dedupeWindowMinutes > 0 ? `${config.dedupeWindowMinutes}min` : "off"}`);

              // Session activity stats — read from persisted file so CLI process
              // can see stats from the running gateway instance
              const liveStats = loadPersistedStats() ?? sessionStats;
              const totalSkipped = liveStats.savesSkippedDedupe + liveStats.savesSkippedNovelty;
              const avgRecallMemories = liveStats.recallCount > 0
                ? (liveStats.recallMemoriesTotal / liveStats.recallCount).toFixed(1)
                : "0";

              console.log("");
              console.log("Session Activity");
              console.log("-".repeat(50));
              console.log(`  Saves:          ${liveStats.saves}`);
              if (totalSkipped > 0) {
                console.log(`  Skipped:        ${totalSkipped} (${liveStats.savesSkippedDedupe} dedupe, ${liveStats.savesSkippedNovelty} novelty)`);
              }
              console.log(`  Searches:       ${liveStats.searches}`);
              console.log(`  Recalls:        ${liveStats.recallCount}`);
              console.log(`  Avg memories/recall: ${avgRecallMemories}`);
              if (liveStats.recallDuplicatesCollapsed > 0) {
                console.log(`  Duplicates collapsed: ${liveStats.recallDuplicatesCollapsed}`);
              }
            });

          cortex
            .command("memories")
            .description("Show memory count and maturity")
            .action(async () => {
              await userIdReady;

              try {
                const knowledge = await client.knowledge(undefined, userId);
                console.log(`Memories:  ${knowledge.total_memories.toLocaleString()}`);
                console.log(`Sessions:  ${knowledge.total_sessions}`);
                console.log(`Maturity:  ${knowledge.maturity}`);

                if (knowledge.entities.length > 0) {
                  console.log(`\nTop Entities:`);
                  knowledge.entities.slice(0, 10).forEach((e) => {
                    console.log(`  ${e.name} (${e.memory_count} memories, last seen ${e.last_seen})`);
                  });
                }
              } catch (err) {
                console.error(`Failed: ${String(err)}`);
                process.exitCode = 1;
              }
            });

          cortex
            .command("search")
            .description("Search memories from the terminal")
            .argument("<query>", "Search query")
            .option("--limit <n>", "Max results", "10")
            .action(async (query: string, opts: { limit: string }) => {
              await userIdReady;

              try {
                const response = await client.recall(query, config.toolTimeoutMs, {
                  limit: parseInt(opts.limit),
                  userId,
                  queryType: "combined",
                });

                if (!response.memories?.length) {
                  console.log(`No memories found for: "${query}"`);
                  return;
                }

                console.log(`Found ${response.memories.length} memories:\n`);
                response.memories.forEach((m, i) => {
                  console.log(`${i + 1}. [${m.confidence.toFixed(2)}] ${m.content}`);
                  if (m.entities.length > 0) {
                    console.log(`   entities: ${m.entities.join(", ")}`);
                  }
                  console.log("");
                });
              } catch (err) {
                console.error(`Search failed: ${String(err)}`);
                process.exitCode = 1;
              }
            });

          cortex
            .command("config")
            .description("Show current Cortex plugin configuration")
            .action(async () => {
              await userIdReady;
              console.log(`Version:          ${version}`);
              console.log(`Base URL:         ${config.baseUrl}`);
              console.log(`User ID:          ${userId ?? "unknown"}`);
              console.log(`Namespace:        ${namespace}`);
              console.log(`Auto-Recall:      ${config.autoRecall ? "on" : "off"}`);
              console.log(`Auto-Capture:     ${config.autoCapture ? "on" : "off"}`);
              console.log(`File Sync:        ${config.fileSync ? "on" : "off"}`);
              console.log(`Transcript Sync:  ${config.transcriptSync ? "on" : "off"}`);
              console.log(`Recall Limit:     ${config.recallLimit}`);
              console.log(`Recall Timeout:   ${config.recallTimeoutMs}ms`);
              console.log(`Tool Timeout:     ${config.toolTimeoutMs}ms`);
              console.log(`Audit Log:        ${config.auditLog ? "on" : "off"}`);
            });

          cortex
            .command("pair")
            .description("Generate a TooToo pairing code to link your agent")
            .action(async () => {
              await userIdReady;
              if (!userId) {
                console.error("Cannot generate pairing code: user ID not available.");
                process.exitCode = 1;
                return;
              }

              try {
                const { user_code, expires_in } = await client.generatePairingCode(userId);
                const mins = Math.floor(expires_in / 60);
                console.log(`Agent ID:      ${userId}`);
                console.log(`Pairing code:  ${user_code}`);
                console.log(`Expires in:    ${mins} minute${mins !== 1 ? "s" : ""}`);
                console.log("");
                console.log("To link your TooToo account:");
                console.log("  1. Open app.tootoo.io/settings/agents");
                console.log('  2. Click "Connect Agent"');
                console.log("  3. Enter the code above");
              } catch (err) {
                console.error(`Failed to generate pairing code: ${String(err)}`);
                process.exitCode = 1;
              }
            });
          cortex
            .command("reset")
            .description("Permanently delete ALL memories for this agent (irreversible)")
            .option("--yes", "Skip confirmation prompt")
            .action(async (opts: { yes?: boolean }) => {
              await userIdReady;
              if (!userId) {
                console.error("Cannot reset: user ID not available.");
                process.exitCode = 1;
                return;
              }

              // Show what will be deleted
              let memoryCount = 0;
              let sessionCount = 0;
              try {
                const knowledge = await client.knowledge(undefined, userId);
                memoryCount = knowledge.total_memories;
                sessionCount = knowledge.total_sessions;
              } catch {
                // Continue even if we can't get counts
              }

              console.log("");
              console.log("  WARNING: This will permanently delete ALL data for this agent.");
              console.log("");
              console.log(`  Agent ID:   ${userId}`);
              if (memoryCount > 0 || sessionCount > 0) {
                console.log(`  Memories:   ${memoryCount.toLocaleString()}`);
                console.log(`  Sessions:   ${sessionCount}`);
              }
              console.log("");
              console.log("  This includes all memories, facts, suggestions, and graph data.");
              console.log("  Agent links (TooToo pairing) will be preserved.");
              console.log("  This action CANNOT be undone.");
              console.log("");

              if (!opts.yes) {
                const { createInterface } = await import("node:readline");
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const answer = await new Promise<string>((resolve) => {
                  rl.question("  Type 'reset' to confirm: ", resolve);
                });
                rl.close();

                if (answer.trim().toLowerCase() !== "reset") {
                  console.log("\n  Aborted. No data was deleted.");
                  return;
                }
              }

              try {
                const result = await client.forgetUser(userId);
                const d = result.deleted;
                console.log("");
                console.log("  Memory reset complete.");
                console.log("");
                console.log(`  Deleted:`);
                console.log(`    Engraved memories:  ${d.engraved_memories}`);
                console.log(`    Resonated memories: ${d.resonated_memories}`);
                console.log(`    Graph nodes:        ${d.nodes}`);
                console.log(`    Codex suggestions:  ${d.codex_suggestions}`);
                console.log(`    Suppressions:       ${d.codex_suggestion_suppressions}`);
              } catch (err) {
                if (isAbortError(err) && await resetCompletedAfterAbort(client, userId)) {
                  console.log("");
                  console.log("  Memory reset complete.");
                  console.log("");
                  console.log("  The server finished the reset, but the request ended before deletion stats were returned.");
                  return;
                }
                console.error(`\n  Reset failed: ${String(err)}`);
                process.exitCode = 1;
              }
            });
        },
        { commands: ["cortex"] },
      );

      api.logger.debug?.("Cortex CLI registered: openclaw cortex {status,memories,search,config,pair,reset}");
    }

    // --- Services: retry queue, file sync ---

    api.registerService({
      id: "cortex-services",
      start(ctx) {
        if (started) {
          api.logger.debug?.("Cortex services already started, skipping");
          return;
        }
        started = true;

        retryQueue.start();

        // Capture workspaceDir for runtime audit toggle via /audit command
        workspaceDirResolved = ctx.workspaceDir;

        // Initialize audit logger if enabled via config
        if (config.auditLog && ctx.workspaceDir) {
          auditLoggerInner = new AuditLogger(ctx.workspaceDir, api.logger);
          api.logger.debug?.(`Cortex audit log enabled: ${ctx.workspaceDir}/.cortex/audit/`);
        }

        // Derive workspace-scoped namespace when user didn't set one explicitly
        if (!userSetNamespace && ctx.workspaceDir) {
          namespace = deriveNamespace(ctx.workspaceDir);
          api.logger.debug?.(`Cortex namespace: ${namespace}`);
        }

        // Inject Cortex instructions into AGENTS.md (idempotent)
        if (ctx.workspaceDir) {
          void injectAgentInstructions(ctx.workspaceDir, api.logger);
        }

        // File sync (MEMORY.md, daily logs, transcripts)
        if (config.fileSync) {
          const workspaceDir = ctx.workspaceDir;
          if (!workspaceDir) {
            api.logger.warn("Cortex file sync: no workspaceDir, skipping");
          } else {
            const newWatcher = new FileSyncWatcher(
              workspaceDir,
              client,
              namespace,
              api.logger,
              retryQueue,
              { transcripts: config.transcriptSync, captureFilter: config.captureFilter },
              () => userId,
              auditLoggerProxy,
            );
            newWatcher.start();
            watcher = newWatcher;
            api.logger.debug?.("Cortex file sync started");
          }
        }

        api.logger.debug?.("Cortex services started");
      },
      stop() {
        if (!started) return;
        started = false;

        watcher?.stop();
        watcher = null;
        retryQueue.stop();

        const summary = recallMetrics.summary();
        if (summary.count > 0) {
          api.logger.debug?.(
            `Cortex session end — recall latency: p50=${summary.p50}ms p95=${summary.p95}ms (${summary.count} calls)`,
          );
        }
      },
    });
  },
};

export default plugin;
