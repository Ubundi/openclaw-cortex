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
});
