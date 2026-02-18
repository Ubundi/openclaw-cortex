import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../src/core/plugin.js";
import { CortexClient } from "../../src/cortex/client.js";
import { FileSyncWatcher } from "../../src/features/sync/watcher.js";
import { PeriodicReflect } from "../../src/features/reflect/service.js";
import { RetryQueue } from "../../src/shared/queue/retry-queue.js";

type HookHandler = (...args: any[]) => any;

interface MockLogger {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

interface MockApi {
  pluginConfig: Record<string, unknown>;
  logger: MockLogger;
  on: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn>;
}

function makeApi(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, HookHandler[]> = {};
  const services: Array<{ id: string; start?: (ctx: { workspaceDir?: string }) => void; stop?: () => void }> = [];
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const api: MockApi = {
    pluginConfig,
    logger,
    on: vi.fn((hookName: string, handler: HookHandler) => {
      hooks[hookName] ??= [];
      hooks[hookName].push(handler);
    }),
    registerService: vi.fn((service) => {
      services.push(service);
    }),
  };

  return { api, hooks, services, logger };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function mockClientHealth() {
  vi.spyOn(CortexClient.prototype, "healthCheck").mockResolvedValue(true);
  vi.spyOn(CortexClient.prototype, "warmup").mockResolvedValue({
    tenant_id: "tenant-test",
    already_warm: true,
  });
}

describe("plugin lifecycle contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientHealth();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("register wires hooks and service", async () => {
    const { api, hooks, services } = makeApi({
      apiKey: "sk-test",
      fileSync: false,
      reflectIntervalMs: 0,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(hooks.before_agent_start).toHaveLength(1);
    expect(hooks.agent_end).toHaveLength(1);

    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(services[0]?.id).toBe("cortex-services");

    expect(CortexClient.prototype.healthCheck).toHaveBeenCalledOnce();
    expect(CortexClient.prototype.warmup).toHaveBeenCalledOnce();
  });

  it("service start/stop initializes retry queue, file sync, and reflect", async () => {
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});
    const retryStop = vi.spyOn(RetryQueue.prototype, "stop").mockImplementation(() => {});
    const watcherStart = vi.spyOn(FileSyncWatcher.prototype, "start").mockImplementation(() => {});
    const watcherStop = vi.spyOn(FileSyncWatcher.prototype, "stop").mockImplementation(() => {});
    const reflectStart = vi.spyOn(PeriodicReflect.prototype, "start").mockImplementation(() => {});
    const reflectStop = vi.spyOn(PeriodicReflect.prototype, "stop").mockImplementation(() => {});

    const { api, services } = makeApi({
      apiKey: "sk-test",
      fileSync: true,
      transcriptSync: true,
      reflectIntervalMs: 1000,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    expect(service).toBeDefined();

    expect(() => service.start?.({ workspaceDir: "/tmp/workspace" })).not.toThrow();
    expect(retryStart).toHaveBeenCalledOnce();
    expect(watcherStart).toHaveBeenCalledOnce();
    expect(reflectStart).toHaveBeenCalledOnce();

    expect(() => service.stop?.call(service)).not.toThrow();
    expect(watcherStop).toHaveBeenCalledOnce();
    expect(reflectStop).toHaveBeenCalledOnce();
    expect(retryStop).toHaveBeenCalledOnce();

    expect(() => service.stop?.call(service)).not.toThrow();
  });

  it("service start is idempotent and does not duplicate background services", async () => {
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});
    const watcherStart = vi.spyOn(FileSyncWatcher.prototype, "start").mockImplementation(() => {});
    const reflectStart = vi.spyOn(PeriodicReflect.prototype, "start").mockImplementation(() => {});

    const { api, services } = makeApi({
      apiKey: "sk-test",
      fileSync: true,
      reflectIntervalMs: 1000,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    service.start?.({ workspaceDir: "/tmp/workspace" });
    service.start?.({ workspaceDir: "/tmp/workspace" });

    expect(retryStart).toHaveBeenCalledOnce();
    expect(watcherStart).toHaveBeenCalledOnce();
    expect(reflectStart).toHaveBeenCalledOnce();
  });

  it("logs warning and skips file sync when workspaceDir is missing", async () => {
    const watcherStart = vi.spyOn(FileSyncWatcher.prototype, "start").mockImplementation(() => {});
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});

    const { api, services, logger } = makeApi({
      apiKey: "sk-test",
      fileSync: true,
      reflectIntervalMs: 0,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    service.start?.({});

    expect(retryStart).toHaveBeenCalledOnce();
    expect(watcherStart).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Cortex file sync: no workspaceDir, skipping");
  });

  it("stop logs recall latency summary after recall handler runs", async () => {
    vi.spyOn(RetryQueue.prototype, "stop").mockImplementation(() => {});
    vi.spyOn(CortexClient.prototype, "retrieve").mockResolvedValue({
      results: [
        { node_id: "n1", type: "FACT", content: "User prefers TypeScript", score: 0.9 },
      ],
    });

    const { api, hooks, services, logger } = makeApi({
      apiKey: "sk-test",
      fileSync: false,
      reflectIntervalMs: 0,
      recallTimeoutMs: 500,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    await hooks.before_agent_start[0](
      { prompt: "Tell me my project preferences" },
      {},
    );

    services[0].start?.({});
    services[0].stop?.call(services[0]);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Cortex recall latency ("));
  });

  it("invalid config refuses registration", () => {
    const { api, hooks, services, logger } = makeApi({
      // apiKey intentionally missing
      fileSync: false,
      reflectIntervalMs: 0,
    });

    plugin.register(api as any);

    expect(logger.error).toHaveBeenCalledWith(
      "Cortex plugin config invalid:",
      expect.stringContaining("apiKey"),
    );
    expect(Object.keys(hooks)).toHaveLength(0);
    expect(services).toHaveLength(0);
  });
});
