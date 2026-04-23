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
    expect(client.getLinkStatus).toHaveBeenCalledWith("user-1");
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

    expect(client.getLinkStatus).toHaveBeenCalledWith("user-1");
    expect(logSpy).toHaveBeenCalledWith("  TooToo Link:    ✓ Linked");
    expect(logSpy).not.toHaveBeenCalledWith("  TooToo Link:    Not linked. Run `openclaw cortex pair` to connect.");
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
    await flushMicrotasks();

    expect(client.healthCheck).toHaveBeenCalledOnce();
    expect(client.knowledge).toHaveBeenCalledWith("user-1", 8000);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("API Health:     OK (fallback via /v1/knowledge)"));
    expect(client.getLinkStatus).toHaveBeenCalledWith("user-1");

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
