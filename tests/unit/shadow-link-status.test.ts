import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CortexClient } from "../../src/cortex/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("shadow-owner link status compatibility", () => {
  let client: CortexClient;

  beforeEach(() => {
    client = new CortexClient("https://api.example.com", "sk-test-key");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps legacy link payload compatibility", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        linked: true,
        link: {
          tootoo_user_id: "tt-user-1",
          linked_at: "2026-03-01T10:00:00Z",
        },
      }),
    });

    const result = await client.getLinkStatus("agent-legacy-1");

    expect(result.linked).toBe(true);
    expect(result.link?.tootoo_user_id).toBe("tt-user-1");
    expect(result.link?.linked_at).toBe("2026-03-01T10:00:00Z");
    expect(result.link?.owner_type).toBeUndefined();
  });

  it("accepts shadow-owner link payloads where tootoo_user_id is null", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        linked: true,
        link: {
          owner_type: "shadow_subject",
          owner_id: "owner-shadow-1",
          shadow_subject_id: "shadow-subject-1",
          claimed_user_id: null,
          tootoo_user_id: null,
          linked_at: "2026-04-23T10:00:00Z",
        },
      }),
    });

    const result = await client.getLinkStatus("agent-shadow-1");

    expect(result.linked).toBe(true);
    expect(result.link?.owner_type).toBe("shadow_subject");
    expect(result.link?.owner_id).toBe("owner-shadow-1");
    expect(result.link?.shadow_subject_id).toBe("shadow-subject-1");
    expect(result.link?.claimed_user_id).toBeNull();
    expect(result.link?.tootoo_user_id).toBeNull();
  });

  it("keeps mixed owner and legacy fields together during migration", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        linked: true,
        owner_type: "claimed_user",
        owner_id: "owner-claimed-1",
        claimed_user_id: "tt-user-9",
        tootoo_user_id: "tt-user-9",
        link: {
          owner_type: "claimed_user",
          owner_id: "owner-claimed-1",
          claimed_user_id: "tt-user-9",
          tootoo_user_id: "tt-user-9",
          linked_at: "2026-04-23T12:00:00Z",
        },
      }),
    });

    const result = await client.getLinkStatus("agent-mixed-1");

    expect(result.linked).toBe(true);
    expect(result.owner_type).toBe("claimed_user");
    expect(result.owner_id).toBe("owner-claimed-1");
    expect(result.tootoo_user_id).toBe("tt-user-9");
    expect(result.link?.owner_type).toBe("claimed_user");
    expect(result.link?.tootoo_user_id).toBe("tt-user-9");
  });

  it("accepts linked=true even when owner metadata is top-level only", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        linked: true,
        owner_type: "shadow_subject",
        owner_id: "owner-shadow-2",
        shadow_subject_id: "shadow-subject-2",
        claimed_user_id: null,
        tootoo_user_id: null,
      }),
    });

    const result = await client.getLinkStatus("agent-shadow-2");

    expect(result.linked).toBe(true);
    expect(result.owner_type).toBe("shadow_subject");
    expect(result.owner_id).toBe("owner-shadow-2");
    expect(result.tootoo_user_id).toBeNull();
    expect(result.link).toBeUndefined();
  });
});
