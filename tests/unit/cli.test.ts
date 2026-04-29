import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCliCommands, type SessionStats } from "../../src/plugin/cli.js";
import type { CliProgram } from "../../src/plugin/types.js";

interface CliNode {
  name: string;
  descriptionText?: string;
  actionHandler?: (...args: any[]) => any;
  children: Map<string, CliNode>;
}

function createCliNode(name: string): CliNode & {
  description(desc: string): CliNode;
  command(childName: string): CliNode;
  argument(_name: string, _desc: string): CliNode;
  option(_flags: string, _desc: string, _defaultValue?: string): CliNode;
  action(fn: (...args: any[]) => any): CliNode;
} {
  const commandApi: CliNode & {
    description(desc: string): CliNode;
    command(childName: string): CliNode;
    argument(_name: string, _desc: string): CliNode;
    option(_flags: string, _desc: string, _defaultValue?: string): CliNode;
    action(fn: (...args: any[]) => any): CliNode;
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
    argument() {
      return commandApi;
    },
    option() {
      return commandApi;
    },
    action(fn: (...args: any[]) => any) {
      commandApi.actionHandler = fn;
      return commandApi;
    },
  };

  return commandApi;
}

function makeSessionStats(): SessionStats {
  return {
    saves: 0,
    savesSkippedDedupe: 0,
    savesSkippedNovelty: 0,
    searches: 0,
    recallCount: 0,
    recallMemoriesTotal: 0,
    recallDuplicatesCollapsed: 0,
  };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe("registerCliCommands search output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  it("prints relevance when present instead of confidence", async () => {
    const registerCli = vi.fn();
    const recall = vi.fn().mockResolvedValue({
      memories: [
        {
          content: "Project uses PostgreSQL",
          confidence: 1,
          relevance: 0.43,
          when: null,
          session_id: null,
          entities: ["PostgreSQL"],
        },
      ],
    });

    registerCliCommands(registerCli, {
      client: { recall } as any,
      config: { toolTimeoutMs: 500 } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("search")?.actionHandler?.(["what", "database"], {
      limit: "10",
      mode: "all",
    });

    expect(recall).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith("1. [0.43] Project uses PostgreSQL");
    expect(logSpy).not.toHaveBeenCalledWith("1. [1.00] Project uses PostgreSQL");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("filters low-score tail results for broad searches", async () => {
    const registerCli = vi.fn();
    const recall = vi.fn().mockResolvedValue({
      memories: [
        {
          content: "User uses Neovim",
          confidence: 0.74,
          relevance: 0.74,
          when: null,
          session_id: null,
          entities: ["Neovim"],
        },
        {
          content: "Weak unrelated tail",
          confidence: 0.12,
          relevance: 0.12,
          when: null,
          session_id: null,
          entities: [],
        },
      ],
    });

    registerCliCommands(registerCli, {
      client: { recall } as any,
      config: { toolTimeoutMs: 500 } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("search")?.actionHandler?.(["what", "editor"], {
      limit: "10",
      mode: "all",
    });

    expect(logSpy).toHaveBeenCalledWith("Found 1 memories (mode: all):\n");
    expect(logSpy).toHaveBeenCalledWith("1. [0.74] User uses Neovim");
    expect(logSpy).not.toHaveBeenCalledWith("2. [0.12] Weak unrelated tail");
  });

  it("uses knowledge fallback when /health probe fails during status checks", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(false),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 53,
        total_sessions: 6,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.();

    expect(client.healthCheck).toHaveBeenCalledOnce();
    expect(client.knowledge).toHaveBeenCalledTimes(1);
    expect(client.knowledge).toHaveBeenCalledWith("user-1", 8000);
    expect(client.getLinkStatus).toHaveBeenCalledWith("user-1", 5000);
    expect(client.recall).toHaveBeenCalledOnce();
    expect(client.retrieve).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("API Health:     OK (fallback via /v1/knowledge)"));
    expect(logSpy).not.toHaveBeenCalledWith("\nAPI is unreachable. Check baseUrl and network connectivity.");
  });

  it("reports linked status when owner metadata is present without legacy link details", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({
        linked: true,
        owner_type: "shadow_subject",
        owner_id: "owner-shadow-1",
        shadow_subject_id: "shadow-subject-1",
        claimed_user_id: null,
        tootoo_user_id: null,
      }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 4,
        total_sessions: 1,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.();

    expect(client.getLinkStatus).toHaveBeenCalledWith("user-1", 5000);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("TooToo Link:    ✓ Linked"));
    expect(logSpy).not.toHaveBeenCalledWith("  TooToo Link:    Not linked. Run `openclaw cortex pair` to connect.");
  });

  it("keeps human-readable status output by default", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 3,
        total_sessions: 1,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.();

    expect(logSpy).toHaveBeenCalledWith("Cortex Status Check");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("TooToo Link:    Not linked"));
  });

  it("returns JSON status when the user ID is unavailable", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn(),
      getLinkStatus: vi.fn(),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => undefined,
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: false,
      agent_user_id: null,
      status: "user_id_unavailable",
      detail: {
        api_health: "not_checked",
        link_status: "unavailable",
      },
    });
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.getLinkStatus).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("returns JSON when user ID readiness never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn(),
      getLinkStatus: vi.fn(),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => undefined,
      userIdReady: new Promise<void>(() => {}),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    await flushMicrotasks();
    expect(logSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await actionPromise;

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: false,
      agent_user_id: null,
      status: "user_id_unavailable",
      detail: {
        api_health: "not_checked",
        user_id_ready_latency_ms: 5_000,
        user_id_ready_timeout_ms: 5_000,
        link_status: "unavailable",
      },
    });
    expect(payload.detail.user_id_ready_error).toContain("timed out");
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.getLinkStatus).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("returns JSON status for shadow-owner links with null tootoo_user_id", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({
        linked: true,
        link: {
          owner_type: "shadow_subject",
          owner_id: "owner-shadow-1",
          shadow_subject_id: "shadow-subject-1",
          claimed_user_id: null,
          tootoo_user_id: null,
          linked_at: "2026-04-24T09:00:00Z",
        },
      }),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-shadow",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: true,
      agent_user_id: "agent-user-shadow",
      tootoo_user_id: null,
      owner_type: "shadow_subject",
      owner_id: "owner-shadow-1",
      shadow_subject_id: "shadow-subject-1",
      claimed_user_id: null,
      linked_at: "2026-04-24T09:00:00Z",
      status: "ok",
    });
    expect(payload.detail.api_health).toBe("ok");
    expect(client.knowledge).not.toHaveBeenCalled();
    expect(client.stats).not.toHaveBeenCalled();
    expect(client.recall).not.toHaveBeenCalled();
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("includes plugin discovery diagnostics in JSON status output", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-discovery",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      pluginDiscovery: {
        configured_plugin_id: "openclaw-cortex",
        config_path: "/home/test/.openclaw/openclaw.json",
        config_references_plugin: true,
        allowlist_includes_plugin: true,
        package_found: false,
        expected_install_paths: ["/home/test/.openclaw/extensions/openclaw-cortex"],
        detected_extension_dirs: [{ path: "/home/test/.openclaw/extensions", exists: true, entries: ["openclaw-memory"] }],
        installed_package_version: null,
        package_json_path: null,
        warnings: ["openclaw-cortex is configured but no package.json was found in expected extension paths"],
      },
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload.detail.plugin_discovery).toMatchObject({
      configured_plugin_id: "openclaw-cortex",
      config_references_plugin: true,
      allowlist_includes_plugin: true,
      package_found: false,
      installed_package_version: null,
    });
    expect(payload.detail.plugin_discovery.detected_extension_dirs[0]).toMatchObject({
      exists: true,
      entries: ["openclaw-memory"],
    });
  });

  it("includes JSON timing breakdown for slow health fallback and link status", async () => {
    const registerCli = vi.fn();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let resolveUserIdReady!: () => void;
    const userIdReady = new Promise<void>((resolve) => {
      resolveUserIdReady = resolve;
    });
    const client = {
      healthCheck: vi.fn().mockImplementation(async () => {
        now += 3_000;
        return false;
      }),
      getLinkStatus: vi.fn().mockImplementation(async () => {
        now += 2_000;
        return {
          linked: true,
          link: {
            owner_type: "shadow_subject",
            owner_id: "owner-shadow-1",
            shadow_subject_id: "shadow-subject-1",
            claimed_user_id: null,
            tootoo_user_id: null,
            linked_at: "2026-04-24T09:00:00Z",
          },
        };
      }),
      knowledge: vi.fn().mockImplementation(async () => {
        now += 3_000;
        return {
          total_memories: 53,
          total_sessions: 6,
          maturity: "cold",
          entities: [],
        };
      }),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-shadow",
      userIdReady,
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });
    await flushMicrotasks();
    now += 37;
    resolveUserIdReady();
    await actionPromise;

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload.detail).toMatchObject({
      api_health: "ok",
      used_knowledge_fallback: true,
      user_id_ready_latency_ms: 37,
      health_latency_ms: 6_000,
      health_probe_latency_ms: 3_000,
      knowledge_fallback_latency_ms: 3_000,
      link_latency_ms: 2_000,
      total_wall_time_ms: 8_037,
      health_timeout_ms: 5_000,
      knowledge_fallback_timeout_ms: 8_000,
      link_timeout_ms: 5_000,
    });
    expect(payload.detail.timing).toBeUndefined();
    expect(client.stats).not.toHaveBeenCalled();
    expect(client.recall).not.toHaveBeenCalled();
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("returns JSON promptly when the health check never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockReturnValue(new Promise<boolean>(() => {})),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 53,
        total_sessions: 6,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-health-timeout",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    await flushMicrotasks();
    expect(logSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await actionPromise;

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: false,
      agent_user_id: "agent-user-health-timeout",
      status: "ok",
      detail: {
        api_health: "ok",
        used_knowledge_fallback: true,
        health_probe_latency_ms: 5_000,
        knowledge_fallback_latency_ms: 0,
        link_status: "ok",
      },
    });
    expect(payload.detail.health_error).toContain("timed out");
    expect(payload.detail.total_wall_time_ms).toBe(5_000);
    expect(client.knowledge).toHaveBeenCalledWith("agent-user-health-timeout", 7000);
    expect(client.getLinkStatus).toHaveBeenCalledWith("agent-user-health-timeout", 5000);
  });

  it("returns JSON timeout before an external 15s timeout can kill status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockReturnValue(new Promise<boolean>(() => {})),
      getLinkStatus: vi.fn(),
      knowledge: vi.fn().mockReturnValue(new Promise(() => {})),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-total-timeout",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(logSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await actionPromise;

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: false,
      agent_user_id: "agent-user-total-timeout",
      status: "timeout",
      detail: {
        api_health: "unreachable",
        total_timeout_ms: 12_000,
        total_wall_time_ms: 12_000,
      },
    });
    expect(payload.detail.health_error).toContain("timed out");
    expect(payload.detail.knowledge_fallback_error).toContain("timed out");
    expect(client.getLinkStatus).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(124);
  });

  it("sets exit code 124 when non-JSON status exhausts the total timeout budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockReturnValue(new Promise<boolean>(() => {})),
      getLinkStatus: vi.fn(),
      knowledge: vi.fn().mockReturnValue(new Promise(() => {})),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-non-json-total-timeout",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.({});

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(12_000);
    await actionPromise;

    expect(logSpy).toHaveBeenCalledWith("\nAPI is unreachable. Check baseUrl and network connectivity.");
    expect(process.exitCode).toBe(124);
  });

  it("returns structured JSON when SIGTERM interrupts status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const originalSigintListeners = process.listeners("SIGINT");
    const originalSigtermListeners = process.listeners("SIGTERM");
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockReturnValue(new Promise<boolean>(() => {})),
      getLinkStatus: vi.fn(),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-sigterm",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => {
      if (typeof cb === "function") cb();
      return true;
    }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);

    program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });
    await flushMicrotasks();

    try {
      expect(() => process.emit("SIGTERM")).toThrow("process.exit:124");
      expect(exitSpy).toHaveBeenCalledWith(124);

      const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0]).trim());
      expect(payload).toMatchObject({
        linked: false,
        agent_user_id: "agent-user-sigterm",
        status: "timeout",
        message: "Cortex status interrupted by SIGTERM.",
        detail: {
          api_health: "not_checked",
          total_timeout_ms: 12_000,
          link_status: "unavailable",
        },
      });
    } finally {
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      for (const listener of originalSigintListeners) process.on("SIGINT", listener);
      for (const listener of originalSigtermListeners) process.on("SIGTERM", listener);
    }
  });

  it("returns JSON promptly when link status never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockReturnValue(new Promise(() => {})),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-link-timeout",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await actionPromise;

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: false,
      agent_user_id: "agent-user-link-timeout",
      status: "ok",
      detail: {
        api_health: "ok",
        used_knowledge_fallback: false,
        link_latency_ms: 5_000,
        link_status: "unavailable",
      },
    });
    expect(payload.detail.link_error).toContain("timed out");
    expect(payload.detail.total_wall_time_ms).toBe(5_000);
  });

  it("returns JSON status for legacy claimed-user link payloads", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({
        linked: true,
        link: {
          tootoo_user_id: "tt-user-9",
          linked_at: "2026-04-24T11:00:00Z",
        },
      }),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-legacy",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: true,
      agent_user_id: "agent-user-legacy",
      tootoo_user_id: "tt-user-9",
      owner_type: null,
      owner_id: null,
      shadow_subject_id: null,
      claimed_user_id: null,
      linked_at: "2026-04-24T11:00:00Z",
      status: "ok",
    });
  });

  it("ignores unrelated status options while honoring --json mode", async () => {
    const registerCli = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn(),
      stats: vi.fn(),
      recall: vi.fn(),
      retrieve: vi.fn(),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "agent-user-opts",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.({
      json: true,
      unsupported_flag: true,
    } as any);

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      linked: false,
      agent_user_id: "agent-user-opts",
      status: "ok",
    });
  });

  it("keeps the manual cortex pair command flow intact", async () => {
    const registerCli = vi.fn();
    const client = {
      generatePairingCode: vi.fn().mockResolvedValue({
        user_code: "WOLF-3847",
        expires_in: 900,
        expires_at: "2026-03-04T12:00:00Z",
      }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("pair")?.actionHandler?.();

    expect(client.generatePairingCode).toHaveBeenCalledWith("user-1");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("TooToo Agent Pairing"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pairing code:  WOLF-3847"));
  });

  it("does not block fallback health reporting on a slow stats probe", async () => {
    const registerCli = vi.fn();
    let resolveStats: ((value: { pipeline_tier: 1; pipeline_maturity: "cold" }) => void) | undefined;
    const statsPromise = new Promise<{ pipeline_tier: 1; pipeline_maturity: "cold" }>((resolve) => {
      resolveStats = resolve;
    });
    const client = {
      healthCheck: vi.fn().mockResolvedValue(false),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 53,
        total_sessions: 6,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockReturnValue(statsPromise),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    });

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const actionPromise = program.children.get("cortex")?.children.get("status")?.actionHandler?.();
    await flushMicrotasks(30);

    expect(client.healthCheck).toHaveBeenCalledOnce();
    expect(client.knowledge).toHaveBeenCalledWith("user-1", 8000);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("API Health:     OK (fallback via /v1/knowledge)"));
    expect(client.getLinkStatus).toHaveBeenCalledWith("user-1", 5000);

    resolveStats?.({ pipeline_tier: 1, pipeline_maturity: "cold" });
    await actionPromise;
  });

  it("shows degraded write-path state on status when the last accepted job is still pending", async () => {
    const registerCli = vi.fn();
    const persistWriteHealth = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 0,
        total_sessions: 0,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
      getJob: vi.fn().mockResolvedValue({ job_id: "job-pending", status: "pending" }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      loadPersistedWriteHealth: () => ({
        status: "degraded",
        lastAttemptAt: Date.now(),
        lastAcceptedAt: Date.now(),
        lastConfirmedAt: 0,
        lastJobId: "job-pending",
        lastJobStatus: "pending",
        lastWarning: "Cortex write job job-pending is still pending; memory is queued but not confirmed.",
        consecutivePendingJobs: 1,
        consecutiveFailures: 0,
      }),
      persistWriteHealth,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    } as any);

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.();

    expect(client.getJob).toHaveBeenCalledWith("job-pending");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Write Path:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("DEGRADED"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("job-pending (pending)"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not confirmed"));
    expect(persistWriteHealth).toHaveBeenCalledWith(expect.objectContaining({
      status: "degraded",
      lastJobStatus: "pending",
    }));
  });

  it("persists refreshed healthy write-path state when the last job has completed", async () => {
    const registerCli = vi.fn();
    const persistWriteHealth = vi.fn();
    const client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getLinkStatus: vi.fn().mockResolvedValue({ linked: false }),
      knowledge: vi.fn().mockResolvedValue({
        total_memories: 0,
        total_sessions: 0,
        maturity: "cold",
        entities: [],
      }),
      stats: vi.fn().mockResolvedValue({ pipeline_tier: 1, pipeline_maturity: "cold" }),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retrieve: vi.fn().mockResolvedValue({ results: [] }),
      getJob: vi.fn().mockResolvedValue({ job_id: "job-done", status: "completed" }),
    };

    registerCliCommands(registerCli, {
      client: client as any,
      config: {
        baseUrl: "https://api.example.com",
        autoRecall: true,
        autoCapture: true,
        dedupeWindowMinutes: 30,
        toolTimeoutMs: 500,
      } as any,
      version: "test",
      getUserId: () => "user-1",
      userIdReady: Promise.resolve(),
      getNamespace: () => "test",
      sessionStats: makeSessionStats(),
      loadPersistedStats: () => null,
      loadPersistedWriteHealth: () => ({
        status: "degraded",
        lastAttemptAt: Date.now(),
        lastAcceptedAt: Date.now(),
        lastConfirmedAt: 0,
        lastJobId: "job-done",
        lastJobStatus: "pending",
        lastWarning: "queued but not confirmed",
        consecutivePendingJobs: 2,
        consecutiveFailures: 0,
      }),
      persistWriteHealth,
      isAbortError: () => false,
      resetCompletedAfterAbort: async () => false,
    } as any);

    const program = createCliNode("root");
    const registrar = registerCli.mock.calls[0][0] as (ctx: { program: CliProgram; config: Record<string, unknown> }) => void;
    registrar({ program: program as unknown as CliProgram, config: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.children.get("cortex")?.children.get("status")?.actionHandler?.();

    expect(client.getJob).toHaveBeenCalledWith("job-done");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("HEALTHY"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("job-done (completed)"));
    expect(persistWriteHealth).toHaveBeenCalledWith(expect.objectContaining({
      status: "healthy",
      lastJobStatus: "completed",
      consecutivePendingJobs: 0,
    }));
  });
});
