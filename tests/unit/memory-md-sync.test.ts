import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryMdSync } from "../../src/features/sync/memory-md-sync.js";
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

describe("MemoryMdSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ingests diff after debounce", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "mem-session", logger);

    mockReadFile.mockResolvedValue("line1\nline2");

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(client.remember).toHaveBeenCalledWith(
      "line1\nline2",
      "mem-session",
    );
  });

  it("debounces multiple rapid calls", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger);

    mockReadFile.mockResolvedValue("content");

    sync.onFileChange();
    sync.onFileChange();
    sync.onFileChange();

    await vi.advanceTimersByTimeAsync(2000);

    // readFile should only be called once despite 3 onChange calls
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("skips when file content is identical to last read", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger);

    mockReadFile.mockResolvedValue("same content");

    // First call: ingests
    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.remember).toHaveBeenCalledTimes(1);

    (client.remember as ReturnType<typeof vi.fn>).mockClear();

    // Second call: same content, should skip
    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.remember).not.toHaveBeenCalled();
  });

  it("skips when diff is only whitespace", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger);

    mockReadFile.mockResolvedValue("line1\nline2");

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);
    (client.remember as ReturnType<typeof vi.fn>).mockClear();

    // Add only blank lines
    mockReadFile.mockResolvedValue("line1\nline2\n\n  \n");

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.remember).not.toHaveBeenCalled();
  });

  it("silently returns when file does not exist", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger);

    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(client.remember).not.toHaveBeenCalled();
    // Should NOT warn — file-not-found is expected
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("queues for retry when ingest fails", async () => {
    const client = makeClient({
      remember: vi.fn().mockRejectedValue(new Error("server error")),
    });
    const logger = makeLogger();
    const retryQueue = makeRetryQueue();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger, retryQueue);

    mockReadFile.mockResolvedValue("new line");

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(retryQueue.enqueue).toHaveBeenCalledWith(
      expect.any(Function),
      expect.stringContaining("memory-md-"),
    );
  });

  it("queues retry tasks for repeated ingest failures", async () => {
    const client = makeClient({
      remember: vi.fn().mockRejectedValue(new Error("still failing")),
    });
    const logger = makeLogger();
    const retryQueue = makeRetryQueue();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger, retryQueue);

    mockReadFile.mockResolvedValueOnce("line1");
    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    mockReadFile.mockResolvedValueOnce("line1\nline2");
    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(retryQueue.enqueue).toHaveBeenCalledTimes(2);
    expect((retryQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("memory-md-1");
    expect((retryQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe("memory-md-2");
  });

  it("stop() cancels pending debounce", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger);

    mockReadFile.mockResolvedValue("content");

    sync.onFileChange();
    sync.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(client.remember).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths when allowedRoot is set", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger, undefined, "/workspace");

    mockSafePath.mockResolvedValue(null);

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSafePath).toHaveBeenCalledWith("/workspace/MEMORY.md", "/workspace");
    expect(client.remember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("rejected unsafe path"));
  });

  it("reads resolved path from safePath when allowedRoot is set", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger, undefined, "/workspace");

    mockSafePath.mockResolvedValue("/workspace/MEMORY.md");
    mockReadFile.mockResolvedValue("safe content");

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSafePath).toHaveBeenCalledWith("/workspace/MEMORY.md", "/workspace");
    expect(mockReadFile).toHaveBeenCalledWith("/workspace/MEMORY.md", "utf-8");
    expect(client.remember).toHaveBeenCalledWith("safe content", "s");
  });

  it("skips safePath check when no allowedRoot is provided", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync("/workspace/MEMORY.md", client, "s", logger);

    mockReadFile.mockResolvedValue("content");

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSafePath).not.toHaveBeenCalled();
    expect(client.remember).toHaveBeenCalled();
  });
});
