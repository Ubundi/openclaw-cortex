import { CortexConfigSchema, configSchema, type CortexConfig } from "./config.js";
import { CortexClient } from "./client.js";
import { createRecallHandler } from "./hooks/recall.js";
import { createCaptureHandler } from "./hooks/capture.js";
import { FileSyncWatcher } from "./sync/watcher.js";
import { RetryQueue } from "./utils/retry-queue.js";
import { LatencyMetrics } from "./utils/metrics.js";

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
  version: "0.1.0",
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

    api.logger.info("Cortex plugin registered");

    // Auto-Recall: inject relevant memories before every agent turn
    // Includes cold-start detection and latency instrumentation
    api.on("before_agent_start", createRecallHandler(client, config, api.logger, recallMetrics));

    // Auto-Capture: extract facts after agent responses
    // Failed ingestions are queued for retry with exponential backoff
    api.on("agent_end", createCaptureHandler(client, config, api.logger, retryQueue));

    // Retry queue + file sync share a service lifecycle
    api.registerService({
      id: "cortex-services",
      start(ctx) {
        retryQueue.start();

        if (config.fileSync) {
          const workspaceDir = ctx.workspaceDir;
          if (!workspaceDir) {
            api.logger.warn("Cortex file sync: no workspaceDir, skipping");
            return;
          }
          const watcher = new FileSyncWatcher(
            workspaceDir,
            client,
            "openclaw",
            api.logger,
            retryQueue,
          );
          watcher.start();
          // Store on service context for stop
          (this as any)._watcher = watcher;
          api.logger.info("Cortex file sync started");
        }

        api.logger.info("Cortex services started");
      },
      stop() {
        (this as any)._watcher?.stop();
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

// Named exports for testing / advanced usage
export { CortexClient } from "./client.js";
export { CortexConfigSchema, type CortexConfig } from "./config.js";
export { createRecallHandler } from "./hooks/recall.js";
export { createCaptureHandler } from "./hooks/capture.js";
export { FileSyncWatcher } from "./sync/watcher.js";
export { RetryQueue } from "./utils/retry-queue.js";
export { LatencyMetrics } from "./utils/metrics.js";
export { formatMemories } from "./utils/format.js";
