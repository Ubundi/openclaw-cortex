import { createHash } from "node:crypto";
import type {
  CortexClient,
  LinkOwnerType,
  PassiveBridgeRequest,
} from "../../cortex/client.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { isHeartbeatTurn } from "../../internal/heartbeat-detect.js";
import type { ClawDeployBridgeTraceClient } from "../../internal/clawdeploy-bridge-traces.js";
import { redactBridgeTraceError } from "../../internal/clawdeploy-bridge-traces.js";
import {
  PassiveExtractorTimeoutError,
  isPassiveExtractorEvent,
  isPassiveExtractorProviderUnavailableError,
  isPassiveExtractorSessionPathError,
  isPassiveExtractorTimeoutError,
} from "./openclaw-extractor.js";
import {
  buildPassiveExtractorInput,
  buildPassiveExtractorPrompt,
  buildPassiveBridgeRequestId,
  buildPassiveCandidateFingerprint,
  PASSIVE_EXTRACTOR_MAX_OUTPUT_TOKENS,
  PASSIVE_EXTRACTOR_TIMEOUT_MS,
  PASSIVE_JOB_TTL_MS,
  MAX_PASSIVE_CANDIDATES_PER_SESSION,
  type PassiveExtractorInput,
  type PassiveExtractorOutput,
  type PassiveModelExtractor,
  PASSIVE_BRIDGE_EXTRACTOR_VERSION,
  shouldAttemptPassiveBridgeExtraction,
  validatePassiveExtractorCandidates,
} from "./passive.js";
import { PassiveExtractionQueue, type PassiveExtractionJob } from "./passive-queue.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

interface LinkStatusSnapshot {
  linked: boolean;
  checkedAt: number;
  ownerType?: LinkOwnerType;
  ownerId?: string;
  tootooUserId?: string | null;
}

interface AgentEndEvent {
  messages?: unknown[];
  aborted?: boolean;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  inputProvenance?: unknown;
}

interface BridgePromptEvent {
  prompt?: string;
  finalPromptText?: string;
  messages?: unknown[];
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  inputProvenance?: unknown;
}

interface BridgeSessionState {
  passiveCandidatesSent?: number;
  passiveFingerprints?: Set<string>;
  passiveRecentCandidates?: PassiveRecentCandidate[];
}

interface PassiveRecentCandidate {
  contentKey: string;
  evidenceKey: string;
  evidenceHash: string;
  sentAt: number;
}

export interface CreateBridgeHandlerOptions {
  logger: Logger;
  getUserId: () => string | undefined;
  userIdReady?: Promise<void>;
  pluginSessionId?: string;
  auditLogger?: AuditLogger;
  bridgeTraceClient?: ClawDeployBridgeTraceClient;
  passiveModelExtractor?: PassiveModelExtractor;
  getActiveModelRef?: (sessionKey: string) => string | undefined;
}

const LINK_STATUS_TTL_MS = 60_000;
const PASSIVE_EXTRACTOR_OUTER_DEADLINE_GRACE_MS = 100;
const PASSIVE_RECENT_CANDIDATE_TTL_MS = 60 * 60 * 1000;
const PASSIVE_CONTENT_DUPLICATE_SIMILARITY = 0.58;
const PASSIVE_EVIDENCE_DUPLICATE_SIMILARITY = 0.5;
const PASSIVE_CANONICAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "bring",
  "brings",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "not",
  "of",
  "or",
  "rather",
  "that",
  "the",
  "their",
  "them",
  "they",
  "to",
  "user",
  "when",
  "with",
]);

function trimPassiveRecentCandidates(sessionState: BridgeSessionState, now = Date.now()): PassiveRecentCandidate[] {
  const recent = (sessionState.passiveRecentCandidates ?? [])
    .filter((candidate) => now - candidate.sentAt <= PASSIVE_RECENT_CANDIDATE_TTL_MS);
  sessionState.passiveRecentCandidates = recent;
  return recent;
}

function passiveCanonicalTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/(?:ing|ed|s)$/i, ""))
    .filter((token) => token.length > 2 && !PASSIVE_CANONICAL_STOPWORDS.has(token));
}

