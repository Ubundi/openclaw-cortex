import { describe, it, expect } from "vitest";
import { cleanTranscript, cleanTranscriptChunk } from "../../src/internal/transcript/cleaner.js";

describe("cleanTranscript", () => {
  it("extracts user and assistant messages", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "What database do we use?" }),
      JSON.stringify({ role: "assistant", content: "PostgreSQL with pgvector." }),
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([
      { role: "user", content: "What database do we use?" },
      { role: "assistant", content: "PostgreSQL with pgvector." },
    ]);
  });

  it("strips system prompt messages", () => {
    const jsonl = [
      JSON.stringify({ role: "system", content: "You are a helpful assistant..." }),
      JSON.stringify({ role: "developer", content: "Internal instructions..." }),
      JSON.stringify({ role: "user", content: "Hello" }),
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("strips tool call and tool result messages", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "Read the file" }),
      JSON.stringify({ role: "assistant", content: "Let me read that.", tool_calls: [{ id: "tc1", function: { name: "read" } }] }),
      JSON.stringify({ role: "tool", tool_call_id: "tc1", content: "file contents here" }),
      JSON.stringify({ role: "assistant", content: "The file contains configuration data." }),
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "Read the file" });
    // Assistant message with tool_calls is kept because it also has text content
    expect(result[1]).toEqual({ role: "assistant", content: "Let me read that." });
    expect(result[2]).toEqual({ role: "assistant", content: "The file contains configuration data." });
  });

  it("strips tool-only assistant messages (no text content)", () => {
    const jsonl = [
      JSON.stringify({ role: "assistant", tool_calls: [{ id: "tc1" }] }),
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([]);
  });

  it("strips base64 images from content", () => {
    const longBase64 = "A".repeat(200);
    const jsonl = JSON.stringify({
      role: "user",
      content: `Check this image: data:image/png;base64,${longBase64} and tell me what it shows`,
    });

    const result = cleanTranscript(jsonl);
    expect(result[0].content).toBe("Check this image: [base64 image] and tell me what it shows");
  });

  it("handles array content blocks", () => {
    const jsonl = JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "Here is the answer." },
        { type: "image", data: "..." },
        { type: "text", text: "More details." },
      ],
    });

    const result = cleanTranscript(jsonl);
    expect(result[0].content).toBe("Here is the answer.\nMore details.");
  });

  it("skips malformed JSONL lines", () => {
    const jsonl = [
      "not json at all",
      JSON.stringify({ role: "user", content: "Valid message" }),
      "{ broken json",
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([{ role: "user", content: "Valid message" }]);
  });

  it("skips empty content messages", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "" }),
      JSON.stringify({ role: "assistant", content: "   " }),
      JSON.stringify({ role: "user", content: "Real message" }),
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([{ role: "user", content: "Real message" }]);
  });
});

describe("cleanTranscriptChunk", () => {
  it("reports worth ingesting when user+assistant exchange exists", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "What is the deployment strategy for the backend?" }),
      JSON.stringify({ role: "assistant", content: "We use blue-green deployment on ECS Fargate." }),
    ].join("\n");

    const result = cleanTranscriptChunk(jsonl);
    expect(result.worthIngesting).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  it("reports not worth ingesting for short exchanges", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "hi" }),
      JSON.stringify({ role: "assistant", content: "hello" }),
    ].join("\n");

    const result = cleanTranscriptChunk(jsonl);
    expect(result.worthIngesting).toBe(false);
  });

  it("reports not worth ingesting for system-only content", () => {
    const jsonl = JSON.stringify({ role: "system", content: "You are a helpful assistant" });

    const result = cleanTranscriptChunk(jsonl);
    expect(result.worthIngesting).toBe(false);
    expect(result.messages).toHaveLength(0);
  });

  it("reports not worth ingesting when only user messages (no assistant)", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "What is the deployment strategy for our backend?" }),
    ].join("\n");

    const result = cleanTranscriptChunk(jsonl);
    expect(result.worthIngesting).toBe(false);
    expect(result.messages).toHaveLength(1);
  });
});

describe("cleanTranscript edge cases", () => {
  it("skips messages with non-string non-array content", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: 12345 }),
      JSON.stringify({ role: "assistant", content: { nested: true } }),
      JSON.stringify({ role: "user", content: "Real message" }),
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([{ role: "user", content: "Real message" }]);
  });

  it("skips messages that are purely base64 images after stripping", () => {
    const longBase64 = "A".repeat(200);
    const jsonl = JSON.stringify({
      role: "user",
      content: `data:image/png;base64,${longBase64}`,
    });

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([]);
  });

  it("handles empty lines in JSONL", () => {
    const jsonl = [
      "",
      JSON.stringify({ role: "user", content: "Hello there" }),
      "   ",
      "",
    ].join("\n");

    const result = cleanTranscript(jsonl);
    expect(result).toEqual([{ role: "user", content: "Hello there" }]);
  });
});
