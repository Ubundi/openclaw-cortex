import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CortexClient } from "../src/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("CortexClient", () => {
  let client: CortexClient;

  beforeEach(() => {
    client = new CortexClient("https://api.example.com", "sk-test-key");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("retrieve", () => {
    it("sends correct request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], query: "test", mode: "fast" }),
      });

      const result = await client.retrieve("test query", 5, "fast", 500);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/retrieve",
        expect.objectContaining({
          method: "POST",
          headers: {
            "x-api-key": "sk-test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: "test query", top_k: 5, mode: "fast" }),
        }),
      );
      expect(result).toEqual({ results: [], query: "test", mode: "fast" });
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(client.retrieve("q", 5, "fast", 500)).rejects.toThrow(
        "Cortex retrieve failed: 500",
      );
    });

    it("aborts on timeout", async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );

      await expect(client.retrieve("q", 5, "fast", 10)).rejects.toThrow();
    });
  });

  describe("ingest", () => {
    it("sends text with session id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fact_ids: ["f1"], entity_count: 1 }),
      });

      const result = await client.ingest("some fact", "session-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/ingest",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "some fact", session_id: "session-1" }),
        }),
      );
      expect(result.fact_ids).toEqual(["f1"]);
    });
  });

  describe("ingestConversation", () => {
    it("sends messages array", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fact_ids: ["f1", "f2"], entity_count: 2 }),
      });

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const result = await client.ingestConversation(messages, "sess-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/ingest/conversation",
        expect.objectContaining({
          body: JSON.stringify({ messages, session_id: "sess-1" }),
        }),
      );
      expect(result.fact_ids).toHaveLength(2);
    });
  });
});