function passiveCanonicalKey(text: string): string {
  return [...new Set(passiveCanonicalTokens(text))].sort().join(" ");
}

function passiveSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function passiveEvidenceHash(evidenceQuote: string): string {
  return createHash("sha256")
    .update(evidenceQuote.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

function passiveTracePrivateFragments(request: PassiveBridgeRequest): string[] {
  return request.candidates.flatMap((candidate) => [
    candidate.content,
    candidate.evidence_quote,
    ...(candidate.supporting_evidence_quotes ?? []),
  ]);
}

function isDuplicateRecentPassiveCandidate(
  sessionState: BridgeSessionState,
  candidate: Pick<PassiveBridgeRequest["candidates"][number], "content" | "evidence_quote">,
  recentCandidates: PassiveRecentCandidate[] = trimPassiveRecentCandidates(sessionState),
): boolean {
  const contentKey = passiveCanonicalKey(candidate.content);
  const evidenceKey = passiveCanonicalKey(candidate.evidence_quote);
  const evidenceHash = passiveEvidenceHash(candidate.evidence_quote);
  return recentCandidates.some((recent) => (
    recent.evidenceHash === evidenceHash
    || passiveSimilarity(contentKey, recent.contentKey) >= PASSIVE_CONTENT_DUPLICATE_SIMILARITY
    || passiveSimilarity(evidenceKey, recent.evidenceKey) >= PASSIVE_EVIDENCE_DUPLICATE_SIMILARITY
  ));
}

function passiveRecentCandidateFor(
  candidate: Pick<PassiveBridgeRequest["candidates"][number], "content" | "evidence_quote">,
): PassiveRecentCandidate {
  return {
    contentKey: passiveCanonicalKey(candidate.content),
    evidenceKey: passiveCanonicalKey(candidate.evidence_quote),
    evidenceHash: passiveEvidenceHash(candidate.evidence_quote),
    sentAt: Date.now(),
  };
}

function rememberRecentPassiveCandidate(
  sessionState: BridgeSessionState,
  candidate: Pick<PassiveBridgeRequest["candidates"][number], "content" | "evidence_quote">,
): void {
  const recent = trimPassiveRecentCandidates(sessionState);
  recent.push(passiveRecentCandidateFor(candidate));
  sessionState.passiveRecentCandidates = recent.slice(-20);
}

function extractErrorStatusCode(err: unknown): number | undefined {
  const match = /\bfailed:\s*(\d{3})\b/.exec(String(err));
  return match ? Number(match[1]) : undefined;
}

function isRetryableBridgeError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") {
    return true;
  }

  const message = String(err);
  if (
    /AbortError/.test(message) ||
    /Failed to fetch/i.test(message) ||
    /fetch failed/i.test(message) ||
    /network/i.test(message) ||
    /ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)
  ) {
    return true;
  }

  const status = extractErrorStatusCode(err);
  return status === 429 || (status !== undefined && status >= 500);
}

function passiveTextLengthBucket(messages: PassiveExtractorInput["messages"]): string {
  const length = messages.reduce((total, message) => total + message.content.length, 0);
  if (length === 0) return "0";
  if (length <= 80) return "1-80";
  if (length <= 280) return "81-280";
  if (length <= 900) return "281-900";
  return "901+";
}

function splitPassiveModelRefForLog(modelRef: string | undefined): { provider: string; model: string } {
  const trimmed = typeof modelRef === "string" ? modelRef.trim().toLowerCase() : "";
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  }
  return { provider: "default", model: trimmed || "default" };
}

