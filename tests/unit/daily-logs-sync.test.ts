import { describe, it, expect, vi, beforeEach } from "vitest";
import { DailyLogsSync } from "../../src/features/sync/daily-logs-sync.js";
import type { CortexClient } from "../../src/adapters/cortex/client.js";
import type { RetryQueue } from "../../src/internal/queue/retry-queue.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../src/internal/fs/safe-path.js", () => ({
  safePath: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { safePath } from "../../src/internal/fs/safe-path.js";

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
    remember: vi.fn().mockResolvedValue({ session_id: null, memories_created: 1, entities_found: [], facts: [] }),
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

describe("DailyLogsSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ingests new content from a file", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "test-ns", logger);

    mockReadFile.mockResolvedValue("line1\nline2\n");

    await sync.onFileChange("/workspace/memory/2026-02-17.md", "2026-02-17.md");

    expect(client.remember).toHaveBeenCalledWith(
      "line1\nline2\n",
      "test-ns:daily:2026-02-17.md",
      undefined,
      "2026-02-17",
    );
  });

  it("only ingests new content on subsequent calls (incremental offset)", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue("line1\nline2\n");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    mockReadFile.mockResolvedValue("line1\nline2\nline3\n");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(client.remember).toHaveBeenCalledTimes(2);
    const secondCall = (client.remember as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe("line3\n");
  });

  it("skips when new content is only whitespace", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue("existing content");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");
    (client.remember as ReturnType<typeof vi.fn>).mockClear();

    // Same length, nothing new
    mockReadFile.mockResolvedValue("existing content   ");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(client.remember).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths when allowedRoot is set", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger, undefined, "/workspace/memory");

    mockSafePath.mockResolvedValue(null);

    await sync.onFileChange("/etc/passwd", "passwd");

    expect(client.remember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("rejected unsafe path"),
    );
  });

  it("uses resolved safe path for reading", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger, undefined, "/workspace/memory");

    mockSafePath.mockResolvedValue("/workspace/memory/resolved.md");
    mockReadFile.mockResolvedValue("safe content");

    await sync.onFileChange("/workspace/memory/../memory/resolved.md", "resolved.md");

    expect(mockReadFile).toHaveBeenCalledWith("/workspace/memory/resolved.md", "utf-8");
  });

  it("queues for retry when ingest fails", async () => {
    const client = makeClient({
      remember: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const logger = makeLogger();
    const retryQueue = makeRetryQueue();
    const sync = new DailyLogsSync(client, "ns", logger, retryQueue);

    mockReadFile.mockResolvedValue("some content");

    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(retryQueue.enqueue).toHaveBeenCalledWith(
      expect.any(Function),
      "daily-log.md",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("queuing for retry"),
    );
  });

  it("queues retry on repeated failures for the same file", async () => {
    const client = makeClient({
      remember: vi.fn().mockRejectedValue(new Error("still failing")),
    });
    const logger = makeLogger();
    const retryQueue = makeRetryQueue();
    const sync = new DailyLogsSync(client, "ns", logger, retryQueue);

    mockReadFile.mockResolvedValueOnce("line1\n");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    mockReadFile.mockResolvedValueOnce("line1\nline2\n");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(retryQueue.enqueue).toHaveBeenCalledTimes(2);
    expect((retryQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("daily-log.md");
    expect((retryQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe("daily-log.md");
  });

  it("logs warning when readFile throws", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger);

    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await sync.onFileChange("/workspace/memory/missing.md", "missing.md");

    expect(client.remember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("read failed"),
    );
  });

  it("stop() clears offsets", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue("content");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");
    (client.remember as ReturnType<typeof vi.fn>).mockClear();

    sync.stop();

    // After stop and re-read, full content should be ingested again (offset reset)
    mockReadFile.mockResolvedValue("content");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(client.remember).toHaveBeenCalledWith("content", expect.any(String), undefined, undefined);
  });
});
