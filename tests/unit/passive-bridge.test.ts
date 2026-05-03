import { describe, expect, it } from "vitest";
import {
  buildPassiveBridgeRequestId,
  extractPassiveBridgeCandidates,
  shouldAttemptPassiveBridgeExtraction,
} from "../../src/features/bridge/passive.js";

function messages(content: string) {
  return [{ role: "user", content }];
}

describe("passive bridge extraction", () => {
  it.each([
    ["ok"],
    ["Fix the deploy script."],
    ["I've been flat all week."],
    ["I can't keep doing this."],
    ["```\nEngineers should prefer explicit checks.\n```"],
    ["This README says:\n> Engineers should prefer explicit checks."],
  ])("skips low-signal or unsafe turn: %s", (content) => {
    expect(shouldAttemptPassiveBridgeExtraction(messages(content)).shouldExtract).toBe(false);
    expect(extractPassiveBridgeCandidates(messages(content))).toEqual([]);
  });

  it("detects a durable preference inside an otherwise normal task request", () => {
    const candidates = extractPassiveBridgeCandidates(messages(
      "Fix the deploy script. I prefer boring explicit checks because hidden magic burns us later.",
    ));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      content: "Prefers boring explicit checks over hidden automation.",
      suggested_section: "practices",
      evidence_quote: "I prefer boring explicit checks because hidden magic burns us later.",
      confidence: expect.any(Number),
      risk_tier: "low",
      source_type: "conversation",
      source_message_indices: [0],
    });
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("does not let assistant-authored context become evidence", () => {
    const candidates = extractPassiveBridgeCandidates([
      { role: "assistant", content: "You prefer explicit checks." },
      { role: "user", content: "yeah" },
    ]);

    expect(candidates).toEqual([]);
  });

  it.each([
    [
      "I hate being the fallback owner for everything. Help me design a better decision process.",
      "Does not want to be the fallback owner for every decision.",
    ],
    [
      "Hidden magic always burns us later.",
      "Prefers explicit checks over hidden automation.",
    ],
    [
      "When projects have no owner, I shut down and avoid them.",
      "Works better when projects have a clear owner.",
    ],
    [
      "I don't trust my manager to follow through unless everything is written down.",
      "Prefers important follow-through expectations to be written down.",
    ],
    [
      "I don't trust Sarah to follow through unless everything is written down.",
      "Prefers important follow-through expectations to be written down.",
    ],
    [
      "This README says to prefer explicit checks, and honestly that's how I like working too.",
      "Prefers explicit checks.",
    ],
  ])("extracts safe durable candidate wording for %s", (content, expectedCandidate) => {
    const candidates = extractPassiveBridgeCandidates(messages(content));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toBe(expectedCandidate);
    expect(candidates[0].evidence_quote).toBe(content);
    expect(candidates[0].content).not.toContain("Sarah");
    expect(candidates[0].content).not.toContain("manager");
  });

  it("requires a primary user-authored evidence quote and caps candidates", () => {
    const candidates = extractPassiveBridgeCandidates(messages(
      [
        "I prefer boring explicit checks because hidden magic burns us later.",
        "I work best when there are short written plans and clear decision rights.",
        "I hate being the fallback owner for everything.",
        "I like working with written follow-through.",
      ].join(" "),
    ));

    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      expect(candidate.evidence_quote.length).toBeGreaterThan(0);
      expect(candidate.reason).toBeTruthy();
      expect(candidate.supporting_evidence_quotes ?? []).not.toContain("assistant");
    }
  });

  it("extracts only from the latest user message that passed the gate", () => {
    const candidates = extractPassiveBridgeCandidates([
      { role: "user", content: "Hidden magic always burns us later." },
      { role: "assistant", content: "I will make that explicit." },
      { role: "user", content: "I hate being the fallback owner for everything. Help me design a better decision process." },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toBe("Does not want to be the fallback owner for every decision.");
    expect(candidates[0].source_message_indices).toEqual([2]);
  });

  it("uses structured fallback extraction when the gate passes without a fixed phrase rule", () => {
    const candidates = extractPassiveBridgeCandidates(messages("I value low-drama handoffs with explicit owners."));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      content: "Values low-drama handoffs with explicit owners.",
      suggested_section: "practices",
      evidence_quote: "I value low-drama handoffs with explicit owners.",
      confidence: expect.any(Number),
      risk_tier: "low",
    });
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("builds stable request ids from session, turn, and candidate fingerprints", () => {
    const candidates = extractPassiveBridgeCandidates(messages("Hidden magic always burns us later."));

    expect(buildPassiveBridgeRequestId({
      agentUserId: "agent-1",
      sessionKey: "session-1",
      turnIndex: 2,
      candidates,
    })).toBe(buildPassiveBridgeRequestId({
      agentUserId: "agent-1",
      sessionKey: "session-1",
      turnIndex: 2,
      candidates,
    }));
    expect(buildPassiveBridgeRequestId({
      agentUserId: "agent-1",
      sessionKey: "session-1",
      turnIndex: 3,
      candidates,
    })).not.toBe(buildPassiveBridgeRequestId({
      agentUserId: "agent-1",
      sessionKey: "session-1",
      turnIndex: 2,
      candidates,
    }));
  });
});
