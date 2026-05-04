import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawPassiveModelExtractor,
  loadRunEmbeddedPiAgent,
  PASSIVE_EXTRACTOR_SESSION_KEY,
} from "../../src/features/bridge/openclaw-extractor.js";
import { buildPassiveExtractorInput } from "../../src/features/bridge/passive.js";

describe("OpenClaw passive model extractor adapter", () => {
  it("prefers the documented api.runtime.agent.runEmbeddedAgent helper", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{"candidates":[]}' }],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        agents: {
          defaults: {
            workspace: "/workspace-from-config",
            model: { primary: "openai/gpt-5.5" },
          },
        },
      },
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => "/agent-dir"),
          resolveAgentWorkspaceDir: vi.fn(() => "/workspace-from-runtime"),
          resolveAgentTimeoutMs: vi.fn(() => 30_000),
        },
      },
    }, { debug: vi.fn() });

    await extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call).toMatchObject({
      sessionKey: PASSIVE_EXTRACTOR_SESSION_KEY,
      workspaceDir: "/workspace-from-runtime",
      timeoutMs: 8_000,
      disableTools: true,
      authProfileIdSource: "auto",
    });
    expect(call.sessionFile).toContain("/agent-dir/sessions/cortex-passive-extractor-");
    expect(call.prompt).toContain("CONVERSATION_WINDOW_JSON");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("model");
  });

  it("can load the embedded agent from the installed OpenClaw package fallback", async () => {
    await expect(loadRunEmbeddedPiAgent()).resolves.toEqual(expect.any(Function));
  });

  it("enforces a hard JavaScript timeout around embedded runs", async () => {
    const runEmbeddedAgent = vi.fn((_params: any) => new Promise(() => undefined));
    const extractor = createOpenClawPassiveModelExtractor({
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => "/agent-dir"),
          resolveAgentTimeoutMs: vi.fn(() => 5),
        },
      },
    }, { debug: vi.fn() });

    const promise = extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    await expect(promise).rejects.toThrow("passive extractor timed out");
    expect(runEmbeddedAgent.mock.calls[0][0].abortSignal.aborted).toBe(true);
  });
});
