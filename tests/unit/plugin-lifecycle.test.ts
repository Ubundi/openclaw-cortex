import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../src/plugin/index.js";
import { CortexClient } from "../../src/cortex/client.js";
import { RetryQueue } from "../../src/internal/retry-queue.js";
import { SessionStateStore } from "../../src/internal/session-state.js";

// Mock fs at module level so ensureToolsAllowlist can be tested
const mockReadFileSync = vi.fn<typeof import("node:fs").readFileSync>();
const mockWriteFileSync = vi.fn<typeof import("node:fs").writeFileSync>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: any[]) => mockReadFileSync(...args as [any]),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args as [any, any]),
  };
});

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
  registerCli: ReturnType<typeof vi.fn>;
}

interface CliNode {
  name: string;
  descriptionText?: string;
  actionHandler?: (...args: any[]) => any;
  children: Map<string, CliNode>;
}

function createCliNode(name: string): CliNode & {
  description(desc: string): any;
  command(childName: string): any;
  argument(_name: string, _desc: string): any;
  option(_flags: string, _desc: string, _defaultValue?: string): any;
  action(fn: (...args: any[]) => any): any;
} {
  const commandApi: CliNode & {
    description(desc: string): any;
    command(childName: string): any;
    argument(_name: string, _desc: string): any;
    option(_flags: string, _desc: string, _defaultValue?: string): any;
    action(fn: (...args: any[]) => any): any;
  } = {
    name,
    children: new Map(),
    description(desc: string) {
      commandApi.descriptionText = desc;
      return commandApi;
    },
    command(childName: string) {
      const child = createCliNode(childName);
      commandApi.children.set(childName, child);
      return child;
    },
    argument(_name: string, _desc: string) {
      return commandApi;
    },
    option(_flags: string, _desc: string, _defaultValue?: string) {
      return commandApi;
    },
    action(fn: (...args: any[]) => any) {
      commandApi.actionHandler = fn;
      return commandApi;
    },
  };

  return commandApi;
}

