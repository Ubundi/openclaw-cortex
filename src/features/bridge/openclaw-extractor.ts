import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  parsePassiveExtractorJson,
  type PassiveExtractorInput,
  type PassiveExtractorOutput,
  type PassiveModelExtractor,
} from "./passive.js";

export const PASSIVE_EXTRACTOR_SESSION_KEY = "__cortex_passive_extractor__";
// OpenClaw can surface the same extractor-generated id through either runId or
// sessionId depending on hook context, so keep both marker names on the same
// prefix intentionally.
export const PASSIVE_EXTRACTOR_RUN_ID_PREFIX = "cortex-passive-extractor-";
export const PASSIVE_EXTRACTOR_SESSION_ID_PREFIX = "cortex-passive-extractor-";
export const PASSIVE_EXTRACTOR_PROVENANCE_SOURCE = "cortex_passive_extractor";

type Logger = {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
};

type OpenClawConfigLike = Record<string, unknown>;

type OpenClawRuntimeApi = {
  config?: OpenClawConfigLike;
  runtime?: {
    agent?: {
      runEmbeddedPiAgent?: RunEmbeddedPiAgent;
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

interface EmbeddedExtractorRunParams {
  input: PassiveExtractorInput;
  config?: OpenClawConfigLike;
  timeoutMs: number;
  activeModel?: { provider: string; model: string };
  paths?: {
    rootDir: string;
    sessionFile: string;
    workspaceDir: string;
  };
}

type IsolatedEmbeddedExtractor = (params: EmbeddedExtractorRunParams) => Promise<PassiveExtractorOutput>;
export type PassiveExtractorWorkerLike = Pick<Worker, "once" | "terminate">;
type PassiveExtractorWorkerFactory = (params: EmbeddedExtractorRunParams) => PassiveExtractorWorkerLike;

interface OpenClawPassiveModelExtractorOptions {
  runIsolatedEmbeddedExtractor?: IsolatedEmbeddedExtractor;
  directModelCall?: DirectPassiveModelCall;
  unsafeAllowInProcessEmbeddedRunnerForTests?: boolean;
}

type DirectPassiveModelCall = (params: {
  input: PassiveExtractorInput;
  config?: OpenClawConfigLike;
  modelRef: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<string>;

type JsonCompatible =
  | null
  | boolean
  | number
  | string
  | JsonCompatible[]
  | { [key: string]: JsonCompatible };

export class PassiveExtractorTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`passive extractor timed out after ${timeoutMs}ms`);
    this.name = "PassiveExtractorTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isPassiveExtractorTimeoutError(error: unknown): error is PassiveExtractorTimeoutError {
  return error instanceof PassiveExtractorTimeoutError
    || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "PassiveExtractorTimeoutError");
}

export class PassiveExtractorProviderUnavailableError extends Error {
  readonly provider: string;
  readonly reason: string;

  constructor(provider: string, reason: string, message?: string) {
    super(message ?? `Passive extractor provider unavailable: ${provider} (${reason})`);
    this.name = "PassiveExtractorProviderUnavailableError";
    this.provider = provider;
    this.reason = reason;
  }
}

export function isPassiveExtractorProviderUnavailableError(error: unknown): error is PassiveExtractorProviderUnavailableError {
  return error instanceof PassiveExtractorProviderUnavailableError
    || (typeof error === "object"
      && error !== null
      && (error as { name?: unknown }).name === "PassiveExtractorProviderUnavailableError");
}

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

function normalizeModelRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("/")) return undefined;
  return trimmed;
}

