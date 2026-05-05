import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelOnlyExtractorConfig,
  buildEmbeddedExtractorWorkerData,
  createOpenClawPassiveModelExtractor,
  createPiAiDirectModelCall,
  createWorkerIsolatedEmbeddedExtractor,
  loadRunEmbeddedPiAgentFromOpenClawRoot,
  PASSIVE_EXTRACTOR_PROVENANCE_SOURCE,
  PASSIVE_EXTRACTOR_SESSION_KEY,
  PassiveExtractorTimeoutError,
  type PassiveExtractorWorkerLike,
} from "../../src/features/bridge/openclaw-extractor.js";
import { buildPassiveExtractorInput } from "../../src/features/bridge/passive.js";

afterEach(() => {
  vi.useRealTimers();
});

type EmbeddedRunnerResult = {
  payloads?: Array<{ text?: string; isError?: boolean }>;
};

type TestWorker = EventEmitter & {
  terminate: ReturnType<typeof vi.fn>;
};

function asPassiveExtractorWorker(worker: TestWorker): PassiveExtractorWorkerLike {
  return worker as unknown as PassiveExtractorWorkerLike;
}

describe("OpenClaw passive model extractor adapter", () => {
  it("production adapter uses a direct model call and never invokes embedded OpenClaw runners", async () => {
    const runEmbeddedAgent = vi.fn(() => {
      throw new Error("embedded runner must not be called");
    });
    const directModelCall = vi.fn().mockResolvedValue('{"candidates":[]}');
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        tools: { allow: ["browser"] },
        agents: {
          defaults: {
            model: { primary: "openai/test-model" },
            workspace: "/should-not-reach-direct-extractor",
            tools: { allow: ["exec"] },
          },
        },
        models: {
          providers: {
            openai: { apiKey: "test-key" },
          },
        },
      },
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentTimeoutMs: vi.fn(() => 30_000),
        },
      },
    }, { debug: vi.fn() }, { directModelCall });

    await expect(extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]))).resolves.toEqual({ candidates: [] });

    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(directModelCall).toHaveBeenCalledTimes(1);
    expect(directModelCall.mock.calls[0][0]).toMatchObject({
      modelRef: "openai/test-model",
      timeoutMs: 15_000,
    });
    expect(directModelCall.mock.calls[0][0].config).toEqual({
      models: {
        providers: {
          openai: { apiKey: "test-key" },
        },
      },
    });
    expect(directModelCall.mock.calls[0][0].input.messages).toHaveLength(1);
  });

  it("direct pi-ai adapter returns JSON from a tiny model-only prompt", async () => {
    const completeSimple = vi.fn().mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: '{"candidates":[]}' }],
    });
    const directModelCall = createPiAiDirectModelCall(async () => ({
      completeSimple,
      getModel: vi.fn(() => ({
        id: "test-model",
        name: "Test Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      })),
    }));
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);

    const raw = await directModelCall({
      input,
      config: { models: { providers: { openai: { apiKey: "test-key" } } } },
      modelRef: "openai/test-model",
      timeoutMs: 100,
      signal: new AbortController().signal,
    });

    expect(raw).toBe('{"candidates":[]}');
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(completeSimple.mock.calls[0][1]).toMatchObject({
      systemPrompt: input.prompt,
      tools: [],
      messages: [expect.objectContaining({ role: "user" })],
    });
    expect(JSON.stringify(completeSimple.mock.calls[0][1])).not.toContain("prependContext");
    expect(completeSimple.mock.calls[0][1].messages[0].content).toContain("CONVERSATION_WINDOW_JSON");
    expect(completeSimple.mock.calls[0][2]).toMatchObject({
      apiKey: "test-key",
      maxTokens: input.maxOutputTokens,
      temperature: 0,
    });
  });

  it("direct pi-ai adapter fabricates OpenAI Codex metadata with Codex API settings", async () => {
    let resolvedModel: Record<string, unknown> | undefined;
    const completeSimple = vi.fn((model) => {
      resolvedModel = model as Record<string, unknown>;
      return Promise.resolve({
        stopReason: "stop",
        content: [{ type: "text", text: '{"candidates":[]}' }],
      });
    });
    const directModelCall = createPiAiDirectModelCall(async () => ({
      completeSimple,
      getModel: vi.fn(() => {
        throw new Error("not in static registry");
      }),
    }));
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);

    await expect(directModelCall({
      input,
      config: { models: { providers: { "openai-codex": { apiKey: "codex-oauth-token" } } } },
      modelRef: "openai-codex/gpt-5.4",
      timeoutMs: 100,
    })).resolves.toBe('{"candidates":[]}');

    expect(resolvedModel).toMatchObject({
      id: "gpt-5.4",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("direct pi-ai adapter aborts only the provider call at the configured timeout", async () => {
    let providerSignal: AbortSignal | undefined;
    const completeSimple = vi.fn((_model, _context, options: any) => {
      providerSignal = options.signal;
      return new Promise(() => undefined);
    });
    const directModelCall = createPiAiDirectModelCall(async () => ({
      completeSimple,
      getModel: vi.fn(() => ({
        id: "test-model",
        name: "Test Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      })),
    }));
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);

    await expect(directModelCall({
      input,
      config: { models: { providers: { openai: { apiKey: "test-key" } } } },
      modelRef: "openai/test-model",
      timeoutMs: 5,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(PassiveExtractorTimeoutError);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("prefers the documented api.runtime.agent.runEmbeddedPiAgent helper", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-agent-"));
    const runEmbeddedPiAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{"candidates":[]}' }],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        agents: {
          defaults: {
            workspace: "/workspace-from-config",
            model: { primary: "openai/test-model" },
          },
        },
      },
      runtime: {
        agent: {
          runEmbeddedPiAgent,
          resolveAgentDir: vi.fn(() => agentDir),
          resolveAgentWorkspaceDir: vi.fn(() => "/workspace-from-runtime"),
          resolveAgentTimeoutMs: vi.fn(() => 30_000),
        },
      },
    }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    await extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgent.mock.calls[0][0];
    expect(call).toMatchObject({
      sessionKey: PASSIVE_EXTRACTOR_SESSION_KEY,
      timeoutMs: 15_000,
      disableTools: true,
      disableMessageTool: true,
      requireExplicitMessageTarget: true,
      authProfileIdSource: "auto",
      inputProvenance: { source: PASSIVE_EXTRACTOR_PROVENANCE_SOURCE },
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [], version: 0 },
    });
    expect(call.workspaceDir).toContain("openclaw-cortex-passive-");
    expect(call.sessionFile).toContain("openclaw-cortex-passive-");
    expect(call.sessionFile).toContain("/sessions/cortex-passive-extractor-");
    expect(call.prompt).toContain("CONVERSATION_WINDOW_JSON");
    expect(call).not.toHaveProperty("agentDir");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("model");
  });

  it("keeps compatibility with legacy api.runtime.agent.runEmbeddedAgent helper", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{"candidates":[]}' }],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      runtime: {
        agent: {
          runEmbeddedAgent,
        },
      },
    }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    await extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
  });

  it("strips explicit tool policy from model-only embedded extraction config", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-agent-"));
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
            model: { primary: "openai/test-model" },
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
          resolveAgentDir: vi.fn(() => agentDir),
        },
      },
    }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    await extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call.disableTools).toBe(true);
    expect(call.config.tools).toEqual({ exec: { timeoutSec: 30 } });
    expect(call.config.agents.defaults.tools).toEqual({ exec: { timeoutSec: 20 } });
    expect(call.config.agents.defaults.model).toEqual({ primary: "openai/test-model", fallbacks: [] });
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

  it("uses the configured primary provider/model when no active turn model is available", async () => {
    const directModelCall = vi.fn().mockResolvedValue('{"candidates":[]}');
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        agents: {
          defaults: {
            model: { provider: "amazon-bedrock", primary: "global.anthropic.claude-sonnet-4-6" },
          },
        },
      },
    }, { debug: vi.fn() }, { directModelCall });

    await expect(extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]))).resolves.toEqual({ candidates: [] });

    expect(directModelCall).toHaveBeenCalledTimes(1);
    expect(directModelCall.mock.calls[0][0].modelRef).toBe("amazon-bedrock/global.anthropic.claude-sonnet-4-6");
  });

  it("forces the active conversation model into model-only extraction", () => {
    const modelOnly = buildModelOnlyExtractorConfig({
      agents: {
        defaults: {
          model: { primary: "openai/test-model", fallbacks: ["openai/test-fallback"] },
          tools: { allow: ["browser"] },
        },
      },
    }, "amazon-bedrock/global.anthropic.claude-sonnet-4-6");

    expect((modelOnly?.agents as any).defaults.model).toEqual({
      primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      fallbacks: [],
    });
  });

  it("returns parsed JSON candidates from a successful model-only extractor run", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-agent-"));
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
        agents: { defaults: { model: { primary: "openai/test-model" } } },
      },
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => agentDir),
        },
      },
    }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    const input = buildPassiveExtractorInput([
      { role: "user", content: evidence },
    ]);
    input.activeModelRef = "amazon-bedrock/global.anthropic.claude-sonnet-4-6";

    await expect(extractor(input)).resolves.toEqual({
      candidates: [expect.objectContaining({
        content: "Prefers handoffs that make the owner and next step obvious.",
        evidence_quote: evidence,
      })],
    });
    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call.config.tools).toEqual({});
    expect(call.provider).toBe("amazon-bedrock");
    expect(call.model).toBe("global.anthropic.claude-sonnet-4-6");
    expect(call.config.agents.defaults.model).toEqual({
      primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      fallbacks: [],
    });
  });

  it("creates isolated temporary session paths before the embedded run and removes them afterward", async () => {
    let workspaceDir = "";
    let sessionFile = "";
    const runEmbeddedAgent = vi.fn(async (params: any) => {
      workspaceDir = params.workspaceDir;
      sessionFile = params.sessionFile;
      await expect(stat(params.workspaceDir)).resolves.toBeTruthy();
      await expect(stat(dirname(params.sessionFile))).resolves.toBeTruthy();
      return { payloads: [{ text: '{"candidates":[]}' }] };
    });
    const extractor = createOpenClawPassiveModelExtractor({
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => undefined as unknown as string),
        },
      },
    }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    await extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call.sessionFile).toContain("openclaw-cortex-passive-");
    expect(call.workspaceDir).toContain("openclaw-cortex-passive-");
    await expect(stat(workspaceDir)).rejects.toThrow();
    await expect(stat(dirname(sessionFile))).rejects.toThrow();
  });

  it("does not clean up temporary extractor paths before the embedded runner fully resolves", async () => {
    let resolveRun!: (value: { payloads: Array<{ text: string }> }) => void;
    let extractionPromise!: Promise<unknown>;
    const runStarted = new Promise<Record<string, unknown>>((resolve) => {
      const runEmbeddedAgent = vi.fn((params: Record<string, unknown>) => {
        resolve(params);
        return new Promise<{ payloads: Array<{ text: string }> }>((runResolve) => {
          resolveRun = runResolve;
        });
      });
      const extractor = createOpenClawPassiveModelExtractor({
        runtime: { agent: { runEmbeddedAgent } },
      }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });
      extractionPromise = extractor(buildPassiveExtractorInput([
        { role: "user", content: "I want the handoff to make the owner and next step obvious." },
      ]));
    });

    const params = await runStarted as { workspaceDir: string; sessionFile: string };
    await expect(stat(params.workspaceDir)).resolves.toBeTruthy();
    await expect(stat(dirname(params.sessionFile))).resolves.toBeTruthy();

    resolveRun({ payloads: [{ text: '{"candidates":[]}' }] });
    await extractionPromise;
    await expect(stat(params.workspaceDir)).rejects.toThrow();
  });

  it("logs ENOENT session path failures from the embedded runner", async () => {
    const logger = { debug: vi.fn() };
    const error = Object.assign(new Error("ENOENT: no such file or directory, mkdir '/tmp/openclaw-cortex-passive-old'"), {
      code: "ENOENT",
    });
    const extractor = createOpenClawPassiveModelExtractor({
      runtime: {
        agent: {
          runEmbeddedAgent: vi.fn().mockRejectedValue(error),
        },
      },
    }, logger, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    await expect(extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]))).rejects.toThrow("ENOENT");

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("extractor_session_path_error"));
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
    const agentDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-agent-"));
    const runEmbeddedAgent = vi.fn((_params: any): Promise<EmbeddedRunnerResult> => new Promise(() => undefined));
    const extractor = createOpenClawPassiveModelExtractor({
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentDir: vi.fn(() => agentDir),
          resolveAgentTimeoutMs: vi.fn(() => 5),
        },
      },
    }, { debug: vi.fn() }, { unsafeAllowInProcessEmbeddedRunnerForTests: true });

    const promise = extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]));

    await expect(promise).rejects.toThrow("passive extractor timed out");
    expect(runEmbeddedAgent.mock.calls[0][0].abortSignal.aborted).toBe(true);
  });

  it("production adapter fails closed instead of falling back to embedded extraction when direct model calls are unavailable", async () => {
    const runEmbeddedAgent = vi.fn(() => {
      throw new Error("in-process runner must not be called");
    });
    const runIsolatedEmbeddedExtractor = vi.fn().mockResolvedValue({
      candidates: [],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      config: {},
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentTimeoutMs: vi.fn(() => 30_000),
        },
      },
    }, { debug: vi.fn() }, { runIsolatedEmbeddedExtractor });

    await expect(extractor(buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]))).resolves.toEqual({ candidates: [] });

    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runIsolatedEmbeddedExtractor).not.toHaveBeenCalled();
  });

  it("sanitizes extractor worker data so runtime config helpers cannot trip structured clone", () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          model: { primary: "openai/test-model" },
          helper: () => "nope",
        },
      },
      matcher: /openclaw-cortex/g,
      tokenExpiresAt: new Date("2026-05-05T10:00:00.000Z"),
    };
    config.self = config;

    const workerData = buildEmbeddedExtractorWorkerData({
      input: buildPassiveExtractorInput([
        { role: "user", content: "I want the handoff to make the owner and next step obvious." },
      ]),
      config,
      timeoutMs: 3_000,
      paths: {
        rootDir: "/tmp/openclaw-cortex-passive-test",
        workspaceDir: "/tmp/openclaw-cortex-passive-test/workspace",
        sessionFile: "/tmp/openclaw-cortex-passive-test/sessions/session.jsonl",
      },
    });

    expect(() => structuredClone(workerData)).not.toThrow();
    expect((workerData.config?.agents as any).defaults.helper).toBeUndefined();
    expect(workerData.config?.matcher).toBe("openclaw-cortex");
    expect(workerData.config?.tokenExpiresAt).toBe("2026-05-05T10:00:00.000Z");
    expect(workerData.config?.self).toBeUndefined();
  });

  it("terminates an isolated extractor worker at the configured timeout and ignores late output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-worker-test-"));
    const workspaceDir = join(rootDir, "workspace");
    const sessionDir = join(rootDir, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    vi.useFakeTimers();
    const worker = new EventEmitter() as EventEmitter & {
      terminate: ReturnType<typeof vi.fn>;
    };
    worker.terminate = vi.fn().mockResolvedValue(1);
    const extractor = createWorkerIsolatedEmbeddedExtractor((params) => {
      expect(params.paths?.rootDir).toBe(rootDir);
      return asPassiveExtractorWorker(worker);
    });
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);
    input.timeoutMs = 25;

    const promise = extractor({
      input,
      timeoutMs: 25,
      config: {},
      paths: {
        rootDir,
        workspaceDir,
        sessionFile: join(sessionDir, "session.jsonl"),
      },
    });
    const rejection = expect(promise).rejects.toBeInstanceOf(PassiveExtractorTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stat(rootDir)).resolves.toBeTruthy();

    worker.emit("message", {
      ok: true,
      output: {
        candidates: [{
          content: "Late output should be ignored.",
          evidence_quote: "I want the handoff to make the owner and next step obvious.",
          confidence: 0.9,
          risk_tier: "low",
        }],
      },
    });
    await Promise.resolve();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await rm(rootDir, { recursive: true, force: true });
  });

  it("terminates an isolated extractor worker after successful output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-cortex-worker-test-"));
    const workspaceDir = join(rootDir, "workspace");
    const sessionDir = join(rootDir, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const worker = new EventEmitter() as EventEmitter & {
      terminate: ReturnType<typeof vi.fn>;
    };
    worker.terminate = vi.fn().mockResolvedValue(0);
    const extractor = createWorkerIsolatedEmbeddedExtractor((params) => {
      expect(params.paths?.rootDir).toBe(rootDir);
      return asPassiveExtractorWorker(worker);
    });
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);

    const promise = extractor({
      input,
      timeoutMs: 3_000,
      config: {},
      paths: {
        rootDir,
        workspaceDir,
        sessionFile: join(sessionDir, "session.jsonl"),
      },
    });

    worker.emit("message", { ok: true, output: { candidates: [] } });

    await expect(promise).resolves.toEqual({ candidates: [] });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stat(rootDir)).resolves.toBeTruthy();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("removes parent-owned temporary paths after successful worker output", async () => {
    const worker = new EventEmitter() as EventEmitter & {
      terminate: ReturnType<typeof vi.fn>;
    };
    worker.terminate = vi.fn().mockResolvedValue(0);
    let rootDir = "";
    let resolveWorkerCreated!: () => void;
    const workerCreated = new Promise<void>((resolve) => {
      resolveWorkerCreated = resolve;
    });
    const extractor = createWorkerIsolatedEmbeddedExtractor((params) => {
      rootDir = params.paths?.rootDir ?? "";
      resolveWorkerCreated();
      return asPassiveExtractorWorker(worker);
    });
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);

    const promise = extractor({
      input,
      timeoutMs: 3_000,
      config: {},
    });

    await workerCreated;
    await expect(stat(rootDir)).resolves.toBeTruthy();
    worker.emit("message", { ok: true, output: { candidates: [] } });

    await expect(promise).resolves.toEqual({ candidates: [] });
    await expect(stat(rootDir)).rejects.toThrow();
  });

  it("removes parent-owned temporary paths after worker timeout", async () => {
    const worker = new EventEmitter() as EventEmitter & {
      terminate: ReturnType<typeof vi.fn>;
    };
    worker.terminate = vi.fn().mockResolvedValue(1);
    let rootDir = "";
    let resolveWorkerCreated!: () => void;
    const workerCreated = new Promise<void>((resolve) => {
      resolveWorkerCreated = resolve;
    });
    const extractor = createWorkerIsolatedEmbeddedExtractor((params) => {
      rootDir = params.paths?.rootDir ?? "";
      resolveWorkerCreated();
      return asPassiveExtractorWorker(worker);
    });
    const input = buildPassiveExtractorInput([
      { role: "user", content: "I want the handoff to make the owner and next step obvious." },
    ]);

    const promise = extractor({
      input,
      timeoutMs: 5,
      config: {},
    });

    await workerCreated;
    await expect(promise).rejects.toBeInstanceOf(PassiveExtractorTimeoutError);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stat(rootDir)).rejects.toThrow();
  });
});
