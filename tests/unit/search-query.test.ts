import { describe, expect, it } from "vitest";
import { coerceCliSearchQuery, inferSearchMode, prepareSearchQuery } from "../../src/plugin/search-query.js";

describe("search-query helpers", () => {
  it("joins variadic CLI args into a single natural-language query", () => {
    expect(coerceCliSearchQuery(["what", "database", "did", "we", "choose"])).toBe(
      "what database did we choose",
    );
  });

  it("infers decision mode for architectural questions", () => {
    expect(inferSearchMode("what database did we choose for our project")).toBe("decisions");
  });

  it("infers preference mode for preference questions", () => {
    expect(inferSearchMode("what theme do I prefer in the editor")).toBe("preferences");
  });

  it("infers recent mode for recency questions", () => {
    expect(inferSearchMode("what changed recently in this project")).toBe("recent");
  });

  it("prepares decision queries with the same metadata tags as the in-chat tool", () => {
    expect(prepareSearchQuery("what database did we choose")).toEqual({
      query: "what database did we choose",
      effectiveQuery: "[type:decision] what database did we choose",
      mode: "decisions",
      queryType: "factual",
      memoryType: "decision",
    });
  });

  it("honors an explicit mode override", () => {
    expect(prepareSearchQuery("what database did we choose", "facts")).toEqual({
      query: "what database did we choose",
      effectiveQuery: "[type:fact] what database did we choose",
      mode: "facts",
      queryType: "factual",
      memoryType: "fact",
    });
  });

  it("preserves an explicit all mode instead of auto-narrowing the search", () => {
    expect(prepareSearchQuery("what database did we choose", "all")).toEqual({
      query: "what database did we choose",
      effectiveQuery: "what database did we choose",
      mode: "all",
      queryType: "combined",
    });
  });

  it("makes recent mode encode recency intent into the effective query", () => {
    expect(prepareSearchQuery("worker jobs", "recent")).toEqual({
      query: "worker jobs",
      effectiveQuery: "most recent relevant memories about: worker jobs",
      mode: "recent",
      queryType: "combined",
    });
  });
});
