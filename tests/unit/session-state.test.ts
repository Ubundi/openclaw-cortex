import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSessionSummaryFromMessages,
  formatRecoveryContext,
  SessionStateStore,
} from "../../src/internal/session/session-state.js";

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
