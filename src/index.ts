import plugin from "./plugin/index.js";

export default plugin;

// Named exports for testing / advanced usage
export { CortexClient } from "./cortex/client.js";
export { CortexConfigSchema, type CortexConfig } from "./plugin/config.js";
export { createRecallHandler } from "./features/recall/handler.js";
export { createCaptureHandler } from "./features/capture/handler.js";
export { RetryQueue } from "./internal/retry-queue.js";
export { LatencyMetrics } from "./internal/latency-metrics.js";
export { formatMemories, formatMemoriesWithStats } from "./features/recall/formatter.js";
export { cleanTranscript, cleanTranscriptChunk } from "./internal/cleaner.js";