function makeApi(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, HookHandler[]> = {};
  const services: Array<{ id: string; start?: (ctx: { workspaceDir?: string }) => void; stop?: () => void }> = [];
  const tools: Array<{ name: string; description: string; parameters: unknown; execute: Function }> = [];
  const commands: Array<{ name: string; description: string; handler: Function }> = [];
  const rpcMethods: Record<string, Function> = {};
  const cliRegistrars: Array<{ registrar: Function; opts?: { commands?: string[] } }> = [];
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
    registerCli: vi.fn((registrar: Function, opts?: { commands?: string[] }) => {
      cliRegistrars.push({ registrar, opts });
    }),
  };

  return { api, hooks, services, tools, commands, rpcMethods, cliRegistrars, logger };
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
    // Provide a test API key so the plugin doesn't bail during registration
    process.env.CORTEX_API_KEY = "test-key";
    mockClientHealth();
    mockClientKnowledge();
    vi.spyOn(CortexClient.prototype, "stats").mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" });
    // Default: ensureToolsAllowlist silently skips (no config file found)
    mockReadFileSync.mockImplementation((...args: any[]) => {
      const path = String(args[0]);
      if (path.includes("openclaw.json")) throw new Error("ENOENT");
      // Fall through to actual fs for other reads (e.g. package.json)
      const actual = vi.importActual<typeof import("node:fs")>("node:fs");
      return (actual as any).readFileSync(...args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CORTEX_API_KEY;
    process.exitCode = undefined;
  });

  it("register wires hooks and service via api.on", async () => {
    const { api, hooks, services } = makeApi({});

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
      "before_message_write",
      expect.any(Function),
    );
    expect(hooks.before_agent_start).toHaveLength(1);
    expect(hooks.agent_end).toHaveLength(1);
    expect(hooks.before_message_write).toHaveLength(1);
    expect(hooks["gateway:heartbeat"]).toBeUndefined();

    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(services[0]?.id).toBe("cortex-services");
  });

  it("falls back to registerHook when api.on is not available", async () => {
    const { api, hooks } = makeApi({});

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
      "before_message_write",
      expect.any(Function),
      { name: "openclaw-cortex.sanitize", description: expect.any(String) },
    );
    expect(hooks.before_agent_start).toHaveLength(1);
    expect(hooks.agent_end).toHaveLength(1);
    expect(hooks.before_message_write).toHaveLength(1);
    expect(hooks["gateway:heartbeat"]).toBeUndefined();
  });

  it("starts a service-owned heartbeat timer instead of registering a gateway heartbeat hook", async () => {
    const { api, services } = makeApi({});
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    plugin.register(api as any);
    services[0].start?.({});

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(api.on).not.toHaveBeenCalledWith(
      "gateway:heartbeat",
      expect.any(Function),
    );
    expect(api.registerHook).not.toHaveBeenCalledWith(
      "gateway:heartbeat",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("sanitizes transcript content through before_message_write", async () => {
    const { api, hooks } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();

    const result = hooks.before_message_write[0]({
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "[Thu 2026-03-19 09:28 UTC] conversation info:",
              "```json",
              '{"chatId":"abc123","sender":"benchmark","timestamp":"2026-03-19T09:30:00Z"}',
              "```",
              "",
              "[telegram group chat]",
              "RPCSAN-20260319 durable business fact goes here.",
            ].join("\n"),
          },
        ],
      },
    });

    expect(result).toEqual({
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "RPCSAN-20260319 durable business fact goes here.",
          },
        ],
      },
    });
  });

  it("registers agent tools", async () => {
    const { api, tools } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();

    expect(api.registerTool).toHaveBeenCalledTimes(5);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("cortex_search_memory");
    expect(toolNames).toContain("cortex_get_memory");
    expect(toolNames).toContain("cortex_save_memory");
    expect(toolNames).toContain("cortex_forget");
    expect(toolNames).toContain("cortex_set_session_goal");
  });

  it("falls back to async ingest when cortex_save_memory sync remember fails", async () => {
    vi.spyOn(CortexClient.prototype, "remember").mockRejectedValue(
      new Error("Cortex remember failed: 500 — {\"detail\":\"Internal server error\"}"),
    );
    vi.spyOn(CortexClient.prototype, "submitIngest").mockResolvedValue({
      job_id: "job-123",
      status: "pending",
    });
    vi.spyOn(CortexClient.prototype, "getJob").mockResolvedValue({
      job_id: "job-123",
      status: "pending",
    });

    const { api, tools } = makeApi({
      toolTimeoutMs: 1000,
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const saveTool = tools.find((t) => t.name === "cortex_save_memory");
    expect(saveTool).toBeDefined();

    const result = await saveTool!.execute("tool-1", { text: "User prefers dark mode interfaces." });
    const responseText = result.content[0]?.text ?? "";

    expect(responseText).toContain("Memory save queued (job job-123");
    expect(responseText).toContain("not confirmed");
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
    expect(CortexClient.prototype.getJob).toHaveBeenCalledWith("job-123");
  });

  it("registers auto-reply command", async () => {
    const { api, commands } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();

    expect(api.registerCommand).toHaveBeenCalledTimes(3);
    expect(commands[0]?.name).toBe("audit");
    expect(commands[1]?.name).toBe("checkpoint");
    expect(commands[2]?.name).toBe("sleep");
  });

  it("sleep command clears dirty session state", async () => {
    const clearSpy = vi.spyOn(SessionStateStore.prototype, "clear").mockResolvedValue();
    const { api, commands } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();

    const sleep = commands.find((c) => c.name === "sleep");
    expect(sleep).toBeDefined();

    const result = await sleep!.handler({});
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(result.text).toContain("clean");
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

    const { api, hooks } = makeApi({});
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

  it("adds linked TooToo guidance before turns and submits bridge Q&A after a qualifying exchange", async () => {
    vi.spyOn(CortexClient.prototype, "getLinkStatus").mockResolvedValue({
      linked: true,
      link: {
        tootoo_user_id: "tt-user-1",
        linked_at: "2026-03-01T10:00:00Z",
      },
    });
    const submitBridgeQA = vi.spyOn(CortexClient.prototype, "submitBridgeQA").mockResolvedValue({
      accepted: true,
      forwarded: true,
      queued_for_retry: false,
      entries_sent: 1,
      tootoo_user_id: "tt-user-1",
      bridge_event_id: "bridge-event-1",
      suggestions_created: 2,
    });

    const { api, hooks } = makeApi({
      userId: "agent-user-1",
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const beforeTurn = await hooks.before_agent_start[0](
      {
        prompt: "I've been rethinking what kind of work I want this year.",
        messages: [
          {
            role: "user",
            content: "I've been rethinking what kind of work I want this year and what would actually feel meaningful.",
            provenance: { kind: "external_user" },
          },
        ],
      },
      { sessionKey: "sess-bridge" },
    );

    expect(beforeTurn?.prependContext).toContain("<tootoo_bridge>");

    await hooks.agent_end[0]({
      messages: [
        { role: "user", content: "I want my work to feel more aligned this year." },
        { role: "assistant", content: "That sounds important. What do you value most in your work?" },
        { role: "user", content: "Autonomy and creative freedom." },
        { role: "assistant", content: "That gives us a strong anchor for future decisions." },
      ],
      aborted: false,
      sessionKey: "sess-bridge",
    });

    await vi.waitFor(() => expect(submitBridgeQA).toHaveBeenCalledTimes(1));
    expect(submitBridgeQA).toHaveBeenCalledWith({
      user_id: "agent-user-1",
      request_id: expect.stringMatching(/^openclaw-bridge-/),
      entries: [
        {
          question: "What do you value most in your work?",
          answer: "Autonomy and creative freedom.",
          target_section: "coreValues",
        },
      ],
    });
  });

  it("does not inject bridge guidance for technical turns even when linked", async () => {
    vi.spyOn(SessionStateStore.prototype, "readDirtyFromPriorLifecycle").mockResolvedValue(null);
    vi.spyOn(CortexClient.prototype, "getLinkStatus").mockResolvedValue({
      linked: true,
      link: {
        tootoo_user_id: "tt-user-1",
        linked_at: "2026-03-01T10:00:00Z",
      },
    });

    const { api, hooks } = makeApi({
      userId: "agent-user-1",
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const beforeTurn = await hooks.before_agent_start[0](
      {
        prompt: "Fix the Redis cache TTL bug and add a regression test.",
        messages: [
          {
            role: "user",
            content: "Fix the Redis cache TTL bug in the worker and add a regression test for it.",
            provenance: { kind: "external_user" },
          },
        ],
      },
      { sessionKey: "sess-technical" },
    );

    expect(beforeTurn).toBeUndefined();
  });

  it("leaves unlinked users unchanged for bridge behavior", async () => {
    vi.spyOn(SessionStateStore.prototype, "readDirtyFromPriorLifecycle").mockResolvedValue(null);
    vi.spyOn(CortexClient.prototype, "getLinkStatus").mockResolvedValue({ linked: false });
    const submitBridgeQA = vi.spyOn(CortexClient.prototype, "submitBridgeQA").mockResolvedValue({
      accepted: true,
      forwarded: true,
      queued_for_retry: false,
      entries_sent: 1,
      tootoo_user_id: "tt-user-1",
      bridge_event_id: "bridge-event-1",
      suggestions_created: 2,
    });

    const { api, hooks } = makeApi({
      userId: "agent-user-1",
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const beforeTurn = await hooks.before_agent_start[0](
      { prompt: "keep going with this conversation" },
      { sessionKey: "sess-unlinked" },
    );

    expect(beforeTurn).toBeUndefined();

    await hooks.agent_end[0]({
      messages: [
        { role: "assistant", content: "What do you value most in your work?" },
        { role: "user", content: "Autonomy and creative freedom." },
        { role: "assistant", content: "That helps a lot." },
      ],
      aborted: false,
      sessionKey: "sess-unlinked",
    });

    expect(submitBridgeQA).not.toHaveBeenCalled();
  });

  it("does not inject bridge guidance for heartbeat or synthetic user turns", async () => {
    vi.spyOn(SessionStateStore.prototype, "readDirtyFromPriorLifecycle").mockResolvedValue(null);
    vi.spyOn(CortexClient.prototype, "getLinkStatus").mockResolvedValue({
      linked: true,
      link: {
        tootoo_user_id: "tt-user-1",
        linked_at: "2026-03-01T10:00:00Z",
      },
    });

    const { api, hooks } = makeApi({
      userId: "agent-user-1",
    });

    plugin.register(api as any);
    await flushMicrotasks();

    const heartbeatTurn = await hooks.before_agent_start[0](
      {
        prompt: "HEARTBEAT_OK - if nothing needs attention, reply with a short status only.",
        messages: [
          {
            role: "user",
            content: "HEARTBEAT_OK - if nothing needs attention, reply with a short status only.",
            provenance: { kind: "external_user" },
          },
        ],
      },
      { sessionKey: "sess-heartbeat" },
    );
    expect(heartbeatTurn).toBeUndefined();

    const syntheticTurn = await hooks.before_agent_start[0](
      {
        prompt: "system-routed turn",
        messages: [
          {
            role: "user",
            content: "Synthetic routing hint",
            provenance: { kind: "internal_system" },
          },
        ],
      },
      { sessionKey: "sess-synthetic" },
    );
    expect(syntheticTurn).toBeUndefined();
  });

  it("registers Gateway RPC method", async () => {
    const { api, rpcMethods } = makeApi({});

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
    expect(rpcResponse).toHaveProperty("writeHealth");
    expect(rpcResponse).toHaveProperty("config");
  });

  it("service start/stop initializes retry queue", async () => {
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});
    const retryStop = vi.spyOn(RetryQueue.prototype, "stop").mockImplementation(() => {});

    const { api, services } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    expect(service).toBeDefined();

    expect(() => service.start?.({ workspaceDir: "/tmp/workspace" })).not.toThrow();
    expect(retryStart).toHaveBeenCalledOnce();

    await expect(service.stop?.call(service)).resolves.toBeUndefined();
    expect(retryStop).toHaveBeenCalledOnce();

    await expect(service.stop?.call(service)).resolves.toBeUndefined();
  });

  it("service start is idempotent and does not duplicate background services", async () => {
    const retryStart = vi.spyOn(RetryQueue.prototype, "start").mockImplementation(() => {});

    const { api, services } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();

    const service = services[0];
    service.start?.({ workspaceDir: "/tmp/workspace" });
    service.start?.({ workspaceDir: "/tmp/workspace" });

    expect(retryStart).toHaveBeenCalledOnce();
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
      autoRecall: true,
      configVersion: 2,
      recallTimeoutMs: 500,
      userId: "user-1",
    });

    plugin.register(api as any);
    // Bootstrap runs in start() — call it so knowledgeState.hasMemories gets set
    services[0].start?.({});
    await new Promise((r) => setTimeout(r, 50));

    await hooks.before_agent_start[0](
      { prompt: "Tell me my project preferences" },
      {},
    );

    await services[0].stop?.call(services[0]);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Cortex session end — recall latency:"));
  });

  it("invalid config refuses registration", () => {
    const { api, hooks, services, logger } = makeApi({
      // baseUrl is invalid (plain http on non-localhost)
      baseUrl: "http://not-allowed.example.com",
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

    const { api, logger, services } = makeApi({ userId: "agent-user-1" });

    plugin.register(api as any);
    // Bootstrap runs in start(), not register()
    services[0].start?.({});
    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        "Cortex connected — 142 memories, 18 sessions (warming), tier 2",
      );
    });
  });

  it("does not log offline when the first startup health probe fails but retry succeeds", async () => {
    vi.restoreAllMocks();
    vi.spyOn(CortexClient.prototype, "healthCheck")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockClientKnowledge({ total_memories: 2616, total_sessions: 24, maturity: "mature" });
    vi.spyOn(CortexClient.prototype, "stats").mockResolvedValue({ pipeline_tier: 3, pipeline_maturity: "mature" });

    const { api, logger } = makeApi({ userId: "agent-user-1" });

    plugin.register(api as any);

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        "Cortex connected — 2,616 memories, 24 sessions (mature), tier 3",
      );
    });

    expect(logger.info).not.toHaveBeenCalledWith("Cortex offline — API unreachable");
  });

  it("suppresses offline when /health fails but knowledge endpoint is still reachable", async () => {
    vi.restoreAllMocks();
    vi.spyOn(CortexClient.prototype, "healthCheck").mockResolvedValue(false);
    mockClientKnowledge({ total_memories: 2616, total_sessions: 24, maturity: "mature" });
    vi.spyOn(CortexClient.prototype, "stats").mockResolvedValue({ pipeline_tier: 3, pipeline_maturity: "mature" });

    const { api, logger } = makeApi({ userId: "agent-user-1" });

    plugin.register(api as any);

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        "Cortex connected — 2,616 memories, 24 sessions (mature), tier 3",
      );
    });

    expect(logger.info).not.toHaveBeenCalledWith("Cortex offline — API unreachable");
    expect(logger.debug).toHaveBeenCalledWith(
      "Cortex startup: /health probe failed but knowledge endpoint succeeded",
    );
  });

  it("logs offline when both health probes and startup knowledge fallback fail", async () => {
    vi.restoreAllMocks();
    vi.spyOn(CortexClient.prototype, "healthCheck").mockResolvedValue(false);
    vi.spyOn(CortexClient.prototype, "knowledge").mockRejectedValue(new Error("unreachable"));

    const { api, logger } = makeApi({ userId: "agent-user-1" });

    plugin.register(api as any);

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith("Cortex offline — API unreachable");
    });

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("Cortex connected —"));
    expect(CortexClient.prototype.healthCheck).toHaveBeenCalledTimes(2);
  });

  it("proceeds without knowledge when endpoint is unavailable", async () => {
    vi.restoreAllMocks();
    mockClientHealth();
    vi.spyOn(CortexClient.prototype, "knowledge").mockRejectedValue(new Error("Not found"));

    const { api, logger } = makeApi({});

    plugin.register(api as any);
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Cortex knowledge:"),
    );
  });

  it("skips optional registrations when methods are unavailable", async () => {
    const { api } = makeApi({});

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

  it("treats AbortError as success when reset already emptied knowledge", async () => {
    vi.spyOn(CortexClient.prototype, "healthCheck").mockResolvedValue(false);
    vi.spyOn(CortexClient.prototype, "forgetUser").mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.spyOn(CortexClient.prototype, "knowledge")
      .mockResolvedValueOnce({
        total_memories: 45,
        total_sessions: 7,
        maturity: "warming",
        entities: [],
      })
      .mockResolvedValue({
        total_memories: 0,
        total_sessions: 0,
        maturity: "cold",
        entities: [],
      });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { api, cliRegistrars } = makeApi({});
    plugin.register(api as any);
    await new Promise((r) => setTimeout(r, 20));

    const program = createCliNode("root");
    cliRegistrars[0]!.registrar({ program, config: {}, logger: api.logger });
    const reset = program.children.get("cortex")?.children.get("reset");

    await reset?.actionHandler?.({ yes: true });

    expect(CortexClient.prototype.forgetUser).toHaveBeenCalledOnce();
    expect(CortexClient.prototype.knowledge).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("  Memory reset complete.");
    expect(logSpy).toHaveBeenCalledWith(
      "  The server finished the reset, but the response timed out before deletion stats were returned.",
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Reset failed:"));
    expect(process.exitCode).toBeUndefined();
  });

  it("still reports reset failure when AbortError occurs and knowledge is not empty", async () => {
    vi.spyOn(CortexClient.prototype, "healthCheck").mockResolvedValue(false);
    vi.spyOn(CortexClient.prototype, "forgetUser").mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.spyOn(CortexClient.prototype, "knowledge").mockResolvedValue({
      total_memories: 3,
      total_sessions: 1,
      maturity: "warming",
      entities: [],
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { api, cliRegistrars } = makeApi({});
    plugin.register(api as any);
    await new Promise((r) => setTimeout(r, 20));

    const program = createCliNode("root");
    cliRegistrars[0]!.registrar({ program, config: {}, logger: api.logger });
    const reset = program.children.get("cortex")?.children.get("reset");

    await reset?.actionHandler?.({ yes: true });

    expect(errorSpy).toHaveBeenCalledWith("\n  Reset failed: AbortError: aborted");
    expect(process.exitCode).toBe(1);
  });

  describe("config migration", () => {
    it("flips autoRecall true → false and persists configVersion for legacy configs", async () => {
      const fileConfig = {
        plugins: { allow: ["openclaw-cortex"], entries: { "openclaw-cortex": { enabled: true, config: { autoRecall: true } } } },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(fileConfig));

      const { api, logger } = makeApi({ autoRecall: true });
      plugin.register(api as any);

      // Should log the migration message
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("autoRecall changed from true → false"),
      );

      // Should persist updated config to openclaw.json
      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      expect(configWrites.length).toBeGreaterThanOrEqual(1);
      const written = JSON.parse(configWrites[0][1] as string);
      expect(written.plugins.entries["openclaw-cortex"].config.autoRecall).toBe(false);
      expect(written.plugins.entries["openclaw-cortex"].config.configVersion).toBe(2);
    });

    it("preserves autoRecall true when configVersion is already current", async () => {
      const fileConfig = {
        plugins: { allow: ["openclaw-cortex"], entries: { "openclaw-cortex": { enabled: true, config: { autoRecall: true, configVersion: 2 } } } },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(fileConfig));

      const { api, hooks, logger } = makeApi({ autoRecall: true, configVersion: 2 });
      plugin.register(api as any);

      // Should NOT log migration message
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("autoRecall changed from true → false"),
      );

      // autoRecall should still be true in the before_agent_start hook behavior
      // (the hook exists, meaning config was accepted with autoRecall: true)
      expect(hooks.before_agent_start).toHaveLength(1);
    });

    it("advances configVersion for fresh installs without triggering autoRecall flip", async () => {
      const fileConfig = {
        plugins: { allow: ["openclaw-cortex"], entries: { "openclaw-cortex": { enabled: true, config: {} } } },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(fileConfig));

      const { api, logger } = makeApi({});
      plugin.register(api as any);

      // Should NOT log autoRecall migration (it was already false/absent)
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("autoRecall changed from true → false"),
      );

      // Should still persist the configVersion bump so future opt-ins are safe
      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      expect(configWrites.length).toBeGreaterThanOrEqual(1);
      const written = JSON.parse(configWrites[0][1] as string);
      expect(written.plugins.entries["openclaw-cortex"].config.configVersion).toBe(2);
    });

    it("is idempotent — second run with configVersion 2 does not write", async () => {
      const fileConfig = {
        plugins: { allow: ["openclaw-cortex"], entries: { "openclaw-cortex": { enabled: true, config: { configVersion: 2 } } } },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(fileConfig));

      const { api } = makeApi({ configVersion: 2 });
      plugin.register(api as any);

      // No openclaw.json writes (plugins.allow already present, no tools profile, migration already done)
      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      expect(configWrites).toHaveLength(0);
    });
  });

  describe("tools.alsoAllow auto-patch", () => {
    it("adds cortex tools to alsoAllow when profile is set and tools are missing", async () => {
      const config = {
        tools: { profile: "coding" },
        plugins: { entries: { "openclaw-cortex": { enabled: true } } },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(config));

      const { api } = makeApi({});
      plugin.register(api as any);

      // Filter out session stats writes (to cortex-session-stats.json)
      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      // Two writes: one for plugins.allow, one for tools.alsoAllow
      expect(configWrites.length).toBeGreaterThanOrEqual(1);
      const lastWrite = JSON.parse(configWrites[configWrites.length - 1][1] as string);
      expect(lastWrite.tools.alsoAllow).toEqual([
        "cortex_search_memory",
        "cortex_get_memory",
        "cortex_save_memory",
        "cortex_forget",
        "cortex_set_session_goal",
      ]);
      expect(api.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('enabled memory tools for "coding" profile'),
      );
    });

    it("skips tools patching when no tools profile is set", async () => {
      const config = {
        tools: {},
        plugins: { allow: ["openclaw-cortex"], entries: { "openclaw-cortex": { enabled: true, config: { configVersion: 2 } } } },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(config));

      const { api } = makeApi({ configVersion: 2 });
      plugin.register(api as any);

      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      expect(configWrites).toHaveLength(0);
    });

    it("skips patching when cortex tools and plugin are already allowed", async () => {
      const config = {
        tools: {
          profile: "coding",
          alsoAllow: ["cortex_search_memory", "cortex_get_memory", "cortex_save_memory", "cortex_forget", "cortex_set_session_goal"],
        },
        plugins: { allow: ["openclaw-cortex"] },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(config));

      const { api } = makeApi({});
      plugin.register(api as any);

      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      expect(configWrites).toHaveLength(0);
    });

    it("preserves existing alsoAllow entries when adding cortex tools", async () => {
      const config = {
        tools: {
          profile: "coding",
          alsoAllow: ["some_other_tool"],
        },
        plugins: { allow: ["openclaw-cortex"] },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(config));

      const { api } = makeApi({});
      plugin.register(api as any);

      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      const written = JSON.parse(configWrites[0][1] as string);
      expect(written.tools.alsoAllow).toEqual([
        "some_other_tool",
        "cortex_search_memory",
        "cortex_get_memory",
        "cortex_save_memory",
        "cortex_forget",
        "cortex_set_session_goal",
      ]);
    });

    it("handles config file read errors gracefully with actionable warning", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const { api } = makeApi({});
      // Should not throw
      plugin.register(api as any);

      const configWrites = mockWriteFileSync.mock.calls.filter(
        (c) => String(c[0]).includes("openclaw.json"),
      );
      expect(configWrites).toHaveLength(0);
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("tools.alsoAllow"),
      );
    });
  });
});
