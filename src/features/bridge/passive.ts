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
export const PASSIVE_EXTRACTOR_TIMEOUT_MS = 3_000;
export const PASSIVE_EXTRACTOR_MAX_OUTPUT_TOKENS = 450;

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

export interface PassiveExtractorMessage {
  role: PassiveRole;
  content: string;
  index: number;
}

export interface PassiveExtractorInput {
  messages: PassiveExtractorMessage[];
  prompt: string;
  extractorVersion: string;
  maxCandidates: number;
  timeoutMs: number;
  maxOutputTokens: number;
  activeModelRef?: string;
}

export interface PassiveExtractorOutput {
  candidates: unknown[];
}

export type PassiveModelExtractor = (input: PassiveExtractorInput) => Promise<PassiveExtractorOutput>;

export interface PassiveValidationResult {
  accepted: PassiveBridgeCandidate[];
  rejected: Array<{ reason: string }>;
}

const VALID_SECTIONS = new Set<BridgeTargetSection>([
  "coreValues",
  "beliefs",
  "principles",
  "ideas",
  "dreams",
  "practices",
  "shadows",
  "legacy",
]);

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

export function normalizePassiveConversationMessages(messages: unknown[]): PassiveConversationMessage[] {
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
const TASK_ONLY_RE = /^(?:(?:please|can you|could you|would you)\s+)?(?:fix|debug|solve|implement|write|update|edit|change|refactor|add|remove|delete|check|review|look at|show me|tell me|give me|explain|run|test|build|deploy|make|create)\b(?![\s\S]*\b(?:i|my|me|for me|to me|prefer|work best|like working|hate being|hidden magic|owner|ownership|written down|tracking it|let it go)\b)/i;
const CODE_FENCE_RE = /```[\s\S]*```/;
const CODEISH_RE = /(?:^|\s)(?:const|let|var|function|class|interface|type|import|export|def|SELECT|CREATE|ERROR|WARN|INFO|Traceback|at\s+\S+\(|npm ERR!)\b|=>|[{};]{2,}/m;
const PASTED_QUOTE_RE = /(?:^|\n)\s*(?:>|#{1,6}\s|[-*]\s)|\bREADME\b.*\bsays\b/i;
const OWNERSHIP_RE = /\b(?:i|i'm|i am|i've|i have|my|me|for me|to me|honestly that's how i|that's how i|i like working|i prefer|i work best)\b/i;
// v1 intentionally over-blocks turns touching diagnosis, crisis, or protected-trait terms.
// Missing a benign candidate is safer than extracting sensitive identity or health claims.
const TRANSIENT_OR_RISK_RE = /\b(?:flat all week|can't keep doing this|cannot keep doing this|kill myself|suicide|self[- ]harm|diagnosed|depressed|bipolar|adhd|autistic|trauma|panic attack)\b/i;
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
  const messages = normalizePassiveConversationMessages(rawMessages).slice(-6);
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

  return { shouldExtract: true };
}

export function buildPassiveExtractorPrompt(): string {
  return [
    "You are reviewing a small recent conversation window after the assistant has helped the user.",
    "Extract candidate Codex entries only if the user revealed something durable, useful, low-risk, and grounded in their own words.",
    "Possible candidates can include preferences, boundaries, recurring patterns, collaboration style, communication preferences, planning habits, operating principles, stable self-descriptions, or other durable useful context.",
    "Do not limit yourself to work preferences.",
    "Do not extract from assistant-only claims or weak user assent like \"yeah\" or \"ok\".",
    "Do not extract transient moods, crisis states, diagnoses, protected-trait guesses, or sensitive/private claims.",
    "Do not create claims about named third parties.",
    "If uncertain, return no candidates.",
    "Return JSON only with this shape:",
    "{\"candidates\":[{\"content\":\"string\",\"suggested_section\":\"practices\",\"evidence_quote\":\"exact user-authored quote\",\"supporting_evidence_quotes\":[\"optional exact user-authored quotes\"],\"confidence\":0.0,\"risk_tier\":\"low\",\"reason\":\"brief internal review note\"}]}",
  ].join("\n");
}

export function buildPassiveExtractorInput(rawMessages: unknown[]): PassiveExtractorInput {
  const messages = normalizePassiveConversationMessages(rawMessages)
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: message.content,
      index: message.originalIndex,
    }));

  return {
    messages,
    prompt: buildPassiveExtractorPrompt(),
    extractorVersion: PASSIVE_BRIDGE_EXTRACTOR_VERSION,
    maxCandidates: MAX_PASSIVE_CANDIDATES_PER_TURN,
    timeoutMs: PASSIVE_EXTRACTOR_TIMEOUT_MS,
    maxOutputTokens: PASSIVE_EXTRACTOR_MAX_OUTPUT_TOKENS,
  };
}

export function parsePassiveExtractorJson(raw: string): PassiveExtractorOutput {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError("passive extractor JSON root must be an object");
  }
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    throw new SyntaxError("passive extractor JSON must include candidates array");
  }
  return { candidates };
}

