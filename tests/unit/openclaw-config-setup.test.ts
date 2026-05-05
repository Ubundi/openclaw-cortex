import { describe, expect, it } from "vitest";

describe("OpenClaw setup config", () => {
  it("enables conversation access for the typed agent_end hook while preserving plugin config", async () => {
    const { ensureOpenClawCortexConfig } = await import("../../scripts/ensure-openclaw-cortex-config.mjs");
    const result = ensureOpenClawCortexConfig({
      plugins: {
        entries: {
          "openclaw-cortex": {
            enabled: true,
            hooks: {
              allowPromptInjection: false,
            },
            config: {
              apiKey: "existing-key",
            },
          },
        },
      },
    });

    expect(result.plugins.entries["openclaw-cortex"]).toEqual({
      enabled: true,
      hooks: {
        allowPromptInjection: false,
        allowConversationAccess: true,
      },
      config: {
        apiKey: "existing-key",
      },
    });
    expect(result.plugins.slots.memory).toBe("openclaw-cortex");
  });

  it("does not silently override an explicit conversation access opt-out", async () => {
    const { ensureOpenClawCortexConfig } = await import("../../scripts/ensure-openclaw-cortex-config.mjs");
    const result = ensureOpenClawCortexConfig({
      plugins: {
        entries: {
          "openclaw-cortex": {
            hooks: {
              allowConversationAccess: false,
            },
          },
        },
      },
    });

    expect(result.plugins.entries["openclaw-cortex"].hooks.allowConversationAccess).toBe(false);
    expect(result.plugins.entries["openclaw-cortex"].enabled).toBe(true);
  });
});
