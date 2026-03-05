import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../src/plugin/index.js";
import { CortexClient } from "../../src/adapters/cortex/client.js";
import { FileSyncWatcher } from "../../src/features/sync/watcher.js";
import { RetryQueue } from "../../src/internal/queue/retry-queue.js";
import { SessionStateStore } from "../../src/internal/session/session-state.js";

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
  registerHook: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerGatewayMethod: ReturnType<typeof vi.fn>;
}

function makeApi(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, HookHandler[]> = {};
  const services: Array<{ id: string; start?: (ctx: { workspaceDir?: string }) => void; stop?: () => void }> = [];
  const tools: Array<{ name: string; description: string; parameters: unknown; execute: Function }> = [];
  const commands: Array<{ name: string; description: string; handler: Function }> = [];
  const rpcMethods: Record<string, Function> = {};
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
    registerHook: vi.fn((hookName: string, handler: HookHandler, _metadata: { name: string; description: string }) => {
      hooks[hookName] ??= [];
      hooks[hookName].push(handler);
    }),
    registerService: vi.fn((service) => {
      services.push(service);
    }),
    registerTool: vi.fn((definition) => {
      tools.push(definition);
    }),
    registerCommand: vi.fn((definition) => {
      commands.push(definition);
    }),
    registerGatewayMethod: vi.fn((name: string, handler: Function) => {
      rpcMethods[name] = handler;
    }),
  };

  return { api, hooks, services, tools, commands, rpcMethods, logger };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function mockClientHealth() {
  vi.spyOn(CortexClient.prototype, "healthCheck").mockResolvedValue(true);
}

function mockClientKnowledge(overrides: Partial<{
  total_memories: number;
  total_sessions: number;
  maturity: "cold" | "warming" | "mature";
}> = {}) {
  vi.spyOn(CortexClient.prototype, "knowledge").mockResolvedValue({
    total_memories: overrides.total_memories ?? 0,
    total_sessions: overrides.total_sessions ?? 0,
    maturity: overrides.maturity ?? "cold",
    entities: [],
  });
}