function exactUserEvidenceSource(
  quote: string,
  messages: PassiveExtractorMessage[],
): PassiveExtractorMessage | undefined {
  if (!quote.trim()) return undefined;
  return messages.find((message) => message.role === "user" && message.content.includes(quote));
}

function isAssistantOnlyEvidence(quote: string, messages: PassiveExtractorMessage[]): boolean {
  if (!quote.trim()) return false;
  const userHasQuote = messages.some((message) => message.role === "user" && message.content.includes(quote));
  if (userHasQuote) return false;
  return messages.some((message) => message.role === "assistant" && message.content.includes(quote));
}

const BLOCKED_CANDIDATE_RE = /\b(?:diagnosed|depressed|bipolar|adhd|autistic|trauma|panic attack|suicid|self[- ]harm|protected trait|ethnicity|religion|sexuality|pregnant|criminal|addict)\b/i;

function normalizeConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : undefined;
}

function normalizeSection(value: unknown): BridgeTargetSection | undefined {
  const section = normalizeString(value);
  if (!section || !VALID_SECTIONS.has(section as BridgeTargetSection)) return undefined;
  return section as BridgeTargetSection;
}

function reject(reason: string): { reason: string } {
  return { reason };
}

export function validatePassiveExtractorCandidates(
  output: PassiveExtractorOutput,
  input: PassiveExtractorInput,
): PassiveValidationResult {
  const accepted: PassiveBridgeCandidate[] = [];
  const rejected: Array<{ reason: string }> = [];
  const seen = new Set<string>();

  for (const rawCandidate of output.candidates) {
    if (accepted.length >= MAX_PASSIVE_CANDIDATES_PER_TURN) break;
    if (typeof rawCandidate !== "object" || rawCandidate === null || Array.isArray(rawCandidate)) {
      rejected.push(reject("invalid_shape"));
      continue;
    }

    const typed = rawCandidate as Record<string, unknown>;
    const content = normalizeString(typed.content);
    const evidenceQuote = normalizeString(typed.evidence_quote);
    const suggestedSection = normalizeSection(typed.suggested_section);
    const confidence = normalizeConfidence(typed.confidence);
    const riskTier = normalizeString(typed.risk_tier)?.toLowerCase();
    const reason = normalizeString(typed.reason);
    const supportingEvidence = Array.isArray(typed.supporting_evidence_quotes)
      ? typed.supporting_evidence_quotes
        .map(normalizeString)
        .filter((quote): quote is string => Boolean(quote))
      : undefined;

    if (!content || countWords(content) < 4) {
      rejected.push(reject("not_useful"));
      continue;
    }
    if (!suggestedSection) {
      rejected.push(reject("invalid_section"));
      continue;
    }
    if (confidence === undefined || confidence < 0.75) {
      rejected.push(reject("low_confidence"));
      continue;
    }
    if (riskTier !== "low") {
      rejected.push(reject("non_low_risk"));
      continue;
    }
    if (!evidenceQuote) {
      rejected.push(reject("missing_evidence"));
      continue;
    }
    const evidenceSource = exactUserEvidenceSource(evidenceQuote, input.messages);
    if (!evidenceSource) {
      rejected.push(reject(isAssistantOnlyEvidence(evidenceQuote, input.messages) ? "assistant_authored_evidence" : "ungrounded_evidence"));
      continue;
    }
    const invalidSupporting = supportingEvidence?.find((quote) => !exactUserEvidenceSource(quote, input.messages));
    if (invalidSupporting) {
      rejected.push(reject(isAssistantOnlyEvidence(invalidSupporting, input.messages) ? "assistant_authored_supporting_evidence" : "ungrounded_supporting_evidence"));
      continue;
    }
    if (TRANSIENT_OR_RISK_RE.test(evidenceQuote) || BLOCKED_CANDIDATE_RE.test(content) || BLOCKED_CANDIDATE_RE.test(evidenceQuote)) {
      rejected.push(reject("sensitive_or_transient"));
      continue;
    }
    const candidate: PassiveBridgeCandidate = {
      content,
      suggested_section: suggestedSection,
      source_type: "conversation",
      confidence,
      risk_tier: "low",
      evidence_quote: evidenceQuote,
      supporting_evidence_quotes: supportingEvidence,
      source_message_indices: [evidenceSource.index],
      evidence_pointer: `message:${evidenceSource.index}`,
      reason,
    };
    const fingerprint = candidateFingerprint(candidate);
    if (seen.has(fingerprint)) {
      rejected.push(reject("duplicate_in_extractor_output"));
      continue;
    }
    seen.add(fingerprint);
    accepted.push(candidate);
  }

  return { accepted, rejected };
}

function candidateFingerprint(candidate: Pick<PassiveBridgeCandidate, "content" | "evidence_quote">): string {
  return createHash("sha256")
    .update(`${candidate.content.toLowerCase().replace(/\s+/g, " ").trim()}\n${candidate.evidence_quote.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 16);
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
