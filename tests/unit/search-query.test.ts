import { describe, expect, it } from "vitest";
import { coerceCliSearchQuery, filterSearchResults, inferSearchMode, prepareSearchQuery } from "../../src/plugin/search-query.js";

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

  it("defaults to broad all-mode search when no explicit mode is provided", () => {
    expect(prepareSearchQuery("what database did we choose")).toEqual({
      query: "what database did we choose",
      effectiveQuery: "what database did we choose",
      mode: "all",
      queryType: "combined",
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

  it("filters weak tail results for broad all-mode searches", () => {
    const filtered = filterSearchResults([
      { content: "strong", confidence: 0.82, relevance: 0.82, when: null, session_id: null, entities: [] },
      { content: "still relevant", confidence: 0.61, relevance: 0.61, when: null, session_id: null, entities: [] },
      { content: "weak tail", confidence: 0.12, relevance: 0.12, when: null, session_id: null, entities: [] },
    ], "all");

    expect(filtered.map((memory) => memory.content)).toEqual(["strong", "still relevant"]);
  });

  it("does not filter explicit mode searches", () => {
    const filtered = filterSearchResults([
      { content: "decision A", confidence: 0.21, relevance: 0.21, when: null, session_id: null, entities: [] },
      { content: "decision B", confidence: 0.11, relevance: 0.11, when: null, session_id: null, entities: [] },
    ], "decisions");

    expect(filtered).toHaveLength(2);
  });
});
