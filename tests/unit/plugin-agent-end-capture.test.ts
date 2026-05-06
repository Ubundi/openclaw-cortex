import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HookHandler = (...args: any[]) => any;

interface MockLogger {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeApi(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, HookHandler[]> = {};
  const services: Array<{ id: string; start?: (...args: any[]) => any; stop?: (...args: any[]) => any }> = [];
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    api: {
      pluginConfig,
      logger,
      on: vi.fn((hookName: string, handler: HookHandler) => {
        hooks[hookName] ??= [];
        hooks[hookName].push(handler);
      }),
      registerHook: vi.fn((hookName: string, handler: HookHandler) => {
        hooks[hookName] ??= [];
        hooks[hookName].push(handler);
      }),
      registerService: vi.fn((service: { id: string; start?: (...args: any[]) => any; stop?: (...args: any[]) => any }) => {
        services.push(service);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
    },
    hooks,
    services,
  };
}

describe("plugin agent_end capture scheduling", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    process.argv = ["node", "cortex"];
    process.env.CORTEX_API_KEY = "test-key";
  });

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env.CORTEX_API_KEY;
    vi.restoreAllMocks();
  });

  it("does not await slow capture work before agent_end completes", async () => {
    let releaseCapture!: () => void;
    const bridgeHandleAgentEnd = vi.fn().mockResolvedValue(true);
    const captureHandler = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      return true;
    });

    vi.doMock("../../src/features/capture/handler.js", () => ({
      createCaptureHandler: vi.fn(() => captureHandler),
    }));
    vi.doMock("../../src/features/bridge/handler.js", () => ({
      createBridgeHandler: vi.fn(() => ({
        shouldInjectPrompt: vi.fn().mockResolvedValue(false),
        refreshLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
        handleAgentEnd: bridgeHandleAgentEnd,
      })),
    }));
    vi.doMock("../../src/features/recall/handler.js", () => ({
      createRecallHandler: vi.fn(() => vi.fn(async () => undefined)),
    }));

    const [{ default: plugin }, { SessionStateStore }] = await Promise.all([
      import("../../src/plugin/index.js"),
      import("../../src/internal/session-state.js"),
    ]);
    vi.spyOn(SessionStateStore.prototype, "markDirty").mockResolvedValue();

    const { api, hooks } = makeApi({ userId: "agent-user-1" });
    plugin.register(api as any);

    let completed = false;
    const agentEndPromise = hooks.agent_end[0]({
      messages: [
        { role: "user", content: "Tell me what matters for deployment safety in this service." },
        { role: "assistant", content: "Start with health checks, rollback safety, and low-risk traffic shifting." },
      ],
      aborted: false,
      sessionKey: "sess-nonblocking",
    }).then(() => {
      completed = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(captureHandler).toHaveBeenCalledTimes(1);
    expect(bridgeHandleAgentEnd).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(completed).toBe(true));

    releaseCapture();
    await agentEndPromise;
  });

  it("waits for pending capture work before service stop completes", async () => {
    let releaseIdle!: () => void;
    const waitForIdle = vi.fn(() => new Promise<void>((resolve) => {
      releaseIdle = resolve;
    }));
    const captureHandler = Object.assign(
      vi.fn(async () => true),
      { waitForIdle },
    );

    vi.doMock("../../src/features/capture/handler.js", () => ({
      createCaptureHandler: vi.fn(() => captureHandler),
    }));
    vi.doMock("../../src/features/bridge/handler.js", () => ({
      createBridgeHandler: vi.fn(() => ({
        shouldInjectPrompt: vi.fn().mockResolvedValue(false),
        refreshLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
        handleAgentEnd: vi.fn().mockResolvedValue(true),
      })),
    }));
    vi.doMock("../../src/features/recall/handler.js", () => ({
      createRecallHandler: vi.fn(() => vi.fn(async () => undefined)),
    }));

    const [{ default: plugin }, { RetryQueue }] = await Promise.all([
      import("../../src/plugin/index.js"),
      import("../../src/internal/retry-queue.js"),
    ]);
    const retryStop = vi.spyOn(RetryQueue.prototype, "stop").mockImplementation(() => {});

    const { api, services } = makeApi({ userId: "agent-user-1" });
    plugin.register(api as any);

    const service = services[0];
    expect(service).toBeDefined();

    service.start?.({ workspaceDir: "/tmp/workspace" });
    const stopPromise = service.stop?.call(service);

    await Promise.resolve();

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(retryStop).not.toHaveBeenCalled();

    releaseIdle();
    await stopPromise;

    expect(retryStop).toHaveBeenCalledTimes(1);
  });
});
