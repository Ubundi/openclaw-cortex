import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CortexClient } from "../../src/cortex/client.js";
import { createBridgeHandler } from "../../src/features/bridge/handler.js";
import {
  PASSIVE_EXTRACTOR_PROVENANCE_SOURCE,
  PASSIVE_EXTRACTOR_RUN_ID_PREFIX,
  PASSIVE_EXTRACTOR_SESSION_ID_PREFIX,
  PASSIVE_EXTRACTOR_SESSION_KEY,
} from "../../src/features/bridge/openclaw-extractor.js";
import type { PassiveExtractorOutput } from "../../src/features/bridge/passive.js";
import type { ClawDeployBridgeTraceClient } from "../../src/internal/clawdeploy-bridge-traces.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeClient(overrides: Partial<{
  getLinkStatus: ReturnType<typeof vi.fn>;
  submitBridgePassive: ReturnType<typeof vi.fn>;
}> = {}): CortexClient {
  return {
    getLinkStatus: overrides.getLinkStatus ?? vi.fn().mockResolvedValue({
      linked: true,
      link: {
        tootoo_user_id: "tt-user-1",
        owner_type: "claimed_user",
        owner_id: "owner-1",
        claimed_user_id: "tt-user-1",
        shadow_subject_id: null,
        linked_at: "2026-03-01T10:00:00Z",
      },
    }),
    submitBridgePassive: overrides.submitBridgePassive ?? vi.fn().mockResolvedValue({
      accepted: true,
      forwarded: true,
      queued_for_retry: false,
      candidates_sent: 1,
      tootoo_user_id: "tt-user-1",
      bridge_event_id: "bridge-event-passive-1",
      suggestions_created: 1,
    }),
  } as unknown as CortexClient;
}

function validPassiveCandidate(content: string, evidence: string) {
  return {
    content,
    suggested_section: "practices",
    evidence_quote: evidence,
    confidence: 0.86,
    risk_tier: "low",
    reason: "The user stated a durable collaboration preference.",
  };
}

function makeTraceClient(): ClawDeployBridgeTraceClient {
  return {
    emitBridgeTrace: vi.fn(),
  };
}

function passiveExtractorFor(contentByEvidence: Record<string, string> = {}) {
  return vi.fn(async (input: any) => {
    const latestUser = [...input.messages].reverse().find((message: any) => message.role === "user");
    const evidence = latestUser?.content ?? "";
    const content = contentByEvidence[evidence]
      ?? (evidence.includes("boring explicit checks")
        ? "Prefers boring explicit checks over hidden automation."
        : evidence.includes("decision they would make")
          ? "Prefers escalations to include a rough proposed decision rather than only the problem."
          : evidence.includes("owner and next step written down")
            ? "Prefers project updates to include the owner and next step in writing."
            : undefined);
    return {
      candidates: content ? [{
        content,
        suggested_section: "practices",
        evidence_quote: evidence.includes("boring explicit checks because hidden magic burns us later")
          ? "I prefer boring explicit checks because hidden magic burns us later."
          : evidence,
        confidence: 0.86,
        risk_tier: "low",
        reason: "Test extractor output.",
      }] : [],
    };
  });
}

function discoveryExchangeMessages() {
  return [
    { role: "user", content: "I have been rethinking what kind of work I want this year." },
    { role: "assistant", content: "That sounds like a meaningful shift. What do you value most in your work?" },
    { role: "user", content: "Autonomy and creative freedom." },
    { role: "assistant", content: "That gives us a clear north star to work with." },
  ];
}

