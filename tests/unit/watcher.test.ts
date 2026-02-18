import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileSyncWatcher } from "../../src/features/sync/watcher.js";
import type { CortexClient } from "../../src/cortex/client.js";
import type { RetryQueue } from "../../src/shared/queue/retry-queue.js";

// Mock all sub-sync classes and fs.watch
vi.mock("node:fs", () => {
  const mockClose = vi.fn();
  return {
    watch: vi.fn(() => ({ close: mockClose, __mockClose: mockClose })),
  };
});

vi.mock("../../src/features/sync/memory-md-sync.js", () => ({
  MemoryMdSync: vi.fn().mockImplementation(() => ({
    onFileChange: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../../src/features/sync/daily-logs-sync.js", () => ({
  DailyLogsSync: vi.fn().mockImplementation(() => ({
    onFileChange: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../../src/features/sync/transcripts-sync.js", () => ({
  TranscriptsSync: vi.fn().mockImplementation(() => ({
    onFileChange: vi.fn(),
    stop: vi.fn(),
  })),
}));

import { watch } from "node:fs";
import { MemoryMdSync } from "../../src/features/sync/memory-md-sync.js";
import { DailyLogsSync } from "../../src/features/sync/daily-logs-sync.js";
import { TranscriptsSync } from "../../src/features/sync/transcripts-sync.js";

const mockWatch = watch as ReturnType<typeof vi.fn>;

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeClient(): CortexClient {
  return {} as unknown as CortexClient;
}

function makeRetryQueue(): RetryQueue {
  return {
    enqueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as RetryQueue;
}

describe("FileSyncWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("start() creates all three watchers by default", () => {
    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      makeLogger(),
    );

    watcher.start();

    // 3 watch calls: MEMORY.md, memory/, sessions/
    expect(mockWatch).toHaveBeenCalledTimes(3);
    expect(MemoryMdSync).toHaveBeenCalledTimes(1);
    expect(DailyLogsSync).toHaveBeenCalledTimes(1);
    expect(TranscriptsSync).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent and does not register duplicate watchers", () => {
    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      makeLogger(),
    );

    watcher.start();
    watcher.start();

    expect(mockWatch).toHaveBeenCalledTimes(3);
  });

  it("start() skips TranscriptsSync when transcripts: false", () => {
    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      makeLogger(),
      undefined,
      { transcripts: false },
    );

    watcher.start();

    // Only 2 watch calls: MEMORY.md, memory/ (no sessions/)
    expect(mockWatch).toHaveBeenCalledTimes(2);
    expect(TranscriptsSync).not.toHaveBeenCalled();
  });

  it("start() handles missing directories gracefully", () => {
    const logger = makeLogger();

    // Make all watch calls throw (directories don't exist)
    mockWatch.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      logger,
    );

    // Should not throw
    expect(() => watcher.start()).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
  });

  it("stop() closes all watchers and sub-syncs", () => {
    const closeFns: Array<ReturnType<typeof vi.fn>> = [];
    mockWatch.mockImplementation(() => {
      const close = vi.fn();
      closeFns.push(close);
      return { close };
    });

    const logger = makeLogger();
    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      logger,
    );

    watcher.start();
    watcher.stop();

    // All fs watchers closed
    for (const close of closeFns) {
      expect(close).toHaveBeenCalled();
    }

    expect(logger.info).toHaveBeenCalledWith("File sync stopped");
  });

  it("stop() is safe to call before start()", () => {
    const logger = makeLogger();
    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      logger,
    );

    // Should not throw
    expect(() => watcher.stop()).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith("File sync stopped");
  });

  it("watch callback for daily logs filters non-.md files", () => {
    let dailyLogsCallback: (event: string, filename: string | null) => void;

    mockWatch.mockImplementation((_path: string, optionsOrCb: unknown, maybeCb?: unknown) => {
      const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      // The second watch call is the daily logs watcher (memory/)
      if (mockWatch.mock.calls.length === 2 && typeof cb === "function") {
        dailyLogsCallback = cb as (event: string, filename: string | null) => void;
      }
      return { close: vi.fn() };
    });

    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      makeLogger(),
    );

    watcher.start();

    const dailyLogsSyncInstance = (DailyLogsSync as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

    // Trigger with non-.md file — should not call onFileChange
    dailyLogsCallback!("change", "data.json");
    expect(dailyLogsSyncInstance.onFileChange).not.toHaveBeenCalled();

    // Trigger with .md file — should call onFileChange
    dailyLogsCallback!("change", "2026-02-17.md");
    expect(dailyLogsSyncInstance.onFileChange).toHaveBeenCalled();
  });

  it("watch callback handles null filename", () => {
    let dailyLogsCallback: (event: string, filename: string | null) => void;

    mockWatch.mockImplementation((_path: string, optionsOrCb: unknown, maybeCb?: unknown) => {
      const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      if (mockWatch.mock.calls.length === 2 && typeof cb === "function") {
        dailyLogsCallback = cb as (event: string, filename: string | null) => void;
      }
      return { close: vi.fn() };
    });

    const watcher = new FileSyncWatcher(
      "/workspace",
      makeClient(),
      "ns",
      makeLogger(),
    );

    watcher.start();

    const dailyLogsSyncInstance = (DailyLogsSync as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

    // null filename should be safely handled
    dailyLogsCallback!("change", null);
    expect(dailyLogsSyncInstance.onFileChange).not.toHaveBeenCalled();
  });
});