async function runPassiveExtractorWithDeadline(
  extractor: PassiveModelExtractor,
  input: PassiveExtractorInput,
): Promise<PassiveExtractorOutput> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const extractorPromise = extractor(input);
  extractorPromise.catch(() => undefined);
  const timeoutPromise = new Promise<PassiveExtractorOutput>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new PassiveExtractorTimeoutError(input.timeoutMs));
    }, input.timeoutMs + PASSIVE_EXTRACTOR_OUTER_DEADLINE_GRACE_MS);
  });
  try {
    return await Promise.race([extractorPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createBridgeHandler(
  client: CortexClient,
  options: CreateBridgeHandlerOptions,
) {
  const {
    logger,
    getUserId,
    userIdReady,
    pluginSessionId,
    auditLogger,
    bridgeTraceClient,
    passiveModelExtractor,
  } = options;

  let linkStatus: LinkStatusSnapshot = {
    linked: false,
    checkedAt: 0,
  };
  let pendingLinkStatusCheck: Promise<LinkStatusSnapshot> | null = null;
  const sessionStates = new Map<string, BridgeSessionState>();

  function resolveBridgeSessionKey(event: { sessionKey?: string; sessionId?: string }): string {
    return event.sessionKey ?? event.sessionId ?? pluginSessionId ?? "__default__";
  }

  function getSessionState(sessionKey: string): BridgeSessionState {
    let state = sessionStates.get(sessionKey);
    if (!state) {
      state = {
        passiveCandidatesSent: 0,
        passiveFingerprints: new Set<string>(),
        passiveRecentCandidates: [],
      };
      sessionStates.set(sessionKey, state);
    }
    state.passiveFingerprints ??= new Set<string>();
    state.passiveRecentCandidates ??= [];
    state.passiveCandidatesSent ??= 0;
    return state;
  }

  function hasOwnerContext(status: LinkStatusSnapshot): boolean {
    return status.linked && Boolean(status.ownerType && status.ownerId);
  }

  async function refreshLinkStatus(force = false): Promise<LinkStatusSnapshot> {
    if (userIdReady) await userIdReady;

    const agentUserId = getUserId();
    if (!agentUserId) {
      linkStatus = { linked: false, checkedAt: Date.now() };
      return linkStatus;
    }

    if (!force && pendingLinkStatusCheck) return pendingLinkStatusCheck;
    if (!force && linkStatus.checkedAt > 0 && Date.now() - linkStatus.checkedAt < LINK_STATUS_TTL_MS) {
      return linkStatus;
    }

    pendingLinkStatusCheck = client.getLinkStatus(agentUserId)
      .then((result) => {
        const link = result.link;
        const next: LinkStatusSnapshot = {
          linked: result.linked,
          checkedAt: Date.now(),
          ownerType: link?.owner_type ?? result.owner_type,
          ownerId: link?.owner_id ?? result.owner_id,
          tootooUserId: link?.tootoo_user_id ?? result.tootoo_user_id,
        };
        if (next.linked !== linkStatus.linked) {
          logger.info(`Cortex bridge: TooToo link ${next.linked ? "active" : "inactive"}`);
        }
        linkStatus = next;
        return next;
      })
      .catch((err) => {
        logger.debug?.(`Cortex bridge: link status check failed: ${String(err)}`);
        linkStatus = { ...linkStatus, checkedAt: Date.now() };
        return linkStatus;
      })
      .finally(() => {
        pendingLinkStatusCheck = null;
      });

    return pendingLinkStatusCheck;
  }

  function emitPassiveTrace(input: {
    request: PassiveBridgeRequest;
    agentUserId: string;
    status: "detected" | "accepted" | "failed";
    response?: Awaited<ReturnType<CortexClient["submitBridgePassive"]>>;
    error?: unknown;
  }): void {
    if (!bridgeTraceClient) return;

    try {
      bridgeTraceClient.emitBridgeTrace({
        requestId: input.request.request_id,
        sessionKey: input.request.session_key,
        cortexAgentUserId: input.agentUserId,
        agentUserId: input.agentUserId,
        targetSection: input.request.candidates[0]?.suggested_section,
        status: input.status,
        detectedAt: input.status === "detected" ? new Date().toISOString() : undefined,
        acceptedAt: input.status === "accepted" ? new Date().toISOString() : undefined,
        forwarded: input.response?.forwarded,
        queuedForRetry: input.response?.queued_for_retry,
        entriesSent: input.response?.candidates_sent,
        lastError: input.error ? redactBridgeTraceError(input.error, passiveTracePrivateFragments(input.request)) : undefined,
        metadata: {
          source: "openclaw-cortex",
          bridgeKind: "passive_bridge",
          extractorVersion: input.request.extractor_version,
          candidateCount: input.request.candidates.length,
          bridgeEventId: input.response?.bridge_event_id,
          suggestionsCreated: input.response?.suggestions_created,
          materialized: input.response?.materialized,
          suppressed: input.response?.suppressed,
          ownerType: input.response?.owner_type,
          hasTootooUserId: Boolean(input.response?.tootoo_user_id),
        },
      });
    } catch (err) {
      logger.debug?.(`Cortex bridge trace emission failed: ${redactBridgeTraceError(err)}`);
    }
  }

  async function processPassiveExtractionJob(job: PassiveExtractionJob): Promise<void> {
    if (!passiveModelExtractor) {
      logger.warn(`Cortex bridge: passive_job_dropped reason=provider_unavailable sessionId=${job.sessionKey}`);
      return;
    }

    const status = await refreshLinkStatus();
    if (!status.linked) {
      logger.warn(`Cortex bridge: passive_job_dropped reason=memory_disabled sessionId=${job.sessionKey}`);
      return;
    }
    if (!hasOwnerContext(status)) {
      logger.warn(`Cortex bridge: passive_job_dropped reason=owner_context_unavailable sessionId=${job.sessionKey}`);
      return;
    }

    const sessionState = getSessionState(job.sessionKey);
    const remainingSessionSlots = Math.max(
      0,
      MAX_PASSIVE_CANDIDATES_PER_SESSION - (sessionState.passiveCandidatesSent ?? 0),
    );
    if (remainingSessionSlots <= 0) {
      logger.warn(`Cortex bridge: passive_job_dropped reason=session_candidate_cap sessionId=${job.sessionKey}`);
      return;
    }

    const extractorInput: PassiveExtractorInput = {
      messages: job.messages,
      prompt: buildPassiveExtractorPrompt(),
      extractorVersion: PASSIVE_BRIDGE_EXTRACTOR_VERSION,
      maxCandidates: Math.min(remainingSessionSlots, 3),
      timeoutMs: PASSIVE_EXTRACTOR_TIMEOUT_MS,
      maxOutputTokens: PASSIVE_EXTRACTOR_MAX_OUTPUT_TOKENS,
      activeModelRef: job.activeModelRef,
    };

    const extractorStartedAt = Date.now();
    const modelLog = splitPassiveModelRefForLog(extractorInput.activeModelRef);
    logger.info(`Cortex bridge: passive_extractor_started sessionId=${job.sessionKey} timeoutMs=${extractorInput.timeoutMs} provider=${modelLog.provider} model=${modelLog.model}`);
    let rawPassiveCandidates: PassiveBridgeRequest["candidates"] = [];
    let rejectedPassiveCandidateCount = 0;
    try {
      const modelOutput = await runPassiveExtractorWithDeadline(passiveModelExtractor, extractorInput);
      const extractorDurationMs = Date.now() - extractorStartedAt;
      logger.info(`Cortex bridge: passive_extractor_completed sessionId=${job.sessionKey} durationMs=${extractorDurationMs} rawCandidateCount=${modelOutput.candidates.length}`);
      const validation = validatePassiveExtractorCandidates(modelOutput, extractorInput);
      rawPassiveCandidates = validation.accepted;
      rejectedPassiveCandidateCount = validation.rejected.length;
      if (validation.rejected.length > 0) {
        const buckets = [...new Set(validation.rejected.map((item) => item.reason))].join(",");
        logger.warn(`Cortex bridge: passive_validator_rejected sessionId=${job.sessionKey} count=${validation.rejected.length} buckets=${buckets}`);
      }
    } catch (err) {
      const durationMs = Date.now() - extractorStartedAt;
      if (isPassiveExtractorTimeoutError(err)) {
        logger.warn(`Cortex bridge: passive_extractor_timeout sessionId=${job.sessionKey} durationMs=${durationMs} timeoutMs=${err.timeoutMs}`);
      } else if (isPassiveExtractorSessionPathError(err)) {
        logger.warn(`Cortex bridge: passive_job_dropped reason=session_path_error sessionId=${job.sessionKey} durationMs=${durationMs}`);
      } else if (err instanceof SyntaxError) {
        logger.warn(`Cortex bridge: passive_extractor_invalid_json sessionId=${job.sessionKey} durationMs=${durationMs} reason=json_parse_failed`);
      } else if (isPassiveExtractorProviderUnavailableError(err)) {
        logger.warn(`Cortex bridge: passive_job_dropped reason=${err.reason} provider=${err.provider} sessionId=${job.sessionKey} durationMs=${durationMs}`);
      } else {
        logger.warn(`Cortex bridge: passive_job_dropped reason=provider_unavailable sessionId=${job.sessionKey} durationMs=${durationMs}`);
      }
      return;
    }

    if (rawPassiveCandidates.length === 0) {
      logger.info(`Cortex bridge: passive_validation_completed sessionId=${job.sessionKey} accepted_count=0 rejected_count=${rejectedPassiveCandidateCount} suppression_count=0`);
      return;
    }

    let suppressionCount = 0;
    const extractedCandidates: PassiveBridgeRequest["candidates"] = [];
    const recentCandidates = trimPassiveRecentCandidates(sessionState).slice();
    for (const candidate of rawPassiveCandidates) {
      const fingerprint = buildPassiveCandidateFingerprint(candidate);
      if (sessionState.passiveFingerprints?.has(fingerprint)) {
        suppressionCount++;
        logger.info(`Cortex bridge: passive_candidate_suppressed reason=duplicate_fingerprint sessionId=${job.sessionKey}`);
        continue;
      }
      if (isDuplicateRecentPassiveCandidate(sessionState, candidate, recentCandidates)) {
        suppressionCount++;
        logger.info(`Cortex bridge: passive_candidate_suppressed reason=duplicate_recent_session_fuzzy sessionId=${job.sessionKey}`);
        continue;
      }
      extractedCandidates.push(candidate);
      recentCandidates.push(passiveRecentCandidateFor(candidate));
      if (extractedCandidates.length >= remainingSessionSlots) break;
    }

    logger.info(`Cortex bridge: passive_validation_completed sessionId=${job.sessionKey} accepted_count=${extractedCandidates.length} rejected_count=${rejectedPassiveCandidateCount} suppression_count=${suppressionCount}`);

    if (extractedCandidates.length === 0) return;

    const request: PassiveBridgeRequest = {
      user_id: job.agentUserId,
      request_id: buildPassiveBridgeRequestId({
        agentUserId: job.agentUserId,
        sessionKey: job.sessionKey,
        turnIndex: job.turnIndex,
        candidates: extractedCandidates,
      }),
      session_key: job.sessionKey,
      extractor_version: PASSIVE_BRIDGE_EXTRACTOR_VERSION,
      candidates: extractedCandidates,
    };

    emitPassiveTrace({
      request,
      agentUserId: job.agentUserId,
      status: "detected",
    });

    try {
      if (auditLogger) {
        await auditLogger.log({
          feature: "bridge-passive",
          method: "POST",
          endpoint: "/v1/bridge/passive",
          payload: JSON.stringify(request, null, 2),
          sessionId: job.sessionKey,
          userId: job.agentUserId,
          messageCount: extractedCandidates.length,
        });
      }
      logger.info(`Cortex bridge: passive_bridge_send_attempted requestId=${request.request_id} sessionId=${job.sessionKey} candidates=${extractedCandidates.length}`);
      const response = await client.submitBridgePassive(request);
      if (!response.accepted) {
        throw new Error(`Cortex bridge/passive failed: accepted=false requestId=${request.request_id}`);
      }
      for (const candidate of extractedCandidates) {
        sessionState.passiveFingerprints?.add(buildPassiveCandidateFingerprint(candidate));
        rememberRecentPassiveCandidate(sessionState, candidate);
      }
      sessionState.passiveCandidatesSent = (sessionState.passiveCandidatesSent ?? 0) + extractedCandidates.length;
      emitPassiveTrace({
        request,
        agentUserId: job.agentUserId,
        status: "accepted",
        response,
      });
      logger.info(`Cortex bridge: passive_bridge_sent requestId=${request.request_id} forwarded=${response.forwarded} queuedForRetry=${response.queued_for_retry} candidates=${response.candidates_sent}`);
    } catch (err) {
      const statusCode = extractErrorStatusCode(err);
      if (statusCode === 404) {
        linkStatus = {
          linked: false,
          checkedAt: Date.now(),
        };
      }
      emitPassiveTrace({
        request,
        agentUserId: job.agentUserId,
        status: "failed",
        error: err,
      });
      logger.warn(`Cortex bridge: passive_bridge_failed requestId=${request.request_id} retryable=${isRetryableBridgeError(err)} reason=${statusCode ?? "unknown"}`);
    }
  }

  const passiveQueue = new PassiveExtractionQueue({
    logger,
    processJob: processPassiveExtractionJob,
    maxGlobalDepth: 100,
    maxPerUserDepth: 5,
    concurrency: 1,
  });

  async function shouldInjectPrompt(event: BridgePromptEvent): Promise<void> {
    if (isPassiveExtractorEvent(event)) return;
    if (isHeartbeatTurn(event.prompt || event.finalPromptText || "")) {
      logger.debug?.(`Cortex bridge: prompt decision mode=none reason=heartbeat sessionId=${resolveBridgeSessionKey(event)}`);
    } else {
      logger.debug?.(`Cortex bridge: prompt decision mode=none reason=passive_only sessionId=${resolveBridgeSessionKey(event)}`);
    }
  }

  async function handleAgentEnd(event: AgentEndEvent): Promise<boolean> {
    if (event.aborted) return false;
    if (!Array.isArray(event.messages) || event.messages.length === 0) return false;
    if (isPassiveExtractorEvent(event)) return false;
    if (userIdReady) await userIdReady;

    const agentUserId = getUserId();
    if (!agentUserId) return false;

    const status = await refreshLinkStatus();
    if (!status.linked) return false;

    const sessionKey = resolveBridgeSessionKey(event);
    const sessionState = getSessionState(sessionKey);
    let passiveEnqueued = false;

    if (hasOwnerContext(status)) {
      const remainingSessionSlots = Math.max(
        0,
        MAX_PASSIVE_CANDIDATES_PER_SESSION - (sessionState.passiveCandidatesSent ?? 0),
      );
      if (remainingSessionSlots > 0) {
        const gateStartedAt = Date.now();
        const passiveGate = shouldAttemptPassiveBridgeExtraction(event.messages);
        const extractorInput = passiveGate.shouldExtract ? buildPassiveExtractorInput(event.messages) : undefined;
        logger.info(
          `Cortex bridge: passive_gate_evaluated decision=${passiveGate.shouldExtract ? "inspect" : "skip"} ` +
          `reason=${passiveGate.reason ?? "candidate_possible"} textLengthBucket=${passiveTextLengthBucket(extractorInput?.messages ?? [])} ` +
          `durationMs=${Date.now() - gateStartedAt}`,
        );
        if (passiveGate.strippedInjectedContext) {
          logger.info(`Cortex bridge: passive_input_recovery_stripped sessionId=${sessionKey}`);
        }
        if (!passiveGate.shouldExtract) {
          logger.debug?.(`Cortex bridge: passive skipped reason=${passiveGate.reason ?? "unknown"} sessionId=${sessionKey}`);
        }
        if (passiveGate.shouldExtract && !passiveModelExtractor) {
          logger.warn(`Cortex bridge: passive_job_dropped reason=provider_unavailable sessionId=${sessionKey}`);
        } else if (passiveGate.shouldExtract && passiveModelExtractor && extractorInput) {
          const enqueueResult = passiveQueue.enqueue({
            agentUserId,
            sessionKey,
            turnIndex: event.messages.length,
            messages: extractorInput.messages,
            activeModelRef: options.getActiveModelRef?.(sessionKey),
            enqueuedAt: Date.now(),
            deadlineAt: Date.now() + PASSIVE_JOB_TTL_MS,
          });
          passiveEnqueued = enqueueResult.enqueued;
        }
      }
    } else {
      logger.warn(`Cortex bridge: passive_job_dropped reason=owner_context_unavailable sessionId=${sessionKey}`);
    }

    return passiveEnqueued;
  }

  return {
    refreshLinkStatus,
    shouldInjectPrompt,
    handleAgentEnd,
    // Test hook only. v1 passive extraction is intentionally in-memory best effort;
    // plugin shutdown does not drain or recover queued passive jobs.
    drainPassiveJobs: () => passiveQueue.drain(),
  };
}
