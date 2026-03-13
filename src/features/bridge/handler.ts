import { createHash } from "node:crypto";
import type {
  BridgeQARequest,
  BridgeTargetSection,
  CortexClient,
} from "../../cortex/client.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { filterConversationMessagesForMemory } from "../../internal/message-provenance.js";
import type { RetryQueue } from "../../internal/retry-queue.js";
import { isLowSignal, sanitizeConversationText } from "../capture/filter.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

interface LinkStatusSnapshot {
  linked: boolean;
  checkedAt: number;
}

interface BridgeConversationMessage {
  role: "assistant" | "user";
  content: string;
  originalIndex: number;
  provenance?: unknown;
}

interface DetectedBridgeExchange {
  question: string;
  answer: string;
  targetSection: BridgeTargetSection;
  requestId: string;
  assistantIndex: number;
  userIndex: number;
  sessionKey: string;
}

interface AgentEndEvent {
  messages?: unknown[];
  aborted?: boolean;
  sessionKey?: string;
  sessionId?: string;
}

export interface CreateBridgeHandlerOptions {
  logger: Logger;
  retryQueue?: RetryQueue;
  getUserId: () => string | undefined;
  userIdReady?: Promise<void>;
  pluginSessionId?: string;
  auditLogger?: AuditLogger;
}

const LINK_STATUS_TTL_MS = 60_000;
const HANDLED_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDLED_REQUEST_MAX = 1000;
const MIN_ANSWER_CHARS = 5;
const MAX_QUESTION_CHARS = 400;
const MAX_ANSWER_CHARS = 5000;

