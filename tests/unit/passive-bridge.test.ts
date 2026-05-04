import { describe, expect, it } from "vitest";
import {
  buildPassiveBridgeRequestId,
  buildPassiveExtractorInput,
  buildPassiveExtractorPrompt,
  parsePassiveExtractorJson,
  shouldAttemptPassiveBridgeExtraction,
  validatePassiveExtractorCandidates,
} from "../../src/features/bridge/passive.js";

function messages(content: string) {
  return [{ role: "user", content }];
}

function validOutput(content: string, evidence: string) {
  return {
    candidates: [{
      content,
      suggested_section: "practices",
      evidence_quote: evidence,
      confidence: 0.86,
      risk_tier: "low",
      reason: "The user stated a durable collaboration preference.",
    }],
  };
}

describe("passive bridge extraction gate and validation", () => {
  it.each([
    ["ok", "too_short"],
    ["thanks", "too_short"],
    ["Fix the deploy script.", "task_only"],
    ["I've been flat all week.", "unsafe_or_transient"],
    ["I can't keep doing this.", "unsafe_or_transient"],
    ["```\nEngineers should prefer explicit checks.\n```", "code_or_log"],
    ["This README says:\n> Engineers should prefer explicit checks.", "pasted_without_ownership"],
  ])("skips obvious non-candidates before model extraction: %s", (content, reason) => {
    expect(shouldAttemptPassiveBridgeExtraction(messages(content))).toEqual({
      shouldExtract: false,
      reason,
    });
  });

  it.each([
    "Usually it’s that the next person isn’t totally clear on what they own, so I end up still carrying it in my head. I want the handoff to make the owner and next step obvious.",
    "The part that usually breaks down is ownership. If every action item has a clear person attached to it and one concrete next step, I can actually let it go instead of tracking it in my head.",
    "The main thing I want is for people to know what actually needs attention. Updates get messy when there are lots of topics but no clear person taking the next step, and then I end up tracking everything myself.",
    "My instinct is to wait when the change affects something customer-facing. I’m okay moving fast for internal cleanup, but if users might notice it, I’d rather have one more verification pass than rush it out.",
    "I tend to decide by asking who will notice the downside if we get it wrong.",
    "For planning, I need a little quiet time before I can commit to a direction.",
    "Fix the deploy script. I prefer boring explicit checks because hidden magic burns us later.",
    "This README says to prefer explicit checks, and honestly that's how I like working too.",
  ])("opens the cheap gate for durable user-owned signal: %s", (content) => {
    expect(shouldAttemptPassiveBridgeExtraction(messages(content)).shouldExtract).toBe(true);
  });

  it("builds a bounded extractor prompt and recent message window", () => {
    const evidence = "I want the handoff to make the owner and next step obvious.";
    const input = buildPassiveExtractorInput([
      { role: "user", content: "Earlier low-signal setup." },
      { role: "assistant", content: "I can help." },
      { role: "user", content: evidence },
      { role: "assistant", content: "I will make that explicit." },
    ]);

    expect(input.messages).toEqual([
      { role: "user", content: "Earlier low-signal setup.", index: 0 },
      { role: "assistant", content: "I can help.", index: 1 },
      { role: "user", content: evidence, index: 2 },
      { role: "assistant", content: "I will make that explicit.", index: 3 },
    ]);
    expect(input.maxCandidates).toBe(3);
    expect(input.prompt).toContain("Return JSON only");
    expect(buildPassiveExtractorPrompt()).toContain("Do not create claims about named third parties");
  });

  it("accepts one grounded low-risk model candidate", () => {
    const evidence = "I want the handoff to make the owner and next step obvious.";
    const input = buildPassiveExtractorInput(messages(evidence));
    const result = validatePassiveExtractorCandidates(
      validOutput("Prefers handoffs that make the owner and next step obvious.", evidence),
      input,
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      expect.objectContaining({
        content: "Prefers handoffs that make the owner and next step obvious.",
        suggested_section: "practices",
        evidence_quote: evidence,
        source_message_indices: [0],
        evidence_pointer: "message:0",
        confidence: 0.86,
        risk_tier: "low",
      }),
    ]);
  });

  it("rejects evidence not present in a user-authored message", () => {
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
      { role: "assistant", content: "I will make ownership explicit." },
    ]);
    const result = validatePassiveExtractorCandidates(
      validOutput("Prefers handoffs with explicit ownership.", "I will make ownership explicit."),
      input,
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ reason: "assistant_authored_evidence" }]);
  });

  it.each([
    [{ confidence: 0.74 }, "low_confidence"],
    [{ risk_tier: "medium" }, "non_low_risk"],
    [{ risk_tier: "high" }, "non_low_risk"],
    [{ suggested_section: "privateNotes" }, "invalid_section"],
    [{ content: "User is depressed." }, "not_useful"],
  ])("rejects invalid model candidate metadata %#", (override, reason) => {
    const evidence = "I want the handoff to make the owner and next step obvious.";
    const input = buildPassiveExtractorInput(messages(evidence));
    const output = validOutput("Prefers handoffs that make the owner and next step obvious.", evidence);
    Object.assign(output.candidates[0], override);

    expect(validatePassiveExtractorCandidates(output, input).rejected).toContainEqual({ reason });
  });

  it("filters invalid candidates before applying the accepted candidate cap", () => {
    const evidence = "I want the handoff to make the owner and next step obvious.";
    const input = buildPassiveExtractorInput(messages(evidence));
    const result = validatePassiveExtractorCandidates({
      candidates: [
        { ...validOutput("Too short.", evidence).candidates[0], content: "Too short." },
        { ...validOutput("Prefers handoffs with explicit ownership.", evidence).candidates[0], risk_tier: "medium" },
        { ...validOutput("Prefers handoffs with explicit next steps.", evidence).candidates[0], confidence: 0.2 },
        validOutput("Prefers handoffs that make the owner and next step obvious.", evidence).candidates[0],
      ],
    }, input);

    expect(result.accepted).toEqual([
      expect.objectContaining({
        content: "Prefers handoffs that make the owner and next step obvious.",
      }),
    ]);
  });

  it("parses JSON-only extractor output and rejects malformed output", () => {
    expect(parsePassiveExtractorJson('{"candidates":[]}')).toEqual({ candidates: [] });
    expect(parsePassiveExtractorJson('```json\n{"candidates":[]}\n```')).toEqual({ candidates: [] });
    expect(() => parsePassiveExtractorJson("{nope")).toThrow(SyntaxError);
    expect(() => parsePassiveExtractorJson('{"items":[]}')).toThrow(SyntaxError);
  });

  it("builds stable request ids from session, turn, and candidate fingerprints", () => {
    const evidence = "I want the handoff to make the owner and next step obvious.";
    const candidates = validatePassiveExtractorCandidates(
      validOutput("Prefers handoffs that make the owner and next step obvious.", evidence),
      buildPassiveExtractorInput(messages(evidence)),
    ).accepted;

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
