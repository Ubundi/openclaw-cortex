import { describe, expect, it, vi } from "vitest";
import type { CortexClient } from "../../src/cortex/client.js";
import {
  buildTooTooBridgePrompt,
  buildBridgeFollowUpPrompt,
  createBridgeHandler,
  detectBridgeExchange,
  detectBridgeQuestions,
  detectBridgeExchanges,
  extractLastQuestion,
  inferTargetSection,
} from "../../src/features/bridge/handler.js";
import type { ClawDeployBridgeTraceClient } from "../../src/internal/clawdeploy-bridge-traces.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeClient(overrides: Partial<{
  getLinkStatus: ReturnType<typeof vi.fn>;
  submitBridgeQA: ReturnType<typeof vi.fn>;
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
    submitBridgeQA: overrides.submitBridgeQA ?? vi.fn().mockResolvedValue({
      accepted: true,
      forwarded: true,
      queued_for_retry: false,
      entries_sent: 1,
      tootoo_user_id: "tt-user-1",
      bridge_event_id: "bridge-event-1",
      suggestions_created: 2,
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

function makeTraceClient(): ClawDeployBridgeTraceClient {
  return {
    emitBridgeTrace: vi.fn(),
  };
}

function discoveryExchangeMessages() {
  return [
    { role: "user", content: "I have been rethinking what kind of work I want this year." },
    { role: "assistant", content: "That sounds like a meaningful shift. What do you value most in your work?" },
    { role: "user", content: "Autonomy and creative freedom." },
    { role: "assistant", content: "That gives us a clear north star to work with." },
  ];
}

const WORK_STYLE_QUESTION = "When something needs attention — a blocker, a stalled task, a decision that's drifting — what's the right amount of pushback from me before it feels like nagging instead of helpful?";
const WORK_STYLE_ANSWER = "Team Ubundi works best when there is clear ownership, short written plans, low-drama execution, and fast checkpoints before work drifts too far.";
const SLACK_REFLECTIVE_BODY = "I'm trying to understand what kind of work gives me energy versus what quietly drains me. I want to spend more of my leadership time on the things that actually compound for the team.";
const SLACK_ANSWER_BODY = "Autonomy, creative freedom, and helping the team build momentum without me becoming the bottleneck.";

function slackDmEnvelope(body: string): string {
  return [
    `System: [2026-04-26 10:30:19 UTC] Slack DM from Matt: ${body}`,
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    '{ "channel_type": "direct", "sender": "Matt", "message_id": "slack-1" }',
    "```",
    "",
    body,
  ].join("\n");
}

function slackMetadataOnlyEnvelope(): string {
  return [
    "System: [2026-04-26 10:30:19 UTC] Slack DM from Matt:",
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    '{ "channel_type": "direct", "sender": "Matt", "message_id": "slack-1" }',
    "```",
  ].join("\n");
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
    expect(prompt).toContain("Help with the user's current task first");
    expect((client.getLinkStatus as any)).toHaveBeenCalledWith("agent-user-1");
    expect(buildTooTooBridgePrompt()).toContain("Only explicit user-authored answers count");
  });

  it("nudges the model toward one natural task-helping clarifier", () => {
    const prompt = buildTooTooBridgePrompt();

    expect(prompt).toContain("current task first");
    expect(prompt).toContain("MAY ask at most one short clarifier");
    expect(prompt).toContain("Do you want this optimized for speed, or for making ownership explicit?");
    expect(prompt).toContain("Do NOT mention memory, TooToo, Codex, saving, profiling, review, or suggestions.");
    expect(prompt).toContain("Do NOT ask abstract extraction questions");
    expect(prompt).not.toContain("Pick exactly one");
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

  it("injects full prompt for reflective live turns when messages are empty but prompt has the user text", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been wondering what really matters in my work right now and what I should optimize for.",
      messages: [],
      sessionKey: "sess-live-empty-messages",
    })).resolves.toBe("full");

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("latestUserTextSource=prompt"));
  });

  it("uses finalPromptText as the live user source when prompt is absent", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      finalPromptText: "I'm trying to figure out what kind of future I want from my work.",
      messages: [],
      sessionKey: "sess-live-final-prompt-text",
    })).resolves.toBe("full");
  });

  it("logs heartbeat bridge prompt skips", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "HEARTBEAT_OK - if nothing needs attention, reply with a short status only.",
      messages: [],
      sessionKey: "sess-heartbeat-log",
    })).resolves.toBe(false);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("reason=heartbeat"));
  });

  it("injects full prompt for wrapped Slack DM reflective prompts", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: slackDmEnvelope(SLACK_REFLECTIVE_BODY),
      messages: [
        {
          role: "user",
          content: slackDmEnvelope(SLACK_REFLECTIVE_BODY),
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "agent:main:slack:direct:u0a6km77zdz",
    })).resolves.toBe("full");

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("reason=injected_full"));
  });

  it("does not inject bridge prompt for Slack metadata without a DM body", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: slackMetadataOnlyEnvelope(),
      messages: [
        {
          role: "user",
          content: slackMetadataOnlyEnvelope(),
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "agent:main:slack:direct:metadata-only",
    })).resolves.toBe(false);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("reason=no_latest_user"));
  });

  it("does not use prompt fallback when non-empty messages were filtered by provenance", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been wondering what really matters in my work right now and what I should optimize for.",
      messages: [
        {
          role: "user",
          content: "Synthetic routing hint",
          provenance: { kind: "internal_system" },
        },
      ],
      sessionKey: "sess-filtered-provenance",
    })).resolves.toBe(false);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("reason=provenance_filtered"));
  });

  it("does not treat a tiny stale user message as matching a new reflective prompt", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking what kind of work would feel meaningful this year.",
      messages: [
        {
          role: "user",
          content: "work",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-stale-short-message",
    })).resolves.toBe("full");
  });

  it("does not carry bridge cooldown into a new session key", async () => {
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
      sessionKey: "sess-before-new",
    })).resolves.toBe("full");

    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I want to understand myself better." },
        { role: "assistant", content: "What do you value most in your work?" },
      ],
      aborted: false,
      sessionKey: "sess-before-new",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been wondering what kind of future I actually want from my work.",
      messages: [],
      sessionKey: "sess-after-new",
    })).resolves.toBe("full");
  });

  it("caps passive clarifier prompts to one per session", async () => {
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
    })).resolves.toBe(false);
  });

  it("does not ask a second full passive clarifier before an assistant question is observed", async () => {
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
    })).resolves.toBe(false);

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
    expect(await handler.shouldInjectPrompt({
      prompt: "I've been wondering what kind of work would feel meaningful this year.",
      messages: [],
      sessionKey: "sess-unlinked-prompt",
    })).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("reason=link_inactive"));
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

  it("emits a detected trace with request ID and section when a discovery exchange is found", async () => {
    const client = makeClient();
    const traceClient = makeTraceClient();
    const handler = createBridgeHandler(client, {
      logger,
      bridgeTraceClient: traceClient,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-trace-detected",
    })).resolves.toBe(true);

    const detected = (traceClient.emitBridgeTrace as any).mock.calls
      .map((call: any[]) => call[0])
      .find((event: any) => event.status === "detected");
    const request = (client.submitBridgeQA as any).mock.calls[0][0];
    expect(detected).toMatchObject({
      requestId: request.request_id,
      sessionKey: "sess-trace-detected",
      cortexAgentUserId: "agent-user-1",
      agentUserId: "agent-user-1",
      targetSection: "coreValues",
      status: "detected",
    });
    expect(detected.detectedAt).toEqual(expect.any(String));
    expect(JSON.stringify(detected)).not.toContain("What do you value most");
    expect(JSON.stringify(detected)).not.toContain("Autonomy and creative freedom");
  });

  it("emits an accepted trace with bridge response status fields", async () => {
    const client = makeClient({
      submitBridgeQA: vi.fn().mockResolvedValue({
        accepted: true,
        forwarded: false,
        queued_for_retry: true,
        entries_sent: 1,
        tootoo_user_id: "tt-user-1",
        bridge_event_id: "bridge-event-accepted",
        suggestions_created: null,
      }),
    });
    const traceClient = makeTraceClient();
    const handler = createBridgeHandler(client, {
      logger,
      bridgeTraceClient: traceClient,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-trace-accepted",
    })).resolves.toBe(true);

    const accepted = (traceClient.emitBridgeTrace as any).mock.calls
      .map((call: any[]) => call[0])
      .find((event: any) => event.status === "accepted");
    expect(accepted).toMatchObject({
      status: "accepted",
      forwarded: false,
      queuedForRetry: true,
      entriesSent: 1,
      requestId: (client.submitBridgeQA as any).mock.calls[0][0].request_id,
      sessionKey: "sess-trace-accepted",
      targetSection: "coreValues",
    });
    expect(accepted.acceptedAt).toEqual(expect.any(String));
  });

  it("sends passive candidates at agent_end and suppresses explicit Q&A for the same turn", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I have been rethinking what kind of work I want this year." },
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "Fix the deploy script. I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will make the deploy script explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-wins",
    })).resolves.toBe(true);

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();
    const request = (client.submitBridgePassive as any).mock.calls[0][0];
    expect(request).toMatchObject({
      user_id: "agent-user-1",
      session_key: "sess-passive-wins",
      extractor_version: "openclaw-cortex-passive-v1",
      candidates: [
        {
          content: "Prefers boring explicit checks over hidden automation.",
          suggested_section: "practices",
          evidence_quote: "I prefer boring explicit checks because hidden magic burns us later.",
        },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("What do you value most");
    expect(JSON.stringify(request)).not.toContain("assistant");
  });

  it("records newly emitted bridge question state even when passive wins the turn", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been rethinking how I want this deploy process to work.",
      messages: [
        {
          role: "user",
          content: "I've been rethinking how I want this deploy process to work and what would feel aligned.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-passive-question-state",
    })).resolves.toBe("full");

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I've been rethinking how I want this deploy process to work." },
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "I hate being the fallback owner for everything. Help me design a better decision process." },
        { role: "assistant", content: "I will make ownership explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-question-state",
    })).resolves.toBe(true);

    await expect(handler.shouldInjectPrompt({
      prompt: "Make ownership explicit.",
      messages: [
        {
          role: "user",
          content: "Make ownership explicit.",
          provenance: { kind: "external_user" },
        },
      ],
      sessionKey: "sess-passive-question-state",
    })).resolves.toBe("followup");
    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();
  });

  it("does not send passive traffic when no candidates exist and keeps explicit Q&A fallback", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-explicit-fallback",
    })).resolves.toBe(true);

    expect((client.submitBridgePassive as any)).not.toHaveBeenCalled();
    expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1);
  });

  it("falls back to explicit Q&A when passive send fails transiently", async () => {
    const client = makeClient({
      submitBridgePassive: vi.fn().mockRejectedValue(new Error("Cortex bridge/passive failed: 503")),
    });
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I have been rethinking what kind of work I want this year." },
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "I prefer boring explicit checks because hidden magic burns us later." },
        { role: "assistant", content: "I will make this explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-transient-fallback",
    })).resolves.toBe(true);

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
    expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1);
  });

  it("requires owner-aware link status before sending passive candidates", async () => {
    const client = makeClient({
      getLinkStatus: vi.fn().mockResolvedValue({
        linked: true,
        link: {
          tootoo_user_id: "tt-user-legacy",
          linked_at: "2026-03-01T10:00:00Z",
        },
      }),
    });
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "Hidden magic always burns us later." },
        { role: "assistant", content: "I will make the flow explicit." },
      ],
      aborted: false,
      sessionKey: "sess-missing-owner",
    })).resolves.toBe(false);

    expect((client.submitBridgePassive as any)).not.toHaveBeenCalled();
  });

  it("suppresses duplicate passive candidates in the same session", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    const event = {
      messages: [
        { role: "user", content: "Hidden magic always burns us later." },
        { role: "assistant", content: "I will keep the checks explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-dupe",
    };

    await expect(handler.handleAgentEnd(event)).resolves.toBe(true);
    await expect(handler.handleAgentEnd({
      ...event,
      messages: [...event.messages, { role: "user", content: "Hidden magic always burns us later." }],
    })).resolves.toBe(false);

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate handoff passive candidates in the same session", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });
    const evidence = "Usually it’s that the next person isn’t totally clear on what they own, so I end up still carrying it in my head. I want the handoff to make the owner and next step obvious.";
    const event = {
      messages: [
        { role: "user", content: evidence },
        { role: "assistant", content: "I will make the owner and next step explicit." },
      ],
      aborted: false,
      sessionKey: "sess-passive-handoff-dupe",
    };

    await expect(handler.handleAgentEnd(event)).resolves.toBe(true);
    await expect(handler.handleAgentEnd({
      ...event,
      messages: [...event.messages, { role: "user", content: evidence }],
    })).resolves.toBe(false);

    expect((client.submitBridgePassive as any)).toHaveBeenCalledTimes(1);
    const request = (client.submitBridgePassive as any).mock.calls[0][0];
    expect(request.candidates).toHaveLength(1);
    expect(request.candidates[0]).toMatchObject({
      content: "Prefers handoffs with a clearly named owner and explicit next step.",
      evidence_quote: evidence,
      risk_tier: "low",
    });
  });

  it("caps passive sends to five candidates per session in memory", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    for (const [index, content] of [
      "Hidden magic always burns us later.",
      "I hate being the fallback owner for everything.",
      "I don't trust Sarah to follow through unless everything is written down.",
      "When projects have no owner, I shut down and avoid them.",
      "I work best when there are short written plans and clear decision rights.",
      "This README says to prefer explicit checks, and honestly that's how I like working too.",
    ].entries()) {
      await handler.handleAgentEnd({
        messages: [
          { role: "user", content },
          { role: "assistant", content: "Understood." },
        ],
        aborted: false,
        sessionKey: "sess-passive-cap",
        sessionId: `turn-${index}`,
      });
    }

    const totalCandidates = (client.submitBridgePassive as any).mock.calls
      .flatMap((call: any[]) => call[0].candidates)
      .length;
    expect(totalCandidates).toBe(5);
  });

  it("emits a failed trace with redacted sensitive values when bridge submission fails", async () => {
    const client = makeClient({
      submitBridgeQA: vi.fn().mockRejectedValue(
        new Error("Cortex bridge/qa failed: 503 Authorization: Bearer token-123 x-api-key=sk-secret answer=Autonomy and creative freedom."),
      ),
    });
    const traceClient = makeTraceClient();
    const handler = createBridgeHandler(client, {
      logger,
      bridgeTraceClient: traceClient,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-trace-failed",
    })).resolves.toBe(false);

    const failed = (traceClient.emitBridgeTrace as any).mock.calls
      .map((call: any[]) => call[0])
      .find((event: any) => event.status === "failed");
    expect(failed).toMatchObject({
      status: "failed",
      requestId: (client.submitBridgeQA as any).mock.calls[0][0].request_id,
      sessionKey: "sess-trace-failed",
      targetSection: "coreValues",
    });
    expect(failed.lastError).toContain("[REDACTED");
    expect(failed.lastError).not.toContain("token-123");
    expect(failed.lastError).not.toContain("sk-secret");
    expect(failed.lastError).not.toContain("Autonomy and creative freedom");
  });

  it("does not fail bridge submission when trace emission throws", async () => {
    const client = makeClient();
    const traceClient: ClawDeployBridgeTraceClient = {
      emitBridgeTrace: vi.fn(() => {
        throw new Error("trace endpoint down");
      }),
    };
    const handler = createBridgeHandler(client, {
      logger,
      bridgeTraceClient: traceClient,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: discoveryExchangeMessages(),
      aborted: false,
      sessionKey: "sess-trace-best-effort",
    })).resolves.toBe(true);

    expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("trace emission failed"));
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
        { role: "assistant", content: "What checkpoint interval should the Redis worker use before retrying failed jobs?" },
        { role: "user", content: "Every 30 seconds." },
      ],
      aborted: false,
      sessionKey: "sess-technical-workflow",
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

    expect(await handler.handleAgentEnd({
      messages: [
        { role: "assistant", content: WORK_STYLE_QUESTION },
        { role: "user", content: "ok" },
      ],
      aborted: false,
      sessionKey: "sess-low-signal-work-style",
    })).toBe(false);

    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();
  });

  it("logs a non-content debug breadcrumb for explicit answers to unmapped questions", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    const handled = await handler.handleAgentEnd({
      messages: [
        { role: "assistant", content: "What color should the deploy dashboard header be?" },
        { role: "user", content: "It should be green and very compact." },
      ],
      aborted: false,
      sessionKey: "sess-unmapped-debug",
    });

    expect(handled).toBe(false);
    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("skipped candidate exchange: unmapped question"));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("sessionId=sess-unmapped-debug"));
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("deploy dashboard header"));
  });

  it("maps practical work-style questions to practices", () => {
    expect(inferTargetSection(WORK_STYLE_QUESTION)).toBe("practices");
    expect(inferTargetSection("What communication cadence helps your team stay aligned?")).toBe("practices");
    expect(inferTargetSection("What checkpoint rhythm keeps work from drifting too far?")).toBe("practices");
    expect(inferTargetSection("How should someone push back when a decision is drifting?")).toBe("practices");
    expect(inferTargetSection("What ownership pattern keeps execution low-drama?")).toBe("practices");
  });

  it("detects practical work-style bridge questions", () => {
    const questions = detectBridgeQuestions({
      messages: [
        { role: "assistant", content: WORK_STYLE_QUESTION },
      ],
      sessionKey: "sess-work-style-question",
    });

    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      question: WORK_STYLE_QUESTION,
      targetSection: "practices",
      assistantIndex: 0,
    });
  });

  it("detects the live Slack work-style Q&A as one explicit bridge exchange", () => {
    const exchanges = detectBridgeExchanges({
      messages: [
        { role: "assistant", content: WORK_STYLE_QUESTION },
        { role: "user", content: WORK_STYLE_ANSWER },
      ],
      agentUserId: "agent-user-1",
      sessionKey: "sess-live-slack-work-style",
    });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      question: WORK_STYLE_QUESTION,
      answer: WORK_STYLE_ANSWER,
      targetSection: "practices",
      assistantIndex: 0,
      userIndex: 1,
      sessionKey: "sess-live-slack-work-style",
    });
  });

  it("detects and submits wrapped Slack answer after a canonical bridge question", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.shouldInjectPrompt({
      prompt: slackDmEnvelope(SLACK_REFLECTIVE_BODY),
      messages: [],
      sessionKey: "agent:main:slack:direct:qa",
    })).resolves.toBe("full");

    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: slackDmEnvelope(SLACK_REFLECTIVE_BODY) },
        { role: "assistant", content: "What do you value most in your work?" },
      ],
      aborted: false,
      sessionKey: "agent:main:slack:direct:qa",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: slackDmEnvelope(SLACK_REFLECTIVE_BODY) },
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: slackDmEnvelope(SLACK_ANSWER_BODY) },
      ],
      aborted: false,
      sessionKey: "agent:main:slack:direct:qa",
    })).resolves.toBe(true);

    expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1);
    expect((client.submitBridgeQA as any).mock.calls[0][0].entries[0]).toEqual({
      question: "What do you value most in your work?",
      answer: SLACK_ANSWER_BODY,
      target_section: "coreValues",
    });
  });

  it("does not forward non-canonical discovery-like questions unless they were bridge-tracked", async () => {
    const client = makeClient();
    const handler = createBridgeHandler(client, {
      logger,
      getUserId: () => "agent-user-1",
      userIdReady: Promise.resolve(),
      pluginSessionId: "plugin-session-1",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "assistant", content: WORK_STYLE_QUESTION },
        { role: "user", content: WORK_STYLE_ANSWER },
      ],
      aborted: false,
      sessionKey: "sess-untracked-work-style",
    })).resolves.toBe(false);
    expect((client.submitBridgeQA as any)).not.toHaveBeenCalled();

    await expect(handler.shouldInjectPrompt({
      prompt: "I've been wondering what really matters in my work right now and what I should optimize for.",
      messages: [],
      sessionKey: "sess-tracked-work-style",
    })).resolves.toBe("full");

    await handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I've been wondering what really matters in my work right now." },
        { role: "assistant", content: WORK_STYLE_QUESTION },
      ],
      aborted: false,
      sessionKey: "sess-tracked-work-style",
    });

    await expect(handler.handleAgentEnd({
      messages: [
        { role: "user", content: "I've been wondering what really matters in my work right now." },
        { role: "assistant", content: WORK_STYLE_QUESTION },
        { role: "user", content: WORK_STYLE_ANSWER },
      ],
      aborted: false,
      sessionKey: "sess-tracked-work-style",
    })).resolves.toBe(true);
    expect((client.submitBridgeQA as any)).toHaveBeenCalledTimes(1);
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
