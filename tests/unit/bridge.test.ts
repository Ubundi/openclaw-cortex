import { describe, expect, it, vi } from "vitest";
import type { CortexClient } from "../../src/cortex/client.js";
import {
  buildTooTooBridgePrompt,
  buildBridgeFollowUpPrompt,
  createBridgeHandler,
  detectBridgeExchange,
  detectBridgeExchanges,
  extractLastQuestion,
  inferTargetSection,
} from "../../src/features/bridge/handler.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeClient(overrides: Partial<{
  getLinkStatus: ReturnType<typeof vi.fn>;
  submitBridgeQA: ReturnType<typeof vi.fn>;
}> = {}): CortexClient {
  return {
    getLinkStatus: overrides.getLinkStatus ?? vi.fn().mockResolvedValue({
      linked: true,
      link: {
        tootoo_user_id: "tt-user-1",
        linked_at: "2026-03-01T10:00:00Z",
      },
    }),
    submitBridgeQA: overrides.submitBridgeQA ?? vi.fn().mockResolvedValue({
      accepted: true,
      forwarded: true,
      queued_for_retry: false,
      entries_sent: 1,
      tootoo_user_id: "tt-user-1",
      bridge_event_id: "bridge-event-1",
      suggestions_created: 2,
    }),
  } as unknown as CortexClient;
}

function discoveryExchangeMessages() {
  return [
    { role: "user", content: "I have been rethinking what kind of work I want this year." },
    { role: "assistant", content: "That sounds like a meaningful shift. What do you value most in your work?" },
    { role: "user", content: "Autonomy and creative freedom." },
    { role: "assistant", content: "That gives us a clear north star to work with." },
  ];
}

