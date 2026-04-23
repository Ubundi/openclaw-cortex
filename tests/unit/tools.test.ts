import { describe, it, expect, vi } from "vitest";
import type { CortexClient, NodeDetailResponse, RecallMemory } from "../../src/cortex/client.js";
import type { CortexConfig } from "../../src/plugin/config.js";
import {
  buildForgetMemoryTool,
  buildGetMemoryTool,
  buildSaveMemoryTool,
  buildSearchMemoryTool,
  type SessionStats,
  type ToolsDeps,
} from "../../src/plugin/tools.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallLimit: 20,
    recallTopK: 10,
    recallQueryType: "combined",
    recallProfile: "auto",
    recallTimeoutMs: 60_000,
    toolTimeoutMs: 5_000,
    captureMaxPayloadBytes: 262_144,
    captureFilter: true,
    dedupeWindowMinutes: 30,
    noveltyThreshold: 0.85,
    auditLog: false,
    namespace: "openclaw",
    ...overrides,
  };
}

function makeMemory(
  content: string,
  overrides: Partial<RecallMemory> = {},
): RecallMemory {
  return {
    content,
    confidence: 0.9,
    when: "2026-03-01T10:00:00Z",
    session_id: "session-999",
    entities: [],
    ...overrides,
  };
}

function makeDeps(configOverrides: Partial<CortexConfig> = {}) {
  const client = {
    recall: vi.fn(),
    forgetEntity: vi.fn(),
    forgetSession: vi.fn(),
    getNode: vi.fn(),
  } as unknown as CortexClient;

  const sessionStats: SessionStats = {
    saves: 0,
    savesSkippedDedupe: 0,
    savesSkippedNovelty: 0,
    searches: 0,
    recallCount: 0,
    recallMemoriesTotal: 0,
    recallDuplicatesCollapsed: 0,
  };

  const persistStats = vi.fn();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const auditLoggerProxy = {
    log: vi.fn().mockResolvedValue(undefined),
  };

  const deps: ToolsDeps = {
    client,
    config: makeConfig(configOverrides),
    logger,
    getUserId: () => "user-123",
    getActiveSessionKey: () => "active-session-123",
    userIdReady: Promise.resolve(),
    sessionId: "session-123",
    sessionStats,
    persistStats,
    auditLoggerProxy: auditLoggerProxy as any,
    knowledgeState: {
      hasMemories: false,
      totalSessions: 0,
      pipelineTier: 1,
      maturity: "cold",
      lastChecked: 0,
    },
    recentSaves: null,
  };

  return { client: client as any, deps, persistStats, logger, auditLoggerProxy };
}

describe("buildSearchMemoryTool", () => {
  it("passes sessionFilter when scope is session", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [makeMemory("Captured in the live chat", { session_id: "active-session-123" })],
    });

    const tool = buildSearchMemoryTool(deps);
    await tool.execute("tool-1", { query: "current", scope: "session" });

    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(client.recall).toHaveBeenCalledWith(
      "current",
      deps.config.toolTimeoutMs,
      expect.objectContaining({
        limit: 10,
        sessionFilter: "active-session-123",
        userId: "user-123",
      }),
    );
  });

  it("filters out current-session memories for long-term scope and expands the recall limit", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [
        makeMemory("Current session note", { session_id: "active-session-123" }),
        makeMemory("Older memory", { session_id: "session-999" }),
      ],
    });

    const tool = buildSearchMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "history", limit: 4, scope: "long-term" });
    const responseText = result.content[0]?.text ?? "";

    expect(client.recall).toHaveBeenCalledWith(
      "history",
      deps.config.toolTimeoutMs,
      expect.objectContaining({
        limit: 8,
        userId: "user-123",
      }),
    );
    expect(responseText).toContain("Older memory");
    expect(responseText).not.toContain("Current session note");
  });

  it("leaves search behavior unchanged for explicit all scope", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({ memories: [makeMemory("All memory")] });

    const tool = buildSearchMemoryTool(deps);
    await tool.execute("tool-1", { query: "history", limit: 3, scope: "all" });

    const options = client.recall.mock.calls[0][2];
    expect(options.limit).toBe(3);
    expect(options).not.toHaveProperty("sessionFilter");
  });

  it("defaults omitted scope to all", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({ memories: [makeMemory("Default scope memory")] });

    const tool = buildSearchMemoryTool(deps);
    await tool.execute("tool-1", { query: "history" });

    const options = client.recall.mock.calls[0][2];
    expect(options.limit).toBe(10);
    expect(options).not.toHaveProperty("sessionFilter");
  });

  it("returns non-session memories unchanged for long-term scope when no current-session matches exist", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [
        makeMemory("Cross-session fact A", { session_id: "session-999" }),
        makeMemory("Legacy deployment uses blue-green rollouts", { session_id: null }),
      ],
    });

    const tool = buildSearchMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "history", scope: "long-term" });
    const responseText = result.content[0]?.text ?? "";

    expect(responseText).toContain("Cross-session fact A");
    expect(responseText).toContain("Legacy deployment uses blue-green rollouts");
  });

  it("expands the fetch window for long-term scope until enough non-current memories are available", async () => {
    const { client, deps } = makeDeps();
    client.recall
      .mockResolvedValueOnce({
        memories: [
          makeMemory("Current turn A", { session_id: "active-session-123" }),
          makeMemory("Current turn B", { session_id: "active-session-123" }),
          makeMemory("Current turn C", { session_id: "active-session-123" }),
          makeMemory("Current turn D", { session_id: "active-session-123" }),
        ],
      })
      .mockResolvedValueOnce({
        memories: [
          makeMemory("Current turn A", { session_id: "active-session-123" }),
          makeMemory("Current turn B", { session_id: "active-session-123" }),
          makeMemory("Current turn C", { session_id: "active-session-123" }),
          makeMemory("Current turn D", { session_id: "active-session-123" }),
          makeMemory("Atlas rollout uses staggered canaries", { session_id: "older-session-1" }),
          makeMemory("Postgres backups run nightly at 02:00 UTC", { session_id: "older-session-2" }),
        ],
      });

    const tool = buildSearchMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "history", limit: 2, scope: "long-term" });

    expect(client.recall).toHaveBeenCalledTimes(2);
    expect(client.recall).toHaveBeenNthCalledWith(
      1,
      "history",
      deps.config.toolTimeoutMs,
      expect.objectContaining({ limit: 4, userId: "user-123" }),
    );
    expect(client.recall).toHaveBeenNthCalledWith(
      2,
      "history",
      deps.config.toolTimeoutMs,
      expect.objectContaining({ limit: 6, userId: "user-123" }),
    );
    expect(result.content[0]?.text).toContain("Atlas rollout uses staggered canaries");
    expect(result.content[0]?.text).toContain("Postgres backups run nightly at 02:00 UTC");
  });
});

