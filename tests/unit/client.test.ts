import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CortexClient } from "../../src/cortex/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const MOCK_INGEST_RESPONSE = {
  nodes_created: 1,
  edges_created: 1,
  facts: [{ core: "test fact", fact_type: "world", occurred_at: null, entity_refs: [], speaker: "user" }],
  entities: [],
};

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
        json: async () => ({ results: [] }),
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
      expect(result).toEqual({ results: [] });
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
        json: async () => MOCK_INGEST_RESPONSE,
      });

      const result = await client.ingest("some fact", "session-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/ingest",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "some fact", session_id: "session-1", reference_date: null }),
        }),
      );
      expect(result.nodes_created).toBe(1);
      expect(result.facts).toHaveLength(1);
    });

    it("aborts on timeout with AbortError", async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );

      await expect(client.ingest("text", "s1", 10)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("ingestConversation", () => {
    it("sends messages array", async () => {
      const response = { ...MOCK_INGEST_RESPONSE, nodes_created: 2, facts: [MOCK_INGEST_RESPONSE.facts[0], MOCK_INGEST_RESPONSE.facts[0]] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => response,
      });

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const result = await client.ingestConversation(messages, "sess-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/ingest/conversation",
        expect.objectContaining({
          body: JSON.stringify({ messages, session_id: "sess-1", reference_date: null }),
        }),
      );
      expect(result.facts).toHaveLength(2);
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

      await expect(
        client.ingestConversation([{ role: "user", content: "hi" }], "s1", 10),
      ).rejects.toThrow();
    });
  });

  describe("reflect", () => {
    it("sends reflect request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ synthesized_count: 3, superseded_count: 1 }),
      });

      const result = await client.reflect("sess-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/reflect",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ session_id: "sess-1" }),
        }),
      );
      expect(result.synthesized_count).toBe(3);
    });

    it("aborts on timeout with AbortError", async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );

      await expect(client.reflect("s1", 10)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("error status codes", () => {
    it("throws with status code for 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      await expect(client.retrieve("q", 5, "fast", 500)).rejects.toThrow("Cortex retrieve failed: 401");
    });

    it("throws with status code for 403 Forbidden", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
      await expect(client.ingest("text", "s1")).rejects.toThrow("Cortex ingest failed: 403");
    });

    it("throws with status code for 429 Too Many Requests", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
      await expect(client.ingestConversation([{ role: "user", content: "hi" }], "s1")).rejects.toThrow("Cortex ingest/conversation failed: 429");
    });
  });

  describe("optional sessionId", () => {
    it("ingest without sessionId omits session_id from body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_INGEST_RESPONSE,
      });

      await client.ingest("some text");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ text: "some text", session_id: undefined, reference_date: null });
    });

    it("reflect without sessionId omits session_id from body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ synthesized_count: 0, superseded_count: 0 }),
      });

      await client.reflect();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ session_id: undefined });
    });
  });
});
