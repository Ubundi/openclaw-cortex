import { describe, it, expect, vi } from "vitest";
import { createCaptureHandler } from "../../src/features/capture/handler.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { CortexConfig } from "../../src/core/config/schema.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallTopK: 5,
    recallTimeoutMs: 500,
    recallMode: "fast" as const,
    fileSync: true,
    transcriptSync: true,
    reflectIntervalMs: 3_600_000,
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
  it("ingests conversation on successful agent end", async () => {
    const ingestPromise = Promise.resolve({ job_id: "job-1", status: "pending" });
    const ingestMock = vi.fn().mockReturnValue(ingestPromise);
    const client = { submitIngestConversation: ingestMock } as unknown as CortexClient;

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
    await ingestPromise;

    expect(ingestMock).toHaveBeenCalledWith(
      [
        { role: "user", content: "What is the deployment strategy for our backend?" },
        { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate with ALB." },
      ],
      "sess-1",
    );
  });

  it("skips when autoCapture is disabled", async () => {
    const ingestMock = vi.fn();
    const client = { submitIngestConversation: ingestMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig({ autoCapture: false }), logger);

    await handler(
      { messages: [{ role: "user", content: "test" }], success: true },
      {},
    );

    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("skips on failed agent run", async () => {
    const ingestMock = vi.fn();
    const client = { submitIngestConversation: ingestMock } as unknown as CortexClient;
    const handler = createCaptureHandler(client, makeConfig(), logger);

    await handler(
      { messages: [{ role: "user", content: "long enough content to matter" }], success: false },
      {},
    );

    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("skips when messages are too short", async () => {
    const ingestMock = vi.fn();
    const client = { submitIngestConversation: ingestMock } as unknown as CortexClient;
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

    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("handles array content blocks", async () => {
    const ingestPromise = Promise.resolve({ job_id: "job-1", status: "pending" });
    const ingestMock = vi.fn().mockReturnValue(ingestPromise);
    const client = { submitIngestConversation: ingestMock } as unknown as CortexClient;

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

    await ingestPromise;

    const callArgs = ingestMock.mock.calls[0][0];
    expect(callArgs[1].content).toBe(
      "The project uses PostgreSQL with pgvector for embedding storage.",
    );
  });
});