function compactModelPart(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function joinProviderModel(provider: unknown, model: unknown): string | undefined {
  const compactProvider = compactModelPart(provider);
  const compactModel = compactModelPart(model);
  if (!compactProvider || !compactModel) return undefined;
  return compactModel.includes("/") ? compactModel : `${compactProvider}/${compactModel}`;
}

function splitModelRef(modelRef: string | undefined): { provider: string; model: string } | undefined {
  const normalized = normalizeModelRef(modelRef);
  if (!normalized) return undefined;
  const slash = normalized.indexOf("/");
  const provider = normalized.slice(0, slash);
  const model = normalized.slice(slash + 1);
  if (!provider || !model) return undefined;
  return { provider, model };
}

function canonicalDirectProvider(provider: string): string {
  return provider === "bedrock" ? "amazon-bedrock" : provider;
}

function readConfiguredPrimaryModelRef(config: OpenClawConfigLike | undefined): string | undefined {
  const agents = recordValue(config?.agents);
  const defaults = recordValue(agents?.defaults);
  const model = recordValue(defaults?.model);
  const primary = compactModelPart(model?.primary);
  if (primary?.includes("/")) return primary;
  return joinProviderModel(model?.provider, primary);
}

function resolveExtractorModelRef(input: PassiveExtractorInput, config: OpenClawConfigLike | undefined): string | undefined {
  return normalizeModelRef(input.activeModelRef) ?? readConfiguredPrimaryModelRef(config);
}

function buildDirectExtractorProviderConfig(config: OpenClawConfigLike | undefined): OpenClawConfigLike | undefined {
  const models = recordValue(config?.models);
  const providers = recordValue(models?.providers);
  if (!providers) return undefined;
  return {
    models: {
      providers,
    },
  };
}

function forcePrimaryModel(config: OpenClawConfigLike, modelRef: string | undefined): OpenClawConfigLike {
  const normalized = normalizeModelRef(modelRef);
  if (!normalized) return config;

  const agents = recordValue(config.agents);
  const defaults = recordValue(agents?.defaults);
  return {
    ...config,
    agents: {
      ...(agents ?? {}),
      defaults: {
        ...(defaults ?? {}),
        model: { primary: normalized, fallbacks: [] },
      },
    },
  };
}

export function isPassiveExtractorSessionPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "ENOENT";
}

