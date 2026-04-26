import { createHash } from "node:crypto";
import type {
  BridgeQARequest,
  BridgeTargetSection,
  CortexClient,
} from "../../cortex/client.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { isHeartbeatTurn } from "../../internal/heartbeat-detect.js";
import {
  filterConversationMessagesForMemory,
  shouldUseUserMessageForMemory,
} from "../../internal/message-provenance.js";
import type { RetryQueue } from "../../internal/retry-queue.js";
import type { ClawDeployBridgeTraceClient, ClawDeployBridgeTraceEvent } from "../../internal/clawdeploy-bridge-traces.js";
import { redactBridgeTraceError } from "../../internal/clawdeploy-bridge-traces.js";
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

interface SkippedUnmappedQuestion {
  question: string;
  assistantIndex: number;
  userIndex: number;
}

interface AgentEndEvent {
  messages?: unknown[];
  aborted?: boolean;
  sessionKey?: string;
  sessionId?: string;
}

interface BridgePromptEvent {
  prompt?: string;
  finalPromptText?: string;
  messages?: unknown[];
  sessionKey?: string;
  sessionId?: string;
}

interface BridgeSessionState {
  userTurns: number;
  lastQuestionTurn?: number;
  lastQuestionAt?: number;
  lastAnsweredTurn?: number;
  questionPending?: boolean;
  awaitingBridgeQuestion?: boolean;
}

export interface CreateBridgeHandlerOptions {
  logger: Logger;
  retryQueue?: RetryQueue;
  getUserId: () => string | undefined;
  userIdReady?: Promise<void>;
  pluginSessionId?: string;
  auditLogger?: AuditLogger;
  bridgeTraceClient?: ClawDeployBridgeTraceClient;
}

const LINK_STATUS_TTL_MS = 60_000;
const HANDLED_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDLED_REQUEST_MAX = 1000;
const MIN_ANSWER_CHARS = 5;
const MAX_QUESTION_CHARS = 400;
const MAX_ANSWER_CHARS = 5000;
const MIN_REFLECTIVE_MESSAGE_CHARS = 24;
const MIN_REFLECTIVE_MESSAGE_WORDS = 5;
const BRIDGE_QUESTION_COOLDOWN_TURNS = 4;
const BRIDGE_ANSWER_COOLDOWN_TURNS = 8;
const BRIDGE_QUESTION_COOLDOWN_MS = 10 * 60 * 1000;
const CANONICAL_BRIDGE_QUESTIONS = new Set([
  "what do you value most in your work",
  "what do you believe to be true",
  "what are your non-negotiables",
  "what are you curious about right now",
  "what do you dream about",
  "what practice keeps you grounded",
  "what are you afraid of",
  "how do you want to be remembered",
]);