describe("TooToo bridge handler", () => {
  it("builds linked-user guidance for before_agent_start", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    const prompt = await handler.getPromptContext();

    expect(prompt).toContain("<tootoo_bridge>");
    expect(prompt).toContain("one short discovery question");
    expect((client.getLinkStatus as any)).toHaveBeenCalledWith("agent-user-1");
    expect(buildTooTooBridgePrompt()).toContain("explicit user answers");
  });

  it("nudges the model toward one direct discovery question before frameworks", () => {
    const prompt = buildTooTooBridgePrompt();

    expect(prompt).toContain("No advice, no frameworks, no bullet points");
    expect(prompt).toContain("\"What do you value most in your work?\"");
    expect(prompt).toContain("\"What do you believe to be true?\"");
    expect(prompt).toContain("\"What are your non-negotiables?\"");
    expect(prompt).toContain("\"What are you curious about right now?\"");
    expect(prompt).toContain("acknowledge in one plain sentence and move on");
    expect(prompt).toContain("Do NOT rephrase into creative or abstract alternatives");
    expect(prompt).toContain("WRONG: giving advice");
    expect(prompt).toContain("RIGHT: just the question, by itself");
  });

  it("builds a follow-up prompt that guides model back to practical help", () => {
    const prompt = buildBridgeFollowUpPrompt();

    expect(prompt).toContain("<tootoo_bridge_followup>");
    expect(prompt).toContain("one plain sentence");
    expect(prompt).toContain("No superlatives, no praise, no coaching tone");
    expect(prompt).toContain("Do NOT: offer plans, frameworks, exercises");
    expect(prompt).toContain("'That's powerful', 'That's beautiful'");
    expect(prompt).toContain("The discovery moment is complete. Move on.");
  });

  it("injects follow-up prompt when user answers a pending bridge question", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    // Turn 1: reflective opening triggers full bridge prompt
    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking what kind of work I want this year.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking what kind of work I want this year and what would feel meaningful.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-followup",
    })).resolves.toBe("full");

    // Simulate agent_end where the assistant asked a qualifying question
    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I've been rethinking what kind of work I want this year." },
        { role: "assistant", content: "What do you value most in your work?" },
      ],
      aborted: false,
      sessionKey: "sess-followup",
    });

    // Turn 2: user answers the question — should get follow-up prompt
    await expect(handler.shouldInjectPrompt({
      prompt: "Autonomy and creative freedom.",
      messages: [
        {
          role: "user",
          content: "Autonomy and creative freedom. Those are the things that keep me going.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-followup",
    })).resolves.toBe("followup");

    // Turn 3: follow-up is consumed, next turn should not get follow-up again
    await expect(handler.shouldInjectPrompt({
      prompt: "I'm also wondering about my long-term direction.",
      messages: [
        {
          role: "user",
          content: "I'm also wondering about my long-term direction and what I should optimize for next.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-followup",
    })).resolves.toBe(false);
  });

  it("only invites bridge prompts on reflective turns", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking what I want from work this year and what would actually feel meaningful.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking what I want from work this year and what would actually feel meaningful.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-reflective",
    })).resolves.toBe("full");

    await expect(handler.shouldInjectPrompt({
      prompt: "Fix the Redis cache TTL bug and add a regression test.",
      messages: [
        {
          role: "user",
          content: "Fix the Redis cache TTL bug in the worker and add a regression test for it.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-technical",
    })).resolves.toBe(false);

    await expect(handler.shouldInjectPrompt({
      prompt: "I'm feeling stuck (especially at work).",
      messages: [
        {
          role: "user",
          content: "I'm feeling stuck (especially at work).",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-punctuation",
    })).resolves.toBe("full");

    await expect(handler.shouldInjectPrompt({
      prompt: "I want to simplify the migration path this week.",
      messages: [
        {
          role: "user",
          content: "I want to simplify the migration path this week and reduce rollout risk.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-work-planning",
    })).resolves.toBe(false);
  });

  it("suppresses repeated bridge prompts on nearby turns in the same session", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking the kind of life I want to build.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking the kind of life I want to build and what would feel genuinely aligned.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-cooldown",
    })).resolves.toBe("full");

    await expect(handler.shouldInjectPrompt({
      prompt: "I'm still trying to figure out what matters most to me in my work.",
      messages: [
        {
          role: "user",
          content: "I'm still trying to figure out what matters most to me in my work and where I should focus next.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-cooldown",
    })).resolves.toBe("full");
  });

  it("starts cooldown only after the assistant actually asks a qualifying question", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking the kind of life I want to build.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking the kind of life I want to build and what would feel genuinely aligned.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-question-cooldown",
    })).resolves.toBe("full");

    await expect(handler.shouldInjectPrompt({
      prompt: "I'm still trying to figure out what matters most to me.",
      messages: [
        {
          role: "user",
          content: "I'm still trying to figure out what matters most to me and what kind of future I want.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-question-cooldown",
    })).resolves.toBe("full");

    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I want to understand myself better." },
        { role: "assistant", content: "What do you value most in your work?" },
      ],
      aborted: false,
      sessionKey: "sess-question-cooldown",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I'm also wondering what kind of future I want from all this.",
      messages: [
        {
          role: "user",
          content: "I'm also wondering what kind of future I want from all this and what I should optimize for.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-question-cooldown",
    })).resolves.toBe(false);
  });

  it("extends prompt suppression after a bridge answer is captured", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking what kind of work I want this year.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking what kind of work I want this year and what would actually feel sustainable.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-after-answer",
    })).resolves.toBe("full");

    await handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-after-answer",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I'm also wondering what kind of future I want from all this.",
      messages: [
        {
          role: "user",
          content: "I'm also wondering what kind of future I want from all this and what I should optimize for.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-after-answer",
    })).resolves.toBe(false);
  });

  it("returns no prompt and skips submission for unlinked users", async () => {
    const client = makeClient({
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
    });
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    expect(await handler.getPromptContext()).toBeUndefined();
    expect(await handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-1",
    })).toBe(false);
    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();
  });

  it("detects a qualifying assistant question plus explicit user answer and submits one entry", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    const handled = await handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-42",
    });

    expect(handled).toBe(true);
    await vi.waitFor(() => expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1));

    const request = (client.submitBridgeQA as any).mock.calls[0][0];
    expect(request.user_id).toBe("agent-user-1");
    expect(request.entries).toEqual([
      {
        question: "What do you value most in your work?",
        answer: "Autonomy and creative freedom.",
        target_section: "coreValues",
      },
    ]);
    expect(request.request_id).toMatch(/^openclaw-bridge-/);
  });

  it("attributes the pair to the assistant question before the latest user answer", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: "We were talking about my career direction." },
        { role: "assistant", content: "That context helps. What do you value most in your work?" },
        { role: "user", content: "Autonomy and creative freedom." },
        { role: "assistant", content: "That makes sense. How do you want to be remembered?" },
      ],
      aborted: false,
      sessionKey: "sess-attribute",
    });

    await vi.waitFor(() => expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1));
    const request = (client.submitBridgeQA as any).mock.calls[0][0];
    expect(request.entries[0]).toEqual({
      question: "What do you value most in your work?",
      answer: "Autonomy and creative freedom.",
      target_section: "coreValues",
    });
  });

  it("finds the latest qualifying bridge answer even if the user sends a follow-up message", () => {
    const request = detectBridgeExchange({
      messages: [
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "Autonomy and creative freedom." },
        { role: "user", content: "Also, how can I protect that in my current role?" },
      ],
      agentUserId: "agent-user-1",
      sessionKey: "sess-follow-up",
    });

    expect(request).toBeDefined();
    expect(request?.question).toBe("What do you value most in your work?");
    expect(request?.answer).toBe("Autonomy and creative freedom.");
    expect(request?.targetSection).toBe("coreValues");
  });

  it("does not submit non-qualifying turns", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    expect(await handler.handleAgentEnd({
      messages: [
        { role: "assistant", content: "What is the default Redis cache TTL we use?" },
        { role: "user", content: "600 seconds." },
        { role: "assistant", content: "Right, the default TTL is 600 seconds." },
      ],
      aborted: false,
      sessionKey: "sess-non-qualifying",
    })).toBe(false);

    expect(await handler.handleAgentEnd({
      messages: [
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "What do you mean by value exactly?" },
        { role: "assistant", content: "I mean the qualities that make work feel worth doing for you." },
      ],
      aborted: false,
      sessionKey: "sess-clarifying",
    })).toBe(false);

    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();
  });

  it("uses a stable request_id and avoids duplicate sends for the same exchange", async () => {
    const retryQueue = { enqueue: vi.fn() };
    const request = detectBridgeExchange({
      messages: discoveryExchangeMessages(),
      agentUserId: "agent-user-1",
      sessionKey: "sess-stable",
    });
    expect(request).toBeDefined();

    const submitBridgeQA = vi.fn().mockRejectedValue(new Error("Cortex bridge/qa failed: 503"));
    const client = makeClient({ submitBridgeQA });
    const handler = createBridgeHandler(client, {
      logger,
      retryQueue: retryQueue as any,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    expect(await handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-stable",
    })).toBe(true);
    await vi.waitFor(() => expect(retryQueue.enqueue).toHaveBeenCalledTimes(1));

    expect(retryQueue.enqueue).toHaveBeenCalledWith(
      expect.any(Function),
      `bridge-${request!.requestId}`,
    );
    expect(submitBridgeQA.mock.calls[0][0].request_id).toBe(request!.requestId);

    expect(await handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-stable",
    })).toBe(false);
    expect(submitBridgeQA).toHaveBeenCalledTimes(1);
  });

  it("submits multiple unseen discovery exchanges from the same turn history", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    const messages = [
      { role: "user", content: "I want to understand myself better." },
      { role: "assistant", content: "What do you value most in your work?" },
      { role: "user", content: "Autonomy and creative freedom." },
      { role: "assistant", content: "What are your non-negotiables?" },
      { role: "user", content: "Trust and honesty." },
      { role: "assistant", content: "That gives us a strong map." },
    ];

    const exchanges = detectBridgeExchanges({
      messages,
      agentUserId: "agent-user-1",
      sessionKey: "sess-batch",
    });
    expect(exchanges).toHaveLength(2);

    expect(await handler.handleAgentEnd({
      messages,
      aborted: false,
      sessionKey: "sess-batch",
    })).toBe(true);

    expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(2);
    expect((client.submitBridgeQA as any).mock.calls[0][0].entries[0]).toEqual({
      question: "What do you value most in your work?",
      answer: "Autonomy and creative freedom.",
      target_section: "coreValues",
    });
    expect((client.submitBridgeQA as any).mock.calls[1][0].entries[0]).toEqual({
      question: "What are your non-negotiables?",
      answer: "Trust and honesty.",
      target_section: "principles",
    });
  });

  it("treats queued_for_retry responses from Cortex as accepted/deferred success", async () => {
    const retryQueue = { enqueue: vi.fn() };
    const client = makeClient({
      submitBridgeQA: vi.fn().mockResolvedValue({
        accepted: true,
        forwarded: false,
        queued_for_retry: true,
        entries_sent: 1,
        tootoo_user_id: "tt-user-1",
        bridge_event_id: "bridge-event-queued",
        suggestions_created: null,
      }),
    });
    const handler = createBridgeHandler(client, {
      logger,
      retryQueue: retryQueue as any,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    expect(await handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-queued",
    })).toBe(true);
    await vi.waitFor(() => expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1));

    expect(retryQueue.enqueue).not.toHaveBeenCalled();
  });

  it("maps discovery questions to target sections conservatively", () => {
    expect(inferTargetSection("What do you value most in your work?")).toBe("coreValues");
    expect(inferTargetSection("What drives you?")).toBe("coreValues");
    expect(inferTargetSection("What are your non-negotiables?")).toBe("principles");
    expect(inferTargetSection("How do you want to be remembered?")).toBe("legacy");
    expect(inferTargetSection("What is the default Redis cache TTL we use?")).toBeUndefined();
  });

  it("maps creative question variants to target sections", () => {
    expect(inferTargetSection("What are you currently saying 'yes' to in your life?")).toBe("coreValues");
    expect(inferTargetSection("What are you saying no to right now?")).toBe("principles");
    expect(inferTargetSection("What are the top three obligations that take most of your time?")).toBe("practices");
    expect(inferTargetSection("What draws you most in your work?")).toBe("coreValues");
    expect(inferTargetSection("What would you change about your daily routine?")).toBe("dreams");
    expect(inferTargetSection("What drains you the most?")).toBe("shadows");
    expect(inferTargetSection("What do you keep coming back to?")).toBe("coreValues");
  });

  it("extracts the last question from assistant text directly", () => {
    expect(extractLastQuestion("That sounds important. What drives you?")).toBe("What drives you?");
    expect(
      extractLastQuestion("- What do you value most in your work?\n- What are your non-negotiables?"),
    ).toBe("What are your non-negotiables?");
    expect(extractLastQuestion("What do you value most in your work")).toBeUndefined();
  });

  it("extracts and maps a discovery question after a preamble", () => {
    const exchange = detectBridgeExchange({
      messages: [
        { role: "assistant", content: "Here's the question: What do you value most in your work?" },
        { role: "user", content: "Autonomy and impact." },
      ],
      agentUserId: "agent-user-1",
      sessionKey: "sess-preamble",
    });

    expect(extractLastQuestion("Here's the question: What do you value most in your work?"))
      .toBe("What do you value most in your work?");
    expect(exchange?.question).toBe("What do you value most in your work?");
    expect(exchange?.targetSection).toBe("coreValues");
  });

  it("preserves structured discovery questions that include a colon list", () => {
    const question = "What do you value most in your work: money, status, freedom, mastery, impact, or relationships?";
    const exchange = detectBridgeExchange({
      messages: [
        { role: "assistant", content: question },
        { role: "user", content: "Freedom and impact." },
      ],
      agentUserId: "agent-user-1",
      sessionKey: "sess-structured-values",
    });

    expect(extractLastQuestion(question)).toBe(question);
    expect(inferTargetSection(question)).toBe("coreValues");
    expect(exchange?.question).toBe(question);
    expect(exchange?.targetSection).toBe("coreValues");
  });
});
