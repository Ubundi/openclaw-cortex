import { describe, it, expect } from "vitest";
import {
  isLowSignal,
  filterLowSignalMessages,
  filterLowSignalLines,
  sanitizeConversationText,
  stripPlaintextMetadataArtifacts,
  stripRuntimeMetadata,
  isVolatileStatement,
  stripVolatileStatements,
  stripVolatileContent,
} from "../../src/features/capture/filter.js";

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
    "User has a file named index.ts with permissions -rw-rw-r--, owned by user 'ubuntu', and group 'ubuntu', with a size of 1223 bytes, last modified on March 4 at 07:59.",
    "The directory 'feature-flags' has permissions drwxrwxr-x and was last modified on March 2 at 12:28.",
    "User has a directory named feature-flags with a size of 4096 bytes, last modified on March 2 at 12:28.",
    "Audit log enabled.\n\nAll data sent to and received from Cortex will be recorded locally.\nLog path: /home/ubuntu/.openclaw/workspace/.cortex/audit/\n\nTurn off with /audit off.",
    "**Cortex Audit Log**\n\n- Status: on\n- Log path: /home/ubuntu/.openclaw/workspace/.cortex/audit/\n\nToggle: /audit on · /audit off",
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
    "Show the Cortex Audit Log path in the status output and explain what gets recorded.",
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

describe("stripRuntimeMetadata", () => {
  it("strips conversation info metadata block", () => {
    const input = `Conversation info (untrusted metadata):\n\`\`\`json\n{\n  "message_id": "628",\n  "sender_id": "8798365142"\n}\n\`\`\`\n\nWhat is ubundi about?`;
    expect(stripRuntimeMetadata(input)).toBe("What is ubundi about?");
  });

  it("strips sender metadata block", () => {
    const input = `Sender (untrusted metadata):\n\`\`\`json\n{\n  "label": "Matthew Schramm",\n  "id": "123"\n}\n\`\`\`\n\nHello world`;
    expect(stripRuntimeMetadata(input)).toBe("Hello world");
  });

  it("strips timestamp-wrapped conversation info metadata blocks", () => {
    const input = [
      "[Thu 2026-03-19 09:28 UTC] conversation info:",
      "```json",
      '{"chatId":"abc123","sender":"benchmark","timestamp":"2026-03-19T09:30:00Z"}',
      "```",
      "",
      "RPCSAN-20260319 durable business fact goes here.",
    ].join("\n");

    expect(stripRuntimeMetadata(input)).toBe("RPCSAN-20260319 durable business fact goes here.");
  });

  it("strips both metadata blocks together", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "message_id": "628", "sender_id": "123", "sender": "Matt", "timestamp": "Sat 2026-03-07 20:14 UTC" }',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "Matt (123)", "id": "123", "name": "Matt" }',
      "```",
      "",
      "What is ubundi about?",
    ].join("\n");
    expect(stripRuntimeMetadata(input)).toBe("What is ubundi about?");
  });

  it("returns unchanged content when no metadata present", () => {
    const input = "What is ubundi about?";
    expect(stripRuntimeMetadata(input)).toBe("What is ubundi about?");
  });

  it("preserves content after metadata blocks", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "message_id": "1" }',
      "```",
      "",
      "First line of actual content.",
      "Second line of actual content.",
    ].join("\n");
    const result = stripRuntimeMetadata(input);
    expect(result).toContain("First line of actual content.");
    expect(result).toContain("Second line of actual content.");
    expect(result).not.toContain("message_id");
  });
});

describe("stripPlaintextMetadataArtifacts", () => {
  it("strips channel envelope headers and inline prefixes", () => {
    const input = [
      "[Telegram group chat with 4 participants]",
      "[Forwarded from Alex]",
      "What is an apple?",
      "[WhatsApp DM] Explain it simply",
    ].join("\n");

    expect(stripPlaintextMetadataArtifacts(input)).toBe("What is an apple?\nExplain it simply");
  });

  it("strips replying block content and preserves the live user message", () => {
    const input = [
      "[Replying to Matthew]",
      "What database do we use?",
      "[/Replying]",
      "How is it configured now?",
    ].join("\n");

    expect(stripPlaintextMetadataArtifacts(input)).toBe("How is it configured now?");
  });

  it("strips quoting block content and preserves the actual message body", () => {
    const input = [
      "[Quoting prior message]",
      "Old quoted text that should not become memory",
      "[/Quoting]",
      "What auth flow did we settle on?",
    ].join("\n");

    expect(stripPlaintextMetadataArtifacts(input)).toBe("What auth flow did we settle on?");
  });

  it("preserves literal bracketed content that is not a channel envelope", () => {
    const input = [
      "[Slack]",
      "webhook_url=https://example.com",
      "[Email] SMTP relay settings",
    ].join("\n");

    expect(stripPlaintextMetadataArtifacts(input)).toBe(input);
  });
});

