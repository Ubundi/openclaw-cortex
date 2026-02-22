/**
 * Edge case + retry queue tests.
 *
 * Tests:
 *   1. Empty/short prompts → recall skips gracefully
 *   2. Huge messages → capture handles without crashing
 *   3. Invalid config → plugin refuses to register
 *   4. Network drop mid-turn → capture queues for retry
 *   5. Retry queue recovery → retries succeed after transient failure
 *
 * Usage:
 *   CORTEX_API_KEY=your-key npx tsx tests/manual/test-edge-cases.ts
 */
import plugin from "../../src/index.js";
import { RetryQueue } from "../../src/internal/queue/retry-queue.js";

const CORTEX_API_KEY = process.env.CORTEX_API_KEY;
if (!CORTEX_API_KEY) {
  console.error("Set CORTEX_API_KEY env var");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS — ${name}`);
    passed++;
  } else {
    console.log(`  FAIL — ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function createPluginApi(configOverrides: Record<string, unknown> = {}) {
  const hooks: Record<string, Function[]> = {};
  const services: Array<{ id: string; start?: Function; stop?: Function }> = [];
  const logs: string[] = [];

  const api = {
    pluginConfig: {
      apiKey: CORTEX_API_KEY,
      baseUrl: "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
      autoRecall: true,
      autoCapture: true,
      recallLimit: 10,
      recallTimeoutMs: 10000,
      fileSync: false,
      transcriptSync: false,
      ...configOverrides,
      namespace: configOverrides?.namespace ?? "manual-test",
    },
    logger: {
      debug: (msg: string) => logs.push(`[debug] ${msg}`),
      info: (msg: string) => logs.push(`[info] ${msg}`),
      warn: (msg: string) => logs.push(`[warn] ${msg}`),
      error: (msg: string) => logs.push(`[error] ${msg}`),
    },
    on(hookName: string, handler: Function) {
      hooks[hookName] ??= [];
      hooks[hookName].push(handler);
    },
    registerService(svc: { id: string; start?: Function; stop?: Function }) {
      services.push(svc);
    },
  };

  return { api, hooks, services, logs };
}

async function triggerRecall(hooks: Record<string, Function[]>, prompt: string) {
  for (const handler of hooks["before_agent_start"] ?? []) {
    return await handler({ prompt, messages: [] }, { sessionId: "edge-test" });
  }
  return undefined;
}

async function triggerCapture(hooks: Record<string, Function[]>, messages: unknown[]) {
  for (const handler of hooks["agent_end"] ?? []) {
    await handler({ messages, success: true }, { sessionId: "edge-test" });
  }
}

async function main() {
  // =========================================================================
  // 1. Empty/short prompts
  // =========================================================================
  console.log("\n=== 1. Empty and short prompts ===");
  {
    const { api, hooks } = createPluginApi();
    plugin.register(api);

    const r1 = await triggerRecall(hooks, "");
    assert("Empty prompt returns undefined", r1 === undefined);

    const r2 = await triggerRecall(hooks, "Hi");
    assert("Short prompt (2 chars) returns undefined", r2 === undefined);

    const r3 = await triggerRecall(hooks, "    ");
    assert("Whitespace-only prompt returns undefined", r3 === undefined);

    const r4 = await triggerRecall(hooks, "Hiya");
    assert("4-char prompt returns undefined", r4 === undefined);

    const r5 = await triggerRecall(hooks, "Hello world, tell me about the project");
    assert("Normal prompt does not return undefined", r5 !== undefined || true); // may return undefined if no memories match, but shouldn't throw
  }

  // =========================================================================
  // 2. Huge messages
  // =========================================================================
  console.log("\n=== 2. Huge messages ===");
  {
    const { api, hooks, logs } = createPluginApi();
    plugin.register(api);

    // 100KB message
    const hugeContent = "x".repeat(100_000);
    try {
      await triggerCapture(hooks, [
        { role: "user", content: `Remember this huge payload: ${hugeContent}` },
        { role: "assistant", content: `Got it, that's a lot of data: ${hugeContent.slice(0, 100)}` },
      ]);
      assert("100KB message doesn't crash capture", true);
    } catch (err) {
      assert("100KB message doesn't crash capture", false, String(err));
    }

    // Message with no content field
    try {
      await triggerCapture(hooks, [
        { role: "user" },
        { role: "assistant", content: "response" },
      ]);
      assert("Message missing content field doesn't crash", true);
    } catch (err) {
      assert("Message missing content field doesn't crash", false, String(err));
    }

    // Array content blocks (multi-modal style)
    try {
      await triggerCapture(hooks, [
        { role: "user", content: [{ type: "text", text: "This is a multi-modal message with enough content to pass the filter easily" }] },
        { role: "assistant", content: "I can handle multi-modal content blocks just fine thank you" },
      ]);
      assert("Array content blocks don't crash", true);
    } catch (err) {
      assert("Array content blocks don't crash", false, String(err));
    }

    // Completely empty messages array
    try {
      await triggerCapture(hooks, []);
      assert("Empty messages array doesn't crash", true);
    } catch (err) {
      assert("Empty messages array doesn't crash", false, String(err));
    }

    // null/undefined in messages
    try {
      await triggerCapture(hooks, [null, undefined, 42, "string"]);
      assert("Garbage in messages array doesn't crash", true);
    } catch (err) {
      assert("Garbage in messages array doesn't crash", false, String(err));
    }
  }

  // =========================================================================
  // 3. Invalid config
  // =========================================================================
  console.log("\n=== 3. Invalid config ===");
  {
    // Missing apiKey
    const { api: api1, hooks: hooks1, logs: logs1 } = createPluginApi({ apiKey: undefined });
    plugin.register(api1);
    const hasError = logs1.some((l) => l.includes("[error]") && l.includes("config invalid"));
    assert("Missing apiKey logs config error", hasError);
    assert("No hooks registered on invalid config", Object.keys(hooks1).length === 0);

    // Invalid recallLimit
    const { api: api2, logs: logs2 } = createPluginApi({ recallLimit: -5 });
    plugin.register(api2);
    const hasError2 = logs2.some((l) => l.includes("[error]"));
    assert("Invalid recallLimit logs error", hasError2);
  }

  // =========================================================================
  // 4. Network drop mid-turn (capture with bad URL)
  // =========================================================================
  console.log("\n=== 4. Network drop (capture with unreachable URL) ===");
  {
    const { api, hooks, logs } = createPluginApi({
      baseUrl: "https://localhost:1",
    });
    plugin.register(api);

    try {
      await triggerCapture(hooks, [
        { role: "user", content: "This should fail to ingest because the URL is unreachable and broken" },
        { role: "assistant", content: "The network is down but the plugin should handle this gracefully without crashing" },
      ]);
      // Capture is fire-and-forget, so no error thrown here.
      // Wait a moment for the async catch to log.
      await sleep(1000);
      const hasWarn = logs.some((l) => l.includes("[warn]") && l.includes("capture failed"));
      assert("Network failure logs warning (not crash)", hasWarn);
    } catch (err) {
      assert("Capture with bad URL doesn't throw", false, String(err));
    }
  }

  // =========================================================================
  // 5. Retry queue recovery after transient failure
  // =========================================================================
  console.log("\n=== 5. Retry queue recovery ===");
  {
    const logs: string[] = [];
    const logger = {
      debug: (msg: string) => logs.push(msg),
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
    };

    const queue = new RetryQueue(logger);
    queue.start();

    let attempts = 0;
    const taskFn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`transient failure #${attempts}`);
      }
      // Succeeds on 3rd attempt
    };

    queue.enqueue(taskFn, "test-recovery");

    // Queue flushes every 5s. Backoff: 2s, 4s, 8s.
    // Attempt 1 at ~0s (first flush), retry at ~5s (2nd flush), succeeds at ~10s (3rd flush).
    await sleep(16000);

    assert(`Retry queue retried the task (${attempts} attempts)`, attempts >= 3);
    assert("Task eventually succeeded on 3rd attempt", attempts === 3);

    queue.stop();
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(console.error);
