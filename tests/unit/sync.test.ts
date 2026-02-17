import { describe, it, expect } from "vitest";
import { lineDiff } from "../../src/features/sync/memory-md-sync.js";

describe("lineDiff", () => {
  it("detects added lines", () => {
    const prev = "line1\nline2\nline3";
    const curr = "line1\nline2\nline3\nline4\nline5";

    const result = lineDiff(prev, curr);
    expect(result).toBe("line4\nline5");
  });

  it("detects changed lines", () => {
    const prev = "fact: joined in 2024\nother";
    const curr = "fact: joined in January 2024\nother";

    const result = lineDiff(prev, curr);
    expect(result).toBe("fact: joined in January 2024");
  });

  it("returns empty for identical content", () => {
    const text = "line1\nline2";
    expect(lineDiff(text, text)).toBe("");
  });

  it("handles empty previous (full file is new)", () => {
    const result = lineDiff("", "line1\nline2");
    expect(result).toBe("line1\nline2");
  });

  it("handles empty current", () => {
    const result = lineDiff("line1\nline2", "");
    expect(result).toBe("");
  });
});
