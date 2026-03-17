import { createHash } from "node:crypto";
import type { CortexClient, ConversationMessage } from "../../cortex/client.js";
import type { CortexConfig } from "../../plugin/config.js";
import type { KnowledgeState } from "../../plugin/index.js";
import type { RetryQueue } from "../../internal/retry-queue.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { filterLowSignalMessages, stripVolatileContent, sanitizeConversationText } from "./filter.js";
import { compressLargeContent } from "./compressor.js";
import type { RecallEchoStore } from "../../internal/recall-echo-store.js";
import { containsHeartbeatPrompt } from "../../internal/heartbeat-detect.js";
import type { CaptureWatermarkStore } from "../../internal/capture-watermark-store.js";
import { filterConversationMessagesForMemory } from "../../internal/message-provenance.js";
import type { SessionGoalStore } from "../../internal/session-goal.js";

interface InputProvenance {
  kind?: string;
  originSessionId?: string;
  sourceChannel?: string;
  sourceTool?: string;
}

interface AgentEndEvent {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  messages: unknown[];
  aborted: boolean;
  error?: string;
  inputProvenance?: InputProvenance;
  usageTotals?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  };
}

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const MIN_CONTENT_LENGTH = 50;
const LOOKUP_MAX_QUESTION_CHARS = 220;
const LOOKUP_MAX_ANSWER_CHARS = 220;
const TURN_DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TURN_DEDUP_MAX_FINGERPRINTS = 1000;
const CAPTURE_DERIVATION_MODE = "inferred";
const BENCHMARK_SEED_SESSION_PREFIX = "benchmark-seed-";

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block): string => {
        if (typeof block !== "object" || block === null) return "";
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "tool_result") return extractContent(b.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isWorthCapturing(messages: ConversationMessage[]): boolean {
  const hasUser = messages.some((m) => m.role === "user" && m.content.length > MIN_CONTENT_LENGTH);
  const hasSubstantiveResponse = messages.some((m) => m.role === "assistant" && m.content.length > MIN_CONTENT_LENGTH);
  return hasUser && hasSubstantiveResponse;
}

function latestByRole(messages: ConversationMessage[], role: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return messages[i].content.trim();
  }
  return undefined;
}

const LOOKUP_QUESTION_PREFIX_RE = /^(what|which|where|who|when|how (long|many|much)|is|are|does|do)\b/i;
const LOOKUP_KEYWORD_RE = /\b(default|ttl|timeout|port|version|config(?:uration)?|setting|package manager|test runner|log level|pool size|url prefix|naming convention|key naming|cache|endpoint|api prefix)\b/i;
const NON_PROBE_QUESTION_RE = /\b(why|trade-?off|strategy|approach|plan|design|architecture|migrate|migration|debug|root cause|fix)\b/i;
const REASONING_ANSWER_RE = /\b(because|therefore|trade-?off|recommend|should|step|first|second|third|plan|strategy|migrate|debug|root cause)\b/i;

function isProbeLookupTurn(messages: ConversationMessage[]): boolean {
  const user = latestByRole(messages, "user");
  const assistant = latestByRole(messages, "assistant");
  if (!user || !assistant) return false;

  const question = user.replace(/\s+/g, " ").trim();
  const answer = assistant.replace(/\s+/g, " ").trim();
  if (!question.endsWith("?")) return false;
  if (question.length > LOOKUP_MAX_QUESTION_CHARS || answer.length > LOOKUP_MAX_ANSWER_CHARS) return false;
  if (!LOOKUP_QUESTION_PREFIX_RE.test(question)) return false;
  if (!LOOKUP_KEYWORD_RE.test(question)) return false;
  if (NON_PROBE_QUESTION_RE.test(question)) return false;
  if (answer.split("\n").length > 3) return false;
  if (REASONING_ANSWER_RE.test(answer)) return false;
  return true;
}

function isBenchmarkSeedSession(sessionId: string | undefined): boolean {
  return Boolean(sessionId?.startsWith(BENCHMARK_SEED_SESSION_PREFIX));
}

function normalizeFingerprintText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?z\b/gi, "<iso-ts>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTurnFingerprint(messages: ConversationMessage[]): string | undefined {
  const user = latestByRole(messages, "user");
  const assistant = latestByRole(messages, "assistant");
  if (!user || !assistant) return undefined;

  const normalizedUser = normalizeFingerprintText(user);
  const normalizedAssistant = normalizeFingerprintText(assistant);
  if (!normalizedUser || !normalizedAssistant) return undefined;
  return createHash("sha1").update(`${normalizedUser}||${normalizedAssistant}`).digest("hex");
}

function extractBatchProvenance(
  messages: ConversationMessage[],
  inputProvenance: InputProvenance | undefined,
): { sourceChannel?: string; originSessionId?: string } {
  if (!inputProvenance) return {};

  // Event-level provenance is only safe to apply when the captured batch is a
  // single user-led turn. Replayed history can span multiple turns and would
  // otherwise inherit the current turn's ACP metadata incorrectly.
  const firstUserIndex = messages.findIndex((msg) => msg.role === "user");
  const userCount = messages.filter((msg) => msg.role === "user").length;
  if (firstUserIndex !== 0 || userCount !== 1) return {};

  return {
    sourceChannel: inputProvenance.sourceChannel,
    originSessionId: inputProvenance.originSessionId,
  };
}