const LOOKUP_SHAPE_RE = /^(?:what (?:is|are|does|do)|which|where|when|how (?:many|much|long))\b/i;
const TECHNICAL_LOOKUP_RE = /\b(?:file|files|repo|repository|package|dependency|dependencies|endpoint|api|port|timeout|ttl|database|schema|migration|commit|branch|log(?:s)?|stack trace|error|test(?:s)?|env|environment variable|config|setting|settings|version|runtime|token|cache|enum|function|method|class|module|library|table|column|redis)\b/i;
const LOW_SIGNAL_ANSWER_RE = /^(?:ok|okay|yes|no|maybe|not sure|i don't know|idk|sure|sounds good|thanks|thank you)[.!?]*$/i;
const CLARIFYING_QUESTION_RE = /^(?:what|why|how|who|where|when|which|can|could|would|do|does|did|is|are|am|should|will|have|has)\b/i;

const SECTION_HINTS: Array<{ section: BridgeTargetSection; patterns: RegExp[]; keywords: string[] }> = [
  {
    section: "coreValues",
    patterns: [
      /\bwhat do you value(?: most)?\b/i,
      /\bwhat matters most to you\b/i,
      /\bwhat do you care about(?: most)?\b/i,
      /\bwhat feels most important to you\b/i,
      /\bwhat makes .* feel meaningful\b/i,
    ],
    keywords: [
      "value",
      "values",
      "matters most",
      "care about",
      "important to you",
      "meaningful",
      "worthwhile",
      "drive",
      "drives you",
      "motivates",
      "motivate",
      "purpose",
    ],
  },
  {
    section: "beliefs",
    patterns: [
      /\bwhat do you believe\b/i,
      /\bwhat belief(?:s)? shape\b/i,
      /\bwhat feels true to you\b/i,
      /\bwhat assumption(?:s)? do you carry\b/i,
      /\bwhat worldview\b/i,
    ],
    keywords: ["believe", "belief", "beliefs", "true to you", "assumption", "assumptions", "worldview", "conviction"],
  },
  {
    section: "principles",
    patterns: [
      /\bwhat principle(?:s)? guide you\b/i,
      /\bwhat rule(?:s)? do you live by\b/i,
      /\bwhat line won't you cross\b/i,
      /\bwhat standard do you hold yourself to\b/i,
      /\bwhat principle(?:s)? matter most\b/i,
    ],
    keywords: [
      "principle",
      "principles",
      "rule",
      "rules",
      "standard",
      "line won't",
      "won't cross",
      "boundary",
      "boundaries",
      "non-negotiable",
      "non-negotiables",
    ],
  },
  {
    section: "ideas",
    patterns: [
      /\bwhat idea(?:s)? are you exploring\b/i,
      /\bwhat idea(?:s)? keep pulling at you\b/i,
      /\bwhat are you curious about\b/i,
      /\bwhat do you want to (?:create|build|explore|learn)\b/i,
      /\bwhat possibility excites you\b/i,
    ],
    keywords: ["idea", "ideas", "curious", "curiosity", "explore", "exploring", "build", "create", "possibility", "learn"],
  },
  {
    section: "dreams",
    patterns: [
      /\bwhat do you dream about\b/i,
      /\bwhat do you hope for\b/i,
      /\bwhat do you want your (?:life|work|future)\b/i,
      /\bwhat would your ideal\b/i,
      /\bwhat future are you trying to build\b/i,
    ],
    keywords: ["dream", "dreams", "hope", "future", "ideal", "aspire", "aspiration", "want your life", "want your work"],
  },
  {
    section: "practices",
    patterns: [
      /\bwhat practice(?:s)? keep you grounded\b/i,
      /\bwhat habit(?:s)? help you\b/i,
      /\bwhat routine(?:s)? matter most\b/i,
      /\bhow do you stay grounded\b/i,
      /\bhow do you keep yourself aligned\b/i,
      /\bwhat helps you reset\b/i,
    ],
    keywords: ["practice", "practices", "habit", "habits", "routine", "routines", "ritual", "grounded", "aligned", "reset"],
  },
  {
    section: "shadows",
    patterns: [
      /\bwhat fear(?:s)? keep showing up\b/i,
      /\bwhat do you avoid\b/i,
      /\bwhat gets in your own way\b/i,
      /\bwhere do you hold yourself back\b/i,
      /\bwhat insecurity\b/i,
      /\bwhat part of yourself is hard to face\b/i,
    ],
    keywords: [
      "fear",
      "fears",
      "avoid",
      "avoiding",
      "hold yourself back",
      "gets in your own way",
      "stuck",
      "insecurity",
      "shadow",
      "self-sabotage",
    ],
  },
  {
    section: "legacy",
    patterns: [
      /\bhow do you want to be remembered\b/i,
      /\bwhat impact do you want to leave\b/i,
      /\bwhat do you want to leave behind\b/i,
      /\bwhat contribution do you hope to make\b/i,
      /\bwhat legacy\b/i,
    ],
    keywords: ["remembered", "impact", "leave behind", "legacy", "contribution", "outlast"],
  },
];

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block): string => {
        if (typeof block !== "object" || block === null) return "";
        const typed = block as Record<string, unknown>;
        if (typed.type === "text" && typeof typed.text === "string") return typed.text;
        if (typed.type === "tool_result") return extractContent(typed.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeRequestText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function trimHandledRequests(handledRequestIds: Map<string, number>): void {
  const now = Date.now();
  for (const [requestId, seenAt] of handledRequestIds) {
    if (now - seenAt > HANDLED_REQUEST_TTL_MS) handledRequestIds.delete(requestId);
  }

  if (handledRequestIds.size <= HANDLED_REQUEST_MAX) return;
  const stale = [...handledRequestIds.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, handledRequestIds.size - HANDLED_REQUEST_MAX);
  for (const [requestId] of stale) handledRequestIds.delete(requestId);
}

function countKeywordMatches(text: string, keywords: readonly string[]): number {
  return keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
}

export function extractLastQuestion(text: string): string | undefined {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const lastQuestionIndex = line.lastIndexOf("?");
    if (lastQuestionIndex === -1) continue;

    let candidate = line.slice(0, lastQuestionIndex + 1).trim();
    const previousQuestionIndex = candidate.lastIndexOf("?", candidate.length - 2);
    if (previousQuestionIndex !== -1) {
      candidate = candidate.slice(previousQuestionIndex + 1).trim();
    }

    const boundary = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf(": "),
      candidate.lastIndexOf("; "),
    );
    if (boundary !== -1) {
      candidate = candidate.slice(boundary + 2).trim();
    }

    candidate = candidate.replace(/^[>\-*•\d.)\s]+/, "").replace(/\s+/g, " ").trim();
    if (candidate.endsWith("?")) return candidate;
  }

  return undefined;
}

