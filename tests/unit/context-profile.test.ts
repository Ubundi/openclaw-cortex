import { describe, it, expect } from "vitest";
import { inferRecallProfile, getProfileParams } from "../../src/features/recall/context-profile.js";
import type { CortexConfig } from "../../src/plugin/config.js";

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    autoRecall: true,
    autoCapture: true,
    recallLimit: 10,
    recallQueryType: "combined",
    recallProfile: "auto",
    recallTimeoutMs: 500,
    fileSync: true,
    transcriptSync: true,
    ...overrides,
    namespace: overrides.namespace ?? "test",
  };
}

describe("inferRecallProfile", () => {
  describe("incident profile", () => {
    it.each([
      "there was an outage last night",
      "we have an incident in production",
      "the server is broken and returning 500s",
      "sev1 failure happening now",
      "need to rollback the deploy",
      "hotfix for the crash in auth",
      "error rate is spiking",
      "service is degraded",
      "there's a bug in the login flow",
    ])("classifies '%s' as incident", (prompt) => {
      expect(inferRecallProfile(prompt)).toBe("incident");
    });
  });

  describe("handoff profile", () => {
    it.each([
      "let's resume where we left off",
      "continue the migration work",
      "handoff from the previous session",
      "pick up the refactoring task",
      "where was I on the auth feature?",
      "where did I leave off?",
      "what was I working on last session",
    ])("classifies '%s' as handoff", (prompt) => {
      expect(inferRecallProfile(prompt)).toBe("handoff");
    });
  });

  describe("planning profile", () => {
    it.each([
      "let's plan the new authentication system",
      "what's the architecture for the API?",
      "create a roadmap for the migration",
      "write a proposal for the new feature",
      "how should we approach the redesign?",
      "what's the strategy for scaling?",
      "design the database schema",
    ])("classifies '%s' as planning", (prompt) => {
      expect(inferRecallProfile(prompt)).toBe("planning");
    });
  });

  describe("factual profile", () => {
    it.each([
      "what is the database port?",
      "what was the TTL we decided on?",
      "which version of Node are we using?",
      "how many replicas are configured?",
      "what is the timeout setting?",
      "what is the API endpoint for auth?",
    ])("classifies '%s' as factual", (prompt) => {
      expect(inferRecallProfile(prompt)).toBe("factual");
    });
  });

  describe("default profile", () => {
    it.each([
      "tell me about the project",
      "help me write a function",
      "refactor this code",
      "explain how this works",
    ])("classifies '%s' as default", (prompt) => {
      expect(inferRecallProfile(prompt)).toBe("default");
    });
  });

  it("uses first-match priority (incident before factual)", () => {
    // "error" matches incident, "what is" matches factual — incident wins
    expect(inferRecallProfile("what is causing this error?")).toBe("incident");
  });

  it("uses first-match priority (handoff before planning)", () => {
    // "resume" matches handoff, "plan" matches planning — handoff wins
    expect(inferRecallProfile("resume the planning session")).toBe("handoff");
  });
});

describe("getProfileParams", () => {
  const config = makeConfig();

  it("returns incident params with doubled limit", () => {
    const params = getProfileParams("incident", config);
    expect(params.queryType).toBe("factual");
    expect(params.limit).toBe(20); // 10 * 2
    expect(params.minConfidence).toBe(0.3);
    expect(params.context).toBeUndefined();
  });

  it("caps incident limit at 50", () => {
    const params = getProfileParams("incident", makeConfig({ recallLimit: 30 }));
    expect(params.limit).toBe(50);
  });

  it("returns handoff params with context hint", () => {
    const params = getProfileParams("handoff", config);
    expect(params.queryType).toBe("combined");
    expect(params.limit).toBe(10);
    expect(params.context).toContain("session handoff");
    expect(params.minConfidence).toBeUndefined();
  });

  it("returns planning params with 1.5x limit", () => {
    const params = getProfileParams("planning", config);
    expect(params.queryType).toBe("combined");
    expect(params.limit).toBe(15); // ceil(10 * 1.5)
    expect(params.context).toContain("architecture");
    expect(params.minConfidence).toBeUndefined();
  });

  it("caps planning limit at 50", () => {
    const params = getProfileParams("planning", makeConfig({ recallLimit: 40 }));
    expect(params.limit).toBe(50);
  });

  it("returns factual params with relaxed confidence floor", () => {
    const params = getProfileParams("factual", config);
    expect(params.queryType).toBe("factual");
    expect(params.limit).toBe(10);
    expect(params.minConfidence).toBe(0.3);
    expect(params.context).toBeUndefined();
  });

  it("passes factual conversation context when provided", () => {
    const params = getProfileParams("factual", config, "user: what port are we using?");
    expect(params.queryType).toBe("factual");
    expect(params.limit).toBe(10);
    expect(params.minConfidence).toBe(0.3);
    expect(params.context).toBe("user: what port are we using?");
  });

  it("returns default params from config", () => {
    const params = getProfileParams("default", config);
    expect(params.queryType).toBe("combined");
    expect(params.limit).toBe(10);
    expect(params.context).toBeUndefined();
    expect(params.minConfidence).toBeUndefined();
  });

  it("default profile respects custom recallQueryType", () => {
    const params = getProfileParams("default", makeConfig({ recallQueryType: "codex" }));
    expect(params.queryType).toBe("codex");
  });
});
