import { describe, it, expect } from "vitest";
import { getRolePreset } from "../../src/internal/agent-roles.js";
import type { AgentRole } from "../../src/internal/agent-roles.js";

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
