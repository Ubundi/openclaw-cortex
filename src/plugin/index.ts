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
import { injectAgentInstructions } from "../internal/agent-instructions.js";
import { createCheckpointHandler } from "../features/checkpoint/handler.js";
import { createHeartbeatHandler } from "../features/heartbeat/handler.js";
import {
  buildSessionSummaryFromMessages,
  formatRecoveryContext,
  SessionStateStore,
} from "../internal/session/session-state.js";

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
    const parsed = CortexConfigSchema.safeParse(raw);

    if (!parsed.success) {
      api.logger.error(
        "Cortex plugin config invalid:",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      return;
    }

    // BUILD_API_KEY must be injected into dist at build/publish time.
    // If the placeholder is still present, Cortex calls will all fail at runtime.
    // Keep unit tests working by allowing placeholder in test environment only.
    const hasInjectedApiKey = BAKED_API_KEY !== "__OPENCLAW_API_KEY__";
    if (!hasInjectedApiKey) {
      api.logger.error(
        "Cortex plugin misconfigured: build-time API key placeholder detected. Rebuild with BUILD_API_KEY=... npm run build, or install the published package.",
      );
      if (process.env.NODE_ENV !== "test") {
        return;
      }
    }

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

          await userIdReady;

          api.logger.debug?.(`Cortex search: "${query.slice(0, 80)}" (limit=${limit})`);

          void auditLoggerProxy.log({
            feature: "tool-search-memory",
            method: "POST",
            endpoint: "/v1/recall",
            payload: query,
            userId,
          });

          try {
            const doRecall = async (attempt = 0): ReturnType<typeof client.recall> => {
              try {
                return await client.recall(query, config.toolTimeoutMs, {
                  limit,
                  userId: userId,
                  queryType: "combined",
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

          await userIdReady;
          if (!userId) {
            api.logger.warn("Cortex save: missing user_id");
            return { content: [{ type: "text", text: "Failed to save memory: Cortex ingest requires user_id." }] };
          }

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
            const now = new Date();
            const referenceDate = now.toISOString().slice(0, 10);
            await client.remember(
              text,
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
                text,
                sessionId,
                referenceDate,
                userId,
                "openclaw",
                "OpenClaw",
              );
              if (knowledgeState) {
                knowledgeState.hasMemories = true;
              }
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
        name: "memories",
        description: "Show Cortex memory status or search memories",
        acceptsArgs: true,
        handler: async (ctx) => {
          await userIdReady;

          const query = ctx.args?.trim();

          // No args — show status (retry once on transient 502/503)
          if (!query) {
            const fetchKnowledge = async (attempt = 0): ReturnType<typeof client.knowledge> => {
              try {
                return await client.knowledge(undefined, userId);
              } catch (err) {
                if (attempt < 1 && /50[23]/.test(String(err))) {
                  await new Promise((r) => setTimeout(r, 2000));
                  return fetchKnowledge(attempt + 1);
                }
                throw err;
              }
            };

            try {
              const knowledge = await fetchKnowledge();
              // Refresh cached tier from /v1/stats alongside the knowledge check
              try {
                const stats = await client.stats(undefined, userId);
                knowledgeState.pipelineTier = stats.pipeline_tier;
              } catch {}
              const recallSummary = recallMetrics.summary();
              const lines = [
                `**Cortex Memory Status**`,
                ``,
                `- Memories: **${knowledge.total_memories.toLocaleString()}** stored facts, entities, and insights`,
                `- Sessions: **${knowledge.total_sessions}** conversation sessions ingested`,
                `- Maturity: **${knowledge.maturity}** ${knowledge.maturity === "cold" ? "(not enough data yet for high-quality recall)" : knowledge.maturity === "warming" ? "(building up — recall quality improving)" : "(fully indexed — best recall quality)"}`,
                `- Pipeline tier: **${knowledgeState.pipelineTier}** ${knowledgeState.pipelineTier === 1 ? "(basic)" : knowledgeState.pipelineTier === 2 ? "(enhanced)" : "(full extraction)"}`,
                `- Recall latency: ${recallSummary.count > 0 ? `p50=${recallSummary.p50}ms, p95=${recallSummary.p95}ms (${recallSummary.count} samples)` : "no samples yet"}`,
                `- Retry queue: ${retryQueue.pending} pending`,
                ``,
                `Search memories: \`/memories <query>\``,
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

      api.registerCommand({
        name: "cortex",
        description: "Display agent ID and generate TooToo pairing code",
        acceptsArgs: true,
        handler: async (ctx) => {
          const sub = ctx.args?.trim().toLowerCase();

          // Only "id" subcommand for now; bare /cortex shows help
          if (sub && sub !== "id") {
            return { text: `Unknown subcommand: ${sub}\nUsage: \`/cortex id\`` };
          }

          if (!sub) {
            return {
              text: [
                `**Cortex Agent Commands**`,
                ``,
                `\`/cortex id\` — Show your agent ID and generate a one-time pairing code to link your TooToo account`,
                ``,
                `Linking lets codex suggestions extracted from your agent conversations appear in your TooToo feed.`,
              ].join("\n"),
            };
          }

          await userIdReady;
          if (!userId) {
            return { text: "Cannot generate pairing code: user ID not available." };
          }

          try {
            const { user_code, expires_in } = await client.generatePairingCode(userId);
            const mins = Math.floor(expires_in / 60);
            return {
              text: [
                `**Agent ID:** \`${userId}\``,
                ``,
                `**Pairing code:** \`${user_code}\``,
                `This code expires in ${mins} minute${mins !== 1 ? "s" : ""} and can only be used once.`,
                ``,
                `**To link your TooToo account:**`,
                `1. Open app.tootoo.io/settings/agents`,
                `2. Click "Connect Agent"`,
                `3. Enter the code above`,
                ``,
                `Once linked, values, beliefs, and insights extracted from your agent conversations will appear in your TooToo codex feed.`,
              ].join("\n"),
            };
          } catch (err) {
            return { text: `Failed to generate pairing code: ${String(err)}` };
          }
        },
      });

      api.logger.debug?.("Cortex commands registered: /memories, /audit, /checkpoint, /sleep, /cortex");
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
