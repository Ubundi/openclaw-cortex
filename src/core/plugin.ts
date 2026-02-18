import { basename } from "node:path";
import { createHash } from "node:crypto";
import { CortexConfigSchema, configSchema, type CortexConfig } from "./config/schema.js";
import { CortexClient } from "../cortex/client.js";
import { createRecallHandler } from "../features/recall/handler.js";
import { createCaptureHandler } from "../features/capture/handler.js";
import { FileSyncWatcher } from "../features/sync/watcher.js";
import { RetryQueue } from "../shared/queue/retry-queue.js";
import { LatencyMetrics } from "../shared/metrics/latency-metrics.js";
import { PeriodicReflect } from "../features/reflect/service.js";

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

const plugin = {
  id: "cortex-memory",
  name: "Cortex Memory",
  description:
    "Long-term memory powered by Cortex — Auto-Recall, Auto-Capture, and background file sync",
  version: "0.2.0",
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
    const client = new CortexClient(config.baseUrl, config.apiKey);
    const retryQueue = new RetryQueue(api.logger);
    const recallMetrics = new LatencyMetrics();
    // Whether the user explicitly set a namespace vs. relying on default
    const userSetNamespace = raw.namespace != null;
    let namespace = config.namespace;

    api.logger.info(`Cortex plugin registered (recallMode=${config.recallMode}, namespace=${namespace})`);

    // Async health check — validate connection early without blocking registration
    client.healthCheck().then((ok) => {
      if (ok) {
        api.logger.info("Cortex health check passed");
      } else {
        api.logger.warn("Cortex health check failed — API may be unreachable");
      }
    });

    // Auto-Recall: inject relevant memories before every agent turn
    api.on("before_agent_start", createRecallHandler(client, config, api.logger, recallMetrics));

    // Auto-Capture: extract facts after agent responses
    api.on("agent_end", createCaptureHandler(client, config, api.logger, retryQueue));

    // Services: retry queue, file sync, periodic reflect
    api.registerService({
      id: "cortex-services",
      start(ctx) {
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
            const watcher = new FileSyncWatcher(
              workspaceDir,
              client,
              namespace,
              api.logger,
              retryQueue,
              { transcripts: config.transcriptSync },
            );
            watcher.start();
            (this as any)._watcher = watcher;
            api.logger.info("Cortex file sync started");
          }
        }

        // Periodic reflect (memory consolidation)
        if (config.reflectIntervalMs > 0) {
          const reflect = new PeriodicReflect(
            client,
            api.logger,
            config.reflectIntervalMs,
          );
          reflect.start();
          (this as any)._reflect = reflect;
          api.logger.info(
            `Cortex periodic reflect started (every ${config.reflectIntervalMs / 1000}s)`,
          );
        }

        api.logger.info("Cortex services started");
      },
      stop() {
        (this as any)._watcher?.stop();
        (this as any)._reflect?.stop();
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
