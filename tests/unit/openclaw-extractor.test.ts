import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelOnlyExtractorConfig,
  buildEmbeddedExtractorWorkerData,
  createOpenClawPassiveModelExtractor,
  createWorkerIsolatedEmbeddedExtractor,
  loadRunEmbeddedPiAgentFromOpenClawRoot,
  PASSIVE_EXTRACTOR_SESSION_KEY,
  PassiveExtractorTimeoutError,
} from "../../src/features/bridge/openclaw-extractor.js";
import { buildPassiveExtractorInput } from "../../src/features/bridge/passive.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenClaw passive model extractor adapter", () => {
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
            model: { primary: "openai/gpt-5.5" },
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
      timeoutMs: 3_000,
      disableTools: true,
      disableMessageTool: true,
      requireExplicitMessageTarget: true,
      authProfileIdSource: "auto",
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
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
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
    const runEmbeddedAgent = vi.fn((_params: any) => new Promise(() => undefined));
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

  it("production adapter uses isolated embedded extraction instead of the in-process runtime helper", async () => {
    const runEmbeddedAgent = vi.fn(() => {
      throw new Error("in-process runner must not be called");
    });
    const runIsolatedEmbeddedExtractor = vi.fn().mockResolvedValue({
      candidates: [],
    });
    const extractor = createOpenClawPassiveModelExtractor({
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
          },
        },
      },
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
    expect(runIsolatedEmbeddedExtractor).toHaveBeenCalledTimes(1);
    expect(runIsolatedEmbeddedExtractor.mock.calls[0][0].config.agents.defaults.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("sanitizes extractor worker data so runtime config helpers cannot trip structured clone", () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
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
      return worker;
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
      return worker;
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
      return worker;
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
      return worker;
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
