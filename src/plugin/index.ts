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

interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: {
    debug?(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  on(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  registerService(service: {
    id: string;
    start?: (ctx: { workspaceDir?: string }) => void;
    stop?: (ctx: { workspaceDir?: string }) => void;
  }): void;
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

const plugin = {
  id: "cortex-memory",
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
    // off the same promise so it always runs with a resolved userId.
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

    // Auto-Recall: inject relevant memories before every agent turn
    api.on(
      "before_agent_start",
      createRecallHandler(client, config, api.logger, recallMetrics, knowledgeState, () => userId),
    );

    // Auto-Capture: extract facts after agent responses
    api.on(
      "agent_end",
      createCaptureHandler(client, config, api.logger, retryQueue, knowledgeState, () => userId),
    );

    // Services: retry queue, file sync
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
