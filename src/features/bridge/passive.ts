import { createHash } from "node:crypto";
import type { BridgeTargetSection, PassiveBridgeCandidate } from "../../cortex/client.js";
import {
  filterConversationMessagesForMemory,
} from "../../internal/message-provenance.js";
import { isHeartbeatTurn } from "../../internal/heartbeat-detect.js";
import { isLowSignal, sanitizeConversationText } from "../capture/filter.js";

export const PASSIVE_BRIDGE_EXTRACTOR_VERSION = "openclaw-cortex-passive-v1";
export const MAX_PASSIVE_CANDIDATES_PER_TURN = 3;
export const MAX_PASSIVE_CANDIDATES_PER_SESSION = 5;

type PassiveRole = "assistant" | "user";

interface PassiveConversationMessage {
  role: PassiveRole;
  content: string;
  originalIndex: number;
}

export interface PassiveGateResult {
  shouldExtract: boolean;
  reason?: string;
}

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

function normalizeConversationMessages(messages: unknown[]): PassiveConversationMessage[] {
  const candidates = filterConversationMessagesForMemory(
    messages.flatMap((message, index) => {
      if (typeof message !== "object" || message === null) return [];
      const typed = message as Record<string, unknown>;
      if (typed.role !== "assistant" && typed.role !== "user") return [];
      if (!("content" in typed)) return [];
      return [{
        role: typed.role as PassiveRole,
        content: typed.content,
        provenance: typed.provenance,
        originalIndex: index,
      }];
    }),
  );

  return candidates
    .map((message) => ({
      role: message.role as PassiveRole,
      content: sanitizeConversationText(extractContent(message.content)).replace(/\s+/g, " ").trim(),
      originalIndex: message.originalIndex,
    }))
    .filter((message) => message.content.length > 0);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const ACK_RE = /^(?:ok|okay|yes|yeah|yep|no|nope|sure|sounds good|thanks|thank you|got it|cool|great)[.!?]*$/i;
const TASK_ONLY_RE = /^(?:please\s+)?(?:fix|debug|solve|implement|write|update|edit|change|refactor|add|remove|delete|check|review|look at|show me|tell me|give me|explain|run|test|build|deploy)\b(?![\s\S]*\b(?:i|my|me|for me|to me|prefer|work best|like working|hate being|hidden magic|owner|written down)\b)/i;
const CODE_FENCE_RE = /```[\s\S]*```/;
const CODEISH_RE = /(?:^|\s)(?:const|let|var|function|class|interface|type|import|export|def|SELECT|CREATE|ERROR|WARN|INFO|Traceback|at\s+\S+\(|npm ERR!)\b|=>|[{};]{2,}/m;
const PASTED_QUOTE_RE = /(?:^|\n)\s*(?:>|#{1,6}\s|[-*]\s)|\bREADME\b.*\bsays\b/i;
const OWNERSHIP_RE = /\b(?:i|i'm|i am|i've|i have|my|me|for me|to me|honestly that's how i|that's how i|i like working|i prefer|i work best)\b/i;
const TRANSIENT_OR_RISK_RE = /\b(?:flat all week|can't keep doing this|cannot keep doing this|kill myself|suicide|self[- ]harm|diagnosed|depressed|bipolar|adhd|autistic|trauma|panic attack)\b/i;
const DURABLE_SIGNAL_RE = /\b(?:prefer|work best|like working|value|boundary|non-negotiable|written down|explicit checks?|hidden magic|fallback owner|clear owner|decision rights|short written plans?|low-drama|fast checkpoints?|follow through|ownership|owner|avoid them|shut down)\b/i;

function latestUserMessage(messages: PassiveConversationMessage[]): PassiveConversationMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

function isPastedWithoutOwnership(text: string): boolean {
  if (!PASTED_QUOTE_RE.test(text) && !CODE_FENCE_RE.test(text)) return false;
  return !OWNERSHIP_RE.test(text);
}

function isCodeOrLogOnly(text: string): boolean {
  if (!CODE_FENCE_RE.test(text) && !CODEISH_RE.test(text)) return false;
  return !OWNERSHIP_RE.test(text);
}

export function shouldAttemptPassiveBridgeExtraction(rawMessages: unknown[]): PassiveGateResult {
  const messages = normalizeConversationMessages(rawMessages).slice(-6);
  const latestUser = latestUserMessage(messages);
  if (!latestUser) return { shouldExtract: false, reason: "no_user_evidence" };

  const text = latestUser.content;
  if (isHeartbeatTurn(text)) return { shouldExtract: false, reason: "heartbeat" };
  if (text.length < 12 || countWords(text) < 3) return { shouldExtract: false, reason: "too_short" };
  if (ACK_RE.test(text) || isLowSignal(text)) return { shouldExtract: false, reason: "low_signal" };
  if (TRANSIENT_OR_RISK_RE.test(text)) return { shouldExtract: false, reason: "unsafe_or_transient" };
  if (isCodeOrLogOnly(text)) return { shouldExtract: false, reason: "code_or_log" };
  if (isPastedWithoutOwnership(text)) return { shouldExtract: false, reason: "pasted_without_ownership" };
  if (TASK_ONLY_RE.test(text)) return { shouldExtract: false, reason: "task_only" };
  if (!DURABLE_SIGNAL_RE.test(text)) return { shouldExtract: false, reason: "no_durable_signal" };

  return { shouldExtract: true };
}

function candidateFingerprint(candidate: Pick<PassiveBridgeCandidate, "content" | "evidence_quote">): string {
  return createHash("sha256")
    .update(`${candidate.content.toLowerCase().replace(/\s+/g, " ").trim()}\n${candidate.evidence_quote.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 16);
}

function makeCandidate(input: {
  content: string;
  section?: BridgeTargetSection;
  evidenceQuote: string;
  sourceIndex: number;
  reason: string;
  confidence?: number;
}): PassiveBridgeCandidate {
  return {
    content: input.content,
    suggested_section: input.section ?? "practices",
    source_type: "conversation",
    confidence: input.confidence ?? 0.86,
    risk_tier: "low",
    evidence_quote: input.evidenceQuote,
    source_message_indices: [input.sourceIndex],
    evidence_pointer: `message:${input.sourceIndex}`,
    reason: input.reason,
  };
}

function evidenceSentence(text: string, required: RegExp[]): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.find((sentence) => required.every((pattern) => pattern.test(sentence))) ?? text;
}

function candidateRules(text: string): Array<{ content: string; reason: string; section?: BridgeTargetSection; confidence?: number }> {
  const rules: Array<{ content: string; reason: string; section?: BridgeTargetSection; confidence?: number }> = [];

  if (/\bboring explicit checks?\b/i.test(text) && /\bhidden magic\b/i.test(text)) {
    rules.push({
      content: "Prefers boring explicit checks over hidden automation.",
      reason: "The user directly contrasted explicit checks with hidden magic.",
      confidence: 0.91,
    });
  } else if (/\bhidden magic\b/i.test(text)) {
    rules.push({
      content: "Prefers explicit checks over hidden automation.",
      reason: "The user described hidden magic as a recurring source of trouble.",
      confidence: 0.84,
    });
  } else if (/\bprefer(?:s|red|ring)?\b/i.test(text) && /\bexplicit checks?\b/i.test(text)) {
    rules.push({
      content: "Prefers explicit checks.",
      reason: "The user stated an explicit work preference.",
      confidence: 0.86,
    });
  }

  if (/\bfallback owner\b/i.test(text)) {
    rules.push({
      content: "Does not want to be the fallback owner for every decision.",
      reason: "The user stated a durable boundary around default ownership.",
      confidence: 0.88,
    });
  }

  if (/\bno owner\b/i.test(text) || /\bclear owner\b/i.test(text)) {
    rules.push({
      content: "Works better when projects have a clear owner.",
      reason: "The user linked ownership clarity to their work pattern.",
      confidence: 0.82,
    });
  }

  if (/\bwritten down\b/i.test(text) && /\bfollow through\b/i.test(text)) {
    rules.push({
      content: "Prefers important follow-through expectations to be written down.",
      reason: "The user framed written expectations as a work preference, with third-party detail omitted.",
      confidence: 0.84,
    });
  }

  if (/\bwork best\b/i.test(text) && /\bshort written plans?\b/i.test(text)) {
    rules.push({
      content: "Works best with short written plans.",
      reason: "The user stated a durable work-style preference.",
      confidence: 0.87,
    });
  }

  if (/\bdecision rights\b/i.test(text)) {
    rules.push({
      content: "Prefers clear decision rights.",
      reason: "The user stated a durable preference for decision clarity.",
      confidence: 0.86,
    });
  }

  return rules;
}

export function extractPassiveBridgeCandidates(rawMessages: unknown[]): PassiveBridgeCandidate[] {
  const messages = normalizeConversationMessages(rawMessages).slice(-6);
  if (!shouldAttemptPassiveBridgeExtraction(rawMessages).shouldExtract) return [];
  const latestUser = latestUserMessage(messages);
  if (!latestUser) return [];

  const candidates: PassiveBridgeCandidate[] = [];
  const seen = new Set<string>();
  for (const rule of candidateRules(latestUser.content)) {
    const candidate = makeCandidate({
      content: rule.content,
      section: rule.section,
      evidenceQuote: rule.content.includes("hidden automation")
        ? evidenceSentence(latestUser.content, [
            /hidden magic|explicit checks?/i,
            rule.content.includes("boring explicit") ? /prefer/i : /./,
          ])
        : latestUser.content,
      sourceIndex: latestUser.originalIndex,
      reason: rule.reason,
      confidence: rule.confidence,
    });
    const fingerprint = candidateFingerprint(candidate);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    candidates.push(candidate);
    if (candidates.length >= MAX_PASSIVE_CANDIDATES_PER_TURN) return candidates;
  }

  return candidates;
}

export function buildPassiveCandidateFingerprint(candidate: Pick<PassiveBridgeCandidate, "content" | "evidence_quote">): string {
  return candidateFingerprint(candidate);
}

export function buildPassiveBridgeRequestId(input: {
  agentUserId: string;
  sessionKey: string;
  turnIndex: number;
  candidates: Array<Pick<PassiveBridgeCandidate, "content" | "evidence_quote">>;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      agentUserId: input.agentUserId,
      sessionKey: input.sessionKey,
      turnIndex: input.turnIndex,
      candidates: input.candidates.map(candidateFingerprint).sort(),
    }))
    .digest("hex")
    .slice(0, 32);

  return `openclaw-passive-${digest}`;
}
