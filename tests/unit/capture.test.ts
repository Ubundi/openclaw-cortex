import { describe, it, expect, vi } from "vitest";
import { createCaptureHandler } from "../../src/features/capture/handler.js";
import type { CortexClient } from "../../src/adapters/cortex/client.js";
import type { CortexConfig } from "../../src/plugin/config/schema.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallLimit: 10,
    recallTimeoutMs: 500,
    fileSync: true,
    transcriptSync: true,
    ...overrides,
    namespace: overrides.namespace ?? "test",
  };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("createCaptureHandler", () => {
  it("remembers conversation on successful agent end", async () => {
    const rememberPromise = Promise.resolve({ session_id: "sess-1", memories_created: 2, entities_found: [], facts: [] });
    const rememberMock = vi.fn().mockReturnValue(rememberPromise);
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;

    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler({
      messages: [
        { role: "user", content: "What is the deployment strategy for our backend?" },
        { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate with ALB." },
      ],
      aborted: false,
      sessionKey: "sess-1",
    });

    await rememberPromise;

    expect(rememberMock).toHaveBeenCalledWith(
      [
        { role: "user", content: "What is the deployment strategy for our backend?" },
        { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate with ALB." },
      ],
      "sess-1",
    );
  });

  it("skips when autoCapture is disabled", async () => {
    const rememberMock = vi.fn();
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig({ autoCapture: false }), logger);

    await handler({ messages: [{ role: "user", content: "test" }], aborted: false });

    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("skips when agent run was aborted", async () => {
    const rememberMock = vi.fn();
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler({ messages: [{ role: "user", content: "long enough content to matter" }], aborted: true });

    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("skips when messages are too short", async () => {
    const rememberMock = vi.fn();
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      aborted: false,
    });

    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("handles array content blocks", async () => {
    const rememberPromise = Promise.resolve({ session_id: null, memories_created: 1, entities_found: [], facts: [] });
    const rememberMock = vi.fn().mockReturnValue(rememberPromise);
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;

    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler({
      messages: [
        { role: "user", content: "What database does the project use and why?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "The project uses PostgreSQL with pgvector for embedding storage." },
          ],
        },
      ],
      aborted: false,
    });

    await rememberPromise;

    const callArgs = rememberMock.mock.calls[0][0];
    expect(callArgs[1].content).toBe(
      "The project uses PostgreSQL with pgvector for embedding storage.",
    );
  });

  it("extracts tool_result content from tool messages", async () => {
    const rememberPromise = Promise.resolve({ session_id: null, memories_created: 1, entities_found: [], facts: [] });
    const rememberMock = vi.fn().mockReturnValue(rememberPromise);
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;

    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler({
      messages: [
        { role: "user", content: "What files are in the src directory?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "exec", input: { command: "ls src" } }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "index.ts\nplugin.ts\nclient.ts" }] },
        { role: "assistant", content: [{ type: "text", text: "The src directory contains index.ts, plugin.ts, and client.ts." }] },
      ],
      aborted: false,
    });

    await rememberPromise;

    const callArgs = rememberMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const toolMsg = callArgs.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toBe("index.ts\nplugin.ts\nclient.ts");
  });

  it("only sends the delta on subsequent turns (watermark)", async () => {
    const rememberMock = vi.fn().mockResolvedValue({ session_id: null, memories_created: 1, entities_found: [], facts: [] });
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;

    const handler = createCaptureHandler(client, makeConfig(), logger);

    const turn1Messages = [
      { role: "user", content: "What is the deployment strategy for our backend?" },
      { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate with ALB." },
    ];

    // Turn 1: full history is [turn1]
    await handler({ messages: turn1Messages, aborted: false, sessionKey: "sess-1" });
    await vi.waitFor(() => expect(rememberMock).toHaveBeenCalledTimes(1));

    const turn2Delta = [
      { role: "user", content: "How does the health check work for the blue-green swap?" },
      { role: "assistant", content: "ALB checks the /health endpoint before shifting traffic to the new target group." },
    ];

    // Turn 2: cumulative history is [turn1..., turn2...]
    await handler({ messages: [...turn1Messages, ...turn2Delta], aborted: false, sessionKey: "sess-1" });
    await vi.waitFor(() => expect(rememberMock).toHaveBeenCalledTimes(2));

    // Second call should only contain the turn 2 delta, not turn 1 again
    const secondCallMessages = rememberMock.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(secondCallMessages).toHaveLength(2);
    expect(secondCallMessages[0].content).toBe("How does the health check work for the blue-green swap?");
  });

  it("falls back to sessionId when sessionKey is absent", async () => {
    const rememberPromise = Promise.resolve({ session_id: null, memories_created: 1, entities_found: [], facts: [] });
    const rememberMock = vi.fn().mockReturnValue(rememberPromise);
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;

    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler({
      messages: [
        { role: "user", content: "What is the deployment strategy for our backend?" },
        { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate with ALB." },
      ],
      aborted: false,
      sessionId: "fallback-id",
    });

    await rememberPromise;
    expect(rememberMock).toHaveBeenCalledWith(expect.any(Array), "fallback-id");
  });
});