describe("sanitizeConversationText", () => {
  it("strips mixed channel metadata, cortex blocks, and envelope artifacts together", () => {
    const input = [
      "<cortex_recovery>",
      "Warning",
      "</cortex_recovery>",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{ "id": "123" }',
      "```",
      "",
      "[Replying to Alex]",
      "Prior quoted content",
      "[/Replying]",
      "[Telegram group chat]",
      "What is an apple?",
    ].join("\n");

    expect(sanitizeConversationText(input)).toBe("What is an apple?");
  });

  it("strips timestamp-wrapped metadata fences before preserving user-authored content", () => {
    const input = [
      "[Thu 2026-03-19 09:28 UTC] conversation info:",
      "```json",
      '{"chatId":"abc123","sender":"benchmark","timestamp":"2026-03-19T09:30:00Z"}',
      "```",
      "",
      "[telegram group chat]",
      "RPCSAN-20260319 durable business fact goes here.",
    ].join("\n");

    expect(sanitizeConversationText(input)).toBe("RPCSAN-20260319 durable business fact goes here.");
  });

  it("preserves literal cortex tags when they are part of the user-authored body", () => {
    const input = [
      "Example markup to keep:",
      "<cortex_recovery>",
      "Warning",
      "</cortex_recovery>",
    ].join("\n");

    expect(sanitizeConversationText(input)).toBe(input);
  });

  it("strips ACP Source Receipt blocks prepended to user messages", () => {
    const input = [
      "[Source Receipt]",
      "bridge=openclaw-acp",
      "originHost=my-server",
      "originCwd=~/project",
      "acpSessionId=acp-session-1",
      "originSessionId=acp-session-1",
      "targetSession=agent:main:main",
      "[/Source Receipt]",
      "",
      "What is an apple?",
    ].join("\n");

    expect(sanitizeConversationText(input)).toBe("What is an apple?");
  });

  it("strips Source Receipt combined with cortex blocks and runtime metadata", () => {
    const input = [
      "<cortex_memories>",
      "Prior memory",
      "</cortex_memories>",
      "",
      "[Source Receipt]",
      "bridge=openclaw-acp",
      "[/Source Receipt]",
      "",
      "What is an apple?",
    ].join("\n");

    expect(sanitizeConversationText(input)).toBe("What is an apple?");
  });

  it("preserves Source Receipt text when it appears mid-body (not leading)", () => {
    const input = [
      "Here is an example receipt:",
      "[Source Receipt]",
      "bridge=openclaw-acp",
      "[/Source Receipt]",
    ].join("\n");

    expect(sanitizeConversationText(input)).toBe(input);
  });
});

describe("isVolatileStatement", () => {
  it.each([
    "We're on version 2.5.0",
    "The app is v3.1.2-beta",
    "Running node 20.11",
    "Running Python 3.12",
    "Task PROJ-123 is in progress",
    "PR #456 is pending",
    "Currently working on the auth refactor",
    "The service is currently running on port 3000",
    "Listening on port 8080",
    "PID is 12345",
    "Right now the tests are passing",
    "At the moment we use Redis",
    "The deploy is running",
    "Build is failing",
    "CI is green",
    "Pipeline is in progress",
    "Currently debugging the timeout issue",
    "The deployment is currently failing",
    "For now we're using the old endpoint",
    "As of now the service is stable",
  ])("returns true for volatile statement: %s", (sentence) => {
    expect(isVolatileStatement(sentence)).toBe(true);
  });

  it.each([
    "The user prefers TypeScript for all new projects",
    "We decided to use PostgreSQL over MySQL for data integrity reasons",
    "The auth flow uses JWT tokens with refresh rotation",
    "Matthew's birthday is March 10",
    "The project follows semver",
    "We use blue-green deployment strategy on ECS Fargate",
    "The team agreed to use Prettier with tab width 2",
    "Redis is used as the session store because of its TTL support",
    "The API uses rate limiting at 100 requests per minute",
    "Remember to always run migrations before deploying",
  ])("returns false for durable fact: %s", (sentence) => {
    expect(isVolatileStatement(sentence)).toBe(false);
  });

  it("returns false for very long sentences (>300 chars)", () => {
    const long = "Currently working on " + "a".repeat(300);
    expect(isVolatileStatement(long)).toBe(false);
  });
});

describe("stripVolatileStatements", () => {
  it("strips volatile sentences while preserving durable facts", () => {
    const text = "The user prefers dark mode. We're on version 2.5.0. The project uses React.";
    const result = stripVolatileStatements(text);
    expect(result).toContain("The user prefers dark mode");
    expect(result).toContain("The project uses React");
    expect(result).not.toContain("version 2.5.0");
  });

  it("preserves original text when nothing is volatile", () => {
    const text = "The user prefers TypeScript. The team uses PostgreSQL.";
    expect(stripVolatileStatements(text)).toBe(text);
  });

  it("returns original text when all sentences are volatile (never returns empty)", () => {
    const text = "Currently working on the fix. Build is failing.";
    const result = stripVolatileStatements(text);
    expect(result).toBe(text);
  });

  it("handles newline-separated content", () => {
    const text = "User prefers dark mode\nCurrently debugging the auth issue\nThe project uses ESM modules";
    const result = stripVolatileStatements(text);
    expect(result).toContain("User prefers dark mode");
    expect(result).toContain("The project uses ESM modules");
    expect(result).not.toContain("Currently debugging");
  });
});

describe("stripVolatileContent", () => {
  it("strips volatile statements from message content", () => {
    const messages = [
      { role: "user", content: "We're on version 2.5.0. I prefer using bun over npm." },
      { role: "assistant", content: "Got it, I'll use bun. Currently running the build." },
    ];
    const result = stripVolatileContent(messages);
    expect(result[0].content).toContain("I prefer using bun over npm");
    expect(result[0].content).not.toContain("version 2.5.0");
    expect(result[1].content).toContain("I'll use bun");
    expect(result[1].content).not.toContain("Currently running");
  });

  it("preserves messages with no volatile content unchanged", () => {
    const messages = [
      { role: "user", content: "The team decided to use Postgres." },
    ];
    const result = stripVolatileContent(messages);
    expect(result[0].content).toBe("The team decided to use Postgres.");
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
