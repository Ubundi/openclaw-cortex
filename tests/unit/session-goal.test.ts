import { describe, it, expect } from "vitest";
import { SessionGoalStore } from "../../src/internal/session-goal.js";

describe("SessionGoalStore", () => {
  it("starts empty", () => {
    const store = new SessionGoalStore();
    expect(store.get()).toBeUndefined();
  });

  it("stores and retrieves a goal", () => {
    const store = new SessionGoalStore();
    store.set({ goal: "Implement OAuth2", setAt: "2026-03-16T10:00:00Z", setBy: "agent" });
    expect(store.get()).toEqual({
      goal: "Implement OAuth2",
      setAt: "2026-03-16T10:00:00Z",
      setBy: "agent",
    });
  });

  it("overwrites a previous goal", () => {
    const store = new SessionGoalStore();
    store.set({ goal: "First goal", setAt: "2026-03-16T10:00:00Z", setBy: "agent" });
    store.set({ goal: "Second goal", setAt: "2026-03-16T11:00:00Z", setBy: "user" });
    expect(store.get()?.goal).toBe("Second goal");
    expect(store.get()?.setBy).toBe("user");
  });

  it("clears the goal", () => {
    const store = new SessionGoalStore();
    store.set({ goal: "Something", setAt: "2026-03-16T10:00:00Z", setBy: "agent" });
    store.clear();
    expect(store.get()).toBeUndefined();
  });

  it("clear is idempotent", () => {
    const store = new SessionGoalStore();
    store.clear();
    expect(store.get()).toBeUndefined();
  });
});
