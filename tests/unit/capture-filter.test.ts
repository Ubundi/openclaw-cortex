import { describe, it, expect } from "vitest";
import { isLowSignal, filterLowSignalMessages, filterLowSignalLines } from "../../src/features/capture/filter.js";

describe("isLowSignal", () => {
  it.each([
    "HEARTBEAT_OK",
    "heartbeat ok",
    "HEARTBEAT OK",
    "task completed at 1709312400",
    "status: idle",
    "status: connected",
    "status: ok",
    "status: ready",
    "ok",
    "done",
    "yes",
    "no",
    "sure",
    "thanks",
    "got it",
    "acknowledged",
    "ok.",
    "done.",
    "2026-03-01T14:30:00Z",
    "[2026-03-01 14:30:00]",
    "2026-03-01 14:30:00.000",
    "agent rune | session abc123 | anthropic/claude-3-opus",
    "─────────────────────",
    "━━━━━━━━━━━━━━━━━━━━",
    "══════════════════════",
    "connected | idle",
    "tokens 45k/100k (45%)",
    "tokens 1200/4096 (29%)",
    "",
    "   ",
  ])("returns true for low-signal content: %s", (content) => {
    expect(isLowSignal(content)).toBe(true);
  });

  it.each([
    "The user prefers TypeScript for all new projects",
    "Deployed the backend to ECS Fargate with blue-green strategy",
    "Bug fix: resolved null pointer in auth middleware",
    "Remember to use bun instead of npm for this project",
    "The database migration script needs to handle rollback scenarios",
    "status: the deployment is currently failing due to memory limits",
  ])("returns false for substantive content: %s", (content) => {
    expect(isLowSignal(content)).toBe(false);
  });
});

describe("filterLowSignalMessages", () => {
  it("removes messages with low-signal content", () => {
    const messages = [
      { role: "user", content: "What is the deployment strategy for our backend?" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "assistant", content: "The backend uses blue-green deployment on ECS Fargate." },
      { role: "user", content: "ok" },
    ];

    const filtered = filterLowSignalMessages(messages);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].content).toContain("deployment strategy");
    expect(filtered[1].content).toContain("blue-green");
  });

  it("returns empty array when all messages are noise", () => {
    const messages = [
      { role: "user", content: "ok" },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ];

    expect(filterLowSignalMessages(messages)).toHaveLength(0);
  });

  it("preserves all messages when none are noise", () => {
    const messages = [
      { role: "user", content: "Explain the authentication flow" },
      { role: "assistant", content: "The auth flow uses JWT tokens with refresh rotation" },
    ];

    expect(filterLowSignalMessages(messages)).toHaveLength(2);
  });
});

describe("filterLowSignalLines", () => {
  it("strips low-signal lines from text blocks", () => {
    const text = [
      "User prefers TypeScript",
      "HEARTBEAT_OK",
      "The project uses PostgreSQL",
      "connected | idle",
      "tokens 45k/100k (45%)",
    ].join("\n");

    const result = filterLowSignalLines(text);
    expect(result).toContain("User prefers TypeScript");
    expect(result).toContain("The project uses PostgreSQL");
    expect(result).not.toContain("HEARTBEAT_OK");
    expect(result).not.toContain("connected | idle");
    expect(result).not.toContain("tokens");
  });

  it("returns empty string when all lines are noise", () => {
    const text = "HEARTBEAT_OK\nok\ndone\n";
    const result = filterLowSignalLines(text);
    expect(result.trim()).toBe("");
  });

  it("preserves text when no lines are noise", () => {
    const text = "User prefers dark mode\nProject uses React and Next.js";
    expect(filterLowSignalLines(text)).toBe(text);
  });

  it("handles TUI status bar lines", () => {
    const text = "agent rune-x | session s-123 | anthropic/claude-3-opus\nReal substantive content here";
    const result = filterLowSignalLines(text);
    expect(result).not.toContain("agent rune-x");
    expect(result).toContain("Real substantive content here");
  });

  it("handles decorative rule lines", () => {
    const text = "# Section Header\n━━━━━━━━━━━━━━━━━━━━\nActual content";
    const result = filterLowSignalLines(text);
    expect(result).not.toContain("━━━━");
    expect(result).toContain("# Section Header");
    expect(result).toContain("Actual content");
  });
});
