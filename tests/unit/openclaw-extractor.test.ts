import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildModelOnlyExtractorConfig,
  createOpenClawPassiveModelExtractor,
  loadRunEmbeddedPiAgentFromOpenClawRoot,
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
      timeoutMs: 3_000,
      disableTools: true,
      disableMessageTool: true,
      requireExplicitMessageTarget: true,
      authProfileIdSource: "auto",
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [], version: 0 },
    });
    expect(call.workspaceDir).toContain("openclaw-cortex-passive-");
    expect(call.sessionFile).toContain("/agent-dir/sessions/cortex-passive-extractor-");
    expect(call.prompt).toContain("CONVERSATION_WINDOW_JSON");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("model");
  });

  it("strips explicit tool policy from model-only embedded extraction config", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{"candidates":[]}' }],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        tools: {
          allow: ["*", "browser"],
          deny: ["exec"],
          profile: "coding",
          alsoAllow: ["cortex_search_memory"],
          byProvider: { openai: { allow: ["browser"] } },
          exec: { timeoutSec: 30 },
        },
        agents: {
          defaults: {
            workspace: "/workspace-from-config",
            model: { primary: "openai/gpt-5.5" },
            tools: {
              allow: ["browser"],
              profile: "coding",
              exec: { timeoutSec: 20 },
            },
          },
          list: [
            {
              id: "main",
              tools: {
                allow: ["browser"],
                deny: ["exec"],
              },
            },
          ],
        },
      },
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => "/agent-dir"),
        },
      },
    }, { debug: vi.fn() });

    await extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call.disableTools).toBe(true);
    expect(call.config.tools).toEqual({ exec: { timeoutSec: 30 } });
    expect(call.config.agents.defaults.tools).toEqual({ exec: { timeoutSec: 20 } });
    expect(call.config.agents.defaults.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(call.config.agents.list[0].tools).toEqual({});
    expect(call.config).not.toBe(call.config.tools);
  });

  it("builds a model-only config without mutating the user's config", () => {
    const config = {
      tools: { allow: ["*", "browser"], exec: { timeoutSec: 30 } },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet" },
          tools: { allow: ["browser"] },
        },
      },
    };

    const modelOnly = buildModelOnlyExtractorConfig(config);

    expect(modelOnly?.tools).toEqual({ exec: { timeoutSec: 30 } });
    expect((modelOnly?.agents as any).defaults.tools).toEqual({});
    expect(config.tools.allow).toEqual(["*", "browser"]);
    expect(config.agents.defaults.tools.allow).toEqual(["browser"]);
  });

  it("forces the active conversation model into model-only extraction", () => {
    const modelOnly = buildModelOnlyExtractorConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
          tools: { allow: ["browser"] },
        },
      },
    }, "bedrock/anthropic.claude-sonnet-4-6");

    expect((modelOnly?.agents as any).defaults.model).toEqual({
      primary: "bedrock/anthropic.claude-sonnet-4-6",
      fallbacks: [],
    });
  });

  it("returns parsed JSON candidates from a successful model-only extractor run", async () => {
    const evidence = "I want the handoff to make the owner and next step obvious.";
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{
        text: JSON.stringify({
          candidates: [{
            content: "Prefers handoffs that make the owner and next step obvious.",
            suggested_section: "practices",
            evidence_quote: evidence,
            confidence: 0.86,
            risk_tier: "low",
            reason: "Durable collaboration preference.",
          }],
        }),
      }],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        tools: { allow: ["*", "browser"] },
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      },
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => "/agent-dir"),
        },
      },
    }, { debug: vi.fn() });

    const input = buildPassiveExtractorInput([
      { role: "user", content: evidence },
    ]);
    input.activeModelRef = "bedrock/anthropic.claude-sonnet-4-6";

    await expect(extractor(input)).resolves.toEqual({
      candidates: [expect.objectContaining({
        content: "Prefers handoffs that make the owner and next step obvious.",
        evidence_quote: evidence,
      })],
    });
    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call.config.tools).toEqual({});
    expect(call.provider).toBe("bedrock");
    expect(call.model).toBe("anthropic.claude-sonnet-4-6");
    expect(call.config.agents.defaults.model).toEqual({
      primary: "bedrock/anthropic.claude-sonnet-4-6",
      fallbacks: [],
    });
  });

  it("can load the embedded agent from a shipped hashed OpenClaw dist bundle fallback", async () => {
    const openclawRoot = join(await mkdtemp(join(tmpdir(), "openclaw-cortex-test-")), "openclaw");
    const distDir = join(openclawRoot, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, "pi-embedded-test.js"),
      [
        "async function runEmbeddedPiAgent() {",
        "  return { payloads: [{ text: '{\"candidates\":[]}' }] };",
        "}",
        "export { runEmbeddedPiAgent as t };",
      ].join("\n"),
    );

    await expect(loadRunEmbeddedPiAgentFromOpenClawRoot(openclawRoot)).resolves.toEqual(expect.any(Function));
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
