import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/shared/fs/safe-path.js", async () => {
  const actual = await vi.importActual("../../src/shared/fs/safe-path.js");
  return actual;
});

import { MemoryMdSync } from "../../src/features/sync/memory-md-sync.js";
import { DailyLogsSync } from "../../src/features/sync/daily-logs-sync.js";
import { TranscriptsSync } from "../../src/features/sync/transcripts-sync.js";
import type { CortexClient } from "../../src/cortex/client.js";

const workspaceDir = await mkdtemp(join(tmpdir(), "sync-safe-root-"));
const outsideDir = await mkdtemp(join(tmpdir(), "sync-safe-outside-"));

await mkdir(join(workspaceDir, "memory"), { recursive: true });
await mkdir(join(workspaceDir, "sessions"), { recursive: true });

const outsideMemoryTarget = join(outsideDir, "outside-memory.md");
const outsideDailyTarget = join(outsideDir, "outside-daily.md");
const outsideTranscriptTarget = join(outsideDir, "outside-transcript.jsonl");

await writeFile(outsideMemoryTarget, "outside memory content");
await writeFile(outsideDailyTarget, "outside daily content");
await writeFile(
  outsideTranscriptTarget,
  [
    JSON.stringify({ role: "user", content: "How do we deploy our production stack safely?" }),
    JSON.stringify({ role: "assistant", content: "Use blue-green deployment with staged health checks and rollback." }),
  ].join("\n"),
);

const memorySymlinkPath = join(workspaceDir, "MEMORY.md");
const dailySymlinkPath = join(workspaceDir, "memory", "escape.md");
const transcriptSymlinkPath = join(workspaceDir, "sessions", "escape.jsonl");

await symlink(outsideMemoryTarget, memorySymlinkPath);
await symlink(outsideDailyTarget, dailySymlinkPath);
await symlink(outsideTranscriptTarget, transcriptSymlinkPath);

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeClient(overrides: Partial<CortexClient> = {}): CortexClient {
  return {
    ingest: vi.fn().mockResolvedValue({ nodes_created: 1, edges_created: 0, facts: [], entities: [] }),
    ingestConversation: vi.fn().mockResolvedValue({ nodes_created: 1, edges_created: 0, facts: [], entities: [] }),
    ...overrides,
  } as unknown as CortexClient;
}

describe("sync path safety (real symlink checks)", () => {
  afterAll(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("rejects symlinked MEMORY.md outside workspace root", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const logger = makeLogger();
    const sync = new MemoryMdSync(memorySymlinkPath, client, "ns:memory-md", logger, undefined, workspaceDir);

    sync.onFileChange();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.ingest).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("rejected unsafe path"));
    vi.useRealTimers();
  });

  it("rejects symlinked daily log outside memory root", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new DailyLogsSync(client, "ns", logger, undefined, join(workspaceDir, "memory"));

    await sync.onFileChange(dailySymlinkPath, "escape.md");

    expect(client.ingest).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("rejected unsafe path"));
  });

  it("rejects symlinked transcript outside sessions root", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const sync = new TranscriptsSync(client, "ns", logger, undefined, join(workspaceDir, "sessions"));

    await sync.onFileChange(transcriptSymlinkPath, "escape.jsonl");

    expect(client.ingestConversation).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("rejected unsafe path"));
  });
});