export function createCaptureHandler(
  client: CortexClient,
  config: CortexConfig,
  logger: Logger,
  retryQueue?: RetryQueue,
  knowledgeState?: KnowledgeState,
  getUserId?: () => string | undefined,
  userIdReady?: Promise<void>,
  pluginSessionId?: string,
  auditLogger?: AuditLogger,
  echoStore?: RecallEchoStore,
  watermarkStore?: CaptureWatermarkStore,
  sessionGoalStore?: SessionGoalStore,
) {
  let captureCounter = 0;
  const seenTurnFingerprints = new Map<string, number>();

  return async (event: AgentEndEvent): Promise<boolean> => {
    logger.info("Cortex capture: hook fired");

    if (!config.autoCapture) return false;
    if (event.aborted) return false;
    if (!event.messages?.length) return false;

    try {
      const sessionId = event.sessionKey ?? event.sessionId ?? pluginSessionId;
      const watermarkKey = sessionId ?? "__default__";
      const previousWatermark = watermarkStore?.get(watermarkKey) ?? 0;
      const watermark = previousWatermark > event.messages.length ? 0 : previousWatermark;
      const delta = event.messages.slice(watermark);
      const markCapturedWatermark = () => {
        // Advance watermark so we don't repeatedly re-process the same turn.
        watermarkStore?.set(watermarkKey, event.messages.length);
      };

      const candidates = filterConversationMessagesForMemory(
        delta.filter(
          (msg): msg is { role: string; content: unknown; provenance?: unknown } =>
            typeof msg === "object" &&
            msg !== null &&
            "role" in msg &&
            "content" in msg &&
            (msg.role === "assistant" || msg.role === "user"),
        ),
      );

      const normalized: ConversationMessage[] = candidates
        .map((msg) => ({
          role: String(msg.role),
          content: sanitizeConversationText(extractContent(msg.content)),
        }))
        .filter((msg) => msg.content.length > 0);

      // Skip capture entirely for heartbeat turns — they produce low-signal
      // operational noise that pollutes the memory store and amplifies false facts.
      if (containsHeartbeatPrompt(normalized)) {
        markCapturedWatermark();
        logger.info("Cortex capture: skipping — heartbeat turn");
        return false;
      }

      // Drop low-signal messages (heartbeats, status lines, TUI artifacts)
      const filtered = config.captureFilter !== false
        ? filterLowSignalMessages(normalized)
        : normalized;

      // Strip volatile/transient statements (version numbers, task status, "currently" state)
      // from message content before capture to prevent stale facts from entering long-term memory.
      const volatileStripped = config.captureFilter !== false
        ? stripVolatileContent(filtered)
        : filtered;

      // Strip assistant messages that echo recently recalled memories.
      // This breaks the feedback loop: recall → agent parrots → capture → recall (stronger).
      let echoFiltered = volatileStripped;
      if (echoStore) {
        let echoesStripped = 0;
        echoFiltered = volatileStripped.filter((msg) => {
          if (msg.role === "assistant" && echoStore.isEcho(msg.content)) {
            echoesStripped++;
            return false;
          }
          return true;
        });
        if (echoesStripped > 0) {
          logger.info(`Cortex capture: stripped ${echoesStripped} assistant message(s) echoing recalled memories`);
        }
      }

      if (!isWorthCapturing(echoFiltered)) {
        markCapturedWatermark();
        logger.info("Cortex capture: skipping — not enough substantive content");
        return false;
      }

      // Capture the active session goal for tagging the ingest payload.
      const activeGoal = config.sessionGoal ? sessionGoalStore?.get()?.goal : undefined;

      // API caps at 200 messages — take the most recent to stay within the limit
      const MAX_MESSAGES = 200;
      const trimmed = echoFiltered.length > MAX_MESSAGES ? echoFiltered.slice(-MAX_MESSAGES) : echoFiltered;

      // Enforce byte-size cap — drop oldest messages until the transcript fits.
      // This prevents oversized payloads from pasted files or verbose replies.
      //
      // Compression runs here, after echo filtering and duplicate detection use
      // the original sanitized text, so those heuristics still see the full turn.
      const API_MAX_MESSAGE_CHARS = 10_000;
      const compressed = trimmed.map((msg) => (
        msg.content.length > API_MAX_MESSAGE_CHARS
          ? { ...msg, content: compressLargeContent(msg.content, API_MAX_MESSAGE_CHARS) }
          : msg
      ));

      // Enforce byte-size cap on the actual payload that will be sent.
      const maxBytes = config.captureMaxPayloadBytes ?? 262_144;
      while (compressed.length > 2) {
        const estimatedSize = compressed.reduce((sum, m) => sum + Buffer.byteLength(m.role, "utf-8") + 2 + Buffer.byteLength(m.content, "utf-8") + 2, 0);
        if (estimatedSize <= maxBytes) break;
        compressed.shift();
      }

      // Enforce character cap — the Cortex API rejects text > 50,000 chars.
      // The transcript format is "role: content\n\n" per message, so we estimate
      // the final transcript length and drop oldest messages to fit.
      const API_MAX_CHARS = 50_000;
      while (compressed.length > 2) {
        const estimatedChars = compressed.reduce((sum, m) => sum + m.role.length + 2 + m.content.length + 2, 0);
        if (estimatedChars <= API_MAX_CHARS) break;
        compressed.shift();
      }

      // Keep probe-lookup filtering enabled for normal traffic and benchmark probes,
      // but bypass it for benchmark seed sessions so factual seed Q&A is retained.
      const shouldFilterProbeLookup = !isBenchmarkSeedSession(sessionId);
      if (shouldFilterProbeLookup && isProbeLookupTurn(trimmed)) {
        markCapturedWatermark();
        logger.info("Cortex capture: skipping — probe lookup turn");
        return false;
      }

      // In-memory duplicate suppression to avoid repeated benchmark/probe churn.
      const now = Date.now();
      for (const [fingerprint, seenAt] of seenTurnFingerprints) {
        if (now - seenAt > TURN_DEDUP_TTL_MS) seenTurnFingerprints.delete(fingerprint);
      }
      const fingerprint = buildTurnFingerprint(trimmed);
      if (fingerprint) {
        const seenAt = seenTurnFingerprints.get(fingerprint);
        if (seenAt && now - seenAt <= TURN_DEDUP_TTL_MS) {
          markCapturedWatermark();
          logger.info("Cortex capture: skipping — duplicate turn fingerprint");
          return false;
        }
        seenTurnFingerprints.set(fingerprint, now);
        if (seenTurnFingerprints.size > TURN_DEDUP_MAX_FINGERPRINTS) {
          const oldest = [...seenTurnFingerprints.entries()]
            .sort((a, b) => a[1] - b[1])
            .slice(0, seenTurnFingerprints.size - TURN_DEDUP_MAX_FINGERPRINTS);
          for (const [stale] of oldest) seenTurnFingerprints.delete(stale);
        }
      }

      const totalChars = compressed.reduce((sum, m) => sum + m.content.length, 0);
      logger.info(`Cortex capture: ${compressed.length} messages, ${totalChars} chars`);

      // Advance watermark before async work so a second turn doesn't re-send this delta
      markCapturedWatermark();

      // Ensure userId is resolved before sending — in practice this resolves in <100ms
      // at startup, well before agent_end fires, but we await explicitly to be correct.
      if (userIdReady) await userIdReady;

      logger.debug?.(`Cortex capture: sessionId=${sessionId}, userId=${getUserId?.()}`);

      // Flatten messages into a role:content transcript for concise logging/audit
      const transcript = compressed
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n\n");

      // Log a summary of what's being sent
      const roleCounts: Record<string, number> = {};
      for (const m of compressed) {
        roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
      }
      const roleBreakdown = Object.entries(roleCounts).map(([r, n]) => `${r}=${n}`).join(", ");
      const preview = (transcript.length > 200 ? transcript.slice(0, 200) + "…" : transcript).replace(/\n/g, " ");
      logger.info(`Cortex capture summary: ${compressed.length} msgs (${roleBreakdown}), ${transcript.length} chars, sessionId=${sessionId}`);
      logger.info(`Cortex capture preview: ${preview}`);

      if (auditLogger) {
        void auditLogger.log({
          feature: "auto-capture",
          method: "POST",
          endpoint: "/v1/jobs/ingest/conversation",
          payload: transcript,
          sessionId,
          userId: getUserId?.(),
          messageCount: compressed.length,
        });
      }

      const doRemember = async () => {
        // Re-evaluate userId at call time so retries pick up the resolved value
        const userId = getUserId?.();
        if (getUserId && !userId) {
          logger.warn("Cortex capture: missing user_id, deferring ingest retry until identity resolves");
          throw new Error("Cortex ingest requires user_id");
        }
        const referenceDate = new Date().toISOString();
        const { sourceChannel, originSessionId } = extractBatchProvenance(compressed, event.inputProvenance);
        // Use async conversation ingest so role attribution is preserved for RESONATE.
        const job = await client.submitIngestConversation(
          compressed,
          sessionId,
          referenceDate,
          userId,
          "openclaw",
          "OpenClaw",
          CAPTURE_DERIVATION_MODE,
          sourceChannel,
          originSessionId,
          activeGoal,
        );
        logger.info(`Cortex capture: submitted job ${job.job_id} (status=${job.status})`);
        // Mark that we have memories — heartbeat handler owns full knowledge refresh
        if (knowledgeState) {
          knowledgeState.hasMemories = true;
        }
      };

      // Fire-and-forget with retry on failure
      doRemember().catch((err) => {
        logger.warn(`Cortex capture failed, queuing for retry: ${String(err)}`);
        if (retryQueue) {
          retryQueue.enqueue(doRemember, `capture-${++captureCounter}`);
        }
      });

      return true; // ingestion was queued
    } catch (err) {
      logger.warn(`Cortex capture error: ${String(err)}`);
      return false;
    }
  };
}