describe("buildSaveMemoryTool", () => {
  it("records accepted remember writes for local dedupe and session stats", async () => {
    const { client, deps, auditLoggerProxy } = makeDeps();
    const record = vi.fn();
    const isDuplicate = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    deps.recentSaves = { record, isDuplicate } as any;
    client.remember = vi.fn().mockResolvedValue({ session_id: "active-session-123", status: "accepted" });

    const tool = buildSaveMemoryTool(deps);
    const result = await tool.execute("tool-1", { text: "Remember that the project uses Atlas." });
    const duplicateResult = await tool.execute("tool-1", { text: "Remember that the project uses Atlas." });
    const responseText = result.content[0]?.text ?? "";
    const duplicateText = duplicateResult.content[0]?.text ?? "";

    expect(client.remember).toHaveBeenCalledWith(
      "Remember that the project uses Atlas.",
      "active-session-123",
      deps.config.toolTimeoutMs,
      expect.any(String),
      "user-123",
      "openclaw",
      "OpenClaw",
    );
    expect(auditLoggerProxy.log).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "active-session-123" }),
    );
    expect(responseText).toContain("accepted for background processing");
    expect(responseText).not.toContain("available shortly");
    expect(duplicateText).toContain("saved recently");
    expect(record).toHaveBeenCalledWith("Remember that the project uses Atlas.");
    expect(deps.knowledgeState.hasMemories).toBe(false);
    expect(deps.sessionStats.saves).toBe(1);
  });

  it("counts async fallback acceptance even when confirmation stays pending", async () => {
    const { client, deps } = makeDeps();
    deps.recentSaves = { record: vi.fn(), isDuplicate: vi.fn().mockReturnValue(false) } as any;
    client.remember = vi.fn().mockRejectedValue(new Error("Cortex remember failed: 503"));
    client.submitIngest = vi.fn().mockResolvedValue({ job_id: "job-123", status: "pending" });
    client.getJob = vi.fn().mockResolvedValue({ job_id: "job-123", status: "pending" });

    const tool = buildSaveMemoryTool(deps);
    const result = await tool.execute("tool-1", { text: "Remember that the project uses Atlas." });
    const responseText = result.content[0]?.text ?? "";

    expect(client.submitIngest).toHaveBeenCalledOnce();
    expect(client.getJob).toHaveBeenCalled();
    expect(responseText).toContain("job job-123");
    expect(responseText).toContain("not confirmed");
    expect(deps.knowledgeState.hasMemories).toBe(false);
    expect(deps.sessionStats.saves).toBe(1);
  });
});