describe("plugin lifecycle contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientHealth();
    mockClientKnowledge();
    vi.spyOn(CortexClient.prototype, "stats").mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("register wires hooks and service via api.on", async () => {
    const { api, hooks, services } = makeApi({
      fileSync: false,
    });

    plugin.register(api as any);
    // Bootstrap (userId + healthCheck) now runs in start(), not register()
    services[0].start?.({});
    await new Promise((r) => setTimeout(r, 20));

    // Should use api.on() (preferred over registerHook)
    expect(api.on).toHaveBeenCalledWith(
      "before_agent_start",
      expect.any(Function),
    );
    expect(api.on).toHaveBeenCalledWith(
      "agent_end",
      expect.any(Function),
    );
    expect(api.on).toHaveBeenCalledWith(
      "gateway:heartbeat",
      expect.any(Function),
    );
    expect(hooks.before_agent_start).toHaveLength(1);
    expect(hooks.agent_end).toHaveLength(1);
    expect(hooks["gateway:heartbeat"]).toHaveLength(1);

    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(services[0]?.id).toBe("cortex-services");

    expect(CortexClient.prototype.healthCheck).toHaveBeenCalledOnce();
  });

  it("falls back to registerHook when api.on is not available", async () => {
    const { api, hooks } = makeApi({ fileSync: false });

    // Remove api.on to simulate runtime without it
    const fallbackApi = {
      ...api,
      on: undefined,
    };

    plugin.register(fallbackApi as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(api.registerHook).toHaveBeenCalledWith(
      "before_agent_start",
      expect.any(Function),
      { name: "openclaw-cortex.recall", description: expect.any(String) },
    );
    expect(api.registerHook).toHaveBeenCalledWith(
      "agent_end",
      expect.any(Function),
      { name: "openclaw-cortex.capture", description: expect.any(String) },
    );
    expect(api.registerHook).toHaveBeenCalledWith(
      "gateway:heartbeat",
      expect.any(Function),
      { name: "openclaw-cortex.heartbeat", description: expect.any(String) },
    );
    expect(hooks.before_agent_start).toHaveLength(1);
    expect(hooks.agent_end).toHaveLength(1);
    expect(hooks["gateway:heartbeat"]).toHaveLength(1);
  });

  it("registers agent tools", async () => {
    const { api, tools } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("cortex_search_memory");
    expect(toolNames).toContain("cortex_save_memory");
  });

  it("falls back to async ingest when cortex_save_memory sync remember fails", async () => {
    vi.spyOn(CortexClient.prototype, "remember").mockRejectedValue(
      new Error("Cortex remember failed: 500 — {\"detail\":\"Internal server error\"}"),
    );
    vi.spyOn(CortexClient.prototype, "submitIngest").mockResolvedValue({
      job_id: "job-123",
      status: "pending",
    });

    const { api, tools } = makeApi({
      fileSync: false,
      toolTimeoutMs: 1000,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const saveTool = tools.find((t) => t.name === "cortex_save_memory");
    expect(saveTool).toBeDefined();

    const result = await saveTool!.execute("tool-1", { text: "User prefers dark mode interfaces." });
    const responseText = result.content[0]?.text ?? "";

    expect(responseText).toContain("Memory save queued (job job-123, status=pending)");
    expect(CortexClient.prototype.remember).toHaveBeenCalledWith(
      "User prefers dark mode interfaces.",
      expect.any(String),
      1000,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.any(String),
      "openclaw",
      "OpenClaw",
    );
    expect(CortexClient.prototype.submitIngest).toHaveBeenCalledWith(
      "User prefers dark mode interfaces.",
      expect.any(String),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.any(String),
      "openclaw",
      "OpenClaw",
    );
  });

  it("registers auto-reply command", async () => {
    const { api, commands } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    expect(api.registerCommand).toHaveBeenCalledTimes(5);
    expect(commands[0]?.name).toBe("memories");
    expect(commands[1]?.name).toBe("audit");
    expect(commands[2]?.name).toBe("checkpoint");
    expect(commands[3]?.name).toBe("sleep");
    expect(commands[4]?.name).toBe("cortex");
  });

  it("sleep command clears dirty session state", async () => {
    const clearSpy = vi.spyOn(SessionStateStore.prototype, "clear").mockResolvedValue();
    const { api, commands } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    const sleep = commands.find((c) => c.name === "sleep");
    expect(sleep).toBeDefined();

    const result = await sleep!.handler({});
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(result.text).toContain("clean");
  });

  it("cortex id command generates and displays pairing code", async () => {
    vi.spyOn(CortexClient.prototype, "generatePairingCode").mockResolvedValue({
      user_code: "WOLF-3847",
      expires_in: 900,
      expires_at: "2026-03-04T12:00:00Z",
    });
    const { api, commands } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    const cortex = commands.find((c) => c.name === "cortex");
    expect(cortex).toBeDefined();

    const result = await cortex!.handler({ args: "id" });
    expect(result.text).toContain("WOLF-3847");
    expect(result.text).toContain("15 minute");
    expect(result.text).toContain("app.tootoo.io/settings/agents");
    expect(result.text).toContain("Connect Agent");
    expect(result.text).toContain("codex feed");
  });

  it("cortex command without args shows usage", async () => {
    const { api, commands } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    const cortex = commands.find((c) => c.name === "cortex");
    const result = await cortex!.handler({});
    expect(result.text).toContain("/cortex id");
  });

  it("cortex id command handles API failure gracefully", async () => {
    vi.spyOn(CortexClient.prototype, "generatePairingCode").mockRejectedValue(
      new Error("Cortex auth/code failed: 500"),
    );
    const { api, commands } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    const cortex = commands.find((c) => c.name === "cortex");
    const result = await cortex!.handler({ args: "id" });
    expect(result.text).toContain("Failed to generate pairing code");
  });

  it("injects recovery context on first turn after unclean prior lifecycle", async () => {
    vi.spyOn(SessionStateStore.prototype, "readDirtyFromPriorLifecycle")
      .mockResolvedValueOnce({
        dirty: true,
        pluginSessionId: "old-plugin-session",
        sessionKey: "old-runtime-session",
        updatedAt: "2026-03-04T07:30:00.000Z",
        summary: "Finish auth migration rollout and verify token refresh behavior",
      })
      .mockResolvedValue(null);
    const clearSpy = vi.spyOn(SessionStateStore.prototype, "clear").mockResolvedValue();

    const { api, hooks } = makeApi({ fileSync: false });
    plugin.register(api as any);
    await flushMicrotasks();

    const first = await hooks.before_agent_start[0](
      { prompt: "continue from where we left off yesterday" },
      { sessionKey: "new-runtime-session" },
    );

    expect(first?.prependContext).toContain("CONTEXT DEATH DETECTED");
    expect(first?.prependContext).toContain("old-runtime-session");
    expect(first?.prependContext).toContain("Finish auth migration rollout");
    expect(clearSpy).toHaveBeenCalledOnce();

    await hooks.before_agent_start[0](
      { prompt: "continue from where we left off yesterday" },
      { sessionKey: "new-runtime-session" },
    );
    expect(SessionStateStore.prototype.readDirtyFromPriorLifecycle).toHaveBeenCalledTimes(1);
  });

  it("registers Gateway RPC method", async () => {
    const { api, rpcMethods } = makeApi({ fileSync: false });

    plugin.register(api as any);
    await flushMicrotasks();

    expect(api.registerGatewayMethod).toHaveBeenCalledWith("cortex.status", expect.any(Function));
    expect(rpcMethods["cortex.status"]).toBeDefined();

    // Test the RPC handler responds with status
    let rpcResponse: unknown;
    rpcMethods["cortex.status"]({
      respond: (_ok: boolean, data: unknown) => { rpcResponse = data; },
    });
    expect(rpcResponse).toHaveProperty("version");
    expect(rpcResponse).toHaveProperty("knowledgeState");
    expect(rpcResponse).toHaveProperty("config");
  });

  it("service start/stop initializes retry queue and file sync", async () => {
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});
    const retryStop = vi.spyOn(RetryQueue.prototype, "stop").mockImplementation(() => {});
    const watcherStart = vi.spyOn(FileSyncWatcher.prototype, "start").mockImplementation(() => {});
    const watcherStop = vi.spyOn(FileSyncWatcher.prototype, "stop").mockImplementation(() => {});

    const { api, services } = makeApi({
      fileSync: true,
      transcriptSync: true,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    expect(service).toBeDefined();

    expect(() => service.start?.({ workspaceDir: "/tmp/workspace" })).not.toThrow();
    expect(retryStart).toHaveBeenCalledOnce();
    expect(watcherStart).toHaveBeenCalledOnce();

    expect(() => service.stop?.call(service)).not.toThrow();
    expect(watcherStop).toHaveBeenCalledOnce();
    expect(retryStop).toHaveBeenCalledOnce();

    expect(() => service.stop?.call(service)).not.toThrow();
  });

  it("service start is idempotent and does not duplicate background services", async () => {
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});
    const watcherStart = vi.spyOn(FileSyncWatcher.prototype, "start").mockImplementation(() => {});

    const { api, services } = makeApi({
      fileSync: true,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    service.start?.({ workspaceDir: "/tmp/workspace" });
    service.start?.({ workspaceDir: "/tmp/workspace" });

    expect(retryStart).toHaveBeenCalledOnce();
    expect(watcherStart).toHaveBeenCalledOnce();
  });

  it("logs warning and skips file sync when workspaceDir is missing", async () => {
    const watcherStart = vi.spyOn(FileSyncWatcher.prototype, "start").mockImplementation(() => {});
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});

    const { api, services, logger } = makeApi({
      fileSync: true,
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
    vi.restoreAllMocks();
    mockClientHealth();
    mockClientKnowledge({ total_memories: 10, total_sessions: 5, maturity: "warming" });
    vi.spyOn(RetryQueue.prototype, "stop").mockImplementation(() => {});
    vi.spyOn(CortexClient.prototype, "retrieve").mockResolvedValue({
      results: [
        { node_id: "1", type: "FACT", content: "User prefers TypeScript", score: 0.9, confidence: 0.9 },
      ],
    });

    const { api, hooks, services, logger } = makeApi({
      fileSync: false,
      recallTimeoutMs: 500,
    });

    plugin.register(api as any);
    // Bootstrap runs in start() — call it so knowledgeState.hasMemories gets set
    services[0].start?.({});
    await new Promise((r) => setTimeout(r, 50));

    await hooks.before_agent_start[0](
      { prompt: "Tell me my project preferences" },
      {},
    );

    services[0].stop?.call(services[0]);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Cortex session end — recall latency:"));
  });

  it("invalid config refuses registration", () => {
    const { api, hooks, services, logger } = makeApi({
      // baseUrl is invalid (plain http on non-localhost)
      baseUrl: "http://not-allowed.example.com",
      fileSync: false,
    });

    plugin.register(api as any);

    expect(logger.error).toHaveBeenCalledWith(
      "Cortex plugin config invalid:",
      expect.stringContaining("baseUrl"),
    );
    expect(Object.keys(hooks)).toHaveLength(0);
    expect(services).toHaveLength(0);
  });

  it("logs maturity and tier info on startup", async () => {
    vi.restoreAllMocks();
    mockClientHealth();
    mockClientKnowledge({ total_memories: 142, total_sessions: 18, maturity: "warming" });
    vi.spyOn(CortexClient.prototype, "stats").mockResolvedValue({ pipeline_tier: 2, pipeline_maturity: "warming" });

    const { api, logger, services } = makeApi({
      fileSync: false,
    });

    plugin.register(api as any);
    // Bootstrap runs in start(), not register()
    services[0].start?.({});
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.info).toHaveBeenCalledWith(
      "Cortex connected — 142 memories, 18 sessions (warming), tier 2",
    );
  });

  it("proceeds without knowledge when endpoint is unavailable", async () => {
    vi.restoreAllMocks();
    mockClientHealth();
    vi.spyOn(CortexClient.prototype, "knowledge").mockRejectedValue(new Error("Not found"));

    const { api, logger } = makeApi({
      fileSync: false,
    });

    plugin.register(api as any);
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Cortex knowledge:"),
    );
  });

  it("skips optional registrations when methods are unavailable", async () => {
    const { api } = makeApi({ fileSync: false });

    // Remove optional methods to simulate minimal runtime
    const minimalApi = {
      pluginConfig: api.pluginConfig,
      logger: api.logger,
      registerHook: api.registerHook,
      registerService: api.registerService,
      // No registerTool, registerCommand, registerGatewayMethod
    };

    plugin.register(minimalApi as any);
    await flushMicrotasks();

    // Should still register hooks and service without errors
    expect(api.registerHook).toHaveBeenCalledTimes(3);
    expect(api.registerService).toHaveBeenCalledTimes(1);
  });
});
