import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PeriodicReflect } from "../src/services/reflect.js";
import type { CortexClient } from "../src/client.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("PeriodicReflect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls reflect on interval", async () => {
    const client = {
      reflect: vi.fn().mockResolvedValue({ synthesized_count: 3, superseded_count: 1 }),
    } as unknown as CortexClient;

    const reflect = new PeriodicReflect(client, logger, 5000);
    reflect.start();

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.reflect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.reflect).toHaveBeenCalledTimes(2);

    reflect.stop();
  });

  it("logs results on success", async () => {
    const client = {
      reflect: vi.fn().mockResolvedValue({ synthesized_count: 5, superseded_count: 2 }),
    } as unknown as CortexClient;

    const reflect = new PeriodicReflect(client, logger, 1000);
    reflect.start();

    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("synthesized 5"),
    );
    reflect.stop();
  });

  it("handles reflect failure gracefully", async () => {
    const client = {
      reflect: vi.fn().mockRejectedValue(new Error("server error")),
    } as unknown as CortexClient;

    const reflect = new PeriodicReflect(client, logger, 1000);
    reflect.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Reflect failed:"));

    // Should continue running — next tick should also attempt
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.reflect).toHaveBeenCalledTimes(2);

    reflect.stop();
  });

  it("run() can be called manually", async () => {
    const client = {
      reflect: vi.fn().mockResolvedValue({ synthesized_count: 1, superseded_count: 0 }),
    } as unknown as CortexClient;

    const reflect = new PeriodicReflect(client, logger);
    await reflect.run();

    expect(client.reflect).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("synthesized 1"),
    );
  });

  it("stop prevents further calls", async () => {
    const client = {
      reflect: vi.fn().mockResolvedValue({ synthesized_count: 0, superseded_count: 0 }),
    } as unknown as CortexClient;

    const reflect = new PeriodicReflect(client, logger, 1000);
    reflect.start();
    reflect.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.reflect).not.toHaveBeenCalled();
  });
});