export function inferTargetSection(question: string): BridgeTargetSection | undefined {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized.endsWith("?")) return undefined;
  if (normalized.length === 0 || normalized.length > MAX_QUESTION_CHARS) return undefined;
  if (LOOKUP_SHAPE_RE.test(normalized) && TECHNICAL_LOOKUP_RE.test(normalized)) return undefined;

  const scored = SECTION_HINTS
    .map(({ section, patterns, keywords }, priority) => ({
      section,
      priority,
      score:
        patterns.reduce((total, pattern) => total + (pattern.test(normalized) ? 2 : 0), 0) +
        countKeywordMatches(normalized.toLowerCase(), keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.priority - b.priority);

  return scored[0]?.section;
}

function isExplicitAnswer(answer: string): boolean {
  const normalized = answer.replace(/\s+/g, " ").trim();
  const withoutLeadIn = normalized.replace(/^(?:and|also|but|plus|so)[,\s]+/i, "");
  if (normalized.length < MIN_ANSWER_CHARS || normalized.length > MAX_ANSWER_CHARS) return false;
  if (LOW_SIGNAL_ANSWER_RE.test(normalized)) return false;
  if (isLowSignal(normalized)) return false;
  if (withoutLeadIn.endsWith("?") && CLARIFYING_QUESTION_RE.test(withoutLeadIn)) return false;
  return true;
}

function normalizeConversationMessages(messages: unknown[]): BridgeConversationMessage[] {
  const candidates = filterConversationMessagesForMemory(
    messages.flatMap((message, index) => {
      if (typeof message !== "object" || message === null) return [];
      const typed = message as Record<string, unknown>;
      if (typed.role !== "assistant" && typed.role !== "user") return [];
      if (!("content" in typed)) return [];
      return [{
        role: typed.role as "assistant" | "user",
        content: typed.content,
        provenance: typed.provenance,
        originalIndex: index,
      }];
    }),
  );

  return candidates
    .map((message) => ({
      role: message.role,
      content: sanitizeConversationText(extractContent(message.content)).replace(/\s+/g, " ").trim(),
      originalIndex: message.originalIndex,
      provenance: message.provenance,
    }))
    .filter((message) => message.content.length > 0);
}

export function buildBridgeRequestId(input: {
  agentUserId: string;
  sessionKey: string;
  assistantIndex: number;
  userIndex: number;
  question: string;
  answer: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      agentUserId: input.agentUserId,
      sessionKey: input.sessionKey,
      assistantIndex: input.assistantIndex,
      userIndex: input.userIndex,
      question: normalizeRequestText(input.question),
      answer: normalizeRequestText(input.answer),
    }))
    .digest("hex")
    .slice(0, 32);

  return `openclaw-bridge-${digest}`;
}

export function detectBridgeExchanges(input: {
  messages: unknown[];
  agentUserId: string;
  sessionKey: string;
}): DetectedBridgeExchange[] {
  const normalized = normalizeConversationMessages(input.messages);
  if (normalized.length < 2) return [];
  const exchanges: DetectedBridgeExchange[] = [];
  const seenRequestIds = new Set<string>();

  for (let userCursor = normalized.length - 1; userCursor >= 0; userCursor--) {
    if (normalized[userCursor].role !== "user") continue;

    const answer = normalized[userCursor].content;
    if (!isExplicitAnswer(answer)) continue;

    let priorAssistantIndex = -1;
    for (let assistantCursor = userCursor - 1; assistantCursor >= 0; assistantCursor--) {
      if (normalized[assistantCursor].role === "assistant") {
        priorAssistantIndex = assistantCursor;
        break;
      }
    }
    if (priorAssistantIndex === -1) continue;

    const question = extractLastQuestion(normalized[priorAssistantIndex].content);
    if (!question) continue;

    const targetSection = inferTargetSection(question);
    if (!targetSection) continue;

    const assistantIndex = normalized[priorAssistantIndex].originalIndex;
    const userIndex = normalized[userCursor].originalIndex;
    const requestId = buildBridgeRequestId({
      agentUserId: input.agentUserId,
      sessionKey: input.sessionKey,
      assistantIndex,
      userIndex,
      question,
      answer,
    });
    if (seenRequestIds.has(requestId)) continue;
    seenRequestIds.add(requestId);

    exchanges.push({
      question,
      answer,
      targetSection,
      requestId,
      assistantIndex,
      userIndex,
      sessionKey: input.sessionKey,
    });
  }

  return exchanges.sort((a, b) => a.userIndex - b.userIndex);
}

export function detectBridgeExchange(input: {
  messages: unknown[];
  agentUserId: string;
  sessionKey: string;
}): DetectedBridgeExchange | undefined {
  return detectBridgeExchanges(input).at(-1);
}

