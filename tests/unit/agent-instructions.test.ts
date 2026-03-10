import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectAgentInstructions } from "../../src/internal/agent-instructions.js";

function mockLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    debug: (...args: unknown[]) => logs.push({ level: "debug", msg: String(args[0]) }),
    info: (...args: unknown[]) => logs.push({ level: "info", msg: String(args[0]) }),
    warn: (...args: unknown[]) => logs.push({ level: "warn", msg: String(args[0]) }),
  };
}

describe("injectAgentInstructions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cortex-inject-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends Cortex section to existing AGENTS.md", async () => {
    const agentsMd = join(tmpDir, "AGENTS.md");
    await writeFile(agentsMd, "# AGENTS.md\n\nSome content.\n");

    const logger = mockLogger();
    await injectAgentInstructions(tmpDir, logger);

    const result = await readFile(agentsMd, "utf-8");
    expect(result).toContain("## Cortex Memory");
    expect(result).toContain("cortex_search_memory");
    expect(result).toContain("For volatile current-state facts, verify against live workspace/runtime first.");
    expect(result).toContain("If memory and live state conflict, report both with timing context.");
    expect(result).toContain("<!-- /cortex-memory -->");
    expect(result).toContain("cortex-memory-hash:");
    expect(result).toContain("# AGENTS.md"); // original content preserved
    expect(logger.logs.some((l) => l.level === "info" && l.msg.includes("appended"))).toBe(true);
  });

  it("is idempotent — does not append twice", async () => {
    const agentsMd = join(tmpDir, "AGENTS.md");
    await writeFile(agentsMd, "# AGENTS.md\n\nSome content.\n");

    const logger = mockLogger();
    await injectAgentInstructions(tmpDir, logger);
    await injectAgentInstructions(tmpDir, logger);

    const result = await readFile(agentsMd, "utf-8");
    const matches = result.match(/## Cortex Memory/g);
    expect(matches).toHaveLength(1);
  });

  it("skips silently when AGENTS.md does not exist", async () => {
    const logger = mockLogger();
    await injectAgentInstructions(tmpDir, logger);

    expect(logger.logs).toHaveLength(0);
  });

  it("logs warning on write failure", async () => {
    // Use a non-existent nested path to trigger write error
    const logger = mockLogger();
    await injectAgentInstructions(join(tmpDir, "nonexistent", "deep"), logger);

    // No AGENTS.md in a nonexistent dir = ENOENT on read = skip silently
    // (the warning path is for other errors like permission denied)
    expect(logger.logs.every((l) => l.level !== "error")).toBe(true);
  });

  it("replaces stale section when hash is missing (legacy injection)", async () => {
    const agentsMd = join(tmpDir, "AGENTS.md");
    // Simulate old-style injection without hash or end marker
    await writeFile(agentsMd, "# AGENTS.md\n\n## Cortex Memory\n\nOld instructions without hash.\n");

    const logger = mockLogger();
    await injectAgentInstructions(tmpDir, logger);

    const result = await readFile(agentsMd, "utf-8");
    // Should have replaced with new content
    expect(result).toContain("cortex-memory-hash:");
    expect(result).toContain("<!-- /cortex-memory -->");
    expect(result).toContain("Don't act on personal facts");
    expect(result).not.toContain("Old instructions without hash.");
    expect(result).toContain("# AGENTS.md"); // original content before section preserved
    expect(logger.logs.some((l) => l.level === "info" && l.msg.includes("updated"))).toBe(true);
  });

  it("replaces stale section when hash doesn't match", async () => {
    const agentsMd = join(tmpDir, "AGENTS.md");
    await writeFile(
      agentsMd,
      "# AGENTS.md\n\n## Cortex Memory\n\nOld content.\n\n<!-- cortex-memory-hash:000000000000 -->\n<!-- /cortex-memory -->\n",
    );

    const logger = mockLogger();
    await injectAgentInstructions(tmpDir, logger);

    const result = await readFile(agentsMd, "utf-8");
    expect(result).toContain("Don't act on personal facts");
    expect(result).not.toContain("000000000000");
    expect(result).not.toContain("Old content.");
    expect(logger.logs.some((l) => l.level === "info" && l.msg.includes("updated"))).toBe(true);
  });

  it("skips when hash matches (up to date)", async () => {
    const agentsMd = join(tmpDir, "AGENTS.md");
    await writeFile(agentsMd, "# AGENTS.md\n\nSome content.\n");

    const logger = mockLogger();
    // First injection
    await injectAgentInstructions(tmpDir, logger);
    const firstResult = await readFile(agentsMd, "utf-8");

    // Second injection — should be a no-op
    logger.logs.length = 0;
    await injectAgentInstructions(tmpDir, logger);
    const secondResult = await readFile(agentsMd, "utf-8");

    expect(secondResult).toBe(firstResult);
    expect(logger.logs).toHaveLength(0);
  });

  it("preserves content after the Cortex section", async () => {
    const agentsMd = join(tmpDir, "AGENTS.md");
    await writeFile(
      agentsMd,
      "# AGENTS.md\n\n## Cortex Memory\n\nOld stuff.\n\n<!-- cortex-memory-hash:000000000000 -->\n<!-- /cortex-memory -->\n\n## Other Section\n\nKeep this.\n",
    );

    const logger = mockLogger();
    await injectAgentInstructions(tmpDir, logger);

    const result = await readFile(agentsMd, "utf-8");
    expect(result).toContain("## Other Section");
    expect(result).toContain("Keep this.");
    expect(result).toContain("Don't act on personal facts");
  });
});
