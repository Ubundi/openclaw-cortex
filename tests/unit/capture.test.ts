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

    await handler(
      {
        messages: [
          { role: "user", content: "What is the deployment strategy for our backend?" },
          { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate with ALB." },
        ],
        success: true,
      },
      { sessionKey: "sess-1" },
    );

    // Wait for fire-and-forget
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

    await handler(
      { messages: [{ role: "user", content: "test" }], success: true },
      {},
    );

    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("skips on failed agent run", async () => {
    const rememberMock = vi.fn();
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler(
      { messages: [{ role: "user", content: "long enough content to matter" }], success: false },
      {},
    );

    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("skips when messages are too short", async () => {
    const rememberMock = vi.fn();
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        success: true,
      },
      {},
    );

    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("handles array content blocks", async () => {
    const rememberPromise = Promise.resolve({ session_id: null, memories_created: 1, entities_found: [], facts: [] });
    const rememberMock = vi.fn().mockReturnValue(rememberPromise);
    const client = { rememberConversation: rememberMock } as unknown as CortexClient;

    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler(
      {
        messages: [
          { role: "user", content: "What database does the project use and why?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "The project uses PostgreSQL with pgvector for embedding storage." },
            ],
          },
        ],
        success: true,
      },
      {},
    );

    await rememberPromise;

    const callArgs = rememberMock.mock.calls[0][0];
    expect(callArgs[1].content).toBe(
      "The project uses PostgreSQL with pgvector for embedding storage.",
    );
  });
});
