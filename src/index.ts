import plugin from "./plugin/index.js";

export default plugin;

// Named exports for testing / advanced usage
export { CortexClient } from "./adapters/cortex/client.js";
export { CortexConfigSchema, type CortexConfig } from "./plugin/config/schema.js";
export { createRecallHandler } from "./features/recall/handler.js";
export { createCaptureHandler } from "./features/capture/handler.js";
export { FileSyncWatcher } from "./features/sync/watcher.js";
export { RetryQueue } from "./internal/queue/retry-queue.js";
export { LatencyMetrics } from "./internal/metrics/latency-metrics.js";
export { formatMemories } from "./features/recall/formatter.js";
export { cleanTranscript, cleanTranscriptChunk } from "./internal/transcript/cleaner.js";
