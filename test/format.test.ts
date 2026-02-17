import { describe, it, expect } from "vitest";
import { formatMemories } from "../src/utils/format.js";

describe("formatMemories", () => {
  it("formats results as XML", () => {
    const result = formatMemories([
      { content: "User prefers dark mode", score: 0.95 },
      { content: "Project uses React", score: 0.82 },
    ]);

    expect(result).toBe(
      `<cortex_memories>\n- [0.95] User prefers dark mode\n- [0.82] Project uses React\n</cortex_memories>`,
    );
  });

  it("returns empty string for no results", () => {
    expect(formatMemories([])).toBe("");
  });
});
