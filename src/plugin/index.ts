import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { version } from "../../package.json" with { type: "json" };
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

export interface KnowledgeState {
  hasMemories: boolean;
  totalSessions: number;
  maturity: "cold" | "warming" | "mature" | "unknown";
  lastChecked: number;
}

export function deriveTier(totalSessions: number): 1 | 2 | 3 {
  if (totalSessions >= 30) return 3;
  if (totalSessions >= 15) return 2;
  return 1;
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
}

interface Logger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => process.env[envVar] ?? "");
}

function resolveConfigEnvVars(raw: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    resolved[key] = typeof value === "string" ? resolveEnvVars(value) : value;
  }
  return resolved;
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
      logger.warn("Cortex health check failed — API may be unreachable");
      return;
    }
    logger.info("Cortex health check passed");
  } catch {
    logger.warn("Cortex health check failed — API may be unreachable");
    return;
  }

  try {
    const knowledge = await client.knowledge(undefined, userId);
    knowledgeState.hasMemories = knowledge.total_memories > 0;
    knowledgeState.totalSessions = knowledge.total_sessions;
    knowledgeState.maturity = knowledge.maturity;
    knowledgeState.lastChecked = Date.now();

    const tier = deriveTier(knowledge.total_sessions);
    logger.info(
      `Cortex knowledge: maturity=${knowledge.maturity}, sessions=${knowledge.total_sessions}, memories=${knowledge.total_memories}, tier=${tier}`,
    );
  } catch {
    logger.debug?.("Cortex knowledge check skipped — endpoint unavailable");
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
  if (api.registerHook) {
    api.registerHook(hookName, handler, metadata);
  } else if (api.on) {
    api.on(hookName, handler);
  } else {
    api.logger.warn(`Cortex: cannot register hook "${hookName}" — no registerHook or on method available`);
  }
}