const LOOKUP_SHAPE_RE = /^(?:what (?:is|are|does|do)|which|where|when|how (?:many|much|long))\b/i;
const TECHNICAL_LOOKUP_RE = /\b(?:file|files|repo|repository|package|dependency|dependencies|endpoint|api|port|timeout|ttl|database|schema|migration|commit|branch|log(?:s)?|stack trace|error|test(?:s)?|env|environment variable|config|setting|settings|version|runtime|token|cache|enum|function|method|class|module|library|table|column|redis)\b/i;
const LOW_SIGNAL_ANSWER_RE = /^(?:ok|okay|yes|no|maybe|not sure|i don't know|idk|sure|sounds good|thanks|thank you)[.!?]*$/i;
const CLARIFYING_QUESTION_RE = /^(?:what|why|how|who|where|when|which|can|could|would|do|does|did|is|are|am|should|will|have|has)\b/i;
const REFLECTIVE_OPENING_RE = /\b(?:i(?:'m| am)?\s+(?:rethinking|wondering|feeling|struggling|stuck|lost|burned out|burnt out|questioning)|i(?:'ve| have) been\s+(?:rethinking|wondering|feeling|struggling)|i(?:'m| am) trying to (?:figure out|understand)\b|what matters to me\b|what i want from\b|who i am\b|my future\b|i want my (?:life|work|future)\b)\b/i;
const REFLECTIVE_SIGNAL_RE = /\b(?:value|values|believe|belief|care about|important|meaningful|purpose|aligned|future|dream|dreams|hope|aspire|fear|afraid|stuck|burned out|burnt out|lost|curious|wondering|rethinking|figuring out|non-negotiable|remembered|fulfilling|matters most)\b/i;
const PERSONAL_DISCOVERY_RE = /\b(?:about myself|for me|to me|who i am|my (?:life|work|future|career|purpose|values|identity)|what matters to me|what i want from|what would feel (?:meaningful|aligned)|how i want to be remembered)\b/i;
const FIRST_PERSON_RE = /\b(?:i|i'm|i’ve|i've|me|my|myself)\b/i;
const DIRECT_TASKING_RE = /\b(?:fix|debug|solve|implement|write|update|edit|change|refactor|add|remove|delete|check|review|look at|show me|tell me|give me|explain|run|test|build|deploy)\b/i;
const TOOLING_HINT_RE = /\b(?:npm|pnpm|yarn|uv|pytest|vitest|tsc|git|docker|kubernetes|postgres|redis)\b/i;
const CODEISH_HINT_RE = /`[^`]+`|\b[A-Za-z_][\w]*\([^)]*\)|=>|(?:^|\s)(?:\/|\.\/|\.\.\/)[\w./-]+/;

const SECTION_HINTS: Array<{ section: BridgeTargetSection; patterns: RegExp[]; keywords: string[] }> = [
  {
    section: "coreValues",
    patterns: [
      /\bwhat do you value(?: most)?\b/i,
      /\bwhat matters most to you\b/i,
      /\bwhat do you care about(?: most)?\b/i,
      /\bwhat feels most important to you\b/i,
      /\bwhat makes .* feel meaningful\b/i,
      /\bwhat (?:are you|do you find yourself) (?:\w+ )?(?:saying|drawn to|pulled toward)\b/i,
      /\bwhat (?:draws|pulls|calls) you\b/i,
      /\bwhat would you (?:fight|sacrifice|give up .+) for\b/i,
      /\bwhat do you (?:keep coming|always come) back to\b/i,
      /\bwhat (?:lights you up|energizes you|fills you up)\b/i,
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
      "drawn to",
      "pulled toward",
      "saying yes",
      "say yes",
      "lights you up",
      "energizes",
      "fills you",
      "come back to",
      "keeps you going",
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
      /\bwhat do you (?:know|hold) to be true\b/i,
      /\bwhat truth(?:s)? (?:guide|anchor|ground) you\b/i,
    ],
    keywords: [
      "believe",
      "belief",
      "beliefs",
      "true to you",
      "assumption",
      "assumptions",
      "worldview",
      "conviction",
      "know to be true",
      "hold to be true",
    ],
  },
  {
    section: "principles",
    patterns: [
      /\bwhat principle(?:s)? guide you\b/i,
      /\bwhat rule(?:s)? do you live by\b/i,
      /\bwhat line won't you cross\b/i,
      /\bwhat standard do you hold yourself to\b/i,
      /\bwhat principle(?:s)? matter most\b/i,
      /\bwhat (?:are you|do you find yourself) saying (?:no|'no') to\b/i,
      /\bwhat do you (?:refuse|reject|resist|protect)\b/i,
      /\bwhat (?:won't|wouldn't) you compromise\b/i,
      /\bwhere do you draw the line\b/i,
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
      "saying no",
      "say no",
      "refuse",
      "protect",
      "compromise",
      "draw the line",
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
      /\bwhat would you (?:change|do differently)\b/i,
      /\bif you could (?:design|redesign|rebuild|reshape)\b/i,
    ],
    keywords: [
      "dream",
      "dreams",
      "hope",
      "future",
      "ideal",
      "aspire",
      "aspiration",
      "want your life",
      "want your work",
      "change about",
      "do differently",
      "if you could",
    ],
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
      /\bwhat (?:are|do) (?:your|you) (?:top|main|biggest) (?:\w+ )?obligation/i,
      /\bwhat (?:takes|occupies|fills|consumes) (?:most of )?your (?:time|energy|day)\b/i,
      /\bhow do you (?:spend|structure|organize) your (?:time|day|week)\b/i,
      /\bwhat does your (?:daily|typical|average) (?:routine|rhythm|day) look like\b/i,
      /\bwhat(?:'s| is) the right amount of pushback\b/i,
      /\bhow should someone push back\b/i,
      /\bwhat communication cadence\b/i,
      /\bwhat checkpoint rhythm\b/i,
      /\bwhat ownership pattern\b/i,
      /\bwhat (?:work|operating) rhythm\b/i,
      /\bwhat .*keeps? work from drifting\b/i,
      /\bwhat .*helps .*team stay aligned\b/i,
      /\bbefore it feels like nagging instead of helpful\b/i,
    ],
    keywords: [
      "practice",
      "practices",
      "habit",
      "habits",
      "routine",
      "routines",
      "ritual",
      "grounded",
      "aligned",
      "reset",
      "obligation",
      "obligations",
      "commitment",
      "commitments",
      "daily rhythm",
      "takes your time",
      "occupies your",
      "spend your time",
      "operating rhythm",
      "work rhythm",
      "communication cadence",
      "pushback",
      "clear ownership",
      "short written plans",
      "low-drama execution",
      "fast checkpoints",
      "work drifts",
      "work from drifting",
    ],
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
      /\bwhat (?:are you|do you keep) (?:resisting|running from|hiding from)\b/i,
      /\bwhat (?:drains|exhausts|depletes) you\b/i,
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
      "resisting",
      "running from",
      "hiding from",
      "drains you",
      "exhausts you",
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

function normalizeQuestionForCanonicalMatch(question: string): string {
  return normalizeRequestText(question).replace(/[.!?]+$/g, "");
}

function isCanonicalBridgeQuestion(question: string): boolean {
  return CANONICAL_BRIDGE_QUESTIONS.has(normalizeQuestionForCanonicalMatch(question));
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

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function findLastQuestionStart(candidate: string): number | undefined {
  const questionStartPattern = /(?:^|[.!?;:]\s+|,\s+|[-*•]\s+|[>"'“‘(\[]\s*)(what|why|how|who|where|when|which|can|could|would|do|does|did|is|are|am|should|will|have|has)\b/gi;
  let match: RegExpExecArray | null;
  let lastStart: number | undefined;

  while ((match = questionStartPattern.exec(candidate)) !== null) {
    const token = match[1];
    const start = match.index + match[0].lastIndexOf(token);
    lastStart = start;
  }

  return lastStart;
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

    candidate = candidate.replace(/^[>\-*•\d.)\s]+/, "").replace(/\s+/g, " ").trim();
    const questionStart = findLastQuestionStart(candidate);
    if (questionStart !== undefined) {
      candidate = candidate.slice(questionStart).trim();
    }

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

function getLatestEligibleUserMessage(messages: BridgeConversationMessage[]): BridgeConversationMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

function promptCandidateFromEvent(event: BridgePromptEvent): string {
  return sanitizeConversationText(event.prompt || event.finalPromptText || "").replace(/\s+/g, " ").trim();
}

function sameTurnText(left: string, right: string): boolean {
  const normalizedLeft = normalizeRequestText(left);
  const normalizedRight = normalizeRequestText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  return shorter.length >= MIN_REFLECTIVE_MESSAGE_CHARS && longer.includes(shorter);
}

function latestUserTextFromEvent(event: BridgePromptEvent): {
  latestUser?: BridgeConversationMessage;
  normalizedMessages: BridgeConversationMessage[];
  source: "messages" | "prompt" | "none";
  missingMessages: boolean;
  provenanceFiltered: boolean;
} {
  const rawMessages = Array.isArray(event.messages) ? event.messages : [];
  const normalizedMessages = normalizeConversationMessages(rawMessages);
  const latestUser = getLatestEligibleUserMessage(normalizedMessages);
  const promptText = promptCandidateFromEvent(event);
  const missingMessages = rawMessages.length === 0;
  const rawUserMessages = rawMessages.filter((message): message is Record<string, unknown> => (
    typeof message === "object" &&
    message !== null &&
    (message as Record<string, unknown>).role === "user"
  ));
  const provenanceFiltered = rawUserMessages.length > 0 && rawUserMessages.every((message) => !shouldUseUserMessageForMemory(message));

  if (promptText && (missingMessages || (latestUser && !sameTurnText(latestUser.content, promptText)))) {
    return {
      latestUser: {
        role: "user",
        content: promptText,
        originalIndex: -1,
        provenance: { kind: "synthetic_prompt" },
      },
      normalizedMessages,
      source: "prompt",
      missingMessages,
      provenanceFiltered,
    };
  }

  if (latestUser) {
    return {
      latestUser,
      normalizedMessages,
      source: "messages",
      missingMessages,
      provenanceFiltered,
    };
  }

  return {
    normalizedMessages,
    source: "none",
    missingMessages,
    provenanceFiltered,
  };
}

function looksTechnicalTurn(text: string): boolean {
  return (
    TECHNICAL_LOOKUP_RE.test(text) ||
    TOOLING_HINT_RE.test(text) ||
    CODEISH_HINT_RE.test(text)
  );
}

function isReflectiveOpportunity(latestUserText: string, messages: BridgeConversationMessage[]): boolean {
  const normalized = latestUserText.replace(/\s+/g, " ").trim();
  if (normalized.length < MIN_REFLECTIVE_MESSAGE_CHARS) return false;
  if (countWords(normalized) < MIN_REFLECTIVE_MESSAGE_WORDS) return false;
  if (LOW_SIGNAL_ANSWER_RE.test(normalized)) return false;
  if (isLowSignal(normalized)) return false;
  if (looksTechnicalTurn(normalized)) return false;
  if (DIRECT_TASKING_RE.test(normalized) && !REFLECTIVE_OPENING_RE.test(normalized)) return false;
  if (REFLECTIVE_OPENING_RE.test(normalized)) return true;
  if (FIRST_PERSON_RE.test(normalized) && (REFLECTIVE_SIGNAL_RE.test(normalized) || PERSONAL_DISCOVERY_RE.test(normalized))) {
    return true;
  }

  const recentContext = messages
    .slice(-4)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return FIRST_PERSON_RE.test(recentContext) && PERSONAL_DISCOVERY_RE.test(recentContext) && REFLECTIVE_SIGNAL_RE.test(recentContext);
}

interface DetectedBridgeQuestion {
  question: string;
  targetSection: BridgeTargetSection;
  assistantIndex: number;
  questionId: string;
}

function buildBridgeQuestionId(input: {
  sessionKey: string;
  assistantIndex: number;
  question: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      sessionKey: input.sessionKey,
      assistantIndex: input.assistantIndex,
      question: normalizeRequestText(input.question),
    }))
    .digest("hex")
    .slice(0, 32);
}

export function detectBridgeQuestions(input: {
  messages: unknown[];
  sessionKey: string;
}): DetectedBridgeQuestion[] {
  const normalized = normalizeConversationMessages(input.messages);
  if (normalized.length === 0) return [];

  const questions: DetectedBridgeQuestion[] = [];
  const seenQuestionIds = new Set<string>();

  for (const message of normalized) {
    if (message.role !== "assistant") continue;
    const question = extractLastQuestion(message.content);
    if (!question) continue;

    const targetSection = inferTargetSection(question);
    if (!targetSection) continue;

    const questionId = buildBridgeQuestionId({
      sessionKey: input.sessionKey,
      assistantIndex: message.originalIndex,
      question,
    });
    if (seenQuestionIds.has(questionId)) continue;
    seenQuestionIds.add(questionId);

    questions.push({
      question,
      targetSection,
      assistantIndex: message.originalIndex,
      questionId,
    });
  }

  return questions.sort((a, b) => a.assistantIndex - b.assistantIndex);
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
  onSkippedUnmappedQuestion?: (skipped: SkippedUnmappedQuestion) => void;
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

    const assistantIndex = normalized[priorAssistantIndex].originalIndex;
    const userIndex = normalized[userCursor].originalIndex;
    const targetSection = inferTargetSection(question);
    if (!targetSection) {
      input.onSkippedUnmappedQuestion?.({
        question,
        assistantIndex,
        userIndex,
      });
      continue;
    }

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

export type BridgePromptMode = "full" | "followup" | false;

export function buildTooTooBridgePrompt(): string {
  return [
    "<tootoo_bridge>",
    "[REQUIRED BEHAVIOR — the user linked this agent to TooToo.]",
    "When the user opens with something reflective or personal, you MUST respond with ONLY one short discovery question. Nothing else. No advice, no frameworks, no bullet points, no preamble, no follow-up offers.",
    "Pick exactly one of these questions. Do not invent a custom question:",
    "- \"What do you value most in your work?\"",
    "- \"What do you believe to be true?\"",
    "- \"What are your non-negotiables?\"",
    "- \"What are you curious about right now?\"",
    "- \"What do you dream about?\"",
    "- \"What practice keeps you grounded?\"",
    "- \"What are you afraid of?\"",
    "- \"How do you want to be remembered?\"",
    "Choose the question that best fits what the user is talking about. Do NOT rephrase into creative or abstract alternatives. Do NOT ask broad custom questions about work style, pushback, cadence, or checkpoints — use the closest listed question instead. The exact wording matters for downstream processing.",
    "WRONG: giving advice, then asking a question at the end. WRONG: asking the question, then adding context or suggestions. RIGHT: just the question, by itself.",
    "After the user answers a discovery question (on the NEXT turn), acknowledge in one plain sentence and move on. No enthusiasm, no praise, no coaching energy. Do not offer to build plans, frameworks, exercises, templates, or manifestos. Keep the response to 2-3 sentences total. Do not ask another discovery question.",
    "Only explicit user answers count. Do not infer or restate personal content the user did not clearly say.",
    "</tootoo_bridge>",
  ].join("\n");
}

export function buildBridgeFollowUpPrompt(): string {
  return [
    "<tootoo_bridge_followup>",
    "[REQUIRED BEHAVIOR — the user just answered a personal discovery question.]",
    "Acknowledge their answer in one plain sentence. No superlatives, no praise, no coaching tone.",
    "Then return to whatever they were working on. Keep the total response to 2-3 sentences.",
    "Do NOT: offer plans, frameworks, exercises, templates, manifestos, or 'if you want, I can...' suggestions.",
    "Do NOT: expand on their answer with bullet points, numbered steps, or structured exercises.",
    "Do NOT: use phrases like 'That's powerful', 'That's beautiful', 'That gives us a clear north star'.",
    "The discovery moment is complete. Move on.",
    "</tootoo_bridge_followup>",
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
    bridgeTraceClient,
  } = options;

  let linkStatus: LinkStatusSnapshot = {
    linked: false,
    checkedAt: 0,
  };
  let pendingLinkStatusCheck: Promise<LinkStatusSnapshot> | null = null;
  const handledRequestIds = new Map<string, number>();
  const handledQuestionIds = new Map<string, number>();
  const trackedBridgeQuestionIds = new Map<string, number>();
  const skippedUnmappedQuestionIds = new Map<string, number>();
  const sessionStates = new Map<string, BridgeSessionState>();

  function resolveBridgeSessionKey(event: { sessionKey?: string; sessionId?: string }): string {
    return event.sessionKey ?? event.sessionId ?? pluginSessionId ?? "__default__";
  }

  function getSessionState(sessionKey: string): BridgeSessionState {
    let state = sessionStates.get(sessionKey);
    if (!state) {
      state = { userTurns: 0 };
      sessionStates.set(sessionKey, state);
    }
    return state;
  }

  function linkStatusLabel(): "active" | "inactive" | "unknown" {
    if (linkStatus.checkedAt === 0) return "unknown";
    return linkStatus.linked ? "active" : "inactive";
  }

  function logPromptDecision(input: {
    mode: BridgePromptMode;
    reason?: string;
    sessionKey: string;
    missingMessages: boolean;
    latestUserTextSource: "messages" | "prompt" | "none";
    reflectiveOpportunity: boolean;
    cooldownReason?: "answer" | "turn" | "time" | "none";
    linkStatus?: "active" | "inactive" | "unknown";
  }): void {
    const reason = input.reason ??
      (input.mode === "full"
        ? "injected_full"
        : input.mode === "followup"
          ? "injected_followup"
          : "no_injection");
    logger.debug?.(
      `Cortex bridge: prompt decision mode=${input.mode || "none"} reason=${reason} ` +
        `sessionId=${input.sessionKey} missingMessages=${input.missingMessages} ` +
        `latestUserTextSource=${input.latestUserTextSource} reflectiveOpportunity=${input.reflectiveOpportunity} ` +
        `cooldown=${input.cooldownReason ?? "none"} linkStatus=${input.linkStatus ?? linkStatusLabel()}`,
    );
  }

  function emitBridgeTrace(
    exchange: DetectedBridgeExchange,
    agentUserId: string,
    event: Omit<ClawDeployBridgeTraceEvent, "requestId" | "sessionKey" | "cortexAgentUserId" | "agentUserId" | "targetSection">,
  ): void {
    if (!bridgeTraceClient) return;

    try {
      bridgeTraceClient.emitBridgeTrace({
        requestId: exchange.requestId,
        sessionKey: exchange.sessionKey,
        cortexAgentUserId: agentUserId,
        agentUserId,
        targetSection: exchange.targetSection,
        ...event,
      });
    } catch (err) {
      logger.debug?.(`Cortex bridge trace emission failed: ${redactBridgeTraceError(err)}`);
    }
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

  async function shouldInjectPrompt(event: BridgePromptEvent): Promise<BridgePromptMode> {
    const sessionKey = resolveBridgeSessionKey(event);
    const promptText = promptCandidateFromEvent(event);
    if (isHeartbeatTurn(promptText)) {
      logPromptDecision({
        mode: false,
        reason: "heartbeat",
        sessionKey,
        missingMessages: !Array.isArray(event.messages) || event.messages.length === 0,
        latestUserTextSource: "none",
        reflectiveOpportunity: false,
      });
      return false;
    }

    const userContext = latestUserTextFromEvent(event);
    const { latestUser, normalizedMessages, source, missingMessages, provenanceFiltered } = userContext;
    if (!latestUser) {
      logPromptDecision({
        mode: false,
        reason: provenanceFiltered ? "provenance_filtered" : "no_latest_user",
        sessionKey,
        missingMessages,
        latestUserTextSource: source,
        reflectiveOpportunity: false,
      });
      return false;
    }

    const sessionState = getSessionState(sessionKey);
    sessionState.userTurns += 1;
    const reflectiveOpportunity = isReflectiveOpportunity(latestUser.content, normalizedMessages);

    // Answer cooldown takes precedence: if a bridge answer was already captured
    // recently, suppress everything (including follow-up prompts).
    if (
      sessionState.lastAnsweredTurn != null &&
      sessionState.userTurns - sessionState.lastAnsweredTurn < BRIDGE_ANSWER_COOLDOWN_TURNS
    ) {
      sessionState.questionPending = false;
      sessionState.awaitingBridgeQuestion = false;
      logPromptDecision({
        mode: false,
        reason: "cooldown",
        sessionKey,
        missingMessages,
        latestUserTextSource: source,
        reflectiveOpportunity,
        cooldownReason: "answer",
      });
      logger.debug?.(`Cortex bridge: prompt suppressed by answer cooldown sessionId=${sessionKey}`);
      return false;
    }

    // Turn/time cooldowns: suppress the full bridge prompt but check if we
    // should inject a lighter follow-up prompt instead. The follow-up fires
    // exactly once on the turn immediately after the bridge question (the turn
    // where the user is answering it).
    const suppressedByTurnCooldown =
      sessionState.lastQuestionTurn != null &&
      sessionState.userTurns - sessionState.lastQuestionTurn < BRIDGE_QUESTION_COOLDOWN_TURNS;
    const suppressedByTimeCooldown =
      sessionState.lastQuestionAt != null &&
      Date.now() - sessionState.lastQuestionAt < BRIDGE_QUESTION_COOLDOWN_MS;

    if (suppressedByTurnCooldown || suppressedByTimeCooldown) {
      // If a bridge question is pending AND this is the very next turn,
      // inject the follow-up prompt to guide the model back to practical help.
      if (
        sessionState.questionPending &&
        sessionState.lastQuestionTurn != null &&
        sessionState.userTurns - sessionState.lastQuestionTurn === 1 &&
        isExplicitAnswer(latestUser.content) &&
        !reflectiveOpportunity
      ) {
        sessionState.questionPending = false;
        sessionState.awaitingBridgeQuestion = false;
        const status = await refreshLinkStatus();
        if (status.linked) {
          logPromptDecision({
            mode: "followup",
            sessionKey,
            missingMessages,
            latestUserTextSource: source,
            reflectiveOpportunity,
            cooldownReason: suppressedByTurnCooldown ? "turn" : "time",
            linkStatus: "active",
          });
          logger.debug?.(`Cortex bridge: injecting follow-up prompt sessionId=${sessionKey}`);
          return "followup";
        }
        logPromptDecision({
          mode: false,
          reason: "link_inactive",
          sessionKey,
          missingMessages,
          latestUserTextSource: source,
          reflectiveOpportunity,
          cooldownReason: suppressedByTurnCooldown ? "turn" : "time",
          linkStatus: "inactive",
        });
      }

      sessionState.questionPending = false;
      sessionState.awaitingBridgeQuestion = false;
      logPromptDecision({
        mode: false,
        reason: "cooldown",
        sessionKey,
        missingMessages,
        latestUserTextSource: source,
        reflectiveOpportunity,
        cooldownReason: suppressedByTurnCooldown ? "turn" : "time",
      });
      logger.debug?.(
        `Cortex bridge: prompt suppressed by ${suppressedByTurnCooldown ? "turn" : "time"} cooldown sessionId=${sessionKey}`,
      );
      return false;
    }

    if (!reflectiveOpportunity) {
      logPromptDecision({
        mode: false,
        reason: "not_reflective",
        sessionKey,
        missingMessages,
        latestUserTextSource: source,
        reflectiveOpportunity,
      });
      return false;
    }

    const status = await refreshLinkStatus();
    if (!status.linked) {
      logPromptDecision({
        mode: false,
        reason: "link_inactive",
        sessionKey,
        missingMessages,
        latestUserTextSource: source,
        reflectiveOpportunity,
        linkStatus: "inactive",
      });
      return false;
    }
    sessionState.awaitingBridgeQuestion = true;
    logPromptDecision({
      mode: "full",
      sessionKey,
      missingMessages,
      latestUserTextSource: source,
      reflectiveOpportunity,
      linkStatus: "active",
    });
    return "full";
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
    trimHandledRequests(handledQuestionIds);
    trimHandledRequests(trackedBridgeQuestionIds);
    trimHandledRequests(skippedUnmappedQuestionIds);

    const sessionKey = resolveBridgeSessionKey(event);
    const sessionState = getSessionState(sessionKey);
    const questions = detectBridgeQuestions({
      messages: event.messages,
      sessionKey,
    });
    const latestNewQuestion = [...questions].reverse().find((question) => !handledQuestionIds.has(question.questionId));
    if (latestNewQuestion) {
      handledQuestionIds.set(latestNewQuestion.questionId, Date.now());
      if (sessionState.awaitingBridgeQuestion) {
        trackedBridgeQuestionIds.set(latestNewQuestion.questionId, Date.now());
      }
      sessionState.lastQuestionTurn = sessionState.userTurns;
      sessionState.lastQuestionAt = Date.now();
      sessionState.questionPending = true;
      sessionState.awaitingBridgeQuestion = false;
    } else {
      sessionState.awaitingBridgeQuestion = false;
    }

    const exchanges = detectBridgeExchanges({
      messages: event.messages,
      agentUserId,
      sessionKey,
      onSkippedUnmappedQuestion: ({ question, assistantIndex, userIndex }) => {
        const questionId = buildBridgeQuestionId({
          sessionKey,
          assistantIndex,
          question,
        });
        if (skippedUnmappedQuestionIds.has(questionId)) return;
        skippedUnmappedQuestionIds.set(questionId, Date.now());
        logger.debug?.(
          `Cortex bridge: skipped candidate exchange: unmapped question questionId=${questionId} sessionId=${sessionKey} assistantIndex=${assistantIndex} userIndex=${userIndex}`,
        );
      },
    });
    const pendingExchanges = exchanges.filter((exchange) => {
      if (handledRequestIds.has(exchange.requestId)) {
        logger.debug?.(`Cortex bridge: duplicate exchange skipped requestId=${exchange.requestId}`);
        return false;
      }
      const questionId = buildBridgeQuestionId({
        sessionKey,
        assistantIndex: exchange.assistantIndex,
        question: exchange.question,
      });
      if (!trackedBridgeQuestionIds.has(questionId) && !isCanonicalBridgeQuestion(exchange.question)) {
        logger.debug?.(
          `Cortex bridge: skipped candidate exchange: untracked non-canonical question questionId=${questionId} sessionId=${sessionKey} assistantIndex=${exchange.assistantIndex} userIndex=${exchange.userIndex}`,
        );
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

      emitBridgeTrace(exchange, agentUserId, {
        status: "accepted",
        acceptedAt: new Date().toISOString(),
        forwarded: response.forwarded,
        queuedForRetry: response.queued_for_retry,
        entriesSent: response.entries_sent,
        metadata: {
          source: "openclaw-cortex",
          bridgeEventId: response.bridge_event_id,
          suggestionsCreated: response.suggestions_created,
          ownerType: response.owner_type,
          hasTootooUserId: Boolean(response.tootoo_user_id),
        },
      });

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
      emitBridgeTrace(exchange, agentUserId, {
        status: "detected",
        detectedAt: new Date().toISOString(),
        metadata: {
          source: "openclaw-cortex",
          assistantIndex: exchange.assistantIndex,
          userIndex: exchange.userIndex,
          entriesDetected: pendingExchanges.length,
        },
      });

      try {
        await performSubmit(exchange);
        handledAny = true;
      } catch (err) {
        emitBridgeTrace(exchange, agentUserId, {
          status: "failed",
          lastError: redactBridgeTraceError(err, [exchange.question, exchange.answer]),
          metadata: {
            source: "openclaw-cortex",
            retryable: isRetryableBridgeError(err),
            statusCode: extractErrorStatusCode(err),
          },
        });
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

    if (handledAny) {
      sessionState.userTurns = Math.max(sessionState.userTurns, 1);
      sessionState.lastAnsweredTurn = sessionState.userTurns;
    }

    return handledAny;
  }

  return {
    refreshLinkStatus,
    getPromptContext,
    shouldInjectPrompt,
    handleAgentEnd,
  };
}
