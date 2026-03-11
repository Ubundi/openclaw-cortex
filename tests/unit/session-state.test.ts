import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSessionSummaryFromMessages,
  formatRecoveryContext,
  SessionStateStore,
} from "../../src/internal/session-state.js";

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "cortex-session-state-"));
  return new SessionStateStore(join(dir, "state.json"));
}

describe("SessionStateStore", () => {
  it("writes dirty state and reports recovery only across plugin lifecycles", async () => {
    const store = await makeStore();
    await store.markDirty({
      pluginSessionId: "plugin-session-1",
      sessionKey: "runtime-session-1",
      summary: "Working on auth migration",
    });

    const sameLifecycle = await store.readDirtyFromPriorLifecycle("plugin-session-1");
    expect(sameLifecycle).toBeNull();

    const priorLifecycle = await store.readDirtyFromPriorLifecycle("plugin-session-2");
    expect(priorLifecycle).toMatchObject({
      dirty: true,
      pluginSessionId: "plugin-session-1",
      sessionKey: "runtime-session-1",
      summary: "Working on auth migration",
    });
  });

  it("clear removes session state", async () => {
    const store = await makeStore();
    await store.markDirty({
      pluginSessionId: "plugin-session-1",
      sessionKey: "runtime-session-1",
    });

    await store.clear();

    const priorLifecycle = await store.readDirtyFromPriorLifecycle("plugin-session-2");
    expect(priorLifecycle).toBeNull();
  });
});

describe("session recovery helpers", () => {
  it("buildSessionSummaryFromMessages prefers latest substantive conversation text", () => {
    const summary = buildSessionSummaryFromMessages([
      { role: "assistant", content: "ok" },
      { role: "user", content: "short" },
      { role: "user", content: "Need to finish the auth migration rollout and validate token refresh in staging before release." },
    ]);

    expect(summary).toContain("auth migration rollout");
  });

  it("buildSessionSummaryFromMessages strips injected context and metadata", () => {
    const summary = buildSessionSummaryFromMessages([
      {
        role: "user",
        content: "<cortex_recovery>\nWarning\n</cortex_recovery>\n\nTelegram (untrusted metadata):\n```json\n{\"chat_id\":\"1\"}\n```\n\nWhat is an apple?",
      },
      { role: "assistant", content: "An apple is a fruit with seeds." },
    ]);

    expect(summary).toBe("An apple is a fruit with seeds.");
  });

  it("buildSessionSummaryFromMessages ignores synthetic user provenance", () => {
    const summary = buildSessionSummaryFromMessages([
      { role: "user", content: "Synthetic bridge text", provenance: { kind: "inter_session" } },
      { role: "assistant", content: "Real assistant text that should be considered as the latest substantive content." },
    ]);

    expect(summary).toBeUndefined();
  });

  it("buildSessionSummaryFromMessages falls back to the latest real turn when a synthetic pair is last", () => {
    const summary = buildSessionSummaryFromMessages([
      { role: "user", content: "What database stack are we using in production for vector search?", provenance: { kind: "external_user" } },
      { role: "assistant", content: "We use PostgreSQL with pgvector in production for vector search and persistence." },
      { role: "user", content: "Synthetic bridge text", provenance: { kind: "inter_session" } },
      { role: "assistant", content: "Session summary: provenance filtering rollout." },
    ]);

    expect(summary).toBe("We use PostgreSQL with pgvector in production for vector search and persistence.");
  });

  it("formats a recovery block with session metadata", () => {
    const text = formatRecoveryContext({
      dirty: true,
      pluginSessionId: "plugin-session-1",
      sessionKey: "runtime-session-1",
      updatedAt: "2026-03-04T07:30:00.000Z",
      summary: "Finish rollout validation",
    });

    expect(text).toContain("<cortex_recovery>");
    expect(text).toContain("CONTEXT DEATH DETECTED");
    expect(text).toContain("runtime-session-1");
    expect(text).toContain("Finish rollout validation");
    expect(text).toContain("</cortex_recovery>");
  });
});