export function buildTooTooBridgePrompt(): string {
  return [
    "<tootoo_bridge>",
    "[NOTE: The current user linked this agent to TooToo. Treat this as behavioral guidance.]",
    "When it fits the moment, you may ask one natural discovery question that grows out of the current conversation.",
    "Keep it grounded in what the user is already discussing and do not derail practical help.",
    "Prefer reflective questions about values, beliefs, principles, ideas, dreams, practices, shadows, or legacy.",
    "Do not force a questionnaire or ask repeated discovery questions in back-to-back turns.",
    "Only explicit user answers count. Do not infer or restate personal content the user did not clearly say.",
    "</tootoo_bridge>",
  ].join("\n");
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

export function createBridgeHandler(
  client: CortexClient,
  options: CreateBridgeHandlerOptions,
) {
  const {
    logger,
    retryQueue,
    getUserId,
    userIdReady,
    pluginSessionId,
    auditLogger,
  } = options;

  let linkStatus: LinkStatusSnapshot = {
    linked: false,
    checkedAt: 0,
  };
  let pendingLinkStatusCheck: Promise<LinkStatusSnapshot> | null = null;
  const handledRequestIds = new Map<string, number>();

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
        const next: LinkStatusSnapshot = {
          linked: result.linked,
          checkedAt: Date.now(),
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

  async function getPromptContext(): Promise<string | undefined> {
    const status = await refreshLinkStatus();
    return status.linked ? buildTooTooBridgePrompt() : undefined;
  }

  async function handleAgentEnd(event: AgentEndEvent): Promise<boolean> {
    if (event.aborted) return false;
    if (!Array.isArray(event.messages) || event.messages.length === 0) return false;
    if (userIdReady) await userIdReady;

    const agentUserId = getUserId();
    if (!agentUserId) return false;

    const status = await refreshLinkStatus();
    if (!status.linked) return false;

    trimHandledRequests(handledRequestIds);

    const exchanges = detectBridgeExchanges({
      messages: event.messages,
      agentUserId,
      sessionKey: event.sessionKey ?? event.sessionId ?? pluginSessionId ?? "__default__",
    });
    const pendingExchanges = exchanges.filter((exchange) => {
      if (handledRequestIds.has(exchange.requestId)) {
        logger.debug?.(`Cortex bridge: duplicate exchange skipped requestId=${exchange.requestId}`);
        return false;
      }
      return true;
    });
    if (pendingExchanges.length === 0) return false;

    const performSubmit = async (exchange: DetectedBridgeExchange) => {
      const request: BridgeQARequest = {
        user_id: agentUserId,
        request_id: exchange.requestId,
        entries: [
          {
            question: exchange.question,
            answer: exchange.answer,
            target_section: exchange.targetSection,
          },
        ],
      };

      if (auditLogger) {
        await auditLogger.log({
          feature: "bridge-qa",
          method: "POST",
          endpoint: "/v1/bridge/qa",
          payload: JSON.stringify(request, null, 2),
          sessionId: exchange.sessionKey,
          userId: agentUserId,
          messageCount: 2,
        });
      }

      const response = await client.submitBridgeQA(request);
      if (!response.accepted) {
        throw new Error(`Cortex bridge/qa failed: accepted=false requestId=${exchange.requestId}`);
      }

      logger.info(
        `Cortex bridge: accepted requestId=${exchange.requestId} forwarded=${response.forwarded} queuedForRetry=${response.queued_for_retry} entries=${response.entries_sent}`,
      );
    };
    let handledAny = false;

    for (const exchange of pendingExchanges) {
      handledRequestIds.set(exchange.requestId, Date.now());
      logger.info(
        `Cortex bridge: detected discovery exchange requestId=${exchange.requestId} sessionId=${exchange.sessionKey} section=${exchange.targetSection}`,
      );

      try {
        await performSubmit(exchange);
        handledAny = true;
      } catch (err) {
        const statusCode = extractErrorStatusCode(err);
        if (statusCode === 404) {
          linkStatus = {
            linked: false,
            checkedAt: Date.now(),
          };
        }

        if (retryQueue && isRetryableBridgeError(err)) {
          logger.warn(`Cortex bridge failed, queuing retry requestId=${exchange.requestId}: ${String(err)}`);
          retryQueue.enqueue(() => performSubmit(exchange), `bridge-${exchange.requestId}`);
          handledAny = true;
          continue;
        }

        logger.warn(`Cortex bridge failed requestId=${exchange.requestId}: ${String(err)}`);
        if (!linkStatus.linked) break;
      }
    }

    return handledAny;
  }

  return {
    refreshLinkStatus,
    getPromptContext,
    handleAgentEnd,
  };
}