describe("buildForgetMemoryTool", () => {
  it("uses query matches to suggest entities without deleting them", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [
        makeMemory("The project uses Atlas and Postgres.", { entities: ["Atlas", "Postgres"], confidence: 0.9 }),
        makeMemory("Atlas owns the migration plan.", { entities: ["Atlas"], confidence: 0.8 }),
        makeMemory("Low-confidence note", { entities: ["IgnoreMe"], confidence: 0.3 }),
      ],
    });

    const tool = buildForgetMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "database choice" });
    const responseText = result.content[0]?.text ?? "";

    expect(client.recall).toHaveBeenCalledWith(
      "database choice",
      deps.config.toolTimeoutMs,
      expect.objectContaining({
        limit: 10,
        userId: "user-123",
      }),
    );
    expect(client.forgetEntity).not.toHaveBeenCalled();
    expect(responseText).toContain("Found 2 matching memories.");
    expect(responseText).toContain("Candidate entities: Atlas, Postgres.");
    expect(responseText).toContain("No memories were deleted from the query matches.");
  });

  it("returns an informational message when query matches contain no named entities", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [
        makeMemory("The user said the setup felt confusing.", { entities: [], confidence: 0.9 }),
      ],
    });

    const tool = buildForgetMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "confusing setup" });
    const responseText = result.content[0]?.text ?? "";

    expect(client.forgetEntity).not.toHaveBeenCalled();
    expect(responseText).toContain("none included named entities to forget");
    expect(responseText).toContain("No memories were deleted.");
    expect(responseText).toContain("The user said the setup felt confusing.");
  });

  it("skips low-confidence query matches", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [
        makeMemory("Possible Redis preference", { entities: ["Redis"], confidence: 0.4 }),
      ],
    });

    const tool = buildForgetMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "redis" });
    const responseText = result.content[0]?.text ?? "";

    expect(client.forgetEntity).not.toHaveBeenCalled();
    expect(responseText).toContain("none met the confidence threshold of 0.50");
    expect(responseText).toContain("No memories were deleted.");
  });

  it("keeps query mode non-destructive when an explicit entity deletion is also provided", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockResolvedValue({
      memories: [
        makeMemory("Atlas owns the deployment plan.", { entities: ["Atlas"], confidence: 0.9 }),
      ],
    });
    client.forgetEntity.mockResolvedValueOnce({ memories_removed: 2 });

    const tool = buildForgetMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "deployment plan", entity: "Phoenix" });
    const responseText = result.content[0]?.text ?? "";

    expect(client.forgetEntity).toHaveBeenCalledTimes(1);
    expect(client.forgetEntity).toHaveBeenNthCalledWith(1, "Phoenix", deps.config.toolTimeoutMs);
    expect(responseText).toContain("Candidate entities: Atlas.");
    expect(responseText).toContain('Removed 2 memories referencing "Phoenix".');
  });

  it("returns a graceful error when the query search fails", async () => {
    const { client, deps } = makeDeps();
    client.recall.mockRejectedValue(new Error("boom"));

    const tool = buildForgetMemoryTool(deps);
    const result = await tool.execute("tool-1", { query: "atlas" });

    expect(result.content[0]?.text).toContain('Failed to search memories for query "atlas": Error: boom');
  });
});

describe("buildGetMemoryTool", () => {
  it("returns formatted node details for a valid memory id", async () => {
    const { client, deps } = makeDeps();
    client.getNode.mockResolvedValue({
      node: {
        id: "node-1",
        type: "FACT",
        content: "User prefers TypeScript",
        confidence: 0.81,
        metadata: { entity_refs: ["TypeScript"] },
        created_at: "2026-03-01T10:00:00Z",
      },
      related: [
        {
          node: { id: "entity-1", type: "ENTITY", content: "TypeScript", confidence: 1.0 },
          edge: { type: "MENTIONS", strength: 1.0 },
        },
      ],
      confidence_explanation: null,
    } satisfies NodeDetailResponse);

    const tool = buildGetMemoryTool(deps);
    const result = await tool.execute("tool-1", { id: "node-1" });
    const responseText = result.content[0]?.text ?? "";

    expect(client.getNode).toHaveBeenCalledWith("node-1", deps.config.toolTimeoutMs);
    expect(responseText).toContain("ID: node-1");
    expect(responseText).toContain("Type: FACT");
    expect(responseText).toContain("Confidence: 0.81");
    expect(responseText).toContain("Related entities: TypeScript");
    expect(responseText).toContain("User prefers TypeScript");
  });

  it("returns a friendly error when the memory lookup fails", async () => {
    const { client, deps } = makeDeps();
    client.getNode.mockRejectedValue(new Error("Cortex nodes failed: 404"));

    const tool = buildGetMemoryTool(deps);
    const result = await tool.execute("tool-1", { id: "missing-node" });

    expect(result.content[0]?.text).toContain('Failed to fetch memory "missing-node": Error: Cortex nodes failed: 404');
  });
});
