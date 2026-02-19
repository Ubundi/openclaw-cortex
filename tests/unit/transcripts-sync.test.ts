import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranscriptsSync } from "../../src/features/sync/transcripts-sync.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { RetryQueue } from "../../src/shared/queue/retry-queue.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../src/shared/fs/safe-path.js", () => ({
  safePath: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { safePath } from "../../src/shared/fs/safe-path.js";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockSafePath = safePath as ReturnType<typeof vi.fn>;

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeClient(overrides: Partial<CortexClient> = {}): CortexClient {
  return {
    submitIngestConversation: vi.fn().mockResolvedValue({ job_id: "job-1", status: "pending" }),
    ...overrides,
  } as unknown as CortexClient;
}

function makeRetryQueue(): RetryQueue {
  return {
    enqueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as RetryQueue;
}

// A valid JSONL chunk with user + assistant (both >20 chars) so worthIngesting=true
const VALID_JSONL = [
  JSON.stringify({ role: "user", content: "What is the deployment strategy for our backend services?" }),
  JSON.stringify({ role: "assistant", content: "We use blue-green deployment on ECS Fargate with ALB switching." }),
].join("\n");

// Only user messages — worthIngesting=false
const USER_ONLY_JSONL = [
  JSON.stringify({ role: "user", content: "What is the deployment strategy for our backend services?" }),
].join("\n");

describe("TranscriptsSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ingests valid transcript chunks", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "test-ns", logger);

    mockReadFile.mockResolvedValue(VALID_JSONL);

    await sync.onFileChange("/workspace/sessions/abc123.jsonl", "abc123.jsonl");

    expect(client.submitIngestConversation).toHaveBeenCalledWith(
      [
        { role: "user", content: "What is the deployment strategy for our backend services?" },
        { role: "assistant", content: "We use blue-green deployment on ECS Fargate with ALB switching." },
      ],
      "test-ns:session:abc123",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("derives session ID from filename by stripping .jsonl", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue(VALID_JSONL);

    await sync.onFileChange("/workspace/sessions/my-session-42.jsonl", "my-session-42.jsonl");

    const sessionId = (client.submitIngestConversation as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sessionId).toBe("ns:session:my-session-42");
  });

  it("skips when transcript is not worth ingesting (no assistant)", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue(USER_ONLY_JSONL);

    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(client.submitIngestConversation).not.toHaveBeenCalled();
  });

  it("only ingests new content on subsequent calls (incremental offset)", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue(VALID_JSONL);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    const appended = VALID_JSONL + "\n" + VALID_JSONL;
    mockReadFile.mockResolvedValue(appended);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(client.submitIngestConversation).toHaveBeenCalledTimes(2);
  });

  it("skips when new content is only whitespace", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue(VALID_JSONL);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");
    (client.submitIngestConversation as ReturnType<typeof vi.fn>).mockClear();

    // Same content, no new bytes
    mockReadFile.mockResolvedValue(VALID_JSONL + "   ");
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(client.submitIngestConversation).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths when allowedRoot is set", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger, undefined, "/workspace/sessions");

    mockSafePath.mockResolvedValue(null);

    await sync.onFileChange("/etc/shadow", "shadow");

    expect(client.submitIngestConversation).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("rejected unsafe path"),
    );
  });

  it("queues for retry when ingestConversation fails", async () => {
    const client = makeClient({
      submitIngestConversation: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const logger = makeLogger();
    const retryQueue = makeRetryQueue();
    const sync = new TranscriptsSync(client, "ns", logger, retryQueue);

    mockReadFile.mockResolvedValue(VALID_JSONL);

    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(retryQueue.enqueue).toHaveBeenCalledWith(
      expect.any(Function),
      "transcript-s.jsonl",
    );
  });

  it("queues retry on repeated failures for the same transcript", async () => {
    const client = makeClient({
      submitIngestConversation: vi.fn().mockRejectedValue(new Error("still failing")),
    });
    const logger = makeLogger();
    const retryQueue = makeRetryQueue();
    const sync = new TranscriptsSync(client, "ns", logger, retryQueue);

    mockReadFile.mockResolvedValueOnce(VALID_JSONL);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    mockReadFile.mockResolvedValueOnce(`${VALID_JSONL}\n${VALID_JSONL}`);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(retryQueue.enqueue).toHaveBeenCalledTimes(2);
    expect((retryQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("transcript-s.jsonl");
    expect((retryQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe("transcript-s.jsonl");
  });

  it("logs warning when readFile throws", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger);

    mockReadFile.mockRejectedValue(new Error("EACCES"));

    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(client.submitIngestConversation).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("read failed"),
    );
  });

  it("stop() clears offsets so next read ingests full content", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue(VALID_JSONL);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");
    (client.submitIngestConversation as ReturnType<typeof vi.fn>).mockClear();

    sync.stop();

    mockReadFile.mockResolvedValue(VALID_JSONL);
    await sync.onFileChange("/workspace/sessions/s.jsonl", "s.jsonl");

    expect(client.submitIngestConversation).toHaveBeenCalledTimes(1);
  });
});
