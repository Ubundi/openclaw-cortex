import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import packageJson from "../../package.json" with { type: "json" };
import { CortexConfigSchema, configSchema, type CortexConfig } from "./config.js";
import { CortexClient } from "../cortex/client.js";
import { createRecallHandler } from "../features/recall/handler.js";
import { createCaptureHandler } from "../features/capture/handler.js";
import { FileSyncWatcher } from "../features/sync/watcher.js";
import { RetryQueue } from "../internal/retry-queue.js";
import { LatencyMetrics } from "../internal/latency-metrics.js";
import { loadOrCreateUserId } from "../internal/user-id.js";
import { BAKED_API_KEY } from "../internal/api-key.js";
import { AuditLogger } from "../internal/audit-logger.js";
import { RecentSaves } from "../internal/dedupe.js";
import { injectAgentInstructions } from "../internal/agent-instructions.js";
import { createHeartbeatHandler } from "../features/heartbeat/handler.js";
import {
  buildSessionSummaryFromMessages,
  formatRecoveryContext,
  SessionStateStore,
} from "../internal/session-state.js";
import type {
  HookMetadata,
  PluginApi,
  Logger,
} from "./types.js";
import { registerCliCommands } from "./cli.js";
import { buildSearchMemoryTool, buildSaveMemoryTool } from "./tools.js";
import { buildCommands } from "./commands.js";

const version = packageJson.version;
const PACKAGE_NAME = packageJson.name;
const STATS_FILE = join(homedir(), ".openclaw", "cortex-session-stats.json");
const UPDATE_CHECK_FILE = join(homedir(), ".openclaw", "cortex-update-check.json");
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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


/**
 * Checks the npm registry for a newer version and logs a hint if available.
 * Throttled to once per 24 hours via a local timestamp file. Fully async
 * and non-blocking — failures are silently ignored.
 */
async function checkForUpdate(logger: Logger): Promise<void> {
  try {
    // Throttle: skip if checked recently
    try {
      const raw = readFileSync(UPDATE_CHECK_FILE, "utf-8");
      const { checkedAt } = JSON.parse(raw);
      if (Date.now() - checkedAt < UPDATE_CHECK_INTERVAL_MS) return;
    } catch { /* first run or corrupt file — continue */ }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(
        `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
        { signal: controller.signal },
      );
      if (!res.ok) return;
      const data = await res.json() as { version?: string };
      const latest = data.version;
      if (latest && latest !== version) {
        logger.info(
          `Cortex: update available ${version} → ${latest} — run \`openclaw install ${PACKAGE_NAME}@latest\` to update`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    // Persist check timestamp (even if no update found)
    writeFileSync(
      UPDATE_CHECK_FILE,
      JSON.stringify({ checkedAt: Date.now(), currentVersion: version }),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Non-fatal — network errors, write errors, etc.
  }
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

const PLUGIN_ID = "openclaw-cortex";

/**
 * Ensures `plugins.allow` in the OpenClaw config includes our plugin id.
 * Without this, the runtime logs a noisy warning about auto-loaded plugins
 * on every startup.
 *
 * Runs once on first registration; idempotent thereafter.
 */
function ensurePluginsAllowlist(logger: Logger): void {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    const existing: string[] = Array.isArray(config.plugins?.allow)
      ? config.plugins.allow
      : [];
    if (existing.includes(PLUGIN_ID)) return;

    if (!config.plugins) config.plugins = {};
    config.plugins.allow = [...existing, PLUGIN_ID];

    let mode: number | undefined;
    try { mode = statSync(configPath).mode & 0o777; } catch { /* ignore */ }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: mode ?? 0o600 });
    logger.info(`Cortex: added "${PLUGIN_ID}" to plugins.allow`);
  } catch {
    // Non-fatal — the warning is cosmetic only
  }
}

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
  id: PLUGIN_ID,
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

    // Ensure our plugin is in the explicit allowlist (suppresses auto-load warning)
    ensurePluginsAllowlist(api.logger);
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
    // Skip when running CLI commands (e.g. `openclaw cortex status`) — the
    // async log races with command output and CLI commands fetch their own data.
    const isCliInvocation = process.argv.some((a) => a === "cortex");
    if (!isCliInvocation) {
      void userIdReady.then(() => bootstrapClient(client, api.logger, knowledgeState, userId));
      void checkForUpdate(api.logger);
    }

    api.logger.info(`Cortex v${version} ready`);

    // Show a getting-started hint on first install or after version upgrade
    if (!isCliInvocation) {
      try {
        const versionFile = join(homedir(), ".openclaw", "cortex-last-version");
        let lastVersion: string | undefined;
        try { lastVersion = readFileSync(versionFile, "utf-8").trim(); } catch { /* first run */ }
        if (lastVersion !== version) {
          api.logger.info("Cortex: run `cortex help` to see available commands");
          writeFileSync(versionFile, version, { encoding: "utf-8", mode: 0o600 });
        }
      } catch { /* non-fatal */ }
    }

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

    // Don't eagerly reset the stats file here — the dual-instance runtime
    // means [plugins] would clobber stats that [gateway] already persisted.
    // In-memory counters start at zero and get persisted on first real activity.

    // --- Agent Tools ---

    const recentSaves = config.dedupeWindowMinutes > 0
      ? new RecentSaves(config.dedupeWindowMinutes)
      : null;

    if (api.registerTool) {
      const toolsDeps = {
        client,
        config,
        logger: api.logger,
        getUserId: () => userId,
        userIdReady,
        sessionId,
        sessionStats,
        persistStats,
        auditLoggerProxy,
        knowledgeState,
        recentSaves,
      };

      api.registerTool(buildSearchMemoryTool(toolsDeps));
      api.registerTool(buildSaveMemoryTool(toolsDeps));

      api.logger.debug?.("Cortex tools registered: cortex_search_memory, cortex_save_memory");
    }

    // --- Auto-Reply Commands ---

    if (api.registerCommand) {
      buildCommands(api.registerCommand.bind(api), {
        client,
        config,
        logger: api.logger,
        getUserId: () => userId,
        userIdReady,
        getLastMessages: () => lastMessages,
        sessionId,
        auditLoggerProxy,
        sessionState,
        getWorkspaceDir: () => workspaceDirResolved,
        getAuditLoggerInner: () => auditLoggerInner,
        setAuditLoggerInner: (l) => { auditLoggerInner = l; },
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
      registerCliCommands(api.registerCli.bind(api), {
        client,
        config,
        version,
        getUserId: () => userId,
        userIdReady,
        getNamespace: () => namespace,
        sessionStats,
        loadPersistedStats,
        isAbortError,
        resetCompletedAfterAbort,
      });

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
