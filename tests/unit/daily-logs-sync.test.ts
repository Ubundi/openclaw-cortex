import { describe, it, expect, vi, beforeEach } from "vitest";
import { DailyLogsSync } from "../../src/features/sync/daily-logs-sync.js";
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
    ingest: vi.fn().mockResolvedValue({ nodes_created: 1, edges_created: 0, facts: [], entities: [] }),
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

    expect(client.ingest).toHaveBeenCalledWith(
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

    expect(client.ingest).toHaveBeenCalledTimes(2);
    const secondCall = (client.ingest as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe("line3\n");
  });

  it("skips when new content is only whitespace", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger);

    mockReadFile.mockResolvedValue("existing content");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");
    (client.ingest as ReturnType<typeof vi.fn>).mockClear();

    // Same length, nothing new
    mockReadFile.mockResolvedValue("existing content   ");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(client.ingest).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths when allowedRoot is set", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger, undefined, "/workspace/memory");

    mockSafePath.mockResolvedValue(null);

    await sync.onFileChange("/etc/passwd", "passwd");

    expect(client.ingest).not.toHaveBeenCalled();
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
      ingest: vi.fn().mockRejectedValue(new Error("network error")),
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

  it("logs warning when readFile throws", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger);

    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await sync.onFileChange("/workspace/memory/missing.md", "missing.md");

    expect(client.ingest).not.toHaveBeenCalled();
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
    (client.ingest as ReturnType<typeof vi.fn>).mockClear();

    sync.stop();

    // After stop and re-read, full content should be ingested again (offset reset)
    mockReadFile.mockResolvedValue("content");
    await sync.onFileChange("/workspace/memory/log.md", "log.md");

    expect(client.ingest).toHaveBeenCalledWith("content", expect.any(String), undefined, undefined);
  });
});
