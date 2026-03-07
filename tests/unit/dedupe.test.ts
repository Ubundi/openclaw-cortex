import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecentSaves } from "../../src/internal/dedupe.js";

describe("RecentSaves", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flag first save as duplicate", () => {
    const ds = new RecentSaves(30);
    expect(ds.isDuplicate("User prefers dark mode")).toBe(false);
  });

  it("flags exact duplicate after recording", () => {
    const ds = new RecentSaves(30);
    ds.record("User prefers dark mode");
    expect(ds.isDuplicate("User prefers dark mode")).toBe(true);
  });

  it("flags near-duplicate with minor wording changes", () => {
    const ds = new RecentSaves(30);
    ds.record("User prefers dark mode for the IDE");
    expect(ds.isDuplicate("The user prefers dark mode for their IDE")).toBe(true);
  });

  it("does not flag unrelated text", () => {
    const ds = new RecentSaves(30);
    ds.record("User prefers dark mode");
    expect(ds.isDuplicate("The project uses PostgreSQL for the database")).toBe(false);
  });

  it("expires entries after window elapses", () => {
    const ds = new RecentSaves(5); // 5 minute window
    ds.record("User prefers dark mode");
    expect(ds.isDuplicate("User prefers dark mode")).toBe(true);

    // Advance past window
    vi.advanceTimersByTime(6 * 60_000);
    expect(ds.isDuplicate("User prefers dark mode")).toBe(false);
  });

  it("tracks size correctly with expiry", () => {
    const ds = new RecentSaves(5);
    ds.record("first memory");
    ds.record("second memory");
    expect(ds.size).toBe(2);

    vi.advanceTimersByTime(6 * 60_000);
    expect(ds.size).toBe(0);
  });

  it("strips metadata tags before comparing", () => {
    const ds = new RecentSaves(30);
    ds.record("[type:preference] [importance:high] User prefers dark mode");
    expect(ds.isDuplicate("User prefers dark mode")).toBe(true);
  });

  it("handles empty and very short text gracefully", () => {
    const ds = new RecentSaves(30);
    ds.record("hi");
    // Words <= 2 chars are filtered out, so this returns false (no words to compare)
    expect(ds.isDuplicate("hi")).toBe(false);
  });

  it("respects custom similarity threshold", () => {
    // Very strict threshold — only near-exact matches
    const strict = new RecentSaves(30, 0.95);
    strict.record("User prefers dark mode for the IDE and terminal");
    expect(strict.isDuplicate("User prefers dark mode for IDE")).toBe(false);

    // Lenient threshold
    const lenient = new RecentSaves(30, 0.4);
    lenient.record("User prefers dark mode for the IDE and terminal");
    expect(lenient.isDuplicate("User prefers dark mode for IDE")).toBe(true);
  });
});
