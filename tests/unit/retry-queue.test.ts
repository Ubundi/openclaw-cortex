import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RetryQueue } from "../../src/shared/queue/retry-queue.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("RetryQueue", () => {
  let queue: RetryQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new RetryQueue(logger);
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("executes enqueued tasks on flush interval", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    queue.start();
    queue.enqueue(task, "test-task");

    expect(queue.pending).toBe(1);

    // Advance past flush interval (5s)
    await vi.advanceTimersByTimeAsync(5000);

    expect(task).toHaveBeenCalledOnce();
    expect(queue.pending).toBe(0);
  });

  it("retries failed tasks with backoff", async () => {
    let attempts = 0;
    const task = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
    });

    queue.start();
    queue.enqueue(task, "retry-task");

    // First flush — fails
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(1);

    // Backoff: 2s after first failure. Advance enough for next flush + backoff.
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(queue.pending).toBe(1);

    // Backoff: 4s after second failure. Advance enough.
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(3);
    expect(queue.pending).toBe(0); // succeeded on 3rd try
  });

  it("drops tasks after max retries", async () => {
    const task = vi.fn().mockRejectedValue(new Error("always fail"));
    queue = new RetryQueue(logger, 2); // max 2 retries
    queue.start();
    queue.enqueue(task, "doomed-task");

    // Flush through retries
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    expect(queue.pending).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed after 2 retries"),
    );
  });

  it("clears queue on stop", () => {
    queue.enqueue(vi.fn(), "task-1");
    queue.enqueue(vi.fn(), "task-2");
    expect(queue.pending).toBe(2);

    queue.stop();
    expect(queue.pending).toBe(0);
  });
});
