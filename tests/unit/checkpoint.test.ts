import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCheckpointHandler } from "../../src/features/checkpoint/handler.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { CortexConfig } from "../../src/plugin/config.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallLimit: 10,
    recallQueryType: "combined",
    recallTimeoutMs: 500,
    toolTimeoutMs: 10000,
    fileSync: true,
    transcriptSync: true,
    captureFilter: true,
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

describe("createCheckpointHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves checkpoint with explicit summary", async () => {
    const rememberMock = vi.fn().mockResolvedValue({ session_id: "sess-1" });
    const client = { remember: rememberMock } as unknown as CortexClient;

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => [],
      "sess-1",
    );

    const result = await handler({ args: "working on auth refactor" });

    expect(result.text).toContain("Checkpoint saved.");
    expect(rememberMock).toHaveBeenCalledWith(
      "[SESSION CHECKPOINT] working on auth refactor",
      "sess-1",
      10000,
      expect.any(String),
      "user-1",
      "openclaw",
      "OpenClaw",
    );
  });

  it("extracts summary from last messages when no args provided", async () => {
    const rememberMock = vi.fn().mockResolvedValue({ session_id: "sess-1" });
    const client = { remember: rememberMock } as unknown as CortexClient;

    const messages = [
      { role: "user", content: "How do I configure the database connection pool?" },
      { role: "assistant", content: "You can configure it in the config file..." },
      { role: "user", content: "What about the retry settings for failed queries?" },
      { role: "assistant", content: "The retry settings are..." },
    ];

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => messages,
      "sess-1",
    );

    const result = await handler({ args: "" });

    expect(result.text).toContain("Checkpoint saved.");
    expect(rememberMock).toHaveBeenCalledOnce();

    const savedText = rememberMock.mock.calls[0][0] as string;
    expect(savedText).toMatch(/^\[SESSION CHECKPOINT\]/);
    expect(savedText).toContain("database connection pool");
    expect(savedText).toContain("retry settings");
  });

  it("returns helpful error when no args and no messages", async () => {
    const rememberMock = vi.fn();
    const client = { remember: rememberMock } as unknown as CortexClient;

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => [],
      "sess-1",
    );

    const result = await handler({ args: "" });

    expect(result.text).toContain("No session context");
    expect(result.text).toContain("/checkpoint");
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("handles remember failure gracefully", async () => {
    const rememberMock = vi.fn().mockRejectedValue(new Error("Cortex remember failed: 503"));
    const client = { remember: rememberMock } as unknown as CortexClient;

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => [],
      "sess-1",
    );

    const result = await handler({ args: "saving my work" });

    expect(result.text).toContain("Checkpoint failed");
    expect(result.text).toContain("503");
  });

  it("awaits userIdReady before calling API", async () => {
    const order: string[] = [];
    let resolveUserId!: () => void;
    const userIdReady = new Promise<void>((resolve) => {
      resolveUserId = resolve;
    });

    const rememberMock = vi.fn().mockImplementation(async () => {
      order.push("remember");
      return { session_id: "sess-1" };
    });
    const client = { remember: rememberMock } as unknown as CortexClient;

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      userIdReady,
      () => [],
      "sess-1",
    );

    const promise = handler({ args: "test checkpoint" });

    // remember should not have been called yet
    expect(rememberMock).not.toHaveBeenCalled();

    resolveUserId();
    await promise;

    expect(rememberMock).toHaveBeenCalledOnce();
  });

  it("fails fast when user_id is missing after userIdReady", async () => {
    const rememberMock = vi.fn();
    const client = { remember: rememberMock } as unknown as CortexClient;

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => undefined,
      Promise.resolve(),
      () => [],
      "sess-1",
    );

    const result = await handler({ args: "checkpoint text" });

    expect(result.text).toContain("requires user_id");
    expect(rememberMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing user_id"));
  });

  it("takes only last 5 user messages for auto-summary", async () => {
    const rememberMock = vi.fn().mockResolvedValue({ session_id: "sess-1" });
    const client = { remember: rememberMock } as unknown as CortexClient;

    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message number ${i + 1} with enough content to be meaningful`,
    }));

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => messages,
      "sess-1",
    );

    await handler({});

    const savedText = rememberMock.mock.calls[0][0] as string;
    const bullets = savedText.replace("[SESSION CHECKPOINT] ", "").split("\n").filter((l: string) => l.startsWith("- "));
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  it("truncates long messages in auto-summary", async () => {
    const rememberMock = vi.fn().mockResolvedValue({ session_id: "sess-1" });
    const client = { remember: rememberMock } as unknown as CortexClient;

    const longContent = "A".repeat(600);
    const messages = [{ role: "user", content: longContent }];

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => messages,
      "sess-1",
    );

    await handler({});

    const savedText = rememberMock.mock.calls[0][0] as string;
    // 500 chars + "…" + bullet prefix + checkpoint prefix
    expect(savedText.length).toBeLessThan(600);
    expect(savedText).toContain("…");
  });

  it("logs to audit logger when provided", async () => {
    const rememberMock = vi.fn().mockResolvedValue({ session_id: "sess-1" });
    const client = { remember: rememberMock } as unknown as CortexClient;
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { log: auditLog } as any;

    const handler = createCheckpointHandler(
      client,
      makeConfig(),
      logger,
      () => "user-1",
      Promise.resolve(),
      () => [],
      "sess-1",
      auditLogger,
    );

    await handler({ args: "test audit" });

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "command-checkpoint",
        endpoint: "/v1/remember",
      }),
    );
  });
});
