import plugin from "./core/plugin.js";

export default plugin;

// Named exports for testing / advanced usage
export { CortexClient } from "./cortex/client.js";
export { CortexConfigSchema, type CortexConfig } from "./core/config/schema.js";
export { createRecallHandler } from "./features/recall/handler.js";
export { createCaptureHandler } from "./features/capture/handler.js";
export { FileSyncWatcher } from "./features/sync/watcher.js";
export { RetryQueue } from "./shared/queue/retry-queue.js";
export { LatencyMetrics } from "./shared/metrics/latency-metrics.js";
export { formatMemories } from "./features/recall/formatter.js";
export { cleanTranscript, cleanTranscriptChunk } from "./shared/transcript/cleaner.js";