describe("TooToo passive bridge handler", () => {
  it.each([
    ["sentinel session key", { sessionKey: PASSIVE_EXTRACTOR_SESSION_KEY }],
    ["sentinel session id", { sessionId: PASSIVE_EXTRACTOR_SESSION_KEY }],
    ["extractor run id prefix", { runId: `${PASSIVE_EXTRACTOR_RUN_ID_PREFIX}123` }],
    ["extractor session id prefix", { sessionId: `${PASSIVE_EXTRACTOR_SESSION_ID_PREFIX}123` }],
    ["extractor provenance marker", { inputProvenance: { source: PASSIVE_EXTRACTOR_PROVENANCE_SOURCE } }],
  ])("skips passive bridge handling for extractor-marked agent_end events: %s", async (_label, marker) => {
    const client = makeClient();
    const passiveModelExtractor = vi.fn().mockResolvedValue({ candidates: [] });
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor,
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will keep the checks explicit." },
      ],
      aborted: false,
      ...marker,
    })).resolves.toBe(false);

    expect(passiveModelExtractor).not.toHaveBeenCalled();
    expect((client.submitBridgePassive as any)).not.toHaveBeenCalled();
  });

  it("does not inject hidden bridge prompts for linked reflective turns", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: passiveExtractorFor(),
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking what kind of work I want this year.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking what kind of work I want this year and what would actually feel meaningful.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-no-prompt",
    })).resolves.toBeUndefined();

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("injecting"));
  });

  it("does not inject follow-up prompts after assistant discovery questions", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: passiveExtractorFor(),
    });

    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I've been rethinking what kind of work I want this year." },
        { role: "assistant", content: "What do you value most in your work?" },
      ],
      aborted: false,
      sessionKey: "sess-no-followup",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "Autonomy and creative freedom.",
      messages: [
        {
          role: "user",
          content: "Autonomy and creative freedom. Those are the things that keep me going.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-no-followup",
    })).resolves.toBeUndefined();
  });

  it("does not submit explicit Q&A or fall back to Q&A when passive has no candidates", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: vi.fn().mockResolvedValue({ candidates: [] }),
    });

    await expect(handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-no-qa-fallback",
    })).resolves.toBe(true);
    await handler.drainPassiveJobs();

    expect(["submit", "Bridge", "QA"].join("") in client).toBe(false);
    expect((client.submitBridgePassive as any)).not.toHaveBeenCalled();
  });

  it("does not fall back to Q&A when passive submission fails", async () => {
    const client = makeClient({
      submitBridgePassive: vi.fn().mockRejectedValue(new Error("Cortex bridge/passive failed: 503")),
    });
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: passiveExtractorFor(),
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I have been rethinking what kind of work I want this year." },
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will make this explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-fails-no-qa",
    })).resolves.toBe(true);
    await handler.drainPassiveJobs();

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
    expect(["submit", "Bridge", "QA"].join("") in client).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("passive_bridge_failed"));
  });

  it("redacts passive candidate text and evidence from failed bridge traces", async () => {
    const content = "Prefers boring explicit checks over hidden automation.";
    const evidence = "I prefer boring explicit checks because hidden magic burns us later.";
    const client = makeClient({
      submitBridgePassive: vi.fn().mockRejectedValue(
        new Error(`Cortex bridge/passive failed: 503 — ${content} evidence_quote=${evidence}`),
      ),
    });
    const traceClient = makeTraceClient();
    const handler = createBridgeHandler(client, {
      logger,
      bridgeTraceClient: traceClient,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: passiveExtractorFor(),
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: evidence },
        { role: "assistant", content: "I will keep the checks explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-trace-redaction",
    })).resolves.toBe(true);
    await handler.drainPassiveJobs();

    const failed = (traceClient.emitBridgeTrace as any).mock.calls
      .map((call: any[]) => call[0])
      .find((event: any) => event.status === "failed");
    expect(failed).toBeDefined();
    expect(failed.lastError).toContain("[REDACTED_CONTENT]");
    expect(failed.lastError).not.toContain(content);
    expect(failed.lastError).not.toContain(evidence);
    expect(JSON.stringify(failed.metadata)).not.toContain(content);
    expect(JSON.stringify(failed.metadata)).not.toContain(evidence);
  });

  it("extractor failure fails closed and does not affect agent_end", async () => {
    const client = makeClient();
    const passiveModelExtractor = vi.fn().mockRejectedValue(new Error("model down"));
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor,
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will make the checks explicit." },
      ],
      aborted: false,
      sessionKey: "sess-extractor-fail-closed",
    })).resolves.toBe(true);
    await handler.drainPassiveJobs();

    expect(passiveModelExtractor).toHaveBeenCalledTimes(1);
    expect((client.submitBridgePassive as any)).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("passive_job_dropped reason=provider_unavailable"));
  });

  it("sends one passive candidate without assistant question or answer payload fields", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: passiveExtractorFor(),
      getActiveModelRef: () => "bedrock/anthropic.claude-sonnet-4-6",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "Fix the deploy script. I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will make the deploy script explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-only",
    })).resolves.toBe(true);
    await handler.drainPassiveJobs();

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
    const request = (client.submitBridgePassive as any).mock.calls[0][0];
    expect(request).toMatchObject({
      user_id: "agent-user-1",
      session_key: "sess-passive-only",
      extractor_version: "openclaw-cortex-passive-v1",
      candidates: [
        {
          content: "Prefers boring explicit checks over hidden automation.",
          suggested_section: "practices",
          evidence_quote: "I prefer boring explicit checks because hidden magic burns us later.",
        },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("question");
    expect(JSON.stringify(request)).not.toContain("answer");
    expect(JSON.stringify(request)).not.toContain("I will make the deploy script explicit");
  });

  it("suppresses duplicate passive candidates in the same session", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor: passiveExtractorFor(),
    });
    const event = {
      messages: [
        { role: "user", content: "I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will keep the checks explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-dupe",
    };

    await expect(handler.handleAgentEnd(event)).resolves.toBe(true);
    await handler.drainPassiveJobs();
    await expect(handler.handleAgentEnd({
      ...event,
      messages: [...event.messages, { role: "user", content: "I prefer boring explicit checks because hidden magic burns us later." }],
    })).resolves.toBe(true);
    await handler.drainPassiveJobs();

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
  });

  it("suppresses near-duplicate passive candidates in the same session while allowing a different later preference", async () => {
    const client = makeClient();
    const evidence = "The thing that helps me most is when someone brings me the decision they would make if I was not available, even if it is rough. If they only bring me the problem, I end up solving from zero and it slows everything down.";
    const duplicateEvidence = "When something is escalated, I want the person to bring the decision they recommend, even if it is rough, because only bringing the problem makes me solve from zero.";
    const differentEvidence = "For project updates, I want the owner and next step written down so I can stop tracking it in my head.";
    const passiveModelExtractor = vi.fn(async (input: any): Promise<PassiveExtractorOutput> => {
      const latest = [...input.messages].reverse().find((message: any) => message.role === "user")?.content ?? "";
      if (latest === evidence) {
        return { candidates: [validPassiveCandidate("Prefers escalations to include a rough proposed decision rather than only the problem.", evidence)] };
      }
      if (latest === duplicateEvidence) {
        return { candidates: [validPassiveCandidate("When escalating, prefers people bring their recommended decision instead of only the problem.", duplicateEvidence)] };
      }
      if (latest === differentEvidence) {
        return { candidates: [validPassiveCandidate("Prefers project updates to include the owner and next step in writing.", differentEvidence)] };
      }
      return { candidates: [] };
    });
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
      passiveModelExtractor,
    });

    await handler.handleAgentEnd({ messages: [{ role: "user", content: evidence }, { role: "assistant", content: "Got it." }], sessionKey: "sess-passive-near-dupe" });
    await handler.drainPassiveJobs();
    await handler.handleAgentEnd({ messages: [{ role: "user", content: evidence }, { role: "assistant", content: "Got it." }, { role: "user", content: duplicateEvidence }, { role: "assistant", content: "That is similar." }], sessionKey: "sess-passive-near-dupe" });
    await handler.drainPassiveJobs();
    await handler.handleAgentEnd({ messages: [{ role: "user", content: evidence }, { role: "assistant", content: "Got it." }, { role: "user", content: duplicateEvidence }, { role: "assistant", content: "That is similar." }, { role: "user", content: differentEvidence }, { role: "assistant", content: "Clear." }], sessionKey: "sess-passive-near-dupe" });
    await handler.drainPassiveJobs();

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("passive_candidate_suppressed reason=duplicate_recent_session_fuzzy"));
  });
});
