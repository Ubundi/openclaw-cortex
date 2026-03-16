import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/**
 * Extracted copy of installSkill logic for unit testing.
 * The real function lives in src/plugin/index.ts and uses import.meta.url
 * to find the package root. Here we accept the source path directly.
 */
function installSkillFromPath(
  srcSkillPath: string,
  destDir: string,
  logger: { debug?: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): void {
  const { copyFileSync, chmodSync } = require("node:fs");
  const destPath = join(destDir, "SKILL.md");

  try {
    let srcContent: string;
    try {
      srcContent = readFileSync(srcSkillPath, "utf-8");
    } catch {
      logger.debug?.("skill not found, skipping");
      return;
    }

    try {
      const destContent = readFileSync(destPath, "utf-8");
      const srcHash = createHash("sha256").update(srcContent).digest("hex").slice(0, 12);
      const destHash = createHash("sha256").update(destContent).digest("hex").slice(0, 12);
      if (srcHash === destHash) return;
    } catch {
      // Destination doesn't exist — proceed
    }

    mkdirSync(destDir, { recursive: true });
    copyFileSync(srcSkillPath, destPath);
    try { chmodSync(destPath, 0o644); } catch { /* best-effort */ }
    logger.info("installed");
  } catch (err) {
    logger.debug?.(`install failed: ${String(err)}`);
  }
}

function mockLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    debug: (...args: unknown[]) => logs.push({ level: "debug", msg: String(args[0]) }),
    info: (...args: unknown[]) => logs.push({ level: "info", msg: String(args[0]) }),
  };
}

describe("installSkill", () => {
  let tmpDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cortex-skill-"));
    srcDir = join(tmpDir, "src");
    destDir = join(tmpDir, "dest", "skills", "cortex-memory");
    await mkdir(srcDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("copies SKILL.md to destination on first install", async () => {
    const srcPath = join(srcDir, "SKILL.md");
    await writeFile(srcPath, "# Test Skill\n\nSome instructions.\n");

    const logger = mockLogger();
    installSkillFromPath(srcPath, destDir, logger);

    expect(existsSync(join(destDir, "SKILL.md"))).toBe(true);
    const content = await readFile(join(destDir, "SKILL.md"), "utf-8");
    expect(content).toContain("# Test Skill");
    expect(logger.logs.some((l) => l.msg.includes("installed"))).toBe(true);
  });

  it("skips copy when destination matches source hash", async () => {
    const srcPath = join(srcDir, "SKILL.md");
    const content = "# Test Skill\n\nSame content.\n";
    await writeFile(srcPath, content);
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "SKILL.md"), content);

    const logger = mockLogger();
    installSkillFromPath(srcPath, destDir, logger);

    // No "installed" log — skipped because hashes match
    expect(logger.logs).toHaveLength(0);
  });

  it("overwrites when destination has different content", async () => {
    const srcPath = join(srcDir, "SKILL.md");
    await writeFile(srcPath, "# New Version\n");
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "SKILL.md"), "# Old Version\n");

    const logger = mockLogger();
    installSkillFromPath(srcPath, destDir, logger);

    const result = await readFile(join(destDir, "SKILL.md"), "utf-8");
    expect(result).toContain("# New Version");
    expect(logger.logs.some((l) => l.msg.includes("installed"))).toBe(true);
  });

  it("skips silently when source SKILL.md does not exist", () => {
    const srcPath = join(srcDir, "nonexistent", "SKILL.md");

    const logger = mockLogger();
    installSkillFromPath(srcPath, destDir, logger);

    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
    expect(logger.logs.some((l) => l.msg.includes("not found"))).toBe(true);
  });

  it("creates nested destination directories", async () => {
    const srcPath = join(srcDir, "SKILL.md");
    await writeFile(srcPath, "# Skill\n");
    const deepDest = join(tmpDir, "a", "b", "c", "cortex-memory");

    const logger = mockLogger();
    installSkillFromPath(srcPath, deepDest, logger);

    expect(existsSync(join(deepDest, "SKILL.md"))).toBe(true);
  });
});
