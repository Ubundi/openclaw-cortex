import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CortexClient } from "../../src/cortex/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const MOCK_REMEMBER_RESPONSE = {
  session_id: "session-1",
  memories_created: 2,
  entities_found: ["TypeScript"],
  facts: ["User likes TypeScript"],
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

  describe("recall", () => {
    it("sends correct request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      const result = await client.recall("test query", 500);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/recall",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-api-key": "sk-test-key",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ query: "test query" }),
        }),
      );
      expect(result).toEqual({ memories: [] });
    });

    it("sends limit and context when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      await client.recall("test query", 500, { limit: 5, context: "some context" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBe(5);
      expect(body.context).toBe("some context");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(client.recall("q", 500)).rejects.toThrow(
        "Cortex recall failed: 500",
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

      await expect(client.recall("q", 10)).rejects.toThrow();
    });
  });

  describe("remember", () => {
    it("sends text with session id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_RESPONSE,
      });

      const result = await client.remember("some fact", "session-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/remember",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "some fact", session_id: "session-1", reference_date: null }),
        }),
      );
      expect(result.memories_created).toBe(2);
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

      await expect(client.remember("text", "s1", 10)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("rememberConversation", () => {
    it("sends messages array", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_RESPONSE,
      });

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const result = await client.rememberConversation(messages, "sess-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/remember",
        expect.objectContaining({
          body: JSON.stringify({ messages, session_id: "sess-1", reference_date: null }),
        }),
      );
      expect(result.memories_created).toBe(2);
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
        client.rememberConversation([{ role: "user", content: "hi" }], "s1", 10),
      ).rejects.toThrow();
    });
  });

  describe("forgetSession", () => {
    it("sends DELETE to correct URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_removed: 5 }),
      });

      const result = await client.forgetSession("sess-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/forget/session/sess-1",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(result.memories_removed).toBe(5);
    });
  });

  describe("forgetEntity", () => {
    it("sends DELETE with URL-encoded entity name", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_removed: 3 }),
      });

      const result = await client.forgetEntity("Acme Corp");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/forget/entity/Acme%20Corp",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(result.memories_removed).toBe(3);
    });
  });

  describe("knowledge", () => {
    it("fetches knowledge summary", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ total_memories: 100, total_sessions: 10, maturity: "mature", entities: [] }),
      });

      const result = await client.knowledge();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/knowledge",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.total_memories).toBe(100);
      expect(result.maturity).toBe("mature");
    });
  });

  describe("error status codes", () => {
    it("throws with status code for 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      await expect(client.recall("q", 500)).rejects.toThrow("Cortex recall failed: 401");
    });

    it("throws with status code for 403 Forbidden", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
      await expect(client.remember("text", "s1")).rejects.toThrow("Cortex remember failed: 403");
    });

    it("throws with status code for 429 Too Many Requests", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
      await expect(client.rememberConversation([{ role: "user", content: "hi" }], "s1")).rejects.toThrow("Cortex remember failed: 429");
    });
  });

  describe("optional sessionId", () => {
    it("remember without sessionId sends null session_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_RESPONSE,
      });

      await client.remember("some text");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ text: "some text", session_id: null, reference_date: null });
    });
  });
});