const plugin = {
  id: "openclaw-cortex",
  name: "Cortex Memory",
  description:
    "Long-term memory powered by Cortex — Auto-Recall, Auto-Capture, and background file sync",
  version,
  kind: "memory" as const,
  configSchema,

  register(api: PluginApi) {
    const raw = api.pluginConfig ?? {};
    const resolved = resolveConfigEnvVars(raw);
    const parsed = CortexConfigSchema.safeParse(resolved);

    if (!parsed.success) {
      api.logger.error(
        "Cortex plugin config invalid:",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      return;
    }

    const config: CortexConfig = parsed.data;
    const client = new CortexClient(config.baseUrl, BAKED_API_KEY);
    const retryQueue = new RetryQueue(api.logger);
    const recallMetrics = new LatencyMetrics();
    const knowledgeState: KnowledgeState = {
      hasMemories: false,
      totalSessions: 0,
      maturity: "unknown",
      lastChecked: 0,
    };

    // Whether the user explicitly set a namespace vs. relying on default
    const userSetNamespace = raw.namespace != null;
    let namespace = config.namespace;
    let started = false;
    let watcher: FileSyncWatcher | null = null;

    // userId: use explicit config value if provided, otherwise load/create a
    // stable UUID persisted at ~/.openclaw/cortex-user-id. Bootstrap is chained
    // off the same promise so it always runs with a resolved userId. The capture
    // handler also awaits userIdReady before firing — user_id is required by the
    // API and sending null/missing would 422.
    let userId: string | undefined = config.userId;
    const userIdReady: Promise<void> = userId
      ? Promise.resolve()
      : loadOrCreateUserId()
          .then((id) => {
            userId = id;
            api.logger.info(`Cortex user ID: ${id}`);
          })
          .catch(() => {
            userId = randomUUID();
            api.logger.warn("Cortex: could not persist user ID, using ephemeral ID for this session");
          });

    if (config.userId) {
      api.logger.info(`Cortex user ID (from config): ${userId}`);
    }

    api.logger.info(`Cortex plugin registered (namespace=${namespace})`);

    // Async health check + knowledge probe — chained after userId resolves
    void userIdReady.then(() => bootstrapClient(client, api.logger, knowledgeState, userId));

    // --- Hooks ---

    // Auto-Recall: inject relevant memories before every agent turn
    registerHookCompat(
      api,
      "before_agent_start",
      createRecallHandler(client, config, api.logger, recallMetrics, knowledgeState, () => userId),
      {
        name: "openclaw-cortex.recall",
        description: "Inject relevant Cortex memories before agent turn",
      },
    );

    // Auto-Capture: extract facts after agent responses
    registerHookCompat(
      api,
      "agent_end",
      createCaptureHandler(client, config, api.logger, retryQueue, knowledgeState, () => userId, userIdReady),
      {
        name: "openclaw-cortex.capture",
        description: "Extract and store facts from conversation after agent turn",
      },
    );

    // --- Agent Tools ---

    if (api.registerTool) {
      api.registerTool({
        name: "cortex_search_memory",
        description: "Search long-term memory for facts, preferences, and past context. Use when you need to recall something the user mentioned before or retrieve stored knowledge.",
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
          },
          required: ["query"],
        },
        async execute(_id, params) {
          const query = String(params.query ?? "");
          const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);

          api.logger.info(`Cortex tool: cortex_search_memory called (query="${query.slice(0, 80)}", limit=${limit})`);

          if (userIdReady) await userIdReady;

          try {
            const response = await client.recall(query, config.recallTimeoutMs, {
              limit,
              userId: userId,
              queryType: "combined",
            });

            if (!response.memories?.length) {
              api.logger.info("Cortex tool: cortex_search_memory returned 0 results");
              return { content: [{ type: "text", text: "No memories found matching that query." }] };
            }

            api.logger.info(`Cortex tool: cortex_search_memory returned ${response.memories.length} memories`);
            const formatted = formatMemories(response.memories);
            return { content: [{ type: "text", text: formatted }] };
          } catch (err) {
            api.logger.warn(`Cortex tool: cortex_search_memory failed: ${String(err)}`);
            return { content: [{ type: "text", text: `Memory search failed: ${String(err)}` }] };
          }
        },
      });

      api.registerTool({
        name: "cortex_save_memory",
        description: "Explicitly save a fact, preference, or piece of information to long-term memory. Use when the user asks you to remember something specific.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The information to save to memory (a fact, preference, or context)",
            },
          },
          required: ["text"],
        },
        async execute(_id, params) {
          const text = String(params.text ?? "");
          if (!text || text.length < 5) {
            return { content: [{ type: "text", text: "Text too short to save as a memory." }] };
          }

          api.logger.info(`Cortex tool: cortex_save_memory called (text="${text.slice(0, 80)}")`);

          if (userIdReady) await userIdReady;

          try {
            const res = await client.remember(text, undefined, undefined, undefined, userId);
            if (knowledgeState && res.memories_created > 0) {
              knowledgeState.hasMemories = true;
            }
            api.logger.info(`Cortex tool: cortex_save_memory created ${res.memories_created} memories, entities: ${res.entities_found.join(", ") || "none"}`);
            return {
              content: [{
                type: "text",
                text: `Saved ${res.memories_created} memory/memories. Entities found: ${res.entities_found.join(", ") || "none"}.`,
              }],
            };
          } catch (err) {
            api.logger.warn(`Cortex tool: cortex_save_memory failed: ${String(err)}`);
            return { content: [{ type: "text", text: `Failed to save memory: ${String(err)}` }] };
          }
        },
      });

      api.logger.info("Cortex agent tools registered: cortex_search_memory, cortex_save_memory");
    }

    // --- Auto-Reply Commands ---

    if (api.registerCommand) {
      api.registerCommand({
        name: "memories",
        description: "Show Cortex memory status or search memories",
        acceptsArgs: true,
        handler: async (ctx) => {
          if (userIdReady) await userIdReady;

          const query = ctx.args?.trim();

          // No args — show status
          if (!query) {
            try {
              const knowledge = await client.knowledge(undefined, userId);
              const tier = deriveTier(knowledge.total_sessions);
              const recallSummary = recallMetrics.summary();
              const lines = [
                `**Cortex Memory Status**`,
                `- Memories: ${knowledge.total_memories}`,
                `- Sessions: ${knowledge.total_sessions}`,
                `- Maturity: ${knowledge.maturity}`,
                `- Tier: ${tier}`,
                `- Recall latency: ${recallSummary.count > 0 ? `p50=${recallSummary.p50}ms, p95=${recallSummary.p95}ms (${recallSummary.count} samples)` : "no samples yet"}`,
                `- Retry queue: ${retryQueue.pending} pending`,
              ];
              return { text: lines.join("\n") };
            } catch (err) {
              return { text: `Cortex status check failed: ${String(err)}` };
            }
          }

          // With args — search memories
          try {
            const response = await client.recall(query, config.recallTimeoutMs, {
              limit: config.recallLimit,
              userId,
              queryType: "combined",
            });

            if (!response.memories?.length) {
              return { text: `No memories found for: "${query}"` };
            }

            const lines = response.memories.map(
              (m) => `- [${m.confidence.toFixed(2)}] ${m.content}`,
            );
            return { text: `**Memories matching "${query}":**\n${lines.join("\n")}` };
          } catch (err) {
            return { text: `Memory search failed: ${String(err)}` };
          }
        },
      });

      api.logger.info("Cortex command registered: /memories");
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
            tier: deriveTier(knowledgeState.totalSessions),
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

      api.logger.info("Cortex RPC registered: cortex.status");
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

        // Derive workspace-scoped namespace when user didn't set one explicitly
        if (!userSetNamespace && ctx.workspaceDir) {
          namespace = deriveNamespace(ctx.workspaceDir);
          api.logger.info(`Cortex namespace auto-derived from workspace: ${namespace}`);
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
              { transcripts: config.transcriptSync },
              () => userId,
            );
            newWatcher.start();
            watcher = newWatcher;
            api.logger.info("Cortex file sync started");
          }
        }

        api.logger.info("Cortex services started");
      },
      stop() {
        if (!started) return;
        started = false;

        watcher?.stop();
        watcher = null;
        retryQueue.stop();

        const summary = recallMetrics.summary();
        if (summary.count > 0) {
          api.logger.info(
            `Cortex recall latency (${summary.count} samples): p50=${summary.p50}ms p95=${summary.p95}ms p99=${summary.p99}ms`,
          );
        }
      },
    });
  },
};

export default plugin;
