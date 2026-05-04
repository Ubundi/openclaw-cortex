import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parsePassiveExtractorJson,
  type PassiveExtractorInput,
  type PassiveExtractorOutput,
  type PassiveModelExtractor,
} from "./passive.js";

export const PASSIVE_EXTRACTOR_SESSION_KEY = "__cortex_passive_extractor__";

type Logger = {
  debug?(...args: unknown[]): void;
};

type OpenClawConfigLike = Record<string, unknown>;

type OpenClawRuntimeApi = {
  config?: OpenClawConfigLike;
  runtime?: {
    agent?: {
      runEmbeddedAgent?: RunEmbeddedPiAgent;
      resolveAgentDir?: (config?: OpenClawConfigLike) => string;
      resolveAgentWorkspaceDir?: (config?: OpenClawConfigLike) => string;
      resolveAgentTimeoutMs?: (config?: OpenClawConfigLike) => number;
    };
  };
};

type RunEmbeddedPiAgent = (params: Record<string, unknown>) => Promise<{
  payloads?: Array<{ text?: string; isError?: boolean }>;
}>;

let cachedRunEmbeddedPiAgent: Promise<RunEmbeddedPiAgent | undefined> | undefined;

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((payload) => !payload.isError && typeof payload.text === "string")
    .map((payload) => payload.text ?? "")
    .join("\n")
    .trim();
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function configuredDefaultWorkspace(config: OpenClawConfigLike | undefined): string | undefined {
  const agents = recordValue(config?.agents);
  const defaults = recordValue(agents?.defaults);
  const workspace = defaults?.workspace;
  return typeof workspace === "string" && workspace.trim() ? workspace : undefined;
}

function stripToolPolicy(value: unknown): unknown {
  const tools = recordValue(value);
  if (!tools) return value;
  const next = { ...tools };
  delete next.allow;
  delete next.deny;
  delete next.profile;
  delete next.alsoAllow;
  delete next.byProvider;
  return next;
}

function stripAgentToolPolicy(value: unknown): unknown {
  const agent = recordValue(value);
  if (!agent) return value;
  if (!recordValue(agent.tools)) return agent;
  return {
    ...agent,
    tools: stripToolPolicy(agent.tools),
  };
}

export function buildModelOnlyExtractorConfig(config: OpenClawConfigLike | undefined): OpenClawConfigLike | undefined {
  if (!config) return undefined;
  const next: OpenClawConfigLike = { ...config };

  if (recordValue(config.tools)) {
    next.tools = stripToolPolicy(config.tools);
  }

  const agents = recordValue(config.agents);
  if (agents) {
    const nextAgents: Record<string, unknown> = { ...agents };
    if (recordValue(agents.defaults)) {
      nextAgents.defaults = stripAgentToolPolicy(agents.defaults);
    }
    if (Array.isArray(agents.list)) {
      nextAgents.list = agents.list.map(stripAgentToolPolicy);
    }
    next.agents = nextAgents;
  }

  return next;
}

export async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgent | undefined> {
  cachedRunEmbeddedPiAgent ??= loadRunEmbeddedPiAgentUncached();
  return cachedRunEmbeddedPiAgent;
}

async function loadRunEmbeddedPiAgentUncached(): Promise<RunEmbeddedPiAgent | undefined> {
  const require = createRequire(import.meta.url);
  try {
    const openclawMain = require.resolve("openclaw");
    return await loadRunEmbeddedPiAgentFromOpenClawRoot(dirname(dirname(openclawMain)));
  } catch {
    return undefined;
  }
}

export async function loadRunEmbeddedPiAgentFromOpenClawRoot(openclawRoot: string): Promise<RunEmbeddedPiAgent | undefined> {
  try {
    const embeddedPath = join(openclawRoot, "dist", "plugin-sdk", "agents", "pi-embedded.js");
    const mod = await import(pathToFileURL(embeddedPath).href) as { runEmbeddedPiAgent?: RunEmbeddedPiAgent };
    if (typeof mod.runEmbeddedPiAgent === "function") return mod.runEmbeddedPiAgent;
  } catch {
    // Fall through to hashed bundle discovery below.
  }

  // Older OpenClaw packages ship declarations for plugin-sdk/agents/pi-embedded
  // while the runtime implementation lives in hashed dist bundles. Locate the
  // shipped bundle by its explicit export alias instead of hardcoding the hash.
  try {
    const distDir = join(openclawRoot, "dist");
    const files = await readdir(distDir);
    for (const file of files) {
      if (!/^pi-embedded-.*\.js$/.test(file)) continue;
      const fullPath = join(distDir, file);
      const source = await readFile(fullPath, "utf-8");
      const alias = /\brunEmbeddedPiAgent as ([A-Za-z_$][\w$]*)\b/.exec(source)?.[1];
      if (!alias) continue;
      const mod = await import(pathToFileURL(fullPath).href) as Record<string, unknown>;
      const fn = mod[alias];
      if (typeof fn === "function") return fn as RunEmbeddedPiAgent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`passive extractor timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function createOpenClawPassiveModelExtractor(
  api: OpenClawRuntimeApi,
  logger: Logger,
): PassiveModelExtractor {
  return async (input: PassiveExtractorInput): Promise<PassiveExtractorOutput> => {
    const runEmbeddedPiAgent = api.runtime?.agent?.runEmbeddedAgent ?? await loadRunEmbeddedPiAgent();
    if (!runEmbeddedPiAgent) {
      logger.debug?.("Cortex bridge: passive extractor unavailable reason=openclaw_embedded_runner_missing");
      return { candidates: [] };
    }

    const config = api.config;
    const extractorConfig = buildModelOnlyExtractorConfig(config);
    let tmpDir: string | undefined;
    try {
      const agentDir = api.runtime?.agent?.resolveAgentDir?.(config);
      if (!agentDir) {
        tmpDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-passive-"));
      }
      const workspaceDir = api.runtime?.agent?.resolveAgentWorkspaceDir?.(config)
        ?? configuredDefaultWorkspace(config)
        ?? process.cwd();
      const timeoutMs = Math.min(
        input.timeoutMs,
        api.runtime?.agent?.resolveAgentTimeoutMs?.(config) ?? input.timeoutMs,
      );
      const prompt = [
        input.prompt,
        "",
        "CONVERSATION_WINDOW_JSON:",
        JSON.stringify({
          messages: input.messages,
          max_candidates: input.maxCandidates,
        }, null, 2),
      ].join("\n");

      const controller = new AbortController();
      const result = await withTimeout(runEmbeddedPiAgent({
        sessionId: `cortex-passive-extractor-${Date.now()}`,
        sessionKey: PASSIVE_EXTRACTOR_SESSION_KEY,
        sessionFile: agentDir
          ? join(agentDir, "sessions", `cortex-passive-extractor-${Date.now()}.jsonl`)
          : join(tmpDir!, "session.json"),
        workspaceDir,
        config: extractorConfig,
        prompt,
        timeoutMs,
        runId: `cortex-passive-extractor-${Date.now()}`,
        abortSignal: controller.signal,
        authProfileIdSource: "auto",
        disableTools: true,
        streamParams: {
          maxTokens: input.maxOutputTokens,
          temperature: 0,
        },
      }), timeoutMs, controller);

      const text = collectText(result.payloads);
      if (!text) return { candidates: [] };
      return parsePassiveExtractorJson(text);
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}
