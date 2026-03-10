import { describe, it, expect, beforeEach } from "vitest";
import { RecallEchoStore, ECHO_CONTAINMENT_THRESHOLD, toContentTokens } from "../../src/internal/recall-echo-store.js";

describe("RecallEchoStore", () => {
  let store: RecallEchoStore;

  beforeEach(() => {
    store = new RecallEchoStore();
  });

  it("returns false for empty store", () => {
    expect(store.isEcho("Happy birthday Adii, turning 45 today!")).toBe(false);
  });

  it("detects direct echo of recalled content", () => {
    store.storeRecalled(["Adii's birthday is March 10, 2026, turning 45"]);
    // Agent literally restates the recalled memory
    expect(store.isEcho("Adii's birthday is March 10, 2026, and he's turning 45")).toBe(true);
  });

  it("detects when agent explains/quotes its recalled memories", () => {
    // This is the most damaging amplification path: the agent references its own memories
    store.storeRecalled(["Adii's birthday is March 10, 2026. He is turning 45."]);
    const explanation =
      "That came from my Cortex memories — I have multiple entries claiming " +
      "'Adii's birthday is March 10, 2026, turning 45' and several about " +
      "a birthday message scheduled for 7am today.";
    expect(store.isEcho(explanation)).toBe(true);
  });

  it("does not flag unrelated content as echo", () => {
    store.storeRecalled(["Adii's birthday is March 10, turning 45"]);
    expect(store.isEcho("The deployment pipeline needs a new staging environment with Docker")).toBe(false);
  });

  it("does not flag content with minimal overlap", () => {
    store.storeRecalled(["Adii prefers flat whites from the café in Stellenbosch"]);
    expect(store.isEcho("Stellenbosch has great weather today, let's go for a walk in the park")).toBe(false);
  });

  it("handles multiple recalled memories", () => {
    store.storeRecalled([
      "Adii's birthday is March 10, turning 45",
      "The project deadline is next Friday for the release",
      "Adii prefers TypeScript over JavaScript for all projects",
    ]);
    // Direct restatement of deadline memory
    expect(store.isEcho("The project deadline for the release is next Friday, we need to prepare")).toBe(true);
    // Should not match anything
    expect(store.isEcho("Let's order pizza for lunch from the place downtown")).toBe(false);
  });

  it("ignores very short texts (< 3 content tokens)", () => {
    store.storeRecalled(["ok sure"]);
    expect(store.isEcho("ok sure")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("reports correct size", () => {
    expect(store.size).toBe(0);
    store.storeRecalled(["Adii's birthday is March 10, turning 45"]);
    expect(store.size).toBe(1);
    store.storeRecalled(["Another memory about something else entirely different"]);
    expect(store.size).toBe(2);
  });

  it("clear removes all entries", () => {
    store.storeRecalled(["Adii's birthday is March 10, turning 45"]);
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.isEcho("Adii's birthday is March 10, turning 45")).toBe(false);
  });

  it("maxContainment returns 0 for empty store", () => {
    expect(store.maxContainment("any text here about something")).toBe(0);
  });

  it("maxContainment returns score above threshold for direct echoes", () => {
    store.storeRecalled(["Adii's birthday is March 10, 2026, turning 45"]);
    const score = store.maxContainment("Adii's birthday is March 10, 2026. He's turning 45 years old!");
    expect(score).toBeGreaterThanOrEqual(ECHO_CONTAINMENT_THRESHOLD);
  });

  it("user corrections are not flagged as echoes", () => {
    store.storeRecalled(["Adii's birthday is March 10, 2026. He is turning 45."]);
    expect(store.isEcho("It is not my birthday today. Where did you find this information?")).toBe(false);
  });

  describe("toContentTokens", () => {
    it("extracts words and numbers", () => {
      const tokens = toContentTokens("Adii's 45th birthday on March 10, 2026");
      expect(tokens.has("adii")).toBe(true);
      expect(tokens.has("birthday")).toBe(true);
      expect(tokens.has("march")).toBe(true);
      expect(tokens.has("#45")).toBe(true);
      expect(tokens.has("#10")).toBe(true);
      expect(tokens.has("#2026")).toBe(true);
    });

    it("filters stop words", () => {
      const tokens = toContentTokens("the quick brown fox and the lazy dog");
      expect(tokens.has("the")).toBe(false);
      expect(tokens.has("and")).toBe(false);
      expect(tokens.has("quick")).toBe(true);
      expect(tokens.has("brown")).toBe(true);
    });

    it("ignores single-digit numbers", () => {
      const tokens = toContentTokens("step 1 and step 2");
      expect(tokens.has("#1")).toBe(false);
      expect(tokens.has("#2")).toBe(false);
    });
  });

  describe("feedback loop scenario", () => {
    it("catches agent self-referencing its recalled memories (main amplification path)", () => {
      // The most damaging capture: agent explains where it got the info, literally quoting the memory
      store.storeRecalled([
        "Adii's birthday is March 10, 2026. He is turning 45.",
        "Birthday message should be sent at 7am today for Adii.",
      ]);

      // Agent explains its sources — this contains near-verbatim memory content
      const selfReference =
        "I'm sorry, that came from my Cortex memories. I have multiple entries " +
        "claiming Adii's birthday is March 10, 2026, turning 45. " +
        "I should have verified before blurting out birthday wishes.";
      expect(store.isEcho(selfReference)).toBe(true);

      // User's correction should NOT be flagged
      expect(store.isEcho("It is not my birthday today. Where did you find this information?")).toBe(false);
    });

    it("allows genuinely new content alongside recalled topic", () => {
      store.storeRecalled([
        "Adii's birthday is March 10, 2026. He is turning 45.",
      ]);

      // Agent discusses something new — should NOT be blocked
      const newContent =
        "I reviewed the pull request and found three issues with the error handling. " +
        "The retry logic in the API client doesn't respect the backoff multiplier.";
      expect(store.isEcho(newContent)).toBe(false);
    });

    it("catches heartbeat status lines that parrot recalled facts", () => {
      store.storeRecalled([
        "Birthday message should be sent at 7am today for Adii's 45th birthday on March 10",
      ]);

      // Heartbeat status restating the recalled plan
      const heartbeatStatus = "Adii's 45th birthday today. Birthday message scheduled at 7am. No other tasks pending.";
      expect(store.isEcho(heartbeatStatus)).toBe(true);
    });
  });

  describe("containment asymmetry", () => {
    it("short memory echoed in long response is detected via sentence splitting", () => {
      store.storeRecalled(["Adii prefers TypeScript strict mode for all projects"]);
      const longResponse =
        "Based on my knowledge, Adii strongly prefers TypeScript with strict mode enabled " +
        "for all projects in the organization. This ensures type safety across the codebase.";
      expect(store.isEcho(longResponse)).toBe(true);
    });

    it("long memory partially echoed in short response is not detected", () => {
      store.storeRecalled([
        "Adii prefers TypeScript strict mode for all projects and uses " +
        "esbuild for bundling with vitest for testing and zod for validation",
      ]);
      // Only mentions TypeScript — not enough containment of the full memory
      const shortResponse = "TypeScript is great for this project";
      expect(store.isEcho(shortResponse)).toBe(false);
    });
  });
});
