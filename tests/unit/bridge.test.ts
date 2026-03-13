import { describe, expect, it, vi } from "vitest";
import type { CortexClient } from "../../src/cortex/client.js";
import {
  buildTooTooBridgePrompt,
  createBridgeHandler,
  detectBridgeExchange,
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
    expect(prompt).toContain("one natural discovery question");
    expect((client.getLinkStatus as any)).toHaveBeenCalledWith("agent-user-1");
    expect(buildTooTooBridgePrompt()).toContain("explicit user answers");
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
    expect(inferTargetSection("How do you want to be remembered?")).toBe("legacy");
    expect(inferTargetSection("What is the default Redis cache TTL we use?")).toBeUndefined();
  });
});
