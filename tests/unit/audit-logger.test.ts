import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLogger } from "../../src/internal/audit/audit-logger.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "audit-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AuditLogger", () => {
  it("creates audit directory and writes index + payload file", async () => {
    const audit = new AuditLogger(tempDir, logger);

    await audit.log({
      feature: "auto-capture",
      method: "POST",
      endpoint: "/v1/jobs/ingest",
      payload: "user: Hello\n\nassistant: Hi there!",
      sessionId: "sess-1",
      userId: "user-1",
      messageCount: 2,
    });

    // Check directory was created
    const auditDir = join(tempDir, ".cortex", "audit");
    const payloadsDir = join(auditDir, "payloads");
    const dirStat = await stat(payloadsDir);
    expect(dirStat.isDirectory()).toBe(true);

    // Check index.jsonl
    const indexPath = join(auditDir, "index.jsonl");
    const indexContent = await readFile(indexPath, "utf-8");
    const entry = JSON.parse(indexContent.trim());
    expect(entry.feature).toBe("auto-capture");
    expect(entry.method).toBe("POST");
    expect(entry.endpoint).toBe("/v1/jobs/ingest");
    expect(entry.bytes).toBe(Buffer.byteLength("user: Hello\n\nassistant: Hi there!", "utf-8"));
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.userId).toBe("user-1");
    expect(entry.msgs).toBe(2);
    expect(entry.payloadFile).toBeDefined();
    expect(entry.ts).toBeDefined();

    // Check payload file
    const payloadFiles = await readdir(payloadsDir);
    expect(payloadFiles).toHaveLength(1);
    const payloadContent = await readFile(join(payloadsDir, payloadFiles[0]), "utf-8");
    expect(payloadContent).toBe("user: Hello\n\nassistant: Hi there!");
  });

  it("appends multiple entries to index.jsonl", async () => {
    const audit = new AuditLogger(tempDir, logger);

    await audit.log({
      feature: "auto-recall",
      method: "POST",
      endpoint: "/v1/recall",
      payload: "What database?",
    });

    await audit.log({
      feature: "auto-capture",
      method: "POST",
      endpoint: "/v1/jobs/ingest",
      payload: "user: What database?\n\nassistant: PostgreSQL.",
      messageCount: 2,
    });

    const indexPath = join(tempDir, ".cortex", "audit", "index.jsonl");
    const lines = (await readFile(indexPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.feature).toBe("auto-recall");
    expect(second.feature).toBe("auto-capture");
    expect(second.msgs).toBe(2);

    const payloadFiles = await readdir(join(tempDir, ".cortex", "audit", "payloads"));
    expect(payloadFiles).toHaveLength(2);
  });

  it("omits msgs field when messageCount is not provided", async () => {
    const audit = new AuditLogger(tempDir, logger);

    await audit.log({
      feature: "auto-recall",
      method: "POST",
      endpoint: "/v1/recall",
      payload: "test query",
    });

    const indexPath = join(tempDir, ".cortex", "audit", "index.jsonl");
    const entry = JSON.parse((await readFile(indexPath, "utf-8")).trim());
    expect(entry.msgs).toBeUndefined();
  });

  it("rotates index.jsonl when it exceeds 5MB", async () => {
    const audit = new AuditLogger(tempDir, logger);
    const auditDir = join(tempDir, ".cortex", "audit");
    const indexPath = join(auditDir, "index.jsonl");

    // Seed the directory structure
    await audit.log({
      feature: "seed",
      method: "POST",
      endpoint: "/test",
      payload: "seed",
    });

    // Write 5MB+ to the index to trigger rotation on next log
    const bigContent = "x".repeat(5 * 1024 * 1024 + 1) + "\n";
    await writeFile(indexPath, bigContent, "utf-8");

    // This log appends to the oversized file, then rotates it away
    await audit.log({
      feature: "triggers-rotation",
      method: "POST",
      endpoint: "/test",
      payload: "triggers rotation",
    });

    // The oversized index (with the appended entry) should be rotated
    const auditFiles = await readdir(auditDir);
    const rotatedFiles = auditFiles.filter((f) => f.startsWith("index.") && f !== "index.jsonl");
    expect(rotatedFiles).toHaveLength(1);
    const rotatedStat = await stat(join(auditDir, rotatedFiles[0]));
    expect(rotatedStat.size).toBeGreaterThan(5 * 1024 * 1024);

    // Next log should create a fresh index.jsonl
    await audit.log({
      feature: "fresh-start",
      method: "POST",
      endpoint: "/test",
      payload: "after rotation",
    });

    const newIndex = (await readFile(indexPath, "utf-8")).trim();
    const entry = JSON.parse(newIndex);
    expect(entry.feature).toBe("fresh-start");
  });

  it("warns and continues on write errors", async () => {
    // Use an invalid path that will fail
    const audit = new AuditLogger("/nonexistent/path/that/will/fail", logger);

    // Should not throw
    await audit.log({
      feature: "test",
      method: "POST",
      endpoint: "/test",
      payload: "test",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Cortex audit log write failed"),
    );
  });
});