async function prepareExtractorPaths(runSuffix: number): Promise<{
  rootDir: string;
  sessionFile: string;
  workspaceDir: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-passive-"));
  const workspaceDir = join(rootDir, "workspace");
  const sessionDir = join(rootDir, "sessions");

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  return {
    rootDir,
    workspaceDir,
    sessionFile: join(sessionDir, `cortex-passive-extractor-${runSuffix}.jsonl`),
  };
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

export function buildModelOnlyExtractorConfig(
  config: OpenClawConfigLike | undefined,
  activeModelRef?: string,
): OpenClawConfigLike | undefined {
  if (!config) return undefined;
  const next: OpenClawConfigLike = forcePrimaryModel({ ...config }, activeModelRef);

  if (recordValue(next.tools)) {
    next.tools = stripToolPolicy(next.tools);
  }

  const agents = recordValue(next.agents);
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
      reject(new PassiveExtractorTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function isPassiveExtractorEvent(event: {
  sessionKey?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  inputProvenance?: unknown;
}): boolean {
  const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const runId = typeof event.runId === "string" ? event.runId : "";
  const provenance = recordValue(event.inputProvenance);
  const source = typeof provenance?.source === "string" ? provenance.source : "";
  return sessionKey === PASSIVE_EXTRACTOR_SESSION_KEY
    || sessionId === PASSIVE_EXTRACTOR_SESSION_KEY
    || runId.startsWith(PASSIVE_EXTRACTOR_RUN_ID_PREFIX)
    || sessionId.startsWith(PASSIVE_EXTRACTOR_SESSION_ID_PREFIX)
    || source === PASSIVE_EXTRACTOR_PROVENANCE_SOURCE;
}

function buildDirectExtractorUserPrompt(input: PassiveExtractorInput): string {
  return [
    "CONVERSATION_WINDOW_JSON:",
    JSON.stringify({
      messages: input.messages,
      max_candidates: input.maxCandidates,
    }, null, 2),
  ].join("\n");
}

function normalizeSecretInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const envMatch = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  if (envMatch) return process.env[envMatch[1]]?.trim() || undefined;
  return trimmed;
}

function providerConfig(config: OpenClawConfigLike | undefined, provider: string): Record<string, unknown> | undefined {
  const models = recordValue(config?.models);
  const providers = recordValue(models?.providers);
  if (!providers) return undefined;
  const canonical = canonicalDirectProvider(provider);
  const direct = recordValue(providers[provider]) ?? recordValue(providers[canonical]);
  if (direct) return direct;
  const normalized = canonical.toLowerCase();
  for (const [key, value] of Object.entries(providers)) {
    if (key.toLowerCase() === normalized) return recordValue(value);
  }
  return undefined;
}

function configuredModel(config: OpenClawConfigLike | undefined, provider: string, modelId: string): Record<string, unknown> | undefined {
  const providerCfg = providerConfig(config, provider);
  const models = Array.isArray(providerCfg?.models) ? providerCfg.models : [];
  return models
    .map(recordValue)
    .find((model) => typeof model?.id === "string" && model.id.toLowerCase() === modelId.toLowerCase());
}

function defaultApiForProvider(provider: string): string | undefined {
  if (provider === "amazon-bedrock" || provider === "bedrock") return "bedrock-converse-stream";
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "openai-codex") return "openai-codex-responses";
  if (provider === "openai") return "openai-responses";
  if (
    provider === "openrouter"
    || provider === "vercel-ai-gateway"
    || provider === "xai"
    || provider === "groq"
    || provider === "mistral"
    || provider === "zai"
  ) return "openai-completions";
  if (provider === "minimax") return "anthropic-messages";
  if (provider === "google") return "google-generative-ai";
  if (provider === "google-vertex") return "google-vertex";
  return undefined;
}

function defaultBaseUrlForProvider(provider: string): string | undefined {
  if (provider === "amazon-bedrock" || provider === "bedrock") {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
    return `https://bedrock-runtime.${region}.amazonaws.com`;
  }
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openai-codex") return "https://chatgpt.com/backend-api";
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "vercel-ai-gateway") return "https://ai-gateway.vercel.sh/v1";
  if (provider === "xai") return "https://api.x.ai/v1";
  if (provider === "groq") return "https://api.groq.com/openai/v1";
  if (provider === "mistral") return "https://api.mistral.ai/v1";
  if (provider === "google") return "https://generativelanguage.googleapis.com/v1beta";
  if (provider === "google-vertex") return "https://{location}-aiplatform.googleapis.com";
  if (provider === "zai") return "https://api.z.ai/api/coding/paas/v4";
  if (provider === "minimax") return "https://api.minimax.io/anthropic";
  return undefined;
}

async function resolveDirectModel(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfigLike;
  piAi: Record<string, unknown>;
}): Promise<Record<string, unknown> | undefined> {
  const getModel = typeof params.piAi.getModel === "function"
    ? params.piAi.getModel as (provider: string, modelId: string) => Record<string, unknown>
    : undefined;
  if (getModel) {
    try {
      const knownModel = getModel(params.provider, params.modelId);
      if (knownModel) return knownModel;
    } catch {
      // Fall through to configured/custom model metadata.
    }
  }

  const configured = configuredModel(params.config, params.provider, params.modelId);
  const providerCfg = providerConfig(params.config, params.provider);
  const api = typeof configured?.api === "string"
    ? configured.api
    : typeof providerCfg?.api === "string"
      ? providerCfg.api
      : defaultApiForProvider(params.provider);
  const baseUrl = typeof configured?.baseUrl === "string"
    ? configured.baseUrl
    : typeof providerCfg?.baseUrl === "string"
      ? providerCfg.baseUrl
      : defaultBaseUrlForProvider(params.provider);
  if (!api || !baseUrl) {
    throw new PassiveExtractorProviderUnavailableError(params.provider, "unsupported_provider");
  }

  return {
    id: params.modelId,
    name: typeof configured?.name === "string" ? configured.name : params.modelId,
    api,
    provider: params.provider,
    baseUrl,
    reasoning: typeof configured?.reasoning === "boolean" ? configured.reasoning : false,
    input: Array.isArray(configured?.input) ? configured.input : ["text"],
    cost: recordValue(configured?.cost) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: typeof configured?.contextWindow === "number" ? configured.contextWindow : 128_000,
    maxTokens: typeof configured?.maxTokens === "number" ? configured.maxTokens : 4_096,
    ...(recordValue(configured?.compat) ? { compat: configured?.compat } : {}),
  };
}

