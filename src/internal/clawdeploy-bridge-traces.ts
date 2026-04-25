import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeTargetSection } from "../cortex/client.js";

type Logger = {
  debug?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

export type ClawDeployBridgeTraceStatus = "detected" | "accepted" | "failed";

export interface ClawDeployBridgeTraceEvent {
  requestId: string;
  sessionKey?: string;
  cortexAgentUserId?: string;
  agentUserId?: string;
  targetSection?: BridgeTargetSection;
  status: ClawDeployBridgeTraceStatus;
  detectedAt?: string;
  acceptedAt?: string;
  forwarded?: boolean;
  queuedForRetry?: boolean;
  entriesSent?: number;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface ClawDeployBridgeTraceClient {
  emitBridgeTrace(event: ClawDeployBridgeTraceEvent): void;
}

interface CreateClientOptions {
  baseUrl?: string;
  gatewayToken?: string;
  enabled?: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface ClawDeployBridgeTraceConfig {
  enabled: boolean;
  baseUrl?: string;
  gatewayToken?: string;
}

interface ResolveConfigOptions {
  homeDir?: string;
  readFile?: (path: string) => string;
}

const TRACE_ENDPOINT = "/api/agent/tootoo/bridge-traces";
const DEFAULT_TIMEOUT_MS = 2_000;
const ERROR_MAX_LENGTH = 2_000;
const SENSITIVE_KEY_RE = /(?:api.?key|token|secret|password|authorization|cookie)/i;

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return true;
  return !/^(?:0|false|no|off)$/i.test(value.trim());
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function readTrimmedFile(path: string, readFile: (path: string) => string): string | undefined {
  try {
    return trimOrUndefined(readFile(path));
  } catch {
    return undefined;
  }
}

function redactSensitiveMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).flatMap(([key, value]): [string, unknown][] => {
    if (SENSITIVE_KEY_RE.test(key)) return [];
    if (Array.isArray(value)) {
      return [[key, value.map((item) => (
        item && typeof item === "object" && !Array.isArray(item)
          ? redactSensitiveMetadata(item as Record<string, unknown>) ?? {}
          : item
      ))]];
    }
    if (value && typeof value === "object") {
      return [[key, redactSensitiveMetadata(value as Record<string, unknown>) ?? {}]];
    }
    return [[key, value]];
  });
  return Object.fromEntries(entries);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactBridgeTraceError(error: unknown, privateFragments: string[] = []): string {
  let redacted = String(error);
  redacted = redacted.replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/giu, "$1[REDACTED_TOKEN]");
  redacted = redacted.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gu, "$1[REDACTED_TOKEN]");
  redacted = redacted.replace(/\b(x-api-key|api[_-]?key|token|secret|password)=([^\s,;]+)/giu, "$1=[REDACTED_SECRET]");
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, "[REDACTED_API_KEY]");

  for (const fragment of privateFragments) {
    const trimmed = fragment.trim();
    if (trimmed.length < 4) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(trimmed), "gu"), "[REDACTED_CONTENT]");
  }

  return redacted.slice(0, ERROR_MAX_LENGTH);
}

export function resolveClawDeployBridgeTraceConfig(
  config: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveConfigOptions = {},
): ClawDeployBridgeTraceConfig {
  const home = options.homeDir ?? homedir();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const managedUrlFile = readTrimmedFile(join(home, ".kwanda", "clawdeploy-api-url"), readFile);

  return {
    enabled: isEnabled(config.enableClawDeployBridgeTrace ?? env.ENABLE_CLAWDEPLOY_BRIDGE_TRACE),
    baseUrl:
      trimOrUndefined(config.clawDeployBaseUrl)
      ?? trimOrUndefined(env.CLAWDEPLOY_BASE_URL)
      ?? trimOrUndefined(env.CLAWDEPLOY_API_URL)
      ?? managedUrlFile,
    gatewayToken:
      trimOrUndefined(env.OPENCLAW_GATEWAY_TOKEN)
      ?? trimOrUndefined(env.GATEWAY_TOKEN),
  };
}

export function createClawDeployBridgeTraceClient(options: CreateClientOptions): ClawDeployBridgeTraceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger;
  const baseUrl = trimOrUndefined(options.baseUrl);
  const gatewayToken = trimOrUndefined(options.gatewayToken);
  const enabled = options.enabled ?? true;

  return {
    emitBridgeTrace(event: ClawDeployBridgeTraceEvent): void {
      if (!enabled) {
        logger.debug?.("Cortex bridge trace emission skipped: disabled");
        return;
      }
      if (!baseUrl) {
        logger.debug?.("Cortex bridge trace emission skipped: missing ClawDeploy base URL");
        return;
      }
      if (!gatewayToken) {
        logger.debug?.("Cortex bridge trace emission skipped: missing_gateway_token");
        return;
      }

      const payload = {
        ...event,
        metadata: redactSensitiveMetadata(event.metadata),
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      void fetchImpl(`${normalizeBaseUrl(baseUrl)}${TRACE_ENDPOINT}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            let detail = "";
            try {
              detail = (await response.text()).slice(0, 300);
            } catch {
              // best-effort observability only
            }
            throw new Error(`failed: ${response.status}${detail ? ` ${detail}` : ""}`);
          }
        })
        .catch((err) => {
          logger.warn(`Cortex bridge trace emission failed: ${redactBridgeTraceError(err)}`);
        })
        .finally(() => {
          clearTimeout(timeout);
        });
    },
  };
}
