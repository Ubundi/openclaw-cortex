import { parentPort, workerData } from "node:worker_threads";
import {
  loadRunEmbeddedPiAgent,
  runEmbeddedPassiveExtractorInProcess,
} from "./openclaw-extractor.js";

// Parent-side bridge logs carry production observability. Keep worker-local
// debug output quiet so extractor text and prompt details never leak.
const logger = {
  debug: () => undefined,
};

function serializeError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return { name: "Error", message: String(error) };
  }
  const typed = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    timeoutMs?: unknown;
  };
  return {
    name: typed.name,
    message: typed.message,
    code: typed.code,
    timeoutMs: typed.timeoutMs,
  };
}

try {
  const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();
  if (!runEmbeddedPiAgent) {
    parentPort?.postMessage({ ok: true, output: { candidates: [] } });
  } else {
    const output = await runEmbeddedPassiveExtractorInProcess(workerData, runEmbeddedPiAgent, logger);
    parentPort?.postMessage({ ok: true, output });
  }
} catch (error) {
  parentPort?.postMessage({ ok: false, error: serializeError(error) });
}
