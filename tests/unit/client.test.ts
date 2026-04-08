import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CortexClient } from "../../src/cortex/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const MOCK_REMEMBER_ACCEPTED = {
  session_id: "session-1",
  status: "accepted",
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

    it("sends session_filter when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      await client.recall("test query", 500, { sessionFilter: "session-123" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.session_filter).toBe("session-123");
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
    it("sends text with session id (async, no sync=true)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_ACCEPTED,
      });

      const result = await client.remember("some fact", "session-1", undefined, undefined, "user-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/remember",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            text: "some fact",
            session_id: "session-1",
            reference_date: null,
            user_id: "user-123",
            source_origin: "openclaw",
            derivation_mode: "inferred",
            source_app: "OpenClaw",
          }),
        }),
      );
      expect(result.session_id).toBe("session-1");
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

      await expect(client.remember("text", "s1", 10, undefined, "user-1")).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("rememberConversation", () => {
    it("sends messages array (async, no sync=true)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_ACCEPTED,
      });

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const result = await client.rememberConversation(messages, "sess-1", undefined, undefined, "user-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/remember",
        expect.objectContaining({
          body: JSON.stringify({
            messages,
            session_id: "sess-1",
            reference_date: null,
            user_id: "user-123",
            source_origin: "openclaw",
            derivation_mode: "inferred",
            source_app: "OpenClaw",
          }),
        }),
      );
      expect(result.session_id).toBe("session-1");
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
        client.rememberConversation([{ role: "user", content: "hi" }], "s1", 10, undefined, "user-1"),
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

      const result = await client.knowledge("user-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/knowledge?user_id=user-123",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.total_memories).toBe(100);
      expect(result.maturity).toBe("mature");
    });

    it("throws before sending request when user id is missing", async () => {
      await expect(client.knowledge("" as string)).rejects.toThrow("Cortex inspect requires user_id");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getNode", () => {
    it("fetches node details by id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          node_id: "node-1",
          type: "FACT",
          content: "User prefers TypeScript",
          confidence: 0.91,
          related_nodes: [],
          related_edges: [],
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-02T10:00:00Z",
        }),
      });

      const result = await client.getNode("node-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/nodes/node-1",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.node_id).toBe("node-1");
      expect(result.content).toBe("User prefers TypeScript");
    });

    it("throws on unknown node id", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(client.getNode("missing-node")).rejects.toThrow("Cortex nodes failed: 404");
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

      await expect(client.getNode("node-1", 10)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("whoami", () => {
    it("sends GET to /v1/keys/whoami", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          key_type: "scoped",
          tenant_id: "tenant-1",
          user_id: "user-123",
          permissions: ["read", "write"],
        }),
      });

      const result = await client.whoami();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/keys/whoami",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.key_type).toBe("scoped");
      expect(result.user_id).toBe("user-123");
      expect(result.permissions).toEqual(["read", "write"]);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      await expect(client.whoami()).rejects.toThrow("Cortex keys/whoami failed: 401");
    });
  });

  describe("error status codes", () => {
    it("throws with status code for 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      await expect(client.recall("q", 500)).rejects.toThrow("Cortex recall failed: 401");
    });

    it("throws user-facing error when 403 indicates scoped key bound to different user", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Scoped key is bound to a different user_id",
      });
      await expect(client.recall("q", 500)).rejects.toThrow(
        "API key is scoped to a different user",
      );
    });

    it("throws user-facing error when 403 indicates missing permission", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Key lacks 'write' permission",
      });
      await expect(client.remember("text", "s1", undefined, undefined, "user-1")).rejects.toThrow(
        "Key lacks 'write' permission",
      );
    });

    it("throws generic 403 when body does not match scoped-key patterns", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });
      await expect(client.remember("text", "s1", undefined, undefined, "user-1")).rejects.toThrow("Cortex remember failed: 403");
    });

    it("throws with status code for 429 Too Many Requests", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
      await expect(client.rememberConversation([{ role: "user", content: "hi" }], "s1", undefined, undefined, "user-1")).rejects.toThrow("Cortex remember failed: 429");
    });
  });

  describe("optional sessionId", () => {
    it("remember without sessionId sends null session_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_ACCEPTED,
      });

      await client.remember("some text", undefined, undefined, undefined, "user-abc");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        text: "some text",
        session_id: null,
        reference_date: null,
        user_id: "user-abc",
        source_origin: "openclaw",
        derivation_mode: "inferred",
        source_app: "OpenClaw",
      });
    });
  });

  describe("ingest provenance", () => {
    it("includes required provenance fields in remember body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_ACCEPTED,
      });

      await client.remember("some fact", "sess-1", undefined, undefined, "user-abc");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.user_id).toBe("user-abc");
      expect(body.source_origin).toBe("openclaw");
      expect(body.derivation_mode).toBe("inferred");
      expect(body.source_app).toBe("OpenClaw");
    });

    it("throws before request when remember user_id is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REMEMBER_ACCEPTED,
      });

      await expect(client.remember("some fact", "sess-1")).rejects.toThrow("Cortex ingest requires user_id");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws before request when rememberConversation user_id is missing", async () => {
      await expect(
        client.rememberConversation([{ role: "user", content: "hello there" }], "sess-1"),
      ).rejects.toThrow("Cortex ingest requires user_id");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("includes required provenance fields in ingest variants", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes_created: 1, edges_created: 0, facts: [], entities: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes_created: 1, edges_created: 0, facts: [], entities: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "job-1", status: "pending" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "job-2", status: "pending" }) });

      await client.ingest("plain text", "s1", undefined, undefined, "user-1");
      await client.ingestConversation([{ role: "user", content: "hello world" }], "s1", undefined, undefined, "user-1");
      await client.submitIngest("plain text", "s1", undefined, "user-1");
      await client.submitIngestConversation([{ role: "user", content: "hello world" }], "s1", undefined, "user-1");

      for (let i = 0; i < 4; i++) {
        const body = JSON.parse(mockFetch.mock.calls[i][1].body);
        expect(body.user_id).toBe("user-1");
        expect(body.source_origin).toBe("openclaw");
        expect(body.derivation_mode).toBe("inferred");
        expect(body.source_app).toBe("OpenClaw");
      }
    });

    it("includes required provenance fields in batch ingest items", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [],
          total_nodes_created: 0,
          total_edges_created: 0,
          failed_count: 0,
          errors: [],
        }),
      });

      await client.batchIngest([{ text: "line one" }, { text: "line two", user_id: "per-item-user" }], undefined, "fallback-user");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.items[0].user_id).toBe("fallback-user");
      expect(body.items[0].source_origin).toBe("openclaw");
      expect(body.items[0].derivation_mode).toBe("inferred");
      expect(body.items[0].source_app).toBe("OpenClaw");
      expect(body.items[1].user_id).toBe("per-item-user");
      expect(body.items[1].source_origin).toBe("openclaw");
      expect(body.items[1].derivation_mode).toBe("inferred");
      expect(body.items[1].source_app).toBe("OpenClaw");
    });

    it("throws before request when ingest user_id is missing", async () => {
      await expect(client.ingest("plain text")).rejects.toThrow("Cortex ingest requires user_id");
      await expect(client.ingestConversation([{ role: "user", content: "hello world" }])).rejects.toThrow("Cortex ingest requires user_id");
      await expect(client.submitIngest("plain text")).rejects.toThrow("Cortex ingest requires user_id");
      await expect(client.submitIngestConversation([{ role: "user", content: "hello world" }])).rejects.toThrow("Cortex ingest requires user_id");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws before request when batch ingest item user_id is missing", async () => {
      await expect(client.batchIngest([{ text: "line one" }])).rejects.toThrow("Cortex ingest/batch item 0 missing user_id");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("includes user_id in recall options when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      await client.recall("query", 500, { userId: "user-abc", queryType: "factual" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.user_id).toBe("user-abc");
      expect(body.query_type).toBe("factual");
    });

    it("includes codex filter params in recall when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      await client.recall("query", 500, {
        queryType: "codex",
        includeOrigins: ["transcript"],
        excludeOrigins: ["manual"],
        derivationMode: "extracted",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query_type).toBe("codex");
      expect(body.include_origins).toEqual(["transcript"]);
      expect(body.exclude_origins).toEqual(["manual"]);
      expect(body.derivation_mode).toBe("extracted");
    });

    it("includes memory_type in recall when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      await client.recall("query", 500, { memoryType: "preference" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.memory_type).toBe("preference");
    });

    it("omits codex filter params from recall when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [] }),
      });

      await client.recall("query", 500, { limit: 5 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("include_origins");
      expect(body).not.toHaveProperty("exclude_origins");
      expect(body).not.toHaveProperty("derivation_mode");
    });
  });

  describe("generatePairingCode", () => {
    it("sends correct request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_code: "WOLF-3847", expires_in: 900, expires_at: "2026-03-04T12:00:00Z" }),
      });

      const result = await client.generatePairingCode("agent-uuid-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/auth/code",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ agent_user_id: "agent-uuid-123" }),
        }),
      );
      expect(result.user_code).toBe("WOLF-3847");
      expect(result.expires_in).toBe(900);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(client.generatePairingCode("agent-uuid-123")).rejects.toThrow(
        "Cortex auth/code failed: 500",
      );
    });
  });

  describe("getLinkStatus", () => {
    it("sends GET request with agent_user_id query param", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ linked: true, link: { tootoo_user_id: "tt-user-1", linked_at: "2026-03-01T10:00:00Z" } }),
      });

      const result = await client.getLinkStatus("agent-uuid-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/auth/link?agent_user_id=agent-uuid-123",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.linked).toBe(true);
      expect(result.link?.tootoo_user_id).toBe("tt-user-1");
    });

    it("returns linked=false when not linked", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ linked: false }),
      });

      const result = await client.getLinkStatus("agent-uuid-123");
      expect(result.linked).toBe(false);
      expect(result.link).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(client.getLinkStatus("agent-uuid-123")).rejects.toThrow(
        "Cortex auth/link failed: 500",
      );
    });
  });

  describe("submitBridgeQA", () => {
    it("sends the discovery Q&A payload to the bridge endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accepted: true,
          forwarded: true,
          queued_for_retry: false,
          entries_sent: 1,
          tootoo_user_id: "tt-user-1",
          bridge_event_id: "bridge-event-1",
          suggestions_created: 2,
        }),
      });

      const result = await client.submitBridgeQA({
        user_id: "agent-user-1",
        request_id: "openclaw-bridge-123",
        entries: [
          {
            question: "What do you value most in your work?",
            answer: "Autonomy and creative freedom.",
            target_section: "coreValues",
          },
        ],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/bridge/qa",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "agent-user-1",
            request_id: "openclaw-bridge-123",
            entries: [
              {
                question: "What do you value most in your work?",
                answer: "Autonomy and creative freedom.",
                target_section: "coreValues",
              },
            ],
          }),
        }),
      );
      expect(result.accepted).toBe(true);
      expect(result.suggestions_created).toBe(2);
    });

    it("throws on bridge endpoint errors", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      await expect(
        client.submitBridgeQA({
          user_id: "agent-user-1",
          request_id: "openclaw-bridge-123",
          entries: [
            {
              question: "What do you value most in your work?",
              answer: "Autonomy and creative freedom.",
              target_section: "coreValues",
            },
          ],
        }),
      ).rejects.toThrow("Cortex bridge/qa failed: 503");
    });
  });

  describe("reflect", () => {
    it("sends empty body to jobs/reflect", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ job_id: "reflect-1", status: "pending" }),
      });

      const result = await client.reflect();

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("/v1/jobs/reflect");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({});
      expect(result.job_id).toBe("reflect-1");
    });
  });
});
