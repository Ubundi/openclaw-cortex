import type { CortexClient } from "../client.js";
import type { CortexConfig } from "../config.js";
import { formatMemories } from "../utils/format.js";

interface BeforeAgentStartEvent {
  prompt: string;
  messages?: unknown[];
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}

interface BeforeAgentStartResult {
  prependContext?: string;
}

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export function createRecallHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
) {
  return async (
    event: BeforeAgentStartEvent,
    _ctx: AgentContext,
  ): Promise<BeforeAgentStartResult | void> => {
    if (!config.autoRecall) return;

    const prompt = event.prompt?.trim();
    if (!prompt || prompt.length < 5) return;

    try {
      const response = await client.retrieve(
        prompt,
        config.recallTopK,
        "fast",
        config.recallTimeoutMs,
      );

      if (!response.results?.length) return;

      const formatted = formatMemories(response.results);
      if (!formatted) return;

      logger.debug?.(`Cortex recall: ${response.results.length} memories`);
      return { prependContext: formatted };
    } catch (err) {
      // Silent degradation — proceed without memories
      if ((err as Error).name === "AbortError") {
        logger.debug?.("Cortex recall timed out, proceeding without memories");
      } else {
        logger.warn("Cortex recall failed:", err);
      }
      return;
    }
  };
}