function resolveDirectApiKey(config: OpenClawConfigLike | undefined, provider: string, piAi: Record<string, unknown>): string | undefined {
  const providerCfg = providerConfig(config, provider);
  const configured = normalizeSecretInput(providerCfg?.apiKey);
  if (configured) return configured;
  const getEnvApiKey = typeof piAi.getEnvApiKey === "function"
    ? piAi.getEnvApiKey as (provider: string) => string | { apiKey?: string } | null
    : undefined;
  const envKey = getEnvApiKey?.(provider);
  if (typeof envKey === "string") return normalizeSecretInput(envKey);
  return normalizeSecretInput(envKey?.apiKey);
}

function extractAssistantText(message: unknown): string {
  const content = Array.isArray((message as { content?: unknown })?.content)
    ? (message as { content: unknown[] }).content
    : [];
  return content
    .map((block) => {
      const typed = recordValue(block);
      return typed?.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

type PiAiLike = Record<string, unknown>;
type PiAiLoader = () => Promise<PiAiLike>;

export function createPiAiDirectModelCall(
  loadPiAi: PiAiLoader = async () => await import("@mariozechner/pi-ai") as PiAiLike,
): DirectPassiveModelCall {
  return async ({ input, config, modelRef, timeoutMs, signal }) => {
    const modelParts = splitModelRef(modelRef);
    if (!modelParts) throw new Error("passive extractor model ref unavailable");
    const provider = canonicalDirectProvider(modelParts.provider);
    let piAi: PiAiLike;
    try {
      piAi = await loadPiAi();
    } catch (err) {
      throw new PassiveExtractorProviderUnavailableError(
        provider,
        "pi_ai_unavailable",
        `Unable to load @mariozechner/pi-ai for passive extraction: ${String(err)}`,
      );
    }
    const completeSimple = typeof piAi.completeSimple === "function"
      ? piAi.completeSimple as (model: unknown, context: unknown, options?: Record<string, unknown>) => Promise<unknown>
      : undefined;
    if (!completeSimple) throw new PassiveExtractorProviderUnavailableError(provider, "pi_ai_complete_simple_unavailable");
    const model = await resolveDirectModel({
      provider,
      modelId: modelParts.model,
      config,
      piAi,
    });
    if (!model) throw new Error(`No direct model metadata for provider "${provider}"`);

    const apiKey = resolveDirectApiKey(config, provider, piAi);
    if (provider !== "amazon-bedrock" && !apiKey) {
      throw new Error(`No API key resolved for provider "${provider}"`);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const message = await withTimeout(completeSimple(
        model,
        {
          systemPrompt: input.prompt,
          tools: [],
          messages: [{
            role: "user",
            content: buildDirectExtractorUserPrompt(input),
            timestamp: Date.now(),
          }],
        },
        {
          signal: controller.signal,
          maxTokens: input.maxOutputTokens,
          temperature: 0,
          ...(apiKey ? { apiKey } : {}),
        },
      ), timeoutMs, controller);
      const stopReason = (message as { stopReason?: unknown })?.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        throw new Error(String((message as { errorMessage?: unknown })?.errorMessage ?? "passive extractor provider failed"));
      }
      return extractAssistantText(message);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

export async function runEmbeddedPassiveExtractorInProcess(
  params: EmbeddedExtractorRunParams,
  runEmbeddedPiAgent: RunEmbeddedPiAgent,
  logger: Logger,
): Promise<PassiveExtractorOutput> {
  const { input, config, timeoutMs, activeModel } = params;
  const startedAt = Date.now();
  let rootDir: string | undefined;
  try {
    const runSuffix = Date.now();
    const preparedPaths = params.paths ?? await prepareExtractorPaths(runSuffix);
    rootDir = params.paths ? undefined : preparedPaths.rootDir;
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
      sessionId: `cortex-passive-extractor-${runSuffix}`,
      sessionKey: PASSIVE_EXTRACTOR_SESSION_KEY,
      sessionFile: preparedPaths.sessionFile,
      workspaceDir: preparedPaths.workspaceDir,
      config,
      prompt,
      timeoutMs,
      runId: `cortex-passive-extractor-${runSuffix}`,
      inputProvenance: { source: PASSIVE_EXTRACTOR_PROVENANCE_SOURCE },
      abortSignal: controller.signal,
      authProfileIdSource: "auto",
      disableTools: true,
      disableMessageTool: true,
      requireExplicitMessageTarget: true,
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [], version: 0 },
      ...(activeModel ? activeModel : {}),
      streamParams: {
        maxTokens: input.maxOutputTokens,
        temperature: 0,
      },
    }), timeoutMs, controller);

    const text = collectText(result.payloads);
    if (!text) {
      logger.debug?.(`Cortex bridge: passive extractor_completed durationMs=${Date.now() - startedAt} candidateCount=0`);
      return { candidates: [] };
    }
    const parsed = parsePassiveExtractorJson(text);
    logger.debug?.(`Cortex bridge: passive extractor_completed durationMs=${Date.now() - startedAt} candidateCount=${parsed.candidates.length}`);
    return parsed;
  } catch (err) {
    if (isPassiveExtractorTimeoutError(err)) {
      logger.debug?.(`Cortex bridge: passive extractor_timeout durationMs=${Date.now() - startedAt} timeoutMs=${err.timeoutMs} model=${input.activeModelRef ?? "default"}`);
    } else if (isPassiveExtractorSessionPathError(err)) {
      logger.debug?.(`Cortex bridge: passive extractor_session_path_error code=ENOENT durationMs=${Date.now() - startedAt}`);
    }
    throw err;
  } finally {
    if (rootDir) {
      try {
        await rm(rootDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only; extraction is already fail-closed.
      }
    }
  }
}

function deserializeWorkerError(error: { name?: unknown; message?: unknown; code?: unknown; timeoutMs?: unknown }): Error {
  const message = typeof error.message === "string" ? error.message : "passive extractor worker failed";
  if (error.name === "PassiveExtractorTimeoutError" && typeof error.timeoutMs === "number") {
    return new PassiveExtractorTimeoutError(error.timeoutMs);
  }
  const result = error.name === "SyntaxError" ? new SyntaxError(message) : new Error(message);
  result.name = typeof error.name === "string" ? error.name : result.name;
  if (typeof error.code === "string") {
    (result as Error & { code?: string }).code = error.code;
  }
  return result;
}

function runtimeEmbeddedRunner(api: OpenClawRuntimeApi): RunEmbeddedPiAgent | undefined {
  return api.runtime?.agent?.runEmbeddedPiAgent ?? api.runtime?.agent?.runEmbeddedAgent;
}

function toWorkerDataValue(value: unknown, seen = new WeakSet<object>()): JsonCompatible | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.source;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value.map((item) => toWorkerDataValue(item, seen) ?? null);
  }
  if (typeof value === "object") {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const output: Record<string, JsonCompatible> = {};
    for (const key of Object.keys(value)) {
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      const sanitized = toWorkerDataValue(child, seen);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  }
  return undefined;
}

export function buildEmbeddedExtractorWorkerData(params: EmbeddedExtractorRunParams): EmbeddedExtractorRunParams {
  return {
    ...params,
    input: toWorkerDataValue(params.input) as unknown as PassiveExtractorInput,
    config: toWorkerDataValue(params.config) as unknown as OpenClawConfigLike | undefined,
    activeModel: toWorkerDataValue(params.activeModel) as unknown as { provider: string; model: string } | undefined,
    paths: toWorkerDataValue(params.paths) as unknown as EmbeddedExtractorRunParams["paths"],
  };
}

export function createWorkerIsolatedEmbeddedExtractor(
  workerFactory: PassiveExtractorWorkerFactory = (params) => new Worker(new URL("./passive-extractor-worker.js", import.meta.url), {
    workerData: params,
  }),
): IsolatedEmbeddedExtractor {
  return async (params: EmbeddedExtractorRunParams): Promise<PassiveExtractorOutput> => {
    const ownsPaths = !params.paths;
    const paths = params.paths ?? await prepareExtractorPaths(Date.now());
    try {
      return await new Promise<PassiveExtractorOutput>((resolve, reject) => {
        const worker = workerFactory(buildEmbeddedExtractorWorkerData({ ...params, paths }));
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          void worker.terminate();
          reject(new PassiveExtractorTimeoutError(params.timeoutMs));
        }, params.timeoutMs);

        worker.once("message", (message: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          void worker.terminate();
          const typed = message as { ok?: boolean; output?: PassiveExtractorOutput; error?: Record<string, unknown> };
          if (typed.ok) {
            resolve(typed.output ?? { candidates: [] });
          } else {
            reject(deserializeWorkerError(typed.error ?? {}));
          }
        });

        worker.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          void worker.terminate();
          reject(error);
        });

        worker.once("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (code === 0) {
            resolve({ candidates: [] });
          } else {
            reject(new Error(`passive extractor worker exited with code ${code}`));
          }
        });
      });
    } finally {
      if (ownsPaths) {
        await rm(paths.rootDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

export function createOpenClawPassiveModelExtractor(
  api: OpenClawRuntimeApi,
  logger: Logger,
  options: OpenClawPassiveModelExtractorOptions = {},
): PassiveModelExtractor {
  return async (input: PassiveExtractorInput): Promise<PassiveExtractorOutput> => {
    const config = api.config;
    const modelRef = resolveExtractorModelRef(input, config);
    const embeddedExtractorConfig = buildModelOnlyExtractorConfig(config, modelRef);
    const directExtractorConfig = buildDirectExtractorProviderConfig(config);
    const activeModel = splitModelRef(input.activeModelRef);
    const timeoutMs = Math.min(
      input.timeoutMs,
      api.runtime?.agent?.resolveAgentTimeoutMs?.(config) ?? input.timeoutMs,
    );

    if (options.unsafeAllowInProcessEmbeddedRunnerForTests) {
      const runEmbeddedPiAgent = runtimeEmbeddedRunner(api) ?? await loadRunEmbeddedPiAgent();
      if (!runEmbeddedPiAgent) {
        logger.debug?.("Cortex bridge: passive extractor unavailable reason=openclaw_embedded_runner_missing");
        return { candidates: [] };
      }
      logger.debug?.(`Cortex bridge: passive extractor_called runner=embedded_agent_in_process timeoutMs=${timeoutMs} maxOutputTokens=${input.maxOutputTokens} model=${input.activeModelRef ?? "default"}`);
      return runEmbeddedPassiveExtractorInProcess({
        input,
        config: embeddedExtractorConfig,
        timeoutMs,
        activeModel,
      }, runEmbeddedPiAgent, logger);
    }

    if (!modelRef) {
      logger.debug?.("Cortex bridge: passive extractor unavailable reason=model_ref_unavailable");
      return { candidates: [] };
    }

    logger.info?.(`Cortex bridge: passive_extractor_model_call_started runner=direct_model timeoutMs=${timeoutMs} maxOutputTokens=${input.maxOutputTokens} model=${modelRef}`);
    const text = await (options.directModelCall ?? createPiAiDirectModelCall())({
      input,
      config: directExtractorConfig,
      modelRef,
      timeoutMs,
    });
    if (!text.trim()) return { candidates: [] };
    return parsePassiveExtractorJson(text);
  };
}
