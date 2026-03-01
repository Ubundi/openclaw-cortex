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
import { AuditLogger } from "../internal/audit/audit-logger.js";

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
      logger.info("Cortex offline — API unreachable");
      return;
    }
  } catch {
    logger.info("Cortex offline — API unreachable");
    return;
  }

  try {
    const knowledge = await client.knowledge(undefined, userId);
    knowledgeState.hasMemories = knowledge.total_memories > 0;
    knowledgeState.totalSessions = knowledge.total_sessions;
    knowledgeState.maturity = knowledge.maturity;
    knowledgeState.lastChecked = Date.now();

    logger.info(
      `Cortex connected — ${knowledge.total_memories.toLocaleString()} memories, ${knowledge.total_sessions} sessions (${knowledge.maturity})`,
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

    // userId: use explicit config value if provided, otherwise resolved lazily
    // in start() to avoid filesystem/network work during plugin install/update.
    // The capture handler awaits userIdReady before firing — user_id is required
    // by the API and sending null/missing would 422.
    let userId: string | undefined = config.userId;
    let userIdReady: Promise<void> = config.userId ? Promise.resolve() : new Promise(() => {});
    // Replaced with a real promise in start() — handlers that run before start()
    // will block indefinitely (which is fine, they shouldn't fire during install).

    api.logger.info(`Cortex v${version} ready`);

    // --- Hooks ---

    // Auto-Recall: inject relevant memories before every agent turn
    registerHookCompat(
      api,
      "before_agent_start",
      createRecallHandler(client, config, api.logger, recallMetrics, knowledgeState, () => userId, auditLoggerProxy),
      {
        name: "openclaw-cortex.recall",
        description: "Inject relevant Cortex memories before agent turn",
      },
    );

    // Auto-Capture: extract facts after agent responses
    registerHookCompat(
      api,
      "agent_end",
      createCaptureHandler(client, config, api.logger, retryQueue, knowledgeState, () => userId, userIdReady, sessionId, auditLoggerProxy),
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

          if (userIdReady) await userIdReady;

          api.logger.debug?.(`Cortex search: "${query.slice(0, 80)}" (limit=${limit})`);

          void auditLoggerProxy.log({
            feature: "tool-search-memory",
            method: "POST",
            endpoint: "/v1/recall",
            payload: query,
            userId,
          });

          try {
            const response = await client.recall(query, config.toolTimeoutMs, {
              limit,
              userId: userId,
              queryType: "combined",
            });

            if (!response.memories?.length) {
              return { content: [{ type: "text", text: "No memories found matching that query." }] };
            }

            api.logger.debug?.(`Cortex search returned ${response.memories.length} memories`);
            const formatted = formatMemories(response.memories);
            return { content: [{ type: "text", text: formatted }] };
          } catch (err) {
            api.logger.warn(`Cortex search failed: ${String(err)}`);
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

          if (userIdReady) await userIdReady;

          api.logger.debug?.(`Cortex save: "${text.slice(0, 80)}"`);

          void auditLoggerProxy.log({
            feature: "tool-save-memory",
            method: "POST",
            endpoint: "/v1/remember",
            payload: text,
            sessionId,
            userId,
          });

          try {
            const res = await client.remember(text, sessionId, undefined, new Date().toISOString(), userId);
            if (knowledgeState && res.memories_created > 0) {
              knowledgeState.hasMemories = true;
            }
            api.logger.debug?.(`Cortex saved ${res.memories_created} memories`);
            const parts = [`Saved ${res.memories_created} memory/memories.`];
            if (res.entities_found.length) parts.push(`Entities: ${res.entities_found.join(", ")}.`);
            if (res.facts.length) parts.push(`Facts: ${res.facts.join("; ")}.`);
            if (res.emotions.length) parts.push(`Emotions: ${res.emotions.join(", ")}.`);
            if (res.values.length) parts.push(`Values: ${res.values.join(", ")}.`);
            if (res.beliefs.length) parts.push(`Beliefs: ${res.beliefs.join("; ")}.`);
            if (res.insights.length) parts.push(`Insights: ${res.insights.join("; ")}.`);
            return {
              content: [{
                type: "text",
                text: parts.join(" "),
              }],
            };
          } catch (err) {
            api.logger.warn(`Cortex save failed: ${String(err)}`);
            return { content: [{ type: "text", text: `Failed to save memory: ${String(err)}` }] };
          }
        },
      });

      api.logger.debug?.("Cortex tools registered: cortex_search_memory, cortex_save_memory");
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
          void auditLoggerProxy.log({
            feature: "command-memories",
            method: "POST",
            endpoint: "/v1/recall",
            payload: query,
            userId,
          });

          try {
            const response = await client.recall(query, config.toolTimeoutMs, {
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

      api.registerCommand({
        name: "audit",
        description: "Toggle or check Cortex audit log (records all data sent to Cortex)",
        acceptsArgs: true,
        handler: (ctx) => {
          const arg = ctx.args?.trim().toLowerCase();

          if (arg === "on") {
            if (!workspaceDirResolved) {
              return { text: "Cannot enable audit log — no workspace directory available." };
            }
            if (auditLoggerInner) {
              return { text: `Audit log is already on.\nLog path: ${workspaceDirResolved}/.cortex/audit/` };
            }
            auditLoggerInner = new AuditLogger(workspaceDirResolved, api.logger);
            api.logger.info(`Cortex audit log enabled via command: ${workspaceDirResolved}/.cortex/audit/`);
            return { text: `Audit log enabled.\nLog path: ${workspaceDirResolved}/.cortex/audit/` };
          }

          if (arg === "off") {
            if (!auditLoggerInner) {
              return { text: "Audit log is already off." };
            }
            auditLoggerInner = undefined;
            api.logger.info("Cortex audit log disabled via command");
            return { text: "Audit log disabled. Existing log files are preserved." };
          }

          // No args — show status
          const status = auditLoggerInner ? "on" : "off";
          const lines = [
            `**Cortex Audit Log**`,
            `- Status: ${status}`,
            `- Config default: ${config.auditLog ? "on" : "off"}`,
          ];
          if (workspaceDirResolved) {
            lines.push(`- Log path: ${workspaceDirResolved}/.cortex/audit/`);
          }
          lines.push("", "Usage: `/audit on` · `/audit off`");
          return { text: lines.join("\n") };
        },
      });

      api.logger.debug?.("Cortex commands registered: /memories, /audit");
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

      api.logger.debug?.("Cortex RPC registered: cortex.status");
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

        // Resolve userId now that we're in an actual session (not install/update).
        // This avoids filesystem + network work during plugin install/update.
        if (!config.userId) {
          userIdReady = loadOrCreateUserId()
            .then((id) => {
              userId = id;
              api.logger.debug?.(`Cortex user ID: ${id}`);
            })
            .catch(() => {
              userId = randomUUID();
              api.logger.warn("Cortex: could not persist user ID, using ephemeral ID for this session");
            });
        }

        // Health check + knowledge probe — runs after userId resolves
        void userIdReady.then(() => bootstrapClient(client, api.logger, knowledgeState, userId));

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
