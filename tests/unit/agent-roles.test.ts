import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRolePreset, detectAgentRole } from "../../src/internal/agent-roles.js";
import type { AgentRole } from "../../src/internal/agent-roles.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("getRolePreset", () => {
  const roles: AgentRole[] = ["developer", "researcher", "manager", "support", "generalist"];

  for (const role of roles) {
    it(`returns a preset for "${role}"`, () => {
      const preset = getRolePreset(role);
      expect(preset).toBeDefined();
      expect(Array.isArray(preset.captureCategories)).toBe(true);
      expect(typeof preset.captureInstructions).toBe("string");
      expect(typeof preset.recallContext).toBe("string");
    });
  }

  it("developer has non-empty categories and instructions", () => {
    const preset = getRolePreset("developer");
    expect(preset.captureCategories.length).toBeGreaterThan(0);
    expect(preset.captureInstructions.length).toBeGreaterThan(0);
    expect(preset.recallContext.length).toBeGreaterThan(0);
  });

  it("generalist has empty categories and instructions", () => {
    const preset = getRolePreset("generalist");
    expect(preset.captureCategories).toEqual([]);
    expect(preset.captureInstructions).toBe("");
    expect(preset.recallContext).toBe("");
  });

  it("each non-generalist role has unique categories", () => {
    const nonGeneralist = roles.filter((r) => r !== "generalist");
    const allCategories = nonGeneralist.map((r) => getRolePreset(r).captureCategories.join("|"));
    const unique = new Set(allCategories);
    expect(unique.size).toBe(nonGeneralist.length);
  });
});

describe("detectAgentRole", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cortex-role-"));
  });

  it("returns undefined for empty directory", async () => {
    expect(await detectAgentRole(dir)).toBeUndefined();
  });

  it("detects developer from SOUL.md with engineering keywords", async () => {
    await writeFile(
      join(dir, "SOUL.md"),
      "You are a software engineer focused on backend architecture, TypeScript, and deployment infrastructure.",
    );
    expect(await detectAgentRole(dir)).toBe("developer");
  });

  it("detects researcher from USER.md with research keywords", async () => {
    await writeFile(
      join(dir, "USER.md"),
      "Role: Research analyst. Focus on data analysis, hypothesis testing, methodology evaluation, and literature review.",
    );
    expect(await detectAgentRole(dir)).toBe("researcher");
  });

  it("detects manager from AGENTS.md with project keywords", async () => {
    await writeFile(
      join(dir, "AGENTS.md"),
      "You are a project manager. Track milestones, deadlines, stakeholder feedback, and team assignments. Run standups and prioritize the backlog.",
    );
    expect(await detectAgentRole(dir)).toBe("manager");
  });

  it("detects support from IDENTITY.md with customer keywords", async () => {
    await writeFile(
      join(dir, "IDENTITY.md"),
      "Customer support specialist. Handle tickets, troubleshoot issues, manage escalations, and track SLA response times.",
    );
    expect(await detectAgentRole(dir)).toBe("support");
  });

  it("returns undefined when content is too generic", async () => {
    await writeFile(join(dir, "SOUL.md"), "You are a helpful assistant.");
    expect(await detectAgentRole(dir)).toBeUndefined();
  });

  it("returns undefined when roles are ambiguous (close scores)", async () => {
    await writeFile(
      join(dir, "SOUL.md"),
      "You help with coding and also research. You deploy software and analyze data.",
    );
    expect(await detectAgentRole(dir)).toBeUndefined();
  });

  it("combines content from multiple bootstrap files", async () => {
    await writeFile(join(dir, "SOUL.md"), "You are an engineer.");
    await writeFile(join(dir, "USER.md"), "Works on backend infrastructure and deployment pipelines.");
    expect(await detectAgentRole(dir)).toBe("developer");
  });
});
